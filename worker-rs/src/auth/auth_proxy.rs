use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::core::{ApiError, AppResult};

const MAX_ALLOWED_ACCOUNT_IDS: usize = 100;
const MAX_ACCOUNT_ID_LENGTH: usize = 256;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthProxySettings {
    pub enabled: bool,
    pub allowed_account_ids: Vec<String>,
}

impl AuthProxySettings {
    pub fn allows(&self, account_id: Option<&str>) -> bool {
        if !self.enabled {
            return false;
        }
        let Some(account_id) = account_id.map(str::trim).filter(|value| !value.is_empty()) else {
            return false;
        };
        self.allowed_account_ids
            .iter()
            .any(|allowed| allowed == account_id)
    }
}

pub fn validate_settings_input(value: &Value) -> AppResult<AuthProxySettings> {
    let settings: AuthProxySettings =
        serde_json::from_value(value.clone()).map_err(|_| invalid_auth_proxy_settings())?;
    validate_settings(settings, invalid_auth_proxy_settings)
}

pub(crate) fn validate_stored_settings(
    settings: AuthProxySettings,
) -> AppResult<AuthProxySettings> {
    validate_settings(settings, invalid_stored_auth_proxy_settings)
}

fn validate_settings(
    mut settings: AuthProxySettings,
    error: fn() -> ApiError,
) -> AppResult<AuthProxySettings> {
    if settings.allowed_account_ids.len() > MAX_ALLOWED_ACCOUNT_IDS {
        return Err(error());
    }

    let mut unique = HashSet::new();
    for account_id in &mut settings.allowed_account_ids {
        *account_id = account_id.trim().to_owned();
        if account_id.is_empty()
            || account_id.len() > MAX_ACCOUNT_ID_LENGTH
            || !account_id.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
            || !unique.insert(account_id.clone())
        {
            return Err(error());
        }
    }
    settings.allowed_account_ids.sort();
    Ok(settings)
}

fn invalid_auth_proxy_settings() -> ApiError {
    ApiError::new(
        400,
        "Credential proxy settings require an enabled state and up to 100 unique account IDs.",
    )
    .with_kind("invalid_request_error")
    .with_code("invalid_auth_proxy_settings")
}

fn invalid_stored_auth_proxy_settings() -> ApiError {
    ApiError::new(500, "Stored credential proxy settings are unavailable.")
        .with_kind("configuration_error")
        .with_code("invalid_stored_auth_proxy_settings")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn defaults_to_passthrough_and_allows_only_exact_configured_ids() {
        let disabled = AuthProxySettings::default();
        assert!(!disabled.allows(Some("account-one")));

        let enabled = validate_settings_input(&json!({
            "enabled": true,
            "allowedAccountIds": [" account-two ", "account-one"]
        }))
        .unwrap();
        assert_eq!(
            enabled.allowed_account_ids,
            vec!["account-one", "account-two"]
        );
        assert!(enabled.allows(Some("account-one")));
        assert!(!enabled.allows(Some("ACCOUNT-ONE")));
        assert!(!enabled.allows(None));
    }

    #[test]
    fn rejects_duplicate_invalid_and_oversized_account_lists() {
        assert!(
            validate_settings_input(&json!({
                "enabled": true,
                "allowedAccountIds": ["account-one", "account-one"]
            }))
            .is_err()
        );
        assert!(
            validate_settings_input(&json!({
                "enabled": true,
                "allowedAccountIds": ["line\nbreak"]
            }))
            .is_err()
        );
        assert!(
            validate_settings_input(&json!({
                "enabled": true,
                "allowedAccountIds": (0..=MAX_ALLOWED_ACCOUNT_IDS)
                    .map(|index| format!("account-{index}"))
                    .collect::<Vec<_>>()
            }))
            .is_err()
        );
    }
}
