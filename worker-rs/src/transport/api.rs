use serde_json::{Value, json};
use worker::{AbortSignal, Context, Date, Request, Response};

use crate::{
    application::{ApiRoute, Cl100kTokenCounter, ProtocolFamily},
    auth::OAuthRepository,
    core::{ApiError, AppResult},
    protocol::{anthropic, gemini},
    upstream::codex::{MAX_MODEL_CATALOG_BYTES, to_openai_model_list},
};

use super::{
    body::{read_limited_response, request_json},
    codex::{CodexClient, CodexProxyRoute, CodexRequestOptions},
    config::WorkerConfig,
    provider_error::{anthropic_upstream_error_response, gemini_upstream_error_response},
    response,
    store::CloudflareSecretStore,
    stream::{present_non_stream, present_stream},
};

pub async fn handle_api(
    route: ApiRoute,
    request: Request,
    client_url: url::Url,
    context: &Context,
    config: &WorkerConfig,
    store: &CloudflareSecretStore,
) -> worker::Result<Response> {
    let family = route.family();
    match dispatch(route, request, &client_url, context, config, store).await {
        Ok(response) => response::with_cors(response, &config.cors_origin),
        Err(error)
            if error.status == 404
                && !matches!(family, ProtocolFamily::Anthropic | ProtocolFamily::Gemini) =>
        {
            response::empty(404)
        }
        Err(error) => {
            let response = match family {
                ProtocolFamily::Anthropic => response::json(
                    &anthropic::anthropic_error_payload(&error, None),
                    error.status,
                ),
                ProtocolFamily::Gemini => {
                    response::json(&gemini::gemini_error_payload(&error), error.status)
                }
                ProtocolFamily::OpenAi | ProtocolFamily::Codex => response::api_error(&error),
            }?;
            response::with_cors(response, &config.cors_origin)
        }
    }
}

async fn dispatch(
    route: ApiRoute,
    mut request: Request,
    client_url: &url::Url,
    context: &Context,
    config: &WorkerConfig,
    store: &CloudflareSecretStore,
) -> AppResult<Response> {
    match &route {
        ApiRoute::MessageTokens => {
            let body = request_json(&mut request).await?;
            let adapted = anthropic::messages_request_to_responses(
                &body,
                anthropic::MessageRequestOptions {
                    require_max_tokens: false,
                },
            )?;
            let counter = Cl100kTokenCounter;
            let count = anthropic::count_codex_input_tokens(&adapted.body, &counter);
            return json_response(&json!({ "input_tokens": count }), 200);
        }
        ApiRoute::GeminiTokens { model } => {
            let body = request_json(&mut request).await?;
            let counter = Cl100kTokenCounter;
            return json_response(&gemini::gemini_count_tokens(&body, model, &counter)?, 200);
        }
        _ => {}
    }

    let oauth = OAuthRepository::new(store, &config.encryption_key);
    let client = CodexClient::new(&oauth, config.require_relay_origin()?);
    match route {
        ApiRoute::Models => {
            let signal = AbortSignal::from(request.inner().signal());
            let mut upstream = client
                .fetch_models(client_url, request_options(&request, &signal))
                .await?;
            if !success(upstream.status_code()) {
                return worker_response(response::upstream_error(upstream));
            }
            if client_url
                .query_pairs()
                .any(|(name, _)| name == "client_version")
            {
                return worker_response(response::upstream_json(upstream));
            }
            let payload = upstream_json(&mut upstream).await?;
            json_response(&to_openai_model_list(&payload)?, 200)
        }
        ApiRoute::GeminiModels => {
            let signal = AbortSignal::from(request.inner().signal());
            let mut upstream = client
                .fetch_models(client_url, request_options(&request, &signal))
                .await?;
            if !success(upstream.status_code()) {
                return worker_response(gemini_upstream_error_response(upstream).await);
            }
            let payload = upstream_json(&mut upstream).await?;
            json_response(&gemini::gemini_model_list(&payload)?, 200)
        }
        ApiRoute::GeminiModel { model } => {
            let signal = AbortSignal::from(request.inner().signal());
            let mut upstream = client
                .fetch_models(client_url, request_options(&request, &signal))
                .await?;
            if !success(upstream.status_code()) {
                return worker_response(gemini_upstream_error_response(upstream).await);
            }
            let payload = upstream_json(&mut upstream).await?;
            json_response(&gemini::gemini_model_detail(&payload, &model)?, 200)
        }
        route @ (ApiRoute::Responses | ApiRoute::Compact | ApiRoute::Proxy) => {
            let proxy_route = match route {
                ApiRoute::Responses => CodexProxyRoute::Responses,
                ApiRoute::Compact => CodexProxyRoute::Compact,
                ApiRoute::Proxy => CodexProxyRoute::Proxy,
                _ => return Err(runtime_failure()),
            };
            let upstream = client
                .forward_proxy(request, client_url, proxy_route, context)
                .await?;
            worker_response(response::upstream_proxy(upstream))
        }
        ApiRoute::MessageTokens | ApiRoute::GeminiTokens { .. } => Err(runtime_failure()),
        route @ (ApiRoute::ChatCompletions
        | ApiRoute::Completions
        | ApiRoute::Messages
        | ApiRoute::GeminiGenerate { .. }) => {
            let body = request_json(&mut request).await?;
            let adapted = route.adapter().ok_or_else(runtime_failure)?.adapt(&body)?;
            let signal = AbortSignal::from(request.inner().signal());
            let upstream = client
                .send_converted_responses(&adapted.body, request_options(&request, &signal))
                .await?;
            if !success(upstream.status_code()) {
                let converted = match route {
                    ApiRoute::Messages => anthropic_upstream_error_response(upstream).await,
                    ApiRoute::GeminiGenerate { .. } => {
                        gemini_upstream_error_response(upstream).await
                    }
                    _ => response::upstream_error(upstream),
                };
                return worker_response(converted);
            }
            let created = Value::from(Date::now().as_millis() / 1_000);
            if adapted.stream {
                return worker_response(present_stream(upstream, adapted.response, created));
            }
            let output = present_non_stream(upstream, &adapted.response, created).await?;
            json_response(&output, 200)
        }
    }
}

fn request_options<'a>(request: &'a Request, signal: &'a AbortSignal) -> CodexRequestOptions<'a> {
    CodexRequestOptions {
        headers: Some(request.headers()),
        signal: Some(signal.clone()),
    }
}

async fn upstream_json(upstream: &mut Response) -> AppResult<Value> {
    let bytes = read_limited_response(upstream, MAX_MODEL_CATALOG_BYTES).await?;
    serde_json::from_slice(&bytes).map_err(|_| {
        ApiError::new(502, "The Codex backend returned invalid JSON.")
            .with_kind("upstream_error")
            .with_code("invalid_codex_response")
    })
}

fn json_response(value: &impl serde::Serialize, status: u16) -> AppResult<Response> {
    worker_response(response::json(value, status))
}

fn worker_response(result: worker::Result<Response>) -> AppResult<Response> {
    result.map_err(|_| runtime_failure())
}

const fn success(status: u16) -> bool {
    status >= 200 && status < 300
}

fn runtime_failure() -> ApiError {
    ApiError::new(500, "The request could not be completed.")
        .with_kind("internal_error")
        .with_code("worker_runtime_error")
}
