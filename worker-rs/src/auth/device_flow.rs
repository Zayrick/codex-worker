//! Encrypted device-authorization session orchestration.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::core::{ApiError, AppResult};

use super::{
    StoredOAuthCredentials, credentials_from_token_response,
    oauth_ports::{OAuthClock, OAuthCredentialsStore},
    oauth_provider::{DEVICE_VERIFICATION_URL, OAuthProvider, ProviderDevicePollResult},
    open_json, seal_json,
};

const DEVICE_STATE_PURPOSE: &str = "codex-worker/device-state/v1";
pub const DEVICE_LIFETIME_MS: i64 = 15 * 60 * 1_000;
pub const DEFAULT_POLL_INTERVAL_SECONDS: u64 = 5;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAuthorization {
    pub verification_uri: String,
    pub user_code: String,
    pub expires_in: u64,
    pub interval: u64,
    pub state: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DevicePollResult {
    Pending { retry_after: u64 },
    Stored { credentials: StoredOAuthCredentials },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceState {
    version: u8,
    device_auth_id: String,
    user_code: String,
    expires_at: i64,
    interval: u64,
}

pub struct DeviceAuthorizationService<'a> {
    credentials: &'a dyn OAuthCredentialsStore,
    provider: &'a OAuthProvider<'a>,
    clock: &'a dyn OAuthClock,
    master_key: &'a str,
}

impl<'a> DeviceAuthorizationService<'a> {
    pub fn new(
        credentials: &'a dyn OAuthCredentialsStore,
        provider: &'a OAuthProvider<'a>,
        clock: &'a dyn OAuthClock,
        master_key: &'a str,
    ) -> Self {
        Self {
            credentials,
            provider,
            clock,
            master_key,
        }
    }

    pub async fn start(&self) -> AppResult<DeviceAuthorization> {
        self.credentials.require_unconfigured().await?;
        let authorization = self.provider.request_device_authorization().await?;
        let interval = poll_interval(authorization.interval.as_ref());
        let expires_at = self.clock.now_ms().await.saturating_add(DEVICE_LIFETIME_MS);
        let state = DeviceState {
            version: 1,
            device_auth_id: authorization.device_auth_id,
            user_code: authorization.user_code.clone(),
            expires_at,
            interval,
        };
        let state = serde_json::to_value(state)
            .ok()
            .and_then(|value| seal_json(&value, self.master_key, DEVICE_STATE_PURPOSE).ok())
            .ok_or_else(device_session_unavailable)?;

        Ok(DeviceAuthorization {
            verification_uri: DEVICE_VERIFICATION_URL.into(),
            user_code: authorization.user_code,
            expires_in: (DEVICE_LIFETIME_MS / 1_000) as u64,
            interval,
            state,
        })
    }

    pub async fn poll(&self, sealed_state: &str) -> AppResult<DevicePollResult> {
        self.credentials.require_unconfigured().await?;
        let state = device_state(sealed_state, self.master_key)?;
        if state.expires_at <= self.clock.now_ms().await {
            return Err(
                ApiError::new(410, "The device authorization session has expired.")
                    .with_kind("invalid_request_error")
                    .with_code("device_session_expired"),
            );
        }

        match self
            .provider
            .poll_device_authorization_token(&state.device_auth_id, &state.user_code)
            .await?
        {
            ProviderDevicePollResult::Pending => Ok(DevicePollResult::Pending {
                retry_after: state.interval,
            }),
            ProviderDevicePollResult::Authorized { token_payload } => {
                let credentials = credentials_from_token_response(
                    &token_payload,
                    None,
                    self.clock.now_ms().await,
                )?;
                self.credentials.require_unconfigured().await?;
                self.credentials.store(&credentials).await?;
                Ok(DevicePollResult::Stored { credentials })
            }
        }
    }
}

fn device_state(sealed_state: &str, master_key: &str) -> AppResult<DeviceState> {
    let value = open_json(sealed_state, master_key, DEVICE_STATE_PURPOSE)
        .map_err(|_| invalid_device_state())?;
    let state: DeviceState = serde_json::from_value(value).map_err(|_| invalid_device_state())?;
    if state.version != 1
        || state.device_auth_id.is_empty()
        || state.user_code.is_empty()
        || state.interval < 1
    {
        return Err(invalid_device_state());
    }
    Ok(state)
}

fn poll_interval(value: Option<&Value>) -> u64 {
    let parsed = match value {
        Some(Value::Number(value)) => value
            .as_f64()
            .filter(|value| value.is_finite() && value.fract() == 0.0)
            .and_then(|value| u64::try_from(value as i128).ok()),
        Some(Value::String(value)) => parse_decimal_prefix(value),
        _ => None,
    };
    parsed
        .filter(|value| (1..=60).contains(value))
        .unwrap_or(DEFAULT_POLL_INTERVAL_SECONDS)
}

fn parse_decimal_prefix(value: &str) -> Option<u64> {
    let value = value.trim_start();
    let (negative, value) = match value.as_bytes().first() {
        Some(b'+') => (false, &value[1..]),
        Some(b'-') => (true, &value[1..]),
        _ => (false, value),
    };
    if negative {
        return None;
    }
    let digits = value.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    value[..digits].parse().ok()
}

fn device_session_unavailable() -> ApiError {
    ApiError::new(500, "Unable to create a device authorization session.")
        .with_kind("configuration_error")
        .with_code("device_session_unavailable")
}

fn invalid_device_state() -> ApiError {
    ApiError::new(400, "The device authorization session is invalid.")
        .with_kind("invalid_request_error")
        .with_code("invalid_device_session")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn matches_javascript_poll_interval_parsing() {
        assert_eq!(poll_interval(Some(&json!(1))), 1);
        assert_eq!(poll_interval(Some(&json!("  +12seconds"))), 12);
        assert_eq!(poll_interval(Some(&json!(1.5))), 5);
        assert_eq!(poll_interval(Some(&json!("61"))), 5);
        assert_eq!(poll_interval(None), 5);
    }
}
