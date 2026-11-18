//! Enrollment tokens (deploy keys) and generated installers.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::FromRow;

use crate::agents::enroll::{self, TOKEN_COLUMNS, TokenRow};
use crate::agents::installers;
use crate::auth::AuthCtx;
use crate::error::{ApiError, ApiResult};
use crate::setup::validate_name;
use crate::state::AppState;

const PERM: &str = "agents.deploy";

#[derive(Debug, Clone, FromRow)]
struct TokenListRow {
    id: String,
    site_id: String,
    site_name: String,
    client_id: String,
    client_name: String,
    name: String,
    expires_at: Option<DateTime<Utc>>,
    max_uses: Option<i64>,
    uses: i64,
    require_approval: bool,
    allowed_domains: String,
    allowed_cidrs: String,
    revoked_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    last_used_at: Option<DateTime<Utc>>,
}

#[derive(Serialize)]
pub struct TokenDto {
    id: String,
    site_id: String,
    site_name: String,
    client_id: String,
    client_name: String,
    name: String,
    expires_at: Option<DateTime<Utc>>,
    max_uses: Option<i64>,
    uses: i64,
    require_approval: bool,
    allowed_domains: Vec<String>,
    allowed_cidrs: Vec<String>,
    status: &'static str,
    created_at: DateTime<Utc>,
    last_used_at: Option<DateTime<Utc>>,
}

fn token_dto(r: TokenListRow) -> TokenDto {
    let now = rustrmm_common::now();
    let status = if r.revoked_at.is_some() {
        "revoked"
    } else if r.expires_at.is_some_and(|t| t <= now) {
        "expired"
    } else if r.max_uses.is_some_and(|m| r.uses >= m) {
        "exhausted"
    } else {
        "active"
    };
    TokenDto {
        allowed_domains: serde_json::from_str(&r.allowed_domains).unwrap_or_default(),
        allowed_cidrs: serde_json::from_str(&r.allowed_cidrs).unwrap_or_default(),
        id: r.id,
        site_id: r.site_id,
        site_name: r.site_name,
        client_id: r.client_id,
        client_name: r.client_name,
        name: r.name,
        expires_at: r.expires_at,
        max_uses: r.max_uses,
        uses: r.uses,
        require_approval: r.require_approval,
        status,
        created_at: r.created_at,
        last_used_at: r.last_used_at,
    }
}

const LIST_SELECT: &str = "SELECT t.id, t.site_id, s.name AS site_name, s.client_id, c.name AS client_name, t.name, t.expires_at, t.max_uses,
    t.uses, t.require_approval, t.allowed_domains, t.allowed_cidrs, t.revoked_at, t.created_at, t.last_used_at
    FROM enrollment_tokens t JOIN sites s ON s.id = t.site_id JOIN clients c ON c.id = s.client_id";

#[derive(Deserialize)]
pub struct ListQuery {
    site_id: Option<String>,
    client_id: Option<String>,
}

/// `GET /api/v1/enrollment-tokens`
#[utoipa::path(get, path = "/api/v1/enrollment-tokens", tag = "Deployment", summary = "List enrollment tokens", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require(PERM)?;
    let rows: Vec<TokenListRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{LIST_SELECT} ORDER BY t.created_at DESC"
    )))
    .fetch_all(&state.db)
    .await?;
    let items: Vec<TokenDto> = rows
        .into_iter()
        .filter(|r| ctx.scope.can_site(PERM, &r.client_id, &r.site_id))
        .filter(|r| q.site_id.as_ref().is_none_or(|s| &r.site_id == s))
        .filter(|r| q.client_id.as_ref().is_none_or(|c| &r.client_id == c))
        .map(token_dto)
        .collect();
    Ok(Json(
        json!({ "items": items, "artifacts": installers::artifacts(&state).await }),
    ))
}

#[derive(Deserialize)]
pub struct CreateToken {
    name: String,
    #[serde(default)]
    expires_in_days: Option<i64>,
    #[serde(default)]
    max_uses: Option<i64>,
    #[serde(default)]
    require_approval: bool,
    #[serde(default)]
    allowed_domains: Vec<String>,
    #[serde(default)]
    allowed_cidrs: Vec<String>,
}

/// `POST /api/v1/sites/{id}/enrollment-tokens`
#[utoipa::path(post, path = "/api/v1/sites/{id}/enrollment-tokens", tag = "Deployment", summary = "Create enrollment token", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn create(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(site_id): Path<String>,
    Json(req): Json<CreateToken>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let client_id: String = sqlx::query_scalar("SELECT client_id FROM sites WHERE id = ?")
        .bind(&site_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| ApiError::not_found("Site"))?;
    if !ctx.scope.can_site(PERM, &client_id, &site_id) {
        return Err(ApiError::forbidden("Missing permission: agents.deploy"));
    }
    let name = validate_name("Name", &req.name, 80)?;
    if let Some(days) = req.expires_in_days
        && !(1..=3650).contains(&days)
    {
        return Err(ApiError::validation(
            "Expiry must be between 1 and 3650 days",
        ));
    }
    if let Some(max) = req.max_uses
        && !(1..=100_000).contains(&max)
    {
        return Err(ApiError::validation(
            "Maximum uses must be between 1 and 100000",
        ));
    }
    let domains: Vec<String> = req
        .allowed_domains
        .iter()
        .map(|d| d.trim().trim_start_matches('.').to_ascii_lowercase())
        .filter(|d| !d.is_empty())
        .collect();
    if domains.iter().any(|d| {
        d.len() > 253
            || !d
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    }) {
        return Err(ApiError::validation(
            "Allowed domains must be DNS names like corp.example.com",
        ));
    }
    let mut cidrs = Vec::new();
    for c in req
        .allowed_cidrs
        .iter()
        .map(|c| c.trim())
        .filter(|c| !c.is_empty())
    {
        let net: ipnet::IpNet = c.parse().map_err(|_| {
            ApiError::validation(format!("{c} is not a valid network (e.g. 10.0.0.0/8)"))
        })?;
        cidrs.push(net.to_string());
    }

    let secret = rustrmm_crypto::random::token()[..24].to_string();
    let id = rustrmm_common::new_id();
    let now = rustrmm_common::now();
    sqlx::query(
        "INSERT INTO enrollment_tokens (id, site_id, name, secret_hash, secret, expires_at, max_uses, require_approval, allowed_domains,
                                        allowed_cidrs, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&site_id)
    .bind(&name)
    .bind(rustrmm_crypto::random::sha256_hex(secret.as_bytes()))
    .bind(state.cipher.encrypt_str(&secret, &enroll::secret_aad(&id)))
    .bind(req.expires_in_days.map(|d| now + chrono::Duration::days(d)))
    .bind(req.max_uses)
    .bind(req.require_approval)
    .bind(serde_json::to_string(&domains)?)
    .bind(serde_json::to_string(&cidrs)?)
    .bind(&ctx.user.id)
    .bind(now)
    .execute(&state.db)
    .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("enrollment_token.created").target("enrollment_token", &id, &name).client(&client_id).site(&site_id).details(json!({
                "expires_in_days": req.expires_in_days, "max_uses": req.max_uses, "require_approval": req.require_approval,
                "allowed_domains": domains, "allowed_cidrs": cidrs,
            })),
        )
        .await;
    let token = load_token(&state, &id).await?;
    let deploy_key = enroll::deploy_key(&state, &token).await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "id": id, "deploy_key": deploy_key })),
    ))
}

async fn load_token(state: &AppState, id: &str) -> ApiResult<TokenRow> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {TOKEN_COLUMNS} FROM enrollment_tokens WHERE id = ?"
    )))
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| ApiError::not_found("Deploy key"))
}

async fn authorize(
    state: &AppState,
    ctx: &AuthCtx,
    token: &TokenRow,
) -> ApiResult<(String, String)> {
    let (client_id, label): (String, String) =
        sqlx::query_as("SELECT s.client_id, c.name || ' / ' || s.name FROM sites s JOIN clients c ON c.id = s.client_id WHERE s.id = ?")
            .bind(&token.site_id)
            .fetch_one(&state.db)
            .await?;
    if !ctx.scope.can_site(PERM, &client_id, &token.site_id) {
        return Err(ApiError::not_found("Deploy key"));
    }
    Ok((client_id, label))
}

/// `GET /api/v1/enrollment-tokens/{id}/deploy-key`
#[utoipa::path(get, path = "/api/v1/enrollment-tokens/{id}/deploy-key", tag = "Deployment", summary = "Deploy key", params(("id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn deploy_key(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let token = load_token(&state, &id).await?;
    let (client_id, _) = authorize(&state, &ctx, &token).await?;
    if token.revoked_at.is_some() {
        return Err(ApiError::conflict(
            "revoked",
            "This deploy key has been revoked",
        ));
    }
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("enrollment_token.viewed")
                .target("enrollment_token", &id, &token.name)
                .client(&client_id),
        )
        .await;
    Ok(Json(
        json!({ "deploy_key": enroll::deploy_key(&state, &token).await? }),
    ))
}

/// `DELETE /api/v1/enrollment-tokens/{id}` — revokes (enrolled agents are unaffected).
#[utoipa::path(delete, path = "/api/v1/enrollment-tokens/{id}", tag = "Deployment", summary = "Revoke", params(("id" = String, Path)), responses((status = 204, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn revoke(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let token = load_token(&state, &id).await?;
    let (client_id, _) = authorize(&state, &ctx, &token).await?;
    sqlx::query("UPDATE enrollment_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .bind(rustrmm_common::now())
        .bind(&id)
        .execute(&state.db)
        .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("enrollment_token.revoked")
                .target("enrollment_token", &id, &token.name)
                .client(&client_id),
        )
        .await;
    Ok(StatusCode::NO_CONTENT)
}

const GPO_README: &str = "RustRMM agent - Group Policy deployment\r\n\r\n\
1. Copy the RustRMM folder to a share the Domain Computers group can read (e.g. \\\\fileserver\\RustRMM$).\r\n\r\n\
Option A - Software Installation (recommended)\r\n\
2. Group Policy Management: edit (or create) a GPO linked to the target OU.\r\n\
3. Computer Configuration > Policies > Software Settings > Software installation > New > Package.\r\n\
4. Pick RustRMMAgent-x64.msi through its UNC path (not a mapped drive) and choose Assigned.\r\n\
   Keep deploy.key next to the .msi: the agent reads it from the install source.\r\n\r\n\
Option B - Startup script\r\n\
2. Computer Configuration > Policies > Windows Settings > Scripts (Startup/Shutdown) > Startup.\r\n\
3. PowerShell Scripts tab > Add > Install-RustRMM.ps1 from the share.\r\n\r\n\
Computers install the agent at their next restart (or after gpupdate /force and a restart).\r\n\
Revoking this deploy key in the console stops new enrollments; installed agents keep working.\r\n";

/// Builds the Group Policy bundle: MSI + deploy.key + startup script + instructions.
fn gpo_bundle(msi: &[u8], key: &str, script: &str) -> ApiResult<Vec<u8>> {
    use std::io::Write as _;
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (name, data) in [
        ("RustRMM/RustRMMAgent-x64.msi", msi),
        ("RustRMM/deploy.key", format!("{key}\r\n").as_bytes()),
        ("RustRMM/Install-RustRMM.ps1", script.as_bytes()),
        ("RustRMM/README.txt", GPO_README.as_bytes()),
    ] {
        zip.start_file(name, options).map_err(ApiError::internal)?;
        zip.write_all(data).map_err(ApiError::internal)?;
    }
    Ok(zip.finish().map_err(ApiError::internal)?.into_inner())
}

/// `GET /api/v1/enrollment-tokens/{id}/installer/{kind}` — kind: powershell | linux | macos | gpo | gpo-bundle | deploy-key
#[utoipa::path(get, path = "/api/v1/enrollment-tokens/{id}/installer/{kind}", tag = "Deployment", summary = "Installer", params(("id" = String, Path), ("kind" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn installer(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path((id, kind)): Path<(String, String)>,
) -> ApiResult<Response> {
    let token = load_token(&state, &id).await?;
    let (client_id, label) = authorize(&state, &ctx, &token).await?;
    if token.revoked_at.is_some() {
        return Err(ApiError::conflict(
            "revoked",
            "This deploy key has been revoked",
        ));
    }
    let key = enroll::deploy_key(&state, &token).await?;
    let artifacts = installers::artifacts(&state).await;
    let slug = rustrmm_common::slugify(&label);
    let (body, file) = match kind.as_str() {
        "powershell" => (
            installers::powershell(&state, &key, &label, &artifacts),
            format!("install-rustrmm-{slug}.ps1"),
        ),
        "linux" => (
            installers::posix(&state, &key, &label, &artifacts, false),
            format!("install-rustrmm-{slug}.sh"),
        ),
        "macos" => (
            installers::posix(&state, &key, &label, &artifacts, true),
            format!("install-rustrmm-{slug}-macos.sh"),
        ),
        "gpo" => (
            installers::gpo_startup_script(&key, &label),
            "Install-RustRMM.ps1".to_string(),
        ),
        "deploy-key" => (format!("{key}\n"), "deploy.key".to_string()),
        "gpo-bundle" => {
            let msi_path = installers::dist_dir(&state)
                .join("windows-x86_64")
                .join("RustRMMAgent-x64.msi");
            let msi = tokio::fs::read(&msi_path).await.map_err(|_| {
                ApiError::conflict(
                    "msi_unavailable",
                    "The Windows MSI has not been published on this server yet",
                )
            })?;
            let zip = gpo_bundle(&msi, &key, &installers::gpo_startup_script(&key, &label))?;
            state
                .audit
                .record_or_log(
                    &state.db,
                    ctx.audit("installer.downloaded")
                        .target("enrollment_token", &id, &token.name)
                        .client(&client_id)
                        .details(json!({ "kind": kind })),
                )
                .await;
            return Ok((
                StatusCode::OK,
                [
                    (header::CONTENT_TYPE, "application/zip".to_string()),
                    (
                        header::CONTENT_DISPOSITION,
                        format!("attachment; filename=\"RustRMM-GPO-{slug}.zip\""),
                    ),
                ],
                zip,
            )
                .into_response());
        }
        _ => return Err(ApiError::not_found("Installer type")),
    };
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("installer.downloaded")
                .target("enrollment_token", &id, &token.name)
                .client(&client_id)
                .details(json!({ "kind": kind })),
        )
        .await;
    Ok((
        StatusCode::OK,
        [
            (
                header::CONTENT_TYPE,
                "text/plain; charset=utf-8".to_string(),
            ),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{file}\""),
            ),
        ],
        body,
    )
        .into_response())
}
