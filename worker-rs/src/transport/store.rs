use std::time::Duration;

use async_trait::async_trait;
use worker::{Delay, Env, KvStore};

use crate::{
    auth::SecretStore,
    core::{ApiError, AppResult},
};

const MIN_KV_CACHE_TTL_SECONDS: u64 = 30;

#[derive(Debug, Clone)]
pub struct CloudflareSecretStore {
    kv: KvStore,
}

impl CloudflareSecretStore {
    pub fn from_env(env: &Env) -> AppResult<Self> {
        env.kv("AUTH_KV")
            .map(|kv| Self { kv })
            .map_err(|_| storage_unavailable())
    }
}

#[async_trait(?Send)]
impl SecretStore for CloudflareSecretStore {
    async fn get(&self, key: &str, cache_ttl: Option<u64>) -> AppResult<Option<String>> {
        let mut get = self.kv.get(key);
        // Cloudflare KV currently accepts edge cache TTLs of at least 30 seconds.
        if let Some(ttl) = cache_ttl.filter(|ttl| *ttl >= MIN_KV_CACHE_TTL_SECONDS) {
            get = get.cache_ttl(ttl);
        }
        get.text().await.map_err(|_| storage_unavailable())
    }

    async fn put(&self, key: &str, value: &str) -> AppResult<()> {
        let mut attempt = 0_u64;
        loop {
            let result = self
                .kv
                .put(key, value)
                .map_err(|_| storage_unavailable())?
                .execute()
                .await;
            match result {
                Ok(()) => return Ok(()),
                Err(error) if attempt < 2 && contains_http_status(&error.to_string(), "429") => {
                    attempt += 1;
                    Delay::from(Duration::from_secs(attempt)).await;
                }
                Err(_) => return Err(storage_unavailable()),
            }
        }
    }

    async fn delete(&self, key: &str) -> AppResult<()> {
        self.kv.delete(key).await.map_err(|_| storage_unavailable())
    }
}

fn contains_http_status(message: &str, status: &str) -> bool {
    message.match_indices(status).any(|(index, _)| {
        let before = message[..index].bytes().next_back();
        let after = message[index + status.len()..].bytes().next();
        before.is_none_or(|value| !value.is_ascii_digit())
            && after.is_none_or(|value| !value.is_ascii_digit())
    })
}

fn storage_unavailable() -> ApiError {
    ApiError::new(500, "Authentication storage is unavailable.")
        .with_kind("configuration_error")
        .with_code("auth_storage_unavailable")
}
