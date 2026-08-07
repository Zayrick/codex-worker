//! Runtime-neutral HTTP policies and wire-format helpers.
//!
//! Cloudflare request/response types intentionally do not cross this module
//! boundary. Transports collect byte chunks into [`LimitedBodyCollector`] and
//! translate [`ResponseDto`] values to their runtime-specific equivalents.

mod body;
mod limited_body;
mod response;
mod sse_encoder;

pub use body::{ParsedJsonBody, has_zstd_encoding, parse_json_body, parse_json_body_with_source};
pub use limited_body::{BodySizeLimitError, LimitedBodyCollector, collect_limited_body};
pub use response::{
    BLOCKED_PROXY_RESPONSE_HEADERS, CORS_ALLOWED_HEADERS, CORS_EXPOSED_HEADERS, HeaderDto,
    HeadersDto, ResponseBodyDto, ResponseDto, chat_sse_response, empty_response,
    event_stream_response, html_response, json_response, upstream_error_response,
    upstream_json_response, upstream_proxy_response, with_cors,
};
pub use sse_encoder::{SSE_DONE, named_sse_event, sse_data};
