//! Server-side checks: devices offline too long, outdated agents, disk-fill forecasts and
//! security changes seen in inventory.

use std::collections::BTreeSet;

use rustrmm_proto::commands::version_cmp;
use serde_json::Value;

use super::alerts::{self, Raise};
use super::policy::{self, ServerConfig};
use crate::agents::DeviceRecord;
use crate::automation::policies::PolicyContext;
use crate::state::AppState;

fn server_raise(
    device_id: &str,
    check_id: &str,
    severity: &str,
    title: String,
    message: String,
) -> Raise {
    Raise {
        device_id: device_id.to_string(),
        source: "server",
        check_id: check_id.to_string(),
        check_type: check_id.split('.').next().unwrap_or(check_id).to_string(),
        severity: severity.to_string(),
        title,
        message,
        policy_id: None,
        remediation: None,
        repeat: false,
    }
}

fn human_minutes(minutes: i64) -> String {
    match minutes {
        m if m < 120 => format!("{m} minutes"),
        m if m < 48 * 60 => format!("{} hours", m / 60),
        m => format!("{} days", m / 1440),
    }
}

/// Minutes before the `device.offline` webhook event fires when the device's offline alert is
/// disabled (`offline_minutes = 0`).
pub const WEBHOOK_OFFLINE_FALLBACK_MINUTES: i64 = 15;

/// Sends the debounced `device.offline` webhook event once per offline period (cleared when the
/// device reconnects). Returns true when the event was published.
async fn notify_offline(state: &AppState, device_id: &str, minutes: i64) -> anyhow::Result<bool> {
    let now = rustrmm_common::now();
    let claimed = sqlx::query(
        "UPDATE devices SET offline_notified_at = ? WHERE id = ? AND online = 0 AND offline_notified_at IS NULL",
    )
    .bind(now)
    .bind(device_id)
    .execute(&state.db)
    .await?
    .rows_affected();
    if claimed == 0 {
        return Ok(false);
    }
    let row: Option<(
        String,
        String,
        String,
        Option<chrono::DateTime<chrono::Utc>>,
        Option<String>,
    )> = sqlx::query_as(
        "SELECT d.hostname, s.client_id, d.site_id, d.last_seen_at, d.offline_reason
             FROM devices d JOIN sites s ON s.id = d.site_id WHERE d.id = ?",
    )
    .bind(device_id)
    .fetch_optional(&state.db)
    .await?;
    let Some((hostname, client_id, site_id, last_seen_at, reason)) = row else {
        return Ok(false);
    };
    state.events.publish(
        "device.offline",
        Some(client_id.clone()),
        serde_json::json!({
            "device_id": device_id, "hostname": hostname, "client_id": client_id, "site_id": site_id,
            "last_seen_at": last_seen_at,
            "reason": reason.unwrap_or_else(|| "connection_lost".into()),
            "offline_minutes": minutes,
        }),
    );
    Ok(true)
}

/// Offline check: devices silent for longer than `offline_minutes` raise `offline`; devices that
/// are back (or whose policy disables the check) resolve it. The `device.offline` webhook event
/// is debounced the same way: it fires once a device stayed offline for that threshold (15
/// minutes when the alert is disabled), so reconnect flaps and server restarts send nothing.
pub async fn check_offline(state: &AppState) -> anyhow::Result<()> {
    let candidates: Vec<String> = sqlx::query_scalar(
        "SELECT d.id FROM devices d WHERE d.status = 'active' AND d.last_seen_at IS NOT NULL
           AND (d.online = 0 OR EXISTS (SELECT 1 FROM alerts a WHERE a.device_id = d.id AND a.check_id = 'offline' AND a.status <> 'resolved'))",
    )
    .fetch_all(&state.db)
    .await?;
    let open_for_inactive: Vec<String> = sqlx::query_scalar(
        "SELECT a.device_id FROM alerts a JOIN devices d ON d.id = a.device_id
         WHERE a.check_id = 'offline' AND a.status <> 'resolved' AND d.status <> 'active'",
    )
    .fetch_all(&state.db)
    .await?;
    for device in open_for_inactive {
        alerts::clear(state, &device, "offline", "The device is no longer active").await?;
    }
    if candidates.is_empty() {
        return Ok(());
    }
    let settings = super::settings::load(state).await?;
    let ctx = PolicyContext::load(&state.db, Some(&candidates)).await?;
    for facts in &ctx.index.facts {
        let server = policy::device_monitoring(&ctx, facts).server;
        let minutes = server
            .offline_minutes
            .unwrap_or(settings.default_offline_minutes);
        let online = state.agents.is_online(&facts.id);
        let silent = facts.last_seen_minutes.unwrap_or(0.0);
        let notify_after = if minutes > 0 {
            minutes
        } else {
            WEBHOOK_OFFLINE_FALLBACK_MINUTES
        };
        if !online && silent >= notify_after as f64 {
            notify_offline(state, &facts.id, notify_after).await?;
        }
        if minutes <= 0 || online {
            let reason = if online {
                "The device is back online"
            } else {
                "The offline check is disabled"
            };
            alerts::clear(state, &facts.id, "offline", reason).await?;
            continue;
        }
        if silent >= minutes as f64 {
            alerts::raise(
                state,
                server_raise(
                    &facts.id,
                    "offline",
                    &server.offline_severity,
                    format!("{} is offline", facts.hostname),
                    format!(
                        "Not seen for {} (threshold {minutes} minutes)",
                        human_minutes(silent as i64)
                    ),
                ),
            )
            .await?;
        }
    }
    Ok(())
}

/// Agents two or more releases behind the newest imported release.
pub async fn check_outdated(state: &AppState, ctx: &PolicyContext) -> anyhow::Result<()> {
    let releases: Vec<String> = sqlx::query_scalar("SELECT version FROM agent_releases")
        .fetch_all(&state.db)
        .await?;
    let newest = releases.iter().max_by(|a, b| version_cmp(a, b)).cloned();
    for facts in &ctx.index.facts {
        let server: ServerConfig = policy::device_monitoring(ctx, facts).server;
        let behind = releases
            .iter()
            .filter(|r| version_cmp(r, &facts.agent_version) == std::cmp::Ordering::Greater)
            .count();
        match (
            &newest,
            server.agent_outdated && !facts.agent_version.is_empty() && behind >= 2,
        ) {
            (Some(newest), true) => {
                alerts::raise(
                    state,
                    server_raise(
                        &facts.id,
                        "agent_outdated",
                        "warning",
                        format!("Agent on {} is out of date", facts.hostname),
                        format!(
                            "Agent {} is {behind} releases behind {newest}",
                            facts.agent_version
                        ),
                    ),
                )
                .await?;
            }
            _ => {
                alerts::clear(
                    state,
                    &facts.id,
                    "agent_outdated",
                    "The agent is up to date",
                )
                .await?
            }
        }
    }
    Ok(())
}

/// Least-squares fit of disk usage (percent) over time. Returns the days until the fitted line
/// reaches 100 %, or `None` when usage is flat or falling or there is too little data (at least
/// 12 points spanning a day).
pub fn forecast_days_to_full(points: &[(i64, f64)]) -> Option<f64> {
    let points: Vec<(f64, f64)> = points
        .iter()
        .filter(|(_, v)| v.is_finite())
        .map(|(t, v)| (*t as f64, *v))
        .collect();
    if points.len() < 12 {
        return None;
    }
    let (first, last) = (points.first()?.0, points.last()?.0);
    if last - first < 86_400.0 {
        return None;
    }
    let n = points.len() as f64;
    let mean_t = points.iter().map(|p| p.0).sum::<f64>() / n;
    let mean_v = points.iter().map(|p| p.1).sum::<f64>() / n;
    let (mut num, mut den) = (0.0, 0.0);
    for (t, v) in &points {
        num += (t - mean_t) * (v - mean_v);
        den += (t - mean_t) * (t - mean_t);
    }
    if den <= 0.0 {
        return None;
    }
    let slope = num / den; // percent per second
    if slope <= 1e-9 {
        return None;
    }
    let now_value = mean_v + slope * (last - mean_t);
    if now_value >= 100.0 {
        return Some(0.0);
    }
    Some((100.0 - now_value) / (slope * 86_400.0))
}

/// Disk-fill forecast from seven days of 15-minute metrics.
pub async fn check_disk_forecast(state: &AppState, ctx: &PolicyContext) -> anyhow::Result<()> {
    let since = chrono::Utc::now().timestamp() - 7 * 86_400;
    for facts in &ctx.index.facts {
        let server = policy::device_monitoring(ctx, facts).server;
        if server.disk_forecast_days <= 0 {
            alerts::clear(
                state,
                &facts.id,
                "disk_forecast",
                "The disk forecast is disabled",
            )
            .await?;
            continue;
        }
        let points: Vec<(i64, f64)> = sqlx::query_as(
            "SELECT ts, disk FROM device_metrics WHERE device_id = ? AND resolution = '15m' AND ts >= ? AND disk IS NOT NULL ORDER BY ts",
        )
        .bind(&facts.id)
        .bind(since)
        .fetch_all(&state.db)
        .await?;
        match forecast_days_to_full(&points) {
            Some(days) if days <= server.disk_forecast_days as f64 => {
                let used = points.last().map(|p| p.1).unwrap_or_default();
                alerts::raise(
                    state,
                    server_raise(
                        &facts.id,
                        "disk_forecast",
                        "warning",
                        format!("Disk on {} predicted to fill up", facts.hostname),
                        format!(
                            "At the current rate the fullest volume ({used:.0}% used) is full in about {} days",
                            days.ceil() as i64
                        ),
                    ),
                )
                .await?;
            }
            _ => {
                alerts::clear(
                    state,
                    &facts.id,
                    "disk_forecast",
                    "The disk is no longer predicted to fill up",
                )
                .await?
            }
        }
    }
    Ok(())
}

fn admins(data: &Value) -> BTreeSet<String> {
    data.get("local_admins")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// `Some(true)` when protection is on, `Some(false)` when off, `None` when unknown.
fn antivirus_on(data: &Value) -> Option<bool> {
    if let Some(rtp) = data
        .pointer("/defender/real_time_protection")
        .and_then(Value::as_bool)
        && data
            .pointer("/defender/antivirus_enabled")
            .and_then(Value::as_bool)
            != Some(false)
    {
        let others = data
            .get("antivirus")
            .and_then(Value::as_array)
            .is_some_and(|a| {
                a.iter()
                    .any(|p| p.get("enabled").and_then(Value::as_bool) == Some(true))
            });
        return Some(rtp || others);
    }
    let list = data.get("antivirus").and_then(Value::as_array)?;
    if list.is_empty() {
        return None;
    }
    Some(
        list.iter()
            .any(|p| p.get("enabled").and_then(Value::as_bool) == Some(true)),
    )
}

fn firewall_on(data: &Value) -> Option<bool> {
    data.pointer("/firewall/enabled").and_then(Value::as_bool)
}

fn encryption_on(data: &Value) -> Option<bool> {
    data.pointer("/encryption/system_volume_encrypted")
        .and_then(Value::as_bool)
}

/// Security inventory changed: new local administrators, antivirus, firewall or disk encryption
/// turned off (the last three resolve when switched back on).
pub async fn on_security(
    state: &AppState,
    device: &DeviceRecord,
    current: &Value,
    previous: Option<&Value>,
) -> anyhow::Result<()> {
    let Some(monitoring) = policy::cached_device(state, &device.id).await? else {
        return Ok(());
    };
    if !monitoring.server.security_changes {
        return Ok(());
    }
    let host = &device.hostname;
    if let Some(prev) = previous {
        let added: Vec<String> = admins(current).difference(&admins(prev)).cloned().collect();
        if !added.is_empty() {
            alerts::raise(
                state,
                Raise {
                    repeat: true,
                    ..server_raise(
                        &device.id,
                        "security.local_admin_added",
                        "warning",
                        format!("New local administrator on {host}"),
                        format!("Added to the local administrators: {}", added.join(", ")),
                    )
                },
            )
            .await?;
        }
    }
    let encryption_label = if current
        .pointer("/encryption/method")
        .and_then(Value::as_str)
        == Some("bitlocker")
    {
        "BitLocker"
    } else {
        "Disk encryption"
    };
    let toggles: [(&str, &str, Option<bool>, Option<bool>, String); 3] = [
        (
            "security.antivirus_off",
            "critical",
            antivirus_on(current),
            previous.and_then(antivirus_on),
            format!("Antivirus protection turned off on {host}"),
        ),
        (
            "security.firewall_off",
            "warning",
            firewall_on(current),
            previous.and_then(firewall_on),
            format!("Firewall turned off on {host}"),
        ),
        (
            "security.encryption_off",
            "warning",
            encryption_on(current),
            previous.and_then(encryption_on),
            format!("{encryption_label} turned off on {host}"),
        ),
    ];
    for (check_id, severity, now_on, was_on, title) in toggles {
        match (now_on, was_on) {
            (Some(false), Some(true)) => {
                alerts::raise(
                    state,
                    server_raise(
                        &device.id,
                        check_id,
                        severity,
                        title.clone(),
                        "Reported by the latest security inventory".into(),
                    ),
                )
                .await?;
            }
            (Some(true), _) => {
                alerts::clear(state, &device.id, check_id, "Switched back on").await?
            }
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn disk_forecast_regression() {
        let day = 86_400;
        // 1 % per day from 80 %, sampled every 6 hours for 7 days.
        let rising: Vec<(i64, f64)> = (0..=28)
            .map(|i| (i * day / 4, 80.0 + i as f64 * 0.25))
            .collect();
        let days = forecast_days_to_full(&rising).expect("rising");
        assert!(
            (days - 13.0).abs() < 0.01,
            "87 % after 7 days leaves 13 days, got {days}"
        );
        // Flat and falling usage never fills.
        let flat: Vec<(i64, f64)> = (0..=28).map(|i| (i * day / 4, 60.0)).collect();
        assert_eq!(forecast_days_to_full(&flat), None);
        let falling: Vec<(i64, f64)> = (0..=28).map(|i| (i * day / 4, 90.0 - i as f64)).collect();
        assert_eq!(forecast_days_to_full(&falling), None);
        // Too little data, or under a day of history.
        assert_eq!(forecast_days_to_full(&rising[..5]), None);
        let short: Vec<(i64, f64)> = (0..20).map(|i| (i * 60, 50.0 + i as f64)).collect();
        assert_eq!(forecast_days_to_full(&short), None);
        // Noisy but clearly rising data still forecasts.
        let noisy: Vec<(i64, f64)> = (0..=28)
            .map(|i| {
                (
                    i * day / 4,
                    70.0 + i as f64 * 0.5 + if i % 2 == 0 { 1.5 } else { -1.5 },
                )
            })
            .collect();
        let days = forecast_days_to_full(&noisy).expect("noisy");
        assert!(
            (6.0..10.0).contains(&days),
            "2 % per day from about 84 %: {days}"
        );
        // Already full.
        let full: Vec<(i64, f64)> = (0..=28)
            .map(|i| (i * day / 4, 99.0 + i as f64 * 0.1))
            .collect();
        assert_eq!(forecast_days_to_full(&full), Some(0.0));
    }

    #[test]
    fn security_facts() {
        let on = json!({ "antivirus": [{ "name": "Defender", "enabled": true }], "firewall": { "enabled": true },
                         "encryption": { "method": "bitlocker", "system_volume_encrypted": true },
                         "local_admins": ["PC\\Administrator"] });
        let off = json!({ "antivirus": [{ "name": "Defender", "enabled": false }], "firewall": { "enabled": false },
                          "encryption": { "system_volume_encrypted": false },
                          "local_admins": ["PC\\Administrator", "PC\\eve"] });
        assert_eq!(antivirus_on(&on), Some(true));
        assert_eq!(antivirus_on(&off), Some(false));
        assert_eq!(antivirus_on(&json!({})), None);
        let defender_off = json!({ "defender": { "real_time_protection": false, "antivirus_enabled": true }, "antivirus": [] });
        assert_eq!(antivirus_on(&defender_off), Some(false));
        assert_eq!(firewall_on(&off), Some(false));
        assert_eq!(encryption_on(&on), Some(true));
        let added: Vec<String> = admins(&off).difference(&admins(&on)).cloned().collect();
        assert_eq!(added, vec!["PC\\eve".to_string()]);
        assert_eq!(human_minutes(30), "30 minutes");
        assert_eq!(human_minutes(180), "3 hours");
        assert_eq!(human_minutes(4320), "3 days");
    }
}
