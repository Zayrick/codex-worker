//! Runtime-neutral OpenAI compatibility protocol.
//!
//! This module owns JSON adaptation and stream state machines. It intentionally
//! contains no Cloudflare Worker types; transports only feed JSON/SSE bytes in
//! and write the returned JSON values or SSE frames out.

pub mod chat;
pub mod completions;
pub mod request_policy;
pub mod responses;
pub mod sse;

use crate::core::ApiError;

pub(crate) fn invalid_request(
    message: impl Into<String>,
    code: &'static str,
    param: Option<impl Into<String>>,
) -> ApiError {
    let error = ApiError::new(400, message)
        .with_kind("invalid_request_error")
        .with_code(code);
    match param {
        Some(param) => error.with_param(param),
        None => error,
    }
}

pub(crate) fn codex_stream_failed() -> ApiError {
    ApiError::new(502, "The Codex response stream failed.")
        .with_kind("upstream_error")
        .with_code("codex_stream_failed")
}
