//! Outbound webhooks: subscriptions to platform events, signed JSON deliveries through the SSRF
//! guard, retries with backoff for 24 hours, delivery history, test and redelivery.
//!
//! Events come from the event bus ([`crate::events::EventBus::publish`] forwards the topics in
//! [`EVENTS`] to the dispatcher). Each matching webhook gets one delivery row whose exact body is
//! signed:
//!
//! ```text
//! X-RustRMM-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>
//! ```

use std::time::Duration;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::Sha256;
use tokio::sync::mpsc;
use utoipa::{IntoParams, ToSchema};

use crate::auth::AuthCtx;
use crate::error::{ApiError, ApiResult};
use crate::events::Event;
use crate::monitoring::notify::ssrf::{self, Allowlist};
use crate::rbac::perm;
use crate::state::AppState;

/// Events a webhook can subscribe to.
pub const EVENTS: [&str; 9] = [
    "device.enrolled",
    "device.offline",
    "alert.opened",
    "alert.resolved",
    "job.completed",
    "ticket.created",
    "ticket.updated",
    "patch_run.completed",
    "secret.revealed",
];
/// Retries stop once this long has passed since the delivery was created.
pub const RETRY_WINDOW_HOURS: i64 = 24;
/// Delay before attempt n+1 (the last value repeats).
const BACKOFF_SECS: [i64; 8] = [30, 120, 600, 1800, 3600, 7200, 14_400, 28_800];
const PARALLEL: usize = 8;

/// Wakes the delivery worker.
static KICK: std::sync::LazyLock<tokio::sync::Notify> =
    std::sync::LazyLock::new(tokio::sync::Notify::new);

fn secret_aad(id: &str) -> String {
    format!("webhooks/secret/{id}")
}

/// `t=<unix>,v1=<hex HMAC-SHA256 of "t.body">`
pub fn signature(secret: &str, timestamp: i64, body: &[u8]) -> String {
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(secret.as_bytes())
        .expect("HMAC accepts any key length");
    mac.update(timestamp.to_string().as_bytes());
    mac.update(b".");
    mac.update(body);
    format!(
        "t={timestamp},v1={}",
        hex::encode(mac.finalize().into_bytes())
    )
}

// ------------------------------------------------------------------ model

#[derive(sqlx::FromRow)]
struct HookRow {
    id: String,
    name: String,
    url: String,
    secret: Vec<u8>,
    events: String,
    client_ids: Option<String>,
    enabled: bool,
    last_delivery_at: Option<DateTime<Utc>>,
    last_status: Option<String>,
    last_error: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

const HOOK_COLUMNS: &str =
    "id, name, url, secret, events, client_ids, enabled, last_delivery_at, last_status, last_error,
    created_at, updated_at";

impl HookRow {
    fn events(&self) -> Vec<String> {
        serde_json::from_str(&self.events).unwrap_or_default()
    }

    fn clients(&self) -> Option<Vec<String>> {
        self.client_ids
            .as_deref()
            .map(|c| serde_json::from_str(c).unwrap_or_default())
    }

    fn matches_client(&self, client_id: Option<&str>) -> bool {
        match (self.clients(), client_id) {
            (None, _) => true,
            (Some(list), Some(c)) => list.iter().any(|x| x == c),
            (Some(_), None) => false,
        }
    }

    fn visible(&self, ctx: &AuthCtx) -> bool {
        if ctx.scope.has_global(perm::API_MANAGE) {
            return true;
        }
        match self.clients() {
            None => false,
            Some(list) => {
                !list.is_empty()
                    && list
                        .iter()
                        .all(|c| ctx.scope.can_client(perm::API_MANAGE, c))
            }
        }
    }
}

/// The last delivery outcome shown on a webhook.
#[derive(Debug, Serialize, ToSchema)]
pub struct LastDelivery {
    pub at: DateTime<Utc>,
    /// `delivered` | `failed` | `retrying`
    pub status: String,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct Webhook {
    pub id: String,
    pub name: String,
    pub url: String,
    pub events: Vec<String>,
    /// `null` = every client.
    pub client_ids: Option<Vec<String>>,
    pub enabled: bool,
    /// The signing secret is write-only; this is always true.
    pub has_secret: bool,
    pub last_delivery: Option<LastDelivery>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

fn to_dto(row: &HookRow) -> Webhook {
    Webhook {
        id: row.id.clone(),
        name: row.name.clone(),
        url: row.url.clone(),
        events: row.events(),
        client_ids: row.clients(),
        enabled: row.enabled,
        has_secret: true,
        last_delivery: row.last_delivery_at.map(|at| LastDelivery {
            at,
            status: row.last_status.clone().unwrap_or_default(),
            error: row.last_error.clone(),
        }),
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

async fn load(state: &AppState, id: &str) -> anyhow::Result<Option<HookRow>> {
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {HOOK_COLUMNS} FROM webhooks WHERE id = ?"
    )))
    .bind(id)
    .fetch_optional(&state.db)
    .await?)
}

async fn visible_hook(state: &AppState, ctx: &AuthCtx, id: &str) -> ApiResult<HookRow> {
    ctx.require(perm::API_MANAGE)?;
    load(state, id)
        .await?
        .filter(|h| h.visible(ctx))
        .ok_or_else(|| ApiError::not_found("Webhook"))
}

// ------------------------------------------------------------------ routes

#[derive(Serialize, ToSchema)]
pub struct WebhookList {
    pub items: Vec<Webhook>,
    /// Event names a webhook can subscribe to.
    pub events: Vec<String>,
}

/// List webhooks
#[utoipa::path(get, path = "/api/v1/webhooks", tag = "Webhooks",
    responses((status = 200, body = WebhookList)))]
pub async fn list(State(state): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<WebhookList>> {
    ctx.require(perm::API_MANAGE)?;
    let rows: Vec<HookRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {HOOK_COLUMNS} FROM webhooks ORDER BY created_at"
    )))
    .fetch_all(&state.db)
    .await?;
    Ok(Json(WebhookList {
        items: rows
            .iter()
            .filter(|h| h.visible(&ctx))
            .map(to_dto)
            .collect(),
        events: EVENTS.iter().map(|e| e.to_string()).collect(),
    }))
}

/// Get a webhook
#[utoipa::path(get, path = "/api/v1/webhooks/{id}", tag = "Webhooks",
    params(("id" = String, Path)), responses((status = 200, body = Webhook)))]
pub async fn get(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Webhook>> {
    Ok(Json(to_dto(&visible_hook(&state, &ctx, &id).await?)))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct WebhookBody {
    #[serde(default)]
    pub name: Option<String>,
    pub url: String,
    /// Write-only. Generated (and returned once) when omitted on create; omit on update to keep it.
    #[serde(default)]
    pub secret: Option<String>,
    pub events: Vec<String>,
    /// `null` = every client (needs `api.manage` installation-wide).
    #[serde(default)]
    pub client_ids: Option<Vec<String>>,
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool {
    true
}

#[derive(Serialize, ToSchema)]
pub struct CreatedWebhook {
    #[serde(flatten)]
    pub webhook: Webhook,
    /// Only present when the server generated the secret.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
}

fn validate_url(raw: &str) -> ApiResult<String> {
    let url =
        url::Url::parse(raw.trim()).map_err(|_| ApiError::validation("url is not a valid URL"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(ApiError::validation("url must be http(s)"));
    }
    if url.host().is_none() {
        return Err(ApiError::validation("url has no host"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ApiError::validation("url must not contain credentials"));
    }
    if raw.len() > 2048 {
        return Err(ApiError::validation("url is too long"));
    }
    Ok(url.to_string())
}

async fn validate(state: &AppState, ctx: &AuthCtx, body: &mut WebhookBody) -> ApiResult<String> {
    let url = validate_url(&body.url)?;
    body.events.sort();
    body.events.dedup();
    if body.events.is_empty() {
        return Err(ApiError::validation("events must not be empty"));
    }
    if let Some(e) = body.events.iter().find(|e| !EVENTS.contains(&e.as_str())) {
        return Err(ApiError::validation(format!("Unknown event {e}"))
            .with_details(json!({ "events": EVENTS })));
    }
    if let Some(name) = &body.name
        && name.chars().count() > 80
    {
        return Err(ApiError::validation("name is at most 80 characters"));
    }
    if let Some(secret) = &body.secret
        && (secret.len() < 16 || secret.len() > 256)
    {
        return Err(ApiError::validation("secret must be 16–256 characters"));
    }
    match &mut body.client_ids {
        None => ctx.require_global(perm::API_MANAGE)?,
        Some(ids) => {
            ids.sort();
            ids.dedup();
            if ids.is_empty() {
                return Err(ApiError::validation(
                    "client_ids must list at least one client (or be null for every client)",
                ));
            }
            for id in ids.iter() {
                let exists: Option<String> =
                    sqlx::query_scalar("SELECT id FROM clients WHERE id = ?")
                        .bind(id)
                        .fetch_optional(&state.db)
                        .await?;
                if exists.is_none() || !ctx.scope.can_client(perm::API_MANAGE, id) {
                    return Err(ApiError::validation(format!("Unknown client {id}")));
                }
            }
        }
    }
    Ok(url)
}

/// Create a webhook
#[utoipa::path(post, path = "/api/v1/webhooks", tag = "Webhooks", request_body = WebhookBody,
    responses((status = 201, body = CreatedWebhook)))]
pub async fn create(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(mut body): Json<WebhookBody>,
) -> ApiResult<(StatusCode, Json<CreatedWebhook>)> {
    ctx.require(perm::API_MANAGE)?;
    let url = validate(&state, &ctx, &mut body).await?;
    let id = rustrmm_common::new_id();
    let generated = body.secret.is_none().then(rustrmm_crypto::random::token);
    let secret = body
        .secret
        .clone()
        .or_else(|| generated.clone())
        .unwrap_or_default();
    let now = rustrmm_common::now();
    let name = body.name.clone().unwrap_or_default().trim().to_string();
    sqlx::query(
        "INSERT INTO webhooks (id, name, url, secret, events, client_ids, enabled, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&name)
    .bind(&url)
    .bind(state.cipher.encrypt_str(&secret, &secret_aad(&id)))
    .bind(serde_json::to_string(&body.events)?)
    .bind(body.client_ids.as_ref().map(serde_json::to_string).transpose()?)
    .bind(body.enabled)
    .bind(&ctx.user.id)
    .bind(now)
    .bind(now)
    .execute(&state.db)
    .await?;
    let mut entry = ctx
        .audit("webhook.created")
        .target("webhook", &id, if name.is_empty() { &url } else { &name })
        .details(json!({ "url": url, "events": body.events, "client_ids": body.client_ids }));
    if let Some(ids) = &body.client_ids
        && ids.len() == 1
    {
        entry = entry.client(ids[0].clone());
    }
    state.audit.record_or_log(&state.db, entry).await;
    let row = load(&state, &id)
        .await?
        .ok_or_else(|| ApiError::internal("webhook vanished"))?;
    Ok((
        StatusCode::CREATED,
        Json(CreatedWebhook {
            webhook: to_dto(&row),
            secret: generated,
        }),
    ))
}

/// Update a webhook
#[utoipa::path(put, path = "/api/v1/webhooks/{id}", tag = "Webhooks", request_body = WebhookBody,
    params(("id" = String, Path)), responses((status = 200, body = Webhook)))]
pub async fn update(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(mut body): Json<WebhookBody>,
) -> ApiResult<Json<Webhook>> {
    let current = visible_hook(&state, &ctx, &id).await?;
    let url = validate(&state, &ctx, &mut body).await?;
    let secret = match &body.secret {
        Some(s) => state.cipher.encrypt_str(s, &secret_aad(&id)),
        None => current.secret.clone(),
    };
    sqlx::query(
        "UPDATE webhooks SET name = ?, url = ?, secret = ?, events = ?, client_ids = ?, enabled = ?, updated_at = ? WHERE id = ?",
    )
    .bind(body.name.clone().unwrap_or(current.name.clone()).trim())
    .bind(&url)
    .bind(secret)
    .bind(serde_json::to_string(&body.events)?)
    .bind(body.client_ids.as_ref().map(serde_json::to_string).transpose()?)
    .bind(body.enabled)
    .bind(rustrmm_common::now())
    .bind(&id)
    .execute(&state.db)
    .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("webhook.updated")
                .target("webhook", &id, &url)
                .details(json!({ "url": url, "events": body.events, "client_ids": body.client_ids,
                                 "enabled": body.enabled, "secret_rotated": body.secret.is_some() })),
        )
        .await;
    let row = load(&state, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Webhook"))?;
    Ok(Json(to_dto(&row)))
}

/// Delete a webhook
#[utoipa::path(delete, path = "/api/v1/webhooks/{id}", tag = "Webhooks",
    params(("id" = String, Path)), responses((status = 204)))]
pub async fn delete(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let current = visible_hook(&state, &ctx, &id).await?;
    sqlx::query("DELETE FROM webhooks WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("webhook.deleted")
                .target("webhook", &id, &current.url),
        )
        .await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Serialize, ToSchema, sqlx::FromRow)]
pub struct Delivery {
    pub id: String,
    pub webhook_id: String,
    /// The payload `id` (unchanged by redelivery).
    pub event_id: String,
    pub event: String,
    /// `pending` | `sending` | `delivered` | `failed`
    pub status: String,
    pub attempts: i64,
    pub next_attempt_at: Option<DateTime<Utc>>,
    pub last_attempt_at: Option<DateTime<Utc>>,
    pub response_status: Option<i64>,
    pub error: Option<String>,
    pub redelivery_of: Option<String>,
    pub created_at: DateTime<Utc>,
    pub delivered_at: Option<DateTime<Utc>>,
    /// The signed JSON body.
    #[schema(value_type = Object)]
    #[sqlx(skip)]
    pub payload: Value,
}

const DELIVERY_COLUMNS: &str =
    "id, webhook_id, event_id, event, status, attempts, next_attempt_at, last_attempt_at,
    response_status, error, redelivery_of, created_at, delivered_at";

async fn load_delivery(state: &AppState, id: &str) -> anyhow::Result<Option<(Delivery, String)>> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT payload FROM webhook_deliveries WHERE id = ?")
            .bind(id)
            .fetch_optional(&state.db)
            .await?;
    let Some((payload,)) = row else {
        return Ok(None);
    };
    let mut d: Delivery = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {DELIVERY_COLUMNS} FROM webhook_deliveries WHERE id = ?"
    )))
    .bind(id)
    .fetch_one(&state.db)
    .await?;
    d.payload = serde_json::from_str(&payload).unwrap_or(Value::Null);
    Ok(Some((d, payload)))
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct DeliveriesQuery {
    limit: Option<i64>,
    /// Filter by status.
    status: Option<String>,
}

#[derive(Serialize, ToSchema)]
pub struct DeliveryList {
    pub items: Vec<Delivery>,
}

/// Webhook delivery history
#[utoipa::path(get, path = "/api/v1/webhooks/{id}/deliveries", tag = "Webhooks",
    params(("id" = String, Path), DeliveriesQuery), responses((status = 200, body = DeliveryList)))]
pub async fn deliveries(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Query(q): Query<DeliveriesQuery>,
) -> ApiResult<Json<DeliveryList>> {
    visible_hook(&state, &ctx, &id).await?;
    let limit = q.limit.unwrap_or(50).clamp(1, 500);
    let status = q.status.filter(|s| !s.is_empty());
    let mut sql =
        format!("SELECT {DELIVERY_COLUMNS}, payload FROM webhook_deliveries WHERE webhook_id = ?");
    if status.is_some() {
        sql.push_str(" AND status = ?");
    }
    sql.push_str(" ORDER BY created_at DESC, id DESC LIMIT ?");
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(&id);
    if let Some(s) = &status {
        query = query.bind(s);
    }
    let rows = query.bind(limit).fetch_all(&state.db).await?;
    let mut items = Vec::new();
    for r in rows {
        use sqlx::{FromRow, Row};
        let mut d = Delivery::from_row(&r)?;
        let payload: String = r.try_get("payload")?;
        d.payload = serde_json::from_str(&payload).unwrap_or(Value::Null);
        items.push(d);
    }
    Ok(Json(DeliveryList { items }))
}

/// Send a test delivery
///
/// Delivers a `webhook.test` event synchronously and returns the recorded delivery.
#[utoipa::path(post, path = "/api/v1/webhooks/{id}/test", tag = "Webhooks",
    params(("id" = String, Path)), responses((status = 200, body = Delivery)))]
pub async fn test(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Delivery>> {
    let hook = visible_hook(&state, &ctx, &id).await?;
    let event_id = rustrmm_common::new_id();
    let now = rustrmm_common::now();
    let payload = serde_json::to_string(&json!({
        "id": event_id, "event": "webhook.test", "created_at": now,
        "data": { "message": "Test delivery from RustRMM", "webhook_id": hook.id, "requested_by": ctx.user.name },
    }))?;
    let delivery_id = insert_delivery(
        &state,
        &hook.id,
        &event_id,
        "webhook.test",
        None,
        &payload,
        None,
    )
    .await?;
    attempt(&state, &delivery_id).await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("webhook.tested")
                .target("webhook", &hook.id, &hook.url),
        )
        .await;
    let (d, _) = load_delivery(&state, &delivery_id)
        .await?
        .ok_or_else(|| ApiError::internal("delivery vanished"))?;
    Ok(Json(d))
}

/// Redeliver a webhook delivery
///
/// Queues the same payload (same `id`) again as a new delivery.
#[utoipa::path(post, path = "/api/v1/webhook-deliveries/{id}/redeliver", tag = "Webhooks",
    params(("id" = String, Path)), responses((status = 202, body = Delivery)))]
pub async fn redeliver(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<(StatusCode, Json<Delivery>)> {
    ctx.require(perm::API_MANAGE)?;
    let (original, payload) = load_delivery(&state, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Delivery"))?;
    let hook = visible_hook(&state, &ctx, &original.webhook_id).await?;
    let client: Option<String> =
        sqlx::query_scalar("SELECT client_id FROM webhook_deliveries WHERE id = ?")
            .bind(&id)
            .fetch_optional(&state.db)
            .await?
            .flatten();
    let new_id = insert_delivery(
        &state,
        &hook.id,
        &original.event_id,
        &original.event,
        client.as_deref(),
        &payload,
        Some(&id),
    )
    .await?;
    KICK.notify_one();
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("webhook.redelivered")
                .target("webhook", &hook.id, &hook.url)
                .details(json!({ "delivery_id": id, "new_delivery_id": new_id, "event": original.event })),
        )
        .await;
    let (d, _) = load_delivery(&state, &new_id)
        .await?
        .ok_or_else(|| ApiError::internal("delivery vanished"))?;
    Ok((StatusCode::ACCEPTED, Json(d)))
}

// ------------------------------------------------------------------ dispatch and delivery

async fn insert_delivery(
    state: &AppState,
    webhook_id: &str,
    event_id: &str,
    event: &str,
    client_id: Option<&str>,
    payload: &str,
    redelivery_of: Option<&str>,
) -> anyhow::Result<String> {
    let id = rustrmm_common::new_id();
    let now = rustrmm_common::now();
    sqlx::query(
        "INSERT INTO webhook_deliveries (id, webhook_id, event_id, event, client_id, payload, status, attempts, next_attempt_at,
             redelivery_of, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)",
    )
    .bind(&id)
    .bind(webhook_id)
    .bind(event_id)
    .bind(event)
    .bind(client_id)
    .bind(payload)
    .bind(now)
    .bind(redelivery_of)
    .bind(now)
    .execute(&state.db)
    .await?;
    Ok(id)
}

/// Queues deliveries of one bus event for every matching enabled webhook.
pub async fn dispatch(state: &AppState, event: &Event) -> anyhow::Result<usize> {
    if !EVENTS.contains(&event.topic.as_str()) {
        return Ok(0);
    }
    let hooks: Vec<HookRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {HOOK_COLUMNS} FROM webhooks WHERE enabled = 1"
    )))
    .fetch_all(&state.db)
    .await?;
    let event_id = rustrmm_common::new_id();
    let now = rustrmm_common::now();
    let body = serde_json::to_string(&json!({
        "id": event_id, "event": event.topic, "created_at": now, "data": event.data,
    }))?;
    let mut queued = 0;
    for hook in hooks {
        if !hook.events().contains(&event.topic) || !hook.matches_client(event.client_id.as_deref())
        {
            continue;
        }
        insert_delivery(
            state,
            &hook.id,
            &event_id,
            &event.topic,
            event.client_id.as_deref(),
            &body,
            None,
        )
        .await?;
        queued += 1;
    }
    if queued > 0 {
        KICK.notify_one();
    }
    Ok(queued)
}

fn next_delay(attempts: i64) -> i64 {
    let index = (attempts.max(1) - 1) as usize;
    BACKOFF_SECS[index.min(BACKOFF_SECS.len() - 1)]
}

/// One delivery attempt (claims the row first so concurrent workers never double-send).
async fn attempt(state: &AppState, delivery_id: &str) -> anyhow::Result<()> {
    let claimed = sqlx::query(
        "UPDATE webhook_deliveries SET status = 'sending' WHERE id = ? AND status = 'pending'",
    )
    .bind(delivery_id)
    .execute(&state.db)
    .await?
    .rows_affected();
    if claimed == 0 {
        return Ok(());
    }
    let row: (String, String, String, i64, DateTime<Utc>) = sqlx::query_as(
        "SELECT webhook_id, event, payload, attempts, created_at FROM webhook_deliveries WHERE id = ?",
    )
    .bind(delivery_id)
    .fetch_one(&state.db)
    .await?;
    let (webhook_id, event, payload, attempts, created_at) = row;
    let hook = load(state, &webhook_id).await?;
    let now = rustrmm_common::now();
    let outcome: Result<u16, (Option<u16>, String)> = match &hook {
        None => Err((None, "the webhook was deleted".into())),
        Some(h) if !h.enabled && event != "webhook.test" => {
            Err((None, "the webhook is disabled".into()))
        }
        Some(h) => send(state, h, delivery_id, &event, &payload).await,
    };
    let attempts = attempts + 1;
    let (status, response_status, error, next) = match &outcome {
        Ok(code) => ("delivered", Some(*code), None, None),
        Err((code, message)) => {
            let next = now + chrono::Duration::seconds(next_delay(attempts));
            let retry = hook.as_ref().is_some_and(|h| h.enabled)
                && event != "webhook.test"
                && next <= created_at + chrono::Duration::hours(RETRY_WINDOW_HOURS);
            if retry {
                ("pending", *code, Some(message.clone()), Some(next))
            } else {
                ("failed", *code, Some(message.clone()), None)
            }
        }
    };
    sqlx::query(
        "UPDATE webhook_deliveries SET status = ?, attempts = ?, last_attempt_at = ?, next_attempt_at = ?, response_status = ?,
             error = ?, delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END WHERE id = ?",
    )
    .bind(status)
    .bind(attempts)
    .bind(now)
    .bind(next)
    .bind(response_status.map(i64::from))
    .bind(&error)
    .bind(status)
    .bind(now)
    .bind(delivery_id)
    .execute(&state.db)
    .await?;
    if hook.is_some() {
        let shown = match status {
            "pending" => "retrying",
            other => other,
        };
        sqlx::query("UPDATE webhooks SET last_delivery_at = ?, last_status = ?, last_error = ? WHERE id = ?")
            .bind(now)
            .bind(shown)
            .bind(&error)
            .bind(&webhook_id)
            .execute(&state.db)
            .await?;
    }
    Ok(())
}

async fn send(
    state: &AppState,
    hook: &HookRow,
    delivery_id: &str,
    event: &str,
    payload: &str,
) -> Result<u16, (Option<u16>, String)> {
    let secret = state
        .cipher
        .decrypt_string(&hook.secret, &secret_aad(&hook.id))
        .map_err(|e| (None, format!("cannot read the webhook secret: {e}")))?;
    let settings = crate::monitoring::settings::load(state)
        .await
        .map_err(|e| (None, format!("{e:#}")))?;
    let allow = Allowlist::new(&settings.webhook_allowlist);
    let timestamp = rustrmm_common::now().timestamp();
    let headers = vec![
        ("X-RustRMM-Event".to_string(), event.to_string()),
        ("X-RustRMM-Delivery".to_string(), delivery_id.to_string()),
        (
            "X-RustRMM-Signature".to_string(),
            signature(&secret, timestamp, payload.as_bytes()),
        ),
    ];
    match ssrf::post(
        &hook.url,
        &allow,
        &headers,
        "application/json",
        payload.as_bytes().to_vec(),
    )
    .await
    {
        Ok(r) if r.ok() => Ok(r.status),
        Ok(r) => Err((
            Some(r.status),
            format!(
                "HTTP {}{}",
                r.status,
                if r.body.trim().is_empty() {
                    String::new()
                } else {
                    format!(": {}", r.body.trim().chars().take(200).collect::<String>())
                }
            ),
        )),
        Err(e) => Err((None, format!("{e:#}"))),
    }
}

/// Delivers every due attempt.
pub async fn process_due(state: &AppState) -> anyhow::Result<()> {
    loop {
        let due: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 50",
        )
        .bind(rustrmm_common::now())
        .fetch_all(&state.db)
        .await?;
        if due.is_empty() {
            return Ok(());
        }
        let mut set = tokio::task::JoinSet::new();
        for id in due {
            while set.len() >= PARALLEL {
                set.join_next().await;
            }
            let state = state.clone();
            set.spawn(async move {
                if let Err(e) = attempt(&state, &id).await {
                    tracing::warn!(error = %format!("{e:#}"), "webhook attempt failed to record");
                }
            });
        }
        while set.join_next().await.is_some() {}
    }
}

/// Starts the dispatcher (bus → delivery rows) and the delivery worker. Deliveries interrupted
/// by a restart are retried. Calling it twice is harmless.
pub fn spawn(state: AppState) {
    let (tx, mut rx) = mpsc::unbounded_channel::<Event>();
    if !state.events.attach_webhooks(tx) {
        return;
    }
    let dispatcher = state.clone();
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            if let Err(e) = dispatch(&dispatcher, &event).await {
                tracing::warn!(event = %event.topic, error = %format!("{e:#}"), "webhook dispatch failed");
            }
        }
    });
    tokio::spawn(async move {
        let _ = sqlx::query(
            "UPDATE webhook_deliveries SET status = 'pending' WHERE status = 'sending'",
        )
        .execute(&state.db)
        .await;
        loop {
            if let Err(e) = process_due(&state).await {
                tracing::warn!(error = %format!("{e:#}"), "webhook delivery pass failed");
            }
            let _ = purge_old(&state).await;
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(5)) => {}
                _ = KICK.notified() => {}
            }
        }
    });
}

/// Delivery history is kept for 30 days.
async fn purge_old(state: &AppState) -> anyhow::Result<()> {
    sqlx::query(
        "DELETE FROM webhook_deliveries WHERE created_at < ? AND status IN ('delivered', 'failed')",
    )
    .bind(rustrmm_common::now() - chrono::Duration::days(30))
    .execute(&state.db)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signature_covers_timestamp_and_body() {
        let a = signature("secret-secret-123", 1_700_000_000, b"{}");
        assert!(a.starts_with("t=1700000000,v1="));
        assert_eq!(a.len(), "t=1700000000,v1=".len() + 64);
        assert_ne!(a, signature("secret-secret-123", 1_700_000_001, b"{}"));
        assert_ne!(a, signature("secret-secret-124", 1_700_000_000, b"{}"));
        // HMAC-SHA256("key", "1.x")
        let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(b"key").expect("mac");
        mac.update(b"1.x");
        assert_eq!(
            signature("key", 1, b"x"),
            format!("t=1,v1={}", hex::encode(mac.finalize().into_bytes()))
        );
    }

    #[test]
    fn backoff_grows_and_caps() {
        assert_eq!(next_delay(1), 30);
        assert_eq!(next_delay(2), 120);
        assert_eq!(next_delay(50), 28_800);
    }
}
