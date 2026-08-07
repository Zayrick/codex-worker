//! Runtime-neutral Anthropic Messages protocol adapter.
//!
//! The transport owns HTTP, SSE decoding, cancellation, and Cloudflare APIs.
//! This module only transforms JSON values and advances bounded state machines.

mod error;
mod identifiers;
mod request;
mod response;
mod stream;
mod token_count;
mod types;

pub use error::{
    MAX_UPSTREAM_ERROR_BYTES, anthropic_error_payload, anthropic_error_type,
    anthropic_upstream_error_payload, codex_event_error, upstream_error_message,
};
pub use identifiers::{
    CODEX_IDENTIFIER_LIMIT, ToolNameMaps, build_tool_name_maps, claude_tool_name,
    claude_tool_use_id, codex_tool_name, shorten_codex_call_id,
};
pub use request::{MessageRequestOptions, messages_request_to_responses};
pub use response::{
    ClaudeContent, claude_stop_reason, claude_usage, failed_codex_response,
    incomplete_codex_stream, message_from_event_values, message_from_terminal_response,
    output_texts, output_to_claude_content, parse_tool_input, reasoning_text,
};
pub use stream::MessagesStreamPresenter;
pub use token_count::{TokenCounter, collect_counted_text, count_codex_input_tokens};
pub use types::{AdaptedMessagesRequest, AnthropicSseEvent, ClaudeUsage};

use serde_json::{Map, Value};

use crate::core::{ApiError, AppResult, JsonObject};

pub type SseEvent = AnthropicSseEvent;

pub(crate) fn into_object(value: Value) -> JsonObject {
    match value {
        Value::Object(object) => object,
        _ => unreachable!("JSON literal must be an object"),
    }
}

pub(crate) fn require_object_ref<'a>(value: &'a Value, label: &str) -> AppResult<&'a JsonObject> {
    value.as_object().ok_or_else(|| {
        ApiError::new(400, format!("The {label} must be a JSON object."))
            .with_kind("invalid_request_error")
            .with_code("invalid_json")
    })
}

pub(crate) fn json_number(value: f64) -> Value {
    if value >= i64::MIN as f64 && value <= i64::MAX as f64 && value.fract() == 0.0 {
        Value::from(value as i64)
    } else {
        serde_json::Number::from_f64(value)
            .map(Value::Number)
            .unwrap_or(Value::Null)
    }
}

pub(crate) fn empty_object() -> JsonObject {
    Map::new()
}
