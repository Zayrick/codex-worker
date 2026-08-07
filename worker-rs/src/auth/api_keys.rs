use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use subtle::ConstantTimeEq;

use crate::core::{ApiError, AppResult};

use super::{SecretStore, open_json, seal_json, sha256};

const API_KEYS_KV_KEY: &str = "API_KEYS";
const API_KEYS_ENVELOPE_PURPOSE: &str = "codex-worker/api-keys/v1";
const MAX_API_KEYS_ENVELOPE_CHARS: usize = 128 * 1_024;
const MAX_API_KEYS: usize = 100;
const MAX_API_KEY_NAME_LENGTH: usize = 100;
const MIN_API_KEY_LENGTH: usize = 11;
const MAX_API_KEY_LENGTH: usize = 512;
const DUMMY_API_KEY: &str = "sk-aaaaaaaaaaaaaaaaaaa0";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientApiKey {
    pub name: String,
    pub key: String,
    pub enabled: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct StoredApiKeys {
    version: u8,
    keys: Vec<ClientApiKey>,
}

pub struct ApiKeyRepository<'a> {
    store: &'a dyn SecretStore,
    master_key: &'a str,
}

impl<'a> ApiKeyRepository<'a> {
    pub fn new(store: &'a dyn SecretStore, master_key: &'a str) -> Self {
        Self { store, master_key }
    }

    pub async fn read(&self) -> AppResult<Vec<ClientApiKey>> {
        let Some(encrypted) = self.store.get(API_KEYS_KV_KEY, Some(30)).await? else {
            return Ok(Vec::new());
        };
        if encrypted.len() > MAX_API_KEYS_ENVELOPE_CHARS {
            return Err(invalid_stored_api_keys());
        }
        let value = open_json(&encrypted, self.master_key, API_KEYS_ENVELOPE_PURPOSE)
            .map_err(|_| invalid_stored_api_keys())?;
        validate_stored_api_keys(value)
    }

    pub async fn store(&self, keys: &[ClientApiKey]) -> AppResult<Vec<ClientApiKey>> {
        let validated = validate_api_key_collection(keys.iter().cloned(), invalid_stored_api_keys)?;
        let value = serde_json::to_value(StoredApiKeys {
            version: 1,
            keys: validated.clone(),
        })
        .map_err(|_| invalid_stored_api_keys())?;
        let encrypted = seal_json(&value, self.master_key, API_KEYS_ENVELOPE_PURPOSE)
            .map_err(|_| invalid_stored_api_keys())?;
        self.store.put(API_KEYS_KV_KEY, &encrypted).await?;
        Ok(validated)
    }

    pub async fn authenticate(&self, token: Option<&str>) -> AppResult<()> {
        let configured = self.read().await?;
        authenticate_token(token, &configured)
    }

    pub async fn create(&self, value: &Value) -> AppResult<Vec<ClientApiKey>> {
        let candidate = validate_api_key_input(value)?;
        let current = self.read().await?;
        require_available_api_key(&current, &candidate)?;
        let mut updated = current;
        updated.push(candidate);
        self.store(&updated).await
    }

    pub async fn update(
        &self,
        original_name: &Value,
        value: &Value,
    ) -> AppResult<Vec<ClientApiKey>> {
        let target_name = validate_api_key_name(original_name.as_str())?;
        let candidate = validate_api_key_input(value)?;
        let mut current = self.read().await?;
        let index = current
            .iter()
            .position(|entry| entry.name == target_name)
            .ok_or_else(api_key_not_found)?;
        let others: Vec<_> = current
            .iter()
            .enumerate()
            .filter(|(entry_index, _)| *entry_index != index)
            .map(|(_, entry)| entry.clone())
            .collect();
        require_available_api_key(&others, &candidate)?;
        current[index] = candidate;
        self.store(&current).await
    }

    pub async fn delete(&self, name: &Value) -> AppResult<Vec<ClientApiKey>> {
        let target_name = validate_api_key_name(name.as_str())?;
        let current = self.read().await?;
        let updated: Vec<_> = current
            .iter()
            .filter(|entry| entry.name != target_name)
            .cloned()
            .collect();
        if updated.len() == current.len() {
            return Err(api_key_not_found());
        }
        self.store(&updated).await
    }
}

pub fn authenticate_token(token: Option<&str>, configured: &[ClientApiKey]) -> AppResult<()> {
    let Some(token) = token.filter(|token| utf16_len(token) <= MAX_API_KEY_LENGTH) else {
        return Err(invalid_api_key());
    };
    let candidates: Vec<_> = configured.iter().filter(|entry| entry.enabled).collect();
    let token_digest = sha256(token);
    let mut matched = false;
    if candidates.is_empty() {
        let _ = token_digest.ct_eq(&sha256(DUMMY_API_KEY));
    } else {
        for candidate in candidates {
            matched |= bool::from(token_digest.ct_eq(&sha256(&candidate.key)));
        }
    }
    if matched {
        Ok(())
    } else {
        Err(invalid_api_key())
    }
}

/// Select a client credential with the same precedence as the public API.
pub fn client_token<'a>(
    authorization: Option<&'a str>,
    api_key: Option<&'a str>,
    google_api_key: Option<&'a str>,
) -> Option<String> {
    bearer_token(authorization)
        .map(str::to_owned)
        .or_else(|| {
            api_key
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        })
        .or_else(|| {
            google_api_key
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        })
}

pub fn validate_api_key_input(value: &Value) -> AppResult<ClientApiKey> {
    let object = value.as_object().ok_or_else(invalid_api_key_record)?;
    let name = validate_api_key_name(object.get("name").and_then(Value::as_str))?;
    let key = object
        .get("key")
        .and_then(Value::as_str)
        .filter(|key| {
            let len = utf16_len(key);
            (MIN_API_KEY_LENGTH..=MAX_API_KEY_LENGTH).contains(&len)
                && key.bytes().any(|byte| byte.is_ascii_alphabetic())
                && key.bytes().any(|byte| byte.is_ascii_digit())
                && key.chars().any(|character| {
                    !character.is_ascii_alphanumeric() && !character.is_whitespace()
                })
        })
        .ok_or_else(invalid_api_key_record)?;
    let enabled = object
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(invalid_api_key_record)?;
    Ok(ClientApiKey {
        name,
        key: key.to_owned(),
        enabled,
    })
}

fn validate_stored_api_keys(value: Value) -> AppResult<Vec<ClientApiKey>> {
    let stored: StoredApiKeys =
        serde_json::from_value(value).map_err(|_| invalid_stored_api_keys())?;
    if stored.version != 1 {
        return Err(invalid_stored_api_keys());
    }
    validate_api_key_collection(stored.keys, invalid_stored_api_keys)
}

fn validate_api_key_collection(
    values: impl IntoIterator<Item = ClientApiKey>,
    error: fn() -> ApiError,
) -> AppResult<Vec<ClientApiKey>> {
    let values: Vec<_> = values.into_iter().collect();
    if values.len() > MAX_API_KEYS {
        return Err(error());
    }
    let mut names = HashSet::new();
    let mut keys = HashSet::new();
    let mut validated = Vec::with_capacity(values.len());
    for value in values {
        let normalized = validate_api_key_input(&serde_json::to_value(value).map_err(|_| error())?)
            .map_err(|_| error())?;
        if !names.insert(normalized.name.clone()) || !keys.insert(normalized.key.clone()) {
            return Err(error());
        }
        validated.push(normalized);
    }
    validated.sort_by(|left, right| left.name.encode_utf16().cmp(right.name.encode_utf16()));
    Ok(validated)
}

fn validate_api_key_name(value: Option<&str>) -> AppResult<String> {
    let name = value.map(str::trim).ok_or_else(invalid_api_key_record)?;
    if name.is_empty()
        || utf16_len(name) > MAX_API_KEY_NAME_LENGTH
        || name
            .chars()
            .any(|character| matches!(character as u32, 0x00..=0x1f | 0x7f))
    {
        return Err(invalid_api_key_record());
    }
    Ok(name.to_owned())
}

fn require_available_api_key(current: &[ClientApiKey], candidate: &ClientApiKey) -> AppResult<()> {
    if current.iter().any(|entry| entry.name == candidate.name) {
        return Err(api_key_conflict(
            "An API key with that name already exists.",
        ));
    }
    if current.iter().any(|entry| entry.key == candidate.key) {
        return Err(api_key_conflict(
            "That API key value is already configured.",
        ));
    }
    if current.len() >= MAX_API_KEYS {
        return Err(api_key_conflict("The API key limit has been reached."));
    }
    Ok(())
}

fn bearer_token(authorization: Option<&str>) -> Option<&str> {
    let authorization = authorization?;
    if authorization.starts_with(char::is_whitespace) {
        return None;
    }
    let mut fields = authorization.split_whitespace();
    let scheme = fields.next()?;
    let token = fields.next()?;
    (scheme.eq_ignore_ascii_case("bearer") && fields.next().is_none()).then_some(token)
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn invalid_api_key() -> ApiError {
    ApiError::new(401, "Invalid API key.")
        .with_kind("authentication_error")
        .with_code("invalid_api_key")
}

fn invalid_api_key_record() -> ApiError {
    ApiError::new(400, "API keys require a unique name, 11 to 512 characters with at least one letter, number, and non-whitespace symbol, and an enabled state.")
        .with_kind("invalid_request_error")
        .with_code("invalid_api_key_record")
}

fn api_key_conflict(message: &str) -> ApiError {
    ApiError::new(409, message)
        .with_kind("invalid_request_error")
        .with_code("api_key_conflict")
}

fn api_key_not_found() -> ApiError {
    ApiError::new(404, "The requested API key does not exist.")
        .with_kind("invalid_request_error")
        .with_code("api_key_not_found")
}

fn invalid_stored_api_keys() -> ApiError {
    ApiError::new(500, "Stored API keys are unavailable.")
        .with_kind("configuration_error")
        .with_code("invalid_stored_api_keys")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn key(name: &str, key: &str, enabled: bool) -> ClientApiKey {
        ClientApiKey {
            name: name.into(),
            key: key.into(),
            enabled,
        }
    }

    #[test]
    fn validates_flexible_keys_and_the_exact_minimum_length() {
        let minimum =
            validate_api_key_input(&json!({"name":" minimum ","key":"A1!aaaaaaaa","enabled":true}))
                .unwrap();
        assert_eq!(minimum.name, "minimum");
        assert!(
            validate_api_key_input(&json!({"name":"bad","key":"A1!aaaaaaa","enabled":true}))
                .is_err()
        );
        assert!(
            validate_api_key_input(&json!({
                "name":"flexible",
                "key":format!("Legacy_{}9!", "f".repeat(55)),
                "enabled":true
            }))
            .is_ok()
        );
    }

    #[test]
    fn accepts_only_enabled_keys_and_executes_a_dummy_comparison() {
        let keys = vec![
            key("disabled", "sk-bbbbbbbbbbbbbbbbbbb1", false),
            key("enabled", "sk-ccccccccccccccccccc2", true),
        ];
        assert!(authenticate_token(Some("sk-ccccccccccccccccccc2"), &keys).is_ok());
        assert!(authenticate_token(Some("sk-bbbbbbbbbbbbbbbbbbb1"), &keys).is_err());
        assert!(authenticate_token(Some("wrong"), &[]).is_err());
    }

    #[test]
    fn preserves_header_precedence() {
        assert_eq!(
            client_token(Some("Bearer wrong"), Some("right"), Some("google")).as_deref(),
            Some("wrong")
        );
        assert_eq!(
            client_token(None, Some(" right "), Some("google")).as_deref(),
            Some("right")
        );
        assert_eq!(
            client_token(Some("Basic value"), None, Some(" google ")).as_deref(),
            Some("google")
        );
    }
}
