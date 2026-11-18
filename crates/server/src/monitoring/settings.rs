//! Monitoring settings (`settings` key `monitoring`) and SMTP settings (`settings` key `smtp`,
//! password field-encrypted).

use axum::Json;
use axum::extract::State;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::auth::AuthCtx;
use crate::error::{ApiError, ApiResult};
use crate::rbac::perm;
use crate::state::AppState;

pub const KEY: &str = "monitoring";
pub const SMTP_KEY: &str = "smtp";
const SMTP_PASSWORD_AAD: &str = "settings/smtp/password";
pub const SECRET_PLACEHOLDER: &str = "••••••";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MonitoringSettings {
    pub default_offline_minutes: i64,
    pub unknown_threshold: i64,
    pub retention_days: i64,
    /// Host names, IP addresses or CIDR ranges that outbound webhooks may reach even though
    /// they resolve to private, loopback or link-local addresses (and may use plain http).
    pub webhook_allowlist: Vec<String>,
}

impl Default for MonitoringSettings {
    fn default() -> Self {
        Self {
            default_offline_minutes: 15,
            unknown_threshold: 3,
            retention_days: 180,
            webhook_allowlist: Vec::new(),
        }
    }
}

impl MonitoringSettings {
    pub fn validate(&mut self) -> Result<(), String> {
        if !(0..=10_080).contains(&self.default_offline_minutes) {
            return Err("default_offline_minutes must be between 0 and 10080".into());
        }
        if !(1..=100).contains(&self.unknown_threshold) {
            return Err("unknown_threshold must be between 1 and 100".into());
        }
        if !(7..=3650).contains(&self.retention_days) {
            return Err("retention_days must be between 7 and 3650".into());
        }
        if self.webhook_allowlist.len() > 100 {
            return Err("webhook_allowlist holds at most 100 entries".into());
        }
        let mut cleaned = Vec::new();
        for entry in &self.webhook_allowlist {
            let entry = entry.trim().to_ascii_lowercase();
            if entry.is_empty() {
                continue;
            }
            if super::notify::ssrf::AllowEntry::parse(&entry).is_none() {
                return Err(format!(
                    "webhook_allowlist entry '{entry}' is not a host name, IP address or CIDR range"
                ));
            }
            if !cleaned.contains(&entry) {
                cleaned.push(entry);
            }
        }
        self.webhook_allowlist = cleaned;
        Ok(())
    }
}

pub async fn load(state: &AppState) -> anyhow::Result<MonitoringSettings> {
    Ok(crate::db::get_setting(&state.db, KEY)
        .await?
        .unwrap_or_default())
}

/// `GET /api/v1/settings/monitoring`
pub async fn get(
    State(state): State<AppState>,
    ctx: AuthCtx,
) -> ApiResult<Json<MonitoringSettings>> {
    ctx.require(perm::SETTINGS_VIEW)?;
    Ok(Json(load(&state).await?))
}

/// `PUT /api/v1/settings/monitoring`
pub async fn put(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(mut req): Json<MonitoringSettings>,
) -> ApiResult<Json<MonitoringSettings>> {
    ctx.require_global(perm::MONITORS_MANAGE)?;
    req.validate().map_err(ApiError::validation)?;
    let before = load(&state).await?;
    crate::db::set_setting(&state.db, KEY, &req).await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("settings.monitoring_updated")
                .details(json!({ "before": before, "after": req })),
        )
        .await;
    if before.unknown_threshold != req.unknown_threshold {
        crate::automation::policies::push_settings_soon(&state);
    }
    Ok(Json(req))
}

// ------------------------------------------------------------------ SMTP

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SmtpSettings {
    pub host: String,
    pub port: u16,
    /// `starttls` | `tls` | `none`
    pub security: String,
    pub username: String,
    /// base64 of the field-encrypted password.
    #[serde(default)]
    pub password_enc: Option<String>,
    pub from_address: String,
    pub from_name: String,
}

impl SmtpSettings {
    pub fn password(&self, state: &AppState) -> anyhow::Result<Option<String>> {
        let Some(enc) = &self.password_enc else {
            return Ok(None);
        };
        let blob = STANDARD.decode(enc)?;
        Ok(Some(
            state
                .cipher
                .decrypt_string(&blob, SMTP_PASSWORD_AAD)?
                .to_string(),
        ))
    }

    pub fn configured(&self) -> bool {
        !self.host.is_empty() && !self.from_address.is_empty()
    }

    fn public(&self) -> Value {
        json!({
            "host": self.host, "port": self.port, "security": self.security, "username": self.username,
            "password": self.password_enc.as_ref().map(|_| SECRET_PLACEHOLDER),
            "from_address": self.from_address, "from_name": self.from_name,
        })
    }
}

pub async fn load_smtp(state: &AppState) -> anyhow::Result<SmtpSettings> {
    let mut smtp: SmtpSettings = crate::db::get_setting(&state.db, SMTP_KEY)
        .await?
        .unwrap_or_default();
    if smtp.port == 0 {
        smtp.port = 587;
    }
    if smtp.security.is_empty() {
        smtp.security = "starttls".into();
    }
    Ok(smtp)
}

/// `GET /api/v1/settings/smtp`
pub async fn get_smtp(State(state): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<Value>> {
    ctx.require_global(perm::NOTIFICATIONS_MANAGE)?;
    Ok(Json(load_smtp(&state).await?.public()))
}

#[derive(Deserialize)]
pub struct SmtpBody {
    #[serde(default)]
    host: String,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    security: Option<String>,
    #[serde(default)]
    username: String,
    /// Omitted (or the placeholder) keeps the stored password; `null` or "" clears it.
    #[serde(default, deserialize_with = "double_option")]
    password: Option<Option<String>>,
    #[serde(default)]
    from_address: String,
    #[serde(default)]
    from_name: String,
}

fn double_option<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<Option<String>>, D::Error> {
    Ok(Some(Option::<String>::deserialize(d)?))
}

fn valid_address(address: &str) -> bool {
    let address = address.trim();
    let Some((local, domain)) = address.rsplit_once('@') else {
        return false;
    };
    !local.is_empty()
        && domain.contains('.')
        && address.len() <= 254
        && !address.chars().any(|c| {
            c.is_whitespace() || c.is_control() || matches!(c, '<' | '>' | ',' | ';' | '"')
        })
}

pub fn valid_email(address: &str) -> bool {
    valid_address(address)
}

/// `PUT /api/v1/settings/smtp` (step-up)
pub async fn put_smtp(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(body): Json<SmtpBody>,
) -> ApiResult<Json<Value>> {
    ctx.require_global(perm::NOTIFICATIONS_MANAGE)?;
    ctx.require_step_up()?;
    let mut smtp = load_smtp(&state).await?;
    let host = body.host.trim().to_string();
    if !host.is_empty() && (host.len() > 253 || host.chars().any(|c| c.is_whitespace() || c == '/'))
    {
        return Err(ApiError::validation("host is not a valid host name"));
    }
    let security = body.security.unwrap_or_else(|| "starttls".into());
    if !matches!(security.as_str(), "starttls" | "tls" | "none") {
        return Err(ApiError::validation(
            "security must be starttls, tls or none",
        ));
    }
    let port = body
        .port
        .unwrap_or(if security == "tls" { 465 } else { 587 });
    if port == 0 {
        return Err(ApiError::validation("port must be between 1 and 65535"));
    }
    let from_address = body.from_address.trim().to_string();
    if !from_address.is_empty() && !valid_address(&from_address) {
        return Err(ApiError::validation(
            "from_address is not a valid e-mail address",
        ));
    }
    if body.from_name.chars().count() > 120 || body.from_name.contains(['\r', '\n']) {
        return Err(ApiError::validation(
            "from_name must be at most 120 characters",
        ));
    }
    if body.username.len() > 256 || body.username.contains(['\r', '\n']) {
        return Err(ApiError::validation("username is too long"));
    }
    smtp.host = host;
    smtp.port = port;
    smtp.security = security;
    smtp.username = body.username.trim().to_string();
    smtp.from_address = from_address;
    smtp.from_name = body.from_name.trim().to_string();
    let password_changed = match body.password {
        None => false,
        Some(Some(p)) if p == SECRET_PLACEHOLDER => false,
        Some(None) => {
            smtp.password_enc = None;
            true
        }
        Some(Some(p)) if p.is_empty() => {
            smtp.password_enc = None;
            true
        }
        Some(Some(p)) => {
            if p.len() > 1024 || p.contains(['\r', '\n']) {
                return Err(ApiError::validation("password is too long"));
            }
            smtp.password_enc =
                Some(STANDARD.encode(state.cipher.encrypt_str(&p, SMTP_PASSWORD_AAD)));
            true
        }
    };
    crate::db::set_setting(&state.db, SMTP_KEY, &smtp).await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("notifications.smtp_updated").details(json!({
                "host": smtp.host, "port": smtp.port, "security": smtp.security, "username": smtp.username,
                "from_address": smtp.from_address, "password_changed": password_changed,
            })),
        )
        .await;
    Ok(Json(smtp.public()))
}

#[derive(Deserialize)]
pub struct SmtpTestBody {
    to: String,
}

/// `POST /api/v1/settings/smtp/test`
pub async fn test_smtp(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(body): Json<SmtpTestBody>,
) -> ApiResult<Json<Value>> {
    ctx.require_global(perm::NOTIFICATIONS_MANAGE)?;
    let to = body.to.trim().to_string();
    if !valid_address(&to) {
        return Err(ApiError::validation("to is not a valid e-mail address"));
    }
    let smtp = load_smtp(&state).await?;
    if !smtp.configured() {
        return Err(ApiError::conflict(
            "smtp_not_configured",
            "Configure the SMTP server first",
        ));
    }
    let password = smtp.password(&state)?;
    let message = super::notify::smtp::Email {
        to: vec![to.clone()],
        cc: Vec::new(),
        subject: "RustRMM test message".into(),
        text: "This is a test message from RustRMM. E-mail notifications are working.".into(),
        html: "<p>This is a test message from <strong>RustRMM</strong>. E-mail notifications are working.</p>".into(),
        ..Default::default()
    };
    let outcome = super::notify::smtp::send(&smtp, password.as_deref(), &message).await;
    let (ok, error) = match &outcome {
        Ok(()) => (true, None),
        Err(e) => (false, Some(format!("{e:#}"))),
    };
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("notifications.smtp_tested")
                .details(json!({ "to": to, "ok": ok, "error": error })),
        )
        .await;
    Ok(Json(json!({ "ok": ok, "error": error })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_validation_cleans_the_allowlist() {
        let mut s = MonitoringSettings {
            webhook_allowlist: vec![
                " 127.0.0.1 ".into(),
                "Hooks.Internal".into(),
                "10.0.0.0/8".into(),
                "".into(),
            ],
            ..MonitoringSettings::default()
        };
        s.validate().expect("valid");
        assert_eq!(
            s.webhook_allowlist,
            vec!["127.0.0.1", "hooks.internal", "10.0.0.0/8"]
        );
        let mut bad = MonitoringSettings {
            webhook_allowlist: vec!["http://x".into()],
            ..MonitoringSettings::default()
        };
        assert!(bad.validate().is_err());
        let mut bad = MonitoringSettings {
            unknown_threshold: 0,
            ..MonitoringSettings::default()
        };
        assert!(bad.validate().is_err());
        assert!(valid_email("ops@example.com"));
        assert!(!valid_email("ops@example"));
        assert!(!valid_email("a b@example.com"));
        assert!(!valid_email("x@example.com\r\nBcc: y@evil.test"));
    }
}
