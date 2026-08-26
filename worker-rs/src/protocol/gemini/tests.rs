use std::collections::HashMap;

use serde_json::{Value, json};

use crate::core::JsonObject;

use super::*;

const TERMINAL_GOLDEN: &str = r#"
{
  "candidates": [{
    "content": {
      "role": "model",
      "parts": [
        {"thought": true, "text": "thinking", "thoughtSignature": "signature"},
        {"text": "answer"},
        {"functionCall": {"id": "call_1", "name": "lookup_original", "args": {"q": "status"}}},
        {"inlineData": {"data": "aW1hZ2U=", "mimeType": "image/png"}}
      ]
    },
    "finishReason": "STOP"
  }],
  "modelVersion": "resolved-model",
  "responseId": "resp_gemini",
  "createTime": "2023-11-14T22:13:20.000Z",
  "usageMetadata": {
    "promptTokenCount": 12,
    "candidatesTokenCount": 7,
    "totalTokenCount": 19,
    "trafficType": "PROVISIONED_THROUGHPUT",
    "cachedContentTokenCount": 3,
    "thoughtsTokenCount": 2
  }
}
"#;

#[test]
fn path_matcher_decodes_models_and_rejects_unsupported_shapes() {
    assert_eq!(
        match_gemini_action_path("/v1beta/models/gpt-5.6-luna:generateContent/"),
        Some(GeminiActionPath {
            model: "gpt-5.6-luna".into(),
            action: GeminiAction::GenerateContent,
        })
    );
    assert_eq!(
        match_gemini_model_path("/v1beta/models/%67pt-5.6-luna"),
        Some("gpt-5.6-luna".into())
    );
    assert!(match_gemini_model_path("/v1beta/models/bad%2Fmodel").is_none());
    assert!(match_gemini_model_path("/v1beta/models/bad%ZZmodel").is_none());
    assert!(match_gemini_action_path("/v1beta/models/model:testAction").is_none());
}

#[test]
fn request_adaptation_maps_gemini_fields() {
    let long_name = format!("mcp__weather__{}", "lookup".repeat(12));
    let signature = format!("gAAAA{}", "G".repeat(120));
    let request = json!({
        "systemInstruction": { "parts": [{ "text": "Be concise." }] },
        "contents": [
            {
                "role": "user",
                "parts": [
                    { "text": "weather" },
                    { "inlineData": { "mimeType": "image/png", "data": "aW1hZ2U=" } }
                ]
            },
            {
                "role": "model",
                "parts": [
                    { "text": "checking", "thought": true, "thoughtSignature": signature },
                    { "functionCall": { "id": "call_weather", "name": long_name, "args": { "city": "Shanghai" } } }
                ]
            },
            {
                "role": "user",
                "parts": [{
                    "functionResponse": {
                        "id": "call_weather",
                        "name": long_name,
                        "response": { "result": "sunny" }
                    }
                }]
            }
        ],
        "tools": [{
            "functionDeclarations": [{
                "name": long_name,
                "description": "Look up weather",
                "parameters": {
                    "$schema": "https://json-schema.org/draft/2020-12/schema",
                    "type": "object",
                    "properties": { "city": { "type": "string" } }
                }
            }]
        }],
        "toolConfig": {
            "functionCallingConfig": { "mode": "ANY", "allowedFunctionNames": [long_name] }
        },
        "generationConfig": { "thinkingConfig": { "thinkingBudget": 20_000 } },
        "serviceTier": "fast"
    });
    let adapted = gemini_request_to_responses(request.as_object().unwrap(), "gpt-5.6-luna")
        .expect("request adapts");
    assert_eq!(adapted.body.get("model"), Some(&json!("gpt-5.6-luna")));
    assert_eq!(
        adapted.body.get("reasoning"),
        Some(&json!({ "effort": "high" }))
    );
    assert_eq!(adapted.body.get("service_tier"), Some(&json!("priority")));
    let tool = adapted.body["tools"][0].as_object().unwrap();
    let shortened = tool["name"].as_str().unwrap();
    assert_eq!(shortened.encode_utf16().count(), 64);
    assert!(tool["parameters"].get("$schema").is_none());
    assert_eq!(tool["parameters"]["additionalProperties"], json!(false));
    assert_eq!(
        adapted.body["tool_choice"],
        json!({ "type": "function", "name": shortened })
    );
    assert_eq!(adapted.reverse_tool_names.get(shortened), Some(&long_name));
    let input = adapted.body["input"].as_array().unwrap();
    assert!(input.iter().any(|item| item["role"] == "developer"));
    assert!(
        input
            .iter()
            .any(|item| { item["type"] == "reasoning" && item["encrypted_content"] == signature })
    );
    assert!(
        input
            .iter()
            .any(|item| { item["type"] == "function_call" && item["call_id"] == "call_weather" })
    );
    assert!(input.iter().any(|item| {
        item["type"] == "function_call_output"
            && item["call_id"] == "call_weather"
            && item["output"] == "sunny"
    }));
}

struct LengthCounter;

impl TokenCounter for LengthCounter {
    fn count_tokens(&self, request: &JsonObject) -> u64 {
        request["input"].as_array().map_or(0, |input| input.len()) as u64 + 2
    }
}

#[test]
fn count_request_supports_nested_body() {
    let input = json!({
        "generateContentRequest": {
            "contents": [{ "role": "user", "parts": [{ "text": "Count this." }] }]
        }
    });
    assert_eq!(
        gemini_count_tokens(input.as_object().unwrap(), "model", &LengthCounter).unwrap(),
        json!({ "totalTokens": 3 })
    );
}

#[test]
fn model_catalog_list_and_detail_match_gemini_shape() {
    let catalog = json!({
        "models": [{
            "slug": "gpt-5.6-luna",
            "display_name": "GPT-5.6 Luna",
            "description": "Fast model",
            "context_window": 272_000
        }, null, { "missing": "id" }]
    });
    let list = gemini_model_list(&catalog).unwrap();
    assert_eq!(list["models"].as_array().unwrap().len(), 1);
    let detail = gemini_model_detail(&catalog, "gpt-5.6-luna").unwrap();
    assert_eq!(
        detail,
        json!({
            "name": "models/gpt-5.6-luna",
            "baseModelId": "gpt-5.6-luna",
            "version": "gpt-5.6-luna",
            "displayName": "GPT-5.6 Luna",
            "description": "Fast model",
            "supportedGenerationMethods": ["generateContent", "countTokens"],
            "inputTokenLimit": 272_000
        })
    );
    assert_eq!(
        gemini_model_detail(&catalog, "missing").unwrap_err().status,
        404
    );
}

#[test]
fn terminal_response_matches_golden_fixture() {
    let response = json!({
        "id": "resp_gemini",
        "model": "resolved-model",
        "created_at": 1_700_000_000,
        "usage": {
            "input_tokens": 12,
            "output_tokens": 7,
            "total_tokens": 19,
            "input_tokens_details": { "cached_tokens": 3 },
            "output_tokens_details": { "reasoning_tokens": 2 }
        },
        "output": [
            {
                "type": "reasoning",
                "summary": [{ "type": "summary_text", "text": "thinking" }],
                "encrypted_content": "signature"
            },
            { "type": "message", "content": [{ "type": "output_text", "text": "answer" }] },
            {
                "type": "function_call",
                "call_id": "call_1",
                "name": "lookup_short",
                "arguments": "{\"q\":\"status\"}"
            },
            { "type": "image_generation_call", "output_format": "png", "result": "aW1hZ2U=" }
        ]
    });
    let reverse = HashMap::from([("lookup_short".into(), "lookup_original".into())]);
    let actual = gemini_response_from_terminal(
        response.as_object().unwrap(),
        "requested-model",
        &reverse,
        false,
    )
    .unwrap();
    let expected: Value = serde_json::from_str(TERMINAL_GOLDEN).unwrap();
    assert_eq!(actual, expected);
}

#[test]
fn stream_presenter_emits_data_and_terminal_usage_without_duplicates() {
    let mut presenter = GeminiStreamPresenter::new(GeminiStreamOptions {
        model: "requested-model".into(),
        reverse_tool_names: HashMap::from([("lookup_short".into(), "lookup_original".into())]),
    });
    let events = [
        json!({
            "type": "response.created",
            "response": { "id": "resp_stream", "model": "resolved-model" }
        }),
        json!({ "type": "response.output_text.delta", "delta": "hello" }),
        json!({
            "type": "response.output_item.done",
            "output_index": 1,
            "item": {
                "id": "fc_1",
                "type": "function_call",
                "call_id": "call_1",
                "name": "lookup_short",
                "arguments": "{\"q\":\"worker\"}"
            }
        }),
        json!({
            "type": "response.completed",
            "response": {
                "id": "resp_stream",
                "model": "resolved-model",
                "usage": { "input_tokens": 8, "output_tokens": 3 },
                "output": [
                    { "type": "message", "content": [{ "type": "output_text", "text": "hello" }] },
                    {
                        "id": "fc_1",
                        "type": "function_call",
                        "call_id": "call_1",
                        "name": "lookup_short",
                        "arguments": "{\"q\":\"worker\"}"
                    }
                ]
            }
        }),
    ];
    let rendered = events
        .into_iter()
        .flat_map(|event| presenter.push(event))
        .map(|event| event.render())
        .collect::<String>();
    assert!(presenter.is_terminal());
    assert!(rendered.contains("\"text\":\"hello\""));
    assert!(rendered.contains("\"name\":\"lookup_original\""));
    assert!(rendered.contains("\"id\":\"call_1\""));
    assert!(rendered.contains("\"finishReason\":\"STOP\""));
    assert!(rendered.contains("\"promptTokenCount\":8"));
    assert!(presenter.finish().is_empty());
}

#[test]
fn stream_finish_turns_truncation_into_named_google_error() {
    let mut presenter = GeminiStreamPresenter::new(GeminiStreamOptions {
        model: "model".into(),
        reverse_tool_names: HashMap::new(),
    });
    presenter.push(json!({
        "type": "response.created",
        "response": { "id": "resp_truncated", "model": "model" }
    }));
    presenter.push(json!({ "type": "response.output_text.delta", "delta": "partial" }));
    let events = presenter.finish();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].event.as_deref(), Some("error"));
    assert_eq!(events[0].data["error"]["status"], "INTERNAL");
}

#[test]
fn error_envelope_preserves_google_status_codes() {
    let error = gemini_upstream_error(403, None);
    assert_eq!(
        gemini_error_payload(&error),
        json!({
            "error": {
                "code": 403,
                "message": "The ChatGPT Codex backend returned HTTP 403.",
                "status": "PERMISSION_DENIED"
            }
        })
    );
}
