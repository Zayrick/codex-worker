use crate::core::{AppResult, JsonObject};

/// Application port for the tokenizer selected by the composition root.
///
/// Gemini adaptation does not know whether token counts come from a Rust
/// tokenizer, a model-specific implementation, or a remote service.
pub trait TokenCounter {
    fn count_tokens(&self, request: &JsonObject) -> AppResult<u64>;
}
