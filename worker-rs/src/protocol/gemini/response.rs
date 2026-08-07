use std::collections::HashMap;

use serde_json::{Map, Number, Value, json};

use crate::core::{ApiError, AppResult, JsonObject, number_field, record_field, string_field};

use super::{failed_codex_response, gemini_codex_event_error, incomplete_codex_stream};

#[derive(Debug, Clone, PartialEq)]
pub struct GeminiResponseMetadata {
    pub id: String,
    pub model: String,
    pub created_at: Option<f64>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct GeminiChunkOptions<'a> {
    pub finish_reason: Option<&'a str>,
    pub usage: Option<&'a JsonObject>,
}

pub fn gemini_response_from_events<I>(
    events: I,
    requested_model: &str,
    reverse_tool_names: &HashMap<String, String>,
) -> AppResult<Value>
where
    I: IntoIterator<Item = Value>,
{
    let mut terminal = None;
    let mut incomplete = false;
    for event in events {
        let Some(event_object) = event.as_object() else {
            continue;
        };
        let event_type = string_field(Some(event_object), "type").unwrap_or("");
        if event_type == "error" {
            return Err(gemini_codex_event_error(&event));
        }
        if matches!(
            event_type,
            "response.completed" | "response.incomplete" | "response.failed"
        ) {
            let response = record_field(Some(event_object), "response")
                .cloned()
                .ok_or_else(incomplete_codex_stream)?;
            if event_type == "response.failed" {
                return Err(failed_codex_response(&response));
            }
            incomplete = event_type == "response.incomplete";
            terminal = Some(response);
            break;
        }
    }
    let terminal = terminal.ok_or_else(incomplete_codex_stream)?;
    gemini_response_from_terminal(&terminal, requested_model, reverse_tool_names, incomplete)
}

pub fn gemini_response_from_terminal(
    response: &JsonObject,
    requested_model: &str,
    reverse_tool_names: &HashMap<String, String>,
    incomplete: bool,
) -> AppResult<Value> {
    let id = string_field(Some(response), "id").ok_or_else(|| {
        ApiError::new(502, "The Codex response did not include a response ID.")
            .with_kind("upstream_error")
            .with_code("missing_codex_response_id")
    })?;
    let parts = output_to_gemini_parts(response.get("output"), reverse_tool_names)?;
    let metadata = GeminiResponseMetadata {
        id: id.to_owned(),
        model: string_field(Some(response), "model")
            .unwrap_or(requested_model)
            .to_owned(),
        created_at: number_field(Some(response), "created_at"),
    };
    Ok(gemini_chunk(
        &metadata,
        parts,
        GeminiChunkOptions {
            finish_reason: Some(gemini_finish_reason(response, incomplete)),
            usage: record_field(Some(response), "usage"),
        },
    ))
}

pub fn output_to_gemini_parts(
    value: Option<&Value>,
    reverse_tool_names: &HashMap<String, String>,
) -> AppResult<Vec<Value>> {
    let output = match value {
        None => &[][..],
        Some(Value::Array(output)) => output.as_slice(),
        Some(_) => return Err(malformed_codex_output()),
    };
    let mut parts = Vec::new();
    for raw in output {
        let Some(raw) = raw.as_object() else {
            continue;
        };
        match string_field(Some(raw), "type").unwrap_or("") {
            "reasoning" => {
                let text = reasoning_text(raw);
                let signature = string_field(Some(raw), "encrypted_content");
                if !text.is_empty() || signature.is_some() {
                    let mut part = Map::from_iter([
                        ("thought".into(), Value::Bool(true)),
                        ("text".into(), Value::String(text)),
                    ]);
                    if let Some(signature) = signature {
                        part.insert(
                            "thoughtSignature".into(),
                            Value::String(signature.to_owned()),
                        );
                    }
                    parts.push(Value::Object(part));
                }
            }
            "message" => {
                for text in output_texts(raw.get("content")) {
                    if !text.is_empty() {
                        parts.push(json!({ "text": text }));
                    }
                }
            }
            item_type @ ("function_call" | "custom_tool_call") => {
                parts.push(function_call_part(raw, item_type, reverse_tool_names));
            }
            "image_generation_call" => {
                if let Some(part) = image_part(raw) {
                    parts.push(part);
                }
            }
            _ => {}
        }
    }
    Ok(parts)
}

pub fn gemini_chunk(
    metadata: &GeminiResponseMetadata,
    parts: Vec<Value>,
    options: GeminiChunkOptions<'_>,
) -> Value {
    let mut candidate = Map::new();
    candidate.insert("content".into(), json!({ "role": "model", "parts": parts }));
    if let Some(reason) = options.finish_reason {
        candidate.insert("finishReason".into(), Value::String(reason.to_owned()));
    }
    let mut result = Map::from_iter([
        (
            "candidates".into(),
            Value::Array(vec![Value::Object(candidate)]),
        ),
        ("modelVersion".into(), Value::String(metadata.model.clone())),
        ("responseId".into(), Value::String(metadata.id.clone())),
    ]);
    if let Some(create_time) = metadata.created_at.and_then(create_time_value) {
        result.insert("createTime".into(), Value::String(create_time));
    }
    if let Some(usage) = options.usage {
        result.insert("usageMetadata".into(), gemini_usage(Some(usage)));
    }
    Value::Object(result)
}

pub fn gemini_usage(usage: Option<&JsonObject>) -> Value {
    let prompt = nonnegative(number_field(usage, "input_tokens").unwrap_or(0.0));
    let candidates = nonnegative(number_field(usage, "output_tokens").unwrap_or(0.0));
    let total = nonnegative(number_field(usage, "total_tokens").unwrap_or(prompt + candidates));
    let mut result = Map::from_iter([
        ("promptTokenCount".into(), number_value(prompt)),
        ("candidatesTokenCount".into(), number_value(candidates)),
        ("totalTokenCount".into(), number_value(total)),
        (
            "trafficType".into(),
            Value::String("PROVISIONED_THROUGHPUT".into()),
        ),
    ]);
    let cached = number_field(record_field(usage, "input_tokens_details"), "cached_tokens");
    if let Some(cached) = cached.filter(|value| *value > 0.0) {
        result.insert("cachedContentTokenCount".into(), number_value(cached));
    }
    let thoughts = number_field(
        record_field(usage, "output_tokens_details"),
        "reasoning_tokens",
    );
    if let Some(thoughts) = thoughts.filter(|value| *value > 0.0) {
        result.insert("thoughtsTokenCount".into(), number_value(thoughts));
    }
    Value::Object(result)
}

pub fn gemini_finish_reason(response: &JsonObject, incomplete: bool) -> &'static str {
    if !incomplete {
        return "STOP";
    }
    match string_field(record_field(Some(response), "incomplete_details"), "reason").unwrap_or("") {
        "max_tokens" | "max_output_tokens" => "MAX_TOKENS",
        "content_filter" => "SAFETY",
        _ => "OTHER",
    }
}

pub fn output_mime_type(format: Option<&str>) -> String {
    let Some(format) = format.filter(|value| !value.is_empty()) else {
        return "image/png".into();
    };
    if format.contains('/') {
        return format.to_owned();
    }
    match format.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "image/png",
    }
    .into()
}

pub(crate) fn reasoning_text(item: &JsonObject) -> String {
    let summary = text_from_parts(item.get("summary"));
    if summary.is_empty() {
        text_from_parts(item.get("content"))
    } else {
        summary
    }
}

pub(crate) fn output_texts(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::String(value)) if !value.is_empty() => vec![value.clone()],
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| {
                let part = part.as_object()?;
                match string_field(Some(part), "type").unwrap_or("") {
                    "output_text" => part.get("text").and_then(Value::as_str),
                    "refusal" => part.get("refusal").and_then(Value::as_str),
                    _ => None,
                }
                .map(str::to_owned)
            })
            .collect(),
        _ => Vec::new(),
    }
}

pub(crate) fn parse_tool_input(value: Option<&str>) -> Value {
    value
        .and_then(|value| serde_json::from_str::<Value>(value).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| Value::Object(Map::new()))
}

pub(crate) fn function_call_part(
    item: &JsonObject,
    item_type: &str,
    reverse_tool_names: &HashMap<String, String>,
) -> Value {
    let raw_name = string_field(Some(item), "name").unwrap_or("tool");
    let raw_arguments = if item_type == "custom_tool_call" {
        string_field(Some(item), "input")
    } else {
        string_field(Some(item), "arguments")
    };
    let mut function_call = Map::from_iter([
        (
            "name".into(),
            Value::String(
                reverse_tool_names
                    .get(raw_name)
                    .map(String::as_str)
                    .unwrap_or(raw_name)
                    .to_owned(),
            ),
        ),
        ("args".into(), parse_tool_input(raw_arguments)),
    ]);
    if let Some(call_id) =
        string_field(Some(item), "call_id").or_else(|| string_field(Some(item), "id"))
    {
        function_call.insert("id".into(), Value::String(call_id.to_owned()));
    }
    json!({ "functionCall": function_call })
}

pub(crate) fn image_part(item: &JsonObject) -> Option<Value> {
    let data = string_field(Some(item), "result")?;
    Some(json!({
        "inlineData": {
            "data": data,
            "mimeType": output_mime_type(string_field(Some(item), "output_format")),
        }
    }))
}

fn text_from_parts(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| match part {
                Value::String(value) => Some(value.as_str()),
                Value::Object(part) => part.get("text").and_then(Value::as_str),
                _ => None,
            })
            .collect(),
        _ => String::new(),
    }
}

fn nonnegative(value: f64) -> f64 {
    value.max(0.0)
}

fn number_value(value: f64) -> Value {
    if value.fract() == 0.0 && value >= 0.0 && value <= u64::MAX as f64 {
        return Value::Number(Number::from(value as u64));
    }
    Number::from_f64(value)
        .map(Value::Number)
        .unwrap_or_else(|| Value::Number(Number::from(0)))
}

fn malformed_codex_output() -> ApiError {
    ApiError::new(502, "The Codex response output was malformed.")
        .with_kind("upstream_error")
        .with_code("malformed_codex_output")
}

fn create_time_value(created_at: f64) -> Option<String> {
    if !created_at.is_finite() {
        return None;
    }
    let milliseconds = (created_at * 1_000.0).trunc();
    if milliseconds < i64::MIN as f64 || milliseconds > i64::MAX as f64 {
        return None;
    }
    let milliseconds = milliseconds as i64;
    let seconds = milliseconds.div_euclid(1_000);
    let millis = milliseconds.rem_euclid(1_000);
    let days = seconds.div_euclid(86_400);
    let second_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days)?;
    let hour = second_of_day / 3_600;
    let minute = second_of_day % 3_600 / 60;
    let second = second_of_day % 60;
    Some(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z"
    ))
}

// Howard Hinnant's civil-from-days algorithm, with day zero at 1970-01-01.
fn civil_from_days(days: i64) -> Option<(i64, i64, i64)> {
    let z = days.checked_add(719_468)?;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (0..=9_999).contains(&year).then_some((year, month, day))
}
