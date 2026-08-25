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

    /// Size failures always make further reads unnecessary.
    #[must_use]
    pub const fn should_cancel_source(self) -> bool {
        true
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
    rejected: bool,
}

impl LimitedBodyCollector {
    /// Creates a collector and performs the cheap `Content-Length` preflight.
    ///
    /// Parsing follows JavaScript's `Number.parseInt(value, 10)`: a decimal
    /// prefix is accepted, malformed or non-finite values are ignored, and
    /// negative values do not trigger the upper bound.
    pub fn new(
        max_bytes: usize,
        declared_content_length: Option<&str>,
    ) -> Result<Self, BodySizeLimitError> {
        let declared = declared_content_length.and_then(parse_decimal_prefix);
        if declared.is_some_and(|length| length > max_bytes as f64) {
            return Err(BodySizeLimitError::new(max_bytes));
        }

        // A declared length is only a hint. Cap eager allocation so a valid but
        // very large limit cannot turn the preflight itself into an OOM hazard.
        let initial_capacity = declared
            .filter(|length| *length >= 0.0)
            .map_or(0, |length| (length as usize).min(max_bytes).min(64 * 1024));
        Ok(Self {
            bytes: Vec::with_capacity(initial_capacity),
            max_bytes,
            rejected: false,
        })
    }

    /// Adds one transport-owned byte chunk.
    pub fn push_chunk(&mut self, chunk: &[u8]) -> Result<(), BodySizeLimitError> {
        if self.rejected || chunk.len() > self.max_bytes.saturating_sub(self.bytes.len()) {
            self.rejected = true;
            return Err(BodySizeLimitError::new(self.max_bytes));
        }
        self.bytes.extend_from_slice(chunk);
        Ok(())
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    #[must_use]
    pub fn remaining(&self) -> usize {
        self.max_bytes.saturating_sub(self.bytes.len())
    }

    #[must_use]
    pub fn finish(self) -> Vec<u8> {
        self.bytes
    }
}

/// Convenience adapter for finite, already-available byte chunk iterators.
///
/// `None` represents a missing body, while `Some(empty_iterator)` represents a
/// present zero-byte body, matching the Fetch API distinction.
pub fn collect_limited_body<I, B>(
    chunks: Option<I>,
    declared_content_length: Option<&str>,
    max_bytes: usize,
) -> Result<Option<Vec<u8>>, BodySizeLimitError>
where
    I: IntoIterator<Item = B>,
    B: AsRef<[u8]>,
{
    let mut collector = LimitedBodyCollector::new(max_bytes, declared_content_length)?;
    let Some(chunks) = chunks else {
        return Ok(None);
    };
    for chunk in chunks {
        collector.push_chunk(chunk.as_ref())?;
    }
    Ok(Some(collector.finish()))
}

fn parse_decimal_prefix(value: &str) -> Option<f64> {
    let value = value.trim_start();
    let bytes = value.as_bytes();
    let sign_length = usize::from(matches!(bytes.first(), Some(b'+') | Some(b'-')));
    let digits = bytes[sign_length..]
        .iter()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    if digits == 0 {
        return None;
    }
    value[..sign_length + digits]
        .parse::<f64>()
        .ok()
        .filter(|number| number.is_finite())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_body_exactly_at_the_limit() {
        let bytes = collect_limited_body(Some([b"ab".as_slice(), b"c"]), Some("3"), 3)
            .expect("body should fit")
            .expect("body should be present");
        assert_eq!(bytes, b"abc");
    }

    #[test]
    fn rejects_an_oversized_declared_length_before_collecting() {
        let error = LimitedBodyCollector::new(3, Some("  +4ignored"))
            .expect_err("declared length should be rejected");
        assert_eq!(error, BodySizeLimitError::new(3));
        assert!(error.should_cancel_source());
    }

    #[test]
    fn rejects_an_oversized_observed_length_without_retaining_the_chunk() {
        let mut collector = LimitedBodyCollector::new(3, None).expect("valid collector");
        collector.push_chunk(b"ab").expect("first chunk fits");
        assert_eq!(collector.push_chunk(b"cd"), Err(BodySizeLimitError::new(3)));
        assert_eq!(collector.len(), 2);
        assert_eq!(collector.remaining(), 1);
    }

    #[test]
    fn preserves_missing_versus_present_empty_bodies() {
        let absent = collect_limited_body::<[&[u8]; 0], &[u8]>(None, None, 3)
            .expect("missing body is valid");
        let empty =
            collect_limited_body(Some([b"".as_slice()]), None, 3).expect("empty body is valid");
        assert_eq!(absent, None);
        assert_eq!(empty, Some(Vec::new()));
    }

    #[test]
    fn ignores_parse_int_compatible_non_lengths() {
        assert!(LimitedBodyCollector::new(3, Some("nope")).is_ok());
        assert!(LimitedBodyCollector::new(3, Some("-99")).is_ok());
        assert!(LimitedBodyCollector::new(3, Some("0x100")).is_ok());
        let enormous = "9".repeat(400);
        assert!(LimitedBodyCollector::new(3, Some(&enormous)).is_ok());
    }
}
