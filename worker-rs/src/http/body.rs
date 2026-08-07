use std::borrow::Cow;
use std::io::Read;

use ruzstd::decoding::StreamingDecoder;
use serde_json::Value;

use crate::core::{ApiError, AppResult, JsonObject};

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedJsonBody {
    pub body: JsonObject,
    /// Original, possibly compressed bytes used when forwarding the request.
    pub encoded_body: Vec<u8>,
}

/// Parses request bytes and returns only the JSON object.
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

#[must_use]
pub fn has_zstd_encoding(content_encoding: Option<&str>) -> bool {
    content_encoding.is_some_and(|header| {
        header
            .split(',')
            .any(|encoding| encoding.trim().eq_ignore_ascii_case("zstd"))
    })
}

fn parse_object(encoded: &[u8], content_encoding: Option<&str>) -> AppResult<JsonObject> {
    let decoded = if has_zstd_encoding(content_encoding) {
        decode_zstd(encoded)
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

fn decode_zstd(encoded: &[u8]) -> Cow<'_, [u8]> {
    let mut decoder = match StreamingDecoder::new(encoded) {
        Ok(decoder) => decoder,
        // Some clients transparently decompress while retaining this header.
        Err(_) => return Cow::Borrowed(encoded),
    };

    let mut decoded = Vec::with_capacity(encoded.len());
    if decoder.read_to_end(&mut decoded).is_err() {
        // Match the retained-header fallback for malformed zstd streams.
        return Cow::Borrowed(encoded);
    }
    Cow::Owned(decoded)
}

fn invalid_json() -> ApiError {
    ApiError::new(400, "The request body is not valid JSON.")
        .with_kind("invalid_request_error")
        .with_code("invalid_json")
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
    fn parses_large_plain_and_zstd_objects() {
        let input = "x".repeat(5 * 1024 * 1024);
        let plain = serde_json::to_vec(&json!({ "input": input })).expect("serializable JSON");
        let parsed = parse_json_body(Some(&plain), None).expect("large plain JSON");
        assert_eq!(
            parsed["input"].as_str().map(str::len),
            Some(5 * 1024 * 1024)
        );

        let encoded = compress_to_vec(plain.as_slice(), CompressionLevel::Fastest);
        let parsed = parse_json_body(Some(&encoded), Some("zstd")).expect("large zstd JSON");
        assert_eq!(
            parsed["input"].as_str().map(str::len),
            Some(5 * 1024 * 1024)
        );
    }
}
