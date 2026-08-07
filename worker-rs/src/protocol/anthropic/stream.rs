use std::collections::{HashMap, HashSet, VecDeque};

use serde_json::{Value, json};

use crate::core::{ApiError, AppResult, JsonObject, number_field, record_field, string_field};

use super::error::{anthropic_error_payload, codex_event_error};
use super::identifiers::{claude_tool_name, claude_tool_use_id};
use super::response::{
    claude_stop_reason, claude_usage, claude_usage_object, failed_codex_response,
    incomplete_codex_stream, output_texts, reasoning_text,
};
use super::{AnthropicSseEvent, empty_object, into_object};

const MAX_RETAINED_CHARS: usize = 8 * 1024 * 1024;
const MAX_TOOL_CALLS: usize = 128;
const MAX_TOOL_ALIASES: usize = MAX_TOOL_CALLS * 3;
const THINKING_PART_SEPARATOR: &str = "\n\n";

#[derive(Debug, Clone)]
struct ToolCallStream {
    call_id: String,
    name: String,
    block_index: usize,
    arguments: String,
    emitted_arguments_bytes: usize,
    has_received_delta: bool,
    emit_initial_empty_delta: bool,
    started: bool,
    done: bool,
    closed: bool,
}

/// Pure presentation state machine for Codex Responses events.
///
/// A transport decodes upstream SSE JSON and feeds each value to [`Self::push`].
/// Protocol failures are represented as a final Anthropic `error` event; no
/// Worker stream or execution-context type crosses this boundary.
#[derive(Debug, Clone)]
pub struct MessagesStreamPresenter {
    requested_model: String,
    reverse_tool_names: HashMap<String, String>,
    id: String,
    model: String,
    message_started: bool,
    terminal: bool,
    block_index: usize,
    text_block_open: bool,
    thinking_block_open: bool,
    thinking_signature: String,
    thinking_summary_seen: bool,
    current_thinking_text: String,
    completed_reasoning_blocks: usize,
    has_text_delta: bool,
    text: String,
    has_emitted_tool_use: bool,
    retained_chars: usize,
    tools: Vec<ToolCallStream>,
    tool_aliases: HashMap<String, usize>,
    tool_queue: VecDeque<usize>,
    active_tool: Option<usize>,
    last_tool: Option<usize>,
    deferred: Vec<JsonObject>,
    web_search_ids: HashSet<String>,
}

impl MessagesStreamPresenter {
    pub fn new(model: impl Into<String>, reverse_tool_names: HashMap<String, String>) -> Self {
        let model = model.into();
        Self {
            requested_model: model.clone(),
            reverse_tool_names,
            id: String::new(),
            model,
            message_started: false,
            terminal: false,
            block_index: 0,
            text_block_open: false,
            thinking_block_open: false,
            thinking_signature: String::new(),
            thinking_summary_seen: false,
            current_thinking_text: String::new(),
            completed_reasoning_blocks: 0,
            has_text_delta: false,
            text: String::new(),
            has_emitted_tool_use: false,
            retained_chars: 0,
            tools: Vec::new(),
            tool_aliases: HashMap::new(),
            tool_queue: VecDeque::new(),
            active_tool: None,
            last_tool: None,
            deferred: Vec::new(),
            web_search_ids: HashSet::new(),
        }
    }

    pub fn push(&mut self, event: Value) -> Vec<AnthropicSseEvent> {
        if self.terminal {
            return Vec::new();
        }
        let result = event
            .as_object()
            .cloned()
            .ok_or_else(codex_stream_failed)
            .and_then(|event| self.translate_event(event));
        match result {
            Ok(events) => events,
            Err(error) => self.fail(error),
        }
    }

    pub fn finish(&mut self) -> Vec<AnthropicSseEvent> {
        if self.terminal {
            Vec::new()
        } else {
            self.fail(incomplete_codex_stream())
        }
    }

    pub fn is_terminal(&self) -> bool {
        self.terminal
    }

    fn fail(&mut self, error: ApiError) -> Vec<AnthropicSseEvent> {
        self.terminal = true;
        self.deferred.clear();
        vec![AnthropicSseEvent::new(
            "error",
            anthropic_error_payload(&error, None),
        )]
    }

    fn translate_event(&mut self, event: JsonObject) -> AppResult<Vec<AnthropicSseEvent>> {
        if self.terminal {
            return Ok(Vec::new());
        }
        let kind = string_field(Some(&event), "type")
            .unwrap_or_default()
            .to_owned();
        if self.active_tool.is_some() && should_defer(&kind, &event) {
            self.reserve(json_char_len(&Value::Object(event.clone())) as isize)?;
            self.deferred.push(event);
            return Ok(Vec::new());
        }

        let mut output = Vec::new();
        match kind.as_str() {
            "error" => return Err(codex_event_error(&event)),
            "response.created" => {
                let response = record_field(Some(&event), "response").cloned();
                output.extend(self.ensure_message_start(response.as_ref())?);
                return Ok(output);
            }
            "response.reasoning_summary_part.added" => {
                output.extend(self.ensure_message_start(None)?);
                output.extend(self.stop_text_block());
                if self.thinking_block_open {
                    output.extend(self.append_thinking_delta(THINKING_PART_SEPARATOR)?);
                } else {
                    output.extend(self.start_thinking_block());
                }
                self.thinking_summary_seen = true;
            }
            "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                output.extend(self.ensure_message_start(None)?);
                output.extend(self.stop_text_block());
                output.extend(self.start_thinking_block());
                output.extend(self.append_thinking_delta(string_value(event.get("delta")))?);
                self.thinking_summary_seen = true;
            }
            "response.content_part.added" => {
                output.extend(self.ensure_message_start(None)?);
                output.extend(self.finalize_thinking_block());
                if string_field(record_field(Some(&event), "part"), "type") == Some("output_text") {
                    output.extend(self.start_text_block());
                }
            }
            "response.output_text.delta" => {
                output.extend(self.ensure_message_start(None)?);
                output.extend(self.finalize_thinking_block());
                output.extend(self.start_text_block());
                let delta = string_value(event.get("delta")).to_owned();
                if !delta.is_empty() {
                    self.reserve(utf16_len(&delta) as isize)?;
                    self.text.push_str(&delta);
                    self.has_text_delta = true;
                    output.push(content_delta(
                        self.block_index,
                        into_object(json!({"type": "text_delta", "text": delta})),
                    ));
                }
            }
            "response.content_part.done" => {
                if string_field(record_field(Some(&event), "part"), "type") == Some("output_text") {
                    output.extend(self.stop_text_block());
                }
            }
            "response.output_item.added" => output.extend(self.handle_output_item_added(&event)?),
            "response.output_item.done" => output.extend(self.handle_output_item_done(&event)?),
            "response.function_call_arguments.delta" | "response.custom_tool_call_input.delta" => {
                let call = self.find_or_create_tool(&event)?;
                self.update_tool_arguments(call, string_value(event.get("delta")), true)?;
                output.extend(self.flush_tool_queue()?);
            }
            "response.function_call_arguments.done" | "response.custom_tool_call_input.done" => {
                let call = self.find_or_create_tool(&event)?;
                let value = if kind.contains("custom_tool") {
                    string_value(event.get("input"))
                } else {
                    string_value(event.get("arguments"))
                };
                self.update_tool_arguments(call, value, false)?;
                output.extend(self.flush_tool_queue()?);
            }
            "response.completed" | "response.incomplete" | "response.failed" => {
                let response = record_field(Some(&event), "response")
                    .cloned()
                    .ok_or_else(codex_stream_failed)?;
                if kind == "response.failed" {
                    return Err(failed_codex_response(&response));
                }
                return self.complete_message(&response);
            }
            _ => {}
        }
        self.drain_deferred_if_ready(output)
    }

    fn handle_output_item_added(
        &mut self,
        event: &JsonObject,
    ) -> AppResult<Vec<AnthropicSseEvent>> {
        let Some(item) = record_field(Some(event), "item").cloned() else {
            return Ok(Vec::new());
        };
        let kind = string_field(Some(&item), "type").unwrap_or_default();
        let mut output = Vec::new();
        if is_function_call_type(kind) {
            output.extend(self.ensure_message_start(None)?);
            output.extend(self.finalize_thinking_block());
            output.extend(self.stop_text_block());
            let call = self.ensure_tool(event, &item)?;
            if !self.tools[call].name.is_empty() {
                self.tools[call].emit_initial_empty_delta = true;
            }
            output.extend(self.flush_tool_queue()?);
        } else if kind == "reasoning" {
            output.extend(self.ensure_message_start(None)?);
            output.extend(self.stop_text_block());
            output.extend(self.finalize_thinking_block());
            self.thinking_summary_seen = false;
            self.current_thinking_text.clear();
            self.thinking_signature = string_field(Some(&item), "encrypted_content")
                .unwrap_or_default()
                .to_owned();
        }
        Ok(output)
    }

    fn handle_output_item_done(&mut self, event: &JsonObject) -> AppResult<Vec<AnthropicSseEvent>> {
        let Some(item) = record_field(Some(event), "item").cloned() else {
            return Ok(Vec::new());
        };
        let kind = string_field(Some(&item), "type").unwrap_or_default();
        let mut output = Vec::new();
        if kind == "message" {
            if self.has_text_delta {
                return Ok(output);
            }
            let text = output_texts(item.get("content")).join("");
            if text.is_empty() {
                return Ok(output);
            }
            output.extend(self.ensure_message_start(None)?);
            output.extend(self.finalize_thinking_block());
            output.extend(self.start_text_block());
            self.reserve(utf16_len(&text) as isize)?;
            self.text.push_str(&text);
            self.has_text_delta = true;
            output.push(content_delta(
                self.block_index,
                into_object(json!({"type": "text_delta", "text": text})),
            ));
            output.extend(self.stop_text_block());
        } else if is_function_call_type(kind) {
            output.extend(self.ensure_message_start(None)?);
            output.extend(self.finalize_thinking_block());
            output.extend(self.stop_text_block());
            let call = self.ensure_tool(event, &item)?;
            self.update_tool_arguments(call, &tool_arguments(&item), false)?;
            self.tools[call].done = true;
            output.extend(self.flush_tool_queue()?);
        } else if kind == "reasoning" {
            output.extend(self.ensure_message_start(None)?);
            output.extend(self.stop_text_block());
            let final_text = reasoning_text_for_stream(&item);
            if !final_text.is_empty() {
                output.extend(self.start_thinking_block());
                output.extend(self.reconcile_thinking_text(&final_text)?);
            }
            if let Some(signature) = string_field(Some(&item), "encrypted_content") {
                self.thinking_signature = signature.to_owned();
            }
            if self.thinking_block_open || !self.thinking_signature.is_empty() {
                output.extend(self.start_thinking_block());
                output.extend(self.finalize_thinking_block());
                self.completed_reasoning_blocks += 1;
            }
            self.thinking_signature.clear();
            self.thinking_summary_seen = false;
            self.current_thinking_text.clear();
        } else if kind == "web_search_call" {
            output.extend(self.append_web_search(&item)?);
        }
        Ok(output)
    }

    fn complete_message(&mut self, response: &JsonObject) -> AppResult<Vec<AnthropicSseEvent>> {
        let mut output = self.ensure_message_start(Some(response))?;
        if response
            .get("output")
            .is_some_and(|value| !value.is_array())
        {
            return Err(codex_stream_failed());
        }
        let terminal_output = response
            .get("output")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut reasoning_index = 0usize;
        let mut final_text = String::new();
        for (index, raw_item) in terminal_output.iter().enumerate() {
            let Some(item) = raw_item.as_object() else {
                continue;
            };
            let kind = string_field(Some(item), "type").unwrap_or_default();
            if kind == "reasoning" {
                if reasoning_index < self.completed_reasoning_blocks {
                    reasoning_index += 1;
                    continue;
                }
                reasoning_index += 1;
                output.extend(self.stop_text_block());
                let text = reasoning_text_for_stream(item);
                output.extend(self.start_thinking_block());
                output.extend(self.reconcile_thinking_text(&text)?);
                self.thinking_signature = string_field(Some(item), "encrypted_content")
                    .unwrap_or_default()
                    .to_owned();
                output.extend(self.finalize_thinking_block());
                self.completed_reasoning_blocks += 1;
            } else if kind == "message" {
                final_text.push_str(&output_texts(item.get("content")).join(""));
                output.extend(self.reconcile_terminal_text(&final_text)?);
            } else if is_function_call_type(kind) {
                output.extend(self.finalize_thinking_block());
                output.extend(self.stop_text_block());
                let event = into_object(json!({"output_index": index}));
                let call = self.ensure_tool(&event, item)?;
                self.update_tool_arguments(call, &tool_arguments(item), false)?;
                self.tools[call].done = true;
                output.extend(self.flush_tool_queue()?);
            } else if kind == "web_search_call" {
                output.extend(self.append_web_search(item)?);
            }
        }
        if !final_text.is_empty() {
            output.extend(self.reconcile_text(&final_text)?);
        }
        for call in self.tool_queue.iter().copied() {
            self.tools[call].done = true;
        }
        output.extend(self.flush_tool_queue()?);
        output.extend(self.finalize_thinking_block());
        output.extend(self.stop_text_block());
        self.deferred.clear();

        let mut delta = into_object(json!({
            "type": "message_delta",
            "delta": {
                "stop_reason": claude_stop_reason(response, self.has_emitted_tool_use),
                "stop_sequence": response
                    .get("stop_sequence")
                    .and_then(Value::as_str)
                    .map(Value::from)
                    .unwrap_or(Value::Null),
            },
        }));
        delta.insert(
            "usage".into(),
            Value::Object(claude_usage_object(&claude_usage(record_field(
                Some(response),
                "usage",
            )))),
        );
        output.push(AnthropicSseEvent::new("message_delta", delta));
        output.push(AnthropicSseEvent::new(
            "message_stop",
            into_object(json!({"type": "message_stop"})),
        ));
        self.terminal = true;
        Ok(output)
    }

    fn reconcile_terminal_text(
        &mut self,
        terminal_text: &str,
    ) -> AppResult<Vec<AnthropicSseEvent>> {
        if terminal_text.starts_with(&self.text) {
            self.reconcile_text(terminal_text)
        } else if self.text.starts_with(terminal_text) {
            Ok(Vec::new())
        } else {
            Err(codex_stream_failed())
        }
    }

    fn ensure_message_start(
        &mut self,
        response: Option<&JsonObject>,
    ) -> AppResult<Vec<AnthropicSseEvent>> {
        if let Some(response) = response {
            if let Some(id) = string_field(Some(response), "id") {
                self.id = id.to_owned();
            }
            if let Some(model) = string_field(Some(response), "model") {
                self.model = model.to_owned();
            }
        }
        if self.message_started {
            return Ok(Vec::new());
        }
        if self.id.is_empty() {
            return Err(codex_stream_failed());
        }
        self.message_started = true;
        let usage = claude_usage(record_field(response, "usage"));
        Ok(vec![AnthropicSseEvent::new(
            "message_start",
            into_object(json!({
                "type": "message_start",
                "message": {
                    "id": self.id,
                    "type": "message",
                    "role": "assistant",
                    "model": if self.model.is_empty() { &self.requested_model } else { &self.model },
                    "content": [],
                    "stop_reason": null,
                    "stop_sequence": null,
                    "usage": claude_usage_object(&usage),
                },
            })),
        )])
    }

    fn start_text_block(&mut self) -> Vec<AnthropicSseEvent> {
        if self.text_block_open {
            return Vec::new();
        }
        self.text_block_open = true;
        vec![content_start(
            self.block_index,
            into_object(json!({"type": "text", "text": ""})),
        )]
    }

    fn stop_text_block(&mut self) -> Vec<AnthropicSseEvent> {
        if !self.text_block_open {
            return Vec::new();
        }
        let index = self.block_index;
        self.block_index += 1;
        self.text_block_open = false;
        vec![content_stop(index)]
    }

    fn start_thinking_block(&mut self) -> Vec<AnthropicSseEvent> {
        if self.thinking_block_open {
            return Vec::new();
        }
        self.thinking_block_open = true;
        self.current_thinking_text.clear();
        vec![content_start(
            self.block_index,
            into_object(json!({"type": "thinking", "thinking": ""})),
        )]
    }

    fn append_thinking_delta(&mut self, text: &str) -> AppResult<Vec<AnthropicSseEvent>> {
        if text.is_empty() {
            return Ok(Vec::new());
        }
        self.reserve(utf16_len(text) as isize)?;
        self.current_thinking_text.push_str(text);
        Ok(vec![content_delta(
            self.block_index,
            into_object(json!({"type": "thinking_delta", "thinking": text})),
        )])
    }

    fn reconcile_thinking_text(&mut self, final_text: &str) -> AppResult<Vec<AnthropicSseEvent>> {
        if final_text.is_empty() || final_text == self.current_thinking_text {
            return Ok(Vec::new());
        }
        let Some(delta) = final_text.strip_prefix(&self.current_thinking_text) else {
            return Err(codex_stream_failed());
        };
        self.append_thinking_delta(delta)
    }

    fn finalize_thinking_block(&mut self) -> Vec<AnthropicSseEvent> {
        if !self.thinking_block_open {
            return Vec::new();
        }
        let index = self.block_index;
        self.block_index += 1;
        let mut output = Vec::new();
        if !self.thinking_signature.is_empty() {
            output.push(content_delta(
                index,
                into_object(json!({
                    "type": "signature_delta",
                    "signature": self.thinking_signature,
                })),
            ));
        }
        output.push(content_stop(index));
        self.thinking_block_open = false;
        self.current_thinking_text.clear();
        output
    }

    fn reconcile_text(&mut self, final_text: &str) -> AppResult<Vec<AnthropicSseEvent>> {
        if final_text == self.text {
            return Ok(Vec::new());
        }
        let Some(delta) = final_text.strip_prefix(&self.text).map(str::to_owned) else {
            return Err(codex_stream_failed());
        };
        if delta.is_empty() {
            return Ok(Vec::new());
        }
        let mut output = self.finalize_thinking_block();
        output.extend(self.start_text_block());
        self.reserve(utf16_len(&delta) as isize)?;
        self.text = final_text.to_owned();
        self.has_text_delta = true;
        output.push(content_delta(
            self.block_index,
            into_object(json!({"type": "text_delta", "text": delta})),
        ));
        Ok(output)
    }

    fn append_web_search(&mut self, item: &JsonObject) -> AppResult<Vec<AnthropicSseEvent>> {
        let raw_id = string_field(Some(item), "id")
            .map(str::to_owned)
            .unwrap_or_else(|| format!("web_search_{}", self.block_index));
        let id = claude_tool_use_id(&raw_id, &format!("web_search_{}", self.block_index));
        if self.web_search_ids.contains(&id) {
            return Ok(Vec::new());
        }
        let action = record_field(Some(item), "action");
        let query = string_field(action, "query")
            .or_else(|| string_field(Some(item), "query"))
            .map(str::to_owned);
        let results = item
            .get("results")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if query.is_none() && results.is_empty() {
            return Ok(Vec::new());
        }
        self.web_search_ids.insert(id.clone());
        let mut output = self.ensure_message_start(None)?;
        output.extend(self.finalize_thinking_block());
        output.extend(self.stop_text_block());
        let mut index = self.block_index;
        self.block_index += 1;
        output.push(content_start(
            index,
            into_object(json!({
                "type": "server_tool_use",
                "id": id,
                "name": "web_search",
                "input": {},
            })),
        ));
        if let Some(query) = &query {
            output.push(content_delta(
                index,
                into_object(json!({
                    "type": "input_json_delta",
                    "partial_json": json!({"query": query}).to_string(),
                })),
            ));
        }
        output.push(content_stop(index));

        let content = results
            .iter()
            .filter_map(Value::as_object)
            .filter_map(|result| {
                let url = string_field(Some(result), "url")?;
                Some(json!({
                    "type": "web_search_result",
                    "title": string_field(Some(result), "title").unwrap_or(url),
                    "url": url,
                    "page_age": null,
                }))
            })
            .collect::<Vec<_>>();
        index = self.block_index;
        self.block_index += 1;
        output.push(content_start(
            index,
            into_object(json!({
                "type": "web_search_tool_result",
                "tool_use_id": id,
                "content": content,
            })),
        ));
        output.push(content_stop(index));
        Ok(output)
    }

    fn find_or_create_tool(&mut self, event: &JsonObject) -> AppResult<usize> {
        match self.find_tool(event)? {
            Some(call) => Ok(call),
            None => self.ensure_tool(event, &empty_object()),
        }
    }

    fn ensure_tool(&mut self, event: &JsonObject, item: &JsonObject) -> AppResult<usize> {
        let keys = tool_keys(event, item);
        let mut call = unique_tools(
            keys.iter()
                .filter_map(|key| self.tool_aliases.get(key).copied()),
        )?;
        if call.is_none() {
            if self.tool_queue.len() >= MAX_TOOL_CALLS {
                return Err(codex_stream_failed());
            }
            let index = self.tools.len();
            let call_id = string_field(Some(item), "call_id")
                .or_else(|| string_field(Some(event), "call_id"))
                .or_else(|| string_field(Some(item), "id"))
                .map(str::to_owned)
                .unwrap_or_else(|| format!("tool_{}", self.tool_queue.len()));
            let name = string_field(Some(item), "name")
                .unwrap_or_default()
                .to_owned();
            self.reserve((utf16_len(&call_id) + utf16_len(&name)) as isize)?;
            self.tools.push(ToolCallStream {
                call_id,
                name,
                block_index: 0,
                arguments: String::new(),
                emitted_arguments_bytes: 0,
                has_received_delta: false,
                emit_initial_empty_delta: false,
                started: false,
                done: false,
                closed: false,
            });
            self.tool_queue.push_back(index);
            call = Some(index);
        }
        let Some(call) = call else {
            return Err(codex_stream_failed());
        };
        if let Some(call_id) =
            string_field(Some(item), "call_id").or_else(|| string_field(Some(event), "call_id"))
        {
            self.tools[call].call_id = call_id.to_owned();
        }
        if let Some(name) = string_field(Some(item), "name")
            && name != self.tools[call].name
        {
            self.reserve(utf16_len(name) as isize)?;
            self.tools[call].name = name.to_owned();
        }
        for key in keys {
            self.register_tool_alias(key, call)?;
        }
        self.last_tool = Some(call);
        Ok(call)
    }

    fn find_tool(&self, event: &JsonObject) -> AppResult<Option<usize>> {
        let keys = tool_keys(event, &empty_object());
        let found = unique_tools(
            keys.iter()
                .filter_map(|key| self.tool_aliases.get(key).copied()),
        )?;
        Ok(found.or_else(|| keys.is_empty().then_some(self.last_tool).flatten()))
    }

    fn register_tool_alias(&mut self, key: String, call: usize) -> AppResult<()> {
        if let Some(existing) = self.tool_aliases.get(&key) {
            return if *existing == call {
                Ok(())
            } else {
                Err(codex_stream_failed())
            };
        }
        if self.tool_aliases.len() >= MAX_TOOL_ALIASES {
            return Err(codex_stream_failed());
        }
        self.reserve(utf16_len(&key) as isize)?;
        self.tool_aliases.insert(key, call);
        Ok(())
    }

    fn update_tool_arguments(&mut self, call: usize, value: &str, is_delta: bool) -> AppResult<()> {
        if value.is_empty() {
            return Ok(());
        }
        if is_delta {
            self.reserve(utf16_len(value) as isize)?;
            self.tools[call].arguments.push_str(value);
            self.tools[call].has_received_delta = true;
            return Ok(());
        }
        if !self.tools[call].has_received_delta {
            let additional =
                utf16_len(value) as isize - utf16_len(&self.tools[call].arguments) as isize;
            self.reserve(additional)?;
            self.tools[call].arguments = value.to_owned();
            return Ok(());
        }
        if !value.starts_with(&self.tools[call].arguments) {
            return Err(codex_stream_failed());
        }
        let additional =
            utf16_len(value) as isize - utf16_len(&self.tools[call].arguments) as isize;
        self.reserve(additional)?;
        self.tools[call].arguments = value.to_owned();
        Ok(())
    }

    fn flush_tool_queue(&mut self) -> AppResult<Vec<AnthropicSseEvent>> {
        let mut output = Vec::new();
        loop {
            if let Some(active) = self.active_tool {
                output.extend(emit_buffered_tool_arguments(&mut self.tools[active]));
                if !self.tools[active].done {
                    return Ok(output);
                }
                output.push(content_stop(self.tools[active].block_index));
                self.block_index = self.block_index.max(self.tools[active].block_index + 1);
                self.tools[active].closed = true;
                self.active_tool = None;
                self.tool_queue.retain(|call| *call != active);
            }
            while self
                .tool_queue
                .front()
                .is_some_and(|call| self.tools[*call].closed)
            {
                self.tool_queue.pop_front();
            }
            let Some(call) = self.tool_queue.front().copied() else {
                return Ok(output);
            };
            if self.tools[call].name.is_empty() {
                return Ok(output);
            }
            output.extend(self.ensure_message_start(None)?);
            output.extend(self.finalize_thinking_block());
            output.extend(self.stop_text_block());
            let block_index = self.block_index;
            self.tools[call].block_index = block_index;
            let id = claude_tool_use_id(&self.tools[call].call_id, &format!("toolu_{block_index}"));
            let name = claude_tool_name(&self.tools[call].name, &self.reverse_tool_names);
            output.push(content_start(
                block_index,
                into_object(json!({
                    "type": "tool_use",
                    "id": id,
                    "name": name,
                    "input": {},
                })),
            ));
            if self.tools[call].emit_initial_empty_delta {
                output.push(content_delta(
                    block_index,
                    into_object(json!({
                        "type": "input_json_delta",
                        "partial_json": "",
                    })),
                ));
            }
            self.tools[call].started = true;
            self.active_tool = Some(call);
            self.has_emitted_tool_use = true;
            output.extend(emit_buffered_tool_arguments(&mut self.tools[call]));
        }
    }

    fn drain_deferred_if_ready(
        &mut self,
        mut output: Vec<AnthropicSseEvent>,
    ) -> AppResult<Vec<AnthropicSseEvent>> {
        if self.active_tool.is_some() || !self.tool_queue.is_empty() || self.deferred.is_empty() {
            return Ok(output);
        }
        let deferred = std::mem::take(&mut self.deferred);
        for event in deferred {
            output.extend(self.translate_event(event)?);
        }
        Ok(output)
    }

    fn reserve(&mut self, additional: isize) -> AppResult<()> {
        if additional <= 0 {
            return Ok(());
        }
        let additional = additional as usize;
        if self.retained_chars > MAX_RETAINED_CHARS.saturating_sub(additional) {
            return Err(codex_stream_failed());
        }
        self.retained_chars += additional;
        Ok(())
    }
}

fn tool_keys(event: &JsonObject, item: &JsonObject) -> Vec<String> {
    let mut keys = Vec::new();
    if let Some(output_index) = number_field(Some(event), "output_index") {
        keys.push(format!("output:{}", javascript_number(output_index)));
    }
    for value in [
        string_field(Some(item), "call_id"),
        string_field(Some(event), "call_id"),
    ]
    .into_iter()
    .flatten()
    {
        keys.push(format!("call:{value}"));
    }
    for value in [
        string_field(Some(item), "id"),
        string_field(Some(event), "item_id"),
    ]
    .into_iter()
    .flatten()
    {
        keys.push(format!("item:{value}"));
    }
    let mut seen = HashSet::new();
    keys.retain(|key| seen.insert(key.clone()));
    keys
}

fn unique_tools(values: impl IntoIterator<Item = usize>) -> AppResult<Option<usize>> {
    let mut result = None;
    for value in values {
        if result.is_some_and(|current| current != value) {
            return Err(codex_stream_failed());
        }
        result = Some(value);
    }
    Ok(result)
}

fn emit_buffered_tool_arguments(call: &mut ToolCallStream) -> Vec<AnthropicSseEvent> {
    if !call.started || call.closed || call.emitted_arguments_bytes >= call.arguments.len() {
        return Vec::new();
    }
    let partial_json = call.arguments[call.emitted_arguments_bytes..].to_owned();
    call.emitted_arguments_bytes = call.arguments.len();
    vec![content_delta(
        call.block_index,
        into_object(json!({
            "type": "input_json_delta",
            "partial_json": partial_json,
        })),
    )]
}

fn should_defer(kind: &str, event: &JsonObject) -> bool {
    if matches!(
        kind,
        "error"
            | "response.completed"
            | "response.incomplete"
            | "response.failed"
            | "response.function_call_arguments.delta"
            | "response.function_call_arguments.done"
            | "response.custom_tool_call_input.delta"
            | "response.custom_tool_call_input.done"
    ) {
        return false;
    }
    if matches!(
        kind,
        "response.output_item.added" | "response.output_item.done"
    ) {
        return !is_function_call_type(
            string_field(record_field(Some(event), "item"), "type").unwrap_or_default(),
        );
    }
    true
}

fn content_start(index: usize, block: JsonObject) -> AnthropicSseEvent {
    AnthropicSseEvent::new(
        "content_block_start",
        into_object(json!({
            "type": "content_block_start",
            "index": index,
            "content_block": block,
        })),
    )
}

fn content_delta(index: usize, delta: JsonObject) -> AnthropicSseEvent {
    AnthropicSseEvent::new(
        "content_block_delta",
        into_object(json!({
            "type": "content_block_delta",
            "index": index,
            "delta": delta,
        })),
    )
}

fn content_stop(index: usize) -> AnthropicSseEvent {
    AnthropicSseEvent::new(
        "content_block_stop",
        into_object(json!({"type": "content_block_stop", "index": index})),
    )
}

fn reasoning_text_for_stream(item: &JsonObject) -> String {
    if let Some(summary) = item.get("summary").and_then(Value::as_array) {
        return summary
            .iter()
            .filter_map(Value::as_object)
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join(THINKING_PART_SEPARATOR);
    }
    reasoning_text(item)
}

fn tool_arguments(item: &JsonObject) -> String {
    if item.get("type").and_then(Value::as_str) == Some("custom_tool_call") {
        string_field(Some(item), "input")
            .unwrap_or_default()
            .to_owned()
    } else {
        string_field(Some(item), "arguments")
            .unwrap_or("{}")
            .to_owned()
    }
}

fn is_function_call_type(kind: &str) -> bool {
    matches!(kind, "function_call" | "custom_tool_call")
}

fn string_value(value: Option<&Value>) -> &str {
    value.and_then(Value::as_str).unwrap_or_default()
}

fn codex_stream_failed() -> ApiError {
    ApiError::new(502, "The Codex response stream failed.")
        .with_kind("upstream_error")
        .with_code("codex_stream_failed")
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn json_char_len(value: &Value) -> usize {
    value.to_string().encode_utf16().count()
}

fn javascript_number(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{}", value as i64)
    } else {
        value.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(
        events: impl IntoIterator<Item = Value>,
        reverse_tool_names: HashMap<String, String>,
    ) -> Vec<AnthropicSseEvent> {
        let mut presenter = MessagesStreamPresenter::new("requested-model", reverse_tool_names);
        let mut output = Vec::new();
        for event in events {
            output.extend(presenter.push(event));
        }
        output.extend(presenter.finish());
        output
    }

    fn find_event<'a>(
        events: &'a [AnthropicSseEvent],
        event: &str,
        index: Option<usize>,
    ) -> Option<(usize, &'a AnthropicSseEvent)> {
        events.iter().enumerate().find(|(_, item)| {
            item.event == event
                && index.is_none_or(|index| {
                    item.data.get("index").and_then(Value::as_u64) == Some(index as u64)
                })
        })
    }

    fn data_pointer<'a>(event: &'a AnthropicSseEvent, pointer: &str) -> Option<&'a Value> {
        match pointer {
            "/content_block/name" => event
                .data
                .get("content_block")
                .and_then(Value::as_object)
                .and_then(|block| block.get("name")),
            "/content_block/id" => event
                .data
                .get("content_block")
                .and_then(Value::as_object)
                .and_then(|block| block.get("id")),
            "/delta/text" => event
                .data
                .get("delta")
                .and_then(Value::as_object)
                .and_then(|delta| delta.get("text")),
            _ => None,
        }
    }

    #[test]
    fn emits_valid_block_order_and_defers_text_around_tools() {
        let signature = format!("gAAAA{}", "B".repeat(120));
        let events = vec![
            json!({"type": "response.created", "response": {"id": "resp_stream", "model": "resolved-model"}}),
            json!({"type": "response.output_item.added", "output_index": 0, "item": {"id": "rs_1", "type": "reasoning", "summary": []}}),
            json!({"type": "response.reasoning_summary_text.delta", "delta": "thinking"}),
            json!({"type": "response.output_item.done", "output_index": 0, "item": {"id": "rs_1", "type": "reasoning", "summary": [{"type": "summary_text", "text": "thinking"}], "encrypted_content": signature}}),
            json!({"type": "response.output_item.added", "output_index": 1, "item": {"id": "fc_1", "type": "function_call", "call_id": "call_1", "name": "lookup_short"}}),
            json!({"type": "response.function_call_arguments.delta", "item_id": "fc_1", "delta": "{\"q\":"}),
            json!({"type": "response.output_text.delta", "delta": "answer"}),
            json!({"type": "response.function_call_arguments.delta", "item_id": "fc_1", "delta": "\"worker\"}"}),
            json!({"type": "response.output_item.done", "output_index": 1, "item": {"id": "fc_1", "type": "function_call", "call_id": "call_1", "name": "lookup_short", "arguments": "{\"q\":\"worker\"}"}}),
            json!({"type": "response.completed", "response": {
                "id": "resp_stream", "model": "resolved-model",
                "usage": {"input_tokens": 20, "output_tokens": 7, "input_tokens_details": {"cached_tokens": 3}},
                "output": [
                    {"type": "reasoning", "summary": [{"type": "summary_text", "text": "thinking"}], "encrypted_content": signature},
                    {"type": "function_call", "call_id": "call_1", "name": "lookup_short", "arguments": "{\"q\":\"worker\"}"},
                    {"type": "message", "content": [{"type": "output_text", "text": "answer"}]}
                ]
            }}),
        ];
        let output = render(
            events,
            HashMap::from([("lookup_short".into(), "lookup_original".into())]),
        );

        assert_eq!(output.first().unwrap().event, "message_start");
        let thinking_stop = find_event(&output, "content_block_stop", Some(0))
            .unwrap()
            .0;
        let tool_start = find_event(&output, "content_block_start", Some(1))
            .unwrap()
            .0;
        let tool_stop = find_event(&output, "content_block_stop", Some(1))
            .unwrap()
            .0;
        let text_start = find_event(&output, "content_block_start", Some(2))
            .unwrap()
            .0;
        assert!(thinking_stop < tool_start && tool_start < tool_stop && tool_stop < text_start);
        assert!(
            output
                .iter()
                .any(|event| data_pointer(event, "/content_block/name")
                    == Some(&json!("lookup_original")))
        );
        assert!(
            output
                .iter()
                .any(|event| data_pointer(event, "/delta/text") == Some(&json!("answer")))
        );
        assert_eq!(output.last().unwrap().event, "message_stop");
        let message_delta = output
            .iter()
            .find(|event| event.event == "message_delta")
            .unwrap();
        assert_eq!(
            message_delta.data["usage"],
            json!({
                "input_tokens": 17,
                "output_tokens": 7,
                "cache_read_input_tokens": 3
            })
        );
        assert_eq!(message_delta.data["delta"]["stop_reason"], "tool_use");
    }

    #[test]
    fn finish_emits_an_anthropic_error_for_truncated_streams() {
        let output = render(
            [
                json!({"type": "response.created", "response": {"id": "resp_truncated", "model": "model"}}),
                json!({"type": "response.output_text.delta", "delta": "partial"}),
            ],
            HashMap::new(),
        );
        assert_eq!(output.last().unwrap().event, "error");
        assert_eq!(output.last().unwrap().data["error"]["type"], "api_error");
        assert!(!output.iter().any(|event| event.event == "message_stop"));
    }

    #[test]
    fn preserves_terminal_only_text_and_tool_block_order() {
        let output = render(
            [json!({"type": "response.completed", "response": {
                "id": "resp_terminal", "model": "model",
                "usage": {"input_tokens": 5, "output_tokens": 4},
                "output": [
                    {"type": "message", "content": [{"type": "output_text", "text": "before"}]},
                    {"type": "function_call", "call_id": "call_terminal", "name": "lookup", "arguments": "{\"q\":\"worker\"}"},
                    {"type": "message", "content": [{"type": "output_text", "text": "after"}]}
                ]
            }})],
            HashMap::new(),
        );
        let before = output
            .iter()
            .position(|event| data_pointer(event, "/delta/text") == Some(&json!("before")))
            .unwrap();
        let tool = output
            .iter()
            .position(|event| {
                data_pointer(event, "/content_block/id") == Some(&json!("call_terminal"))
            })
            .unwrap();
        let after = output
            .iter()
            .position(|event| data_pointer(event, "/delta/text") == Some(&json!("after")))
            .unwrap();
        assert!(before < tool && tool < after);
    }
}
