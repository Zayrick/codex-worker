use futures_util::{StreamExt, TryStreamExt, stream};
use serde::Serialize;
use serde_json::{Value, json};
use worker::{AbortSignal, Date, Env, Headers, Request, Response};

use crate::{
    application::{AdminRoute, MatchedAdminRoute},
    auth::{
        ApiKeyRepository, AuthProxyAccount, DeviceAuthorizationService, DevicePollResult,
        OAuthProvider, OAuthRepository, OAuthStatus, admin_secret_matches,
        admin_session_cookie_header, clear_admin_session_cookie_header, create_admin_session,
        has_valid_admin_session, oauth_status,
    },
    core::{ApiError, AppResult, JsonObject},
    upstream::codex::{codex_subscription_from_usage, codex_subscription_metadata},
};

use super::{
    application_page::application_page,
    body::read_limited_body,
    codex::CodexClient,
    config::WorkerConfig,
    oauth::{CloudflareClock, CloudflareOAuthHttpClient},
    response,
    store::CloudflareSecretStore,
};

const MAX_ADMIN_BODY_BYTES: usize = 16 * 1024;
const AUTH_PROXY_OAUTH_READ_CONCURRENCY: usize = 4;

pub async fn handle_admin(
    matched: MatchedAdminRoute,
    request: &mut Request,
    env: &Env,
    now_ms: i64,
) -> worker::Result<Response> {
    match dispatch(matched, request, env, now_ms).await {
        Ok(response) => Ok(response),
        Err(error) => response::api_error(&error),
    }
}

async fn dispatch(
    matched: MatchedAdminRoute,
    request: &mut Request,
    env: &Env,
    now_ms: i64,
) -> AppResult<Response> {
    let url = request.url().map_err(|_| invalid_admin_request())?;
    match matched.route {
        AdminRoute::Page => return application_page(request, env).await,
        AdminRoute::Login => {
            require_same_origin(request, &url)?;
            let admin_secret = WorkerConfig::admin_secret(env)?;
            let encryption_key = WorkerConfig::encryption_key(env)?;
            let bytes = read_limited_body(request, MAX_ADMIN_BODY_BYTES)
                .await
                .ok()
                .flatten()
                .unwrap_or_default();
            let secret = url::form_urlencoded::parse(&bytes)
                .find(|(name, _)| name == "secret")
                .map(|(_, value)| value.into_owned());
            if !admin_secret_matches(
                &secret.map(Value::String).unwrap_or(Value::Null),
                &admin_secret,
            ) {
                return Err(invalid_admin_secret());
            }
            let session = create_admin_session(&admin_secret, &encryption_key, now_ms)?;
            return redirect_response(
                &matched.base_path,
                &url,
                Some(&admin_session_cookie_header(&session)),
            );
        }
        AdminRoute::Logout => {
            require_same_origin(request, &url)?;
            return redirect_response(
                &matched.base_path,
                &url,
                Some(&clear_admin_session_cookie_header()),
            );
        }
        _ => {}
    }

    let admin_secret = WorkerConfig::admin_secret(env)?;
    let encryption_key = WorkerConfig::encryption_key(env)?;
    let cookie = request
        .headers()
        .get("cookie")
        .map_err(|_| invalid_admin_session())?;
    if !has_valid_admin_session(cookie.as_deref(), &admin_secret, &encryption_key, now_ms) {
        return Err(invalid_admin_session());
    }
    if request.inner().method() != "GET" {
        require_same_origin(request, &url)?;
    }

    let store = CloudflareSecretStore::from_env(env)?;
    let oauth = OAuthRepository::new(&store, &encryption_key);
    let keys = ApiKeyRepository::new(&store, &encryption_key);
    match matched.route {
        AdminRoute::State => {
            let credentials = oauth.read().await?;
            let api_keys = keys.read().await?;
            let auth_proxy_accounts = keys.read_auth_proxy_accounts().await?;
            let auth_proxy_accounts =
                auth_proxy_account_states(&store, &encryption_key, auth_proxy_accounts).await?;
            let oauth_status = credentials.as_ref().map(oauth_status);
            let subscription = credentials
                .as_ref()
                .map(|credentials| codex_subscription_metadata(credentials.id_token.as_deref()));
            json_response(
                &json!({
                    "oauth": oauth_status,
                    "subscription": subscription,
                    "apiKeys": api_keys,
                    "authProxyAccounts": auth_proxy_accounts,
                }),
                200,
            )
        }
        AdminRoute::Subscription => {
            let client = CodexClient::new(&oauth, WorkerConfig::relay_origin(env)?);
            let usage = client
                .fetch_usage(Some(AbortSignal::from(request.inner().signal())))
                .await?;
            let subscription = codex_subscription_from_usage(
                &usage.payload,
                usage.metadata,
                Date::now().as_millis() as f64,
            )?;
            json_response(&json!({ "subscription": subscription }), 200)
        }
        AdminRoute::OAuthStart => {
            let clock = CloudflareClock;
            let http = CloudflareOAuthHttpClient::new(Some(request.inner().signal()));
            let provider = OAuthProvider::new(&http, &clock);
            let service =
                DeviceAuthorizationService::new(&oauth, &provider, &clock, &encryption_key);
            let authorization = service.start().await?;
            json_response(&authorization, 201)
        }
        AdminRoute::OAuthPoll => {
            let body = admin_json(request).await?;
            let state = required_device_state(&body)?;
            let clock = CloudflareClock;
            let http = CloudflareOAuthHttpClient::new(Some(request.inner().signal()));
            let provider = OAuthProvider::new(&http, &clock);
            let service =
                DeviceAuthorizationService::new(&oauth, &provider, &clock, &encryption_key);
            match service.poll(state).await? {
                DevicePollResult::Pending { retry_after } => json_response(
                    &json!({ "status": "pending", "retryAfter": retry_after }),
                    202,
                ),
                DevicePollResult::Stored { credentials } => json_response(
                    &json!({
                        "status": "stored",
                        "oauth": oauth_status(&credentials),
                        "subscription": codex_subscription_metadata(credentials.id_token.as_deref()),
                    }),
                    200,
                ),
            }
        }
        AdminRoute::OAuthDelete => {
            oauth.delete().await?;
            json_response(&json!({ "oauth": Value::Null }), 200)
        }
        AdminRoute::ApiKeysGet => json_response(&json!({ "apiKeys": keys.read().await? }), 200),
        AdminRoute::ApiKeysCreate => {
            let body = Value::Object(admin_json(request).await?);
            json_response(&json!({ "apiKeys": keys.create(&body).await? }), 201)
        }
        AdminRoute::ApiKeysUpdate => {
            let body = admin_json(request).await?;
            let id = body.get("id").cloned().unwrap_or(Value::Null);
            let value = Value::Object(body);
            json_response(&json!({ "apiKeys": keys.update(&id, &value).await? }), 200)
        }
        AdminRoute::ApiKeysDelete => {
            let body = admin_json(request).await?;
            let id = body.get("id").cloned().unwrap_or(Value::Null);
            json_response(&json!({ "apiKeys": keys.delete(&id).await? }), 200)
        }
        AdminRoute::AuthProxyCreate => {
            let body = Value::Object(admin_json(request).await?);
            let accounts = keys.create_auth_proxy_account(&body).await?;
            auth_proxy_accounts_response(&store, &encryption_key, accounts, 201).await
        }
        AdminRoute::AuthProxyUpdate => {
            let body = admin_json(request).await?;
            let id = body.get("id").cloned().unwrap_or(Value::Null);
            let value = Value::Object(body);
            let accounts = keys.update_auth_proxy_account(&id, &value).await?;
            auth_proxy_accounts_response(&store, &encryption_key, accounts, 200).await
        }
        AdminRoute::AuthProxyDelete => {
            let body = admin_json(request).await?;
            let id = body.get("id").cloned().unwrap_or(Value::Null);
            let account = keys.auth_proxy_account(&id).await?;
            OAuthRepository::for_auth_proxy_account(&store, &encryption_key, &account.id)
                .delete()
                .await?;
            let accounts = keys.delete_auth_proxy_account(&id).await?;
            auth_proxy_accounts_response(&store, &encryption_key, accounts, 200).await
        }
        AdminRoute::AuthProxyOAuthStart => {
            let body = admin_json(request).await?;
            let id = body.get("id").cloned().unwrap_or(Value::Null);
            let account = keys.auth_proxy_account(&id).await?;
            let account_oauth =
                OAuthRepository::for_auth_proxy_account(&store, &encryption_key, &account.id);
            let clock = CloudflareClock;
            let http = CloudflareOAuthHttpClient::new(Some(request.inner().signal()));
            let provider = OAuthProvider::new(&http, &clock);
            let service = DeviceAuthorizationService::scoped(
                &account_oauth,
                &provider,
                &clock,
                &encryption_key,
                &account.id,
            );
            json_response(&service.start().await?, 201)
        }
        AdminRoute::AuthProxyOAuthPoll => {
            let body = admin_json(request).await?;
            let id = body.get("id").cloned().unwrap_or(Value::Null);
            let state = required_device_state(&body)?;
            let account = keys.auth_proxy_account(&id).await?;
            let account_oauth =
                OAuthRepository::for_auth_proxy_account(&store, &encryption_key, &account.id);
            let clock = CloudflareClock;
            let http = CloudflareOAuthHttpClient::new(Some(request.inner().signal()));
            let provider = OAuthProvider::new(&http, &clock);
            let service = DeviceAuthorizationService::scoped(
                &account_oauth,
                &provider,
                &clock,
                &encryption_key,
                &account.id,
            );
            match service.poll(state).await? {
                DevicePollResult::Pending { retry_after } => json_response(
                    &json!({ "status": "pending", "retryAfter": retry_after }),
                    202,
                ),
                DevicePollResult::Stored { credentials } => json_response(
                    &json!({
                        "status": "stored",
                        "oauth": oauth_status(&credentials),
                    }),
                    200,
                ),
            }
        }
        AdminRoute::AuthProxyOAuthDelete => {
            let body = admin_json(request).await?;
            let id = body.get("id").cloned().unwrap_or(Value::Null);
            let account = keys.auth_proxy_account(&id).await?;
            OAuthRepository::for_auth_proxy_account(&store, &encryption_key, &account.id)
                .delete()
                .await?;
            json_response(&json!({ "oauth": Value::Null }), 200)
        }
        AdminRoute::Page | AdminRoute::Login | AdminRoute::Logout => Err(invalid_admin_request()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthProxyAccountState {
    #[serde(flatten)]
    account: AuthProxyAccount,
    oauth: Option<OAuthStatus>,
}

async fn auth_proxy_account_states(
    store: &CloudflareSecretStore,
    encryption_key: &str,
    accounts: Vec<AuthProxyAccount>,
) -> AppResult<Vec<AuthProxyAccountState>> {
    stream::iter(accounts)
        .map(|account| {
            let oauth = OAuthRepository::for_auth_proxy_account(store, encryption_key, &account.id);
            async move {
                let credentials = oauth.read().await?;
                Ok(AuthProxyAccountState {
                    account,
                    oauth: credentials.as_ref().map(oauth_status),
                })
            }
        })
        .buffered(AUTH_PROXY_OAUTH_READ_CONCURRENCY)
        .try_collect()
        .await
}

async fn auth_proxy_accounts_response(
    store: &CloudflareSecretStore,
    encryption_key: &str,
    accounts: Vec<AuthProxyAccount>,
    status: u16,
) -> AppResult<Response> {
    let accounts = auth_proxy_account_states(store, encryption_key, accounts).await?;
    json_response(&json!({ "authProxyAccounts": accounts }), status)
}

fn required_device_state(body: &JsonObject) -> AppResult<&str> {
    body.get("state")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ApiError::new(400, "Missing device authorization state.")
                .with_kind("invalid_request_error")
                .with_code("missing_required_parameter")
                .with_param("state")
        })
}

async fn admin_json(request: &mut Request) -> AppResult<JsonObject> {
    let bytes = read_limited_body(request, MAX_ADMIN_BODY_BYTES).await?;
    let Some(bytes) = bytes else {
        return Err(invalid_admin_json());
    };
    serde_json::from_slice::<Value>(&bytes)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .ok_or_else(invalid_admin_json)
}

fn require_same_origin(request: &Request, url: &url::Url) -> AppResult<()> {
    let origin = request
        .headers()
        .get("origin")
        .map_err(|_| invalid_admin_origin())?;
    if origin.as_deref() == Some(&url.origin().ascii_serialization()) {
        Ok(())
    } else {
        Err(invalid_admin_origin())
    }
}

fn redirect_response(
    base_path: &str,
    request_url: &url::Url,
    cookie: Option<&str>,
) -> AppResult<Response> {
    let location = request_url
        .join(base_path)
        .map_err(|_| invalid_admin_request())?;
    let headers = Headers::new();
    headers
        .set("location", location.as_str())
        .map_err(|_| invalid_admin_request())?;
    headers
        .set("cache-control", "no-store")
        .map_err(|_| invalid_admin_request())?;
    if let Some(cookie) = cookie {
        headers
            .append("set-cookie", cookie)
            .map_err(|_| invalid_admin_request())?;
    }
    Ok(Response::builder()
        .with_status(303)
        .with_headers(headers)
        .empty())
}

fn json_response(value: &impl serde::Serialize, status: u16) -> AppResult<Response> {
    response::json(value, status).map_err(|_| invalid_admin_request())
}

fn invalid_admin_session() -> ApiError {
    ApiError::new(401, "The management session is missing or expired.")
        .with_kind("authentication_error")
        .with_code("invalid_admin_session")
}

fn invalid_admin_secret() -> ApiError {
    ApiError::new(401, "管理密钥无效。")
        .with_kind("authentication_error")
        .with_code("invalid_admin_secret")
}

fn invalid_admin_origin() -> ApiError {
    ApiError::new(403, "The management request must be same-origin.")
        .with_kind("authentication_error")
        .with_code("invalid_admin_origin")
}

fn invalid_admin_json() -> ApiError {
    ApiError::new(400, "The management request body is not valid JSON.")
        .with_kind("invalid_request_error")
        .with_code("invalid_json")
}

fn invalid_admin_request() -> ApiError {
    ApiError::new(500, "The management request could not be completed.")
        .with_kind("internal_error")
        .with_code("admin_request_failed")
}
