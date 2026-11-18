//! Login and MFA endpoints. MFA is mandatory: a correct password yields a short-lived
//! challenge token that must be completed with TOTP, a passkey or a recovery code (or used to
//! enroll TOTP on first sign-in) before a session is created.

use std::time::Duration as StdDuration;

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum_extra::extract::CookieJar;
use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use webauthn_rs::prelude::{PasskeyAuthentication, PublicKeyCredential};

use super::me::{MeResponse, build_me};
use super::session;
use super::{ClientMeta, USER_COLUMNS, UserRecord, password, totp, webauthn};
use crate::audit::{Actor, AuditEntry};
use crate::error::{ApiError, ApiResult};
use crate::ratelimit::Limit;
use crate::state::AppState;

const CHALLENGE_TTL_MINUTES: i64 = 10;
const CHALLENGE_MAX_ATTEMPTS: i64 = 5;
const LOGIN_LIMIT: Limit = Limit::per(10, StdDuration::from_secs(60));
const MFA_LIMIT: Limit = Limit::per(20, StdDuration::from_secs(60));

#[derive(Deserialize)]
pub struct LoginRequest {
    email: String,
    password: String,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum LoginResponse {
    MfaRequired {
        challenge_token: String,
        methods: Vec<&'static str>,
    },
    MfaSetupRequired {
        challenge_token: String,
    },
}

fn rate_key(meta: &ClientMeta) -> String {
    meta.ip.clone().unwrap_or_else(|| "unknown".into())
}

/// `POST /api/v1/auth/login`
#[utoipa::path(post, path = "/api/v1/auth/login", tag = "Authentication", summary = "Login", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")), security(()))]
pub async fn login(
    State(state): State<AppState>,
    meta: ClientMeta,
    Json(req): Json<LoginRequest>,
) -> ApiResult<Json<LoginResponse>> {
    if !state.limiter.check("login", &rate_key(&meta), LOGIN_LIMIT) {
        return Err(ApiError::too_many_requests());
    }
    let email = req.email.trim().to_lowercase();
    let user: Option<UserRecord> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {USER_COLUMNS} FROM users WHERE email = ?"
    )))
    .bind(&email)
    .fetch_optional(&state.db)
    .await?;

    let invalid = || {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_credentials",
            "Email or password is incorrect",
        )
    };
    let Some(user) = user else {
        let pw = req.password.clone();
        tokio::task::spawn_blocking(move || password::verify_dummy(&pw)).await?;
        audit_failed_login(&state, &meta, &email, "unknown_account").await;
        return Err(invalid());
    };

    if let Some(until) = user.locked_until
        && until > rustrmm_common::now()
    {
        audit_failed_login(&state, &meta, &email, "locked").await;
        return Err(ApiError::new(
            StatusCode::LOCKED,
            "account_locked",
            "Too many failed attempts; try again later",
        )
        .with_details(json!({ "locked_until": until })));
    }

    let pw = req.password.clone();
    let phc = user.password_hash.clone();
    let ok = tokio::task::spawn_blocking(move || password::verify(&pw, &phc)).await?;
    if !ok || user.status != "active" {
        register_failure(&state, &user).await?;
        audit_failed_login(
            &state,
            &meta,
            &email,
            if ok { "disabled" } else { "bad_password" },
        )
        .await;
        return Err(invalid());
    }
    sqlx::query("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?")
        .bind(&user.id)
        .execute(&state.db)
        .await?;
    // Single sign-on enforced: only global owners keep password + MFA sign-in (break glass).
    if super::oidc::password_login_blocked(&state, &user.id).await? {
        audit_failed_login(&state, &meta, &email, "sso_enforced").await;
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "sso_required",
            "Sign in with your organisation's single sign-on provider",
        ));
    }

    let passkeys = webauthn::count_passkeys(&state.db, &user.id).await?;
    let has_totp = user.totp_enabled_at.is_some();
    if !has_totp && passkeys == 0 {
        let token = create_challenge(&state, &user.id, "mfa_setup", None, None).await?;
        return Ok(Json(LoginResponse::MfaSetupRequired {
            challenge_token: token,
        }));
    }
    let mut methods = Vec::new();
    if has_totp {
        methods.push("totp");
    }
    if passkeys > 0 {
        methods.push("webauthn");
    }
    methods.push("recovery_code");
    let token = create_challenge(&state, &user.id, "mfa", None, None).await?;
    Ok(Json(LoginResponse::MfaRequired {
        challenge_token: token,
        methods,
    }))
}

async fn register_failure(state: &AppState, user: &UserRecord) -> ApiResult<()> {
    let failures = user.failed_logins + 1;
    // Lock after 5 failures: 1 minute, doubling, capped at 1 hour.
    let locked_until = (failures >= 5).then(|| {
        let minutes = 1i64 << (failures - 5).min(6);
        rustrmm_common::now() + Duration::minutes(minutes.min(60))
    });
    sqlx::query("UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?")
        .bind(failures)
        .bind(locked_until)
        .bind(&user.id)
        .execute(&state.db)
        .await?;
    Ok(())
}

async fn audit_failed_login(state: &AppState, meta: &ClientMeta, email: &str, reason: &str) {
    state
        .audit
        .record_or_log(
            &state.db,
            AuditEntry::new(Actor::System, "auth.login_failed")
                .request(meta.ip.clone(), meta.user_agent.clone())
                .details(json!({ "email": email, "reason": reason })),
        )
        .await;
}

// ------------------------------------------------------------------ challenges

/// A loaded, still-valid challenge.
pub struct Challenge {
    pub id: String,
    pub user_id: String,
    pub kind: String,
    pub state: Option<Vec<u8>>,
    pub session_id: Option<String>,
}

fn challenge_aad(id: &str) -> String {
    format!("auth_challenges/state/{id}")
}

pub async fn create_challenge(
    state: &AppState,
    user_id: &str,
    kind: &str,
    payload: Option<&Value>,
    session_id: Option<&str>,
) -> ApiResult<String> {
    let token = rustrmm_crypto::random::token();
    let id = session::token_id(&token);
    let now = rustrmm_common::now();
    let blob = match payload {
        Some(v) => Some(state.cipher.encrypt(
            serde_json::to_string(v)?.as_bytes(),
            challenge_aad(&id).as_bytes(),
        )),
        None => None,
    };
    // One live challenge of each kind per user.
    sqlx::query("DELETE FROM auth_challenges WHERE user_id = ? AND kind = ?")
        .bind(user_id)
        .bind(kind)
        .execute(&state.db)
        .await?;
    sqlx::query(
        "INSERT INTO auth_challenges (id, user_id, kind, state, session_id, attempts, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
    )
    .bind(&id)
    .bind(user_id)
    .bind(kind)
    .bind(blob)
    .bind(session_id)
    .bind(now)
    .bind(now + Duration::minutes(CHALLENGE_TTL_MINUTES))
    .execute(&state.db)
    .await?;
    Ok(token)
}

/// `(user_id, kind, state, session_id, attempts)` of a challenge row.
type ChallengeRow = (String, String, Option<Vec<u8>>, Option<String>, i64);

/// Loads a challenge by token, counting the attempt. Fails when expired or exhausted.
pub async fn take_challenge(state: &AppState, token: &str, kinds: &[&str]) -> ApiResult<Challenge> {
    let id = session::token_id(token);
    let row: Option<ChallengeRow> = sqlx::query_as(
        "SELECT user_id, kind, state, session_id, attempts FROM auth_challenges WHERE id = ? AND expires_at > ?",
    )
    .bind(&id)
    .bind(rustrmm_common::now())
    .fetch_optional(&state.db)
    .await?;
    let expired = || {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "challenge_expired",
            "Sign-in expired; start again",
        )
    };
    let Some((user_id, kind, blob, session_id, attempts)) = row else {
        return Err(expired());
    };
    if !kinds.contains(&kind.as_str()) {
        return Err(expired());
    }
    if attempts >= CHALLENGE_MAX_ATTEMPTS {
        sqlx::query("DELETE FROM auth_challenges WHERE id = ?")
            .bind(&id)
            .execute(&state.db)
            .await?;
        return Err(expired());
    }
    sqlx::query("UPDATE auth_challenges SET attempts = attempts + 1 WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    let decrypted = match blob {
        Some(b) => Some(
            state
                .cipher
                .decrypt(&b, challenge_aad(&id).as_bytes())?
                .to_vec(),
        ),
        None => None,
    };
    Ok(Challenge {
        id,
        user_id,
        kind,
        state: decrypted,
        session_id,
    })
}

pub async fn delete_challenge(state: &AppState, id: &str) -> ApiResult<()> {
    sqlx::query("DELETE FROM auth_challenges WHERE id = ?")
        .bind(id)
        .execute(&state.db)
        .await?;
    Ok(())
}

fn challenge_json<T: serde::de::DeserializeOwned>(challenge: &Challenge) -> ApiResult<T> {
    let raw = challenge
        .state
        .as_ref()
        .ok_or_else(|| ApiError::internal("challenge is missing its state"))?;
    Ok(serde_json::from_slice(raw)?)
}

// ------------------------------------------------------------------ completing sign-in

#[derive(Serialize)]
pub struct SignedIn {
    status: &'static str,
    me: MeResponse,
    #[serde(skip_serializing_if = "Option::is_none")]
    recovery_codes: Option<Vec<String>>,
}

async fn finish_sign_in(
    state: &AppState,
    jar: CookieJar,
    user_id: &str,
    meta: &ClientMeta,
    method: &str,
    recovery_codes: Option<Vec<String>>,
) -> ApiResult<(CookieJar, Json<SignedIn>)> {
    let (token, record) = session::create(
        state,
        user_id,
        meta.ip.clone(),
        meta.user_agent.clone(),
        true,
    )
    .await?;
    sqlx::query("UPDATE users SET last_login_at = ? WHERE id = ?")
        .bind(rustrmm_common::now())
        .bind(user_id)
        .execute(&state.db)
        .await?;
    let user = super::load_user(state, user_id)
        .await?
        .ok_or_else(ApiError::unauthenticated)?;
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
            .details(json!({ "method": method })),
        )
        .await;
    let me = build_me(state, &user, &record).await?;
    let jar = session::set_cookie(jar, token, state.args.session_max_hours);
    Ok((
        jar,
        Json(SignedIn {
            status: "ok",
            me,
            recovery_codes,
        }),
    ))
}

// ------------------------------------------------------------------ TOTP

#[derive(Deserialize)]
pub struct CodeRequest {
    challenge_token: String,
    code: String,
}

/// `POST /api/v1/auth/mfa/totp`
#[utoipa::path(post, path = "/api/v1/auth/mfa/totp", tag = "Authentication", summary = "Mfa totp", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")), security(()))]
pub async fn mfa_totp(
    State(state): State<AppState>,
    meta: ClientMeta,
    jar: CookieJar,
    Json(req): Json<CodeRequest>,
) -> ApiResult<impl IntoResponse> {
    if !state.limiter.check("mfa", &rate_key(&meta), MFA_LIMIT) {
        return Err(ApiError::too_many_requests());
    }
    let challenge = take_challenge(&state, &req.challenge_token, &["mfa"]).await?;
    let user = super::load_user(&state, &challenge.user_id)
        .await?
        .ok_or_else(ApiError::unauthenticated)?;
    let secret_blob = user
        .totp_secret
        .clone()
        .ok_or_else(|| ApiError::bad_request("Authenticator app is not set up"))?;
    let secret = state
        .cipher
        .decrypt(&secret_blob, totp_aad(&user.id).as_bytes())?;
    let step = totp::verify(
        &secret,
        &req.code,
        Utc::now().timestamp() as u64,
        user.totp_last_step,
    )
    .ok_or_else(|| {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_code",
            "That code is not valid",
        )
    })?;
    sqlx::query("UPDATE users SET totp_last_step = ? WHERE id = ?")
        .bind(step as i64)
        .bind(&user.id)
        .execute(&state.db)
        .await?;
    delete_challenge(&state, &challenge.id).await?;
    finish_sign_in(&state, jar, &user.id, &meta, "totp", None).await
}

pub fn totp_aad(user_id: &str) -> String {
    format!("users/totp_secret/{user_id}")
}

/// `POST /api/v1/auth/mfa/recovery`
#[utoipa::path(post, path = "/api/v1/auth/mfa/recovery", tag = "Authentication", summary = "Mfa recovery", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")), security(()))]
pub async fn mfa_recovery(
    State(state): State<AppState>,
    meta: ClientMeta,
    jar: CookieJar,
    Json(req): Json<CodeRequest>,
) -> ApiResult<impl IntoResponse> {
    if !state.limiter.check("mfa", &rate_key(&meta), MFA_LIMIT) {
        return Err(ApiError::too_many_requests());
    }
    let challenge = take_challenge(&state, &req.challenge_token, &["mfa"]).await?;
    let hash = recovery_hash(&state, &req.code);
    let result = sqlx::query("UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL")
        .bind(rustrmm_common::now())
        .bind(&challenge.user_id)
        .bind(&hash)
        .execute(&state.db)
        .await?;
    if result.rows_affected() != 1 {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_code",
            "That recovery code is not valid",
        ));
    }
    delete_challenge(&state, &challenge.id).await?;
    finish_sign_in(
        &state,
        jar,
        &challenge.user_id,
        &meta,
        "recovery_code",
        None,
    )
    .await
}

/// Normalises and peppers a recovery code.
pub fn recovery_hash(state: &AppState, code: &str) -> String {
    let normalised: String = code
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_uppercase();
    rustrmm_crypto::random::hmac_sha256_hex(state.keys.pepper.as_slice(), normalised.as_bytes())
}

/// Replaces a user's recovery codes with 10 fresh ones and returns them (shown once).
pub async fn regenerate_recovery_codes(state: &AppState, user_id: &str) -> ApiResult<Vec<String>> {
    let codes: Vec<String> = (0..10)
        .map(|_| rustrmm_crypto::random::grouped_code(2, 5))
        .collect();
    let mut tx = state.db.begin().await?;
    sqlx::query("DELETE FROM recovery_codes WHERE user_id = ?")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    let now = rustrmm_common::now();
    for code in &codes {
        sqlx::query(
            "INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind(rustrmm_common::new_id())
        .bind(user_id)
        .bind(recovery_hash(state, code))
        .bind(now)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(codes)
}

// ------------------------------------------------------------------ TOTP enrollment

#[derive(Deserialize)]
pub struct ChallengeOnly {
    challenge_token: String,
}

#[derive(Serialize)]
pub struct TotpSetup {
    secret: String,
    otpauth_url: String,
    qr_svg: String,
}

/// `POST /api/v1/auth/mfa/setup/totp/start`
#[utoipa::path(post, path = "/api/v1/auth/mfa/setup/totp/start", tag = "Authentication", summary = "Totp setup start", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")), security(()))]
pub async fn totp_setup_start(
    State(state): State<AppState>,
    meta: ClientMeta,
    Json(req): Json<ChallengeOnly>,
) -> ApiResult<Json<TotpSetup>> {
    if !state.limiter.check("mfa", &rate_key(&meta), MFA_LIMIT) {
        return Err(ApiError::too_many_requests());
    }
    let challenge = take_challenge(&state, &req.challenge_token, &["mfa_setup"]).await?;
    let user = super::load_user(&state, &challenge.user_id)
        .await?
        .ok_or_else(ApiError::unauthenticated)?;
    let secret = totp::generate_secret();
    let secret_b32 = totp::to_base32(&secret);
    // Re-store the pending secret on the same challenge token.
    let payload = json!({ "pending_secret": secret_b32 });
    let blob = state.cipher.encrypt(
        serde_json::to_string(&payload)?.as_bytes(),
        challenge_aad(&challenge.id).as_bytes(),
    );
    sqlx::query("UPDATE auth_challenges SET state = ?, attempts = 0 WHERE id = ?")
        .bind(blob)
        .bind(&challenge.id)
        .execute(&state.db)
        .await?;
    let org = crate::setup::organization_name(&state)
        .await
        .unwrap_or_else(|| "RustRMM".into());
    let issuer = format!("RustRMM ({org})");
    let otpauth_url = totp::otpauth_url(&issuer, &user.email, &secret_b32);
    let qr_svg = totp::qr_svg(&otpauth_url)?;
    Ok(Json(TotpSetup {
        secret: secret_b32,
        otpauth_url,
        qr_svg,
    }))
}

/// `POST /api/v1/auth/mfa/setup/totp/finish`
#[utoipa::path(post, path = "/api/v1/auth/mfa/setup/totp/finish", tag = "Authentication", summary = "Totp setup finish", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")), security(()))]
pub async fn totp_setup_finish(
    State(state): State<AppState>,
    meta: ClientMeta,
    jar: CookieJar,
    Json(req): Json<CodeRequest>,
) -> ApiResult<impl IntoResponse> {
    if !state.limiter.check("mfa", &rate_key(&meta), MFA_LIMIT) {
        return Err(ApiError::too_many_requests());
    }
    let challenge = take_challenge(&state, &req.challenge_token, &["mfa_setup"]).await?;
    let pending: Value = challenge_json(&challenge)?;
    let secret_b32 = pending["pending_secret"]
        .as_str()
        .ok_or_else(|| ApiError::bad_request("Start TOTP setup first"))?;
    let secret = data_encoding::BASE32_NOPAD
        .decode(secret_b32.as_bytes())
        .map_err(|_| ApiError::internal("stored TOTP secret is corrupt"))?;
    let step =
        totp::verify(&secret, &req.code, Utc::now().timestamp() as u64, None).ok_or_else(|| {
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                "invalid_code",
                "That code is not valid",
            )
        })?;
    let user_id = challenge.user_id.clone();
    let blob = state.cipher.encrypt(&secret, totp_aad(&user_id).as_bytes());
    sqlx::query("UPDATE users SET totp_secret = ?, totp_enabled_at = ?, totp_last_step = ?, updated_at = ? WHERE id = ?")
        .bind(blob)
        .bind(rustrmm_common::now())
        .bind(step as i64)
        .bind(rustrmm_common::now())
        .bind(&user_id)
        .execute(&state.db)
        .await?;
    delete_challenge(&state, &challenge.id).await?;
    let codes = regenerate_recovery_codes(&state, &user_id).await?;
    if let Some(user) = super::load_user(&state, &user_id).await? {
        state
            .audit
            .record_or_log(
                &state.db,
                AuditEntry::new(
                    Actor::User {
                        id: user.id.clone(),
                        name: user.name.clone(),
                    },
                    "auth.mfa_enrolled",
                )
                .request(meta.ip.clone(), meta.user_agent.clone())
                .details(json!({ "method": "totp" })),
            )
            .await;
    }
    finish_sign_in(&state, jar, &user_id, &meta, "totp_enrollment", Some(codes)).await
}

// ------------------------------------------------------------------ passkeys as second factor

#[derive(Serialize)]
pub struct OptionsResponse {
    options: Value,
}

/// `POST /api/v1/auth/mfa/webauthn/start`
#[utoipa::path(post, path = "/api/v1/auth/mfa/webauthn/start", tag = "Authentication", summary = "Mfa webauthn start", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")), security(()))]
pub async fn mfa_webauthn_start(
    State(state): State<AppState>,
    meta: ClientMeta,
    Json(req): Json<ChallengeOnly>,
) -> ApiResult<Json<OptionsResponse>> {
    if !state.limiter.check("mfa", &rate_key(&meta), MFA_LIMIT) {
        return Err(ApiError::too_many_requests());
    }
    let challenge = take_challenge(&state, &req.challenge_token, &["mfa"]).await?;
    let stored = webauthn::load_passkeys(&state, &challenge.user_id).await?;
    if stored.is_empty() {
        return Err(ApiError::bad_request("No passkeys registered"));
    }
    let passkeys: Vec<_> = stored.iter().map(|s| s.passkey.clone()).collect();
    let (options, auth_state) = state
        .webauthn
        .start_passkey_authentication(&passkeys)
        .map_err(|e| ApiError::internal(format!("webauthn start failed: {e}")))?;
    let payload = json!({ "webauthn": serde_json::to_value(&auth_state)? });
    let blob = state.cipher.encrypt(
        serde_json::to_string(&payload)?.as_bytes(),
        challenge_aad(&challenge.id).as_bytes(),
    );
    sqlx::query("UPDATE auth_challenges SET state = ? WHERE id = ?")
        .bind(blob)
        .bind(&challenge.id)
        .execute(&state.db)
        .await?;
    Ok(Json(OptionsResponse {
        options: serde_json::to_value(options)?,
    }))
}

#[derive(Deserialize)]
pub struct WebauthnFinish {
    challenge_token: String,
    credential: PublicKeyCredential,
}

/// `POST /api/v1/auth/mfa/webauthn/finish`
#[utoipa::path(post, path = "/api/v1/auth/mfa/webauthn/finish", tag = "Authentication", summary = "Mfa webauthn finish", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")), security(()))]
pub async fn mfa_webauthn_finish(
    State(state): State<AppState>,
    meta: ClientMeta,
    jar: CookieJar,
    Json(req): Json<WebauthnFinish>,
) -> ApiResult<impl IntoResponse> {
    if !state.limiter.check("mfa", &rate_key(&meta), MFA_LIMIT) {
        return Err(ApiError::too_many_requests());
    }
    let challenge = take_challenge(&state, &req.challenge_token, &["mfa"]).await?;
    let payload: Value = challenge_json(&challenge)?;
    let auth_state: PasskeyAuthentication = serde_json::from_value(payload["webauthn"].clone())
        .map_err(|_| ApiError::bad_request("Start passkey sign-in first"))?;
    let result = state
        .webauthn
        .finish_passkey_authentication(&req.credential, &auth_state)
        .map_err(|_| {
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                "invalid_passkey",
                "Passkey verification failed",
            )
        })?;
    for mut stored in webauthn::load_passkeys(&state, &challenge.user_id).await? {
        if stored.passkey.update_credential(&result).is_some() {
            webauthn::update_passkey(&state, &stored).await?;
            stored.passkey = stored.passkey.clone();
        }
    }
    delete_challenge(&state, &challenge.id).await?;
    finish_sign_in(&state, jar, &challenge.user_id, &meta, "webauthn", None).await
}

/// `POST /api/v1/auth/logout`
#[utoipa::path(post, path = "/api/v1/auth/logout", tag = "Authentication", summary = "Logout", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")), security(()))]
pub async fn logout(State(state): State<AppState>, jar: CookieJar) -> ApiResult<impl IntoResponse> {
    if let Some(cookie) = jar.get(session::COOKIE_NAME) {
        let token = cookie.value().to_string();
        if let Some(record) = session::lookup(&state, &token).await? {
            session::revoke(&state.db, &record.id).await?;
            if let Some(user) = super::load_user(&state, &record.user_id).await? {
                state
                    .audit
                    .record_or_log(
                        &state.db,
                        AuditEntry::new(
                            Actor::User {
                                id: user.id,
                                name: user.name,
                            },
                            "auth.logout",
                        ),
                    )
                    .await;
            }
        }
    }
    Ok((session::clear_cookie(jar), StatusCode::NO_CONTENT))
}
