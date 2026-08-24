use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::core::{ApiError, AppResult};

pub(crate) const MAX_AUTH_PROXY_ACCOUNTS: usize = 100;
const MAX_AUTH_PROXY_NAME_LENGTH: usize = 100;
const MAX_ACCOUNT_ID_LENGTH: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthProxyAccount {
    pub name: String,
    pub account_id: String,
    pub enabled: bool,
}

pub fn replacement_allowed(account_id: Option<&str>, configured: &[AuthProxyAccount]) -> bool {
    let Some(account_id) = account_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return false;
    };
    configured
        .iter()
        .any(|entry| entry.enabled && entry.account_id == account_id)
}

pub fn validate_auth_proxy_account_input(value: &Value) -> AppResult<AuthProxyAccount> {
    let object = value.as_object().ok_or_else(invalid_auth_proxy_account)?;
    let name = validate_auth_proxy_account_name(object.get("name").and_then(Value::as_str))?;
    let account_id = object
        .get("accountId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= MAX_ACCOUNT_ID_LENGTH
                && value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
        })
        .ok_or_else(invalid_auth_proxy_account)?;
    let enabled = object
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(invalid_auth_proxy_account)?;
    Ok(AuthProxyAccount {
        name,
        account_id: account_id.to_owned(),
        enabled,
    })
}

pub(crate) fn validate_auth_proxy_account_name(value: Option<&str>) -> AppResult<String> {
    let name = value
        .map(str::trim)
        .ok_or_else(invalid_auth_proxy_account)?;
    if name.is_empty()
        || name.encode_utf16().count() > MAX_AUTH_PROXY_NAME_LENGTH
        || name
            .chars()
            .any(|character| matches!(character as u32, 0x00..=0x1f | 0x7f))
    {
        return Err(invalid_auth_proxy_account());
    }
    Ok(name.to_owned())
}

pub(crate) fn validate_stored_auth_proxy_accounts(
    values: impl IntoIterator<Item = AuthProxyAccount>,
) -> AppResult<Vec<AuthProxyAccount>> {
    validate_auth_proxy_account_collection(values, invalid_stored_auth_proxy_accounts)
}

fn validate_auth_proxy_account_collection(
    values: impl IntoIterator<Item = AuthProxyAccount>,
    error: fn() -> ApiError,
) -> AppResult<Vec<AuthProxyAccount>> {
    let values: Vec<_> = values.into_iter().collect();
    if values.len() > MAX_AUTH_PROXY_ACCOUNTS {
        return Err(error());
    }
    let mut names = HashSet::new();
    let mut account_ids = HashSet::new();
    let mut validated = Vec::with_capacity(values.len());
    for value in values {
        let normalized =
            validate_auth_proxy_account_input(&serde_json::to_value(value).map_err(|_| error())?)
                .map_err(|_| error())?;
        if !names.insert(normalized.name.clone())
            || !account_ids.insert(normalized.account_id.clone())
        {
            return Err(error());
        }
        validated.push(normalized);
    }
    validated.sort_by(|left, right| left.name.encode_utf16().cmp(right.name.encode_utf16()));
    Ok(validated)
}

pub(crate) fn auth_proxy_account_conflict(message: &str) -> ApiError {
    ApiError::new(409, message)
        .with_kind("invalid_request_error")
        .with_code("auth_proxy_account_conflict")
}

pub(crate) fn auth_proxy_account_not_found() -> ApiError {
    ApiError::new(
        404,
        "The requested credential proxy account does not exist.",
    )
    .with_kind("invalid_request_error")
    .with_code("auth_proxy_account_not_found")
}

fn invalid_auth_proxy_account() -> ApiError {
    ApiError::new(
        400,
        "Credential proxy accounts require a unique name, a unique account ID, and an enabled state.",
    )
    .with_kind("invalid_request_error")
    .with_code("invalid_auth_proxy_account")
}

fn invalid_stored_auth_proxy_accounts() -> ApiError {
    ApiError::new(500, "Stored credential proxy accounts are unavailable.")
        .with_kind("configuration_error")
        .with_code("invalid_stored_auth_proxy_accounts")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn allows_only_exact_enabled_account_ids() {
        let accounts = vec![
            AuthProxyAccount {
                name: "disabled".into(),
                account_id: "account-one".into(),
                enabled: false,
            },
            AuthProxyAccount {
                name: "enabled".into(),
                account_id: "account-two".into(),
                enabled: true,
            },
        ];
        assert!(!replacement_allowed(Some("account-one"), &accounts));
        assert!(replacement_allowed(Some(" account-two "), &accounts));
        assert!(!replacement_allowed(Some("ACCOUNT-TWO"), &accounts));
        assert!(!replacement_allowed(None, &accounts));
    }

    #[test]
    fn normalizes_and_validates_account_records() {
        let account = validate_auth_proxy_account_input(&json!({
            "name": " browser ",
            "accountId": " account-two ",
            "enabled": true
        }))
        .unwrap();
        assert_eq!(account.name, "browser");
        assert_eq!(account.account_id, "account-two");
        assert!(
            validate_auth_proxy_account_input(&json!({
                "name": "bad",
                "accountId": "line\nbreak",
                "enabled": true
            }))
            .is_err()
        );
    }

    #[test]
    fn rejects_duplicate_names_ids_and_oversized_collections() {
        let account = |name: &str, account_id: &str| AuthProxyAccount {
            name: name.into(),
            account_id: account_id.into(),
            enabled: true,
        };
        assert!(
            validate_stored_auth_proxy_accounts(vec![
                account("same", "account-one"),
                account("same", "account-two"),
            ])
            .is_err()
        );
        assert!(
            validate_stored_auth_proxy_accounts(vec![
                account("one", "same"),
                account("two", "same"),
            ])
            .is_err()
        );
        assert!(
            validate_stored_auth_proxy_accounts(
                (0..=MAX_AUTH_PROXY_ACCOUNTS)
                    .map(|index| account(&format!("name-{index}"), &format!("account-{index}")))
            )
            .is_err()
        );
    }
}
