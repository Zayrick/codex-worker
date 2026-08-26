use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};

use crate::core::{ApiError, AppResult, JsonObject};

use super::{AdaptedChatRequest, ToolKind};
use crate::protocol::openai::{invalid_request, responses::to_codex_message_role};

struct AdaptedTools {
    items: Vec<Value>,
    custom_names: HashSet<String>,
}

pub fn chat_request_to_responses(input: &JsonObject) -> AppResult<AdaptedChatRequest> {
    let model = require_string(input.get("model"), "model", None)?.to_owned();
    let messages = input
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            invalid_request(
                "Missing required parameter: 'messages'.",
                "missing_required_parameter",
                Some("messages".to_owned()),
            )
        })?;

    let tools = adapt_tools(input.get("tools"))?;
    let mut pending_tool_kinds = HashMap::new();
    let mut response_input = Vec::new();
    for (index, raw_message) in messages.iter().enumerate() {
        let message = require_object(raw_message, &format!("messages[{index}]"))?;
        let source_role = require_string(
            message.get("role"),
            &format!("messages[{index}].role"),
            Some(&format!("messages[{index}].role must be a string.")),
        )?;
        let role = to_codex_message_role(source_role);
        response_input.extend(message_to_response_items(
            message,
            role,
            index,
            &tools.custom_names,
            &mut pending_tool_kinds,
        )?);
    }

    let mut body = JsonObject::new();
    body.insert("model".into(), Value::String(model.clone()));
    body.insert("input".into(), Value::Array(response_input));
    if !tools.items.is_empty() {
        body.insert("tools".into(), Value::Array(tools.items));
    }
    if let Some(value) = input.get("parallel_tool_calls") {
        body.insert("parallel_tool_calls".into(), value.clone());
    }
    if let Some(value) = input.get("tool_choice") {
        body.insert(
            "tool_choice".into(),
            adapt_tool_choice(value, &tools.custom_names)?,
        );
    }

    if let Some(reasoning_effort) = input.get("reasoning_effort") {
        let Some(reasoning_effort) = reasoning_effort
            .as_str()
            .filter(|reasoning_effort| !reasoning_effort.is_empty())
        else {
            return Err(invalid_request(
                "'reasoning_effort' must be a non-empty string.",
                "invalid_reasoning_effort",
                Some("reasoning_effort".to_owned()),
            ));
        };
        body.insert("reasoning".into(), json!({"effort":reasoning_effort}));
    }

    if let Some(text) = adapt_response_format(input.get("response_format"))? {
        body.insert("text".into(), Value::Object(text));
    }
    if input.get("service_tier").and_then(Value::as_str) == Some("priority") {
        body.insert("service_tier".into(), Value::String("priority".into()));
    }
    if let Some(metadata) = input.get("metadata").and_then(Value::as_object) {
        body.insert("metadata".into(), Value::Object(metadata.clone()));
    }
    if let Some(value) = input.get("prompt_cache_key") {
        body.insert(
            "prompt_cache_key".into(),
            Value::String(
                require_string(
                    Some(value),
                    "prompt_cache_key",
                    Some("'prompt_cache_key' must be a non-empty string."),
                )?
                .to_owned(),
            ),
        );
    }

    if let Some(n) = input.get("n")
        && n.as_f64() != Some(1.0)
    {
        return Err(invalid_request(
            "This proxy currently supports only n=1.",
            "unsupported_parameter",
            Some("n".to_owned()),
        ));
    }

    let stream = input.get("stream").and_then(Value::as_bool) == Some(true);
    let include_usage = input
        .get("stream_options")
        .and_then(Value::as_object)
        .and_then(|options| options.get("include_usage"))
        .and_then(Value::as_bool)
        == Some(true);
    Ok(AdaptedChatRequest {
        body,
        model,
        stream,
        include_usage,
    })
}

fn adapt_tools(value: Option<&Value>) -> AppResult<AdaptedTools> {
    let Some(value) = value else {
        return Ok(AdaptedTools {
            items: Vec::new(),
            custom_names: HashSet::new(),
        });
    };
    let Some(values) = value.as_array() else {
        return Err(invalid_request(
            "'tools' must be an array.",
            "invalid_tools",
            Some("tools".to_owned()),
        ));
    };

    let mut custom_names = HashSet::new();
    let mut function_names = HashSet::new();
    let mut items = Vec::with_capacity(values.len());
    for (index, raw) in values.iter().enumerate() {
        let tool = require_object(raw, &format!("tools[{index}]"))?;
        let kind = require_string(tool.get("type"), &format!("tools[{index}].type"), None)?;
        if kind == "custom" {
            let custom = tool
                .get("custom")
                .and_then(Value::as_object)
                .unwrap_or(tool);
            let name = require_string(custom.get("name"), &format!("tools[{index}].name"), None)?;
            custom_names.insert(name.to_owned());
            let mut adapted = JsonObject::new();
            adapted.insert("type".into(), Value::String("custom".into()));
            adapted.insert("name".into(), Value::String(name.to_owned()));
            copy_string(custom, &mut adapted, "description");
            copy_if_present(custom, &mut adapted, "format");
            items.push(Value::Object(adapted));
            continue;
        }
        if kind != "function" {
            let mut adapted = tool.clone();
            adapted.insert("type".into(), Value::String(kind.to_owned()));
            items.push(Value::Object(adapted));
            continue;
        }

        let function = tool
            .get("function")
            .and_then(Value::as_object)
            .ok_or_else(|| invalid_json(&format!("tools[{index}].function")))?;
        let name = require_string(
            function.get("name"),
            &format!("tools[{index}].function.name"),
            None,
        )?;
        function_names.insert(name.to_owned());
        let mut adapted = JsonObject::new();
        adapted.insert("type".into(), Value::String("function".into()));
        adapted.insert("name".into(), Value::String(name.to_owned()));
        copy_string(function, &mut adapted, "description");
        copy_if_present(function, &mut adapted, "parameters");
        copy_if_present(function, &mut adapted, "strict");
        items.push(Value::Object(adapted));
    }
    for name in function_names {
        custom_names.remove(&name);
    }
    Ok(AdaptedTools {
        items,
        custom_names,
    })
}

fn adapt_tool_choice(value: &Value, custom_names: &HashSet<String>) -> AppResult<Value> {
    if matches!(value.as_str(), Some("auto" | "required" | "none")) {
        return Ok(value.clone());
    }
    let Some(choice) = value.as_object() else {
        return Err(invalid_request(
            "Invalid 'tool_choice'.",
            "invalid_tool_choice",
            Some("tool_choice".to_owned()),
        ));
    };
    let kind = choice
        .get("type")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    if kind == Some("function") {
        let function = choice
            .get("function")
            .and_then(Value::as_object)
            .unwrap_or(choice);
        let name = require_string(function.get("name"), "tool_choice.function.name", None)?;
        return Ok(json!({
            "type": if custom_names.contains(name) { "custom" } else { "function" },
            "name": name
        }));
    }
    if kind == Some("custom") {
        let custom = choice
            .get("custom")
            .and_then(Value::as_object)
            .unwrap_or(choice);
        let name = require_string(custom.get("name"), "tool_choice.custom.name", None)?;
        return Ok(json!({"type":"custom","name":name}));
    }
    if let Some(kind) = kind {
        let mut adapted = choice.clone();
        adapted.insert("type".into(), Value::String(kind.to_owned()));
        return Ok(Value::Object(adapted));
    }
    Err(invalid_request(
        "Invalid 'tool_choice'.",
        "invalid_tool_choice",
        Some("tool_choice".to_owned()),
    ))
}

fn message_to_response_items(
    message: &JsonObject,
    role: &str,
    index: usize,
    custom_names: &HashSet<String>,
    pending_tool_kinds: &mut HashMap<String, ToolKind>,
) -> AppResult<Vec<Value>> {
    if role == "tool" {
        let call_id = require_string(
            message.get("tool_call_id"),
            &format!("messages[{index}].tool_call_id"),
            None,
        )?;
        let kind = pending_tool_kinds
            .get(call_id)
            .copied()
            .unwrap_or(ToolKind::Function);
        return Ok(vec![json!({
            "type": if kind == ToolKind::Custom { "custom_tool_call_output" } else { "function_call_output" },
            "call_id":call_id,
            "output":adapt_tool_output(message.get("content"))
        })]);
    }
    if role == "function" {
        let name = require_string(
            message.get("name"),
            &format!("messages[{index}].name"),
            None,
        )?;
        return Ok(vec![json!({
            "type":"function_call_output",
            "call_id":format!("legacy-{name}-{index}"),
            "output":adapt_tool_output(message.get("content"))
        })]);
    }
    if !matches!(role, "user" | "assistant" | "developer") {
        return Err(invalid_request(
            "Unsupported message role.",
            "invalid_message_role",
            Some(format!("messages[{index}].role")),
        ));
    }

    let mut items = Vec::new();
    let content = adapt_message_content(message.get("content"), role, index)?;
    if !content.is_empty() {
        items.push(json!({"type":"message","role":role,"content":content}));
    }
    if role != "assistant" {
        return Ok(items);
    }

    let tool_calls = match message.get("tool_calls") {
        None => &[][..],
        Some(Value::Array(calls)) => calls.as_slice(),
        Some(_) => {
            return Err(invalid_request(
                format!("messages[{index}].tool_calls must be an array."),
                "invalid_tool_calls",
                Some(format!("messages[{index}].tool_calls")),
            ));
        }
    };
    for (tool_index, raw_call) in tool_calls.iter().enumerate() {
        let label = format!("messages[{index}].tool_calls[{tool_index}]");
        let call = require_object(raw_call, &label)?;
        let call_type = call
            .get("type")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or("function");
        let call_id = call
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("call-{index}-{tool_index}"));

        let (kind, name, input) = if call_type == "custom" {
            let custom = call
                .get("custom")
                .and_then(Value::as_object)
                .unwrap_or(call);
            let name = require_string(custom.get("name"), &format!("{label}.custom.name"), None)?;
            let input = custom
                .get("input")
                .and_then(Value::as_str)
                .or_else(|| custom.get("arguments").and_then(Value::as_str))
                .unwrap_or("");
            (ToolKind::Custom, name.to_owned(), input.to_owned())
        } else if call_type == "function" {
            let function = call
                .get("function")
                .and_then(Value::as_object)
                .ok_or_else(|| invalid_json(&format!("{label}.function")))?;
            let name = require_string(
                function.get("name"),
                &format!("{label}.function.name"),
                None,
            )?;
            let kind = if custom_names.contains(name) {
                ToolKind::Custom
            } else {
                ToolKind::Function
            };
            let input = function
                .get("arguments")
                .and_then(Value::as_str)
                .unwrap_or(if kind == ToolKind::Custom { "" } else { "{}" });
            (kind, name.to_owned(), input.to_owned())
        } else {
            return Err(invalid_request(
                "Unsupported tool call type.",
                "unsupported_tool_call_type",
                Some(format!("{label}.type")),
            ));
        };

        pending_tool_kinds.insert(call_id.clone(), kind);
        items.push(if kind == ToolKind::Custom {
            json!({"type":"custom_tool_call","call_id":call_id,"name":name,"input":input})
        } else {
            json!({"type":"function_call","call_id":call_id,"name":name,"arguments":input})
        });
    }
    Ok(items)
}

fn adapt_message_content(value: Option<&Value>, role: &str, index: usize) -> AppResult<Vec<Value>> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    if value.is_null() {
        return Ok(Vec::new());
    }
    if let Some(text) = value.as_str() {
        return Ok(vec![json!({
            "type":if role == "assistant" { "output_text" } else { "input_text" },
            "text":text
        })]);
    }
    let Some(values) = value.as_array() else {
        return Err(invalid_request(
            format!("messages[{index}].content must be a string, array, or null."),
            "invalid_message_content",
            Some(format!("messages[{index}].content")),
        ));
    };

    let mut parts = Vec::with_capacity(values.len());
    for (part_index, raw) in values.iter().enumerate() {
        let label = format!("messages[{index}].content[{part_index}]");
        let part = require_object(raw, &label)?;
        let kind = part
            .get("type")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        if matches!(kind, Some("text" | "input_text" | "output_text")) {
            parts.push(json!({
                "type":if role == "assistant" { "output_text" } else { "input_text" },
                "text":part.get("text").and_then(Value::as_str).unwrap_or("")
            }));
            continue;
        }
        if matches!(kind, Some("image_url" | "input_image")) {
            require_user_content_role(role, "Image", "invalid_image_role", &label)?;
            let Some(image) = to_input_image_part(part) else {
                return Err(invalid_request(
                    "An image_url content part must include a URL.",
                    "invalid_image_url",
                    Some(format!("{label}.image_url")),
                ));
            };
            parts.push(Value::Object(image));
            continue;
        }
        if matches!(kind, Some("file" | "input_file")) {
            require_user_content_role(role, "File", "invalid_file_role", &label)?;
            let Some(file) = to_input_file_part(part) else {
                return Err(invalid_request(
                    "A file content part must include file_id, file_data, or file_url.",
                    "invalid_file",
                    Some(format!("{label}.file")),
                ));
            };
            parts.push(Value::Object(file));
            continue;
        }
        if kind == Some("input_audio") {
            require_user_content_role(role, "Audio", "invalid_audio_role", &label)?;
            let audio = part
                .get("input_audio")
                .and_then(Value::as_object)
                .unwrap_or(part);
            let data = require_string(
                audio.get("data"),
                &format!("{label}.input_audio.data"),
                None,
            )?;
            let mut audio_part = JsonObject::new();
            audio_part.insert("type".into(), Value::String("input_audio".into()));
            audio_part.insert("data".into(), Value::String(data.to_owned()));
            copy_non_empty_string(audio, &mut audio_part, "format");
            parts.push(Value::Object(audio_part));
            continue;
        }
        if kind == Some("refusal") && role == "assistant" {
            parts.push(json!({
                "type":"output_text",
                "text":part.get("refusal").and_then(Value::as_str).unwrap_or("")
            }));
            continue;
        }
        return Err(invalid_request(
            "Unsupported message content type.",
            "unsupported_content_type",
            Some(format!("{label}.type")),
        ));
    }
    Ok(parts)
}

fn require_user_content_role(
    role: &str,
    label: &str,
    code: &'static str,
    param: &str,
) -> AppResult<()> {
    if role == "user" {
        return Ok(());
    }
    Err(invalid_request(
        format!("{label} content is supported only in user messages."),
        code,
        Some(param.to_owned()),
    ))
}

fn to_input_image_part(value: &JsonObject) -> Option<JsonObject> {
    let image = value.get("image_url").and_then(Value::as_object);
    let image_url = value
        .get("image_url")
        .and_then(Value::as_str)
        .or_else(|| {
            image
                .and_then(|image| image.get("url"))
                .and_then(Value::as_str)
        })
        .or_else(|| value.get("url").and_then(Value::as_str))
        .filter(|url| !url.is_empty())?;
    let mut part = JsonObject::new();
    part.insert("type".into(), Value::String("input_image".into()));
    part.insert("image_url".into(), Value::String(image_url.to_owned()));
    let detail = image
        .and_then(|image| image.get("detail"))
        .and_then(Value::as_str)
        .or_else(|| value.get("detail").and_then(Value::as_str))
        .filter(|detail| !detail.is_empty());
    if let Some(detail) = detail {
        part.insert("detail".into(), Value::String(detail.to_owned()));
    }
    Some(part)
}

fn to_input_file_part(value: &JsonObject) -> Option<JsonObject> {
    let file = value
        .get("file")
        .and_then(Value::as_object)
        .unwrap_or(value);
    let mut part = JsonObject::new();
    part.insert("type".into(), Value::String("input_file".into()));
    for key in ["file_id", "file_data", "file_url", "filename"] {
        copy_non_empty_string(file, &mut part, key);
    }
    (part.contains_key("file_id")
        || part.contains_key("file_data")
        || part.contains_key("file_url"))
    .then_some(part)
}

fn adapt_tool_output(value: Option<&Value>) -> Value {
    let Some(value) = value else {
        return Value::String(String::new());
    };
    if let Some(text) = value.as_str() {
        if let Ok(Value::Array(parts)) = serde_json::from_str::<Value>(text) {
            let has_rich_part = parts.iter().any(|part| {
                matches!(
                    part.as_object()
                        .and_then(|part| part.get("type"))
                        .and_then(Value::as_str),
                    Some("image_url" | "input_image" | "file" | "input_file")
                )
            });
            if has_rich_part {
                return Value::Array(parts.iter().map(adapt_tool_output_part).collect());
            }
        }
        return Value::String(text.to_owned());
    }
    if value.is_null() {
        return Value::String(String::new());
    }
    if let Some(parts) = value.as_array() {
        return Value::Array(parts.iter().map(adapt_tool_output_part).collect());
    }
    Value::String(value.to_string())
}

fn adapt_tool_output_part(value: &Value) -> Value {
    if let Some(text) = value.as_str() {
        return json!({"type":"input_text","text":text});
    }
    let Some(part) = value.as_object() else {
        return json!({
            "type":"input_text",
            "text":if value.is_null() { String::new() } else { value.to_string() }
        });
    };
    let kind = part.get("type").and_then(Value::as_str);
    if matches!(kind, Some("text" | "input_text" | "output_text")) {
        return json!({
            "type":"input_text",
            "text":part.get("text").and_then(Value::as_str)
                .or_else(|| part.get("content").and_then(Value::as_str))
                .unwrap_or("")
        });
    }
    if matches!(kind, Some("image_url" | "input_image"))
        && let Some(adapted) = to_input_image_part(part)
    {
        return Value::Object(adapted);
    }
    if matches!(kind, Some("file" | "input_file"))
        && let Some(adapted) = to_input_file_part(part)
    {
        return Value::Object(adapted);
    }
    json!({
        "type":"input_text",
        "text":value.to_string()
    })
}

fn adapt_response_format(value: Option<&Value>) -> AppResult<Option<JsonObject>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let response_format = require_object(value, "response_format")?;
    let kind = require_string(response_format.get("type"), "response_format.type", None)?;
    if kind == "text" || kind == "json_object" {
        return Ok(Some(json_object(json!({"format":{"type":kind}}))));
    }
    if kind != "json_schema" {
        return Err(invalid_request(
            "Unsupported response_format type.",
            "unsupported_response_format",
            Some("response_format.type".to_owned()),
        ));
    }
    let schema = response_format
        .get("json_schema")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid_json("response_format.json_schema"))?;
    let mut format = JsonObject::new();
    format.insert("type".into(), Value::String("json_schema".into()));
    format.insert(
        "name".into(),
        Value::String(
            require_string(schema.get("name"), "response_format.json_schema.name", None)?
                .to_owned(),
        ),
    );
    copy_string(schema, &mut format, "description");
    copy_if_present(schema, &mut format, "schema");
    copy_if_present(schema, &mut format, "strict");
    let mut text = JsonObject::new();
    text.insert("format".into(), Value::Object(format));
    Ok(Some(text))
}

fn require_object<'a>(value: &'a Value, label: &str) -> AppResult<&'a JsonObject> {
    value.as_object().ok_or_else(|| invalid_json(label))
}

fn invalid_json(label: &str) -> ApiError {
    ApiError::new(400, format!("The {label} must be a JSON object."))
        .with_kind("invalid_request_error")
        .with_code("invalid_json")
}

fn require_string<'a>(
    value: Option<&'a Value>,
    param: &str,
    message: Option<&str>,
) -> AppResult<&'a str> {
    ApiError::require_string(value, param, message)
}

fn copy_string(source: &JsonObject, target: &mut JsonObject, key: &str) {
    if let Some(value) = source.get(key).and_then(Value::as_str) {
        target.insert(key.to_owned(), Value::String(value.to_owned()));
    }
}

fn copy_non_empty_string(source: &JsonObject, target: &mut JsonObject, key: &str) {
    if let Some(value) = source
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        target.insert(key.to_owned(), Value::String(value.to_owned()));
    }
}

fn copy_if_present(source: &JsonObject, target: &mut JsonObject, key: &str) {
    if let Some(value) = source.get(key) {
        target.insert(key.to_owned(), value.clone());
    }
}

fn json_object(value: Value) -> JsonObject {
    value.as_object().cloned().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(value: Value) -> JsonObject {
        value.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn maps_messages_tools_multimodal_content_and_formats() {
        let adapted = chat_request_to_responses(&request(json!({
            "model":"gpt-5.6-lunar",
            "reasoning_effort":"low",
            "parallel_tool_calls":false,
            "service_tier":"flex",
            "messages":[
                {"role":"system","content":"Answer precisely."},
                {"role":"user","content":[
                    {"type":"image_url","image_url":{"url":"https://example.com/weather.png"}}
                ]},
                {"role":"assistant","content":null,"tool_calls":[{
                    "id":"call_1","type":"function",
                    "function":{"name":"weather","arguments":"{\"city\":\"Shanghai\"}"}
                }]},
                {"role":"tool","tool_call_id":"call_1","content":"sunny"}
            ],
            "tools":[{"type":"function","function":{"name":"weather","description":"Get weather"}}],
            "response_format":{"type":"json_schema","json_schema":{"name":"weather"}}
        })))
        .expect("valid request");

        assert_eq!(adapted.body["reasoning"], json!({"effort":"low"}));
        assert_eq!(adapted.body["parallel_tool_calls"], false);
        assert!(adapted.body.get("service_tier").is_none());
        assert_eq!(adapted.body["input"][0]["role"], "developer");
        assert_eq!(
            adapted.body["input"][1]["content"][0]["type"],
            "input_image"
        );
        assert_eq!(adapted.body["input"][2]["type"], "function_call");
        assert_eq!(adapted.body["input"][3]["type"], "function_call_output");
        assert_eq!(adapted.body["text"]["format"]["name"], "weather");
    }

    #[test]
    fn custom_tool_identity_controls_calls_outputs_and_choice() {
        let adapted = chat_request_to_responses(&request(json!({
            "model":"gpt-5.6-luna",
            "messages":[
                {"role":"assistant","content":null,"tool_calls":[{
                    "id":"call_patch","type":"function",
                    "function":{"name":"apply_patch","arguments":"patch"}
                }]},
                {"role":"tool","tool_call_id":"call_patch","content":[
                    {"type":"text","text":"done"},
                    {"type":"file","file":{"file_id":"file_result","filename":"result.txt"}}
                ]}
            ],
            "tools":[{"type":"custom","name":"apply_patch","format":{"type":"text"}}],
            "tool_choice":{"type":"function","function":{"name":"apply_patch"}}
        })))
        .expect("valid request");
        assert_eq!(
            adapted.body["tool_choice"],
            json!({"type":"custom","name":"apply_patch"})
        );
        assert_eq!(adapted.body["input"][0]["type"], "custom_tool_call");
        assert_eq!(adapted.body["input"][1]["type"], "custom_tool_call_output");
        assert!(adapted.body["input"][1]["output"].is_array());
    }

    #[test]
    fn rejects_multi_choice_and_invalid_prompt_shapes_without_panicking() {
        let error = chat_request_to_responses(&request(json!({
            "model":"m","messages":[],"n":2
        })))
        .expect_err("n=2 must fail");
        assert_eq!(error.code.as_deref(), Some("unsupported_parameter"));
    }
}
