use worker::{
    AbortSignal, CacheMode, Fetch, Headers, Method, Request, RequestInit, RequestRedirect,
};

use crate::{
    core::AppResult,
    upstream::codex_resets::{
        CODEX_RESETS_MAX_RESPONSE_BYTES, CODEX_RESETS_REQUEST_TIMEOUT_MS, CODEX_RESETS_STATUS_URL,
        CodexResetStatus, codex_resets_unavailable, parse_codex_reset_status,
    },
};

use super::body::read_limited_response;

pub struct CodexResetsClient;

impl CodexResetsClient {
    pub async fn fetch_status() -> AppResult<CodexResetStatus> {
        let headers = Headers::new();
        headers
            .set("accept", "application/json")
            .map_err(|_| codex_resets_unavailable())?;
        let mut init = RequestInit::new();
        init.with_method(Method::Get)
            .with_headers(headers)
            .with_redirect(RequestRedirect::Manual)
            .with_cache(CacheMode::NoStore);
        let outgoing = Request::new_with_init(CODEX_RESETS_STATUS_URL, &init)
            .map_err(|_| codex_resets_unavailable())?;
        let timeout =
            worker::web_sys::AbortSignal::timeout_with_f64(CODEX_RESETS_REQUEST_TIMEOUT_MS as f64);
        let signal = AbortSignal::from(timeout);
        let mut response = Fetch::Request(outgoing)
            .send_with_signal(&signal)
            .await
            .map_err(|_| codex_resets_unavailable())?;
        let status = response.status_code();
        let body = read_limited_response(&mut response, CODEX_RESETS_MAX_RESPONSE_BYTES)
            .await
            .map_err(|_| codex_resets_unavailable())?;
        if !(200..300).contains(&status) {
            return Err(codex_resets_unavailable());
        }
        parse_codex_reset_status(&body)
    }
}
