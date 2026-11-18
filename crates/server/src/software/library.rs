//! The software library: packages from package managers or uploaded files, with detection
//! rules.

use std::collections::{HashMap, HashSet};

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use rustrmm_proto::patching::valid_package_name;
use rustrmm_proto::scripts::PLATFORMS;
use rustrmm_proto::software::{Detection, INSTALLERS, PackageSource, split_registry_key};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::auth::AuthCtx;
use crate::db::Db;
use crate::error::{ApiError, ApiResult};
use crate::rbac::perm;
use crate::state::AppState;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PackageRow {
    pub id: String,
    pub name: String,
    pub publisher: String,
    pub description: String,
    pub platforms: String,
    pub source: String,
    pub detection: String,
    pub created_by_name: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl PackageRow {
    pub fn source(&self) -> Option<PackageSource> {
        serde_json::from_str(&self.source).ok()
    }

    pub fn detection(&self) -> Detection {
        serde_json::from_str(&self.detection).unwrap_or_default()
    }

    pub fn platforms(&self) -> Vec<String> {
        serde_json::from_str(&self.platforms).unwrap_or_default()
    }

    pub fn to_json(&self, installed_on: i64) -> Value {
        json!({
            "id": self.id, "name": self.name, "publisher": self.publisher, "description": self.description,
            "platforms": self.platforms(),
            "source": serde_json::from_str::<Value>(&self.source).unwrap_or(Value::Null),
            "detection": serde_json::from_str::<Value>(&self.detection).unwrap_or(json!({ "type": "none" })),
            "created_by_name": self.created_by_name, "created_at": self.created_at, "updated_at": self.updated_at,
            "installed_on": installed_on,
        })
    }
}

const SELECT: &str = "SELECT id, name, publisher, description, platforms, source, detection, created_by_name, created_at, updated_at
    FROM software_packages";

pub async fn load(db: &Db, id: &str) -> anyhow::Result<Option<PackageRow>> {
    Ok(
        sqlx::query_as(sqlx::AssertSqlSafe(format!("{SELECT} WHERE id = ?")))
            .bind(id)
            .fetch_optional(db)
            .await?,
    )
}

fn valid_manager_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && !id.starts_with('-')
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+' | '@' | '/'))
}

fn clean_args(args: &str, path: &str) -> ApiResult<String> {
    if args.chars().count() > 1000 || args.chars().any(|c| c == '\0' || c == '\n' || c == '\r') {
        return Err(ApiError::validation(format!(
            "{path} must be one line of at most 1000 characters"
        ))
        .with_details(json!({ "path": path })));
    }
    Ok(args.trim().to_string())
}

/// Validates and completes a source (uploaded files get their hash, size and name).
async fn check_source(db: &Db, source: PackageSource) -> ApiResult<PackageSource> {
    let invalid =
        |m: &str| ApiError::validation(m.to_string()).with_details(json!({ "path": "source" }));
    match source {
        PackageSource::Winget { ref id } | PackageSource::Choco { ref id } => {
            if !valid_manager_id(id) {
                return Err(invalid("source.id is not a valid package id"));
            }
            Ok(source)
        }
        PackageSource::Brew { ref id, .. }
        | PackageSource::Apt { ref id }
        | PackageSource::Dnf { ref id }
        | PackageSource::Zypper { ref id }
        | PackageSource::Pacman { ref id }
        | PackageSource::Apk { ref id } => {
            if !valid_package_name(id) {
                return Err(invalid("source.id is not a valid package name"));
            }
            Ok(source)
        }
        PackageSource::File {
            file_id,
            installer,
            install_args,
            uninstall_args,
            ..
        } => {
            if !INSTALLERS.iter().any(|(i, _)| *i == installer) {
                return Err(invalid(
                    "source.installer must be msi, exe, pkg, deb, rpm or sh",
                ));
            }
            let file: Option<(String, i64, String)> = sqlx::query_as(
                "SELECT sha256, size_bytes, file_name FROM software_files WHERE id = ?",
            )
            .bind(&file_id)
            .fetch_optional(db)
            .await?;
            let (sha256, size, file_name) =
                file.ok_or_else(|| invalid("source.file_id does not name an uploaded file"))?;
            Ok(PackageSource::File {
                file_id,
                file_name,
                sha256,
                size_bytes: size.max(0) as u64,
                installer,
                install_args: clean_args(&install_args, "source.install_args")?,
                uninstall_args: clean_args(&uninstall_args, "source.uninstall_args")?,
            })
        }
    }
}

fn check_detection(detection: &Detection) -> ApiResult<()> {
    let invalid =
        |m: &str| ApiError::validation(m.to_string()).with_details(json!({ "path": "detection" }));
    let version_ok = |v: &Option<String>| v.as_ref().is_none_or(|v| v.chars().count() <= 50);
    match detection {
        Detection::SoftwareName {
            pattern,
            min_version,
        } => {
            if pattern.trim().is_empty() || pattern.chars().count() > 200 {
                return Err(invalid("detection.pattern must be 1–200 characters"));
            }
            if !version_ok(min_version) {
                return Err(invalid("detection.min_version is too long"));
            }
        }
        Detection::File { path, min_version } => {
            let absolute = path.starts_with('/')
                || (path.len() > 2 && path.as_bytes()[1] == b':')
                || path.starts_with("%");
            if !absolute || path.chars().count() > 400 || path.contains('\0') {
                return Err(invalid("detection.path must be an absolute path"));
            }
            if !version_ok(min_version) {
                return Err(invalid("detection.min_version is too long"));
            }
        }
        Detection::Registry { key, value, equals } => {
            if split_registry_key(key).is_none() || key.chars().count() > 400 {
                return Err(invalid(
                    "detection.key must start with HKLM, HKCU, HKU or HKCR",
                ));
            }
            if value.as_ref().is_some_and(|v| v.chars().count() > 200)
                || equals.as_ref().is_some_and(|v| v.chars().count() > 400)
            {
                return Err(invalid("detection.value or detection.equals is too long"));
            }
        }
        Detection::None => {}
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct PackageBody {
    name: String,
    #[serde(default)]
    publisher: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    platforms: Vec<String>,
    source: PackageSource,
    #[serde(default)]
    detection: Detection,
}

struct Checked {
    name: String,
    platforms: Vec<String>,
    source: PackageSource,
}

async fn check_body(db: &Db, body: &PackageBody) -> ApiResult<Checked> {
    let name = body.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 120 {
        return Err(ApiError::validation("Name must be 1–120 characters"));
    }
    if body.publisher.chars().count() > 120 || body.description.chars().count() > 2000 {
        return Err(ApiError::validation("Publisher or description is too long"));
    }
    let source = check_source(db, body.source.clone()).await?;
    check_detection(&body.detection)?;
    let supported = source.platforms();
    let mut platforms: Vec<String> = if body.platforms.is_empty() {
        supported.iter().map(|p| p.to_string()).collect()
    } else {
        body.platforms.clone()
    };
    platforms.sort();
    platforms.dedup();
    for p in &platforms {
        if !PLATFORMS.contains(&p.as_str()) || !supported.contains(&p.as_str()) {
            return Err(ApiError::validation(format!(
                "{} packages cannot be installed on {p}",
                source.kind()
            ))
            .with_details(json!({ "path": "platforms" })));
        }
    }
    Ok(Checked {
        name,
        platforms,
        source,
    })
}

/// Devices where each package is installed: detection by software name against inventory,
/// otherwise devices with a successful install deployment (both within the caller's scope).
async fn installed_counts(
    state: &AppState,
    ctx: &AuthCtx,
    packages: &[PackageRow],
) -> anyhow::Result<HashMap<String, i64>> {
    let mut out = HashMap::new();
    let needs_inventory = packages
        .iter()
        .any(|p| matches!(p.detection(), Detection::SoftwareName { .. }));
    // (name, version) → devices
    let mut inventory: HashMap<(String, String), HashSet<String>> = HashMap::new();
    if needs_inventory {
        let rows: Vec<(String, String, String, String, String)> = sqlx::query_as(
            "SELECT ds.device_id, ds.name, ds.version, s.client_id, d.site_id FROM device_software ds
             JOIN devices d ON d.id = ds.device_id JOIN sites s ON s.id = d.site_id WHERE d.status = 'active'",
        )
        .fetch_all(&state.db)
        .await?;
        for (device, name, version, client, site) in rows {
            if ctx.scope.can_site(perm::SOFTWARE_VIEW, &client, &site) {
                inventory.entry((name, version)).or_default().insert(device);
            }
        }
    }
    let deployed: Vec<(String, String, String, String)> = sqlx::query_as(
        "SELECT dep.package_id, r.device_id, s.client_id, d.site_id FROM software_deployment_results r
         JOIN software_deployments dep ON dep.id = r.deployment_id JOIN devices d ON d.id = r.device_id
         JOIN sites s ON s.id = d.site_id
         WHERE dep.action = 'install' AND r.status = 'succeeded' AND dep.package_id IS NOT NULL AND d.status = 'active'",
    )
    .fetch_all(&state.db)
    .await?;
    let mut by_package: HashMap<String, HashSet<String>> = HashMap::new();
    for (package, device, client, site) in deployed {
        if ctx.scope.can_site(perm::SOFTWARE_VIEW, &client, &site) {
            by_package.entry(package).or_default().insert(device);
        }
    }
    for package in packages {
        let count = match package.detection() {
            Detection::SoftwareName {
                pattern,
                min_version,
            } => {
                let mut devices: HashSet<&String> = HashSet::new();
                for ((name, version), ids) in &inventory {
                    if rustrmm_proto::software::glob_match(&pattern, name)
                        && rustrmm_proto::software::version_satisfies(
                            version,
                            min_version.as_deref(),
                        )
                    {
                        devices.extend(ids.iter());
                    }
                }
                devices.len() as i64
            }
            _ => by_package.get(&package.id).map_or(0, |d| d.len() as i64),
        };
        out.insert(package.id.clone(), count);
    }
    Ok(out)
}

/// `GET /api/v1/software/packages`
pub async fn list(State(state): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<Value>> {
    ctx.require(perm::SOFTWARE_VIEW)?;
    let rows: Vec<PackageRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{SELECT} ORDER BY name COLLATE NOCASE"
    )))
    .fetch_all(&state.db)
    .await?;
    let counts = installed_counts(&state, &ctx, &rows).await?;
    let items: Vec<Value> = rows
        .iter()
        .map(|p| p.to_json(counts.get(&p.id).copied().unwrap_or(0)))
        .collect();
    Ok(Json(json!({ "items": items })))
}

/// `GET /api/v1/software/packages/{id}`
pub async fn get(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::SOFTWARE_VIEW)?;
    let row = load(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Package"))?;
    let counts = installed_counts(&state, &ctx, std::slice::from_ref(&row)).await?;
    Ok(Json(row.to_json(counts.get(&id).copied().unwrap_or(0))))
}

/// `POST /api/v1/software/packages`
pub async fn create(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(body): Json<PackageBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    ctx.require_global(perm::SOFTWARE_LIBRARY)?;
    let checked = check_body(&state.db, &body).await?;
    let id = rustrmm_common::new_id();
    let now = rustrmm_common::now();
    sqlx::query(
        "INSERT INTO software_packages (id, name, publisher, description, platforms, source, detection, created_by, created_by_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&checked.name)
    .bind(body.publisher.trim())
    .bind(body.description.trim())
    .bind(serde_json::to_string(&checked.platforms)?)
    .bind(serde_json::to_string(&checked.source)?)
    .bind(serde_json::to_string(&body.detection)?)
    .bind(&ctx.user.id)
    .bind(&ctx.user.name)
    .bind(now)
    .bind(now)
    .execute(&state.db)
    .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("software.package_created")
                .target("software_package", &id, &checked.name)
                .details(
                    json!({ "source": checked.source.kind(), "platforms": checked.platforms }),
                ),
        )
        .await;
    let row = load(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::internal("package vanished"))?;
    Ok((StatusCode::CREATED, Json(row.to_json(0))))
}

/// `PUT /api/v1/software/packages/{id}`
pub async fn update(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(body): Json<PackageBody>,
) -> ApiResult<Json<Value>> {
    ctx.require_global(perm::SOFTWARE_LIBRARY)?;
    load(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Package"))?;
    let checked = check_body(&state.db, &body).await?;
    sqlx::query(
        "UPDATE software_packages SET name = ?, publisher = ?, description = ?, platforms = ?, source = ?, detection = ?, updated_at = ?
         WHERE id = ?",
    )
    .bind(&checked.name)
    .bind(body.publisher.trim())
    .bind(body.description.trim())
    .bind(serde_json::to_string(&checked.platforms)?)
    .bind(serde_json::to_string(&checked.source)?)
    .bind(serde_json::to_string(&body.detection)?)
    .bind(rustrmm_common::now())
    .bind(&id)
    .execute(&state.db)
    .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("software.package_updated")
                .target("software_package", &id, &checked.name)
                .details(
                    json!({ "source": checked.source.kind(), "platforms": checked.platforms }),
                ),
        )
        .await;
    let row = load(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::internal("package vanished"))?;
    let counts = installed_counts(&state, &ctx, std::slice::from_ref(&row)).await?;
    Ok(Json(row.to_json(counts.get(&id).copied().unwrap_or(0))))
}

/// `DELETE /api/v1/software/packages/{id}` — refused while a deployment of it is active.
pub async fn delete(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    ctx.require_global(perm::SOFTWARE_LIBRARY)?;
    let row = load(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Package"))?;
    let active: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM software_deployments WHERE package_id = ? AND status IN ('scheduled', 'running')",
    )
    .bind(&id)
    .fetch_one(&state.db)
    .await?;
    if active > 0 {
        return Err(ApiError::conflict(
            "package_in_use",
            "Cancel the active deployments of this package first",
        ));
    }
    sqlx::query("DELETE FROM software_packages WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("software.package_deleted")
                .target("software_package", &id, &row.name),
        )
        .await;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detection_rules_are_validated() {
        assert!(check_detection(&Detection::None).is_ok());
        assert!(
            check_detection(&Detection::SoftwareName {
                pattern: "7-Zip*".into(),
                min_version: Some("24.0".into())
            })
            .is_ok()
        );
        assert!(
            check_detection(&Detection::SoftwareName {
                pattern: " ".into(),
                min_version: None
            })
            .is_err()
        );
        assert!(
            check_detection(&Detection::File {
                path: r"C:\Program Files\7-Zip\7z.exe".into(),
                min_version: None
            })
            .is_ok()
        );
        assert!(
            check_detection(&Detection::File {
                path: "relative/7z".into(),
                min_version: None
            })
            .is_err()
        );
        assert!(
            check_detection(&Detection::Registry {
                key: r"HKLM\SOFTWARE\7-Zip".into(),
                value: Some("Path".into()),
                equals: None
            })
            .is_ok()
        );
        assert!(
            check_detection(&Detection::Registry {
                key: r"SOFTWARE\7-Zip".into(),
                value: None,
                equals: None
            })
            .is_err()
        );
        assert!(valid_manager_id("7zip.7zip"));
        assert!(!valid_manager_id("--source x"));
        assert!(clean_args("/qn /norestart", "a").is_ok());
        assert!(clean_args("/qn\n& calc", "a").is_err());
    }
}
