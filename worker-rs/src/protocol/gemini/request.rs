use std::collections::{HashMap, HashSet, VecDeque};

use serde_json::{Map, Value, json};

use crate::core::{ApiError, AppResult, JsonObject};

use super::TokenCounter;

const MAX_TOOLS: usize = 128;
const CODEX_IDENTIFIER_LIMIT: usize = 64;

#[derive(Debug, Clone, PartialEq)]
pub struct AdaptedGeminiRequest {
    pub body: JsonObject,
    pub model: String,
    pub reverse_tool_names: HashMap<String, String>,
}

#[derive(Default)]
struct ToolNameMaps {
    forward: HashMap<String, String>,
    reverse: HashMap<String, String>,
}

struct FunctionDeclaration<'a> {
    declaration: &'a JsonObject,
    param: String,
}

#[derive(Default)]
struct LocalCallIds(u64);

impl LocalCallIds {
    fn next(&mut self) -> String {
        let value = format!("call_gemini_{}", self.0);
        self.0 += 1;
        value
    }
}

pub fn gemini_request_to_responses(
    input: &JsonObject,
    model: &str,
) -> AppResult<AdaptedGeminiRequest> {
    if model.is_empty() {
        return Err(invalid_request(
            "The model path parameter is required.",
            "model",
        ));
    }
    let contents = input
        .get("contents")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid_request("Missing required parameter: 'contents'.", "contents"))?;
    let declarations = function_declarations(input.get("tools"))?;
    let names = declarations
        .iter()
        .filter_map(|entry| entry.declaration.get("name").and_then(Value::as_str));
    let name_maps = build_tool_name_maps(names);
    let mut response_input = Vec::new();
    append_system_instruction(&mut response_input, input)?;
    append_contents(&mut response_input, contents, &name_maps)?;

    let mut body = Map::new();
    body.insert("model".into(), Value::String(model.to_owned()));
    body.insert("input".into(), Value::Array(response_input));
    body.insert("parallel_tool_calls".into(), Value::Bool(true));
    body.insert(
        "reasoning".into(),
        json!({ "effort": reasoning_effort(input) }),
    );
    let tools = adapt_tools(&declarations, &name_maps)?;
    if !tools.is_empty() {
        body.insert("tools".into(), Value::Array(tools));
        body.insert("tool_choice".into(), Value::String("auto".into()));
    }
    apply_tool_choice(
        &mut body,
        alias(input, "toolConfig", "tool_config"),
        &name_maps,
    );
    let tier = alias(input, "service_tier", "serviceTier")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(tier.as_str(), "priority" | "fast") {
        body.insert("service_tier".into(), Value::String("priority".into()));
    }
    Ok(AdaptedGeminiRequest {
        body,
        model: model.to_owned(),
        reverse_tool_names: name_maps.reverse,
    })
}

pub fn gemini_count_request(input: &JsonObject, model: &str) -> AppResult<AdaptedGeminiRequest> {
    let nested = alias(input, "generateContentRequest", "generate_content_request");
    match nested {
        None => gemini_request_to_responses(input, model),
        Some(value) => {
            let request = require_record(value, "generateContentRequest")?;
            gemini_request_to_responses(request, model)
        }
    }
}

pub fn gemini_count_tokens<C: TokenCounter + ?Sized>(
    input: &JsonObject,
    model: &str,
    counter: &C,
) -> AppResult<Value> {
    let adapted = gemini_count_request(input, model)?;
    Ok(json!({ "totalTokens": counter.count_tokens(&adapted.body)? }))
}

fn append_system_instruction(output: &mut Vec<Value>, input: &JsonObject) -> AppResult<()> {
    let Some(value) = alias(input, "systemInstruction", "system_instruction") else {
        return Ok(());
    };
    if let Some(text) = value.as_str() {
        output.push(message(
            "developer",
            json!({ "type": "input_text", "text": text }),
        ));
        return Ok(());
    }
    let instruction = require_record(value, "systemInstruction")?;
    let parts = instruction
        .get("parts")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            invalid_request(
                "systemInstruction.parts must be an array.",
                "systemInstruction.parts",
            )
        })?;
    for (index, raw) in parts.iter().enumerate() {
        let param = format!("systemInstruction.parts[{index}]");
        let part = require_record(raw, &param)?;
        let Some(text) = part.get("text").and_then(Value::as_str) else {
            return Err(invalid_request(
                "System instructions support only text parts.",
                &param,
            ));
        };
        output.push(message(
            "developer",
            json!({ "type": "input_text", "text": text }),
        ));
    }
    Ok(())
}

fn append_contents(
    output: &mut Vec<Value>,
    contents: &[Value],
    name_maps: &ToolNameMaps,
) -> AppResult<()> {
    let mut pending_call_ids = VecDeque::new();
    let mut generated_ids = LocalCallIds::default();
    for (content_index, raw_content) in contents.iter().enumerate() {
        let content_param = format!("contents[{content_index}]");
        let content = require_record(raw_content, &content_param)?;
        let source_role = match content.get("role") {
            None => "user",
            Some(value) => value.as_str().unwrap_or(""),
        };
        let role = if source_role == "model" {
            "assistant"
        } else {
            source_role
        };
        if !matches!(role, "user" | "assistant") {
            return Err(invalid_request(
                format!("contents[{content_index}].role must be 'user' or 'model'."),
                &format!("contents[{content_index}].role"),
            ));
        }
        let parts = content
            .get("parts")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                invalid_request(
                    format!("contents[{content_index}].parts must be an array."),
                    &format!("contents[{content_index}].parts"),
                )
            })?;
        for (part_index, raw_part) in parts.iter().enumerate() {
            let param = format!("contents[{content_index}].parts[{part_index}]");
            let part = require_record(raw_part, &param)?;
            if let Some(text) = part.get("text").and_then(Value::as_str) {
                let signature = alias(part, "thoughtSignature", "thought_signature")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if role == "assistant"
                    && part.get("thought") == Some(&Value::Bool(true))
                    && is_codex_reasoning_signature(signature)
                {
                    output.push(json!({
                        "type": "reasoning",
                        "summary": if text.is_empty() {
                            Vec::<Value>::new()
                        } else {
                            vec![json!({ "type": "summary_text", "text": text })]
                        },
                        "content": Value::Null,
                        "encrypted_content": signature,
                    }));
                } else {
                    output.push(message(
                        role,
                        json!({
                            "type": if role == "assistant" { "output_text" } else { "input_text" },
                            "text": text,
                        }),
                    ));
                }
                continue;
            }

            if let Some(inline) =
                alias(part, "inlineData", "inline_data").and_then(Value::as_object)
            {
                output.push(message(
                    role,
                    inline_data_part(inline, &format!("{param}.inlineData"))?,
                ));
                continue;
            }
            if let Some(file) = alias(part, "fileData", "file_data").and_then(Value::as_object) {
                output.push(message(
                    role,
                    file_data_part(file, &format!("{param}.fileData"))?,
                ));
                continue;
            }
            if let Some(call) =
                alias(part, "functionCall", "function_call").and_then(Value::as_object)
            {
                let name =
                    required_string(call.get("name"), &format!("{param}.functionCall.name"))?;
                let explicit = alias(call, "id", "call_id")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let raw_call_id = if explicit.is_empty() {
                    generated_ids.next()
                } else {
                    explicit.to_owned()
                };
                let call_id = shorten_codex_call_id(&raw_call_id);
                pending_call_ids.push_back(call_id.clone());
                let arguments = call
                    .get("args")
                    .filter(|value| !value.is_null())
                    .map(|value| serde_json::to_string(value).unwrap_or_else(|_| "{}".into()))
                    .unwrap_or_else(|| "{}".into());
                output.push(json!({
                    "type": "function_call",
                    "call_id": call_id,
                    "name": codex_tool_name(name, &name_maps.forward),
                    "arguments": arguments,
                }));
                continue;
            }
            if let Some(response) =
                alias(part, "functionResponse", "function_response").and_then(Value::as_object)
            {
                let explicit = alias(response, "id", "call_id")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let call_id = if explicit.is_empty() {
                    pending_call_ids
                        .pop_front()
                        .unwrap_or_else(|| generated_ids.next())
                } else {
                    let shortened = shorten_codex_call_id(explicit);
                    if let Some(index) = pending_call_ids.iter().position(|id| id == &shortened) {
                        pending_call_ids.remove(index);
                    }
                    shortened
                };
                output.push(json!({
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": function_response_output(response.get("response")),
                }));
                continue;
            }
            if let Some(executable) =
                alias(part, "executableCode", "executable_code").and_then(Value::as_object)
            {
                output.push(message(
                    role,
                    json!({
                        "type": if role == "assistant" { "output_text" } else { "input_text" },
                        "text": executable.get("code").and_then(Value::as_str).unwrap_or(""),
                    }),
                ));
                continue;
            }
            if let Some(execution) = alias(part, "codeExecutionResult", "code_execution_result")
                .and_then(Value::as_object)
            {
                output.push(message(
                    role,
                    json!({
                        "type": if role == "assistant" { "output_text" } else { "input_text" },
                        "text": execution.get("output").and_then(Value::as_str).unwrap_or(""),
                    }),
                ));
                continue;
            }
            return Err(invalid_request("Unsupported Gemini content part.", &param));
        }
    }
    Ok(())
}

fn inline_data_part(value: &JsonObject, param: &str) -> AppResult<Value> {
    let mime_type = required_string(
        alias(value, "mimeType", "mime_type"),
        &format!("{param}.mimeType"),
    )?;
    let data = required_string(value.get("data"), &format!("{param}.data"))?;
    let lower = mime_type.to_ascii_lowercase();
    if lower.starts_with("image/") {
        return Ok(json!({
            "type": "input_image",
            "image_url": format!("data:{mime_type};base64,{data}"),
        }));
    }
    if lower.starts_with("audio/") {
        return Ok(json!({
            "type": "input_audio",
            "input_audio": { "data": data, "format": audio_format(mime_type) },
        }));
    }
    Ok(json!({
        "type": "input_file",
        "file_data": data,
        "filename": filename(mime_type),
    }))
}

fn file_data_part(value: &JsonObject, param: &str) -> AppResult<Value> {
    let uri = required_string(
        alias(value, "fileUri", "file_uri"),
        &format!("{param}.fileUri"),
    )?;
    let mime_type = alias(value, "mimeType", "mime_type")
        .and_then(Value::as_str)
        .unwrap_or("");
    let lower = mime_type.to_ascii_lowercase();
    if lower.starts_with("image/") {
        return Ok(json!({ "type": "input_image", "image_url": uri }));
    }
    if lower.starts_with("video/")
        || lower.starts_with("application/")
        || lower.starts_with("text/")
    {
        return Ok(json!({
            "type": "input_file",
            "file_url": uri,
            "filename": filename(mime_type),
        }));
    }
    Ok(json!({
        "type": "input_text",
        "text": if mime_type.is_empty() {
            format!("File: {uri}")
        } else {
            format!("File: {uri} (Type: {mime_type})")
        },
    }))
}

fn function_declarations(value: Option<&Value>) -> AppResult<Vec<FunctionDeclaration<'_>>> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let tools = value
        .as_array()
        .ok_or_else(|| invalid_request("'tools' must be an array.", "tools"))?;
    let mut result = Vec::new();
    for (tool_index, raw_tool) in tools.iter().enumerate() {
        let tool = require_record(raw_tool, &format!("tools[{tool_index}]"))?;
        let Some(raw) = alias(tool, "functionDeclarations", "function_declarations") else {
            continue;
        };
        let declarations = raw.as_array().ok_or_else(|| {
            invalid_request(
                "functionDeclarations must be an array.",
                &format!("tools[{tool_index}].functionDeclarations"),
            )
        })?;
        for (index, declaration) in declarations.iter().enumerate() {
            if result.len() >= MAX_TOOLS {
                return Err(invalid_request(
                    format!("At most {MAX_TOOLS} functions are supported."),
                    "tools",
                ));
            }
            let param = format!("tools[{tool_index}].functionDeclarations[{index}]");
            result.push(FunctionDeclaration {
                declaration: require_record(declaration, &param)?,
                param,
            });
        }
    }
    Ok(result)
}

fn adapt_tools(
    declarations: &[FunctionDeclaration<'_>],
    name_maps: &ToolNameMaps,
) -> AppResult<Vec<Value>> {
    declarations
        .iter()
        .map(|entry| {
            let name = required_string(
                entry.declaration.get("name"),
                &format!("{}.name", entry.param),
            )?;
            let mut parameters = alias(entry.declaration, "parameters", "parametersJsonSchema")
                .or_else(|| entry.declaration.get("parameters_json_schema"))
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_else(|| {
                    Map::from_iter([
                        ("type".into(), Value::String("object".into())),
                        ("properties".into(), Value::Object(Map::new())),
                    ])
                });
            parameters.remove("$schema");
            if parameters.get("additionalProperties") != Some(&Value::Bool(false)) {
                parameters.insert("additionalProperties".into(), Value::Bool(false));
            }
            let mut tool = Map::from_iter([
                ("type".into(), Value::String("function".into())),
                (
                    "name".into(),
                    Value::String(codex_tool_name(name, &name_maps.forward)),
                ),
                ("parameters".into(), Value::Object(parameters)),
                ("strict".into(), Value::Bool(false)),
            ]);
            if let Some(description) = entry.declaration.get("description").and_then(Value::as_str)
            {
                tool.insert("description".into(), Value::String(description.to_owned()));
            }
            Ok(Value::Object(tool))
        })
        .collect()
}

fn apply_tool_choice(body: &mut JsonObject, value: Option<&Value>, names: &ToolNameMaps) {
    let Some(config) = value.and_then(Value::as_object) else {
        return;
    };
    let Some(config) = alias(config, "functionCallingConfig", "function_calling_config")
        .and_then(Value::as_object)
    else {
        return;
    };
    let mode = config
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_uppercase();
    match mode.as_str() {
        "NONE" => {
            body.insert("tool_choice".into(), Value::String("none".into()));
        }
        "AUTO" => {
            body.insert("tool_choice".into(), Value::String("auto".into()));
        }
        "ANY" | "VALIDATED" => {
            let allowed = alias(config, "allowedFunctionNames", "allowed_function_names")
                .and_then(Value::as_array);
            if let Some([Value::String(name)]) = allowed.map(Vec::as_slice) {
                body.insert(
                    "tool_choice".into(),
                    json!({
                        "type": "function",
                        "name": codex_tool_name(name, &names.forward),
                    }),
                );
            } else {
                body.insert("tool_choice".into(), Value::String("required".into()));
            }
        }
        _ => {}
    }
}

fn reasoning_effort(input: &JsonObject) -> String {
    let Some(config) =
        alias(input, "generationConfig", "generation_config").and_then(Value::as_object)
    else {
        return "medium".into();
    };
    if let Some(level) = alias(config, "thinkingLevel", "thinking_level")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        return level.trim().to_ascii_lowercase();
    }
    let Some(thinking) =
        alias(config, "thinkingConfig", "thinking_config").and_then(Value::as_object)
    else {
        return "medium".into();
    };
    if let Some(level) = alias(thinking, "thinkingLevel", "thinking_level")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        return level.trim().to_ascii_lowercase();
    }
    alias(thinking, "thinkingBudget", "thinking_budget")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .map(effort_from_budget)
        .unwrap_or_else(|| "medium".into())
}

fn effort_from_budget(budget: f64) -> String {
    let budget = budget.trunc();
    if budget < -1.0 {
        "medium"
    } else if budget == -1.0 {
        "auto"
    } else if budget == 0.0 {
        "none"
    } else if budget <= 512.0 {
        "minimal"
    } else if budget <= 1_024.0 {
        "low"
    } else if budget <= 8_192.0 {
        "medium"
    } else if budget <= 24_576.0 {
        "high"
    } else {
        "xhigh"
    }
    .into()
}

fn build_tool_name_maps<'a>(names: impl IntoIterator<Item = &'a str>) -> ToolNameMaps {
    let mut result = ToolNameMaps::default();
    let mut used = HashSet::new();
    for name in names {
        if result.forward.contains_key(name) {
            continue;
        }
        let base = tool_name_candidate(name);
        let mut candidate = base.clone();
        let mut suffix = 1;
        while used.contains(&candidate) {
            let ending = format!("_{suffix}");
            candidate = format!(
                "{}{}",
                truncate_utf16(&base, CODEX_IDENTIFIER_LIMIT - utf16_len(&ending)),
                ending
            );
            suffix += 1;
        }
        used.insert(candidate.clone());
        result.forward.insert(name.to_owned(), candidate.clone());
        result.reverse.insert(candidate, name.to_owned());
    }
    result
}

fn codex_tool_name(name: &str, forward: &HashMap<String, String>) -> String {
    forward
        .get(name)
        .cloned()
        .unwrap_or_else(|| tool_name_candidate(name))
}

fn tool_name_candidate(name: &str) -> String {
    if utf16_len(name) <= CODEX_IDENTIFIER_LIMIT {
        return name.to_owned();
    }
    if let Some(suffix) = name
        .strip_prefix("mcp__")
        .and_then(|rest| rest.rsplit_once("__").map(|(_, suffix)| suffix))
    {
        return truncate_utf16(&format!("mcp__{suffix}"), CODEX_IDENTIFIER_LIMIT);
    }
    truncate_utf16(name, CODEX_IDENTIFIER_LIMIT)
}

fn shorten_codex_call_id(id: &str) -> String {
    if utf16_len(id) <= CODEX_IDENTIFIER_LIMIT {
        return id.to_owned();
    }
    let suffix = format!("_{}", stable_hash(id));
    format!(
        "{}{}",
        truncate_utf16(id, CODEX_IDENTIFIER_LIMIT - utf16_len(&suffix)),
        suffix
    )
}

fn stable_hash(value: &str) -> String {
    let mut left = 0x811c_9dc5_u32;
    let mut right = 0x9e37_79b9_u32;
    for code in value.encode_utf16() {
        left = (left ^ u32::from(code)).wrapping_mul(0x0100_0193);
        right = (right ^ u32::from(code)).wrapping_mul(0x85eb_ca6b);
    }
    format!("{left:08x}{right:08x}")
}

fn message(role: &str, part: Value) -> Value {
    json!({ "type": "message", "role": role, "content": [part] })
}

fn function_response_output(value: Option<&Value>) -> String {
    let value = value.unwrap_or(&Value::Null);
    if let Some(result) = value.as_object().and_then(|value| value.get("result")) {
        return output_string(result);
    }
    output_string(value)
}

fn output_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(value) => value.clone(),
        value => serde_json::to_string(value).unwrap_or_default(),
    }
}

fn audio_format(mime_type: &str) -> &'static str {
    match mime_type.trim().to_ascii_lowercase().as_str() {
        "audio/wav" | "audio/wave" | "audio/x-wav" => "wav",
        "audio/flac" => "flac",
        "audio/opus" | "audio/ogg" => "opus",
        "audio/pcm" | "audio/l16" => "pcm16",
        _ => "mp3",
    }
}

fn filename(mime_type: &str) -> &'static str {
    match mime_type.trim().to_ascii_lowercase().as_str() {
        "application/pdf" => "document.pdf",
        "text/plain" => "document.txt",
        "text/csv" => "document.csv",
        "application/json" => "document.json",
        "application/xml" | "text/xml" => "document.xml",
        value if value.starts_with("video/") => "video",
        _ => "document",
    }
}

fn is_codex_reasoning_signature(value: &str) -> bool {
    let length = utf16_len(value);
    (98..=32 * 1024 * 1024).contains(&length)
        && value.starts_with("gAAAA")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'=' | b'-'))
}

fn alias<'a>(object: &'a JsonObject, first: &str, second: &str) -> Option<&'a Value> {
    object
        .get(first)
        .filter(|value| !value.is_null())
        .or_else(|| object.get(second).filter(|value| !value.is_null()))
}

fn require_record<'a>(value: &'a Value, label: &str) -> AppResult<&'a JsonObject> {
    value.as_object().ok_or_else(|| {
        ApiError::new(400, format!("The {label} must be a JSON object."))
            .with_kind("invalid_request_error")
            .with_code("invalid_json")
    })
}

fn required_string<'a>(value: Option<&'a Value>, param: &str) -> AppResult<&'a str> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid_request(format!("Missing required parameter: '{param}'."), param))
}

fn invalid_request(message: impl Into<String>, param: &str) -> ApiError {
    ApiError::new(400, message)
        .with_kind("invalid_request_error")
        .with_code("INVALID_ARGUMENT")
        .with_param(param)
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn truncate_utf16(value: &str, limit: usize) -> String {
    let mut length = 0;
    value
        .chars()
        .take_while(|character| {
            let next = length + character.len_utf16();
            if next > limit {
                false
            } else {
                length = next;
                true
            }
        })
        .collect()
}
