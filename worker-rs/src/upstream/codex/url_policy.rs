use url::Url;

use crate::core::{ApiError, AppResult};

use super::HeaderBag;

pub const DEFAULT_CODEX_CLIENT_VERSION: &str = "0.144.1";
pub const CODEX_MODELS_PATH: &str = "/backend-api/codex/models";
pub const CODEX_RESPONSES_PATH: &str = "/backend-api/codex/responses";
const CODEX_ROOT: &str = "/backend-api/codex";
const REALTIME_SIDEBAND_ORIGIN: &str = "https://api.openai.com";

pub fn is_codex_proxy_path(pathname: &str) -> bool {
    is_path_family(pathname, "/v1/images")
        || is_path_family(pathname, "/v1/responses")
        || pathname == "/v1/alpha/search"
        || is_live_proxy_path(pathname)
        || is_realtime_proxy_path(pathname)
}

pub fn is_codex_proxy_request_allowed(
    method: &str,
    client_url: &Url,
    websocket_upgrade: bool,
) -> bool {
    let pathname = client_url.path();
    if matches!(pathname, "/v1/live" | "/v1/realtime/calls") {
        return method == "POST";
    }
    if is_realtime_sideband_path(pathname) {
        if method != "GET" || !websocket_upgrade {
            return false;
        }
        if pathname != "/v1/realtime" {
            return true;
        }
        return client_url
            .query_pairs()
            .find(|(name, _)| name == "call_id")
            .is_some_and(|(_, value)| valid_route_id(&value));
    }
    method != "OPTIONS" && method != "CONNECT"
}

pub fn resolve_codex_proxy_url(
    relay_origin: &str,
    client_url: &Url,
    method: &str,
) -> AppResult<Url> {
    if method == "GET" && is_realtime_sideband_path(client_url.path()) {
        let mut target = Url::parse(REALTIME_SIDEBAND_ORIGIN).map_err(|_| invalid_relay_url())?;
        target.set_path(client_url.path());
        if client_url.path() == "/v1/realtime" {
            let call_id = client_url
                .query_pairs()
                .find(|(name, _)| name == "call_id")
                .map(|(_, value)| value.into_owned())
                .unwrap_or_default();
            target
                .query_pairs_mut()
                .append_pair("intent", "quicksilver")
                .append_pair("call_id", &call_id);
        }
        return Ok(target);
    }
    let pathname = proxy_path(client_url.path(), method);
    let search = client_url
        .query()
        .map(|query| format!("?{query}"))
        .unwrap_or_default();
    let mut target = resolve_chatgpt_relay_url(relay_origin, &pathname, &search)?;
    if method == "POST" && matches!(client_url.path(), "/v1/live" | "/v1/realtime/calls") {
        let has_intent = target.query_pairs().any(|(name, _)| name == "intent");
        let has_architecture = target.query_pairs().any(|(name, _)| name == "architecture");
        let mut query = target.query_pairs_mut();
        if !has_intent {
            query.append_pair("intent", "quicksilver");
        }
        if !has_architecture {
            query.append_pair("architecture", "avas");
        }
    }
    Ok(target)
}

pub fn proxy_path(pathname: &str, method: &str) -> String {
    if is_path_family(pathname, CODEX_ROOT) {
        return pathname.to_owned();
    }
    if is_path_family(pathname, "/v1/images") || is_path_family(pathname, "/v1/responses") {
        return format!("{CODEX_ROOT}{}", &pathname["/v1".len()..]);
    }
    if pathname == "/v1/alpha/search" {
        return format!("{CODEX_ROOT}/alpha/search");
    }
    if method == "POST" && matches!(pathname, "/v1/live" | "/v1/realtime/calls") {
        return format!("{CODEX_ROOT}/realtime/calls");
    }
    pathname.to_owned()
}

pub fn resolve_models_url(
    relay_origin: &str,
    client_url: &Url,
    client_headers: Option<&HeaderBag>,
) -> AppResult<Url> {
    let mut target = resolve_chatgpt_relay_url(relay_origin, CODEX_MODELS_PATH, "")?;
    let query_version = client_url
        .query_pairs()
        .find(|(name, _)| name == "client_version")
        .map(|(_, value)| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let header_version = client_headers
        .and_then(|headers| headers.get("version"))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let client_version = query_version
        .or(header_version)
        .unwrap_or_else(|| DEFAULT_CODEX_CLIENT_VERSION.to_owned());
    target
        .query_pairs_mut()
        .append_pair("client_version", &client_version);
    for (name, value) in client_url.query_pairs() {
        if name == "channel" {
            target.query_pairs_mut().append_pair(&name, &value);
        }
    }
    Ok(target)
}

pub fn responses_url(relay_origin: &str) -> AppResult<Url> {
    resolve_chatgpt_relay_url(relay_origin, CODEX_RESPONSES_PATH, "")
}

pub fn usage_url(relay_origin: &str) -> AppResult<Url> {
    resolve_chatgpt_relay_url(relay_origin, super::CODEX_USAGE_PATH, "")
}

pub fn resolve_chatgpt_relay_url(origin: &str, pathname: &str, search: &str) -> AppResult<Url> {
    let base = Url::parse(origin).map_err(|_| invalid_relay_url())?;
    if base.scheme() != "https" || base.origin().ascii_serialization() != origin {
        return Err(invalid_relay_url());
    }
    let mut target = base.join(pathname).map_err(|_| invalid_relay_url())?;
    if target.origin().ascii_serialization() != origin {
        return Err(invalid_relay_url());
    }
    target.set_query(if search.is_empty() {
        None
    } else {
        Some(search.strip_prefix('?').unwrap_or(search))
    });
    Ok(target)
}

pub fn is_codex_native_target(pathname: &str) -> bool {
    let Some(index) = pathname.find(CODEX_ROOT) else {
        return false;
    };
    let remainder = &pathname[index + CODEX_ROOT.len()..];
    remainder.is_empty() || remainder.starts_with('/')
}

pub fn is_realtime_sideband_path(pathname: &str) -> bool {
    pathname == "/v1/realtime"
        || pathname
            .strip_prefix("/v1/live/")
            .is_some_and(valid_route_id)
        || pathname
            .strip_prefix("/v1/realtime/calls/")
            .is_some_and(valid_route_id)
}

pub fn is_live_proxy_path(pathname: &str) -> bool {
    pathname == "/v1/live"
        || pathname
            .strip_prefix("/v1/live/")
            .is_some_and(valid_route_id)
}

pub fn is_realtime_proxy_path(pathname: &str) -> bool {
    matches!(pathname, "/v1/realtime" | "/v1/realtime/calls")
        || pathname
            .strip_prefix("/v1/realtime/calls/")
            .is_some_and(valid_route_id)
}

fn is_path_family(pathname: &str, root: &str) -> bool {
    pathname == root
        || pathname
            .strip_prefix(root)
            .is_some_and(|rest| rest.starts_with('/'))
}

fn valid_route_id(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn invalid_relay_url() -> ApiError {
    ApiError::new(500, "CHATGPT_RELAY_URL must be an HTTPS origin.")
        .with_kind("configuration_error")
        .with_code("invalid_chatgpt_relay_url")
}
