use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};

use crate::core::{ApiError, AppResult, JsonObject, number_field, record_field, string_field};

use super::error::codex_event_error;
use super::identifiers::{claude_tool_name, claude_tool_use_id};
use super::{ClaudeUsage, empty_object, into_object, json_number};

#[derive(Debug, Clone, PartialEq)]
pub struct ClaudeContent {
    pub content: Vec<Value>,
    pub has_client_tool_use: bool,
}

pub fn message_from_event_values(
    events: impl IntoIterator<Item = Value>,
    requested_model: &str,
    reverse_tool_names: &HashMap<String, String>,
) -> AppResult<JsonObject> {
    let mut terminal = None;
    let mut terminal_type = String::new();
    for event in events {
        let Some(event) = event.as_object() else {
            continue;
        };
        let kind = string_field(Some(event), "type").unwrap_or_default();
        if kind == "error" {
            return Err(codex_event_error(event));
        }
        if matches!(
            kind,
            "response.completed" | "response.incomplete" | "response.failed"
        ) {
            terminal = record_field(Some(event), "response").cloned();
            terminal_type = kind.to_owned();
            break;
        }
    }
    let terminal = terminal.ok_or_else(incomplete_codex_stream)?;
    if terminal_type == "response.failed" {
        return Err(failed_codex_response(&terminal));
    }
    message_from_terminal_response(&terminal, requested_model, reverse_tool_names)
}

pub fn message_from_terminal_response(
    response: &JsonObject,
    requested_model: &str,
    reverse_tool_names: &HashMap<String, String>,
) -> AppResult<JsonObject> {
    let id = string_field(Some(response), "id").ok_or_else(|| {
        ApiError::new(502, "The Codex response did not include a response ID.")
            .with_kind("api_error")
            .with_code("missing_codex_response_id")
    })?;
    let converted = output_to_claude_content(response.get("output"), reverse_tool_names)?;
    let mut message = into_object(json!({
        "id": id,
        "type": "message",
        "role": "assistant",
        "model": string_field(Some(response), "model").unwrap_or(requested_model),
        "content": converted.content,
        "stop_reason": claude_stop_reason(response, converted.has_client_tool_use),
        "stop_sequence": response
            .get("stop_sequence")
            .and_then(Value::as_str)
            .map(Value::from)
            .unwrap_or(Value::Null),
    }));
    message.insert(
        "usage".into(),
        Value::Object(claude_usage_object(&claude_usage(record_field(
            Some(response),
            "usage",
        )))),
    );
    Ok(message)
}

pub fn output_to_claude_content(
    value: Option<&Value>,
    reverse_tool_names: &HashMap<String, String>,
) -> AppResult<ClaudeContent> {
    if value.is_some_and(|value| !value.is_array()) {
        return Err(malformed_codex_output());
    }
    let mut content = Vec::new();
    let mut has_client_tool_use = false;
    let mut seen_web_search = HashSet::new();
    for (index, item) in value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        let Some(item) = item.as_object() else {
            continue;
        };
        match string_field(Some(item), "type").unwrap_or_default() {
            "reasoning" => {
                let thinking = reasoning_text(item);
                let signature = string_field(Some(item), "encrypted_content");
                if !thinking.is_empty() || signature.is_some() {
                    let mut block = into_object(json!({
                        "type": "thinking",
                        "thinking": thinking,
                    }));
                    if let Some(signature) = signature {
                        block.insert("signature".into(), Value::String(signature.to_owned()));
                    }
                    content.push(Value::Object(block));
                }
            }
            "message" => {
                for text in output_texts(item.get("content")) {
                    if !text.is_empty() {
                        content.push(json!({"type": "text", "text": text}));
                    }
                }
            }
            kind @ ("function_call" | "custom_tool_call") => {
                has_client_tool_use = true;
                let raw_id = string_field(Some(item), "call_id")
                    .or_else(|| string_field(Some(item), "id"))
                    .unwrap_or_default();
                let raw_name = string_field(Some(item), "name").unwrap_or("tool");
                let raw_input = if kind == "custom_tool_call" {
                    string_field(Some(item), "input")
                } else {
                    string_field(Some(item), "arguments")
                };
                content.push(json!({
                    "type": "tool_use",
                    "id": claude_tool_use_id(raw_id, &format!("toolu_{index}")),
                    "name": claude_tool_name(raw_name, reverse_tool_names),
                    "input": parse_tool_input(raw_input),
                }));
            }
            "web_search_call" => {
                content.extend(web_search_content(item, index, &mut seen_web_search));
            }
            _ => {}
        }
    }
    Ok(ClaudeContent {
        content,
        has_client_tool_use,
    })
}

pub fn claude_usage(usage: Option<&JsonObject>) -> ClaudeUsage {
    let cached = number_field(record_field(usage, "input_tokens_details"), "cached_tokens")
        .unwrap_or(0.0)
        .max(0.0);
    let total_input = number_field(usage, "input_tokens").unwrap_or(0.0).max(0.0);
    ClaudeUsage {
        input_tokens: (total_input - cached).max(0.0),
        output_tokens: number_field(usage, "output_tokens").unwrap_or(0.0).max(0.0),
        cache_read_input_tokens: (cached > 0.0).then_some(cached),
    }
}

pub(crate) fn claude_usage_object(usage: &ClaudeUsage) -> JsonObject {
    let mut value = into_object(json!({
        "input_tokens": json_number(usage.input_tokens),
        "output_tokens": json_number(usage.output_tokens),
    }));
    if let Some(cached) = usage.cache_read_input_tokens {
        value.insert("cache_read_input_tokens".into(), json_number(cached));
    }
    value
}

pub fn claude_stop_reason(response: &JsonObject, has_client_tool_use: bool) -> String {
    if has_client_tool_use {
        return "tool_use".into();
    }
    let mut reason = string_field(Some(response), "stop_reason").unwrap_or_default();
    if reason.is_empty() {
        reason = string_field(record_field(Some(response), "incomplete_details"), "reason")
            .unwrap_or_default();
    }
    if reason.is_empty() && string_field(Some(response), "stop_sequence").is_some() {
        reason = "stop_sequence";
    }
    match reason {
        "max_tokens" | "max_output_tokens" => "max_tokens",
        "content_filter" => "refusal",
        "end_turn"
        | "stop_sequence"
        | "pause_turn"
        | "refusal"
        | "model_context_window_exceeded" => reason,
        _ => "end_turn",
    }
    .to_owned()
}

pub fn reasoning_text(item: &JsonObject) -> String {
    let summary = text_from_parts(item.get("summary"));
    if summary.is_empty() {
        text_from_parts(item.get("content"))
    } else {
        summary
    }
}

pub fn output_texts(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::String(value)) if !value.is_empty() => vec![value.clone()],
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(Value::as_object)
            .filter_map(|part| match part.get("type").and_then(Value::as_str) {
                Some("output_text") => part.get("text").and_then(Value::as_str),
                Some("refusal") => part.get("refusal").and_then(Value::as_str),
                _ => None,
            })
            .map(str::to_owned)
            .collect(),
        _ => Vec::new(),
    }
}

pub fn parse_tool_input(value: Option<&str>) -> JsonObject {
    value
        .and_then(|value| serde_json::from_str::<Value>(value).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_else(empty_object)
}

pub fn incomplete_codex_stream() -> ApiError {
    ApiError::new(502, "The Codex stream ended without a completed response.")
        .with_kind("api_error")
        .with_code("incomplete_codex_stream")
}

pub fn failed_codex_response(response: &JsonObject) -> ApiError {
    let error = record_field(Some(response), "error");
    ApiError::new(
        502,
        string_field(error, "message").unwrap_or("The Codex response failed."),
    )
    .with_kind("api_error")
    .with_code(string_field(error, "code").unwrap_or("codex_response_failed"))
}

fn text_from_parts(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Array(parts)) => {
            let mut text = String::new();
            for part in parts {
                match part {
                    Value::String(part) => text.push_str(part),
                    Value::Object(part) => {
                        if let Some(part) = part.get("text").and_then(Value::as_str) {
                            text.push_str(part);
                        }
                    }
                    _ => {}
                }
            }
            text
        }
        _ => String::new(),
    }
}

fn web_search_content(item: &JsonObject, index: usize, seen: &mut HashSet<String>) -> Vec<Value> {
    let raw_id = string_field(Some(item), "id")
        .map(str::to_owned)
        .unwrap_or_else(|| format!("web_search_{index}"));
    let id = claude_tool_use_id(&raw_id, &format!("web_search_{index}"));
    if seen.contains(&id) {
        return Vec::new();
    }
    let action = record_field(Some(item), "action");
    let query = string_field(action, "query").or_else(|| string_field(Some(item), "query"));
    let results = item
        .get("results")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    if query.is_none() && results.is_empty() {
        return Vec::new();
    }
    seen.insert(id.clone());
    let result_content = results
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
    vec![
        json!({
            "type": "server_tool_use",
            "id": id,
            "name": "web_search",
            "input": query.map(|query| json!({"query": query})).unwrap_or_else(|| json!({})),
        }),
        json!({
            "type": "web_search_tool_result",
            "tool_use_id": id,
            "content": result_content,
        }),
    ]
}

fn malformed_codex_output() -> ApiError {
    ApiError::new(502, "The Codex response output was malformed.")
        .with_kind("api_error")
        .with_code("malformed_codex_output")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_ordered_terminal_content_usage_and_stop_reason() {
        let signature = format!("gAAAA{}", "A".repeat(120));
        let response = into_object(json!({
            "id": "resp_message",
            "model": "resolved-model",
            "usage": {
                "input_tokens": 30,
                "output_tokens": 12,
                "input_tokens_details": {"cached_tokens": 5}
            },
            "output": [
                {"type": "reasoning", "summary": [{"type": "summary_text", "text": "thinking"}], "encrypted_content": signature},
                {"type": "message", "content": [{"type": "output_text", "text": "answer"}]},
                {"type": "function_call", "call_id": "call_weather", "name": "weather_short", "arguments": "{\"city\":\"Shanghai\"}"},
                {"type": "web_search_call", "id": "ws_1", "action": {"type": "search", "query": "Workers streams"}, "results": [{"title": "Streams", "url": "https://example.com/streams"}]}
            ]
        }));
        let names = HashMap::from([("weather_short".into(), "weather_original".into())]);
        let message = message_from_terminal_response(&response, "requested-model", &names).unwrap();
        assert_eq!(message["model"], "resolved-model");
        assert_eq!(message["stop_reason"], "tool_use");
        assert_eq!(
            message["usage"],
            json!({
                "input_tokens": 25,
                "output_tokens": 12,
                "cache_read_input_tokens": 5
            })
        );
        let content = message["content"].as_array().unwrap();
        assert_eq!(
            content
                .iter()
                .map(|block| block["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            [
                "thinking",
                "text",
                "tool_use",
                "server_tool_use",
                "web_search_tool_result"
            ]
        );
        assert_eq!(content[2]["name"], "weather_original");
        assert_eq!(content[2]["input"], json!({"city": "Shanghai"}));
    }

    #[test]
    fn rejects_missing_terminal_and_failed_responses() {
        let error = message_from_event_values(
            [json!({"type": "response.created", "response": {"id": "one"}})],
            "model",
            &HashMap::new(),
        )
        .unwrap_err();
        assert_eq!(error.code.as_deref(), Some("incomplete_codex_stream"));

        let error = message_from_event_values(
            [json!({"type": "response.failed", "response": {"error": {"code": "bad", "message": "failed"}}})],
            "model",
            &HashMap::new(),
        )
        .unwrap_err();
        assert_eq!(error.message, "failed");
    }
}
