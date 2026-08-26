use crate::{
    application::{CodexUsageMonitorState, validate_codex_usage_monitor_state},
    auth::{SecretStore, open_json, seal_json},
    core::{ApiError, AppResult},
};

const CODEX_USAGE_KV_KEY: &str = "CODEX_USAGE";
const CODEX_USAGE_ENVELOPE_PURPOSE: &str = "codex-worker/codex-usage/v1";
const MAX_CODEX_USAGE_ENVELOPE_CHARS: usize = 256 * 1_024;

pub struct CodexUsageStateRepository<'a> {
    store: &'a dyn SecretStore,
    master_key: &'a str,
}

impl<'a> CodexUsageStateRepository<'a> {
    pub fn new(store: &'a dyn SecretStore, master_key: &'a str) -> Self {
        Self { store, master_key }
    }

    pub async fn read(&self) -> AppResult<Option<CodexUsageMonitorState>> {
        let Some(encrypted) = self.store.get(CODEX_USAGE_KV_KEY, None).await? else {
            return Ok(None);
        };
        if encrypted.len() > MAX_CODEX_USAGE_ENVELOPE_CHARS {
            return Err(invalid_stored_usage_state());
        }
        let value = open_json(&encrypted, self.master_key, CODEX_USAGE_ENVELOPE_PURPOSE)
            .map_err(|_| invalid_stored_usage_state())?;
        validate_codex_usage_monitor_state(value).map(Some)
    }

    pub async fn store(&self, state: &CodexUsageMonitorState) -> AppResult<()> {
        let value = serde_json::to_value(state).map_err(|_| invalid_stored_usage_state())?;
        let encrypted = seal_json(&value, self.master_key, CODEX_USAGE_ENVELOPE_PURPOSE)
            .map_err(|_| invalid_stored_usage_state())?;
        if encrypted.len() > MAX_CODEX_USAGE_ENVELOPE_CHARS {
            return Err(invalid_stored_usage_state());
        }
        self.store.put(CODEX_USAGE_KV_KEY, &encrypted).await
    }
}

fn invalid_stored_usage_state() -> ApiError {
    ApiError::new(500, "Stored Codex usage state is unavailable.")
        .with_kind("configuration_error")
        .with_code("invalid_codex_usage_state")
}
