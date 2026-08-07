use serde::Serialize;

use crate::core::{ApiError, AppResult};

pub const SSE_DONE: &[u8] = b"data: [DONE]\n\n";

pub fn sse_data<T: Serialize + ?Sized>(value: &T) -> AppResult<Vec<u8>> {
    let json = serialize(value)?;
    let mut event = Vec::with_capacity("data: ".len() + json.len() + 2);
    event.extend_from_slice(b"data: ");
    event.extend_from_slice(&json);
    event.extend_from_slice(b"\n\n");
    Ok(event)
}

pub fn named_sse_event<T: Serialize + ?Sized>(event_name: &str, value: &T) -> AppResult<Vec<u8>> {
    let json = serialize(value)?;
    let mut event =
        Vec::with_capacity("event: ".len() + event_name.len() + "\ndata: ".len() + json.len() + 2);
    event.extend_from_slice(b"event: ");
    event.extend_from_slice(event_name.as_bytes());
    event.extend_from_slice(b"\ndata: ");
    event.extend_from_slice(&json);
    event.extend_from_slice(b"\n\n");
    Ok(event)
}

fn serialize<T: Serialize + ?Sized>(value: &T) -> AppResult<Vec<u8>> {
    serde_json::to_vec(value).map_err(|_| {
        ApiError::new(500, "Failed to serialize the SSE event.")
            .with_kind("internal_error")
            .with_code("json_serialization_error")
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn encodes_data_named_events_and_done_sentinel_exactly() {
        assert_eq!(
            sse_data(&json!({"delta": "hello"})).expect("serializable event"),
            br#"data: {"delta":"hello"}

"#
        );
        assert_eq!(
            named_sse_event("error", &json!({"message": "bad"})).expect("serializable event"),
            br#"event: error
data: {"message":"bad"}

"#
        );
        assert_eq!(SSE_DONE, b"data: [DONE]\n\n");
    }
}
