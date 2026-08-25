use std::{
    cell::{Cell, RefCell},
    collections::{HashMap, VecDeque},
    future::Future,
    task::{Context, Poll, Waker},
};

use async_trait::async_trait;
use serde_json::{Value, json};
use url::form_urlencoded;

use crate::core::AppResult;

use super::*;

const MASTER_KEY: &str = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
const NOW_MS: i64 = 1_800_000_000_000;

#[derive(Default)]
struct FakeHttp {
    responses: RefCell<VecDeque<Result<OAuthHttpResponse, OAuthHttpFailure>>>,
    requests: RefCell<Vec<OAuthHttpRequest>>,
}

impl FakeHttp {
    fn push(&self, response: Result<OAuthHttpResponse, OAuthHttpFailure>) {
        self.responses.borrow_mut().push_back(response);
    }

    fn requests(&self) -> Vec<OAuthHttpRequest> {
        self.requests.borrow().clone()
    }

    fn is_empty(&self) -> bool {
        self.responses.borrow().is_empty()
    }
}

#[async_trait(?Send)]
impl OAuthHttpClient for FakeHttp {
    async fn execute(
        &self,
        request: OAuthHttpRequest,
    ) -> Result<OAuthHttpResponse, OAuthHttpFailure> {
        self.requests.borrow_mut().push(request);
        self.responses
            .borrow_mut()
            .pop_front()
            .unwrap_or(Err(OAuthHttpFailure::Network))
    }
}

struct FakeClock {
    now_ms: Cell<i64>,
    sleeps: RefCell<Vec<u64>>,
}

impl FakeClock {
    fn new(now_ms: i64) -> Self {
        Self {
            now_ms: Cell::new(now_ms),
            sleeps: RefCell::new(Vec::new()),
        }
    }

    fn set(&self, now_ms: i64) {
        self.now_ms.set(now_ms);
    }
}

#[async_trait(?Send)]
impl OAuthClock for FakeClock {
    async fn now_ms(&self) -> i64 {
        self.now_ms.get()
    }

    async fn sleep_ms(&self, delay_ms: u64) {
        self.sleeps.borrow_mut().push(delay_ms);
    }
}

#[derive(Default)]
struct MemorySecretStore {
    values: RefCell<HashMap<String, String>>,
}

impl MemorySecretStore {
    fn raw(&self, key: &str) -> Option<String> {
        self.values.borrow().get(key).cloned()
    }
}

#[async_trait(?Send)]
impl SecretStore for MemorySecretStore {
    async fn get(&self, key: &str, _cache_ttl: Option<u64>) -> AppResult<Option<String>> {
        Ok(self.raw(key))
    }

    async fn put(&self, key: &str, value: &str) -> AppResult<()> {
        self.values
            .borrow_mut()
            .insert(key.to_owned(), value.to_owned());
        Ok(())
    }

    async fn delete(&self, key: &str) -> AppResult<()> {
        self.values.borrow_mut().remove(key);
        Ok(())
    }
}

fn response(status: u16, value: Value) -> Result<OAuthHttpResponse, OAuthHttpFailure> {
    Ok(OAuthHttpResponse {
        status,
        body: serde_json::to_vec(&value).unwrap(),
    })
}

fn empty_response(status: u16) -> Result<OAuthHttpResponse, OAuthHttpFailure> {
    Ok(OAuthHttpResponse {
        status,
        body: Vec::new(),
    })
}

fn credentials(expires_at: i64) -> StoredOAuthCredentials {
    StoredOAuthCredentials {
        version: 1,
        access_token: "access-original".into(),
        refresh_token: "refresh-original".into(),
        id_token: None,
        account_id: Some("account-original".into()),
        email: None,
        expires_at,
        updated_at: "2027-01-15T08:00:00.000Z".into(),
    }
}

fn form(request: &OAuthHttpRequest) -> HashMap<String, String> {
    form_urlencoded::parse(request.body.as_bytes())
        .into_owned()
        .collect()
}

fn block_on_ready<F: Future>(future: F) -> F::Output {
    let mut future = Box::pin(future);
    let mut context = Context::from_waker(Waker::noop());
    match future.as_mut().poll(&mut context) {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("test port unexpectedly returned a pending future"),
    }
}

#[test]
fn device_start_pending_and_completion_use_encrypted_repository() {
    let http = FakeHttp::default();
    http.push(response(
        200,
        json!({
            "device_auth_id": "device-auth-sensitive",
            "user_code": "ABCD-EFGH",
            "interval": "1 second"
        }),
    ));
    http.push(empty_response(403));
    http.push(response(
        200,
        json!({
            "authorization_code": "authorization-code",
            "code_verifier": "code-verifier",
            "code_challenge": "code-challenge"
        }),
    ));
    http.push(response(
        200,
        json!({
            "access_token": "device-access-sensitive",
            "refresh_token": "device-refresh-sensitive",
            "expires_in": 3600
        }),
    ));
    let clock = FakeClock::new(NOW_MS);
    let provider = OAuthProvider::new(&http, &clock);
    let secret_store = MemorySecretStore::default();
    let repository = OAuthRepository::new(&secret_store, MASTER_KEY);
    let service = DeviceAuthorizationService::new(&repository, &provider, &clock, MASTER_KEY);

    let authorization = block_on_ready(service.start()).unwrap();
    assert_eq!(authorization.verification_uri, DEVICE_VERIFICATION_URL);
    assert_eq!(authorization.user_code, "ABCD-EFGH");
    assert_eq!(authorization.expires_in, 900);
    assert_eq!(authorization.interval, 1);
    assert!(!authorization.state.contains("device-auth-sensitive"));

    assert_eq!(
        block_on_ready(service.poll(&authorization.state)).unwrap(),
        DevicePollResult::Pending { retry_after: 1 }
    );
    let stored = block_on_ready(service.poll(&authorization.state)).unwrap();
    let DevicePollResult::Stored { credentials } = stored else {
        panic!("expected stored device credentials");
    };
    assert_eq!(credentials.access_token, "device-access-sensitive");
    assert_eq!(credentials.refresh_token, "device-refresh-sensitive");

    let encrypted = secret_store.raw("oauth").unwrap();
    assert!(!encrypted.contains("device-access-sensitive"));
    assert!(!encrypted.contains("device-refresh-sensitive"));
    assert_eq!(
        block_on_ready(repository.read())
            .unwrap()
            .unwrap()
            .access_token,
        "device-access-sensitive"
    );

    let requests = http.requests();
    assert_eq!(requests.len(), 4);
    assert_eq!(
        requests[0].url,
        "https://auth.openai.com/api/accounts/deviceauth/usercode"
    );
    assert_eq!(requests[0].timeout_ms, 10_000);
    assert_eq!(requests[0].max_response_bytes, 64 * 1024);
    assert_eq!(
        form(&requests[3]).get("grant_type").map(String::as_str),
        Some("authorization_code")
    );
    assert_eq!(
        form(&requests[3]).get("code_verifier").map(String::as_str),
        Some("code-verifier")
    );
    assert!(http.is_empty());
}

#[test]
fn device_flow_rejects_expired_invalid_and_aborted_sessions() {
    let http = FakeHttp::default();
    http.push(response(
        200,
        json!({
            "device_auth_id": "device",
            "user_code": "CODE",
            "interval": 1
        }),
    ));
    let clock = FakeClock::new(NOW_MS);
    let provider = OAuthProvider::new(&http, &clock);
    let secret_store = MemorySecretStore::default();
    let repository = OAuthRepository::new(&secret_store, MASTER_KEY);
    let service = DeviceAuthorizationService::new(&repository, &provider, &clock, MASTER_KEY);
    let authorization = block_on_ready(service.start()).unwrap();

    clock.set(NOW_MS + DEVICE_LIFETIME_MS);
    let expired = block_on_ready(service.poll(&authorization.state)).unwrap_err();
    assert_eq!(expired.status, 410);
    assert_eq!(expired.code.as_deref(), Some("device_session_expired"));

    let invalid = block_on_ready(service.poll("not-an-envelope")).unwrap_err();
    assert_eq!(invalid.status, 400);
    assert_eq!(invalid.code.as_deref(), Some("invalid_device_session"));

    let aborting_http = FakeHttp::default();
    aborting_http.push(Err(OAuthHttpFailure::ClientAborted));
    let aborting_provider = OAuthProvider::new(&aborting_http, &clock);
    let aborting_service =
        DeviceAuthorizationService::new(&repository, &aborting_provider, &clock, MASTER_KEY);
    let aborted = block_on_ready(aborting_service.start()).unwrap_err();
    assert_eq!(aborted.status, 408);
    assert_eq!(aborted.code.as_deref(), Some("request_aborted"));
}

#[test]
fn device_state_is_bound_to_the_proxy_record_id() {
    let http = FakeHttp::default();
    http.push(response(
        200,
        json!({
            "device_auth_id": "device",
            "user_code": "CODE",
            "interval": 1
        }),
    ));
    let clock = FakeClock::new(NOW_MS);
    let provider = OAuthProvider::new(&http, &clock);
    let secret_store = MemorySecretStore::default();
    let first = OAuthRepository::for_auth_proxy_account(
        &secret_store,
        MASTER_KEY,
        "00000000-0000-4000-8000-000000000001",
    );
    let second = OAuthRepository::for_auth_proxy_account(
        &secret_store,
        MASTER_KEY,
        "00000000-0000-4000-8000-000000000002",
    );
    let first_service = DeviceAuthorizationService::scoped(
        &first,
        &provider,
        &clock,
        MASTER_KEY,
        "00000000-0000-4000-8000-000000000001",
    );
    let second_service = DeviceAuthorizationService::scoped(
        &second,
        &provider,
        &clock,
        MASTER_KEY,
        "00000000-0000-4000-8000-000000000002",
    );
    let authorization = block_on_ready(first_service.start()).unwrap();
    let error = block_on_ready(second_service.poll(&authorization.state)).unwrap_err();
    assert_eq!(error.code.as_deref(), Some("invalid_device_session"));
    assert_eq!(http.requests().len(), 1);
}

#[test]
fn refresh_retries_transient_failures_and_rotates_encrypted_credentials() {
    let http = FakeHttp::default();
    http.push(Err(OAuthHttpFailure::Network));
    http.push(empty_response(503));
    http.push(response(
        200,
        json!({
            "access_token": "access-refreshed-sensitive",
            "refresh_token": "refresh-refreshed-sensitive",
            "expires_in": 3600
        }),
    ));
    let clock = FakeClock::new(NOW_MS + 500);
    let provider = OAuthProvider::new(&http, &clock);
    let secret_store = MemorySecretStore::default();
    let repository = OAuthRepository::new(&secret_store, MASTER_KEY);
    block_on_ready(repository.store(&credentials(NOW_MS + 60_000))).unwrap();
    let service = OAuthRefreshService::new(&repository, &provider, &clock);

    assert_eq!(
        block_on_ready(service.refresh(Some(NOW_MS))).unwrap(),
        OAuthRefreshResult::Refreshed
    );
    assert_eq!(*clock.sleeps.borrow(), vec![1_000, 2_000]);
    let stored = block_on_ready(repository.read()).unwrap().unwrap();
    assert_eq!(stored.access_token, "access-refreshed-sensitive");
    assert_eq!(stored.refresh_token, "refresh-refreshed-sensitive");
    assert_eq!(stored.expires_at, NOW_MS + 500 + 3_600_000);
    let encrypted = secret_store.raw("oauth").unwrap();
    assert!(!encrypted.contains("access-refreshed-sensitive"));

    for request in http.requests() {
        let values = form(&request);
        assert_eq!(
            values.get("grant_type").map(String::as_str),
            Some("refresh_token")
        );
        assert_eq!(
            values.get("refresh_token").map(String::as_str),
            Some("refresh-original")
        );
        assert!(!format!("{request:?}").contains("refresh-original"));
    }
    assert!(http.is_empty());
}

#[test]
fn proxy_credentials_are_uuid_scoped_and_fall_back_to_primary() {
    let secret_store = MemorySecretStore::default();
    let primary = OAuthRepository::new(&secret_store, MASTER_KEY);
    let proxy_id = "00000000-0000-4000-8000-000000000001";
    let proxy = OAuthRepository::for_auth_proxy_account(&secret_store, MASTER_KEY, proxy_id);
    block_on_ready(primary.store(&credentials(NOW_MS + 60_000))).unwrap();

    let selected =
        block_on_ready(auth_proxy_credentials_or_primary(&proxy, &primary, NOW_MS)).unwrap();
    assert_eq!(selected.token, "access-original");

    let mut proxy_credentials = credentials(NOW_MS + 60_000);
    proxy_credentials.access_token = "access-proxy-sensitive".into();
    proxy_credentials.refresh_token = "refresh-proxy-sensitive".into();
    proxy_credentials.account_id = Some("account-proxy".into());
    block_on_ready(proxy.store(&proxy_credentials)).unwrap();
    let selected =
        block_on_ready(auth_proxy_credentials_or_primary(&proxy, &primary, NOW_MS)).unwrap();
    assert_eq!(selected.token, "access-proxy-sensitive");
    assert_eq!(selected.account_id.as_deref(), Some("account-proxy"));

    proxy_credentials.account_id = None;
    block_on_ready(proxy.store(&proxy_credentials)).unwrap();
    let selected =
        block_on_ready(auth_proxy_credentials_or_primary(&proxy, &primary, NOW_MS)).unwrap();
    assert_eq!(selected.token, "access-original");

    proxy_credentials.account_id = Some("account-proxy".into());
    proxy_credentials.expires_at = NOW_MS;
    block_on_ready(proxy.store(&proxy_credentials)).unwrap();
    let selected =
        block_on_ready(auth_proxy_credentials_or_primary(&proxy, &primary, NOW_MS)).unwrap();
    assert_eq!(selected.token, "access-original");

    let encrypted = secret_store
        .raw(&format!("oauth:auth-proxy:{proxy_id}"))
        .unwrap();
    assert!(!encrypted.contains("access-proxy-sensitive"));
}

#[test]
fn refresh_distinguishes_missing_not_due_and_safe_provider_errors() {
    let clock = FakeClock::new(NOW_MS);

    let missing_http = FakeHttp::default();
    let missing_provider = OAuthProvider::new(&missing_http, &clock);
    let missing_store = MemorySecretStore::default();
    let missing_repository = OAuthRepository::new(&missing_store, MASTER_KEY);
    let missing_service = OAuthRefreshService::new(&missing_repository, &missing_provider, &clock);
    assert_eq!(
        block_on_ready(missing_service.refresh(Some(NOW_MS))).unwrap(),
        OAuthRefreshResult::Missing
    );
    assert!(missing_http.requests().is_empty());

    let future_http = FakeHttp::default();
    let future_provider = OAuthProvider::new(&future_http, &clock);
    let future_store = MemorySecretStore::default();
    let future_repository = OAuthRepository::new(&future_store, MASTER_KEY);
    block_on_ready(future_repository.store(&credentials(NOW_MS + REFRESH_WINDOW_MS + 1))).unwrap();
    let future_service = OAuthRefreshService::new(&future_repository, &future_provider, &clock);
    assert_eq!(
        block_on_ready(future_service.refresh(Some(NOW_MS))).unwrap(),
        OAuthRefreshResult::NotDue
    );
    assert!(future_http.requests().is_empty());

    let failing_http = FakeHttp::default();
    failing_http.push(Ok(OAuthHttpResponse {
        status: 400,
        body: b"access-original refresh-original should-never-surface".to_vec(),
    }));
    let failing_provider = OAuthProvider::new(&failing_http, &clock);
    let failing_store = MemorySecretStore::default();
    let failing_repository = OAuthRepository::new(&failing_store, MASTER_KEY);
    block_on_ready(failing_repository.store(&credentials(NOW_MS))).unwrap();
    let failing_service = OAuthRefreshService::new(&failing_repository, &failing_provider, &clock);
    let error = block_on_ready(failing_service.refresh(Some(NOW_MS))).unwrap_err();
    assert_eq!(error.status, 502);
    assert_eq!(error.code.as_deref(), Some("oauth_provider_error"));
    assert!(!error.message.contains("access-original"));
    assert!(!error.message.contains("refresh-original"));
    assert!(clock.sleeps.borrow().is_empty());
}

#[test]
fn provider_bounds_json_and_preserves_rate_limit_error_semantics() {
    let clock = FakeClock::new(NOW_MS);
    let oversized_http = FakeHttp::default();
    oversized_http.push(Ok(OAuthHttpResponse {
        status: 200,
        body: vec![b'x'; MAX_OAUTH_RESPONSE_BYTES + 1],
    }));
    let oversized_provider = OAuthProvider::new(&oversized_http, &clock);
    let error = block_on_ready(oversized_provider.request_device_authorization()).unwrap_err();
    assert_eq!(
        error.code.as_deref(),
        Some("invalid_oauth_provider_response")
    );

    let limited_http = FakeHttp::default();
    limited_http.push(empty_response(429));
    limited_http.push(empty_response(429));
    limited_http.push(empty_response(429));
    let limited_provider = OAuthProvider::new(&limited_http, &clock);
    let error = block_on_ready(limited_provider.refresh_provider_token("secret")).unwrap_err();
    assert_eq!(error.status, 502);
    assert_eq!(error.code.as_deref(), Some("oauth_rate_limited"));
    assert_eq!(*clock.sleeps.borrow(), vec![1_000, 2_000]);
}
