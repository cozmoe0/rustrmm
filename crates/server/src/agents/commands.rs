//! Building, signing and tracking server → agent commands.

use std::sync::atomic::Ordering;

use anyhow::{Context, Result, bail};
use rustrmm_proto::commands::{
    Command, CommandPayload, CommandResult, SignedCommand, command_signing_bytes,
};
use serde_json::json;

use crate::state::AppState;

/// Signs and sends a command over the device's live connection. Returns the command id.
pub async fn send(
    state: &AppState,
    device_id: &str,
    command: Command,
    created_by: Option<&str>,
    ttl_secs: i64,
    summary: &str,
) -> Result<String> {
    send_with(
        state, device_id, command, created_by, ttl_secs, summary, true, None,
    )
    .await
}

/// Like [`send`] with a caller-chosen command id (so related rows can point at the command
/// before an agent can possibly answer it).
pub async fn send_as(
    state: &AppState,
    cmd_id: &str,
    device_id: &str,
    command: Command,
    created_by: Option<&str>,
    ttl_secs: i64,
    summary: &str,
) -> Result<String> {
    send_with(
        state,
        device_id,
        command,
        created_by,
        ttl_secs,
        summary,
        true,
        Some(cmd_id.to_string()),
    )
    .await
}

/// Signs and sends a command without recording it in the command history (configuration
/// pushes). Returns the command id.
pub async fn send_quiet(
    state: &AppState,
    device_id: &str,
    command: Command,
    ttl_secs: i64,
) -> Result<String> {
    let summary = command.kind().to_string();
    send_with(
        state, device_id, command, None, ttl_secs, &summary, false, None,
    )
    .await
}

/// Failure of a request/response command.
#[derive(Debug)]
pub enum RequestError {
    Offline,
    Timeout,
    Refused(String),
    Other(anyhow::Error),
}

impl std::fmt::Display for RequestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Offline => f.write_str("device is offline"),
            Self::Timeout => f.write_str("the device did not answer in time"),
            Self::Refused(m) => f.write_str(m),
            Self::Other(e) => write!(f, "{e:#}"),
        }
    }
}

/// Sends a command and waits for its final result. Read-only queries pass `record = false` so
/// listings don't flood the command history; state-changing tools are recorded.
pub async fn request(
    state: &AppState,
    device_id: &str,
    command: Command,
    created_by: Option<&str>,
    summary: &str,
    record: bool,
    timeout: std::time::Duration,
) -> Result<CommandResult, RequestError> {
    if !state.agents.is_online(device_id) {
        return Err(RequestError::Offline);
    }
    let cmd_id = rustrmm_common::new_id();
    let rx = state.agents.wait_for(&cmd_id, device_id);
    let ttl = (timeout.as_secs() as i64).max(10);
    if let Err(e) = send_with(
        state,
        device_id,
        command,
        created_by,
        ttl,
        summary,
        record,
        Some(cmd_id.clone()),
    )
    .await
    {
        state.agents.forget_waiter(&cmd_id);
        return Err(RequestError::Other(e));
    }
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(result)) if result.status == "succeeded" => Ok(result),
        Ok(Ok(result)) => Err(RequestError::Refused(if result.message.is_empty() {
            format!("the device reported {}", result.status)
        } else {
            result.message
        })),
        Ok(Err(_)) => Err(RequestError::Offline),
        Err(_) => {
            state.agents.forget_waiter(&cmd_id);
            Err(RequestError::Timeout)
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn send_with(
    state: &AppState,
    device_id: &str,
    command: Command,
    created_by: Option<&str>,
    ttl_secs: i64,
    summary: &str,
    record: bool,
    cmd_id: Option<String>,
) -> Result<String> {
    let handle = state.agents.get(device_id).context("device is offline")?;
    let seq = handle.seq.fetch_add(1, Ordering::SeqCst) + 1;
    let now = chrono::Utc::now().timestamp_millis();
    let cmd_id = cmd_id.unwrap_or_else(rustrmm_common::new_id);
    let kind = command.kind();
    let payload = CommandPayload {
        cmd_id: cmd_id.clone(),
        device_id: device_id.to_string(),
        session_nonce: handle.session_nonce.clone(),
        seq,
        issued_at: now,
        expires_at: now + ttl_secs.max(5) * 1000,
        command,
    };
    let payload_bytes = rmp_serde::to_vec_named(&payload)?;
    let signature = state
        .keys
        .command
        .sign(&command_signing_bytes(&payload_bytes));
    let frame = rustrmm_proto::encode(&SignedCommand {
        payload: payload_bytes,
        signature,
    })?;

    if !record {
        if !state.agents.send(device_id, frame) {
            bail!("device connection unavailable");
        }
        return Ok(cmd_id);
    }
    let ts = rustrmm_common::now();
    sqlx::query("INSERT INTO commands (id, device_id, kind, status, summary, created_by, created_at, updated_at) VALUES (?, ?, ?, 'sent', ?, ?, ?, ?)")
        .bind(&cmd_id)
        .bind(device_id)
        .bind(kind)
        .bind(summary)
        .bind(created_by)
        .bind(ts)
        .bind(ts)
        .execute(&state.db)
        .await?;
    if !state.agents.send(device_id, frame) {
        sqlx::query("UPDATE commands SET status = 'failed', result = ? WHERE id = ?")
            .bind(json!({ "message": "device connection unavailable" }).to_string())
            .bind(&cmd_id)
            .execute(&state.db)
            .await?;
        bail!("device connection unavailable");
    }
    Ok(cmd_id)
}

/// Stores an agent's command result (only for commands that belong to that device).
pub async fn record_result(state: &AppState, device_id: &str, result: CommandResult) -> Result<()> {
    let kind: Option<String> =
        sqlx::query_scalar("SELECT kind FROM commands WHERE id = ? AND device_id = ?")
            .bind(&result.cmd_id)
            .bind(device_id)
            .fetch_optional(&state.db)
            .await?;
    let Some(kind) = kind else {
        tracing::debug!(device = device_id, cmd = %result.cmd_id, "result for unknown command ignored");
        return Ok(());
    };
    let status = match result.status.as_str() {
        "accepted" | "rejected" | "running" | "succeeded" | "failed" => result.status.clone(),
        _ => "failed".to_string(),
    };
    // Script and installer output lives with the job or deployment result; command history
    // keeps only the outcome.
    let stored = if kind == "run_script" || kind == "software_action" {
        let mut trimmed = result.clone();
        if let Some(data) = trimmed.data.as_object_mut() {
            data.remove("stdout");
            data.remove("stderr");
            data.remove("output");
        }
        trimmed
    } else {
        result.clone()
    };
    sqlx::query("UPDATE commands SET status = ?, result = ?, updated_at = ? WHERE id = ?")
        .bind(&status)
        .bind(serde_json::to_string(&stored)?)
        .bind(rustrmm_common::now())
        .bind(&result.cmd_id)
        .execute(&state.db)
        .await?;
    if kind == "update_agent" {
        super::releases::on_update_result(state, device_id, &result).await?;
    }
    if kind == "run_script" {
        crate::automation::jobs::on_script_result(state, device_id, &result).await?;
    }
    if kind == "patch_install" {
        crate::patching::runs::on_install_result(state, device_id, &result).await?;
    }
    if kind == "software_action" {
        crate::software::deployments::on_result(state, device_id, &result).await?;
    }
    if kind == "rotate_local_admin" {
        crate::escrow::on_rotate_result(state, device_id, &result).await?;
    }
    if kind == "network_scan" {
        crate::network::scans::on_command_result(state, device_id, &result).await?;
    }
    let client_id: Option<String> = sqlx::query_scalar(
        "SELECT s.client_id FROM devices d JOIN sites s ON s.id = d.site_id WHERE d.id = ?",
    )
    .bind(device_id)
    .fetch_optional(&state.db)
    .await?;
    if let Some(client_id) = client_id {
        state.events.publish(
            "device.command",
            Some(client_id),
            json!({ "device_id": device_id, "cmd_id": result.cmd_id, "status": status }),
        );
    }
    Ok(())
}
