//! Inventory ingestion: stores sections, keeps device summary columns current, normalises
//! installed software, and turns meaningful changes into device-timeline events.

use std::collections::{BTreeMap, BTreeSet};

use rustrmm_proto::messages::{InventoryAck, InventorySection, sections};
use serde_json::{Value, json};

use super::DeviceRecord;
use super::health::{HealthInputs, evaluate};
use crate::state::AppState;

const MAX_SECTION_BYTES: usize = 8 * 1024 * 1024;
const MAX_TIMELINE_ITEMS: usize = 25;

pub async fn ingest(
    state: &AppState,
    device: &DeviceRecord,
    section: InventorySection,
) -> anyhow::Result<InventoryAck> {
    if !sections::ALL.contains(&section.section.as_str()) {
        anyhow::bail!("unknown inventory section '{}'", section.section);
    }
    let data = serde_json::to_string(&section.data)?;
    if data.len() > MAX_SECTION_BYTES {
        anyhow::bail!("inventory section too large");
    }
    let previous: Option<String> =
        sqlx::query_scalar("SELECT data FROM device_inventory WHERE device_id = ? AND section = ?")
            .bind(&device.id)
            .bind(&section.section)
            .fetch_optional(&state.db)
            .await?;
    let previous: Option<Value> = previous.and_then(|p| serde_json::from_str(&p).ok());
    let now = rustrmm_common::now();
    sqlx::query(
        "INSERT INTO device_inventory (device_id, section, data, hash, collected_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (device_id, section) DO UPDATE SET data = excluded.data, hash = excluded.hash, collected_at = excluded.collected_at",
    )
    .bind(&device.id)
    .bind(&section.section)
    .bind(&data)
    .bind(&section.hash)
    .bind(now)
    .execute(&state.db)
    .await?;

    match section.section.as_str() {
        sections::SYSTEM => apply_system(state, device, &section.data, previous.as_ref()).await?,
        sections::HARDWARE => {
            apply_hardware(state, device, &section.data, previous.as_ref()).await?
        }
        sections::SOFTWARE => {
            apply_software(state, device, &section.data, previous.as_ref()).await?
        }
        sections::USERS => apply_users(state, device, &section.data, previous.as_ref()).await?,
        sections::SECURITY => {
            if let Err(e) = crate::monitoring::server_checks::on_security(
                state,
                device,
                &section.data,
                previous.as_ref(),
            )
            .await
            {
                tracing::warn!(device = %device.id, error = %format!("{e:#}"), "security change check failed");
            }
        }
        _ => {}
    }
    if matches!(
        section.section.as_str(),
        sections::SECURITY | sections::SYSTEM
    ) {
        refresh_health(state, &device.id).await?;
    }
    state.events.publish(
        "device.inventory",
        Some(device.client_id.clone()),
        json!({ "device_id": device.id, "section": section.section }),
    );
    Ok(InventoryAck {
        section: section.section,
        hash: section.hash,
    })
}

fn s(v: &Value, ptr: &str) -> Option<String> {
    v.pointer(ptr)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|x| !x.is_empty())
        .map(|x| x.chars().take(200).collect())
}

async fn apply_system(
    state: &AppState,
    device: &DeviceRecord,
    data: &Value,
    previous: Option<&Value>,
) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE devices SET os_name = COALESCE(?, os_name), os_version = COALESCE(?, os_version), domain = COALESCE(?, domain),
                device_type = COALESCE(?, device_type), updated_at = ? WHERE id = ?",
    )
    .bind(s(data, "/os/name"))
    .bind(s(data, "/os/version"))
    .bind(s(data, "/domain"))
    .bind(s(data, "/device_type"))
    .bind(rustrmm_common::now())
    .bind(&device.id)
    .execute(&state.db)
    .await?;
    if let Some(prev) = previous {
        let (before, after) = (s(prev, "/os/version"), s(data, "/os/version"));
        if before.is_some() && after.is_some() && before != after {
            let summary = format!(
                "Operating system updated: {} → {}",
                before.as_deref().unwrap_or("?"),
                after.as_deref().unwrap_or("?")
            );
            super::timeline(
                &state.db,
                &device.id,
                "os.updated",
                "notice",
                &summary,
                json!({ "from": before, "to": after }),
            )
            .await?;
        }
        if prev.get("pending_reboot").and_then(Value::as_bool) != Some(true)
            && data.get("pending_reboot").and_then(Value::as_bool) == Some(true)
        {
            super::timeline(
                &state.db,
                &device.id,
                "system.reboot_pending",
                "notice",
                "A restart is pending",
                json!({ "reasons": data.get("pending_reboot_reasons") }),
            )
            .await?;
        }
    }
    Ok(())
}

async fn apply_hardware(
    state: &AppState,
    device: &DeviceRecord,
    data: &Value,
    previous: Option<&Value>,
) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE devices SET manufacturer = COALESCE(?, manufacturer), model = COALESCE(?, model), serial = COALESCE(?, serial),
                updated_at = ? WHERE id = ?",
    )
    .bind(s(data, "/manufacturer"))
    .bind(s(data, "/model"))
    .bind(s(data, "/serial"))
    .bind(rustrmm_common::now())
    .bind(&device.id)
    .execute(&state.db)
    .await?;
    if let Some(prev) = previous {
        let mut changes = Vec::new();
        let mem = |v: &Value| v.pointer("/memory/total_bytes").and_then(Value::as_u64);
        if let (Some(a), Some(b)) = (mem(prev), mem(data))
            && a.abs_diff(b) > 256 * 1024 * 1024
        {
            changes.push(format!(
                "memory {} → {} GB",
                a / 1_073_741_824,
                b / 1_073_741_824
            ));
        }
        let (a, b) = (s(prev, "/cpu/model"), s(data, "/cpu/model"));
        if a.is_some() && b.is_some() && a != b {
            changes.push(format!(
                "processor {} → {}",
                a.unwrap_or_default(),
                b.unwrap_or_default()
            ));
        }
        if !changes.is_empty() {
            let summary = format!("Hardware changed: {}", changes.join(", "));
            super::timeline(
                &state.db,
                &device.id,
                "hardware.changed",
                "notice",
                &summary,
                json!({ "changes": changes }),
            )
            .await?;
        }
    }
    Ok(())
}

type SoftwareKey = (String, String);

fn software_items(data: &Value) -> BTreeMap<SoftwareKey, Value> {
    let mut out = BTreeMap::new();
    if let Some(items) = data.get("items").and_then(Value::as_array) {
        for item in items {
            let name = item
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if name.is_empty() {
                continue;
            }
            let version = item
                .get("version")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            out.insert(
                (
                    name.chars().take(300).collect(),
                    version.chars().take(100).collect(),
                ),
                item.clone(),
            );
        }
    }
    out
}

async fn apply_software(
    state: &AppState,
    device: &DeviceRecord,
    data: &Value,
    previous: Option<&Value>,
) -> anyhow::Result<()> {
    let current = software_items(data);
    let mut tx = state.db.begin().await?;
    sqlx::query("DELETE FROM device_software WHERE device_id = ?")
        .bind(&device.id)
        .execute(&mut *tx)
        .await?;
    for ((name, version), item) in &current {
        sqlx::query(
            "INSERT OR IGNORE INTO device_software (device_id, name, version, publisher, install_date, source) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&device.id)
        .bind(name)
        .bind(version)
        .bind(item.get("publisher").and_then(Value::as_str).unwrap_or("").chars().take(200).collect::<String>())
        .bind(item.get("install_date").and_then(Value::as_str))
        .bind(item.get("source").and_then(Value::as_str).unwrap_or(""))
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    let Some(prev) = previous else {
        let summary = format!("Software inventory collected ({} items)", current.len());
        super::timeline(
            &state.db,
            &device.id,
            "inventory.software",
            "info",
            &summary,
            json!({}),
        )
        .await?;
        return Ok(());
    };
    let before = software_items(prev);
    let before_names: BTreeMap<&str, &str> = before
        .keys()
        .map(|(n, v)| (n.as_str(), v.as_str()))
        .collect();
    let after_names: BTreeMap<&str, &str> = current
        .keys()
        .map(|(n, v)| (n.as_str(), v.as_str()))
        .collect();
    let mut events = 0usize;
    for (name, version) in &after_names {
        if events >= MAX_TIMELINE_ITEMS {
            break;
        }
        match before_names.get(name) {
            None => {
                super::timeline(
                    &state.db,
                    &device.id,
                    "software.installed",
                    "notice",
                    &format!("Installed {name} {version}"),
                    json!({ "name": name, "version": version }),
                )
                .await?;
                events += 1;
            }
            Some(old) if old != version => {
                super::timeline(
                    &state.db,
                    &device.id,
                    "software.updated",
                    "info",
                    &format!("Updated {name} {old} → {version}"),
                    json!({ "name": name, "from": old, "to": version }),
                )
                .await?;
                events += 1;
            }
            _ => {}
        }
    }
    for (name, version) in &before_names {
        if events >= MAX_TIMELINE_ITEMS {
            break;
        }
        if !after_names.contains_key(name) {
            super::timeline(
                &state.db,
                &device.id,
                "software.removed",
                "notice",
                &format!("Removed {name} {version}"),
                json!({ "name": name, "version": version }),
            )
            .await?;
            events += 1;
        }
    }
    Ok(())
}

fn admins(data: &Value) -> BTreeSet<String> {
    data.get("local")
        .and_then(Value::as_array)
        .map(|users| {
            users
                .iter()
                .filter(|u| u.get("admin").and_then(Value::as_bool) == Some(true))
                .filter_map(|u| u.get("name").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

async fn apply_users(
    state: &AppState,
    device: &DeviceRecord,
    data: &Value,
    previous: Option<&Value>,
) -> anyhow::Result<()> {
    if let Some(user) = s(data, "/last_user") {
        sqlx::query("UPDATE devices SET last_user = ? WHERE id = ?")
            .bind(user)
            .bind(&device.id)
            .execute(&state.db)
            .await?;
    }
    if let Some(prev) = previous {
        let (before, after) = (admins(prev), admins(data));
        for added in after.difference(&before) {
            super::timeline(
                &state.db,
                &device.id,
                "security.admin_added",
                "warning",
                &format!("New local administrator: {added}"),
                json!({ "account": added }),
            )
            .await?;
        }
        for removed in before.difference(&after) {
            super::timeline(
                &state.db,
                &device.id,
                "security.admin_removed",
                "info",
                &format!("Local administrator removed: {removed}"),
                json!({ "account": removed }),
            )
            .await?;
        }
    }
    Ok(())
}

/// Recomputes and stores a device's health score.
pub async fn refresh_health(state: &AppState, device_id: &str) -> anyhow::Result<i64> {
    let row: Option<(
        bool,
        Option<chrono::DateTime<chrono::Utc>>,
        Option<f64>,
        Option<f64>,
    )> = sqlx::query_as("SELECT online, last_seen_at, disk_pct, mem_pct FROM devices WHERE id = ?")
        .bind(device_id)
        .fetch_optional(&state.db)
        .await?;
    let Some((online, last_seen, disk, mem)) = row else {
        return Ok(0);
    };
    let sections: Vec<(String, String)> =
        sqlx::query_as("SELECT section, data FROM device_inventory WHERE device_id = ? AND section IN ('security', 'system')")
            .bind(device_id)
            .fetch_all(&state.db)
            .await?;
    let mut security = None;
    let mut system = None;
    for (name, data) in sections {
        let value: Option<Value> = serde_json::from_str(&data).ok();
        if name == "security" {
            security = value;
        } else {
            system = value;
        }
    }
    let offline_hours = last_seen.map(|t| (rustrmm_common::now() - t).num_minutes() as f64 / 60.0);
    let report = evaluate(&HealthInputs {
        online,
        offline_hours,
        disk_pct: disk,
        mem_pct: mem,
        security: security.as_ref(),
        system: system.as_ref(),
    });
    sqlx::query("UPDATE devices SET health_score = ? WHERE id = ?")
        .bind(report.score)
        .bind(device_id)
        .execute(&state.db)
        .await?;
    Ok(report.score)
}
