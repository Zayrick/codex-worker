use serde_json::{Map, Value, json};

use crate::core::{ApiError, AppResult, object, string_field};

pub fn gemini_model_list(payload: &Value) -> AppResult<Value> {
    Ok(json!({ "models": gemini_models(payload)? }))
}

pub fn gemini_model_detail(payload: &Value, model_id: &str) -> AppResult<Value> {
    let expected = format!("models/{model_id}");
    gemini_models(payload)?
        .into_iter()
        .find(|model| model.get("name").and_then(Value::as_str) == Some(expected.as_str()))
        .ok_or_else(|| {
            ApiError::new(404, format!("Model '{model_id}' was not found."))
                .with_kind("not_found")
                .with_code("NOT_FOUND")
        })
}

pub fn gemini_models(payload: &Value) -> AppResult<Vec<Value>> {
    let source = object(payload)
        .and_then(|payload| payload.get("models"))
        .and_then(Value::as_array)
        .ok_or_else(invalid_model_catalog)?;
    let mut models = Vec::with_capacity(source.len());
    for raw in source {
        let Some(raw) = raw.as_object() else {
            continue;
        };
        let Some(id) = string_field(Some(raw), "id").or_else(|| string_field(Some(raw), "slug"))
        else {
            continue;
        };
        let display_name = string_field(Some(raw), "display_name").unwrap_or(id);
        let mut model = Map::new();
        model.insert("name".into(), Value::String(format!("models/{id}")));
        model.insert("baseModelId".into(), Value::String(id.to_owned()));
        model.insert("version".into(), Value::String(id.to_owned()));
        model.insert("displayName".into(), Value::String(display_name.to_owned()));
        model.insert(
            "description".into(),
            Value::String(
                string_field(Some(raw), "description")
                    .unwrap_or(display_name)
                    .to_owned(),
            ),
        );
        model.insert(
            "supportedGenerationMethods".into(),
            json!(["generateContent", "countTokens"]),
        );
        if let Some(limit) = finite_number(raw.get("context_window"))
            .or_else(|| finite_number(raw.get("max_context_window")))
        {
            model.insert("inputTokenLimit".into(), limit.clone());
        }
        models.push(Value::Object(model));
    }
    Ok(models)
}

fn finite_number(value: Option<&Value>) -> Option<&Value> {
    value?.as_f64()?.is_finite().then_some(value?)
}

fn invalid_model_catalog() -> ApiError {
    ApiError::new(502, "The Codex backend returned an invalid model catalog.")
        .with_kind("upstream_error")
        .with_code("INTERNAL")
}
