use serde_json::Value;

use crate::core::JsonObject;

/// Tokenizer used by the token-count endpoints.
pub trait TokenCounter {
    fn count_tokens(&self, text: &str) -> usize;
}

pub fn count_codex_input_tokens(
    body: &JsonObject,
    counter: &(impl TokenCounter + ?Sized),
) -> usize {
    let values = collect_counted_text(body);
    values
        .iter()
        .enumerate()
        .map(|(index, value)| counter.count_tokens(value) + usize::from(index > 0))
        .sum()
}

pub fn collect_counted_text(body: &JsonObject) -> Vec<String> {
    let mut values = Vec::new();
    append_string(&mut values, body.get("instructions"));
    append_input(&mut values, body.get("input"));
    append_tools(&mut values, body.get("tools"));
    append_text_controls(&mut values, body.get("text"));
    values
}

fn append_input(values: &mut Vec<String>, input: Option<&Value>) {
    let Some(input) = input.and_then(Value::as_array) else {
        return;
    };
    for raw in input {
        let Some(raw) = raw.as_object() else {
            continue;
        };
        append_string(values, raw.get("name"));
        append_string(values, raw.get("arguments"));
        append_string(values, raw.get("input"));
        match raw.get("output") {
            Some(Value::String(output)) => values.push(output.clone()),
            Some(Value::Array(output)) => append_content(values, Some(output)),
            _ => {}
        }
        append_content(values, raw.get("content").and_then(Value::as_array));
        append_content(values, raw.get("summary").and_then(Value::as_array));
    }
}

fn append_content(values: &mut Vec<String>, content: Option<&Vec<Value>>) {
    let Some(content) = content else {
        return;
    };
    for raw in content {
        let Some(raw) = raw.as_object() else {
            continue;
        };
        append_string(values, raw.get("text"));
    }
}

fn append_tools(values: &mut Vec<String>, tools: Option<&Value>) {
    let Some(tools) = tools.and_then(Value::as_array) else {
        return;
    };
    for raw in tools {
        let Some(raw) = raw.as_object() else {
            continue;
        };
        append_string(values, raw.get("name"));
        append_string(values, raw.get("description"));
        if let Some(parameters) = raw.get("parameters") {
            values.push(parameters.to_string());
        }
    }
}

fn append_text_controls(values: &mut Vec<String>, text: Option<&Value>) {
    let Some(format) = text
        .and_then(Value::as_object)
        .and_then(|text| text.get("format"))
        .and_then(Value::as_object)
    else {
        return;
    };
    append_string(values, format.get("name"));
    if let Some(schema) = format.get("schema") {
        values.push(schema.to_string());
    }
}

fn append_string(values: &mut Vec<String>, value: Option<&Value>) {
    if let Some(value) = value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        values.push(value.to_owned());
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::protocol::anthropic::into_object;

    struct WordCounter;

    impl TokenCounter for WordCounter {
        fn count_tokens(&self, text: &str) -> usize {
            text.split_whitespace().count()
        }
    }

    #[test]
    fn counts_codex_request_text_fields() {
        let body = into_object(json!({
            "instructions": "system words",
            "input": [{"content": [{"text": "user words"}]}],
            "tools": [{"name": "lookup", "parameters": {"type": "object"}}]
        }));
        assert_eq!(count_codex_input_tokens(&body, &WordCounter), 9);
    }
}
