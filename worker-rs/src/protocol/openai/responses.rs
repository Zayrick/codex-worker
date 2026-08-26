//! Responses create/compact/WebSocket JSON adaptation.

use std::borrow::Cow;

use serde_json::{Value, json};

use crate::core::JsonObject;

use super::request_policy::{
    BodyEditor, apply_http_response_create_egress_policy_to,
    apply_websocket_response_create_egress_policy_to,
};

#[must_use]
pub fn to_codex_message_role(role: &str) -> &str {
    if role == "system" { "developer" } else { role }
}

/// Adapts a Responses create body and reports changes through `Cow` so an HTTP
/// transport may preserve the original encoded body when no rewrite is needed.
#[must_use]
pub fn adapt_responses_create_body<'a>(body: &'a JsonObject) -> Cow<'a, JsonObject> {
    let mut editor = BodyEditor::new(body);
    normalize_string_response_input(&mut editor);
    rewrite_system_message_roles(&mut editor);
    apply_http_response_create_egress_policy_to(&mut editor);
    editor.finish()
}

fn adapt_responses_websocket_create_body<'a>(body: &'a JsonObject) -> Cow<'a, JsonObject> {
    let mut editor = BodyEditor::new(body);
    normalize_string_response_input(&mut editor);
    rewrite_system_message_roles(&mut editor);
    apply_websocket_response_create_egress_policy_to(&mut editor);
    editor.finish()
}

#[must_use]
pub fn adapt_compact_body<'a>(body: &'a JsonObject) -> Cow<'a, JsonObject> {
    let mut editor = BodyEditor::new(body);
    rewrite_system_message_roles(&mut editor);
    editor.finish()
}

/// Returns the original wire message for malformed, unknown, or unchanged WS
/// frames. JSON serialization is attempted only after a supported policy changed
/// the body.
#[must_use]
pub fn adapt_responses_websocket_message(message: &str) -> String {
    let Ok(Value::Object(body)) = serde_json::from_str::<Value>(message) else {
        return message.to_owned();
    };
    let Some(kind) = body.get("type").and_then(Value::as_str) else {
        return message.to_owned();
    };
    let adapted = match kind {
        "response.create" => adapt_responses_websocket_create_body(&body),
        "response.append" => adapt_compact_body(&body),
        _ => return message.to_owned(),
    };
    match adapted {
        Cow::Borrowed(_) => message.to_owned(),
        Cow::Owned(body) => Value::Object(body).to_string(),
    }
}

fn normalize_string_response_input(editor: &mut BodyEditor<'_>) {
    let Some(input) = editor
        .current()
        .get("input")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return;
    };
    editor.make_mut().insert(
        "input".into(),
        json!([{
            "type":"message",
            "role":"user",
            "content":[{"type":"input_text","text":input}]
        }]),
    );
}

fn rewrite_system_message_roles(editor: &mut BodyEditor<'_>) {
    let replacements = editor
        .current()
        .get("input")
        .and_then(Value::as_array)
        .map(|input| {
            input
                .iter()
                .enumerate()
                .filter_map(|(index, item)| {
                    (item.as_object()?.get("role")?.as_str()? == "system").then_some(index)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if replacements.is_empty() {
        return;
    }

    let body = editor.make_mut();
    let Some(input) = body.get_mut("input").and_then(Value::as_array_mut) else {
        return;
    };
    for index in replacements {
        if let Some(item) = input.get_mut(index).and_then(Value::as_object_mut) {
            item.insert("role".into(), Value::String("developer".into()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn object(value: Value) -> JsonObject {
        value.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn create_normalizes_string_input_roles_and_egress_fields() {
        let body = object(json!({
            "model":"gpt-5.6-luna",
            "input":"hello",
            "store":true,
            "max_tokens":20,
            "previous_response_id":"resp_1",
            "generate":true,
            "prompt_cache_options":{"mode":"implicit"},
            "prompt_cache_retention":"24h",
            "safety_identifier":"safety_1",
            "stream_options":{"include_usage":true}
        }));
        assert_eq!(
            adapt_responses_create_body(&body).as_ref(),
            &object(json!({
                "model":"gpt-5.6-luna",
                "input":[{
                    "type":"message",
                    "role":"user",
                    "content":[{"type":"input_text","text":"hello"}]
                }],
                "store":false
            }))
        );
    }

    #[test]
    fn compact_only_rewrites_system_roles() {
        let body = object(json!({
            "input":[
                {"type":"message","role":"system","content":[]},
                {"type":"message","role":"user","content":[]}
            ],
            "store":true
        }));
        let adapted = adapt_compact_body(&body);
        assert_eq!(adapted["input"][0]["role"], "developer");
        assert_eq!(adapted["store"], true);
    }

    #[test]
    fn websocket_preserves_unknown_and_malformed_frames_verbatim() {
        for message in ["not json", r#"{"type":"future.event","store":true}"#] {
            assert_eq!(adapt_responses_websocket_message(message), message);
        }
        let adapted = adapt_responses_websocket_message(
            r#"{"type":"response.create","input":"hello","store":true,"previous_response_id":"resp_1","generate":true,"prompt_cache_options":{"mode":"explicit"},"prompt_cache_retention":"24h","safety_identifier":"safety_1","stream_options":{"include_usage":true},"unknown_extension":{"keep":true}}"#,
        );
        let parsed: Value = serde_json::from_str(&adapted).unwrap_or(Value::Null);
        assert_eq!(parsed["store"], false);
        assert!(parsed["input"].is_array());
        assert_eq!(parsed["previous_response_id"], "resp_1");
        assert_eq!(parsed["generate"], true);
        assert_eq!(parsed["stream_options"]["include_usage"], true);
        assert_eq!(parsed["unknown_extension"]["keep"], true);
        assert!(parsed.get("prompt_cache_options").is_none());
        assert!(parsed.get("prompt_cache_retention").is_none());
        assert!(parsed.get("safety_identifier").is_none());
    }
}
