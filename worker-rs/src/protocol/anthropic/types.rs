use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::core::JsonObject;

#[derive(Debug, Clone, PartialEq)]
pub struct AdaptedMessagesRequest {
    pub body: JsonObject,
    pub model: String,
    pub stream: bool,
    pub reverse_tool_names: HashMap<String, String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ClaudeUsage {
    pub input_tokens: f64,
    pub output_tokens: f64,
    pub cache_read_input_tokens: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AnthropicSseEvent {
    pub event: String,
    pub data: JsonObject,
}

impl AnthropicSseEvent {
    pub(crate) fn new(event: impl Into<String>, data: JsonObject) -> Self {
        Self {
            event: event.into(),
            data,
        }
    }
}
