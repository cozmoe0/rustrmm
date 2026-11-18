//! Metrics storage: a single batching writer, periodic rollups, retention and offline detection.

use std::time::Duration;

use rustrmm_proto::messages::MetricSample;
use serde_json::json;
use tokio::sync::mpsc;

use crate::db::Db;
use crate::state::AppState;

const RAW_RETENTION_DAYS: i64 = 7;
const QUARTER_RETENTION_DAYS: i64 = 90;
const HOURLY_RETENTION_DAYS: i64 = 730;

/// Handle used by connections to submit samples without touching the database themselves.
pub struct Telemetry {
    tx: mpsc::Sender<(String, MetricSample)>,
}

impl Telemetry {
    /// Creates the handle and the receiving end for [`spawn_writer`].
    pub fn new() -> (Self, mpsc::Receiver<(String, MetricSample)>) {
        let (tx, rx) = mpsc::channel(8192);
        (Self { tx }, rx)
    }

    pub fn record(&self, device_id: &str, sample: MetricSample) {
        if self.tx.try_send((device_id.to_string(), sample)).is_err() {
            tracing::warn!("metrics queue full; dropping sample");
        }
    }
}

/// Batches samples into one transaction every couple of seconds.
pub fn spawn_writer(db: Db, mut rx: mpsc::Receiver<(String, MetricSample)>) {
    tokio::spawn(async move {
        let mut batch: Vec<(String, MetricSample)> = Vec::with_capacity(512);
        loop {
            let first = rx.recv().await;
            let Some(first) = first else { break };
            batch.push(first);
            let deadline = tokio::time::sleep(Duration::from_secs(2));
            tokio::pin!(deadline);
            loop {
                tokio::select! {
                    item = rx.recv() => match item {
                        Some(item) => { batch.push(item); if batch.len() >= 500 { break; } }
                        None => break,
                    },
                    _ = &mut deadline => break,
                }
            }
            if let Err(e) = write_batch(&db, &batch).await {
                tracing::error!(error = %format!("{e:#}"), rows = batch.len(), "failed to store metrics");
            }
            batch.clear();
        }
    });
}

async fn write_batch(db: &Db, batch: &[(String, MetricSample)]) -> anyhow::Result<()> {
    let mut tx = db.begin().await?;
    for (device_id, s) in batch {
        sqlx::query(
            "INSERT OR REPLACE INTO device_metrics (device_id, resolution, ts, cpu, mem, disk, net_rx, net_tx, disk_read, disk_write, samples)
             VALUES (?, 'raw', ?, ?, ?, ?, ?, ?, ?, ?, 1)",
        )
        .bind(device_id)
        .bind(s.ts)
        .bind(f64::from(s.cpu))
        .bind(f64::from(s.mem))
        .bind(f64::from(s.disk))
        .bind(s.net_rx_bps)
        .bind(s.net_tx_bps)
        .bind(s.disk_read_bps)
        .bind(s.disk_write_bps)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Every 5 minutes: roll raw samples into 15-minute and hourly buckets and apply retention.
pub fn spawn_rollups(db: Db) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(300));
        loop {
            interval.tick().await;
            if let Err(e) = rollup(&db).await {
                tracing::warn!(error = %format!("{e:#}"), "metrics rollup failed");
            }
        }
    });
}

pub async fn rollup(db: &Db) -> anyhow::Result<()> {
    let now = chrono::Utc::now().timestamp();
    for (resolution, bucket, lookback) in [("15m", 900i64, 3 * 3600i64), ("1h", 3600, 6 * 3600)] {
        let from = (now - lookback) / bucket * bucket;
        sqlx::query(
            "INSERT OR REPLACE INTO device_metrics (device_id, resolution, ts, cpu, mem, disk, net_rx, net_tx, disk_read, disk_write, samples)
             SELECT device_id, ?, (ts / ?) * ?, AVG(cpu), AVG(mem), AVG(disk), AVG(net_rx), AVG(net_tx), AVG(disk_read), AVG(disk_write), COUNT(*)
             FROM device_metrics WHERE resolution = 'raw' AND ts >= ?
             GROUP BY device_id, ts / ?",
        )
        .bind(resolution)
        .bind(bucket)
        .bind(bucket)
        .bind(from)
        .bind(bucket)
        .execute(db)
        .await?;
    }
    for (resolution, days) in [
        ("raw", RAW_RETENTION_DAYS),
        ("15m", QUARTER_RETENTION_DAYS),
        ("1h", HOURLY_RETENTION_DAYS),
    ] {
        let cutoff = now - days * 86_400;
        sqlx::query("DELETE FROM device_metrics WHERE resolution = ? AND ts < ?")
            .bind(resolution)
            .bind(cutoff)
            .execute(db)
            .await?;
    }
    let cutoff = rustrmm_common::now() - chrono::Duration::days(180);
    sqlx::query("DELETE FROM device_timeline WHERE at < ?")
        .bind(cutoff)
        .execute(db)
        .await?;
    Ok(())
}

/// Marks devices offline when their connection silently vanished (half-open TCP).
pub fn spawn_offline_sweeper(state: AppState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        loop {
            interval.tick().await;
            let stale = rustrmm_common::now() - chrono::Duration::seconds(150);
            let rows: Result<Vec<(String, String)>, _> = sqlx::query_as(
                "SELECT d.id, s.client_id FROM devices d JOIN sites s ON s.id = d.site_id
                 WHERE d.online = 1 AND (d.last_seen_at IS NULL OR d.last_seen_at < ?)",
            )
            .bind(stale)
            .fetch_all(&state.db)
            .await;
            let Ok(rows) = rows else { continue };
            for (device_id, client_id) in rows {
                if state.agents.is_online(&device_id) {
                    continue;
                }
                let _ = sqlx::query("UPDATE devices SET online = 0, offline_reason = 'connection_lost' WHERE id = ?")
                    .bind(&device_id)
                    .execute(&state.db)
                    .await;
                state.events.publish(
                    "devices.changed",
                    Some(client_id.clone()),
                    json!({ "id": device_id, "online": false }),
                );
                state
                    .events
                    .publish("fleet.summary", Some(client_id), serde_json::Value::Null);
            }
        }
    });
}
