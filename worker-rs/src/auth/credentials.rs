use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::OffsetDateTime;

use crate::core::{ApiError, AppResult};

use super::{SecretStore, oauth_ports::OAuthCredentialsStore, open_json, seal_json};

const OAUTH_KEY: &str = "oauth";
const OAUTH_ENVELOPE_PURPOSE: &str = "codex-worker/oauth/v1";
const DEFAULT_TOKEN_LIFETIME_MS: i64 = 55 * 60 * 1_000;
const MAX_OAUTH_ENVELOPE_CHARS: usize = 128 * 1_024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexCredentials {
    pub token: String,
    pub account_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredOAuthCredentials {
    pub version: u8,
    pub access_token: String,
    pub refresh_token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    pub expires_at: i64,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthStatus {
    pub email: Option<String>,
    pub expires_at: i64,
}

pub struct OAuthRepository<'a> {
    store: &'a dyn SecretStore,
    master_key: &'a str,
}

impl<'a> OAuthRepository<'a> {
    pub fn new(store: &'a dyn SecretStore, master_key: &'a str) -> Self {
        Self { store, master_key }
    }

    pub async fn read(&self) -> AppResult<Option<StoredOAuthCredentials>> {
        let Some(encrypted) = self.store.get(OAUTH_KEY, Some(30)).await? else {
            return Ok(None);
        };
        if encrypted.len() > MAX_OAUTH_ENVELOPE_CHARS {
            return Err(invalid_stored_credentials());
        }
        let value = open_json(&encrypted, self.master_key, OAUTH_ENVELOPE_PURPOSE)
            .map_err(|_| invalid_stored_credentials())?;
        validate_stored_credentials(value).map(Some)
    }

    pub async fn store(&self, credentials: &StoredOAuthCredentials) -> AppResult<()> {
        let value = serde_json::to_value(credentials).map_err(|_| invalid_stored_credentials())?;
        let validated = validate_stored_credentials(value)?;
        let value = serde_json::to_value(validated).map_err(|_| invalid_stored_credentials())?;
        let encrypted = seal_json(&value, self.master_key, OAUTH_ENVELOPE_PURPOSE)
            .map_err(|_| invalid_stored_credentials())?;
        self.store.put(OAUTH_KEY, &encrypted).await
    }

    pub async fn delete(&self) -> AppResult<()> {
        self.store.delete(OAUTH_KEY).await
    }

    pub async fn require_unconfigured(&self) -> AppResult<()> {
        if self.store.get(OAUTH_KEY, None).await?.is_some() {
            return Err(
                ApiError::new(409, "OAuth credentials are already configured.")
                    .with_kind("invalid_request_error")
                    .with_code("oauth_already_configured"),
            );
        }
        Ok(())
    }

    pub async fn require_valid(&self, now_ms: i64) -> AppResult<StoredOAuthCredentials> {
        let Some(credentials) = self.read().await? else {
            return Err(
                ApiError::new(503, "Upstream OAuth credentials are not configured.")
                    .with_kind("configuration_error")
                    .with_code("missing_oauth_credentials"),
            );
        };
        if credentials.expires_at <= now_ms {
            return Err(
                ApiError::new(503, "Upstream OAuth credentials are awaiting refresh.")
                    .with_kind("upstream_authentication_error")
                    .with_code("oauth_refresh_required"),
            );
        }
        Ok(credentials)
    }

    pub async fn codex_credentials(&self, now_ms: i64) -> AppResult<CodexCredentials> {
        let credentials = self.require_valid(now_ms).await?;
        Ok(CodexCredentials {
            token: credentials.access_token,
            account_id: credentials.account_id,
        })
    }
}

#[async_trait(?Send)]
impl OAuthCredentialsStore for OAuthRepository<'_> {
    async fn read(&self) -> AppResult<Option<StoredOAuthCredentials>> {
        OAuthRepository::read(self).await
    }

    async fn store(&self, credentials: &StoredOAuthCredentials) -> AppResult<()> {
        OAuthRepository::store(self, credentials).await
    }

    async fn delete(&self) -> AppResult<()> {
        OAuthRepository::delete(self).await
    }

    async fn require_unconfigured(&self) -> AppResult<()> {
        OAuthRepository::require_unconfigured(self).await
    }
}

pub fn oauth_status(credentials: &StoredOAuthCredentials) -> OAuthStatus {
    OAuthStatus {
        email: credentials.email.clone(),
        expires_at: credentials.expires_at,
    }
}

pub fn credentials_from_token_response(
    value: &Value,
    previous: Option<&StoredOAuthCredentials>,
    now_ms: i64,
) -> AppResult<StoredOAuthCredentials> {
    let object = value.as_object().ok_or_else(invalid_provider_credentials)?;
    let access_token =
        nonempty_string(object.get("access_token")).ok_or_else(invalid_provider_credentials)?;
    let refresh_token = nonempty_string(object.get("refresh_token"))
        .map(str::to_owned)
        .or_else(|| previous.map(|value| value.refresh_token.clone()))
        .ok_or_else(invalid_provider_credentials)?;
    let id_token = nonempty_string(object.get("id_token"))
        .map(str::to_owned)
        .or_else(|| previous.and_then(|value| value.id_token.clone()));
    let claims = id_token.as_deref().and_then(decode_jwt);
    let account_id = nonempty_string(object.get("account_id"))
        .map(str::to_owned)
        .or_else(|| account_id_from_claims(claims.as_ref()).map(str::to_owned))
        .or_else(|| previous.and_then(|value| value.account_id.clone()));
    let email = claims
        .as_ref()
        .and_then(|claims| nonempty_string(claims.get("email")))
        .map(str::to_owned)
        .or_else(|| previous.and_then(|value| value.email.clone()));
    let expires_at = object
        .get("expires_in")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|seconds| now_ms.saturating_add((seconds * 1_000.0) as i64))
        .or_else(|| jwt_expiry(access_token))
        .unwrap_or_else(|| now_ms.saturating_add(DEFAULT_TOKEN_LIFETIME_MS));

    Ok(StoredOAuthCredentials {
        version: 1,
        access_token: access_token.to_owned(),
        refresh_token,
        id_token,
        account_id,
        email,
        expires_at,
        updated_at: iso_timestamp(now_ms)?,
    })
}

fn validate_stored_credentials(value: Value) -> AppResult<StoredOAuthCredentials> {
    let credentials: StoredOAuthCredentials =
        serde_json::from_value(value).map_err(|_| invalid_stored_credentials())?;
    if credentials.version != 1
        || credentials.access_token.is_empty()
        || credentials.refresh_token.is_empty()
        || credentials.expires_at <= 0
        || credentials.updated_at.is_empty()
        || credentials.id_token.as_deref().is_some_and(str::is_empty)
        || credentials.account_id.as_deref().is_some_and(str::is_empty)
        || credentials.email.as_deref().is_some_and(str::is_empty)
    {
        return Err(invalid_stored_credentials());
    }
    Ok(credentials)
}

fn decode_jwt(token: &str) -> Option<serde_json::Map<String, Value>> {
    let mut parts = token.split('.');
    let _header = parts.next()?;
    let payload = parts.next()?;
    let _signature = parts.next()?;
    if parts.next().is_some() || payload.is_empty() {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD.decode(payload).ok()?;
    serde_json::from_slice::<Value>(&bytes)
        .ok()?
        .as_object()
        .cloned()
}

fn jwt_expiry(token: &str) -> Option<i64> {
    let exp = decode_jwt(token)?.get("exp")?.as_f64()?;
    (exp.is_finite() && exp > 0.0).then_some((exp * 1_000.0) as i64)
}

fn account_id_from_claims(claims: Option<&serde_json::Map<String, Value>>) -> Option<&str> {
    claims?
        .get("https://api.openai.com/auth")?
        .as_object()?
        .get("chatgpt_account_id")?
        .as_str()
        .filter(|value| !value.is_empty())
}

fn nonempty_string(value: Option<&Value>) -> Option<&str> {
    value?.as_str().filter(|value| !value.is_empty())
}

fn iso_timestamp(now_ms: i64) -> AppResult<String> {
    let timestamp = OffsetDateTime::from_unix_timestamp_nanos(i128::from(now_ms) * 1_000_000)
        .map_err(|_| invalid_provider_credentials())?;
    Ok(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        timestamp.year(),
        u8::from(timestamp.month()),
        timestamp.day(),
        timestamp.hour(),
        timestamp.minute(),
        timestamp.second(),
        timestamp.millisecond(),
    ))
}

fn invalid_provider_credentials() -> ApiError {
    ApiError::new(
        502,
        "The OAuth provider returned an invalid token response.",
    )
    .with_kind("upstream_error")
    .with_code("invalid_oauth_token_response")
}

fn invalid_stored_credentials() -> ApiError {
    ApiError::new(500, "Stored OAuth credentials are unavailable.")
        .with_kind("configuration_error")
        .with_code("invalid_oauth_credentials")
}

#[cfg(test)]
mod tests {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use serde_json::json;

    use super::*;

    fn jwt(value: Value) -> String {
        format!(
            "{}.{}.signature",
            URL_SAFE_NO_PAD.encode(b"{}"),
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&value).unwrap()),
        )
    }

    #[test]
    fn derives_account_email_expiry_and_stable_iso_timestamp() {
        let access = jwt(json!({"exp": 4_102_444_800_i64}));
        let id = jwt(json!({
            "email": "test@example.com",
            "https://api.openai.com/auth": {"chatgpt_account_id": "account-test"}
        }));
        let credentials = credentials_from_token_response(
            &json!({
                "access_token": access,
                "refresh_token": "refresh",
                "id_token": id,
                "expires_in": 3600
            }),
            None,
            1_800_000_000_000,
        )
        .unwrap();
        assert_eq!(credentials.account_id.as_deref(), Some("account-test"));
        assert_eq!(credentials.email.as_deref(), Some("test@example.com"));
        assert_eq!(credentials.expires_at, 1_800_003_600_000);
        assert_eq!(credentials.updated_at, "2027-01-15T08:00:00.000Z");
    }

    #[test]
    fn keeps_rotating_refresh_metadata_when_the_provider_omits_it() {
        let previous = StoredOAuthCredentials {
            version: 1,
            access_token: "old".into(),
            refresh_token: "refresh".into(),
            id_token: None,
            account_id: Some("account".into()),
            email: None,
            expires_at: 1,
            updated_at: "old".into(),
        };
        let updated = credentials_from_token_response(
            &json!({"access_token": "new"}),
            Some(&previous),
            1_000,
        )
        .unwrap();
        assert_eq!(updated.refresh_token, "refresh");
        assert_eq!(updated.account_id.as_deref(), Some("account"));
    }
}
