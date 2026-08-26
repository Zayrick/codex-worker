use serde::Serialize;
use worker::{EncodeBody, Headers, Response};

use crate::{
    core::ApiError,
    http::{self, HeadersDto, ResponseBodyDto, ResponseDto},
};

pub fn empty(status: u16) -> worker::Result<Response> {
    from_dto(http::empty_response(status))
}

pub fn json<T: Serialize>(value: &T, status: u16) -> worker::Result<Response> {
    from_dto(
        http::json_response(value, status)
            .map_err(|error| worker::Error::RustError(error.to_string()))?,
    )
}

pub fn api_error(error: &ApiError) -> worker::Result<Response> {
    json(&error.openai_payload(), error.status)
}

pub fn with_cors(response: Response, origin: &str) -> worker::Result<Response> {
    let policy = http::with_cors(
        ResponseDto {
            status: response.status_code(),
            status_text: String::new(),
            headers: headers_dto(response.headers()),
            body: ResponseBodyDto::Passthrough,
            websocket: false,
            encode_body_manual: false,
        },
        origin,
    );
    let (builder, body) = response.into_parts();
    let mut next = builder
        .with_headers(worker_headers(&policy.headers)?)
        .body(body);
    if policy.encode_body_manual {
        next = next.with_encode_body(EncodeBody::Manual);
    }
    Ok(next)
}

pub fn upstream_json(response: Response) -> worker::Result<Response> {
    apply_upstream_policy(response, http::upstream_json_response)
}

pub fn upstream_error(response: Response) -> worker::Result<Response> {
    apply_upstream_policy(response, http::upstream_error_response)
}

pub fn upstream_proxy(response: Response) -> worker::Result<Response> {
    apply_upstream_policy(response, http::upstream_proxy_response)
}

pub fn suppress_html_body(response: Response) -> worker::Result<Response> {
    if response.status_code() == 101
        || !response
            .headers()
            .get("content-type")?
            .as_deref()
            .is_some_and(http::is_html_content_type)
    {
        return Ok(response);
    }
    let policy = http::suppress_html_body(ResponseDto {
        status: response.status_code(),
        status_text: String::new(),
        headers: headers_dto(response.headers()),
        body: ResponseBodyDto::Passthrough,
        websocket: false,
        encode_body_manual: matches!(response.encode_body(), EncodeBody::Manual),
    });
    let (builder, _) = response.into_parts();
    Ok(builder
        .with_headers(worker_headers(&policy.headers)?)
        .with_encode_body(EncodeBody::Automatic)
        .empty())
}

fn apply_upstream_policy(
    response: Response,
    policy: impl FnOnce(ResponseDto) -> ResponseDto,
) -> worker::Result<Response> {
    let head = ResponseDto {
        status: response.status_code(),
        status_text: String::new(),
        headers: headers_dto(response.headers()),
        body: ResponseBodyDto::Passthrough,
        websocket: false,
        encode_body_manual: false,
    };
    let policy = policy(head);
    let (builder, body) = response.into_parts();
    let mut response = builder
        .with_headers(worker_headers(&policy.headers)?)
        .body(body);
    if policy.encode_body_manual {
        response = response.with_encode_body(EncodeBody::Manual);
    }
    Ok(response)
}

pub fn headers_dto(source: &Headers) -> HeadersDto {
    HeadersDto::from_pairs(source.entries())
}

pub fn worker_headers(source: &HeadersDto) -> worker::Result<Headers> {
    let headers = Headers::new();
    for (name, value) in source.iter() {
        headers.append(name, value)?;
    }
    Ok(headers)
}

fn from_dto(response: ResponseDto) -> worker::Result<Response> {
    let builder = Response::builder()
        .with_status(response.status)
        .with_headers(worker_headers(&response.headers)?);
    let mut response = match response.body {
        ResponseBodyDto::Empty => builder.empty(),
        ResponseBodyDto::Bytes(bytes) => builder.fixed(bytes),
        ResponseBodyDto::Passthrough | ResponseBodyDto::EventStream => {
            return Err(worker::Error::RustError(
                "response DTO requires a runtime body".into(),
            ));
        }
    };
    if response.headers().has("content-encoding")? {
        response = response.with_encode_body(EncodeBody::Manual);
    }
    Ok(response)
}
