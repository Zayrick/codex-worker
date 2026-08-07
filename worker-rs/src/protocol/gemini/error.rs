use serde_json::{Value, json};

use crate::core::{ApiError, JsonObject, object, record_field, string_field};

pub fn gemini_error_payload(error: &ApiError) -> Value {
    json!({
        "error": {
            "code": error.status,
            "message": error.message,
            "status": google_status(error.status, error.code.as_deref().unwrap_or("")),
        }
    })
}

pub fn gemini_codex_event_error(event: &Value) -> ApiError {
    let event = object(event);
    let detail = record_field(event, "error");
    let source = format!(
        "{} {}",
        string_field(detail, "type").unwrap_or(""),
        string_field(detail, "code").unwrap_or("")
    )
    .to_ascii_lowercase();
    let status = if source.contains("rate_limit") {
        429
    } else if source.contains("overload") {
        503
    } else if source.contains("invalid_request") || source.contains("context_length") {
        400
    } else if source.contains("auth") {
        401
    } else if source.contains("permission") {
        403
    } else {
        502
    };
    let message = string_field(detail, "message")
        .or_else(|| string_field(event, "message"))
        .unwrap_or("The Codex response stream failed.");
    ApiError::new(status, message)
        .with_kind("upstream_error")
        .with_code(google_status(status, ""))
}

/// Converts already-parsed upstream error JSON into the protocol-neutral error.
/// Body reading and size limits remain transport concerns.
pub fn gemini_upstream_error(status: u16, payload: Option<&Value>) -> ApiError {
    let root = payload.and_then(Value::as_object);
    let detail = record_field(root, "error");
    let message = string_field(detail, "message")
        .or_else(|| string_field(root, "message"))
        .map(str::to_owned)
        .unwrap_or_else(|| format!("The ChatGPT Codex backend returned HTTP {status}."));
    ApiError::new(status, message)
        .with_kind("upstream_error")
        .with_code(google_status(status, ""))
}

pub fn google_status(status: u16, source: &str) -> String {
    if is_google_status(source) {
        return source.to_owned();
    }
    match status {
        400 => "INVALID_ARGUMENT",
        401 => "UNAUTHENTICATED",
        403 => "PERMISSION_DENIED",
        404 => "NOT_FOUND",
        409 => "ABORTED",
        429 => "RESOURCE_EXHAUSTED",
        503 | 529 => "UNAVAILABLE",
        _ => "INTERNAL",
    }
    .to_owned()
}

pub fn incomplete_codex_stream() -> ApiError {
    ApiError::new(502, "The Codex stream ended without a completed response.")
        .with_kind("api_error")
        .with_code("incomplete_codex_stream")
}

pub fn codex_stream_failed() -> ApiError {
    ApiError::new(502, "The Codex response stream failed.")
        .with_kind("upstream_error")
        .with_code("codex_stream_failed")
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

fn is_google_status(source: &str) -> bool {
    let mut bytes = source.bytes();
    matches!(bytes.next(), Some(b'A'..=b'Z'))
        && bytes.clone().next().is_some()
        && bytes.all(|value| value.is_ascii_uppercase() || value == b'_')
}
