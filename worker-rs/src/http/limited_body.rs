use thiserror::Error;

/// Deterministic signal for transports to stop/cancel their body source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
#[error("Body exceeds the {max_bytes}-byte limit.")]
pub struct BodySizeLimitError {
    pub max_bytes: usize,
}

impl BodySizeLimitError {
    #[must_use]
    pub const fn new(max_bytes: usize) -> Self {
        Self { max_bytes }
    }
}

/// Incrementally collects a body without ever retaining more than `max_bytes`.
///
/// Runtime adapters remain responsible for reading and cancelling their own I/O
/// source. A failure from [`Self::push_chunk`] is the cancellation signal.
#[derive(Debug)]
pub struct LimitedBodyCollector {
    bytes: Vec<u8>,
    max_bytes: usize,
}

impl LimitedBodyCollector {
    /// Creates a collector and performs the cheap `Content-Length` preflight.
    ///
    pub fn new(
        max_bytes: usize,
        declared_content_length: Option<&str>,
    ) -> Result<Self, BodySizeLimitError> {
        let declared = declared_content_length.and_then(|value| value.trim().parse::<usize>().ok());
        if declared.is_some_and(|length| length > max_bytes) {
            return Err(BodySizeLimitError::new(max_bytes));
        }

        // A declared length is only a hint. Cap eager allocation so a valid but
        // very large limit cannot turn the preflight itself into an OOM hazard.
        let initial_capacity = declared.map_or(0, |length| length.min(max_bytes).min(64 * 1024));
        Ok(Self {
            bytes: Vec::with_capacity(initial_capacity),
            max_bytes,
        })
    }

    /// Adds one transport-owned byte chunk.
    pub fn push_chunk(&mut self, chunk: &[u8]) -> Result<(), BodySizeLimitError> {
        if chunk.len() > self.max_bytes.saturating_sub(self.bytes.len()) {
            return Err(BodySizeLimitError::new(self.max_bytes));
        }
        self.bytes.extend_from_slice(chunk);
        Ok(())
    }

    #[must_use]
    pub fn finish(self) -> Vec<u8> {
        self.bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_body_exactly_at_the_limit() {
        let mut collector = LimitedBodyCollector::new(3, Some("3")).unwrap();
        collector.push_chunk(b"ab").unwrap();
        collector.push_chunk(b"c").unwrap();
        assert_eq!(collector.finish(), b"abc");
    }

    #[test]
    fn rejects_an_oversized_declared_length_before_collecting() {
        let error = LimitedBodyCollector::new(3, Some("4"))
            .expect_err("declared length should be rejected");
        assert_eq!(error, BodySizeLimitError::new(3));
    }

    #[test]
    fn rejects_an_oversized_observed_length_without_retaining_the_chunk() {
        let mut collector = LimitedBodyCollector::new(3, None).expect("valid collector");
        collector.push_chunk(b"ab").expect("first chunk fits");
        assert_eq!(collector.push_chunk(b"cd"), Err(BodySizeLimitError::new(3)));
        assert_eq!(collector.finish(), b"ab");
    }
}
