//! Declarative, copy-on-write policies for backend request bodies.

use std::borrow::Cow;

use serde_json::{Value, json};

use crate::core::JsonObject;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct RequestBodyPolicyDefinition {
    pub allowed_values: Vec<(String, Vec<Value>)>,
    pub remove: Vec<String>,
    pub overrides: JsonObject,
}

#[derive(Debug, Clone, PartialEq)]
enum PolicyStep {
    Remove(Vec<String>),
    AllowOnly(Vec<(String, Vec<Value>)>),
    Override(JsonObject),
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct RequestBodyPolicy {
    steps: Vec<PolicyStep>,
}

impl RequestBodyPolicy {
    #[must_use]
    pub fn from_definition(definition: RequestBodyPolicyDefinition) -> Self {
        Self {
            steps: vec![
                PolicyStep::Remove(definition.remove),
                PolicyStep::AllowOnly(definition.allowed_values),
                PolicyStep::Override(definition.overrides),
            ],
        }
    }

    #[must_use]
    pub fn compose(policies: impl IntoIterator<Item = Self>) -> Self {
        Self {
            steps: policies
                .into_iter()
                .flat_map(|policy| policy.steps)
                .collect(),
        }
    }

    #[must_use]
    pub fn remove(keys: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            steps: vec![PolicyStep::Remove(
                keys.into_iter().map(Into::into).collect(),
            )],
        }
    }

    #[must_use]
    pub fn allow_only(values: Vec<(String, Vec<Value>)>) -> Self {
        Self {
            steps: vec![PolicyStep::AllowOnly(values)],
        }
    }

    #[must_use]
    pub fn override_fields(fields: JsonObject) -> Self {
        Self {
            steps: vec![PolicyStep::Override(fields)],
        }
    }

    /// Applies the policy without mutating the caller's object. An unchanged
    /// body is returned borrowed, preserving the TypeScript identity contract.
    #[must_use]
    pub fn apply<'a>(&self, body: &'a JsonObject) -> Cow<'a, JsonObject> {
        let mut editor = BodyEditor::new(body);
        self.apply_to(&mut editor);
        editor.finish()
    }

    pub(crate) fn apply_to(&self, editor: &mut BodyEditor<'_>) {
        for step in &self.steps {
            match step {
                PolicyStep::Remove(keys) => {
                    for key in keys {
                        if editor.current().contains_key(key) {
                            editor.make_mut().remove(key);
                        }
                    }
                }
                PolicyStep::AllowOnly(entries) => {
                    for (key, allowed) in entries {
                        let remove = editor
                            .current()
                            .get(key)
                            .is_some_and(|value| !allowed.iter().any(|item| item == value));
                        if remove {
                            editor.make_mut().remove(key);
                        }
                    }
                }
                PolicyStep::Override(fields) => {
                    for (key, value) in fields {
                        let changed = editor.current().get(key) != Some(value);
                        if changed {
                            editor.make_mut().insert(key.clone(), value.clone());
                        }
                    }
                }
            }
        }
    }
}

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

#[must_use]
fn base_response_create_egress_policy() -> RequestBodyPolicy {
    let mut overrides = JsonObject::new();
    overrides.insert("store".into(), Value::Bool(false));
    RequestBodyPolicy::from_definition(RequestBodyPolicyDefinition {
        allowed_values: vec![("service_tier".into(), vec![json!("priority")])],
        remove: REMOVED_RESPONSE_FIELDS
            .into_iter()
            .map(str::to_owned)
            .collect(),
        overrides,
    })
}

#[must_use]
pub fn http_response_create_egress_policy() -> RequestBodyPolicy {
    RequestBodyPolicy::compose([
        base_response_create_egress_policy(),
        RequestBodyPolicy::remove(REMOVED_HTTP_RESPONSE_FIELDS),
    ])
}

#[must_use]
pub fn websocket_response_create_egress_policy() -> RequestBodyPolicy {
    base_response_create_egress_policy()
}

#[must_use]
pub fn converted_response_egress_policy() -> RequestBodyPolicy {
    let overrides = serde_json::from_value(json!({
        "instructions": "",
        "stream": true,
        "include": ["reasoning.encrypted_content"]
    }))
    .unwrap_or_default();
    RequestBodyPolicy::compose([
        http_response_create_egress_policy(),
        RequestBodyPolicy::override_fields(overrides),
    ])
}

#[must_use]
pub fn apply_http_response_create_egress_policy<'a>(body: &'a JsonObject) -> Cow<'a, JsonObject> {
    http_response_create_egress_policy().apply(body)
}

#[must_use]
pub fn apply_websocket_response_create_egress_policy<'a>(
    body: &'a JsonObject,
) -> Cow<'a, JsonObject> {
    websocket_response_create_egress_policy().apply(body)
}

#[must_use]
pub fn apply_converted_response_egress_policy<'a>(body: &'a JsonObject) -> Cow<'a, JsonObject> {
    converted_response_egress_policy().apply(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn object(value: Value) -> JsonObject {
        value.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn response_policy_is_copy_on_write_and_preserves_extensions() {
        let satisfied = object(json!({"model":"gpt-5.6-luna","store":false}));
        assert!(matches!(
            apply_http_response_create_egress_policy(&satisfied),
            Cow::Borrowed(_)
        ));

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
        let output = apply_http_response_create_egress_policy(&input);
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
            apply_websocket_response_create_egress_policy(&input).as_ref(),
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
    fn converted_policy_centralizes_transport_invariants() {
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

    #[test]
    fn declarative_policy_composes_remove_allow_and_override() {
        let mut overrides = JsonObject::new();
        overrides.insert("required_parameter".into(), json!("upstream-value"));
        let policy = RequestBodyPolicy::from_definition(RequestBodyPolicyDefinition {
            allowed_values: vec![("mode".into(), vec![json!("supported")])],
            remove: vec!["retired_parameter".into()],
            overrides,
        });
        let input = object(json!({
            "retired_parameter":true,
            "required_parameter":"downstream-value",
            "mode":"legacy",
            "future_parameter":"preserved"
        }));
        assert_eq!(
            policy.apply(&input).as_ref(),
            &object(json!({
                "required_parameter":"upstream-value",
                "future_parameter":"preserved"
            }))
        );
    }
}
