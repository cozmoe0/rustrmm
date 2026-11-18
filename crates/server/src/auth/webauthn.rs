//! Passkey (WebAuthn) support built on webauthn-rs.

use anyhow::{Context, Result};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use webauthn_rs::prelude::{Passkey, Url};
use webauthn_rs::{Webauthn, WebauthnBuilder};

use crate::config::ServeArgs;
use crate::db::Db;
use crate::state::AppState;

/// Builds the relying party from the console URL (plus any extra allowed origins).
pub fn build(args: &ServeArgs) -> Result<Webauthn> {
    let origin: Url =
        Url::parse(&args.console_origin()).context("console URL is not a valid origin")?;
    let rp_id = args
        .console_url
        .host_str()
        .context("console URL has no host")?
        .to_string();
    let mut builder = WebauthnBuilder::new(&rp_id, &origin)
        .context("invalid WebAuthn relying party (rp id must match the console host)")?
        .rp_name("RustRMM");
    for extra in &args.allowed_origins {
        if let Ok(url) = Url::parse(&crate::config::origin_of(extra)) {
            builder = builder.append_allowed_origin(&url);
        }
    }
    if args.dev {
        for dev in ["http://localhost:5173", "http://127.0.0.1:5173"] {
            if let Ok(url) = Url::parse(dev) {
                builder = builder.append_allowed_origin(&url);
            }
        }
    }
    builder.build().context("building WebAuthn relying party")
}

/// A stored passkey row.
pub struct StoredPasskey {
    pub id: String,
    pub passkey: Passkey,
}

fn aad(row_id: &str) -> String {
    format!("webauthn_credentials/passkey/{row_id}")
}

pub fn credential_id_string(passkey: &Passkey) -> String {
    let bytes: &[u8] = passkey.cred_id().as_ref();
    URL_SAFE_NO_PAD.encode(bytes)
}

pub async fn load_passkeys(state: &AppState, user_id: &str) -> Result<Vec<StoredPasskey>> {
    let rows: Vec<(String, Vec<u8>)> = sqlx::query_as(
        "SELECT id, passkey FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at",
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for (id, blob) in rows {
        let json = state.cipher.decrypt(&blob, aad(&id).as_bytes())?;
        let passkey: Passkey = serde_json::from_slice(&json).context("decoding stored passkey")?;
        out.push(StoredPasskey { id, passkey });
    }
    Ok(out)
}

pub async fn insert_passkey(
    state: &AppState,
    user_id: &str,
    name: &str,
    passkey: &Passkey,
) -> Result<String> {
    let id = rustrmm_common::new_id();
    let json = serde_json::to_vec(passkey)?;
    let blob = state.cipher.encrypt(&json, aad(&id).as_bytes());
    sqlx::query(
        "INSERT INTO webauthn_credentials (id, user_id, name, credential_id, passkey, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(user_id)
    .bind(name)
    .bind(credential_id_string(passkey))
    .bind(blob)
    .bind(rustrmm_common::now())
    .execute(&state.db)
    .await?;
    Ok(id)
}

pub async fn update_passkey(state: &AppState, stored: &StoredPasskey) -> Result<()> {
    let json = serde_json::to_vec(&stored.passkey)?;
    let blob = state.cipher.encrypt(&json, aad(&stored.id).as_bytes());
    sqlx::query("UPDATE webauthn_credentials SET passkey = ?, last_used_at = ? WHERE id = ?")
        .bind(blob)
        .bind(rustrmm_common::now())
        .bind(&stored.id)
        .execute(&state.db)
        .await?;
    Ok(())
}

pub async fn count_passkeys(db: &Db, user_id: &str) -> Result<i64> {
    Ok(
        sqlx::query_scalar("SELECT COUNT(*) FROM webauthn_credentials WHERE user_id = ?")
            .bind(user_id)
            .fetch_one(db)
            .await?,
    )
}
