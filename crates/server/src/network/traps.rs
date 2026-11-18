//! SNMP traps received by a site's probe, and trap rules that raise alerts (matched by OID
//! prefix). Trap alerts resolve manually; repeats add occurrences.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use rustrmm_proto::network::SnmpTrap;
use serde::Deserialize;
use serde_json::{Value, json};

use super::alerting::{self, SnmpRaise};
use crate::agents::DeviceRecord;
use crate::auth::AuthCtx;
use crate::db::Db;
use crate::error::{ApiError, ApiResult};
use crate::rbac::perm;
use crate::state::AppState;

/// Whether `oid` lies under `prefix` (on an arc boundary).
pub fn oid_matches(prefix: &str, oid: &str) -> bool {
    let prefix = prefix.trim_start_matches('.').trim_end_matches('.');
    let oid = oid.trim_start_matches('.');
    !prefix.is_empty()
        && (oid == prefix || oid.strip_prefix(prefix).is_some_and(|r| r.starts_with('.')))
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct RuleRow {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub oid_prefix: String,
    pub severity: String,
    pub site_ids: String,
    pub title: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

const RULE_SELECT: &str = "SELECT id, name, enabled, oid_prefix, severity, site_ids, title, created_at, updated_at FROM trap_rules";

impl RuleRow {
    fn site_ids(&self) -> Vec<String> {
        serde_json::from_str(&self.site_ids).unwrap_or_default()
    }

    fn to_json(&self) -> Value {
        json!({
            "id": self.id, "name": self.name, "enabled": self.enabled, "oid_prefix": self.oid_prefix,
            "severity": self.severity, "site_ids": self.site_ids(), "title": self.title,
            "created_at": self.created_at, "updated_at": self.updated_at,
        })
    }
}

/// The most specific enabled rule matching a trap in a site.
pub fn best_rule<'a>(rules: &'a [RuleRow], site_id: &str, oid: &str) -> Option<&'a RuleRow> {
    rules
        .iter()
        .filter(|r| r.enabled && oid_matches(&r.oid_prefix, oid))
        .filter(|r| {
            let sites = r.site_ids();
            sites.is_empty() || sites.iter().any(|s| s == site_id)
        })
        .max_by_key(|r| r.oid_prefix.trim_matches('.').split('.').count())
}

/// Stores a trap from a probe and applies the trap rules.
pub async fn on_trap(state: &AppState, probe: &DeviceRecord, trap: SnmpTrap) -> anyhow::Result<()> {
    let Some(site) = super::probes::site_of(&state.db, &probe.id).await? else {
        tracing::debug!(device = %probe.id, "trap from a device that is not a probe ignored");
        return Ok(());
    };
    if !site.trap_receiver {
        return Ok(());
    }
    let from_ip: String = trap.from_ip.chars().take(64).collect();
    let oid: String = trap.oid.chars().take(255).collect();
    if from_ip.parse::<std::net::IpAddr>().is_err()
        || !super::templates::valid_oid(oid.trim_start_matches('.'))
    {
        anyhow::bail!("malformed trap");
    }
    let now = rustrmm_common::now();
    let at = DateTime::<Utc>::from_timestamp_millis(trap.at)
        .filter(|t| *t <= now && *t > now - chrono::Duration::days(7))
        .unwrap_or(now);
    let device: Option<(String, String)> =
        sqlx::query_as("SELECT id, name FROM snmp_devices WHERE site_id = ? AND ip = ? LIMIT 1")
            .bind(&site.site_id)
            .bind(&from_ip)
            .fetch_optional(&state.db)
            .await?;
    let varbinds: Vec<_> = trap.varbinds.into_iter().take(64).collect();
    let id = rustrmm_common::new_id();
    sqlx::query(
        "INSERT INTO snmp_traps (id, site_id, probe_device_id, snmp_device_id, from_ip, at, version, oid, varbinds, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&site.site_id)
    .bind(&probe.id)
    .bind(device.as_ref().map(|d| &d.0))
    .bind(&from_ip)
    .bind(at)
    .bind(trap.version.chars().take(8).collect::<String>())
    .bind(&oid)
    .bind(serde_json::to_string(&varbinds)?)
    .bind(now)
    .execute(&state.db)
    .await?;

    let rules: Vec<RuleRow> = sqlx::query_as(RULE_SELECT).fetch_all(&state.db).await?;
    if let Some(rule) = best_rule(&rules, &site.site_id, &oid) {
        let source = device
            .as_ref()
            .map(|d| d.1.clone())
            .unwrap_or_else(|| from_ip.clone());
        let prefix = rule.oid_prefix.trim_matches('.').to_string();
        let check_id = match &device {
            Some(_) => format!("snmp:trap:{prefix}"),
            None => format!("snmp:trap:{prefix}:{from_ip}"),
        };
        let title = if rule.title.trim().is_empty() {
            format!("{}: {}", source, rule.name)
        } else {
            format!("{source}: {}", rule.title.trim())
        };
        let detail: Vec<String> = varbinds
            .iter()
            .take(8)
            .map(|v| {
                format!(
                    "{} = {}",
                    v.oid,
                    match &v.value {
                        Value::String(s) => s.chars().take(120).collect::<String>(),
                        other => other.to_string(),
                    }
                )
            })
            .collect();
        let alert_id = alerting::raise(
            state,
            SnmpRaise {
                snmp_device_id: device.as_ref().map(|d| d.0.clone()),
                client_id: site.client_id.clone(),
                site_id: site.site_id.clone(),
                check_id,
                check_type: "trap".into(),
                severity: rule.severity.clone(),
                title,
                message: format!(
                    "Trap {oid} from {from_ip} matched rule {}. {}",
                    rule.name,
                    detail.join("; ")
                ),
                repeat: true,
            },
        )
        .await?;
        sqlx::query("UPDATE snmp_traps SET rule_id = ?, alert_id = ? WHERE id = ?")
            .bind(&rule.id)
            .bind(&alert_id)
            .bind(&id)
            .execute(&state.db)
            .await?;
    }
    state.events.publish(
        "snmp.trap",
        Some(site.client_id.clone()),
        json!({ "id": id, "site_id": site.site_id, "oid": oid, "from_ip": from_ip }),
    );
    Ok(())
}

// ------------------------------------------------------------------ API: traps

#[derive(Deserialize)]
pub struct TrapQuery {
    site_id: Option<String>,
    limit: Option<i64>,
}

#[derive(sqlx::FromRow)]
struct TrapRow {
    id: String,
    site_id: String,
    client_id: String,
    snmp_device_id: Option<String>,
    snmp_device_name: Option<String>,
    from_ip: String,
    at: DateTime<Utc>,
    version: String,
    oid: String,
    varbinds: String,
    rule_id: Option<String>,
    alert_id: Option<String>,
}

/// `GET /api/v1/network/snmp/traps?site_id=&limit=`
#[utoipa::path(get, path = "/api/v1/network/snmp/traps", tag = "Network", summary = "List traps", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<TrapQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::NETWORK_VIEW)?;
    let limit = q.limit.unwrap_or(100).clamp(1, 1000);
    let mut qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
        "SELECT t.id, t.site_id, s.client_id, t.snmp_device_id, sd.name AS snmp_device_name, t.from_ip, t.at, t.version, t.oid,
                t.varbinds, t.rule_id, t.alert_id
         FROM snmp_traps t JOIN sites s ON s.id = t.site_id LEFT JOIN snmp_devices sd ON sd.id = t.snmp_device_id WHERE 1 = 1",
    );
    if let Some(site) = q.site_id.as_deref().filter(|s| !s.is_empty()) {
        qb.push(" AND t.site_id = ").push_bind(site.to_string());
    }
    qb.push(" ORDER BY t.at DESC, t.id DESC LIMIT ")
        .push_bind(limit * 4);
    let rows: Vec<TrapRow> = qb.build_query_as().fetch_all(&state.db).await?;
    let items: Vec<Value> = rows
        .iter()
        .filter(|r| ctx.scope.can_site(perm::NETWORK_VIEW, &r.client_id, &r.site_id))
        .take(limit as usize)
        .map(|r| {
            json!({
                "id": r.id, "site_id": r.site_id, "snmp_device_id": r.snmp_device_id,
                "snmp_device_name": r.snmp_device_name, "from_ip": r.from_ip, "at": r.at, "version": r.version,
                "oid": r.oid, "varbinds": serde_json::from_str::<Value>(&r.varbinds).unwrap_or_else(|_| json!([])),
                "rule_id": r.rule_id, "alert_id": r.alert_id,
            })
        })
        .collect();
    Ok(Json(json!({ "items": items })))
}

// ------------------------------------------------------------------ API: trap rules

/// `GET /api/v1/network/snmp/trap-rules`
#[utoipa::path(get, path = "/api/v1/network/snmp/trap-rules", tag = "Network", summary = "List rules", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list_rules(State(state): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<Value>> {
    ctx.require(perm::NETWORK_VIEW)?;
    let rows: Vec<RuleRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{RULE_SELECT} ORDER BY name COLLATE NOCASE"
    )))
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        json!({ "items": rows.iter().map(RuleRow::to_json).collect::<Vec<_>>() }),
    ))
}

#[derive(Deserialize)]
pub struct RuleBody {
    name: String,
    #[serde(default = "yes")]
    enabled: bool,
    oid_prefix: String,
    #[serde(default = "warning")]
    severity: String,
    #[serde(default)]
    site_ids: Vec<String>,
    #[serde(default)]
    title: String,
}

fn yes() -> bool {
    true
}

fn warning() -> String {
    "warning".into()
}

async fn check_rule(db: &Db, body: &mut RuleBody) -> ApiResult<()> {
    body.name = body.name.trim().to_string();
    if body.name.is_empty() || body.name.chars().count() > 120 {
        return Err(ApiError::validation("Name must be 1–120 characters"));
    }
    body.oid_prefix = body.oid_prefix.trim().trim_matches('.').to_string();
    if !super::templates::valid_oid(&body.oid_prefix) {
        return Err(ApiError::validation(
            "oid_prefix must be a numeric OID like 1.3.6.1.6.3.1.1.5",
        ));
    }
    if !["info", "warning", "critical"].contains(&body.severity.as_str()) {
        return Err(ApiError::validation(
            "severity must be info, warning or critical",
        ));
    }
    if body.title.chars().count() > 200 {
        return Err(ApiError::validation("title: at most 200 characters"));
    }
    body.site_ids.dedup();
    if body.site_ids.len() > 200 {
        return Err(ApiError::validation("site_ids: at most 200 sites"));
    }
    for site in &body.site_ids {
        let found: Option<String> = sqlx::query_scalar("SELECT id FROM sites WHERE id = ?")
            .bind(site)
            .fetch_optional(db)
            .await?;
        if found.is_none() {
            return Err(ApiError::validation(format!("Unknown site {site}")));
        }
    }
    Ok(())
}

async fn load_rule(db: &Db, id: &str) -> ApiResult<RuleRow> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!("{RULE_SELECT} WHERE id = ?")))
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| ApiError::not_found("Trap rule"))
}

/// `POST /api/v1/network/snmp/trap-rules`
#[utoipa::path(post, path = "/api/v1/network/snmp/trap-rules", tag = "Network", summary = "Create rule", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn create_rule(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(mut body): Json<RuleBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    ctx.require_global(perm::NETWORK_MANAGE)?;
    check_rule(&state.db, &mut body).await?;
    let id = rustrmm_common::new_id();
    let now = rustrmm_common::now();
    sqlx::query("INSERT INTO trap_rules (id, name, enabled, oid_prefix, severity, site_ids, title, created_by, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&id)
        .bind(&body.name)
        .bind(body.enabled)
        .bind(&body.oid_prefix)
        .bind(&body.severity)
        .bind(serde_json::to_string(&body.site_ids)?)
        .bind(body.title.trim())
        .bind(&ctx.user.id)
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("snmp.trap_rule_created")
                .target("trap_rule", &id, &body.name),
        )
        .await;
    Ok((
        StatusCode::CREATED,
        Json(load_rule(&state.db, &id).await?.to_json()),
    ))
}

/// `PUT /api/v1/network/snmp/trap-rules/{id}`
#[utoipa::path(put, path = "/api/v1/network/snmp/trap-rules/{id}", tag = "Network", summary = "Update rule", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn update_rule(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(mut body): Json<RuleBody>,
) -> ApiResult<Json<Value>> {
    ctx.require_global(perm::NETWORK_MANAGE)?;
    load_rule(&state.db, &id).await?;
    check_rule(&state.db, &mut body).await?;
    sqlx::query("UPDATE trap_rules SET name = ?, enabled = ?, oid_prefix = ?, severity = ?, site_ids = ?, title = ?, updated_at = ? WHERE id = ?")
        .bind(&body.name)
        .bind(body.enabled)
        .bind(&body.oid_prefix)
        .bind(&body.severity)
        .bind(serde_json::to_string(&body.site_ids)?)
        .bind(body.title.trim())
        .bind(rustrmm_common::now())
        .bind(&id)
        .execute(&state.db)
        .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("snmp.trap_rule_updated")
                .target("trap_rule", &id, &body.name),
        )
        .await;
    Ok(Json(load_rule(&state.db, &id).await?.to_json()))
}

/// `DELETE /api/v1/network/snmp/trap-rules/{id}`
#[utoipa::path(delete, path = "/api/v1/network/snmp/trap-rules/{id}", tag = "Network", summary = "Delete rule", params(("id" = String, Path)), responses((status = 204, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn delete_rule(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    ctx.require_global(perm::NETWORK_MANAGE)?;
    let rule = load_rule(&state.db, &id).await?;
    sqlx::query("DELETE FROM trap_rules WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("snmp.trap_rule_deleted")
                .target("trap_rule", &id, &rule.name),
        )
        .await;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(id: &str, prefix: &str, sites: &[&str]) -> RuleRow {
        RuleRow {
            id: id.into(),
            name: id.into(),
            enabled: true,
            oid_prefix: prefix.into(),
            severity: "warning".into(),
            site_ids: serde_json::to_string(sites).expect("json"),
            title: String::new(),
            created_at: rustrmm_common::now(),
            updated_at: rustrmm_common::now(),
        }
    }

    #[test]
    fn trap_rules_match_by_oid_prefix() {
        assert!(oid_matches("1.3.6.1.6.3.1.1.5", "1.3.6.1.6.3.1.1.5.3"));
        assert!(oid_matches(".1.3.6.1.6.3.1.1.5.", "1.3.6.1.6.3.1.1.5"));
        assert!(
            !oid_matches("1.3.6.1.6.3.1.1.5", "1.3.6.1.6.3.1.1.50"),
            "arc boundary"
        );
        assert!(!oid_matches("", "1.3.6"));
        let rules = vec![
            rule("generic", "1.3.6.1.6.3.1.1.5", &[]),
            rule("link-down", "1.3.6.1.6.3.1.1.5.3", &[]),
            rule("other-site", "1.3.6.1.6.3.1.1.5.3.1", &["site-b"]),
        ];
        assert_eq!(
            best_rule(&rules, "site-a", "1.3.6.1.6.3.1.1.5.3").map(|r| r.id.as_str()),
            Some("link-down")
        );
        assert_eq!(
            best_rule(&rules, "site-a", "1.3.6.1.6.3.1.1.5.4").map(|r| r.id.as_str()),
            Some("generic")
        );
        assert_eq!(
            best_rule(&rules, "site-b", "1.3.6.1.6.3.1.1.5.3.1").map(|r| r.id.as_str()),
            Some("other-site")
        );
        assert!(best_rule(&rules, "site-a", "1.3.6.1.4.1.9.9.41.2").is_none());
    }
}
