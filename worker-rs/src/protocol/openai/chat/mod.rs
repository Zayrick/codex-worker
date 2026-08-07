//! Chat Completions request and response compatibility.

mod presentation;
mod request;
mod state;

use std::collections::HashMap;

use serde_json::Value;

use crate::core::JsonObject;

pub use presentation::{
    ChatStreamPresenter, StreamPresentationState, chat_completion_from_events,
    chat_completion_from_state, finish_reason, present_chat_action, stream_failure_frames,
    usage_to_chat,
};
pub use request::chat_request_to_responses;
pub use state::{
    MAX_CHAT_RETAINED_CHARS, MAX_CHAT_TOOL_ALIASES, MAX_CHAT_TOOL_CALLS, create_chat_state,
    reduce_codex_event, require_chat_response_id, require_chat_terminal,
};

#[derive(Debug, Clone, PartialEq)]
pub struct AdaptedChatRequest {
    pub body: JsonObject,
    pub model: String,
    pub stream: bool,
    pub include_usage: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolKind {
    Function,
    Custom,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCallState {
    pub index: usize,
    pub output_index: Option<String>,
    pub item_id: String,
    pub id: String,
    pub name: String,
    pub arguments: String,
    pub kind: ToolKind,
    pub started: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatTerminal {
    Completed,
    Incomplete,
    Failed,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChatState {
    pub id: String,
    pub created: Value,
    pub model: String,
    pub text: String,
    pub reasoning: String,
    pub retained_chars: usize,
    pub tools: Vec<ToolCallState>,
    pub usage: Option<JsonObject>,
    pub incomplete_reason: Option<String>,
    pub terminal: Option<ChatTerminal>,
    pub(crate) tools_by_item_id: HashMap<String, usize>,
    pub(crate) tools_by_call_id: HashMap<String, usize>,
    pub(crate) tools_by_output_index: HashMap<String, usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolActionSnapshot {
    pub index: usize,
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatAction {
    ResponseCreated,
    TextDelta(String),
    ReasoningDelta(String),
    ToolStarted {
        tool: ToolActionSnapshot,
        initial_arguments: String,
    },
    ToolArgumentsDelta {
        tool: ToolActionSnapshot,
        delta: String,
    },
    ResponseCompleted,
}
