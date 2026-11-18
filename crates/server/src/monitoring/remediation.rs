//! Auto-remediation: opening an alert whose check has `remediation` runs the script as a Phase 5
//! job (trigger `policy`) on the device, up to `max_attempts` per alert.

use serde_json::{Value, json};

use super::alerts;
use super::policy::Remediation;
use crate::automation::params::{self, SecretRule};
use crate::state::AppState;

pub const CREATED_BY: &str = "Monitoring";

fn attempts_of(remediation: Option<&str>) -> i64 {
    remediation
        .and_then(|r| serde_json::from_str::<Value>(r).ok())
        .and_then(|v| v.get("attempts").and_then(Value::as_i64))
        .unwrap_or(0)
}

/// Starts a remediation run for an alert (no-op once `max_attempts` is reached).
pub async fn start(
    state: &AppState,
    alert_id: &str,
    device_id: &str,
    spec: &Remediation,
) -> anyhow::Result<()> {
    let Some(alert) = alerts::load(&state.db, alert_id).await? else {
        return Ok(());
    };
    let attempts = attempts_of(alert.remediation.as_deref());
    if attempts >= spec.max_attempts.clamp(1, 10) {
        return Ok(());
    }
    let settings = crate::automation::settings::load(state).await?;
    let runnable = crate::automation::scripts::runnable_version(state, &spec.script_id, &settings)
        .await
        .map_err(|e| anyhow::anyhow!("{}", e.message))?;
    let values = params::validate_values(
        &runnable.parameters,
        &spec.parameters,
        SecretRule::FromVariables,
    )
    .map_err(|e| anyhow::anyhow!("{e}"))?;
    let parameters: serde_json::Map<String, Value> = values
        .into_iter()
        .map(|(k, v)| (k, json!(v.value)))
        .collect();
    let place: Option<(String, String, String)> = sqlx::query_as(
        "SELECT s.client_id, d.site_id, d.hostname FROM devices d JOIN sites s ON s.id = d.site_id WHERE d.id = ?",
    )
    .bind(device_id)
    .fetch_optional(&state.db)
    .await?;
    let Some((client_id, site_id, hostname)) = place else {
        return Ok(());
    };
    let job_id = rustrmm_common::new_id();
    let now = rustrmm_common::now();
    let name: String = format!("Remediation: {} on {hostname}", runnable.script.name)
        .chars()
        .take(120)
        .collect();
    sqlx::query("INSERT INTO jobs (id, name, script_id, script_version, content_sha256, parameters, target_type, target_ids, schedule,
                 next_run_at, status, offline_wait_minutes, concurrency, timeout_secs, client_id, site_id, created_by_name, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, 'devices', ?, ?, NULL, 'scheduled', 60, 1, ?, ?, ?, ?, ?, ?)")
        .bind(&job_id)
        .bind(&name)
        .bind(&runnable.script.id)
        .bind(runnable.version)
        .bind(&runnable.content_sha256)
        .bind(Value::Object(parameters).to_string())
        .bind(serde_json::to_string(&[device_id])?)
        .bind(json!({ "type": "now" }).to_string())
        .bind(runnable.script.timeout_secs.clamp(10, 86_400))
        .bind(&client_id)
        .bind(&site_id)
        .bind(CREATED_BY)
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await?;
    let record = json!({ "status": "running", "job_id": job_id, "attempts": attempts + 1 });
    sqlx::query("UPDATE alerts SET remediation = ?, updated_at = ? WHERE id = ?")
        .bind(record.to_string())
        .bind(now)
        .bind(alert_id)
        .execute(&state.db)
        .await?;
    alerts::add_event(
        &state.db,
        alert_id,
        "remediation_started",
        None,
        &format!("Running {} (attempt {})", runnable.script.name, attempts + 1),
        json!({ "job_id": job_id, "script_id": runnable.script.id, "script_version": runnable.version, "attempt": attempts + 1 }),
    )
    .await?;
    let run = crate::automation::jobs::start_run(state, &job_id, "policy", None, None).await;
    if let Err(e) = run {
        finish(state, &job_id, "failed", &format!("{e:#}")).await?;
    }
    Ok(())
}

/// Records the outcome of a remediation job on its alert.
async fn finish(state: &AppState, job_id: &str, status: &str, detail: &str) -> anyhow::Result<()> {
    let alerts_for_job: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT id, remediation FROM alerts WHERE json_extract(remediation, '$.job_id') = ?
           AND json_extract(remediation, '$.status') = 'running'",
    )
    .bind(job_id)
    .fetch_all(&state.db)
    .await?;
    for (alert_id, remediation) in alerts_for_job {
        let mut record: Value = remediation
            .as_deref()
            .and_then(|r| serde_json::from_str(r).ok())
            .unwrap_or_else(|| json!({}));
        let outcome = if status == "succeeded" {
            "succeeded"
        } else {
            "failed"
        };
        record["status"] = json!(outcome);
        sqlx::query("UPDATE alerts SET remediation = ?, updated_at = ? WHERE id = ?")
            .bind(record.to_string())
            .bind(rustrmm_common::now())
            .bind(&alert_id)
            .execute(&state.db)
            .await?;
        alerts::add_event(
            &state.db,
            &alert_id,
            "remediation_finished",
            None,
            &format!(
                "Remediation {outcome}{}",
                if detail.is_empty() {
                    String::new()
                } else {
                    format!(": {detail}")
                }
            ),
            json!({ "job_id": job_id, "status": status }),
        )
        .await?;
        alerts::publish(state, &alert_id, false).await;
    }
    Ok(())
}

/// A job result reached a final status (called from the Phase 5 result handler).
pub async fn on_job_result(state: &AppState, job_id: &str, status: &str) -> anyhow::Result<()> {
    if matches!(status, "pending" | "waiting_offline" | "running") {
        return Ok(());
    }
    finish(state, job_id, status, "").await
}

/// Catches remediation results that ended without an agent answer (offline, skipped,
/// timed out on the server).
pub async fn sweep(state: &AppState) -> anyhow::Result<()> {
    let running: Vec<String> = sqlx::query_scalar(
        "SELECT json_extract(remediation, '$.job_id') FROM alerts WHERE json_extract(remediation, '$.status') = 'running'",
    )
    .fetch_all(&state.db)
    .await?;
    for job_id in running {
        let statuses: Vec<(String, Option<String>)> =
            sqlx::query_as("SELECT status, error FROM job_results WHERE job_id = ?")
                .bind(&job_id)
                .fetch_all(&state.db)
                .await?;
        let active_run: Option<String> = sqlx::query_scalar(
            "SELECT id FROM job_runs WHERE job_id = ? AND status = 'running' LIMIT 1",
        )
        .bind(&job_id)
        .fetch_optional(&state.db)
        .await?;
        match statuses.first() {
            Some((status, error))
                if !matches!(status.as_str(), "pending" | "waiting_offline" | "running") =>
            {
                finish(state, &job_id, status, error.as_deref().unwrap_or_default()).await?;
            }
            None if active_run.is_none() => {
                finish(state, &job_id, "failed", "the job did not run").await?;
            }
            _ => {}
        }
    }
    Ok(())
}
