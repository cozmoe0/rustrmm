//! Remote desktop (Phase 8, `docs/api-desktop.md`): the device's interactive sessions, desktop
//! sessions relayed over the tunnel broker, and one-shot screenshots.
//!
//! A desktop session reuses the Phase 4 flow: `POST /devices/{id}/desktop` (step-up) creates a
//! `remote_sessions` row of kind `desktop` and a one-time ticket; the browser attaches to
//! `/remote-sessions/{id}/ws`, which asks the agent to dial a `Desktop` tunnel. Frames pass through
//! untouched; the relay only watches control messages to record consent, audit view-only changes
//! and Ctrl+Alt+Del, count clipboard use, and drop input while the session is view-only.

use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use base64::Engine as _;
use rustrmm_proto::commands::Command;
use rustrmm_proto::desktop::{ConsentStatus, DesktopControl, MAX_TEXT_CHARS, Quality, Screenshot};
use rustrmm_proto::remote::{TunnelControl, TunnelKind};
use serde::Deserialize;
use serde_json::{Value, json};

use super::remote::{self, DeviceRef};
use crate::agents::{commands, tunnels};
use crate::audit::{Actor, AuditEntry};
use crate::auth::AuthCtx;
use crate::automation::policies::{self, DesktopPolicy};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

/// No keyboard or mouse input for this long ends a session (acks do not count).
const DESKTOP_IDLE: Duration = Duration::from_secs(30 * 60);
const DESKTOP_MAX: Duration = Duration::from_secs(8 * 3600);
const SCREENSHOT_MAX_WIDTH: u32 = 1280;

fn macos_refused() -> ApiError {
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "device_error",
        "Remote desktop on macOS is not available yet",
    )
}

async fn os_family(state: &AppState, device_id: &str) -> ApiResult<String> {
    Ok(
        sqlx::query_scalar("SELECT os_family FROM devices WHERE id = ?")
            .bind(device_id)
            .fetch_optional(&state.db)
            .await?
            .unwrap_or_default(),
    )
}

async fn desktop_policy(state: &AppState, device_id: &str) -> ApiResult<DesktopPolicy> {
    policies::desktop_policy_for(&state.db, device_id)
        .await
        .map_err(|e| ApiError::internal(format!("{e:#}")))
}

/// `GET /api/v1/devices/{id}/desktop/sessions`
pub async fn sessions(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let dev = remote::device(&state, &ctx, &id, "remote.desktop").await?;
    remote::query(
        &state,
        &ctx,
        &dev,
        Command::DesktopSessions,
        "List desktop sessions",
    )
    .await
}

#[derive(Deserialize)]
pub struct CreateBody {
    #[serde(default)]
    session_id: Option<u32>,
    #[serde(default)]
    view_only: bool,
    #[serde(default)]
    quality: Option<String>,
}

/// `POST /api/v1/devices/{id}/desktop` (step-up): creates a desktop session and a one-time socket
/// ticket. The tunnel opens when the browser attaches to `/remote-sessions/{id}/ws`.
pub async fn create(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(body): Json<CreateBody>,
) -> ApiResult<Json<Value>> {
    ctx.require_session()?;
    ctx.require_step_up()?;
    let dev = remote::device(&state, &ctx, &id, "remote.desktop").await?;
    if !state.agents.is_online(&dev.id) {
        return Err(ApiError::conflict(
            "device_offline",
            "The device is offline",
        ));
    }
    if os_family(&state, &dev.id).await? == "macos" {
        return Err(macos_refused());
    }
    let quality = match body.quality.as_deref().map(str::trim) {
        None | Some("") => Quality::Auto,
        Some(q) => Quality::parse(q)
            .ok_or_else(|| ApiError::validation("quality must be auto, low, medium or high"))?,
    };
    let policy = desktop_policy(&state, &dev.id).await?;
    let view_only = body.view_only || policy.view_only;
    let detail = json!({
        "session_id": body.session_id,
        "view_only": view_only,
        "quality": quality.as_str(),
        "consent": null,
    });
    let session_id =
        remote::new_session(&state, &ctx, &dev, "desktop", &detail.to_string()).await?;
    let ticket = state
        .agents
        .tunnels
        .issue_ticket(&session_id, &ctx.user.id, &ctx.session.id);
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("remote.desktop.opened")
                .target("device", &dev.id, &dev.hostname)
                .client(&dev.client_id)
                .site(&dev.site_id)
                .details(json!({
                    "session_id": session_id,
                    "windows_session": body.session_id,
                    "view_only": view_only,
                    "view_only_forced": policy.view_only,
                    "quality": quality.as_str(),
                })),
        )
        .await;
    Ok(Json(
        json!({ "session_id": session_id, "ticket": ticket, "expires_in": 30 }),
    ))
}

/// `GET /api/v1/devices/{id}/screenshot`: one JPEG of the console session's primary monitor, at
/// most 1280 px wide. Consent rules apply; audited as `remote.screenshot`.
pub async fn screenshot(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let dev = remote::device(&state, &ctx, &id, "remote.desktop").await?;
    if os_family(&state, &dev.id).await? == "macos" {
        return Err(macos_refused());
    }
    let policy = desktop_policy(&state, &dev.id).await?;
    let organization = crate::setup::organization_name(&state)
        .await
        .unwrap_or_default();
    let command = Command::Screenshot(Screenshot {
        max_width: SCREENSHOT_MAX_WIDTH,
        consent: policy.consent,
        consent_timeout_secs: policy.consent_timeout_secs,
        technician: ctx.user.name.clone(),
        organization,
    });
    let timeout = Duration::from_secs(u64::from(policy.consent_timeout_secs) + 60);
    let outcome = commands::request(
        &state,
        &dev.id,
        command,
        Some(&ctx.user.id),
        "Screenshot",
        false,
        timeout,
    )
    .await;
    let decoded = outcome.as_ref().ok().and_then(|result| {
        result.data["jpeg"]
            .as_str()
            .and_then(|b| base64::engine::general_purpose::STANDARD.decode(b).ok())
    });
    let mut details = json!({ "outcome": if decoded.is_some() { "succeeded" } else { "failed" } });
    match &outcome {
        Ok(result) => {
            details["width"] = result.data["width"].clone();
            details["height"] = result.data["height"].clone();
            details["consent"] = result.data["consent"].clone();
        }
        Err(e) => details["error"] = json!(e.to_string()),
    }
    audit_device(&state, &ctx, &dev, "remote.screenshot", details).await;
    let result = outcome.map_err(remote::map_error)?;
    let jpeg = decoded.ok_or_else(|| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "device_error",
            if result.message.is_empty() {
                "The device returned no image".to_string()
            } else {
                result.message.clone()
            },
        )
    })?;
    Ok((
        [
            (header::CONTENT_TYPE, "image/jpeg"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        jpeg,
    )
        .into_response())
}

async fn audit_device(
    state: &AppState,
    ctx: &AuthCtx,
    dev: &DeviceRef,
    action: &'static str,
    details: Value,
) {
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit(action)
                .target("device", &dev.id, &dev.hostname)
                .client(&dev.client_id)
                .site(&dev.site_id)
                .details(details),
        )
        .await;
}

/// What the socket handler learned about a desktop session row.
pub struct DesktopCtx {
    pub session_id: String,
    pub device_id: String,
    pub hostname: String,
    pub user_id: String,
    pub web_session_id: String,
    /// The row's `detail` JSON.
    pub detail: Value,
}

/// Session state the relay keeps for the audit trail and the `detail` column.
struct Relay {
    detail: Value,
    view_only: bool,
    /// Policy forces view-only: `view_only:false` from the browser is dropped.
    view_only_forced: bool,
    consent: Option<ConsentStatus>,
    cad: u32,
    clipboard_to_device: u32,
    clipboard_from_device: u32,
    dropped_inputs: u64,
}

impl Relay {
    async fn save_detail(&mut self, state: &AppState, session_id: &str) {
        self.detail["view_only"] = json!(self.view_only);
        self.detail["consent"] = match self.consent {
            Some(c) => json!(c.as_str()),
            None => Value::Null,
        };
        let _ = sqlx::query("UPDATE remote_sessions SET detail = ? WHERE id = ?")
            .bind(self.detail.to_string())
            .bind(session_id)
            .execute(&state.db)
            .await;
    }
}

struct Auditor {
    actor: Actor,
    device_id: String,
    hostname: String,
    client_id: Option<String>,
    session_id: String,
}

impl Auditor {
    async fn record(&self, state: &AppState, action: &'static str, mut details: Value) {
        details["session_id"] = json!(self.session_id);
        let mut entry = AuditEntry::new(self.actor.clone(), action)
            .target("device", &self.device_id, &self.hostname)
            .details(details);
        if let Some(client) = &self.client_id {
            entry = entry.client(client);
        }
        state.audit.record_or_log(&state.db, entry).await;
    }
}

async fn send_text(socket: &mut WebSocket, text: String) -> bool {
    socket.send(Message::Text(text.into())).await.is_ok()
}

/// Relays one desktop session between the browser socket and the agent's tunnel.
pub async fn run(state: AppState, mut browser: WebSocket, ctx: DesktopCtx) {
    remote::status(&mut browser, "Connecting to the device…").await;
    let user_name: String = sqlx::query_scalar("SELECT name FROM users WHERE id = ?")
        .bind(&ctx.user_id)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    let client_id: Option<String> = sqlx::query_scalar(
        "SELECT s.client_id FROM devices d JOIN sites s ON s.id = d.site_id WHERE d.id = ?",
    )
    .bind(&ctx.device_id)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();
    let auditor = Auditor {
        actor: Actor::User {
            id: ctx.user_id.clone(),
            name: user_name.clone(),
        },
        device_id: ctx.device_id.clone(),
        hostname: ctx.hostname.clone(),
        client_id: client_id.clone(),
        session_id: ctx.session_id.clone(),
    };

    // The policy is read again at connect time: it may have changed since the ticket was issued.
    let policy = match policies::desktop_policy_for(&state.db, &ctx.device_id).await {
        Ok(p) => p,
        Err(e) => {
            abort(&state, &mut browser, &ctx.session_id, &format!("{e:#}")).await;
            return;
        }
    };
    if policy.disabled_by.is_some() {
        abort(
            &state,
            &mut browser,
            &ctx.session_id,
            "Remote desktop is disabled for this device by policy",
        )
        .await;
        return;
    }
    let mut relay = Relay {
        view_only: ctx.detail["view_only"].as_bool().unwrap_or(false) || policy.view_only,
        view_only_forced: policy.view_only,
        detail: ctx.detail.clone(),
        consent: None,
        cad: 0,
        clipboard_to_device: 0,
        clipboard_from_device: 0,
        dropped_inputs: 0,
    };
    let quality = ctx.detail["quality"]
        .as_str()
        .and_then(Quality::parse)
        .unwrap_or_default();
    let windows_session = ctx.detail["session_id"]
        .as_u64()
        .and_then(|v| u32::try_from(v).ok());
    let organization = crate::setup::organization_name(&state)
        .await
        .unwrap_or_default();
    let kind = TunnelKind::Desktop {
        session_id: windows_session,
        monitor: None,
        view_only: relay.view_only,
        quality,
        consent: policy.consent,
        consent_timeout_secs: policy.consent_timeout_secs,
        banner: policy.banner,
        technician: user_name.clone(),
        organization,
    };
    let mut agent =
        match tunnels::open(&state, &ctx.device_id, kind, &ctx.user_id, "Remote desktop").await {
            Ok(ws) => ws,
            Err(e) => {
                abort(&state, &mut browser, &ctx.session_id, &e).await;
                return;
            }
        };
    remote::mark_active(&state, &ctx.session_id).await;
    relay.save_detail(&state, &ctx.session_id).await;
    let cancel = state
        .agents
        .tunnels
        .register_live(&ctx.session_id, &ctx.device_id);
    state.events.publish(
        "remote.session",
        client_id.clone(),
        json!({ "session_id": ctx.session_id, "device_id": ctx.device_id, "status": "active", "kind": "desktop" }),
    );

    let started = Instant::now();
    let mut last_input = Instant::now();
    let mut to_device: u64 = 0;
    let mut from_device: u64 = 0;
    let mut checks = tokio::time::interval(Duration::from_secs(30));
    checks.tick().await;
    let reason: String = loop {
        tokio::select! {
            _ = cancel.cancelled() => break "ended by an administrator".into(),
            _ = checks.tick() => {
                if !remote::web_session_valid(&state, &ctx.web_session_id, &ctx.user_id).await {
                    break "operator signed out".into();
                }
                if last_input.elapsed() > DESKTOP_IDLE {
                    break "idle timeout".into();
                }
                if started.elapsed() > DESKTOP_MAX {
                    break "maximum session length reached".into();
                }
            }
            incoming = agent.recv() => match incoming {
                Some(Ok(Message::Binary(bytes))) => {
                    from_device += bytes.len() as u64;
                    if browser.send(Message::Binary(bytes)).await.is_err() {
                        break "operator disconnected".into();
                    }
                }
                Some(Ok(Message::Text(text))) => {
                    from_device += text.len() as u64;
                    let parsed = serde_json::from_str::<DesktopControl>(&text).ok();
                    let mut end: Option<String> = None;
                    match &parsed {
                        Some(DesktopControl::Consent { status }) if *status != ConsentStatus::Waiting => {
                            relay.consent = Some(*status);
                            relay.save_detail(&state, &ctx.session_id).await;
                            auditor.record(&state, "remote.desktop.consent", json!({ "status": status.as_str() })).await;
                            if !status.allows() {
                                end = Some(match status {
                                    ConsentStatus::Timeout => "the user did not answer the consent prompt".into(),
                                    _ => "the user denied the session".into(),
                                });
                            }
                        }
                        Some(DesktopControl::Ready { .. }) if relay.consent.is_none() => {
                            relay.consent = Some(ConsentStatus::NotRequired);
                            relay.save_detail(&state, &ctx.session_id).await;
                        }
                        Some(DesktopControl::Clipboard { .. }) => relay.clipboard_from_device += 1,
                        Some(DesktopControl::Exit { .. }) => end = Some("desktop session ended".into()),
                        _ => {}
                    }
                    if !send_text(&mut browser, text.to_string()).await {
                        break "operator disconnected".into();
                    }
                    if let Some(reason) = end {
                        break reason;
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break "device closed the session".into(),
                Some(Ok(_)) => {}
            },
            incoming = browser.recv() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    let Ok(message) = serde_json::from_str::<DesktopControl>(&text) else { continue };
                    if message.is_input() && relay.view_only {
                        relay.dropped_inputs += 1;
                        continue;
                    }
                    let forward = match &message {
                        DesktopControl::Ack { .. }
                        | DesktopControl::Monitor { .. }
                        | DesktopControl::Quality { .. }
                        | DesktopControl::Refresh => true,
                        DesktopControl::Mouse { .. } | DesktopControl::Key { .. } => {
                            last_input = Instant::now();
                            true
                        }
                        DesktopControl::Text { text } => {
                            last_input = Instant::now();
                            text.chars().count() <= MAX_TEXT_CHARS
                        }
                        DesktopControl::Clipboard { text } => {
                            last_input = Instant::now();
                            relay.clipboard_to_device += 1;
                            text.len() <= rustrmm_proto::desktop::MAX_CLIPBOARD_BYTES
                        }
                        DesktopControl::Cad => {
                            last_input = Instant::now();
                            relay.cad += 1;
                            auditor.record(&state, "remote.desktop.cad", json!({})).await;
                            true
                        }
                        DesktopControl::ViewOnly { value } => {
                            if !*value && relay.view_only_forced {
                                false
                            } else if *value != relay.view_only {
                                relay.view_only = *value;
                                relay.save_detail(&state, &ctx.session_id).await;
                                auditor.record(&state, "remote.desktop.view_only", json!({ "value": value })).await;
                                true
                            } else {
                                false
                            }
                        }
                        // Agent-to-browser message types are never accepted from the browser.
                        _ => false,
                    };
                    if forward {
                        to_device += text.len() as u64;
                        if agent.send(Message::Text(text)).await.is_err() {
                            break "device disconnected".into();
                        }
                    }
                }
                // Desktops take no binary input from the browser.
                Some(Ok(Message::Binary(_))) => {}
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break "operator closed the session".into(),
                Some(Ok(_)) => {}
            },
        }
    };
    state.agents.tunnels.unregister_live(&ctx.session_id);
    let _ = agent.send(Message::Close(None)).await;
    let _ = send_text(
        &mut browser,
        json!({ "type": "closed", "reason": reason }).to_string(),
    )
    .await;
    let _ = browser.send(Message::Close(None)).await;
    remote::finish_session(
        &state,
        &ctx.session_id,
        "ended",
        &reason,
        to_device,
        from_device,
        None,
    )
    .await;
    state.events.publish(
        "remote.session",
        client_id,
        json!({ "session_id": ctx.session_id, "device_id": ctx.device_id, "status": "ended", "kind": "desktop" }),
    );
    auditor
        .record(
            &state,
            "remote.desktop.ended",
            json!({
                "reason": reason,
                "duration_secs": started.elapsed().as_secs(),
                "bytes_to_device": to_device,
                "bytes_from_device": from_device,
                "consent": relay.consent.map(ConsentStatus::as_str),
                "view_only": relay.view_only,
                "ctrl_alt_del": relay.cad,
                "clipboard_to_device": relay.clipboard_to_device,
                "clipboard_from_device": relay.clipboard_from_device,
                "dropped_inputs": relay.dropped_inputs,
            }),
        )
        .await;
}

/// Reports a failure before streaming started and marks the session failed.
async fn abort(state: &AppState, browser: &mut WebSocket, session_id: &str, message: &str) {
    let _ = send_text(
        browser,
        TunnelControl::Error {
            message: message.to_string(),
        }
        .to_text(),
    )
    .await;
    let _ = browser.send(Message::Close(None)).await;
    remote::finish_session(state, session_id, "failed", message, 0, 0, None).await;
}
