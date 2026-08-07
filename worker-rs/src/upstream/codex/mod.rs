//! Runtime-neutral policy for the ChatGPT Codex upstream.
//!
//! Transports own HTTP, body limits, cancellation, and WebSockets. This module
//! accepts plain DTOs and returns normalized JSON, URLs, headers, and routing
//! decisions that can be tested on a host target.

mod headers;
mod models;
mod subscription;
mod url_policy;

pub use headers::{
    CodexCredentials, HeaderBag, codex_headers, is_websocket_upgrade, proxy_request_headers,
    usage_headers,
};
pub use models::{MAX_MODEL_CATALOG_BYTES, to_openai_model_list};
pub use subscription::{
    CODEX_USAGE_PATH, CODEX_USAGE_REQUEST_TIMEOUT_MS, CodexQuotaCategory, CodexQuotaWindow,
    CodexQuotaWindowKind, CodexRateLimitResetCredits, CodexSubscriptionInfo,
    CodexSubscriptionMetadata, MAX_CODEX_USAGE_RESPONSE_BYTES, codex_subscription_from_usage,
    codex_subscription_metadata, codex_usage_unavailable, codex_usage_upstream_error,
    invalid_codex_usage_response,
};
pub use url_policy::{
    CODEX_MODELS_PATH, CODEX_RESPONSES_PATH, DEFAULT_CODEX_CLIENT_VERSION, is_codex_native_target,
    is_codex_proxy_path, is_codex_proxy_request_allowed, is_live_proxy_path,
    is_realtime_proxy_path, is_realtime_sideband_path, proxy_path, resolve_chatgpt_relay_url,
    resolve_codex_proxy_url, resolve_models_url, responses_url, usage_url,
};

#[cfg(test)]
mod tests;
