//! Runtime ports for OAuth I/O.
//!
//! Cloudflare-specific fetch, timers, cancellation, and KV bindings are
//! implemented outside `auth`; domain services depend only on these traits.

use std::fmt;

use async_trait::async_trait;

use crate::core::AppResult;

use super::StoredOAuthCredentials;

#[derive(Clone, PartialEq, Eq)]
pub struct OAuthHttpRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub timeout_ms: u64,
    pub max_response_bytes: usize,
}

impl fmt::Debug for OAuthHttpRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OAuthHttpRequest")
            .field("url", &self.url)
            .field("headers", &self.headers)
            .field("body_bytes", &self.body.len())
            .field("timeout_ms", &self.timeout_ms)
            .field("max_response_bytes", &self.max_response_bytes)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct OAuthHttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

impl fmt::Debug for OAuthHttpResponse {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OAuthHttpResponse")
            .field("status", &self.status)
            .field("body_bytes", &self.body.len())
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OAuthHttpFailure {
    /// The caller's cancellation signal fired.
    ClientAborted,
    /// DNS, connection, or response-body collection failed.
    Network,
    /// The provider request exceeded `timeout_ms`.
    TimedOut,
    /// The response exceeded `max_response_bytes`.
    ResponseTooLarge,
}

#[async_trait(?Send)]
pub trait OAuthHttpClient {
    /// Executes one bounded provider request.
    ///
    /// Implementations capture any client-cancellation signal in the adapter,
    /// enforce both limits carried by the request, and never include request or
    /// response bodies in returned errors.
    async fn execute(
        &self,
        request: OAuthHttpRequest,
    ) -> Result<OAuthHttpResponse, OAuthHttpFailure>;
}

#[async_trait(?Send)]
pub trait OAuthClock {
    async fn now_ms(&self) -> i64;
    async fn sleep_ms(&self, delay_ms: u64);
}

#[async_trait(?Send)]
pub trait OAuthCredentialsStore {
    async fn read(&self) -> AppResult<Option<StoredOAuthCredentials>>;
    async fn store(&self, credentials: &StoredOAuthCredentials) -> AppResult<()>;
    async fn delete(&self) -> AppResult<()>;
    async fn require_unconfigured(&self) -> AppResult<()>;
}
