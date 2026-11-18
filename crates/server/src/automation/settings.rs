//! Automation settings (`settings` key `automation`): mass-action guard, four-eyes, approval
//! requirement, output cap and default offline wait.

use axum::Json;
use axum::extract::State;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::auth::AuthCtx;
use crate::error::{ApiError, ApiResult};
use crate::rbac::perm;
use crate::state::AppState;

pub const KEY: &str = "automation";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AutomationSettings {
    pub mass_action_threshold: i64,
    pub four_eyes_jobs: bool,
    pub require_script_approval: bool,
    pub allow_self_approval: bool,
    pub max_output_kb: i64,
    pub default_offline_wait_minutes: i64,
}

impl Default for AutomationSettings {
    fn default() -> Self {
        Self {
            mass_action_threshold: 25,
            four_eyes_jobs: false,
            require_script_approval: false,
            allow_self_approval: false,
            max_output_kb: 256,
            default_offline_wait_minutes: 60,
        }
    }
}

impl AutomationSettings {
    pub fn validate(&self) -> Result<(), String> {
        if !(1..=100_000).contains(&self.mass_action_threshold) {
            return Err("mass_action_threshold must be between 1 and 100000".into());
        }
        if !(16..=4096).contains(&self.max_output_kb) {
            return Err("max_output_kb must be between 16 and 4096".into());
        }
        if !(0..=10_080).contains(&self.default_offline_wait_minutes) {
            return Err("default_offline_wait_minutes must be between 0 and 10080".into());
        }
        Ok(())
    }

    pub fn max_output_bytes(&self) -> u32 {
        (self.max_output_kb.clamp(16, 4096) * 1024) as u32
    }
}

pub async fn load(state: &AppState) -> anyhow::Result<AutomationSettings> {
    Ok(crate::db::get_setting(&state.db, KEY)
        .await?
        .unwrap_or_default())
}

/// `GET /api/v1/settings/automation`
pub async fn get(
    State(state): State<AppState>,
    ctx: AuthCtx,
) -> ApiResult<Json<AutomationSettings>> {
    ctx.require(perm::SETTINGS_VIEW)?;
    Ok(Json(load(&state).await?))
}

/// `PUT /api/v1/settings/automation` (step-up)
pub async fn put(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(req): Json<AutomationSettings>,
) -> ApiResult<Json<AutomationSettings>> {
    ctx.require_global(perm::SETTINGS_MANAGE)?;
    ctx.require_step_up()?;
    req.validate().map_err(ApiError::validation)?;
    let before = load(&state).await?;
    crate::db::set_setting(&state.db, KEY, &req).await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("settings.automation_updated")
                .details(json!({ "before": before, "after": req })),
        )
        .await;
    Ok(Json(req))
}
