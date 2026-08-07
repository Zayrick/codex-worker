use std::borrow::Cow;
use std::io::Read;

use ruzstd::decoding::StreamingDecoder;
use ruzstd::decoding::errors::FrameDecoderError;
use serde_json::Value;

use crate::core::{ApiError, AppResult, JsonObject};

use super::limited_body::{BodySizeLimitError, collect_limited_body};

pub const MAX_JSON_BODY_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedJsonBody {
    pub body: JsonObject,
    /// Original, possibly compressed bytes used when forwarding the request.
    pub encoded_body: Vec<u8>,
}

/// Parses already-bounded bytes and returns only the JSON object.
pub fn parse_json_body(
    encoded_body: Option<&[u8]>,
    content_encoding: Option<&str>,
) -> AppResult<JsonObject> {
    let encoded_body = encoded_body.ok_or_else(invalid_json)?;
    parse_object(encoded_body, content_encoding)
}

/// Parses an owned body while retaining its original wire representation.
pub fn parse_json_body_with_source(
    encoded_body: Option<Vec<u8>>,
    content_encoding: Option<&str>,
) -> AppResult<ParsedJsonBody> {
    let encoded_body = encoded_body.ok_or_else(invalid_json)?;
    let body = parse_object(&encoded_body, content_encoding)?;
    Ok(ParsedJsonBody { body, encoded_body })
}

/// Collects finite chunks under the 4 MiB limit and parses their JSON object.
pub fn parse_json_body_chunks<I, B>(
    chunks: Option<I>,
    declared_content_length: Option<&str>,
    content_encoding: Option<&str>,
) -> AppResult<JsonObject>
where
    I: IntoIterator<Item = B>,
    B: AsRef<[u8]>,
{
    let encoded = collect_json_body(chunks, declared_content_length)?;
    parse_json_body(encoded.as_deref(), content_encoding)
}

/// Collects and parses chunks while retaining their original wire bytes.
pub fn parse_json_body_chunks_with_source<I, B>(
    chunks: Option<I>,
    declared_content_length: Option<&str>,
    content_encoding: Option<&str>,
) -> AppResult<ParsedJsonBody>
where
    I: IntoIterator<Item = B>,
    B: AsRef<[u8]>,
{
    let encoded = collect_json_body(chunks, declared_content_length)?;
    parse_json_body_with_source(encoded, content_encoding)
}

#[must_use]
pub fn has_zstd_encoding(content_encoding: Option<&str>) -> bool {
    content_encoding.is_some_and(|header| {
        header
            .split(',')
            .any(|encoding| encoding.trim().eq_ignore_ascii_case("zstd"))
    })
}

fn collect_json_body<I, B>(
    chunks: Option<I>,
    declared_content_length: Option<&str>,
) -> AppResult<Option<Vec<u8>>>
where
    I: IntoIterator<Item = B>,
    B: AsRef<[u8]>,
{
    collect_limited_body(chunks, declared_content_length, MAX_JSON_BODY_BYTES)
        .map_err(|_| request_too_large())
}

fn parse_object(encoded: &[u8], content_encoding: Option<&str>) -> AppResult<JsonObject> {
    if encoded.len() > MAX_JSON_BODY_BYTES {
        return Err(request_too_large());
    }
    let decoded = if has_zstd_encoding(content_encoding) {
        decode_zstd_bounded(encoded, MAX_JSON_BODY_BYTES)?
    } else {
        Cow::Borrowed(encoded)
    };

    // TextDecoder replaces malformed UTF-8, so preserve that compatibility
    // before serde_json validates the resulting JSON text.
    let text = String::from_utf8_lossy(&decoded);
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(object)) => Ok(object),
        _ => Err(invalid_json()),
    }
}

fn decode_zstd_bounded(encoded: &[u8], max_bytes: usize) -> AppResult<Cow<'_, [u8]>> {
    let mut decoder = match StreamingDecoder::new_with_max_window_size(encoded, max_bytes as u64) {
        Ok(decoder) => decoder,
        Err(FrameDecoderError::WindowSizeTooBig { .. }) => return Err(request_too_large()),
        // Some clients transparently decompress while retaining this header.
        Err(_) => return Ok(Cow::Borrowed(encoded)),
    };

    let mut decoded = Vec::with_capacity(encoded.len().min(max_bytes));
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        let remaining = max_bytes.saturating_sub(decoded.len());
        let read_limit = buffer.len().min(remaining.saturating_add(1));
        match decoder.read(&mut buffer[..read_limit]) {
            Ok(0) => return Ok(Cow::Owned(decoded)),
            Ok(read) if read > remaining => return Err(request_too_large()),
            Ok(read) => decoded.extend_from_slice(&buffer[..read]),
            // Match the retained-header fallback for malformed zstd streams.
            Err(_) => return Ok(Cow::Borrowed(encoded)),
        }
    }
}

fn invalid_json() -> ApiError {
    ApiError::new(400, "The request body is not valid JSON.")
        .with_kind("invalid_request_error")
        .with_code("invalid_json")
}

fn request_too_large() -> ApiError {
    ApiError::new(413, "The request body is too large.")
        .with_kind("invalid_request_error")
        .with_code("request_too_large")
}

impl From<BodySizeLimitError> for ApiError {
    fn from(_: BodySizeLimitError) -> Self {
        request_too_large()
    }
}

#[cfg(test)]
mod tests {
    use ruzstd::encoding::{CompressionLevel, compress_to_vec};
    use serde_json::json;

    use super::*;

    #[test]
    fn parses_an_object_and_retains_encoded_bytes() {
        let encoded = br#"{"model":"gpt-5","stream":true}"#.to_vec();
        let parsed =
            parse_json_body_with_source(Some(encoded.clone()), None).expect("valid JSON object");
        assert_eq!(parsed.body["model"], "gpt-5");
        assert_eq!(parsed.encoded_body, encoded);
    }

    #[test]
    fn rejects_missing_empty_and_non_object_json() {
        for encoded in [None, Some(b"".as_slice()), Some(b"[]".as_slice())] {
            let error = parse_json_body(encoded, None).expect_err("body must be rejected");
            assert_eq!(error.status, 400);
            assert_eq!(error.code.as_deref(), Some("invalid_json"));
        }
    }

    #[test]
    fn recognizes_comma_separated_zstd_case_insensitively() {
        assert!(has_zstd_encoding(Some("gzip, ZSTD")));
        assert!(!has_zstd_encoding(Some("gzip, br")));
        assert!(!has_zstd_encoding(None));
    }

    #[test]
    fn decodes_zstd_and_preserves_the_compressed_source() {
        let plain = br#"{"input":"hello"}"#;
        let encoded = compress_to_vec(plain.as_slice(), CompressionLevel::Fastest);
        let parsed = parse_json_body_with_source(Some(encoded.clone()), Some("zstd"))
            .expect("valid zstd JSON");
        assert_eq!(
            parsed.body,
            json!({"input": "hello"}).as_object().unwrap().clone()
        );
        assert_eq!(parsed.encoded_body, encoded);
    }

    #[test]
    fn accepts_transparently_decoded_bytes_with_a_retained_zstd_header() {
        let parsed = parse_json_body(Some(br#"{"input":"hello"}"#), Some("zstd"))
            .expect("raw JSON fallback");
        assert_eq!(parsed["input"], "hello");
    }

    #[test]
    fn bounds_decompressed_output() {
        let encoded = compress_to_vec(b"123456789".as_slice(), CompressionLevel::Fastest);
        let error = decode_zstd_bounded(&encoded, 8).expect_err("decoded body is too large");
        assert_eq!(error.status, 413);
        assert_eq!(error.code.as_deref(), Some("request_too_large"));
    }

    #[test]
    fn bounds_encoded_input_even_when_called_without_the_collector() {
        let encoded = vec![b' '; MAX_JSON_BODY_BYTES + 1];
        let error = parse_json_body(Some(&encoded), None).expect_err("encoded body is too large");
        assert_eq!(error.status, 413);
    }
}
