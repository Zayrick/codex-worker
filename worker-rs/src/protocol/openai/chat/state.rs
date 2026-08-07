use std::collections::HashMap;

use serde_json::{Value, json};

use crate::core::{ApiError, AppResult, JsonObject};

use super::{ChatAction, ChatState, ChatTerminal, ToolActionSnapshot, ToolCallState, ToolKind};
use crate::protocol::openai::{codex_stream_failed, sse::utf16_len};

pub const MAX_CHAT_RETAINED_CHARS: usize = 8 * 1024 * 1024;
pub const MAX_CHAT_TOOL_CALLS: usize = 128;
pub const MAX_CHAT_TOOL_ALIASES: usize = MAX_CHAT_TOOL_CALLS * 3;

#[must_use]
pub fn create_chat_state(model: impl Into<String>, created: Value) -> ChatState {
    ChatState {
        id: String::new(),
        created,
        model: model.into(),
        text: String::new(),
        reasoning: String::new(),
        retained_chars: 0,
        tools: Vec::new(),
        usage: None,
        incomplete_reason: None,
        terminal: None,
        tools_by_item_id: HashMap::new(),
        tools_by_call_id: HashMap::new(),
        tools_by_output_index: HashMap::new(),
    }
}

pub fn reduce_codex_event(state: &mut ChatState, event: &JsonObject) -> AppResult<Vec<ChatAction>> {
    if state.terminal.is_some() {
        return Ok(Vec::new());
    }
    let kind = string_field(event, "type").unwrap_or("");
    if kind == "response.created" {
        update_response_metadata(state, record_field(event, "response"));
        return Ok(vec![ChatAction::ResponseCreated]);
    }
    if kind == "response.output_text.delta" {
        let delta = event.get("delta").and_then(Value::as_str).unwrap_or("");
        reserve_chat_chars(state, utf16_len(delta))?;
        state.text.push_str(delta);
        return Ok((!delta.is_empty())
            .then(|| ChatAction::TextDelta(delta.to_owned()))
            .into_iter()
            .collect());
    }
    if matches!(
        kind,
        "response.reasoning_summary_text.delta" | "response.reasoning_text.delta"
    ) {
        let delta = event.get("delta").and_then(Value::as_str).unwrap_or("");
        reserve_chat_chars(state, utf16_len(delta))?;
        state.reasoning.push_str(delta);
        return Ok((!delta.is_empty())
            .then(|| ChatAction::ReasoningDelta(delta.to_owned()))
            .into_iter()
            .collect());
    }
    if kind == "response.output_item.added" {
        let Some(item) = record_field(event, "item") else {
            return Ok(Vec::new());
        };
        if !is_tool_call_item(item) {
            return Ok(Vec::new());
        }
        let tool = ensure_tool(state, event, item)?;
        return start_tool(state, tool, "");
    }
    if matches!(
        kind,
        "response.function_call_arguments.delta" | "response.custom_tool_call_input.delta"
    ) {
        let tool = match find_tool_for_event(state, event)? {
            Some(tool) => tool,
            None => {
                let item = json!({
                    "type":if kind == "response.custom_tool_call_input.delta" {
                        "custom_tool_call"
                    } else {
                        "function_call"
                    },
                    "name":"tool"
                });
                ensure_tool(
                    state,
                    event,
                    item.as_object().ok_or_else(codex_stream_failed)?,
                )?
            }
        };
        let mut actions = start_tool(state, tool, "")?;
        let delta = event.get("delta").and_then(Value::as_str).unwrap_or("");
        if !delta.is_empty() {
            reserve_chat_chars(state, utf16_len(delta))?;
            let Some(tool_state) = state.tools.get_mut(tool) else {
                return Err(codex_stream_failed());
            };
            tool_state.arguments.push_str(delta);
            actions.push(ChatAction::ToolArgumentsDelta {
                tool: tool_snapshot(tool_state),
                delta: delta.to_owned(),
            });
        }
        return Ok(actions);
    }
    if matches!(
        kind,
        "response.function_call_arguments.done" | "response.custom_tool_call_input.done"
    ) {
        let tool_kind = if kind.contains("custom_tool") {
            ToolKind::Custom
        } else {
            ToolKind::Function
        };
        let tool = match find_tool_for_event(state, event)? {
            Some(tool) => tool,
            None => {
                let item = json!({
                    "type":if tool_kind == ToolKind::Custom { "custom_tool_call" } else { "function_call" },
                    "name":"tool"
                });
                ensure_tool(
                    state,
                    event,
                    item.as_object().ok_or_else(codex_stream_failed)?,
                )?
            }
        };
        let final_arguments = if tool_kind == ToolKind::Custom {
            event.get("input").and_then(Value::as_str)
        } else {
            event.get("arguments").and_then(Value::as_str)
        };
        return reconcile_tool_arguments(state, tool, final_arguments, "");
    }
    if kind == "response.output_item.done" {
        let Some(item) = record_field(event, "item") else {
            return Ok(Vec::new());
        };
        if !is_tool_call_item(item) {
            return Ok(Vec::new());
        }
        let tool = ensure_tool(state, event, item)?;
        return reconcile_tool_arguments(state, tool, tool_call_input(item), "");
    }
    if matches!(
        kind,
        "response.completed" | "response.incomplete" | "response.failed"
    ) {
        let Some(response) = record_field(event, "response") else {
            state.terminal = Some(ChatTerminal::Failed);
            return Err(codex_stream_failed());
        };
        state.usage = record_field(response, "usage").cloned();
        state.incomplete_reason = record_field(response, "incomplete_details")
            .and_then(|details| string_field(details, "reason"))
            .map(str::to_owned);
        update_response_metadata(state, Some(response));
        if kind == "response.failed" {
            state.terminal = Some(ChatTerminal::Failed);
            return Err(codex_stream_failed());
        }

        return match reconcile_terminal_output(state, response) {
            Ok(mut actions) => {
                state.terminal = Some(if kind == "response.completed" {
                    ChatTerminal::Completed
                } else {
                    ChatTerminal::Incomplete
                });
                actions.push(ChatAction::ResponseCompleted);
                Ok(actions)
            }
            Err(error) => {
                state.terminal = Some(ChatTerminal::Failed);
                Err(error)
            }
        };
    }
    if kind == "error" {
        state.terminal = Some(ChatTerminal::Failed);
        return Err(codex_stream_failed());
    }
    Ok(Vec::new())
}

pub fn require_chat_terminal(state: &ChatState) -> AppResult<()> {
    if matches!(
        state.terminal,
        Some(ChatTerminal::Completed | ChatTerminal::Incomplete)
    ) {
        return Ok(());
    }
    Err(
        ApiError::new(502, "The Codex stream ended without a completed response.")
            .with_kind("upstream_error")
            .with_code("incomplete_codex_stream"),
    )
}

pub fn require_chat_response_id(state: &ChatState) -> AppResult<()> {
    if !state.id.is_empty() {
        return Ok(());
    }
    Err(
        ApiError::new(502, "The Codex response did not include a response ID.")
            .with_kind("upstream_error")
            .with_code("missing_codex_response_id"),
    )
}

fn reserve_chat_chars(state: &mut ChatState, additional: usize) -> AppResult<()> {
    if additional == 0 {
        return Ok(());
    }
    let Some(remaining) = MAX_CHAT_RETAINED_CHARS.checked_sub(additional) else {
        return Err(codex_stream_failed());
    };
    if state.retained_chars > remaining {
        return Err(codex_stream_failed());
    }
    state.retained_chars += additional;
    Ok(())
}

fn reserve_chat_tool(state: &mut ChatState, name: &str) -> AppResult<()> {
    if state.tools.len() >= MAX_CHAT_TOOL_CALLS {
        return Err(codex_stream_failed());
    }
    reserve_chat_chars(state, utf16_len(name))
}

fn reserve_chat_alias(state: &mut ChatState, string_key: Option<&str>) -> AppResult<()> {
    let alias_count = state
        .tools_by_item_id
        .len()
        .checked_add(state.tools_by_call_id.len())
        .and_then(|value| value.checked_add(state.tools_by_output_index.len()))
        .ok_or_else(codex_stream_failed)?;
    if alias_count >= MAX_CHAT_TOOL_ALIASES {
        return Err(codex_stream_failed());
    }
    if let Some(key) = string_key {
        reserve_chat_chars(state, utf16_len(key))?;
    }
    Ok(())
}

fn reconcile_tool_arguments(
    state: &mut ChatState,
    tool: usize,
    final_arguments: Option<&str>,
    initial_fallback: &str,
) -> AppResult<Vec<ChatAction>> {
    let Some(current) = state.tools.get(tool) else {
        return Err(codex_stream_failed());
    };
    if !current.started {
        let initial = final_arguments.unwrap_or(initial_fallback);
        reserve_chat_chars(state, utf16_len(initial))?;
        let Some(current) = state.tools.get_mut(tool) else {
            return Err(codex_stream_failed());
        };
        current.arguments.clear();
        current.arguments.push_str(initial);
        current.started = true;
        return Ok(vec![ChatAction::ToolStarted {
            tool: tool_snapshot(current),
            initial_arguments: initial.to_owned(),
        }]);
    }
    let current_arguments = current.arguments.clone();
    let Some(final_arguments) = final_arguments else {
        return Ok(Vec::new());
    };
    if final_arguments == current_arguments {
        return Ok(Vec::new());
    }
    let Some(delta) = final_arguments.strip_prefix(&current_arguments) else {
        return Err(codex_stream_failed());
    };
    reserve_chat_chars(state, utf16_len(delta))?;
    let Some(current) = state.tools.get_mut(tool) else {
        return Err(codex_stream_failed());
    };
    current.arguments.clear();
    current.arguments.push_str(final_arguments);
    Ok((!delta.is_empty())
        .then(|| ChatAction::ToolArgumentsDelta {
            tool: tool_snapshot(current),
            delta: delta.to_owned(),
        })
        .into_iter()
        .collect())
}

fn start_tool(
    state: &mut ChatState,
    tool: usize,
    initial_arguments: &str,
) -> AppResult<Vec<ChatAction>> {
    let Some(tool) = state.tools.get_mut(tool) else {
        return Err(codex_stream_failed());
    };
    if tool.started {
        return Ok(Vec::new());
    }
    tool.started = true;
    Ok(vec![ChatAction::ToolStarted {
        tool: tool_snapshot(tool),
        initial_arguments: initial_arguments.to_owned(),
    }])
}

fn tool_snapshot(tool: &ToolCallState) -> ToolActionSnapshot {
    ToolActionSnapshot {
        index: tool.index,
        id: tool.id.clone(),
        name: tool.name.clone(),
    }
}

fn is_tool_call_item(item: &JsonObject) -> bool {
    matches!(
        item.get("type").and_then(Value::as_str),
        Some("function_call" | "custom_tool_call")
    )
}

fn tool_kind(item: &JsonObject) -> ToolKind {
    if item.get("type").and_then(Value::as_str) == Some("custom_tool_call") {
        ToolKind::Custom
    } else {
        ToolKind::Function
    }
}

fn tool_call_input(item: &JsonObject) -> Option<&str> {
    if tool_kind(item) == ToolKind::Custom {
        item.get("input").and_then(Value::as_str)
    } else {
        item.get("arguments").and_then(Value::as_str)
    }
}

fn find_tool_for_event(state: &ChatState, event: &JsonObject) -> AppResult<Option<usize>> {
    let item_id = string_field(event, "item_id");
    let call_id = string_field(event, "call_id");
    let output_index = number_key(event.get("output_index"));
    unique_tool([
        item_id.and_then(|key| state.tools_by_item_id.get(key).copied()),
        call_id.and_then(|key| state.tools_by_call_id.get(key).copied()),
        output_index
            .as_deref()
            .and_then(|key| state.tools_by_output_index.get(key).copied()),
    ])
}

fn ensure_tool(state: &mut ChatState, event: &JsonObject, item: &JsonObject) -> AppResult<usize> {
    let explicit_item_id = string_field(item, "id")
        .or_else(|| string_field(event, "item_id"))
        .map(str::to_owned);
    let explicit_call_id = string_field(item, "call_id")
        .or_else(|| string_field(event, "call_id"))
        .map(str::to_owned);
    let output_index = number_key(event.get("output_index"));
    let existing = unique_tool([
        explicit_item_id
            .as_deref()
            .and_then(|key| state.tools_by_item_id.get(key).copied()),
        explicit_call_id
            .as_deref()
            .and_then(|key| state.tools_by_call_id.get(key).copied()),
        output_index
            .as_deref()
            .and_then(|key| state.tools_by_output_index.get(key).copied()),
    ])?;

    if let Some(index) = existing {
        let new_name = string_field(item, "name").map(str::to_owned);
        let name_changed = new_name
            .as_deref()
            .is_some_and(|name| state.tools.get(index).is_some_and(|tool| tool.name != name));
        if name_changed {
            reserve_chat_chars(
                state,
                new_name.as_deref().map(utf16_len).unwrap_or_default(),
            )?;
        }
        let Some(tool) = state.tools.get_mut(index) else {
            return Err(codex_stream_failed());
        };
        if let Some(item_id) = &explicit_item_id {
            tool.item_id.clone_from(item_id);
        }
        if let Some(call_id) = &explicit_call_id {
            tool.id.clone_from(call_id);
        }
        if let Some(name) = new_name {
            tool.name = name;
        }
        tool.kind = tool_kind(item);
        if let Some(output_index) = &output_index {
            tool.output_index = Some(output_index.clone());
        }
        register_tool_aliases(
            state,
            index,
            explicit_item_id.as_deref(),
            explicit_call_id.as_deref(),
            output_index.as_deref(),
        )?;
        return Ok(index);
    }

    let item_id = explicit_item_id
        .clone()
        .or_else(|| explicit_call_id.clone())
        .unwrap_or_else(|| format!("tool-{}", state.tools.len()));
    let call_id = explicit_call_id.clone().unwrap_or_else(|| item_id.clone());
    let name = string_field(item, "name").unwrap_or("tool").to_owned();
    reserve_chat_tool(state, &name)?;
    let index = state.tools.len();
    state.tools.push(ToolCallState {
        index,
        output_index: output_index.clone(),
        item_id: item_id.clone(),
        id: call_id.clone(),
        name,
        arguments: String::new(),
        kind: tool_kind(item),
        started: false,
    });
    register_tool_aliases(
        state,
        index,
        Some(&item_id),
        Some(&call_id),
        output_index.as_deref(),
    )?;
    Ok(index)
}

fn register_tool_aliases(
    state: &mut ChatState,
    tool: usize,
    item_id: Option<&str>,
    call_id: Option<&str>,
    output_index: Option<&str>,
) -> AppResult<()> {
    if let Some(key) = item_id {
        register_item_alias(state, key, tool)?;
    }
    if let Some(key) = call_id {
        register_call_alias(state, key, tool)?;
    }
    if let Some(key) = output_index {
        register_output_alias(state, key, tool)?;
    }
    Ok(())
}

fn register_item_alias(state: &mut ChatState, key: &str, tool: usize) -> AppResult<()> {
    if let Some(existing) = state.tools_by_item_id.get(key) {
        return (*existing == tool)
            .then_some(())
            .ok_or_else(codex_stream_failed);
    }
    reserve_chat_alias(state, Some(key))?;
    state.tools_by_item_id.insert(key.to_owned(), tool);
    Ok(())
}

fn register_call_alias(state: &mut ChatState, key: &str, tool: usize) -> AppResult<()> {
    if let Some(existing) = state.tools_by_call_id.get(key) {
        return (*existing == tool)
            .then_some(())
            .ok_or_else(codex_stream_failed);
    }
    reserve_chat_alias(state, Some(key))?;
    state.tools_by_call_id.insert(key.to_owned(), tool);
    Ok(())
}

fn register_output_alias(state: &mut ChatState, key: &str, tool: usize) -> AppResult<()> {
    if let Some(existing) = state.tools_by_output_index.get(key) {
        return (*existing == tool)
            .then_some(())
            .ok_or_else(codex_stream_failed);
    }
    reserve_chat_alias(state, None)?;
    state.tools_by_output_index.insert(key.to_owned(), tool);
    Ok(())
}

fn unique_tool(candidates: [Option<usize>; 3]) -> AppResult<Option<usize>> {
    let mut result = None;
    for candidate in candidates.into_iter().flatten() {
        if result.is_some_and(|existing| existing != candidate) {
            return Err(codex_stream_failed());
        }
        result = Some(candidate);
    }
    Ok(result)
}

fn reconcile_terminal_output(
    state: &mut ChatState,
    response: &JsonObject,
) -> AppResult<Vec<ChatAction>> {
    let Some(output_value) = response.get("output") else {
        return Ok(Vec::new());
    };
    let Some(output) = output_value.as_array() else {
        return Err(codex_stream_failed());
    };

    let mut final_text = String::new();
    let mut final_reasoning = String::new();
    let mut text_order = usize::MAX;
    let mut reasoning_order = usize::MAX;
    let mut terminal_tools = Vec::new();
    for (output_index, value) in output.iter().enumerate() {
        let Some(item) = value.as_object() else {
            continue;
        };
        match string_field(item, "type") {
            Some("message") => {
                let Some(content) = item.get("content").and_then(Value::as_array) else {
                    continue;
                };
                for value in content {
                    let Some(content) = value.as_object() else {
                        continue;
                    };
                    if content.get("type").and_then(Value::as_str) == Some("output_text") {
                        append_terminal_text(
                            &mut final_text,
                            content.get("text").and_then(Value::as_str).unwrap_or(""),
                        )?;
                        text_order = text_order.min(output_index);
                    } else if content.get("type").and_then(Value::as_str) == Some("refusal") {
                        append_terminal_text(
                            &mut final_text,
                            content.get("refusal").and_then(Value::as_str).unwrap_or(""),
                        )?;
                        text_order = text_order.min(output_index);
                    }
                }
            }
            Some("reasoning") => {
                let Some(summary) = item.get("summary").and_then(Value::as_array) else {
                    continue;
                };
                for value in summary {
                    let Some(summary) = value.as_object() else {
                        continue;
                    };
                    append_terminal_text(
                        &mut final_reasoning,
                        summary.get("text").and_then(Value::as_str).unwrap_or(""),
                    )?;
                    reasoning_order = reasoning_order.min(output_index);
                }
            }
            _ if is_tool_call_item(item) => terminal_tools.push((item, output_index)),
            _ => {}
        }
    }

    let mut ordered = Vec::<(usize, usize, ChatAction)>::new();
    let mut sequence = 0;
    for action in reconcile_text(state, TextField::Text, &final_text)? {
        ordered.push((text_order, sequence, action));
        sequence += 1;
    }
    for action in reconcile_text(state, TextField::Reasoning, &final_reasoning)? {
        ordered.push((reasoning_order, sequence, action));
        sequence += 1;
    }
    for (item, output_index) in terminal_tools {
        let event = json!({"output_index":output_index});
        let event = event.as_object().ok_or_else(codex_stream_failed)?;
        let tool = ensure_tool(state, event, item)?;
        let fallback = if state
            .tools
            .get(tool)
            .is_some_and(|tool| tool.kind == ToolKind::Function)
        {
            "{}"
        } else {
            ""
        };
        for action in reconcile_tool_arguments(
            state,
            tool,
            tool_call_input(item),
            tool_call_input(item).unwrap_or(fallback),
        )? {
            ordered.push((output_index, sequence, action));
            sequence += 1;
        }
    }
    ordered.sort_by_key(|(order, sequence, _)| (*order, *sequence));
    Ok(ordered.into_iter().map(|(_, _, action)| action).collect())
}

#[derive(Clone, Copy)]
enum TextField {
    Text,
    Reasoning,
}

fn reconcile_text(
    state: &mut ChatState,
    field: TextField,
    final_value: &str,
) -> AppResult<Vec<ChatAction>> {
    if final_value.is_empty() {
        return Ok(Vec::new());
    }
    let current = match field {
        TextField::Text => &state.text,
        TextField::Reasoning => &state.reasoning,
    };
    if current == final_value {
        return Ok(Vec::new());
    }
    let Some(delta) = final_value.strip_prefix(current) else {
        return Err(codex_stream_failed());
    };
    let delta = delta.to_owned();
    reserve_chat_chars(state, utf16_len(&delta))?;
    match field {
        TextField::Text => state.text = final_value.to_owned(),
        TextField::Reasoning => state.reasoning = final_value.to_owned(),
    }
    Ok((!delta.is_empty())
        .then_some(match field {
            TextField::Text => ChatAction::TextDelta(delta),
            TextField::Reasoning => ChatAction::ReasoningDelta(delta),
        })
        .into_iter()
        .collect())
}

fn append_terminal_text(target: &mut String, value: &str) -> AppResult<()> {
    let total = utf16_len(target)
        .checked_add(utf16_len(value))
        .ok_or_else(codex_stream_failed)?;
    if total > MAX_CHAT_RETAINED_CHARS {
        return Err(codex_stream_failed());
    }
    target.push_str(value);
    Ok(())
}

fn update_response_metadata(state: &mut ChatState, response: Option<&JsonObject>) {
    let Some(response) = response else {
        return;
    };
    if let Some(id) = string_field(response, "id") {
        state.id = format!("chatcmpl-{}", id.strip_prefix("resp_").unwrap_or(id));
    }
    if response.get("created_at").is_some_and(Value::is_number) {
        state.created = response["created_at"].clone();
    }
    if let Some(model) = string_field(response, "model") {
        state.model = model.to_owned();
    }
}

fn string_field<'a>(object: &'a JsonObject, key: &str) -> Option<&'a str> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

fn record_field<'a>(object: &'a JsonObject, key: &str) -> Option<&'a JsonObject> {
    object.get(key).and_then(Value::as_object)
}

fn number_key(value: Option<&Value>) -> Option<String> {
    let number = value?.as_number()?;
    let mut number = number.as_f64().filter(|number| number.is_finite())?;
    if number == 0.0 {
        number = 0.0;
    }
    Some(format!("{:016x}", number.to_bits()))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn object(value: Value) -> JsonObject {
        value.as_object().cloned().unwrap_or_default()
    }

    fn created(id: &str) -> JsonObject {
        object(json!({
            "type":"response.created",
            "response":{"id":id,"created_at":1_754_006_400,"model":"resolved-model"}
        }))
    }

    #[test]
    fn terminal_output_reconciles_message_reasoning_and_tool_in_order() {
        let mut state = create_chat_state("requested-model", json!(0));
        reduce_codex_event(&mut state, &created("resp_terminal")).expect("created");
        let actions = reduce_codex_event(
            &mut state,
            &object(json!({
                "type":"response.completed",
                "response":{
                    "id":"resp_terminal",
                    "created_at":1_754_006_400,
                    "model":"resolved-model",
                    "output":[
                        {"type":"reasoning","summary":[{"text":"terminal reasoning"}]},
                        {"type":"message","content":[{"type":"output_text","text":"terminal answer"}]},
                        {"id":"fc_terminal","type":"function_call","call_id":"call_terminal","name":"lookup","arguments":"{\"q\":\"worker\"}"}
                    ]
                }
            })),
        )
        .expect("completed");
        assert_eq!(state.text, "terminal answer");
        assert_eq!(state.reasoning, "terminal reasoning");
        assert_eq!(state.tools[0].id, "call_terminal");
        assert!(matches!(
            actions.last(),
            Some(ChatAction::ResponseCompleted)
        ));
    }

    #[test]
    fn rejects_truncation_memory_overrun_and_failed_terminal() {
        let mut state = create_chat_state("model", json!(0));
        state.retained_chars = MAX_CHAT_RETAINED_CHARS;
        let error = reduce_codex_event(
            &mut state,
            &object(json!({"type":"response.output_text.delta","delta":"x"})),
        )
        .expect_err("over budget");
        assert_eq!(error.code.as_deref(), Some("codex_stream_failed"));

        let mut failed = create_chat_state("model", json!(0));
        let error = reduce_codex_event(
            &mut failed,
            &object(json!({"type":"response.failed","response":{"id":"resp_failed"}})),
        )
        .expect_err("failed terminal");
        assert_eq!(error.code.as_deref(), Some("codex_stream_failed"));
        assert_eq!(failed.terminal, Some(ChatTerminal::Failed));
    }

    #[test]
    fn bounds_tool_count_and_alias_churn() {
        let mut state = create_chat_state("model", json!(0));
        for index in 0..MAX_CHAT_TOOL_CALLS {
            reduce_codex_event(
                &mut state,
                &object(json!({
                    "type":"response.output_item.added",
                    "output_index":index,
                    "item":{"id":format!("item-{index}"),"type":"function_call","call_id":format!("call-{index}"),"name":"tool"}
                })),
            )
            .expect("within tool budget");
        }
        assert!(
            reduce_codex_event(
                &mut state,
                &object(json!({
                    "type":"response.output_item.added",
                    "output_index":MAX_CHAT_TOOL_CALLS,
                    "item":{"id":"overflow","type":"function_call","call_id":"overflow","name":"tool"}
                })),
            )
            .is_err()
        );
    }
}
