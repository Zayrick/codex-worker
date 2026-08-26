use serde_json::{Value, json};

use crate::core::{AppResult, JsonObject};

use super::{
    ChatAction, ChatState, ChatTerminal, ToolActionSnapshot, create_chat_state, reduce_codex_event,
    require_chat_response_id, require_chat_terminal,
};
use crate::protocol::openai::{
    codex_stream_failed,
    sse::{SSE_DONE, sse_data},
};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StreamPresentationState {
    pub role_sent: bool,
    pub finished: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChatStreamPresenter {
    pub state: ChatState,
    pub presentation: StreamPresentationState,
    include_usage: bool,
}

impl ChatStreamPresenter {
    #[must_use]
    pub fn new(model: impl Into<String>, created: Value, include_usage: bool) -> Self {
        Self {
            state: create_chat_state(model, created),
            presentation: StreamPresentationState::default(),
            include_usage,
        }
    }

    pub fn push_event(&mut self, event: &JsonObject) -> AppResult<Vec<String>> {
        if self.presentation.finished {
            return Ok(Vec::new());
        }
        let actions = reduce_codex_event(&mut self.state, event)?;
        let mut frames = Vec::new();
        for action in &actions {
            frames.extend(present_chat_action(
                &self.state,
                &mut self.presentation,
                action,
                self.include_usage,
            )?);
        }
        Ok(frames)
    }

    pub fn finish(&self) -> AppResult<()> {
        if self.presentation.finished {
            return Ok(());
        }
        require_chat_terminal(&self.state)
    }
}

pub fn chat_completion_from_state(state: &ChatState) -> AppResult<JsonObject> {
    require_chat_terminal(state)?;
    require_chat_response_id(state)?;

    let mut message = JsonObject::new();
    message.insert("role".into(), Value::String("assistant".into()));
    message.insert(
        "content".into(),
        if state.text.is_empty() && !state.tools.is_empty() {
            Value::Null
        } else {
            Value::String(state.text.clone())
        },
    );
    message.insert("refusal".into(), Value::Null);
    if !state.reasoning.is_empty() {
        message.insert(
            "reasoning_content".into(),
            Value::String(state.reasoning.clone()),
        );
    }
    if !state.tools.is_empty() {
        message.insert(
            "tool_calls".into(),
            Value::Array(
                state
                    .tools
                    .iter()
                    .map(|tool| {
                        json!({
                            "id":tool.id,
                            "type":"function",
                            "function":{
                                "name":tool.name,
                                "arguments":if tool.kind == super::ToolKind::Custom {
                                    tool.arguments.clone()
                                } else if tool.arguments.is_empty() {
                                    "{}".to_owned()
                                } else {
                                    tool.arguments.clone()
                                }
                            }
                        })
                    })
                    .collect(),
            ),
        );
    }

    let completion = json!({
        "id":state.id,
        "object":"chat.completion",
        "created":state.created,
        "model":state.model,
        "choices":[{
            "index":0,
            "message":message,
            "logprobs":Value::Null,
            "finish_reason":finish_reason(
                state.incomplete_reason.as_deref(),
                !state.tools.is_empty(),
                state.terminal == Some(ChatTerminal::Incomplete)
            )
        }],
        "usage":usage_to_chat(state.usage.as_ref())
    });
    completion
        .as_object()
        .cloned()
        .ok_or_else(codex_stream_failed)
}

#[must_use]
pub fn finish_reason(
    incomplete_reason: Option<&str>,
    has_tools: bool,
    incomplete: bool,
) -> &'static str {
    if has_tools {
        return "tool_calls";
    }
    if incomplete {
        return if incomplete_reason.is_some_and(|reason| reason.contains("content_filter")) {
            "content_filter"
        } else {
            "length"
        };
    }
    "stop"
}

#[must_use]
pub fn usage_to_chat(usage: Option<&JsonObject>) -> Value {
    let Some(usage) = usage else {
        return Value::Null;
    };
    let mut result = JsonObject::new();
    result.insert(
        "prompt_tokens".into(),
        numeric_value(usage.get("input_tokens")),
    );
    result.insert(
        "completion_tokens".into(),
        numeric_value(usage.get("output_tokens")),
    );
    result.insert(
        "total_tokens".into(),
        numeric_value(usage.get("total_tokens")),
    );
    if let Some(details) = usage.get("input_tokens_details").and_then(Value::as_object) {
        result.insert(
            "prompt_tokens_details".into(),
            json!({"cached_tokens":numeric_value(details.get("cached_tokens"))}),
        );
    }
    if let Some(details) = usage
        .get("output_tokens_details")
        .and_then(Value::as_object)
    {
        result.insert(
            "completion_tokens_details".into(),
            json!({"reasoning_tokens":numeric_value(details.get("reasoning_tokens"))}),
        );
    }
    Value::Object(result)
}

pub fn present_chat_action(
    state: &ChatState,
    presentation: &mut StreamPresentationState,
    action: &ChatAction,
    include_usage: bool,
) -> AppResult<Vec<String>> {
    if presentation.finished {
        return Ok(Vec::new());
    }
    let mut frames = Vec::new();
    match action {
        ChatAction::ResponseCreated => ensure_role_chunk(state, presentation, &mut frames)?,
        ChatAction::TextDelta(delta) => {
            ensure_role_chunk(state, presentation, &mut frames)?;
            if !delta.is_empty() {
                frames.push(sse_data(&chat_chunk(
                    state,
                    json_object(json!({"content":delta})),
                    Value::Null,
                )));
            }
        }
        ChatAction::ReasoningDelta(delta) => {
            ensure_role_chunk(state, presentation, &mut frames)?;
            if !delta.is_empty() {
                frames.push(sse_data(&chat_chunk(
                    state,
                    json_object(json!({"reasoning_content":delta})),
                    Value::Null,
                )));
            }
        }
        ChatAction::ToolStarted {
            tool,
            initial_arguments,
        } => {
            ensure_role_chunk(state, presentation, &mut frames)?;
            frames.push(sse_data(&tool_start_chunk(state, tool, initial_arguments)));
        }
        ChatAction::ToolArgumentsDelta { tool, delta } => {
            ensure_role_chunk(state, presentation, &mut frames)?;
            if !delta.is_empty() {
                frames.push(sse_data(&chat_chunk(
                    state,
                    json_object(json!({
                        "tool_calls":[{
                            "index":tool.index,
                            "function":{"arguments":delta}
                        }]
                    })),
                    Value::Null,
                )));
            }
        }
        ChatAction::ResponseCompleted => {
            ensure_role_chunk(state, presentation, &mut frames)?;
            frames.push(sse_data(&chat_chunk(
                state,
                JsonObject::new(),
                Value::String(
                    finish_reason(
                        state.incomplete_reason.as_deref(),
                        !state.tools.is_empty(),
                        state.terminal == Some(ChatTerminal::Incomplete),
                    )
                    .into(),
                ),
            )));
            if include_usage {
                frames.push(sse_data(&json!({
                    "id":state.id,
                    "object":"chat.completion.chunk",
                    "created":state.created,
                    "model":state.model,
                    "choices":[],
                    "usage":usage_to_chat(state.usage.as_ref())
                })));
            }
            frames.push(SSE_DONE.to_owned());
            presentation.finished = true;
        }
    }
    Ok(frames)
}

pub fn stream_failure_frames() -> Vec<String> {
    vec![
        sse_data(&codex_stream_failed().openai_payload()),
        SSE_DONE.to_owned(),
    ]
}

fn ensure_role_chunk(
    state: &ChatState,
    presentation: &mut StreamPresentationState,
    frames: &mut Vec<String>,
) -> AppResult<()> {
    if presentation.role_sent {
        return Ok(());
    }
    require_chat_response_id(state)?;
    frames.push(sse_data(&chat_chunk(
        state,
        json_object(json!({"role":"assistant","content":""})),
        Value::Null,
    )));
    presentation.role_sent = true;
    Ok(())
}

fn chat_chunk(state: &ChatState, delta: JsonObject, finish_reason: Value) -> Value {
    json!({
        "id":state.id,
        "object":"chat.completion.chunk",
        "created":state.created,
        "model":state.model,
        "choices":[{
            "index":0,
            "delta":delta,
            "logprobs":Value::Null,
            "finish_reason":finish_reason
        }]
    })
}

fn tool_start_chunk(
    state: &ChatState,
    tool: &ToolActionSnapshot,
    initial_arguments: &str,
) -> Value {
    chat_chunk(
        state,
        json_object(json!({
            "tool_calls":[{
                "index":tool.index,
                "id":tool.id,
                "type":"function",
                "function":{"name":tool.name,"arguments":initial_arguments}
            }]
        })),
        Value::Null,
    )
}

fn numeric_value(value: Option<&Value>) -> Value {
    value
        .filter(|value| value.as_f64().is_some_and(f64::is_finite))
        .cloned()
        .unwrap_or_else(|| json!(0))
}

fn json_object(value: Value) -> JsonObject {
    value.as_object().cloned().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn object(value: Value) -> JsonObject {
        value.as_object().cloned().unwrap_or_default()
    }

    fn terminal_events(kind: &str, reason: Option<&str>) -> Vec<JsonObject> {
        let mut response = json_object(json!({
            "id":"resp_terminal",
            "created_at":1_754_006_400,
            "model":"resolved-model",
            "output":[
                {"type":"reasoning","summary":[{"text":"terminal reasoning"}]},
                {"type":"message","content":[{"type":"output_text","text":"terminal answer"}]},
                {"id":"fc_terminal","type":"function_call","call_id":"call_terminal","name":"lookup","arguments":"{\"q\":\"worker\"}"}
            ]
        }));
        if let Some(reason) = reason {
            response.insert("incomplete_details".into(), json!({"reason":reason}));
        }
        vec![
            object(json!({
                "type":"response.created",
                "response":{"id":"resp_terminal","created_at":1_754_006_400,"model":"resolved-model"}
            })),
            object(json!({"type":kind,"response":response})),
        ]
    }

    fn completion_from_events(events: &[JsonObject]) -> AppResult<JsonObject> {
        let mut state = create_chat_state("requested-model", json!(0));
        for event in events {
            reduce_codex_event(&mut state, event)?;
            if state.terminal.is_some() {
                break;
            }
        }
        chat_completion_from_state(&state)
    }

    #[test]
    fn presents_terminal_only_json_and_sse() {
        let events = terminal_events("response.completed", None);
        let completion = completion_from_events(&events).expect("completion");
        assert_eq!(completion["id"], "chatcmpl-terminal");
        assert_eq!(
            completion["choices"][0]["message"]["content"],
            "terminal answer"
        );
        assert_eq!(completion["choices"][0]["finish_reason"], "tool_calls");

        let mut presenter = ChatStreamPresenter::new("requested-model", json!(0), false);
        let mut rendered = String::new();
        for event in &events {
            for frame in presenter.push_event(event).expect("frame") {
                rendered.push_str(&frame);
            }
        }
        assert!(rendered.contains("terminal reasoning"));
        assert!(rendered.contains("terminal answer"));
        assert!(rendered.contains("call_terminal"));
        assert!(rendered.ends_with(SSE_DONE));
    }

    #[test]
    fn maps_incomplete_reasons_and_rejects_truncation() {
        for (reason, expected) in [
            (Some("max_output_tokens"), "length"),
            (None, "length"),
            (Some("content_filter"), "content_filter"),
        ] {
            let mut events = terminal_events("response.incomplete", reason);
            if let Some(output) = events
                .get_mut(1)
                .and_then(|event| event.get_mut("response"))
                .and_then(Value::as_object_mut)
            {
                output.insert("output".into(), Value::Array(Vec::new()));
            }
            let completion =
                completion_from_events(&events).expect("incomplete is a valid terminal");
            assert_eq!(completion["choices"][0]["finish_reason"], expected);
        }

        let truncated = vec![object(json!({
            "type":"response.created",
            "response":{"id":"resp_truncated"}
        }))];
        let error = completion_from_events(&truncated).expect_err("truncated stream");
        assert_eq!(error.code.as_deref(), Some("incomplete_codex_stream"));
    }
}
