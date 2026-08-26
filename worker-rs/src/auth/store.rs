use async_trait::async_trait;

use crate::core::AppResult;

/// Persistence boundary for encrypted repositories.
#[async_trait(?Send)]
pub trait SecretStore {
    async fn get(&self, key: &str, cache_ttl: Option<u64>) -> AppResult<Option<String>>;
    async fn put(&self, key: &str, value: &str) -> AppResult<()>;
    async fn delete(&self, key: &str) -> AppResult<()>;
}
