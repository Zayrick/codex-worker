use serde::Serialize;
use worker::{Env, Request, Response};

use crate::{
    application::{MonitoredQuotaWindow, StatusRoute},
    core::ApiError,
};

use super::{
    application_page::application_page, config::WorkerConfig, response,
    store::CloudflareSecretStore, usage_store::CodexUsageStateRepository,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicUsageSnapshot<'a> {
    sampled_at: i64,
    plan_type: Option<&'a str>,
    windows: Vec<PublicQuotaWindow<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicQuotaWindow<'a> {
    id: &'a str,
    category: crate::upstream::codex::CodexQuotaCategory,
    name: &'a str,
    kind: crate::upstream::codex::CodexQuotaWindowKind,
    used_percent: Option<f64>,
    remaining_percent: Option<f64>,
    limit_window_seconds: Option<f64>,
    reset_at: Option<i64>,
}

impl<'a> From<&'a MonitoredQuotaWindow> for PublicQuotaWindow<'a> {
    fn from(window: &'a MonitoredQuotaWindow) -> Self {
        Self {
            id: &window.id,
            category: window.category,
            name: &window.name,
            kind: window.kind,
            used_percent: window.used_percent,
            remaining_percent: window.remaining_percent,
            limit_window_seconds: window.limit_window_seconds,
            reset_at: window.reset_at,
        }
    }
}

pub async fn handle_status(
    route: StatusRoute,
    request: &Request,
    env: &Env,
) -> worker::Result<Response> {
    match route {
        StatusRoute::Page => match application_page(request, env).await {
            Ok(response) => Ok(response),
            Err(_) => response::api_error(&status_unavailable()),
        },
        StatusRoute::Usage => usage_snapshot(env).await,
    }
}

async fn usage_snapshot(env: &Env) -> worker::Result<Response> {
    let result = async {
        let encryption_key = WorkerConfig::encryption_key(env)?;
        let store = CloudflareSecretStore::from_env(env)?;
        CodexUsageStateRepository::new(&store, &encryption_key)
            .read()
            .await
    }
    .await;

    match result {
        Ok(Some(state)) => response::json(
            &PublicUsageSnapshot {
                sampled_at: state.sampled_at,
                plan_type: state.plan_type.as_deref(),
                windows: state.windows.iter().map(PublicQuotaWindow::from).collect(),
            },
            200,
        ),
        Ok(None) => response::json(&serde_json::json!({ "snapshot": null }), 200),
        Err(_) => response::api_error(&status_unavailable()),
    }
}

fn status_unavailable() -> ApiError {
    ApiError::new(503, "Usage status is temporarily unavailable.")
        .with_kind("server_error")
        .with_code("usage_status_unavailable")
}
