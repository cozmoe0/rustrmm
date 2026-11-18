//! Software explorer over the `device_software` inventory, grouped by normalised name and
//! publisher.

use std::collections::{BTreeMap, HashMap, HashSet};

use axum::Json;
use axum::extract::{Query, State};
use rustrmm_proto::commands::version_cmp;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{QueryBuilder, Sqlite};

use super::{normalize_name, normalize_publisher, strip_name};
use crate::auth::AuthCtx;
use crate::error::{ApiError, ApiResult};
use crate::rbac::perm;
use crate::state::AppState;

#[derive(sqlx::FromRow)]
struct SoftwareRow {
    device_id: String,
    name: String,
    version: String,
    publisher: String,
    install_date: Option<String>,
    client_id: String,
    site_id: String,
    hostname: String,
    client_name: String,
}

async fn load_rows(
    state: &AppState,
    ctx: &AuthCtx,
    client_id: Option<&str>,
) -> anyhow::Result<Vec<SoftwareRow>> {
    let mut qb = QueryBuilder::<Sqlite>::new(
        "SELECT ds.device_id, ds.name, ds.version, ds.publisher, ds.install_date, s.client_id, d.site_id,
                COALESCE(d.display_name, d.hostname) AS hostname, c.name AS client_name
         FROM device_software ds JOIN devices d ON d.id = ds.device_id JOIN sites s ON s.id = d.site_id
         JOIN clients c ON c.id = s.client_id WHERE d.status = 'active'",
    );
    if let Some(c) = client_id {
        qb.push(" AND s.client_id = ").push_bind(c.to_string());
    }
    let rows: Vec<SoftwareRow> = qb.build_query_as().fetch_all(&state.db).await?;
    Ok(rows
        .into_iter()
        .filter(|r| {
            ctx.scope
                .can_site(perm::SOFTWARE_VIEW, &r.client_id, &r.site_id)
        })
        .collect())
}

#[derive(Default)]
struct Group {
    names: BTreeMap<String, usize>,
    /// Display forms of the publisher with their counts (the most common one is shown).
    publishers: BTreeMap<String, usize>,
    versions: HashSet<String>,
    devices: HashSet<String>,
}

#[derive(Deserialize)]
pub struct ListQuery {
    q: Option<String>,
    publisher: Option<String>,
    client_id: Option<String>,
    cursor: Option<String>,
    limit: Option<i64>,
}

/// `GET /api/v1/software`
pub async fn list(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::SOFTWARE_VIEW)?;
    let client_id = q.client_id.clone().filter(|c| !c.is_empty());
    let limit = q.limit.unwrap_or(100).clamp(1, 500) as usize;
    let offset: usize = q
        .cursor
        .as_deref()
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    let rows = load_rows(&state, &ctx, client_id.as_deref()).await?;
    let search =
        q.q.as_deref()
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty());
    let publisher = q
        .publisher
        .as_deref()
        .map(normalize_publisher)
        .filter(|s| !s.is_empty());
    let mut groups: HashMap<(String, String), Group> = HashMap::new();
    for row in &rows {
        let key = (
            normalize_name(&row.name),
            normalize_publisher(&row.publisher),
        );
        if search.as_ref().is_some_and(|s| !key.0.contains(s.as_str())) {
            continue;
        }
        if publisher
            .as_ref()
            .is_some_and(|p| !key.1.contains(p.as_str()))
        {
            continue;
        }
        let group = groups.entry(key).or_default();
        *group.names.entry(strip_name(&row.name)).or_default() += 1;
        *group
            .publishers
            .entry(row.publisher.trim().to_string())
            .or_default() += 1;
        if !row.version.is_empty() {
            group.versions.insert(row.version.clone());
        }
        group.devices.insert(row.device_id.clone());
    }
    let mut items: Vec<(String, Value, usize)> = groups
        .into_values()
        .map(|g| {
            let name = g
                .names
                .iter()
                .max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0)))
                .map(|(n, _)| n.clone())
                .unwrap_or_default();
            let latest = g.versions.iter().max_by(|a, b| version_cmp(a, b)).cloned();
            let devices = g.devices.len();
            let publisher = most_common(&g.publishers);
            (
                name.to_lowercase(),
                json!({ "name": name, "publisher": publisher, "versions": g.versions.len(),
                        "devices": devices, "latest_version": latest }),
                devices,
            )
        })
        .collect();
    items.sort_by(|a, b| b.2.cmp(&a.2).then(a.0.cmp(&b.0)));
    let total = items.len();
    let page: Vec<Value> = items
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(|(_, v, _)| v)
        .collect();
    let next_cursor = (offset + limit < total).then(|| (offset + limit).to_string());
    Ok(Json(json!({ "items": page, "next_cursor": next_cursor })))
}

/// The most frequent display form (ties: alphabetical first).
fn most_common(forms: &BTreeMap<String, usize>) -> String {
    forms
        .iter()
        .max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0)))
        .map(|(n, _)| n.clone())
        .unwrap_or_default()
}

#[derive(Deserialize)]
pub struct ProductQuery {
    name: String,
    #[serde(default)]
    publisher: String,
}

/// `GET /api/v1/software/product?name=&publisher=`
pub async fn product(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<ProductQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::SOFTWARE_VIEW)?;
    if q.name.trim().is_empty() {
        return Err(ApiError::validation("name is required"));
    }
    let name_key = normalize_name(&q.name);
    let publisher_key = normalize_publisher(&q.publisher);
    let rows = load_rows(&state, &ctx, None).await?;
    let matching: Vec<&SoftwareRow> = rows
        .iter()
        .filter(|r| {
            normalize_name(&r.name) == name_key
                && normalize_publisher(&r.publisher) == publisher_key
        })
        .collect();
    let mut versions: BTreeMap<String, HashSet<&str>> = BTreeMap::new();
    for row in &matching {
        versions
            .entry(row.version.clone())
            .or_default()
            .insert(row.device_id.as_str());
    }
    let mut version_list: Vec<(String, usize)> =
        versions.into_iter().map(|(v, d)| (v, d.len())).collect();
    version_list.sort_by(|a, b| version_cmp(&b.0, &a.0));
    let mut devices: Vec<Value> = matching
        .iter()
        .map(|r| {
            json!({ "device_id": r.device_id, "hostname": r.hostname, "client_name": r.client_name,
                    "version": r.version, "install_date": r.install_date })
        })
        .collect();
    devices.sort_by(|a, b| {
        a["hostname"]
            .as_str()
            .unwrap_or("")
            .to_lowercase()
            .cmp(&b["hostname"].as_str().unwrap_or("").to_lowercase())
    });
    let mut names: BTreeMap<String, usize> = BTreeMap::new();
    let mut publishers: BTreeMap<String, usize> = BTreeMap::new();
    for r in &matching {
        *names.entry(strip_name(&r.name)).or_default() += 1;
        *publishers
            .entry(r.publisher.trim().to_string())
            .or_default() += 1;
    }
    let display = if names.is_empty() {
        strip_name(&q.name)
    } else {
        most_common(&names)
    };
    let publisher = if publishers.is_empty() {
        q.publisher.clone()
    } else {
        most_common(&publishers)
    };
    Ok(Json(json!({
        "name": display, "publisher": publisher,
        "versions": version_list.into_iter().map(|(v, d)| json!({ "version": v, "devices": d })).collect::<Vec<_>>(),
        "devices": devices,
    })))
}
