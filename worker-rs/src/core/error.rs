use serde_json::{Value, json};
use thiserror::Error;

use super::JsonObject;

pub type AppResult<T> = Result<T, ApiError>;

/// Provider-neutral error used by the application core.
///
/// Transports and protocol adapters decide how this value is presented on the
/// wire, keeping provider envelopes out of business logic.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{message}")]
pub struct ApiError {
    pub status: u16,
    pub message: String,
    pub kind: String,
    pub code: Option<String>,
    pub param: Option<String>,
}

impl ApiError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
            kind: "api_error".into(),
            code: None,
            param: None,
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(400, message)
            .with_kind("invalid_request_error")
            .with_code("invalid_request")
    }

    pub fn with_kind(mut self, kind: impl Into<String>) -> Self {
        self.kind = kind.into();
        self
    }

    pub fn with_code(mut self, code: impl Into<String>) -> Self {
        self.code = Some(code.into());
        self
    }

    pub fn with_param(mut self, param: impl Into<String>) -> Self {
        self.param = Some(param.into());
        self
    }

    pub fn openai_payload(&self) -> Value {
        json!({
            "error": {
                "message": self.message,
                "type": self.kind,
                "param": self.param,
                "code": self.code,
            }
        })
    }

    pub fn require_object(value: Value, label: &str) -> AppResult<JsonObject> {
        value.as_object().cloned().ok_or_else(|| {
            Self::new(400, format!("The {label} must be a JSON object."))
                .with_kind("invalid_request_error")
                .with_code("invalid_json")
        })
    }

    pub fn require_string<'a>(
        value: Option<&'a Value>,
        param: &str,
        message: Option<&str>,
    ) -> AppResult<&'a str> {
        value
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                Self::new(
                    400,
                    message
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("Missing required parameter: '{param}'.")),
                )
                .with_kind("invalid_request_error")
                .with_code("missing_required_parameter")
                .with_param(param)
            })
    }
}
