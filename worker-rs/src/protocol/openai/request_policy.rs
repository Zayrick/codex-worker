//! Copy-on-write policies for backend request bodies.

use std::borrow::Cow;

use serde_json::Value;

use crate::core::JsonObject;

pub(crate) struct BodyEditor<'a> {
    original: &'a JsonObject,
    owned: Option<JsonObject>,
}

impl<'a> BodyEditor<'a> {
    pub(crate) fn new(original: &'a JsonObject) -> Self {
        Self {
            original,
            owned: None,
        }
    }

    pub(crate) fn current(&self) -> &JsonObject {
        self.owned.as_ref().unwrap_or(self.original)
    }

    pub(crate) fn make_mut(&mut self) -> &mut JsonObject {
        self.owned.get_or_insert_with(|| self.original.clone())
    }

    pub(crate) fn finish(self) -> Cow<'a, JsonObject> {
        match self.owned {
            Some(body) => Cow::Owned(body),
            None => Cow::Borrowed(self.original),
        }
    }
}

const REMOVED_RESPONSE_FIELDS: [&str; 12] = [
    "max_completion_tokens",
    "max_output_tokens",
    "maxOutputTokens",
    "max_tokens",
    "context_management",
    "temperature",
    "top_p",
    "truncation",
    "user",
    "prompt_cache_options",
    "prompt_cache_retention",
    "safety_identifier",
];

const REMOVED_HTTP_RESPONSE_FIELDS: [&str; 3] =
    ["previous_response_id", "generate", "stream_options"];

fn apply_base_policy(editor: &mut BodyEditor<'_>) {
    remove_fields(editor, &REMOVED_RESPONSE_FIELDS);
    if editor
        .current()
        .get("service_tier")
        .is_some_and(|value| value != "priority")
    {
        editor.make_mut().remove("service_tier");
    }
    set_field(editor, "store", Value::Bool(false));
}

pub(crate) fn apply_http_response_create_egress_policy_to(editor: &mut BodyEditor<'_>) {
    apply_base_policy(editor);
    remove_fields(editor, &REMOVED_HTTP_RESPONSE_FIELDS);
}

pub(crate) fn apply_websocket_response_create_egress_policy_to(editor: &mut BodyEditor<'_>) {
    apply_base_policy(editor);
}

fn remove_fields(editor: &mut BodyEditor<'_>, fields: &[&str]) {
    for field in fields {
        if editor.current().contains_key(*field) {
            editor.make_mut().remove(*field);
        }
    }
}

fn set_field(editor: &mut BodyEditor<'_>, field: &str, value: Value) {
    if editor.current().get(field) != Some(&value) {
        editor.make_mut().insert(field.into(), value);
    }
}

#[must_use]
pub fn apply_converted_response_egress_policy<'a>(body: &'a JsonObject) -> Cow<'a, JsonObject> {
    let mut editor = BodyEditor::new(body);
    apply_http_response_create_egress_policy_to(&mut editor);
    set_field(&mut editor, "instructions", Value::String(String::new()));
    set_field(&mut editor, "stream", Value::Bool(true));
    set_field(
        &mut editor,
        "include",
        Value::Array(vec![Value::String("reasoning.encrypted_content".into())]),
    );
    editor.finish()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn object(value: Value) -> JsonObject {
        value.as_object().cloned().unwrap_or_default()
    }

    fn apply_http_policy(body: &JsonObject) -> Cow<'_, JsonObject> {
        let mut editor = BodyEditor::new(body);
        apply_http_response_create_egress_policy_to(&mut editor);
        editor.finish()
    }

    fn apply_websocket_policy(body: &JsonObject) -> Cow<'_, JsonObject> {
        let mut editor = BodyEditor::new(body);
        apply_websocket_response_create_egress_policy_to(&mut editor);
        editor.finish()
    }

    #[test]
    fn response_policy_is_copy_on_write_and_preserves_extensions() {
        let satisfied = object(json!({"model":"gpt-5.6-luna","store":false}));
        assert!(matches!(apply_http_policy(&satisfied), Cow::Borrowed(_)));

        let input = object(json!({
            "model":"gpt-5.6-luna",
            "store":true,
            "service_tier":"flex",
            "max_tokens":1024,
            "previous_response_id":"resp_1",
            "generate":true,
            "prompt_cache_options":{"mode":"implicit"},
            "prompt_cache_retention":"24h",
            "safety_identifier":"safety_1",
            "stream_options":{"include_usage":true},
            "unknown_extension":{"keep":true}
        }));
        let output = apply_http_policy(&input);
        assert_eq!(
            output.as_ref(),
            &object(json!({
                "model":"gpt-5.6-luna",
                "store":false,
                "unknown_extension":{"keep":true}
            }))
        );
        assert_eq!(input.get("store"), Some(&Value::Bool(true)));
    }

    #[test]
    fn websocket_policy_only_removes_websocket_unsupported_fields() {
        let input = object(json!({
            "model":"gpt-5.6-luna",
            "store":false,
            "previous_response_id":"resp_1",
            "generate":true,
            "prompt_cache_options":{"mode":"explicit"},
            "prompt_cache_retention":"24h",
            "safety_identifier":"safety_1",
            "stream_options":{"include_usage":true}
        }));
        assert_eq!(
            apply_websocket_policy(&input).as_ref(),
            &object(json!({
                "model":"gpt-5.6-luna",
                "store":false,
                "previous_response_id":"resp_1",
                "generate":true,
                "stream_options":{"include_usage":true}
            }))
        );
    }

    #[test]
    fn converted_policy_applies_required_fields() {
        let input = object(json!({
            "instructions":"downstream",
            "store":true,
            "stream":false,
            "include":["downstream.value"],
            "max_tokens":1024,
            "context_management":[{"type":"compaction"}],
            "previous_response_id":"resp_1",
            "generate":true,
            "prompt_cache_options":{"mode":"implicit"},
            "prompt_cache_retention":"24h",
            "safety_identifier":"safety_1",
            "stream_options":{"include_usage":true}
        }));
        assert_eq!(
            apply_converted_response_egress_policy(&input).as_ref(),
            &object(json!({
                "instructions":"",
                "store":false,
                "stream":true,
                "include":["reasoning.encrypted_content"]
            }))
        );
    }
}
