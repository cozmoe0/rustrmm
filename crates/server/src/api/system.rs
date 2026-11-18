//! System health, fleet summary and public PKI material.

use axum::Json;
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde_json::json;

use crate::auth::AuthCtx;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

#[derive(Serialize)]
pub struct DbHealth {
    size_bytes: u64,
    wal_bytes: u64,
}

#[derive(Serialize)]
pub struct Health {
    status: &'static str,
    version: &'static str,
    uptime_s: u64,
    db: DbHealth,
    agents_connected: u64,
    tls_mode: &'static str,
}

/// `GET /api/v1/system/health`
pub async fn health(State(state): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<Health>> {
    // Installation-wide figures (agent count, database size): not for client-scoped users.
    ctx.require_global(crate::rbac::perm::SETTINGS_VIEW)?;
    sqlx::query_scalar::<_, i64>("SELECT 1")
        .fetch_one(&state.db)
        .await?;
    let (size_bytes, wal_bytes) = crate::db::file_sizes(&state.args.db_path());
    Ok(Json(Health {
        status: "ok",
        version: rustrmm_common::VERSION,
        uptime_s: state.started.elapsed().as_secs(),
        db: DbHealth {
            size_bytes,
            wal_bytes,
        },
        agents_connected: state.agents.count() as u64,
        tls_mode: state.tls.mode.as_str(),
    }))
}

/// `GET /api/v1/system/ca.crt` — the internal CA certificate (public; lets admins trust the console).
pub async fn ca_certificate(State(state): State<AppState>) -> Response {
    match &state.tls.ca_cert_pem {
        Some(pem) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "application/x-pem-file"),
                (
                    header::CONTENT_DISPOSITION,
                    "attachment; filename=\"rustrmm-ca.crt\"",
                ),
            ],
            pem.clone(),
        )
            .into_response(),
        None => ApiError::not_found("Internal CA certificate").into_response(),
    }
}

/// Unknown API route.
pub async fn not_found() -> ApiError {
    ApiError::not_found("Endpoint")
}

/// `GET /healthz` — unauthenticated liveness probe.
pub async fn healthz(State(state): State<AppState>) -> Response {
    match sqlx::query_scalar::<_, i64>("SELECT 1")
        .fetch_one(&state.db)
        .await
    {
        Ok(_) => (StatusCode::OK, Json(json!({ "status": "ok" }))).into_response(),
        Err(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "status": "db_unavailable" })),
        )
            .into_response(),
    }
}
