//! The signed-in user's own account: profile, sessions, passkeys, password, recovery codes and
//! step-up re-authentication.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use webauthn_rs::prelude::{
    PasskeyAuthentication, PasskeyRegistration, PublicKeyCredential, RegisterPublicKeyCredential,
};

use super::handlers::{create_challenge, delete_challenge, regenerate_recovery_codes, totp_aad};
use super::session::{self, SessionRecord};
use super::{AuthCtx, UserRecord, password, totp, webauthn};
use crate::error::{ApiError, ApiResult};
use crate::rbac::ScopeSummary;
use crate::state::AppState;

const STEP_UP_MINUTES: i64 = 5;

#[derive(Serialize)]
pub struct MeUser {
    id: String,
    name: String,
    email: String,
    mfa: MfaSummary,
    created_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct MfaSummary {
    totp: bool,
    passkeys: i64,
}

#[derive(Serialize)]
pub struct MeSession {
    id: String,
    expires_at: DateTime<Utc>,
    idle_expires_at: DateTime<Utc>,
    stepped_up_until: Option<DateTime<Utc>>,
}

#[derive(Serialize)]
pub struct Organization {
    name: String,
}

#[derive(Serialize)]
pub struct MeResponse {
    user: MeUser,
    csrf_token: String,
    permissions: Vec<String>,
    scopes: ScopeSummary,
    organization: Organization,
    session: MeSession,
}

pub async fn build_me(
    state: &AppState,
    user: &UserRecord,
    session: &SessionRecord,
) -> ApiResult<MeResponse> {
    build_me_scoped(state, user, session, None).await
}

/// [`build_me`] with an explicit (for example token-restricted) scope.
pub async fn build_me_scoped(
    state: &AppState,
    user: &UserRecord,
    session: &SessionRecord,
    scope: Option<&crate::rbac::AccessScope>,
) -> ApiResult<MeResponse> {
    let scope = match scope {
        Some(s) => s.clone(),
        None => crate::rbac::AccessScope::load(&state.db, &user.id).await?,
    };
    let passkeys = webauthn::count_passkeys(&state.db, &user.id).await?;
    let org = crate::setup::organization_name(state)
        .await
        .unwrap_or_else(|| "RustRMM".into());
    Ok(MeResponse {
        user: MeUser {
            id: user.id.clone(),
            name: user.name.clone(),
            email: user.email.clone(),
            mfa: MfaSummary {
                totp: user.totp_enabled_at.is_some(),
                passkeys,
            },
            created_at: user.created_at,
        },
        csrf_token: session.csrf_token.clone(),
        permissions: scope.all_permissions().into_iter().collect(),
        scopes: scope.summary(),
        organization: Organization { name: org },
        session: MeSession {
            id: session.id.clone(),
            expires_at: session.expires_at,
            idle_expires_at: session.idle_expires_at,
            stepped_up_until: session.stepped_up_until,
        },
    })
}

/// `GET /api/v1/auth/me`
#[utoipa::path(get, path = "/api/v1/auth/me", tag = "My account", summary = "Me", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn me(State(state): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<MeResponse>> {
    let scope = ctx.is_token().then_some(&ctx.scope);
    Ok(Json(
        build_me_scoped(&state, &ctx.user, &ctx.session, scope).await?,
    ))
}

// ------------------------------------------------------------------ sessions

#[derive(Serialize, sqlx::FromRow)]
pub struct SessionItem {
    id: String,
    created_at: DateTime<Utc>,
    last_seen_at: DateTime<Utc>,
    ip: Option<String>,
    user_agent: Option<String>,
    #[sqlx(skip)]
    current: bool,
}

/// `GET /api/v1/me/sessions`
#[utoipa::path(get, path = "/api/v1/me/sessions", tag = "My account", summary = "List sessions", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list_sessions(State(state): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<Value>> {
    let now = rustrmm_common::now();
    let mut items: Vec<SessionItem> = sqlx::query_as(
        "SELECT id, created_at, last_seen_at, ip, user_agent FROM sessions
         WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? AND idle_expires_at > ?
         ORDER BY last_seen_at DESC",
    )
    .bind(&ctx.user.id)
    .bind(now)
    .bind(now)
    .fetch_all(&state.db)
    .await?;
    for item in &mut items {
        item.current = item.id == ctx.session.id;
    }
    Ok(Json(json!({ "items": items })))
}

/// `DELETE /api/v1/me/sessions/{id}`
#[utoipa::path(delete, path = "/api/v1/me/sessions/{id}", tag = "My account", summary = "Revoke session", params(("id" = String, Path)), responses((status = 204, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn revoke_session(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let owner: Option<String> = sqlx::query_scalar("SELECT user_id FROM sessions WHERE id = ?")
        .bind(&id)
        .fetch_optional(&state.db)
        .await?;
    if owner.as_deref() != Some(ctx.user.id.as_str()) {
        return Err(ApiError::not_found("Session"));
    }
    session::revoke(&state.db, &id).await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("session.revoked")
                .details(json!({ "session": &id[..12] })),
        )
        .await;
    Ok(StatusCode::NO_CONTENT)
}

// ------------------------------------------------------------------ password & recovery codes

#[derive(Deserialize)]
pub struct PasswordChange {
    current_password: String,
    new_password: String,
}

/// `POST /api/v1/me/password`
#[utoipa::path(post, path = "/api/v1/me/password", tag = "My account", summary = "Change password", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn change_password(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(req): Json<PasswordChange>,
) -> ApiResult<StatusCode> {
    let phc = ctx.user.password_hash.clone();
    let current = req.current_password.clone();
    if !tokio::task::spawn_blocking(move || password::verify(&current, &phc)).await? {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_credentials",
            "Current password is incorrect",
        ));
    }
    if let Some(reason) =
        password::policy_violation(&req.new_password, &ctx.user.email, &ctx.user.name)
    {
        return Err(ApiError::validation(reason));
    }
    let new = req.new_password.clone();
    let hash = tokio::task::spawn_blocking(move || password::hash(&new)).await??;
    let now = rustrmm_common::now();
    sqlx::query(
        "UPDATE users SET password_hash = ?, password_changed_at = ?, updated_at = ? WHERE id = ?",
    )
    .bind(hash)
    .bind(now)
    .bind(now)
    .bind(&ctx.user.id)
    .execute(&state.db)
    .await?;
    session::revoke_all_for_user(&state.db, &ctx.user.id, Some(&ctx.session.id)).await?;
    state
        .audit
        .record_or_log(&state.db, ctx.audit("auth.password_changed"))
        .await;
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /api/v1/me/recovery-codes` (step-up)
#[utoipa::path(post, path = "/api/v1/me/recovery-codes", tag = "My account", summary = "New recovery codes", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn new_recovery_codes(
    State(state): State<AppState>,
    ctx: AuthCtx,
) -> ApiResult<Json<Value>> {
    ctx.require_step_up()?;
    let codes = regenerate_recovery_codes(&state, &ctx.user.id).await?;
    state
        .audit
        .record_or_log(&state.db, ctx.audit("auth.recovery_codes_regenerated"))
        .await;
    Ok(Json(json!({ "recovery_codes": codes })))
}

// ------------------------------------------------------------------ step-up

#[derive(Deserialize)]
pub struct StepUpRequest {
    method: String,
    code: String,
}

/// `POST /api/v1/auth/step-up` (TOTP)
#[utoipa::path(post, path = "/api/v1/auth/step-up", tag = "My account", summary = "Step up", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn step_up(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(req): Json<StepUpRequest>,
) -> ApiResult<Json<Value>> {
    if req.method != "totp" {
        return Err(ApiError::bad_request("Unsupported step-up method"));
    }
    if !state.limiter.check(
        "step_up",
        &ctx.user.id,
        crate::ratelimit::Limit::per(10, std::time::Duration::from_secs(60)),
    ) {
        return Err(ApiError::too_many_requests());
    }
    let blob = ctx
        .user
        .totp_secret
        .clone()
        .ok_or_else(|| ApiError::bad_request("Authenticator app is not set up"))?;
    let secret = state
        .cipher
        .decrypt(&blob, totp_aad(&ctx.user.id).as_bytes())?;
    let step = totp::verify(
        &secret,
        &req.code,
        Utc::now().timestamp() as u64,
        ctx.user.totp_last_step,
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
        .bind(&ctx.user.id)
        .execute(&state.db)
        .await?;
    let until = session::mark_stepped_up(&state.db, &ctx.session.id, STEP_UP_MINUTES).await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("auth.step_up")
                .details(json!({ "method": "totp" })),
        )
        .await;
    Ok(Json(json!({ "stepped_up_until": until })))
}

/// `POST /api/v1/auth/step-up/webauthn/start`
#[utoipa::path(post, path = "/api/v1/auth/step-up/webauthn/start", tag = "My account", summary = "Step up webauthn start", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn step_up_webauthn_start(
    State(state): State<AppState>,
    ctx: AuthCtx,
) -> ApiResult<Json<Value>> {
    let stored = webauthn::load_passkeys(&state, &ctx.user.id).await?;
    if stored.is_empty() {
        return Err(ApiError::bad_request("No passkeys registered"));
    }
    let passkeys: Vec<_> = stored.into_iter().map(|s| s.passkey).collect();
    let (options, auth_state) = state
        .webauthn
        .start_passkey_authentication(&passkeys)
        .map_err(|e| ApiError::internal(format!("webauthn start failed: {e}")))?;
    let payload = json!({ "webauthn": serde_json::to_value(&auth_state)? });
    create_challenge(
        &state,
        &ctx.user.id,
        "step_up_webauthn",
        Some(&payload),
        Some(&ctx.session.id),
    )
    .await?;
    Ok(Json(json!({ "options": options })))
}

#[derive(Deserialize)]
pub struct StepUpWebauthnFinish {
    credential: PublicKeyCredential,
}

/// `POST /api/v1/auth/step-up/webauthn/finish`
#[utoipa::path(post, path = "/api/v1/auth/step-up/webauthn/finish", tag = "My account", summary = "Step up webauthn finish", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn step_up_webauthn_finish(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(req): Json<StepUpWebauthnFinish>,
) -> ApiResult<Json<Value>> {
    let challenge = latest_challenge(&state, &ctx.user.id, "step_up_webauthn").await?;
    if challenge.session_id.as_deref() != Some(ctx.session.id.as_str()) {
        return Err(ApiError::bad_request("Start passkey confirmation first"));
    }
    let payload: Value = serde_json::from_slice(challenge.state.as_deref().unwrap_or(b"{}"))?;
    let auth_state: PasskeyAuthentication = serde_json::from_value(payload["webauthn"].clone())
        .map_err(|_| ApiError::bad_request("Start passkey confirmation first"))?;
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
    for mut stored in webauthn::load_passkeys(&state, &ctx.user.id).await? {
        if stored.passkey.update_credential(&result).is_some() {
            webauthn::update_passkey(&state, &stored).await?;
        }
    }
    delete_challenge(&state, &challenge.id).await?;
    let until = session::mark_stepped_up(&state.db, &ctx.session.id, STEP_UP_MINUTES).await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("auth.step_up")
                .details(json!({ "method": "webauthn" })),
        )
        .await;
    Ok(Json(json!({ "stepped_up_until": until })))
}

/// `(id, state, session_id, attempts)` of a challenge row.
type ChallengeLookup = (String, Option<Vec<u8>>, Option<String>, i64);

/// Finds the live challenge of `kind` for a user (used by session-bound ceremonies).
async fn latest_challenge(
    state: &AppState,
    user_id: &str,
    kind: &str,
) -> ApiResult<super::handlers::Challenge> {
    // Challenges are keyed by token hash; session-bound ceremonies don't round-trip the token, so
    // look the row up by user + kind and reuse take_challenge's validation via its id.
    let row: Option<ChallengeLookup> = sqlx::query_as(
        "SELECT id, state, session_id, attempts FROM auth_challenges WHERE user_id = ? AND kind = ? AND expires_at > ?",
    )
    .bind(user_id)
    .bind(kind)
    .bind(rustrmm_common::now())
    .fetch_optional(&state.db)
    .await?;
    let Some((id, blob, session_id, attempts)) = row else {
        return Err(ApiError::bad_request(
            "No ceremony in progress; start again",
        ));
    };
    if attempts >= 5 {
        delete_challenge(state, &id).await?;
        return Err(ApiError::bad_request("Too many attempts; start again"));
    }
    sqlx::query("UPDATE auth_challenges SET attempts = attempts + 1 WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    let decrypted = match blob {
        Some(b) => Some(
            state
                .cipher
                .decrypt(&b, format!("auth_challenges/state/{id}").as_bytes())?
                .to_vec(),
        ),
        None => None,
    };
    Ok(super::handlers::Challenge {
        id,
        user_id: user_id.to_string(),
        kind: kind.to_string(),
        state: decrypted,
        session_id,
    })
}

// ------------------------------------------------------------------ passkey management

#[derive(Serialize, sqlx::FromRow)]
pub struct PasskeyItem {
    id: String,
    name: String,
    created_at: DateTime<Utc>,
    last_used_at: Option<DateTime<Utc>>,
}

/// `GET /api/v1/me/passkeys`
#[utoipa::path(get, path = "/api/v1/me/passkeys", tag = "My account", summary = "List passkeys", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list_passkeys(State(state): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<Value>> {
    let items: Vec<PasskeyItem> = sqlx::query_as(
        "SELECT id, name, created_at, last_used_at FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at",
    )
    .bind(&ctx.user.id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({ "items": items })))
}

/// `POST /api/v1/me/passkeys/register/start`
#[utoipa::path(post, path = "/api/v1/me/passkeys/register/start", tag = "My account", summary = "Passkey register start", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn passkey_register_start(
    State(state): State<AppState>,
    ctx: AuthCtx,
) -> ApiResult<Json<Value>> {
    let existing = webauthn::load_passkeys(&state, &ctx.user.id).await?;
    let exclude: Vec<_> = existing
        .iter()
        .map(|s| s.passkey.cred_id().clone())
        .collect();
    let user_uuid = uuid::Uuid::parse_str(&ctx.user.id).map_err(ApiError::internal)?;
    let (options, reg_state) = state
        .webauthn
        .start_passkey_registration(user_uuid, &ctx.user.email, &ctx.user.name, Some(exclude))
        .map_err(|e| ApiError::internal(format!("webauthn registration start failed: {e}")))?;
    let payload = json!({ "webauthn": serde_json::to_value(&reg_state)? });
    create_challenge(
        &state,
        &ctx.user.id,
        "webauthn_register",
        Some(&payload),
        Some(&ctx.session.id),
    )
    .await?;
    Ok(Json(json!({ "options": options })))
}

#[derive(Deserialize)]
pub struct PasskeyRegisterFinish {
    name: String,
    credential: RegisterPublicKeyCredential,
}

/// `POST /api/v1/me/passkeys/register/finish`
#[utoipa::path(post, path = "/api/v1/me/passkeys/register/finish", tag = "My account", summary = "Passkey register finish", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn passkey_register_finish(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(req): Json<PasskeyRegisterFinish>,
) -> ApiResult<Json<PasskeyItem>> {
    let name = req.name.trim();
    if name.is_empty() || name.len() > 64 {
        return Err(ApiError::validation("Passkey name must be 1–64 characters"));
    }
    let challenge = latest_challenge(&state, &ctx.user.id, "webauthn_register").await?;
    if challenge.session_id.as_deref() != Some(ctx.session.id.as_str()) {
        return Err(ApiError::bad_request("Start passkey registration first"));
    }
    let payload: Value = serde_json::from_slice(challenge.state.as_deref().unwrap_or(b"{}"))?;
    let reg_state: PasskeyRegistration = serde_json::from_value(payload["webauthn"].clone())
        .map_err(|_| ApiError::bad_request("Start passkey registration first"))?;
    let passkey = state
        .webauthn
        .finish_passkey_registration(&req.credential, &reg_state)
        .map_err(|e| ApiError::validation(format!("Passkey registration failed: {e}")))?;
    let id = webauthn::insert_passkey(&state, &ctx.user.id, name, &passkey).await?;
    delete_challenge(&state, &challenge.id).await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("auth.passkey_added")
                .details(json!({ "name": name })),
        )
        .await;
    Ok(Json(PasskeyItem {
        id,
        name: name.to_string(),
        created_at: rustrmm_common::now(),
        last_used_at: None,
    }))
}

/// `DELETE /api/v1/me/passkeys/{id}`
#[utoipa::path(delete, path = "/api/v1/me/passkeys/{id}", tag = "My account", summary = "Delete passkey", params(("id" = String, Path)), responses((status = 204, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn delete_passkey(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let has_totp = ctx.user.totp_enabled_at.is_some();
    let count = webauthn::count_passkeys(&state.db, &ctx.user.id).await?;
    if !has_totp && count <= 1 {
        return Err(ApiError::conflict(
            "last_factor",
            "You cannot remove your only sign-in factor",
        ));
    }
    let result = sqlx::query("DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?")
        .bind(&id)
        .bind(&ctx.user.id)
        .execute(&state.db)
        .await?;
    if result.rows_affected() == 0 {
        return Err(ApiError::not_found("Passkey"));
    }
    state
        .audit
        .record_or_log(&state.db, ctx.audit("auth.passkey_removed"))
        .await;
    Ok(StatusCode::NO_CONTENT)
}
