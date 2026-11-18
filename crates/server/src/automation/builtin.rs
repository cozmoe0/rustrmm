//! The built-in script pack, written for RustRMM and embedded at compile time from
//! `crates/server/builtin-scripts/`. Seeding is idempotent and keyed by each script's stable
//! built-in id: new scripts are added (approved), changed ones get a new approved version, and
//! metadata is refreshed in place.

use anyhow::{Context, Result, bail};
use serde::Deserialize;

use super::params::ScriptParameter;
use super::scripts::{self, Author, BUILTIN_AUTHOR, ScriptBody, ValidScript};
use crate::db::Db;

include!(concat!(env!("OUT_DIR"), "/builtin_scripts.rs"));

const MANIFEST: &str = "manifest.json";

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    id: String,
    file: String,
    name: String,
    description: String,
    category: String,
    language: String,
    platforms: Vec<String>,
    timeout_secs: i64,
    #[serde(default = "normal")]
    risk: String,
    #[serde(default)]
    parameters: Vec<ScriptParameter>,
}

fn normal() -> String {
    "normal".into()
}

fn file(name: &str) -> Option<&'static str> {
    BUILTIN_FILES
        .iter()
        .find(|(path, _)| *path == name)
        .map(|(_, content)| *content)
}

/// The pack, validated exactly like user scripts.
pub fn pack() -> Result<Vec<(String, ValidScript)>> {
    let manifest = file(MANIFEST).context("builtin-scripts/manifest.json is missing")?;
    let entries: Vec<Entry> =
        serde_json::from_str(manifest).context("builtin-scripts/manifest.json is invalid")?;
    let mut out = Vec::with_capacity(entries.len());
    let mut ids = std::collections::HashSet::new();
    for entry in entries {
        if !ids.insert(entry.id.clone()) {
            bail!("duplicate built-in id {}", entry.id);
        }
        let content = file(&entry.file).with_context(|| {
            format!(
                "built-in {} refers to missing file {}",
                entry.id, entry.file
            )
        })?;
        let body = ScriptBody {
            name: entry.name,
            description: entry.description,
            category: entry.category,
            language: entry.language,
            platforms: entry.platforms,
            timeout_secs: entry.timeout_secs,
            risk: entry.risk,
            // Files are checked out with either line ending; scripts always store LF.
            content: content.replace("\r\n", "\n"),
            parameters: entry.parameters,
            notes: Some(format!("Built in to RustRMM {}", rustrmm_common::VERSION)),
        };
        let valid = scripts::validate(&body)
            .map_err(|e| anyhow::anyhow!("built-in {} is invalid: {e}", entry.id))?;
        out.push((entry.id, valid));
    }
    Ok(out)
}

/// Seeds or upgrades the built-in scripts.
pub async fn seed(db: &Db) -> Result<()> {
    let author = Author {
        id: None,
        name: BUILTIN_AUTHOR,
    };
    let (mut added, mut updated) = (0, 0);
    for (builtin_id, valid) in pack()? {
        let existing: Option<(String, i64)> =
            sqlx::query_as("SELECT id, current_version FROM scripts WHERE builtin_id = ?")
                .bind(&builtin_id)
                .fetch_optional(db)
                .await?;
        let Some((id, current)) = existing else {
            scripts::insert(db, &valid, Some(&builtin_id), &author, true).await?;
            added += 1;
            continue;
        };
        let version = scripts::load_version(db, &id, current).await?;
        let changed = version.as_ref().is_none_or(|v| {
            v.content_sha256 != valid.content_sha256 || v.parameters() != valid.parameters
        });
        let now = rustrmm_common::now();
        let mut tx = db.begin().await?;
        let new_version = if changed { current + 1 } else { current };
        if changed {
            scripts::insert_version(&mut tx, &id, new_version, &valid, &author, true).await?;
            updated += 1;
        }
        sqlx::query("UPDATE scripts SET name = ?, description = ?, category = ?, language = ?, platforms = ?, timeout_secs = ?,
                     risk = ?, current_version = ?, approved_version = CASE WHEN ? THEN ? ELSE approved_version END,
                     updated_at = CASE WHEN ? THEN ? ELSE updated_at END WHERE id = ?")
            .bind(&valid.name)
            .bind(&valid.description)
            .bind(&valid.category)
            .bind(&valid.language)
            .bind(serde_json::to_string(&valid.platforms)?)
            .bind(valid.timeout_secs)
            .bind(&valid.risk)
            .bind(new_version)
            .bind(changed)
            .bind(new_version)
            .bind(changed)
            .bind(now)
            .bind(&id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
    }
    if added + updated > 0 {
        tracing::info!(added, updated, "built-in scripts seeded");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_is_valid_and_complete() {
        let pack = pack().expect("built-in pack");
        assert!(
            pack.len() >= 35,
            "about 40 built-in scripts, found {}",
            pack.len()
        );
        let categories: std::collections::HashSet<&str> =
            pack.iter().map(|(_, s)| s.category.as_str()).collect();
        for category in [
            "Maintenance",
            "Network",
            "Security",
            "Inventory",
            "Troubleshooting",
            "Updates",
            "Users",
        ] {
            assert!(
                categories.contains(category),
                "category {category} is empty"
            );
        }
        for platform in ["windows", "linux", "macos"] {
            assert!(
                pack.iter()
                    .any(|(_, s)| s.platforms.iter().any(|p| p == platform)),
                "no script for {platform}"
            );
        }
        assert!(pack.iter().any(|(_, s)| s.risk == "high"));
        // Every file is referenced by the manifest.
        let manifest = file(MANIFEST).expect("manifest");
        for (path, _) in BUILTIN_FILES {
            if *path != MANIFEST {
                assert!(
                    manifest.contains(&format!("\"{path}\"")),
                    "{path} is not in the manifest"
                );
            }
        }
    }

    #[tokio::test]
    async fn seeding_is_idempotent() {
        let db = crate::db::connect_memory().await.expect("db");
        crate::db::migrate(&db).await.expect("migrate");
        seed(&db).await.expect("seed");
        seed(&db).await.expect("seed again");
        let (scripts, versions, approved): (i64, i64, i64) = sqlx::query_as(
            "SELECT (SELECT COUNT(*) FROM scripts), (SELECT COUNT(*) FROM script_versions),
                    (SELECT COUNT(*) FROM scripts WHERE approved_version = current_version)",
        )
        .fetch_one(&db)
        .await
        .expect("counts");
        assert_eq!(scripts as usize, pack().expect("pack").len());
        assert_eq!(versions, scripts, "re-seeding adds no versions");
        assert_eq!(approved, scripts, "built-ins are approved");
        // A changed built-in gets a new approved version.
        sqlx::query("UPDATE script_versions SET content_sha256 = 'old' WHERE version = 1 AND script_id = (SELECT id FROM scripts LIMIT 1)")
            .execute(&db)
            .await
            .expect("tamper");
        seed(&db).await.expect("upgrade");
        let max: i64 = sqlx::query_scalar("SELECT MAX(current_version) FROM scripts")
            .fetch_one(&db)
            .await
            .expect("max");
        assert_eq!(max, 2);
    }
}
