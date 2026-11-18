//! Notification channels: e-mail, Slack, Teams, Discord, ntfy and signed webhooks. Configs are
//! stored field-encrypted (AAD `notification_channels/config/<id>`), and secret fields are
//! write-only.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::auth::AuthCtx;
use crate::error::{ApiError, ApiResult};
use crate::monitoring::settings::{SECRET_PLACEHOLDER, valid_email};
use crate::rbac::perm;
use crate::state::AppState;

pub const KINDS: &[&str] = &["email", "slack", "teams", "discord", "ntfy", "webhook"];
/// Headers a webhook channel may not set.
const FORBIDDEN_HEADERS: &[&str] = &[
    "host",
    "content-length",
    "content-type",
    "transfer-encoding",
    "connection",
    "upgrade",
    "te",
    "trailer",
    "keep-alive",
    "proxy-authorization",
    "proxy-connection",
    "x-rustrmm-signature",
];

pub fn aad(id: &str) -> String {
    format!("notification_channels/config/{id}")
}

/// Secret fields of a kind (write-only; returned as the placeholder).
pub fn secret_fields(kind: &str) -> &'static [&'static str] {
    match kind {
        "slack" | "teams" | "discord" => &["webhook_url"],
        "ntfy" => &["token"],
        "webhook" => &["secret", "headers"],
        _ => &[],
    }
}

#[derive(Debug, Clone)]
pub struct Channel {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub enabled: bool,
    pub config: Map<String, Value>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(sqlx::FromRow)]
struct ChannelRow {
    id: String,
    name: String,
    kind: String,
    enabled: bool,
    config: Vec<u8>,
    last_used_at: Option<DateTime<Utc>>,
    last_error: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

const SELECT: &str = "SELECT id, name, kind, enabled, config, last_used_at, last_error, created_at, updated_at FROM notification_channels";

fn decrypt(state: &AppState, row: ChannelRow) -> anyhow::Result<Channel> {
    let text = state.cipher.decrypt_string(&row.config, &aad(&row.id))?;
    let config: Map<String, Value> = serde_json::from_str(&text)?;
    Ok(Channel {
        id: row.id,
        name: row.name,
        kind: row.kind,
        enabled: row.enabled,
        config,
        last_used_at: row.last_used_at,
        last_error: row.last_error,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

pub async fn load(state: &AppState, id: &str) -> anyhow::Result<Option<Channel>> {
    let row: Option<ChannelRow> =
        sqlx::query_as(sqlx::AssertSqlSafe(format!("{SELECT} WHERE id = ?")))
            .bind(id)
            .fetch_optional(&state.db)
            .await?;
    row.map(|r| decrypt(state, r)).transpose()
}

async fn load_api(state: &AppState, id: &str) -> ApiResult<Channel> {
    load(state, id)
        .await?
        .ok_or_else(|| ApiError::not_found("Notification channel"))
}

impl Channel {
    /// The channel as the API returns it: secret fields replaced by the placeholder.
    pub fn public(&self) -> Value {
        let mut config = self.config.clone();
        for field in secret_fields(&self.kind) {
            match config.get_mut(*field) {
                Some(Value::Object(headers)) => {
                    for value in headers.values_mut() {
                        *value = json!(SECRET_PLACEHOLDER);
                    }
                }
                Some(v) if !v.is_null() => *v = json!(SECRET_PLACEHOLDER),
                _ => {}
            }
        }
        json!({
            "id": self.id, "name": self.name, "kind": self.kind, "enabled": self.enabled,
            "config": config, "last_used_at": self.last_used_at, "last_error": self.last_error,
            "created_at": self.created_at, "updated_at": self.updated_at,
        })
    }
}

fn http_url(value: &str, field: &str) -> ApiResult<String> {
    let v = value.trim();
    match url::Url::parse(v) {
        Ok(u)
            if matches!(u.scheme(), "http" | "https")
                && u.host_str().is_some()
                && v.len() <= 2048 =>
        {
            Ok(v.to_string())
        }
        _ => Err(
            ApiError::validation(format!("config.{field} must be an http(s) URL"))
                .with_details(json!({ "path": format!("config.{field}") })),
        ),
    }
}

fn email_list(v: Option<&Value>, field: &str, required: bool) -> ApiResult<Vec<String>> {
    let list: Vec<String> = match v {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|i| i.as_str().map(|s| s.trim().to_string()))
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| {
                ApiError::validation(format!("config.{field} must be a list of addresses"))
            })?,
        Some(Value::String(s)) => s
            .split([',', ';'])
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        _ => {
            return Err(ApiError::validation(format!(
                "config.{field} must be a list of addresses"
            )));
        }
    };
    if required && list.is_empty() {
        return Err(ApiError::validation(format!(
            "config.{field} needs at least one address"
        )));
    }
    if list.len() > 20 {
        return Err(ApiError::validation(format!(
            "config.{field} holds at most 20 addresses"
        )));
    }
    if let Some(bad) = list.iter().find(|a| !valid_email(a)) {
        return Err(ApiError::validation(format!(
            "config.{field}: '{bad}' is not a valid address"
        )));
    }
    Ok(list)
}

fn header_name_ok(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "!#$%&'*+-.^_`|~".contains(c))
        && !FORBIDDEN_HEADERS.contains(&name.to_ascii_lowercase().as_str())
}

/// Validates a config for a kind, keeping stored secrets the request leaves out (or sends as
/// the placeholder).
pub fn normalize(
    kind: &str,
    input: &Map<String, Value>,
    existing: Option<&Map<String, Value>>,
) -> ApiResult<Map<String, Value>> {
    let keep = |field: &str| -> Option<Value> {
        match input.get(field) {
            None => existing.and_then(|e| e.get(field).cloned()),
            Some(Value::String(s)) if s == SECRET_PLACEHOLDER => {
                existing.and_then(|e| e.get(field).cloned())
            }
            Some(v) => Some(v.clone()),
        }
    };
    let text = |v: Option<Value>| {
        v.and_then(|v| v.as_str().map(|s| s.trim().to_string()))
            .filter(|s| !s.is_empty())
    };
    let mut out = Map::new();
    let allowed: &[&str] = match kind {
        "email" => &["to", "cc"],
        "slack" | "teams" | "discord" => &["webhook_url"],
        "ntfy" => &["server_url", "topic", "token"],
        "webhook" => &["url", "secret", "headers"],
        _ => {
            return Err(ApiError::validation(format!(
                "kind must be one of {}",
                KINDS.join(", ")
            )));
        }
    };
    if let Some(bad) = input.keys().find(|k| !allowed.contains(&k.as_str())) {
        return Err(ApiError::validation(format!(
            "config.{bad} is not a setting of {kind} channels"
        ))
        .with_details(json!({ "path": format!("config.{bad}") })));
    }
    match kind {
        "email" => {
            out.insert("to".into(), json!(email_list(input.get("to"), "to", true)?));
            out.insert(
                "cc".into(),
                json!(email_list(input.get("cc"), "cc", false)?),
            );
        }
        "slack" | "teams" | "discord" => {
            let url = text(keep("webhook_url"))
                .ok_or_else(|| ApiError::validation("config.webhook_url is required"))?;
            out.insert("webhook_url".into(), json!(http_url(&url, "webhook_url")?));
        }
        "ntfy" => {
            let server =
                text(input.get("server_url").cloned()).unwrap_or_else(|| "https://ntfy.sh".into());
            out.insert(
                "server_url".into(),
                json!(http_url(&server, "server_url")?.trim_end_matches('/')),
            );
            let topic = text(input.get("topic").cloned()).unwrap_or_default();
            if topic.is_empty()
                || topic.len() > 64
                || !topic
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            {
                return Err(ApiError::validation(
                    "config.topic must be 1–64 letters, digits, - or _",
                ));
            }
            out.insert("topic".into(), json!(topic));
            if let Some(token) = text(keep("token")) {
                if token.len() > 512 || token.contains(['\r', '\n']) {
                    return Err(ApiError::validation("config.token is invalid"));
                }
                out.insert("token".into(), json!(token));
            }
        }
        "webhook" => {
            let url = text(input.get("url").cloned())
                .ok_or_else(|| ApiError::validation("config.url is required"))?;
            out.insert("url".into(), json!(http_url(&url, "url")?));
            if let Some(secret) = text(keep("secret")) {
                if secret.len() > 512 {
                    return Err(ApiError::validation(
                        "config.secret is at most 512 characters",
                    ));
                }
                out.insert("secret".into(), json!(secret));
            }
            let old_headers = existing
                .and_then(|e| e.get("headers"))
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let headers = match input.get("headers") {
                None => old_headers,
                Some(Value::Null) => Map::new(),
                Some(Value::Object(h)) => {
                    if h.len() > 20 {
                        return Err(ApiError::validation(
                            "config.headers holds at most 20 headers",
                        ));
                    }
                    let mut merged = Map::new();
                    for (name, value) in h {
                        if !header_name_ok(name) {
                            return Err(ApiError::validation(format!(
                                "config.headers: '{name}' is not an allowed header name"
                            )));
                        }
                        let value = match value.as_str() {
                            Some(SECRET_PLACEHOLDER) => old_headers
                                .get(name)
                                .and_then(Value::as_str)
                                .map(str::to_string)
                                .ok_or_else(|| {
                                    ApiError::validation(format!(
                                        "config.headers.{name} needs a value"
                                    ))
                                })?,
                            Some(v) if v.len() <= 1024 && !v.contains(['\r', '\n', '\0']) => {
                                v.to_string()
                            }
                            _ => {
                                return Err(ApiError::validation(format!(
                                    "config.headers.{name} must be text without line breaks"
                                )));
                            }
                        };
                        merged.insert(name.clone(), json!(value));
                    }
                    merged
                }
                Some(_) => return Err(ApiError::validation("config.headers must be an object")),
            };
            if !headers.is_empty() {
                out.insert("headers".into(), Value::Object(headers));
            }
        }
        _ => unreachable!("kind checked above"),
    }
    Ok(out)
}

// ------------------------------------------------------------------ API

#[derive(Deserialize)]
pub struct ChannelBody {
    name: String,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default = "yes")]
    enabled: bool,
    #[serde(default)]
    config: Map<String, Value>,
}

fn yes() -> bool {
    true
}

fn check_name(name: &str) -> ApiResult<String> {
    let name = name.trim().to_string();
    if name.is_empty() || name.chars().count() > 120 {
        return Err(ApiError::validation("Name must be 1–120 characters"));
    }
    Ok(name)
}

/// Audit details: the config without secret values.
fn audit_config(kind: &str, config: &Map<String, Value>) -> Value {
    let mut c = config.clone();
    for field in secret_fields(kind) {
        if c.contains_key(*field) {
            c.insert((*field).to_string(), json!(SECRET_PLACEHOLDER));
        }
    }
    Value::Object(c)
}

/// `GET /api/v1/notification-channels`
pub async fn list(State(state): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<Value>> {
    ctx.require_global(perm::NOTIFICATIONS_MANAGE)?;
    let rows: Vec<ChannelRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{SELECT} ORDER BY name COLLATE NOCASE"
    )))
    .fetch_all(&state.db)
    .await?;
    let mut items = Vec::new();
    for row in rows {
        match decrypt(&state, row) {
            Ok(channel) => items.push(channel.public()),
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), "notification channel could not be decrypted")
            }
        }
    }
    Ok(Json(json!({ "items": items })))
}

/// `POST /api/v1/notification-channels`
pub async fn create(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(body): Json<ChannelBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    ctx.require_global(perm::NOTIFICATIONS_MANAGE)?;
    let name = check_name(&body.name)?;
    let kind = body.kind.clone().unwrap_or_default();
    let config = normalize(&kind, &body.config, None)?;
    let id = rustrmm_common::new_id();
    let now = rustrmm_common::now();
    let blob = state
        .cipher
        .encrypt_str(&Value::Object(config.clone()).to_string(), &aad(&id));
    sqlx::query("INSERT INTO notification_channels (id, name, kind, enabled, config, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&id)
        .bind(&name)
        .bind(&kind)
        .bind(body.enabled)
        .bind(blob)
        .bind(&ctx.user.id)
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("notifications.channel_created")
                .target("notification_channel", &id, &name)
                .details(json!({ "kind": kind, "enabled": body.enabled, "config": audit_config(&kind, &config) })),
        )
        .await;
    Ok((
        StatusCode::CREATED,
        Json(load_api(&state, &id).await?.public()),
    ))
}

/// `PUT /api/v1/notification-channels/{id}` — leave secret fields out to keep them.
pub async fn update(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(body): Json<ChannelBody>,
) -> ApiResult<Json<Value>> {
    ctx.require_global(perm::NOTIFICATIONS_MANAGE)?;
    let current = load_api(&state, &id).await?;
    if body.kind.as_ref().is_some_and(|k| *k != current.kind) {
        return Err(ApiError::validation(
            "kind cannot change; create a new channel",
        ));
    }
    let name = check_name(&body.name)?;
    let config = normalize(&current.kind, &body.config, Some(&current.config))?;
    let blob = state
        .cipher
        .encrypt_str(&Value::Object(config.clone()).to_string(), &aad(&id));
    sqlx::query("UPDATE notification_channels SET name = ?, enabled = ?, config = ?, updated_at = ? WHERE id = ?")
        .bind(&name)
        .bind(body.enabled)
        .bind(blob)
        .bind(rustrmm_common::now())
        .bind(&id)
        .execute(&state.db)
        .await?;
    let secrets_changed: Vec<&str> = secret_fields(&current.kind)
        .iter()
        .copied()
        .filter(|f| current.config.get(*f) != config.get(*f))
        .collect();
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("notifications.channel_updated")
                .target("notification_channel", &id, &name)
                .details(
                    json!({ "enabled": body.enabled, "config": audit_config(&current.kind, &config),
                                 "secrets_changed": secrets_changed }),
                ),
        )
        .await;
    Ok(Json(load_api(&state, &id).await?.public()))
}

/// `DELETE /api/v1/notification-channels/{id}`
pub async fn delete(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    ctx.require_global(perm::NOTIFICATIONS_MANAGE)?;
    let current = load_api(&state, &id).await?;
    sqlx::query("DELETE FROM notification_channels WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    // Rules keep working without the deleted channel.
    for rule in super::rules::load_all(&state.db).await? {
        let uses = rule.channel_ids.contains(&id)
            || rule
                .escalation
                .as_ref()
                .is_some_and(|e| e.channel_ids.contains(&id));
        if !uses {
            continue;
        }
        let channel_ids: Vec<&String> = rule.channel_ids.iter().filter(|c| **c != id).collect();
        let escalation = rule.escalation.clone().map(|mut e| {
            e.channel_ids.retain(|c| *c != id);
            e
        });
        sqlx::query("UPDATE notification_rules SET channel_ids = ?, escalation = ?, updated_at = ? WHERE id = ?")
            .bind(serde_json::to_string(&channel_ids)?)
            .bind(escalation.map(|e| serde_json::to_string(&e)).transpose()?)
            .bind(rustrmm_common::now())
            .bind(&rule.id)
            .execute(&state.db)
            .await?;
    }
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("notifications.channel_deleted")
                .target("notification_channel", &id, &current.name)
                .details(json!({ "kind": current.kind })),
        )
        .await;
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /api/v1/notification-channels/{id}/test`
pub async fn test(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    ctx.require_global(perm::NOTIFICATIONS_MANAGE)?;
    let channel = load_api(&state, &id).await?;
    let payload = super::delivery::Payload::sample(&state);
    let outcome = super::delivery::deliver_test(&state, &channel, &payload).await;
    let (ok, status, error) = match &outcome {
        Ok(status) => (true, *status, None),
        Err(e) => (false, e.status, Some(e.message.clone())),
    };
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("notifications.channel_tested")
                .target("notification_channel", &id, &channel.name)
                .details(json!({ "ok": ok, "status": status, "error": error })),
        )
        .await;
    Ok(Json(json!({ "ok": ok, "status": status, "error": error })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(v: Value) -> Map<String, Value> {
        v.as_object().cloned().expect("object")
    }

    #[test]
    fn configs_validate_and_keep_secrets() {
        let slack = normalize(
            "slack",
            &map(json!({ "webhook_url": "https://hooks.slack.com/services/T/B/x" })),
            None,
        )
        .expect("slack");
        let kept = normalize("slack", &map(json!({})), Some(&slack)).expect("kept");
        assert_eq!(kept["webhook_url"], slack["webhook_url"]);
        let kept = normalize(
            "slack",
            &map(json!({ "webhook_url": SECRET_PLACEHOLDER })),
            Some(&slack),
        )
        .expect("kept");
        assert_eq!(kept["webhook_url"], slack["webhook_url"]);
        assert!(normalize("slack", &map(json!({})), None).is_err());
        assert!(normalize("discord", &map(json!({ "webhook_url": "ftp://x" })), None).is_err());

        let hook = normalize(
            "webhook",
            &map(json!({ "url": "https://example.com/h", "secret": "s3cret", "headers": { "X-Api-Key": "k1" } })),
            None,
        )
        .expect("webhook");
        let updated = normalize(
            "webhook",
            &map(json!({ "url": "https://example.com/h2", "headers": { "X-Api-Key": SECRET_PLACEHOLDER, "X-Env": "prod" } })),
            Some(&hook),
        )
        .expect("update");
        assert_eq!(updated["secret"], "s3cret");
        assert_eq!(updated["headers"]["X-Api-Key"], "k1");
        assert_eq!(updated["headers"]["X-Env"], "prod");
        assert!(
            normalize(
                "webhook",
                &map(json!({ "url": "https://e.com", "headers": { "Host": "x" } })),
                None
            )
            .is_err()
        );
        assert!(
            normalize(
                "webhook",
                &map(json!({ "url": "https://e.com", "headers": { "X-A": "a\r\nb" } })),
                None
            )
            .is_err()
        );

        let email = normalize(
            "email",
            &map(json!({ "to": ["ops@example.com"], "cc": "a@example.com; b@example.com" })),
            None,
        )
        .expect("email");
        assert_eq!(email["cc"].as_array().map(Vec::len), Some(2));
        assert!(normalize("email", &map(json!({ "to": [] })), None).is_err());
        let ntfy = normalize(
            "ntfy",
            &map(json!({ "topic": "alerts", "token": "tk_1" })),
            None,
        )
        .expect("ntfy");
        assert_eq!(ntfy["server_url"], "https://ntfy.sh");
        assert!(normalize("ntfy", &map(json!({ "topic": "a b" })), None).is_err());
        assert!(normalize("pager", &map(json!({})), None).is_err());
        assert!(
            normalize(
                "slack",
                &map(json!({ "webhook_url": "https://x.y", "to": [] })),
                None
            )
            .is_err()
        );
    }

    #[test]
    fn public_view_masks_secrets() {
        let channel = Channel {
            id: "c".into(),
            name: "Hook".into(),
            kind: "webhook".into(),
            enabled: true,
            config: map(
                json!({ "url": "https://example.com/h", "secret": "s3cret", "headers": { "X-Api-Key": "k1" } }),
            ),
            last_used_at: None,
            last_error: None,
            created_at: rustrmm_common::now(),
            updated_at: rustrmm_common::now(),
        };
        let public = channel.public().to_string();
        assert!(
            !public.contains("s3cret") && !public.contains("k1"),
            "{public}"
        );
        assert!(public.contains("https://example.com/h"));
    }
}
