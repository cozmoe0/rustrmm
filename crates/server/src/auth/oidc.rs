//! OpenID Connect single sign-on: provider settings, the authorization code flow with PKCE,
//! ID token verification against the provider's JWKS (signature, `iss`, `aud`, `exp`, `nonce`),
//! user linking/provisioning by verified e-mail, role mappings applied at every sign-in, MFA
//! handling (`amr`/`acr`, `require_local_mfa`) and SSO enforcement with a local-owner break
//! glass.
//!
//! JWT verification is implemented here on `ring` (already the rustls provider): RS256/384/512,
//! PS256/384/512, ES256/384 and EdDSA. `none` and HMAC algorithms are always refused.

use std::collections::HashMap;
use std::sync::LazyLock;
use std::time::{Duration as StdDuration, Instant};

use anyhow::{Context, anyhow, bail};
use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Redirect, Response};
use axum_extra::extract::CookieJar;
use axum_extra::extract::cookie::{Cookie, SameSite};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Utc};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use utoipa::ToSchema;

use super::{AuthCtx, ClientMeta, session};
use crate::audit::{Actor, AuditEntry};
use crate::error::{ApiError, ApiResult};
use crate::ratelimit::Limit;
use crate::rbac::{OWNER_ROLE_ID, perm};
use crate::state::AppState;

pub const FLOW_COOKIE: &str = "__Host-rustrmm_oidc";
const FLOW_TTL_SECS: i64 = 600;
const CLOCK_SKEW_SECS: i64 = 120;
const CACHE_TTL: StdDuration = StdDuration::from_secs(3600);
const HTTP_TIMEOUT: StdDuration = StdDuration::from_secs(15);
const MAX_HTTP_BODY: usize = 1024 * 1024;
const FLOW_LIMIT: Limit = Limit::per(30, StdDuration::from_secs(60));

// ------------------------------------------------------------------ provider model

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
pub struct RoleMapping {
    /// Group value from the group claim (exact, case-sensitive).
    pub group: String,
    pub role_id: String,
    /// `global` or `client`.
    pub scope_type: String,
    #[serde(default)]
    pub scope_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub issuer_url: String,
    pub client_id: String,
    pub client_secret: Option<Vec<u8>>,
    pub scopes: Vec<String>,
    pub group_claim: String,
    pub role_mappings: Vec<RoleMapping>,
    pub auto_provision: bool,
    pub require_local_mfa: bool,
    pub trust_unverified_email: bool,
    pub enabled: bool,
    pub button_label: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(sqlx::FromRow)]
struct ProviderRow {
    id: String,
    name: String,
    issuer_url: String,
    client_id: String,
    client_secret: Option<Vec<u8>>,
    scopes: String,
    group_claim: String,
    role_mappings: String,
    auto_provision: bool,
    require_local_mfa: bool,
    trust_unverified_email: bool,
    enabled: bool,
    button_label: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl From<ProviderRow> for Provider {
    fn from(r: ProviderRow) -> Self {
        Self {
            id: r.id,
            name: r.name,
            issuer_url: r.issuer_url,
            client_id: r.client_id,
            client_secret: r.client_secret,
            scopes: serde_json::from_str(&r.scopes).unwrap_or_default(),
            group_claim: r.group_claim,
            role_mappings: serde_json::from_str(&r.role_mappings).unwrap_or_default(),
            auto_provision: r.auto_provision,
            require_local_mfa: r.require_local_mfa,
            trust_unverified_email: r.trust_unverified_email,
            enabled: r.enabled,
            button_label: r.button_label,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }
}

/// A provider as the API shows it (`client_secret` is write-only).
#[derive(Debug, Serialize, ToSchema)]
pub struct ProviderDto {
    pub id: String,
    pub name: String,
    pub issuer_url: String,
    pub client_id: String,
    /// Whether a client secret is stored (the secret itself is never returned).
    pub has_client_secret: bool,
    pub scopes: Vec<String>,
    pub group_claim: String,
    pub role_mappings: Vec<RoleMapping>,
    pub auto_provision: bool,
    pub require_local_mfa: bool,
    pub trust_unverified_email: bool,
    pub enabled: bool,
    pub button_label: String,
    /// The redirect URI to register at the identity provider.
    pub redirect_uri: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

const PROVIDER_COLUMNS: &str = "id, name, issuer_url, client_id, client_secret, scopes, group_claim, role_mappings,
    auto_provision, require_local_mfa, trust_unverified_email, enabled, button_label, created_at, updated_at";

fn secret_aad(id: &str) -> String {
    format!("oidc_providers/client_secret/{id}")
}

pub fn redirect_uri(state: &AppState, provider_id: &str) -> String {
    format!(
        "{}api/v1/auth/oidc/{provider_id}/callback",
        crate::monitoring::notify::delivery::console_base(state)
    )
}

fn to_dto(state: &AppState, p: Provider) -> ProviderDto {
    ProviderDto {
        redirect_uri: redirect_uri(state, &p.id),
        has_client_secret: p.client_secret.is_some(),
        id: p.id,
        name: p.name,
        issuer_url: p.issuer_url,
        client_id: p.client_id,
        scopes: p.scopes,
        group_claim: p.group_claim,
        role_mappings: p.role_mappings,
        auto_provision: p.auto_provision,
        require_local_mfa: p.require_local_mfa,
        trust_unverified_email: p.trust_unverified_email,
        enabled: p.enabled,
        button_label: p.button_label,
        created_at: p.created_at,
        updated_at: p.updated_at,
    }
}

pub async fn load(state: &AppState, id: &str) -> anyhow::Result<Option<Provider>> {
    let row: Option<ProviderRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {PROVIDER_COLUMNS} FROM oidc_providers WHERE id = ?"
    )))
    .bind(id)
    .fetch_optional(&state.db)
    .await?;
    Ok(row.map(Provider::from))
}

async fn load_all(state: &AppState) -> anyhow::Result<Vec<Provider>> {
    let rows: Vec<ProviderRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {PROVIDER_COLUMNS} FROM oidc_providers ORDER BY name COLLATE NOCASE"
    )))
    .fetch_all(&state.db)
    .await?;
    Ok(rows.into_iter().map(Provider::from).collect())
}

// ------------------------------------------------------------------ provider routes

#[derive(Serialize, ToSchema)]
pub struct ProviderList {
    pub items: Vec<ProviderDto>,
}

/// List SSO providers
#[utoipa::path(get, path = "/api/v1/settings/sso/providers", tag = "Single sign-on",
    responses((status = 200, body = ProviderList)))]
pub async fn list_providers(
    State(state): State<AppState>,
    ctx: AuthCtx,
) -> ApiResult<Json<ProviderList>> {
    ctx.require_global(perm::SETTINGS_MANAGE)?;
    ctx.require_step_up()?;
    let items = load_all(&state)
        .await?
        .into_iter()
        .map(|p| to_dto(&state, p))
        .collect();
    Ok(Json(ProviderList { items }))
}

/// Get an SSO provider
#[utoipa::path(get, path = "/api/v1/settings/sso/providers/{id}", tag = "Single sign-on",
    params(("id" = String, Path)), responses((status = 200, body = ProviderDto)))]
pub async fn get_provider(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<ProviderDto>> {
    ctx.require_global(perm::SETTINGS_MANAGE)?;
    ctx.require_step_up()?;
    let p = load(&state, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("SSO provider"))?;
    Ok(Json(to_dto(&state, p)))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ProviderBody {
    pub name: String,
    pub issuer_url: String,
    pub client_id: String,
    /// Write-only. Omit on update to keep the stored secret; `""` clears it (public clients).
    #[serde(default)]
    pub client_secret: Option<String>,
    #[serde(default)]
    pub scopes: Option<Vec<String>>,
    #[serde(default)]
    pub group_claim: Option<String>,
    #[serde(default)]
    pub role_mappings: Vec<RoleMapping>,
    #[serde(default)]
    pub auto_provision: bool,
    #[serde(default)]
    pub require_local_mfa: bool,
    /// Accept the `email` claim without `email_verified: true` (e.g. Entra ID).
    #[serde(default)]
    pub trust_unverified_email: bool,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub button_label: Option<String>,
}

fn yes() -> bool {
    true
}

/// Issuer URLs must be https (http only for loopback test issuers).
fn validate_issuer(raw: &str) -> ApiResult<String> {
    let issuer = raw.trim().trim_end_matches('/').to_string();
    let url = url::Url::parse(&issuer)
        .map_err(|_| ApiError::validation("issuer_url is not a valid URL"))?;
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() {
        return Err(ApiError::validation(
            "issuer_url must not contain credentials or a query",
        ));
    }
    match url.scheme() {
        "https" => {}
        "http" if is_loopback_host(&url) => {}
        _ => {
            return Err(ApiError::validation(
                "issuer_url must use https (plain http is only allowed for loopback test issuers)",
            ));
        }
    }
    Ok(issuer)
}

fn is_loopback_host(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

async fn validate_body(state: &AppState, body: &mut ProviderBody) -> ApiResult<String> {
    body.name = body.name.trim().to_string();
    if body.name.is_empty() || body.name.chars().count() > 80 {
        return Err(ApiError::validation("name must be 1–80 characters"));
    }
    let issuer = validate_issuer(&body.issuer_url)?;
    body.client_id = body.client_id.trim().to_string();
    if body.client_id.is_empty() || body.client_id.len() > 512 {
        return Err(ApiError::validation("client_id must be 1–512 characters"));
    }
    if let Some(scopes) = &mut body.scopes {
        scopes.retain(|s| !s.trim().is_empty());
        if !scopes.iter().any(|s| s == "openid") {
            scopes.insert(0, "openid".into());
        }
        if scopes.len() > 20
            || scopes
                .iter()
                .any(|s| s.len() > 100 || s.chars().any(|c| c.is_whitespace() || c == '"'))
        {
            return Err(ApiError::validation("scopes are invalid"));
        }
    }
    if let Some(claim) = &body.group_claim
        && (claim.trim().is_empty() || claim.len() > 100)
    {
        return Err(ApiError::validation("group_claim must be 1–100 characters"));
    }
    if body.role_mappings.len() > 200 {
        return Err(ApiError::validation("At most 200 role mappings"));
    }
    for m in &mut body.role_mappings {
        m.group = m.group.trim().to_string();
        if m.group.is_empty() || m.group.len() > 256 {
            return Err(ApiError::validation(
                "role mapping groups must be 1–256 characters",
            ));
        }
        if m.role_id == OWNER_ROLE_ID {
            return Err(ApiError::validation(
                "The Owner role cannot be granted through SSO; owners are managed locally",
            ));
        }
        let role: Option<String> = sqlx::query_scalar("SELECT id FROM roles WHERE id = ?")
            .bind(&m.role_id)
            .fetch_optional(&state.db)
            .await?;
        if role.is_none() {
            return Err(ApiError::validation(format!("Unknown role {}", m.role_id)));
        }
        match m.scope_type.as_str() {
            "global" => m.scope_id = None,
            "client" => {
                let id = m.scope_id.clone().unwrap_or_default();
                let found: Option<String> =
                    sqlx::query_scalar("SELECT id FROM clients WHERE id = ?")
                        .bind(&id)
                        .fetch_optional(&state.db)
                        .await?;
                if found.is_none() {
                    return Err(ApiError::validation(format!(
                        "Role mapping for {} names an unknown client",
                        m.group
                    )));
                }
            }
            _ => {
                return Err(ApiError::validation(
                    "role mapping scope_type must be global or client",
                ));
            }
        }
    }
    if let Some(label) = &body.button_label
        && label.chars().count() > 80
    {
        return Err(ApiError::validation(
            "button_label is at most 80 characters",
        ));
    }
    Ok(issuer)
}

/// Create an SSO provider
#[utoipa::path(post, path = "/api/v1/settings/sso/providers", tag = "Single sign-on",
    request_body = ProviderBody, responses((status = 201, body = ProviderDto)))]
pub async fn create_provider(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(mut body): Json<ProviderBody>,
) -> ApiResult<(StatusCode, Json<ProviderDto>)> {
    ctx.require_global(perm::SETTINGS_MANAGE)?;
    ctx.require_step_up()?;
    let issuer = validate_body(&state, &mut body).await?;
    let id = rustrmm_common::new_id();
    let now = rustrmm_common::now();
    let secret = body
        .client_secret
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|s| state.cipher.encrypt_str(s, &secret_aad(&id)));
    let scopes = body
        .scopes
        .clone()
        .unwrap_or_else(|| vec!["openid".into(), "email".into(), "profile".into()]);
    let label = body
        .button_label
        .clone()
        .filter(|l| !l.trim().is_empty())
        .unwrap_or_else(|| format!("Sign in with {}", body.name));
    sqlx::query(
        "INSERT INTO oidc_providers (id, name, issuer_url, client_id, client_secret, scopes, group_claim, role_mappings,
             auto_provision, require_local_mfa, trust_unverified_email, enabled, button_label, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&body.name)
    .bind(&issuer)
    .bind(&body.client_id)
    .bind(secret)
    .bind(serde_json::to_string(&scopes)?)
    .bind(body.group_claim.as_deref().unwrap_or("groups").trim())
    .bind(serde_json::to_string(&body.role_mappings)?)
    .bind(body.auto_provision)
    .bind(body.require_local_mfa)
    .bind(body.trust_unverified_email)
    .bind(body.enabled)
    .bind(&label)
    .bind(now)
    .bind(now)
    .execute(&state.db)
    .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("sso.provider_created")
                .target("oidc_provider", &id, &body.name)
                .details(
                    json!({ "issuer_url": issuer, "auto_provision": body.auto_provision,
                                 "role_mappings": body.role_mappings.len() }),
                ),
        )
        .await;
    let p = load(&state, &id)
        .await?
        .ok_or_else(|| ApiError::internal("provider vanished"))?;
    Ok((StatusCode::CREATED, Json(to_dto(&state, p))))
}

/// Update an SSO provider
#[utoipa::path(put, path = "/api/v1/settings/sso/providers/{id}", tag = "Single sign-on",
    params(("id" = String, Path)), request_body = ProviderBody, responses((status = 200, body = ProviderDto)))]
pub async fn update_provider(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(mut body): Json<ProviderBody>,
) -> ApiResult<Json<ProviderDto>> {
    ctx.require_global(perm::SETTINGS_MANAGE)?;
    ctx.require_step_up()?;
    let current = load(&state, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("SSO provider"))?;
    let issuer = validate_body(&state, &mut body).await?;
    let secret = match body.client_secret.as_deref() {
        None => current.client_secret.clone(),
        Some("") => None,
        Some(s) => Some(state.cipher.encrypt_str(s, &secret_aad(&id))),
    };
    let scopes = body.scopes.clone().unwrap_or(current.scopes.clone());
    let label = body
        .button_label
        .clone()
        .filter(|l| !l.trim().is_empty())
        .unwrap_or(current.button_label.clone());
    sqlx::query(
        "UPDATE oidc_providers SET name = ?, issuer_url = ?, client_id = ?, client_secret = ?, scopes = ?, group_claim = ?,
             role_mappings = ?, auto_provision = ?, require_local_mfa = ?, trust_unverified_email = ?, enabled = ?,
             button_label = ?, updated_at = ? WHERE id = ?",
    )
    .bind(&body.name)
    .bind(&issuer)
    .bind(&body.client_id)
    .bind(secret)
    .bind(serde_json::to_string(&scopes)?)
    .bind(
        body.group_claim
            .as_deref()
            .unwrap_or(&current.group_claim)
            .trim(),
    )
    .bind(serde_json::to_string(&body.role_mappings)?)
    .bind(body.auto_provision)
    .bind(body.require_local_mfa)
    .bind(body.trust_unverified_email)
    .bind(body.enabled)
    .bind(&label)
    .bind(rustrmm_common::now())
    .bind(&id)
    .execute(&state.db)
    .await?;
    CACHE.remove(&id);
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("sso.provider_updated")
                .target("oidc_provider", &id, &body.name)
                .details(json!({ "issuer_url": issuer, "enabled": body.enabled,
                                 "secret_changed": body.client_secret.is_some(),
                                 "role_mappings": body.role_mappings.len() })),
        )
        .await;
    let p = load(&state, &id)
        .await?
        .ok_or_else(|| ApiError::internal("provider vanished"))?;
    Ok(Json(to_dto(&state, p)))
}

/// Delete an SSO provider
///
/// Linked identities and the provider's managed role assignments are removed.
#[utoipa::path(delete, path = "/api/v1/settings/sso/providers/{id}", tag = "Single sign-on",
    params(("id" = String, Path)), responses((status = 204)))]
pub async fn delete_provider(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    ctx.require_global(perm::SETTINGS_MANAGE)?;
    ctx.require_step_up()?;
    let current = load(&state, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("SSO provider"))?;
    let mut tx = state.db.begin().await?;
    sqlx::query("DELETE FROM role_assignments WHERE managed_by = ?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM oidc_providers WHERE id = ?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    CACHE.remove(&id);
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("sso.provider_deleted")
                .target("oidc_provider", &id, &current.name),
        )
        .await;
    Ok(StatusCode::NO_CONTENT)
}

// ------------------------------------------------------------------ SSO settings

#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
pub struct SsoSettings {
    /// Blocks password sign-in for everyone except global owners (break glass).
    #[serde(default)]
    pub enforce: bool,
}

pub async fn sso_settings(state: &AppState) -> anyhow::Result<SsoSettings> {
    Ok(crate::db::get_setting(&state.db, "sso")
        .await?
        .unwrap_or_default())
}

/// Get SSO settings
#[utoipa::path(get, path = "/api/v1/settings/sso", tag = "Single sign-on",
    responses((status = 200, body = SsoSettings)))]
pub async fn get_settings(
    State(state): State<AppState>,
    ctx: AuthCtx,
) -> ApiResult<Json<SsoSettings>> {
    ctx.require_global(perm::SETTINGS_VIEW)?;
    Ok(Json(sso_settings(&state).await?))
}

/// Update SSO settings
///
/// Enforcement needs at least one enabled provider; owners keep password + MFA sign-in.
#[utoipa::path(put, path = "/api/v1/settings/sso", tag = "Single sign-on",
    request_body = SsoSettings, responses((status = 200, body = SsoSettings)))]
pub async fn put_settings(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(body): Json<SsoSettings>,
) -> ApiResult<Json<SsoSettings>> {
    ctx.require_global(perm::SETTINGS_MANAGE)?;
    ctx.require_step_up()?;
    if body.enforce {
        let enabled: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM oidc_providers WHERE enabled = 1")
                .fetch_one(&state.db)
                .await?;
        if enabled == 0 {
            return Err(ApiError::validation(
                "Add and enable an SSO provider before enforcing single sign-on",
            ));
        }
    }
    crate::db::set_setting(&state.db, "sso", &body).await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("sso.settings_updated")
                .details(json!({ "enforce": body.enforce })),
        )
        .await;
    Ok(Json(body))
}

/// Whether password sign-in is blocked for `user_id` (SSO enforced and not a global owner).
pub async fn password_login_blocked(state: &AppState, user_id: &str) -> anyhow::Result<bool> {
    if !sso_settings(state).await?.enforce {
        return Ok(false);
    }
    let owner: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM role_assignments WHERE user_id = ? AND role_id = ? AND scope_type = 'global'",
    )
    .bind(user_id)
    .bind(OWNER_ROLE_ID)
    .fetch_one(&state.db)
    .await?;
    Ok(owner == 0)
}

#[derive(Serialize, ToSchema)]
pub struct PublicProvider {
    pub id: String,
    pub button_label: String,
}

#[derive(Serialize, ToSchema)]
pub struct PublicProviders {
    pub items: Vec<PublicProvider>,
    /// Password sign-in is reserved for owners (break glass).
    pub enforced: bool,
}

/// Sign-in providers (public)
///
/// Enabled SSO providers for the login page. No authentication.
#[utoipa::path(get, path = "/api/v1/auth/providers", tag = "Single sign-on",
    responses((status = 200, body = PublicProviders)), security(()))]
pub async fn public_providers(State(state): State<AppState>) -> ApiResult<Json<PublicProviders>> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, button_label FROM oidc_providers WHERE enabled = 1 ORDER BY name COLLATE NOCASE",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(PublicProviders {
        items: rows
            .into_iter()
            .map(|(id, button_label)| PublicProvider { id, button_label })
            .collect(),
        enforced: sso_settings(&state).await?.enforce,
    }))
}

// ------------------------------------------------------------------ discovery and JWKS

#[derive(Debug, Clone, Deserialize)]
struct Discovery {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    jwks_uri: String,
    #[serde(default)]
    token_endpoint_auth_methods_supported: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Jwk {
    pub kty: String,
    #[serde(default)]
    pub kid: Option<String>,
    #[serde(default, rename = "use")]
    pub key_use: Option<String>,
    #[serde(default)]
    pub alg: Option<String>,
    #[serde(default)]
    pub n: Option<String>,
    #[serde(default)]
    pub e: Option<String>,
    #[serde(default)]
    pub crv: Option<String>,
    #[serde(default)]
    pub x: Option<String>,
    #[serde(default)]
    pub y: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Jwks {
    pub keys: Vec<Jwk>,
}

struct Cached {
    fetched: Instant,
    issuer: String,
    discovery: Discovery,
    jwks: Jwks,
}

static CACHE: LazyLock<DashMap<String, Cached>> = LazyLock::new(DashMap::new);

fn http_client() -> anyhow::Result<reqwest::Client> {
    reqwest::Client::builder()
        .use_preconfigured_tls(crate::monitoring::notify::ssrf::tls_client_config()?)
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(StdDuration::from_secs(5))
        .timeout(HTTP_TIMEOUT)
        .user_agent(format!("RustRMM/{}", rustrmm_common::VERSION))
        .build()
        .context("building the OIDC HTTP client")
}

async fn read_json(response: reqwest::Response, what: &str) -> anyhow::Result<Value> {
    let status = response.status();
    let mut body = Vec::new();
    let mut response = response;
    while let Some(chunk) = response.chunk().await? {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_HTTP_BODY {
            bail!("{what} response is too large");
        }
    }
    if !status.is_success() {
        let text = String::from_utf8_lossy(&body);
        bail!(
            "{what} answered HTTP {}: {}",
            status.as_u16(),
            text.chars().take(200).collect::<String>()
        );
    }
    serde_json::from_slice(&body).with_context(|| format!("{what} returned invalid JSON"))
}

fn same_issuer(a: &str, b: &str) -> bool {
    a.trim_end_matches('/') == b.trim_end_matches('/')
}

async fn fetch_metadata(
    provider: &Provider,
    force_jwks: bool,
) -> anyhow::Result<(Discovery, Jwks)> {
    if let Some(entry) = CACHE.get(&provider.id)
        && entry.fetched.elapsed() < CACHE_TTL
        && entry.issuer == provider.issuer_url
        && !force_jwks
    {
        return Ok((entry.discovery.clone(), entry.jwks.clone()));
    }
    let client = http_client()?;
    let url = format!(
        "{}/.well-known/openid-configuration",
        provider.issuer_url.trim_end_matches('/')
    );
    let discovery: Discovery = serde_json::from_value(
        read_json(
            client
                .get(&url)
                .send()
                .await
                .context("fetching discovery")?,
            "OIDC discovery",
        )
        .await?,
    )
    .context("discovery document is missing required fields")?;
    if !same_issuer(&discovery.issuer, &provider.issuer_url) {
        bail!(
            "discovery issuer {} does not match the configured issuer {}",
            discovery.issuer,
            provider.issuer_url
        );
    }
    for endpoint in [
        &discovery.authorization_endpoint,
        &discovery.token_endpoint,
        &discovery.jwks_uri,
    ] {
        let u = url::Url::parse(endpoint).context("discovery lists an invalid endpoint URL")?;
        if u.scheme() != "https" && !(u.scheme() == "http" && is_loopback_host(&u)) {
            bail!("discovery endpoint {endpoint} is not https");
        }
    }
    let jwks: Jwks = serde_json::from_value(
        read_json(
            client
                .get(&discovery.jwks_uri)
                .send()
                .await
                .context("fetching JWKS")?,
            "JWKS",
        )
        .await?,
    )
    .context("JWKS document is invalid")?;
    CACHE.insert(
        provider.id.clone(),
        Cached {
            fetched: Instant::now(),
            issuer: provider.issuer_url.clone(),
            discovery: discovery.clone(),
            jwks: jwks.clone(),
        },
    );
    Ok((discovery, jwks))
}

// ------------------------------------------------------------------ JWT verification

fn b64(input: &str) -> anyhow::Result<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(input.trim_end_matches('='))
        .map_err(|_| anyhow!("invalid base64url"))
}

/// Verifies a compact JWS against a JWK set and returns its claims. Claims are not validated
/// here (see [`validate_claims`]).
pub fn verify_jws(token: &str, jwks: &Jwks) -> anyhow::Result<Value> {
    let mut parts = token.split('.');
    let (Some(h), Some(p), Some(s), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        bail!("the ID token is not a compact JWS");
    };
    let header: Value = serde_json::from_slice(&b64(h)?).context("invalid JWS header")?;
    let alg = header["alg"].as_str().unwrap_or_default();
    let kid = header["kid"].as_str();
    if header.get("crit").is_some() {
        bail!("critical JWS header extensions are not supported");
    }
    let signature = b64(s)?;
    let signed = format!("{h}.{p}");
    let candidates: Vec<&Jwk> = jwks
        .keys
        .iter()
        .filter(|k| k.key_use.as_deref().is_none_or(|u| u == "sig"))
        .filter(|k| kid.is_none_or(|kid| k.kid.as_deref() == Some(kid)))
        .filter(|k| k.alg.as_deref().is_none_or(|a| a == alg))
        .collect();
    if candidates.is_empty() {
        bail!("no signing key matches the token (kid {kid:?})");
    }
    let mut last_err = anyhow!("signature verification failed");
    for key in candidates {
        match verify_with(alg, key, signed.as_bytes(), &signature) {
            Ok(()) => {
                return serde_json::from_slice(&b64(p)?).context("invalid JWS payload");
            }
            Err(e) => last_err = e,
        }
    }
    Err(last_err)
}

fn verify_with(alg: &str, key: &Jwk, message: &[u8], signature: &[u8]) -> anyhow::Result<()> {
    use ring::signature as sig;
    let field = |v: &Option<String>, name: &str| -> anyhow::Result<Vec<u8>> {
        b64(v
            .as_deref()
            .ok_or_else(|| anyhow!("JWK is missing {name}"))?)
    };
    let rsa = |params: &'static sig::RsaParameters| -> anyhow::Result<()> {
        if key.kty != "RSA" {
            bail!("algorithm {alg} needs an RSA key");
        }
        let n = field(&key.n, "n")?;
        let e = field(&key.e, "e")?;
        sig::RsaPublicKeyComponents { n: &n, e: &e }
            .verify(params, message, signature)
            .map_err(|_| anyhow!("signature verification failed"))
    };
    let ec = |alg_ref: &'static sig::EcdsaVerificationAlgorithm, crv: &str| -> anyhow::Result<()> {
        if key.kty != "EC" || key.crv.as_deref() != Some(crv) {
            bail!("algorithm {alg} needs an EC {crv} key");
        }
        let mut point = vec![0x04];
        point.extend(field(&key.x, "x")?);
        point.extend(field(&key.y, "y")?);
        sig::UnparsedPublicKey::new(alg_ref, &point)
            .verify(message, signature)
            .map_err(|_| anyhow!("signature verification failed"))
    };
    match alg {
        "RS256" => rsa(&sig::RSA_PKCS1_2048_8192_SHA256),
        "RS384" => rsa(&sig::RSA_PKCS1_2048_8192_SHA384),
        "RS512" => rsa(&sig::RSA_PKCS1_2048_8192_SHA512),
        "PS256" => rsa(&sig::RSA_PSS_2048_8192_SHA256),
        "PS384" => rsa(&sig::RSA_PSS_2048_8192_SHA384),
        "PS512" => rsa(&sig::RSA_PSS_2048_8192_SHA512),
        "ES256" => ec(&sig::ECDSA_P256_SHA256_FIXED, "P-256"),
        "ES384" => ec(&sig::ECDSA_P384_SHA384_FIXED, "P-384"),
        "EdDSA" => {
            if key.kty != "OKP" || key.crv.as_deref() != Some("Ed25519") {
                bail!("EdDSA needs an Ed25519 key");
            }
            let x = field(&key.x, "x")?;
            sig::UnparsedPublicKey::new(&sig::ED25519, &x)
                .verify(message, signature)
                .map_err(|_| anyhow!("signature verification failed"))
        }
        other => bail!("unsupported or refused JWS algorithm {other:?}"),
    }
}

/// Checks `iss`, `aud` (and `azp`), `exp`, `iat`, `nbf` and `nonce`.
pub fn validate_claims(
    claims: &Value,
    issuer: &str,
    client_id: &str,
    nonce: &str,
    now: i64,
) -> anyhow::Result<()> {
    if claims["iss"].as_str() != Some(issuer) {
        bail!("the ID token issuer does not match");
    }
    let audiences: Vec<&str> = match &claims["aud"] {
        Value::String(s) => vec![s.as_str()],
        Value::Array(a) => a.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    };
    if !audiences.contains(&client_id) {
        bail!("the ID token was not issued for this client");
    }
    if audiences.len() > 1 && claims["azp"].as_str().is_some_and(|azp| azp != client_id) {
        bail!("the ID token's authorized party does not match");
    }
    let exp = claims["exp"]
        .as_i64()
        .ok_or_else(|| anyhow!("the ID token has no expiry"))?;
    if exp + CLOCK_SKEW_SECS < now {
        bail!("the ID token has expired");
    }
    if let Some(iat) = claims["iat"].as_i64()
        && iat - CLOCK_SKEW_SECS > now
    {
        bail!("the ID token was issued in the future");
    }
    if let Some(nbf) = claims["nbf"].as_i64()
        && nbf - CLOCK_SKEW_SECS > now
    {
        bail!("the ID token is not valid yet");
    }
    let token_nonce = claims["nonce"].as_str().unwrap_or_default();
    if !rustrmm_crypto::random::ct_eq(token_nonce.as_bytes(), nonce.as_bytes()) {
        bail!("the ID token nonce does not match");
    }
    if claims["sub"].as_str().is_none_or(str::is_empty) {
        bail!("the ID token has no subject");
    }
    Ok(())
}

/// Whether the provider asserted multi-factor authentication (`amr` per RFC 8176, or an MFA
/// `acr` value).
pub fn mfa_asserted(claims: &Value) -> bool {
    const FACTORS: [&str; 10] = [
        "otp", "sms", "hwk", "swk", "fido", "face", "fpt", "iris", "retina", "sc",
    ];
    let amr: Vec<String> = claims["amr"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_ascii_lowercase)
                .collect()
        })
        .unwrap_or_default();
    if amr.iter().any(|m| m == "mfa") {
        return true;
    }
    let factor_count = amr.iter().filter(|m| FACTORS.contains(&m.as_str())).count();
    if factor_count >= 1 && (amr.iter().any(|m| m == "pwd") || factor_count >= 2) {
        return true;
    }
    let acr = claims["acr"]
        .as_str()
        .unwrap_or_default()
        .to_ascii_lowercase();
    acr.contains("mfa")
        || acr.contains("2fa")
        || acr.contains("multi-factor")
        || acr.contains("multifactor")
        || acr == "phr"
        || acr == "phrh"
}

/// The values of the group claim (a top-level claim or a dotted path such as
/// `realm_access.roles`).
pub fn groups(claims: &Value, claim: &str) -> Vec<String> {
    let mut value = claims;
    for part in claim.split('.') {
        value = &value[part];
    }
    match value {
        Value::Array(a) => a
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect(),
        Value::String(s) => vec![s.clone()],
        _ => Vec::new(),
    }
}

// ------------------------------------------------------------------ the flow

#[derive(Debug, Serialize, Deserialize)]
struct Flow {
    provider_id: String,
    state: String,
    nonce: String,
    verifier: String,
    return_to: String,
    exp: i64,
}

fn flow_aad() -> &'static [u8] {
    b"oidc/flow-cookie"
}

fn flow_cookie(value: String, max_age: i64) -> Cookie<'static> {
    Cookie::build((FLOW_COOKIE, value))
        .path("/")
        .secure(true)
        .http_only(true)
        // The callback is a cross-site top-level navigation from the identity provider.
        .same_site(SameSite::Lax)
        .max_age(time::Duration::seconds(max_age))
        .build()
}

fn login_redirect(fragment: &str) -> Response {
    let mut r = Redirect::to(&format!("/login#{fragment}")).into_response();
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r
}

fn safe_return_to(raw: Option<&str>) -> String {
    match raw {
        Some(r)
            if r.starts_with('/')
                && !r.starts_with("//")
                && !r.contains('\\')
                && r.len() <= 512
                && !r.chars().any(char::is_control) =>
        {
            r.to_string()
        }
        _ => "/".into(),
    }
}

#[derive(Deserialize, utoipa::IntoParams)]
pub struct StartQuery {
    /// Console path to open after sign-in (relative, e.g. `/devices`).
    return_to: Option<String>,
}

/// Start SSO sign-in
///
/// Redirects to the identity provider (authorization code flow with PKCE S256).
#[utoipa::path(get, path = "/api/v1/auth/oidc/{provider_id}/start", tag = "Single sign-on",
    params(("provider_id" = String, Path), StartQuery),
    responses((status = 303, description = "Redirect to the identity provider")), security(()))]
pub async fn start(
    State(state): State<AppState>,
    Path(provider_id): Path<String>,
    meta: ClientMeta,
    Query(q): Query<StartQuery>,
    jar: CookieJar,
) -> Response {
    let ip = meta.ip.clone().unwrap_or_else(|| "unknown".into());
    if !state.limiter.check("oidc", &ip, FLOW_LIMIT) {
        return login_redirect("sso_error=rate_limited");
    }
    let provider = match load(&state, &provider_id).await {
        Ok(Some(p)) if p.enabled => p,
        _ => return login_redirect("sso_error=unknown_provider"),
    };
    let discovery = match fetch_metadata(&provider, false).await {
        Ok((d, _)) => d,
        Err(e) => {
            tracing::warn!(provider = %provider.name, error = %format!("{e:#}"), "OIDC discovery failed");
            return login_redirect("sso_error=provider_unavailable");
        }
    };
    let flow = Flow {
        provider_id: provider.id.clone(),
        state: URL_SAFE_NO_PAD.encode(rustrmm_crypto::random::bytes::<24>()),
        nonce: URL_SAFE_NO_PAD.encode(rustrmm_crypto::random::bytes::<24>()),
        verifier: URL_SAFE_NO_PAD.encode(rustrmm_crypto::random::bytes::<32>()),
        return_to: safe_return_to(q.return_to.as_deref()),
        exp: rustrmm_common::now().timestamp() + FLOW_TTL_SECS,
    };
    let challenge =
        URL_SAFE_NO_PAD.encode(rustrmm_crypto::random::sha256(flow.verifier.as_bytes()));
    let Ok(mut url) = url::Url::parse(&discovery.authorization_endpoint) else {
        return login_redirect("sso_error=provider_unavailable");
    };
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &provider.client_id)
        .append_pair("redirect_uri", &redirect_uri(&state, &provider.id))
        .append_pair("scope", &provider.scopes.join(" "))
        .append_pair("state", &flow.state)
        .append_pair("nonce", &flow.nonce)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256");
    let Ok(plain) = serde_json::to_vec(&flow) else {
        return login_redirect("sso_error=internal");
    };
    let sealed = URL_SAFE_NO_PAD.encode(state.cipher.encrypt(&plain, flow_aad()));
    let jar = jar.add(flow_cookie(sealed, FLOW_TTL_SECS));
    let mut response = (jar, Redirect::to(url.as_str())).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[derive(Deserialize, utoipa::IntoParams)]
pub struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

/// SSO callback
///
/// The identity provider redirects here. On success a console session is created (or a local
/// MFA challenge is handed to the login page in the URL fragment) and the browser is redirected.
#[utoipa::path(get, path = "/api/v1/auth/oidc/{provider_id}/callback", tag = "Single sign-on",
    params(("provider_id" = String, Path), CallbackQuery),
    responses((status = 303, description = "Redirect to the console")), security(()))]
pub async fn callback(
    State(state): State<AppState>,
    Path(provider_id): Path<String>,
    meta: ClientMeta,
    Query(q): Query<CallbackQuery>,
    jar: CookieJar,
) -> Response {
    let ip = meta.ip.clone().unwrap_or_else(|| "unknown".into());
    let cleared = jar.clone().remove(flow_cookie(String::new(), 0));
    if !state.limiter.check("oidc", &ip, FLOW_LIMIT) {
        return (cleared, login_redirect("sso_error=rate_limited")).into_response();
    }
    match complete(&state, &provider_id, &meta, &q, &jar).await {
        Ok(Outcome::Session { token, return_to }) => {
            let jar = session::set_cookie(cleared, token, state.args.session_max_hours);
            let mut r = (jar, Redirect::to(&return_to)).into_response();
            r.headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            r
        }
        Ok(Outcome::Mfa {
            challenge,
            setup,
            methods,
        }) => {
            let fragment = if setup {
                format!("sso_challenge={challenge}&mfa=setup")
            } else {
                format!(
                    "sso_challenge={challenge}&mfa=required&methods={}",
                    methods.join(",")
                )
            };
            (cleared, login_redirect(&fragment)).into_response()
        }
        Err((code, detail)) => {
            tracing::warn!(provider = %provider_id, code, error = %detail, "SSO sign-in failed");
            state
                .audit
                .record_or_log(
                    &state.db,
                    AuditEntry::new(Actor::System, "auth.login_failed")
                        .request(meta.ip.clone(), meta.user_agent.clone())
                        .details(json!({ "method": "oidc", "provider_id": provider_id, "reason": code, "detail": detail.chars().take(300).collect::<String>() })),
                )
                .await;
            (cleared, login_redirect(&format!("sso_error={code}"))).into_response()
        }
    }
}

enum Outcome {
    Session {
        token: String,
        return_to: String,
    },
    Mfa {
        challenge: String,
        setup: bool,
        methods: Vec<&'static str>,
    },
}

type FlowError = (&'static str, String);

fn fail(code: &'static str) -> impl FnOnce(anyhow::Error) -> FlowError {
    move |e| (code, format!("{e:#}"))
}

async fn complete(
    state: &AppState,
    provider_id: &str,
    meta: &ClientMeta,
    q: &CallbackQuery,
    jar: &CookieJar,
) -> Result<Outcome, FlowError> {
    if let Some(err) = &q.error {
        return Err(("idp_error", err.chars().take(100).collect()));
    }
    let sealed = jar
        .get(FLOW_COOKIE)
        .map(|c| c.value().to_string())
        .ok_or(("flow_expired", "no flow cookie".to_string()))?;
    let plain = URL_SAFE_NO_PAD
        .decode(sealed.as_bytes())
        .ok()
        .and_then(|blob| state.cipher.decrypt(&blob, flow_aad()).ok())
        .ok_or(("flow_expired", "unreadable flow cookie".to_string()))?;
    let flow: Flow = serde_json::from_slice(&plain)
        .map_err(|_| ("flow_expired", "invalid flow cookie".to_string()))?;
    let now = rustrmm_common::now();
    if flow.exp < now.timestamp() || flow.provider_id != provider_id {
        return Err((
            "flow_expired",
            "flow cookie expired or for another provider".into(),
        ));
    }
    let returned_state = q.state.as_deref().unwrap_or_default();
    if !rustrmm_crypto::random::ct_eq(returned_state.as_bytes(), flow.state.as_bytes()) {
        return Err(("state_mismatch", "state does not match".into()));
    }
    let code = q
        .code
        .as_deref()
        .filter(|c| !c.is_empty() && c.len() <= 4096)
        .ok_or(("idp_error", "no authorization code".to_string()))?;
    let provider = load(state, provider_id)
        .await
        .map_err(fail("internal"))?
        .filter(|p| p.enabled)
        .ok_or((
            "unknown_provider",
            "provider missing or disabled".to_string(),
        ))?;
    let (discovery, _) = fetch_metadata(&provider, false)
        .await
        .map_err(fail("provider_unavailable"))?;
    let id_token = exchange_code(state, &provider, &discovery, code, &flow.verifier)
        .await
        .map_err(fail("token_exchange_failed"))?;
    // Verify (refetching the JWKS once when the key is unknown: key rotation).
    let claims = match fetch_metadata(&provider, false)
        .await
        .map_err(fail("provider_unavailable"))
        .and_then(|(_, jwks)| verify_jws(&id_token, &jwks).map_err(fail("invalid_token")))
    {
        Ok(c) => c,
        Err(_) => {
            let (_, jwks) = fetch_metadata(&provider, true)
                .await
                .map_err(fail("provider_unavailable"))?;
            verify_jws(&id_token, &jwks).map_err(fail("invalid_token"))?
        }
    };
    validate_claims(
        &claims,
        &discovery.issuer,
        &provider.client_id,
        &flow.nonce,
        now.timestamp(),
    )
    .map_err(fail("invalid_token"))?;

    let user_id = link_user(state, &provider, &claims).await?;
    let user = super::load_user(state, &user_id)
        .await
        .map_err(fail("internal"))?
        .ok_or(("internal", "user vanished".to_string()))?;
    if user.status != "active" {
        return Err(("account_disabled", "the account is disabled".into()));
    }
    let user_groups = groups(&claims, &provider.group_claim);
    apply_role_mappings(state, &provider, &user_id, &user_groups)
        .await
        .map_err(fail("internal"))?;
    sqlx::query(
        "UPDATE user_identities SET last_login_at = ? WHERE provider_id = ? AND subject = ?",
    )
    .bind(now)
    .bind(&provider.id)
    .bind(claims["sub"].as_str().unwrap_or_default())
    .execute(&state.db)
    .await
    .map_err(|e| fail("internal")(e.into()))?;

    let asserted = mfa_asserted(&claims);
    if provider.require_local_mfa || !asserted {
        let passkeys = super::webauthn::count_passkeys(&state.db, &user.id)
            .await
            .map_err(fail("internal"))?;
        let has_totp = user.totp_enabled_at.is_some();
        let setup = !has_totp && passkeys == 0;
        let challenge = super::handlers::create_challenge(
            state,
            &user.id,
            if setup { "mfa_setup" } else { "mfa" },
            None,
            None,
        )
        .await
        .map_err(|e| ("internal", e.message))?;
        let mut methods = Vec::new();
        if has_totp {
            methods.push("totp");
        }
        if passkeys > 0 {
            methods.push("webauthn");
        }
        methods.push("recovery_code");
        state
            .audit
            .record_or_log(
                &state.db,
                AuditEntry::new(
                    Actor::User {
                        id: user.id.clone(),
                        name: user.name.clone(),
                    },
                    "auth.sso_verified",
                )
                .request(meta.ip.clone(), meta.user_agent.clone())
                .details(json!({ "provider": provider.name, "local_mfa": if setup { "setup" } else { "required" },
                                 "provider_mfa": asserted, "groups": user_groups.len() })),
            )
            .await;
        return Ok(Outcome::Mfa {
            challenge,
            setup,
            methods,
        });
    }
    let (token, _record) = session::create(
        state,
        &user.id,
        meta.ip.clone(),
        meta.user_agent.clone(),
        false,
    )
    .await
    .map_err(fail("internal"))?;
    sqlx::query("UPDATE users SET last_login_at = ? WHERE id = ?")
        .bind(now)
        .bind(&user.id)
        .execute(&state.db)
        .await
        .map_err(|e| fail("internal")(e.into()))?;
    state
        .audit
        .record_or_log(
            &state.db,
            AuditEntry::new(
                Actor::User {
                    id: user.id.clone(),
                    name: user.name.clone(),
                },
                "auth.login",
            )
            .request(meta.ip.clone(), meta.user_agent.clone())
            .details(
                json!({ "method": "oidc", "provider": provider.name, "provider_mfa": true,
                             "groups": user_groups.len() }),
            ),
        )
        .await;
    Ok(Outcome::Session {
        token,
        return_to: flow.return_to,
    })
}

async fn exchange_code(
    state: &AppState,
    provider: &Provider,
    discovery: &Discovery,
    code: &str,
    verifier: &str,
) -> anyhow::Result<String> {
    let secret = match &provider.client_secret {
        Some(blob) => Some(
            state
                .cipher
                .decrypt_string(blob, &secret_aad(&provider.id))?
                .to_string(),
        ),
        None => None,
    };
    let basic = secret.is_some()
        && (discovery.token_endpoint_auth_methods_supported.is_empty()
            || discovery
                .token_endpoint_auth_methods_supported
                .iter()
                .any(|m| m == "client_secret_basic"));
    let form_body = {
        let mut form = url::form_urlencoded::Serializer::new(String::new());
        form.append_pair("grant_type", "authorization_code")
            .append_pair("code", code)
            .append_pair("redirect_uri", &redirect_uri(state, &provider.id))
            .append_pair("code_verifier", verifier)
            .append_pair("client_id", &provider.client_id);
        if let (Some(secret), false) = (&secret, basic) {
            form.append_pair("client_secret", secret);
        }
        form.finish()
    };
    let mut request = http_client()?
        .post(&discovery.token_endpoint)
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded",
        )
        .header(reqwest::header::ACCEPT, "application/json")
        .body(form_body);
    if let (Some(secret), true) = (&secret, basic) {
        let enc = |s: &str| url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>();
        let credentials = base64::engine::general_purpose::STANDARD.encode(format!(
            "{}:{}",
            enc(&provider.client_id),
            enc(secret)
        ));
        request = request.header(
            reqwest::header::AUTHORIZATION,
            format!("Basic {credentials}"),
        );
    }
    let response = request.send().await.context("calling the token endpoint")?;
    let body = read_json(response, "token endpoint").await?;
    body["id_token"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| anyhow!("the token response has no id_token"))
}

/// Finds the user for the ID token (identity link, then verified e-mail, then provisioning).
async fn link_user(
    state: &AppState,
    provider: &Provider,
    claims: &Value,
) -> Result<String, FlowError> {
    let sub = claims["sub"].as_str().unwrap_or_default().to_string();
    let linked: Option<String> = sqlx::query_scalar(
        "SELECT user_id FROM user_identities WHERE provider_id = ? AND subject = ?",
    )
    .bind(&provider.id)
    .bind(&sub)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| fail("internal")(e.into()))?;
    if let Some(user_id) = linked {
        return Ok(user_id);
    }
    let email = claims["email"]
        .as_str()
        .map(|e| e.trim().to_lowercase())
        .filter(|e| crate::monitoring::settings::valid_email(e))
        .ok_or((
            "no_email",
            "the ID token carries no usable email claim".to_string(),
        ))?;
    let verified = claims["email_verified"].as_bool() == Some(true)
        || claims["email_verified"].as_str() == Some("true");
    if !verified && !provider.trust_unverified_email {
        return Err((
            "email_not_verified",
            "the provider did not verify the email".into(),
        ));
    }
    let existing: Option<String> = sqlx::query_scalar("SELECT id FROM users WHERE email = ?")
        .bind(&email)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| fail("internal")(e.into()))?;
    let now = rustrmm_common::now();
    let (user_id, created) = match existing {
        Some(id) => (id, false),
        None if provider.auto_provision => {
            let name = claims["name"]
                .as_str()
                .or_else(|| claims["preferred_username"].as_str())
                .map(|n| n.trim().chars().take(100).collect::<String>())
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| email.clone());
            // SSO users get an unusable random password (they can set one later if allowed).
            let random = rustrmm_crypto::random::token();
            let hash = tokio::task::spawn_blocking(move || super::password::hash(&random))
                .await
                .map_err(|e| ("internal", e.to_string()))?
                .map_err(fail("internal"))?;
            let id = rustrmm_common::new_id();
            sqlx::query(
                "INSERT INTO users (id, email, name, password_hash, status, password_changed_at, created_at, updated_at)
                 VALUES (?, ?, ?, ?, 'active', ?, ?, ?)",
            )
            .bind(&id)
            .bind(&email)
            .bind(&name)
            .bind(hash)
            .bind(now)
            .bind(now)
            .bind(now)
            .execute(&state.db)
            .await
            .map_err(|e| fail("internal")(e.into()))?;
            (id, true)
        }
        None => {
            return Err(("not_provisioned", format!("no account for {email}")));
        }
    };
    sqlx::query(
        "INSERT OR IGNORE INTO user_identities (user_id, provider_id, subject, email, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&user_id)
    .bind(&provider.id)
    .bind(&sub)
    .bind(&email)
    .bind(now)
    .execute(&state.db)
    .await
    .map_err(|e| fail("internal")(e.into()))?;
    state
        .audit
        .record_or_log(
            &state.db,
            AuditEntry::new(
                Actor::System,
                if created {
                    "user.provisioned"
                } else {
                    "user.identity_linked"
                },
            )
            .target("user", &user_id, &email)
            .details(json!({ "provider": provider.name, "provider_id": provider.id })),
        )
        .await;
    Ok(user_id)
}

/// Replaces the user's assignments managed by this provider with the mapped ones.
async fn apply_role_mappings(
    state: &AppState,
    provider: &Provider,
    user_id: &str,
    user_groups: &[String],
) -> anyhow::Result<()> {
    let wanted: Vec<&RoleMapping> = provider
        .role_mappings
        .iter()
        .filter(|m| user_groups.contains(&m.group))
        .collect();
    let mut tx = state.db.begin().await?;
    sqlx::query("DELETE FROM role_assignments WHERE user_id = ? AND managed_by = ?")
        .bind(user_id)
        .bind(&provider.id)
        .execute(&mut *tx)
        .await?;
    let now = rustrmm_common::now();
    let mut applied = HashMap::new();
    for m in wanted {
        if m.role_id == OWNER_ROLE_ID {
            continue;
        }
        let key = (m.role_id.clone(), m.scope_type.clone(), m.scope_id.clone());
        if applied.insert(key, ()).is_some() {
            continue;
        }
        sqlx::query(
            "INSERT OR IGNORE INTO role_assignments (id, user_id, role_id, scope_type, scope_id, created_at, managed_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(rustrmm_common::new_id())
        .bind(user_id)
        .bind(&m.role_id)
        .bind(&m.scope_type)
        .bind(&m.scope_id)
        .bind(now)
        .bind(&provider.id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mfa_claims() {
        assert!(mfa_asserted(&json!({ "amr": ["pwd", "mfa"] })));
        assert!(mfa_asserted(&json!({ "amr": ["pwd", "otp"] })));
        assert!(mfa_asserted(&json!({ "amr": ["hwk", "fpt"] })));
        assert!(!mfa_asserted(&json!({ "amr": ["pwd"] })));
        assert!(!mfa_asserted(&json!({})));
        assert!(mfa_asserted(&json!({ "acr": "urn:okta:loa:2fa:any" })));
        assert!(mfa_asserted(&json!({
            "acr": "http://schemas.openid.net/pape/policies/2007/06/multi-factor"
        })));
        assert!(!mfa_asserted(&json!({ "acr": "1" })));
    }

    #[test]
    fn group_claims_and_paths() {
        let claims =
            json!({ "groups": ["a", "b"], "realm_access": { "roles": ["admin"] }, "role": "x" });
        assert_eq!(groups(&claims, "groups"), vec!["a", "b"]);
        assert_eq!(groups(&claims, "realm_access.roles"), vec!["admin"]);
        assert_eq!(groups(&claims, "role"), vec!["x"]);
        assert!(groups(&claims, "missing").is_empty());
    }

    #[test]
    fn return_to_is_relative_only() {
        assert_eq!(safe_return_to(Some("/devices?x=1")), "/devices?x=1");
        assert_eq!(safe_return_to(Some("//evil.example")), "/");
        assert_eq!(safe_return_to(Some("https://evil.example")), "/");
        assert_eq!(safe_return_to(Some("/\\evil")), "/");
        assert_eq!(safe_return_to(None), "/");
    }

    #[test]
    fn claims_validation() {
        let now = 1_800_000_000;
        let good = json!({ "iss": "https://idp", "aud": ["app", "other"], "azp": "app", "exp": now + 60,
                           "iat": now, "nonce": "n1", "sub": "s" });
        assert!(validate_claims(&good, "https://idp", "app", "n1", now).is_ok());
        assert!(validate_claims(&good, "https://idp2", "app", "n1", now).is_err());
        assert!(validate_claims(&good, "https://idp", "nope", "n1", now).is_err());
        assert!(validate_claims(&good, "https://idp", "app", "n2", now).is_err());
        assert!(validate_claims(&good, "https://idp", "app", "n1", now + 600).is_err());
        let mut bad_azp = good.clone();
        bad_azp["azp"] = json!("other");
        assert!(validate_claims(&bad_azp, "https://idp", "app", "n1", now).is_err());
    }

    #[test]
    fn es256_tokens_verify_and_tampering_fails() {
        use ring::rand::SystemRandom;
        use ring::signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, KeyPair};
        let rng = SystemRandom::new();
        let pkcs8 =
            EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).expect("key");
        let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng)
            .expect("pair");
        let public = pair.public_key().as_ref();
        let jwks = Jwks {
            keys: vec![Jwk {
                kty: "EC".into(),
                kid: Some("k1".into()),
                key_use: Some("sig".into()),
                alg: Some("ES256".into()),
                n: None,
                e: None,
                crv: Some("P-256".into()),
                x: Some(URL_SAFE_NO_PAD.encode(&public[1..33])),
                y: Some(URL_SAFE_NO_PAD.encode(&public[33..65])),
            }],
        };
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"ES256","kid":"k1"}"#);
        let payload = URL_SAFE_NO_PAD.encode(br#"{"sub":"u1"}"#);
        let input = format!("{header}.{payload}");
        let sig = pair.sign(&rng, input.as_bytes()).expect("sign");
        let token = format!("{input}.{}", URL_SAFE_NO_PAD.encode(sig.as_ref()));
        assert_eq!(verify_jws(&token, &jwks).expect("valid")["sub"], "u1");
        let forged_payload = URL_SAFE_NO_PAD.encode(br#"{"sub":"admin"}"#);
        let forged = format!(
            "{header}.{forged_payload}.{}",
            URL_SAFE_NO_PAD.encode(sig.as_ref())
        );
        assert!(verify_jws(&forged, &jwks).is_err());
        let none = format!(
            "{}.{payload}.",
            URL_SAFE_NO_PAD.encode(br#"{"alg":"none","kid":"k1"}"#)
        );
        assert!(verify_jws(&none, &jwks).is_err());
    }
}
