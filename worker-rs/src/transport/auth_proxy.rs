use url::Url;
use worker::wasm_bindgen::JsValue;
use worker::{AbortSignal, Env, Fetch, Headers, Request, Response};

use crate::{
    auth::{
        ApiKeyRepository, OAuthRepository, auth_proxy_credentials_or_primary,
        matching_auth_proxy_account,
    },
    core::{ApiError, AppResult},
    upstream::{
        auth_proxy::{
            auth_proxy_request_headers, resolve_auth_proxy_url, uses_auth_proxy_credentials,
        },
        codex::{CodexCredentials, HeaderBag},
    },
};

use super::{config::WorkerConfig, response, store::CloudflareSecretStore};

pub async fn handle_auth_proxy(
    request: Request,
    client_url: Url,
    env: &Env,
    now_ms: i64,
) -> worker::Result<Response> {
    match dispatch_auth_proxy(request, &client_url, env, now_ms).await {
        Ok(response) => Ok(response),
        Err(error) => response::api_error(&error),
    }
}

async fn dispatch_auth_proxy(
    request: Request,
    client_url: &Url,
    env: &Env,
    now_ms: i64,
) -> AppResult<Response> {
    let relay_origin = WorkerConfig::relay_origin(env)?;
    if !uses_auth_proxy_credentials(client_url.path()) {
        return forward_auth_proxy(request, client_url, &relay_origin, None).await;
    }

    let encryption_key = WorkerConfig::encryption_key(env)?;
    let store = CloudflareSecretStore::from_env(env)?;
    let configured_accounts = ApiKeyRepository::new(&store, &encryption_key)
        .read_auth_proxy_accounts()
        .await?;
    let incoming_account_id = request
        .headers()
        .get(crate::upstream::auth_proxy::ACCOUNT_ID_HEADER)
        .map_err(|_| invalid_proxy_request())?;
    let replacement = if let Some(account) =
        matching_auth_proxy_account(incoming_account_id.as_deref(), &configured_accounts)
    {
        let primary = OAuthRepository::new(&store, &encryption_key);
        let auth_proxy =
            OAuthRepository::for_auth_proxy_account(&store, &encryption_key, &account.id);
        let stored = auth_proxy_credentials_or_primary(&auth_proxy, &primary, now_ms).await?;
        if stored
            .account_id
            .as_deref()
            .is_none_or(|value| value.trim().is_empty())
        {
            return Err(missing_oauth_account_id());
        }
        Some(CodexCredentials {
            token: stored.access_token,
            account_id: stored.account_id,
        })
    } else {
        None
    };

    forward_auth_proxy(request, client_url, &relay_origin, replacement.as_ref()).await
}

pub async fn forward_auth_proxy(
    request: Request,
    client_url: &Url,
    relay_origin: &str,
    credentials: Option<&CodexCredentials>,
) -> AppResult<Response> {
    let method = request.inner().method();
    let source = HeaderBag::from_pairs(request.headers().entries());
    let headers = worker_headers(&auth_proxy_request_headers(&source, credentials))?;
    let target = resolve_auth_proxy_url(relay_origin, client_url)?;
    let signal = AbortSignal::from(request.inner().signal());
    let body = (!matches!(method.as_str(), "GET" | "HEAD"))
        .then(|| request.inner().body().map(JsValue::from))
        .flatten();

    let init = worker::web_sys::RequestInit::new();
    init.set_method(&method);
    init.set_headers(headers.as_ref());
    init.set_redirect(worker::web_sys::RequestRedirect::Manual);
    if let Some(body) = body.as_ref() {
        init.set_body(body);
    }
    let outgoing = worker::web_sys::Request::new_with_str_and_init(target.as_str(), &init)
        .map(Request::from)
        .map_err(|_| invalid_proxy_request())?;

    Fetch::Request(outgoing)
        .send_with_signal(&signal)
        .await
        .map_err(|error| proxy_fetch_error(&error, &signal))
}

fn worker_headers(headers: &HeaderBag) -> AppResult<Headers> {
    let output = Headers::new();
    for (name, value) in headers.iter() {
        output
            .append(name, value)
            .map_err(|_| invalid_proxy_request())?;
    }
    Ok(output)
}

fn proxy_fetch_error(error: &worker::Error, signal: &AbortSignal) -> ApiError {
    if signal.aborted() || is_abort_error(error) {
        return ApiError::new(408, "The request was cancelled or timed out.")
            .with_kind("request_timeout")
            .with_code("request_aborted");
    }
    ApiError::new(
        502,
        "Unable to reach the configured credential proxy relay.",
    )
    .with_kind("upstream_error")
    .with_code("auth_proxy_unavailable")
}

fn is_abort_error(error: &worker::Error) -> bool {
    match error {
        worker::Error::UnknownJsError { name, message, .. } => {
            name.as_deref() == Some("AbortError")
                || message.to_ascii_lowercase().contains("aborted")
        }
        worker::Error::JsError(message) | worker::Error::RustError(message) => {
            message.to_ascii_lowercase().contains("abort")
        }
        _ => false,
    }
}

fn invalid_proxy_request() -> ApiError {
    ApiError::new(500, "The credential proxy request could not be created.")
        .with_kind("internal_error")
        .with_code("invalid_auth_proxy_request")
}

fn missing_oauth_account_id() -> ApiError {
    ApiError::new(
        503,
        "Stored OAuth credentials do not contain a ChatGPT account ID.",
    )
    .with_kind("configuration_error")
    .with_code("missing_oauth_account_id")
}
