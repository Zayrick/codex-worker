use crate::core::JsonObject;

pub trait TokenCounter {
    fn count_tokens(&self, request: &JsonObject) -> u64;
}
