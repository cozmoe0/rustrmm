//! Patch compliance: a device is compliant when no effective-approved patch has been missing
//! for more than 7 days and no failed install is still missing.

use std::collections::{BTreeMap, HashMap};

use axum::Json;
use axum::extract::{Query, State};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::approvals;
use crate::auth::AuthCtx;
use crate::error::{ApiError, ApiResult};
use crate::rbac::perm;
use crate::state::AppState;

/// Grace period before an approved missing patch makes a device non-compliant.
pub const GRACE_DAYS: i64 = 7;

/// One patch on one device, as compliance sees it.
#[derive(Debug, Clone)]
pub struct PatchFact {
    pub severity: Option<String>,
    pub state: String,
    pub detected_at: DateTime<Utc>,
    /// When the patch became effective-approved for the device (`None` = not approved).
    pub effective_since: Option<DateTime<Utc>>,
}

pub fn is_missing(state: &str) -> bool {
    matches!(state, "missing" | "downloaded" | "installing" | "failed")
}

pub fn device_compliant(facts: &[PatchFact], now: DateTime<Utc>) -> bool {
    !facts.iter().any(|f| {
        f.state == "failed"
            || (is_missing(&f.state)
                && f.effective_since.is_some_and(|since| {
                    now - since.max(f.detected_at) > chrono::Duration::days(GRACE_DAYS)
                }))
    })
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct Totals {
    pub devices: i64,
    pub compliant: i64,
    pub non_compliant: i64,
    /// Missing (device, patch) pairs with severity Critical.
    pub missing_critical: i64,
    pub missing_important: i64,
    /// Devices waiting for a restart.
    pub pending_reboot: i64,
    /// Devices with at least one failed install that is still missing.
    pub failed: i64,
}

#[derive(Debug, Clone, Default)]
struct Row {
    label: String,
    devices: i64,
    compliant: i64,
    by_severity: BTreeMap<String, i64>,
    oldest_missing_days: Option<i64>,
}

/// One device's inputs.
pub struct DeviceFacts {
    pub group_key: String,
    pub group_label: String,
    pub pending_reboot: bool,
    pub patches: Vec<PatchFact>,
}

/// Aggregates totals and rows from per-device facts.
pub fn summarise(devices: &[DeviceFacts], now: DateTime<Utc>) -> (Totals, Vec<Value>) {
    let mut totals = Totals::default();
    let mut rows: BTreeMap<String, Row> = BTreeMap::new();
    for device in devices {
        let compliant = device_compliant(&device.patches, now);
        totals.devices += 1;
        if compliant {
            totals.compliant += 1;
        } else {
            totals.non_compliant += 1;
        }
        let pending_reboot =
            device.pending_reboot || device.patches.iter().any(|p| p.state == "pending_reboot");
        if pending_reboot {
            totals.pending_reboot += 1;
        }
        if device.patches.iter().any(|p| p.state == "failed") {
            totals.failed += 1;
        }
        let row = rows.entry(device.group_key.clone()).or_default();
        row.label = device.group_label.clone();
        row.devices += 1;
        if compliant {
            row.compliant += 1;
        }
        for patch in device.patches.iter().filter(|p| is_missing(&p.state)) {
            let severity = patch
                .severity
                .clone()
                .unwrap_or_else(|| "Unspecified".into());
            match severity.as_str() {
                "Critical" => totals.missing_critical += 1,
                "Important" => totals.missing_important += 1,
                _ => {}
            }
            *row.by_severity.entry(severity).or_default() += 1;
            let days = (now - patch.detected_at).num_days().max(0);
            row.oldest_missing_days = Some(row.oldest_missing_days.map_or(days, |d| d.max(days)));
        }
    }
    let mut out: Vec<(String, Row)> = rows.into_iter().collect();
    out.sort_by_key(|a| a.1.label.to_lowercase());
    let rows = out
        .into_iter()
        .map(|(key, row)| {
            let mut by_severity = serde_json::Map::new();
            for severity in ["Critical", "Important", "Moderate", "Low", "Unspecified"] {
                by_severity.insert(
                    severity.into(),
                    json!(row.by_severity.get(severity).copied().unwrap_or(0)),
                );
            }
            let pct = if row.devices == 0 {
                100.0
            } else {
                (row.compliant as f64 * 1000.0 / row.devices as f64).round() / 10.0
            };
            json!({ "key": key, "label": row.label, "devices": row.devices, "compliant": row.compliant,
                    "compliance_pct": pct, "missing_by_severity": by_severity,
                    "oldest_missing_days": row.oldest_missing_days })
        })
        .collect();
    (totals, rows)
}

#[derive(sqlx::FromRow)]
struct FactRow {
    device_id: String,
    patch_id: String,
    state: String,
    detected_at: DateTime<Utc>,
    severity: Option<String>,
    release_date: Option<String>,
    first_seen_at: DateTime<Utc>,
}

/// One scanned device with its patch facts.
#[derive(Debug, Clone)]
pub struct DeviceStatus {
    pub device_id: String,
    pub hostname: String,
    pub client_id: String,
    pub site_id: String,
    pub client_name: String,
    pub site_name: String,
    pub os_family: String,
    pub pending_reboot: bool,
    pub patches: Vec<PatchFact>,
}

impl DeviceStatus {
    pub fn compliant(&self, now: DateTime<Utc>) -> bool {
        device_compliant(&self.patches, now)
    }

    pub fn pending_reboot(&self) -> bool {
        self.pending_reboot || self.patches.iter().any(|p| p.state == "pending_reboot")
    }

    pub fn failed(&self) -> bool {
        self.patches.iter().any(|p| p.state == "failed")
    }

    /// Missing patches of a severity.
    pub fn missing(&self, severity: &str) -> usize {
        self.patches
            .iter()
            .filter(|p| is_missing(&p.state) && p.severity.as_deref() == Some(severity))
            .count()
    }

    pub fn missing_total(&self) -> usize {
        self.patches.iter().filter(|p| is_missing(&p.state)).count()
    }

    pub fn oldest_missing_days(&self, now: DateTime<Utc>) -> Option<i64> {
        self.patches
            .iter()
            .filter(|p| is_missing(&p.state))
            .map(|p| (now - p.detected_at).num_days().max(0))
            .max()
    }
}

/// Scanned, active devices accepted by `visible(client_id, site_id)` with their patch facts.
pub async fn load_status(
    state: &AppState,
    visible: &(dyn Fn(&str, &str) -> bool + Send + Sync),
) -> anyhow::Result<Vec<DeviceStatus>> {
    let scanned: Vec<(String, String, String, String, String, String, String, bool)> = sqlx::query_as(
        "SELECT d.id, COALESCE(d.display_name, d.hostname), s.client_id, d.site_id, c.name, s.name, d.os_family, st.pending_reboot
         FROM device_patch_status st JOIN devices d ON d.id = st.device_id JOIN sites s ON s.id = d.site_id
         JOIN clients c ON c.id = s.client_id WHERE d.status = 'active' AND st.scanned_at IS NOT NULL",
    )
    .fetch_all(&state.db)
    .await?;
    let visible: Vec<_> = scanned
        .into_iter()
        .filter(|(_, _, client, site, ..)| visible(client, site))
        .collect();
    let ids: Vec<String> = visible.iter().map(|r| r.0.clone()).collect();
    let configs: HashMap<String, super::DeviceCtx> = if ids.is_empty() {
        HashMap::new()
    } else {
        super::load_devices(state, Some(&ids))
            .await?
            .into_iter()
            .map(|d| (d.id.clone(), d))
            .collect()
    };
    let facts: Vec<FactRow> = sqlx::query_as(
        "SELECT dp.device_id, dp.patch_id, dp.state, dp.detected_at, c.severity, c.release_date, c.first_seen_at
         FROM device_patches dp JOIN patch_catalog c ON c.id = dp.patch_id JOIN devices d ON d.id = dp.device_id
         WHERE d.status = 'active'",
    )
    .fetch_all(&state.db)
    .await?;
    let approvals = approvals::load(&state.db, None).await?;
    let now = rustrmm_common::now();
    let mut by_device: HashMap<String, Vec<PatchFact>> = HashMap::new();
    for row in facts {
        let Some(device) = configs.get(&row.device_id) else {
            continue;
        };
        let effective_since = approvals.get(&row.patch_id).and_then(|a| {
            a.effective_since(
                &device.client_id,
                &device.config.ring,
                approvals::base_date(row.release_date.as_deref(), row.first_seen_at),
                now,
            )
        });
        by_device.entry(row.device_id).or_default().push(PatchFact {
            severity: row.severity,
            state: row.state,
            detected_at: row.detected_at,
            effective_since,
        });
    }
    Ok(visible
        .into_iter()
        .map(
            |(
                id,
                hostname,
                client_id,
                site_id,
                client_name,
                site_name,
                os_family,
                pending_reboot,
            )| {
                DeviceStatus {
                    patches: by_device.remove(&id).unwrap_or_default(),
                    device_id: id,
                    hostname,
                    client_id,
                    site_id,
                    client_name,
                    site_name,
                    os_family,
                    pending_reboot,
                }
            },
        )
        .collect())
}

#[derive(Deserialize, utoipa::IntoParams)]
pub struct ComplianceQuery {
    /// `client` (default), `site` or `os`.
    group_by: Option<String>,
    /// Only devices of this client.
    client_id: Option<String>,
    /// Only devices of this site.
    site_id: Option<String>,
}

/// Patch compliance
///
/// Totals and rows grouped by client, site or OS, optionally filtered by client and site.
#[utoipa::path(get, path = "/api/v1/patching/compliance", tag = "Patching", params(ComplianceQuery),
    responses((status = 200, description = "`{ totals, rows }`")))]
pub async fn get(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<ComplianceQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::PATCHES_VIEW)?;
    let group_by = q.group_by.as_deref().unwrap_or("client");
    if !matches!(group_by, "client" | "site" | "os") {
        return Err(ApiError::validation("group_by must be client, site or os"));
    }
    let client_filter = q.client_id.clone().filter(|c| !c.is_empty());
    let site_filter = q.site_id.clone().filter(|s| !s.is_empty());
    if let Some(c) = &client_filter {
        let exists: Option<String> = sqlx::query_scalar("SELECT id FROM clients WHERE id = ?")
            .bind(c)
            .fetch_optional(&state.db)
            .await?;
        if exists.is_none() || !ctx.scope.can_see_client(perm::PATCHES_VIEW, c) {
            return Err(ApiError::not_found("Client"));
        }
    }
    let scope = ctx.scope.clone();
    let visible = move |client: &str, site: &str| {
        scope.can_site(perm::PATCHES_VIEW, client, site)
            && client_filter.as_deref().is_none_or(|c| c == client)
            && site_filter.as_deref().is_none_or(|s| s == site)
    };
    let statuses = load_status(&state, &visible).await?;
    let now = rustrmm_common::now();
    let devices: Vec<DeviceFacts> = statuses
        .into_iter()
        .map(|d| {
            let (group_key, group_label) = match group_by {
                "site" => (d.site_id, format!("{} / {}", d.client_name, d.site_name)),
                "os" => {
                    let label = match d.os_family.as_str() {
                        "windows" => "Windows",
                        "linux" => "Linux",
                        "macos" => "macOS",
                        other => other,
                    }
                    .to_string();
                    (d.os_family, label)
                }
                _ => (d.client_id, d.client_name),
            };
            DeviceFacts {
                group_key,
                group_label,
                pending_reboot: d.pending_reboot,
                patches: d.patches,
            }
        })
        .collect();
    let (totals, rows) = summarise(&devices, now);
    Ok(Json(json!({ "totals": totals, "rows": rows })))
}

/// Patch state of each visible scanned device (for the device list filter).
pub async fn device_states(
    state: &AppState,
    ctx: &AuthCtx,
) -> anyhow::Result<HashMap<String, DeviceStatus>> {
    let scope = ctx.scope.clone();
    let visible = move |client: &str, site: &str| scope.can_site(perm::PATCHES_VIEW, client, site);
    Ok(load_status(state, &visible)
        .await?
        .into_iter()
        .map(|d| (d.device_id.clone(), d))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fact(
        state: &str,
        severity: Option<&str>,
        detected_days: i64,
        approved_days: Option<i64>,
    ) -> PatchFact {
        let now = rustrmm_common::now();
        PatchFact {
            severity: severity.map(str::to_string),
            state: state.into(),
            detected_at: now - chrono::Duration::days(detected_days),
            effective_since: approved_days.map(|d| now - chrono::Duration::days(d)),
        }
    }

    #[test]
    fn compliance_rules() {
        let now = rustrmm_common::now();
        // Approved 8 days ago, detected 10 days ago: missing beyond the grace period.
        assert!(!device_compliant(
            &[fact("missing", None, 10, Some(8))],
            now
        ));
        // Approved 3 days ago: still inside the grace period.
        assert!(device_compliant(&[fact("missing", None, 10, Some(3))], now));
        // Detected only yesterday although approved long ago.
        assert!(device_compliant(&[fact("missing", None, 1, Some(30))], now));
        // Not approved at all: never counts.
        assert!(device_compliant(
            &[fact("missing", Some("Critical"), 90, None)],
            now
        ));
        // Approval in the future (ring delay pending).
        assert!(device_compliant(
            &[fact("missing", None, 90, Some(-2))],
            now
        ));
        // A failed install that is still missing always counts.
        assert!(!device_compliant(&[fact("failed", None, 0, Some(0))], now));
        assert!(device_compliant(
            &[fact("installed", None, 90, Some(90))],
            now
        ));
    }

    #[test]
    fn summary_counts_devices_and_severities() {
        let now = rustrmm_common::now();
        let devices = vec![
            DeviceFacts {
                group_key: "c1".into(),
                group_label: "Acme".into(),
                pending_reboot: false,
                patches: vec![
                    fact("failed", Some("Critical"), 2, Some(2)),
                    fact("installed", Some("Important"), 20, Some(20)),
                ],
            },
            DeviceFacts {
                group_key: "c1".into(),
                group_label: "Acme".into(),
                pending_reboot: true,
                patches: vec![fact("missing", Some("Important"), 4, None)],
            },
            DeviceFacts {
                group_key: "c2".into(),
                group_label: "Beta".into(),
                pending_reboot: false,
                patches: vec![],
            },
        ];
        let (totals, rows) = summarise(&devices, now);
        assert_eq!(
            totals,
            Totals {
                devices: 3,
                compliant: 2,
                non_compliant: 1,
                missing_critical: 1,
                missing_important: 1,
                pending_reboot: 1,
                failed: 1,
            }
        );
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["label"], "Acme");
        assert_eq!(rows[0]["devices"], 2);
        assert_eq!(rows[0]["compliance_pct"], 50.0);
        assert_eq!(rows[0]["missing_by_severity"]["Critical"], 1);
        assert_eq!(rows[0]["missing_by_severity"]["Important"], 1);
        assert_eq!(rows[0]["oldest_missing_days"], 4);
        assert_eq!(rows[1]["compliance_pct"], 100.0);
        assert_eq!(rows[1]["oldest_missing_days"], Value::Null);
    }
}
