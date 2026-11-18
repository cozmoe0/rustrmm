//! The SNMP configuration pushed to a site's probe as a signed command (it carries decrypted
//! credentials, so it never travels unsigned and the probe keeps it in memory only).

use std::collections::HashMap;

use rustrmm_proto::commands::Command;
use rustrmm_proto::network::{SnmpConfig, SnmpCredential, SnmpTarget, TrapReceiver};

use crate::state::AppState;

#[derive(sqlx::FromRow)]
struct DeviceRow {
    id: String,
    ip: String,
    port: i64,
    credential_id: String,
    template_ids: String,
    poll_interval_secs: i64,
}

/// One device as the probe polls it.
pub async fn target_for(state: &AppState, device_id: &str) -> anyhow::Result<Option<SnmpTarget>> {
    let row: Option<DeviceRow> = sqlx::query_as(
        "SELECT id, ip, port, credential_id, template_ids, poll_interval_secs FROM snmp_devices WHERE id = ?",
    )
    .bind(device_id)
    .fetch_optional(&state.db)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let mut cache = HashMap::new();
    build_target(state, row, &mut cache).await
}

async fn build_target(
    state: &AppState,
    row: DeviceRow,
    cache: &mut HashMap<String, Option<SnmpCredential>>,
) -> anyhow::Result<Option<SnmpTarget>> {
    if !cache.contains_key(&row.credential_id) {
        let credential = super::credentials::load_decrypted(state, &row.credential_id).await?;
        cache.insert(row.credential_id.clone(), credential);
    }
    let Some(credential) = cache.get(&row.credential_id).cloned().flatten() else {
        return Ok(None);
    };
    let ids: Vec<String> = serde_json::from_str(&row.template_ids).unwrap_or_default();
    let templates = super::templates::load_many(&state.db, &ids).await?;
    let metrics = super::templates::merged_metrics(&templates);
    Ok(Some(SnmpTarget {
        id: row.id,
        ip: row.ip,
        port: u16::try_from(row.port).unwrap_or(161),
        credential,
        oids: super::templates::oids_for(&metrics),
        poll_interval_secs: u32::try_from(row.poll_interval_secs).unwrap_or(300),
    }))
}

/// Everything the site's probe polls.
pub async fn build(state: &AppState, site_id: &str) -> anyhow::Result<SnmpConfig> {
    let rows: Vec<DeviceRow> = sqlx::query_as(
        "SELECT id, ip, port, credential_id, template_ids, poll_interval_secs FROM snmp_devices
         WHERE site_id = ? AND enabled = 1 ORDER BY id",
    )
    .bind(site_id)
    .fetch_all(&state.db)
    .await?;
    let mut cache = HashMap::new();
    let mut devices = Vec::new();
    for row in rows {
        if let Some(target) = build_target(state, row, &mut cache).await? {
            devices.push(target);
        }
    }
    let trap = super::probes::of_site(&state.db, site_id)
        .await?
        .map(|p| TrapReceiver {
            enabled: p.trap_receiver,
            port: u16::try_from(p.trap_port).unwrap_or(162),
        })
        .unwrap_or_default();
    Ok(SnmpConfig::new(devices, trap))
}

async fn send(state: &AppState, device_id: &str, config: SnmpConfig) -> anyhow::Result<()> {
    let _guard = state.network.push_lock.lock().await;
    if state
        .network
        .pushed
        .get(device_id)
        .is_some_and(|v| *v == config.version)
    {
        return Ok(());
    }
    let version = config.version.clone();
    crate::agents::commands::send_quiet(state, device_id, Command::SnmpConfig(config), 300).await?;
    state.network.pushed.insert(device_id.to_string(), version);
    Ok(())
}

/// Sends the site's configuration to its probe when it changed.
pub async fn push_site(state: &AppState, site_id: &str) -> anyhow::Result<()> {
    let Some(probe) = super::probes::of_site(&state.db, site_id).await? else {
        return Ok(());
    };
    if !state.agents.is_online(&probe.device_id) {
        return Ok(());
    }
    let config = build(state, site_id).await?;
    send(state, &probe.device_id, config).await
}

/// A connected device: send its configuration if it is a probe.
pub async fn push_probe(state: &AppState, device_id: &str) -> anyhow::Result<()> {
    match super::probes::site_of(&state.db, device_id).await? {
        Some(probe) => push_site(state, &probe.site_id).await,
        None => Ok(()),
    }
}

/// A device stopped being a probe: stop its polling and trap receiver.
pub async fn clear_probe(state: &AppState, device_id: &str) {
    if !state.agents.is_online(device_id) {
        state.network.pushed.remove(device_id);
        return;
    }
    let config = SnmpConfig::new(Vec::new(), TrapReceiver::default());
    if let Err(e) = send(state, device_id, config).await {
        tracing::debug!(device = device_id, error = %format!("{e:#}"), "clearing the SNMP configuration failed");
    }
}

/// Pushes one site's configuration in the background.
pub fn push_site_soon(state: &AppState, site_id: &str) {
    let state = state.clone();
    let site_id = site_id.to_string();
    tokio::spawn(async move {
        if let Err(e) = push_site(&state, &site_id).await {
            tracing::warn!(site = %site_id, error = %format!("{e:#}"), "pushing the SNMP configuration failed");
        }
    });
}

/// Pushes every probe's configuration in the background (template or credential change).
pub fn push_all_soon(state: &AppState) {
    let state = state.clone();
    tokio::spawn(async move {
        let sites: Vec<String> = match sqlx::query_scalar("SELECT site_id FROM site_probes")
            .fetch_all(&state.db)
            .await
        {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(error = %e, "listing probes failed");
                return;
            }
        };
        for site in sites {
            if let Err(e) = push_site(&state, &site).await {
                tracing::warn!(site = %site, error = %format!("{e:#}"), "pushing the SNMP configuration failed");
            }
        }
    });
}
