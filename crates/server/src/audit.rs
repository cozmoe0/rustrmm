//! Append-only, hash-chained audit log.
//!
//! Each row stores `hash = SHA-256(prev_hash || "\n" || canonical_json(row))`. Editing or deleting
//! any row breaks the chain from that point, which [`verify`] detects. SQLite triggers reject
//! UPDATE/DELETE on the table as a second line of defence.

use anyhow::Result;
use chrono::SecondsFormat;
use serde::Serialize;
use serde_json::Value;
use sqlx::Row;
use tokio::sync::Mutex;

use crate::db::Db;

pub const GENESIS_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// Who performed an action.
#[derive(Debug, Clone)]
pub enum Actor {
    User { id: String, name: String },
    System,
    Agent { id: String, name: String },
    ApiToken { id: String, name: String },
}

impl Actor {
    fn parts(&self) -> (&'static str, Option<&str>, Option<&str>) {
        match self {
            Self::User { id, name } => ("user", Some(id), Some(name)),
            Self::System => ("system", None, Some("System")),
            Self::Agent { id, name } => ("agent", Some(id), Some(name)),
            Self::ApiToken { id, name } => ("api_token", Some(id), Some(name)),
        }
    }
}

/// What an action was performed on.
#[derive(Debug, Clone)]
pub struct Target {
    pub kind: &'static str,
    pub id: String,
    pub name: String,
}

/// One audit entry under construction.
#[derive(Debug, Clone)]
pub struct AuditEntry {
    pub actor: Actor,
    pub action: &'static str,
    pub target: Option<Target>,
    pub client_id: Option<String>,
    pub site_id: Option<String>,
    pub ip: Option<String>,
    pub user_agent: Option<String>,
    pub details: Value,
}

impl AuditEntry {
    pub fn new(actor: Actor, action: &'static str) -> Self {
        Self {
            actor,
            action,
            target: None,
            client_id: None,
            site_id: None,
            ip: None,
            user_agent: None,
            details: Value::Object(Default::default()),
        }
    }

    pub fn target(
        mut self,
        kind: &'static str,
        id: impl Into<String>,
        name: impl Into<String>,
    ) -> Self {
        self.target = Some(Target {
            kind,
            id: id.into(),
            name: name.into(),
        });
        self
    }

    pub fn client(mut self, client_id: impl Into<String>) -> Self {
        self.client_id = Some(client_id.into());
        self
    }

    pub fn site(mut self, site_id: impl Into<String>) -> Self {
        self.site_id = Some(site_id.into());
        self
    }

    pub fn request(mut self, ip: Option<String>, user_agent: Option<String>) -> Self {
        self.ip = ip;
        self.user_agent = user_agent;
        self
    }

    pub fn details(mut self, details: Value) -> Self {
        self.details = details;
        self
    }
}

/// Fields covered by the hash, in a fixed order.
#[derive(Serialize)]
struct Hashed<'a> {
    at: &'a str,
    actor_type: &'a str,
    actor_id: Option<&'a str>,
    actor_name: Option<&'a str>,
    action: &'a str,
    target_type: Option<&'a str>,
    target_id: Option<&'a str>,
    target_name: Option<&'a str>,
    client_id: Option<&'a str>,
    site_id: Option<&'a str>,
    ip: Option<&'a str>,
    user_agent: Option<&'a str>,
    details: &'a str,
}

fn chain_hash(prev_hash: &str, fields: &Hashed<'_>) -> String {
    let canonical = serde_json::to_string(fields).expect("audit fields serialize");
    rustrmm_crypto::random::sha256_hex(format!("{prev_hash}\n{canonical}").as_bytes())
}

/// Serialises writers so each row chains onto the previous one.
#[derive(Default)]
pub struct AuditLog {
    lock: Mutex<()>,
}

impl AuditLog {
    pub fn new() -> Self {
        Self::default()
    }

    /// Appends an entry; returns its id.
    pub async fn record(&self, db: &Db, entry: AuditEntry) -> Result<i64> {
        let _guard = self.lock.lock().await;
        let prev_hash: String =
            sqlx::query_scalar("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1")
                .fetch_optional(db)
                .await?
                .unwrap_or_else(|| GENESIS_HASH.to_string());
        let at = rustrmm_common::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let details = serde_json::to_string(&entry.details)?;
        let (actor_type, actor_id, actor_name) = entry.actor.parts();
        let fields = Hashed {
            at: &at,
            actor_type,
            actor_id,
            actor_name,
            action: entry.action,
            target_type: entry.target.as_ref().map(|t| t.kind),
            target_id: entry.target.as_ref().map(|t| t.id.as_str()),
            target_name: entry.target.as_ref().map(|t| t.name.as_str()),
            client_id: entry.client_id.as_deref(),
            site_id: entry.site_id.as_deref(),
            ip: entry.ip.as_deref(),
            user_agent: entry.user_agent.as_deref(),
            details: &details,
        };
        let hash = chain_hash(&prev_hash, &fields);
        let id = sqlx::query(
            "INSERT INTO audit_log (at, actor_type, actor_id, actor_name, action, target_type, target_id, target_name,
                                    client_id, site_id, ip, user_agent, details, prev_hash, hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(fields.at)
        .bind(fields.actor_type)
        .bind(fields.actor_id)
        .bind(fields.actor_name)
        .bind(fields.action)
        .bind(fields.target_type)
        .bind(fields.target_id)
        .bind(fields.target_name)
        .bind(fields.client_id)
        .bind(fields.site_id)
        .bind(fields.ip)
        .bind(fields.user_agent)
        .bind(fields.details)
        .bind(&prev_hash)
        .bind(&hash)
        .execute(db)
        .await?
        .last_insert_rowid();
        Ok(id)
    }

    /// Records an entry, logging (not propagating) failures. Use where the primary action has
    /// already happened and must not be reported as failed.
    pub async fn record_or_log(&self, db: &Db, entry: AuditEntry) {
        let action = entry.action;
        if let Err(e) = self.record(db, entry).await {
            tracing::error!(action, error = %format!("{e:#}"), "failed to write audit entry");
        }
    }
}

/// Result of a chain verification.
#[derive(Debug, Clone, Serialize)]
pub struct VerifyResult {
    pub ok: bool,
    pub checked: i64,
    pub broken_at: Option<i64>,
}

/// Recomputes the hash chain over the whole log.
pub async fn verify(db: &Db) -> Result<VerifyResult> {
    let mut prev = GENESIS_HASH.to_string();
    let mut checked = 0i64;
    let mut last_id = 0i64;
    loop {
        let rows = sqlx::query(
            "SELECT id, at, actor_type, actor_id, actor_name, action, target_type, target_id, target_name,
                    client_id, site_id, ip, user_agent, details, prev_hash, hash
             FROM audit_log WHERE id > ? ORDER BY id ASC LIMIT 1000",
        )
        .bind(last_id)
        .fetch_all(db)
        .await?;
        if rows.is_empty() {
            break;
        }
        for row in rows {
            let id: i64 = row.try_get("id")?;
            let get = |name: &str| -> Result<Option<String>> {
                Ok(row.try_get::<Option<String>, _>(name)?)
            };
            let at: String = row.try_get("at")?;
            let actor_type: String = row.try_get("actor_type")?;
            let action: String = row.try_get("action")?;
            let details: String = row.try_get("details")?;
            let prev_hash: String = row.try_get("prev_hash")?;
            let hash: String = row.try_get("hash")?;
            let (
                actor_id,
                actor_name,
                target_type,
                target_id,
                target_name,
                client_id,
                site_id,
                ip,
                user_agent,
            ) = (
                get("actor_id")?,
                get("actor_name")?,
                get("target_type")?,
                get("target_id")?,
                get("target_name")?,
                get("client_id")?,
                get("site_id")?,
                get("ip")?,
                get("user_agent")?,
            );
            let fields = Hashed {
                at: &at,
                actor_type: &actor_type,
                actor_id: actor_id.as_deref(),
                actor_name: actor_name.as_deref(),
                action: &action,
                target_type: target_type.as_deref(),
                target_id: target_id.as_deref(),
                target_name: target_name.as_deref(),
                client_id: client_id.as_deref(),
                site_id: site_id.as_deref(),
                ip: ip.as_deref(),
                user_agent: user_agent.as_deref(),
                details: &details,
            };
            if prev_hash != prev || chain_hash(&prev, &fields) != hash {
                return Ok(VerifyResult {
                    ok: false,
                    checked,
                    broken_at: Some(id),
                });
            }
            prev = hash;
            checked += 1;
            last_id = id;
        }
    }
    Ok(VerifyResult {
        ok: true,
        checked,
        broken_at: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn db() -> Db {
        let db = crate::db::connect_memory().await.expect("db");
        crate::db::migrate(&db).await.expect("migrate");
        db
    }

    #[tokio::test]
    async fn chain_verifies_and_detects_tampering() {
        let db = db().await;
        let log = AuditLog::new();
        for i in 0..5 {
            log.record(
                &db,
                AuditEntry::new(Actor::System, "test.event").details(serde_json::json!({ "i": i })),
            )
            .await
            .expect("record");
        }
        let result = verify(&db).await.expect("verify");
        assert!(result.ok);
        assert_eq!(result.checked, 5);

        // Bypass the append-only trigger to simulate an attacker with raw database access.
        sqlx::query("DROP TRIGGER audit_log_no_update")
            .execute(&db)
            .await
            .expect("drop trigger");
        sqlx::query("UPDATE audit_log SET details = '{\"i\":99}' WHERE id = 3")
            .execute(&db)
            .await
            .expect("tamper");
        let result = verify(&db).await.expect("verify");
        assert!(!result.ok);
        assert_eq!(result.broken_at, Some(3));
    }

    #[tokio::test]
    async fn updates_and_deletes_are_rejected() {
        let db = db().await;
        AuditLog::new()
            .record(&db, AuditEntry::new(Actor::System, "test.event"))
            .await
            .expect("record");
        assert!(
            sqlx::query("UPDATE audit_log SET action = 'x'")
                .execute(&db)
                .await
                .is_err()
        );
        assert!(
            sqlx::query("DELETE FROM audit_log")
                .execute(&db)
                .await
                .is_err()
        );
    }
}
