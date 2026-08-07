use std::sync::OnceLock;

use crate::{
    core::{ApiError, AppResult, JsonObject},
    protocol::{anthropic, gemini},
};

static CL100K_BASE: OnceLock<tiktoken::CoreBpe> = OnceLock::new();

/// Shared, immutable `cl100k_base` tokenizer selected by the composition root.
///
/// Vocabulary construction is cached per isolate. This is immutable process
/// state, never request-scoped state, and avoids rebuilding a large BPE table
/// for every token-count request.
#[derive(Debug, Default, Clone, Copy)]
pub struct Cl100kTokenCounter;

impl Cl100kTokenCounter {
    fn encoding() -> &'static tiktoken::CoreBpe {
        // Calling the concrete constructor is intentional: `get_encoding`
        // references every bundled vocabulary and forces all of them into the
        // Wasm binary. This Worker needs only cl100k_base.
        CL100K_BASE.get_or_init(tiktoken::encoding::cl100k_base)
    }

    pub fn count(&self, text: &str) -> AppResult<usize> {
        Ok(Self::encoding().count(text))
    }

    fn count_request(&self, request: &JsonObject) -> AppResult<u64> {
        let count = anthropic::count_codex_input_tokens(request, self);
        u64::try_from(count).map_err(|_| {
            ApiError::new(413, "The token count exceeds the supported range.")
                .with_kind("invalid_request_error")
                .with_code("token_count_too_large")
        })
    }
}

impl anthropic::TokenCounter for Cl100kTokenCounter {
    fn count_tokens(&self, text: &str) -> usize {
        // The embedded cl100k table is build-time validated by the dependency.
        // Returning zero only contains an impossible initialization failure;
        // request-level callers use the fallible Gemini port below.
        self.count(text).unwrap_or(0)
    }
}

impl gemini::TokenCounter for Cl100kTokenCounter {
    fn count_tokens(&self, request: &JsonObject) -> AppResult<u64> {
        self.count_request(request)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn matches_known_cl100k_counts() {
        let counter = Cl100kTokenCounter;
        assert_eq!(counter.count("hello world").unwrap(), 2);
        assert_eq!(counter.count("你好，世界").unwrap(), 6);
    }

    #[test]
    fn counts_the_same_codex_fields_for_both_provider_ports() {
        let request = json!({
            "instructions": "hello",
            "input": [{"content": [{"text": "world"}]}]
        });
        let request = request.as_object().unwrap();
        let anthropic = anthropic::count_codex_input_tokens(request, &Cl100kTokenCounter);
        let gemini = gemini::TokenCounter::count_tokens(&Cl100kTokenCounter, request).unwrap();
        assert_eq!(gemini, anthropic as u64);
    }
}
