//! Discovered assets: hosts found by scans, with OUI vendors, type guesses and the enrolled
//! agent they belong to (matched by MAC address or host name).

use std::net::IpAddr;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use rustrmm_proto::network::ScanHost;
use serde::Deserialize;
use serde_json::{Value, json};

use super::classify::{self, Facts};
use crate::auth::AuthCtx;
use crate::error::{ApiError, ApiResult};
use crate::rbac::perm;
use crate::state::AppState;

fn clean(text: Option<&str>, max: usize) -> Option<String> {
    text.map(|t| {
        t.chars()
            .filter(|c| !c.is_control())
            .take(max)
            .collect::<String>()
            .trim()
            .to_string()
    })
    .filter(|t| !t.is_empty())
}

/// Short host name: drops `.local` and DNS suffixes.
fn short_name(name: &str) -> String {
    let name = name.trim().trim_end_matches('.');
    name.split('.').next().unwrap_or(name).to_string()
}

/// Enrolled agent in the same client matching the MAC address or host name.
async fn managed_device(
    state: &AppState,
    client_id: &str,
    site_id: &str,
    ip: &str,
    mac: Option<&str>,
    names: &[&str],
) -> anyhow::Result<Option<String>> {
    if let Some(mac) = mac {
        let found: Option<String> = sqlx::query_scalar(
            "SELECT d.id FROM devices d JOIN sites s ON s.id = d.site_id
             JOIN device_inventory i ON i.device_id = d.id AND i.section = 'network'
             WHERE s.client_id = ? AND d.status = 'active' AND instr(lower(i.data), ?) > 0 LIMIT 1",
        )
        .bind(client_id)
        .bind(mac)
        .fetch_optional(&state.db)
        .await?;
        if found.is_some() {
            return Ok(found);
        }
    }
    for name in names
        .iter()
        .map(|n| short_name(n))
        .filter(|n| !n.is_empty())
    {
        let found: Option<String> = sqlx::query_scalar(
            "SELECT d.id FROM devices d JOIN sites s ON s.id = d.site_id
             WHERE s.client_id = ? AND d.status = 'active' AND lower(d.hostname) = lower(?) LIMIT 1",
        )
        .bind(client_id)
        .bind(&name)
        .fetch_optional(&state.db)
        .await?;
        if found.is_some() {
            return Ok(found);
        }
    }
    // Without a MAC (routed range, ARP off, or the probe itself) fall back to an agent in the
    // same site that reports this exact address. The quotes keep 10.0.0.1 from matching
    // 10.0.0.12. With a MAC that matched no agent, the address may have been re-leased, so the
    // address alone is not trusted.
    if mac.is_none() {
        let found: Option<String> = sqlx::query_scalar(
            "SELECT d.id FROM devices d
             JOIN device_inventory i ON i.device_id = d.id AND i.section = 'network'
             WHERE d.site_id = ? AND d.status = 'active' AND instr(i.data, ?) > 0
             ORDER BY d.last_seen_at DESC LIMIT 1",
        )
        .bind(site_id)
        .bind(format!("\"{ip}\""))
        .fetch_optional(&state.db)
        .await?;
        if found.is_some() {
            return Ok(found);
        }
    }
    Ok(None)
}

/// Records one scanned host. Returns the asset id (`None` for an unusable address).
pub async fn upsert(
    state: &AppState,
    site_id: &str,
    client_id: &str,
    host: &ScanHost,
    scan_id: &str,
) -> anyhow::Result<Option<String>> {
    let Ok(ip) = host.ip.trim().parse::<IpAddr>() else {
        return Ok(None);
    };
    let ip = ip.to_string();
    let mac = host.mac.as_deref().and_then(super::oui::normalize_mac);
    let vendor = clean(host.vendor.as_deref(), 120).or_else(|| {
        mac.as_deref()
            .and_then(super::oui::vendor)
            .map(String::from)
    });
    let snmp = host.snmp.clone().unwrap_or_default();
    let sys_descr = clean(snmp.sys_descr.as_deref(), 1000);
    let sys_name = clean(snmp.sys_name.as_deref(), 255);
    let sys_object_id = clean(snmp.sys_object_id.as_deref(), 255);
    let netbios = clean(host.netbios_name.as_deref(), 64);
    let hostname = clean(host.hostname.as_deref(), 255)
        .map(|h| {
            h.trim_end_matches(".local")
                .trim_end_matches('.')
                .to_string()
        })
        .or_else(|| netbios.clone())
        .or_else(|| sys_name.clone());
    let mut ports: Vec<u16> = host.open_ports.clone();
    ports.sort_unstable();
    ports.dedup();
    ports.truncate(256);
    let mdns: Vec<String> = host
        .mdns
        .iter()
        .filter_map(|s| clean(Some(s), 255))
        .take(50)
        .collect();
    let type_guess = classify::guess(&Facts {
        vendor: vendor.as_deref(),
        sys_object_id: sys_object_id.as_deref(),
        sys_descr: sys_descr.as_deref(),
        open_ports: &ports,
        mdns: &mdns,
        netbios_name: netbios.as_deref(),
    });
    let names: Vec<&str> = [hostname.as_deref(), netbios.as_deref(), sys_name.as_deref()]
        .into_iter()
        .flatten()
        .collect();
    let managed = managed_device(state, client_id, site_id, &ip, mac.as_deref(), &names).await?;
    let rtt = host.rtt_ms.filter(|r| r.is_finite() && *r >= 0.0);
    let now = rustrmm_common::now();

    // Same MAC first (the address may have changed), then the same address.
    let by_mac: Option<(String, String)> = match &mac {
        Some(mac) => {
            sqlx::query_as("SELECT id, ip FROM network_assets WHERE site_id = ? AND mac = ? ORDER BY last_seen_at DESC LIMIT 1")
                .bind(site_id)
                .bind(mac)
                .fetch_optional(&state.db)
                .await?
        }
        None => None,
    };
    let by_ip: Option<String> =
        sqlx::query_scalar("SELECT id FROM network_assets WHERE site_id = ? AND ip = ?")
            .bind(site_id)
            .bind(&ip)
            .fetch_optional(&state.db)
            .await?;
    let existing = match (by_mac, by_ip) {
        // The MAC moved to an address another asset holds: update that one.
        (Some((_, old_ip)), Some(ip_id)) if old_ip != ip => Some(ip_id),
        (Some((id, _)), _) => Some(id),
        (None, ip_id) => ip_id,
    };
    let id = match existing {
        Some(id) => {
            sqlx::query(
                "UPDATE network_assets SET ip = ?, mac = COALESCE(?, mac), vendor = COALESCE(?, vendor),
                     hostname = COALESCE(?, hostname), type_guess = ?, managed_device_id = COALESCE(?, managed_device_id),
                     open_ports = ?, snmp_sys_descr = COALESCE(?, snmp_sys_descr), snmp_sys_name = COALESCE(?, snmp_sys_name),
                     snmp_sys_object_id = COALESCE(?, snmp_sys_object_id), mdns = CASE WHEN ? = '[]' THEN mdns ELSE ? END,
                     netbios_name = COALESCE(?, netbios_name), rtt_ms = ?, last_seen_at = ?, last_scan_id = ?
                 WHERE id = ?",
            )
            .bind(&ip)
            .bind(&mac)
            .bind(&vendor)
            .bind(&hostname)
            .bind(type_guess)
            .bind(&managed)
            .bind(serde_json::to_string(&ports)?)
            .bind(&sys_descr)
            .bind(&sys_name)
            .bind(&sys_object_id)
            .bind(serde_json::to_string(&mdns)?)
            .bind(serde_json::to_string(&mdns)?)
            .bind(&netbios)
            .bind(rtt)
            .bind(now)
            .bind(scan_id)
            .bind(&id)
            .execute(&state.db)
            .await?;
            id
        }
        None => {
            let id = rustrmm_common::new_id();
            sqlx::query(
                "INSERT INTO network_assets (id, site_id, ip, mac, vendor, hostname, type_guess, managed_device_id, open_ports,
                     snmp_sys_descr, snmp_sys_name, snmp_sys_object_id, mdns, netbios_name, rtt_ms, first_seen_at, last_seen_at, last_scan_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&id)
            .bind(site_id)
            .bind(&ip)
            .bind(&mac)
            .bind(&vendor)
            .bind(&hostname)
            .bind(type_guess)
            .bind(&managed)
            .bind(serde_json::to_string(&ports)?)
            .bind(&sys_descr)
            .bind(&sys_name)
            .bind(&sys_object_id)
            .bind(serde_json::to_string(&mdns)?)
            .bind(&netbios)
            .bind(rtt)
            .bind(now)
            .bind(now)
            .bind(scan_id)
            .execute(&state.db)
            .await?;
            id
        }
    };
    Ok(Some(id))
}

// ------------------------------------------------------------------ API

#[derive(Debug, sqlx::FromRow)]
struct AssetRow {
    id: String,
    site_id: String,
    site_name: String,
    client_id: String,
    ip: String,
    mac: Option<String>,
    vendor: Option<String>,
    hostname: Option<String>,
    type_guess: String,
    type_override: Option<String>,
    managed_device_id: Option<String>,
    managed_hostname: Option<String>,
    open_ports: String,
    snmp_sys_descr: Option<String>,
    snmp_sys_name: Option<String>,
    snmp_sys_object_id: Option<String>,
    mdns: String,
    netbios_name: Option<String>,
    rtt_ms: Option<f64>,
    notes: String,
    ignored: bool,
    first_seen_at: DateTime<Utc>,
    last_seen_at: DateTime<Utc>,
    snmp_device_id: Option<String>,
}

const SELECT: &str = "SELECT a.id, a.site_id, s.name AS site_name, s.client_id, a.ip, a.mac, a.vendor, a.hostname, a.type_guess,
    a.type_override, a.managed_device_id, d.hostname AS managed_hostname, a.open_ports, a.snmp_sys_descr, a.snmp_sys_name,
    a.snmp_sys_object_id, a.mdns, a.netbios_name, a.rtt_ms, a.notes, a.ignored, a.first_seen_at, a.last_seen_at,
    (SELECT sd.id FROM snmp_devices sd WHERE sd.asset_id = a.id LIMIT 1) AS snmp_device_id
    FROM network_assets a JOIN sites s ON s.id = a.site_id LEFT JOIN devices d ON d.id = a.managed_device_id";

impl AssetRow {
    fn effective_type(&self) -> &str {
        self.type_override.as_deref().unwrap_or(&self.type_guess)
    }

    fn to_json(&self) -> Value {
        json!({
            "id": self.id, "site_id": self.site_id, "site_name": self.site_name, "ip": self.ip, "mac": self.mac,
            "vendor": self.vendor, "hostname": self.hostname, "type_guess": self.effective_type(),
            "type_source": if self.type_override.is_some() { "manual" } else { "guess" },
            "managed_device_id": self.managed_device_id, "managed_hostname": self.managed_hostname,
            "first_seen_at": self.first_seen_at, "last_seen_at": self.last_seen_at,
            "open_ports": serde_json::from_str::<Value>(&self.open_ports).unwrap_or_else(|_| json!([])),
            "snmp_sys_descr": self.snmp_sys_descr, "snmp_sys_name": self.snmp_sys_name,
            "snmp_sys_object_id": self.snmp_sys_object_id,
            "mdns": serde_json::from_str::<Value>(&self.mdns).unwrap_or_else(|_| json!([])),
            "netbios_name": self.netbios_name, "rtt_ms": self.rtt_ms,
            "notes": self.notes, "ignored": self.ignored, "snmp_device_id": self.snmp_device_id,
        })
    }
}

#[derive(Debug, Default, Deserialize)]
pub struct ListQuery {
    site_id: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
    managed: Option<String>,
    q: Option<String>,
}

/// `GET /api/v1/network/assets?site_id=&type=&managed=true|false&q=`
#[utoipa::path(get, path = "/api/v1/network/assets", tag = "Network", summary = "List assets", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::NETWORK_VIEW)?;
    let mut qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new(format!("{SELECT} WHERE 1 = 1"));
    if let Some(site) = q.site_id.as_deref().filter(|s| !s.is_empty()) {
        qb.push(" AND a.site_id = ").push_bind(site.to_string());
    }
    if let Some(kind) = q.kind.as_deref().filter(|k| !k.is_empty()) {
        qb.push(" AND COALESCE(a.type_override, a.type_guess) = ")
            .push_bind(kind.to_string());
    }
    match q.managed.as_deref() {
        Some("true") => {
            qb.push(" AND a.managed_device_id IS NOT NULL");
        }
        Some("false") => {
            qb.push(" AND a.managed_device_id IS NULL");
        }
        _ => {}
    }
    if let Some(text) = q.q.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        let like = format!(
            "%{}%",
            text.replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        qb.push(" AND (a.ip LIKE ").push_bind(like.clone());
        for column in [
            "a.mac",
            "a.vendor",
            "a.hostname",
            "a.notes",
            "a.snmp_sys_descr",
        ] {
            qb.push(format!(" ESCAPE '\\' OR {column} LIKE "))
                .push_bind(like.clone());
        }
        qb.push(" ESCAPE '\\')");
    }
    qb.push(" ORDER BY a.site_id, a.ip LIMIT 10000");
    let rows: Vec<AssetRow> = qb.build_query_as().fetch_all(&state.db).await?;
    let mut items: Vec<&AssetRow> = rows
        .iter()
        .filter(|r| {
            ctx.scope
                .can_site(perm::NETWORK_VIEW, &r.client_id, &r.site_id)
        })
        .collect();
    // Numeric address order within a site.
    items.sort_by_key(|r| (r.site_id.clone(), r.ip.parse::<IpAddr>().ok()));
    Ok(Json(json!({
        "items": items.iter().take(5000).map(|r| r.to_json()).collect::<Vec<_>>(),
    })))
}

async fn load(state: &AppState, ctx: &AuthCtx, id: &str, permission: &str) -> ApiResult<AssetRow> {
    let row: Option<AssetRow> =
        sqlx::query_as(sqlx::AssertSqlSafe(format!("{SELECT} WHERE a.id = ?")))
            .bind(id)
            .fetch_optional(&state.db)
            .await?;
    let row = row
        .filter(|r| {
            ctx.scope
                .can_site(perm::NETWORK_VIEW, &r.client_id, &r.site_id)
                || ctx.scope.can_site(permission, &r.client_id, &r.site_id)
        })
        .ok_or_else(|| ApiError::not_found("Asset"))?;
    if !ctx.scope.can_site(permission, &row.client_id, &row.site_id) {
        return Err(
            ApiError::forbidden(format!("Missing permission: {permission}"))
                .with_details(json!({ "permission": permission })),
        );
    }
    Ok(row)
}

#[derive(Deserialize)]
pub struct PatchBody {
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    ignored: Option<bool>,
    /// `null` or `""` clears a manual type.
    #[serde(default, rename = "type")]
    kind: Option<Option<String>>,
}

/// `PATCH /api/v1/network/assets/{id}` — body `{ notes?, ignored?, type? }`.
#[utoipa::path(patch, path = "/api/v1/network/assets/{id}", tag = "Network", summary = "Update asset", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn update(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(body): Json<PatchBody>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::NETWORK_MANAGE)?;
    let row = load(&state, &ctx, &id, perm::NETWORK_MANAGE).await?;
    if let Some(notes) = &body.notes {
        if notes.chars().count() > 2000 {
            return Err(ApiError::validation("notes: at most 2000 characters"));
        }
        sqlx::query("UPDATE network_assets SET notes = ? WHERE id = ?")
            .bind(notes)
            .bind(&id)
            .execute(&state.db)
            .await?;
    }
    if let Some(ignored) = body.ignored {
        sqlx::query("UPDATE network_assets SET ignored = ? WHERE id = ?")
            .bind(ignored)
            .bind(&id)
            .execute(&state.db)
            .await?;
    }
    if let Some(kind) = &body.kind {
        let kind = kind.as_deref().filter(|k| !k.is_empty());
        if let Some(k) = kind
            && !classify::TYPES.contains(&k)
        {
            return Err(ApiError::validation(format!(
                "type must be one of {}",
                classify::TYPES.join(", ")
            )));
        }
        sqlx::query("UPDATE network_assets SET type_override = ? WHERE id = ?")
            .bind(kind)
            .bind(&id)
            .execute(&state.db)
            .await?;
    }
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("network.asset_updated")
                .target("network_asset", &id, &row.ip)
                .client(&row.client_id)
                .site(&row.site_id),
        )
        .await;
    Ok(Json(
        load(&state, &ctx, &id, perm::NETWORK_VIEW).await?.to_json(),
    ))
}

#[derive(Deserialize)]
pub struct MonitorBody {
    credential_id: String,
    #[serde(default)]
    template_ids: Option<Vec<String>>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    poll_interval_secs: Option<i64>,
    #[serde(default)]
    port: Option<u16>,
}

/// `POST /api/v1/network/assets/{id}/monitor` — creates an SNMP device from the asset.
#[utoipa::path(post, path = "/api/v1/network/assets/{id}/monitor", tag = "Network", summary = "Monitor", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn monitor(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(body): Json<MonitorBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    ctx.require(perm::NETWORK_MANAGE)?;
    let row = load(&state, &ctx, &id, perm::NETWORK_MANAGE).await?;
    let name = body
        .name
        .clone()
        .filter(|n| !n.trim().is_empty())
        .or_else(|| row.hostname.clone())
        .or_else(|| row.snmp_sys_name.clone())
        .unwrap_or_else(|| row.ip.clone());
    let input = super::devices::DeviceInput {
        site_id: row.site_id.clone(),
        asset_id: Some(row.id.clone()),
        name,
        ip: row.ip.clone(),
        port: body.port.unwrap_or(161),
        credential_id: body.credential_id.clone(),
        template_ids: body
            .template_ids
            .clone()
            .unwrap_or_else(|| super::templates::defaults_for(row.effective_type())),
        poll_interval_secs: body.poll_interval_secs.unwrap_or(300),
        enabled: true,
    };
    let device = super::devices::create_device(&state, &ctx, input).await?;
    Ok((StatusCode::CREATED, Json(device)))
}
