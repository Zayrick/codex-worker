//! Scheduled OAuth refresh policy and orchestration.

use serde::{Deserialize, Serialize};

use crate::core::AppResult;

use super::{
    StoredOAuthCredentials, credentials_from_token_response,
    oauth_ports::{OAuthClock, OAuthCredentialsStore},
    oauth_provider::OAuthProvider,
};

pub const REFRESH_WINDOW_MS: i64 = 3 * 60 * 60 * 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OAuthRefreshResult {
    Missing,
    NotDue,
    Refreshed,
}

pub struct OAuthRefreshService<'a> {
    credentials: &'a dyn OAuthCredentialsStore,
    provider: &'a OAuthProvider<'a>,
    clock: &'a dyn OAuthClock,
}

impl<'a> OAuthRefreshService<'a> {
    pub fn new(
        credentials: &'a dyn OAuthCredentialsStore,
        provider: &'a OAuthProvider<'a>,
        clock: &'a dyn OAuthClock,
    ) -> Self {
        Self {
            credentials,
            provider,
            clock,
        }
    }

    pub async fn refresh(&self, evaluation_now_ms: Option<i64>) -> AppResult<OAuthRefreshResult> {
        let evaluation_now_ms = match evaluation_now_ms {
            Some(value) => value,
            None => self.clock.now_ms().await,
        };
        let Some(current) = self.credentials.read().await? else {
            return Ok(OAuthRefreshResult::Missing);
        };
        if !oauth_refresh_due(&current, evaluation_now_ms) {
            return Ok(OAuthRefreshResult::NotDue);
        }

        let token_payload = self
            .provider
            .refresh_provider_token(&current.refresh_token)
            .await?;
        let updated = credentials_from_token_response(
            &token_payload,
            Some(&current),
            self.clock.now_ms().await,
        )?;
        self.credentials.store(&updated).await?;
        Ok(OAuthRefreshResult::Refreshed)
    }
}

pub fn oauth_refresh_due(credentials: &StoredOAuthCredentials, now_ms: i64) -> bool {
    credentials.expires_at <= now_ms.saturating_add(REFRESH_WINDOW_MS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn credentials(expires_at: i64) -> StoredOAuthCredentials {
        StoredOAuthCredentials {
            version: 1,
            access_token: "access".into(),
            refresh_token: "refresh".into(),
            id_token: None,
            account_id: None,
            email: None,
            expires_at,
            updated_at: "2026-01-01T00:00:00.000Z".into(),
        }
    }

    #[test]
    fn refresh_window_is_inclusive_at_three_hours() {
        let now = 1_000_000;
        assert!(oauth_refresh_due(
            &credentials(now + REFRESH_WINDOW_MS),
            now
        ));
        assert!(!oauth_refresh_due(
            &credentials(now + REFRESH_WINDOW_MS + 1),
            now
        ));
    }
}
