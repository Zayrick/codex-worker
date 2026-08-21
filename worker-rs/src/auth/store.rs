use async_trait::async_trait;

use crate::core::AppResult;

/// Narrow persistence port used by encrypted repositories.
///
/// The Cloudflare adapter maps this to one KV binding; tests can use an
/// in-memory implementation without importing Workers runtime types.
#[async_trait(?Send)]
pub trait SecretStore {
    async fn get(&self, key: &str, cache_ttl: Option<u64>) -> AppResult<Option<String>>;
    async fn put(&self, key: &str, value: &str) -> AppResult<()>;
    async fn delete(&self, key: &str) -> AppResult<()>;
}
