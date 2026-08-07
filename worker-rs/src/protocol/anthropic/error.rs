use serde_json::{Value, json};

use crate::core::{ApiError, JsonObject, string_field};

use super::into_object;

pub const MAX_UPSTREAM_ERROR_BYTES: usize = 1024 * 1024;

const ANTHROPIC_ERROR_TYPES: &[&str] = &[
    "api_error",
    "authentication_error",
    "billing_error",
    "conflict_error",
    "invalid_request_error",
    "not_found_error",
    "overloaded_error",
    "permission_error",
    "rate_limit_error",
    "request_too_large",
];

pub fn anthropic_error_payload(error: &ApiError, request_id: Option<&str>) -> JsonObject {
    let mut payload = into_object(json!({
        "type": "error",
        "error": {
            "type": anthropic_error_type(error.status, &error.kind),
            "message": error.message,
        }
    }));
    if let Some(request_id) = request_id.filter(|value| !value.is_empty()) {
        payload.insert("request_id".into(), Value::String(request_id.to_owned()));
    }
    payload
}

pub fn anthropic_upstream_error_payload(
    status: u16,
    body: &[u8],
    request_id: Option<&str>,
) -> JsonObject {
    let error = ApiError::new(status, upstream_error_message(status, body))
        .with_kind(anthropic_error_type(status, ""));
    anthropic_error_payload(&error, request_id)
}

pub fn codex_event_error(event: &JsonObject) -> ApiError {
    let detail = event.get("error").and_then(Value::as_object);
    let source_type = string_field(detail, "type")
        .or_else(|| string_field(Some(event), "error_type"))
        .unwrap_or_default();
    let code = string_field(detail, "code")
        .or_else(|| string_field(Some(event), "code"))
        .unwrap_or_default();
    let message = string_field(detail, "message")
        .or_else(|| string_field(Some(event), "message"))
        .or_else(|| (!code.is_empty()).then_some(code))
        .unwrap_or("The Codex response stream failed.");
    let status = codex_error_status(source_type, code);
    let mut error =
        ApiError::new(status, message).with_kind(anthropic_error_type(status, source_type));
    if !code.is_empty() {
        error = error.with_code(code);
    }
    error
}

pub fn anthropic_error_type(status: u16, source_type: &str) -> String {
    if ANTHROPIC_ERROR_TYPES.contains(&source_type) {
        return source_type.to_owned();
    }
    match status {
        400 => "invalid_request_error",
        401 => "authentication_error",
        402 => "billing_error",
        403 => "permission_error",
        404 => "not_found_error",
        409 => "conflict_error",
        413 => "request_too_large",
        429 => "rate_limit_error",
        529 => "overloaded_error",
        _ => "api_error",
    }
    .to_owned()
}

pub fn upstream_error_message(status: u16, body: &[u8]) -> String {
    let fallback = || format!("The ChatGPT Codex backend returned HTTP {status}.");
    if body.is_empty() || body.len() > MAX_UPSTREAM_ERROR_BYTES {
        return fallback();
    }
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return fallback();
    };
    let Some(value) = value.as_object() else {
        return fallback();
    };
    let detail = value.get("error").and_then(Value::as_object);
    string_field(detail, "message")
        .or_else(|| string_field(Some(value), "message"))
        .map(str::to_owned)
        .unwrap_or_else(fallback)
}

fn codex_error_status(kind: &str, code: &str) -> u16 {
    let normalized = format!("{kind} {code}").to_lowercase();
    if normalized.contains("rate_limit") {
        429
    } else if normalized.contains("overload") {
        529
    } else if normalized.contains("invalid_request")
        || normalized.contains("context_length")
        || normalized.contains("cyber_policy")
    {
        400
    } else if normalized.contains("auth") {
        401
    } else if normalized.contains("permission") {
        403
    } else {
        502
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn converts_html_upstream_failures_to_safe_anthropic_errors() {
        assert_eq!(
            anthropic_upstream_error_payload(
                403,
                b"<html>managed challenge</html>",
                Some("request_upstream")
            ),
            into_object(json!({
                "type": "error",
                "error": {
                    "type": "permission_error",
                    "message": "The ChatGPT Codex backend returned HTTP 403."
                },
                "request_id": "request_upstream"
            }))
        );
    }

    #[test]
    fn maps_codex_error_codes_to_anthropic_statuses() {
        let event = into_object(json!({
            "type": "error",
            "error": {"code": "rate_limit_exceeded", "message": "slow down"}
        }));
        let error = codex_event_error(&event);
        assert_eq!(error.status, 429);
        assert_eq!(error.kind, "rate_limit_error");
        assert_eq!(error.code.as_deref(), Some("rate_limit_exceeded"));
    }
}
