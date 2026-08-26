use url::Url;

use crate::core::{ApiError, AppResult};

use super::codex::{CodexCredentials, HeaderBag, is_websocket_upgrade, resolve_chatgpt_relay_url};

pub const ACCOUNT_ID_HEADER: &str = "chatgpt-account-id";
const BACKEND_API_ROOT: &str = "/backend-api";

pub fn is_backend_api_path(pathname: &str) -> bool {
    pathname == BACKEND_API_ROOT || pathname.starts_with("/backend-api/")
}

pub fn resolve_relay_url(relay_origin: &str, client_url: &Url) -> AppResult<Url> {
    let search = client_url
        .query()
        .map(|query| format!("?{query}"))
        .unwrap_or_default();
    let target = resolve_chatgpt_relay_url(relay_origin, client_url.path(), &search)?;
    if target.origin() == client_url.origin() {
        return Err(ApiError::new(
            500,
            "The request origin and CHATGPT_RELAY_URL must not be the same origin.",
        )
        .with_kind("configuration_error")
        .with_code("relay_loop"));
    }
    Ok(target)
}

pub fn relay_request_headers(
    source: &HeaderBag,
    credentials: Option<&CodexCredentials>,
) -> HeaderBag {
    let websocket_upgrade = is_websocket_upgrade(source);
    let connection_headers = source
        .get("connection")
        .into_iter()
        .flat_map(|value| value.split(','))
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    let mut headers = HeaderBag::new();
    for (name, value) in source.iter() {
        if !blocked_request_header(name, websocket_upgrade, &connection_headers) {
            headers.append(name, value);
        }
    }

    if let Some(credentials) = credentials {
        if source.contains("authorization") {
            headers.set("authorization", format!("Bearer {}", credentials.token));
        }
        if source.contains(ACCOUNT_ID_HEADER)
            && let Some(account_id) = credentials
                .account_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
        {
            headers.set(ACCOUNT_ID_HEADER, account_id);
        }
    }
    if websocket_upgrade {
        headers.set("upgrade", "websocket");
    }
    headers
}

fn blocked_request_header(
    name: &str,
    websocket_upgrade: bool,
    connection_headers: &[String],
) -> bool {
    connection_headers.iter().any(|header| header == name)
        || matches!(
            name,
            "connection"
                | "content-length"
                | "host"
                | "keep-alive"
                | "proxy-authenticate"
                | "proxy-authorization"
                | "proxy-connection"
                | "sec-websocket-extensions"
                | "sec-websocket-key"
                | "sec-websocket-version"
                | "te"
                | "trailer"
                | "transfer-encoding"
        )
        || (name == "upgrade" && !websocket_upgrade)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn credentials() -> CodexCredentials {
        CodexCredentials {
            token: "replacement-token".into(),
            account_id: Some("replacement-account".into()),
        }
    }

    #[test]
    fn recognizes_the_backend_api_path_family() {
        assert!(is_backend_api_path("/backend-api"));
        assert!(is_backend_api_path("/backend-api/codex/models"));
        assert!(!is_backend_api_path("/backend-api-legacy"));
        assert!(!is_backend_api_path("/assets/backend-api"));
    }

    #[test]
    fn builds_target_url_and_rejects_a_recursive_relay() {
        let client = Url::parse(
            "https://worker.example/backend-api/codex/models?client_version=1.2.3&channel=stable",
        )
        .unwrap();
        assert_eq!(
            resolve_relay_url("https://relay.example", &client)
                .unwrap()
                .as_str(),
            "https://relay.example/backend-api/codex/models?client_version=1.2.3&channel=stable"
        );
        assert!(resolve_relay_url("https://worker.example", &client).is_err());
    }

    #[test]
    fn passthrough_keeps_credentials_and_end_to_end_headers() {
        let source = HeaderBag::from_pairs([
            ("authorization", "Bearer original"),
            (ACCOUNT_ID_HEADER, "original-account"),
            ("cookie", "session=original"),
            ("x-custom", "preserved"),
            ("connection", "keep-alive, x-hop"),
            ("x-hop", "removed"),
            ("host", "worker.example"),
        ]);
        let headers = relay_request_headers(&source, None);

        assert_eq!(headers.get("authorization"), Some("Bearer original"));
        assert_eq!(headers.get(ACCOUNT_ID_HEADER), Some("original-account"));
        assert_eq!(headers.get("cookie"), Some("session=original"));
        assert_eq!(headers.get("x-custom"), Some("preserved"));
        assert!(!headers.contains("connection"));
        assert!(!headers.contains("x-hop"));
        assert!(!headers.contains("host"));
    }

    #[test]
    fn replacement_changes_only_auth_headers_that_already_exist() {
        let source = HeaderBag::from_pairs([
            ("authorization", "Bearer original"),
            (ACCOUNT_ID_HEADER, "allowed-account"),
            ("x-custom", "preserved"),
        ]);
        let headers = relay_request_headers(&source, Some(&credentials()));
        assert_eq!(
            headers.get("authorization"),
            Some("Bearer replacement-token")
        );
        assert_eq!(headers.get(ACCOUNT_ID_HEADER), Some("replacement-account"));
        assert_eq!(headers.get("x-custom"), Some("preserved"));

        let without_authorization = HeaderBag::from_pairs([(ACCOUNT_ID_HEADER, "allowed-account")]);
        let headers = relay_request_headers(&without_authorization, Some(&credentials()));
        assert!(!headers.contains("authorization"));
        assert_eq!(headers.get(ACCOUNT_ID_HEADER), Some("replacement-account"));
    }

    #[test]
    fn keeps_websocket_subprotocol_and_leaves_runtime_handshake_fields_managed() {
        let source = HeaderBag::from_pairs([
            ("connection", "Upgrade"),
            ("upgrade", "websocket"),
            ("sec-websocket-key", "runtime-key"),
            ("sec-websocket-version", "13"),
            ("sec-websocket-protocol", "openai-responses-v1"),
        ]);
        let headers = relay_request_headers(&source, None);
        assert_eq!(headers.get("upgrade"), Some("websocket"));
        assert_eq!(
            headers.get("sec-websocket-protocol"),
            Some("openai-responses-v1")
        );
        assert!(!headers.contains("connection"));
        assert!(!headers.contains("sec-websocket-key"));
        assert!(!headers.contains("sec-websocket-version"));
    }
}
