use futures_util::{StreamExt, stream};
use serde_json::json;
use worker::{Date, Env, ScheduleContext, ScheduledEvent};

use crate::{
    application::{PushNotification, evaluate_codex_usage, reset_watch_notification},
    auth::{ApiKeyRepository, OAuthProvider, OAuthRefreshService, OAuthRepository},
    core::{ApiError, AppResult},
    upstream::codex::codex_subscription_from_usage,
};

const AUTH_PROXY_REFRESH_CONCURRENCY: usize = 4;

use super::{
    bark::BarkClient,
    codex::CodexClient,
    codex_resets::CodexResetsClient,
    config::WorkerConfig,
    dingtalk::DingTalkClient,
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

    if let Err(error) = monitor_reset_watch(&env).await {
        log_api_failure("scheduled_reset_watch", &error);
    }

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

    let accounts = match ApiKeyRepository::new(&store, &encryption_key)
        .read_auth_proxy_accounts()
        .await
    {
        Ok(accounts) => accounts,
        Err(error) => {
            log_api_failure("scheduled_auth_proxy_oauth_refresh", &error);
            return;
        }
    };
    stream::iter(accounts)
        .for_each_concurrent(AUTH_PROXY_REFRESH_CONCURRENCY, |account| {
            let provider = &provider;
            let clock = &clock;
            let store = &store;
            let encryption_key = &encryption_key;
            async move {
                let oauth =
                    OAuthRepository::for_auth_proxy_account(store, encryption_key, &account.id);
                let service = OAuthRefreshService::new(&oauth, provider, clock);
                if let Err(error) = service.refresh(Some(now_ms)).await {
                    log_api_failure("scheduled_auth_proxy_oauth_refresh", &error);
                }
            }
        })
        .await;
}

async fn monitor_reset_watch(env: &Env) -> AppResult<()> {
    let status = CodexResetsClient::fetch_status().await?;
    let now_ms = i64::try_from(Date::now().as_millis()).unwrap_or(i64::MAX);
    if let Some(notification) = reset_watch_notification(&status, now_ms) {
        deliver_notification(
            env,
            &notification,
            now_ms,
            "scheduled_reset_watch_bark_push",
            "scheduled_reset_watch_dingtalk_push",
        )
        .await;
    }
    Ok(())
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
    let evaluation = evaluate_codex_usage(previous.as_ref(), &subscription, now_ms);

    if let Some(notification) = evaluation.notification() {
        deliver_notification(
            env,
            &notification,
            now_ms,
            "scheduled_bark_push",
            "scheduled_dingtalk_push",
        )
        .await;
    }

    repository.store(&evaluation.state).await
}

async fn deliver_notification(
    env: &Env,
    notification: &PushNotification,
    now_ms: i64,
    bark_log_event: &str,
    dingtalk_log_event: &str,
) {
    let bark = async {
        let endpoint = WorkerConfig::bark_push_url(env)?;
        BarkClient::new(&endpoint)?.send(notification).await
    };
    let dingtalk = async {
        let webhook = WorkerConfig::dingtalk_webhook_url(env)?;
        let secret = WorkerConfig::dingtalk_secret(env)?;
        DingTalkClient::new(webhook, secret)
            .send(notification, now_ms)
            .await
    };
    let (bark_delivery, dingtalk_delivery) = futures_util::join!(bark, dingtalk);
    if let Err(error) = bark_delivery {
        log_api_failure(bark_log_event, &error);
    }
    if let Err(error) = dingtalk_delivery {
        log_api_failure(dingtalk_log_event, &error);
    }
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
