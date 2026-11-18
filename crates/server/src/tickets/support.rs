//! `POST /agent/v1/support-request` on the agent listener: an end-user "Request support"
//! signed with the device key (Ed25519 over `"rustrmm/v1/support" ‖ body`), with a five-minute
//! timestamp window, a nonce replay cache and a limit of five requests per device per hour.

use std::time::Duration;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use rustrmm_crypto::sign::PublicKey;
use rustrmm_proto::support::{self as proto, SupportRequest, SupportResponse};
use serde_json::json;

use super::model::{self, NewComment, NewTicket, Who};
use crate::db::Db;
use crate::error::ApiError;
use crate::ratelimit::Limit;
use crate::state::AppState;

pub const RATE_LIMIT: Limit = Limit::per(5, Duration::from_secs(3600));
/// Nonces are remembered for twice the timestamp window.
const NONCE_TTL_SECS: i64 = 2 * proto::MAX_SKEW_SECS;
const MAX_SCREENSHOT_BYTES: usize = 5 * 1024 * 1024;

/// The device a request authenticated as.
#[derive(Debug, Clone)]
pub struct Device {
    pub id: String,
    pub hostname: String,
    pub client_id: String,
    pub site_id: String,
}

fn unauthenticated(message: &str) -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, "unauthenticated", message)
}

/// Verifies the device headers and the signature over the raw body.
pub async fn authenticate(db: &Db, headers: &HeaderMap, body: &[u8]) -> Result<Device, ApiError> {
    let device_id = headers
        .get(proto::DEVICE_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| !v.is_empty() && v.len() <= 64)
        .ok_or_else(|| unauthenticated("Missing device id"))?;
    let signature = headers
        .get(proto::SIGNATURE_HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(proto::decode_signature)
        .ok_or_else(|| unauthenticated("Missing or malformed signature"))?;
    let row: Option<(String, String, String, String, String)> = sqlx::query_as(
        "SELECT d.public_key, d.status, d.hostname, s.client_id, d.site_id FROM devices d JOIN sites s ON s.id = d.site_id WHERE d.id = ?",
    )
    .bind(device_id)
    .fetch_optional(db)
    .await
    .map_err(ApiError::from)?;
    let Some((public_key, status, hostname, client_id, site_id)) = row else {
        return Err(unauthenticated("Unknown device or bad signature"));
    };
    if status != "active" {
        return Err(unauthenticated("Unknown device or bad signature"));
    }
    let key = PublicKey::parse(&public_key)
        .map_err(|_| unauthenticated("Unknown device or bad signature"))?;
    key.verify(&proto::signing_bytes(body), &signature)
        .map_err(|_| unauthenticated("Unknown device or bad signature"))?;
    Ok(Device {
        id: device_id.to_string(),
        hostname,
        client_id,
        site_id,
    })
}

/// The timestamp must be within five minutes of the server clock.
pub fn fresh(timestamp: i64, now: i64) -> bool {
    (timestamp - now).abs() <= proto::MAX_SKEW_SECS
}

/// Nonces are 16–128 URL-safe characters.
pub fn valid_nonce(nonce: &str) -> bool {
    (16..=128).contains(&nonce.len())
        && nonce
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Records a nonce; false when the device already used it.
pub async fn remember_nonce(db: &Db, device_id: &str, nonce: &str) -> anyhow::Result<bool> {
    let now = rustrmm_common::now();
    sqlx::query("DELETE FROM support_nonces WHERE expires_at < ?")
        .bind(now)
        .execute(db)
        .await?;
    let inserted = sqlx::query(
        "INSERT OR IGNORE INTO support_nonces (device_id, nonce, expires_at) VALUES (?, ?, ?)",
    )
    .bind(device_id)
    .bind(nonce)
    .bind(now + chrono::Duration::seconds(NONCE_TTL_SECS))
    .execute(db)
    .await?
    .rows_affected();
    Ok(inserted == 1)
}

fn clip(text: &str, max: usize) -> String {
    text.chars()
        .filter(|c| *c == '\n' || *c == '\t' || !c.is_control())
        .take(max)
        .collect::<String>()
        .trim()
        .to_string()
}

async fn contact_for(
    db: &Db,
    client_id: &str,
    email: Option<&str>,
    user: &str,
) -> anyhow::Result<Option<(String, String)>> {
    if let Some(email) = email
        && let Some(c) = super::contacts::by_email_in_client(db, client_id, email).await?
    {
        return Ok(Some((c.id, c.name)));
    }
    if user.chars().count() >= 2 {
        let found: Option<(String, String)> = sqlx::query_as(
            "SELECT id, name FROM contacts WHERE client_id = ? AND notes LIKE ? ESCAPE '\\' ORDER BY is_primary DESC, created_at LIMIT 1",
        )
        .bind(client_id)
        .bind(super::like_pattern(user))
        .fetch_optional(db)
        .await?;
        return Ok(found);
    }
    Ok(None)
}

async fn handle(state: &AppState, headers: &HeaderMap, body: &[u8]) -> Result<Response, ApiError> {
    if body.len() > proto::MAX_BODY_BYTES {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "too_large",
            "The request is too large",
        ));
    }
    let device = authenticate(&state.db, headers, body).await?;
    let req: SupportRequest = serde_json::from_slice(body)
        .map_err(|e| ApiError::bad_request(format!("invalid request: {e}")))?;
    if !fresh(req.timestamp, chrono::Utc::now().timestamp()) {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "stale_request",
            "The request timestamp is outside the accepted window (check the device clock)",
        ));
    }
    if !valid_nonce(&req.nonce) {
        return Err(ApiError::bad_request(
            "nonce must be 16–128 URL-safe characters",
        ));
    }
    if !remember_nonce(&state.db, &device.id, &req.nonce).await? {
        tracing::warn!(device = %device.id, "refused a replayed support request");
        return Err(ApiError::conflict(
            "replayed",
            "This request was already received",
        ));
    }
    if !state
        .limiter
        .check("support_request", &device.id, RATE_LIMIT)
    {
        return Err(ApiError::too_many_requests());
    }

    let user = clip(&req.user, 256);
    let name = clip(&req.name, 200);
    let requester = if name.is_empty() {
        user.clone()
    } else {
        name.clone()
    };
    let email = req
        .email
        .as_deref()
        .map(str::trim)
        .filter(|e| crate::monitoring::settings::valid_email(e))
        .map(str::to_string);
    let mut subject = clip(&req.subject, 200).replace(['\r', '\n'], " ");
    if subject.is_empty() {
        subject = format!(
            "Support request from {}",
            if requester.is_empty() {
                "a user"
            } else {
                &requester
            }
        );
    }
    let screenshot = match req.screenshot_jpeg_b64.as_deref().filter(|s| !s.is_empty()) {
        Some(b64) => {
            let data = base64::engine::general_purpose::STANDARD
                .decode(b64.trim())
                .map_err(|_| ApiError::bad_request("screenshot_jpeg_b64 is not base64"))?;
            if data.len() > MAX_SCREENSHOT_BYTES || !data.starts_with(&[0xff, 0xd8, 0xff]) {
                return Err(ApiError::bad_request(
                    "the screenshot must be a JPEG of at most 5 MiB",
                ));
            }
            Some(data)
        }
        None => None,
    };
    let contact = contact_for(&state.db, &device.client_id, email.as_deref(), &user).await?;
    let mut by = requester.clone();
    if !user.is_empty() && user != requester {
        by.push_str(&format!(" ({user})"));
    }
    if let Some(e) = &email {
        by.push_str(&format!(" <{e}>"));
    }
    let description = format!(
        "{}\n\n---\nSubmitted from **{}** by {}.",
        clip(&req.description, 20_000),
        device.hostname,
        if by.is_empty() {
            "an unknown user".to_string()
        } else {
            by
        }
    );
    let who = Who::contact(
        contact.as_ref().map(|c| c.0.clone()),
        contact.as_ref().map(|c| c.1.clone()).unwrap_or_else(|| {
            if requester.is_empty() {
                device.hostname.clone()
            } else {
                requester.clone()
            }
        }),
    );
    let ticket = model::create(
        state,
        NewTicket {
            subject,
            description,
            client_id: device.client_id.clone(),
            site_id: Some(device.site_id.clone()),
            contact_id: contact.map(|c| c.0),
            kind: "incident".into(),
            source: "agent",
            device_ids: vec![device.id.clone()],
            ..NewTicket::default()
        },
        &who,
    )
    .await?;
    if let Some(jpeg) = screenshot {
        let stored =
            super::comments::store_bytes(state, &jpeg, "screenshot.jpg", "image/jpeg").await?;
        model::add_comment(
            state,
            &ticket,
            NewComment {
                author: who.clone(),
                visibility: "public".into(),
                body: "Screenshot taken when the request was sent.".into(),
                source: "agent",
                email_message_id: None,
                files: vec![stored],
            },
        )
        .await?;
    }
    let _ = crate::agents::timeline(
        &state.db,
        &device.id,
        "ticket.created",
        "info",
        &format!("Support request #{}: {}", ticket.number, ticket.subject),
        json!({ "ticket_id": ticket.id, "number": ticket.number }),
    )
    .await;
    tracing::info!(device = %device.id, ticket = ticket.number, "support request received");
    Ok((
        StatusCode::CREATED,
        axum::Json(SupportResponse {
            ticket_id: ticket.id,
            number: ticket.number,
        }),
    )
        .into_response())
}

/// `POST /agent/v1/support-request`
pub async fn support_request(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    match handle(&state, &headers, &body).await {
        Ok(r) => r,
        Err(e) => e.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;
    use rustrmm_crypto::sign::SigningKey;

    async fn db_with_device(key: &SigningKey) -> Db {
        let db = crate::db::connect_memory().await.expect("db");
        crate::db::migrate(&db).await.expect("migrate");
        let now = rustrmm_common::now();
        sqlx::query("INSERT INTO clients (id, name, slug, created_at, updated_at) VALUES ('c1', 'C', 'c', ?, ?)")
            .bind(now)
            .bind(now)
            .execute(&db)
            .await
            .expect("client");
        sqlx::query("INSERT INTO sites (id, client_id, name, created_at, updated_at) VALUES ('s1', 'c1', 'S', ?, ?)")
            .bind(now)
            .bind(now)
            .execute(&db)
            .await
            .expect("site");
        sqlx::query("INSERT INTO devices (id, site_id, status, hostname, os_family, public_key, enrolled_at, created_at, updated_at)
                     VALUES ('d1', 's1', 'active', 'WS-1', 'windows', ?, ?, ?, ?)")
            .bind(key.public_key().to_string())
            .bind(now)
            .bind(now)
            .bind(now)
            .execute(&db)
            .await
            .expect("device");
        db
    }

    fn headers(device: &str, signature: &[u8]) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(
            proto::DEVICE_HEADER,
            HeaderValue::from_str(device).expect("hdr"),
        );
        h.insert(
            proto::SIGNATURE_HEADER,
            HeaderValue::from_str(&proto::encode_signature(signature)).expect("hdr"),
        );
        h
    }

    #[tokio::test]
    async fn signatures_bind_the_device_and_body() {
        let key = SigningKey::generate();
        let db = db_with_device(&key).await;
        let body = br#"{"user":"alex","subject":"Printer","timestamp":1,"nonce":"x"}"#;
        let sig = key.sign(&proto::signing_bytes(body));
        let device = authenticate(&db, &headers("d1", &sig), body)
            .await
            .expect("valid");
        assert_eq!(
            (device.client_id.as_str(), device.site_id.as_str()),
            ("c1", "s1")
        );
        // A changed body, another key, an unknown device or a missing header fail.
        assert!(
            authenticate(&db, &headers("d1", &sig), b"{}")
                .await
                .is_err()
        );
        let other = SigningKey::generate().sign(&proto::signing_bytes(body));
        assert!(
            authenticate(&db, &headers("d1", &other), body)
                .await
                .is_err()
        );
        assert!(authenticate(&db, &headers("d2", &sig), body).await.is_err());
        assert!(authenticate(&db, &HeaderMap::new(), body).await.is_err());
        // The bare body (no context prefix) is not accepted.
        let bare = key.sign(body);
        assert!(
            authenticate(&db, &headers("d1", &bare), body)
                .await
                .is_err()
        );
        // A revoked device is refused.
        sqlx::query("UPDATE devices SET status = 'revoked'")
            .execute(&db)
            .await
            .expect("revoke");
        assert!(authenticate(&db, &headers("d1", &sig), body).await.is_err());
    }

    #[tokio::test]
    async fn timestamps_nonces_and_rate_limits() {
        assert!(fresh(1_000_000, 1_000_000));
        assert!(fresh(1_000_000 - 300, 1_000_000));
        assert!(fresh(1_000_000 + 300, 1_000_000));
        assert!(!fresh(1_000_000 - 301, 1_000_000));
        assert!(!fresh(1_000_000 + 301, 1_000_000));
        assert!(valid_nonce(&proto::new_nonce()));
        assert!(!valid_nonce("short"));
        assert!(!valid_nonce(&"a".repeat(129)));
        assert!(!valid_nonce("has spaces in it!!"));

        let key = SigningKey::generate();
        let db = db_with_device(&key).await;
        let nonce = proto::new_nonce();
        assert!(remember_nonce(&db, "d1", &nonce).await.expect("first"));
        assert!(!remember_nonce(&db, "d1", &nonce).await.expect("replay"));
        assert!(
            remember_nonce(&db, "d2", &nonce)
                .await
                .expect("other device")
        );
        // Expired nonces are purged.
        sqlx::query("UPDATE support_nonces SET expires_at = ?")
            .bind(rustrmm_common::now() - chrono::Duration::seconds(1))
            .execute(&db)
            .await
            .expect("expire");
        assert!(
            remember_nonce(&db, "d1", &nonce)
                .await
                .expect("after expiry")
        );

        let limiter = crate::ratelimit::RateLimiter::new();
        for _ in 0..5 {
            assert!(limiter.check("support_request", "d1", RATE_LIMIT));
        }
        assert!(!limiter.check("support_request", "d1", RATE_LIMIT));
        assert!(limiter.check("support_request", "d2", RATE_LIMIT));
    }
}
