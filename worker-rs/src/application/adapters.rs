use std::collections::HashMap;

use crate::{
    core::{AppResult, JsonObject},
    protocol::{anthropic, gemini, openai},
};

/// Metadata needed to select the matching response presenter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResponseAdapter {
    OpenAiChat {
        model: String,
        include_usage: bool,
    },
    OpenAiCompletion {
        model: String,
        include_usage: bool,
        echo_prefix: String,
    },
    AnthropicMessages {
        model: String,
        reverse_tool_names: HashMap<String, String>,
    },
    GeminiContent {
        model: String,
        reverse_tool_names: HashMap<String, String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdaptedUpstreamRequest {
    pub body: JsonObject,
    pub stream: bool,
    pub response: ResponseAdapter,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestAdapter {
    OpenAiChat,
    OpenAiCompletion,
    AnthropicMessages,
    GeminiContent { model: String, stream: bool },
}

impl RequestAdapter {
    pub fn adapt(&self, input: &JsonObject) -> AppResult<AdaptedUpstreamRequest> {
        match self {
            Self::OpenAiChat => {
                let adapted = openai::chat::chat_request_to_responses(input)?;
                Ok(AdaptedUpstreamRequest {
                    body: adapted.body,
                    stream: adapted.stream,
                    response: ResponseAdapter::OpenAiChat {
                        model: adapted.model,
                        include_usage: adapted.include_usage,
                    },
                })
            }
            Self::OpenAiCompletion => {
                let adapted = openai::completions::completion_request_to_responses(input)?;
                Ok(AdaptedUpstreamRequest {
                    body: adapted.body,
                    stream: adapted.stream,
                    response: ResponseAdapter::OpenAiCompletion {
                        model: adapted.model,
                        include_usage: adapted.include_usage,
                        echo_prefix: adapted.echo_prefix,
                    },
                })
            }
            Self::AnthropicMessages => {
                let adapted = anthropic::messages_request_to_responses(
                    input,
                    anthropic::MessageRequestOptions {
                        require_max_tokens: true,
                    },
                )?;
                Ok(AdaptedUpstreamRequest {
                    body: adapted.body,
                    stream: adapted.stream,
                    response: ResponseAdapter::AnthropicMessages {
                        model: adapted.model,
                        reverse_tool_names: adapted.reverse_tool_names,
                    },
                })
            }
            Self::GeminiContent { model, stream } => {
                let adapted = gemini::gemini_request_to_responses(input, model)?;
                Ok(AdaptedUpstreamRequest {
                    body: adapted.body,
                    stream: *stream,
                    response: ResponseAdapter::GeminiContent {
                        model: adapted.model,
                        reverse_tool_names: adapted.reverse_tool_names,
                    },
                })
            }
        }
    }
}
