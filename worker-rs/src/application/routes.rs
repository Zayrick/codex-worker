use crate::{
    protocol::gemini::{GeminiAction, match_gemini_action_path, match_gemini_model_path},
    upstream::codex::{is_codex_proxy_path, is_codex_proxy_request_allowed},
};
use url::Url;

use super::{
    ANTHROPIC_MESSAGES_ADAPTER, CHAT_COMPLETIONS_ADAPTER, COMPLETIONS_ADAPTER,
    GEMINI_CONTENT_ADAPTER,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtocolFamily {
    OpenAi,
    Anthropic,
    Gemini,
    Codex,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApiRoute {
    Models,
    Responses,
    Compact,
    Proxy,
    ChatCompletions,
    Completions,
    Messages,
    MessageTokens,
    GeminiModels,
    GeminiModel { model: String },
    GeminiGenerate { model: String, stream: bool },
    GeminiTokens { model: String },
}

impl ApiRoute {
    pub const fn family(&self) -> ProtocolFamily {
        match self {
            Self::Messages | Self::MessageTokens => ProtocolFamily::Anthropic,
            Self::GeminiModels
            | Self::GeminiModel { .. }
            | Self::GeminiGenerate { .. }
            | Self::GeminiTokens { .. } => ProtocolFamily::Gemini,
            Self::Responses | Self::Compact | Self::Proxy => ProtocolFamily::Codex,
            Self::Models | Self::ChatCompletions | Self::Completions => ProtocolFamily::OpenAi,
        }
    }

    pub const fn adapter_id(&self) -> Option<&'static str> {
        match self {
            Self::ChatCompletions => Some(CHAT_COMPLETIONS_ADAPTER),
            Self::Completions => Some(COMPLETIONS_ADAPTER),
            Self::Messages => Some(ANTHROPIC_MESSAGES_ADAPTER),
            Self::GeminiGenerate { .. } => Some(GEMINI_CONTENT_ADAPTER),
            _ => None,
        }
    }
}

pub fn match_api_route(
    method: &str,
    client_url: &Url,
    websocket_upgrade: bool,
) -> Option<ApiRoute> {
    let route = match_api_path(client_url.path())?;
    match &route {
        ApiRoute::Models | ApiRoute::GeminiModels | ApiRoute::GeminiModel { .. } => {
            (method == "GET").then_some(route)
        }
        ApiRoute::Responses => {
            ((method == "POST") || (method == "GET" && websocket_upgrade)).then_some(route)
        }
        ApiRoute::Proxy => {
            is_codex_proxy_request_allowed(method, client_url, websocket_upgrade).then_some(route)
        }
        _ => (method == "POST").then_some(route),
    }
}

pub fn is_known_api_path(pathname: &str) -> bool {
    match_api_path(pathname).is_some()
}

fn match_api_path(pathname: &str) -> Option<ApiRoute> {
    match pathname {
        "/v1/models" => Some(ApiRoute::Models),
        "/v1/responses"
        | "/v1/responses/"
        | "/backend-api/codex/responses"
        | "/backend-api/codex/responses/" => Some(ApiRoute::Responses),
        "/v1/responses/compact"
        | "/v1/responses/compact/"
        | "/backend-api/codex/responses/compact"
        | "/backend-api/codex/responses/compact/" => Some(ApiRoute::Compact),
        "/v1/chat/completions" => Some(ApiRoute::ChatCompletions),
        "/v1/completions" => Some(ApiRoute::Completions),
        "/v1/messages" | "/v1/messages/" => Some(ApiRoute::Messages),
        "/v1/messages/count_tokens" | "/v1/messages/count_tokens/" => Some(ApiRoute::MessageTokens),
        "/v1beta/models" | "/v1beta/models/" => Some(ApiRoute::GeminiModels),
        _ => {
            if let Some(target) = match_gemini_action_path(pathname) {
                return Some(match target.action {
                    GeminiAction::GenerateContent => ApiRoute::GeminiGenerate {
                        model: target.model,
                        stream: false,
                    },
                    GeminiAction::StreamGenerateContent => ApiRoute::GeminiGenerate {
                        model: target.model,
                        stream: true,
                    },
                    GeminiAction::CountTokens => ApiRoute::GeminiTokens {
                        model: target.model,
                    },
                });
            }
            if let Some(model) = match_gemini_model_path(pathname) {
                return Some(ApiRoute::GeminiModel { model });
            }
            is_codex_proxy_path(pathname).then_some(ApiRoute::Proxy)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdminRoute {
    Page,
    Login,
    Logout,
    State,
    Subscription,
    OAuthStart,
    OAuthPoll,
    OAuthDelete,
    ApiKeysGet,
    ApiKeysCreate,
    ApiKeysUpdate,
    ApiKeysDelete,
    AuthProxyUpdate,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MatchedAdminRoute {
    pub base_path: String,
    pub route: AdminRoute,
}

pub fn match_admin_route(
    method: &str,
    pathname: &str,
    configured_path: &str,
) -> Option<MatchedAdminRoute> {
    let configured_path = configured_path.trim();
    if !valid_route_id(configured_path) {
        return None;
    }
    let base_path = format!("/{configured_path}/admin");
    if pathname == base_path {
        return (method == "GET").then_some(MatchedAdminRoute {
            base_path,
            route: AdminRoute::Page,
        });
    }
    let relative = pathname.strip_prefix(&format!("{base_path}/"))?;
    let route = match (method, relative) {
        ("POST", "login") => AdminRoute::Login,
        ("POST", "logout") => AdminRoute::Logout,
        ("GET", "state") => AdminRoute::State,
        ("GET", "subscription") => AdminRoute::Subscription,
        ("POST", "oauth/device") => AdminRoute::OAuthStart,
        ("POST", "oauth/device/poll") => AdminRoute::OAuthPoll,
        ("DELETE", "oauth") => AdminRoute::OAuthDelete,
        ("GET", "api-keys") => AdminRoute::ApiKeysGet,
        ("POST", "api-keys") => AdminRoute::ApiKeysCreate,
        ("PUT", "api-keys") => AdminRoute::ApiKeysUpdate,
        ("DELETE", "api-keys") => AdminRoute::ApiKeysDelete,
        ("PUT", "auth-proxy") => AdminRoute::AuthProxyUpdate,
        _ => return None,
    };
    Some(MatchedAdminRoute { base_path, route })
}

fn valid_route_id(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hides_method_mismatches_but_recognizes_options_paths() {
        let url = Url::parse("https://worker.example/v1/chat/completions").unwrap();
        assert_eq!(
            match_api_route("POST", &url, false),
            Some(ApiRoute::ChatCompletions)
        );
        assert_eq!(match_api_route("GET", &url, false), None);
        assert!(is_known_api_path(url.path()));
    }

    #[test]
    fn preserves_extension_methods_for_native_codex_proxy_routes() {
        let url = Url::parse("https://worker.example/backend-api/codex/files/item").unwrap();
        assert_eq!(
            match_api_route("PROPFIND", &url, false),
            Some(ApiRoute::Proxy)
        );
        assert_eq!(match_api_route("CONNECT", &url, false), None);
    }

    #[test]
    fn captures_gemini_model_and_stream_action() {
        let url =
            Url::parse("https://worker.example/v1beta/models/gemini%2Dtest:streamGenerateContent")
                .unwrap();
        assert_eq!(
            match_api_route("POST", &url, false),
            Some(ApiRoute::GeminiGenerate {
                model: "gemini-test".into(),
                stream: true,
            })
        );
    }

    #[test]
    fn admin_path_is_secret_and_strictly_bounded() {
        assert_eq!(
            match_admin_route("GET", "/secret/admin/state", "secret"),
            Some(MatchedAdminRoute {
                base_path: "/secret/admin".into(),
                route: AdminRoute::State,
            })
        );
        assert_eq!(match_admin_route("GET", "/secret/admin", "bad/path"), None);
        assert_eq!(
            match_admin_route("PUT", "/secret/admin/auth-proxy", "secret"),
            Some(MatchedAdminRoute {
                base_path: "/secret/admin".into(),
                route: AdminRoute::AuthProxyUpdate,
            })
        );
    }
}
