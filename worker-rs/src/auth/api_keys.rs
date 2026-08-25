use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use subtle::ConstantTimeEq;

use crate::core::{ApiError, AppResult};

use super::{
    AuthProxyAccount, SecretStore,
    auth_proxy::{
        MAX_AUTH_PROXY_ACCOUNTS, auth_proxy_account_conflict, auth_proxy_account_not_found,
        validate_auth_proxy_account_input, validate_auth_proxy_account_with_id,
        validate_stored_auth_proxy_accounts,
    },
    derived_record_id, new_record_id, open_json, seal_json, sha256, valid_record_id,
};

const API_KEYS_KV_KEY: &str = "API_KEYS";
const API_KEYS_ENVELOPE_PURPOSE: &str = "codex-worker/api-keys/v1";
const CURRENT_API_KEYS_VERSION: u8 = 2;
const IDLESS_API_KEYS_VERSION: u8 = 1;
const MAX_API_KEYS_ENVELOPE_CHARS: usize = 128 * 1_024;
const MAX_API_KEYS: usize = 100;
const MAX_API_KEY_NAME_LENGTH: usize = 100;
const MIN_API_KEY_LENGTH: usize = 11;
const MAX_API_KEY_LENGTH: usize = 512;
const DUMMY_API_KEY: &str = "sk-aaaaaaaaaaaaaaaaaaa0";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientApiKey {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub key: String,
    pub enabled: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct StoredApiKeys {
    version: u8,
    keys: Vec<ClientApiKey>,
    #[serde(default, rename = "authProxyAccounts")]
    auth_proxy_accounts: Vec<AuthProxyAccount>,
}

#[derive(Debug, Default)]
struct ApiKeyState {
    keys: Vec<ClientApiKey>,
    auth_proxy_accounts: Vec<AuthProxyAccount>,
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
        Ok(self.read_state(Some(30), false).await?.keys)
    }

    pub async fn read_auth_proxy_accounts(&self) -> AppResult<Vec<AuthProxyAccount>> {
        Ok(self.read_state(None, true).await?.auth_proxy_accounts)
    }

    async fn read_state(
        &self,
        cache_ttl: Option<u64>,
        persist_upgrade: bool,
    ) -> AppResult<ApiKeyState> {
        let Some(encrypted) = self.store.get(API_KEYS_KV_KEY, cache_ttl).await? else {
            return Ok(ApiKeyState::default());
        };
        if encrypted.len() > MAX_API_KEYS_ENVELOPE_CHARS {
            return Err(invalid_stored_api_keys());
        }
        let value = open_json(&encrypted, self.master_key, API_KEYS_ENVELOPE_PURPOSE)
            .map_err(|_| invalid_stored_api_keys())?;
        let (state, needs_upgrade) = validate_stored_api_keys(value, self.master_key)?;
        if needs_upgrade && persist_upgrade {
            self.write_state(&state).await?;
        }
        Ok(state)
    }

    pub async fn store(&self, keys: &[ClientApiKey]) -> AppResult<Vec<ClientApiKey>> {
        let auth_proxy_accounts = self.read_auth_proxy_accounts().await?;
        Ok(self.store_state(keys, auth_proxy_accounts).await?.keys)
    }

    async fn store_state(
        &self,
        keys: &[ClientApiKey],
        auth_proxy_accounts: Vec<AuthProxyAccount>,
    ) -> AppResult<ApiKeyState> {
        let validated = validate_api_key_collection(
            keys.iter().cloned(),
            self.master_key,
            false,
            invalid_stored_api_keys,
        )?
        .0;
        let auth_proxy_accounts =
            validate_stored_auth_proxy_accounts(auth_proxy_accounts, self.master_key)?.0;
        let state = ApiKeyState {
            keys: validated,
            auth_proxy_accounts,
        };
        self.write_state(&state).await?;
        Ok(state)
    }

    async fn write_state(&self, state: &ApiKeyState) -> AppResult<()> {
        let value = serde_json::to_value(StoredApiKeys {
            version: CURRENT_API_KEYS_VERSION,
            keys: state.keys.clone(),
            auth_proxy_accounts: state.auth_proxy_accounts.clone(),
        })
        .map_err(|_| invalid_stored_api_keys())?;
        let encrypted = seal_json(&value, self.master_key, API_KEYS_ENVELOPE_PURPOSE)
            .map_err(|_| invalid_stored_api_keys())?;
        self.store.put(API_KEYS_KV_KEY, &encrypted).await
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

    pub async fn update(&self, id: &Value, value: &Value) -> AppResult<Vec<ClientApiKey>> {
        let target_id = validate_api_key_id(id.as_str())?;
        let mut current = self.read().await?;
        let index = current
            .iter()
            .position(|entry| entry.id == target_id)
            .ok_or_else(api_key_not_found)?;
        let candidate = validate_api_key_with_id(value, target_id)?;
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

    pub async fn delete(&self, id: &Value) -> AppResult<Vec<ClientApiKey>> {
        let target_id = validate_api_key_id(id.as_str())?;
        let current = self.read().await?;
        let updated: Vec<_> = current
            .iter()
            .filter(|entry| entry.id != target_id)
            .cloned()
            .collect();
        if updated.len() == current.len() {
            return Err(api_key_not_found());
        }
        self.store(&updated).await
    }

    pub async fn create_auth_proxy_account(
        &self,
        value: &Value,
    ) -> AppResult<Vec<AuthProxyAccount>> {
        let candidate = validate_auth_proxy_account_input(value)?;
        let current = self.read_state(None, true).await?;
        require_available_auth_proxy_account(&current.auth_proxy_accounts, &candidate)?;
        let mut updated = current.auth_proxy_accounts;
        updated.push(candidate);
        Ok(self
            .store_state(&current.keys, updated)
            .await?
            .auth_proxy_accounts)
    }

    pub async fn update_auth_proxy_account(
        &self,
        id: &Value,
        value: &Value,
    ) -> AppResult<Vec<AuthProxyAccount>> {
        let target_id = validate_auth_proxy_account_id(id.as_str())?;
        let current = self.read_state(None, true).await?;
        let mut accounts = current.auth_proxy_accounts;
        let index = accounts
            .iter()
            .position(|entry| entry.id == target_id)
            .ok_or_else(auth_proxy_account_not_found)?;
        let candidate = validate_auth_proxy_account_with_id(value, target_id)?;
        let others: Vec<_> = accounts
            .iter()
            .enumerate()
            .filter(|(entry_index, _)| *entry_index != index)
            .map(|(_, entry)| entry.clone())
            .collect();
        require_available_auth_proxy_account(&others, &candidate)?;
        accounts[index] = candidate;
        Ok(self
            .store_state(&current.keys, accounts)
            .await?
            .auth_proxy_accounts)
    }

    pub async fn delete_auth_proxy_account(&self, id: &Value) -> AppResult<Vec<AuthProxyAccount>> {
        let target_id = validate_auth_proxy_account_id(id.as_str())?;
        let current = self.read_state(None, true).await?;
        let accounts: Vec<_> = current
            .auth_proxy_accounts
            .iter()
            .filter(|entry| entry.id != target_id)
            .cloned()
            .collect();
        if accounts.len() == current.auth_proxy_accounts.len() {
            return Err(auth_proxy_account_not_found());
        }
        Ok(self
            .store_state(&current.keys, accounts)
            .await?
            .auth_proxy_accounts)
    }

    pub async fn auth_proxy_account(&self, id: &Value) -> AppResult<AuthProxyAccount> {
        let target_id = validate_auth_proxy_account_id(id.as_str())?;
        self.read_state(None, true)
            .await?
            .auth_proxy_accounts
            .into_iter()
            .find(|entry| entry.id == target_id)
            .ok_or_else(auth_proxy_account_not_found)
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
    validate_api_key_with_id(value, new_record_id()?)
}

fn validate_api_key_with_id(value: &Value, id: String) -> AppResult<ClientApiKey> {
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
        id,
        name,
        key: key.to_owned(),
        enabled,
    })
}

fn validate_stored_api_keys(value: Value, master_key: &str) -> AppResult<(ApiKeyState, bool)> {
    let stored: StoredApiKeys =
        serde_json::from_value(value).map_err(|_| invalid_stored_api_keys())?;
    if !matches!(
        stored.version,
        IDLESS_API_KEYS_VERSION | CURRENT_API_KEYS_VERSION
    ) {
        return Err(invalid_stored_api_keys());
    }
    let (keys, keys_upgraded) =
        validate_api_key_collection(stored.keys, master_key, true, invalid_stored_api_keys)?;
    let (auth_proxy_accounts, accounts_upgraded) =
        validate_stored_auth_proxy_accounts(stored.auth_proxy_accounts, master_key)?;
    Ok((
        ApiKeyState {
            keys,
            auth_proxy_accounts,
        },
        stored.version != CURRENT_API_KEYS_VERSION || keys_upgraded || accounts_upgraded,
    ))
}

fn validate_api_key_collection(
    values: impl IntoIterator<Item = ClientApiKey>,
    master_key: &str,
    allow_missing_ids: bool,
    error: fn() -> ApiError,
) -> AppResult<(Vec<ClientApiKey>, bool)> {
    let values: Vec<_> = values.into_iter().collect();
    if values.len() > MAX_API_KEYS {
        return Err(error());
    }
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    let mut keys = HashSet::new();
    let mut validated = Vec::with_capacity(values.len());
    let mut upgraded = false;
    for value in values {
        let id = if value.id.is_empty() && allow_missing_ids {
            upgraded = true;
            derived_record_id(master_key, "api-key", &value.name)
        } else if valid_record_id(&value.id) {
            value.id.clone()
        } else {
            return Err(error());
        };
        let normalized =
            validate_api_key_with_id(&serde_json::to_value(value).map_err(|_| error())?, id)
                .map_err(|_| error())?;
        if !ids.insert(normalized.id.clone())
            || !names.insert(normalized.name.clone())
            || !keys.insert(normalized.key.clone())
        {
            return Err(error());
        }
        validated.push(normalized);
    }
    validated.sort_by(|left, right| left.name.encode_utf16().cmp(right.name.encode_utf16()));
    Ok((validated, upgraded))
}

fn validate_api_key_id(value: Option<&str>) -> AppResult<String> {
    value
        .filter(|value| valid_record_id(value))
        .map(str::to_owned)
        .ok_or_else(invalid_api_key_record)
}

fn validate_auth_proxy_account_id(value: Option<&str>) -> AppResult<String> {
    value
        .filter(|value| valid_record_id(value))
        .map(str::to_owned)
        .ok_or_else(|| {
            ApiError::new(400, "The credential proxy account ID is invalid.")
                .with_kind("invalid_request_error")
                .with_code("invalid_auth_proxy_account")
        })
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

fn require_available_auth_proxy_account(
    current: &[AuthProxyAccount],
    candidate: &AuthProxyAccount,
) -> AppResult<()> {
    if current.iter().any(|entry| entry.name == candidate.name) {
        return Err(auth_proxy_account_conflict(
            "A credential proxy account with that name already exists.",
        ));
    }
    if current
        .iter()
        .any(|entry| entry.account_id == candidate.account_id)
    {
        return Err(auth_proxy_account_conflict(
            "That credential proxy account ID is already configured.",
        ));
    }
    if current.len() >= MAX_AUTH_PROXY_ACCOUNTS {
        return Err(auth_proxy_account_conflict(
            "The credential proxy account limit has been reached.",
        ));
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
    use std::{
        cell::RefCell,
        collections::BTreeMap,
        future::Future,
        pin::pin,
        task::{Context, Poll, Waker},
    };

    use async_trait::async_trait;
    use serde_json::json;

    use super::*;

    const MASTER_KEY: &str = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";

    #[derive(Default)]
    struct MemoryStore {
        values: RefCell<BTreeMap<String, String>>,
    }

    #[async_trait(?Send)]
    impl SecretStore for MemoryStore {
        async fn get(&self, key: &str, _cache_ttl: Option<u64>) -> AppResult<Option<String>> {
            Ok(self.values.borrow().get(key).cloned())
        }

        async fn put(&self, key: &str, value: &str) -> AppResult<()> {
            self.values
                .borrow_mut()
                .insert(key.to_owned(), value.to_owned());
            Ok(())
        }

        async fn delete(&self, key: &str) -> AppResult<()> {
            self.values.borrow_mut().remove(key);
            Ok(())
        }
    }

    fn block_on_ready<F: Future>(future: F) -> F::Output {
        let mut future = pin!(future);
        let waker = Waker::noop();
        let mut context = Context::from_waker(waker);
        match future.as_mut().poll(&mut context) {
            Poll::Ready(value) => value,
            Poll::Pending => panic!("test future unexpectedly returned pending"),
        }
    }

    fn key(name: &str, key: &str, enabled: bool) -> ClientApiKey {
        ClientApiKey {
            id: derived_record_id(MASTER_KEY, "test-api-key", name),
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
                "key":format!("Flexible_{}9!", "f".repeat(55)),
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

    #[test]
    fn version_one_envelope_defaults_proxy_accounts() {
        let store = MemoryStore::default();
        let repository = ApiKeyRepository::new(&store, MASTER_KEY);
        let version_one = seal_json(
            &json!({ "version": 1, "keys": [] }),
            MASTER_KEY,
            API_KEYS_ENVELOPE_PURPOSE,
        )
        .unwrap();
        store
            .values
            .borrow_mut()
            .insert(API_KEYS_KV_KEY.into(), version_one);
        assert!(
            block_on_ready(repository.read_auth_proxy_accounts())
                .unwrap()
                .is_empty()
        );

        let configured_key = key("client", "sk-ccccccccccccccccccc2", true);
        block_on_ready(repository.store(std::slice::from_ref(&configured_key))).unwrap();
        let accounts = block_on_ready(repository.create_auth_proxy_account(&json!({
            "name": "browser",
            "accountId": "account-sensitive",
            "enabled": true
        })))
        .unwrap();

        let raw = store.values.borrow().get(API_KEYS_KV_KEY).cloned().unwrap();
        assert!(!raw.contains("account-sensitive"));
        assert!(!raw.contains("sk-ccccccccccccccccccc2"));
        assert_eq!(
            block_on_ready(repository.read()).unwrap(),
            vec![configured_key]
        );
        assert_eq!(
            block_on_ready(repository.read_auth_proxy_accounts()).unwrap(),
            accounts
        );
    }

    #[test]
    fn records_without_ids_receive_stable_ids_and_are_written_as_version_two() {
        let store = MemoryStore::default();
        let repository = ApiKeyRepository::new(&store, MASTER_KEY);
        let idless = seal_json(
            &json!({
                "version": 1,
                "keys": [{
                    "name": "stored-key",
                    "key": "sk-stored-value-123!",
                    "enabled": true
                }],
                "authProxyAccounts": [{
                    "name": "stored-proxy",
                    "accountId": "account-stored",
                    "enabled": true
                }]
            }),
            MASTER_KEY,
            API_KEYS_ENVELOPE_PURPOSE,
        )
        .unwrap();
        store
            .values
            .borrow_mut()
            .insert(API_KEYS_KV_KEY.into(), idless);

        let accounts = block_on_ready(repository.read_auth_proxy_accounts()).unwrap();
        let keys = block_on_ready(repository.read()).unwrap();
        assert_eq!(accounts.len(), 1);
        assert_eq!(keys.len(), 1);
        assert!(valid_record_id(&accounts[0].id));
        assert!(valid_record_id(&keys[0].id));
        assert_eq!(accounts[0].id.as_bytes()[14], b'8');
        assert_eq!(keys[0].id.as_bytes()[14], b'8');

        let encrypted = store.values.borrow().get(API_KEYS_KV_KEY).cloned().unwrap();
        let rewritten = open_json(&encrypted, MASTER_KEY, API_KEYS_ENVELOPE_PURPOSE).unwrap();
        assert_eq!(rewritten.get("version").and_then(Value::as_u64), Some(2));
        assert_eq!(
            rewritten.pointer("/keys/0/id").and_then(Value::as_str),
            Some(keys[0].id.as_str())
        );
        assert_eq!(
            rewritten
                .pointer("/authProxyAccounts/0/id")
                .and_then(Value::as_str),
            Some(accounts[0].id.as_str())
        );
    }

    #[test]
    fn updates_use_opaque_ids_and_preserve_them_across_renames() {
        let store = MemoryStore::default();
        let repository = ApiKeyRepository::new(&store, MASTER_KEY);
        let supplied_id = "00000000-0000-4000-8000-000000000098";
        let created = block_on_ready(repository.create(&json!({
            "id": supplied_id,
            "name": "before",
            "key": "sk-created-value-123!",
            "enabled": true
        })))
        .unwrap();
        assert_eq!(created[0].id.as_bytes()[14], b'4');
        assert_ne!(created[0].id, supplied_id);
        let id = created[0].id.clone();
        let updated = block_on_ready(repository.update(
            &json!(id),
            &json!({
                "name": "after",
                "key": "sk-created-value-123!",
                "enabled": false
            }),
        ))
        .unwrap();
        assert_eq!(updated[0].id, id);
        assert_eq!(updated[0].name, "after");
        assert!(!updated[0].enabled);
    }

    #[test]
    fn proxy_account_ids_are_generated_and_survive_editable_field_changes() {
        let store = MemoryStore::default();
        let repository = ApiKeyRepository::new(&store, MASTER_KEY);
        let supplied_id = "00000000-0000-4000-8000-000000000099";
        let created = block_on_ready(repository.create_auth_proxy_account(&json!({
            "id": supplied_id,
            "name": "before",
            "accountId": "account-before",
            "enabled": true
        })))
        .unwrap();
        assert_eq!(created[0].id.as_bytes()[14], b'4');
        assert_ne!(created[0].id, supplied_id);
        let id = created[0].id.clone();

        let updated = block_on_ready(repository.update_auth_proxy_account(
            &json!(id),
            &json!({
                "name": "after",
                "accountId": "account-after",
                "enabled": false
            }),
        ))
        .unwrap();
        assert_eq!(updated[0].id, id);
        assert_eq!(updated[0].name, "after");
        assert_eq!(updated[0].account_id, "account-after");
        assert!(!updated[0].enabled);
    }
}
