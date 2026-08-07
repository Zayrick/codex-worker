use std::collections::{BTreeMap, HashMap};

use crate::{
    core::{ApiError, AppResult, JsonObject},
    protocol::{anthropic, gemini, openai},
};

pub const CHAT_COMPLETIONS_ADAPTER: &str = "openai.chat_completions";
pub const COMPLETIONS_ADAPTER: &str = "openai.completions";
pub const ANTHROPIC_MESSAGES_ADAPTER: &str = "anthropic.messages";
pub const GEMINI_CONTENT_ADAPTER: &str = "gemini.content";

/// Transport-provided values that are intentionally absent from a JSON body.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AdaptContext {
    pub path_model: Option<String>,
    pub stream: bool,
    pub require_max_tokens: bool,
}

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

/// Pluggable request-conversion boundary. A new compatibility API can be
/// registered without changing the Cloudflare transport or existing adapters.
pub trait RequestAdapter {
    fn adapt(
        &self,
        input: &JsonObject,
        context: &AdaptContext,
    ) -> AppResult<AdaptedUpstreamRequest>;
}

/// Composition-root registry rather than a protocol switch embedded in I/O.
#[derive(Default)]
pub struct AdapterRegistry {
    adapters: BTreeMap<String, Box<dyn RequestAdapter>>,
}

impl AdapterRegistry {
    pub fn empty() -> Self {
        Self::default()
    }

    pub fn builtins() -> Self {
        let mut registry = Self::empty();
        registry.register(CHAT_COMPLETIONS_ADAPTER, ChatAdapter);
        registry.register(COMPLETIONS_ADAPTER, CompletionAdapter);
        registry.register(ANTHROPIC_MESSAGES_ADAPTER, AnthropicAdapter);
        registry.register(GEMINI_CONTENT_ADAPTER, GeminiAdapter);
        registry
    }

    pub fn register(
        &mut self,
        id: impl Into<String>,
        adapter: impl RequestAdapter + 'static,
    ) -> Option<Box<dyn RequestAdapter>> {
        self.adapters.insert(id.into(), Box::new(adapter))
    }

    pub fn adapt(
        &self,
        id: &str,
        input: &JsonObject,
        context: &AdaptContext,
    ) -> AppResult<AdaptedUpstreamRequest> {
        self.adapters
            .get(id)
            .ok_or_else(|| {
                ApiError::new(500, "The protocol adapter is not registered.")
                    .with_kind("configuration_error")
                    .with_code("missing_protocol_adapter")
            })?
            .adapt(input, context)
    }
}

struct ChatAdapter;

impl RequestAdapter for ChatAdapter {
    fn adapt(
        &self,
        input: &JsonObject,
        _context: &AdaptContext,
    ) -> AppResult<AdaptedUpstreamRequest> {
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
}

struct CompletionAdapter;

impl RequestAdapter for CompletionAdapter {
    fn adapt(
        &self,
        input: &JsonObject,
        _context: &AdaptContext,
    ) -> AppResult<AdaptedUpstreamRequest> {
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
}

struct AnthropicAdapter;

impl RequestAdapter for AnthropicAdapter {
    fn adapt(
        &self,
        input: &JsonObject,
        context: &AdaptContext,
    ) -> AppResult<AdaptedUpstreamRequest> {
        let adapted = anthropic::messages_request_to_responses(
            input,
            anthropic::MessageRequestOptions {
                require_max_tokens: context.require_max_tokens,
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
}

struct GeminiAdapter;

impl RequestAdapter for GeminiAdapter {
    fn adapt(
        &self,
        input: &JsonObject,
        context: &AdaptContext,
    ) -> AppResult<AdaptedUpstreamRequest> {
        let model = context.path_model.as_deref().ok_or_else(|| {
            ApiError::invalid("The model path parameter is required.").with_param("model")
        })?;
        let adapted = gemini::gemini_request_to_responses(input, model)?;
        Ok(AdaptedUpstreamRequest {
            body: adapted.body,
            stream: context.stream,
            response: ResponseAdapter::GeminiContent {
                model: adapted.model,
                reverse_tool_names: adapted.reverse_tool_names,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn builtins_are_selected_by_stable_ids() {
        let registry = AdapterRegistry::builtins();
        let input = json!({"model":"gpt-test","messages":[{"role":"user","content":"hi"}]});
        let adapted = registry
            .adapt(
                CHAT_COMPLETIONS_ADAPTER,
                input.as_object().unwrap(),
                &AdaptContext::default(),
            )
            .unwrap();
        assert!(matches!(
            adapted.response,
            ResponseAdapter::OpenAiChat { ref model, .. } if model == "gpt-test"
        ));
    }

    #[test]
    fn adapters_can_be_replaced_without_transport_changes() {
        struct Marker;
        impl RequestAdapter for Marker {
            fn adapt(
                &self,
                _input: &JsonObject,
                _context: &AdaptContext,
            ) -> AppResult<AdaptedUpstreamRequest> {
                Err(ApiError::new(418, "marker"))
            }
        }

        let mut registry = AdapterRegistry::builtins();
        assert!(
            registry
                .register(CHAT_COMPLETIONS_ADAPTER, Marker)
                .is_some()
        );
        let error = registry
            .adapt(
                CHAT_COMPLETIONS_ADAPTER,
                &JsonObject::new(),
                &AdaptContext::default(),
            )
            .unwrap_err();
        assert_eq!(error.status, 418);
    }
}
