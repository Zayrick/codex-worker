use worker::{
    AbortSignal, Fetch, Headers, Method, Request, RequestInit, RequestRedirect, Response,
    ResponseBody,
};

use crate::{
    application::UsageNotification,
    core::AppResult,
    upstream::bark::{
        BARK_PUSH_REQUEST_TIMEOUT_MS, bark_push_payload, bark_push_unavailable, parse_bark_push_url,
    },
};

use super::body::cancel_readable_stream;

pub struct BarkClient {
    endpoint: url::Url,
}

impl BarkClient {
    pub fn new(endpoint: &str) -> AppResult<Self> {
        Ok(Self {
            endpoint: parse_bark_push_url(endpoint)?,
        })
    }

    pub async fn send(&self, notification: &UsageNotification) -> AppResult<()> {
        let headers = Headers::new();
        headers
            .set("content-type", "application/json; charset=utf-8")
            .map_err(|_| bark_push_unavailable())?;
        let payload = bark_push_payload(&notification.title, &notification.body);
        let body = serde_json::to_string(&payload).map_err(|_| bark_push_unavailable())?;
        let mut init = RequestInit::new();
        init.with_method(Method::Post)
            .with_headers(headers)
            .with_body(Some(body.into()))
            .with_redirect(RequestRedirect::Manual);
        let outgoing = Request::new_with_init(self.endpoint.as_str(), &init)
            .map_err(|_| bark_push_unavailable())?;
        let timeout =
            worker::web_sys::AbortSignal::timeout_with_f64(BARK_PUSH_REQUEST_TIMEOUT_MS as f64);
        let signal = AbortSignal::from(timeout);
        let response = Fetch::Request(outgoing)
            .send_with_signal(&signal)
            .await
            .map_err(|_| bark_push_unavailable())?;
        let status = response.status_code();
        discard_response_body(response).await;
        if (200..300).contains(&status) {
            Ok(())
        } else {
            Err(bark_push_unavailable())
        }
    }
}

async fn discard_response_body(response: Response) {
    let stream = match response.body() {
        ResponseBody::Stream(stream) => Some(stream.clone()),
        ResponseBody::Empty | ResponseBody::Body(_) => None,
    };
    cancel_readable_stream(stream.as_ref()).await;
}
