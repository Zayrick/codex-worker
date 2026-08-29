use worker::{AbortSignal, Fetch, Headers, Method, Request, RequestInit, RequestRedirect};

use crate::{
    application::PushNotification,
    core::AppResult,
    upstream::dingtalk::{
        DINGTALK_MAX_RESPONSE_BYTES, DINGTALK_REQUEST_TIMEOUT_MS, DingTalkResponse,
        dingtalk_markdown_notification_payload, dingtalk_notification_payload,
        dingtalk_unavailable, signed_dingtalk_webhook,
    },
};

use super::body::read_limited_response;

pub struct DingTalkClient {
    webhook: String,
    secret: String,
}

impl DingTalkClient {
    pub fn new(webhook: String, secret: String) -> Self {
        Self { webhook, secret }
    }

    pub async fn send(&self, notification: &PushNotification, timestamp_ms: i64) -> AppResult<()> {
        let endpoint = signed_dingtalk_webhook(&self.webhook, &self.secret, timestamp_ms)?;
        let headers = Headers::new();
        headers
            .set("content-type", "application/json; charset=utf-8")
            .map_err(|_| dingtalk_unavailable())?;
        let body = match notification.url.as_deref() {
            Some(url) => serde_json::to_string(&dingtalk_markdown_notification_payload(
                &notification.title,
                &notification.body,
                url,
            )),
            None => serde_json::to_string(&dingtalk_notification_payload(&notification.body)),
        }
        .map_err(|_| dingtalk_unavailable())?;
        let mut init = RequestInit::new();
        init.with_method(Method::Post)
            .with_headers(headers)
            .with_body(Some(body.into()))
            .with_redirect(RequestRedirect::Manual);
        let outgoing =
            Request::new_with_init(endpoint.as_str(), &init).map_err(|_| dingtalk_unavailable())?;
        let timeout =
            worker::web_sys::AbortSignal::timeout_with_f64(DINGTALK_REQUEST_TIMEOUT_MS as f64);
        let signal = AbortSignal::from(timeout);
        let mut response = Fetch::Request(outgoing)
            .send_with_signal(&signal)
            .await
            .map_err(|_| dingtalk_unavailable())?;
        let status = response.status_code();
        let body = read_limited_response(&mut response, DINGTALK_MAX_RESPONSE_BYTES)
            .await
            .map_err(|_| dingtalk_unavailable())?;
        if !(200..300).contains(&status) {
            return Err(dingtalk_unavailable());
        }
        let result = serde_json::from_slice::<DingTalkResponse>(&body)
            .map_err(|_| dingtalk_unavailable())?;
        if result.is_success() {
            Ok(())
        } else {
            Err(dingtalk_unavailable())
        }
    }
}
