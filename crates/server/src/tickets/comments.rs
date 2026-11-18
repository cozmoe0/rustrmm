//! Comments (multipart upload with size and type limits), comment edits and attachment
//! downloads. Attachments live in the content-addressed store `<data dir>/files/<sha256>`.

use std::path::Path as FsPath;

use axum::Json;
use axum::body::Body;
use axum::extract::{FromRequest, Multipart, Path, Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;

use super::model::{self, NewComment, StoredFile, Who};
use crate::auth::AuthCtx;
use crate::error::{ApiError, ApiResult};
use crate::rbac::perm;
use crate::state::AppState;

/// Largest single attachment.
pub const MAX_FILE_BYTES: u64 = 25 * 1024 * 1024;
/// Files per comment.
pub const MAX_FILES: usize = 10;
/// Body limit of the comment route (all files plus the text).
pub const MAX_REQUEST_BYTES: usize = 110 * 1024 * 1024;
const MAX_BODY_CHARS: usize = 100_000;
/// Comments can be edited by their author for this long.
const EDIT_WINDOW_MINUTES: i64 = 15;

/// Accepted file extensions: common documents, images, logs and archives.
const ALLOWED_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif", "svg", "ico", "pdf",
    "txt", "log", "csv", "tsv", "md", "rtf", "json", "xml", "yaml", "yml", "ini", "conf", "cfg",
    "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "vsdx", "pages", "numbers",
    "key", "zip", "7z", "gz", "tgz", "tar", "rar", "eml", "msg", "mp4", "mov", "webm", "mp3",
    "wav", "m4a", "evtx", "etl", "dmp", "pcap", "pcapng", "har",
];

fn is_executable(head: &[u8]) -> bool {
    const MAGIC: &[&[u8]] = &[
        b"MZ",               // PE (exe, dll, scr, sys)
        b"\x7fELF",          // ELF
        b"\xfe\xed\xfa\xce", // Mach-O
        b"\xfe\xed\xfa\xcf",
        b"\xce\xfa\xed\xfe",
        b"\xcf\xfa\xed\xfe",
        b"\xca\xfe\xba\xbe", // universal Mach-O / Java class
        b"#!",               // scripts
    ];
    MAGIC.iter().any(|m| head.starts_with(m))
}

/// Checks a file by name and leading bytes; returns its content type.
pub fn check_file(name: &str, head: &[u8]) -> Result<String, String> {
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !ALLOWED_EXTENSIONS.contains(&ext.as_str()) {
        return Err(if ext.is_empty() {
            "files need an extension".into()
        } else {
            format!(".{ext} files are not accepted")
        });
    }
    if is_executable(head) {
        return Err("executables are not accepted".into());
    }
    Ok(mime_guess::from_path(name)
        .first_or_octet_stream()
        .essence_str()
        .to_string())
}

async fn place(state: &AppState, tmp: &FsPath, sha256: &str) -> anyhow::Result<()> {
    let files_dir = state.args.files_dir();
    tokio::fs::create_dir_all(&files_dir).await?;
    let target = files_dir.join(sha256);
    if tokio::fs::metadata(&target).await.is_ok() {
        let _ = tokio::fs::remove_file(tmp).await;
    } else if let Err(e) = tokio::fs::rename(tmp, &target).await {
        let _ = tokio::fs::remove_file(tmp).await;
        return Err(e.into());
    }
    Ok(())
}

/// Stores bytes in the blob store.
pub async fn store_bytes(
    state: &AppState,
    data: &[u8],
    file_name: &str,
    content_type: &str,
) -> anyhow::Result<StoredFile> {
    let sha256 = hex::encode(Sha256::digest(data));
    let tmp_dir = state.args.tmp_dir();
    tokio::fs::create_dir_all(&tmp_dir).await?;
    let tmp = tmp_dir.join(format!("ticket-{}.part", rustrmm_common::new_id()));
    tokio::fs::write(&tmp, data).await?;
    place(state, &tmp, &sha256).await?;
    Ok(StoredFile {
        sha256,
        size: data.len() as u64,
        file_name: file_name.to_string(),
        content_type: content_type.to_string(),
    })
}

/// Streams one multipart file field into the store, enforcing the limits.
async fn store_field(
    state: &AppState,
    mut field: axum::extract::multipart::Field<'_>,
) -> ApiResult<StoredFile> {
    let name = field
        .file_name()
        .and_then(crate::software::files::clean_file_name)
        .ok_or_else(|| ApiError::validation("every file needs a name"))?;
    check_file(&name, &[]).map_err(|e| ApiError::validation(format!("{name}: {e}")))?;
    let tmp_dir = state.args.tmp_dir();
    tokio::fs::create_dir_all(&tmp_dir)
        .await
        .map_err(ApiError::internal)?;
    let tmp = tmp_dir.join(format!("ticket-{}.part", rustrmm_common::new_id()));
    let result: ApiResult<(String, u64, String)> = async {
        let mut file = tokio::fs::File::create(&tmp)
            .await
            .map_err(ApiError::internal)?;
        let mut hasher = Sha256::new();
        let mut size: u64 = 0;
        let mut head: Vec<u8> = Vec::new();
        while let Some(chunk) = field
            .chunk()
            .await
            .map_err(|e| ApiError::bad_request(e.body_text()))?
        {
            size += chunk.len() as u64;
            if size > MAX_FILE_BYTES {
                return Err(ApiError::validation(format!(
                    "{name} is larger than 25 MiB"
                )));
            }
            if head.len() < 16 {
                head.extend_from_slice(&chunk[..chunk.len().min(16 - head.len())]);
            }
            hasher.update(&chunk);
            file.write_all(&chunk).await.map_err(ApiError::internal)?;
        }
        file.flush().await.map_err(ApiError::internal)?;
        if size == 0 {
            return Err(ApiError::validation(format!("{name} is empty")));
        }
        let content_type =
            check_file(&name, &head).map_err(|e| ApiError::validation(format!("{name}: {e}")))?;
        Ok((hex::encode(hasher.finalize()), size, content_type))
    }
    .await;
    match result {
        Ok((sha256, size, content_type)) => {
            place(state, &tmp, &sha256)
                .await
                .map_err(ApiError::internal)?;
            Ok(StoredFile {
                sha256,
                size,
                file_name: name,
                content_type,
            })
        }
        Err(e) => {
            let _ = tokio::fs::remove_file(&tmp).await;
            Err(e)
        }
    }
}

#[derive(Debug, Default, Deserialize)]
struct JsonComment {
    #[serde(default)]
    body: String,
    #[serde(default)]
    visibility: Option<String>,
}

/// `POST /api/v1/tickets/{id}/comments` — `multipart/form-data` (`body`, `visibility`,
/// repeated `files`) or JSON `{ body, visibility }`.
#[utoipa::path(post, path = "/api/v1/tickets/{id}/comments", tag = "Tickets", summary = "Create comment", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn create(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    req: Request,
) -> ApiResult<(StatusCode, Json<Value>)> {
    ctx.require(perm::TICKETS_MANAGE)?;
    let ticket = super::api::visible_ticket(&state, &ctx, &id, perm::TICKETS_MANAGE).await?;
    let content_type = req
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let (mut body, mut visibility, mut files) = (String::new(), None::<String>, Vec::new());
    if content_type.starts_with("multipart/form-data") {
        let mut multipart = Multipart::from_request(req, &state)
            .await
            .map_err(|e| ApiError::bad_request(e.body_text()))?;
        let mut stored: Vec<StoredFile> = Vec::new();
        let outcome: ApiResult<()> = async {
            while let Some(field) = multipart
                .next_field()
                .await
                .map_err(|e| ApiError::bad_request(e.body_text()))?
            {
                match field.name() {
                    Some("body") => {
                        body = field
                            .text()
                            .await
                            .map_err(|e| ApiError::bad_request(e.body_text()))?
                    }
                    Some("visibility") => {
                        visibility = Some(
                            field
                                .text()
                                .await
                                .map_err(|e| ApiError::bad_request(e.body_text()))?,
                        )
                    }
                    Some("files") | Some("files[]") => {
                        if stored.len() >= MAX_FILES {
                            return Err(ApiError::validation(format!(
                                "at most {MAX_FILES} files per comment"
                            )));
                        }
                        stored.push(store_field(&state, field).await?);
                    }
                    _ => {}
                }
            }
            Ok(())
        }
        .await;
        outcome?;
        files = stored;
    } else {
        let Json(parsed) = Json::<JsonComment>::from_request(req, &state)
            .await
            .map_err(|e| ApiError::bad_request(e.body_text()))?;
        body = parsed.body;
        visibility = parsed.visibility;
    }
    let visibility = visibility
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "internal".into());
    if !matches!(visibility.as_str(), "public" | "internal") {
        return Err(ApiError::validation(
            "visibility must be public or internal",
        ));
    }
    let body = body.trim().to_string();
    if body.is_empty() && files.is_empty() {
        return Err(ApiError::validation("a comment needs a body or files"));
    }
    if body.chars().count() > MAX_BODY_CHARS {
        return Err(ApiError::validation("body is at most 100000 characters"));
    }
    let comment = model::add_comment(
        &state,
        &ticket,
        NewComment {
            author: Who::user(&ctx),
            visibility,
            body,
            source: "console",
            email_message_id: None,
            files,
        },
    )
    .await?;
    Ok((StatusCode::CREATED, Json(comment)))
}

#[derive(Debug, Deserialize)]
pub struct EditBody {
    body: String,
}

/// `PATCH /api/v1/tickets/{id}/comments/{cid}` — the author, within 15 minutes.
#[utoipa::path(patch, path = "/api/v1/tickets/{id}/comments/{cid}", tag = "Tickets", summary = "Edit", params(("id" = String, Path), ("cid" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn edit(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path((id, cid)): Path<(String, String)>,
    Json(body): Json<EditBody>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::TICKETS_MANAGE)?;
    let ticket = super::api::visible_ticket(&state, &ctx, &id, perm::TICKETS_MANAGE).await?;
    let row = model::load_comment_row(&state.db, &cid)
        .await?
        .filter(|c| c.ticket_id == ticket.id)
        .ok_or_else(|| ApiError::not_found("Comment"))?;
    if row.author_type != "user" || row.author_id.as_deref() != Some(ctx.user.id.as_str()) {
        return Err(ApiError::forbidden("Only the author can edit a comment"));
    }
    if rustrmm_common::now() - row.created_at > chrono::Duration::minutes(EDIT_WINDOW_MINUTES) {
        return Err(ApiError::conflict(
            "edit_window_closed",
            "Comments can only be edited within 15 minutes",
        ));
    }
    let text = body.body.trim().to_string();
    if text.is_empty() || text.chars().count() > MAX_BODY_CHARS {
        return Err(ApiError::validation("body must be 1–100000 characters"));
    }
    sqlx::query("UPDATE ticket_comments SET body = ?, edited_at = ? WHERE id = ?")
        .bind(&text)
        .bind(rustrmm_common::now())
        .bind(&cid)
        .execute(&state.db)
        .await?;
    state.events.publish(
        "ticket.comment",
        Some(ticket.client_id.clone()),
        json!({ "ticket_id": ticket.id, "comment_id": cid, "visibility": row.visibility }),
    );
    let comment = model::load_comment(&state.db, &cid)
        .await?
        .ok_or_else(|| ApiError::not_found("Comment"))?;
    Ok(Json(comment))
}

fn encode_filename(name: &str) -> String {
    let mut out = String::new();
    for b in name.bytes() {
        if b.is_ascii_alphanumeric() || b"!#$&+.^_`|~-".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `GET /api/v1/tickets/attachments/{id}`
#[utoipa::path(get, path = "/api/v1/tickets/attachments/{id}", tag = "Tickets", summary = "Download", params(("id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn download(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    ctx.require(perm::TICKETS_VIEW)?;
    let row: Option<(String, String, i64, String, String)> = sqlx::query_as(
        "SELECT ticket_id, sha256, size_bytes, file_name, content_type FROM ticket_attachments WHERE id = ?",
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;
    let (ticket_id, sha256, size, file_name, content_type) =
        row.ok_or_else(|| ApiError::not_found("Attachment"))?;
    super::api::visible_ticket(&state, &ctx, &ticket_id, perm::TICKETS_VIEW)
        .await
        .map_err(|_| ApiError::not_found("Attachment"))?;
    let path = crate::software::files::stored_path(&state.args.files_dir(), &sha256)
        .ok_or_else(|| ApiError::not_found("Attachment"))?;
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|_| ApiError::not_found("Attachment"))?;
    let ascii: String = file_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || " .-_()".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, content_type),
            (header::CONTENT_LENGTH, size.to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!(
                    "attachment; filename=\"{ascii}\"; filename*=UTF-8''{}",
                    encode_filename(&file_name)
                ),
            ),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_string()),
            (header::CONTENT_SECURITY_POLICY, "sandbox".to_string()),
        ],
        Body::from_stream(ReaderStream::new(file)),
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_policy_accepts_documents_and_refuses_executables() {
        assert_eq!(
            check_file("report.pdf", b"%PDF-1.7").as_deref(),
            Ok("application/pdf")
        );
        assert_eq!(
            check_file("Screen Shot.PNG", b"\x89PNG").as_deref(),
            Ok("image/png")
        );
        assert!(check_file("logs.zip", b"PK\x03\x04").is_ok());
        assert!(check_file("setup.exe", b"MZ").is_err());
        assert!(check_file("script.ps1", b"Write-Host").is_err());
        assert!(check_file("noext", b"hello").is_err());
        // Renamed executables are caught by their magic bytes.
        assert_eq!(
            check_file("invoice.pdf", b"MZ\x90\x00"),
            Err("executables are not accepted".to_string())
        );
        assert!(check_file("notes.txt", b"\x7fELF\x02").is_err());
        assert!(check_file("run.txt", b"#!/bin/sh").is_err());
        assert_eq!(encode_filename("a b.pdf"), "a%20b.pdf");
    }
}
