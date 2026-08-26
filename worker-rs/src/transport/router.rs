use worker::{Context, Date, Env, Request, Response};

use crate::{
    application::{
        AdminRoute, StatusRoute, is_admin_path_family, is_known_api_path, match_admin_route,
        match_api_route, match_status_route,
    },
    auth::{ApiKeyRepository, OAuthRepository, client_token},
    upstream::relay::is_backend_api_path,
};

use super::{
    admin::handle_admin,
    api::handle_api,
    config::WorkerConfig,
    relay::handle_relay,
    response::{empty, with_cors},
    status::handle_status,
    store::CloudflareSecretStore,
};

pub async fn handle_fetch(
    request: Request,
    env: Env,
    context: Context,
) -> worker::Result<Response> {
    let url = request.url()?;
    let method = request.inner().method();
    let preserve_html = matches!(
        match_status_route(&method, url.path()),
        Some(StatusRoute::Page)
    ) || WorkerConfig::admin_path(&env).is_some_and(|admin_path| {
        match_admin_route(&method, url.path(), &admin_path)
            .is_some_and(|matched| matched.route == AdminRoute::Page)
    });
    let response = dispatch_fetch(request, url, method, &env, &context).await?;
    if preserve_html {
        Ok(response)
    } else {
        super::response::suppress_html_body(response)
    }
}

async fn dispatch_fetch(
    mut request: Request,
    url: url::Url,
    method: String,
    env: &Env,
    context: &Context,
) -> worker::Result<Response> {
    let now_ms = i64::try_from(Date::now().as_millis()).unwrap_or(i64::MAX);

    if let Some(admin_path) = WorkerConfig::admin_path(env) {
        if let Some(matched) = match_admin_route(&method, url.path(), &admin_path) {
            return handle_admin(matched, &mut request, env, now_ms).await;
        }
        if is_admin_path_family(url.path(), &admin_path) {
            return empty(404);
        }
    }

    if is_backend_api_path(url.path()) {
        return handle_relay(request, url, env, now_ms).await;
    }

    if url.path() == "/healthz" {
        if method != "GET" {
            return empty(404);
        }
        let encryption_key = match WorkerConfig::encryption_key(env) {
            Ok(key) => key,
            Err(error) => return health_failure(&error),
        };
        let store = match CloudflareSecretStore::from_env(env) {
            Ok(store) => store,
            Err(error) => return health_failure(&error),
        };
        let oauth = OAuthRepository::new(&store, &encryption_key);
        return match oauth.require_valid(now_ms).await {
            Ok(_) => empty(204),
            Err(error) => health_failure(&error),
        };
    }

    if let Some(route) = match_status_route(&method, url.path()) {
        return handle_status(route, &request, env).await;
    }
    if matches!(url.path(), "/status/usage" | "/status/usage/data") {
        return empty(404);
    }

    if method == "OPTIONS" && is_known_api_path(url.path()) {
        return with_cors(empty(204)?, &WorkerConfig::cors_origin(env));
    }

    let websocket = request
        .headers()
        .get("upgrade")?
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("websocket"));
    let Some(route) = match_api_route(&method, &url, websocket) else {
        if is_known_api_path(url.path()) {
            return empty(404);
        }
        return handle_relay(request, url, env, now_ms).await;
    };

    let encryption_key = match WorkerConfig::encryption_key(env) {
        Ok(key) => key,
        Err(_) => return empty(404),
    };
    let store = match CloudflareSecretStore::from_env(env) {
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

    let config = WorkerConfig::for_api_request(env, encryption_key);

    handle_api(route, request, url, context, &config, &store).await
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
