//! Incremental, bounded SSE framing and Codex event decoding.

use serde_json::Value;

use crate::core::{AppResult, JsonObject};

use super::codex_stream_failed;

pub const MAX_SSE_EVENT_CHARS: usize = 8 * 1024 * 1024;
pub const SSE_DONE: &str = "data: [DONE]\n\n";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SseFrame {
    Data(String),
    Done,
}

/// Incremental UTF-8/SSE framing shared by Responses and Completion adapters.
///
/// The retained event is capped in UTF-16 code units to preserve JavaScript's
/// `String.length` behavior. A split UTF-8 tail retains at most three bytes.
#[derive(Debug, Clone, Default)]
pub struct SseFrameDecoder {
    buffer: String,
    buffer_chars: usize,
    utf8_tail: Vec<u8>,
}

impl SseFrameDecoder {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push_bytes(&mut self, bytes: &[u8]) -> AppResult<Vec<SseFrame>> {
        let mut frames = Vec::new();
        let mut offset = 0;
        if let Some(first) = self.utf8_tail.first().copied() {
            let width = utf8_width(first).ok_or_else(codex_stream_failed)?;
            if self.utf8_tail.len() >= width {
                self.reset();
                return Err(codex_stream_failed());
            }
            let needed = width - self.utf8_tail.len();
            let taken = needed.min(bytes.len());
            let mut prefix = std::mem::take(&mut self.utf8_tail);
            prefix.extend_from_slice(&bytes[..taken]);
            offset = taken;
            if prefix.len() < width {
                self.utf8_tail = prefix;
                return Ok(frames);
            }
            let decoded = std::str::from_utf8(&prefix).map_err(|_| codex_stream_failed())?;
            self.push_decoded(decoded, &mut frames)?;
        }
        if offset < bytes.len() {
            self.decode_slice(&bytes[offset..], &mut frames)?;
        }
        self.verify_retained_limit()?;
        Ok(frames)
    }

    pub fn push_str(&mut self, chunk: &str) -> AppResult<Vec<SseFrame>> {
        if !self.utf8_tail.is_empty() {
            return Err(codex_stream_failed());
        }
        let mut frames = Vec::new();
        self.push_decoded(chunk, &mut frames)?;
        self.verify_retained_limit()?;
        Ok(frames)
    }

    pub fn finish(&mut self) -> AppResult<Vec<SseFrame>> {
        if !self.utf8_tail.is_empty() {
            self.reset();
            return Err(codex_stream_failed());
        }
        if self.buffer.trim().is_empty() {
            self.reset();
            return Ok(Vec::new());
        }
        let block = std::mem::take(&mut self.buffer);
        self.buffer_chars = 0;
        Ok(parse_frame(&block).into_iter().collect())
    }

    fn decode_slice(&mut self, bytes: &[u8], frames: &mut Vec<SseFrame>) -> AppResult<()> {
        match std::str::from_utf8(bytes) {
            Ok(decoded) => self.push_decoded(decoded, frames),
            Err(error) => {
                let valid = &bytes[..error.valid_up_to()];
                if !valid.is_empty() {
                    let decoded = std::str::from_utf8(valid).map_err(|_| codex_stream_failed())?;
                    self.push_decoded(decoded, frames)?;
                }
                if error.error_len().is_some() {
                    return Err(codex_stream_failed());
                }
                let tail = &bytes[error.valid_up_to()..];
                if tail.len() > 3 {
                    return Err(codex_stream_failed());
                }
                self.utf8_tail.extend_from_slice(tail);
                Ok(())
            }
        }
    }

    fn push_decoded(&mut self, chunk: &str, frames: &mut Vec<SseFrame>) -> AppResult<()> {
        for character in chunk.chars() {
            if character == '\r' {
                continue;
            }
            self.buffer.push(character);
            self.buffer_chars = self
                .buffer_chars
                .checked_add(character.len_utf16())
                .ok_or_else(codex_stream_failed)?;
            if self.buffer.ends_with("\n\n") {
                let new_len = self.buffer.len().saturating_sub(2);
                self.buffer.truncate(new_len);
                if utf16_len(&self.buffer) > MAX_SSE_EVENT_CHARS {
                    self.reset();
                    return Err(codex_stream_failed());
                }
                let block = std::mem::take(&mut self.buffer);
                self.buffer_chars = 0;
                if let Some(frame) = parse_frame(&block) {
                    frames.push(frame);
                }
            } else if self.buffer_chars > MAX_SSE_EVENT_CHARS + 1
                || (self.buffer_chars > MAX_SSE_EVENT_CHARS && !self.buffer.ends_with('\n'))
            {
                self.reset();
                return Err(codex_stream_failed());
            }
        }
        Ok(())
    }

    fn verify_retained_limit(&mut self) -> AppResult<()> {
        if self.buffer_chars > MAX_SSE_EVENT_CHARS {
            self.reset();
            return Err(codex_stream_failed());
        }
        Ok(())
    }

    fn reset(&mut self) {
        self.buffer.clear();
        self.buffer_chars = 0;
        self.utf8_tail.clear();
    }
}

/// Codex-specific wrapper that parses data frames as JSON objects and ignores
/// the terminal `[DONE]` marker, matching the original async generator.
#[derive(Debug, Clone, Default)]
pub struct SseDecoder {
    frames: SseFrameDecoder,
}

impl SseDecoder {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push_bytes(&mut self, bytes: &[u8]) -> AppResult<Vec<JsonObject>> {
        parse_json_frames(self.frames.push_bytes(bytes)?)
    }

    pub fn push_str(&mut self, chunk: &str) -> AppResult<Vec<JsonObject>> {
        parse_json_frames(self.frames.push_str(chunk)?)
    }

    pub fn finish(&mut self) -> AppResult<Vec<JsonObject>> {
        parse_json_frames(self.frames.finish()?)
    }
}

fn parse_json_frames(frames: Vec<SseFrame>) -> AppResult<Vec<JsonObject>> {
    let mut events = Vec::new();
    for frame in frames {
        let SseFrame::Data(data) = frame else {
            continue;
        };
        match serde_json::from_str::<Value>(&data) {
            Ok(Value::Object(event)) => events.push(event),
            _ => return Err(codex_stream_failed()),
        }
    }
    Ok(events)
}

fn parse_frame(block: &str) -> Option<SseFrame> {
    let mut data = String::new();
    for line in block.lines() {
        let Some(value) = line.strip_prefix("data:") else {
            continue;
        };
        if !data.is_empty() {
            data.push('\n');
        }
        data.push_str(value.trim_start());
    }
    if data.trim().is_empty() {
        None
    } else if data.trim() == "[DONE]" {
        Some(SseFrame::Done)
    } else {
        Some(SseFrame::Data(data))
    }
}

pub(crate) fn utf16_len(value: &str) -> usize {
    value.chars().map(char::len_utf16).sum()
}

fn utf8_width(first: u8) -> Option<usize> {
    match first {
        0x00..=0x7f => Some(1),
        0xc2..=0xdf => Some(2),
        0xe0..=0xef => Some(3),
        0xf0..=0xf4 => Some(4),
        _ => None,
    }
}

pub(crate) fn sse_data(value: &Value) -> AppResult<String> {
    let encoded = serde_json::to_string(value).map_err(|_| codex_stream_failed())?;
    Ok(format!("data: {encoded}\n\n"))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn decodes_crlf_comments_multiline_data_and_split_utf8() {
        let source = concat!(
            ": keepalive\r\n\r\n",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\r\n",
            "data: \"你\"}\r\n\r\n"
        );
        let bytes = source.as_bytes();
        let split = bytes
            .iter()
            .position(|byte| *byte == 0xe4)
            .unwrap_or(bytes.len());
        let mut decoder = SseDecoder::new();
        let mut events = decoder
            .push_bytes(&bytes[..split.saturating_add(1).min(bytes.len())])
            .unwrap_or_default();
        events.extend(
            decoder
                .push_bytes(&bytes[split.saturating_add(1).min(bytes.len())..])
                .unwrap_or_default(),
        );
        events.extend(decoder.finish().unwrap_or_default());
        assert_eq!(
            events,
            vec![
                json!({"type":"response.output_text.delta","delta":"你"})
                    .as_object()
                    .cloned()
                    .unwrap_or_default()
            ]
        );
    }

    #[test]
    fn raw_framer_preserves_done_for_downstream_presenters() {
        let mut decoder = SseFrameDecoder::new();
        assert_eq!(
            decoder.push_str("data: [DONE]\n\n").unwrap_or_default(),
            vec![SseFrame::Done]
        );
    }

    #[test]
    fn rejects_malformed_invalid_utf8_and_oversized_events() {
        let mut malformed = SseDecoder::new();
        assert!(malformed.push_str("data: {bad}\n\n").is_err());
        let mut invalid_utf8 = SseDecoder::new();
        assert!(invalid_utf8.push_bytes(&[0xff]).is_err());
        let mut oversized = SseDecoder::new();
        assert!(
            oversized
                .push_str(&"x".repeat(MAX_SSE_EVENT_CHARS + 1))
                .is_err()
        );
    }

    #[test]
    fn rejects_an_incomplete_utf8_tail_at_eof() {
        let mut decoder = SseDecoder::new();
        assert!(decoder.push_bytes(&[0xe4]).is_ok());
        assert!(decoder.finish().is_err());
    }

    #[test]
    fn decodes_adjacent_multibyte_characters_across_a_split() {
        let source = "data: {\"type\":\"delta\",\"delta\":\"你好\"}\n\n";
        let bytes = source.as_bytes();
        let split = bytes
            .iter()
            .position(|byte| *byte == 0xe4)
            .unwrap_or(bytes.len());
        let mut decoder = SseDecoder::new();
        let mut events = decoder
            .push_bytes(&bytes[..split.saturating_add(1).min(bytes.len())])
            .unwrap_or_default();
        events.extend(
            decoder
                .push_bytes(&bytes[split.saturating_add(1).min(bytes.len())..])
                .unwrap_or_default(),
        );
        assert_eq!(
            events.first().and_then(|event| event.get("delta")),
            Some(&json!("你好"))
        );
    }
}
