//! Runtime-neutral Gemini compatibility protocol.
//!
//! This module owns only routing and JSON adaptation. Network I/O, Cloudflare
//! bindings, SSE decoding, and tokenization live behind transport/application
//! boundaries so the protocol can be tested on the host target.

mod error;
mod models;
mod path;
mod ports;
mod request;
mod response;
mod stream;

pub use error::{
    codex_stream_failed, failed_codex_response, gemini_codex_event_error, gemini_error_payload,
    gemini_upstream_error, google_status, incomplete_codex_stream,
};
pub use models::{gemini_model_detail, gemini_model_list, gemini_models};
pub use path::{GeminiAction, GeminiActionPath, match_gemini_action_path, match_gemini_model_path};
pub use ports::TokenCounter;
pub use request::{
    AdaptedGeminiRequest, gemini_count_request, gemini_count_tokens, gemini_request_to_responses,
};
pub use response::{
    GeminiChunkOptions, GeminiResponseMetadata, gemini_chunk, gemini_finish_reason,
    gemini_response_from_events, gemini_response_from_terminal, gemini_usage, output_mime_type,
    output_to_gemini_parts,
};
pub use stream::{GeminiStreamOptions, GeminiStreamPresenter, SseEvent};

#[cfg(test)]
mod tests;
