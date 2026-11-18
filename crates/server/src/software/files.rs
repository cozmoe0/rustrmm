//! Uploaded installers: content-addressed storage in `<data dir>/files/<sha256>`, single-use
//! device-bound download tokens, and the agent download route.

use std::path::{Path, PathBuf};

use axum::Json;
use axum::body::Body;
use axum::extract::{Path as UrlPath, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use futures::{Stream, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio_util::io::ReaderStream;

use crate::auth::AuthCtx;
use crate::db::Db;
use crate::error::{ApiError, ApiResult};
use crate::rbac::perm;
use crate::state::AppState;

/// Largest accepted upload.
pub const MAX_UPLOAD: u64 = 4 * 1024 * 1024 * 1024;
/// Download tokens expire after this long.
pub const TOKEN_TTL_MINUTES: i64 = 60;
/// Header the agent sends with its device id (must match the token).
pub const DEVICE_HEADER: &str = "x-rustrmm-device-id";

pub fn valid_sha256(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// Path of a stored file.
pub fn stored_path(files_dir: &Path, sha256: &str) -> Option<PathBuf> {
    valid_sha256(sha256).then(|| files_dir.join(sha256))
}

/// Decodes `%XX` escapes (UTF-8); `+` stays a plus sign.
pub fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(hex) = raw.get(i + 1..i + 3)
            && let Ok(b) = u8::from_str_radix(hex, 16)
        {
            out.push(b);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A file name for display: the last path component, without control characters.
pub fn clean_file_name(raw: &str) -> Option<String> {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or(raw);
    let name: String = base.chars().filter(|c| !c.is_control()).take(255).collect();
    let name = name.trim().to_string();
    (!name.is_empty() && name != "." && name != "..").then_some(name)
}

#[derive(Debug, thiserror::Error)]
pub enum UploadError {
    #[error("the body is larger than Content-Length")]
    TooLarge,
    #[error("the body is shorter than Content-Length")]
    Truncated,
    #[error("upload interrupted: {0}")]
    Interrupted(String),
    #[error("storage error: {0}")]
    Io(#[from] std::io::Error),
}

/// Streams a body to `tmp`, hashing as it goes. The body must be exactly `expected` bytes.
pub async fn write_hashed<S, E>(
    mut body: S,
    tmp: &Path,
    expected: u64,
) -> Result<(String, u64), UploadError>
where
    S: Stream<Item = Result<Bytes, E>> + Unpin,
    E: std::fmt::Display,
{
    let mut file = tokio::fs::File::create(tmp).await?;
    let mut hasher = Sha256::new();
    let mut size: u64 = 0;
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(|e| UploadError::Interrupted(e.to_string()))?;
        size += chunk.len() as u64;
        if size > expected {
            return Err(UploadError::TooLarge);
        }
        hasher.update(&chunk);
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    file.sync_all().await?;
    if size != expected {
        return Err(UploadError::Truncated);
    }
    Ok((hex::encode(hasher.finalize()), size))
}

/// `POST /api/v1/software/files` — raw body with `X-File-Name` and `Content-Length`.
pub async fn upload(
    State(state): State<AppState>,
    ctx: AuthCtx,
    headers: HeaderMap,
    body: Body,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::SOFTWARE_LIBRARY)?;
    let file_name = headers
        .get("x-file-name")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .and_then(|n| clean_file_name(&n))
        .ok_or_else(|| ApiError::validation("X-File-Name is required"))?;
    let size: u64 = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| ApiError::validation("Content-Length is required"))?;
    if size == 0 {
        return Err(ApiError::validation("The file is empty"));
    }
    if size > MAX_UPLOAD {
        return Err(ApiError::validation(
            "Files larger than 4 GiB cannot be uploaded",
        ));
    }
    let tmp_dir = state.args.tmp_dir();
    tokio::fs::create_dir_all(&tmp_dir)
        .await
        .map_err(ApiError::internal)?;
    let tmp = tmp_dir.join(format!("upload-{}.part", rustrmm_common::new_id()));
    let written = write_hashed(body.into_data_stream(), &tmp, size).await;
    let (sha256, size) = match written {
        Ok(v) => v,
        Err(e) => {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(match e {
                UploadError::Io(io) => ApiError::internal(io),
                other => ApiError::bad_request(other.to_string()),
            });
        }
    };
    let files_dir = state.args.files_dir();
    tokio::fs::create_dir_all(&files_dir)
        .await
        .map_err(ApiError::internal)?;
    let target = files_dir.join(&sha256);
    if tokio::fs::metadata(&target).await.is_ok() {
        // Same content already stored.
        let _ = tokio::fs::remove_file(&tmp).await;
    } else if let Err(e) = tokio::fs::rename(&tmp, &target).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(ApiError::internal(e));
    }
    let existing: Option<String> =
        sqlx::query_scalar("SELECT id FROM software_files WHERE sha256 = ? AND file_name = ?")
            .bind(&sha256)
            .bind(&file_name)
            .fetch_optional(&state.db)
            .await?;
    let file_id = match existing {
        Some(id) => id,
        None => {
            let id = rustrmm_common::new_id();
            sqlx::query("INSERT INTO software_files (id, sha256, size_bytes, file_name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
                .bind(&id)
                .bind(&sha256)
                .bind(size as i64)
                .bind(&file_name)
                .bind(&ctx.user.id)
                .bind(rustrmm_common::now())
                .execute(&state.db)
                .await?;
            id
        }
    };
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("software.file_uploaded")
                .target("software_file", &file_id, &file_name)
                .details(json!({ "sha256": sha256, "size_bytes": size })),
        )
        .await;
    Ok(Json(
        json!({ "file_id": file_id, "sha256": sha256, "size_bytes": size, "file_name": file_name }),
    ))
}

// ------------------------------------------------------------------ download tokens

fn token_hash(token: &str) -> String {
    rustrmm_crypto::random::sha256_hex(token.as_bytes())
}

/// Issues a single-use token for `device_id` to fetch `sha256`, valid for one hour. Only the
/// hash is stored; the token travels inside the signed command.
pub async fn issue_token(
    db: &Db,
    device_id: &str,
    sha256: &str,
    deployment_id: Option<&str>,
) -> anyhow::Result<String> {
    let token = rustrmm_crypto::random::token();
    let now = rustrmm_common::now();
    sqlx::query("INSERT INTO file_download_tokens (token_hash, device_id, sha256, deployment_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(token_hash(&token))
        .bind(device_id)
        .bind(sha256)
        .bind(deployment_id)
        .bind(now)
        .bind(now + chrono::Duration::minutes(TOKEN_TTL_MINUTES))
        .execute(db)
        .await?;
    Ok(token)
}

/// Consumes a token: true exactly once, for the device and file it was issued for, before it
/// expires.
pub async fn consume_token(
    db: &Db,
    token: &str,
    device_id: &str,
    sha256: &str,
) -> anyhow::Result<bool> {
    let now = rustrmm_common::now();
    let used = sqlx::query(
        "UPDATE file_download_tokens SET used_at = ? WHERE token_hash = ? AND device_id = ? AND sha256 = ?
           AND used_at IS NULL AND expires_at > ?",
    )
    .bind(now)
    .bind(token_hash(token))
    .bind(device_id)
    .bind(sha256)
    .bind(now)
    .execute(db)
    .await?
    .rows_affected();
    Ok(used == 1)
}

/// Deletes tokens that expired more than a day ago.
pub async fn purge_tokens(db: &Db) -> anyhow::Result<()> {
    sqlx::query("DELETE FROM file_download_tokens WHERE expires_at < ?")
        .bind(rustrmm_common::now() - chrono::Duration::days(1))
        .execute(db)
        .await?;
    Ok(())
}

/// The URL path the agent fetches (relative to the gateway it is connected to).
pub fn download_path(sha256: &str, token: &str) -> String {
    format!("/agent/v1/files/{sha256}?token={token}")
}

/// Parses a single `bytes=start-end` range against a file size.
pub fn parse_range(value: &str, size: u64) -> Option<(u64, u64)> {
    let spec = value.trim().strip_prefix("bytes=")?;
    if spec.contains(',') || size == 0 {
        return None;
    }
    let (start, end) = spec.split_once('-')?;
    let (start, end) = match (start.trim(), end.trim()) {
        ("", suffix) => {
            let n: u64 = suffix.parse().ok()?;
            if n == 0 {
                return None;
            }
            (size.saturating_sub(n), size - 1)
        }
        (s, "") => (s.parse().ok()?, size - 1),
        (s, e) => (s.parse().ok()?, e.parse::<u64>().ok()?.min(size - 1)),
    };
    (start <= end && start < size).then_some((start, end))
}

#[derive(Deserialize)]
pub struct DownloadQuery {
    #[serde(default)]
    token: String,
}

fn refused() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({ "error": { "code": "forbidden", "message": "Invalid, expired or already used download token" } })),
    )
        .into_response()
}

/// `GET /agent/v1/files/{sha256}?token=…` (agent listener only).
pub async fn agent_download(
    State(state): State<AppState>,
    UrlPath(sha256): UrlPath<String>,
    Query(q): Query<DownloadQuery>,
    headers: HeaderMap,
) -> Response {
    let Some(path) = stored_path(&state.args.files_dir(), &sha256) else {
        return refused();
    };
    let Some(device_id) = headers.get(DEVICE_HEADER).and_then(|v| v.to_str().ok()) else {
        return refused();
    };
    if q.token.is_empty() || !state.agents.is_online(device_id) {
        return refused();
    }
    match consume_token(&state.db, &q.token, device_id, &sha256).await {
        Ok(true) => {}
        Ok(false) => {
            tracing::warn!(device = device_id, file = %sha256, "refused a file download with an invalid or used token");
            return refused();
        }
        Err(e) => return ApiError::internal(format!("{e:#}")).into_response(),
    }
    let Ok(mut file) = tokio::fs::File::open(&path).await else {
        return ApiError::not_found("File").into_response();
    };
    let size = file.metadata().await.map(|m| m.len()).unwrap_or(0);
    let range = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|v| parse_range(v, size));
    match range {
        Some(None) => (
            StatusCode::RANGE_NOT_SATISFIABLE,
            [(header::CONTENT_RANGE, format!("bytes */{size}"))],
        )
            .into_response(),
        Some(Some((start, end))) => {
            if file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
                return ApiError::internal("seek failed").into_response();
            }
            let len = end - start + 1;
            (
                StatusCode::PARTIAL_CONTENT,
                [
                    (header::CONTENT_TYPE, "application/octet-stream".to_string()),
                    (header::CONTENT_LENGTH, len.to_string()),
                    (header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}")),
                    (header::ACCEPT_RANGES, "bytes".to_string()),
                ],
                Body::from_stream(ReaderStream::new(file.take(len))),
            )
                .into_response()
        }
        None => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "application/octet-stream".to_string()),
                (header::CONTENT_LENGTH, size.to_string()),
                (header::ACCEPT_RANGES, "bytes".to_string()),
            ],
            Body::from_stream(ReaderStream::new(file)),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn db_with_device() -> Db {
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
        for id in ["d1", "d2"] {
            sqlx::query("INSERT INTO devices (id, site_id, status, hostname, os_family, public_key, enrolled_at, created_at, updated_at)
                         VALUES (?, 's1', 'active', ?, 'windows', ?, ?, ?, ?)")
                .bind(id)
                .bind(id)
                .bind(format!("key-{id}"))
                .bind(now)
                .bind(now)
                .bind(now)
                .execute(&db)
                .await
                .expect("device");
        }
        db
    }

    #[tokio::test]
    async fn download_tokens_are_single_use_device_bound_and_expire() {
        let db = db_with_device().await;
        let sha = "a".repeat(64);
        let token = issue_token(&db, "d1", &sha, None).await.expect("token");
        assert!(
            !consume_token(&db, &token, "d2", &sha)
                .await
                .expect("other device")
        );
        assert!(
            !consume_token(&db, &token, "d1", &"b".repeat(64))
                .await
                .expect("other file")
        );
        assert!(
            consume_token(&db, &token, "d1", &sha)
                .await
                .expect("first use")
        );
        assert!(
            !consume_token(&db, &token, "d1", &sha)
                .await
                .expect("second use")
        );
        assert!(
            !consume_token(&db, "forged", "d1", &sha)
                .await
                .expect("forged")
        );
        let stale = issue_token(&db, "d1", &sha, None).await.expect("token");
        sqlx::query("UPDATE file_download_tokens SET expires_at = ? WHERE used_at IS NULL")
            .bind(rustrmm_common::now() - chrono::Duration::seconds(1))
            .execute(&db)
            .await
            .expect("expire");
        assert!(
            !consume_token(&db, &stale, "d1", &sha)
                .await
                .expect("expired")
        );
        let stored: Vec<String> = sqlx::query_scalar("SELECT token_hash FROM file_download_tokens")
            .fetch_all(&db)
            .await
            .expect("rows");
        assert!(stored.iter().all(|h| h != &token), "only hashes are stored");
    }

    #[tokio::test]
    async fn uploads_are_hashed_while_streaming_and_size_checked() {
        let dir = tempfile::tempdir().expect("dir");
        let tmp = dir.path().join("upload.part");
        let chunks: Vec<Result<Bytes, std::io::Error>> = vec![
            Ok(Bytes::from_static(b"hello ")),
            Ok(Bytes::from_static(b"world")),
        ];
        let (sha, size) = write_hashed(futures::stream::iter(chunks), &tmp, 11)
            .await
            .expect("written");
        assert_eq!(size, 11);
        assert_eq!(sha, rustrmm_crypto::random::sha256_hex(b"hello world"));
        assert_eq!(std::fs::read(&tmp).expect("file"), b"hello world");
        let long: Vec<Result<Bytes, std::io::Error>> = vec![Ok(Bytes::from_static(b"too long"))];
        assert!(matches!(
            write_hashed(futures::stream::iter(long), &tmp, 3).await,
            Err(UploadError::TooLarge)
        ));
        let short: Vec<Result<Bytes, std::io::Error>> = vec![Ok(Bytes::from_static(b"ab"))];
        assert!(matches!(
            write_hashed(futures::stream::iter(short), &tmp, 3).await,
            Err(UploadError::Truncated)
        ));
    }

    #[test]
    fn ranges_names_and_hashes() {
        assert_eq!(parse_range("bytes=0-9", 100), Some((0, 9)));
        assert_eq!(parse_range("bytes=90-", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=50-500", 100), Some((50, 99)));
        assert_eq!(parse_range("bytes=100-", 100), None);
        assert_eq!(parse_range("bytes=0-1,5-6", 100), None);
        assert_eq!(parse_range("items=0-1", 100), None);
        assert_eq!(clean_file_name(r"C:\x\7z.msi").as_deref(), Some("7z.msi"));
        assert_eq!(percent_decode("7z%202409+x64.msi"), "7z 2409+x64.msi");
        assert_eq!(percent_decode("caf%C3%A9.exe"), "café.exe");
        assert_eq!(percent_decode("100%.exe"), "100%.exe");
        assert_eq!(percent_decode("x%4"), "x%4");
        assert_eq!(clean_file_name("../.."), None);
        assert!(valid_sha256(&"0".repeat(64)));
        assert!(!valid_sha256(&"A".repeat(64)));
        assert!(!valid_sha256("../etc/passwd"));
    }
}
