//! Agent enrollment (`POST /agent/v1/enroll`) and deploy-key construction.

use std::net::IpAddr;
use std::time::Duration;

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use rustrmm_crypto::sign::PublicKey;
use rustrmm_proto::deploy::{DeployKey, EnrollRequest, EnrollResponse};
use serde_json::json;
use sqlx::FromRow;

use crate::audit::{Actor, AuditEntry};
use crate::auth::ClientMeta;
use crate::error::{ApiError, ApiResult};
use crate::ratelimit::Limit;
use crate::state::AppState;

#[derive(Debug, Clone, FromRow)]
pub struct TokenRow {
    pub id: String,
    pub site_id: String,
    pub name: String,
    pub secret: Vec<u8>,
    pub expires_at: Option<chrono::DateTime<chrono::Utc>>,
    pub max_uses: Option<i64>,
    pub uses: i64,
    pub require_approval: bool,
    pub allowed_domains: String,
    pub allowed_cidrs: String,
    pub revoked_at: Option<chrono::DateTime<chrono::Utc>>,
}

pub const TOKEN_COLUMNS: &str =
    "id, site_id, name, secret, expires_at, max_uses, uses, require_approval, allowed_domains,
    allowed_cidrs, revoked_at";

pub fn secret_aad(token_id: &str) -> String {
    format!("enrollment_tokens/secret/{token_id}")
}

/// Builds the deploy key for a token.
pub async fn deploy_key(state: &AppState, token: &TokenRow) -> ApiResult<String> {
    let secret = state
        .cipher
        .decrypt_string(&token.secret, &secret_aad(&token.id))?;
    let label: Option<(String, String)> = sqlx::query_as(
        "SELECT c.name, s.name FROM sites s JOIN clients c ON c.id = s.client_id WHERE s.id = ?",
    )
    .bind(&token.site_id)
    .fetch_optional(&state.db)
    .await?;
    let label = label.map(|(c, s)| format!("{c} / {s}")).unwrap_or_default();
    let mut agent_url = state.args.effective_agent_url().to_string();
    if agent_url.ends_with('/') {
        agent_url.pop();
    }
    Ok(DeployKey {
        v: 1,
        urls: vec![agent_url],
        secret: secret.to_string(),
        identity: state.keys.identity_public().to_string(),
        ca_pin: state.tls.ca_spki_pin.clone(),
        label,
    }
    .encode())
}

fn reject(code: &'static str, message: &str) -> ApiError {
    ApiError::new(StatusCode::FORBIDDEN, code, message)
}

fn fingerprint(req: &EnrollRequest) -> Option<String> {
    let uuid = req
        .hardware_uuid
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && !is_junk_id(s));
    let serial = req
        .serial
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && !is_junk_id(s));
    if uuid.is_none() && serial.is_none() {
        return None;
    }
    let material = format!(
        "{}|{}",
        uuid.unwrap_or("").to_lowercase(),
        serial.unwrap_or("").to_lowercase()
    );
    Some(rustrmm_crypto::random::sha256_hex(material.as_bytes()))
}

/// Placeholder identifiers OEMs ship that would make unrelated machines look identical.
fn is_junk_id(value: &str) -> bool {
    let v = value.to_ascii_lowercase();
    v.chars().all(|c| c == '0' || c == '-' || c == 'f')
        || [
            "to be filled by o.e.m.",
            "default string",
            "system serial number",
            "none",
            "not specified",
            "0123456789",
        ]
        .contains(&v.as_str())
}

fn bounded(value: &str, max: usize) -> String {
    value
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(max)
        .collect()
}

/// `POST /agent/v1/enroll`
pub async fn enroll(
    State(state): State<AppState>,
    meta: ClientMeta,
    Json(req): Json<EnrollRequest>,
) -> ApiResult<Json<EnrollResponse>> {
    let ip_key = meta.ip.clone().unwrap_or_else(|| "unknown".into());
    if !state
        .limiter
        .check("enroll", &ip_key, Limit::per(120, Duration::from_secs(60)))
    {
        return Err(ApiError::too_many_requests());
    }
    let secret_hash = rustrmm_crypto::random::sha256_hex(req.secret.trim().as_bytes());
    let token: TokenRow = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {TOKEN_COLUMNS} FROM enrollment_tokens WHERE secret_hash = ?"
    )))
    .bind(&secret_hash)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| reject("invalid_token", "This deploy key is not valid"))?;

    let now = rustrmm_common::now();
    if token.revoked_at.is_some() {
        return Err(reject("token_revoked", "This deploy key has been revoked"));
    }
    if token.expires_at.is_some_and(|t| t <= now) {
        return Err(reject("token_expired", "This deploy key has expired"));
    }
    if token.max_uses.is_some_and(|max| token.uses >= max) {
        return Err(reject(
            "token_exhausted",
            "This deploy key has reached its enrollment limit",
        ));
    }
    let cidrs: Vec<ipnet::IpNet> = serde_json::from_str(&token.allowed_cidrs).unwrap_or_default();
    if !cidrs.is_empty() {
        let ip: Option<IpAddr> = meta.ip.as_deref().and_then(|s| s.parse().ok());
        if !ip.is_some_and(|ip| cidrs.iter().any(|n| n.contains(&ip))) {
            return Err(reject(
                "network_not_allowed",
                "Enrollment is not allowed from this network",
            ));
        }
    }
    let domains: Vec<String> = serde_json::from_str(&token.allowed_domains).unwrap_or_default();
    if !domains.is_empty() {
        let domain = req
            .domain
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let ok = domains.iter().any(|d| {
            let d = d.trim().trim_start_matches('.').to_ascii_lowercase();
            !d.is_empty() && (domain == d || domain.ends_with(&format!(".{d}")))
        });
        if !ok {
            return Err(reject(
                "domain_not_allowed",
                "This computer is not a member of an allowed domain",
            ));
        }
    }
    let public_key = PublicKey::parse(&req.public_key)
        .map_err(|_| ApiError::bad_request("Invalid device public key"))?;
    let os_family = match req.os_family.as_str() {
        "windows" | "macos" | "linux" => req.os_family.clone(),
        _ => return Err(ApiError::bad_request("Unsupported operating system family")),
    };
    let hostname = bounded(&req.hostname, 253);
    if hostname.is_empty() {
        return Err(ApiError::bad_request("Hostname is required"));
    }

    let fp = fingerprint(&req);
    let duplicate: Option<String> = match &fp {
        Some(fp) => sqlx::query_scalar("SELECT id FROM devices WHERE fingerprint = ? AND status IN ('active', 'quarantined') LIMIT 1")
            .bind(fp)
            .fetch_optional(&state.db)
            .await?,
        None => None,
    };
    let status = if token.require_approval || duplicate.is_some() {
        "pending"
    } else {
        "active"
    };

    let id = rustrmm_common::new_id();
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "INSERT INTO devices (id, site_id, status, hostname, os_family, os_name, os_version, arch, serial, hardware_uuid,
                              fingerprint, domain, agent_version, protocol, public_key, enrollment_token_id, replaces_device_id,
                              enrolled_at, approved_at, last_ip, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&token.site_id)
    .bind(status)
    .bind(&hostname)
    .bind(&os_family)
    .bind(bounded(&req.os_name, 120))
    .bind(bounded(&req.os_version, 60))
    .bind(bounded(&req.arch, 20))
    .bind(req.serial.as_deref().map(|s| bounded(s, 120)))
    .bind(req.hardware_uuid.as_deref().map(|s| bounded(s, 80)))
    .bind(&fp)
    .bind(req.domain.as_deref().map(|s| bounded(s, 253)))
    .bind(bounded(&req.agent_version, 40))
    .bind(format!("{}.{}", rustrmm_proto::PROTOCOL_MAJOR, rustrmm_proto::PROTOCOL_MINOR))
    .bind(public_key.to_string())
    .bind(&token.id)
    .bind(&duplicate)
    .bind(now)
    .bind((status == "active").then_some(now))
    .bind(&meta.ip)
    .bind(now)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|e| match ApiError::from(e) {
        err if err.code == "already_exists" => ApiError::conflict("key_in_use", "This device key is already enrolled"),
        err => err,
    })?;
    sqlx::query("UPDATE enrollment_tokens SET uses = uses + 1, last_used_at = ? WHERE id = ?")
        .bind(now)
        .bind(&token.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    let summary = if status == "pending" {
        "Enrolled — waiting for approval"
    } else {
        "Agent enrolled"
    };
    super::timeline(
        &state.db,
        &id,
        "agent.enrolled",
        "notice",
        summary,
        json!({ "token": token.name, "ip": meta.ip }),
    )
    .await?;
    let (client_id, client_name, site_name): (String, String, String) =
        sqlx::query_as("SELECT c.id, c.name, s.name FROM sites s JOIN clients c ON c.id = s.client_id WHERE s.id = ?")
            .bind(&token.site_id)
            .fetch_one(&state.db)
            .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            AuditEntry::new(Actor::Agent { id: id.clone(), name: hostname.clone() }, "agent.enrolled")
                .target("device", &id, &hostname)
                .client(&client_id)
                .site(&token.site_id)
                .request(meta.ip.clone(), meta.user_agent.clone())
                .details(json!({ "status": status, "token": token.name, "os": os_family, "replaces": duplicate })),
        )
        .await;
    state.events.publish(
        "devices.changed",
        Some(client_id.clone()),
        json!({ "id": id, "enrolled": true, "status": status }),
    );
    state.events.publish(
        "device.enrolled",
        Some(client_id.clone()),
        json!({ "device_id": id, "hostname": hostname, "status": status, "client_id": client_id,
                "client_name": client_name, "site_id": token.site_id, "site_name": site_name,
                "os_family": os_family }),
    );
    state
        .events
        .publish("fleet.summary", Some(client_id), serde_json::Value::Null);

    Ok(Json(EnrollResponse {
        device_id: id,
        status: status.to_string(),
        identity: state.keys.identity_public().to_string(),
        command_key: state.keys.command.public_key().to_string(),
        release_key: state.keys.release.public_key().to_string(),
        escrow_recipient: state.keys.escrow_recipient(),
        ca_cert_pem: state.tls.ca_cert_pem.clone(),
        client_name,
        site_name,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(uuid: Option<&str>, serial: Option<&str>) -> EnrollRequest {
        EnrollRequest {
            secret: "x".into(),
            public_key: "k".into(),
            hostname: "h".into(),
            os_family: "windows".into(),
            os_name: String::new(),
            os_version: String::new(),
            arch: String::new(),
            hardware_uuid: uuid.map(Into::into),
            serial: serial.map(Into::into),
            domain: None,
            agent_version: "0".into(),
        }
    }

    #[test]
    fn fingerprints_ignore_oem_placeholders() {
        assert!(fingerprint(&req(None, None)).is_none());
        assert!(
            fingerprint(&req(
                Some("00000000-0000-0000-0000-000000000000"),
                Some("To be filled by O.E.M.")
            ))
            .is_none()
        );
        let a = fingerprint(&req(
            Some("4C4C4544-0039-3010-8048-B2C04F333232"),
            Some("ABC123"),
        ));
        let b = fingerprint(&req(
            Some("4c4c4544-0039-3010-8048-b2c04f333232"),
            Some("abc123"),
        ));
        assert!(a.is_some());
        assert_eq!(a, b, "case-insensitive");
    }
}
