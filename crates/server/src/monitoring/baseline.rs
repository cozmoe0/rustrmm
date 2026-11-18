//! The "Baseline monitoring" policy, created once on first start and assigned globally.
//! Administrators may edit or delete it; it is never recreated after that.

use serde_json::{Value, json};

use crate::db::Db;

pub const POLICY_ID: &str = "builtin-baseline-monitoring";
pub const POLICY_NAME: &str = "Baseline monitoring";
const MARKER: &str = "monitoring_baseline_seeded";

async fn builtin_script(db: &Db, builtin_id: &str) -> anyhow::Result<Option<String>> {
    Ok(
        sqlx::query_scalar("SELECT id FROM scripts WHERE builtin_id = ? AND archived_at IS NULL")
            .bind(builtin_id)
            .fetch_optional(db)
            .await?,
    )
}

/// The baseline document. `cleanup_script` is the built-in "Clear temporary files" script used
/// to remediate low disk space on Windows.
pub fn document(cleanup_script: Option<&str>) -> Value {
    let mut windows_disk = json!({
        "id": "disk-space-windows", "type": "disk", "name": "Low disk space", "platforms": ["windows"],
        "interval_secs": 600, "config": { "volume": "*", "warn_free_pct": 10, "crit_free_pct": 5 }
    });
    if let Some(script) = cleanup_script {
        windows_disk["remediation"] =
            json!({ "script_id": script, "parameters": { "OlderThanDays": 7 }, "max_attempts": 1 });
    }
    json!({
        "monitoring": {
            "checks": [
                { "id": "cpu-high", "type": "cpu", "name": "High CPU usage", "interval_secs": 300,
                  "config": { "warn_pct": 90, "crit_pct": 98, "window_minutes": 15 } },
                { "id": "memory-high", "type": "memory", "name": "High memory usage", "interval_secs": 300,
                  "config": { "warn_pct": 90, "crit_pct": 97, "window_minutes": 15 } },
                windows_disk,
                { "id": "disk-space", "type": "disk", "name": "Low disk space", "platforms": ["linux", "macos"],
                  "interval_secs": 600, "config": { "volume": "*", "warn_free_pct": 10, "crit_free_pct": 5 } },
                { "id": "uptime", "type": "uptime", "name": "Long uptime", "interval_secs": 3600,
                  "config": { "warn_days": 30, "crit_days": 60 } },
                { "id": "pending-reboot", "type": "pending_reboot", "name": "Restart pending", "interval_secs": 3600,
                  "platforms": ["windows", "linux"], "severity": "warning", "config": { "warn_after_hours": 72 } },
                { "id": "antivirus", "type": "antivirus", "name": "Antivirus protection", "interval_secs": 900,
                  "config": { "max_signature_age_hours": 72 } },
                { "id": "firewall", "type": "firewall", "name": "Firewall enabled", "interval_secs": 900,
                  "platforms": ["windows"], "severity": "warning" },
                { "id": "windows-update", "type": "windows_update", "name": "Windows updates installed", "interval_secs": 21600,
                  "severity": "warning", "config": { "warn_days_since_install": 35, "alert_on_failures": true } }
            ],
            "server": { "offline_minutes": 15, "offline_severity": "critical", "agent_outdated": true,
                        "disk_forecast_days": 14, "security_changes": true }
        }
    })
}

/// Creates and globally assigns the baseline policy (idempotent).
pub async fn seed(db: &Db) -> anyhow::Result<()> {
    let seeded: Option<bool> = crate::db::get_setting(db, MARKER).await?;
    if seeded == Some(true) {
        return Ok(());
    }
    let exists: Option<String> = sqlx::query_scalar("SELECT id FROM policies WHERE id = ?")
        .bind(POLICY_ID)
        .fetch_optional(db)
        .await?;
    if exists.is_none() {
        let cleanup = builtin_script(db, "win-clear-temp-files").await?;
        let doc = document(cleanup.as_deref());
        crate::automation::policies::validate_structure(&doc).map_err(|e| {
            anyhow::anyhow!("baseline policy is invalid at {}: {}", e.path, e.message)
        })?;
        let now = rustrmm_common::now();
        let mut tx = db.begin().await?;
        sqlx::query("INSERT INTO policies (id, name, description, version, document, created_by, updated_by, updated_by_name, created_at, updated_at)
                     VALUES (?, ?, ?, 1, ?, NULL, NULL, 'RustRMM', ?, ?)")
            .bind(POLICY_ID)
            .bind(POLICY_NAME)
            .bind("Sensible checks for Windows, Linux and macOS: CPU, memory, disk, uptime, restarts, antivirus, firewall, Windows Update, offline devices, outdated agents, disk forecasts and security changes.")
            .bind(doc.to_string())
            .bind(now)
            .bind(now)
            .execute(&mut *tx)
            .await?;
        sqlx::query("INSERT INTO policy_assignments (id, policy_id, target_type, target_id, priority, created_by, created_at) VALUES (?, ?, 'global', NULL, -100, NULL, ?)")
            .bind(rustrmm_common::new_id())
            .bind(POLICY_ID)
            .bind(now)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        tracing::info!("created the Baseline monitoring policy");
    }
    crate::db::set_setting(db, MARKER, &true).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn baseline_is_a_valid_policy_for_every_platform() {
        let doc = document(Some("script-id"));
        crate::automation::policies::validate_structure(&doc).expect("valid");
        let origins = std::collections::BTreeMap::new();
        for os in ["windows", "linux", "macos"] {
            let checks = super::super::policy::effective_checks(&doc, &origins, os);
            assert!(checks.len() >= 4, "{os}: {}", checks.len());
            assert!(checks.iter().any(|c| c.kind == "disk"));
        }
        let windows = super::super::policy::effective_checks(&doc, &origins, "windows");
        assert!(windows.iter().any(|c| c.kind == "windows_update"));
        assert!(windows.iter().any(|c| c.remediation.is_some()));
        let linux = super::super::policy::effective_checks(&doc, &origins, "linux");
        assert!(
            linux
                .iter()
                .all(|c| c.kind != "antivirus" && c.kind != "windows_update")
        );
    }
}
