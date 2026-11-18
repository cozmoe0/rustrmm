//! Best-effort site topology: the probe, discovered assets and SNMP devices as nodes; LLDP
//! neighbours (`lldpRemSysName`, polled with the Interfaces template) as edges where available,
//! and an `arp` edge from the probe to every host it saw on the wire otherwise.

use std::collections::HashMap;

use axum::Json;
use axum::extract::{Query, State};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::auth::AuthCtx;
use crate::error::{ApiError, ApiResult};
use crate::rbac::perm;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct TopologyQuery {
    site_id: Option<String>,
}

fn key(name: &str) -> String {
    name.trim()
        .trim_end_matches('.')
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
}

/// `GET /api/v1/network/topology?site_id=`
#[utoipa::path(get, path = "/api/v1/network/topology", tag = "Network", summary = "Get topology", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn get(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<TopologyQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::NETWORK_VIEW)?;
    let site_id = q
        .site_id
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::validation("site_id is required"))?;
    super::site_scope(&state, &ctx, &site_id, perm::NETWORK_VIEW).await?;
    let mut nodes: Vec<Value> = Vec::new();
    let mut edges: Vec<Value> = Vec::new();
    // Host name → node id, for LLDP matching.
    let mut by_name: HashMap<String, String> = HashMap::new();

    let probe = super::probes::of_site(&state.db, &site_id).await?;
    if let Some(p) = &probe {
        let id = format!("device:{}", p.device_id);
        by_name.insert(key(&p.hostname), id.clone());
        nodes.push(
            json!({ "id": id, "kind": "probe", "label": p.hostname, "device_id": p.device_id,
                           "type": p.os_family }),
        );
    }
    let snmp: Vec<(String, String, String, Option<String>)> = sqlx::query_as(
        "SELECT id, name, ip, asset_id FROM snmp_devices WHERE site_id = ? ORDER BY name",
    )
    .bind(&site_id)
    .fetch_all(&state.db)
    .await?;
    let monitored: HashMap<String, String> = snmp
        .iter()
        .filter_map(|(id, _, _, asset)| Some((asset.clone()?, format!("snmp:{id}"))))
        .collect();
    let assets: Vec<(String, String, Option<String>, String, Option<String>, Option<String>, Option<String>)> =
        sqlx::query_as(
            "SELECT id, ip, hostname, COALESCE(type_override, type_guess), mac, managed_device_id, snmp_sys_name
             FROM network_assets WHERE site_id = ? AND ignored = 0 ORDER BY ip LIMIT 2000",
        )
        .bind(&site_id)
        .fetch_all(&state.db)
        .await?;
    for (id, ip, hostname, kind, mac, managed, sys_name) in &assets {
        if monitored.contains_key(id) {
            continue;
        }
        let node = format!("asset:{id}");
        for name in [hostname, sys_name].into_iter().flatten() {
            by_name.entry(key(name)).or_insert_with(|| node.clone());
        }
        nodes.push(json!({ "id": node, "kind": "asset", "label": hostname.clone().unwrap_or_else(|| ip.clone()),
                           "ip": ip, "mac": mac, "type": kind, "asset_id": id, "device_id": managed }));
        if let Some(p) = &probe {
            edges.push(
                json!({ "from": format!("device:{}", p.device_id), "to": node, "kind": "arp" }),
            );
        }
    }
    for (id, name, ip, asset) in &snmp {
        let node = format!("snmp:{id}");
        by_name.entry(key(name)).or_insert_with(|| node.clone());
        let kind = asset
            .as_ref()
            .and_then(|a| assets.iter().find(|x| &x.0 == a))
            .map(|a| a.3.clone())
            .unwrap_or_else(|| "unknown".into());
        nodes.push(
            json!({ "id": node, "kind": "snmp", "label": name, "ip": ip, "type": kind,
                           "snmp_device_id": id, "asset_id": asset }),
        );
    }
    // LLDP neighbours reported by SNMP devices.
    let lldp: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT v.snmp_device_id, v.idx, v.text FROM snmp_values v JOIN snmp_devices d ON d.id = v.snmp_device_id
         WHERE d.site_id = ? AND v.key = 'lldpRemSysName'",
    )
    .bind(&site_id)
    .fetch_all(&state.db)
    .await?;
    let mut linked = std::collections::HashSet::new();
    for (device, idx, neighbour) in lldp {
        let Some(neighbour) = neighbour.filter(|n| !n.trim().is_empty()) else {
            continue;
        };
        let from = format!("snmp:{device}");
        let to = match by_name.get(&key(&neighbour)) {
            Some(node) => node.clone(),
            None => {
                let node = format!("lldp:{}", key(&neighbour));
                if !nodes.iter().any(|n| n["id"] == node) {
                    nodes.push(json!({ "id": node, "kind": "neighbour", "label": neighbour, "type": "unknown" }));
                }
                node
            }
        };
        if from == to || !linked.insert((from.clone(), to.clone())) {
            continue;
        }
        // lldpRemTable rows are indexed by (time mark, local port, neighbour index).
        let local_port = idx.split('.').nth(1).map(str::to_string);
        edges.push(json!({ "from": from, "to": to, "kind": "lldp", "local_port": local_port }));
    }
    Ok(Json(json!({ "nodes": nodes, "edges": edges })))
}
