use std::collections::HashSet;

use serde_json::{Value, json};

use crate::core::{ApiError, AppResult, JsonObject, record_field, string_field};

use super::identifiers::{
    ToolNameMaps, build_tool_name_maps, codex_tool_name, shorten_codex_call_id,
};
use super::{AdaptedMessagesRequest, empty_object, into_object, require_object_ref};

const MAX_TOOLS: usize = 128;
const WEB_SEARCH_TOOL_TYPES: &[&str] = &["web_search_20250305", "web_search_20260209"];

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MessageRequestOptions {
    pub require_max_tokens: bool,
}

pub fn messages_request_to_responses(
    input: &JsonObject,
    options: MessageRequestOptions,
) -> AppResult<AdaptedMessagesRequest> {
    let model = ApiError::require_string(input.get("model"), "model", None)?.to_owned();
    let messages = input
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            invalid_request(
                "Missing required parameter: 'messages'.",
                "missing_required_parameter",
                "messages",
            )
        })?;
    if options.require_max_tokens {
        validate_max_tokens(input.get("max_tokens"))?;
    }

    let tool_names = declared_tool_names(input.get("tools"))?;
    let name_maps = build_tool_name_maps(tool_names.iter().map(String::as_str));
    let mut response_input = Vec::new();
    append_system(&mut response_input, input.get("system"))?;

    for (index, raw_message) in messages.iter().enumerate() {
        let message = require_object_ref(raw_message, &format!("messages[{index}]"))?;
        let role_param = format!("messages[{index}].role");
        let role = ApiError::require_string(
            message.get("role"),
            &role_param,
            Some(&format!(
                "messages[{index}].role must be 'user' or 'assistant'."
            )),
        )?;
        if role == "system" {
            append_message_system_reminder(&mut response_input, message.get("content"));
            continue;
        }
        if role != "user" && role != "assistant" {
            return Err(invalid_request(
                format!("messages[{index}].role must be 'user' or 'assistant'."),
                "invalid_message_role",
                role_param,
            ));
        }
        append_message(
            &mut response_input,
            message.get("content"),
            role,
            index,
            &name_maps,
        )?;
    }

    let mut body = into_object(json!({
        "model": model,
        "input": response_input,
        "parallel_tool_calls": parallel_tool_calls(input.get("tool_choice")),
        "reasoning": {"effort": reasoning_effort(input)},
    }));
    let adapted_tools = adapt_tools(input.get("tools"), &name_maps)?;
    if !adapted_tools.items.is_empty() {
        body.insert("tools".into(), Value::Array(adapted_tools.items));
        body.insert(
            "tool_choice".into(),
            adapt_tool_choice(
                input.get("tool_choice"),
                &name_maps,
                &adapted_tools.web_search_names,
            ),
        );
    }
    if matches!(
        input.get("service_tier").and_then(Value::as_str),
        Some("priority" | "fast")
    ) || input.get("speed").and_then(Value::as_str) == Some("fast")
    {
        body.insert("service_tier".into(), Value::String("priority".into()));
    }

    Ok(AdaptedMessagesRequest {
        body,
        model,
        stream: input.get("stream").and_then(Value::as_bool) == Some(true),
        reverse_tool_names: name_maps.reverse,
    })
}

fn validate_max_tokens(value: Option<&Value>) -> AppResult<()> {
    let valid = value
        .and_then(Value::as_f64)
        .is_some_and(|value| value.is_finite() && value >= 0.0 && value.fract() == 0.0);
    if valid {
        Ok(())
    } else {
        Err(invalid_request(
            "'max_tokens' must be a non-negative integer.",
            "invalid_max_tokens",
            "max_tokens",
        ))
    }
}

fn append_system(output: &mut Vec<Value>, value: Option<&Value>) -> AppResult<()> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(());
    };
    let mut parts = Vec::new();
    match value {
        Value::String(text) => parts.push(json!({"type": "input_text", "text": text})),
        Value::Array(blocks) => {
            for (index, raw_block) in blocks.iter().enumerate() {
                let block = require_object_ref(raw_block, &format!("system[{index}]"))?;
                let Some(text) = block.get("text").and_then(Value::as_str) else {
                    return Err(invalid_request(
                        "System content supports only text blocks.",
                        "unsupported_content_type",
                        format!("system[{index}].type"),
                    ));
                };
                if block.get("type").and_then(Value::as_str) != Some("text") {
                    return Err(invalid_request(
                        "System content supports only text blocks.",
                        "unsupported_content_type",
                        format!("system[{index}].type"),
                    ));
                }
                parts.push(json!({"type": "input_text", "text": text}));
            }
        }
        _ => {
            return Err(invalid_request(
                "'system' must be a string or an array of text blocks.",
                "invalid_system",
                "system",
            ));
        }
    }
    if !parts.is_empty() {
        output.push(json!({"type": "message", "role": "developer", "content": parts}));
    }
    Ok(())
}

fn append_message(
    output: &mut Vec<Value>,
    value: Option<&Value>,
    role: &str,
    message_index: usize,
    name_maps: &ToolNameMaps,
) -> AppResult<()> {
    if let Some(Value::String(text)) = value {
        output.push(json!({
            "type": "message",
            "role": role,
            "content": [{"type": text_part_type(role), "text": text}],
        }));
        return Ok(());
    }
    let Some(blocks) = value.and_then(Value::as_array) else {
        return Err(invalid_request(
            format!("messages[{message_index}].content must be a string or an array."),
            "invalid_message_content",
            format!("messages[{message_index}].content"),
        ));
    };

    let mut content = Vec::new();
    for (part_index, raw_block) in blocks.iter().enumerate() {
        let param = format!("messages[{message_index}].content[{part_index}]");
        let block = require_object_ref(raw_block, &param)?;
        let type_param = format!("{param}.type");
        let kind = ApiError::require_string(block.get("type"), &type_param, None)?;

        match kind {
            "text" => {
                content.push(json!({
                    "type": text_part_type(role),
                    "text": block.get("text").and_then(Value::as_str).unwrap_or_default(),
                }));
            }
            "image" | "document" => {
                if role != "user" {
                    return Err(invalid_request(
                        format!("{kind} blocks are supported only in user messages."),
                        format!("invalid_{kind}_role"),
                        param,
                    ));
                }
                content.push(adapt_media_block(block, kind, &param)?);
            }
            "search_result" => content.push(json!({
                "type": text_part_type(role),
                "text": search_result_text(block),
            })),
            "thinking" | "redacted_thinking" => {
                if role != "assistant" {
                    continue;
                }
                let signature = if kind == "thinking" {
                    string_field(Some(block), "signature")
                } else {
                    string_field(Some(block), "data")
                };
                let Some(signature) =
                    signature.filter(|signature| is_codex_reasoning_signature(signature))
                else {
                    continue;
                };
                flush_message(output, role, &mut content);
                output.push(json!({
                    "type": "reasoning",
                    "summary": [],
                    "content": null,
                    "encrypted_content": signature,
                }));
            }
            "tool_use" | "mcp_tool_use" => {
                if role != "assistant" {
                    return Err(invalid_request(
                        "tool_use blocks are supported only in assistant messages.",
                        "invalid_tool_use_role",
                        param,
                    ));
                }
                flush_message(output, role, &mut content);
                let name_param = format!("{param}.name");
                let id_param = format!("{param}.id");
                let name = ApiError::require_string(block.get("name"), &name_param, None)?;
                let call_id = ApiError::require_string(block.get("id"), &id_param, None)?;
                output.push(json!({
                    "type": "function_call",
                    "call_id": shorten_codex_call_id(call_id),
                    "name": codex_tool_name(name, &name_maps.forward),
                    "arguments": block.get("input").cloned().unwrap_or_else(|| json!({})).to_string(),
                }));
            }
            "tool_result" | "mcp_tool_result" => {
                if role != "user" {
                    return Err(invalid_request(
                        "tool_result blocks are supported only in user messages.",
                        "invalid_tool_result_role",
                        param,
                    ));
                }
                flush_message(output, role, &mut content);
                let id_param = format!("{param}.tool_use_id");
                let call_id = ApiError::require_string(
                    block.get("tool_use_id").or_else(|| block.get("id")),
                    &id_param,
                    None,
                )?;
                output.push(json!({
                    "type": "function_call_output",
                    "call_id": shorten_codex_call_id(call_id),
                    "output": adapt_tool_result(block.get("content")),
                }));
            }
            "server_tool_use" => {
                if role != "assistant" {
                    continue;
                }
                flush_message(output, role, &mut content);
                let name_param = format!("{param}.name");
                let id_param = format!("{param}.id");
                let name = ApiError::require_string(block.get("name"), &name_param, None)?;
                let call_id = ApiError::require_string(block.get("id"), &id_param, None)?;
                output.push(json!({
                    "type": "function_call",
                    "call_id": shorten_codex_call_id(call_id),
                    "name": codex_tool_name(name, &name_maps.forward),
                    "arguments": block.get("input").cloned().unwrap_or_else(|| json!({})).to_string(),
                }));
            }
            "web_search_tool_result" => content.push(json!({
                "type": text_part_type(role),
                "text": web_search_result_text(block.get("content")),
            })),
            _ => {
                return Err(invalid_request(
                    "Unsupported message content type.",
                    "unsupported_content_type",
                    type_param,
                ));
            }
        }
    }
    flush_message(output, role, &mut content);
    Ok(())
}

fn flush_message(output: &mut Vec<Value>, role: &str, content: &mut Vec<Value>) {
    if content.is_empty() {
        return;
    }
    output.push(json!({
        "type": "message",
        "role": role,
        "content": std::mem::take(content),
    }));
}

fn append_message_system_reminder(output: &mut Vec<Value>, value: Option<&Value>) {
    let parts = message_system_text_parts(value);
    if parts.is_empty() {
        return;
    }
    let text = parts.join("\n");
    if text.trim().is_empty() {
        return;
    }
    output.push(json!({
        "type": "message",
        "role": "user",
        "content": [{
            "type": "input_text",
            "text": format!("<system-reminder>\n{text}\n</system-reminder>"),
        }],
    }));
}

fn message_system_text_parts(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::String(text))
            if !text.is_empty() && !is_claude_code_attribution_system_text(text) =>
        {
            vec![text.clone()]
        }
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_object)
            .filter(|item| item.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|item| string_field(Some(item), "text"))
            .filter(|text| !is_claude_code_attribution_system_text(text))
            .map(str::to_owned)
            .collect(),
        _ => Vec::new(),
    }
}

fn is_claude_code_attribution_system_text(value: &str) -> bool {
    value
        .trim_start()
        .starts_with("x-anthropic-billing-header:")
}

fn adapt_media_block(block: &JsonObject, kind: &str, param: &str) -> AppResult<Value> {
    let source_param = format!("{param}.source");
    let source = block
        .get("source")
        .ok_or_else(|| {
            invalid_request(
                format!("The {source_param} must be a JSON object."),
                "invalid_json",
                source_param.clone(),
            )
        })
        .and_then(|value| require_object_ref(value, &source_param))?;
    let source_type_param = format!("{param}.source.type");
    let source_type = ApiError::require_string(source.get("type"), &source_type_param, None)?;
    match source_type {
        "base64" => {
            let media_type_param = format!("{param}.source.media_type");
            let data_param = format!("{param}.source.data");
            let media_type =
                ApiError::require_string(source.get("media_type"), &media_type_param, None)?;
            let data = ApiError::require_string(source.get("data"), &data_param, None)?;
            if kind == "image" {
                Ok(json!({
                    "type": "input_image",
                    "image_url": format!("data:{media_type};base64,{data}"),
                }))
            } else {
                Ok(json!({
                    "type": "input_file",
                    "file_data": format!("data:{media_type};base64,{data}"),
                    "filename": document_filename(block, source, media_type),
                }))
            }
        }
        "url" => {
            let url_param = format!("{param}.source.url");
            let url = ApiError::require_string(source.get("url"), &url_param, None)?;
            if kind == "image" {
                Ok(json!({"type": "input_image", "image_url": url}))
            } else {
                Ok(json!({
                    "type": "input_file",
                    "file_url": url,
                    "filename": document_filename(block, source, ""),
                }))
            }
        }
        "file" => {
            let file_id_param = format!("{param}.source.file_id");
            Ok(json!({
                "type": "input_file",
                "file_id": ApiError::require_string(source.get("file_id"), &file_id_param, None)?,
                "filename": document_filename(block, source, ""),
            }))
        }
        "text" if kind == "document" => {
            let data_param = format!("{param}.source.data");
            Ok(json!({
                "type": "input_text",
                "text": ApiError::require_string(source.get("data"), &data_param, None)?,
            }))
        }
        _ => Err(invalid_request(
            format!("Unsupported {kind} source type."),
            format!("unsupported_{kind}_source"),
            source_type_param,
        )),
    }
}

fn document_filename(block: &JsonObject, source: &JsonObject, media_type: &str) -> String {
    string_field(Some(block), "title")
        .or_else(|| string_field(Some(source), "filename"))
        .map(str::to_owned)
        .unwrap_or_else(|| default_filename(media_type).to_owned())
}

fn default_filename(media_type: &str) -> &'static str {
    match media_type.to_ascii_lowercase().as_str() {
        "application/pdf" => "document.pdf",
        "text/plain" => "document.txt",
        "text/csv" => "document.csv",
        "application/json" => "document.json",
        _ => "document",
    }
}

fn search_result_text(block: &JsonObject) -> String {
    let title = string_field(Some(block), "title").unwrap_or("Search result");
    let source = string_field(Some(block), "source")
        .or_else(|| string_field(Some(block), "url"))
        .unwrap_or_default();
    let content = web_search_result_text(block.get("content"));
    [title, source, &content]
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn web_search_result_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        None => String::new(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_object)
            .filter_map(|item| {
                if item.get("type").and_then(Value::as_str) == Some("text") {
                    return item.get("text").and_then(Value::as_str).map(str::to_owned);
                }
                let url = string_field(Some(item), "url")?;
                Some(format!(
                    "{}\n{url}",
                    string_field(Some(item), "title").unwrap_or(url)
                ))
            })
            .collect::<Vec<_>>()
            .join("\n\n"),
        Some(value) => value.to_string(),
    }
}

fn adapt_tool_result(value: Option<&Value>) -> Value {
    match value {
        None | Some(Value::Null) => Value::String(String::new()),
        Some(Value::String(value)) => Value::String(value.clone()),
        Some(value @ Value::Array(items)) => {
            let mut adapted = Vec::new();
            for raw in items {
                let Some(raw) = raw.as_object() else {
                    continue;
                };
                match raw.get("type").and_then(Value::as_str) {
                    Some("text") => adapted.push(json!({
                        "type": "input_text",
                        "text": raw.get("text").and_then(Value::as_str).unwrap_or_default(),
                    })),
                    Some("image") => {
                        let Some(source) = record_field(Some(raw), "source") else {
                            continue;
                        };
                        match source.get("type").and_then(Value::as_str) {
                            Some("base64") => {
                                if let (Some(media_type), Some(data)) = (
                                    string_field(Some(source), "media_type"),
                                    string_field(Some(source), "data"),
                                ) {
                                    adapted.push(json!({
                                        "type": "input_image",
                                        "image_url": format!("data:{media_type};base64,{data}"),
                                    }));
                                }
                            }
                            Some("url") => {
                                if let Some(url) = string_field(Some(source), "url") {
                                    adapted.push(json!({"type": "input_image", "image_url": url}));
                                }
                            }
                            _ => {}
                        }
                    }
                    Some("document" | "search_result") => adapted.push(json!({
                        "type": "input_text",
                        "text": search_result_text(raw),
                    })),
                    _ => {}
                }
            }
            if adapted.is_empty() {
                Value::String(value.to_string())
            } else {
                Value::Array(adapted)
            }
        }
        Some(value) => Value::String(value.to_string()),
    }
}

fn declared_tool_names(value: Option<&Value>) -> AppResult<Vec<String>> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let Some(tools) = value.as_array() else {
        return Err(invalid_request(
            "'tools' must be an array.",
            "invalid_tools",
            "tools",
        ));
    };
    if tools.len() > MAX_TOOLS {
        return Err(invalid_request(
            format!("'tools' supports at most {MAX_TOOLS} entries."),
            "too_many_tools",
            "tools",
        ));
    }
    let mut names = Vec::new();
    for (index, raw_tool) in tools.iter().enumerate() {
        let tool = require_object_ref(raw_tool, &format!("tools[{index}]"))?;
        if let Some(name) = string_field(Some(tool), "name") {
            names.push(name.to_owned());
        }
    }
    Ok(names)
}

struct AdaptedTools {
    items: Vec<Value>,
    web_search_names: HashSet<String>,
}

fn adapt_tools(value: Option<&Value>, name_maps: &ToolNameMaps) -> AppResult<AdaptedTools> {
    let Some(value) = value else {
        return Ok(AdaptedTools {
            items: Vec::new(),
            web_search_names: HashSet::new(),
        });
    };
    let Some(tools) = value.as_array() else {
        return Err(invalid_request(
            "'tools' must be an array.",
            "invalid_tools",
            "tools",
        ));
    };
    let mut items = Vec::new();
    let mut web_search_names = HashSet::new();
    for (index, raw_tool) in tools.iter().enumerate() {
        let tool = require_object_ref(raw_tool, &format!("tools[{index}]"))?;
        let kind = string_field(Some(tool), "type").unwrap_or("custom");
        if WEB_SEARCH_TOOL_TYPES.contains(&kind) {
            let mut adapted = into_object(json!({"type": "web_search"}));
            if let Some(domains) = tool.get("allowed_domains").and_then(Value::as_array) {
                adapted.insert("filters".into(), json!({"allowed_domains": domains}));
            }
            if let Some(location) = tool.get("user_location").and_then(Value::as_object) {
                adapted.insert("user_location".into(), Value::Object(location.clone()));
            }
            items.push(Value::Object(adapted));
            if let Some(name) = string_field(Some(tool), "name") {
                web_search_names.insert(name.to_owned());
            }
            continue;
        }

        let name_param = format!("tools[{index}].name");
        let name = ApiError::require_string(tool.get("name"), &name_param, None)?;
        let mut adapted = into_object(json!({
            "type": "function",
            "name": codex_tool_name(name, &name_maps.forward),
            "parameters": normalize_tool_schema(tool.get("input_schema")),
            "strict": false,
        }));
        if let Some(description) = tool.get("description").and_then(Value::as_str) {
            adapted.insert("description".into(), Value::String(description.to_owned()));
        }
        items.push(Value::Object(adapted));
    }
    Ok(AdaptedTools {
        items,
        web_search_names,
    })
}

fn normalize_tool_schema(value: Option<&Value>) -> JsonObject {
    let mut schema = value
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_else(|| into_object(json!({"type": "object", "properties": {}})));
    schema.remove("$schema");
    schema
        .entry("type")
        .or_insert_with(|| Value::String("object".into()));
    schema
        .entry("properties")
        .or_insert_with(|| Value::Object(empty_object()));
    schema
}

fn adapt_tool_choice(
    value: Option<&Value>,
    name_maps: &ToolNameMaps,
    web_search_names: &HashSet<String>,
) -> Value {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Value::String("auto".into());
    };
    if let Some(value) = value.as_str() {
        return Value::String(
            match value {
                "auto" | "none" => value,
                "any" => "required",
                _ => "auto",
            }
            .to_owned(),
        );
    }
    let Some(value) = value.as_object() else {
        return Value::String("auto".into());
    };
    let kind = string_field(Some(value), "type").unwrap_or("auto");
    match kind {
        "auto" | "none" => Value::String(kind.to_owned()),
        "any" => Value::String("required".into()),
        "tool" => {
            let Some(name) = string_field(Some(value), "name") else {
                return Value::String("auto".into());
            };
            if web_search_names.contains(name) {
                json!({"type": "web_search"})
            } else {
                json!({"type": "function", "name": codex_tool_name(name, &name_maps.forward)})
            }
        }
        _ => Value::String("auto".into()),
    }
}

fn parallel_tool_calls(tool_choice: Option<&Value>) -> bool {
    !tool_choice
        .and_then(Value::as_object)
        .and_then(|choice| choice.get("disable_parallel_tool_use"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn reasoning_effort(input: &JsonObject) -> String {
    let Some(thinking) = record_field(Some(input), "thinking") else {
        return "medium".into();
    };
    match string_field(Some(thinking), "type").unwrap_or_default() {
        "disabled" => "none".into(),
        "enabled" => thinking
            .get("budget_tokens")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
            .map(|value| effort_from_budget(value.trunc() as i64).to_owned())
            .unwrap_or_else(|| "medium".into()),
        "adaptive" | "auto" => string_field(record_field(Some(input), "output_config"), "effort")
            .map(|effort| effort.trim().to_lowercase())
            .filter(|effort| !effort.is_empty())
            .unwrap_or_else(|| "xhigh".into()),
        _ => "medium".into(),
    }
}

fn effort_from_budget(budget: i64) -> &'static str {
    match budget {
        i64::MIN..=-2 => "medium",
        -1 => "auto",
        0 => "none",
        1..=512 => "minimal",
        513..=1024 => "low",
        1025..=8192 => "medium",
        8193..=24576 => "high",
        _ => "xhigh",
    }
}

fn text_part_type(role: &str) -> &'static str {
    if role == "assistant" {
        "output_text"
    } else {
        "input_text"
    }
}

fn is_codex_reasoning_signature(value: &str) -> bool {
    let length = value.encode_utf16().count();
    (98..=32 * 1024 * 1024).contains(&length)
        && value.starts_with("gAAAA")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'=' | b'-'))
}

fn invalid_request(
    message: impl Into<String>,
    code: impl Into<String>,
    param: impl Into<String>,
) -> ApiError {
    ApiError::new(400, message)
        .with_kind("invalid_request_error")
        .with_code(code)
        .with_param(param)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const SIGNATURE_PREFIX: &str = "gAAAA";

    #[test]
    fn maps_multimodal_thinking_tools_and_results() {
        let long_tool_name = format!("mcp__weather__{}", "lookup".repeat(12));
        let long_call_id = format!("toolu_{}", "x".repeat(90));
        let signature = format!("{SIGNATURE_PREFIX}{}", "A".repeat(120));
        let input = into_object(json!({
            "model": "gpt-5.6-luna",
            "max_tokens": 2048,
            "stream": true,
            "system": [{"type": "text", "text": "Answer precisely.", "cache_control": {"type": "ephemeral"}}],
            "messages": [
                {"role": "user", "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "aW1hZ2U="}},
                    {"type": "document", "title": "brief.pdf", "source": {"type": "base64", "media_type": "application/pdf", "data": "UERG"}},
                    {"type": "text", "text": "What is the weather?"}
                ]},
                {"role": "assistant", "content": [
                    {"type": "thinking", "thinking": "checking", "signature": signature},
                    {"type": "tool_use", "id": long_call_id, "name": long_tool_name, "input": {"city": "Shanghai"}}
                ]},
                {"role": "user", "content": [{"type": "tool_result", "tool_use_id": long_call_id, "content": [
                    {"type": "text", "text": "sunny"},
                    {"type": "image", "source": {"type": "url", "url": "https://example.com/weather.png"}}
                ]}]}
            ],
            "tools": [
                {"name": long_tool_name, "description": "Look up weather", "input_schema": {"$schema": "draft", "type": "object", "properties": {"city": {"type": "string"}}}},
                {"type": "web_search_20250305", "name": "web_search", "allowed_domains": ["example.com"]}
            ],
            "tool_choice": {"type": "tool", "name": long_tool_name, "disable_parallel_tool_use": true},
            "thinking": {"type": "enabled", "budget_tokens": 20000},
            "speed": "fast"
        }));

        let adapted = messages_request_to_responses(
            &input,
            MessageRequestOptions {
                require_max_tokens: true,
            },
        )
        .unwrap();

        assert!(adapted.stream);
        assert_eq!(adapted.body["parallel_tool_calls"], false);
        assert_eq!(adapted.body["reasoning"], json!({"effort": "high"}));
        assert_eq!(adapted.body["service_tier"], "priority");
        let tools = adapted.body["tools"].as_array().unwrap();
        assert_eq!(tools[0]["name"].as_str().unwrap().len(), 64);
        assert!(tools[0]["parameters"].get("$schema").is_none());
        assert_eq!(
            tools[1],
            json!({"type": "web_search", "filters": {"allowed_domains": ["example.com"]}})
        );
        let response_input = adapted.body["input"].as_array().unwrap();
        let call = response_input
            .iter()
            .find(|item| item.get("type").and_then(Value::as_str) == Some("function_call"))
            .unwrap();
        assert_eq!(call["call_id"].as_str().unwrap().len(), 64);
        assert_eq!(call["arguments"], r#"{"city":"Shanghai"}"#);
        assert_eq!(
            adapted
                .reverse_tool_names
                .get(call["name"].as_str().unwrap()),
            Some(&long_tool_name)
        );
    }

    #[test]
    fn rejects_invalid_fields_and_maps_dynamic_thinking() {
        let invalid = into_object(json!({"model": "model", "messages": [], "max_tokens": -1}));
        let error = messages_request_to_responses(
            &invalid,
            MessageRequestOptions {
                require_max_tokens: true,
            },
        )
        .unwrap_err();
        assert_eq!(error.code.as_deref(), Some("invalid_max_tokens"));

        let dynamic = into_object(json!({
            "model": "model",
            "messages": [],
            "thinking": {"type": "enabled", "budget_tokens": -1}
        }));
        let adapted =
            messages_request_to_responses(&dynamic, MessageRequestOptions::default()).unwrap();
        assert_eq!(adapted.body["reasoning"], json!({"effort": "auto"}));
    }

    #[test]
    fn wraps_message_level_system_roles_and_drops_billing_attribution() {
        let input = into_object(json!({
            "model": "model",
            "system": [{"type": "text", "text": "Top-level rules"}],
            "messages": [
                {"role": "user", "content": "hello"},
                {"role": "system", "content": "Follow the project instructions"},
                {"role": "assistant", "content": [{"type": "text", "text": "ok"}]},
                {"role": "system", "content": [{"type": "text", "text": "Use the current repo"}, {"type": "image"}]},
                {"role": "system", "content": " x-anthropic-billing-header: cc_version=2.1.63;"}
            ]
        }));
        let adapted =
            messages_request_to_responses(&input, MessageRequestOptions::default()).unwrap();
        assert_eq!(adapted.body["input"].as_array().unwrap().len(), 5);
        assert_eq!(
            adapted.body["input"][2]["content"][0]["text"],
            "<system-reminder>\nFollow the project instructions\n</system-reminder>"
        );
    }
}
