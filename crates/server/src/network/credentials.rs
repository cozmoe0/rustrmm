//! SNMP credentials (installation-wide). Secrets (community, auth and privacy passwords) are
//! field-encrypted (AAD `snmp_credentials/secret/<id>`), write-only, and returned as `"••••••"`.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use rustrmm_proto::network::{SnmpCredential, SnmpV3};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use zeroize::Zeroize;

use crate::auth::AuthCtx;
use crate::error::{ApiError, ApiResult};
use crate::rbac::perm;
use crate::state::AppState;

pub const MASK: &str = "••••••";

fn aad(id: &str) -> String {
    format!("snmp_credentials/secret/{id}")
}

/// The encrypted part of a credential.
#[derive(Default, Serialize, Deserialize)]
struct Secrets {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    community: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    auth_password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    privacy_password: Option<String>,
}

impl Drop for Secrets {
    fn drop(&mut self) {
        for s in [
            &mut self.community,
            &mut self.auth_password,
            &mut self.privacy_password,
        ]
        .into_iter()
        .flatten()
        {
            s.zeroize();
        }
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct Row {
    id: String,
    name: String,
    version: String,
    username: Option<String>,
    auth: String,
    privacy: String,
    secret: Option<Vec<u8>>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

const SELECT: &str = "SELECT id, name, version, username, auth, privacy, secret, created_at, updated_at FROM snmp_credentials";

impl Row {
    fn secrets(&self, state: &AppState) -> anyhow::Result<Secrets> {
        match &self.secret {
            Some(blob) => {
                let plain = state.cipher.decrypt(blob, aad(&self.id).as_bytes())?;
                Ok(serde_json::from_slice(&plain)?)
            }
            None => Ok(Secrets::default()),
        }
    }

    fn to_json(&self, state: &AppState) -> Value {
        let secrets = self.secrets(state).unwrap_or_default();
        let mask = |s: &Option<String>| s.as_ref().map(|_| MASK);
        json!({
            "id": self.id, "name": self.name, "version": self.version,
            "community": if self.version == "v2c" { mask(&secrets.community) } else { None },
            "v3": (self.version == "v3").then(|| json!({
                "username": self.username, "auth": self.auth, "auth_password": mask(&secrets.auth_password),
                "privacy": self.privacy, "privacy_password": mask(&secrets.privacy_password),
            })),
            "created_at": self.created_at, "updated_at": self.updated_at,
        })
    }
}

async fn load(state: &AppState, id: &str) -> ApiResult<Row> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!("{SELECT} WHERE id = ?")))
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| ApiError::not_found("SNMP credential"))
}

/// The decrypted credential the probe uses (only ever sent inside signed commands).
pub async fn load_decrypted(state: &AppState, id: &str) -> anyhow::Result<Option<SnmpCredential>> {
    let row: Option<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!("{SELECT} WHERE id = ?")))
        .bind(id)
        .fetch_optional(&state.db)
        .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let secrets = row.secrets(state)?;
    Ok(Some(if row.version == "v3" {
        SnmpCredential {
            version: "v3".into(),
            community: None,
            v3: Some(SnmpV3 {
                username: row.username.clone().unwrap_or_default(),
                auth: row.auth.clone(),
                auth_password: secrets.auth_password.clone().unwrap_or_default(),
                privacy: row.privacy.clone(),
                privacy_password: secrets.privacy_password.clone().unwrap_or_default(),
            }),
        }
    } else {
        SnmpCredential {
            version: "v2c".into(),
            community: secrets.community.clone(),
            v3: None,
        }
    }))
}

/// `GET /api/v1/network/snmp/credentials`
#[utoipa::path(get, path = "/api/v1/network/snmp/credentials", tag = "Network", summary = "List credentials", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list(State(state): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<Value>> {
    ctx.require(perm::NETWORK_VIEW)?;
    let rows: Vec<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{SELECT} ORDER BY name COLLATE NOCASE"
    )))
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        json!({ "items": rows.iter().map(|r| r.to_json(&state)).collect::<Vec<_>>() }),
    ))
}

#[derive(Deserialize)]
pub struct V3Body {
    username: String,
    #[serde(default = "none")]
    auth: String,
    #[serde(default)]
    auth_password: Option<String>,
    #[serde(default = "none")]
    privacy: String,
    #[serde(default)]
    privacy_password: Option<String>,
}

fn none() -> String {
    "none".into()
}

#[derive(Deserialize)]
pub struct CredentialBody {
    name: String,
    version: String,
    #[serde(default)]
    community: Option<String>,
    #[serde(default)]
    v3: Option<V3Body>,
}

/// A submitted secret: `None` or the mask keeps the stored value.
fn submitted(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|v| *v != MASK)
}

/// Validates the body and merges it with the stored secrets. Returns (username, auth, privacy,
/// secrets).
fn build(
    body: &CredentialBody,
    current: Option<Secrets>,
) -> ApiResult<(String, Option<String>, String, String, Secrets)> {
    let name = body.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 120 {
        return Err(ApiError::validation("Name must be 1–120 characters"));
    }
    let mut current = current.unwrap_or_default();
    match body.version.as_str() {
        "v2c" => {
            let community = match submitted(&body.community) {
                Some(c) => c.to_string(),
                None => current
                    .community
                    .take()
                    .ok_or_else(|| ApiError::validation("community is required for v2c"))?,
            };
            if community.is_empty() || community.len() > 64 {
                return Err(ApiError::validation("community must be 1–64 characters"));
            }
            Ok((
                name,
                None,
                "none".into(),
                "none".into(),
                Secrets {
                    community: Some(community),
                    auth_password: None,
                    privacy_password: None,
                },
            ))
        }
        "v3" => {
            let v3 = body
                .v3
                .as_ref()
                .ok_or_else(|| ApiError::validation("v3 settings are required"))?;
            let username = v3.username.trim().to_string();
            if username.is_empty() || username.len() > 32 {
                return Err(ApiError::validation("v3.username must be 1–32 characters"));
            }
            if !matches!(v3.auth.as_str(), "none" | "sha" | "sha256") {
                return Err(ApiError::validation("v3.auth must be none, sha or sha256"));
            }
            if !matches!(v3.privacy.as_str(), "none" | "aes128") {
                return Err(ApiError::validation("v3.privacy must be none or aes128"));
            }
            if v3.privacy != "none" && v3.auth == "none" {
                return Err(ApiError::validation(
                    "v3.privacy needs authentication (sha or sha256)",
                ));
            }
            let mut secrets = Secrets::default();
            if v3.auth != "none" {
                let pw = match submitted(&v3.auth_password) {
                    Some(p) => p.to_string(),
                    None => current
                        .auth_password
                        .take()
                        .ok_or_else(|| ApiError::validation("v3.auth_password is required"))?,
                };
                if pw.len() < 8 || pw.len() > 128 {
                    return Err(ApiError::validation(
                        "v3.auth_password must be 8–128 characters",
                    ));
                }
                secrets.auth_password = Some(pw);
            }
            if v3.privacy != "none" {
                let pw = match submitted(&v3.privacy_password) {
                    Some(p) => p.to_string(),
                    None => current
                        .privacy_password
                        .take()
                        .ok_or_else(|| ApiError::validation("v3.privacy_password is required"))?,
                };
                if pw.len() < 8 || pw.len() > 128 {
                    return Err(ApiError::validation(
                        "v3.privacy_password must be 8–128 characters",
                    ));
                }
                secrets.privacy_password = Some(pw);
            }
            Ok((
                name,
                Some(username),
                v3.auth.clone(),
                v3.privacy.clone(),
                secrets,
            ))
        }
        _ => Err(ApiError::validation("version must be v2c or v3")),
    }
}

/// `POST /api/v1/network/snmp/credentials`
#[utoipa::path(post, path = "/api/v1/network/snmp/credentials", tag = "Network", summary = "Create credential", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn create(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(body): Json<CredentialBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    ctx.require_global(perm::NETWORK_MANAGE)?;
    let (name, username, auth, privacy, secrets) = build(&body, None)?;
    let id = rustrmm_common::new_id();
    let now = rustrmm_common::now();
    let blob = state
        .cipher
        .encrypt(&serde_json::to_vec(&secrets)?, aad(&id).as_bytes());
    sqlx::query("INSERT INTO snmp_credentials (id, name, version, username, auth, privacy, secret, created_by, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&id)
        .bind(&name)
        .bind(&body.version)
        .bind(&username)
        .bind(&auth)
        .bind(&privacy)
        .bind(&blob)
        .bind(&ctx.user.id)
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("snmp.credential_created")
                .target("snmp_credential", &id, &name)
                .details(json!({ "version": body.version })),
        )
        .await;
    Ok((
        StatusCode::CREATED,
        Json(load(&state, &id).await?.to_json(&state)),
    ))
}

/// `PUT /api/v1/network/snmp/credentials/{id}` — leave secrets out (or send the mask) to keep them.
#[utoipa::path(put, path = "/api/v1/network/snmp/credentials/{id}", tag = "Network", summary = "Update credential", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn update(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(body): Json<CredentialBody>,
) -> ApiResult<Json<Value>> {
    ctx.require_global(perm::NETWORK_MANAGE)?;
    let current = load(&state, &id).await?;
    let stored = current.secrets(&state)?;
    let (name, username, auth, privacy, secrets) = build(&body, Some(stored))?;
    let changed: Vec<&str> = [
        ("community", submitted(&body.community).is_some()),
        (
            "auth_password",
            body.v3
                .as_ref()
                .is_some_and(|v| submitted(&v.auth_password).is_some()),
        ),
        (
            "privacy_password",
            body.v3
                .as_ref()
                .is_some_and(|v| submitted(&v.privacy_password).is_some()),
        ),
    ]
    .into_iter()
    .filter(|(_, c)| *c)
    .map(|(n, _)| n)
    .collect();
    let blob = state
        .cipher
        .encrypt(&serde_json::to_vec(&secrets)?, aad(&id).as_bytes());
    sqlx::query("UPDATE snmp_credentials SET name = ?, version = ?, username = ?, auth = ?, privacy = ?, secret = ?, updated_at = ? WHERE id = ?")
        .bind(&name)
        .bind(&body.version)
        .bind(&username)
        .bind(&auth)
        .bind(&privacy)
        .bind(&blob)
        .bind(rustrmm_common::now())
        .bind(&id)
        .execute(&state.db)
        .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("snmp.credential_updated")
                .target("snmp_credential", &id, &name)
                .details(json!({ "version": body.version, "secrets_changed": changed })),
        )
        .await;
    super::config::push_all_soon(&state);
    Ok(Json(load(&state, &id).await?.to_json(&state)))
}

/// `DELETE /api/v1/network/snmp/credentials/{id}`
#[utoipa::path(delete, path = "/api/v1/network/snmp/credentials/{id}", tag = "Network", summary = "Delete credential", params(("id" = String, Path)), responses((status = 204, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn delete(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    ctx.require_global(perm::NETWORK_MANAGE)?;
    let current = load(&state, &id).await?;
    let in_use: Option<String> =
        sqlx::query_scalar("SELECT name FROM snmp_devices WHERE credential_id = ? LIMIT 1")
            .bind(&id)
            .fetch_optional(&state.db)
            .await?;
    if let Some(device) = in_use {
        return Err(ApiError::conflict(
            "credential_in_use",
            format!("The SNMP device {device} uses this credential"),
        ));
    }
    sqlx::query("DELETE FROM snmp_credentials WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    // Scans that referenced it simply stop using it.
    let scans: Vec<(String, String)> =
        sqlx::query_as("SELECT id, snmp_credential_ids FROM network_scans")
            .fetch_all(&state.db)
            .await?;
    for (scan_id, ids) in scans {
        let list: Vec<String> = serde_json::from_str(&ids).unwrap_or_default();
        if list.contains(&id) {
            let kept: Vec<&String> = list.iter().filter(|x| **x != id).collect();
            sqlx::query("UPDATE network_scans SET snmp_credential_ids = ? WHERE id = ?")
                .bind(serde_json::to_string(&kept)?)
                .bind(&scan_id)
                .execute(&state.db)
                .await?;
        }
    }
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("snmp.credential_deleted")
                .target("snmp_credential", &id, &current.name),
        )
        .await;
    Ok(StatusCode::NO_CONTENT)
}
