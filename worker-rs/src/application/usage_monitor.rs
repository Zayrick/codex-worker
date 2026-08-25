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
const GRACE_USAGE_EQUIVALENT_SECONDS: f64 = 12.0 * 60.0 * 60.0;

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
    ConsumptionTooFast,
    ConsumptionRecovered,
    QuotaReset,
}

#[derive(Debug, Clone, PartialEq)]
pub struct UsageAlert {
    pub kind: UsageAlertKind,
    pub window_label: String,
    pub remaining_percent: Option<f64>,
    pub remaining_time_percent: Option<f64>,
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
            title: "Codex 额度提醒".into(),
            body,
        })
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
        });
        if matches!(
            (
                prior.and_then(|prior| prior.remaining_percent),
                current.remaining_percent
            ),
            (Some(previous), Some(current)) if current > previous
        ) {
            alerts.push(alert(current, UsageAlertKind::QuotaReset));
        }
        let Some(prior) = prior else {
            current.entry_alert_sent =
                current.quota_below_time && !is_within_initial_usage_allowance(current);
            continue;
        };
        if current.quota_below_time {
            if prior.quota_below_time && prior.entry_alert_sent {
                current.entry_alert_sent = true;
            } else if !is_within_initial_usage_allowance(current) {
                alerts.push(alert(current, UsageAlertKind::ConsumptionTooFast));
                current.entry_alert_sent = true;
            }
        }
        if let (Some(QuotaTimeRelation::Below), Some(QuotaTimeRelation::Above)) =
            (quota_time_relation(prior), quota_time_relation(current))
        {
            alerts.push(alert(current, UsageAlertKind::ConsumptionRecovered));
        }
    }

    CodexUsageMonitorEvaluation { state, alerts }
}

pub fn validate_codex_usage_monitor_state(value: Value) -> AppResult<CodexUsageMonitorState> {
    let state: CodexUsageMonitorState =
        serde_json::from_value(value).map_err(|_| invalid_stored_usage_state())?;
    if state.version != STATE_VERSION || !valid_state_header(&state) {
        return Err(invalid_stored_usage_state());
    }
    let mut ids = HashSet::new();
    for window in &state.windows {
        if !valid_window(window, &mut ids) {
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
    let remaining_time_ms = reset_at.map(|reset_at| reset_at.saturating_sub(now_ms).max(0));
    let remaining_time_percent = remaining_time_ms
        .zip(limit_window_seconds.and_then(seconds_to_ms))
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

fn alert(window: &MonitoredQuotaWindow, kind: UsageAlertKind) -> UsageAlert {
    UsageAlert {
        kind,
        window_label: window_label(window),
        remaining_percent: window.remaining_percent,
        remaining_time_percent: window.remaining_time_percent,
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum QuotaTimeRelation {
    Above,
    Below,
}

fn quota_time_relation(window: &MonitoredQuotaWindow) -> Option<QuotaTimeRelation> {
    match (window.remaining_percent, window.remaining_time_percent) {
        (Some(quota), Some(time)) if quota > time => Some(QuotaTimeRelation::Above),
        (Some(quota), Some(time)) if quota < time => Some(QuotaTimeRelation::Below),
        _ => None,
    }
}

fn is_within_initial_usage_allowance(window: &MonitoredQuotaWindow) -> bool {
    let Some(window_seconds) = window.limit_window_seconds else {
        return false;
    };
    if window_seconds <= GRACE_USAGE_EQUIVALENT_SECONDS {
        return false;
    }
    let Some(used_percent) = window.used_percent else {
        return false;
    };
    let allowance_percent = GRACE_USAGE_EQUIVALENT_SECONDS / window_seconds * 100.0;
    used_percent <= allowance_percent
}

fn valid_state_header(state: &CodexUsageMonitorState) -> bool {
    state.sampled_at > 0
        && state.windows.len() <= MAX_WINDOWS
        && state
            .plan_type
            .as_deref()
            .is_none_or(|value| !value.is_empty() && value.chars().count() <= MAX_PLAN_TYPE_CHARS)
}

fn valid_window<'a>(window: &'a MonitoredQuotaWindow, ids: &mut HashSet<&'a str>) -> bool {
    !window.id.is_empty()
        && window.id.chars().count() <= MAX_ID_CHARS
        && ids.insert(window.id.as_str())
        && !window.name.is_empty()
        && window.name.chars().count() <= MAX_NAME_CHARS
        && valid_percent(window.used_percent)
        && valid_percent(window.remaining_percent)
        && valid_positive(window.limit_window_seconds)
        && window.reset_at.is_none_or(|value| value > 0)
        && window.remaining_time_ms.is_none_or(|value| value >= 0)
        && valid_percent(window.remaining_time_percent)
        && window.quota_below_time
            == (window.category == CodexQuotaCategory::Codex
                && matches!(
                    (window.remaining_percent, window.remaining_time_percent),
                    (Some(quota), Some(time)) if quota < time
                ))
        && (!window.entry_alert_sent || window.quota_below_time)
}

fn normalized_percent(value: Option<f64>) -> Option<f64> {
    value
        .filter(|value| value.is_finite())
        .map(|value| value.clamp(0.0, 100.0))
}

fn timestamp_ms(value: f64) -> Option<i64> {
    (value.is_finite() && value > 0.0 && value <= i64::MAX as f64).then_some(value as i64)
}

fn seconds_to_ms(value: f64) -> Option<i64> {
    let milliseconds = value * 1_000.0;
    (milliseconds.is_finite() && milliseconds > 0.0 && milliseconds <= i64::MAX as f64)
        .then_some(milliseconds as i64)
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
    let remaining = alert
        .remaining_percent
        .map(|value| format!("{value:.1}%"))
        .unwrap_or_else(|| "未知".into());
    let remaining_time = alert
        .remaining_time_percent
        .map(|value| format!("{value:.1}%"))
        .unwrap_or_else(|| "未知".into());
    match alert.kind {
        UsageAlertKind::ConsumptionTooFast => format!(
            "{}：剩余额度 {remaining}，低于剩余时间 {remaining_time}，当前消耗进度偏快。",
            alert.window_label,
        ),
        UsageAlertKind::ConsumptionRecovered => format!(
            "{}：剩余额度 {remaining}，已高于剩余时间 {remaining_time}，消耗已恢复到平均水平。",
            alert.window_label,
        ),
        UsageAlertKind::QuotaReset => format!(
            "{}：检测到剩余额度增加，额度已重置，当前剩余 {remaining}。",
            alert.window_label
        ),
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

    fn subscription(
        remaining_percent: f64,
        remaining_time_percent: f64,
        window_seconds: f64,
        sampled_at: i64,
    ) -> CodexSubscriptionInfo {
        let reset_after_ms = (window_seconds * remaining_time_percent / 100.0 * 1_000.0) as i64;
        CodexSubscriptionInfo {
            plan_type: Some("pro".into()),
            subscription_active_start: None,
            subscription_active_until: None,
            windows: vec![CodexQuotaWindow {
                id: "codex-weekly-0".into(),
                category: CodexQuotaCategory::Codex,
                name: "Codex".into(),
                kind: CodexQuotaWindowKind::Weekly,
                used_percent: Some(100.0 - remaining_percent),
                remaining_percent: Some(remaining_percent),
                limit_window_seconds: Some(window_seconds),
                reset_at: Some((sampled_at + reset_after_ms) as f64),
                allowed: Some(true),
                limit_reached: false,
            }],
            rate_limit_reset_credits: CodexRateLimitResetCredits::default(),
            fetched_at: sampled_at as f64,
        }
    }

    #[test]
    fn crossing_below_time_alerts_once() {
        let weekly = 7.0 * 24.0 * 60.0 * 60.0;
        let first = evaluate_codex_usage(None, &subscription(8.0, 7.0, weekly, NOW_MS), NOW_MS);
        let crossed = evaluate_codex_usage(
            Some(&first.state),
            &subscription(6.0, 7.0, weekly, NOW_MS + FIVE_MINUTES_MS),
            NOW_MS + FIVE_MINUTES_MS,
        );
        assert_eq!(crossed.alerts[0].kind, UsageAlertKind::ConsumptionTooFast);
        assert!(
            crossed
                .notification()
                .unwrap()
                .body
                .contains("消耗进度偏快")
        );
        let still_below = evaluate_codex_usage(
            Some(&crossed.state),
            &subscription(5.0, 6.0, weekly, NOW_MS + 2 * FIVE_MINUTES_MS),
            NOW_MS + 2 * FIVE_MINUTES_MS,
        );
        assert!(still_below.alerts.is_empty());
    }

    #[test]
    fn crossing_back_above_time_reports_recovery_once() {
        let five_hours = 5.0 * 60.0 * 60.0;
        let below =
            evaluate_codex_usage(None, &subscription(40.0, 50.0, five_hours, NOW_MS), NOW_MS);
        assert!(below.alerts.is_empty());
        let recovered = evaluate_codex_usage(
            Some(&below.state),
            &subscription(46.0, 45.0, five_hours, NOW_MS + FIVE_MINUTES_MS),
            NOW_MS + FIVE_MINUTES_MS,
        );
        assert_eq!(
            recovered
                .alerts
                .iter()
                .map(|alert| alert.kind)
                .collect::<Vec<_>>(),
            vec![
                UsageAlertKind::QuotaReset,
                UsageAlertKind::ConsumptionRecovered
            ]
        );
        assert!(
            recovered
                .notification()
                .unwrap()
                .body
                .contains("恢复到平均水平")
        );
        let next = evaluate_codex_usage(
            Some(&recovered.state),
            &subscription(44.0, 43.0, five_hours, NOW_MS + 2 * FIVE_MINUTES_MS),
            NOW_MS + 2 * FIVE_MINUTES_MS,
        );
        assert!(next.alerts.is_empty());
    }

    #[test]
    fn any_increase_in_remaining_quota_reports_a_reset() {
        let five_hours = 5.0 * 60.0 * 60.0;
        let previous =
            evaluate_codex_usage(None, &subscription(40.0, 50.0, five_hours, NOW_MS), NOW_MS);
        let reset = evaluate_codex_usage(
            Some(&previous.state),
            &subscription(40.1, 49.0, five_hours, NOW_MS + FIVE_MINUTES_MS),
            NOW_MS + FIVE_MINUTES_MS,
        );
        assert_eq!(reset.alerts.len(), 1);
        assert_eq!(reset.alerts[0].kind, UsageAlertKind::QuotaReset);
    }

    #[test]
    fn weekly_warning_uses_the_first_twelve_hours_quota_share_as_an_allowance() {
        let weekly = 7.0 * 24.0 * 60.0 * 60.0;
        let above = evaluate_codex_usage(None, &subscription(100.0, 99.0, weekly, NOW_MS), NOW_MS);
        let within_allowance = evaluate_codex_usage(
            Some(&above.state),
            &subscription(94.0, 95.0, weekly, NOW_MS + FIVE_MINUTES_MS),
            NOW_MS + FIVE_MINUTES_MS,
        );
        assert!(within_allowance.alerts.is_empty());

        let allowance_percent = GRACE_USAGE_EQUIVALENT_SECONDS / weekly * 100.0;
        let at_allowance = evaluate_codex_usage(
            Some(&within_allowance.state),
            &subscription(
                100.0 - allowance_percent,
                94.0,
                weekly,
                NOW_MS + 2 * FIVE_MINUTES_MS,
            ),
            NOW_MS + 2 * FIVE_MINUTES_MS,
        );
        assert!(at_allowance.alerts.is_empty());

        let beyond_allowance = evaluate_codex_usage(
            Some(&at_allowance.state),
            &subscription(92.8, 99.0, weekly, NOW_MS + 3 * FIVE_MINUTES_MS),
            NOW_MS + 3 * FIVE_MINUTES_MS,
        );
        assert_eq!(beyond_allowance.alerts.len(), 1);
        assert_eq!(
            beyond_allowance.alerts[0].kind,
            UsageAlertKind::ConsumptionTooFast
        );
        assert!(beyond_allowance.state.windows[0].entry_alert_sent);

        let still_below = evaluate_codex_usage(
            Some(&beyond_allowance.state),
            &subscription(92.7, 98.0, weekly, NOW_MS + 4 * FIVE_MINUTES_MS),
            NOW_MS + 4 * FIVE_MINUTES_MS,
        );
        assert!(still_below.alerts.is_empty());
    }

    #[test]
    fn accepts_stored_state_with_time_percentages() {
        let stored = json!({
            "version": 1,
            "sampledAt": NOW_MS,
            "planType": "pro",
            "windows": [{
                "id": "codex-weekly-0",
                "category": "codex",
                "name": "Codex",
                "kind": "weekly",
                "usedPercent": 60.0,
                "remainingPercent": 40.0,
                "limitWindowSeconds": 604800.0,
                "resetAt": NOW_MS + 1,
                "remainingTimeMs": 1,
                "remainingTimePercent": 50.0,
                "quotaBelowTime": true,
                "entryAlertSent": true
            }]
        });
        let state = validate_codex_usage_monitor_state(stored).unwrap();
        assert_eq!(state.version, STATE_VERSION);
        assert_eq!(state.windows[0].remaining_time_percent, Some(50.0));
        assert!(state.windows[0].quota_below_time);
    }

    #[test]
    fn stored_state_validation_rejects_an_inconsistent_relation() {
        let value = json!({
            "version": 1,
            "sampledAt": NOW_MS,
            "planType": "pro",
            "windows": [{
                "id": "codex-weekly-0",
                "category": "codex",
                "name": "Codex",
                "kind": "weekly",
                "usedPercent": 94.0,
                "remainingPercent": 6.0,
                "remainingTimePercent": 7.0,
                "remainingTimeMs": 42336000,
                "limitWindowSeconds": 604800.0,
                "resetAt": NOW_MS + 1,
                "quotaBelowTime": false,
                "entryAlertSent": false
            }]
        });
        assert!(validate_codex_usage_monitor_state(value).is_err());
    }
}
