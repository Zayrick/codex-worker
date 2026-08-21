use url::Url;

use crate::core::{ApiError, AppResult};

pub const BARK_PUSH_REQUEST_TIMEOUT_MS: u64 = 10_000;

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
    use super::*;

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
