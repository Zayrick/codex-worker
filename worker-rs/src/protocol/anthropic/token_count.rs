use serde_json::Value;

use crate::core::JsonObject;

const MAX_TOKENIZER_CHUNK_CHARS: usize = 64 * 1024;

/// Port for a concrete tokenizer implementation.
///
/// The protocol owns which strings count as Codex input. A separately selected
/// adapter owns the tokenizer vocabulary (for parity, `cl100k_base`).
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
        .map(|(index, value)| count_in_chunks(value, counter) + usize::from(index > 0))
        .sum()
}

fn count_in_chunks(value: &str, counter: &(impl TokenCounter + ?Sized)) -> usize {
    let mut count = 0usize;
    let mut start = 0usize;
    let mut units = 0usize;

    for (index, character) in value.char_indices() {
        let width = character.len_utf16();
        if units > 0 && units + width > MAX_TOKENIZER_CHUNK_CHARS {
            count += counter.count_tokens(&value[start..index]);
            start = index;
            units = 0;
        }
        units += width;
    }
    if start < value.len() {
        count += counter.count_tokens(&value[start..]);
    }
    count
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
    use std::cell::RefCell;

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
    fn tokenization_is_injected_behind_a_narrow_port() {
        let body = into_object(json!({
            "instructions": "system words",
            "input": [{"content": [{"text": "user words"}]}],
            "tools": [{"name": "lookup", "parameters": {"type": "object"}}]
        }));
        assert_eq!(count_codex_input_tokens(&body, &WordCounter), 9);
    }

    #[test]
    fn bounds_each_tokenizer_call_without_adding_chunk_separators() {
        struct RecordingCounter(RefCell<Vec<usize>>);

        impl TokenCounter for RecordingCounter {
            fn count_tokens(&self, text: &str) -> usize {
                let length = text.encode_utf16().count();
                self.0.borrow_mut().push(length);
                length
            }
        }

        let text = "x".repeat(MAX_TOKENIZER_CHUNK_CHARS + 1);
        let body = into_object(json!({"instructions": text}));
        let counter = RecordingCounter(RefCell::new(Vec::new()));
        assert_eq!(
            count_codex_input_tokens(&body, &counter),
            MAX_TOKENIZER_CHUNK_CHARS + 1
        );
        assert_eq!(*counter.0.borrow(), vec![MAX_TOKENIZER_CHUNK_CHARS, 1]);
    }
}
