use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use percent_encoding::{NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::core::{ApiError, AppResult};

use super::{constant_time_equal, open_json, seal_json, sha256};

const ADMIN_SESSION_COOKIE: &str = "__Host-codex-admin";
const ADMIN_SESSION_PURPOSE: &str = "codex-worker/admin-session/v1";
const ADMIN_SESSION_LIFETIME_SECONDS: i64 = 12 * 60 * 60;
const ADMIN_SESSION_CLOCK_SKEW_MS: i64 = 60 * 1_000;
const MAX_ADMIN_SESSION_CHARS: usize = 4_096;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdminSession {
    version: u8,
    issued_at: i64,
    expires_at: i64,
    secret_tag: String,
}

pub fn admin_secret_matches(provided: &Value, expected: &str) -> bool {
    provided
        .as_str()
        .filter(|value| !value.is_empty() && value.encode_utf16().count() <= 512)
        .is_some_and(|provided| constant_time_equal(provided, expected))
}

pub fn create_admin_session(
    admin_secret: &str,
    master_key: &str,
    now_ms: i64,
) -> AppResult<String> {
    let session = AdminSession {
        version: 1,
        issued_at: now_ms,
        expires_at: now_ms + ADMIN_SESSION_LIFETIME_SECONDS * 1_000,
        secret_tag: admin_secret_tag(admin_secret),
    };
    let unavailable = || {
        ApiError::new(500, "Unable to create an admin session.")
            .with_kind("configuration_error")
            .with_code("admin_session_unavailable")
    };
    let value = serde_json::to_value(session).map_err(|_| unavailable())?;
    seal_json(&value, master_key, ADMIN_SESSION_PURPOSE).map_err(|_| unavailable())
}

pub fn has_valid_admin_session(
    cookie_header: Option<&str>,
    admin_secret: &str,
    master_key: &str,
    now_ms: i64,
) -> bool {
    let Some(token) = admin_session_cookie(cookie_header) else {
        return false;
    };
    if token.len() > MAX_ADMIN_SESSION_CHARS {
        return false;
    }
    let Ok(value) = open_json(&token, master_key, ADMIN_SESSION_PURPOSE) else {
        return false;
    };
    let Ok(session) = serde_json::from_value::<AdminSession>(value) else {
        return false;
    };
    if session.version != 1
        || session.issued_at > now_ms + ADMIN_SESSION_CLOCK_SKEW_MS
        || session.expires_at <= now_ms
        || session.expires_at - session.issued_at != ADMIN_SESSION_LIFETIME_SECONDS * 1_000
    {
        return false;
    }
    constant_time_equal(&session.secret_tag, &admin_secret_tag(admin_secret))
}

pub fn admin_session_cookie_header(token: &str) -> String {
    format!(
        "{ADMIN_SESSION_COOKIE}={}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age={ADMIN_SESSION_LIFETIME_SECONDS}",
        utf8_percent_encode(token, NON_ALPHANUMERIC),
    )
}

pub fn clear_admin_session_cookie_header() -> String {
    format!("{ADMIN_SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0")
}

fn admin_session_cookie(header: Option<&str>) -> Option<String> {
    for part in header?.split(';') {
        let (name, value) = part.split_once('=')?;
        if name.trim() != ADMIN_SESSION_COOKIE {
            continue;
        }
        return percent_decode_str(value.trim())
            .decode_utf8()
            .ok()
            .map(|value| value.into_owned());
    }
    None
}

fn admin_secret_tag(secret: &str) -> String {
    URL_SAFE_NO_PAD.encode(sha256(secret))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const KEY: &str = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";

    #[test]
    fn matches_secret_with_bounds() {
        assert!(admin_secret_matches(&json!("secret"), "secret"));
        assert!(!admin_secret_matches(&json!("wrong"), "secret"));
        assert!(!admin_secret_matches(&json!(""), ""));
    }

    #[test]
    fn expires_and_rotates_sessions() {
        let now = 1_800_000_000_000_i64;
        let token = create_admin_session("admin-secret", KEY, now).unwrap();
        let cookie = admin_session_cookie_header(&token);
        assert!(has_valid_admin_session(
            Some(&cookie),
            "admin-secret",
            KEY,
            now
        ));
        assert!(!has_valid_admin_session(Some(&cookie), "rotated", KEY, now));
        assert!(!has_valid_admin_session(
            Some(&cookie),
            "admin-secret",
            KEY,
            now + ADMIN_SESSION_LIFETIME_SECONDS * 1_000,
        ));
    }

    #[test]
    fn emits_hardened_cookie_attributes() {
        let cookie = admin_session_cookie_header("token");
        for attribute in [
            "Path=/",
            "Secure",
            "HttpOnly",
            "SameSite=Strict",
            "Max-Age=43200",
        ] {
            assert!(cookie.contains(attribute));
        }
    }
}
