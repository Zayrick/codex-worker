use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};

use crate::core::{ApiError, AppResult, JsonObject, number_field, record_field, string_field};

use super::response::{function_call_part, image_part, output_texts, reasoning_text};
use super::{
    GeminiChunkOptions, GeminiResponseMetadata, codex_stream_failed, failed_codex_response,
    gemini_chunk, gemini_codex_event_error, gemini_error_payload, gemini_finish_reason,
    incomplete_codex_stream,
};

const MAX_RETAINED_CHARS: usize = 8 * 1024 * 1024;
const MAX_OUTPUT_ITEMS: usize = 256;
const THINKING_SEPARATOR: &str = "\n\n";

#[derive(Debug, Clone, PartialEq)]
pub struct SseEvent {
    pub event: Option<String>,
    pub data: Value,
}

impl SseEvent {
    pub fn data(data: Value) -> Self {
        Self { event: None, data }
    }

    pub fn named(event: impl Into<String>, data: Value) -> Self {
        Self {
            event: Some(event.into()),
            data,
        }
    }

    /// Wire presentation is kept here, while stream ownership remains in the
    /// transport adapter.
    pub fn render(&self) -> String {
        let mut rendered = String::new();
        if let Some(event) = &self.event {
            rendered.push_str("event: ");
            rendered.push_str(event);
            rendered.push('\n');
        }
        rendered.push_str("data: ");
        rendered.push_str(&self.data.to_string());
        rendered.push_str("\n\n");
        rendered
    }
}

#[derive(Debug, Clone, Default)]
pub struct GeminiStreamOptions {
    pub model: String,
    pub reverse_tool_names: HashMap<String, String>,
}

/// Pure reducer that presents Codex response events as Gemini SSE events.
///
/// `push` never performs I/O and always absorbs protocol errors into a named
/// Gemini error event. `finish` must be called when the upstream event source
/// ends so truncation cannot be mistaken for a successful response.
pub struct GeminiStreamPresenter {
    requested_model: String,
    reverse_tool_names: HashMap<String, String>,
    id: String,
    model: String,
    created_at: Option<f64>,
    terminal: bool,
    text: String,
    reasoning: String,
    terminal_text: String,
    terminal_reasoning: String,
    retained_chars: usize,
    seen_items: HashSet<String>,
}

impl GeminiStreamPresenter {
    pub fn new(options: GeminiStreamOptions) -> Self {
        Self {
            model: options.model.clone(),
            requested_model: options.model,
            reverse_tool_names: options.reverse_tool_names,
            id: String::new(),
            created_at: None,
            terminal: false,
            text: String::new(),
            reasoning: String::new(),
            terminal_text: String::new(),
            terminal_reasoning: String::new(),
            retained_chars: 0,
            seen_items: HashSet::new(),
        }
    }

    pub fn push(&mut self, event: Value) -> Vec<SseEvent> {
        if self.terminal {
            return Vec::new();
        }
        match self.translate_event(&event) {
            Ok(chunks) => chunks.into_iter().map(SseEvent::data).collect(),
            Err(error) => self.fail(error),
        }
    }

    pub fn finish(&mut self) -> Vec<SseEvent> {
        if self.terminal {
            Vec::new()
        } else {
            self.fail(incomplete_codex_stream())
        }
    }

    pub const fn is_terminal(&self) -> bool {
        self.terminal
    }

    fn fail(&mut self, error: ApiError) -> Vec<SseEvent> {
        self.terminal = true;
        vec![SseEvent::named("error", gemini_error_payload(&error))]
    }

    fn translate_event(&mut self, event: &Value) -> AppResult<Vec<Value>> {
        let event_object = event.as_object().ok_or_else(codex_stream_failed)?;
        let event_type = string_field(Some(event_object), "type").unwrap_or("");
        match event_type {
            "error" => Err(gemini_codex_event_error(event)),
            "response.created" => {
                self.update_metadata(record_field(Some(event_object), "response"));
                Ok(Vec::new())
            }
            "response.reasoning_summary_part.added" => {
                if self.reasoning.is_empty() {
                    Ok(Vec::new())
                } else {
                    self.emit_reasoning(THINKING_SEPARATOR)
                        .map(|value| vec![value])
                }
            }
            "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                let delta = event_object
                    .get("delta")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if delta.is_empty() {
                    Ok(Vec::new())
                } else {
                    self.emit_reasoning(delta).map(|value| vec![value])
                }
            }
            "response.output_text.delta" => {
                let delta = event_object
                    .get("delta")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if delta.is_empty() {
                    Ok(Vec::new())
                } else {
                    self.emit_text(delta).map(|value| vec![value])
                }
            }
            "response.output_item.done" => self.output_item_done(
                record_field(Some(event_object), "item"),
                number_field(Some(event_object), "output_index"),
            ),
            "response.completed" | "response.incomplete" | "response.failed" => {
                let response =
                    record_field(Some(event_object), "response").ok_or_else(codex_stream_failed)?;
                if event_type == "response.failed" {
                    return Err(failed_codex_response(response));
                }
                self.complete_response(response, event_type == "response.incomplete")
            }
            _ => Ok(Vec::new()),
        }
    }

    fn output_item_done(
        &mut self,
        item: Option<&JsonObject>,
        output_index: Option<f64>,
    ) -> AppResult<Vec<Value>> {
        let Some(item) = item else {
            return Ok(Vec::new());
        };
        let key = item_key(item, output_index.map(js_number));
        if self.seen_items.contains(&key) {
            return Ok(Vec::new());
        }
        self.remember_item(key)?;
        match string_field(Some(item), "type").unwrap_or("") {
            "message" => {
                self.terminal_text
                    .push_str(&output_texts(item.get("content")).concat());
                let terminal_text = self.terminal_text.clone();
                self.reconcile_terminal_text(&terminal_text)
            }
            "reasoning" => {
                let text = reasoning_text(item);
                if !self.terminal_reasoning.is_empty() && !text.is_empty() {
                    self.terminal_reasoning.push_str(THINKING_SEPARATOR);
                }
                self.terminal_reasoning.push_str(&text);
                let terminal_reasoning = self.terminal_reasoning.clone();
                let mut chunks = self.reconcile_terminal_reasoning(&terminal_reasoning)?;
                if let Some(signature) = string_field(Some(item), "encrypted_content") {
                    chunks.push(self.part_chunk(json!({
                        "thought": true,
                        "text": "",
                        "thoughtSignature": signature,
                    }))?);
                }
                Ok(chunks)
            }
            item_type @ ("function_call" | "custom_tool_call") => Ok(vec![self.part_chunk(
                function_call_part(item, item_type, &self.reverse_tool_names),
            )?]),
            "image_generation_call" => image_part(item)
                .map(|part| self.part_chunk(part).map(|chunk| vec![chunk]))
                .unwrap_or_else(|| Ok(Vec::new())),
            _ => Ok(Vec::new()),
        }
    }

    fn complete_response(
        &mut self,
        response: &JsonObject,
        incomplete: bool,
    ) -> AppResult<Vec<Value>> {
        self.update_metadata(Some(response));
        let output = match response.get("output") {
            None => &[][..],
            Some(Value::Array(output)) => output.as_slice(),
            Some(_) => return Err(codex_stream_failed()),
        };
        let mut chunks = Vec::new();
        let mut terminal_text = String::new();
        let mut terminal_reasoning = String::new();
        for (index, raw) in output.iter().enumerate() {
            let Some(item) = raw.as_object() else {
                continue;
            };
            let item_type = string_field(Some(item), "type").unwrap_or("");
            if item_type == "message" {
                terminal_text.push_str(&output_texts(item.get("content")).concat());
                if !self
                    .seen_items
                    .contains(&item_key(item, Some(index.to_string())))
                {
                    chunks.extend(self.reconcile_terminal_text(&terminal_text)?);
                }
                continue;
            }
            if item_type == "reasoning" {
                let text = reasoning_text(item);
                if !terminal_reasoning.is_empty() && !text.is_empty() {
                    terminal_reasoning.push_str(THINKING_SEPARATOR);
                }
                terminal_reasoning.push_str(&text);
                let key = item_key(item, Some(index.to_string()));
                if !self.seen_items.contains(&key) {
                    chunks.extend(self.reconcile_terminal_reasoning(&terminal_reasoning)?);
                    if let Some(signature) = string_field(Some(item), "encrypted_content") {
                        chunks.push(self.part_chunk(json!({
                            "thought": true,
                            "text": "",
                            "thoughtSignature": signature,
                        }))?);
                    }
                }
                continue;
            }
            let key = item_key(item, Some(index.to_string()));
            if self.seen_items.contains(&key) {
                continue;
            }
            self.remember_item(key)?;
            if matches!(item_type, "function_call" | "custom_tool_call") {
                chunks.push(self.part_chunk(function_call_part(
                    item,
                    item_type,
                    &self.reverse_tool_names,
                ))?);
            } else if item_type == "image_generation_call"
                && let Some(part) = image_part(item)
            {
                chunks.push(self.part_chunk(part)?);
            }
        }
        if !terminal_text.is_empty() {
            chunks.extend(self.reconcile_text(&terminal_text)?);
        }
        if !terminal_reasoning.is_empty() {
            chunks.extend(self.reconcile_reasoning(&terminal_reasoning)?);
        }
        let metadata = self.metadata()?;
        chunks.push(gemini_chunk(
            &metadata,
            Vec::new(),
            GeminiChunkOptions {
                finish_reason: Some(gemini_finish_reason(response, incomplete)),
                usage: record_field(Some(response), "usage"),
            },
        ));
        self.terminal = true;
        Ok(chunks)
    }

    fn emit_text(&mut self, text: &str) -> AppResult<Value> {
        self.reserve(utf16_len(text))?;
        self.text.push_str(text);
        self.part_chunk(json!({ "text": text }))
    }

    fn emit_reasoning(&mut self, text: &str) -> AppResult<Value> {
        self.reserve(utf16_len(text))?;
        self.reasoning.push_str(text);
        self.part_chunk(json!({ "thought": true, "text": text }))
    }

    fn reconcile_text(&mut self, terminal_text: &str) -> AppResult<Vec<Value>> {
        if terminal_text.is_empty() || terminal_text == self.text {
            return Ok(Vec::new());
        }
        let suffix = terminal_text
            .strip_prefix(&self.text)
            .ok_or_else(codex_stream_failed)?
            .to_owned();
        self.emit_text(&suffix).map(|value| vec![value])
    }

    fn reconcile_terminal_text(&mut self, terminal_text: &str) -> AppResult<Vec<Value>> {
        if terminal_text.starts_with(&self.text) {
            self.reconcile_text(terminal_text)
        } else if self.text.starts_with(terminal_text) {
            Ok(Vec::new())
        } else {
            Err(codex_stream_failed())
        }
    }

    fn reconcile_reasoning(&mut self, terminal_reasoning: &str) -> AppResult<Vec<Value>> {
        if terminal_reasoning.is_empty() || terminal_reasoning == self.reasoning {
            return Ok(Vec::new());
        }
        let suffix = terminal_reasoning
            .strip_prefix(&self.reasoning)
            .ok_or_else(codex_stream_failed)?
            .to_owned();
        self.emit_reasoning(&suffix).map(|value| vec![value])
    }

    fn reconcile_terminal_reasoning(&mut self, terminal_reasoning: &str) -> AppResult<Vec<Value>> {
        if terminal_reasoning.starts_with(&self.reasoning) {
            self.reconcile_reasoning(terminal_reasoning)
        } else if self.reasoning.starts_with(terminal_reasoning) {
            Ok(Vec::new())
        } else {
            Err(codex_stream_failed())
        }
    }

    fn part_chunk(&self, part: Value) -> AppResult<Value> {
        Ok(gemini_chunk(
            &self.metadata()?,
            vec![part],
            GeminiChunkOptions::default(),
        ))
    }

    fn metadata(&self) -> AppResult<GeminiResponseMetadata> {
        if self.id.is_empty() {
            return Err(codex_stream_failed());
        }
        Ok(GeminiResponseMetadata {
            id: self.id.clone(),
            model: if self.model.is_empty() {
                self.requested_model.clone()
            } else {
                self.model.clone()
            },
            created_at: self.created_at,
        })
    }

    fn update_metadata(&mut self, response: Option<&JsonObject>) {
        if let Some(id) = string_field(response, "id") {
            self.id = id.to_owned();
        }
        if let Some(model) = string_field(response, "model") {
            self.model = model.to_owned();
        }
        if let Some(created_at) = number_field(response, "created_at") {
            self.created_at = Some(created_at);
        }
    }

    fn remember_item(&mut self, key: String) -> AppResult<()> {
        if self.seen_items.len() >= MAX_OUTPUT_ITEMS {
            return Err(codex_stream_failed());
        }
        self.reserve(utf16_len(&key))?;
        self.seen_items.insert(key);
        Ok(())
    }

    fn reserve(&mut self, additional: usize) -> AppResult<()> {
        if additional > MAX_RETAINED_CHARS.saturating_sub(self.retained_chars) {
            return Err(codex_stream_failed());
        }
        self.retained_chars += additional;
        Ok(())
    }
}

fn item_key(item: &JsonObject, output_index: Option<String>) -> String {
    string_field(Some(item), "id")
        .or_else(|| string_field(Some(item), "call_id"))
        .map(str::to_owned)
        .unwrap_or_else(|| {
            format!(
                "{}:{}",
                string_field(Some(item), "type").unwrap_or("item"),
                output_index.as_deref().unwrap_or("unknown")
            )
        })
}

fn js_number(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{value:.0}")
    } else {
        value.to_string()
    }
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}
