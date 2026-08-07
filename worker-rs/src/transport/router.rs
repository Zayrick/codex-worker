use worker::{Context, Date, Env, Request, Response, ScheduleContext, ScheduledEvent};

use crate::{
    application::{is_known_api_path, match_admin_route, match_api_route},
    auth::{ApiKeyRepository, OAuthProvider, OAuthRefreshService, OAuthRepository, client_token},
};

use super::{
    admin::handle_admin,
    api::handle_api,
    config::WorkerConfig,
    oauth::{CloudflareClock, CloudflareOAuthHttpClient},
    response::{empty, with_cors},
    store::CloudflareSecretStore,
};

pub async fn handle_fetch(
    mut request: Request,
    env: Env,
    context: Context,
) -> worker::Result<Response> {
    let url = request.url()?;
    let method = request.inner().method();
    let now_ms = i64::try_from(Date::now().as_millis()).unwrap_or(i64::MAX);

    if method == "GET" && url.path() == "/healthz" {
        let encryption_key = match WorkerConfig::encryption_key(&env) {
            Ok(key) => key,
            Err(error) => return health_failure(&error),
        };
        let store = match CloudflareSecretStore::from_env(&env) {
            Ok(store) => store,
            Err(error) => return health_failure(&error),
        };
        let oauth = OAuthRepository::new(&store, &encryption_key);
        return match oauth.require_valid(now_ms).await {
            Ok(_) => empty(204),
            Err(error) => health_failure(&error),
        };
    }

    if let Some(admin_path) = WorkerConfig::admin_path(&env)
        && let Some(matched) = match_admin_route(&method, url.path(), &admin_path)
    {
        return handle_admin(matched, &mut request, &env, now_ms).await;
    }

    if method == "OPTIONS" && is_known_api_path(url.path()) {
        return with_cors(empty(204)?, &WorkerConfig::cors_origin(&env));
    }

    let websocket = request
        .headers()
        .get("upgrade")?
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("websocket"));
    let Some(route) = match_api_route(&method, &url, websocket) else {
        return empty(404);
    };

    let encryption_key = match WorkerConfig::encryption_key(&env) {
        Ok(key) => key,
        Err(_) => return empty(404),
    };
    let store = match CloudflareSecretStore::from_env(&env) {
        Ok(store) => store,
        Err(_) => return empty(404),
    };

    let authorization = request.headers().get("authorization")?;
    let api_key = request.headers().get("x-api-key")?;
    let google_api_key = request.headers().get("x-goog-api-key")?;
    let token = client_token(
        authorization.as_deref(),
        api_key.as_deref(),
        google_api_key.as_deref(),
    );
    let keys = ApiKeyRepository::new(&store, &encryption_key);
    if keys.authenticate(token.as_deref()).await.is_err() {
        return empty(404);
    }

    let config = WorkerConfig::for_api_request(&env, encryption_key);

    handle_api(route, request, url, &context, &config, &store).await
}

fn health_failure(error: &crate::core::ApiError) -> worker::Result<Response> {
    worker::console_error!(
        "{}",
        serde_json::json!({
            "event": "health_check",
            "status": "failed",
            "code": error.code.as_deref().unwrap_or("health_check_failed"),
        })
    );
    empty(404)
}

pub async fn handle_scheduled(_event: ScheduledEvent, env: Env, _context: ScheduleContext) {
    let Ok(encryption_key) = WorkerConfig::encryption_key(&env) else {
        worker::console_error!("scheduled OAuth refresh: invalid Worker configuration");
        return;
    };
    let Ok(store) = CloudflareSecretStore::from_env(&env) else {
        worker::console_error!("scheduled OAuth refresh: authentication storage unavailable");
        return;
    };
    let credentials = OAuthRepository::new(&store, &encryption_key);
    let clock = CloudflareClock;
    let http = CloudflareOAuthHttpClient::new(None);
    let provider = OAuthProvider::new(&http, &clock);
    let service = OAuthRefreshService::new(&credentials, &provider, &clock);
    if let Err(error) = service.refresh(None).await {
        worker::console_error!(
            "scheduled OAuth refresh failed: {}",
            error.code.as_deref().unwrap_or("oauth_refresh_failed")
        );
    }
}
