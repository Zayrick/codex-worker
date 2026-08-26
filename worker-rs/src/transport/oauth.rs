use std::time::Duration;

use async_trait::async_trait;
use futures_util::StreamExt;
use worker::{
    AbortSignal, Date, Delay, Fetch, Headers, Method, Request, RequestInit, ResponseBody,
};

use crate::{
    auth::{OAuthClock, OAuthHttpClient, OAuthHttpFailure, OAuthHttpRequest, OAuthHttpResponse},
    http::LimitedBodyCollector,
};

use super::body::cancel_readable_stream;

#[derive(Debug, Clone, Default)]
pub struct CloudflareOAuthHttpClient {
    client_signal: Option<worker::web_sys::AbortSignal>,
}

impl CloudflareOAuthHttpClient {
    pub fn new(client_signal: Option<worker::web_sys::AbortSignal>) -> Self {
        Self { client_signal }
    }
}

#[async_trait(?Send)]
impl OAuthHttpClient for CloudflareOAuthHttpClient {
    async fn execute(
        &self,
        request: OAuthHttpRequest,
    ) -> Result<OAuthHttpResponse, OAuthHttpFailure> {
        let headers = Headers::new();
        for (name, value) in &request.headers {
            headers
                .append(name, value)
                .map_err(|_| OAuthHttpFailure::Network)?;
        }
        let mut init = RequestInit::new();
        init.with_method(Method::Post)
            .with_headers(headers)
            .with_body(Some(request.body.into()));
        let outgoing =
            Request::new_with_init(&request.url, &init).map_err(|_| OAuthHttpFailure::Network)?;

        let timeout = worker::web_sys::AbortSignal::timeout_with_f64(request.timeout_ms as f64);
        let signal = combined_signal(self.client_signal.as_ref(), &timeout);
        let signal = AbortSignal::from(signal);
        let mut upstream = Fetch::Request(outgoing)
            .send_with_signal(&signal)
            .await
            .map_err(|_| classify_abort(self.client_signal.as_ref(), &timeout))?;
        let status = upstream.status_code();
        if !(200..300).contains(&status) {
            let raw_stream = match upstream.body() {
                ResponseBody::Stream(stream) => Some(stream.clone()),
                ResponseBody::Empty | ResponseBody::Body(_) => None,
            };
            cancel_readable_stream(raw_stream.as_ref()).await;
            return Ok(OAuthHttpResponse {
                status,
                body: Vec::new(),
            });
        }
        let raw_stream = match upstream.body() {
            ResponseBody::Stream(stream) => Some(stream.clone()),
            ResponseBody::Empty | ResponseBody::Body(_) => None,
        };
        let declared = match upstream.headers().get("content-length") {
            Ok(length) => length,
            Err(_) => {
                cancel_readable_stream(raw_stream.as_ref()).await;
                return Err(OAuthHttpFailure::Network);
            }
        };
        let mut collector =
            match LimitedBodyCollector::new(request.max_response_bytes, declared.as_deref()) {
                Ok(collector) => collector,
                Err(_) => {
                    cancel_readable_stream(raw_stream.as_ref()).await;
                    return Err(OAuthHttpFailure::ResponseTooLarge);
                }
            };

        match upstream.body() {
            ResponseBody::Empty => {}
            ResponseBody::Body(bytes) => collector
                .push_chunk(bytes)
                .map_err(|_| OAuthHttpFailure::ResponseTooLarge)?,
            ResponseBody::Stream(_) => {
                let mut source = match upstream.stream() {
                    Ok(source) => source,
                    Err(_) => {
                        cancel_readable_stream(raw_stream.as_ref()).await;
                        return Err(classify_abort(self.client_signal.as_ref(), &timeout));
                    }
                };
                while let Some(chunk) = source.next().await {
                    let chunk = match chunk {
                        Ok(chunk) => chunk,
                        Err(_) => {
                            drop(source);
                            cancel_readable_stream(raw_stream.as_ref()).await;
                            return Err(classify_abort(self.client_signal.as_ref(), &timeout));
                        }
                    };
                    if collector.push_chunk(&chunk).is_err() {
                        drop(source);
                        cancel_readable_stream(raw_stream.as_ref()).await;
                        return Err(OAuthHttpFailure::ResponseTooLarge);
                    }
                }
                // Workers can surface an aborted byte stream as a clean EOF.
                // Re-check both signals before accepting a partial response.
                if self
                    .client_signal
                    .as_ref()
                    .is_some_and(worker::web_sys::AbortSignal::aborted)
                    || timeout.aborted()
                {
                    return Err(classify_abort(self.client_signal.as_ref(), &timeout));
                }
            }
        }
        Ok(OAuthHttpResponse {
            status,
            body: collector.finish(),
        })
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct CloudflareClock;

#[async_trait(?Send)]
impl OAuthClock for CloudflareClock {
    async fn now_ms(&self) -> i64 {
        i64::try_from(Date::now().as_millis()).unwrap_or(i64::MAX)
    }

    async fn sleep_ms(&self, delay_ms: u64) {
        Delay::from(Duration::from_millis(delay_ms)).await;
    }
}

fn combined_signal(
    client: Option<&worker::web_sys::AbortSignal>,
    timeout: &worker::web_sys::AbortSignal,
) -> worker::web_sys::AbortSignal {
    let signals = worker::js_sys::Array::new();
    if let Some(client) = client {
        signals.push(client);
    }
    signals.push(timeout);
    worker::web_sys::AbortSignal::any(&signals)
}

fn classify_abort(
    client: Option<&worker::web_sys::AbortSignal>,
    timeout: &worker::web_sys::AbortSignal,
) -> OAuthHttpFailure {
    if client.is_some_and(worker::web_sys::AbortSignal::aborted) {
        OAuthHttpFailure::ClientAborted
    } else if timeout.aborted() {
        OAuthHttpFailure::TimedOut
    } else {
        OAuthHttpFailure::Network
    }
}
