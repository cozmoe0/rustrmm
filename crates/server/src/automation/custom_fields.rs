//! Custom fields: typed extra values on devices, clients and sites. Scripts can write device
//! fields marked `script_writable` through `::rustrmm::set-field` directives.

use std::collections::{BTreeMap, HashMap};

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::auth::AuthCtx;
use crate::db::Db;
use crate::error::{ApiError, ApiResult};
use crate::rbac::perm;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct CustomField {
    pub id: String,
    pub key: String,
    pub name: String,
    pub description: String,
    #[serde(rename = "type")]
    #[sqlx(rename = "type")]
    pub kind: String,
    #[serde(serialize_with = "json_text")]
    pub options: String,
    pub scope: String,
    pub script_writable: bool,
    pub created_at: DateTime<Utc>,
}

fn json_text<S: serde::Serializer>(raw: &str, s: S) -> Result<S::Ok, S::Error> {
    serde_json::from_str::<Value>(raw)
        .unwrap_or(Value::Array(vec![]))
        .serialize(s)
}

const COLUMNS: &str =
    "id, key, name, description, type, options, scope, script_writable, created_at";

impl CustomField {
    fn options(&self) -> Vec<String> {
        serde_json::from_str(&self.options).unwrap_or_default()
    }

    /// Validates a value against the field type and returns its normalised JSON form.
    pub fn normalise(&self, value: &Value) -> Result<Value, String> {
        match (self.kind.as_str(), value) {
            ("text", Value::String(s)) if s.chars().count() <= 1000 => Ok(json!(s)),
            ("text", Value::Number(n)) => Ok(json!(n.to_string())),
            ("text", _) => Err("must be text of at most 1000 characters".into()),
            ("number", Value::Number(n)) => Ok(Value::Number(n.clone())),
            ("number", Value::String(s)) => s
                .trim()
                .parse::<f64>()
                .ok()
                .filter(|f| f.is_finite())
                .and_then(serde_json::Number::from_f64)
                .map(Value::Number)
                .ok_or_else(|| "must be a number".into()),
            ("number", _) => Err("must be a number".into()),
            ("boolean", Value::Bool(b)) => Ok(json!(b)),
            ("boolean", Value::String(s)) => match s.trim().to_ascii_lowercase().as_str() {
                "true" | "yes" | "1" => Ok(json!(true)),
                "false" | "no" | "0" => Ok(json!(false)),
                _ => Err("must be true or false".into()),
            },
            ("boolean", _) => Err("must be true or false".into()),
            ("date", Value::String(s)) => super::rules::parse_date(s)
                .map(|d| json!(d.format("%Y-%m-%d").to_string()))
                .ok_or_else(|| "must be a date (YYYY-MM-DD)".into()),
            ("date", _) => Err("must be a date (YYYY-MM-DD)".into()),
            ("select", Value::String(s)) if self.options().contains(s) => Ok(json!(s)),
            ("select", _) => Err("must be one of the field's options".into()),
            _ => Err("unsupported field type".into()),
        }
    }
}

fn valid_key(key: &str) -> bool {
    let mut chars = key.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_lowercase())
        && key.len() <= 48
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

pub async fn load_all(db: &Db, scope: Option<&str>) -> anyhow::Result<Vec<CustomField>> {
    let rows =
        match scope {
            Some(scope) => sqlx::query_as(sqlx::AssertSqlSafe(format!(
                "SELECT {COLUMNS} FROM custom_fields WHERE scope = ? ORDER BY name COLLATE NOCASE"
            )))
            .bind(scope)
            .fetch_all(db)
            .await?,
            None => {
                sqlx::query_as(sqlx::AssertSqlSafe(format!(
                    "SELECT {COLUMNS} FROM custom_fields ORDER BY scope, name COLLATE NOCASE"
                )))
                .fetch_all(db)
                .await?
            }
        };
    Ok(rows)
}

async fn load_one(db: &Db, id: &str) -> ApiResult<CustomField> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {COLUMNS} FROM custom_fields WHERE id = ?"
    )))
    .bind(id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| ApiError::not_found("Custom field"))
}

/// `custom_fields: { key: value }` for many devices (used by the device list and detail).
pub async fn device_values(
    db: &Db,
) -> anyhow::Result<HashMap<String, serde_json::Map<String, Value>>> {
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT v.entity_id, f.key, v.value FROM custom_field_values v JOIN custom_fields f ON f.id = v.field_id
         WHERE f.scope = 'device'",
    )
    .fetch_all(db)
    .await?;
    let mut out: HashMap<String, serde_json::Map<String, Value>> = HashMap::new();
    for (device, key, value) in rows {
        if let Ok(v) = serde_json::from_str(&value) {
            out.entry(device).or_default().insert(key, v);
        }
    }
    Ok(out)
}

/// `custom_fields` for one entity.
pub async fn entity_values(
    db: &Db,
    entity_id: &str,
) -> anyhow::Result<serde_json::Map<String, Value>> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT f.key, v.value FROM custom_field_values v JOIN custom_fields f ON f.id = v.field_id WHERE v.entity_id = ?",
    )
    .bind(entity_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(k, v)| serde_json::from_str(&v).ok().map(|v| (k, v)))
        .collect())
}

async fn store(
    db: &Db,
    field_id: &str,
    entity_id: &str,
    value: Option<&Value>,
    updated_by: &str,
) -> anyhow::Result<()> {
    match value {
        None => {
            sqlx::query("DELETE FROM custom_field_values WHERE field_id = ? AND entity_id = ?")
                .bind(field_id)
                .bind(entity_id)
                .execute(db)
                .await?;
        }
        Some(v) => {
            sqlx::query(
                "INSERT INTO custom_field_values (field_id, entity_id, value, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (field_id, entity_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at,
                 updated_by = excluded.updated_by",
            )
            .bind(field_id)
            .bind(entity_id)
            .bind(serde_json::to_string(v)?)
            .bind(rustrmm_common::now())
            .bind(updated_by)
            .execute(db)
            .await?;
        }
    }
    Ok(())
}

/// Applies a `set-field` directive for a device. An empty value clears the field. Returns why
/// the directive was refused.
pub async fn apply_directive(
    state: &AppState,
    device_id: &str,
    key: &str,
    raw: &str,
    job_name: &str,
) -> Result<Option<Value>, String> {
    let field: Option<CustomField> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {COLUMNS} FROM custom_fields WHERE key = ?"
    )))
    .bind(key)
    .fetch_optional(&state.db)
    .await
    .map_err(|_| "database error".to_string())?;
    let field = field.ok_or_else(|| format!("no custom field named '{key}'"))?;
    if field.scope != "device" {
        return Err(format!("'{key}' is not a device field"));
    }
    if !field.script_writable {
        return Err(format!("'{key}' cannot be written by scripts"));
    }
    let value = if raw.is_empty() {
        None
    } else {
        Some(field.normalise(&Value::String(raw.to_string()))?)
    };
    store(&state.db, &field.id, device_id, value.as_ref(), "script")
        .await
        .map_err(|_| "database error".to_string())?;
    let summary = match &value {
        Some(v) => format!("{} set to {} by {job_name}", field.name, display(v)),
        None => format!("{} cleared by {job_name}", field.name),
    };
    let _ = crate::agents::timeline(
        &state.db,
        device_id,
        "custom_field.changed",
        "info",
        &summary,
        json!({ "field": key, "value": value, "source": "script", "job": job_name }),
    )
    .await;
    Ok(value)
}

fn display(v: &Value) -> String {
    match v {
        Value::String(s) => s.chars().take(80).collect(),
        other => other.to_string(),
    }
}

// ------------------------------------------------------------------ definitions API

#[derive(Deserialize)]
pub struct ListQuery {
    scope: Option<String>,
}

/// `GET /api/v1/custom-fields?scope=`
pub async fn list(
    State(state): State<AppState>,
    _ctx: AuthCtx,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    let scope = q.scope.as_deref().filter(|s| !s.is_empty());
    Ok(Json(json!({ "items": load_all(&state.db, scope).await? })))
}

#[derive(Deserialize)]
pub struct FieldBody {
    #[serde(default)]
    key: Option<String>,
    name: String,
    #[serde(default)]
    description: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    options: Vec<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    script_writable: bool,
}

fn validate_body(body: &FieldBody) -> ApiResult<(String, String, Vec<String>)> {
    let name = body.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(ApiError::validation("Name must be 1–80 characters"));
    }
    if body.description.chars().count() > 1000 {
        return Err(ApiError::validation("Description is too long"));
    }
    if !matches!(
        body.kind.as_str(),
        "text" | "number" | "boolean" | "date" | "select"
    ) {
        return Err(ApiError::validation(
            "type must be text, number, boolean, date or select",
        ));
    }
    let options: Vec<String> = if body.kind == "select" {
        let options: Vec<String> = body
            .options
            .iter()
            .map(|o| o.trim().to_string())
            .filter(|o| !o.is_empty())
            .collect();
        if options.is_empty()
            || options.len() > 100
            || options.iter().any(|o| o.chars().count() > 200)
        {
            return Err(ApiError::validation(
                "Select fields need 1–100 options of at most 200 characters",
            ));
        }
        options
    } else {
        Vec::new()
    };
    Ok((name, body.description.trim().to_string(), options))
}

/// `POST /api/v1/custom-fields`
pub async fn create(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(body): Json<FieldBody>,
) -> ApiResult<(StatusCode, Json<CustomField>)> {
    ctx.require_global(perm::SETTINGS_MANAGE)?;
    let (name, description, options) = validate_body(&body)?;
    let key = body.key.clone().unwrap_or_default().trim().to_string();
    if !valid_key(&key) {
        return Err(ApiError::validation("key must match [a-z][a-z0-9_]{0,47}"));
    }
    let scope = body.scope.clone().unwrap_or_default();
    if !matches!(scope.as_str(), "device" | "client" | "site") {
        return Err(ApiError::validation("scope must be device, client or site"));
    }
    if body.script_writable && scope != "device" {
        return Err(ApiError::validation(
            "Only device fields can be written by scripts",
        ));
    }
    let id = rustrmm_common::new_id();
    let now = rustrmm_common::now();
    sqlx::query("INSERT INTO custom_fields (id, key, name, description, type, options, scope, script_writable, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&id)
        .bind(&key)
        .bind(&name)
        .bind(&description)
        .bind(&body.kind)
        .bind(serde_json::to_string(&options)?)
        .bind(&scope)
        .bind(body.script_writable)
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("custom_field.created")
                .target("custom_field", &id, &key)
                .details(json!({ "type": body.kind, "scope": scope })),
        )
        .await;
    Ok((StatusCode::CREATED, Json(load_one(&state.db, &id).await?)))
}

/// `PUT /api/v1/custom-fields/{id}` — key and scope cannot change.
pub async fn update(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(body): Json<FieldBody>,
) -> ApiResult<Json<CustomField>> {
    ctx.require_global(perm::SETTINGS_MANAGE)?;
    let current = load_one(&state.db, &id).await?;
    let (name, description, options) = validate_body(&body)?;
    if body.key.as_deref().is_some_and(|k| k.trim() != current.key) {
        return Err(ApiError::validation("A custom field's key cannot change"));
    }
    if body.scope.as_deref().is_some_and(|s| s != current.scope) {
        return Err(ApiError::validation("A custom field's scope cannot change"));
    }
    if body.script_writable && current.scope != "device" {
        return Err(ApiError::validation(
            "Only device fields can be written by scripts",
        ));
    }
    if body.kind != current.kind {
        let used: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM custom_field_values WHERE field_id = ?")
                .bind(&id)
                .fetch_one(&state.db)
                .await?;
        if used > 0 {
            return Err(ApiError::validation(
                "The type of a field that already holds values cannot change",
            ));
        }
    }
    sqlx::query("UPDATE custom_fields SET name = ?, description = ?, type = ?, options = ?, script_writable = ?, updated_at = ? WHERE id = ?")
        .bind(&name)
        .bind(&description)
        .bind(&body.kind)
        .bind(serde_json::to_string(&options)?)
        .bind(body.script_writable)
        .bind(rustrmm_common::now())
        .bind(&id)
        .execute(&state.db)
        .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("custom_field.updated")
                .target("custom_field", &id, &current.key),
        )
        .await;
    Ok(Json(load_one(&state.db, &id).await?))
}

/// `DELETE /api/v1/custom-fields/{id}` (step-up) — deletes stored values too.
pub async fn delete(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    ctx.require_global(perm::SETTINGS_MANAGE)?;
    ctx.require_step_up()?;
    let current = load_one(&state.db, &id).await?;
    sqlx::query("DELETE FROM custom_fields WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("custom_field.deleted")
                .target("custom_field", &id, &current.key),
        )
        .await;
    Ok(StatusCode::NO_CONTENT)
}

// ------------------------------------------------------------------ values API

#[derive(Clone, Copy)]
enum Entity {
    Device,
    Client,
    Site,
}

impl Entity {
    fn scope(self) -> &'static str {
        match self {
            Self::Device => "device",
            Self::Client => "client",
            Self::Site => "site",
        }
    }
}

struct EntityRef {
    name: String,
    client_id: String,
    site_id: Option<String>,
}

/// Loads the entity and checks the caller's permission on it (`manage` = write access).
async fn entity(
    state: &AppState,
    ctx: &AuthCtx,
    kind: Entity,
    id: &str,
    manage: bool,
) -> ApiResult<EntityRef> {
    match kind {
        Entity::Device => {
            let row: Option<(String, String, String)> = sqlx::query_as(
                "SELECT d.hostname, s.client_id, d.site_id FROM devices d JOIN sites s ON s.id = d.site_id WHERE d.id = ?",
            )
            .bind(id)
            .fetch_optional(&state.db)
            .await?;
            let (name, client_id, site_id) = row.ok_or_else(|| ApiError::not_found("Device"))?;
            if !ctx.scope.can_site(perm::DEVICES_VIEW, &client_id, &site_id) {
                return Err(ApiError::not_found("Device"));
            }
            if manage
                && !ctx
                    .scope
                    .can_site(perm::DEVICES_MANAGE, &client_id, &site_id)
            {
                return Err(ApiError::forbidden("Missing permission: devices.manage"));
            }
            Ok(EntityRef {
                name,
                client_id,
                site_id: Some(site_id),
            })
        }
        Entity::Client => {
            let name: Option<String> = sqlx::query_scalar("SELECT name FROM clients WHERE id = ?")
                .bind(id)
                .fetch_optional(&state.db)
                .await?;
            let name = name.ok_or_else(|| ApiError::not_found("Client"))?;
            if !ctx.scope.can_see_client(perm::CLIENTS_VIEW, id) {
                return Err(ApiError::not_found("Client"));
            }
            if manage && !ctx.scope.can_client(perm::CLIENTS_MANAGE, id) {
                return Err(ApiError::forbidden("Missing permission: clients.manage"));
            }
            Ok(EntityRef {
                name,
                client_id: id.to_string(),
                site_id: None,
            })
        }
        Entity::Site => {
            let row: Option<(String, String)> =
                sqlx::query_as("SELECT name, client_id FROM sites WHERE id = ?")
                    .bind(id)
                    .fetch_optional(&state.db)
                    .await?;
            let (name, client_id) = row.ok_or_else(|| ApiError::not_found("Site"))?;
            if !ctx.scope.can_site(perm::CLIENTS_VIEW, &client_id, id) {
                return Err(ApiError::not_found("Site"));
            }
            if manage && !ctx.scope.can_site(perm::CLIENTS_MANAGE, &client_id, id) {
                return Err(ApiError::forbidden("Missing permission: clients.manage"));
            }
            Ok(EntityRef {
                name,
                client_id,
                site_id: Some(id.to_string()),
            })
        }
    }
}

async fn values_doc(state: &AppState, kind: Entity, id: &str) -> ApiResult<Value> {
    let fields = load_all(&state.db, Some(kind.scope())).await?;
    let rows: Vec<(String, String, DateTime<Utc>, String)> = sqlx::query_as(
        "SELECT field_id, value, updated_at, updated_by FROM custom_field_values WHERE entity_id = ?",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    let by_field: HashMap<String, (Value, DateTime<Utc>, String)> = rows
        .into_iter()
        .map(|(f, v, at, by)| (f, (serde_json::from_str(&v).unwrap_or(Value::Null), at, by)))
        .collect();
    let items: Vec<Value> = fields
        .into_iter()
        .map(|field| {
            let stored = by_field.get(&field.id);
            json!({
                "value": stored.map(|s| s.0.clone()).unwrap_or(Value::Null),
                "updated_at": stored.map(|s| s.1),
                "updated_by": stored.map(|s| s.2.clone()),
                "field": field,
            })
        })
        .collect();
    Ok(json!({ "items": items }))
}

#[derive(Deserialize)]
pub struct ValuesBody {
    values: BTreeMap<String, Value>,
}

async fn put_values(
    state: &AppState,
    ctx: &AuthCtx,
    kind: Entity,
    id: &str,
    body: ValuesBody,
) -> ApiResult<Value> {
    let target = entity(state, ctx, kind, id, true).await?;
    let fields: HashMap<String, CustomField> = load_all(&state.db, Some(kind.scope()))
        .await?
        .into_iter()
        .map(|f| (f.key.clone(), f))
        .collect();
    if body.values.len() > 200 {
        return Err(ApiError::validation("Too many values in one request"));
    }
    let mut normalised = Vec::new();
    for (key, value) in &body.values {
        let field = fields.get(key).ok_or_else(|| {
            ApiError::validation(format!("Unknown {} field '{key}'", kind.scope()))
                .with_details(json!({ "field": key }))
        })?;
        let value = if value.is_null() {
            None
        } else {
            Some(field.normalise(value).map_err(|e| {
                ApiError::validation(format!("{}: {e}", field.name))
                    .with_details(json!({ "field": key }))
            })?)
        };
        normalised.push((field, value));
    }
    for (field, value) in &normalised {
        store(&state.db, &field.id, id, value.as_ref(), &ctx.user.name).await?;
        if matches!(kind, Entity::Device) {
            let summary = match value {
                Some(v) => format!("{} set to {} by {}", field.name, display(v), ctx.user.name),
                None => format!("{} cleared by {}", field.name, ctx.user.name),
            };
            crate::agents::timeline(
                &state.db,
                id,
                "custom_field.changed",
                "info",
                &summary,
                json!({ "field": field.key, "value": value, "source": "user" }),
            )
            .await?;
        }
    }
    let mut entry = ctx
        .audit("custom_field.values_updated")
        .target(
            match kind {
                Entity::Device => "device",
                Entity::Client => "client",
                Entity::Site => "site",
            },
            id,
            &target.name,
        )
        .client(&target.client_id)
        .details(json!({ "fields": body.values.keys().collect::<Vec<_>>() }));
    if let Some(site) = &target.site_id {
        entry = entry.site(site);
    }
    state.audit.record_or_log(&state.db, entry).await;
    if matches!(kind, Entity::Device) {
        state.events.publish(
            "devices.changed",
            Some(target.client_id.clone()),
            json!({ "id": id }),
        );
    }
    values_doc(state, kind, id).await
}

/// `GET /api/v1/devices/{id}/custom-fields`
pub async fn device_get(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    entity(&state, &ctx, Entity::Device, &id, false).await?;
    Ok(Json(values_doc(&state, Entity::Device, &id).await?))
}

/// `PUT /api/v1/devices/{id}/custom-fields`
pub async fn device_put(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(body): Json<ValuesBody>,
) -> ApiResult<Json<Value>> {
    Ok(Json(
        put_values(&state, &ctx, Entity::Device, &id, body).await?,
    ))
}

/// `GET /api/v1/clients/{id}/custom-fields`
pub async fn client_get(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    entity(&state, &ctx, Entity::Client, &id, false).await?;
    Ok(Json(values_doc(&state, Entity::Client, &id).await?))
}

/// `PUT /api/v1/clients/{id}/custom-fields`
pub async fn client_put(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(body): Json<ValuesBody>,
) -> ApiResult<Json<Value>> {
    Ok(Json(
        put_values(&state, &ctx, Entity::Client, &id, body).await?,
    ))
}

/// `GET /api/v1/sites/{id}/custom-fields`
pub async fn site_get(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    entity(&state, &ctx, Entity::Site, &id, false).await?;
    Ok(Json(values_doc(&state, Entity::Site, &id).await?))
}

/// `PUT /api/v1/sites/{id}/custom-fields`
pub async fn site_put(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(body): Json<ValuesBody>,
) -> ApiResult<Json<Value>> {
    Ok(Json(
        put_values(&state, &ctx, Entity::Site, &id, body).await?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(kind: &str) -> CustomField {
        CustomField {
            id: "f".into(),
            key: "k".into(),
            name: "K".into(),
            description: String::new(),
            kind: kind.into(),
            options: r#"["gold","silver"]"#.into(),
            scope: "device".into(),
            script_writable: true,
            created_at: rustrmm_common::now(),
        }
    }

    #[test]
    fn values_are_validated_per_type() {
        assert_eq!(field("number").normalise(&json!("42.5")), Ok(json!(42.5)));
        assert!(field("number").normalise(&json!("lots")).is_err());
        assert_eq!(field("boolean").normalise(&json!("yes")), Ok(json!(true)));
        assert_eq!(
            field("date").normalise(&json!("2027-03-01T10:00:00Z")),
            Ok(json!("2027-03-01"))
        );
        assert!(field("date").normalise(&json!("tomorrow")).is_err());
        assert_eq!(field("select").normalise(&json!("gold")), Ok(json!("gold")));
        assert!(field("select").normalise(&json!("bronze")).is_err());
        assert!(field("text").normalise(&json!("x".repeat(1001))).is_err());
        assert!(valid_key("asset_tag"));
        assert!(!valid_key("Asset"));
        assert!(!valid_key("1x"));
    }
}
