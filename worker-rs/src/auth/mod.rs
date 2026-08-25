//! Authentication, encrypted persistence, and OAuth domain services.

mod admin_session;
mod api_keys;
mod auth_proxy;
mod credentials;
mod crypto;
mod device_flow;
mod oauth_ports;
mod oauth_provider;
mod record_id;
mod refresh;
mod store;

#[cfg(test)]
mod oauth_tests;

pub use admin_session::{
    admin_secret_matches, admin_session_cookie_header, clear_admin_session_cookie_header,
    create_admin_session, has_valid_admin_session,
};
pub use api_keys::{
    ApiKeyRepository, ClientApiKey, authenticate_token, client_token, validate_api_key_input,
};
pub use auth_proxy::{AuthProxyAccount, matching_auth_proxy_account};
pub use credentials::{
    CodexCredentials, OAuthRepository, OAuthStatus, StoredOAuthCredentials,
    auth_proxy_credentials_or_primary, credentials_from_token_response, oauth_status,
};
pub use crypto::{constant_time_equal, open_json, seal_json, sha256};
pub use device_flow::{
    DEFAULT_POLL_INTERVAL_SECONDS, DEVICE_LIFETIME_MS, DeviceAuthorization,
    DeviceAuthorizationService, DevicePollResult,
};
pub use oauth_ports::{
    OAuthClock, OAuthCredentialsStore, OAuthHttpClient, OAuthHttpFailure, OAuthHttpMethod,
    OAuthHttpRequest, OAuthHttpResponse,
};
pub use oauth_provider::{
    DEVICE_VERIFICATION_URL, MAX_OAUTH_RESPONSE_BYTES, OAuthProvider, PROVIDER_REQUEST_TIMEOUT_MS,
    ProviderDeviceAuthorization, ProviderDevicePollResult,
};
pub(crate) use record_id::{derived_record_id, new_record_id, valid_record_id};
pub use refresh::{OAuthRefreshResult, OAuthRefreshService, REFRESH_WINDOW_MS, oauth_refresh_due};
pub use store::SecretStore;
