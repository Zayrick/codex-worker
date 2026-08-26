use std::sync::OnceLock;

use crate::{
    core::JsonObject,
    protocol::{anthropic, gemini},
};

static CL100K_BASE: OnceLock<tiktoken::CoreBpe> = OnceLock::new();

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

    pub fn count(&self, text: &str) -> usize {
        Self::encoding().count(text)
    }

    fn count_request(&self, request: &JsonObject) -> u64 {
        anthropic::count_codex_input_tokens(request, self) as u64
    }
}

impl anthropic::TokenCounter for Cl100kTokenCounter {
    fn count_tokens(&self, text: &str) -> usize {
        self.count(text)
    }
}

impl gemini::TokenCounter for Cl100kTokenCounter {
    fn count_tokens(&self, request: &JsonObject) -> u64 {
        self.count_request(request)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_known_cl100k_counts() {
        let counter = Cl100kTokenCounter;
        assert_eq!(counter.count("hello world"), 2);
        assert_eq!(counter.count("你好，世界"), 6);
    }
}
