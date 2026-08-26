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
#[serde(rename_all = "camelCase")]
pub struct CodexUsageMonitorState {
    pub version: u8,
    pub sampled_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_type: Option<String>,
    pub windows: Vec<MonitoredQuotaWindow>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
    pub entry_alert_sent: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UsageAlertKind {
    ConsumptionTooFast,
    ConsumptionRecovered,
    QuotaReset,
}

#[derive(Debug, Clone, PartialEq)]
struct UsageAlert {
    kind: UsageAlertKind,
    window_kind: CodexQuotaWindowKind,
    remaining_percent: Option<f64>,
    remaining_time_percent: Option<f64>,
    previous_remaining_percent: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageNotification {
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CodexUsageMonitorEvaluation {
    pub state: CodexUsageMonitorState,
    alerts: Vec<UsageAlert>,
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
            .map(snapshot)
            .collect(),
    };
    let mut alerts = Vec::new();

    for current in &mut state.windows {
        if current.category != CodexQuotaCategory::Codex {
            continue;
        }
        let current_relation = quota_time_relation(current, now_ms);
        let prior = previous.and_then(|state| {
            state
                .windows
                .iter()
                .find(|candidate| candidate.id == current.id)
                .map(|window| (window, state.sampled_at))
        });
        if current.kind != CodexQuotaWindowKind::FiveHour
            && let (Some(previous_remaining), Some(current_remaining)) = (
                prior.and_then(|(prior, _)| prior.remaining_percent),
                current.remaining_percent,
            )
            && current_remaining > previous_remaining
        {
            alerts.push(reset_alert(current, previous_remaining, now_ms));
        }
        let Some((prior, prior_sampled_at)) = prior else {
            current.entry_alert_sent = current_relation == Some(QuotaTimeRelation::Below)
                && !is_within_initial_usage_allowance(current);
            continue;
        };
        let prior_relation = quota_time_relation(prior, prior_sampled_at);
        if current_relation == Some(QuotaTimeRelation::Below) {
            if prior_relation == Some(QuotaTimeRelation::Below) && prior.entry_alert_sent {
                current.entry_alert_sent = true;
            } else if !is_within_initial_usage_allowance(current) {
                alerts.push(alert(current, UsageAlertKind::ConsumptionTooFast, now_ms));
                current.entry_alert_sent = true;
            }
        }
        if let (Some(QuotaTimeRelation::Below), Some(QuotaTimeRelation::Above)) =
            (prior_relation, current_relation)
        {
            alerts.push(alert(current, UsageAlertKind::ConsumptionRecovered, now_ms));
        }
    }

    CodexUsageMonitorEvaluation { state, alerts }
}

pub fn validate_codex_usage_monitor_state(value: Value) -> AppResult<CodexUsageMonitorState> {
    let state: CodexUsageMonitorState =
        serde_json::from_value(value).map_err(|_| invalid_stored_usage_state())?;
    if state.version != STATE_VERSION || state.sampled_at <= 0 || state.windows.len() > MAX_WINDOWS
    {
        return Err(invalid_stored_usage_state());
    }
    Ok(state)
}

fn snapshot(window: &CodexQuotaWindow) -> MonitoredQuotaWindow {
    let used_percent = normalized_percent(window.used_percent);
    let remaining_percent = normalized_percent(window.remaining_percent);
    let limit_window_seconds = window
        .limit_window_seconds
        .filter(|value| value.is_finite() && *value > 0.0);
    let reset_at = window.reset_at.and_then(timestamp_ms);
    MonitoredQuotaWindow {
        id: bounded_chars(&window.id, MAX_ID_CHARS),
        category: window.category,
        name: bounded_chars(&window.name, MAX_NAME_CHARS),
        kind: window.kind,
        used_percent,
        remaining_percent,
        limit_window_seconds,
        reset_at,
        entry_alert_sent: false,
    }
}

fn alert(window: &MonitoredQuotaWindow, kind: UsageAlertKind, sampled_at: i64) -> UsageAlert {
    UsageAlert {
        kind,
        window_kind: window.kind,
        remaining_percent: window.remaining_percent,
        remaining_time_percent: remaining_time_percent(window, sampled_at),
        previous_remaining_percent: None,
    }
}

fn reset_alert(
    window: &MonitoredQuotaWindow,
    previous_remaining_percent: f64,
    sampled_at: i64,
) -> UsageAlert {
    UsageAlert {
        kind: UsageAlertKind::QuotaReset,
        window_kind: window.kind,
        remaining_percent: window.remaining_percent,
        remaining_time_percent: remaining_time_percent(window, sampled_at),
        previous_remaining_percent: Some(previous_remaining_percent),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum QuotaTimeRelation {
    Above,
    Below,
}

fn quota_time_relation(
    window: &MonitoredQuotaWindow,
    sampled_at: i64,
) -> Option<QuotaTimeRelation> {
    match (
        window.remaining_percent,
        remaining_time_percent(window, sampled_at),
    ) {
        (Some(quota), Some(time)) if quota > time => Some(QuotaTimeRelation::Above),
        (Some(quota), Some(time)) if quota < time => Some(QuotaTimeRelation::Below),
        _ => None,
    }
}

fn remaining_time_percent(window: &MonitoredQuotaWindow, sampled_at: i64) -> Option<f64> {
    let remaining = window.reset_at?.saturating_sub(sampled_at).max(0);
    let duration = seconds_to_ms(window.limit_window_seconds?)?;
    Some((remaining as f64 / duration as f64 * 100.0).clamp(0.0, 100.0))
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

fn bounded_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn consumption_period(kind: CodexQuotaWindowKind) -> &'static str {
    match kind {
        CodexQuotaWindowKind::FiveHour => "当前 5 小时",
        CodexQuotaWindowKind::Weekly => "当前周",
        CodexQuotaWindowKind::Monthly => "当前月",
        CodexQuotaWindowKind::Primary => "当前主要额度",
        CodexQuotaWindowKind::Secondary => "当前次要额度",
    }
}

fn reset_period(kind: CodexQuotaWindowKind) -> &'static str {
    match kind {
        CodexQuotaWindowKind::FiveHour => "5 小时",
        CodexQuotaWindowKind::Weekly => "周",
        CodexQuotaWindowKind::Monthly => "月度",
        CodexQuotaWindowKind::Primary => "主要",
        CodexQuotaWindowKind::Secondary => "次要",
    }
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
    let previous_remaining = alert
        .previous_remaining_percent
        .map(|value| format!("{value:.1}%"))
        .unwrap_or_else(|| "未知".into());
    match alert.kind {
        UsageAlertKind::ConsumptionTooFast => format!(
            "剩余额度 {remaining}，低于剩余时间 {remaining_time}，{}消耗进度偏快。",
            consumption_period(alert.window_kind),
        ),
        UsageAlertKind::ConsumptionRecovered => format!(
            "剩余额度 {remaining}，已高于剩余时间 {remaining_time}，{}消耗已恢复到平均水平。",
            consumption_period(alert.window_kind),
        ),
        UsageAlertKind::QuotaReset => format!(
            "检测到{}额度已重置，重置前剩余额度为 {previous_remaining}。",
            reset_period(alert.window_kind),
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
        let kind = if window_seconds == 5.0 * 60.0 * 60.0 {
            CodexQuotaWindowKind::FiveHour
        } else {
            CodexQuotaWindowKind::Weekly
        };
        CodexSubscriptionInfo {
            plan_type: Some("pro".into()),
            subscription_active_start: None,
            subscription_active_until: None,
            windows: vec![CodexQuotaWindow {
                id: "codex-weekly-0".into(),
                category: CodexQuotaCategory::Codex,
                name: "Codex".into(),
                kind,
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
        assert_eq!(
            crossed.notification().unwrap().body,
            "剩余额度 6.0%，低于剩余时间 7.0%，当前周消耗进度偏快。"
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
            vec![UsageAlertKind::ConsumptionRecovered]
        );
        assert_eq!(
            recovered.notification().unwrap().body,
            "剩余额度 46.0%，已高于剩余时间 45.0%，当前 5 小时消耗已恢复到平均水平。"
        );
        let next = evaluate_codex_usage(
            Some(&recovered.state),
            &subscription(44.0, 43.0, five_hours, NOW_MS + 2 * FIVE_MINUTES_MS),
            NOW_MS + 2 * FIVE_MINUTES_MS,
        );
        assert!(next.alerts.is_empty());
    }

    #[test]
    fn weekly_increase_in_remaining_quota_reports_the_previous_value() {
        let weekly = 7.0 * 24.0 * 60.0 * 60.0;
        let previous =
            evaluate_codex_usage(None, &subscription(40.0, 50.0, weekly, NOW_MS), NOW_MS);
        let reset = evaluate_codex_usage(
            Some(&previous.state),
            &subscription(40.1, 49.0, weekly, NOW_MS + FIVE_MINUTES_MS),
            NOW_MS + FIVE_MINUTES_MS,
        );
        assert_eq!(reset.alerts.len(), 1);
        assert_eq!(reset.alerts[0].kind, UsageAlertKind::QuotaReset);
        assert_eq!(reset.alerts[0].previous_remaining_percent, Some(40.0));
        assert_eq!(
            reset.notification().unwrap().body,
            "检测到周额度已重置，重置前剩余额度为 40.0%。"
        );
    }

    #[test]
    fn five_hour_increase_does_not_report_a_reset() {
        let five_hours = 5.0 * 60.0 * 60.0;
        let previous =
            evaluate_codex_usage(None, &subscription(40.0, 50.0, five_hours, NOW_MS), NOW_MS);
        let reset = evaluate_codex_usage(
            Some(&previous.state),
            &subscription(40.1, 49.0, five_hours, NOW_MS + FIVE_MINUTES_MS),
            NOW_MS + FIVE_MINUTES_MS,
        );
        assert!(reset.alerts.is_empty());
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
}
