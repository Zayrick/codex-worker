use async_stream::stream;
use futures_util::StreamExt;
use serde_json::Value;
use worker::{Headers, Response};

use crate::{
    application::ResponseAdapter,
    core::{ApiError, AppResult, JsonObject},
    protocol::{anthropic, gemini, openai},
};

pub async fn present_non_stream(
    mut upstream: Response,
    adapter: &ResponseAdapter,
    created: Value,
) -> AppResult<Value> {
    match adapter {
        ResponseAdapter::OpenAiChat { model, .. } => {
            let state = decode_chat_state(&mut upstream, model, created).await?;
            openai::chat::chat_completion_from_state(&state).map(Value::Object)
        }
        ResponseAdapter::OpenAiCompletion {
            model, echo_prefix, ..
        } => {
            let state = decode_chat_state(&mut upstream, model, created).await?;
            let chat = openai::chat::chat_completion_from_state(&state)?;
            Ok(Value::Object(openai::completions::completion_from_chat(
                &chat,
                echo_prefix,
            )))
        }
        ResponseAdapter::AnthropicMessages {
            model,
            reverse_tool_names,
        } => {
            let terminal = decode_terminal_event(&mut upstream).await?;
            anthropic::message_from_event_values(terminal, model, reverse_tool_names)
                .map(Value::Object)
        }
        ResponseAdapter::GeminiContent {
            model,
            reverse_tool_names,
        } => {
            let terminal = decode_terminal_event(&mut upstream).await?;
            gemini::gemini_response_from_events(terminal, model, reverse_tool_names)
        }
    }
}

pub fn present_stream(
    upstream: Response,
    adapter: ResponseAdapter,
    created: Value,
) -> worker::Result<Response> {
    match adapter {
        ResponseAdapter::OpenAiChat {
            model,
            include_usage,
        } => chat_stream(upstream, model, include_usage, created),
        ResponseAdapter::OpenAiCompletion {
            model,
            include_usage,
            echo_prefix,
        } => completion_stream(upstream, model, include_usage, echo_prefix, created),
        ResponseAdapter::AnthropicMessages {
            model,
            reverse_tool_names,
        } => anthropic_stream(upstream, model, reverse_tool_names),
        ResponseAdapter::GeminiContent {
            model,
            reverse_tool_names,
        } => gemini_stream(upstream, model, reverse_tool_names),
    }
}

async fn decode_chat_state(
    upstream: &mut Response,
    model: &str,
    created: Value,
) -> AppResult<openai::chat::ChatState> {
    let mut state = openai::chat::create_chat_state(model, created);
    consume_events(upstream, |event| {
        openai::chat::reduce_codex_event(&mut state, event)?;
        Ok(state.terminal.is_some())
    })
    .await?;
    Ok(state)
}

async fn decode_terminal_event(upstream: &mut Response) -> AppResult<Option<Value>> {
    let mut terminal = None;
    consume_events(upstream, |event| {
        let done = event
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|kind| {
                matches!(
                    kind,
                    "error" | "response.completed" | "response.incomplete" | "response.failed"
                )
            });
        if done {
            terminal = Some(Value::Object(event.clone()));
        }
        Ok(done)
    })
    .await?;
    Ok(terminal)
}

async fn consume_events(
    upstream: &mut Response,
    mut consume: impl FnMut(&JsonObject) -> AppResult<bool>,
) -> AppResult<()> {
    let mut source = upstream.stream().map_err(|_| stream_failed())?;
    let mut decoder = openai::sse::SseDecoder::new();
    while let Some(chunk) = source.next().await {
        let chunk = chunk.map_err(|_| stream_failed())?;
        for event in decoder.push_bytes(&chunk)? {
            if consume(&event)? {
                drop(source);
                return Ok(());
            }
        }
    }
    for event in decoder.finish()? {
        if consume(&event)? {
            break;
        }
    }
    Ok(())
}

fn chat_stream(
    mut upstream: Response,
    model: String,
    include_usage: bool,
    created: Value,
) -> worker::Result<Response> {
    let headers = sse_headers(upstream.headers())?;
    let mut source = upstream.stream()?;
    let output = stream! {
        let mut decoder = openai::sse::SseDecoder::new();
        let mut presenter = openai::chat::ChatStreamPresenter::new(model, created, include_usage);
        let mut failed = false;
        let mut finished = false;
        while let Some(chunk) = source.next().await {
            let events = match chunk {
                Ok(chunk) => decoder.push_bytes(&chunk),
                Err(_) => Err(stream_failed()),
            };
            let events = match events {
                Ok(events) => events,
                Err(_) => {
                    for frame in openai_failure_frames() {
                        yield Ok::<_, worker::Error>(frame.into_bytes());
                    }
                    failed = true;
                    break;
                }
            };
            for event in events {
                match presenter.push_event(&event) {
                    Ok(frames) => for frame in frames {
                        yield Ok::<_, worker::Error>(frame.into_bytes());
                    },
                    Err(_) => {
                        for frame in openai_failure_frames() {
                            yield Ok::<_, worker::Error>(frame.into_bytes());
                        }
                        failed = true;
                        break;
                    }
                }
                if failed {
                    break;
                }
                if presenter.presentation.finished {
                    finished = true;
                    break;
                }
            }
            if failed || finished {
                break;
            }
        }
        if !failed && !finished {
            let tail = decoder.finish().and_then(|events| {
                let mut frames = Vec::new();
                for event in events {
                    frames.extend(presenter.push_event(&event)?);
                }
                presenter.finish()?;
                Ok(frames)
            });
            match tail {
                Ok(frames) => for frame in frames {
                    yield Ok::<_, worker::Error>(frame.into_bytes());
                },
                Err(_) => for frame in openai_failure_frames() {
                    yield Ok::<_, worker::Error>(frame.into_bytes());
                },
            }
        }
    };
    Ok(Response::from_stream(output)?.with_headers(headers))
}

fn completion_stream(
    mut upstream: Response,
    model: String,
    include_usage: bool,
    echo_prefix: String,
    created: Value,
) -> worker::Result<Response> {
    let headers = sse_headers(upstream.headers())?;
    let mut source = upstream.stream()?;
    let output = stream! {
        let mut decoder = openai::sse::SseDecoder::new();
        let mut presenter = openai::chat::ChatStreamPresenter::new(model, created, include_usage);
        let mut completion = openai::completions::CompletionSseDecoder::new(echo_prefix);
        let mut failed = false;
        let mut finished = false;
        while let Some(chunk) = source.next().await {
            let events = match chunk {
                Ok(chunk) => decoder.push_bytes(&chunk),
                Err(_) => Err(stream_failed()),
            };
            let events = match events {
                Ok(events) => events,
                Err(_) => {
                    for frame in completion_failure_frames(&mut completion) {
                        yield Ok::<_, worker::Error>(frame.into_bytes());
                    }
                    failed = true;
                    break;
                }
            };
            for event in events {
                match presenter.push_event(&event) {
                    Ok(frames) => for chat_frame in frames {
                        match completion.push_str(&chat_frame) {
                            Ok(frames) => for frame in frames {
                                yield Ok::<_, worker::Error>(frame.into_bytes());
                            },
                            Err(_) => {
                                for frame in completion_failure_frames(&mut completion) {
                                    yield Ok::<_, worker::Error>(frame.into_bytes());
                                }
                                failed = true;
                                break;
                            }
                        }
                    },
                    Err(_) => {
                        for frame in completion_failure_frames(&mut completion) {
                            yield Ok::<_, worker::Error>(frame.into_bytes());
                        }
                        failed = true;
                        break;
                    }
                }
                if failed {
                    break;
                }
                if presenter.presentation.finished {
                    finished = true;
                    break;
                }
            }
            if failed || finished {
                break;
            }
        }
        if !failed && !finished {
            let tail = decoder.finish().and_then(|events| {
                let mut chat_frames = Vec::new();
                for event in events {
                    chat_frames.extend(presenter.push_event(&event)?);
                }
                presenter.finish()?;
                Ok(chat_frames)
            });
            match tail {
                Ok(chat_frames) => {
                    let mut conversion_failed = false;
                    for chat_frame in chat_frames {
                        match completion.push_str(&chat_frame) {
                            Ok(frames) => for frame in frames {
                                yield Ok::<_, worker::Error>(frame.into_bytes());
                            },
                            Err(_) => {
                                conversion_failed = true;
                                break;
                            }
                        }
                    }
                    if conversion_failed {
                        for frame in completion_failure_frames(&mut completion) {
                            yield Ok::<_, worker::Error>(frame.into_bytes());
                        }
                    } else {
                        match completion.finish() {
                            Ok(frames) => for frame in frames {
                                yield Ok::<_, worker::Error>(frame.into_bytes());
                            },
                            Err(_) => for frame in completion_failure_frames(&mut completion) {
                                yield Ok::<_, worker::Error>(frame.into_bytes());
                            },
                        }
                    }
                }
                Err(_) => for frame in completion_failure_frames(&mut completion) {
                    yield Ok::<_, worker::Error>(frame.into_bytes());
                },
            }
        }
    };
    Ok(Response::from_stream(output)?.with_headers(headers))
}

fn anthropic_stream(
    mut upstream: Response,
    model: String,
    reverse_tool_names: std::collections::HashMap<String, String>,
) -> worker::Result<Response> {
    let headers = sse_headers(upstream.headers())?;
    let mut source = upstream.stream()?;
    let output = stream! {
        let mut decoder = openai::sse::SseDecoder::new();
        let mut presenter = anthropic::MessagesStreamPresenter::new(model, reverse_tool_names);
        let mut failed = false;
        let mut finished = false;
        while let Some(chunk) = source.next().await {
            let events = match chunk {
                Ok(chunk) => decoder.push_bytes(&chunk),
                Err(_) => Err(stream_failed()),
            };
            match events {
                Ok(events) => for event in events {
                    for frame in presenter.push(Value::Object(event)) {
                        yield Ok::<_, worker::Error>(render_anthropic(&frame).into_bytes());
                    }
                    if presenter.is_terminal() {
                        finished = true;
                        break;
                    }
                },
                Err(error) => {
                    yield Ok::<_, worker::Error>(render_anthropic_error(&error).into_bytes());
                    failed = true;
                    break;
                }
            }
            if finished {
                break;
            }
        }
        if !failed && !finished {
            match decoder.finish() {
                Ok(events) => for event in events {
                    for frame in presenter.push(Value::Object(event)) {
                        yield Ok::<_, worker::Error>(render_anthropic(&frame).into_bytes());
                    }
                },
                Err(error) => {
                    yield Ok::<_, worker::Error>(render_anthropic_error(&error).into_bytes());
                    failed = true;
                }
            }
            if !failed {
                for frame in presenter.finish() {
                    yield Ok::<_, worker::Error>(render_anthropic(&frame).into_bytes());
                }
            }
        }
    };
    Ok(Response::from_stream(output)?.with_headers(headers))
}

fn gemini_stream(
    mut upstream: Response,
    model: String,
    reverse_tool_names: std::collections::HashMap<String, String>,
) -> worker::Result<Response> {
    let headers = sse_headers(upstream.headers())?;
    let mut source = upstream.stream()?;
    let output = stream! {
        let mut decoder = openai::sse::SseDecoder::new();
        let mut presenter = gemini::GeminiStreamPresenter::new(gemini::GeminiStreamOptions {
            model,
            reverse_tool_names,
        });
        let mut failed = false;
        let mut finished = false;
        while let Some(chunk) = source.next().await {
            let events = match chunk {
                Ok(chunk) => decoder.push_bytes(&chunk),
                Err(_) => Err(stream_failed()),
            };
            match events {
                Ok(events) => for event in events {
                    for frame in presenter.push(Value::Object(event)) {
                        yield Ok::<_, worker::Error>(frame.render().into_bytes());
                    }
                    if presenter.is_terminal() {
                        finished = true;
                        break;
                    }
                },
                Err(error) => {
                    yield Ok::<_, worker::Error>(gemini::SseEvent::named(
                        "error",
                        gemini::gemini_error_payload(&error),
                    ).render().into_bytes());
                    failed = true;
                    break;
                }
            }
            if finished {
                break;
            }
        }
        if !failed && !finished {
            match decoder.finish() {
                Ok(events) => for event in events {
                    for frame in presenter.push(Value::Object(event)) {
                        yield Ok::<_, worker::Error>(frame.render().into_bytes());
                    }
                },
                Err(error) => {
                    yield Ok::<_, worker::Error>(gemini::SseEvent::named(
                        "error",
                        gemini::gemini_error_payload(&error),
                    ).render().into_bytes());
                    failed = true;
                }
            }
            if !failed {
                for frame in presenter.finish() {
                    yield Ok::<_, worker::Error>(frame.render().into_bytes());
                }
            }
        }
    };
    Ok(Response::from_stream(output)?.with_headers(headers))
}

fn sse_headers(source: &Headers) -> worker::Result<Headers> {
    let headers = Headers::new();
    headers.set("content-type", "text/event-stream; charset=utf-8")?;
    headers.set("cache-control", "no-cache, no-transform")?;
    if let Some(turn_state) = source
        .get("x-codex-turn-state")?
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    {
        headers.set("x-codex-turn-state", &turn_state)?;
    }
    Ok(headers)
}

fn openai_failure_frames() -> Vec<String> {
    openai::chat::stream_failure_frames().unwrap_or_else(|_| {
        vec![
            "data: {\"error\":{\"message\":\"The Codex response stream failed.\",\"type\":\"upstream_error\",\"code\":\"codex_stream_failed\"}}\n\n".into(),
            openai::sse::SSE_DONE.into(),
        ]
    })
}

fn completion_failure_frames(
    completion: &mut openai::completions::CompletionSseDecoder,
) -> Vec<String> {
    let mut output = Vec::new();
    for frame in openai_failure_frames() {
        match completion.push_str(&frame) {
            Ok(frames) => output.extend(frames),
            Err(_) => return vec![openai::sse::SSE_DONE.into()],
        }
    }
    output
}

fn render_anthropic(event: &anthropic::AnthropicSseEvent) -> String {
    let data = serde_json::to_string(&event.data).unwrap_or_else(|_| "{}".into());
    format!("event: {}\ndata: {data}\n\n", event.event)
}

fn render_anthropic_error(error: &ApiError) -> String {
    let event = anthropic::AnthropicSseEvent {
        event: "error".into(),
        data: anthropic::anthropic_error_payload(error, None),
    };
    render_anthropic(&event)
}

fn stream_failed() -> ApiError {
    ApiError::new(502, "The Codex response stream failed.")
        .with_kind("upstream_error")
        .with_code("codex_stream_failed")
}
