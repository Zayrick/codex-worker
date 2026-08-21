use serde_json::json;
use worker::{Date, Env, ScheduleContext, ScheduledEvent};

use crate::{
    application::evaluate_codex_usage,
    auth::{OAuthProvider, OAuthRefreshService, OAuthRepository},
    core::{ApiError, AppResult},
    upstream::codex::codex_subscription_from_usage,
};

use super::{
    bark::BarkClient,
    codex::CodexClient,
    config::WorkerConfig,
    oauth::{CloudflareClock, CloudflareOAuthHttpClient},
    store::CloudflareSecretStore,
    usage_store::CodexUsageStateRepository,
};

pub async fn handle_scheduled(_event: ScheduledEvent, env: Env, _context: ScheduleContext) {
    let Ok(encryption_key) = WorkerConfig::encryption_key(&env) else {
        log_failure("scheduled_maintenance", "invalid_worker_configuration");
        return;
    };
    let Ok(store) = CloudflareSecretStore::from_env(&env) else {
        log_failure("scheduled_maintenance", "auth_storage_unavailable");
        return;
    };
    let oauth = OAuthRepository::new(&store, &encryption_key);
    let now_ms = i64::try_from(Date::now().as_millis()).unwrap_or(i64::MAX);

    if let Err(error) = monitor_usage(&env, &store, &oauth, &encryption_key, now_ms).await {
        log_api_failure("scheduled_usage_monitor", &error);
    }

    let clock = CloudflareClock;
    let http = CloudflareOAuthHttpClient::new(None);
    let provider = OAuthProvider::new(&http, &clock);
    let service = OAuthRefreshService::new(&oauth, &provider, &clock);
    if let Err(error) = service.refresh(Some(now_ms)).await {
        log_api_failure("scheduled_oauth_refresh", &error);
    }
}

async fn monitor_usage(
    env: &Env,
    store: &CloudflareSecretStore,
    oauth: &OAuthRepository<'_>,
    encryption_key: &str,
    now_ms: i64,
) -> AppResult<()> {
    let relay_origin = WorkerConfig::relay_origin(env)?;
    let client = CodexClient::new(oauth, relay_origin);
    let usage = client.fetch_usage(None).await?;
    let subscription =
        codex_subscription_from_usage(&usage.payload, usage.metadata, now_ms as f64)?;
    let repository = CodexUsageStateRepository::new(store, encryption_key);
    let previous = repository.read().await?;
    let mut evaluation = evaluate_codex_usage(previous.as_ref(), &subscription, now_ms);

    if let Some(notification) = evaluation.notification() {
        let delivery = match WorkerConfig::bark_push_url(env) {
            Ok(endpoint) => match BarkClient::new(&endpoint) {
                Ok(client) => client.send(&notification).await,
                Err(error) => Err(error),
            },
            Err(error) => Err(error),
        };
        match delivery {
            Ok(()) => evaluation.mark_entry_alerts_delivered(),
            Err(error) => log_api_failure("scheduled_bark_push", &error),
        }
    }

    repository.store(&evaluation.state).await
}

fn log_api_failure(event: &str, error: &ApiError) {
    log_failure(
        event,
        error.code.as_deref().unwrap_or("scheduled_task_failed"),
    );
}

fn log_failure(event: &str, code: &str) {
    worker::console_error!(
        "{}",
        json!({
            "event": event,
            "status": "failed",
            "code": code,
        })
    );
}
