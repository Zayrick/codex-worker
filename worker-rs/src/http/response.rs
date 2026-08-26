use serde::Serialize;

use crate::core::{ApiError, AppResult};

pub const CORS_ALLOWED_HEADERS: &[&str] = &[
    "Authorization",
    "Content-Type",
    "Range",
    "X-Api-Key",
    "X-Goog-Api-Key",
    "X-Goog-Api-Client",
    "X-Goog-User-Project",
    "Idempotency-Key",
    "Version",
    "OpenAI-Alpha",
    "OpenAI-Beta",
    "OpenAI-Organization",
    "OpenAI-Project",
    "Anthropic-Version",
    "Anthropic-Beta",
    "Anthropic-Dangerous-Direct-Browser-Access",
    "Session-Id",
    "Thread-Id",
    "Last-Event-ID",
    "X-Client-Request-Id",
    "X-Codex-Beta-Features",
    "X-Codex-Turn-Metadata",
    "X-Codex-Turn-State",
    "X-Oai-Attestation",
    "X-Stainless-Arch",
    "X-Stainless-Helper-Method",
    "X-Stainless-Lang",
    "X-Stainless-OS",
    "X-Stainless-Package-Version",
    "X-Stainless-Retry-Count",
    "X-Stainless-Runtime",
    "X-Stainless-Runtime-Version",
    "X-Stainless-Timeout",
];

pub const CORS_EXPOSED_HEADERS: &[&str] = &[
    "Accept-Ranges",
    "Anthropic-Ratelimit-Input-Tokens-Limit",
    "Anthropic-Ratelimit-Input-Tokens-Remaining",
    "Anthropic-Ratelimit-Input-Tokens-Reset",
    "Anthropic-Ratelimit-Output-Tokens-Limit",
    "Anthropic-Ratelimit-Output-Tokens-Remaining",
    "Anthropic-Ratelimit-Output-Tokens-Reset",
    "Anthropic-Ratelimit-Requests-Limit",
    "Anthropic-Ratelimit-Requests-Remaining",
    "Anthropic-Ratelimit-Requests-Reset",
    "Anthropic-Ratelimit-Tokens-Limit",
    "Anthropic-Ratelimit-Tokens-Remaining",
    "Anthropic-Ratelimit-Tokens-Reset",
    "Content-Disposition",
    "Content-Length",
    "Content-Range",
    "ETag",
    "Location",
    "OpenAI-Processing-Ms",
    "OpenAI-Request-Id",
    "OpenAI-Version",
    "Request-Id",
    "Retry-After",
    "X-Codex-Turn-State",
    "X-Goog-Request-Id",
    "X-Ratelimit-Limit-Requests",
    "X-Ratelimit-Limit-Tokens",
    "X-Ratelimit-Remaining-Requests",
    "X-Ratelimit-Remaining-Tokens",
    "X-Ratelimit-Reset-Requests",
    "X-Ratelimit-Reset-Tokens",
    "X-Request-Id",
];

pub const BLOCKED_PROXY_RESPONSE_HEADERS: &[&str] = &[
    "alt-svc",
    "clear-site-data",
    "connection",
    "keep-alive",
    "nel",
    "proxy-authenticate",
    "proxy-authorization",
    "report-to",
    "sec-websocket-accept",
    "sec-websocket-extensions",
    "server",
    "set-cookie",
    "set-cookie2",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeaderDto {
    pub name: String,
    pub value: String,
}

/// Ordered, case-insensitive header DTO. Duplicate entries are retained.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HeadersDto {
    entries: Vec<HeaderDto>,
}

impl HeadersDto {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            entries: Vec::new(),
        }
    }

    #[must_use]
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

    pub fn append(&mut self, name: impl Into<String>, value: impl Into<String>) {
        self.entries.push(HeaderDto {
            name: name.into(),
            value: value.into(),
        });
    }

    pub fn set(&mut self, name: impl Into<String>, value: impl Into<String>) {
        let name = name.into();
        self.remove(&name);
        self.append(name, value);
    }

    pub fn remove(&mut self, name: &str) {
        self.entries
            .retain(|entry| !entry.name.eq_ignore_ascii_case(name));
    }

    #[must_use]
    pub fn get(&self, name: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|entry| entry.name.eq_ignore_ascii_case(name))
            .map(|entry| entry.value.as_str())
    }

    #[must_use]
    pub fn contains(&self, name: &str) -> bool {
        self.get(name).is_some()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.entries
            .iter()
            .map(|entry| (entry.name.as_str(), entry.value.as_str()))
    }

    #[must_use]
    pub fn as_slice(&self) -> &[HeaderDto] {
        &self.entries
    }

    #[must_use]
    pub fn into_entries(self) -> Vec<HeaderDto> {
        self.entries
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResponseBodyDto {
    Empty,
    Bytes(Vec<u8>),
    /// The runtime must reuse the upstream body handle without buffering it.
    Passthrough,
    /// The runtime supplies a stream and uses the generated SSE response head.
    EventStream,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResponseDto {
    pub status: u16,
    pub status_text: String,
    pub headers: HeadersDto,
    pub body: ResponseBodyDto,
    /// Whether the runtime must preserve the upstream WebSocket handle.
    pub websocket: bool,
    /// Mirrors Workers' `encodeBody: "manual"` response option.
    pub encode_body_manual: bool,
}

impl ResponseDto {
    #[must_use]
    pub fn new(status: u16, body: ResponseBodyDto) -> Self {
        Self {
            status,
            status_text: String::new(),
            headers: HeadersDto::new(),
            body,
            websocket: false,
            encode_body_manual: false,
        }
    }
}

#[must_use]
pub fn empty_response(status: u16) -> ResponseDto {
    ResponseDto::new(status, ResponseBodyDto::Empty)
}

pub fn json_response<T: Serialize + ?Sized>(value: &T, status: u16) -> AppResult<ResponseDto> {
    let bytes = serde_json::to_vec(value).map_err(json_serialization_error)?;
    let mut response = ResponseDto::new(status, ResponseBodyDto::Bytes(bytes));
    response
        .headers
        .set("Content-Type", "application/json; charset=utf-8");
    response.headers.set("Cache-Control", "no-store");
    Ok(response)
}

#[must_use]
pub fn html_response(body: &str, status: u16, nonce: Option<&str>) -> ResponseDto {
    let source = nonce.map_or_else(|| "'none'".to_owned(), |nonce| format!("'nonce-{nonce}'"));
    let policy = format!(
        "default-src 'none'; script-src {source}; style-src {source}; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    );
    let mut response = ResponseDto::new(status, ResponseBodyDto::Bytes(body.as_bytes().to_vec()));
    response
        .headers
        .set("Content-Type", "text/html; charset=utf-8");
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Content-Security-Policy", policy);
    response.headers.set("Referrer-Policy", "same-origin");
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("X-Frame-Options", "SAMEORIGIN");
    response
}

#[must_use]
pub fn upstream_json_response(response: ResponseDto) -> ResponseDto {
    let content_type = response
        .headers
        .get("Content-Type")
        .unwrap_or("application/json; charset=utf-8")
        .to_owned();
    let mut headers = HeadersDto::from_pairs([
        ("Content-Type", content_type.as_str()),
        ("Cache-Control", "no-store"),
    ]);
    copy_codex_response_headers(&response.headers, &mut headers);
    ResponseDto {
        headers,
        websocket: false,
        encode_body_manual: false,
        ..response
    }
}

#[must_use]
pub fn upstream_error_response(response: ResponseDto) -> ResponseDto {
    let mut headers = HeadersDto::from_pairs([("Cache-Control", "no-store")]);
    for name in [
        "Content-Type",
        "Retry-After",
        "X-Request-Id",
        "OpenAI-Request-Id",
        "X-Codex-Turn-State",
    ] {
        if let Some(value) = response
            .headers
            .get(name)
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            headers.set(name, value);
        }
    }
    ResponseDto {
        headers,
        websocket: false,
        encode_body_manual: false,
        ..response
    }
}

#[must_use]
pub fn upstream_proxy_response(mut response: ResponseDto) -> ResponseDto {
    let mut headers = HeadersDto::new();
    for (name, value) in response.headers.iter() {
        let blocked = BLOCKED_PROXY_RESPONSE_HEADERS
            .iter()
            .any(|blocked| name.eq_ignore_ascii_case(blocked));
        if blocked || starts_with_ignore_ascii_case(name, "cf-") {
            continue;
        }
        headers.append(name, value);
    }
    headers.set("Cache-Control", "no-store");
    response.encode_body_manual = headers.contains("Content-Encoding");
    response.headers = headers;
    if response.websocket {
        response.body = ResponseBodyDto::Empty;
    }
    response
}

#[must_use]
pub fn suppress_html_body(mut response: ResponseDto) -> ResponseDto {
    let is_html = response
        .headers
        .get("Content-Type")
        .is_some_and(is_html_content_type);
    if is_html && !response.websocket {
        response.headers.remove("Content-Length");
        response.headers.remove("Content-Encoding");
        response.body = ResponseBodyDto::Empty;
        response.encode_body_manual = false;
    }
    response
}

#[must_use]
pub fn is_html_content_type(value: &str) -> bool {
    value
        .split(';')
        .next()
        .map(str::trim)
        .is_some_and(|media_type| {
            media_type.eq_ignore_ascii_case("text/html")
                || media_type.eq_ignore_ascii_case("application/xhtml+xml")
        })
}

#[must_use]
pub fn chat_sse_response(source: Option<&HeadersDto>) -> ResponseDto {
    event_stream_response(source)
}

#[must_use]
pub fn event_stream_response(source: Option<&HeadersDto>) -> ResponseDto {
    let mut response = ResponseDto::new(200, ResponseBodyDto::EventStream);
    response
        .headers
        .set("Content-Type", "text/event-stream; charset=utf-8");
    response
        .headers
        .set("Cache-Control", "no-cache, no-transform");
    if let Some(source) = source {
        copy_codex_response_headers(source, &mut response.headers);
    }
    response
}

#[must_use]
pub fn with_cors(mut response: ResponseDto, origin: &str) -> ResponseDto {
    response.headers.set(
        "Access-Control-Allow-Origin",
        if origin.is_empty() { "*" } else { origin },
    );
    response.headers.set(
        "Access-Control-Allow-Headers",
        CORS_ALLOWED_HEADERS.join(", "),
    );
    response.headers.set(
        "Access-Control-Allow-Methods",
        "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
    );
    response.headers.set(
        "Access-Control-Expose-Headers",
        CORS_EXPOSED_HEADERS.join(", "),
    );
    response.headers.set("Access-Control-Max-Age", "86400");
    response.encode_body_manual = response.headers.contains("Content-Encoding");
    if response.websocket {
        response.body = ResponseBodyDto::Empty;
    }
    response
}

fn copy_codex_response_headers(source: &HeadersDto, target: &mut HeadersDto) {
    if let Some(turn_state) = source
        .get("X-Codex-Turn-State")
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        target.set("X-Codex-Turn-State", turn_state);
    }
}

fn starts_with_ignore_ascii_case(value: &str, prefix: &str) -> bool {
    value
        .get(..prefix.len())
        .is_some_and(|candidate| candidate.eq_ignore_ascii_case(prefix))
}

fn json_serialization_error(_: serde_json::Error) -> ApiError {
    ApiError::new(500, "Failed to serialize the JSON response.")
        .with_kind("internal_error")
        .with_code("json_serialization_error")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn upstream(headers: HeadersDto) -> ResponseDto {
        ResponseDto {
            status: 429,
            status_text: "Too Many Requests".into(),
            headers,
            body: ResponseBodyDto::Passthrough,
            websocket: false,
            encode_body_manual: false,
        }
    }

    #[test]
    fn builds_json_and_secure_nonce_html_responses() {
        let json = json_response(&json!({"ok": true}), 201).expect("serializable JSON");
        assert_eq!(
            json.headers.get("content-type"),
            Some("application/json; charset=utf-8")
        );
        assert_eq!(json.headers.get("cache-control"), Some("no-store"));

        let html = html_response("<main>ok</main>", 200, Some("abc123"));
        let csp = html.headers.get("content-security-policy").expect("CSP");
        assert!(csp.contains("script-src 'nonce-abc123'"));
        assert!(csp.contains("style-src 'nonce-abc123'"));
        assert!(!csp.contains("unsafe-inline"));
    }

    #[test]
    fn filters_proxy_headers_and_marks_encoded_bodies_manual() {
        let response = upstream_proxy_response(upstream(HeadersDto::from_pairs([
            ("Content-Type", "application/json"),
            ("Content-Encoding", "zstd"),
            ("Set-Cookie", "secret=true"),
            ("CF-Ray", "internal"),
            ("X-Request-Id", "req_123"),
        ])));
        assert!(!response.headers.contains("set-cookie"));
        assert!(!response.headers.contains("cf-ray"));
        assert_eq!(response.headers.get("x-request-id"), Some("req_123"));
        assert_eq!(response.headers.get("cache-control"), Some("no-store"));
        assert!(response.encode_body_manual);
    }

    #[test]
    fn suppresses_declared_html_without_changing_api_responses() {
        let mut html = upstream(HeadersDto::from_pairs([
            ("Content-Type", " Text/HTML ; charset=utf-8 "),
            ("Content-Length", "1024"),
            ("Content-Encoding", "gzip"),
            ("X-Request-Id", "req_123"),
        ]));
        html.encode_body_manual = true;
        let html = suppress_html_body(html);
        assert_eq!(html.body, ResponseBodyDto::Empty);
        assert!(!html.headers.contains("content-length"));
        assert!(!html.headers.contains("content-encoding"));
        assert_eq!(html.headers.get("x-request-id"), Some("req_123"));
        assert!(!html.encode_body_manual);

        let xhtml = suppress_html_body(upstream(HeadersDto::from_pairs([(
            "Content-Type",
            "application/xhtml+xml",
        )])));
        assert_eq!(xhtml.body, ResponseBodyDto::Empty);

        let json = upstream(HeadersDto::from_pairs([(
            "Content-Type",
            "application/json",
        )]));
        assert_eq!(suppress_html_body(json.clone()), json);
    }

    #[test]
    fn preserves_websocket_metadata_but_drops_the_http_body() {
        let mut response = upstream(HeadersDto::from_pairs([
            ("Sec-WebSocket-Accept", "blocked"),
            ("Sec-WebSocket-Protocol", "openai-responses-v1"),
        ]));
        response.status = 101;
        response.websocket = true;
        let response = with_cors(upstream_proxy_response(response), "https://client.example");
        assert!(response.websocket);
        assert_eq!(response.body, ResponseBodyDto::Empty);
        assert!(!response.headers.contains("sec-websocket-accept"));
        assert_eq!(
            response.headers.get("sec-websocket-protocol"),
            Some("openai-responses-v1")
        );
        assert_eq!(
            response.headers.get("access-control-allow-origin"),
            Some("https://client.example")
        );
    }

    #[test]
    fn error_response_only_copies_the_allowlist_and_trims_values() {
        let response = upstream_error_response(upstream(HeadersDto::from_pairs([
            ("Content-Type", " application/json "),
            ("Retry-After", " 2 "),
            ("X-Secret", "do-not-copy"),
            ("X-Codex-Turn-State", " turn-1 "),
        ])));
        assert_eq!(
            response.headers.get("content-type"),
            Some("application/json")
        );
        assert_eq!(response.headers.get("retry-after"), Some("2"));
        assert_eq!(response.headers.get("x-codex-turn-state"), Some("turn-1"));
        assert!(!response.headers.contains("x-secret"));
    }

    #[test]
    fn sse_and_cors_headers_match_the_wire_contract() {
        let source = HeadersDto::from_pairs([("X-Codex-Turn-State", " state ")]);
        let response = with_cors(event_stream_response(Some(&source)), "");
        assert_eq!(response.status, 200);
        assert_eq!(response.body, ResponseBodyDto::EventStream);
        assert_eq!(
            response.headers.get("content-type"),
            Some("text/event-stream; charset=utf-8")
        );
        assert_eq!(response.headers.get("x-codex-turn-state"), Some("state"));
        assert_eq!(
            response.headers.get("access-control-allow-origin"),
            Some("*")
        );
        assert_eq!(
            response.headers.get("access-control-max-age"),
            Some("86400")
        );
        assert!(
            response
                .headers
                .get("access-control-allow-headers")
                .is_some_and(|value| value.contains("Authorization"))
        );
    }
}
