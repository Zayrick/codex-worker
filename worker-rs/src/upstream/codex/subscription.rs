use base64::{
    Engine as _,
    engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::core::{ApiError, AppResult, JsonObject, record_field};

pub const CODEX_USAGE_PATH: &str = "/backend-api/wham/usage";
pub const CODEX_USAGE_REQUEST_TIMEOUT_MS: u64 = 10_000;
pub const MAX_CODEX_USAGE_RESPONSE_BYTES: usize = 256 * 1024;
const FIVE_HOUR_SECONDS: f64 = 5.0 * 60.0 * 60.0;
const WEEK_SECONDS: f64 = 7.0 * 24.0 * 60.0 * 60.0;
const MIN_MONTH_SECONDS: f64 = 28.0 * 24.0 * 60.0 * 60.0;
const MAX_MONTH_SECONDS: f64 = 31.0 * 24.0 * 60.0 * 60.0;
const MAX_JAVASCRIPT_DATE_MS: f64 = 8_640_000_000_000_000.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexQuotaWindowKind {
    FiveHour,
    Weekly,
    Monthly,
    Primary,
    Secondary,
}

impl CodexQuotaWindowKind {
    const fn as_str(self) -> &'static str {
        match self {
            Self::FiveHour => "five_hour",
            Self::Weekly => "weekly",
            Self::Monthly => "monthly",
            Self::Primary => "primary",
            Self::Secondary => "secondary",
        }
    }

    const fn rank(self) -> u8 {
        match self {
            Self::FiveHour => 0,
            Self::Weekly => 1,
            Self::Monthly => 2,
            Self::Primary => 3,
            Self::Secondary => 4,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexQuotaCategory {
    Codex,
    CodeReview,
    Additional,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSubscriptionMetadata {
    pub plan_type: Option<String>,
    pub subscription_active_start: Option<f64>,
    pub subscription_active_until: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexQuotaWindow {
    pub id: String,
    pub category: CodexQuotaCategory,
    pub name: String,
    pub kind: CodexQuotaWindowKind,
    pub used_percent: Option<f64>,
    pub remaining_percent: Option<f64>,
    pub limit_window_seconds: Option<f64>,
    pub reset_at: Option<f64>,
    pub allowed: Option<bool>,
    pub limit_reached: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRateLimitResetCredits {
    pub available_count: Option<f64>,
    pub applicable_available_count: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSubscriptionInfo {
    pub plan_type: Option<String>,
    pub subscription_active_start: Option<f64>,
    pub subscription_active_until: Option<f64>,
    pub windows: Vec<CodexQuotaWindow>,
    pub rate_limit_reset_credits: CodexRateLimitResetCredits,
    pub fetched_at: f64,
}

/// Extracts display metadata from an ID token accepted by the authentication boundary.
pub fn codex_subscription_metadata(id_token: Option<&str>) -> CodexSubscriptionMetadata {
    let claims = id_token.and_then(decode_jwt);
    let auth = record_field(claims.as_ref(), "https://api.openai.com/auth").or(claims.as_ref());
    CodexSubscriptionMetadata {
        plan_type: normalize_plan_type(alias4(
            auth,
            "chatgpt_plan_type",
            "chatgptPlanType",
            "plan_type",
            "planType",
        )),
        subscription_active_start: date_value_to_ms(alias4(
            auth,
            "chatgpt_subscription_active_start",
            "chatgptSubscriptionActiveStart",
            "subscription_active_start",
            "subscriptionActiveStart",
        )),
        subscription_active_until: date_value_to_ms(alias4(
            auth,
            "chatgpt_subscription_active_until",
            "chatgptSubscriptionActiveUntil",
            "subscription_active_until",
            "subscriptionActiveUntil",
        )),
    }
}

pub fn codex_subscription_from_usage(
    payload: &Value,
    metadata: CodexSubscriptionMetadata,
    now_ms: f64,
) -> AppResult<CodexSubscriptionInfo> {
    let payload = payload
        .as_object()
        .ok_or_else(invalid_codex_usage_response)?;
    Ok(CodexSubscriptionInfo {
        plan_type: normalize_plan_type(alias(payload, "plan_type", "planType"))
            .or(metadata.plan_type),
        subscription_active_start: metadata.subscription_active_start,
        subscription_active_until: metadata.subscription_active_until,
        windows: build_quota_windows(payload, now_ms),
        rate_limit_reset_credits: normalize_reset_credits(alias(
            payload,
            "rate_limit_reset_credits",
            "rateLimitResetCredits",
        )),
        fetched_at: now_ms,
    })
}

pub fn codex_usage_unavailable() -> ApiError {
    ApiError::new(502, "Unable to retrieve Codex subscription usage.")
        .with_kind("upstream_error")
        .with_code("codex_usage_unavailable")
}

pub fn codex_usage_upstream_error(status: u16) -> ApiError {
    ApiError::new(502, "The Codex subscription usage request was rejected.")
        .with_kind("upstream_error")
        .with_code(if status == 429 {
            "codex_usage_rate_limited"
        } else {
            "codex_usage_upstream_error"
        })
}

pub fn invalid_codex_usage_response() -> ApiError {
    ApiError::new(502, "The Codex subscription usage response was invalid.")
        .with_kind("upstream_error")
        .with_code("invalid_codex_usage_response")
}

#[derive(Clone, Copy)]
struct WindowGroup<'a> {
    id: &'a str,
    category: CodexQuotaCategory,
    name: &'a str,
}

fn build_quota_windows(payload: &JsonObject, now_ms: f64) -> Vec<CodexQuotaWindow> {
    let mut windows = Vec::new();
    append_rate_limit_windows(
        &mut windows,
        alias(payload, "rate_limit", "rateLimit"),
        WindowGroup {
            id: "codex",
            category: CodexQuotaCategory::Codex,
            name: "Codex",
        },
        now_ms,
    );
    append_rate_limit_windows(
        &mut windows,
        alias(payload, "code_review_rate_limit", "codeReviewRateLimit"),
        WindowGroup {
            id: "code-review",
            category: CodexQuotaCategory::CodeReview,
            name: "Code Review",
        },
        now_ms,
    );
    if let Some(additional) =
        alias(payload, "additional_rate_limits", "additionalRateLimits").and_then(Value::as_array)
    {
        for (index, item) in additional.iter().enumerate() {
            let Some(item) = item.as_object() else {
                continue;
            };
            let name = normalize_string(alias(item, "limit_name", "limitName"))
                .or_else(|| normalize_string(alias(item, "metered_feature", "meteredFeature")))
                .unwrap_or_else(|| format!("Additional {}", index + 1));
            let id = format!("additional-{}-{}", index + 1, slug(&name));
            append_rate_limit_windows(
                &mut windows,
                alias(item, "rate_limit", "rateLimit"),
                WindowGroup {
                    id: &id,
                    category: CodexQuotaCategory::Additional,
                    name: &name,
                },
                now_ms,
            );
        }
    }
    windows
}

fn append_rate_limit_windows(
    target: &mut Vec<CodexQuotaWindow>,
    value: Option<&Value>,
    group: WindowGroup<'_>,
    now_ms: f64,
) {
    let Some(value) = value.and_then(Value::as_object) else {
        return;
    };
    let allowed = value.get("allowed").and_then(Value::as_bool);
    let limit_reached = alias(value, "limit_reached", "limitReached").and_then(Value::as_bool)
        == Some(true)
        || allowed == Some(false);
    let mut candidates = [
        (
            CodexQuotaWindowKind::Primary,
            alias(value, "primary_window", "primaryWindow").and_then(Value::as_object),
        ),
        (
            CodexQuotaWindowKind::Secondary,
            alias(value, "secondary_window", "secondaryWindow").and_then(Value::as_object),
        ),
    ]
    .into_iter()
    .filter_map(|(fallback, window)| {
        window.map(|window| (quota_window_kind(window, fallback), window))
    })
    .collect::<Vec<_>>();
    candidates.sort_by_key(|(kind, _)| kind.rank());
    for (index, (kind, window)) in candidates.into_iter().enumerate() {
        let raw_used = number_value(alias(window, "used_percent", "usedPercent"));
        let used_percent = raw_used
            .map(clamp_percent)
            .or_else(|| limit_reached.then_some(100.0));
        target.push(CodexQuotaWindow {
            id: format!("{}-{}-{index}", group.id, kind.as_str()),
            category: group.category,
            name: group.name.to_owned(),
            kind,
            used_percent,
            remaining_percent: used_percent.map(|value| clamp_percent(100.0 - value)),
            limit_window_seconds: positive_number(alias(
                window,
                "limit_window_seconds",
                "limitWindowSeconds",
            )),
            reset_at: quota_reset_at(window, now_ms),
            allowed,
            limit_reached,
        });
    }
}

fn quota_window_kind(window: &JsonObject, fallback: CodexQuotaWindowKind) -> CodexQuotaWindowKind {
    let seconds = positive_number(alias(window, "limit_window_seconds", "limitWindowSeconds"));
    match seconds {
        Some(value) if value == FIVE_HOUR_SECONDS => CodexQuotaWindowKind::FiveHour,
        Some(value) if value == WEEK_SECONDS => CodexQuotaWindowKind::Weekly,
        Some(value) if (MIN_MONTH_SECONDS..=MAX_MONTH_SECONDS).contains(&value) => {
            CodexQuotaWindowKind::Monthly
        }
        _ => fallback,
    }
}

fn quota_reset_at(window: &JsonObject, now_ms: f64) -> Option<f64> {
    date_value_to_ms(alias(window, "reset_at", "resetAt")).or_else(|| {
        positive_number(alias(window, "reset_after_seconds", "resetAfterSeconds"))
            .map(|seconds| now_ms + seconds * 1_000.0)
    })
}

fn normalize_reset_credits(value: Option<&Value>) -> CodexRateLimitResetCredits {
    let Some(value) = value.and_then(Value::as_object) else {
        return CodexRateLimitResetCredits::default();
    };
    CodexRateLimitResetCredits {
        available_count: nonnegative_number(alias(value, "available_count", "availableCount")),
        applicable_available_count: nonnegative_number(alias(
            value,
            "applicable_available_count",
            "applicableAvailableCount",
        )),
    }
}

fn decode_jwt(token: &str) -> Option<JsonObject> {
    let mut parts = token.split('.');
    let _header = parts.next()?;
    let payload = parts.next()?;
    let _signature = parts.next()?;
    if payload.is_empty() || parts.next().is_some() {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| URL_SAFE.decode(payload))
        .ok()?;
    serde_json::from_slice::<Value>(&bytes)
        .ok()?
        .as_object()
        .cloned()
}

fn date_value_to_ms(value: Option<&Value>) -> Option<f64> {
    if let Some(numeric) = number_value(value) {
        if numeric <= 0.0 {
            return None;
        }
        let milliseconds = if numeric < 1e11 {
            numeric * 1_000.0
        } else {
            numeric
        };
        return (milliseconds.abs() <= MAX_JAVASCRIPT_DATE_MS).then_some(milliseconds);
    }
    let text = normalize_string(value)?;
    parse_rfc3339_ms(&text)
}

fn parse_rfc3339_ms(value: &str) -> Option<f64> {
    let timestamp = OffsetDateTime::parse(value, &Rfc3339).ok()?;
    let milliseconds = (timestamp.unix_timestamp_nanos() as f64 / 1_000_000.0).trunc();
    (milliseconds.abs() <= MAX_JAVASCRIPT_DATE_MS).then_some(milliseconds)
}

fn normalize_plan_type(value: Option<&Value>) -> Option<String> {
    normalize_string(value).map(|value| value.to_lowercase())
}

fn normalize_string(value: Option<&Value>) -> Option<String> {
    value?
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn number_value(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(value) => value.as_f64().filter(|value| value.is_finite()),
        Value::String(value) if !value.trim().is_empty() => value
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite()),
        _ => None,
    }
}

fn positive_number(value: Option<&Value>) -> Option<f64> {
    number_value(value).filter(|value| *value > 0.0)
}

fn nonnegative_number(value: Option<&Value>) -> Option<f64> {
    number_value(value).filter(|value| *value >= 0.0)
}

fn clamp_percent(value: f64) -> f64 {
    value.clamp(0.0, 100.0)
}

fn slug(value: &str) -> String {
    let mut slug = String::new();
    let mut separator = false;
    for character in value.trim().to_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            if separator && !slug.is_empty() {
                slug.push('-');
            }
            separator = false;
            slug.push(character);
        } else {
            separator = true;
        }
    }
    if slug.is_empty() {
        "quota".into()
    } else {
        slug
    }
}

fn alias<'a>(object: &'a JsonObject, first: &str, second: &str) -> Option<&'a Value> {
    object
        .get(first)
        .filter(|value| !value.is_null())
        .or_else(|| object.get(second).filter(|value| !value.is_null()))
}

fn alias4<'a>(
    object: Option<&'a JsonObject>,
    first: &str,
    second: &str,
    third: &str,
    fourth: &str,
) -> Option<&'a Value> {
    let object = object?;
    [first, second, third, fourth]
        .into_iter()
        .find_map(|key| object.get(key).filter(|value| !value.is_null()))
}
