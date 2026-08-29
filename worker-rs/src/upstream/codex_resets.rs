use serde::Deserialize;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::core::{ApiError, AppResult};

pub const CODEX_RESETS_STATUS_URL: &str = "https://codex-resets.com/api/v1/status";
pub const CODEX_RESETS_REQUEST_TIMEOUT_MS: u64 = 10_000;
pub const CODEX_RESETS_MAX_RESPONSE_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexResetStatus {
    pub active_watch: Option<CodexResetWatch>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexResetWatch {
    pub reset_chance_percent: u8,
    pub observed_at_ms: i64,
    pub expires_at: OffsetDateTime,
    pub text: String,
    pub source_url: String,
}

#[derive(Deserialize)]
struct StatusResponse {
    data: StatusData,
}

#[derive(Deserialize)]
struct StatusData {
    active_watch: Option<WatchResponse>,
}

#[derive(Deserialize)]
struct WatchResponse {
    reset_chance_percent: u8,
    observed_at: String,
    expires_at: String,
    text: String,
    source: SourceResponse,
}

#[derive(Deserialize)]
struct SourceResponse {
    url: String,
}

pub fn parse_codex_reset_status(body: &[u8]) -> AppResult<CodexResetStatus> {
    let response =
        serde_json::from_slice::<StatusResponse>(body).map_err(|_| codex_resets_unavailable())?;
    let active_watch = response.data.active_watch.map(parse_watch).transpose()?;
    Ok(CodexResetStatus { active_watch })
}

fn parse_watch(watch: WatchResponse) -> AppResult<CodexResetWatch> {
    let observed_at = parse_timestamp(&watch.observed_at)?;
    let observed_at_ms = i64::try_from(observed_at.unix_timestamp_nanos() / 1_000_000)
        .map_err(|_| codex_resets_unavailable())?;
    let expires_at = parse_timestamp(&watch.expires_at)?;

    Ok(CodexResetWatch {
        reset_chance_percent: watch.reset_chance_percent,
        observed_at_ms,
        expires_at,
        text: watch.text,
        source_url: watch.source.url,
    })
}

fn parse_timestamp(value: &str) -> AppResult<OffsetDateTime> {
    OffsetDateTime::parse(value, &Rfc3339).map_err(|_| codex_resets_unavailable())
}

pub fn codex_resets_unavailable() -> ApiError {
    ApiError::new(502, "The Codex reset forecast is unavailable.")
        .with_kind("upstream_error")
        .with_code("codex_resets_unavailable")
}
