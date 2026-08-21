use serde::Serialize;
use url::Url;

use crate::core::{ApiError, AppResult};

pub const BARK_PUSH_REQUEST_TIMEOUT_MS: u64 = 10_000;
const BARK_PUSH_GROUP: &str = "Codex 用量警告";
const BARK_PUSH_LEVEL: &str = "timeSensitive";
const BARK_PUSH_ICON: &str = "https://raw.githubusercontent.com/lobehub/lobe-icons/refs/heads/master/packages/static-avatar/avatars/codex.webp";

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct BarkPushPayload<'a> {
    title: &'a str,
    body: &'a str,
    group: &'static str,
    level: &'static str,
    icon: &'static str,
}

pub fn bark_push_payload<'a>(title: &'a str, body: &'a str) -> BarkPushPayload<'a> {
    BarkPushPayload {
        title,
        body,
        group: BARK_PUSH_GROUP,
        level: BARK_PUSH_LEVEL,
        icon: BARK_PUSH_ICON,
    }
}

pub fn parse_bark_push_url(value: &str) -> AppResult<Url> {
    let value = value.trim();
    let url = Url::parse(value).map_err(|_| invalid_bark_push_url())?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() == "/"
        || url.path().is_empty()
        || url.path().ends_with('/')
    {
        return Err(invalid_bark_push_url());
    }
    Ok(url)
}

pub fn bark_push_unavailable() -> ApiError {
    ApiError::new(502, "Unable to deliver the Bark notification.")
        .with_kind("upstream_error")
        .with_code("bark_push_unavailable")
}

fn invalid_bark_push_url() -> ApiError {
    ApiError::new(500, "The Bark push URL is invalid.")
        .with_kind("configuration_error")
        .with_code("invalid_bark_push_url")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn builds_codex_usage_push_presentation() {
        let payload =
            serde_json::to_value(bark_push_payload("Codex 用量提醒", "额度提醒正文")).unwrap();
        assert_eq!(
            payload,
            json!({
                "title": "Codex 用量提醒",
                "body": "额度提醒正文",
                "group": "Codex 用量警告",
                "level": "timeSensitive",
                "icon": "https://raw.githubusercontent.com/lobehub/lobe-icons/refs/heads/master/packages/static-avatar/avatars/codex.webp",
            })
        );
    }

    #[test]
    fn accepts_exact_https_bark_endpoints() {
        assert_eq!(
            parse_bark_push_url(" https://api.day.app/device-key ")
                .unwrap()
                .as_str(),
            "https://api.day.app/device-key"
        );
        assert!(parse_bark_push_url("https://bark.example.com/api/device-key").is_ok());
    }

    #[test]
    fn rejects_urls_that_can_leak_or_ambiguously_route_the_device_key() {
        for value in [
            "http://api.day.app/device-key",
            "https://api.day.app/",
            "https://user:password@api.day.app/device-key",
            "https://api.day.app/device-key/",
            "https://api.day.app/device-key?redirect=https://example.com",
            "https://api.day.app/device-key#fragment",
        ] {
            assert!(parse_bark_push_url(value).is_err(), "{value}");
        }
    }
}
