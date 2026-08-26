use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use url::Url;

use super::*;

#[test]
fn extracts_plan_and_subscription_dates_from_id_token() {
    let payload = json!({
        "email": "test@example.com",
        "https://api.openai.com/auth": {
            "chatgpt_account_id": "account-test",
            "chatgpt_plan_type": "PLUS",
            "chatgpt_subscription_active_start": "2026-01-01T00:00:00.000Z",
            "chatgpt_subscription_active_until": 1_800_000_000
        }
    });
    let token = format!(
        "e30.{}.test-signature",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap())
    );
    assert_eq!(
        codex_subscription_metadata(Some(&token)),
        CodexSubscriptionMetadata {
            plan_type: Some("plus".into()),
            subscription_active_start: Some(1_767_225_600_000.0),
            subscription_active_until: Some(1_800_000_000_000.0),
        }
    );
    assert_eq!(
        codex_subscription_metadata(Some("invalid")),
        CodexSubscriptionMetadata::default()
    );
}

#[test]
fn normalizes_camel_case_usage_and_clamps_percentages() {
    let now = 1_754_438_400_000.0;
    let subscription = codex_subscription_from_usage(
        &json!({
            "rateLimit": {
                "allowed": true,
                "primaryWindow": {
                    "usedPercent": "150",
                    "limitWindowSeconds": "604800",
                    "resetAfterSeconds": "60"
                }
            },
            "rateLimitResetCredits": {
                "availableCount": "0",
                "applicableAvailableCount": "0"
            }
        }),
        CodexSubscriptionMetadata {
            plan_type: Some("team".into()),
            ..CodexSubscriptionMetadata::default()
        },
        now,
    )
    .unwrap();
    assert_eq!(subscription.plan_type.as_deref(), Some("team"));
    assert_eq!(subscription.fetched_at, now);
    assert_eq!(
        subscription.rate_limit_reset_credits.available_count,
        Some(0.0)
    );
    assert_eq!(subscription.windows.len(), 1);
    let window = &subscription.windows[0];
    assert_eq!(window.kind, CodexQuotaWindowKind::Weekly);
    assert_eq!(window.used_percent, Some(100.0));
    assert_eq!(window.remaining_percent, Some(0.0));
    assert_eq!(window.reset_at, Some(now + 60_000.0));
}

#[test]
fn sorts_named_quota_windows_and_normalizes_limit_reached() {
    let now = 1_800_000_000_000.0;
    let subscription = codex_subscription_from_usage(
        &json!({
            "plan_type": "Pro",
            "rate_limit": {
                "allowed": true,
                "primary_window": {
                    "used_percent": 1,
                    "limit_window_seconds": 604800,
                    "reset_at": 1805000000
                },
                "secondary_window": {
                    "usedPercent": "42.5",
                    "limitWindowSeconds": "18000",
                    "resetAfterSeconds": 3600
                }
            },
            "code_review_rate_limit": {
                "allowed": false,
                "primary_window": { "limit_window_seconds": 18000 }
            },
            "additional_rate_limits": [{
                "limit_name": "GPT-5.3-Codex-Spark",
                "rate_limit": {
                    "primary_window": {
                        "used_percent": 9,
                        "limit_window_seconds": 2419200
                    }
                }
            }],
            "rate_limit_reset_credits": {
                "available_count": "2",
                "applicable_available_count": 1
            }
        }),
        CodexSubscriptionMetadata::default(),
        now,
    )
    .unwrap();
    assert_eq!(subscription.plan_type.as_deref(), Some("pro"));
    assert_eq!(subscription.windows.len(), 4);
    assert_eq!(subscription.windows[0].kind, CodexQuotaWindowKind::FiveHour);
    assert_eq!(subscription.windows[1].kind, CodexQuotaWindowKind::Weekly);
    assert_eq!(subscription.windows[1].reset_at, Some(1_805_000_000_000.0));
    assert_eq!(
        subscription.windows[2].category,
        CodexQuotaCategory::CodeReview
    );
    assert_eq!(subscription.windows[2].used_percent, Some(100.0));
    assert!(subscription.windows[2].limit_reached);
    assert_eq!(subscription.windows[3].kind, CodexQuotaWindowKind::Monthly);
    assert_eq!(
        subscription.windows[3].id,
        "additional-1-gpt-5-3-codex-spark-monthly-0"
    );
    assert_eq!(
        subscription.rate_limit_reset_credits,
        CodexRateLimitResetCredits {
            available_count: Some(2.0),
            applicable_available_count: Some(1.0),
        }
    );
}

#[test]
fn rejects_non_object_usage_payloads() {
    let error =
        codex_subscription_from_usage(&Value::Null, CodexSubscriptionMetadata::default(), 0.0)
            .unwrap_err();
    assert_eq!(error.code.as_deref(), Some("invalid_codex_usage_response"));
}

#[test]
fn maps_model_catalog_to_openai_list() {
    assert_eq!(
        to_openai_model_list(&json!({
            "models": [
                { "slug": "gpt-5.6-luna" },
                { "id": "gpt-image-2", "created": 1_700_000_000, "owned_by": "openai" },
                null,
                { "missing": "id" }
            ]
        }))
        .unwrap(),
        json!({
            "object": "list",
            "data": [
                { "id": "gpt-5.6-luna", "object": "model" },
                { "id": "gpt-image-2", "object": "model", "created": 1_700_000_000, "owned_by": "openai" }
            ]
        })
    );
    assert_eq!(
        to_openai_model_list(&json!([]))
            .unwrap_err()
            .code
            .as_deref(),
        Some("invalid_codex_model_catalog")
    );
}

#[test]
fn resolves_realtime_sideband_and_native_proxy_urls() {
    for (client, expected) in [
        (
            "/v1/live/call_123?key=drop-me",
            "https://api.openai.com/v1/live/call_123",
        ),
        (
            "/v1/realtime/calls/call_123?token=drop-me",
            "https://api.openai.com/v1/realtime/calls/call_123",
        ),
        (
            "/v1/realtime?call_id=call_123&intent=override&key=drop-me",
            "https://api.openai.com/v1/realtime?intent=quicksilver&call_id=call_123",
        ),
    ] {
        let client = Url::parse(&format!("https://worker.example{client}")).unwrap();
        assert_eq!(
            resolve_codex_proxy_url("https://codex-relay.test", &client, "GET")
                .unwrap()
                .as_str(),
            expected
        );
    }
    let live = Url::parse("https://worker.example/v1/live?voice=marin").unwrap();
    assert_eq!(
        resolve_codex_proxy_url("https://codex-relay.test", &live, "POST")
            .unwrap()
            .as_str(),
        "https://codex-relay.test/backend-api/codex/realtime/calls?voice=marin&intent=quicksilver&architecture=avas"
    );
    let search = Url::parse("https://worker.example/v1/alpha/search?locale=en").unwrap();
    assert_eq!(
        resolve_codex_proxy_url("https://codex-relay.test", &search, "POST")
            .unwrap()
            .as_str(),
        "https://codex-relay.test/backend-api/codex/alpha/search?locale=en"
    );
}

#[test]
fn proxy_path_and_method_policy_reject_unsupported_realtime_shapes() {
    for path in [
        "/v1/images/generations",
        "/v1/responses",
        "/v1/alpha/search",
        "/v1/live",
        "/v1/realtime/calls/call_123",
    ] {
        assert!(is_codex_proxy_path(path), "{path}");
    }
    for path in [
        "/v1/videos/video_123/content",
        "/v1/realtime/unknown/path",
        "/v1/images-other",
        "/backend-api/codex/videos/video_123",
    ] {
        assert!(!is_codex_proxy_path(path), "{path}");
    }
    let live_root = Url::parse("https://worker.example/v1/live").unwrap();
    assert!(is_codex_proxy_request_allowed("POST", &live_root, false));
    assert!(!is_codex_proxy_request_allowed("GET", &live_root, false));
    let sideband = Url::parse("https://worker.example/v1/realtime?call_id=call_123").unwrap();
    assert!(is_codex_proxy_request_allowed("GET", &sideband, true));
    assert!(!is_codex_proxy_request_allowed("GET", &sideband, false));
    let invalid = Url::parse("https://worker.example/v1/realtime?call_id=bad%2Fid").unwrap();
    assert!(!is_codex_proxy_request_allowed("GET", &invalid, true));
}

#[test]
fn model_query_policy_keeps_only_version_and_channel() {
    let client = Url::parse(
        "https://worker.example/v1/models?client_version=0.200.0&channel=stable&session_id=drop&api_key=drop&channel=beta",
    )
    .unwrap();
    assert_eq!(
        resolve_models_url(
            "https://codex-relay.test",
            &client,
            Some(&HeaderBag::from_pairs([("Version", "0.144.1")]))
        )
        .unwrap()
        .as_str(),
        "https://codex-relay.test/backend-api/codex/models?client_version=0.200.0&channel=stable&channel=beta"
    );
    let client = Url::parse("https://worker.example/v1/models").unwrap();
    assert_eq!(
        resolve_models_url("https://codex-relay.test", &client, None)
            .unwrap()
            .query(),
        Some("client_version=0.144.1")
    );
}

#[test]
fn rejects_nonstandard_relay_origins() {
    for origin in [
        "relay.example.com",
        "https://relay.example.com/",
        " http://relay.example.com ",
        "http://relay.example.com",
        "https://user:pass@relay.example.com",
        "https://relay.example.com/backend-api/codex/responses",
        "https://relay.example.com?target=chatgpt",
        "https://relay.example.com#target",
    ] {
        assert!(
            resolve_chatgpt_relay_url(origin, CODEX_MODELS_PATH, "").is_err(),
            "{origin}"
        );
    }
}

#[test]
fn proxy_header_policy_drops_client_credentials_and_sets_native_defaults() {
    let source = HeaderBag::from_pairs([
        ("Authorization", "Bearer attacker"),
        ("Chatgpt-Account-Id", "attacker-account"),
        ("Origin", "https://untrusted.example"),
        ("X-Api-Key", "secret"),
        ("X-Goog-Api-Key", "secret"),
        ("Content-Length", "123"),
        ("User-Agent", "attacker-agent"),
        ("CF-Connecting-IP", "203.0.113.5"),
        ("X-Forwarded-For", "203.0.113.5"),
        ("Content-Type", "multipart/form-data; boundary=test"),
        ("Sec-WebSocket-Protocol", "openai-responses-v1"),
    ]);
    let credentials = CodexCredentials {
        token: "oauth-token".into(),
        account_id: Some("account-test".into()),
    };
    let headers =
        proxy_request_headers(&source, &credentials, "/backend-api/codex/responses", true);
    assert_eq!(headers.get("authorization"), Some("Bearer oauth-token"));
    assert_eq!(headers.get("chatgpt-account-id"), Some("account-test"));
    assert_eq!(headers.get("user-agent"), Some("codex_cli_rs/0.144.1"));
    assert_eq!(headers.get("version"), Some("0.144.1"));
    assert_eq!(headers.get("originator"), Some("codex_cli_rs"));
    assert_eq!(headers.get("upgrade"), Some("websocket"));
    assert_eq!(
        headers.get("openai-beta"),
        Some("responses_websockets=2026-02-06")
    );
    assert_eq!(
        headers.get("sec-websocket-protocol"),
        Some("openai-responses-v1")
    );
    assert!(headers.get("origin").is_none());
    assert!(headers.get("x-api-key").is_none());
    assert!(headers.get("content-length").is_none());
    assert!(headers.get("cf-connecting-ip").is_none());
    assert!(headers.get("x-forwarded-for").is_none());
}

#[test]
fn converted_client_headers_forward_only_codex_controls() {
    let source = HeaderBag::from_pairs([
        ("Version", " 0.200.0 "),
        ("X-Codex-Beta-Features", " beta-a "),
        ("X-Codex-Turn-Metadata", "turn"),
        ("X-Codex-Turn-State", "state"),
        ("X-Request-Id", "drop"),
        ("Cookie", "drop"),
    ]);
    let credentials = CodexCredentials {
        token: "oauth-token".into(),
        account_id: None,
    };
    let headers = codex_headers(&credentials, "text/event-stream", Some(&source), true);
    assert_eq!(headers.get("accept"), Some("text/event-stream"));
    assert_eq!(headers.get("content-type"), Some("application/json"));
    assert_eq!(headers.get("version"), Some("0.200.0"));
    assert_eq!(headers.get("x-codex-beta-features"), Some("beta-a"));
    assert!(headers.get("x-request-id").is_none());
    assert!(headers.get("cookie").is_none());

    let usage = usage_headers(&CodexCredentials {
        token: "oauth-token".into(),
        account_id: Some("account-test".into()),
    });
    assert_eq!(usage.get("accept"), Some("application/json"));
    assert_eq!(usage.get("content-type"), Some("application/json"));
    assert_eq!(usage.get("user-agent"), Some("codex_cli_rs/0.144.1"));
    assert_eq!(usage.get("chatgpt-account-id"), Some("account-test"));
}
