use serde_json::{Map, Value, json};

use crate::core::{ApiError, AppResult, object, string_field};

pub const MAX_MODEL_CATALOG_BYTES: usize = 1024 * 1024;

pub fn to_openai_model_list(payload: &Value) -> AppResult<Value> {
    let models = object(payload)
        .and_then(|payload| payload.get("models"))
        .and_then(Value::as_array)
        .ok_or_else(invalid_model_catalog)?;
    let mut data = Vec::with_capacity(models.len());
    for raw in models {
        let Some(raw) = raw.as_object() else {
            continue;
        };
        let Some(id) = string_field(Some(raw), "id").or_else(|| string_field(Some(raw), "slug"))
        else {
            continue;
        };
        let mut model = Map::from_iter([
            ("id".into(), Value::String(id.to_owned())),
            ("object".into(), Value::String("model".into())),
        ]);
        if let Some(created) = raw
            .get("created")
            .filter(|value| value.as_f64().is_some_and(|number| number.is_finite()))
        {
            model.insert("created".into(), created.clone());
        }
        if let Some(owned_by) = string_field(Some(raw), "owned_by") {
            model.insert("owned_by".into(), Value::String(owned_by.to_owned()));
        }
        data.push(Value::Object(model));
    }
    Ok(json!({ "object": "list", "data": data }))
}

fn invalid_model_catalog() -> ApiError {
    ApiError::new(502, "The Codex backend returned an invalid model catalog.")
        .with_kind("upstream_error")
        .with_code("invalid_codex_model_catalog")
}
