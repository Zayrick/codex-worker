use worker::Env;

use crate::core::{ApiError, AppResult};

#[derive(Debug, Clone)]
pub struct WorkerConfig {
    relay_origin: Option<String>,
    pub encryption_key: String,
    pub cors_origin: String,
}

impl WorkerConfig {
    pub fn for_api_request(env: &Env, encryption_key: String) -> Self {
        Self {
            relay_origin: optional_string(env, "CHATGPT_RELAY_URL"),
            encryption_key,
            cors_origin: Self::cors_origin(env),
        }
    }

    pub fn admin_path(env: &Env) -> Option<String> {
        optional_string(env, "ADMIN_PATH")
    }

    pub fn admin_secret(env: &Env) -> AppResult<String> {
        required_string(env, "ADMIN_SECRET")
    }

    pub fn relay_origin(env: &Env) -> AppResult<String> {
        required_string(env, "CHATGPT_RELAY_URL")
    }

    pub fn bark_push_url(env: &Env) -> AppResult<String> {
        required_string(env, "BARK_PUSH_URL")
    }

    pub fn dingtalk_webhook_url(env: &Env) -> AppResult<String> {
        required_string(env, "DINGTALK_WEBHOOK_URL")
    }

    pub fn dingtalk_secret(env: &Env) -> AppResult<String> {
        required_string(env, "DINGTALK_SECRET")
    }

    pub fn require_relay_origin(&self) -> AppResult<&str> {
        self.relay_origin
            .as_deref()
            .ok_or_else(|| missing_binding("CHATGPT_RELAY_URL"))
    }

    pub fn encryption_key(env: &Env) -> AppResult<String> {
        required_string(env, "DATA_ENCRYPTION_KEY")
    }

    pub fn cors_origin(env: &Env) -> String {
        optional_string(env, "CORS_ORIGIN").unwrap_or_else(|| "*".into())
    }
}

fn required_string(env: &Env, name: &str) -> AppResult<String> {
    optional_string(env, name).ok_or_else(|| missing_binding(name))
}

fn missing_binding(name: &str) -> ApiError {
    ApiError::new(500, format!("The {name} binding is not configured."))
        .with_kind("configuration_error")
        .with_code("missing_worker_binding")
}

fn optional_string(env: &Env, name: &str) -> Option<String> {
    env.secret(name)
        .or_else(|_| env.var(name))
        .ok()
        .map(|binding| binding.to_string())
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}
