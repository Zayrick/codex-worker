//! Cloudflare-specific request, response, storage, and upstream I/O adapters.

mod admin;
mod api;
mod body;
mod codex;
mod config;
mod oauth;
mod provider_error;
mod response;
mod router;
mod store;
mod stream;

pub use router::{handle_fetch, handle_scheduled};
