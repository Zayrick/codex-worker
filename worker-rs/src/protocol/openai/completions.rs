//! Legacy Completions compatibility built on the Chat/Responses core.

use serde_json::{Value, json};

use crate::core::{AppResult, JsonObject};

use super::{
    chat::{AdaptedChatRequest, chat_request_to_responses},
    codex_stream_failed, invalid_request,
    sse::{SSE_DONE, SseFrame, SseFrameDecoder, sse_data},
};

#[derive(Debug, Clone, PartialEq)]
pub struct AdaptedCompletionRequest {
    pub body: JsonObject,
    pub model: String,
    pub stream: bool,
    pub include_usage: bool,
    pub echo_prefix: String,
}

pub fn completion_request_to_responses(input: &JsonObject) -> AppResult<AdaptedCompletionRequest> {
    let model = input
        .get("model")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            invalid_request(
                "Missing required parameter: 'model'.",
                "missing_required_parameter",
                Some("model".to_owned()),
            )
        })?
        .to_owned();
    let prompt = completion_prompt(input.get("prompt"))?;
    require_single_completion(input.get("n"), "n")?;
    require_single_completion(input.get("best_of"), "best_of")?;

    let mut chat_request = json_object(json!({
        "model":model,
        "messages":[{"role":"user","content":prompt}],
        "stream":input.get("stream").and_then(Value::as_bool) == Some(true)
    }));
    for key in [
        "metadata",
        "prompt_cache_key",
        "reasoning_effort",
        "service_tier",
        "stream_options",
    ] {
        if let Some(value) = input.get(key) {
            chat_request.insert(key.to_owned(), value.clone());
        }
    }
    let AdaptedChatRequest {
        body,
        model,
        stream,
        include_usage,
    } = chat_request_to_responses(&chat_request)?;
    Ok(AdaptedCompletionRequest {
        body,
        model,
        stream,
        include_usage,
        echo_prefix: if input.get("echo").and_then(Value::as_bool) == Some(true) {
            prompt
        } else {
            String::new()
        },
    })
}

pub fn completion_from_chat(chat: &JsonObject, echo_prefix: &str) -> JsonObject {
    let choices = chat
        .get("choices")
        .and_then(Value::as_array)
        .map(|choices| {
            choices
                .iter()
                .filter_map(Value::as_object)
                .map(|choice| {
                    let content = choice
                        .get("message")
                        .and_then(Value::as_object)
                        .and_then(|message| message.get("content"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    json!({
                        "index":numeric_or_zero(choice.get("index")),
                        "text":format!("{echo_prefix}{content}"),
                        "logprobs":choice.get("logprobs").cloned().unwrap_or(Value::Null),
                        "finish_reason":choice.get("finish_reason").cloned().unwrap_or(Value::Null)
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let mut result = JsonObject::new();
    if let Some(id) = chat.get("id") {
        result.insert("id".into(), completion_id(id));
    }
    result.insert("object".into(), Value::String("text_completion".into()));
    copy_if_present(chat, &mut result, "created");
    copy_if_present(chat, &mut result, "model");
    result.insert("choices".into(), Value::Array(choices));
    copy_if_present(chat, &mut result, "usage");
    result
}

#[must_use]
pub fn completion_id(value: &Value) -> Value {
    let Some(id) = value.as_str() else {
        return value.clone();
    };
    if let Some(suffix) = id.strip_prefix("chatcmpl-") {
        return Value::String(format!("cmpl-{suffix}"));
    }
    if let Some(suffix) = id.strip_prefix("resp_") {
        return Value::String(format!("cmpl-{suffix}"));
    }
    value.clone()
}

/// Incrementally converts Chat Completions SSE frames into legacy Completion
/// frames. The class retains at most one bounded SSE event plus the echo prefix.
#[derive(Debug, Clone)]
pub struct CompletionSseDecoder {
    frames: SseFrameDecoder,
    pending_echo: String,
}

impl CompletionSseDecoder {
    #[must_use]
    pub fn new(echo_prefix: impl Into<String>) -> Self {
        Self {
            frames: SseFrameDecoder::new(),
            pending_echo: echo_prefix.into(),
        }
    }

    pub fn push_bytes(&mut self, bytes: &[u8]) -> AppResult<Vec<String>> {
        let frames = self.frames.push_bytes(bytes)?;
        self.convert_frames(frames)
    }

    pub fn push_str(&mut self, chunk: &str) -> AppResult<Vec<String>> {
        let frames = self.frames.push_str(chunk)?;
        self.convert_frames(frames)
    }

    pub fn finish(&mut self) -> AppResult<Vec<String>> {
        let frames = self.frames.finish()?;
        self.convert_frames(frames)
    }

    fn convert_frames(&mut self, frames: Vec<SseFrame>) -> AppResult<Vec<String>> {
        let mut converted_frames = Vec::new();
        for frame in frames {
            match frame {
                SseFrame::Done => converted_frames.push(SSE_DONE.to_owned()),
                SseFrame::Data(data) => {
                    let Value::Object(chunk) = serde_json::from_str::<Value>(data.trim())
                        .map_err(|_| codex_stream_failed())?
                    else {
                        return Err(codex_stream_failed());
                    };
                    if chunk.get("error").and_then(Value::as_object).is_some() {
                        converted_frames.push(sse_data(&Value::Object(chunk))?);
                    } else if let Some(converted) = completion_chunk(&chunk, &mut self.pending_echo)
                    {
                        converted_frames.push(sse_data(&Value::Object(converted))?);
                    }
                }
            }
        }
        Ok(converted_frames)
    }
}

fn completion_chunk(chunk: &JsonObject, pending_echo: &mut String) -> Option<JsonObject> {
    let mut choices = Vec::new();
    if let Some(raw_choices) = chunk.get("choices").and_then(Value::as_array) {
        for raw_choice in raw_choices {
            let Some(choice) = raw_choice.as_object() else {
                continue;
            };
            let delta_text = choice
                .get("delta")
                .and_then(Value::as_object)
                .and_then(|delta| delta.get("content"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let finish_reason = choice.get("finish_reason");
            if delta_text.is_empty() && finish_reason.is_none_or(Value::is_null) {
                continue;
            }
            let echo = std::mem::take(pending_echo);
            choices.push(json!({
                "index":numeric_or_zero(choice.get("index")),
                "text":format!("{echo}{delta_text}"),
                "logprobs":choice.get("logprobs").cloned().unwrap_or(Value::Null),
                "finish_reason":finish_reason.cloned().unwrap_or(Value::Null)
            }));
        }
    }
    if choices.is_empty() && !chunk.contains_key("usage") {
        return None;
    }
    let mut converted = JsonObject::new();
    if let Some(id) = chunk.get("id") {
        converted.insert("id".into(), completion_id(id));
    }
    converted.insert("object".into(), Value::String("text_completion".into()));
    copy_if_present(chunk, &mut converted, "created");
    copy_if_present(chunk, &mut converted, "model");
    converted.insert("choices".into(), Value::Array(choices));
    copy_if_present(chunk, &mut converted, "usage");
    Some(converted)
}

fn completion_prompt(value: Option<&Value>) -> AppResult<String> {
    if let Some(value) = value.and_then(Value::as_str) {
        return Ok(value.to_owned());
    }
    if let Some(values) = value.and_then(Value::as_array)
        && values.len() == 1
        && let Some(value) = values.first().and_then(Value::as_str)
    {
        return Ok(value.to_owned());
    }
    Err(invalid_request(
        "'prompt' must be a string or a single-item string array.",
        "invalid_prompt",
        Some("prompt".to_owned()),
    ))
}

fn require_single_completion(value: Option<&Value>, param: &str) -> AppResult<()> {
    if value.is_none() || value.and_then(Value::as_f64) == Some(1.0) {
        return Ok(());
    }
    Err(invalid_request(
        format!("This proxy currently supports only {param}=1."),
        "unsupported_parameter",
        Some(param.to_owned()),
    ))
}

fn numeric_or_zero(value: Option<&Value>) -> Value {
    value
        .filter(|value| value.is_number())
        .cloned()
        .unwrap_or_else(|| json!(0))
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

    fn object(value: Value) -> JsonObject {
        value.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn converts_requests_responses_and_echo() {
        let request = completion_request_to_responses(&object(json!({
            "model":"gpt-5.6-luna","prompt":"Prompt: ","echo":true
        })))
        .expect("request");
        assert_eq!(request.echo_prefix, "Prompt: ");
        assert_eq!(request.body["input"][0]["content"][0]["text"], "Prompt: ");

        let completion = completion_from_chat(
            &object(json!({
                "id":"chatcmpl-completion",
                "created":1,
                "model":"gpt-5.6-luna",
                "choices":[{"index":0,"message":{"content":"generated"},"logprobs":null,"finish_reason":"stop"}],
                "usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}
            })),
            &request.echo_prefix,
        );
        assert_eq!(completion["id"], "cmpl-completion");
        assert_eq!(completion["choices"][0]["text"], "Prompt: generated");
    }

    #[test]
    fn rejects_multi_prompt_n_and_best_of() {
        for input in [
            json!({"model":"m","prompt":["one","two"]}),
            json!({"model":"m","prompt":"one","n":2}),
            json!({"model":"m","prompt":"one","best_of":2}),
        ] {
            assert!(completion_request_to_responses(&object(input)).is_err());
        }
    }

    #[test]
    fn incrementally_converts_chat_sse_and_preserves_done_and_errors() {
        let source = concat!(
            "data: {\"id\":\"chatcmpl-completion\",\"created\":1,\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"generated\"},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl-completion\",\"created\":1,\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n"
        );
        let split = source.len() / 2;
        let mut decoder = CompletionSseDecoder::new("Prompt: ");
        let mut frames = decoder.push_str(&source[..split]).expect("first half");
        frames.extend(decoder.push_str(&source[split..]).expect("second half"));
        frames.extend(decoder.finish().expect("finish"));
        let rendered = frames.concat();
        assert!(rendered.contains("cmpl-completion"));
        assert!(rendered.contains("Prompt: generated"));
        assert!(rendered.contains("\"finish_reason\":\"stop\""));
        assert!(rendered.ends_with(SSE_DONE));
        assert!(!rendered.contains("chat.completion.chunk"));
    }

    #[test]
    fn completion_decoder_preserves_split_utf8_code_points() {
        let source = concat!(
            "data: {\"id\":\"chatcmpl-unicode\",\"model\":\"m\",\"choices\":[{\"delta\":{\"content\":\"你好\"},\"finish_reason\":null}]}\n\n",
            "data: [DONE]\n\n"
        );
        let bytes = source.as_bytes();
        let split = bytes
            .iter()
            .position(|byte| *byte == 0xe4)
            .unwrap_or(bytes.len());
        let mut decoder = CompletionSseDecoder::new("");
        let mut frames = decoder
            .push_bytes(&bytes[..split.saturating_add(1).min(bytes.len())])
            .unwrap_or_default();
        frames.extend(
            decoder
                .push_bytes(&bytes[split.saturating_add(1).min(bytes.len())..])
                .unwrap_or_default(),
        );
        assert!(frames.concat().contains("你好"));
    }
}
