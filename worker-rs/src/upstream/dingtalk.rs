use base64::{Engine as _, engine::general_purpose::STANDARD};
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use url::Url;

use crate::core::{ApiError, AppResult};

pub const DINGTALK_REQUEST_TIMEOUT_MS: u64 = 10_000;
pub const DINGTALK_MAX_RESPONSE_BYTES: usize = 64 * 1024;

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct DingTalkPayload<'a> {
    msgtype: &'static str,
    text: DingTalkText<'a>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
struct DingTalkText<'a> {
    content: &'a str,
}

#[derive(Debug, Deserialize)]
pub struct DingTalkResponse {
    errcode: i64,
}

impl DingTalkResponse {
    pub fn is_success(&self) -> bool {
        self.errcode == 0
    }
}

pub fn dingtalk_payload(content: &str) -> DingTalkPayload<'_> {
    DingTalkPayload {
        msgtype: "text",
        text: DingTalkText { content },
    }
}

pub fn signed_dingtalk_webhook(webhook: &str, secret: &str, timestamp_ms: i64) -> AppResult<Url> {
    let mut url = parse_dingtalk_webhook(webhook)?;
    let secret = secret.trim();
    if secret.is_empty() {
        return Err(invalid_dingtalk_secret());
    }
    let string_to_sign = format!("{timestamp_ms}\n{secret}");
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(|_| invalid_dingtalk_secret())?;
    mac.update(string_to_sign.as_bytes());
    let sign = STANDARD.encode(mac.finalize().into_bytes());
    url.query_pairs_mut()
        .append_pair("timestamp", &timestamp_ms.to_string())
        .append_pair("sign", &sign);
    Ok(url)
}

pub fn dingtalk_unavailable() -> ApiError {
    ApiError::new(502, "Unable to deliver the DingTalk notification.")
        .with_kind("upstream_error")
        .with_code("dingtalk_unavailable")
}

fn parse_dingtalk_webhook(value: &str) -> AppResult<Url> {
    let url = Url::parse(value.trim()).map_err(|_| invalid_dingtalk_webhook())?;
    let query = url.query_pairs().collect::<Vec<_>>();
    let has_single_access_token =
        query.len() == 1 && query[0].0 == "access_token" && !query[0].1.trim().is_empty();
    if url.scheme() != "https"
        || url.host_str() != Some("oapi.dingtalk.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/robot/send"
        || url.fragment().is_some()
        || !has_single_access_token
    {
        return Err(invalid_dingtalk_webhook());
    }
    Ok(url)
}

fn invalid_dingtalk_webhook() -> ApiError {
    ApiError::new(500, "The DingTalk webhook URL is invalid.")
        .with_kind("configuration_error")
        .with_code("invalid_dingtalk_webhook")
}

fn invalid_dingtalk_secret() -> ApiError {
    ApiError::new(500, "The DingTalk signing secret is invalid.")
        .with_kind("configuration_error")
        .with_code("invalid_dingtalk_secret")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn builds_text_payload() {
        assert_eq!(
            serde_json::to_value(dingtalk_payload("Codex 额度提醒\n额度提醒正文")).unwrap(),
            json!({
                "msgtype": "text",
                "text": { "content": "Codex 额度提醒\n额度提醒正文" },
            })
        );
    }

    #[test]
    fn signs_webhook_with_hmac_sha256() {
        let url = signed_dingtalk_webhook(
            "https://oapi.dingtalk.com/robot/send?access_token=token",
            "this is secret",
            1_600_000_000_000,
        )
        .unwrap();
        let query = url.query_pairs().collect::<Vec<_>>();
        assert_eq!(query[0], ("access_token".into(), "token".into()));
        assert_eq!(query[1], ("timestamp".into(), "1600000000000".into()));
        assert_eq!(query[2].0, "sign");
        assert_eq!(query[2].1, "MYEtKC4/NfMR1l4prX++ai6oOf70X1xOf6UlnyUhJH4=");
        assert_eq!(
            url.as_str(),
            "https://oapi.dingtalk.com/robot/send?access_token=token&timestamp=1600000000000&sign=MYEtKC4%2FNfMR1l4prX%2B%2Bai6oOf70X1xOf6UlnyUhJH4%3D"
        );
    }

    #[test]
    fn rejects_non_exact_dingtalk_webhooks() {
        for value in [
            "http://oapi.dingtalk.com/robot/send?access_token=token",
            "https://example.com/robot/send?access_token=token",
            "https://user@oapi.dingtalk.com/robot/send?access_token=token",
            "https://oapi.dingtalk.com/robot/send",
            "https://oapi.dingtalk.com/robot/send?access_token=",
            "https://oapi.dingtalk.com/robot/send?access_token=token&sign=forged",
            "https://oapi.dingtalk.com/robot/send?access_token=token#fragment",
            "https://oapi.dingtalk.com/other?access_token=token",
        ] {
            assert!(
                signed_dingtalk_webhook(value, "secret", 1).is_err(),
                "{value}"
            );
        }
        assert!(
            signed_dingtalk_webhook(
                "https://oapi.dingtalk.com/robot/send?access_token=token",
                "  ",
                1,
            )
            .is_err()
        );
    }
}
