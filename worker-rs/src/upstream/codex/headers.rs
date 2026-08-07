use std::collections::BTreeMap;

use super::DEFAULT_CODEX_CLIENT_VERSION;

const FORWARDED_CODEX_HEADERS: [&str; 4] = [
    "version",
    "x-codex-beta-features",
    "x-codex-turn-metadata",
    "x-codex-turn-state",
];

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HeaderBag {
    values: BTreeMap<String, String>,
}

impl HeaderBag {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_pairs<I, N, V>(pairs: I) -> Self
    where
        I: IntoIterator<Item = (N, V)>,
        N: Into<String>,
        V: Into<String>,
    {
        let mut headers = Self::new();
        for (name, value) in pairs {
            headers.append(name, value);
        }
        headers
    }

    pub fn get(&self, name: &str) -> Option<&str> {
        self.values
            .get(&name.to_ascii_lowercase())
            .map(String::as_str)
    }

    pub fn contains(&self, name: &str) -> bool {
        self.values.contains_key(&name.to_ascii_lowercase())
    }

    pub fn set(&mut self, name: impl Into<String>, value: impl Into<String>) {
        self.values.insert(
            name.into().to_ascii_lowercase(),
            value.into().trim().to_owned(),
        );
    }

    pub fn append(&mut self, name: impl Into<String>, value: impl Into<String>) {
        let name = name.into().to_ascii_lowercase();
        let value = value.into().trim().to_owned();
        self.values
            .entry(name)
            .and_modify(|current| {
                if !current.is_empty() && !value.is_empty() {
                    current.push_str(", ");
                }
                current.push_str(&value);
            })
            .or_insert(value);
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.values
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexCredentials {
    pub token: String,
    pub account_id: Option<String>,
}

pub fn is_websocket_upgrade(headers: &HeaderBag) -> bool {
    headers
        .get("upgrade")
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("websocket"))
}

pub fn codex_headers(
    credentials: &CodexCredentials,
    accept: &str,
    source: Option<&HeaderBag>,
    has_json_body: bool,
) -> HeaderBag {
    let mut headers = HeaderBag::from_pairs([
        ("accept", accept.to_owned()),
        ("authorization", format!("Bearer {}", credentials.token)),
    ]);
    if has_json_body {
        headers.set("content-type", "application/json");
    }
    if let Some(account_id) = credentials
        .account_id
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        headers.set("chatgpt-account-id", account_id);
    }
    for name in FORWARDED_CODEX_HEADERS {
        if let Some(value) = source
            .and_then(|headers| headers.get(name))
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            headers.set(name, value);
        }
    }
    headers
}

pub fn usage_headers(credentials: &CodexCredentials) -> HeaderBag {
    let mut headers = HeaderBag::from_pairs([
        ("accept", "application/json".to_owned()),
        ("authorization", format!("Bearer {}", credentials.token)),
        ("content-type", "application/json".to_owned()),
        (
            "user-agent",
            format!("codex_cli_rs/{DEFAULT_CODEX_CLIENT_VERSION}"),
        ),
    ]);
    if let Some(account_id) = credentials
        .account_id
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        headers.set("chatgpt-account-id", account_id);
    }
    headers
}

pub fn proxy_request_headers(
    source: &HeaderBag,
    credentials: &CodexCredentials,
    target_pathname: &str,
    websocket_upgrade: bool,
) -> HeaderBag {
    let mut headers = HeaderBag::new();
    for (name, value) in source.iter() {
        if !blocked_request_header(name) {
            headers.append(name, value);
        }
    }
    headers.set("authorization", format!("Bearer {}", credentials.token));
    if let Some(account_id) = credentials
        .account_id
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        headers.set("chatgpt-account-id", account_id);
    }
    if super::is_codex_native_target(target_pathname) {
        headers.set(
            "user-agent",
            format!("codex_cli_rs/{DEFAULT_CODEX_CLIENT_VERSION}"),
        );
        if !headers.contains("version") {
            headers.set("version", DEFAULT_CODEX_CLIENT_VERSION);
        }
        if !headers.contains("originator") {
            headers.set("originator", "codex_cli_rs");
        }
        if websocket_upgrade
            && is_responses_websocket_path(target_pathname)
            && !headers
                .get("openai-beta")
                .is_some_and(|value| value.contains("responses_websockets="))
        {
            headers.set("openai-beta", "responses_websockets=2026-02-06");
        }
    }
    if websocket_upgrade {
        headers.set("upgrade", "websocket");
    }
    headers
}

fn blocked_request_header(name: &str) -> bool {
    matches!(
        name,
        "accept-encoding"
            | "authorization"
            | "cdn-loop"
            | "chatgpt-account-id"
            | "connection"
            | "content-length"
            | "cookie"
            | "expect"
            | "forwarded"
            | "host"
            | "keep-alive"
            | "origin"
            | "proxy-authorization"
            | "proxy-connection"
            | "referer"
            | "sec-websocket-extensions"
            | "sec-websocket-key"
            | "sec-websocket-version"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "true-client-ip"
            | "upgrade"
            | "user-agent"
            | "via"
            | "x-api-key"
            | "x-goog-api-key"
            | "x-real-ip"
    ) || name.starts_with("cf-")
        || name.starts_with("x-forwarded-")
        || name.starts_with("x-envoy-")
}

fn is_responses_websocket_path(pathname: &str) -> bool {
    pathname
        .strip_suffix('/')
        .unwrap_or(pathname)
        .ends_with("/backend-api/codex/responses")
}
