//! OpenAI OAuth wire protocol and retry policy.

use serde_json::{Value, json};
use url::form_urlencoded;

use crate::core::{ApiError, AppResult};

use super::oauth_ports::{
    OAuthClock, OAuthHttpClient, OAuthHttpFailure, OAuthHttpMethod, OAuthHttpRequest,
    OAuthHttpResponse,
};

const CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEVICE_USER_CODE_URL: &str = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL: &str = "https://auth.openai.com/api/accounts/deviceauth/token";
pub const DEVICE_VERIFICATION_URL: &str = "https://auth.openai.com/codex/device";
const DEVICE_TOKEN_REDIRECT_URI: &str = "https://auth.openai.com/deviceauth/callback";
const OAUTH_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
pub const MAX_OAUTH_RESPONSE_BYTES: usize = 64 * 1024;
pub const PROVIDER_REQUEST_TIMEOUT_MS: u64 = 10_000;
const MAX_REFRESH_ATTEMPTS: usize = 3;

#[derive(Debug, Clone, PartialEq)]
pub struct ProviderDeviceAuthorization {
    pub device_auth_id: String,
    pub user_code: String,
    pub interval: Option<Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ProviderDevicePollResult {
    Pending,
    Authorized { token_payload: Value },
}

pub struct OAuthProvider<'a> {
    http: &'a dyn OAuthHttpClient,
    clock: &'a dyn OAuthClock,
}

impl<'a> OAuthProvider<'a> {
    pub fn new(http: &'a dyn OAuthHttpClient, clock: &'a dyn OAuthClock) -> Self {
        Self { http, clock }
    }

    pub async fn request_device_authorization(&self) -> AppResult<ProviderDeviceAuthorization> {
        let response = self
            .execute_for_api(json_request(
                DEVICE_USER_CODE_URL,
                json!({"client_id": CODEX_CLIENT_ID}).to_string(),
            ))
            .await?;
        let payload = require_provider_json(response)?;
        let payload = payload.as_object().ok_or_else(invalid_provider_response)?;
        let device_auth_id =
            nonempty_string(payload.get("device_auth_id")).ok_or_else(invalid_provider_response)?;
        let user_code = nonempty_string(payload.get("user_code"))
            .or_else(|| nonempty_string(payload.get("usercode")))
            .ok_or_else(invalid_provider_response)?;
        Ok(ProviderDeviceAuthorization {
            device_auth_id: device_auth_id.to_owned(),
            user_code: user_code.to_owned(),
            interval: payload.get("interval").cloned(),
        })
    }

    pub async fn poll_device_authorization_token(
        &self,
        device_auth_id: &str,
        user_code: &str,
    ) -> AppResult<ProviderDevicePollResult> {
        let response = self
            .execute_for_api(json_request(
                DEVICE_TOKEN_URL,
                json!({
                    "device_auth_id": device_auth_id,
                    "user_code": user_code,
                })
                .to_string(),
            ))
            .await?;
        if matches!(response.status, 403 | 404) {
            return Ok(ProviderDevicePollResult::Pending);
        }
        let payload = require_provider_json(response)?;
        let payload = payload.as_object().ok_or_else(invalid_provider_response)?;
        let authorization_code = nonempty_string(payload.get("authorization_code"))
            .ok_or_else(invalid_provider_response)?;
        let code_verifier =
            nonempty_string(payload.get("code_verifier")).ok_or_else(invalid_provider_response)?;
        if nonempty_string(payload.get("code_challenge")).is_none() {
            return Err(invalid_provider_response());
        }
        let token_payload = self
            .exchange_authorization_code(authorization_code, code_verifier)
            .await?;
        Ok(ProviderDevicePollResult::Authorized { token_payload })
    }

    pub async fn refresh_provider_token(&self, refresh_token: &str) -> AppResult<Value> {
        for attempt in 0..MAX_REFRESH_ATTEMPTS {
            match self.exchange_refresh_token(refresh_token).await {
                Ok(payload) => return Ok(payload),
                Err(RefreshExchangeError::Api(error)) => return Err(error),
                Err(RefreshExchangeError::Provider(status))
                    if retryable_provider_failure(status) && attempt + 1 < MAX_REFRESH_ATTEMPTS =>
                {
                    self.clock.sleep_ms((attempt as u64 + 1) * 1_000).await;
                }
                Err(RefreshExchangeError::Provider(status)) => {
                    return Err(provider_api_error(status));
                }
            }
        }
        Err(provider_api_error(None))
    }

    async fn exchange_authorization_code(
        &self,
        code: &str,
        code_verifier: &str,
    ) -> AppResult<Value> {
        let response = self
            .execute_for_api(form_request(
                OAUTH_TOKEN_URL,
                &[
                    ("grant_type", "authorization_code"),
                    ("client_id", CODEX_CLIENT_ID),
                    ("code", code),
                    ("redirect_uri", DEVICE_TOKEN_REDIRECT_URI),
                    ("code_verifier", code_verifier),
                ],
            ))
            .await?;
        require_provider_json(response)
    }

    async fn exchange_refresh_token(
        &self,
        refresh_token: &str,
    ) -> Result<Value, RefreshExchangeError> {
        let request = form_request(
            OAUTH_TOKEN_URL,
            &[
                ("client_id", CODEX_CLIENT_ID),
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh_token),
                ("scope", "openid profile email"),
            ],
        );
        let response = self.http.execute(request).await.map_err(|failure| {
            if failure == OAuthHttpFailure::ResponseTooLarge {
                RefreshExchangeError::Api(invalid_provider_response())
            } else {
                RefreshExchangeError::Provider(None)
            }
        })?;
        if !success_status(response.status) {
            return Err(RefreshExchangeError::Provider(Some(response.status)));
        }
        provider_json(&response.body).map_err(RefreshExchangeError::Api)
    }

    async fn execute_for_api(&self, request: OAuthHttpRequest) -> AppResult<OAuthHttpResponse> {
        self.http
            .execute(request)
            .await
            .map_err(|failure| match failure {
                OAuthHttpFailure::ClientAborted => request_aborted(),
                OAuthHttpFailure::ResponseTooLarge => invalid_provider_response(),
                OAuthHttpFailure::Network | OAuthHttpFailure::TimedOut => provider_api_error(None),
            })
    }
}

enum RefreshExchangeError {
    Api(ApiError),
    Provider(Option<u16>),
}

fn json_request(url: &str, body: String) -> OAuthHttpRequest {
    request(url, "application/json", body)
}

fn form_request(url: &str, values: &[(&str, &str)]) -> OAuthHttpRequest {
    let mut serializer = form_urlencoded::Serializer::new(String::new());
    serializer.extend_pairs(values.iter().copied());
    request(
        url,
        "application/x-www-form-urlencoded",
        serializer.finish(),
    )
}

fn request(url: &str, content_type: &str, body: String) -> OAuthHttpRequest {
    OAuthHttpRequest {
        method: OAuthHttpMethod::Post,
        url: url.to_owned(),
        headers: vec![
            ("Accept".into(), "application/json".into()),
            ("Content-Type".into(), content_type.into()),
        ],
        body,
        timeout_ms: PROVIDER_REQUEST_TIMEOUT_MS,
        max_response_bytes: MAX_OAUTH_RESPONSE_BYTES,
    }
}

fn require_provider_json(response: OAuthHttpResponse) -> AppResult<Value> {
    if !success_status(response.status) {
        return Err(provider_api_error(Some(response.status)));
    }
    provider_json(&response.body)
}

fn provider_json(body: &[u8]) -> AppResult<Value> {
    if body.is_empty() || body.len() > MAX_OAUTH_RESPONSE_BYTES {
        return Err(invalid_provider_response());
    }
    serde_json::from_slice(body).map_err(|_| invalid_provider_response())
}

fn success_status(status: u16) -> bool {
    (200..300).contains(&status)
}

fn retryable_provider_failure(status: Option<u16>) -> bool {
    status.is_none_or(|status| status == 429 || status >= 500)
}

fn nonempty_string(value: Option<&Value>) -> Option<&str> {
    value?.as_str().filter(|value| !value.is_empty())
}

fn request_aborted() -> ApiError {
    ApiError::new(408, "The request was cancelled or timed out.")
        .with_kind("request_timeout")
        .with_code("request_aborted")
}

fn provider_api_error(status: Option<u16>) -> ApiError {
    ApiError::new(502, "The OAuth provider request failed.")
        .with_kind("upstream_error")
        .with_code(if status == Some(429) {
            "oauth_rate_limited"
        } else {
            "oauth_provider_error"
        })
}

fn invalid_provider_response() -> ApiError {
    ApiError::new(502, "The OAuth provider returned an invalid response.")
        .with_kind("upstream_error")
        .with_code("invalid_oauth_provider_response")
}
