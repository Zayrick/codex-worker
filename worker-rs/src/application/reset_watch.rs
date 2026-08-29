use time::UtcOffset;

use crate::upstream::codex_resets::CodexResetStatus;

use super::PushNotification;

const RESET_WATCH_WINDOW_MS: i64 = 5 * 60 * 1_000;

pub fn reset_watch_notification(
    status: &CodexResetStatus,
    now_ms: i64,
) -> Option<PushNotification> {
    let watch = status.active_watch.as_ref()?;
    let age_ms = now_ms.checked_sub(watch.observed_at_ms)?;
    if !(0..RESET_WATCH_WINDOW_MS).contains(&age_ms) {
        return None;
    }

    let expires_at = watch
        .expires_at
        .to_offset(UtcOffset::from_hms(8, 0, 0).expect("UTC+8 is a valid offset"));
    let title = format!(
        "Codex将有{}%可能性将在{:02}月{:02}日 {:02}:{:02}重置",
        watch.reset_chance_percent,
        u8::from(expires_at.month()),
        expires_at.day(),
        expires_at.hour(),
        expires_at.minute(),
    );

    Some(PushNotification {
        title,
        body: watch.text.clone(),
        url: Some(watch.source_url.clone()),
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use time::{OffsetDateTime, format_description::well_known::Rfc3339};

    use crate::upstream::codex_resets::parse_codex_reset_status;

    use super::*;

    fn timestamp_ms(value: &str) -> i64 {
        let timestamp = OffsetDateTime::parse(value, &Rfc3339).unwrap();
        i64::try_from(timestamp.unix_timestamp_nanos() / 1_000_000).unwrap()
    }

    fn status(observed_at: &str) -> CodexResetStatus {
        let body = json!({
            "data": {
                "active_watch": {
                    "reset_chance_percent": 70,
                    "observed_at": observed_at,
                    "expires_at": "2026-08-30T07:00:00.000Z",
                    "text": "第一行\n\n第二行",
                    "source": { "url": "https://x.com/thsottiaux/status/123" },
                }
            }
        });
        parse_codex_reset_status(body.to_string().as_bytes()).unwrap()
    }

    #[test]
    fn notifies_for_the_latest_five_minutes_and_formats_the_message() {
        let now_ms = timestamp_ms("2026-08-29T04:10:00.000Z");
        let notification =
            reset_watch_notification(&status("2026-08-29T04:05:00.001Z"), now_ms).unwrap();

        assert_eq!(
            notification.title,
            "Codex将有70%可能性将在08月30日 15:00重置"
        );
        assert_eq!(notification.body, "第一行\n\n第二行");
        assert_eq!(
            notification.url.as_deref(),
            Some("https://x.com/thsottiaux/status/123")
        );
        assert!(reset_watch_notification(&status("2026-08-29T04:05:00.000Z"), now_ms).is_none());
    }
}
