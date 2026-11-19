//! Console sessions: opaque 256-bit tokens in a `__Host-` cookie; only their SHA-256 is stored.

use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use chrono::{DateTime, Duration, Utc};
use sqlx::FromRow;

use crate::db::Db;
use crate::state::AppState;

pub const COOKIE_NAME: &str = "__Host-rustrmm_session";
/// Last-seen updates are throttled to avoid a write on every request.
const TOUCH_EVERY: Duration = Duration::seconds(60);

#[derive(Debug, Clone, FromRow)]
pub struct SessionRecord {
    pub id: String,
    pub user_id: String,
    pub csrf_token: String,
    pub created_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
    pub idle_expires_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub stepped_up_until: Option<DateTime<Utc>>,
    pub ip: Option<String>,
    pub user_agent: Option<String>,
}

impl SessionRecord {
    pub fn is_stepped_up(&self) -> bool {
        self.stepped_up_until
            .is_some_and(|t| t > rustrmm_common::now())
    }
}

pub fn token_id(token: &str) -> String {
    rustrmm_crypto::random::sha256_hex(token.as_bytes())
}

/// Creates a session and returns `(token, record)`. The token is only ever sent in the cookie.
pub async fn create(
    state: &AppState,
    user_id: &str,
    ip: Option<String>,
    user_agent: Option<String>,
    stepped_up: bool,
) -> anyhow::Result<(String, SessionRecord)> {
    let token = rustrmm_crypto::random::token();
    let now = rustrmm_common::now();
    let expires_at = now + Duration::hours(state.args.session_max_hours.max(1));
    let record = SessionRecord {
        id: token_id(&token),
        user_id: user_id.to_string(),
        csrf_token: rustrmm_crypto::random::token(),
        created_at: now,
        last_seen_at: now,
        idle_expires_at: now + Duration::minutes(state.args.session_idle_minutes.max(5)),
        expires_at,
        // Signing in with MFA counts as a step-up for the whole session.
        stepped_up_until: stepped_up.then_some(expires_at),
        ip,
        user_agent: user_agent.map(|ua| ua.chars().take(400).collect()),
    };
    sqlx::query(
        "INSERT INTO sessions (id, user_id, csrf_token, created_at, last_seen_at, idle_expires_at, expires_at,
                               stepped_up_until, ip, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&record.id)
    .bind(&record.user_id)
    .bind(&record.csrf_token)
    .bind(record.created_at)
    .bind(record.last_seen_at)
    .bind(record.idle_expires_at)
    .bind(record.expires_at)
    .bind(record.stepped_up_until)
    .bind(&record.ip)
    .bind(&record.user_agent)
    .execute(&state.db)
    .await?;
    Ok((token, record))
}

/// Resolves a token to a live session, sliding the idle expiry.
pub async fn lookup(state: &AppState, token: &str) -> anyhow::Result<Option<SessionRecord>> {
    let now = rustrmm_common::now();
    let record: Option<SessionRecord> = sqlx::query_as(
        "SELECT id, user_id, csrf_token, created_at, last_seen_at, idle_expires_at, expires_at, stepped_up_until,
                ip, user_agent
         FROM sessions
         WHERE id = ? AND revoked_at IS NULL AND expires_at > ? AND idle_expires_at > ?",
    )
    .bind(token_id(token))
    .bind(now)
    .bind(now)
    .fetch_optional(&state.db)
    .await?;
    let Some(mut record) = record else {
        return Ok(None);
    };
    if now - record.last_seen_at > TOUCH_EVERY {
        let idle = (now + Duration::minutes(state.args.session_idle_minutes.max(5)))
            .min(record.expires_at);
        sqlx::query("UPDATE sessions SET last_seen_at = ?, idle_expires_at = ? WHERE id = ?")
            .bind(now)
            .bind(idle)
            .bind(&record.id)
            .execute(&state.db)
            .await?;
        record.last_seen_at = now;
        record.idle_expires_at = idle;
    }
    Ok(Some(record))
}

pub async fn revoke(db: &Db, session_id: &str) -> anyhow::Result<()> {
    sqlx::query("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .bind(rustrmm_common::now())
        .bind(session_id)
        .execute(db)
        .await?;
    Ok(())
}

/// Revokes every session of a user except `keep` (e.g. after a password change).
pub async fn revoke_all_for_user(db: &Db, user_id: &str, keep: Option<&str>) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id <> ?",
    )
    .bind(rustrmm_common::now())
    .bind(user_id)
    .bind(keep.unwrap_or(""))
    .execute(db)
    .await?;
    Ok(())
}

/// Marks a session stepped up until it expires: one MFA confirmation lasts the whole session.
pub async fn mark_stepped_up(db: &Db, session: &SessionRecord) -> anyhow::Result<DateTime<Utc>> {
    let until = session.expires_at;
    sqlx::query("UPDATE sessions SET stepped_up_until = ? WHERE id = ?")
        .bind(until)
        .bind(&session.id)
        .execute(db)
        .await?;
    Ok(until)
}

pub fn set_cookie(jar: CookieJar, token: String, max_age_hours: i64) -> CookieJar {
    let cookie = Cookie::build((COOKIE_NAME, token))
        .path("/")
        .secure(true)
        .http_only(true)
        .same_site(SameSite::Strict)
        .max_age(time_duration_hours(max_age_hours))
        .build();
    jar.add(cookie)
}

pub fn clear_cookie(jar: CookieJar) -> CookieJar {
    let cookie = Cookie::build((COOKIE_NAME, ""))
        .path("/")
        .secure(true)
        .http_only(true)
        .same_site(SameSite::Strict)
        .build();
    jar.remove(cookie)
}

fn time_duration_hours(hours: i64) -> time::Duration {
    time::Duration::hours(hours.max(1))
}

/// Deletes long-dead sessions and challenges (housekeeping task).
pub async fn purge_expired(db: &Db) -> anyhow::Result<()> {
    let cutoff = rustrmm_common::now() - Duration::days(30);
    sqlx::query("DELETE FROM sessions WHERE expires_at < ?")
        .bind(cutoff)
        .execute(db)
        .await?;
    sqlx::query("DELETE FROM auth_challenges WHERE expires_at < ?")
        .bind(rustrmm_common::now())
        .execute(db)
        .await?;
    Ok(())
}
