//! Cloudflare-specific request, response, storage, and upstream I/O adapters.

mod admin;
mod api;
mod application_page;
mod auth_proxy;
mod bark;
mod body;
mod codex;
mod config;
mod dingtalk;
mod oauth;
mod provider_error;
mod response;
mod router;
mod scheduled;
mod status;
mod store;
mod stream;
mod usage_store;

pub use router::handle_fetch;
pub use scheduled::handle_scheduled;
