use base64::{Engine as _, engine::general_purpose::STANDARD};
use worker::{Env, Headers, Method, Request, RequestInit, Response};

use crate::core::{ApiError, AppResult};

const CSP_NONCE_PLACEHOLDER: &str = "__CODEX_WORKER_CSP_NONCE__";

pub async fn application_page(request: &Request, env: &Env) -> AppResult<Response> {
    let assets = env
        .assets("ASSETS")
        .map_err(|_| application_unavailable())?;
    let mut asset_url = request.url().map_err(|_| application_unavailable())?;
    asset_url.set_path("/index.html");
    asset_url.set_query(None);
    asset_url.set_fragment(None);
    let headers = Headers::new();
    headers
        .set("accept", "text/html")
        .map_err(|_| application_unavailable())?;
    let mut init = RequestInit::new();
    init.with_method(Method::Get).with_headers(headers);
    let mut asset = assets
        .fetch(asset_url.as_str(), Some(init))
        .await
        .map_err(|_| application_unavailable())?;
    let content_type = asset
        .headers()
        .get("content-type")
        .map_err(|_| application_unavailable())?
        .unwrap_or_default();
    if !(200..300).contains(&asset.status_code())
        || !content_type.to_ascii_lowercase().contains("text/html")
    {
        return Err(application_unavailable());
    }
    let html = asset.text().await.map_err(|_| application_unavailable())?;
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random).map_err(|_| application_unavailable())?;
    let nonce = STANDARD.encode(random);
    let html = html.replace(CSP_NONCE_PLACEHOLDER, &nonce);
    let headers = Headers::new();
    headers
        .set("content-type", "text/html; charset=utf-8")
        .map_err(|_| application_unavailable())?;
    for (name, value) in [
        ("cache-control", "no-store".to_owned()),
        (
            "content-security-policy",
            format!(
                "default-src 'none'; script-src 'self' 'nonce-{nonce}'; style-src 'self' 'nonce-{nonce}'; connect-src 'self'; img-src 'self' data:; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
            ),
        ),
        ("cross-origin-opener-policy", "same-origin".to_owned()),
        ("cross-origin-resource-policy", "same-origin".to_owned()),
        (
            "permissions-policy",
            "camera=(), geolocation=(), microphone=()".to_owned(),
        ),
        ("referrer-policy", "same-origin".to_owned()),
        ("x-content-type-options", "nosniff".to_owned()),
        ("x-frame-options", "DENY".to_owned()),
    ] {
        headers
            .set(name, &value)
            .map_err(|_| application_unavailable())?;
    }
    Ok(Response::builder()
        .with_headers(headers)
        .fixed(html.into_bytes()))
}

fn application_unavailable() -> ApiError {
    ApiError::new(500, "The web application is unavailable.")
        .with_kind("configuration_error")
        .with_code("application_unavailable")
}
