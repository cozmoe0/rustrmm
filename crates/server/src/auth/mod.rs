//! Authentication: sessions, MFA (TOTP, passkeys, recovery codes), step-up, and the
//! [`AuthCtx`] extractor that every protected handler takes.

pub mod handlers;
pub mod me;
pub mod oidc;
pub mod password;
pub mod session;
pub mod tokens;
pub mod totp;
pub mod webauthn;

use std::net::{IpAddr, SocketAddr};

use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::request::Parts;
use axum::http::{HeaderMap, Method, header};
use axum_extra::extract::CookieJar;
use chrono::{DateTime, Utc};
use sqlx::FromRow;

use crate::audit::{Actor, AuditEntry};
use crate::error::{ApiError, ApiResult};
use crate::rbac::AccessScope;
use crate::state::AppState;
use session::SessionRecord;

pub const CSRF_HEADER: &str = "x-csrf-token";

#[derive(Debug, Clone, FromRow)]
pub struct UserRecord {
    pub id: String,
    pub email: String,
    pub name: String,
    pub password_hash: String,
    pub status: String,
    pub totp_secret: Option<Vec<u8>>,
    pub totp_enabled_at: Option<DateTime<Utc>>,
    pub totp_last_step: Option<i64>,
    pub failed_logins: i64,
    pub locked_until: Option<DateTime<Utc>>,
    pub last_login_at: Option<DateTime<Utc>>,
    pub password_changed_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

pub const USER_COLUMNS: &str =
    "id, email, name, password_hash, status, totp_secret, totp_enabled_at, totp_last_step,
    failed_logins, locked_until, last_login_at, password_changed_at, created_at";

pub async fn load_user(state: &AppState, user_id: &str) -> anyhow::Result<Option<UserRecord>> {
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {USER_COLUMNS} FROM users WHERE id = ?"
    )))
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?)
}

/// The API token a request authenticated with.
#[derive(Debug, Clone)]
pub struct TokenInfo {
    pub id: String,
    pub name: String,
}

/// Authenticated request context.
pub struct AuthCtx {
    pub user: UserRecord,
    /// The console session; for API tokens a synthetic record that is never stepped up.
    pub session: SessionRecord,
    pub scope: AccessScope,
    pub ip: Option<String>,
    pub user_agent: Option<String>,
    /// Set when the request used `Authorization: Bearer rrmm_pat_…`.
    pub token: Option<TokenInfo>,
}

impl AuthCtx {
    /// Whether the request authenticated with an API token.
    pub fn is_token(&self) -> bool {
        self.token.is_some()
    }

    /// Refuses API tokens (interactive sessions, account management).
    pub fn require_session(&self) -> ApiResult<()> {
        if self.is_token() {
            Err(token_not_allowed())
        } else {
            Ok(())
        }
    }

    /// Permission held at any scope (handlers then filter results by scope).
    pub fn require(&self, perm: &str) -> ApiResult<()> {
        if self.scope.has_anywhere(perm) {
            Ok(())
        } else {
            Err(forbidden(perm))
        }
    }

    /// Permission held installation-wide.
    pub fn require_global(&self, perm: &str) -> ApiResult<()> {
        if self.scope.has_global(perm) {
            Ok(())
        } else {
            Err(forbidden(perm))
        }
    }

    /// Permission over a whole client.
    pub fn require_client(&self, perm: &str, client_id: &str) -> ApiResult<()> {
        if self.scope.can_client(perm, client_id) {
            Ok(())
        } else {
            Err(forbidden(perm))
        }
    }

    /// Requires an MFA confirmation on this session (MFA sign-in or a step-up; it lasts until the
    /// session ends).
    pub fn require_step_up(&self) -> ApiResult<()> {
        if self.session.is_stepped_up() {
            Ok(())
        } else {
            Err(ApiError::step_up_required())
        }
    }

    pub fn actor(&self) -> Actor {
        Actor::User {
            id: self.user.id.clone(),
            name: match &self.token {
                Some(t) => format!("{} (API token {})", self.user.name, t.name),
                None => self.user.name.clone(),
            },
        }
    }

    /// Starts an audit entry pre-filled with actor and request metadata.
    pub fn audit(&self, action: &'static str) -> AuditEntry {
        AuditEntry::new(self.actor(), action).request(self.ip.clone(), self.user_agent.clone())
    }
}

fn forbidden(perm: &str) -> ApiError {
    ApiError::forbidden(format!("Missing permission: {perm}"))
        .with_details(serde_json::json!({ "permission": perm }))
}

pub fn token_not_allowed() -> ApiError {
    ApiError::new(
        axum::http::StatusCode::FORBIDDEN,
        "token_not_allowed",
        "This action needs a signed-in console session; API tokens cannot use it",
    )
}

/// Routes an API token may never call: interactive sessions (shell, desktop, live stream),
/// step-up, account management and minting further tokens.
fn token_blocked(method: &Method, path: &str) -> bool {
    let path = path.trim_end_matches('/');
    let path = path.strip_prefix("/api/v1").unwrap_or(path);
    path.starts_with("/me/")
        || path.starts_with("/auth/step-up")
        || path.starts_with("/stream")
        || (path.starts_with("/remote-sessions/") && path.ends_with("/ws"))
        || (path.starts_with("/devices/")
            && (path.ends_with("/shell") || path.ends_with("/desktop")))
        || (path == "/api-tokens" && *method == Method::POST)
}

impl FromRequestParts<AppState> for AuthCtx {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        if let Some(bearer) = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| {
                v.strip_prefix("Bearer ")
                    .or_else(|| v.strip_prefix("bearer "))
            })
        {
            let ip = client_ip(parts, state);
            let path = parts.uri.path().to_string();
            if token_blocked(&parts.method, &path) {
                return Err(token_not_allowed());
            }
            let auth = tokens::authenticate(state, bearer.trim(), ip).await?;
            return Ok(Self {
                user: auth.user,
                session: auth.session,
                scope: auth.scope,
                ip: ip.map(|ip| ip.to_string()),
                user_agent: user_agent(&parts.headers),
                token: Some(auth.token),
            });
        }
        let jar = CookieJar::from_headers(&parts.headers);
        let token = jar
            .get(session::COOKIE_NAME)
            .map(|c| c.value().to_string())
            .ok_or_else(ApiError::unauthenticated)?;
        let session = session::lookup(state, &token)
            .await?
            .ok_or_else(ApiError::unauthenticated)?;

        if is_unsafe(&parts.method) {
            check_origin_headers(state, &parts.headers, false)?;
            let provided = parts
                .headers
                .get(CSRF_HEADER)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("");
            if !rustrmm_crypto::random::ct_eq(provided.as_bytes(), session.csrf_token.as_bytes()) {
                return Err(ApiError::forbidden("Missing or invalid CSRF token")
                    .with_details(serde_json::json!({ "reason": "csrf" })));
            }
        }

        let user = load_user(state, &session.user_id)
            .await?
            .ok_or_else(ApiError::unauthenticated)?;
        if user.status != "active" {
            session::revoke(&state.db, &session.id).await?;
            return Err(ApiError::unauthenticated());
        }
        let scope = AccessScope::load(&state.db, &user.id).await?;
        let ip = client_ip(parts, state).map(|ip| ip.to_string());
        let user_agent = user_agent(&parts.headers);
        Ok(Self {
            user,
            session,
            scope,
            ip,
            user_agent,
            token: None,
        })
    }
}

fn is_unsafe(method: &Method) -> bool {
    !matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS)
}

pub fn user_agent(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(|ua| ua.chars().take(400).collect())
}

/// Client address: the socket peer, or the first untrusted hop of `X-Forwarded-For` when the peer
/// is a configured trusted proxy.
pub fn client_ip(parts: &Parts, state: &AppState) -> Option<IpAddr> {
    let peer = parts
        .extensions
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ci| ci.0.ip());
    let peer = peer?;
    let trusted = |ip: &IpAddr| {
        state
            .args
            .trusted_proxies
            .iter()
            .any(|net| net.contains(ip))
    };
    if !trusted(&peer) {
        return Some(peer);
    }
    let forwarded = parts
        .headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    forwarded
        .split(',')
        .rev()
        .filter_map(|s| s.trim().parse::<IpAddr>().ok())
        .find(|ip| !trusted(ip))
        .or(Some(peer))
}

/// Extracts the client IP inside a handler that doesn't use [`AuthCtx`].
pub struct ClientMeta {
    pub ip: Option<String>,
    pub user_agent: Option<String>,
}

impl FromRequestParts<AppState> for ClientMeta {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        Ok(Self {
            ip: client_ip(parts, state).map(|ip| ip.to_string()),
            user_agent: user_agent(&parts.headers),
        })
    }
}

/// Rejects cross-site requests. When `require_present` is false a missing `Origin` header is
/// accepted (non-browser clients); browsers always send it on POST and WebSocket upgrades.
pub fn check_origin_headers(
    state: &AppState,
    headers: &HeaderMap,
    require_present: bool,
) -> ApiResult<()> {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return if require_present {
            Err(ApiError::forbidden("Missing Origin header"))
        } else {
            Ok(())
        };
    };
    if origin_allowed(state, headers, origin) {
        Ok(())
    } else {
        tracing::warn!(origin, "rejected cross-origin request");
        Err(ApiError::forbidden("Cross-origin request rejected"))
    }
}

fn origin_allowed(state: &AppState, headers: &HeaderMap, origin: &str) -> bool {
    let origin = origin.trim_end_matches('/');
    if state.allowed_origins.iter().any(|o| o == origin) {
        return true;
    }
    // Same-origin request addressed by a host name or IP the operator didn't list.
    if let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok())
        && (origin == format!("https://{host}") || origin == format!("http://{host}"))
    {
        return true;
    }
    if state.args.dev
        && let Ok(url) = url::Url::parse(origin)
        && matches!(
            url.host_str(),
            Some("localhost") | Some("127.0.0.1") | Some("[::1]")
        )
    {
        return true;
    }
    false
}

/// Builds the list of allowed origins from configuration.
pub fn allowed_origins(args: &crate::config::ServeArgs) -> Vec<String> {
    let mut origins = vec![args.console_origin()];
    for url in &args.allowed_origins {
        origins.push(crate::config::origin_of(url));
    }
    origins.sort();
    origins.dedup();
    origins
}
