//! SNMP results from probes: counters become rates (with wraparound and reset handling),
//! percentages are computed against their base OID, samples are stored with 15-minute and hourly
//! rollups (same retention as device metrics), and thresholds raise or clear alerts.

use std::collections::HashMap;

use axum::Json;
use axum::extract::{Path, Query, State};
use rustrmm_proto::network::{SnmpResults, SnmpSample};
use serde::Deserialize;
use serde_json::{Value, json};

use super::alerting::{self, SnmpRaise};
use super::templates::{self, DESCR_KEY, LABEL_PREFIX, MAX_PREFIX, Metric, UPTIME_KEY};
use crate::agents::DeviceRecord;
use crate::auth::AuthCtx;
use crate::db::Db;
use crate::error::ApiResult;
use crate::rbac::perm;
use crate::state::AppState;

const RAW_RETENTION_DAYS: i64 = 7;
const QUARTER_RETENTION_DAYS: i64 = 90;
const HOURLY_RETENTION_DAYS: i64 = 730;
const MAX_SAMPLES: usize = 500;
const MAX_VALUES: usize = 5000;

/// Increase of a counter between two readings. A decrease is a wrap for 32-bit counters (and
/// for 64-bit counters close to their maximum); otherwise it is a reset (device restart or
/// cleared counters) and yields no rate.
pub fn counter_delta(old: u64, new: u64, kind: &str) -> Option<u64> {
    if new >= old {
        return Some(new - old);
    }
    match kind {
        "counter32" if old <= u64::from(u32::MAX) => Some(u64::from(u32::MAX) - old + new + 1),
        "counter64" if old > u64::MAX - (1u64 << 56) => {
            (u64::MAX - old).checked_add(new)?.checked_add(1)
        }
        _ => None,
    }
}

/// Per-second rate between two counter readings (`None` across a reset or a bad interval).
pub fn counter_rate(old: u64, old_at_ms: i64, new: u64, new_at_ms: i64, kind: &str) -> Option<f64> {
    let dt = (new_at_ms - old_at_ms) as f64 / 1000.0;
    if dt <= 0.0 {
        return None;
    }
    counter_delta(old, new, kind).map(|d| d as f64 / dt)
}

fn number(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|s| s.trim().parse().ok()))
}

fn text(value: &Value) -> String {
    match value {
        Value::String(s) => s.chars().filter(|c| !c.is_control()).take(500).collect(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

#[derive(sqlx::FromRow)]
struct Previous {
    raw: Option<String>,
    raw_at: Option<i64>,
}

#[derive(sqlx::FromRow)]
struct DeviceCtx {
    id: String,
    site_id: String,
    client_id: String,
    name: String,
    status: String,
    uptime_secs: Option<i64>,
    template_ids: String,
}

fn metric_title(device: &str, metric: &Metric, label: Option<&str>, value: f64) -> String {
    let what = if metric.label.is_empty() {
        metric.key.as_str()
    } else {
        metric.label.as_str()
    };
    let row = label.map(|l| format!(" ({l})")).unwrap_or_default();
    let shown = if value.fract() == 0.0 {
        format!("{value:.0}")
    } else {
        format!("{value:.1}")
    };
    let unit = if metric.unit == "%" {
        "%".to_string()
    } else if metric.unit.is_empty() {
        String::new()
    } else {
        format!(" {}", metric.unit)
    };
    format!("{device}: {what}{row} is {shown}{unit}")
}

/// Stores one value's latest state.
#[allow(clippy::too_many_arguments)]
async fn store_value(
    db: &Db,
    device_id: &str,
    key: &str,
    idx: &str,
    value: Option<f64>,
    text: Option<&str>,
    raw: Option<(u64, i64)>,
    state: Option<&str>,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO snmp_values (snmp_device_id, key, idx, value, text, raw, raw_at, state, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, 'ok'), ?)
         ON CONFLICT (snmp_device_id, key, idx) DO UPDATE SET
             value = COALESCE(excluded.value, snmp_values.value), text = COALESCE(excluded.text, snmp_values.text),
             raw = COALESCE(excluded.raw, snmp_values.raw), raw_at = COALESCE(excluded.raw_at, snmp_values.raw_at),
             state = COALESCE(?, snmp_values.state), updated_at = excluded.updated_at",
    )
    .bind(device_id)
    .bind(key)
    .bind(idx)
    .bind(value)
    .bind(text)
    .bind(raw.map(|(r, _)| r.to_string()))
    .bind(raw.map(|(_, at)| at))
    .bind(state)
    .bind(rustrmm_common::now())
    .bind(state)
    .execute(db)
    .await?;
    Ok(())
}

/// Processes one device's poll.
async fn ingest_sample(
    state: &AppState,
    device: &DeviceCtx,
    sample: &SnmpSample,
) -> anyhow::Result<()> {
    let ids: Vec<String> = serde_json::from_str(&device.template_ids).unwrap_or_default();
    let tpl = templates::load_many(&state.db, &ids).await?;
    let metrics: HashMap<String, Metric> = templates::merged_metrics(&tpl)
        .into_iter()
        .map(|m| (m.key.clone(), m))
        .collect();
    let now_ms = chrono::Utc::now().timestamp_millis();
    // Clamp the probe's clock to the last 7 days and now.
    let at_ms = sample.at.clamp(now_ms - 7 * 86_400_000, now_ms);
    let ts = at_ms / 1000;

    let mut labels: HashMap<(String, String), String> = HashMap::new();
    let mut maxes: HashMap<(String, String), f64> = HashMap::new();
    let mut uptime: Option<i64> = None;
    let mut descr: Option<String> = None;
    for v in sample.values.iter().take(MAX_VALUES) {
        let idx = v.index.clone().unwrap_or_default();
        if let Some(key) = v.key.strip_prefix(LABEL_PREFIX) {
            labels.insert((key.to_string(), idx), text(&v.value));
        } else if let Some(key) = v.key.strip_prefix(MAX_PREFIX) {
            if let Some(n) = number(&v.value) {
                maxes.insert((key.to_string(), idx), n);
            }
        } else if v.key == UPTIME_KEY {
            uptime = number(&v.value).map(|t| (t / 100.0) as i64);
        } else if v.key == DESCR_KEY {
            descr = Some(text(&v.value)).filter(|d| !d.is_empty());
        }
    }
    let reset = matches!((device.uptime_secs, uptime), (Some(old), Some(new)) if new < old);
    for ((key, idx), label) in &labels {
        store_value(
            &state.db,
            &device.id,
            &format!("{LABEL_PREFIX}{key}"),
            idx,
            None,
            Some(label),
            None,
            None,
        )
        .await?;
    }

    let mut tx_rows: Vec<(String, String, f64)> = Vec::new();
    let mut evaluations: Vec<(Metric, String, f64)> = Vec::new();
    for v in sample.values.iter().take(MAX_VALUES) {
        let Some(metric) = metrics.get(&v.key) else {
            continue;
        };
        let idx = v.index.clone().unwrap_or_default();
        match metric.kind.as_str() {
            "text" => {
                store_value(
                    &state.db,
                    &device.id,
                    &metric.key,
                    &idx,
                    None,
                    Some(&text(&v.value)),
                    None,
                    None,
                )
                .await?;
            }
            "counter" => {
                let Some(raw) = v
                    .value
                    .as_u64()
                    .or_else(|| number(&v.value).map(|n| n as u64))
                else {
                    continue;
                };
                let previous: Option<Previous> = sqlx::query_as(
                    "SELECT raw, raw_at FROM snmp_values WHERE snmp_device_id = ? AND key = ? AND idx = ?",
                )
                .bind(&device.id)
                .bind(&metric.key)
                .bind(&idx)
                .fetch_optional(&state.db)
                .await?;
                let kind = if v.kind.is_empty() {
                    "counter64"
                } else {
                    v.kind.as_str()
                };
                let rate = match previous
                    .as_ref()
                    .and_then(|p| Some((p.raw.as_deref()?.parse::<u64>().ok()?, p.raw_at?)))
                {
                    Some((old, old_at)) if !reset => counter_rate(old, old_at, raw, at_ms, kind),
                    _ => None,
                };
                store_value(
                    &state.db,
                    &device.id,
                    &metric.key,
                    &idx,
                    rate,
                    None,
                    Some((raw, at_ms)),
                    None,
                )
                .await?;
                if let Some(rate) = rate {
                    tx_rows.push((metric.key.clone(), idx.clone(), rate));
                    evaluations.push((metric.clone(), idx, rate));
                }
            }
            _ => {
                let Some(mut value) = number(&v.value) else {
                    continue;
                };
                if v.kind == "timeticks" {
                    value /= 100.0;
                }
                if metric.max_oid.is_some() {
                    // Printer-MIB uses -1/-2/-3 for "other", "unknown" and "some remaining".
                    let Some(max) = maxes.get(&(metric.key.clone(), idx.clone())).copied() else {
                        continue;
                    };
                    if value < 0.0 || max <= 0.0 {
                        continue;
                    }
                    value = (value / max * 100.0).min(100.0);
                }
                store_value(
                    &state.db,
                    &device.id,
                    &metric.key,
                    &idx,
                    Some(value),
                    None,
                    None,
                    None,
                )
                .await?;
                tx_rows.push((metric.key.clone(), idx.clone(), value));
                evaluations.push((metric.clone(), idx, value));
            }
        }
    }
    if !tx_rows.is_empty() {
        let mut tx = state.db.begin().await?;
        for (key, idx, value) in &tx_rows {
            sqlx::query(
                "INSERT OR REPLACE INTO snmp_metrics_raw (snmp_device_id, key, idx, ts, value) VALUES (?, ?, ?, ?, ?)",
            )
            .bind(&device.id)
            .bind(key)
            .bind(idx)
            .bind(ts)
            .bind(value)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
    }

    // Thresholds.
    for (metric, idx, value) in evaluations {
        let Some(thresholds) = &metric.thresholds else {
            continue;
        };
        let new_state = thresholds.evaluate(value);
        let previous: String = sqlx::query_scalar(
            "SELECT state FROM snmp_values WHERE snmp_device_id = ? AND key = ? AND idx = ?",
        )
        .bind(&device.id)
        .bind(&metric.key)
        .bind(&idx)
        .fetch_optional(&state.db)
        .await?
        .unwrap_or_else(|| "ok".into());
        store_value(
            &state.db,
            &device.id,
            &metric.key,
            &idx,
            None,
            None,
            None,
            Some(new_state),
        )
        .await?;
        let check_id = if idx.is_empty() {
            format!("snmp:{}", metric.key)
        } else {
            format!("snmp:{}:{idx}", metric.key)
        };
        let label = labels
            .get(&(metric.key.clone(), idx.clone()))
            .map(String::as_str)
            .filter(|l| !l.is_empty());
        if new_state == "ok" {
            if previous != "ok" {
                alerting::clear(
                    state,
                    &device.id,
                    &device.site_id,
                    &check_id,
                    &format!(
                        "{} is back within its thresholds",
                        metric_title(&device.name, &metric, label, value)
                    ),
                )
                .await?;
            }
            continue;
        }
        let title = metric_title(&device.name, &metric, label, value);
        alerting::raise(
            state,
            SnmpRaise {
                snmp_device_id: Some(device.id.clone()),
                client_id: device.client_id.clone(),
                site_id: device.site_id.clone(),
                check_id,
                check_type: "threshold".into(),
                severity: new_state.to_string(),
                message: format!(
                    "{title} ({} threshold {})",
                    new_state,
                    match (new_state, thresholds.warn, thresholds.crit) {
                        ("critical", _, Some(c)) => format!("{} {c}", thresholds.direction),
                        (_, Some(w), _) => format!("{} {w}", thresholds.direction),
                        _ => thresholds.direction.clone(),
                    }
                ),
                title,
                repeat: previous != new_state,
            },
        )
        .await?;
    }

    let alerting_now: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM snmp_values WHERE snmp_device_id = ? AND state <> 'ok' LIMIT 1",
    )
    .bind(&device.id)
    .fetch_optional(&state.db)
    .await?;
    let status = if alerting_now.is_some() {
        "alerting"
    } else {
        "ok"
    };
    sqlx::query(
        "UPDATE snmp_devices SET status = ?, last_poll_at = ?, uptime_secs = COALESCE(?, uptime_secs),
             sys_descr = COALESCE(?, sys_descr), last_error = NULL, updated_at = ? WHERE id = ?",
    )
    .bind(status)
    .bind(chrono::DateTime::<chrono::Utc>::from_timestamp_millis(at_ms).unwrap_or_else(rustrmm_common::now))
    .bind(uptime)
    .bind(descr.map(|d| d.chars().take(1000).collect::<String>()))
    .bind(rustrmm_common::now())
    .bind(&device.id)
    .execute(&state.db)
    .await?;
    if device.status == "unreachable" {
        alerting::clear(
            state,
            &device.id,
            &device.site_id,
            "snmp:unreachable",
            &format!("{} answers SNMP again", device.name),
        )
        .await?;
    }
    if device.status != status {
        state.events.publish(
            "snmp.device",
            Some(device.client_id.clone()),
            json!({ "id": device.id, "site_id": device.site_id, "status": status }),
        );
    }
    Ok(())
}

async fn device_in_site(
    state: &AppState,
    id: &str,
    site_id: &str,
) -> anyhow::Result<Option<DeviceCtx>> {
    Ok(sqlx::query_as(
        "SELECT sd.id, sd.site_id, s.client_id, sd.name, sd.status, sd.uptime_secs, sd.template_ids
         FROM snmp_devices sd JOIN sites s ON s.id = sd.site_id WHERE sd.id = ? AND sd.site_id = ?",
    )
    .bind(id)
    .bind(site_id)
    .fetch_optional(&state.db)
    .await?)
}

/// `snmp_results` from a probe. Results for devices outside the probe's site are ignored.
pub async fn on_results(
    state: &AppState,
    probe: &DeviceRecord,
    results: SnmpResults,
) -> anyhow::Result<()> {
    let Some(site) = super::probes::site_of(&state.db, &probe.id).await? else {
        tracing::debug!(device = %probe.id, "SNMP results from a device that is not a probe ignored");
        return Ok(());
    };
    for sample in results.samples.iter().take(MAX_SAMPLES) {
        let Some(device) = device_in_site(state, &sample.device_id, &site.site_id).await? else {
            continue;
        };
        if let Err(e) = ingest_sample(state, &device, sample).await {
            tracing::warn!(snmp_device = %device.id, error = %format!("{e:#}"), "storing SNMP results failed");
        }
    }
    for id in results.unreachable.iter().take(MAX_SAMPLES) {
        let Some(device) = device_in_site(state, id, &site.site_id).await? else {
            continue;
        };
        sqlx::query("UPDATE snmp_devices SET status = 'unreachable', last_poll_at = ?, last_error = ?, updated_at = ? WHERE id = ?")
            .bind(rustrmm_common::now())
            .bind("No SNMP response")
            .bind(rustrmm_common::now())
            .bind(&device.id)
            .execute(&state.db)
            .await?;
        alerting::raise(
            state,
            SnmpRaise {
                snmp_device_id: Some(device.id.clone()),
                client_id: device.client_id.clone(),
                site_id: device.site_id.clone(),
                check_id: "snmp:unreachable".into(),
                check_type: "unreachable".into(),
                severity: "critical".into(),
                title: format!("{} is not answering SNMP", device.name),
                message: format!(
                    "The probe {} got no SNMP response from {}",
                    probe.hostname, device.name
                ),
                repeat: device.status != "unreachable",
            },
        )
        .await?;
        if device.status != "unreachable" {
            state.events.publish(
                "snmp.device",
                Some(device.client_id.clone()),
                json!({ "id": device.id, "site_id": device.site_id, "status": "unreachable" }),
            );
        }
    }
    Ok(())
}

/// Rolls raw samples into 15-minute and hourly buckets and applies retention.
pub async fn rollup(db: &Db) -> anyhow::Result<()> {
    let now = chrono::Utc::now().timestamp();
    for (table, bucket, lookback) in [
        ("snmp_metrics_15m", 900i64, 3 * 3600i64),
        ("snmp_metrics_1h", 3600, 6 * 3600),
    ] {
        let from = (now - lookback) / bucket * bucket;
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "INSERT OR REPLACE INTO {table} (snmp_device_id, key, idx, ts, value, min, max, samples)
             SELECT snmp_device_id, key, idx, (ts / ?) * ?, AVG(value), MIN(value), MAX(value), COUNT(*)
             FROM snmp_metrics_raw WHERE ts >= ? GROUP BY snmp_device_id, key, idx, ts / ?"
        )))
        .bind(bucket)
        .bind(bucket)
        .bind(from)
        .bind(bucket)
        .execute(db)
        .await?;
    }
    for (table, days) in [
        ("snmp_metrics_raw", RAW_RETENTION_DAYS),
        ("snmp_metrics_15m", QUARTER_RETENTION_DAYS),
        ("snmp_metrics_1h", HOURLY_RETENTION_DAYS),
    ] {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "DELETE FROM {table} WHERE ts < ?"
        )))
        .bind(now - days * 86_400)
        .execute(db)
        .await?;
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct MetricsQuery {
    range: Option<String>,
}

#[derive(sqlx::FromRow)]
struct CurrentRow {
    key: String,
    idx: String,
    value: Option<f64>,
    text: Option<String>,
    state: String,
}

/// `GET /api/v1/network/snmp/devices/{id}/metrics?range=1h|24h|7d|30d`
#[utoipa::path(get, path = "/api/v1/network/snmp/devices/{id}/metrics", tag = "Network", summary = "Device metrics", params(("id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn device_metrics(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Query(q): Query<MetricsQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::NETWORK_VIEW)?;
    let device = super::devices::load(&state, &ctx, &id, perm::NETWORK_VIEW).await?;
    let (range, table, seconds) = match q.range.as_deref().unwrap_or("24h") {
        "1h" => ("1h", "snmp_metrics_raw", 3600),
        "7d" => ("7d", "snmp_metrics_15m", 7 * 86_400),
        "30d" => ("30d", "snmp_metrics_1h", 30 * 86_400),
        _ => ("24h", "snmp_metrics_raw", 86_400),
    };
    let from = chrono::Utc::now().timestamp() - seconds;
    let rows: Vec<(String, String, i64, f64)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT key, idx, ts, value FROM {table} WHERE snmp_device_id = ? AND ts >= ? ORDER BY key, idx, ts"
    )))
    .bind(&id)
    .bind(from)
    .fetch_all(&state.db)
    .await?;
    let templates = templates::load_many(&state.db, &device.template_ids()).await?;
    let metrics: HashMap<String, Metric> = templates::merged_metrics(&templates)
        .into_iter()
        .map(|m| (m.key.clone(), m))
        .collect();
    let current: Vec<CurrentRow> = sqlx::query_as(
        "SELECT key, idx, value, text, state FROM snmp_values WHERE snmp_device_id = ? ORDER BY key, idx",
    )
    .bind(&id)
    .fetch_all(&state.db)
    .await?;
    let labels: HashMap<(String, String), String> = current
        .iter()
        .filter_map(|c| {
            let key = c.key.strip_prefix(LABEL_PREFIX)?;
            Some(((key.to_string(), c.idx.clone()), c.text.clone()?))
        })
        .collect();
    let label_for = |key: &str, idx: &str| -> String {
        let base = metrics
            .get(key)
            .map(|m| {
                if m.label.is_empty() {
                    key.to_string()
                } else {
                    m.label.clone()
                }
            })
            .unwrap_or_else(|| key.to_string());
        match labels.get(&(key.to_string(), idx.to_string())) {
            Some(l) if !l.is_empty() => format!("{base} ({l})"),
            _ if !idx.is_empty() => format!("{base} ({idx})"),
            _ => base,
        }
    };
    let mut series: Vec<Value> = Vec::new();
    let mut current_key: Option<(String, String)> = None;
    let mut points: Vec<Value> = Vec::new();
    let flush = |key: &(String, String), points: Vec<Value>, series: &mut Vec<Value>| {
        series.push(json!({
            "key": key.0, "index": if key.1.is_empty() { None } else { Some(&key.1) },
            "label": label_for(&key.0, &key.1),
            "unit": metrics.get(&key.0).map(|m| m.unit.clone()).unwrap_or_default(),
            "points": points,
        }));
    };
    for (key, idx, ts, value) in rows {
        let k = (key, idx);
        if current_key.as_ref() != Some(&k) {
            if let Some(prev) = current_key.take() {
                flush(&prev, std::mem::take(&mut points), &mut series);
            }
            current_key = Some(k);
        }
        points.push(json!([ts, value]));
    }
    if let Some(prev) = current_key {
        flush(&prev, points, &mut series);
    }
    let values: Vec<Value> = current
        .iter()
        .filter(|c| !c.key.starts_with(LABEL_PREFIX) && metrics.contains_key(&c.key))
        .map(|c| {
            json!({
                "key": c.key, "index": if c.idx.is_empty() { None } else { Some(&c.idx) },
                "label": label_for(&c.key, &c.idx),
                "unit": metrics.get(&c.key).map(|m| m.unit.clone()).unwrap_or_default(),
                "value": c.value, "text": c.text, "state": c.state,
            })
        })
        .collect();
    Ok(Json(
        json!({ "range": range, "series": series, "current": values }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counters_become_rates_with_wraparound() {
        // 1 MB in 10 s.
        assert_eq!(
            counter_rate(1_000, 0, 1_001_000, 10_000, "counter64"),
            Some(100_000.0)
        );
        // 32-bit wrap: 100 below the top, 900 after it = 1000 octets.
        let old = u64::from(u32::MAX) - 99;
        assert_eq!(counter_delta(old, 900, "counter32"), Some(1000));
        assert_eq!(counter_rate(old, 0, 900, 1_000, "counter32"), Some(1000.0));
        // 64-bit wrap near the top.
        assert_eq!(counter_delta(u64::MAX - 9, 10, "counter64"), Some(20));
        // A 64-bit counter that drops from the middle of its range was reset: no rate.
        assert_eq!(counter_delta(5_000_000, 10, "counter64"), None);
        assert_eq!(counter_delta(5_000_000, 10, "gauge32"), None);
        // No time passed (or the clock went backwards): no rate.
        assert_eq!(counter_rate(1, 5_000, 2, 5_000, "counter64"), None);
        assert_eq!(counter_rate(1, 6_000, 2, 5_000, "counter64"), None);
        assert_eq!(counter_delta(7, 7, "counter32"), Some(0));
    }

    #[test]
    fn titles_read_well() {
        let metric = templates::builtins()
            .into_iter()
            .find(|(id, _, _)| *id == templates::PRINTER)
            .expect("printer")
            .2
            .remove(0);
        assert_eq!(
            metric_title("Front desk printer", &metric, Some("Black Toner"), 8.0),
            "Front desk printer: Supply level (Black Toner) is 8%"
        );
    }
}
