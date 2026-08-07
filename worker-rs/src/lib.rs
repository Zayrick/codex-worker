//! Rust/WebAssembly implementation of the codex-worker backend.
//!
//! Runtime-neutral protocol and application modules stay testable on the host;
//! Cloudflare bindings are isolated behind the `wasm32` transport boundary.

pub mod application;
pub mod auth;
pub mod core;
pub mod http;
pub mod protocol;
pub mod upstream;

#[cfg(target_arch = "wasm32")]
pub mod transport;

#[cfg(target_arch = "wasm32")]
#[worker::event(fetch)]
pub async fn fetch(
    request: worker::Request,
    env: worker::Env,
    context: worker::Context,
) -> worker::Result<worker::Response> {
    transport::handle_fetch(request, env, context).await
}

#[cfg(target_arch = "wasm32")]
#[worker::event(scheduled)]
pub async fn scheduled(
    event: worker::ScheduledEvent,
    env: worker::Env,
    context: worker::ScheduleContext,
) {
    transport::handle_scheduled(event, env, context).await;
}
