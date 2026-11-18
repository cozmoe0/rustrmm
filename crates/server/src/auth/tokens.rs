//! Personal API tokens (`rrmm_pat_…`): creation, listing, revocation and the bearer
//! authentication path used by [`super::AuthCtx`].
//!
//! Only the SHA-256 of a token is stored. A token carries a subset of its creator's
//! permissions, optionally a client subset, an expiry (at most one year) and an optional source
//! network allowlist. Its effective scope is recomputed on every request as the intersection of
//! the creator's *current* scope with the token's restrictions, so removing a role from the user
//! also narrows their tokens.

use std::collections::HashSet;
use std::net::IpAddr;
use std::time::Duration as StdDuration;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Duration, Utc};
use ipnet::IpNet;
use serde::{Deserialize, Serialize};
use serde_json::json;
use utoipa::{IntoParams, ToSchema};

use super::session::SessionRecord;
use super::{AuthCtx, TokenInfo, UserRecord};
use crate::audit::{Actor, AuditEntry};
use crate::error::{ApiError, ApiResult};
use crate::ratelimit::Limit;
use crate::rbac::{AccessScope, perm};
use crate::state::AppState;

pub const TOKEN_PREFIX: &str = "rrmm_pat_";
/// 600 requests per minute per token.
pub const TOKEN_LIMIT: Limit = Limit::per(600, StdDuration::from_secs(60));
const MAX_LIFETIME_DAYS: i64 = 366;
const DEFAULT_LIFETIME_DAYS: i64 = 90;

/// The result of a successful bearer authentication.
pub struct TokenAuth {
    pub user: UserRecord,
    pub session: SessionRecord,
    pub scope: AccessScope,
    pub token: TokenInfo,
}

#[derive(sqlx::FromRow)]
struct TokenRow {
    id: String,
    user_id: String,
    name: String,
    prefix: String,
    permissions: String,
    client_ids: Option<String>,
    allowed_cidrs: Option<String>,
    expires_at: DateTime<Utc>,
    created_at: DateTime<Utc>,
    last_used_at: Option<DateTime<Utc>>,
    last_used_ip: Option<String>,
    last_audit_at: Option<DateTime<Utc>>,
}

const TOKEN_COLUMNS: &str =
    "t.id, t.user_id, t.name, t.prefix, t.permissions, t.client_ids, t.allowed_cidrs, t.expires_at,
    t.created_at, t.last_used_at, t.last_used_ip, t.last_audit_at";

fn json_list(raw: Option<&str>) -> Option<Vec<String>> {
    raw.map(|r| serde_json::from_str(r).unwrap_or_default())
}

fn invalid_token() -> ApiError {
    ApiError::new(
        StatusCode::UNAUTHORIZED,
        "invalid_token",
        "The API token is invalid, expired or revoked",
    )
}

/// Hash stored for a token string.
pub fn token_hash(token: &str) -> String {
    rustrmm_crypto::random::sha256_hex(token.as_bytes())
}

/// Authenticates `Authorization: Bearer <token>`.
pub async fn authenticate(
    state: &AppState,
    token: &str,
    ip: Option<IpAddr>,
) -> ApiResult<TokenAuth> {
    if !token.starts_with(TOKEN_PREFIX) || token.len() > 128 {
        return Err(invalid_token());
    }
    let row: Option<TokenRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {TOKEN_COLUMNS} FROM api_tokens t WHERE t.token_hash = ? AND t.revoked_at IS NULL"
    )))
    .bind(token_hash(token))
    .fetch_optional(&state.db)
    .await?;
    let row = row.ok_or_else(invalid_token)?;
    let now = rustrmm_common::now();
    if row.expires_at <= now {
        return Err(invalid_token());
    }
    if let Some(cidrs) = json_list(row.allowed_cidrs.as_deref())
        && !cidrs.is_empty()
    {
        let nets: Vec<IpNet> = cidrs.iter().filter_map(|c| parse_net(c)).collect();
        let allowed = ip.is_some_and(|ip| {
            let ip = crate::monitoring::notify::ssrf::canonical(ip);
            nets.iter().any(|n| n.contains(&ip))
        });
        if !allowed {
            return Err(ApiError::forbidden(
                "This API token is not allowed from your network address",
            )
            .with_details(json!({ "reason": "ip_not_allowed" })));
        }
    }
    if !state.limiter.check("api_token", &row.id, TOKEN_LIMIT) {
        return Err(ApiError::too_many_requests()
            .with_details(json!({ "limit": "600 requests per minute per token" })));
    }
    let user = super::load_user(state, &row.user_id)
        .await?
        .ok_or_else(invalid_token)?;
    if user.status != "active" {
        return Err(invalid_token());
    }
    let permissions: HashSet<String> = json_list(Some(&row.permissions))
        .unwrap_or_default()
        .into_iter()
        .collect();
    let clients: Option<HashSet<String>> =
        json_list(row.client_ids.as_deref()).map(|c| c.into_iter().collect());
    let scope = AccessScope::load(&state.db, &user.id)
        .await?
        .restrict(&permissions, clients.as_ref());

    // Usage bookkeeping: throttled writes, audit sampled to the first use per hour.
    let ip_text = ip.map(|i| i.to_string());
    if row
        .last_used_at
        .is_none_or(|t| now - t > Duration::seconds(60))
        || row.last_used_ip != ip_text
    {
        sqlx::query("UPDATE api_tokens SET last_used_at = ?, last_used_ip = ? WHERE id = ?")
            .bind(now)
            .bind(&ip_text)
            .bind(&row.id)
            .execute(&state.db)
            .await?;
    }
    if row
        .last_audit_at
        .is_none_or(|t| now - t >= Duration::hours(1))
    {
        let claimed = sqlx::query(
            "UPDATE api_tokens SET last_audit_at = ? WHERE id = ? AND (last_audit_at IS NULL OR last_audit_at <= ?)",
        )
        .bind(now)
        .bind(&row.id)
        .bind(now - Duration::hours(1))
        .execute(&state.db)
        .await?
        .rows_affected();
        if claimed > 0 {
            state
                .audit
                .record_or_log(
                    &state.db,
                    AuditEntry::new(
                        Actor::ApiToken {
                            id: row.id.clone(),
                            name: format!("{} ({})", row.name, user.name),
                        },
                        "api_token.used",
                    )
                    .target("api_token", &row.id, &row.name)
                    .request(ip_text.clone(), None)
                    .details(json!({ "user_id": user.id, "sampled": "first use per hour" })),
                )
                .await;
        }
    }
    let session = SessionRecord {
        id: format!("api_token:{}", row.id),
        user_id: user.id.clone(),
        csrf_token: String::new(),
        created_at: row.created_at,
        last_seen_at: now,
        idle_expires_at: row.expires_at,
        expires_at: row.expires_at,
        stepped_up_until: None,
        ip: ip_text,
        user_agent: None,
    };
    Ok(TokenAuth {
        user,
        session,
        scope,
        token: TokenInfo {
            id: row.id,
            name: row.name,
        },
    })
}

fn parse_net(raw: &str) -> Option<IpNet> {
    let raw = raw.trim();
    raw.parse::<IpNet>()
        .ok()
        .or_else(|| raw.parse::<IpAddr>().ok().map(IpNet::from))
}

// ------------------------------------------------------------------ API

/// An API token (the secret is only returned once, by `POST /api-tokens`).
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiToken {
    pub id: String,
    pub name: String,
    /// The first characters of the token, e.g. `rrmm_pat_Ab3d…`.
    pub prefix: String,
    pub permissions: Vec<String>,
    /// `null` = the creator's full client scope.
    pub client_ids: Option<Vec<String>>,
    pub allowed_cidrs: Option<Vec<String>>,
    pub expires_at: DateTime<Utc>,
    pub expired: bool,
    pub last_used_at: Option<DateTime<Utc>>,
    pub last_used_ip: Option<String>,
    pub created_at: DateTime<Utc>,
    /// Present in `?all=true` listings.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<TokenOwner>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TokenOwner {
    pub id: String,
    pub name: String,
    pub email: String,
}

fn to_api(row: TokenRow, owner: Option<TokenOwner>) -> ApiToken {
    ApiToken {
        expired: row.expires_at <= rustrmm_common::now(),
        id: row.id,
        name: row.name,
        prefix: row.prefix,
        permissions: json_list(Some(&row.permissions)).unwrap_or_default(),
        client_ids: json_list(row.client_ids.as_deref()),
        allowed_cidrs: json_list(row.allowed_cidrs.as_deref()),
        expires_at: row.expires_at,
        last_used_at: row.last_used_at,
        last_used_ip: row.last_used_ip,
        created_at: row.created_at,
        user: owner,
    }
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct ListQuery {
    /// `true` lists every user's tokens (needs `api.manage` installation-wide).
    all: Option<bool>,
}

#[derive(Serialize, ToSchema)]
pub struct TokenList {
    pub items: Vec<ApiToken>,
}

/// List API tokens
///
/// Your own active tokens, or everyone's with `?all=true` (`api.manage`).
#[utoipa::path(get, path = "/api/v1/api-tokens", tag = "API tokens", params(ListQuery),
    responses((status = 200, body = TokenList)))]
pub async fn list(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<TokenList>> {
    let all = q.all.unwrap_or(false);
    if all {
        ctx.require_global(perm::API_MANAGE)?;
    }
    let mut sql = format!(
        "SELECT {TOKEN_COLUMNS}, u.name AS owner_name, u.email AS owner_email FROM api_tokens t JOIN users u ON u.id = t.user_id
         WHERE t.revoked_at IS NULL"
    );
    if !all {
        sql.push_str(" AND t.user_id = ?");
    }
    sql.push_str(" ORDER BY t.created_at DESC");
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
    if !all {
        query = query.bind(&ctx.user.id);
    }
    let rows = query.fetch_all(&state.db).await?;
    let mut items = Vec::new();
    for r in rows {
        use sqlx::{FromRow, Row};
        let token = TokenRow::from_row(&r)?;
        let owner = all.then(|| TokenOwner {
            id: token.user_id.clone(),
            name: r.try_get("owner_name").unwrap_or_default(),
            email: r.try_get("owner_email").unwrap_or_default(),
        });
        items.push(to_api(token, owner));
    }
    Ok(Json(TokenList { items }))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateToken {
    pub name: String,
    /// A non-empty subset of your own permissions.
    pub permissions: Vec<String>,
    /// Restrict to these clients; omit or `null` for your full scope.
    #[serde(default)]
    pub client_ids: Option<Vec<String>>,
    /// Defaults to 90 days from now; at most one year.
    #[serde(default)]
    pub expires_at: Option<DateTime<Utc>>,
    /// Source networks (`203.0.113.0/24`, `2001:db8::1`); omit for any address.
    #[serde(default)]
    pub allowed_cidrs: Option<Vec<String>>,
}

#[derive(Serialize, ToSchema)]
pub struct CreatedToken {
    /// The token itself, shown only in this response.
    pub token: String,
    pub item: ApiToken,
}

/// Create an API token
///
/// Needs a console session with a recent step-up; the token is returned once.
#[utoipa::path(post, path = "/api/v1/api-tokens", tag = "API tokens", request_body = CreateToken,
    responses((status = 201, body = CreatedToken), (status = 403, description = "step_up_required or token_not_allowed")))]
pub async fn create(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(body): Json<CreateToken>,
) -> ApiResult<(StatusCode, Json<CreatedToken>)> {
    ctx.require_session()?;
    ctx.require_step_up()?;
    let name = body.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(ApiError::validation("name must be 1–80 characters"));
    }
    let mut permissions: Vec<String> = body
        .permissions
        .iter()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();
    permissions.sort();
    permissions.dedup();
    if permissions.is_empty() {
        return Err(ApiError::validation("permissions must not be empty"));
    }
    for p in &permissions {
        if !crate::rbac::is_known(p) {
            return Err(ApiError::validation(format!("Unknown permission {p}")));
        }
        if !ctx.scope.has_anywhere(p) {
            return Err(
                ApiError::validation(format!("You cannot grant {p}: you do not hold it"))
                    .with_details(json!({ "permission": p })),
            );
        }
    }
    let client_ids = match body.client_ids {
        None => None,
        Some(ids) => {
            let mut ids: Vec<String> = ids
                .into_iter()
                .map(|c| c.trim().to_string())
                .filter(|c| !c.is_empty())
                .collect();
            ids.sort();
            ids.dedup();
            if ids.is_empty() || ids.len() > 500 {
                return Err(ApiError::validation(
                    "client_ids must list 1–500 clients (or be null for your full scope)",
                ));
            }
            for id in &ids {
                let exists: Option<String> =
                    sqlx::query_scalar("SELECT id FROM clients WHERE id = ?")
                        .bind(id)
                        .fetch_optional(&state.db)
                        .await?;
                let visible = permissions.iter().any(|p| ctx.scope.can_see_client(p, id));
                if exists.is_none() || !visible {
                    return Err(ApiError::validation(format!(
                        "Unknown client {id} (or outside your scope)"
                    )));
                }
            }
            Some(ids)
        }
    };
    let now = rustrmm_common::now();
    let expires_at = body
        .expires_at
        .unwrap_or(now + Duration::days(DEFAULT_LIFETIME_DAYS));
    if expires_at <= now + Duration::minutes(5) {
        return Err(ApiError::validation("expires_at must be in the future"));
    }
    if expires_at > now + Duration::days(MAX_LIFETIME_DAYS) {
        return Err(ApiError::validation(
            "expires_at must be at most one year away",
        ));
    }
    let allowed_cidrs = match body.allowed_cidrs {
        None => None,
        Some(list) if list.is_empty() => None,
        Some(list) => {
            if list.len() > 32 {
                return Err(ApiError::validation("At most 32 allowed networks"));
            }
            let mut out = Vec::new();
            for raw in list {
                let net = parse_net(&raw).ok_or_else(|| {
                    ApiError::validation(format!("{raw} is not an IP address or CIDR network"))
                })?;
                out.push(net.to_string());
            }
            Some(out)
        }
    };
    let secret = URL_SAFE_NO_PAD.encode(rustrmm_crypto::random::bytes::<32>());
    let token = format!("{TOKEN_PREFIX}{secret}");
    let prefix = format!("{TOKEN_PREFIX}{}…", &secret[..4]);
    let id = rustrmm_common::new_id();
    sqlx::query(
        "INSERT INTO api_tokens (id, user_id, name, prefix, token_hash, permissions, client_ids, allowed_cidrs, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&ctx.user.id)
    .bind(&name)
    .bind(&prefix)
    .bind(token_hash(&token))
    .bind(serde_json::to_string(&permissions)?)
    .bind(client_ids.as_ref().map(serde_json::to_string).transpose()?)
    .bind(allowed_cidrs.as_ref().map(serde_json::to_string).transpose()?)
    .bind(expires_at)
    .bind(now)
    .execute(&state.db)
    .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("api_token.created")
                .target("api_token", &id, &name)
                .details(
                    json!({ "permissions": permissions, "client_ids": client_ids,
                                 "expires_at": expires_at, "allowed_cidrs": allowed_cidrs }),
                ),
        )
        .await;
    let item = ApiToken {
        id,
        name,
        prefix,
        permissions,
        client_ids,
        allowed_cidrs,
        expires_at,
        expired: false,
        last_used_at: None,
        last_used_ip: None,
        created_at: now,
        user: None,
    };
    Ok((StatusCode::CREATED, Json(CreatedToken { token, item })))
}

/// Revoke an API token
///
/// Your own token, or anyone's with `api.manage` installation-wide.
#[utoipa::path(delete, path = "/api/v1/api-tokens/{id}", tag = "API tokens",
    params(("id" = String, Path)), responses((status = 204), (status = 404)))]
pub async fn revoke(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT user_id, name FROM api_tokens WHERE id = ? AND revoked_at IS NULL")
            .bind(&id)
            .fetch_optional(&state.db)
            .await?;
    let (owner, name) = row.ok_or_else(|| ApiError::not_found("API token"))?;
    if owner != ctx.user.id && !ctx.scope.has_global(perm::API_MANAGE) {
        return Err(ApiError::not_found("API token"));
    }
    sqlx::query("UPDATE api_tokens SET revoked_at = ? WHERE id = ?")
        .bind(rustrmm_common::now())
        .bind(&id)
        .execute(&state.db)
        .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("api_token.revoked")
                .target("api_token", &id, &name)
                .details(json!({ "owner_id": owner })),
        )
        .await;
    Ok(StatusCode::NO_CONTENT)
}
