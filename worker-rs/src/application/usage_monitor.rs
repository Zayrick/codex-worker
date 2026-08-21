use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    core::{ApiError, AppResult},
    upstream::codex::{
        CodexQuotaCategory, CodexQuotaWindow, CodexQuotaWindowKind, CodexSubscriptionInfo,
    },
};

const STATE_VERSION: u8 = 1;
const MAX_WINDOWS: usize = 64;
const MAX_ID_CHARS: usize = 512;
const MAX_NAME_CHARS: usize = 256;
const MAX_PLAN_TYPE_CHARS: usize = 128;
const RESET_TIME_TOLERANCE_MS: i64 = 60_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexUsageMonitorState {
    pub version: u8,
    pub sampled_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_type: Option<String>,
    pub windows: Vec<MonitoredQuotaWindow>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MonitoredQuotaWindow {
    pub id: String,
    pub category: CodexQuotaCategory,
    pub name: String,
    pub kind: CodexQuotaWindowKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit_window_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reset_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining_time_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining_time_percent: Option<f64>,
    pub quota_below_time: bool,
    pub entry_alert_sent: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsageAlertKind {
    QuotaBelowTime,
    FastConsumption,
}

#[derive(Debug, Clone, PartialEq)]
pub struct UsageAlert {
    pub kind: UsageAlertKind,
    pub window_id: String,
    pub window_label: String,
    pub remaining_percent: f64,
    pub remaining_time_percent: f64,
    pub remaining_time_ms: i64,
    pub consumed_percent: Option<f64>,
    pub sustainable_percent: Option<f64>,
    pub sample_interval_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageNotification {
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CodexUsageMonitorEvaluation {
    pub state: CodexUsageMonitorState,
    pub alerts: Vec<UsageAlert>,
}

impl CodexUsageMonitorEvaluation {
    pub fn notification(&self) -> Option<UsageNotification> {
        if self.alerts.is_empty() {
            return None;
        }
        let body = self
            .alerts
            .iter()
            .map(alert_line)
            .collect::<Vec<_>>()
            .join("\n");
        Some(UsageNotification {
            title: "Codex 用量提醒".into(),
            body,
        })
    }

    pub fn mark_entry_alerts_delivered(&mut self) {
        for alert in &self.alerts {
            if alert.kind != UsageAlertKind::QuotaBelowTime {
                continue;
            }
            if let Some(window) = self
                .state
                .windows
                .iter_mut()
                .find(|window| window.id == alert.window_id)
            {
                window.entry_alert_sent = true;
            }
        }
    }
}

pub fn evaluate_codex_usage(
    previous: Option<&CodexUsageMonitorState>,
    subscription: &CodexSubscriptionInfo,
    now_ms: i64,
) -> CodexUsageMonitorEvaluation {
    let mut state = CodexUsageMonitorState {
        version: STATE_VERSION,
        sampled_at: now_ms,
        plan_type: subscription
            .plan_type
            .as_deref()
            .map(|value| bounded_chars(value, MAX_PLAN_TYPE_CHARS)),
        windows: subscription
            .windows
            .iter()
            .take(MAX_WINDOWS)
            .map(|window| snapshot(window, now_ms))
            .collect(),
    };
    let mut alerts = Vec::new();

    for current in &mut state.windows {
        if current.category != CodexQuotaCategory::Codex {
            continue;
        }
        let prior = previous.and_then(|state| {
            state
                .windows
                .iter()
                .find(|candidate| candidate.id == current.id)
                .map(|window| (state.sampled_at, window))
        });
        let prior_same_cycle = prior.filter(|(_, prior)| same_quota_cycle(prior, current));
        let prior_alerted = prior_same_cycle
            .is_some_and(|(_, prior)| prior.quota_below_time && prior.entry_alert_sent);
        current.entry_alert_sent = current.quota_below_time && prior_alerted;

        let Some(remaining_percent) = current.remaining_percent else {
            continue;
        };
        let Some(remaining_time_percent) = current.remaining_time_percent else {
            continue;
        };
        let Some(remaining_time_ms) = current.remaining_time_ms else {
            continue;
        };

        if current.quota_below_time && !current.entry_alert_sent {
            alerts.push(UsageAlert {
                kind: UsageAlertKind::QuotaBelowTime,
                window_id: current.id.clone(),
                window_label: window_label(current),
                remaining_percent,
                remaining_time_percent,
                remaining_time_ms,
                consumed_percent: None,
                sustainable_percent: None,
                sample_interval_ms: None,
            });
            continue;
        }

        let Some((previous_sampled_at, prior)) = prior_same_cycle else {
            continue;
        };
        if !prior_alerted {
            continue;
        }
        let Some(prior_remaining) = prior.remaining_percent else {
            continue;
        };
        let Some(prior_reset_at) = prior.reset_at else {
            continue;
        };
        let elapsed_ms = now_ms.saturating_sub(previous_sampled_at);
        let prior_remaining_time_ms = prior_reset_at.saturating_sub(previous_sampled_at);
        if elapsed_ms <= 0 || prior_remaining_time_ms <= 0 {
            continue;
        }
        let consumed_percent = prior_remaining - remaining_percent;
        if consumed_percent <= 0.0 {
            continue;
        }
        let evaluated_interval_ms = elapsed_ms.min(prior_remaining_time_ms);
        let sustainable_percent =
            prior_remaining * evaluated_interval_ms as f64 / prior_remaining_time_ms as f64;
        if consumed_percent > sustainable_percent {
            alerts.push(UsageAlert {
                kind: UsageAlertKind::FastConsumption,
                window_id: current.id.clone(),
                window_label: window_label(current),
                remaining_percent,
                remaining_time_percent,
                remaining_time_ms,
                consumed_percent: Some(consumed_percent),
                sustainable_percent: Some(sustainable_percent),
                sample_interval_ms: Some(elapsed_ms),
            });
        }
    }

    CodexUsageMonitorEvaluation { state, alerts }
}

pub fn validate_codex_usage_monitor_state(value: Value) -> AppResult<CodexUsageMonitorState> {
    let state: CodexUsageMonitorState =
        serde_json::from_value(value).map_err(|_| invalid_stored_usage_state())?;
    if state.version != STATE_VERSION
        || state.sampled_at <= 0
        || state.windows.len() > MAX_WINDOWS
        || state
            .plan_type
            .as_deref()
            .is_some_and(|value| value.is_empty() || value.chars().count() > MAX_PLAN_TYPE_CHARS)
    {
        return Err(invalid_stored_usage_state());
    }
    let mut ids = HashSet::new();
    for window in &state.windows {
        if window.id.is_empty()
            || window.id.chars().count() > MAX_ID_CHARS
            || !ids.insert(window.id.as_str())
            || window.name.is_empty()
            || window.name.chars().count() > MAX_NAME_CHARS
            || !valid_percent(window.used_percent)
            || !valid_percent(window.remaining_percent)
            || !valid_positive(window.limit_window_seconds)
            || window.reset_at.is_some_and(|value| value <= 0)
            || window.remaining_time_ms.is_some_and(|value| value < 0)
            || !valid_percent(window.remaining_time_percent)
            || window.entry_alert_sent && !window.quota_below_time
            || window.quota_below_time
                != (window.category == CodexQuotaCategory::Codex
                    && matches!(
                        (window.remaining_percent, window.remaining_time_percent),
                        (Some(quota), Some(time)) if quota < time
                    ))
        {
            return Err(invalid_stored_usage_state());
        }
    }
    Ok(state)
}

fn snapshot(window: &CodexQuotaWindow, now_ms: i64) -> MonitoredQuotaWindow {
    let used_percent = normalized_percent(window.used_percent);
    let remaining_percent = normalized_percent(window.remaining_percent);
    let limit_window_seconds = window
        .limit_window_seconds
        .filter(|value| value.is_finite() && *value > 0.0);
    let reset_at = window.reset_at.and_then(timestamp_ms);
    let duration_ms = limit_window_seconds.and_then(|seconds| positive_ms(seconds * 1_000.0));
    let remaining_time_ms = reset_at.map(|reset_at| reset_at.saturating_sub(now_ms).max(0));
    let remaining_time_percent = remaining_time_ms
        .zip(duration_ms)
        .map(|(remaining, duration)| {
            (remaining as f64 / duration as f64 * 100.0).clamp(0.0, 100.0)
        });
    let quota_below_time = window.category == CodexQuotaCategory::Codex
        && matches!(
            (remaining_percent, remaining_time_percent),
            (Some(quota), Some(time)) if quota < time
        );
    MonitoredQuotaWindow {
        id: bounded_chars(&window.id, MAX_ID_CHARS),
        category: window.category,
        name: bounded_chars(&window.name, MAX_NAME_CHARS),
        kind: window.kind,
        used_percent,
        remaining_percent,
        limit_window_seconds,
        reset_at,
        remaining_time_ms,
        remaining_time_percent,
        quota_below_time,
        entry_alert_sent: false,
    }
}

fn same_quota_cycle(previous: &MonitoredQuotaWindow, current: &MonitoredQuotaWindow) -> bool {
    previous.kind == current.kind
        && matches!(
            (previous.reset_at, current.reset_at),
            (Some(left), Some(right)) if left.abs_diff(right) <= RESET_TIME_TOLERANCE_MS as u64
        )
}

fn normalized_percent(value: Option<f64>) -> Option<f64> {
    value
        .filter(|value| value.is_finite())
        .map(|value| value.clamp(0.0, 100.0))
}

fn timestamp_ms(value: f64) -> Option<i64> {
    (value.is_finite() && value > 0.0 && value <= i64::MAX as f64).then_some(value as i64)
}

fn positive_ms(value: f64) -> Option<i64> {
    (value.is_finite() && value > 0.0 && value <= i64::MAX as f64).then_some(value as i64)
}

fn valid_percent(value: Option<f64>) -> bool {
    value.is_none_or(|value| value.is_finite() && (0.0..=100.0).contains(&value))
}

fn valid_positive(value: Option<f64>) -> bool {
    value.is_none_or(|value| value.is_finite() && value > 0.0)
}

fn bounded_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn window_label(window: &MonitoredQuotaWindow) -> String {
    let period = match window.kind {
        CodexQuotaWindowKind::FiveHour => "5 小时",
        CodexQuotaWindowKind::Weekly => "7 天",
        CodexQuotaWindowKind::Monthly => "月度",
        CodexQuotaWindowKind::Primary => "主要额度",
        CodexQuotaWindowKind::Secondary => "次要额度",
    };
    format!("{} · {period}", window.name)
}

fn alert_line(alert: &UsageAlert) -> String {
    match alert.kind {
        UsageAlertKind::QuotaBelowTime => format!(
            "{}：额度剩余 {:.1}%，低于剩余时间 {:.1}%（{}），当前消耗进度偏快。",
            alert.window_label,
            alert.remaining_percent,
            alert.remaining_time_percent,
            duration_label(alert.remaining_time_ms),
        ),
        UsageAlertKind::FastConsumption => format!(
            "{}：最近 {:.1} 分钟消耗 {:.1}%，高于均匀使用额度 {:.1}%；当前剩余 {:.1}%。",
            alert.window_label,
            alert.sample_interval_ms.unwrap_or_default() as f64 / 60_000.0,
            alert.consumed_percent.unwrap_or_default(),
            alert.sustainable_percent.unwrap_or_default(),
            alert.remaining_percent,
        ),
    }
}

fn duration_label(milliseconds: i64) -> String {
    let total_minutes = milliseconds.saturating_add(59_999) / 60_000;
    let days = total_minutes / (24 * 60);
    let hours = total_minutes % (24 * 60) / 60;
    let minutes = total_minutes % 60;
    if days > 0 {
        format!("{days} 天 {hours} 小时 {minutes} 分钟")
    } else if hours > 0 {
        format!("{hours} 小时 {minutes} 分钟")
    } else {
        format!("{minutes} 分钟")
    }
}

fn invalid_stored_usage_state() -> ApiError {
    ApiError::new(500, "Stored Codex usage state is unavailable.")
        .with_kind("configuration_error")
        .with_code("invalid_codex_usage_state")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::upstream::codex::CodexRateLimitResetCredits;

    const NOW_MS: i64 = 1_800_000_000_000;
    const FIVE_MINUTES_MS: i64 = 5 * 60 * 1_000;

    fn subscription(remaining_percent: f64, reset_at: i64) -> CodexSubscriptionInfo {
        CodexSubscriptionInfo {
            plan_type: Some("pro".into()),
            subscription_active_start: None,
            subscription_active_until: None,
            windows: vec![CodexQuotaWindow {
                id: "codex-five_hour-0".into(),
                category: CodexQuotaCategory::Codex,
                name: "Codex".into(),
                kind: CodexQuotaWindowKind::FiveHour,
                used_percent: Some(100.0 - remaining_percent),
                remaining_percent: Some(remaining_percent),
                limit_window_seconds: Some(5.0 * 60.0 * 60.0),
                reset_at: Some(reset_at as f64),
                allowed: Some(true),
                limit_reached: false,
            }],
            rate_limit_reset_credits: CodexRateLimitResetCredits::default(),
            fetched_at: NOW_MS as f64,
        }
    }

    #[test]
    fn first_quota_below_time_sample_creates_an_entry_alert() {
        let reset_at = NOW_MS + 150 * 60 * 1_000;
        let evaluation = evaluate_codex_usage(None, &subscription(40.0, reset_at), NOW_MS);
        assert_eq!(
            evaluation.state.windows[0].remaining_time_percent,
            Some(50.0)
        );
        assert!(evaluation.state.windows[0].quota_below_time);
        assert_eq!(evaluation.alerts.len(), 1);
        assert_eq!(evaluation.alerts[0].kind, UsageAlertKind::QuotaBelowTime);
        assert!(
            evaluation
                .notification()
                .unwrap()
                .body
                .contains("额度剩余 40.0%")
        );
    }

    #[test]
    fn next_sample_alerts_only_when_consumption_exceeds_the_sustainable_interval() {
        let reset_at = NOW_MS + 150 * 60 * 1_000;
        let mut first = evaluate_codex_usage(None, &subscription(40.0, reset_at), NOW_MS);
        first.mark_entry_alerts_delivered();

        let fast = evaluate_codex_usage(
            Some(&first.state),
            &subscription(38.0, reset_at),
            NOW_MS + FIVE_MINUTES_MS,
        );
        assert_eq!(fast.alerts.len(), 1);
        assert_eq!(fast.alerts[0].kind, UsageAlertKind::FastConsumption);
        assert_eq!(fast.alerts[0].consumed_percent, Some(2.0));
        assert!((fast.alerts[0].sustainable_percent.unwrap() - 4.0 / 3.0).abs() < 1e-9);

        let steady = evaluate_codex_usage(
            Some(&first.state),
            &subscription(39.0, reset_at),
            NOW_MS + FIVE_MINUTES_MS,
        );
        assert!(steady.alerts.is_empty());
    }

    #[test]
    fn failed_entry_delivery_is_retried_and_new_reset_cycles_do_not_use_old_consumption() {
        let reset_at = NOW_MS + 150 * 60 * 1_000;
        let first = evaluate_codex_usage(None, &subscription(40.0, reset_at), NOW_MS);
        let retry = evaluate_codex_usage(
            Some(&first.state),
            &subscription(39.0, reset_at),
            NOW_MS + FIVE_MINUTES_MS,
        );
        assert_eq!(retry.alerts[0].kind, UsageAlertKind::QuotaBelowTime);

        let next_reset = reset_at + 5 * 60 * 60 * 1_000;
        let reset = evaluate_codex_usage(
            Some(&first.state),
            &subscription(100.0, next_reset),
            NOW_MS + FIVE_MINUTES_MS,
        );
        assert!(reset.alerts.is_empty());
    }

    #[test]
    fn stored_state_validation_rejects_inconsistent_alert_flags() {
        let value = json!({
            "version": 1,
            "sampledAt": NOW_MS,
            "planType": "pro",
            "windows": [{
                "id": "codex-five_hour-0",
                "category": "codex",
                "name": "Codex",
                "kind": "five_hour",
                "usedPercent": 10.0,
                "remainingPercent": 90.0,
                "limitWindowSeconds": 18000.0,
                "resetAt": NOW_MS + 1,
                "remainingTimeMs": 1,
                "remainingTimePercent": 0.1,
                "quotaBelowTime": false,
                "entryAlertSent": true
            }]
        });
        assert!(validate_codex_usage_monitor_state(value).is_err());
    }
}
