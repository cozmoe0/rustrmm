//! Five-field cron schedules evaluated in an IANA time zone.

use chrono::{DateTime, Utc};
use croner::Cron;
use croner::parser::{CronParser, Seconds};

/// Parses a standard five-field expression (minute hour day month weekday).
pub fn parse(expr: &str) -> Result<Cron, String> {
    let expr = expr.trim();
    if expr.is_empty() || expr.len() > 120 {
        return Err("Cron expression must be 1–120 characters".into());
    }
    if expr.split_whitespace().count() != 5 {
        return Err("Cron expression needs five fields: minute hour day month weekday".into());
    }
    CronParser::builder()
        .seconds(Seconds::Disallowed)
        .build()
        .parse(expr)
        .map_err(|e| format!("Invalid cron expression: {e}"))
}

/// Parses an IANA time zone name (`Europe/London`, `UTC`).
pub fn timezone(name: &str) -> Result<chrono_tz::Tz, String> {
    name.trim()
        .parse::<chrono_tz::Tz>()
        .map_err(|_| format!("Unknown time zone {name}"))
}

/// Validates both parts of a schedule.
pub fn validate(expr: &str, tz: &str) -> Result<(), String> {
    parse(expr)?;
    timezone(tz)?;
    Ok(())
}

/// The first occurrence strictly after `after`, or `None` when the schedule never fires again.
pub fn next_after(expr: &str, tz: &str, after: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let cron = parse(expr).ok()?;
    let zone = timezone(tz).ok()?;
    let local = after.with_timezone(&zone);
    cron.find_next_occurrence(&local, false)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn utc(y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, m, d, h, min, 0)
            .single()
            .expect("valid time")
    }

    #[test]
    fn validates_expressions_and_zones() {
        assert!(validate("0 3 * * 1", "Europe/London").is_ok());
        assert!(validate("*/15 * * * *", "UTC").is_ok());
        assert!(validate("0 3 * * 1", "Mars/Olympus").is_err());
        assert!(validate("not a cron", "UTC").is_err());
        assert!(
            validate("0 0 3 * * 1", "UTC").is_err(),
            "seconds are not allowed"
        );
        assert!(validate("61 * * * *", "UTC").is_err());
    }

    #[test]
    fn next_run_in_utc_and_local_time() {
        // Monday 2026-11-16 is a Monday.
        let from = utc(2026, 11, 16, 2, 0);
        assert_eq!(
            next_after("0 3 * * 1", "UTC", from),
            Some(utc(2026, 11, 16, 3, 0))
        );
        // Strictly after: at exactly 03:00 the next run is a week later.
        assert_eq!(
            next_after("0 3 * * 1", "UTC", utc(2026, 11, 16, 3, 0)),
            Some(utc(2026, 11, 23, 3, 0))
        );
        // 03:00 in New York (UTC-5 in November) is 08:00 UTC.
        assert_eq!(
            next_after("0 3 * * *", "America/New_York", from),
            Some(utc(2026, 11, 16, 8, 0))
        );
        // Summer time: 03:00 in London during BST is 02:00 UTC.
        assert_eq!(
            next_after("0 3 * * *", "Europe/London", utc(2026, 7, 1, 0, 0)),
            Some(utc(2026, 7, 1, 2, 0))
        );
        assert_eq!(
            next_after("*/15 * * * *", "UTC", utc(2026, 1, 1, 10, 7)),
            Some(utc(2026, 1, 1, 10, 15))
        );
    }
}
