//! Phase 10 secrets escrow (`docs/api-escrow-network.md`): BitLocker/FileVault/LUKS and LAPS
//! items encrypted on the device to the server's age escrow recipient, the reveal flow (step-up,
//! typed reason, audit, notification, rotate after reveal), LAPS rotation scheduling and stats.
//!
//! The ciphertext is decrypted only inside [`reveal`], in memory, and the plaintext is returned
//! exactly once with `Cache-Control: no-store`. Secrets never reach logs, events or the audit log.

pub mod policy;

use std::collections::HashSet;
use std::time::Duration;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Utc};
use rustrmm_proto::commands::{Command, CommandResult};
use rustrmm_proto::escrow::{EscrowItem, MAX_CIPHERTEXT_BYTES, kinds};
use serde::Deserialize;
use serde_json::{Value, json};
use zeroize::Zeroizing;

use crate::agents::DeviceRecord;
use crate::audit::{Actor, AuditEntry};
use crate::auth::AuthCtx;
use crate::automation::policies::PolicyContext;
use crate::error::{ApiError, ApiResult};
use crate::monitoring::notify::delivery::Payload;
use crate::rbac::{AccessScope, perm};
use crate::state::AppState;

/// The binary age header every escrow ciphertext starts with.
const AGE_HEADER: &[u8] = b"age-encryption.org/v1\n";
/// How long a revealed secret is shown by the console.
const REVEAL_EXPIRES_SECS: i64 = 60;
/// A rotation command that got no result is retried after this long.
const PENDING_TIMEOUT_MINUTES: i64 = 15;
/// Retry delay after a failed rotation.
const RETRY_AFTER_FAILURE_MINUTES: i64 = 60;
/// Scheduler period.
const TICK: Duration = Duration::from_secs(60);

// ------------------------------------------------------------------ ingest

/// Stores an escrow item from an agent: de-duplicated by (device, kind, identifier, source
/// hash); a new secret for the same identifier supersedes the previous item.
pub async fn ingest(
    state: &AppState,
    device: &DeviceRecord,
    item: EscrowItem,
) -> anyhow::Result<()> {
    if !kinds::ALL.contains(&item.kind.as_str()) {
        anyhow::bail!("unknown escrow kind {}", item.kind);
    }
    let identifier: String = item.identifier.trim().chars().take(200).collect();
    if identifier.is_empty() {
        anyhow::bail!("escrow item without identifier");
    }
    if item.ciphertext_age.len() > MAX_CIPHERTEXT_BYTES
        || !item.ciphertext_age.starts_with(AGE_HEADER)
    {
        anyhow::bail!("escrow ciphertext is not a binary age file");
    }
    let label: String = item.label.chars().take(200).collect();
    let metadata = match &item.metadata {
        Value::Object(m) if serde_json::to_string(m)?.len() <= 4096 => Value::Object(m.clone()),
        _ => json!({}),
    };
    let source_hash: String = item
        .source_hash
        .chars()
        .filter(char::is_ascii_hexdigit)
        .take(64)
        .collect();
    let now = rustrmm_common::now();
    let captured_at = DateTime::<Utc>::from_timestamp_millis(item.captured_at)
        .filter(|t| *t <= now && *t > now - chrono::Duration::days(7))
        .unwrap_or(now);

    if !source_hash.is_empty() {
        let existing: Option<String> = sqlx::query_scalar(
            "SELECT id FROM escrow_items WHERE device_id = ? AND kind = ? AND identifier = ? AND source_hash = ?
             AND superseded_at IS NULL",
        )
        .bind(&device.id)
        .bind(&item.kind)
        .bind(&identifier)
        .bind(&source_hash)
        .fetch_optional(&state.db)
        .await?;
        if let Some(id) = existing {
            sqlx::query(
                "UPDATE escrow_items SET received_at = ?, label = ?, metadata = ? WHERE id = ?",
            )
            .bind(now)
            .bind(&label)
            .bind(metadata.to_string())
            .bind(&id)
            .execute(&state.db)
            .await?;
            return Ok(());
        }
    }
    let id = rustrmm_common::new_id();
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "UPDATE escrow_items SET superseded_at = ? WHERE device_id = ? AND kind = ? AND identifier = ? AND superseded_at IS NULL",
    )
    .bind(now)
    .bind(&device.id)
    .bind(&item.kind)
    .bind(&identifier)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO escrow_items (id, device_id, client_id, site_id, hostname, kind, identifier, label, ciphertext, source_hash,
                                   metadata, captured_at, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&device.id)
    .bind(&device.client_id)
    .bind(&device.site_id)
    .bind(&device.hostname)
    .bind(&item.kind)
    .bind(&identifier)
    .bind(&label)
    .bind(&item.ciphertext_age)
    .bind(&source_hash)
    .bind(metadata.to_string())
    .bind(captured_at)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    let what = kind_label(&item.kind);
    let _ = crate::agents::timeline(
        &state.db,
        &device.id,
        "escrow.captured",
        "info",
        &format!("{what} escrowed ({identifier})"),
        json!({ "item_id": id, "kind": item.kind, "identifier": identifier }),
    )
    .await;
    state
        .audit
        .record_or_log(
            &state.db,
            AuditEntry::new(
                Actor::Agent {
                    id: device.id.clone(),
                    name: device.hostname.clone(),
                },
                "secret.escrowed",
            )
            .target("escrow_item", &id, format!("{what} {identifier}"))
            .client(&device.client_id)
            .site(&device.site_id)
            .details(
                json!({ "kind": item.kind, "identifier": identifier, "device_id": device.id }),
            ),
        )
        .await;
    state.events.publish(
        "escrow.changed",
        Some(device.client_id.clone()),
        json!({ "device_id": device.id, "kind": item.kind }),
    );
    Ok(())
}

fn kind_label(kind: &str) -> &'static str {
    match kind {
        kinds::BITLOCKER => "BitLocker recovery key",
        kinds::LAPS => "Local administrator password",
        kinds::FILEVAULT => "FileVault recovery key",
        _ => "LUKS key",
    }
}

// ------------------------------------------------------------------ listing

#[derive(Debug, sqlx::FromRow)]
struct ItemRow {
    id: String,
    device_id: Option<String>,
    hostname: String,
    client_id: String,
    client_name: String,
    site_id: Option<String>,
    kind: String,
    identifier: String,
    label: String,
    metadata: String,
    captured_at: DateTime<Utc>,
    superseded_at: Option<DateTime<Utc>>,
    last_revealed_at: Option<DateTime<Utc>>,
    reveal_count: i64,
}

const ITEM_SELECT: &str = "SELECT e.id, e.device_id, COALESCE(d.hostname, e.hostname) AS hostname, e.client_id, c.name AS client_name,
    e.site_id, e.kind, e.identifier, e.label, e.metadata, e.captured_at, e.superseded_at, e.last_revealed_at, e.reveal_count
    FROM escrow_items e JOIN clients c ON c.id = e.client_id LEFT JOIN devices d ON d.id = e.device_id";

impl ItemRow {
    fn to_json(&self) -> Value {
        json!({
            "id": self.id, "device_id": self.device_id, "hostname": self.hostname,
            "client_id": self.client_id, "client_name": self.client_name, "site_id": self.site_id,
            "kind": self.kind, "identifier": self.identifier, "label": self.label,
            "metadata": serde_json::from_str::<Value>(&self.metadata).unwrap_or_else(|_| json!({})),
            "captured_at": self.captured_at, "superseded_at": self.superseded_at,
            "last_revealed_at": self.last_revealed_at, "reveal_count": self.reveal_count,
        })
    }

    fn can(&self, scope: &AccessScope, permission: &str) -> bool {
        match &self.site_id {
            Some(site) => scope.can_site(permission, &self.client_id, site),
            None => scope.can_client(permission, &self.client_id),
        }
    }

    fn visible(&self, scope: &AccessScope) -> bool {
        self.can(scope, perm::SECRETS_REVEAL) || self.can(scope, perm::SECRETS_MANAGE)
    }
}

fn require_escrow_view(ctx: &AuthCtx) -> ApiResult<()> {
    if ctx.scope.has_anywhere(perm::SECRETS_REVEAL) || ctx.scope.has_anywhere(perm::SECRETS_MANAGE)
    {
        Ok(())
    } else {
        Err(
            ApiError::forbidden("Missing permission: secrets.reveal or secrets.manage")
                .with_details(json!({ "permission": perm::SECRETS_REVEAL })),
        )
    }
}

#[derive(Debug, Default, Deserialize)]
pub struct ListQuery {
    client_id: Option<String>,
    device_id: Option<String>,
    kind: Option<String>,
    q: Option<String>,
    #[serde(default)]
    include_superseded: Option<bool>,
}

async fn list_items(state: &AppState, ctx: &AuthCtx, q: &ListQuery) -> ApiResult<Vec<Value>> {
    let mut qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new(format!("{ITEM_SELECT} WHERE 1 = 1"));
    if !q.include_superseded.unwrap_or(false) {
        qb.push(" AND e.superseded_at IS NULL");
    }
    if let Some(c) = q.client_id.as_deref().filter(|c| !c.is_empty()) {
        qb.push(" AND e.client_id = ").push_bind(c.to_string());
    }
    if let Some(d) = q.device_id.as_deref().filter(|d| !d.is_empty()) {
        qb.push(" AND e.device_id = ").push_bind(d.to_string());
    }
    if let Some(k) = q.kind.as_deref().filter(|k| !k.is_empty()) {
        qb.push(" AND e.kind = ").push_bind(k.to_string());
    }
    if let Some(text) = q.q.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        let like = format!(
            "%{}%",
            text.replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        qb.push(" AND (e.identifier LIKE ")
            .push_bind(like.clone())
            .push(" ESCAPE '\\' OR e.label LIKE ")
            .push_bind(like.clone())
            .push(" ESCAPE '\\' OR COALESCE(d.hostname, e.hostname) LIKE ")
            .push_bind(like)
            .push(" ESCAPE '\\')");
    }
    qb.push(" ORDER BY e.captured_at DESC, e.id DESC LIMIT 5000");
    let rows: Vec<ItemRow> = qb.build_query_as().fetch_all(&state.db).await?;
    Ok(rows
        .iter()
        .filter(|r| r.visible(&ctx.scope))
        .take(1000)
        .map(ItemRow::to_json)
        .collect())
}

/// `GET /api/v1/escrow`
#[utoipa::path(get, path = "/api/v1/escrow", tag = "Escrow", summary = "List escrow", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    require_escrow_view(&ctx)?;
    Ok(Json(
        json!({ "items": list_items(&state, &ctx, &q).await? }),
    ))
}

/// Device visible with `secrets.reveal` or `secrets.manage`; returns (client, site, hostname).
async fn escrow_device(
    state: &AppState,
    ctx: &AuthCtx,
    device_id: &str,
    permission: Option<&str>,
) -> ApiResult<(String, String, String)> {
    let row: Option<(String, String, String)> = sqlx::query_as(
        "SELECT s.client_id, d.site_id, d.hostname FROM devices d JOIN sites s ON s.id = d.site_id WHERE d.id = ?",
    )
    .bind(device_id)
    .fetch_optional(&state.db)
    .await?;
    let (client, site, hostname) = row.ok_or_else(|| ApiError::not_found("Device"))?;
    let sees = |p: &str| ctx.scope.can_site(p, &client, &site);
    if !sees(perm::DEVICES_VIEW) && !sees(perm::SECRETS_REVEAL) && !sees(perm::SECRETS_MANAGE) {
        return Err(ApiError::not_found("Device"));
    }
    let allowed = match permission {
        Some(p) => sees(p),
        None => sees(perm::SECRETS_REVEAL) || sees(perm::SECRETS_MANAGE),
    };
    if !allowed {
        let p = permission.unwrap_or(perm::SECRETS_REVEAL);
        return Err(ApiError::forbidden(format!("Missing permission: {p}"))
            .with_details(json!({ "permission": p })));
    }
    Ok((client, site, hostname))
}

/// `GET /api/v1/devices/{id}/escrow`
#[utoipa::path(get, path = "/api/v1/devices/{id}/escrow", tag = "Escrow", summary = "Device items", params(("id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn device_items(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Query(mut q): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    require_escrow_view(&ctx)?;
    escrow_device(&state, &ctx, &id, None).await?;
    q.device_id = Some(id);
    Ok(Json(
        json!({ "items": list_items(&state, &ctx, &q).await? }),
    ))
}

async fn load_item(state: &AppState, ctx: &AuthCtx, id: &str) -> ApiResult<(ItemRow, Vec<u8>)> {
    let row: Option<ItemRow> =
        sqlx::query_as(sqlx::AssertSqlSafe(format!("{ITEM_SELECT} WHERE e.id = ?")))
            .bind(id)
            .fetch_optional(&state.db)
            .await?;
    let row = row
        .filter(|r| r.visible(&ctx.scope))
        .ok_or_else(|| ApiError::not_found("Escrow item"))?;
    let ciphertext: Vec<u8> =
        sqlx::query_scalar("SELECT ciphertext FROM escrow_items WHERE id = ?")
            .bind(id)
            .fetch_one(&state.db)
            .await?;
    Ok((row, ciphertext))
}

// ------------------------------------------------------------------ reveal

#[derive(Deserialize)]
pub struct RevealBody {
    #[serde(default)]
    reason: String,
}

/// Decrypts an escrow ciphertext with the server's escrow identity (in memory only).
pub fn decrypt(
    identity: &age::x25519::Identity,
    ciphertext: &[u8],
) -> anyhow::Result<Zeroizing<String>> {
    let plaintext = Zeroizing::new(
        age::decrypt(identity, ciphertext)
            .map_err(|e| anyhow::anyhow!("decryption failed: {e}"))?,
    );
    let text =
        std::str::from_utf8(&plaintext).map_err(|_| anyhow::anyhow!("secret is not UTF-8"))?;
    Ok(Zeroizing::new(text.to_string()))
}

/// `POST /api/v1/escrow/{id}/reveal` (step-up) — returns the secret once, never cached.
#[utoipa::path(post, path = "/api/v1/escrow/{id}/reveal", tag = "Escrow", summary = "Reveal", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn reveal(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(body): Json<RevealBody>,
) -> ApiResult<Response> {
    ctx.require(perm::SECRETS_REVEAL)?;
    let (item, ciphertext) = load_item(&state, &ctx, &id).await?;
    if !item.can(&ctx.scope, perm::SECRETS_REVEAL) {
        return Err(ApiError::forbidden("Missing permission: secrets.reveal")
            .with_details(json!({ "permission": perm::SECRETS_REVEAL })));
    }
    ctx.require_step_up()?;
    let reason = body.reason.trim().to_string();
    if reason.chars().count() < 10 || reason.chars().count() > 500 {
        return Err(
            ApiError::validation("Give a reason of at least 10 characters (at most 500)")
                .with_details(json!({ "path": "reason" })),
        );
    }
    if !state.limiter.check(
        "escrow_reveal",
        &ctx.user.id,
        crate::ratelimit::Limit::per(20, Duration::from_secs(600)),
    ) {
        return Err(ApiError::too_many_requests());
    }
    let secret = decrypt(&state.keys.escrow, &ciphertext).map_err(|e| {
        // The error never contains key material; the reference id ties it to the log line.
        ApiError::internal(format!("escrow item {id} could not be decrypted: {e:#}"))
    })?;

    let now = rustrmm_common::now();
    sqlx::query("INSERT INTO escrow_reveals (item_id, user_id, user_name, reason, at, ip) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(&id)
        .bind(&ctx.user.id)
        .bind(&ctx.user.name)
        .bind(&reason)
        .bind(now)
        .bind(&ctx.ip)
        .execute(&state.db)
        .await?;
    sqlx::query("UPDATE escrow_items SET last_revealed_at = ?, reveal_count = reveal_count + 1 WHERE id = ?")
        .bind(now)
        .bind(&id)
        .execute(&state.db)
        .await?;
    let mut entry = ctx
        .audit("secret.revealed")
        .target(
            "escrow_item",
            &id,
            format!(
                "{} {} ({})",
                kind_label(&item.kind),
                item.identifier,
                item.hostname
            ),
        )
        .client(&item.client_id)
        .details(
            json!({ "reason": reason, "kind": item.kind, "identifier": item.identifier,
                         "device_id": item.device_id, "hostname": item.hostname }),
        );
    if let Some(site) = &item.site_id {
        entry = entry.site(site);
    }
    state.audit.record_or_log(&state.db, entry).await;
    if let Some(device_id) = &item.device_id {
        let _ = crate::agents::timeline(
            &state.db,
            device_id,
            "secret.revealed",
            "notice",
            &format!("{} revealed by {}", kind_label(&item.kind), ctx.user.name),
            json!({ "item_id": id, "reason": reason }),
        )
        .await;
        if item.kind == kinds::LAPS
            && let Err(e) = schedule_after_reveal(&state, device_id, now).await
        {
            tracing::warn!(device = %device_id, error = %format!("{e:#}"), "could not schedule rotation after reveal");
        }
    }
    notify_revealed(&state, &item, &ctx.user.name, &reason).await;
    // Webhooks: who revealed what and why, never the secret.
    state.events.publish(
        "secret.revealed",
        Some(item.client_id.clone()),
        json!({ "item_id": id, "kind": item.kind, "identifier": item.identifier, "device_id": item.device_id,
                "hostname": item.hostname, "client_id": item.client_id, "site_id": item.site_id,
                "revealed_by": { "id": ctx.user.id, "name": ctx.user.name }, "reason": reason, "at": now }),
    );
    state.events.publish(
        "escrow.changed",
        Some(item.client_id.clone()),
        json!({ "device_id": item.device_id, "kind": item.kind }),
    );

    let body = json!({
        "secret": secret.as_str(), "kind": item.kind, "identifier": item.identifier,
        "expires_in": REVEAL_EXPIRES_SECS,
    });
    let mut response = Json(body).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, max-age=0"),
    );
    headers.insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    Ok(response)
}

/// Notification rules listening for `secret.revealed` (never with the secret itself).
async fn notify_revealed(state: &AppState, item: &ItemRow, user: &str, reason: &str) {
    let site_name: Option<String> = match &item.site_id {
        Some(site) => sqlx::query_scalar("SELECT name FROM sites WHERE id = ?")
            .bind(site)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten(),
        None => None,
    };
    let now = rustrmm_common::now();
    let payload = Payload {
        event: "secret.revealed".into(),
        alert_id: None,
        title: format!("{} revealed on {}", kind_label(&item.kind), item.hostname),
        severity: "info".into(),
        status: "revealed".into(),
        source: "escrow".into(),
        check_id: "secret.revealed".into(),
        check_type: item.kind.clone(),
        message: format!(
            "{user} revealed {} ({}). Reason: {reason}",
            kind_label(&item.kind),
            item.identifier
        ),
        hostname: Some(item.hostname.clone()),
        client_name: item.client_name.clone(),
        site_name,
        opened_at: Some(now),
        last_occurrence_at: Some(now),
        resolved_at: None,
        occurrences: 1,
        link: item.device_id.as_ref().map(|d| {
            format!(
                "{}devices/{d}",
                crate::monitoring::notify::delivery::console_base(state)
            )
        }),
        sent_at: now,
    };
    if let Err(e) = crate::monitoring::notify::dispatch_event(
        state,
        &item.client_id,
        item.site_id.as_deref(),
        &payload,
    )
    .await
    {
        tracing::warn!(error = %format!("{e:#}"), "secret.revealed notification failed");
    }
}

// ------------------------------------------------------------------ delete, rotate, refresh

/// `DELETE /api/v1/escrow/{id}` (step-up)
#[utoipa::path(delete, path = "/api/v1/escrow/{id}", tag = "Escrow", summary = "Delete escrow", params(("id" = String, Path)), responses((status = 204, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn delete(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    ctx.require(perm::SECRETS_MANAGE)?;
    let (item, _) = load_item(&state, &ctx, &id).await?;
    if !item.can(&ctx.scope, perm::SECRETS_MANAGE) {
        return Err(ApiError::forbidden("Missing permission: secrets.manage")
            .with_details(json!({ "permission": perm::SECRETS_MANAGE })));
    }
    ctx.require_step_up()?;
    sqlx::query("DELETE FROM escrow_items WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    let mut entry = ctx
        .audit("secret.deleted")
        .target(
            "escrow_item",
            &id,
            format!("{} {} ({})", kind_label(&item.kind), item.identifier, item.hostname),
        )
        .client(&item.client_id)
        .details(json!({ "kind": item.kind, "identifier": item.identifier, "device_id": item.device_id }));
    if let Some(site) = &item.site_id {
        entry = entry.site(site);
    }
    state.audit.record_or_log(&state.db, entry).await;
    state.events.publish(
        "escrow.changed",
        Some(item.client_id.clone()),
        json!({ "device_id": item.device_id, "kind": item.kind }),
    );
    Ok(StatusCode::NO_CONTENT)
}

fn device_offline() -> ApiError {
    ApiError::conflict("device_offline", "The device is offline")
}

/// Sends a signed rotation with the device's effective LAPS settings and records it as pending.
pub async fn send_rotation(
    state: &AppState,
    device_id: &str,
    created_by: Option<&str>,
) -> anyhow::Result<String> {
    let laps = device_policy(state, device_id).await?.laps;
    let cmd_id = crate::agents::commands::send(
        state,
        device_id,
        Command::RotateLocalAdmin(laps.command()),
        created_by,
        600,
        &format!("Rotate local administrator password ({})", laps.account),
    )
    .await?;
    let now = rustrmm_common::now();
    sqlx::query(
        "INSERT INTO laps_state (device_id, account, pending_cmd_id, pending_since, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (device_id) DO UPDATE SET account = excluded.account, pending_cmd_id = excluded.pending_cmd_id,
             pending_since = excluded.pending_since, updated_at = excluded.updated_at",
    )
    .bind(device_id)
    .bind(&laps.account)
    .bind(&cmd_id)
    .bind(now)
    .bind(now)
    .execute(&state.db)
    .await?;
    Ok(cmd_id)
}

/// `POST /api/v1/devices/{id}/laps/rotate` (step-up)
#[utoipa::path(post, path = "/api/v1/devices/{id}/laps/rotate", tag = "Escrow", summary = "Rotate now", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn rotate_now(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::SECRETS_MANAGE)?;
    let (client, site, hostname) =
        escrow_device(&state, &ctx, &id, Some(perm::SECRETS_MANAGE)).await?;
    ctx.require_step_up()?;
    if !state.agents.is_online(&id) {
        return Err(device_offline());
    }
    let cmd_id = send_rotation(&state, &id, Some(&ctx.user.id))
        .await
        .map_err(|e| ApiError::conflict("device_offline", format!("{e:#}")))?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("laps.rotate_requested")
                .target("device", &id, &hostname)
                .client(&client)
                .site(&site)
                .details(json!({ "cmd_id": cmd_id })),
        )
        .await;
    Ok(Json(json!({ "cmd_id": cmd_id })))
}

/// `POST /api/v1/devices/{id}/escrow/refresh`
#[utoipa::path(post, path = "/api/v1/devices/{id}/escrow/refresh", tag = "Escrow", summary = "Refresh", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn refresh(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::SECRETS_MANAGE)?;
    let (client, site, hostname) =
        escrow_device(&state, &ctx, &id, Some(perm::SECRETS_MANAGE)).await?;
    if !state.agents.is_online(&id) {
        return Err(device_offline());
    }
    let cmd_id = crate::agents::commands::send(
        &state,
        &id,
        Command::EscrowRefresh,
        Some(&ctx.user.id),
        600,
        "Collect escrow secrets",
    )
    .await
    .map_err(|e| ApiError::conflict("device_offline", format!("{e:#}")))?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("escrow.refresh_requested")
                .target("device", &id, &hostname)
                .client(&client)
                .site(&site),
        )
        .await;
    Ok(Json(json!({ "cmd_id": cmd_id })))
}

// ------------------------------------------------------------------ LAPS scheduling

/// Effective escrow policy of one device (defaults when it is not active).
pub async fn device_policy(
    state: &AppState,
    device_id: &str,
) -> anyhow::Result<policy::EscrowPolicy> {
    let effective = crate::automation::policies::effective_for_device(&state.db, device_id).await?;
    Ok(effective
        .map(|e| policy::from_effective(&e.document))
        .unwrap_or_default())
}

/// A LAPS secret was revealed: rotate within `rotate_after_reveal_hours` (0 = never).
async fn schedule_after_reveal(
    state: &AppState,
    device_id: &str,
    now: DateTime<Utc>,
) -> anyhow::Result<()> {
    let laps = device_policy(state, device_id).await?.laps;
    if laps.rotate_after_reveal_hours <= 0 {
        return Ok(());
    }
    let due = now + chrono::Duration::hours(laps.rotate_after_reveal_hours);
    sqlx::query(
        "INSERT INTO laps_state (device_id, account, next_rotation_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (device_id) DO UPDATE SET
             next_rotation_at = CASE WHEN laps_state.next_rotation_at IS NULL OR laps_state.next_rotation_at > excluded.next_rotation_at
                                     THEN excluded.next_rotation_at ELSE laps_state.next_rotation_at END,
             updated_at = excluded.updated_at",
    )
    .bind(device_id)
    .bind(&laps.account)
    .bind(due)
    .bind(now)
    .execute(&state.db)
    .await?;
    Ok(())
}

/// Outcome of a `rotate_local_admin` command.
pub async fn on_rotate_result(
    state: &AppState,
    device_id: &str,
    result: &CommandResult,
) -> anyhow::Result<()> {
    let now = rustrmm_common::now();
    match result.status.as_str() {
        "succeeded" => {
            let laps = device_policy(state, device_id).await?.laps;
            let account = result
                .data
                .get("account")
                .and_then(Value::as_str)
                .unwrap_or(&laps.account)
                .to_string();
            sqlx::query(
                "INSERT INTO laps_state (device_id, account, last_rotated_at, next_rotation_at, updated_at) VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (device_id) DO UPDATE SET account = excluded.account, last_rotated_at = excluded.last_rotated_at,
                     next_rotation_at = excluded.next_rotation_at, last_error = NULL, pending_cmd_id = NULL, pending_since = NULL,
                     updated_at = excluded.updated_at",
            )
            .bind(device_id)
            .bind(&account)
            .bind(now)
            .bind(now + chrono::Duration::days(laps.rotate_days))
            .bind(now)
            .execute(&state.db)
            .await?;
            let _ = crate::agents::timeline(
                &state.db,
                device_id,
                "laps.rotated",
                "info",
                &format!("Local administrator password rotated ({account})"),
                json!({ "cmd_id": result.cmd_id }),
            )
            .await;
        }
        "failed" | "rejected" => {
            let message: String = result.message.chars().take(500).collect();
            sqlx::query(
                "UPDATE laps_state SET last_error = ?, pending_cmd_id = NULL, pending_since = NULL, next_rotation_at = ?, updated_at = ?
                 WHERE device_id = ?",
            )
            .bind(if message.is_empty() { result.status.clone() } else { message.clone() })
            .bind(now + chrono::Duration::minutes(RETRY_AFTER_FAILURE_MINUTES))
            .bind(now)
            .bind(device_id)
            .execute(&state.db)
            .await?;
            let _ = crate::agents::timeline(
                &state.db,
                device_id,
                "laps.failed",
                "warning",
                &format!("Local administrator password rotation failed: {message}"),
                json!({ "cmd_id": result.cmd_id }),
            )
            .await;
        }
        _ => {}
    }
    Ok(())
}

/// Sends rotations that are due to online devices with LAPS enabled.
pub async fn tick(state: &AppState) -> anyhow::Result<usize> {
    let online: Vec<String> =
        sqlx::query_scalar("SELECT id FROM devices WHERE online = 1 AND status = 'active'")
            .fetch_all(&state.db)
            .await?;
    let online: Vec<String> = online
        .into_iter()
        .filter(|d| state.agents.is_online(d))
        .collect();
    if online.is_empty() {
        return Ok(0);
    }
    let ctx = PolicyContext::load(&state.db, Some(&online)).await?;
    let now = rustrmm_common::now();
    let mut sent = 0;
    for facts in &ctx.index.facts {
        let laps = policy::from_effective(&ctx.effective(facts).document).laps;
        if !laps.enabled {
            continue;
        }
        let row: Option<(Option<DateTime<Utc>>, Option<DateTime<Utc>>, Option<String>, Option<DateTime<Utc>>)> =
            sqlx::query_as(
                "SELECT last_rotated_at, next_rotation_at, pending_cmd_id, pending_since FROM laps_state WHERE device_id = ?",
            )
            .bind(&facts.id)
            .fetch_optional(&state.db)
            .await?;
        let due = match &row {
            None => true,
            Some((last, next, pending, since)) => {
                let pending_fresh = pending.is_some()
                    && since.is_some_and(|s| {
                        now - s < chrono::Duration::minutes(PENDING_TIMEOUT_MINUTES)
                    });
                let by_schedule = match (next, last) {
                    (Some(next), _) => *next <= now,
                    (None, Some(last)) => *last + chrono::Duration::days(laps.rotate_days) <= now,
                    (None, None) => true,
                };
                !pending_fresh && by_schedule
            }
        };
        if !due {
            continue;
        }
        match send_rotation(state, &facts.id, None).await {
            Ok(_) => sent += 1,
            Err(e) => {
                tracing::debug!(device = %facts.id, error = %format!("{e:#}"), "LAPS rotation not sent")
            }
        }
    }
    Ok(sent)
}

/// Agent connected: rotate at once when a rotation is due.
pub async fn on_connect(state: &AppState, device_id: &str) {
    let due: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM laps_state WHERE device_id = ? AND pending_cmd_id IS NULL AND next_rotation_at IS NOT NULL AND next_rotation_at <= ?",
    )
    .bind(device_id)
    .bind(rustrmm_common::now())
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();
    if due.is_some()
        && device_policy(state, device_id)
            .await
            .is_ok_and(|p| p.laps.enabled)
        && let Err(e) = send_rotation(state, device_id, None).await
    {
        tracing::debug!(device = device_id, error = %format!("{e:#}"), "LAPS rotation on connect not sent");
    }
}

/// Starts the LAPS scheduler.
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(30)).await;
        loop {
            if let Err(e) = tick(&state).await {
                tracing::warn!(error = %format!("{e:#}"), "LAPS scheduler tick failed");
            }
            tokio::time::sleep(TICK).await;
        }
    });
}

// ------------------------------------------------------------------ stats

#[derive(sqlx::FromRow)]
struct DeviceBrief {
    id: String,
    hostname: String,
    client_id: String,
    client_name: String,
    site_id: String,
}

impl DeviceBrief {
    fn to_json(&self) -> Value {
        json!({ "id": self.id, "hostname": self.hostname, "client_id": self.client_id, "client_name": self.client_name })
    }
}

/// `GET /api/v1/escrow/stats`
#[utoipa::path(get, path = "/api/v1/escrow/stats", tag = "Escrow", summary = "Stats", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn stats(State(state): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<Value>> {
    ctx.require(perm::SECRETS_MANAGE)?;
    let encrypted: Vec<DeviceBrief> = sqlx::query_as(
        "SELECT d.id, d.hostname, s.client_id, c.name AS client_name, d.site_id FROM devices d
         JOIN sites s ON s.id = d.site_id JOIN clients c ON c.id = s.client_id
         JOIN device_inventory i ON i.device_id = d.id AND i.section = 'security'
         WHERE d.status = 'active' AND json_extract(i.data, '$.encryption.method') = 'bitlocker'
           AND json_extract(i.data, '$.encryption.system_volume_encrypted') = 1
         ORDER BY d.hostname COLLATE NOCASE",
    )
    .fetch_all(&state.db)
    .await?;
    let visible = |d: &DeviceBrief| {
        ctx.scope
            .can_site(perm::SECRETS_MANAGE, &d.client_id, &d.site_id)
    };
    let escrowed: HashSet<String> = sqlx::query_scalar(
        "SELECT DISTINCT device_id FROM escrow_items WHERE kind = 'bitlocker' AND superseded_at IS NULL AND device_id IS NOT NULL",
    )
    .fetch_all(&state.db)
    .await?
    .into_iter()
    .collect();
    let encrypted: Vec<&DeviceBrief> = encrypted.iter().filter(|d| visible(d)).collect();
    let missing: Vec<Value> = encrypted
        .iter()
        .filter(|d| !escrowed.contains(&d.id))
        .map(|d| d.to_json())
        .collect();
    let escrowed_count = encrypted.len() - missing.len();

    // LAPS: devices whose effective policy enables it.
    let policy_ctx = PolicyContext::load(&state.db, None).await?;
    let all: Vec<DeviceBrief> = sqlx::query_as(
        "SELECT d.id, d.hostname, s.client_id, c.name AS client_name, d.site_id FROM devices d
         JOIN sites s ON s.id = d.site_id JOIN clients c ON c.id = s.client_id WHERE d.status = 'active'",
    )
    .fetch_all(&state.db)
    .await?;
    let rotated: std::collections::HashMap<String, Option<DateTime<Utc>>> =
        sqlx::query_as::<_, (String, Option<DateTime<Utc>>)>(
            "SELECT device_id, last_rotated_at FROM laps_state",
        )
        .fetch_all(&state.db)
        .await?
        .into_iter()
        .collect();
    let now = rustrmm_common::now();
    let (mut enabled, mut within) = (0usize, 0usize);
    let mut overdue = Vec::new();
    for device in all.iter().filter(|d| visible(d)) {
        let Some(facts) = policy_ctx.facts(&device.id) else {
            continue;
        };
        let laps = policy::from_effective(&policy_ctx.effective(facts).document).laps;
        if !laps.enabled {
            continue;
        }
        enabled += 1;
        let ok = rotated
            .get(&device.id)
            .and_then(|t| *t)
            .is_some_and(|t| now - t <= chrono::Duration::days(laps.rotate_days));
        if ok {
            within += 1;
        } else {
            overdue.push(device.to_json());
        }
    }
    Ok(Json(json!({
        "bitlocker": { "encrypted_devices": encrypted.len(), "escrowed": escrowed_count, "missing": missing },
        "laps": { "enabled_devices": enabled, "rotated_within_policy": within, "overdue": overdue },
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustrmm_crypto::master::MasterKey;

    #[test]
    fn age_round_trip_with_the_server_identity() {
        let dir = tempfile::tempdir().expect("tempdir");
        let keys =
            crate::keys::KeyRing::load_or_create(dir.path(), &MasterKey::generate()).expect("keys");
        // What an agent does with `AgentConfig.escrow_recipient`.
        let recipient: age::x25519::Recipient =
            keys.escrow_recipient().parse().expect("recipient parses");
        let secret = "123456-234567-345678-456789-567890-678901-789012-890123";
        let ciphertext = age::encrypt(&recipient, secret.as_bytes()).expect("encrypt");
        assert!(ciphertext.starts_with(AGE_HEADER));
        assert!(
            !ciphertext.windows(6).any(|w| w == b"123456"),
            "plaintext is not visible in the ciphertext"
        );
        let plain = decrypt(&keys.escrow, &ciphertext).expect("decrypt");
        assert_eq!(plain.as_str(), secret);
        // Another identity cannot decrypt it.
        let other = age::x25519::Identity::generate();
        assert!(decrypt(&other, &ciphertext).is_err());
    }
}
