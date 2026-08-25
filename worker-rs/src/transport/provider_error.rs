//! Cloudflare transport adapters for provider-specific upstream errors.
//!
//! Provider protocol modules own the JSON envelopes. This module only performs
//! bounded body I/O, cancellation, and the response-header policy.

use futures_util::StreamExt;
use serde::Serialize;
use serde_json::Value;
use worker::{Headers, Response, ResponseBody};

use crate::{
    http::LimitedBodyCollector,
    protocol::{anthropic, gemini},
};

use super::body::cancel_readable_stream;

const GEMINI_MAX_UPSTREAM_ERROR_BYTES: usize = 1024 * 1024;

/// Headers that are useful to clients and safe to copy onto a newly encoded
/// JSON error. Entity, hop-by-hop, cookie, and arbitrary upstream headers are
/// deliberately excluded.
const FORWARDED_ERROR_HEADERS: &[&str] = &[
    "Retry-After",
    "Request-Id",
    "X-Request-Id",
    "OpenAI-Request-Id",
    "X-Codex-Turn-State",
    "X-Goog-Request-Id",
];

/// Converts a Codex upstream failure to the Anthropic Messages error schema.
pub async fn anthropic_upstream_error_response(mut upstream: Response) -> worker::Result<Response> {
    let status = upstream.status_code();
    let source_headers = ForwardedHeaders::capture(upstream.headers());
    let request_id = source_headers.anthropic_request_id().map(str::to_owned);
    let body = read_bounded_body(&mut upstream, anthropic::MAX_UPSTREAM_ERROR_BYTES)
        .await
        .unwrap_or_default();
    let payload = anthropic::anthropic_upstream_error_payload(status, &body, request_id.as_deref());

    json_error_response(status, &payload, &source_headers, request_id.as_deref())
}

/// Converts a Codex upstream failure to the Google JSON error schema.
pub async fn gemini_upstream_error_response(mut upstream: Response) -> worker::Result<Response> {
    let status = upstream.status_code();
    let source_headers = ForwardedHeaders::capture(upstream.headers());
    let body = read_bounded_body(&mut upstream, GEMINI_MAX_UPSTREAM_ERROR_BYTES).await;
    let parsed = body
        .as_deref()
        .and_then(|bytes| serde_json::from_slice::<Value>(bytes).ok());
    let error = gemini::gemini_upstream_error(status, parsed.as_ref());
    let payload = gemini::gemini_error_payload(&error);

    json_error_response(status, &payload, &source_headers, None)
}

#[derive(Debug, Default)]
struct ForwardedHeaders {
    values: Vec<(&'static str, String)>,
}

impl ForwardedHeaders {
    fn capture(source: &Headers) -> Self {
        let values = FORWARDED_ERROR_HEADERS
            .iter()
            .filter_map(|&name| trimmed_header(source, name).map(|value| (name, value)))
            .collect();
        Self { values }
    }

    fn get(&self, name: &str) -> Option<&str> {
        self.values
            .iter()
            .find(|(candidate, _)| candidate.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    fn anthropic_request_id(&self) -> Option<&str> {
        ["Request-Id", "X-Request-Id", "OpenAI-Request-Id"]
            .into_iter()
            .find_map(|name| self.get(name))
    }
}

fn trimmed_header(headers: &Headers, name: &str) -> Option<String> {
    headers
        .get(name)
        .ok()
        .flatten()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn json_error_response<T: Serialize + ?Sized>(
    status: u16,
    payload: &T,
    source_headers: &ForwardedHeaders,
    canonical_request_id: Option<&str>,
) -> worker::Result<Response> {
    let body = serde_json::to_vec(payload)
        .map_err(|_| worker::Error::RustError("Failed to serialize the JSON response.".into()))?;
    let headers = Headers::new();
    headers.set("Content-Type", "application/json; charset=utf-8")?;
    headers.set("Cache-Control", "no-store")?;
    for (name, value) in &source_headers.values {
        headers.set(name, value)?;
    }
    if let Some(request_id) = canonical_request_id {
        // Anthropic clients inspect both spellings; emit the canonical value as both.
        headers.set("Request-Id", request_id)?;
        headers.set("X-Request-Id", request_id)?;
    }

    Ok(Response::builder()
        .with_status(status)
        .with_headers(headers)
        .fixed(body))
}

/// Returns `None` for missing, oversized, or unreadable bodies. Callers use
/// that single outcome to produce a provider-safe fallback message.
async fn read_bounded_body(upstream: &mut Response, max_bytes: usize) -> Option<Vec<u8>> {
    let declared_length = trimmed_header(upstream.headers(), "Content-Length");
    let raw_stream = match upstream.body() {
        ResponseBody::Stream(stream) => Some(stream.clone()),
        ResponseBody::Empty | ResponseBody::Body(_) => None,
    };
    let mut collector = match LimitedBodyCollector::new(max_bytes, declared_length.as_deref()) {
        Ok(collector) => collector,
        Err(_) => {
            cancel_readable_stream(raw_stream.as_ref()).await;
            return None;
        }
    };

    match upstream.body() {
        ResponseBody::Empty => {}
        ResponseBody::Body(bytes) => {
            if collector.push_chunk(bytes).is_err() {
                return None;
            }
        }
        ResponseBody::Stream(_) => {
            let mut source = match upstream.stream() {
                Ok(source) => source,
                Err(_) => {
                    cancel_readable_stream(raw_stream.as_ref()).await;
                    return None;
                }
            };
            while let Some(chunk) = source.next().await {
                let Ok(chunk) = chunk else {
                    // Dropping worker::ByteStream cancels its active reader. A
                    // direct best-effort cancellation also covers readers that
                    // have already transitioned to an errored/unlocked state.
                    drop(source);
                    cancel_readable_stream(raw_stream.as_ref()).await;
                    return None;
                };
                if collector.push_chunk(&chunk).is_err() {
                    drop(source);
                    cancel_readable_stream(raw_stream.as_ref()).await;
                    return None;
                }
            }
        }
    }

    Some(collector.finish())
}
