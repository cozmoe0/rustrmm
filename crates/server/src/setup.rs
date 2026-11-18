//! First-run setup.
//!
//! While no user exists the server prints a one-time setup token to its console/logs; the setup
//! wizard must present it, so nobody else on the network can race to claim a fresh install.
//! Completing setup creates the owner, the first client and site, and the backup key pair whose
//! private half is returned once in the recovery kit and never stored.

use std::sync::Mutex;
use std::time::Duration;

use age::secrecy::ExposeSecret;
use axum::Json;
use axum::extract::State;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::audit::{Actor, AuditEntry};
use crate::auth::{ClientMeta, password};
use crate::backup::BackupSettings;
use crate::db::{self, Db};
use crate::error::{ApiError, ApiResult};
use crate::ratelimit::Limit;
use crate::rbac::OWNER_ROLE_ID;
use crate::state::AppState;

const ORG_SETTING: &str = "organization";

#[derive(Serialize, Deserialize)]
struct OrganizationSetting {
    name: String,
}

pub struct SetupGate {
    token: Mutex<Option<String>>,
}

impl SetupGate {
    pub fn new(token: Option<String>) -> Self {
        Self {
            token: Mutex::new(token),
        }
    }

    pub fn is_open(&self) -> bool {
        self.token.lock().map(|t| t.is_some()).unwrap_or(false)
    }

    pub fn check(&self, candidate: &str) -> bool {
        let normalise = |s: &str| s.trim().to_ascii_uppercase().replace(' ', "");
        match self.token.lock() {
            Ok(guard) => guard.as_deref().is_some_and(|t| {
                rustrmm_crypto::random::ct_eq(
                    normalise(t).as_bytes(),
                    normalise(candidate).as_bytes(),
                )
            }),
            Err(_) => false,
        }
    }

    /// The current token (also printed to the console). Used by in-process tests and tooling.
    pub fn current_token(&self) -> Option<String> {
        self.token.lock().ok().and_then(|t| t.clone())
    }

    pub fn close(&self) {
        if let Ok(mut guard) = self.token.lock() {
            *guard = None;
        }
    }
}

pub async fn user_count(db: &Db) -> anyhow::Result<i64> {
    Ok(sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(db)
        .await?)
}

/// Generates a setup token when the installation has no users, printing it prominently.
pub async fn prepare_gate(db: &Db) -> anyhow::Result<SetupGate> {
    if user_count(db).await? > 0 {
        return Ok(SetupGate::new(None));
    }
    let token = rustrmm_crypto::random::grouped_code(4, 4);
    let banner = format!(
        "\n\n  ┌──────────────────────────────────────────────────────────┐\n  │  RustRMM first-run setup                                 │\n  │  Open the console and enter this one-time setup token:   │\n  │                                                          │\n  │      {token}                                 │\n  │                                                          │\n  └──────────────────────────────────────────────────────────┘\n"
    );
    eprintln!("{banner}");
    tracing::warn!(setup_token = %token, "installation is not set up yet; use the setup token shown above");
    Ok(SetupGate::new(Some(token)))
}

pub async fn organization_name(state: &AppState) -> Option<String> {
    db::get_setting::<OrganizationSetting>(&state.db, ORG_SETTING)
        .await
        .ok()
        .flatten()
        .map(|o| o.name)
}

#[derive(Serialize)]
pub struct SetupStatus {
    needs_setup: bool,
    product: &'static str,
    version: &'static str,
}

/// `GET /api/v1/setup/status`
pub async fn status(State(state): State<AppState>) -> ApiResult<Json<SetupStatus>> {
    let needs_setup = user_count(&state.db).await? == 0;
    Ok(Json(SetupStatus {
        needs_setup,
        product: rustrmm_common::PRODUCT_NAME,
        version: rustrmm_common::VERSION,
    }))
}

#[derive(Deserialize)]
pub struct OwnerInput {
    name: String,
    email: String,
    password: String,
}

#[derive(Deserialize)]
pub struct NameInput {
    name: String,
}

#[derive(Deserialize)]
pub struct SiteInput {
    name: String,
    #[serde(default)]
    timezone: Option<String>,
}

#[derive(Deserialize)]
pub struct CompleteRequest {
    setup_token: String,
    organization_name: String,
    owner: OwnerInput,
    first_client: NameInput,
    first_site: SiteInput,
}

#[derive(Serialize)]
pub struct RecoveryKit {
    master_key: String,
    backup_identity: String,
    backup_recipient: String,
    generated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Serialize)]
pub struct CompleteResponse {
    recovery_kit: RecoveryKit,
}

pub fn validate_name(label: &str, value: &str, max: usize) -> ApiResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().count() > max {
        return Err(ApiError::validation(format!(
            "{label} must be 1–{max} characters"
        )));
    }
    if trimmed.chars().any(char::is_control) {
        return Err(ApiError::validation(format!(
            "{label} contains invalid characters"
        )));
    }
    Ok(trimmed.to_string())
}

pub fn validate_email(value: &str) -> ApiResult<String> {
    let email = value.trim().to_lowercase();
    let valid = email.len() <= 254
        && email.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty() && domain.contains('.') && !domain.starts_with('.')
        })
        && !email.chars().any(|c| c.is_whitespace() || c.is_control());
    if valid {
        Ok(email)
    } else {
        Err(ApiError::validation("Enter a valid email address"))
    }
}

pub fn validate_timezone(value: Option<&str>) -> ApiResult<String> {
    let tz = value
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("UTC");
    if tz.len() > 64
        || !tz
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "/_+-".contains(c))
    {
        return Err(ApiError::validation("Invalid time zone"));
    }
    Ok(tz.to_string())
}

/// `POST /api/v1/setup/complete`
pub async fn complete(
    State(state): State<AppState>,
    meta: ClientMeta,
    Json(req): Json<CompleteRequest>,
) -> ApiResult<Json<CompleteResponse>> {
    let key = meta.ip.clone().unwrap_or_else(|| "unknown".into());
    if !state
        .limiter
        .check("setup", &key, Limit::per(10, Duration::from_secs(600)))
    {
        return Err(ApiError::too_many_requests());
    }
    if !state.setup.is_open() || user_count(&state.db).await? > 0 {
        return Err(ApiError::conflict(
            "already_set_up",
            "This installation is already set up",
        ));
    }
    if !state.setup.check(&req.setup_token) {
        return Err(ApiError::forbidden("The setup token is not correct")
            .with_details(json!({ "field": "setup_token" })));
    }

    let org_name = validate_name("Organization name", &req.organization_name, 80)?;
    let owner_name = validate_name("Name", &req.owner.name, 80)?;
    let email = validate_email(&req.owner.email)?;
    if let Some(reason) = password::policy_violation(&req.owner.password, &email, &owner_name) {
        return Err(ApiError::validation(reason));
    }
    let client_name = validate_name("Client name", &req.first_client.name, 80)?;
    let site_name = validate_name("Site name", &req.first_site.name, 80)?;
    let timezone = validate_timezone(req.first_site.timezone.as_deref())?;

    let pw = req.owner.password.clone();
    let password_hash = tokio::task::spawn_blocking(move || password::hash(&pw)).await??;

    let backup_identity = age::x25519::Identity::generate();
    let backup_recipient = backup_identity.to_public().to_string();

    let now = rustrmm_common::now();
    let user_id = rustrmm_common::new_id();
    let client_id = rustrmm_common::new_id();
    let site_id = rustrmm_common::new_id();
    let mut tx = state.db.begin().await?;
    let existing: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&mut *tx)
        .await?;
    if existing > 0 {
        return Err(ApiError::conflict(
            "already_set_up",
            "This installation is already set up",
        ));
    }
    sqlx::query(
        "INSERT INTO users (id, email, name, password_hash, status, password_changed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?)",
    )
    .bind(&user_id)
    .bind(&email)
    .bind(&owner_name)
    .bind(&password_hash)
    .bind(now)
    .bind(now)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO role_assignments (id, user_id, role_id, scope_type, scope_id, created_at) VALUES (?, ?, ?, 'global', NULL, ?)",
    )
    .bind(rustrmm_common::new_id())
    .bind(&user_id)
    .bind(OWNER_ROLE_ID)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO clients (id, name, slug, notes, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?)")
        .bind(&client_id)
        .bind(&client_name)
        .bind(rustrmm_common::slugify(&client_name))
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO sites (id, client_id, name, timezone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(&site_id)
        .bind(&client_id)
        .bind(&site_name)
        .bind(&timezone)
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    db::set_setting(
        &state.db,
        ORG_SETTING,
        &OrganizationSetting {
            name: org_name.clone(),
        },
    )
    .await?;
    db::set_setting(
        &state.db,
        crate::backup::SETTINGS_KEY,
        &BackupSettings::initial(backup_recipient.clone()),
    )
    .await?;
    state.backups.notify_settings_changed();
    state.setup.close();

    state
        .audit
        .record_or_log(
            &state.db,
            AuditEntry::new(Actor::User { id: user_id.clone(), name: owner_name.clone() }, "setup.completed")
                .request(meta.ip.clone(), meta.user_agent.clone())
                .details(json!({ "organization": org_name, "first_client": client_name, "first_site": site_name })),
        )
        .await;

    let secret = backup_identity.to_string();
    Ok(Json(CompleteResponse {
        recovery_kit: RecoveryKit {
            master_key: state.master.to_base64().to_string(),
            backup_identity: secret.expose_secret().to_string(),
            backup_recipient,
            generated_at: now,
        },
    }))
}
