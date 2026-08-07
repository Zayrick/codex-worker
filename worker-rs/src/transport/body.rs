use futures_util::StreamExt;
use worker::{Request, Response, ResponseBody};

use crate::{
    core::{ApiError, AppResult, JsonObject},
    http::{LimitedBodyCollector, MAX_JSON_BODY_BYTES, parse_json_body},
};

pub async fn request_json(request: &mut Request) -> AppResult<JsonObject> {
    let content_encoding = request
        .headers()
        .get("content-encoding")
        .map_err(|_| invalid_json())?;
    let bytes = read_limited_body(request, MAX_JSON_BODY_BYTES).await?;
    parse_json_body(bytes.as_deref(), content_encoding.as_deref())
}

pub async fn read_limited_body(
    request: &mut Request,
    max_bytes: usize,
) -> AppResult<Option<Vec<u8>>> {
    let raw_stream = request.inner().body();
    let declared_length = match request.headers().get("content-length") {
        Ok(length) => length,
        Err(_) => {
            cancel_readable_stream(raw_stream.as_ref()).await;
            return Err(body_unavailable());
        }
    };
    let mut collector = match LimitedBodyCollector::new(max_bytes, declared_length.as_deref()) {
        Ok(collector) => collector,
        Err(_) => {
            cancel_readable_stream(raw_stream.as_ref()).await;
            return Err(request_too_large(max_bytes));
        }
    };

    if raw_stream.is_none() {
        return Ok(None);
    }
    let mut source = match request.stream() {
        Ok(source) => source,
        Err(_) => {
            cancel_readable_stream(raw_stream.as_ref()).await;
            return Err(body_unavailable());
        }
    };
    while let Some(chunk) = source.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(_) => {
                drop(source);
                cancel_readable_stream(raw_stream.as_ref()).await;
                return Err(body_unavailable());
            }
        };
        if collector.push_chunk(&chunk).is_err() {
            drop(source);
            cancel_readable_stream(raw_stream.as_ref()).await;
            return Err(request_too_large(max_bytes));
        }
    }
    Ok(Some(collector.finish()))
}

pub async fn read_limited_response(
    response: &mut Response,
    max_bytes: usize,
) -> AppResult<Vec<u8>> {
    let raw_stream = match response.body() {
        ResponseBody::Stream(stream) => Some(stream.clone()),
        ResponseBody::Empty | ResponseBody::Body(_) => None,
    };
    let declared_length = match response.headers().get("content-length") {
        Ok(length) => length,
        Err(_) => {
            cancel_readable_stream(raw_stream.as_ref()).await;
            return Err(response_unavailable());
        }
    };
    let mut collector = match LimitedBodyCollector::new(max_bytes, declared_length.as_deref()) {
        Ok(collector) => collector,
        Err(_) => {
            cancel_readable_stream(raw_stream.as_ref()).await;
            return Err(response_unavailable());
        }
    };
    match response.body() {
        ResponseBody::Empty => return Ok(Vec::new()),
        ResponseBody::Body(bytes) => {
            collector
                .push_chunk(bytes)
                .map_err(|_| response_unavailable())?;
            return Ok(collector.finish());
        }
        ResponseBody::Stream(_) => {}
    }
    let mut source = match response.stream() {
        Ok(source) => source,
        Err(_) => {
            cancel_readable_stream(raw_stream.as_ref()).await;
            return Err(response_unavailable());
        }
    };
    while let Some(chunk) = source.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(_) => {
                drop(source);
                cancel_readable_stream(raw_stream.as_ref()).await;
                return Err(response_unavailable());
            }
        };
        if collector.push_chunk(&chunk).is_err() {
            drop(source);
            cancel_readable_stream(raw_stream.as_ref()).await;
            return Err(response_unavailable());
        }
    }
    Ok(collector.finish())
}

pub async fn cancel_readable_stream(stream: Option<&worker::web_sys::ReadableStream>) {
    if let Some(stream) = stream {
        let _ = worker::wasm_bindgen_futures::JsFuture::from(stream.cancel()).await;
    }
}

fn invalid_json() -> ApiError {
    ApiError::new(400, "The request body is not valid JSON.")
        .with_kind("invalid_request_error")
        .with_code("invalid_json")
}

fn body_unavailable() -> ApiError {
    ApiError::new(400, "The request body could not be read.")
        .with_kind("invalid_request_error")
        .with_code("invalid_request_body")
}

fn request_too_large(max_bytes: usize) -> ApiError {
    let message = if max_bytes == MAX_JSON_BODY_BYTES {
        "The request body is too large.".to_owned()
    } else {
        "The management request body is too large.".to_owned()
    };
    ApiError::new(413, message)
        .with_kind("invalid_request_error")
        .with_code("request_too_large")
}

fn response_unavailable() -> ApiError {
    ApiError::new(502, "The Codex backend returned an invalid response.")
        .with_kind("upstream_error")
        .with_code("invalid_codex_response")
}
