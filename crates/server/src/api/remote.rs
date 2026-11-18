//! Remote tools: processes, services, event logs, registry, files, power, messages, diagnostics,
//! and interactive shells with recording.

use std::time::{Duration, Instant};

use axum::Json;
use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Utc};
use futures::StreamExt;
use rustrmm_proto::commands::Command;
use rustrmm_proto::remote::{
    DiagnosticKind, FileOp, PowerAction, ServiceAction, TunnelControl, TunnelKind,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::agents::commands::{self, RequestError};
use crate::agents::tunnels::{self, Recorder};
use crate::auth::AuthCtx;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

const QUERY_TIMEOUT: Duration = Duration::from_secs(60);
const ACTION_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_UPLOAD: u64 = 2 * 1024 * 1024 * 1024;
const SHELL_IDLE: Duration = Duration::from_secs(30 * 60);
const SHELL_MAX: Duration = Duration::from_secs(8 * 3600);

pub(crate) struct DeviceRef {
    pub(crate) id: String,
    pub(crate) client_id: String,
    pub(crate) site_id: String,
    pub(crate) hostname: String,
}

pub(crate) async fn device(
    state: &AppState,
    ctx: &AuthCtx,
    id: &str,
    permission: &str,
) -> ApiResult<DeviceRef> {
    let row: Option<(String, String, String, String)> = sqlx::query_as(
        "SELECT s.client_id, d.site_id, d.hostname, d.status FROM devices d JOIN sites s ON s.id = d.site_id WHERE d.id = ?",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?;
    let (client_id, site_id, hostname, status) =
        row.ok_or_else(|| ApiError::not_found("Device"))?;
    if !ctx.scope.can_site("devices.view", &client_id, &site_id) {
        return Err(ApiError::not_found("Device"));
    }
    if !ctx.scope.can_site(permission, &client_id, &site_id) {
        return Err(
            ApiError::forbidden(format!("Missing permission: {permission}"))
                .with_details(json!({ "permission": permission })),
        );
    }
    if status != "active" {
        return Err(ApiError::conflict(
            "device_inactive",
            "The device is not active",
        ));
    }
    enforce_policy(state, id, permission).await?;
    Ok(DeviceRef {
        id: id.to_string(),
        client_id,
        site_id,
        hostname,
    })
}

/// The device's effective policy can switch remote features off (`remote_access` section).
async fn enforce_policy(state: &AppState, device_id: &str, permission: &str) -> ApiResult<()> {
    let (feature, label) = match permission {
        "remote.shell" => ("shell", "Remote shell"),
        "remote.files" => ("files", "File transfer"),
        "remote.system" => ("system", "System tools"),
        "remote.power" => ("power", "Power actions and messages"),
        "remote.desktop" => ("desktop", "Remote desktop"),
        _ => return Ok(()),
    };
    if let Some(policy_id) =
        crate::automation::policies::remote_disabled_by(&state.db, device_id, feature).await?
    {
        let policy_name: Option<String> =
            sqlx::query_scalar("SELECT name FROM policies WHERE id = ?")
                .bind(&policy_id)
                .fetch_optional(&state.db)
                .await?;
        let message = match &policy_name {
            Some(name) => format!("{label} is disabled for this device by the policy \"{name}\""),
            None => format!("{label} is disabled for this device by policy"),
        };
        return Err(
            ApiError::new(StatusCode::FORBIDDEN, "disabled_by_policy", message).with_details(
                json!({ "feature": feature, "policy_id": policy_id, "policy_name": policy_name }),
            ),
        );
    }
    Ok(())
}

pub(crate) fn map_error(e: RequestError) -> ApiError {
    match e {
        RequestError::Offline => ApiError::conflict("device_offline", "The device is offline"),
        RequestError::Timeout => ApiError::new(
            StatusCode::GATEWAY_TIMEOUT,
            "device_timeout",
            "The device did not answer in time",
        ),
        RequestError::Refused(message) => {
            ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "device_error", message)
        }
        RequestError::Other(e) => ApiError::internal(format!("{e:#}")),
    }
}

/// Runs a read-only query (not recorded in command history).
pub(crate) async fn query(
    state: &AppState,
    ctx: &AuthCtx,
    dev: &DeviceRef,
    command: Command,
    summary: &str,
) -> ApiResult<Json<Value>> {
    let result = commands::request(
        state,
        &dev.id,
        command,
        Some(&ctx.user.id),
        summary,
        false,
        QUERY_TIMEOUT,
    )
    .await
    .map_err(map_error)?;
    Ok(Json(result.data))
}

/// Runs a state-changing action: recorded in command history and the audit log.
async fn action(
    state: &AppState,
    ctx: &AuthCtx,
    dev: &DeviceRef,
    command: Command,
    audit_action: &'static str,
    summary: String,
    details: Value,
) -> ApiResult<Json<Value>> {
    let outcome = commands::request(
        state,
        &dev.id,
        command,
        Some(&ctx.user.id),
        &summary,
        true,
        ACTION_TIMEOUT,
    )
    .await;
    let ok = outcome.is_ok();
    let mut details = details;
    details["summary"] = json!(summary);
    details["outcome"] = json!(if ok { "succeeded" } else { "failed" });
    if let Err(e) = &outcome {
        details["error"] = json!(e.to_string());
    }
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit(audit_action)
                .target("device", &dev.id, &dev.hostname)
                .client(&dev.client_id)
                .site(&dev.site_id)
                .details(details),
        )
        .await;
    let result = outcome.map_err(map_error)?;
    Ok(Json(
        json!({ "ok": true, "message": result.message, "data": result.data }),
    ))
}

// ------------------------------------------------------------------ processes & services

/// `GET /api/v1/devices/{id}/processes`
#[utoipa::path(get, path = "/api/v1/devices/{id}/processes", tag = "Remote tools", summary = "Processes", params(("id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn processes(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let dev = device(&state, &ctx, &id, "remote.system").await?;
    query(&state, &ctx, &dev, Command::ListProcesses, "List processes").await
}

#[derive(Deserialize, Default)]
pub struct KillBody {
    #[serde(default)]
    tree: bool,
}

/// `POST /api/v1/devices/{id}/processes/{pid}/kill`
#[utoipa::path(post, path = "/api/v1/devices/{id}/processes/{pid}/kill", tag = "Remote tools", summary = "Kill process", params(("id" = String, Path), ("pid" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn kill_process(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path((id, pid)): Path<(String, u32)>,
    body: Option<Json<KillBody>>,
) -> ApiResult<Json<Value>> {
    let dev = device(&state, &ctx, &id, "remote.system").await?;
    let tree = body.map(|b| b.tree).unwrap_or(false);
    action(
        &state,
        &ctx,
        &dev,
        Command::KillProcess { pid, tree },
        "remote.process.killed",
        format!(
            "Terminate process {pid}{}",
            if tree { " and its children" } else { "" }
        ),
        json!({ "pid": pid, "tree": tree }),
    )
    .await
}

/// `GET /api/v1/devices/{id}/services`
#[utoipa::path(get, path = "/api/v1/devices/{id}/services", tag = "Remote tools", summary = "Services", params(("id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn services(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let dev = device(&state, &ctx, &id, "remote.system").await?;
    query(&state, &ctx, &dev, Command::ListServices, "List services").await
}

/// `POST /api/v1/devices/{id}/services/{name}/{action}`
#[utoipa::path(post, path = "/api/v1/devices/{id}/services/{name}/{action}", tag = "Remote tools", summary = "Control service", params(("id" = String, Path), ("name" = String, Path), ("action" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn control_service(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path((id, name, verb)): Path<(String, String, String)>,
) -> ApiResult<Json<Value>> {
    let dev = device(&state, &ctx, &id, "remote.system").await?;
    let service_action = match verb.as_str() {
        "start" => ServiceAction::Start,
        "stop" => ServiceAction::Stop,
        "restart" => ServiceAction::Restart,
        _ => {
            return Err(ApiError::validation(
                "action must be start, stop or restart",
            ));
        }
    };
    if !rustrmm_proto::remote::valid_service_name(&name) {
        return Err(ApiError::validation("Invalid service name"));
    }
    action(
        &state,
        &ctx,
        &dev,
        Command::ControlService {
            name: name.clone(),
            action: service_action,
        },
        "remote.service.controlled",
        format!("{} service {name}", capitalize(&verb)),
        json!({ "service": name, "action": verb }),
    )
    .await
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    c.next()
        .map(|f| f.to_uppercase().collect::<String>() + c.as_str())
        .unwrap_or_default()
}

// ------------------------------------------------------------------ event logs & registry

#[derive(Deserialize)]
pub struct EventLogQuery {
    #[serde(default)]
    log: String,
    #[serde(default)]
    level: u8,
    #[serde(default)]
    limit: Option<u32>,
    #[serde(default)]
    hours: u32,
}

/// `GET /api/v1/devices/{id}/event-logs?log=System&level=3&limit=200&hours=24`
#[utoipa::path(get, path = "/api/v1/devices/{id}/event-logs", tag = "Remote tools", summary = "Event logs", params(("id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn event_logs(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Query(q): Query<EventLogQuery>,
) -> ApiResult<Json<Value>> {
    let dev = device(&state, &ctx, &id, "remote.system").await?;
    query(
        &state,
        &ctx,
        &dev,
        Command::EventLog {
            log: q.log,
            max_level: q.level.min(4),
            limit: q.limit.unwrap_or(200).clamp(1, 1000),
            hours: q.hours,
        },
        "Read event log",
    )
    .await
}

#[derive(Deserialize)]
pub struct PathQuery {
    #[serde(default)]
    path: String,
}

/// `GET /api/v1/devices/{id}/registry?path=HKLM\SOFTWARE`
#[utoipa::path(get, path = "/api/v1/devices/{id}/registry", tag = "Remote tools", summary = "Registry", params(("id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn registry(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Query(q): Query<PathQuery>,
) -> ApiResult<Json<Value>> {
    let dev = device(&state, &ctx, &id, "remote.system").await?;
    query(
        &state,
        &ctx,
        &dev,
        Command::RegistryList { path: q.path },
        "Browse registry",
    )
    .await
}

// ------------------------------------------------------------------ power, messages, diagnostics

#[derive(Deserialize)]
pub struct PowerBody {
    action: PowerAction,
    #[serde(default)]
    delay_secs: u32,
    #[serde(default)]
    message: String,
}

/// `POST /api/v1/devices/{id}/power` — reboot/shutdown/sign-out need a recent MFA step-up.
#[utoipa::path(post, path = "/api/v1/devices/{id}/power", tag = "Remote tools", summary = "Power", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn power(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(body): Json<PowerBody>,
) -> ApiResult<Json<Value>> {
    let dev = device(&state, &ctx, &id, "remote.power").await?;
    if matches!(
        body.action,
        PowerAction::Reboot | PowerAction::Shutdown | PowerAction::Logoff
    ) {
        ctx.require_step_up()?;
    }
    let verb = match body.action {
        PowerAction::Reboot => "Reboot",
        PowerAction::Shutdown => "Shut down",
        PowerAction::Cancel => "Cancel pending shutdown",
        PowerAction::Logoff => "Sign out user",
        PowerAction::Lock => "Lock",
    };
    let summary = if body.delay_secs > 0
        && matches!(body.action, PowerAction::Reboot | PowerAction::Shutdown)
    {
        format!("{verb} in {} s", body.delay_secs)
    } else {
        verb.to_string()
    };
    action(
        &state,
        &ctx,
        &dev,
        Command::Power {
            action: body.action,
            delay_secs: body.delay_secs,
            message: body.message.clone(),
        },
        "remote.power",
        summary,
        json!({ "action": body.action, "delay_secs": body.delay_secs }),
    )
    .await
}

#[derive(Deserialize)]
pub struct MessageBody {
    #[serde(default)]
    title: String,
    body: String,
    #[serde(default)]
    timeout_secs: u32,
}

/// `POST /api/v1/devices/{id}/message`
#[utoipa::path(post, path = "/api/v1/devices/{id}/message", tag = "Remote tools", summary = "Message", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn message(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(body): Json<MessageBody>,
) -> ApiResult<Json<Value>> {
    let dev = device(&state, &ctx, &id, "remote.power").await?;
    if body.body.trim().is_empty() {
        return Err(ApiError::validation("The message is empty"));
    }
    action(
        &state,
        &ctx,
        &dev,
        Command::MessageUser {
            title: body.title.clone(),
            body: body.body.clone(),
            timeout_secs: body.timeout_secs,
        },
        "remote.message.sent",
        "Message user".to_string(),
        json!({ "title": body.title, "length": body.body.chars().count() }),
    )
    .await
}

#[derive(Deserialize)]
pub struct DiagnosticBody {
    kind: DiagnosticKind,
    target: String,
    #[serde(default)]
    port: Option<u16>,
}

/// `POST /api/v1/devices/{id}/diagnostics`
#[utoipa::path(post, path = "/api/v1/devices/{id}/diagnostics", tag = "Remote tools", summary = "Diagnostics", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn diagnostics(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(body): Json<DiagnosticBody>,
) -> ApiResult<Json<Value>> {
    let dev = device(&state, &ctx, &id, "remote.system").await?;
    if !rustrmm_proto::remote::valid_target(body.target.trim()) {
        return Err(ApiError::validation("Enter a host name or IP address"));
    }
    let result = commands::request(
        &state,
        &dev.id,
        Command::Diagnostic {
            kind: body.kind,
            target: body.target.trim().to_string(),
            port: body.port,
        },
        Some(&ctx.user.id),
        "Network diagnostic",
        false,
        Duration::from_secs(120),
    )
    .await
    .map_err(map_error)?;
    Ok(Json(result.data))
}

// ------------------------------------------------------------------ files

/// `GET /api/v1/devices/{id}/files?path=` — empty path lists drives / `/`.
#[utoipa::path(get, path = "/api/v1/devices/{id}/files", tag = "Remote tools", summary = "List files", params(("id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn list_files(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Query(q): Query<PathQuery>,
) -> ApiResult<Json<Value>> {
    let dev = device(&state, &ctx, &id, "remote.files").await?;
    query(
        &state,
        &ctx,
        &dev,
        Command::ListDir { path: q.path },
        "List folder",
    )
    .await
}

/// `POST /api/v1/devices/{id}/files/op` — `{op: mkdir|rename|delete, …}`
#[utoipa::path(post, path = "/api/v1/devices/{id}/files/op", tag = "Remote tools", summary = "File op", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn file_op(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(op): Json<FileOp>,
) -> ApiResult<Json<Value>> {
    let dev = device(&state, &ctx, &id, "remote.files").await?;
    let summary = op.summary();
    let details = serde_json::to_value(&op).unwrap_or(Value::Null);
    action(
        &state,
        &ctx,
        &dev,
        Command::FileOp(op),
        "remote.file.changed",
        summary,
        details,
    )
    .await
}

pub(crate) async fn new_session(
    state: &AppState,
    ctx: &AuthCtx,
    dev: &DeviceRef,
    kind: &str,
    detail: &str,
) -> ApiResult<String> {
    let id = rustrmm_common::new_id();
    sqlx::query(
        "INSERT INTO remote_sessions (id, device_id, user_id, user_name, kind, detail, status, started_at, client_ip) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
    )
    .bind(&id)
    .bind(&dev.id)
    .bind(&ctx.user.id)
    .bind(&ctx.user.name)
    .bind(kind)
    .bind(detail)
    .bind(rustrmm_common::now())
    .bind(&ctx.ip)
    .execute(&state.db)
    .await?;
    Ok(id)
}

pub(crate) async fn finish_session(
    state: &AppState,
    id: &str,
    status: &str,
    reason: &str,
    to_device: u64,
    from_device: u64,
    recording: Option<(&str, u64)>,
) {
    let _ = sqlx::query(
        "UPDATE remote_sessions SET status = ?, ended_at = ?, end_reason = ?, bytes_to_device = ?, bytes_from_device = ?, recording = COALESCE(?, recording), recording_bytes = COALESCE(?, recording_bytes) WHERE id = ?",
    )
    .bind(status)
    .bind(rustrmm_common::now())
    .bind(reason)
    .bind(to_device as i64)
    .bind(from_device as i64)
    .bind(recording.map(|r| r.0))
    .bind(recording.map(|r| r.1 as i64))
    .bind(id)
    .execute(&state.db)
    .await;
}

pub(crate) async fn mark_active(state: &AppState, id: &str) {
    let _ =
        sqlx::query("UPDATE remote_sessions SET status = 'active', connected_at = ? WHERE id = ?")
            .bind(rustrmm_common::now())
            .bind(id)
            .execute(&state.db)
            .await;
}

/// RFC 5987 encoding for `filename*`.
fn encode_filename(name: &str) -> String {
    let mut out = String::new();
    for b in name.bytes() {
        if b.is_ascii_alphanumeric() || b"!#$&+.^_`|~-".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `GET /api/v1/devices/{id}/files/download?path=` — streams a file from the device.
#[utoipa::path(get, path = "/api/v1/devices/{id}/files/download", tag = "Remote tools", summary = "Download", params(("id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn download(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Query(q): Query<PathQuery>,
) -> ApiResult<Response> {
    let dev = device(&state, &ctx, &id, "remote.files").await?;
    if q.path.trim().is_empty() {
        return Err(ApiError::validation("A file path is required"));
    }
    let session_id = new_session(&state, &ctx, &dev, "download", &q.path).await?;
    let mut agent = match tunnels::open(
        &state,
        &dev.id,
        TunnelKind::Download {
            path: q.path.clone(),
        },
        &ctx.user.id,
        &format!("Download {}", q.path),
    )
    .await
    {
        Ok(ws) => ws,
        Err(e) => {
            finish_session(&state, &session_id, "failed", &e, 0, 0, None).await;
            return Err(ApiError::conflict("tunnel_failed", e));
        }
    };
    // The first message is the file's metadata (or an error).
    let meta = tokio::time::timeout(Duration::from_secs(30), agent.recv()).await;
    let (name, size) = match meta {
        Ok(Some(Ok(Message::Text(text)))) => match serde_json::from_str::<TunnelControl>(&text) {
            Ok(TunnelControl::Meta { name, size }) => (name, size),
            Ok(TunnelControl::Error { message }) => {
                finish_session(&state, &session_id, "failed", &message, 0, 0, None).await;
                return Err(ApiError::new(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "device_error",
                    message,
                ));
            }
            _ => return Err(ApiError::internal("unexpected tunnel message")),
        },
        _ => {
            finish_session(&state, &session_id, "failed", "no response", 0, 0, None).await;
            return Err(ApiError::new(
                StatusCode::GATEWAY_TIMEOUT,
                "device_timeout",
                "The device did not start the transfer",
            ));
        }
    };
    mark_active(&state, &session_id).await;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("remote.file.downloaded")
                .target("device", &dev.id, &dev.hostname)
                .client(&dev.client_id)
                .site(&dev.site_id)
                .details(json!({ "path": q.path, "size": size, "session_id": session_id })),
        )
        .await;

    struct Transfer {
        agent: crate::agents::channel::AgentSocket,
        state: AppState,
        session_id: String,
        sent: u64,
        done: bool,
    }
    let stream = futures::stream::unfold(
        Transfer {
            agent,
            state: state.clone(),
            session_id,
            sent: 0,
            done: false,
        },
        |mut t| async move {
            if t.done {
                return None;
            }
            loop {
                match tokio::time::timeout(Duration::from_secs(120), t.agent.recv()).await {
                    Ok(Some(Ok(Message::Binary(bytes)))) => {
                        t.sent += bytes.len() as u64;
                        return Some((Ok::<_, std::io::Error>(bytes), t));
                    }
                    Ok(Some(Ok(Message::Text(text)))) => {
                        if matches!(serde_json::from_str(&text), Ok(TunnelControl::Eof)) {
                            t.done = true;
                            let _ = t.agent.send(Message::Close(None)).await;
                            finish_session(
                                &t.state,
                                &t.session_id,
                                "ended",
                                "completed",
                                0,
                                t.sent,
                                None,
                            )
                            .await;
                            return None;
                        }
                    }
                    Ok(Some(Ok(_))) => {}
                    _ => {
                        t.done = true;
                        finish_session(
                            &t.state,
                            &t.session_id,
                            "failed",
                            "interrupted",
                            0,
                            t.sent,
                            None,
                        )
                        .await;
                        return Some((Err(std::io::Error::other("transfer interrupted")), t));
                    }
                }
            }
        },
    );
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (header::CONTENT_LENGTH, size.to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename*=UTF-8''{}", encode_filename(&name)),
            ),
            (header::CACHE_CONTROL, "no-store".to_string()),
        ],
        Body::from_stream(stream),
    )
        .into_response())
}

#[derive(Deserialize)]
pub struct UploadQuery {
    path: String,
    #[serde(default)]
    overwrite: bool,
}

/// `POST /api/v1/devices/{id}/files/upload?path=<full target path>&overwrite=` — raw body.
#[utoipa::path(post, path = "/api/v1/devices/{id}/files/upload", tag = "Remote tools", summary = "Upload", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn upload(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Query(q): Query<UploadQuery>,
    headers: HeaderMap,
    body: Body,
) -> ApiResult<Json<Value>> {
    let dev = device(&state, &ctx, &id, "remote.files").await?;
    let size: u64 = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| ApiError::validation("Content-Length is required"))?;
    if size > MAX_UPLOAD {
        return Err(ApiError::validation(
            "Files larger than 2 GiB cannot be uploaded",
        ));
    }
    if q.path.trim().is_empty() {
        return Err(ApiError::validation("A target path is required"));
    }
    let session_id = new_session(&state, &ctx, &dev, "upload", &q.path).await?;
    let mut agent = match tunnels::open(
        &state,
        &dev.id,
        TunnelKind::Upload {
            path: q.path.clone(),
            size,
            overwrite: q.overwrite,
        },
        &ctx.user.id,
        &format!("Upload {}", q.path),
    )
    .await
    {
        Ok(ws) => ws,
        Err(e) => {
            finish_session(&state, &session_id, "failed", &e, 0, 0, None).await;
            return Err(ApiError::conflict("tunnel_failed", e));
        }
    };
    let fail =
        |message: String| ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "device_error", message);
    match tokio::time::timeout(Duration::from_secs(30), agent.recv()).await {
        Ok(Some(Ok(Message::Text(text)))) => match serde_json::from_str::<TunnelControl>(&text) {
            Ok(TunnelControl::Ready) => {}
            Ok(TunnelControl::Error { message }) => {
                finish_session(&state, &session_id, "failed", &message, 0, 0, None).await;
                return Err(fail(message));
            }
            _ => return Err(ApiError::internal("unexpected tunnel message")),
        },
        _ => {
            finish_session(&state, &session_id, "failed", "no response", 0, 0, None).await;
            return Err(ApiError::new(
                StatusCode::GATEWAY_TIMEOUT,
                "device_timeout",
                "The device did not accept the upload",
            ));
        }
    }
    mark_active(&state, &session_id).await;

    let mut sent: u64 = 0;
    let mut data = body.into_data_stream();
    while let Some(chunk) = data.next().await {
        let chunk = chunk.map_err(|e| ApiError::bad_request(format!("upload interrupted: {e}")))?;
        sent += chunk.len() as u64;
        if sent > size {
            finish_session(
                &state,
                &session_id,
                "failed",
                "body larger than Content-Length",
                sent,
                0,
                None,
            )
            .await;
            return Err(ApiError::validation("Body is larger than Content-Length"));
        }
        for piece in chunk.chunks(1024 * 1024) {
            if agent
                .send(Message::Binary(piece.to_vec().into()))
                .await
                .is_err()
            {
                finish_session(
                    &state,
                    &session_id,
                    "failed",
                    "device disconnected",
                    sent,
                    0,
                    None,
                )
                .await;
                return Err(ApiError::conflict(
                    "tunnel_failed",
                    "The device disconnected during the upload",
                ));
            }
        }
    }
    let _ = agent
        .send(Message::Text(TunnelControl::Eof.to_text().into()))
        .await;
    let outcome = loop {
        match tokio::time::timeout(Duration::from_secs(60), agent.recv()).await {
            Ok(Some(Ok(Message::Text(text)))) => match serde_json::from_str::<TunnelControl>(&text)
            {
                Ok(TunnelControl::Done { bytes }) => break Ok(bytes),
                Ok(TunnelControl::Error { message }) => break Err(message),
                _ => {}
            },
            Ok(Some(Ok(_))) => {}
            _ => break Err("the device did not confirm the upload".to_string()),
        }
    };
    let _ = agent.send(Message::Close(None)).await;
    let (status, reason) = match &outcome {
        Ok(_) => ("ended", "completed".to_string()),
        Err(e) => ("failed", e.clone()),
    };
    finish_session(&state, &session_id, status, &reason, sent, 0, None).await;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("remote.file.uploaded")
                .target("device", &dev.id, &dev.hostname)
                .client(&dev.client_id)
                .site(&dev.site_id)
                .details(json!({ "path": q.path, "size": size, "outcome": status, "session_id": session_id })),
        )
        .await;
    let bytes = outcome.map_err(fail)?;
    Ok(Json(json!({ "ok": true, "bytes": bytes, "path": q.path })))
}

// ------------------------------------------------------------------ shell

#[derive(Deserialize)]
pub struct ShellBody {
    #[serde(default)]
    shell: String,
    #[serde(default = "default_cols")]
    cols: u16,
    #[serde(default = "default_rows")]
    rows: u16,
}

fn default_cols() -> u16 {
    120
}
fn default_rows() -> u16 {
    32
}

/// `POST /api/v1/devices/{id}/shell` (step-up) — creates a shell session and a one-time socket
/// ticket. The tunnel opens when the browser attaches to `/remote-sessions/{id}/ws`.
#[utoipa::path(post, path = "/api/v1/devices/{id}/shell", tag = "Remote tools", summary = "Create shell", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn create_shell(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(body): Json<ShellBody>,
) -> ApiResult<Json<Value>> {
    ctx.require_session()?;
    ctx.require_step_up()?;
    let dev = device(&state, &ctx, &id, "remote.shell").await?;
    if !state.agents.is_online(&dev.id) {
        return Err(ApiError::conflict(
            "device_offline",
            "The device is offline",
        ));
    }
    let shell = body.shell.trim().to_ascii_lowercase();
    if !shell.is_empty()
        && !["powershell", "pwsh", "cmd", "bash", "zsh", "sh"].contains(&shell.as_str())
    {
        return Err(ApiError::validation("Unsupported shell"));
    }
    let detail = json!({ "shell": shell, "cols": body.cols, "rows": body.rows }).to_string();
    let session_id = new_session(&state, &ctx, &dev, "shell", &detail).await?;
    let ticket = state
        .agents
        .tunnels
        .issue_ticket(&session_id, &ctx.user.id, &ctx.session.id);
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("remote.shell.opened")
                .target("device", &dev.id, &dev.hostname)
                .client(&dev.client_id)
                .site(&dev.site_id)
                .details(json!({ "session_id": session_id, "shell": shell })),
        )
        .await;
    Ok(Json(
        json!({ "session_id": session_id, "ticket": ticket, "expires_in": 30 }),
    ))
}

#[derive(Deserialize)]
pub struct TicketQuery {
    ticket: String,
}

/// `GET /api/v1/remote-sessions/{id}/ws?ticket=` (WebSocket upgrade) for shell and desktop
/// sessions.
#[utoipa::path(get, path = "/api/v1/remote-sessions/{id}/ws", tag = "Remote tools", summary = "Shell socket", params(("id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn shell_socket(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<TicketQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> ApiResult<Response> {
    crate::auth::check_origin_headers(&state, &headers, true)?;
    let ticket = state
        .agents
        .tunnels
        .redeem_ticket(&q.ticket)
        .filter(|t| t.remote_session_id == id)
        .ok_or_else(ApiError::unauthenticated)?;
    if !web_session_valid(&state, &ticket.web_session_id, &ticket.user_id).await {
        return Err(ApiError::unauthenticated());
    }
    let row: Option<(String, String, String, String, String)> = sqlx::query_as(
        "SELECT r.device_id, r.detail, r.status, d.hostname, r.kind FROM remote_sessions r JOIN devices d ON d.id = r.device_id WHERE r.id = ? AND r.kind IN ('shell', 'desktop') AND r.user_id = ?",
    )
    .bind(&id)
    .bind(&ticket.user_id)
    .fetch_optional(&state.db)
    .await?;
    let (device_id, detail, status, hostname, kind) =
        row.ok_or_else(|| ApiError::not_found("Session"))?;
    if status != "pending" {
        return Err(ApiError::conflict(
            "session_used",
            "This session has already been used",
        ));
    }
    let detail: Value = serde_json::from_str(&detail).unwrap_or(Value::Null);
    if kind == "desktop" {
        let ctx = super::desktop::DesktopCtx {
            session_id: id,
            device_id,
            hostname,
            user_id: ticket.user_id,
            web_session_id: ticket.web_session_id,
            detail,
        };
        return Ok(ws
            .max_message_size(1024 * 1024 + 64 * 1024)
            .on_upgrade(move |socket| super::desktop::run(state, socket, ctx)));
    }
    let shell = detail["shell"].as_str().unwrap_or("").to_string();
    let cols = detail["cols"].as_u64().unwrap_or(120) as u16;
    let rows = detail["rows"].as_u64().unwrap_or(32) as u16;
    let ctx = ShellCtx {
        session_id: id,
        device_id,
        hostname,
        user_id: ticket.user_id,
        web_session_id: ticket.web_session_id,
        shell,
        cols,
        rows,
    };
    Ok(ws
        .max_message_size(1024 * 1024)
        .on_upgrade(move |socket| run_shell(state, socket, ctx)))
}

pub(crate) async fn web_session_valid(state: &AppState, session_id: &str, user_id: &str) -> bool {
    sqlx::query_scalar::<_, String>(
        "SELECT id FROM sessions WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?",
    )
    .bind(session_id)
    .bind(user_id)
    .bind(rustrmm_common::now())
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten()
    .is_some()
}

struct ShellCtx {
    session_id: String,
    device_id: String,
    hostname: String,
    user_id: String,
    web_session_id: String,
    shell: String,
    cols: u16,
    rows: u16,
}

pub(crate) async fn status(browser: &mut WebSocket, message: &str) {
    let _ = browser
        .send(Message::Text(
            json!({ "type": "status", "message": message })
                .to_string()
                .into(),
        ))
        .await;
}

async fn run_shell(state: AppState, mut browser: WebSocket, ctx: ShellCtx) {
    status(&mut browser, "Connecting to the device…").await;
    let mut agent = match tunnels::open(
        &state,
        &ctx.device_id,
        TunnelKind::Shell {
            shell: ctx.shell.clone(),
            cols: ctx.cols,
            rows: ctx.rows,
        },
        &ctx.user_id,
        "Remote shell",
    )
    .await
    {
        Ok(ws) => ws,
        Err(e) => {
            let _ = browser
                .send(Message::Text(
                    TunnelControl::Error { message: e.clone() }.to_text().into(),
                ))
                .await;
            let _ = browser.send(Message::Close(None)).await;
            finish_session(&state, &ctx.session_id, "failed", &e, 0, 0, None).await;
            return;
        }
    };
    mark_active(&state, &ctx.session_id).await;
    let cancel = state
        .agents
        .tunnels
        .register_live(&ctx.session_id, &ctx.device_id);
    let mut recorder = match Recorder::create(
        &state.args.data_dir,
        &ctx.session_id,
        ctx.cols,
        ctx.rows,
        &format!(
            "{} — {}",
            ctx.hostname,
            if ctx.shell.is_empty() {
                "default shell"
            } else {
                &ctx.shell
            }
        ),
    )
    .await
    {
        Ok(r) => Some(r),
        Err(e) => {
            tracing::warn!(error = %format!("{e:#}"), "shell recording unavailable");
            None
        }
    };
    let client_id: Option<String> = sqlx::query_scalar(
        "SELECT s.client_id FROM devices d JOIN sites s ON s.id = d.site_id WHERE d.id = ?",
    )
    .bind(&ctx.device_id)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();
    state.events.publish(
        "remote.session",
        client_id.clone(),
        json!({ "session_id": ctx.session_id, "device_id": ctx.device_id, "status": "active", "kind": "shell" }),
    );

    let started = Instant::now();
    let mut last_input = Instant::now();
    let mut to_device: u64 = 0;
    let mut from_device: u64 = 0;
    let mut checks = tokio::time::interval(Duration::from_secs(30));
    checks.tick().await;
    let reason = loop {
        tokio::select! {
            _ = cancel.cancelled() => break "ended by an administrator",
            _ = checks.tick() => {
                if !web_session_valid(&state, &ctx.web_session_id, &ctx.user_id).await {
                    break "operator signed out";
                }
                if last_input.elapsed() > SHELL_IDLE {
                    break "idle timeout";
                }
                if started.elapsed() > SHELL_MAX {
                    break "maximum session length reached";
                }
            }
            incoming = agent.recv() => match incoming {
                Some(Ok(Message::Binary(bytes))) => {
                    from_device += bytes.len() as u64;
                    if let Some(r) = recorder.as_mut() {
                        let _ = r.output(&bytes).await;
                    }
                    if browser.send(Message::Binary(bytes)).await.is_err() {
                        break "operator disconnected";
                    }
                }
                Some(Ok(Message::Text(text))) => {
                    let exit = matches!(serde_json::from_str::<TunnelControl>(&text), Ok(TunnelControl::Exit { .. }));
                    let _ = browser.send(Message::Text(text)).await;
                    if exit {
                        break "shell exited";
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break "device closed the session",
                Some(Ok(_)) => {}
            },
            incoming = browser.recv() => match incoming {
                Some(Ok(Message::Binary(bytes))) => {
                    to_device += bytes.len() as u64;
                    last_input = Instant::now();
                    if agent.send(Message::Binary(bytes)).await.is_err() {
                        break "device disconnected";
                    }
                }
                Some(Ok(Message::Text(text))) => {
                    // Only resize messages are forwarded to the agent.
                    if let Ok(TunnelControl::Resize { cols, rows }) = serde_json::from_str::<TunnelControl>(&text) {
                        if let Some(r) = recorder.as_mut() {
                            let _ = r.resize(cols, rows).await;
                        }
                        let _ = agent.send(Message::Text(TunnelControl::Resize { cols, rows }.to_text().into())).await;
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break "operator closed the session",
                Some(Ok(_)) => {}
            },
        }
    };
    state.agents.tunnels.unregister_live(&ctx.session_id);
    let _ = agent.send(Message::Close(None)).await;
    let _ = browser
        .send(Message::Text(
            json!({ "type": "closed", "reason": reason })
                .to_string()
                .into(),
        ))
        .await;
    let _ = browser.send(Message::Close(None)).await;
    let recording = match recorder {
        Some(r) => {
            let relative = r.relative.clone();
            let bytes = r.finish().await;
            Some((relative, bytes))
        }
        None => None,
    };
    finish_session(
        &state,
        &ctx.session_id,
        "ended",
        reason,
        to_device,
        from_device,
        recording.as_ref().map(|(p, b)| (p.as_str(), *b)),
    )
    .await;
    state.events.publish(
        "remote.session",
        client_id,
        json!({ "session_id": ctx.session_id, "device_id": ctx.device_id, "status": "ended", "kind": "shell" }),
    );
    let user_name: String = sqlx::query_scalar("SELECT name FROM users WHERE id = ?")
        .bind(&ctx.user_id)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    let entry = crate::audit::AuditEntry::new(
        crate::audit::Actor::User {
            id: ctx.user_id.clone(),
            name: user_name,
        },
        "remote.shell.ended",
    )
    .target("device", &ctx.device_id, &ctx.hostname)
    .details(json!({
        "session_id": ctx.session_id,
        "reason": reason,
        "duration_secs": started.elapsed().as_secs(),
        "bytes_to_device": to_device,
        "bytes_from_device": from_device,
    }));
    state.audit.record_or_log(&state.db, entry).await;
}

// ------------------------------------------------------------------ session history

#[derive(Deserialize)]
pub struct SessionsQuery {
    #[serde(default)]
    device_id: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
}

type SessionRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    DateTime<Utc>,
    Option<DateTime<Utc>>,
    Option<DateTime<Utc>>,
    Option<String>,
    i64,
    i64,
    Option<String>,
    Option<i64>,
);

/// `GET /api/v1/remote-sessions?device_id=&limit=`
#[utoipa::path(get, path = "/api/v1/remote-sessions", tag = "Remote tools", summary = "List sessions", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list_sessions(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<SessionsQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require("devices.view")?;
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    let rows: Vec<SessionRow> = sqlx::query_as(
        "SELECT r.id, r.device_id, d.hostname, s.client_id, d.site_id, r.user_name, r.kind, r.detail, r.started_at, r.connected_at, r.ended_at, r.end_reason, r.bytes_to_device, r.bytes_from_device, r.recording, r.recording_bytes
         FROM remote_sessions r JOIN devices d ON d.id = r.device_id JOIN sites s ON s.id = d.site_id
         WHERE (? IS NULL OR r.device_id = ?) ORDER BY r.started_at DESC LIMIT ?",
    )
    .bind(&q.device_id)
    .bind(&q.device_id)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;
    let items: Vec<Value> = rows
        .into_iter()
        .filter(|r| ctx.scope.can_site("devices.view", &r.3, &r.4))
        .map(|(id, device_id, hostname, _client, _site, user_name, kind, detail, started_at, connected_at, ended_at, end_reason, to_dev, from_dev, recording, recording_bytes)| {
            let live = state.agents.tunnels.is_live(&id);
            json!({
                "id": id, "device_id": device_id, "hostname": hostname, "user_name": user_name, "kind": kind,
                "detail": if kind == "shell" || kind == "desktop" { serde_json::from_str::<Value>(&detail).unwrap_or(Value::Null) } else { json!({ "path": detail }) },
                "started_at": started_at, "connected_at": connected_at, "ended_at": ended_at, "end_reason": end_reason,
                "bytes_to_device": to_dev, "bytes_from_device": from_dev,
                "has_recording": recording.is_some(), "recording_bytes": recording_bytes, "live": live,
            })
        })
        .collect();
    Ok(Json(json!({ "items": items })))
}

async fn session_device(
    state: &AppState,
    ctx: &AuthCtx,
    id: &str,
    permission: &str,
) -> ApiResult<(String, Option<String>)> {
    let row: Option<(String, String, String, Option<String>, String)> = sqlx::query_as(
        "SELECT r.device_id, s.client_id, d.site_id, r.recording, r.kind FROM remote_sessions r JOIN devices d ON d.id = r.device_id JOIN sites s ON s.id = d.site_id WHERE r.id = ?",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?;
    let (device_id, client_id, site_id, recording, kind) =
        row.ok_or_else(|| ApiError::not_found("Session"))?;
    // Ending a live desktop session needs the desktop permission rather than the shell one.
    let permission = if permission == "remote.shell" && kind == "desktop" {
        "remote.desktop"
    } else {
        permission
    };
    if !ctx.scope.can_site("devices.view", &client_id, &site_id) {
        return Err(ApiError::not_found("Session"));
    }
    if !ctx.scope.can_site(permission, &client_id, &site_id) {
        return Err(ApiError::forbidden(format!(
            "Missing permission: {permission}"
        )));
    }
    Ok((device_id, recording))
}

/// `GET /api/v1/remote-sessions/{id}/recording` — asciicast v2.
#[utoipa::path(get, path = "/api/v1/remote-sessions/{id}/recording", tag = "Remote tools", summary = "Recording", params(("id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn recording(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let (device_id, recording) = session_device(&state, &ctx, &id, "remote.recordings").await?;
    let relative = recording.ok_or_else(|| ApiError::not_found("Recording"))?;
    if relative.contains("..") {
        return Err(ApiError::not_found("Recording"));
    }
    let path = state.args.data_dir.join("recordings").join(&relative);
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|_| ApiError::not_found("Recording"))?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("remote.recording.viewed")
                .target("device", &device_id, "")
                .details(json!({ "session_id": id })),
        )
        .await;
    Ok((
        [
            (header::CONTENT_TYPE, "application/x-asciicast"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        bytes,
    )
        .into_response())
}

/// `POST /api/v1/remote-sessions/{id}/end`
#[utoipa::path(post, path = "/api/v1/remote-sessions/{id}/end", tag = "Remote tools", summary = "End session", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn end_session(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let (device_id, _) = session_device(&state, &ctx, &id, "remote.shell").await?;
    if !state.agents.tunnels.end(&id) {
        return Err(ApiError::conflict("not_live", "The session is not running"));
    }
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("remote.session.terminated")
                .target("device", &device_id, "")
                .details(json!({ "session_id": id })),
        )
        .await;
    Ok(StatusCode::NO_CONTENT)
}
