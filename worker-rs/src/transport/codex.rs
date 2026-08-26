//! Cloudflare I/O adapter for the ChatGPT Codex relay.
//!
//! URL, header, and JSON policies remain runtime-neutral in `upstream` and
//! `protocol`; this module only owns Worker requests, cancellation, streams,
//! and WebSocket lifetime management.

use std::borrow::Cow;

use futures_util::{StreamExt, future::join};
use serde_json::Value;
use url::Url;
use worker::{
    AbortSignal, Context, Date, Fetch, FormEntry, Headers, Method, Request, RequestInit,
    RequestRedirect, Response, ResponseBody, WebSocket, WebSocketPair, WebsocketEvent,
};
use worker::{
    js_sys::{Array, Function, Object, Reflect, Uint8Array},
    wasm_bindgen::{JsCast, JsValue},
    web_sys::{BinaryType, Response as WebResponse},
    worker_sys::ext::ResponseExt,
};

use crate::{
    auth::OAuthRepository,
    core::{ApiError, AppResult, JsonObject},
    http::{LimitedBodyCollector, parse_json_body_with_source},
    protocol::openai::{
        request_policy::apply_converted_response_egress_policy,
        responses::{
            adapt_compact_body, adapt_responses_create_body, adapt_responses_websocket_message,
        },
    },
    upstream::codex::{
        CODEX_USAGE_REQUEST_TIMEOUT_MS, CodexCredentials, CodexSubscriptionMetadata, HeaderBag,
        MAX_CODEX_USAGE_RESPONSE_BYTES, codex_headers, codex_subscription_metadata,
        codex_usage_unavailable, codex_usage_upstream_error, invalid_codex_usage_response,
        is_websocket_upgrade, proxy_request_headers, resolve_codex_proxy_url, resolve_models_url,
        responses_url, usage_headers, usage_url,
    },
};

use super::body::{cancel_readable_stream, read_body, read_limited_body};

const MAX_LIVE_BOOTSTRAP_BODY_BYTES: usize = 16 * 1024 * 1024;
const WEBSOCKET_PROXY_ERROR: &str = "WebSocket proxy error";

/// The three Codex routes whose HTTP bodies have distinct egress policies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexProxyRoute {
    Responses,
    Compact,
    Proxy,
}

/// Optional metadata forwarded by direct Codex calls.
#[derive(Debug, Clone, Default)]
pub struct CodexRequestOptions<'a> {
    pub headers: Option<&'a Headers>,
    pub signal: Option<AbortSignal>,
}

/// Bounded usage document paired with metadata from the exact credential read
/// that authorized it. The application layer performs the pure normalization.
#[derive(Debug, Clone, PartialEq)]
pub struct CodexUsageDocument {
    pub payload: Value,
    pub metadata: CodexSubscriptionMetadata,
}

/// Codex relay client backed by the encrypted OAuth repository.
pub struct CodexClient<'repository, 'store> {
    oauth: &'repository OAuthRepository<'store>,
    relay_origin: String,
}

impl<'repository, 'store> CodexClient<'repository, 'store> {
    pub fn new(
        oauth: &'repository OAuthRepository<'store>,
        relay_origin: impl Into<String>,
    ) -> Self {
        Self {
            oauth,
            relay_origin: relay_origin.into(),
        }
    }

    /// Fetches the native Codex model catalog without buffering its response.
    pub async fn fetch_models(
        &self,
        client_url: &Url,
        options: CodexRequestOptions<'_>,
    ) -> AppResult<Response> {
        let credentials = self.credentials().await?;
        let source = options.headers.map(header_bag);
        let target = resolve_models_url(&self.relay_origin, client_url, source.as_ref())?;
        let headers = codex_headers(&credentials, "application/json", source.as_ref(), false);
        self.send(&target, "GET", headers, None, options.signal.as_ref(), true)
            .await
    }

    /// Fetches and bounds the live subscription usage document. The timeout
    /// covers both response headers and body consumption.
    pub async fn fetch_usage(
        &self,
        client_signal: Option<AbortSignal>,
    ) -> AppResult<CodexUsageDocument> {
        let now_ms = current_time_ms();
        let stored = self.oauth.require_valid(now_ms).await?;
        let metadata = codex_subscription_metadata(stored.id_token.as_deref());
        let credentials = CodexCredentials {
            token: stored.access_token,
            account_id: stored.account_id,
        };
        let target = usage_url(&self.relay_origin)?;
        let mut init = RequestInit::new();
        init.with_method(Method::Get)
            .with_headers(worker_headers(&usage_headers(&credentials))?)
            .with_redirect(RequestRedirect::Manual);
        let outgoing = Request::new_with_init(target.as_str(), &init)
            .map_err(|_| codex_usage_unavailable())?;

        let timeout =
            worker::web_sys::AbortSignal::timeout_with_f64(CODEX_USAGE_REQUEST_TIMEOUT_MS as f64);
        let signal = combined_abort_signal(client_signal.as_ref(), &timeout);
        let mut response = Fetch::Request(outgoing)
            .send_with_signal(&signal)
            .await
            .map_err(|_| usage_transport_error(client_signal.as_ref()))?;
        let status = response.status_code();
        if !(200..300).contains(&status) {
            discard_response_body(response).await;
            return Err(codex_usage_upstream_error(status));
        }

        let payload = read_usage_payload(&mut response, client_signal.as_ref(), &timeout).await?;
        Ok(CodexUsageDocument { payload, metadata })
    }

    /// Sends a protocol-converted Responses request and keeps the SSE body as
    /// the upstream `ReadableStream`.
    pub async fn send_converted_responses(
        &self,
        body: &JsonObject,
        options: CodexRequestOptions<'_>,
    ) -> AppResult<Response> {
        let credentials = self.credentials().await?;
        let source = options.headers.map(header_bag);
        let target = responses_url(&self.relay_origin)?;
        let headers = codex_headers(&credentials, "text/event-stream", source.as_ref(), true);
        let adapted = apply_converted_response_egress_policy(body);
        let body = serde_json::to_string(adapted.as_ref())
            .map(JsValue::from)
            .map_err(|_| json_serialization_error())?;
        self.send(
            &target,
            "POST",
            headers,
            Some(body),
            options.signal.as_ref(),
            true,
        )
        .await
    }

    /// Forwards a native Codex/realtime request. Non-adapted bodies and every
    /// non-Responses WebSocket stay transparent.
    pub async fn forward_proxy(
        &self,
        mut request: Request,
        client_url: &Url,
        route: CodexProxyRoute,
        context: &Context,
    ) -> AppResult<Response> {
        let credentials = self.credentials().await?;
        let method = request.inner().method();
        let source = header_bag(request.headers());
        let websocket_upgrade = is_websocket_upgrade(&source);
        let target = resolve_codex_proxy_url(&self.relay_origin, client_url, &method)?;
        let signal = AbortSignal::from(request.inner().signal());
        let prepared = prepare_proxy_body(&mut request, client_url, &method, route, source).await?;
        let headers = proxy_request_headers(
            &prepared.headers,
            &credentials,
            target.path(),
            websocket_upgrade,
        );
        let response = self
            .send(
                &target,
                &method,
                headers,
                prepared.body,
                Some(&signal),
                false,
            )
            .await?;

        if route == CodexProxyRoute::Responses && websocket_upgrade {
            bridge_responses_websocket(response, context)
        } else {
            Ok(response)
        }
    }

    async fn credentials(&self) -> AppResult<CodexCredentials> {
        let stored = self.oauth.require_valid(current_time_ms()).await?;
        Ok(CodexCredentials {
            token: stored.access_token,
            account_id: stored.account_id,
        })
    }

    async fn send(
        &self,
        target: &Url,
        method: &str,
        headers: HeaderBag,
        body: Option<JsValue>,
        signal: Option<&AbortSignal>,
        require_success_body: bool,
    ) -> AppResult<Response> {
        let headers = worker_headers(&headers)?;
        let init = worker::web_sys::RequestInit::new();
        init.set_method(method);
        init.set_headers(headers.as_ref());
        init.set_redirect(worker::web_sys::RequestRedirect::Manual);
        if let Some(body) = body.as_ref() {
            init.set_body(body);
        }
        let outgoing = worker::web_sys::Request::new_with_str_and_init(target.as_str(), &init)
            .map(Request::from)
            .map_err(|_| codex_unavailable())?;
        let fetch = Fetch::Request(outgoing);
        let response = match signal {
            Some(signal) => fetch.send_with_signal(signal).await,
            None => fetch.send().await,
        }
        .map_err(|error| fetch_error(&error, signal))?;

        if require_success_body
            && (200..300).contains(&response.status_code())
            && matches!(response.body(), ResponseBody::Empty)
        {
            return Err(empty_codex_response());
        }
        Ok(response)
    }
}

async fn read_usage_payload(
    response: &mut Response,
    client_signal: Option<&AbortSignal>,
    timeout: &worker::web_sys::AbortSignal,
) -> AppResult<Value> {
    let raw_stream = match response.body() {
        ResponseBody::Stream(stream) => Some(stream.clone()),
        ResponseBody::Empty | ResponseBody::Body(_) => None,
    };
    let declared_length = match response.headers().get("content-length") {
        Ok(length) => length,
        Err(_) => {
            cancel_readable_stream(raw_stream.as_ref()).await;
            return Err(usage_transport_error(client_signal));
        }
    };
    let mut collector =
        match LimitedBodyCollector::new(MAX_CODEX_USAGE_RESPONSE_BYTES, declared_length.as_deref())
        {
            Ok(collector) => collector,
            Err(_) => {
                cancel_readable_stream(raw_stream.as_ref()).await;
                return Err(usage_payload_error(client_signal, timeout));
            }
        };

    match response.body() {
        ResponseBody::Empty => {}
        ResponseBody::Body(bytes) => collector
            .push_chunk(bytes)
            .map_err(|_| usage_payload_error(client_signal, timeout))?,
        ResponseBody::Stream(_) => {
            let mut source = match response.stream() {
                Ok(source) => source,
                Err(_) => {
                    cancel_readable_stream(raw_stream.as_ref()).await;
                    return Err(usage_transport_error(client_signal));
                }
            };
            while let Some(chunk) = source.next().await {
                let chunk = match chunk {
                    Ok(chunk) => chunk,
                    Err(_) => {
                        drop(source);
                        cancel_readable_stream(raw_stream.as_ref()).await;
                        return Err(usage_transport_error(client_signal));
                    }
                };
                if collector.push_chunk(&chunk).is_err() {
                    drop(source);
                    cancel_readable_stream(raw_stream.as_ref()).await;
                    return Err(usage_payload_error(client_signal, timeout));
                }
            }
            // ByteStream treats an aborted reader as EOF, so explicitly retain
            // the client-vs-timeout distinction after streaming completes.
            if client_signal.is_some_and(AbortSignal::aborted) {
                return Err(request_aborted());
            }
            if timeout.aborted() {
                return Err(codex_usage_unavailable());
            }
        }
    }

    let bytes = collector.finish();
    if bytes.is_empty() {
        return Err(usage_payload_error(client_signal, timeout));
    }
    serde_json::from_slice(&bytes).map_err(|_| usage_payload_error(client_signal, timeout))
}

async fn discard_response_body(response: Response) {
    let stream = match response.body() {
        ResponseBody::Stream(stream) => Some(stream.clone()),
        ResponseBody::Empty | ResponseBody::Body(_) => None,
    };
    cancel_readable_stream(stream.as_ref()).await;
}

fn combined_abort_signal(
    client: Option<&AbortSignal>,
    timeout: &worker::web_sys::AbortSignal,
) -> AbortSignal {
    let signals = Array::new();
    if let Some(client) = client {
        let client: &worker::web_sys::AbortSignal = client;
        signals.push(client);
    }
    signals.push(timeout);
    AbortSignal::from(worker::web_sys::AbortSignal::any(&signals))
}

fn current_time_ms() -> i64 {
    i64::try_from(Date::now().as_millis()).unwrap_or(i64::MAX)
}

fn usage_transport_error(client_signal: Option<&AbortSignal>) -> ApiError {
    if client_signal.is_some_and(AbortSignal::aborted) {
        request_aborted()
    } else {
        codex_usage_unavailable()
    }
}

fn usage_payload_error(
    client_signal: Option<&AbortSignal>,
    timeout: &worker::web_sys::AbortSignal,
) -> ApiError {
    if client_signal.is_some_and(AbortSignal::aborted) {
        request_aborted()
    } else if timeout.aborted() {
        codex_usage_unavailable()
    } else {
        invalid_codex_usage_response()
    }
}

struct PreparedProxyBody {
    headers: HeaderBag,
    body: Option<JsValue>,
}

async fn prepare_proxy_body(
    request: &mut Request,
    client_url: &Url,
    method: &str,
    route: CodexProxyRoute,
    headers: HeaderBag,
) -> AppResult<PreparedProxyBody> {
    if method != "POST" {
        return Ok(passthrough_body(request, method, headers));
    }

    match route {
        CodexProxyRoute::Responses => {
            adapt_json_body(request, headers, adapt_responses_create_body).await
        }
        CodexProxyRoute::Compact => adapt_json_body(request, headers, adapt_compact_body).await,
        CodexProxyRoute::Proxy if is_live_multipart(client_url.path(), &headers) => {
            adapt_live_bootstrap(request, client_url, headers).await
        }
        CodexProxyRoute::Proxy => Ok(passthrough_body(request, method, headers)),
    }
}

async fn adapt_json_body<'a>(
    request: &mut Request,
    headers: HeaderBag,
    adapt: impl for<'body> Fn(&'body JsonObject) -> Cow<'body, JsonObject>,
) -> AppResult<PreparedProxyBody> {
    let content_encoding = headers.get("content-encoding").map(str::to_owned);
    let encoded = read_body(request).await?;
    let parsed = parse_json_body_with_source(encoded, content_encoding.as_deref())?;
    let adapted = adapt(&parsed.body);

    if matches!(adapted, Cow::Borrowed(_)) {
        return Ok(PreparedProxyBody {
            headers,
            body: Some(bytes_body(&parsed.encoded_body)),
        });
    }

    let bytes = serde_json::to_vec(adapted.as_ref()).map_err(|_| json_serialization_error())?;
    Ok(PreparedProxyBody {
        headers: json_headers(&headers),
        body: Some(bytes_body(&bytes)),
    })
}

async fn adapt_live_bootstrap(
    request: &mut Request,
    client_url: &Url,
    headers: HeaderBag,
) -> AppResult<PreparedProxyBody> {
    let content_type = headers
        .get("content-type")
        .ok_or_else(|| invalid_live_request("The live multipart body is invalid."))?;
    let bytes = match read_limited_body(request, MAX_LIVE_BOOTSTRAP_BODY_BYTES).await {
        Ok(Some(bytes)) if !bytes.is_empty() => bytes,
        Ok(_) => return Err(invalid_live_request("The live request body is empty.")),
        Err(error) if error.status == 413 => return Err(live_request_too_large()),
        Err(_) => return Err(invalid_live_request("The live multipart body is invalid.")),
    };

    let parse_headers = Headers::new();
    parse_headers
        .set("content-type", content_type)
        .map_err(|_| invalid_live_request("The live multipart body is invalid."))?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(parse_headers)
        .with_body(Some(bytes_body(&bytes)));
    let mut multipart = Request::new_with_init(client_url.as_str(), &init)
        .map_err(|_| invalid_live_request("The live multipart body is invalid."))?;
    let form = multipart
        .form_data()
        .await
        .map_err(|_| invalid_live_request("The live multipart body is invalid."))?;

    let raw_sdp = form
        .get("sdp")
        .ok_or_else(|| invalid_live_request("The live multipart body requires an 'sdp' field."))?;
    let mut payload = JsonObject::new();
    payload.insert("sdp".into(), Value::String(form_entry_text(raw_sdp).await?));
    if let Some(raw_session) = form.get("session") {
        let text = form_entry_text(raw_session).await?;
        let session = serde_json::from_str(&text).map_err(|_| {
            invalid_live_request("The live 'session' field must contain valid JSON.")
        })?;
        payload.insert("session".into(), session);
    }
    let bytes = serde_json::to_vec(&payload).map_err(|_| json_serialization_error())?;
    Ok(PreparedProxyBody {
        headers: json_headers(&headers),
        body: Some(bytes_body(&bytes)),
    })
}

async fn form_entry_text(entry: FormEntry) -> AppResult<String> {
    match entry {
        FormEntry::Field(value) => Ok(value),
        FormEntry::File(file) => file
            .bytes()
            .await
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .map_err(|_| invalid_live_request("The live multipart body is invalid.")),
    }
}

fn passthrough_body(request: &Request, method: &str, headers: HeaderBag) -> PreparedProxyBody {
    let body = (!matches!(method, "GET" | "HEAD"))
        .then(|| request.inner().body().map(JsValue::from))
        .flatten();
    PreparedProxyBody { headers, body }
}

fn is_live_multipart(pathname: &str, headers: &HeaderBag) -> bool {
    matches!(pathname, "/v1/live" | "/v1/realtime/calls")
        && headers.get("content-type").is_some_and(|value| {
            value.split(';').next().is_some_and(|media_type| {
                media_type
                    .trim()
                    .eq_ignore_ascii_case("multipart/form-data")
            })
        })
}

fn json_headers(source: &HeaderBag) -> HeaderBag {
    let mut headers = HeaderBag::new();
    for (name, value) in source.iter() {
        if !matches!(name, "content-encoding" | "content-length" | "content-type") {
            headers.append(name, value);
        }
    }
    headers.set("content-type", "application/json");
    headers
}

fn bytes_body(bytes: &[u8]) -> JsValue {
    Uint8Array::from(bytes).into()
}

fn header_bag(headers: &Headers) -> HeaderBag {
    HeaderBag::from_pairs(headers.entries())
}

fn worker_headers(headers: &HeaderBag) -> AppResult<Headers> {
    let output = Headers::new();
    for (name, value) in headers.iter() {
        output
            .append(name, value)
            .map_err(|_| invalid_upstream_headers())?;
    }
    Ok(output)
}

fn bridge_responses_websocket(response: Response, context: &Context) -> AppResult<Response> {
    let raw = WebResponse::from(&response);
    let Some(upstream) = ResponseExt::websocket(&raw).map(WebSocket::from) else {
        return Ok(response);
    };

    let status = response.status_code();
    let headers = response.headers().clone();
    let WebSocketPair { client, server } =
        WebSocketPair::new().map_err(|_| websocket_proxy_unavailable())?;
    context.wait_until(relay_responses_websockets(server, upstream));

    Ok(Response::builder()
        .with_status(status)
        .with_headers(headers)
        .with_websocket(client)
        .empty())
}

async fn relay_responses_websockets(proxy: WebSocket, upstream: WebSocket) {
    proxy.as_ref().set_binary_type(BinaryType::Arraybuffer);
    upstream.as_ref().set_binary_type(BinaryType::Arraybuffer);

    let mut client_events = match proxy.events() {
        Ok(events) => events,
        Err(_) => {
            close_pair(&proxy, &upstream, 1011, WEBSOCKET_PROXY_ERROR);
            return;
        }
    };
    let mut upstream_events = match upstream.events() {
        Ok(events) => events,
        Err(_) => {
            close_pair(&proxy, &upstream, 1011, WEBSOCKET_PROXY_ERROR);
            return;
        }
    };
    if accept_half_open(&proxy).is_err() || accept_half_open(&upstream).is_err() {
        close_pair(&proxy, &upstream, 1011, WEBSOCKET_PROXY_ERROR);
        return;
    }

    let client_to_upstream = relay_websocket_events(&mut client_events, &proxy, &upstream, true);
    let upstream_to_client = relay_websocket_events(&mut upstream_events, &upstream, &proxy, false);
    join(client_to_upstream, upstream_to_client).await;
}

async fn relay_websocket_events(
    events: &mut worker::EventStream<'_>,
    source: &WebSocket,
    target: &WebSocket,
    adapt_client_text: bool,
) {
    while let Some(event) = events.next().await {
        match event {
            Ok(WebsocketEvent::Message(message)) => {
                let result = if let Some(text) = message.text() {
                    if adapt_client_text {
                        target.send_with_str(adapt_responses_websocket_message(&text))
                    } else {
                        target.send_with_str(text)
                    }
                } else if let Some(bytes) = message.bytes() {
                    target.send_with_bytes(bytes)
                } else {
                    Err(worker::Error::RustError(
                        "unsupported WebSocket message".into(),
                    ))
                };
                if result.is_err() {
                    close_pair(source, target, 1011, WEBSOCKET_PROXY_ERROR);
                    return;
                }
            }
            Ok(WebsocketEvent::Close(event)) => {
                let code = forwardable_close_code(event.code());
                let reason = event.reason();
                close_pair(source, target, code, &reason);
                return;
            }
            Err(_) => {
                close_pair(source, target, 1011, WEBSOCKET_PROXY_ERROR);
                return;
            }
        }
    }
    close_pair(source, target, 1011, WEBSOCKET_PROXY_ERROR);
}

/// workers-rs 0.8.5 predates the typed `allowHalfOpen` option, so use its
/// re-exported Web API bindings without adding a second JS/Wasm dependency.
fn accept_half_open(socket: &WebSocket) -> worker::Result<()> {
    let this: &JsValue = socket.as_ref().as_ref();
    let accept = Reflect::get(this, &JsValue::from_str("accept"))?.dyn_into::<Function>()?;
    let options = Object::new();
    Reflect::set(
        options.as_ref(),
        &JsValue::from_str("allowHalfOpen"),
        &JsValue::TRUE,
    )?;
    accept.call1(this, options.as_ref())?;
    Ok(())
}

fn close_pair(first: &WebSocket, second: &WebSocket, code: u16, reason: &str) {
    let _ = first.close(Some(code), Some(reason));
    let _ = second.close(Some(code), Some(reason));
}

fn forwardable_close_code(code: u16) -> u16 {
    if (1000..=4999).contains(&code) && !matches!(code, 1004 | 1005 | 1006 | 1015) {
        code
    } else {
        1011
    }
}

fn fetch_error(error: &worker::Error, signal: Option<&AbortSignal>) -> ApiError {
    if signal.is_some_and(AbortSignal::aborted) || is_abort_error(error) {
        return request_aborted();
    }
    codex_unavailable()
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

fn request_aborted() -> ApiError {
    ApiError::new(408, "The request was cancelled or timed out.")
        .with_kind("request_timeout")
        .with_code("request_aborted")
}

fn codex_unavailable() -> ApiError {
    ApiError::new(502, "Unable to reach the Codex relay.")
        .with_kind("upstream_error")
        .with_code("codex_unavailable")
}

fn empty_codex_response() -> ApiError {
    ApiError::new(502, "The ChatGPT Codex backend returned an empty response.")
        .with_kind("upstream_error")
        .with_code("empty_codex_response")
}

fn invalid_upstream_headers() -> ApiError {
    ApiError::new(500, "The Codex request headers are invalid.")
        .with_kind("internal_error")
        .with_code("invalid_upstream_headers")
}

fn websocket_proxy_unavailable() -> ApiError {
    ApiError::new(502, "The Codex WebSocket proxy could not be created.")
        .with_kind("upstream_error")
        .with_code("codex_websocket_unavailable")
}

fn json_serialization_error() -> ApiError {
    ApiError::new(500, "Failed to serialize the Codex request.")
        .with_kind("internal_error")
        .with_code("json_serialization_error")
}

fn invalid_live_request(message: &str) -> ApiError {
    ApiError::new(400, message)
        .with_kind("invalid_request_error")
        .with_code("invalid_live_request")
}

fn live_request_too_large() -> ApiError {
    ApiError::new(413, "The live request body is too large.")
        .with_kind("invalid_request_error")
        .with_code("request_too_large")
}
