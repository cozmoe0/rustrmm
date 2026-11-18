//! Client contacts (`/contacts`) and CSV import.

use axum::Json;
use axum::extract::{FromRequest, Multipart, Path, Query, Request, State};
use axum::http::{StatusCode, header};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{QueryBuilder, Sqlite};

use crate::auth::AuthCtx;
use crate::db::Db;
use crate::error::{ApiError, ApiResult};
use crate::rbac::{ClientFilter, perm};
use crate::state::AppState;

const MAX_CSV_BYTES: usize = 5 * 1024 * 1024;
const MAX_CSV_ROWS: usize = 10_000;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ContactRow {
    pub id: String,
    pub client_id: String,
    pub client_name: String,
    pub site_id: Option<String>,
    pub site_name: Option<String>,
    pub name: String,
    pub email: String,
    pub phone: String,
    pub title: String,
    pub is_primary: bool,
    pub notify: bool,
    pub notes: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl ContactRow {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id, "client_id": self.client_id, "client_name": self.client_name,
            "site_id": self.site_id, "site_name": self.site_name, "name": self.name, "email": self.email,
            "phone": self.phone, "title": self.title, "is_primary": self.is_primary, "notify": self.notify,
            "notes": self.notes, "created_at": self.created_at, "updated_at": self.updated_at,
        })
    }
}

pub const SELECT: &str = "SELECT ct.id, ct.client_id, c.name AS client_name, ct.site_id, s.name AS site_name, ct.name, ct.email,
    ct.phone, ct.title, ct.is_primary, ct.notify, ct.notes, ct.created_at, ct.updated_at
    FROM contacts ct JOIN clients c ON c.id = ct.client_id LEFT JOIN sites s ON s.id = ct.site_id";

pub async fn load(db: &Db, id: &str) -> anyhow::Result<Option<ContactRow>> {
    Ok(
        sqlx::query_as(sqlx::AssertSqlSafe(format!("{SELECT} WHERE ct.id = ?")))
            .bind(id)
            .fetch_optional(db)
            .await?,
    )
}

/// Contacts with this e-mail address in any client: primary contacts first, then oldest.
pub async fn by_email(db: &Db, email: &str) -> anyhow::Result<Vec<ContactRow>> {
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{SELECT} WHERE ct.email = ? COLLATE NOCASE AND ct.email <> '' ORDER BY ct.is_primary DESC, ct.created_at, ct.id"
    )))
    .bind(email.trim())
    .fetch_all(db)
    .await?)
}

pub async fn by_email_in_client(
    db: &Db,
    client_id: &str,
    email: &str,
) -> anyhow::Result<Option<ContactRow>> {
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{SELECT} WHERE ct.client_id = ? AND ct.email = ? COLLATE NOCASE AND ct.email <> ''"
    )))
    .bind(client_id)
    .bind(email.trim())
    .fetch_optional(db)
    .await?)
}

// ------------------------------------------------------------------ CSV

/// Parses RFC 4180 CSV (quoted fields, doubled quotes, CRLF or LF, optional BOM). Blank lines
/// are skipped.
pub fn parse_csv(text: &str) -> Result<Vec<Vec<String>>, String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut rows = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut field_started = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            match c {
                '"' if chars.peek() == Some(&'"') => {
                    field.push('"');
                    chars.next();
                }
                '"' => quoted = false,
                _ => field.push(c),
            }
            continue;
        }
        match c {
            '"' if !field_started => {
                quoted = true;
                field_started = true;
            }
            '"' => return Err(format!("unexpected quote on line {}", rows.len() + 1)),
            ',' => {
                row.push(std::mem::take(&mut field));
                field_started = false;
            }
            '\r' => {}
            '\n' => {
                row.push(std::mem::take(&mut field));
                field_started = false;
                if !(row.len() == 1 && row[0].trim().is_empty()) {
                    rows.push(std::mem::take(&mut row));
                } else {
                    row.clear();
                }
            }
            _ => {
                field.push(c);
                field_started = true;
            }
        }
    }
    if quoted {
        return Err("unterminated quoted field".into());
    }
    if field_started || !row.is_empty() {
        row.push(field);
        if !(row.len() == 1 && row[0].trim().is_empty()) {
            rows.push(row);
        }
    }
    Ok(rows)
}

/// One contact line of an import file (1-based `row`, counting the header as row 1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportRow {
    pub row: usize,
    pub name: String,
    pub email: String,
    pub phone: String,
    pub title: String,
    pub site: String,
}

/// Maps CSV rows to contacts by the header row `name,email,phone,title,site` (any order,
/// case-insensitive, extra columns ignored). Returns the rows and per-row errors.
pub fn parse_import(text: &str) -> Result<(Vec<ImportRow>, Vec<(usize, String)>), String> {
    let rows = parse_csv(text)?;
    let mut iter = rows.into_iter();
    let header = iter.next().ok_or("the file is empty")?;
    let col = |name: &str| {
        header
            .iter()
            .position(|h| h.trim().eq_ignore_ascii_case(name))
    };
    let (name_col, email_col) = match (col("name"), col("email")) {
        (Some(n), Some(e)) => (n, e),
        _ => return Err("the header row must contain name and email columns".into()),
    };
    let (phone_col, title_col, site_col) = (col("phone"), col("title"), col("site"));
    let mut out = Vec::new();
    let mut errors = Vec::new();
    for (i, cells) in iter.enumerate() {
        let row = i + 2;
        if out.len() + errors.len() >= MAX_CSV_ROWS {
            errors.push((row, format!("only {MAX_CSV_ROWS} rows are imported")));
            break;
        }
        let get = |c: Option<usize>| {
            c.and_then(|c| cells.get(c))
                .map(|v| v.trim().to_string())
                .unwrap_or_default()
        };
        let item = ImportRow {
            row,
            name: get(Some(name_col)),
            email: get(Some(email_col)),
            phone: get(phone_col),
            title: get(title_col),
            site: get(site_col),
        };
        if item.name.is_empty() {
            errors.push((row, "name is required".into()));
        } else if item.name.chars().count() > 200 {
            errors.push((row, "name is longer than 200 characters".into()));
        } else if !crate::monitoring::settings::valid_email(&item.email) {
            errors.push((
                row,
                format!("'{}' is not a valid e-mail address", item.email),
            ));
        } else if item.phone.chars().count() > 64 || item.title.chars().count() > 120 {
            errors.push((row, "phone or title is too long".into()));
        } else {
            out.push(item);
        }
    }
    Ok((out, errors))
}

// ------------------------------------------------------------------ API

#[derive(Debug, Default, Deserialize)]
pub struct ListQuery {
    client_id: Option<String>,
    q: Option<String>,
    limit: Option<i64>,
}

/// `GET /api/v1/contacts?client_id=&q=`
#[utoipa::path(get, path = "/api/v1/contacts", tag = "Tickets", summary = "List contacts", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::TICKETS_VIEW)?;
    let mut qb = QueryBuilder::<Sqlite>::new(format!("{SELECT} WHERE 1 = 1"));
    if let ClientFilter::Only(ids) = ctx.scope.client_filter(perm::TICKETS_VIEW) {
        qb.push(" AND ct.client_id IN (");
        let mut sep = qb.separated(", ");
        sep.push_bind("");
        for id in ids {
            sep.push_bind(id);
        }
        qb.push(")");
    }
    super::push_in(&mut qb, "ct.client_id", &super::csv_param(&q.client_id));
    if let Some(text) = q.q.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        let like = super::like_pattern(text);
        qb.push(" AND (ct.name LIKE ")
            .push_bind(like.clone())
            .push(" ESCAPE '\\' OR ct.email LIKE ")
            .push_bind(like.clone())
            .push(" ESCAPE '\\' OR ct.phone LIKE ")
            .push_bind(like)
            .push(" ESCAPE '\\')");
    }
    qb.push(" ORDER BY c.name COLLATE NOCASE, ct.is_primary DESC, ct.name COLLATE NOCASE LIMIT ")
        .push_bind(q.limit.unwrap_or(500).clamp(1, 2000));
    let rows: Vec<ContactRow> = qb.build_query_as().fetch_all(&state.db).await?;
    Ok(Json(
        json!({ "items": rows.iter().map(ContactRow::to_json).collect::<Vec<_>>() }),
    ))
}

async fn visible_contact(
    state: &AppState,
    ctx: &AuthCtx,
    id: &str,
    permission: &str,
) -> ApiResult<ContactRow> {
    let row = load(&state.db, id)
        .await?
        .filter(|c| ctx.scope.can_see_client(perm::TICKETS_VIEW, &c.client_id))
        .ok_or_else(|| ApiError::not_found("Contact"))?;
    if !ctx.scope.can_see_client(permission, &row.client_id) {
        return Err(
            ApiError::forbidden(format!("Missing permission: {permission}"))
                .with_details(json!({ "permission": permission })),
        );
    }
    Ok(row)
}

/// `GET /api/v1/contacts/{id}`
#[utoipa::path(get, path = "/api/v1/contacts/{id}", tag = "Tickets", summary = "Get contact", params(("id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn get(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::TICKETS_VIEW)?;
    Ok(Json(
        visible_contact(&state, &ctx, &id, perm::TICKETS_VIEW)
            .await?
            .to_json(),
    ))
}

#[derive(Debug, Deserialize)]
pub struct ContactBody {
    #[serde(default)]
    client_id: Option<String>,
    #[serde(default)]
    site_id: Option<String>,
    name: String,
    #[serde(default)]
    email: String,
    #[serde(default)]
    phone: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    is_primary: bool,
    #[serde(default = "yes")]
    notify: bool,
    #[serde(default)]
    notes: String,
}

fn yes() -> bool {
    true
}

impl ContactBody {
    async fn validate(&mut self, db: &Db, client_id: &str) -> ApiResult<()> {
        self.name = self.name.trim().to_string();
        self.email = self.email.trim().to_string();
        if self.name.is_empty() || self.name.chars().count() > 200 {
            return Err(ApiError::validation("name must be 1–200 characters"));
        }
        if !self.email.is_empty() && !crate::monitoring::settings::valid_email(&self.email) {
            return Err(ApiError::validation("email is not a valid e-mail address"));
        }
        if self.phone.chars().count() > 64
            || self.title.chars().count() > 120
            || self.notes.chars().count() > 5000
        {
            return Err(ApiError::validation("phone, title or notes is too long"));
        }
        self.site_id = self.site_id.take().filter(|s| !s.is_empty());
        if let Some(site) = &self.site_id {
            let ok: Option<String> =
                sqlx::query_scalar("SELECT id FROM sites WHERE id = ? AND client_id = ?")
                    .bind(site)
                    .bind(client_id)
                    .fetch_optional(db)
                    .await?;
            if ok.is_none() {
                return Err(ApiError::validation("site_id is not a site of this client"));
            }
        }
        Ok(())
    }
}

fn require_manage(ctx: &AuthCtx, client_id: &str, site_id: Option<&str>) -> ApiResult<()> {
    let allowed = match site_id {
        Some(site) => ctx.scope.can_site(perm::TICKETS_MANAGE, client_id, site),
        None => ctx.scope.can_client(perm::TICKETS_MANAGE, client_id),
    };
    if allowed {
        Ok(())
    } else {
        Err(ApiError::forbidden("Missing permission: tickets.manage")
            .with_details(json!({ "permission": perm::TICKETS_MANAGE })))
    }
}

async fn clear_other_primaries(db: &Db, client_id: &str, keep: &str) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE contacts SET is_primary = 0 WHERE client_id = ? AND id <> ? AND is_primary = 1",
    )
    .bind(client_id)
    .bind(keep)
    .execute(db)
    .await?;
    Ok(())
}

/// `POST /api/v1/contacts`
#[utoipa::path(post, path = "/api/v1/contacts", tag = "Tickets", summary = "Create contact", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn create(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(mut body): Json<ContactBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    ctx.require(perm::TICKETS_MANAGE)?;
    let client_id = body
        .client_id
        .clone()
        .filter(|c| !c.is_empty())
        .ok_or_else(|| ApiError::validation("client_id is required"))?;
    if !ctx.scope.can_see_client(perm::TICKETS_VIEW, &client_id)
        && !ctx.scope.can_see_client(perm::TICKETS_MANAGE, &client_id)
    {
        return Err(ApiError::not_found("Client"));
    }
    body.validate(&state.db, &client_id).await?;
    require_manage(&ctx, &client_id, body.site_id.as_deref())?;
    let id = rustrmm_common::new_id();
    let now = rustrmm_common::now();
    sqlx::query("INSERT INTO contacts (id, client_id, site_id, name, email, phone, title, is_primary, notify, notes, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&id)
        .bind(&client_id)
        .bind(&body.site_id)
        .bind(&body.name)
        .bind(&body.email)
        .bind(&body.phone)
        .bind(&body.title)
        .bind(body.is_primary)
        .bind(body.notify)
        .bind(&body.notes)
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await
        .map_err(email_conflict)?;
    if body.is_primary {
        clear_other_primaries(&state.db, &client_id, &id).await?;
    }
    let row = load(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Contact"))?;
    Ok((StatusCode::CREATED, Json(row.to_json())))
}

fn email_conflict(e: sqlx::Error) -> ApiError {
    if let sqlx::Error::Database(db) = &e
        && db.is_unique_violation()
    {
        return ApiError::conflict(
            "contact_exists",
            "A contact with this e-mail address already exists for the client",
        );
    }
    ApiError::from(e)
}

/// `PUT /api/v1/contacts/{id}`
#[utoipa::path(put, path = "/api/v1/contacts/{id}", tag = "Tickets", summary = "Update contact", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn update(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(mut body): Json<ContactBody>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::TICKETS_MANAGE)?;
    let row = visible_contact(&state, &ctx, &id, perm::TICKETS_MANAGE).await?;
    if body
        .client_id
        .as_deref()
        .is_some_and(|c| !c.is_empty() && c != row.client_id)
    {
        return Err(ApiError::validation(
            "a contact cannot move to another client",
        ));
    }
    body.validate(&state.db, &row.client_id).await?;
    require_manage(&ctx, &row.client_id, body.site_id.as_deref())?;
    sqlx::query("UPDATE contacts SET site_id = ?, name = ?, email = ?, phone = ?, title = ?, is_primary = ?, notify = ?, notes = ?, updated_at = ? WHERE id = ?")
        .bind(&body.site_id)
        .bind(&body.name)
        .bind(&body.email)
        .bind(&body.phone)
        .bind(&body.title)
        .bind(body.is_primary)
        .bind(body.notify)
        .bind(&body.notes)
        .bind(rustrmm_common::now())
        .bind(&id)
        .execute(&state.db)
        .await
        .map_err(email_conflict)?;
    if body.is_primary {
        clear_other_primaries(&state.db, &row.client_id, &id).await?;
    }
    let row = load(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Contact"))?;
    Ok(Json(row.to_json()))
}

/// `DELETE /api/v1/contacts/{id}` (tickets keep their history; the contact reference clears).
#[utoipa::path(delete, path = "/api/v1/contacts/{id}", tag = "Tickets", summary = "Delete contact", params(("id" = String, Path)), responses((status = 204, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn delete(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    ctx.require(perm::TICKETS_MANAGE)?;
    let row = visible_contact(&state, &ctx, &id, perm::TICKETS_MANAGE).await?;
    require_manage(&ctx, &row.client_id, row.site_id.as_deref())?;
    sqlx::query("DELETE FROM contacts WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Default, Deserialize)]
pub struct ImportQuery {
    client_id: Option<String>,
}

/// `POST /api/v1/contacts/import?client_id=` — a `text/csv` body, or `multipart/form-data`
/// with a `file` field (and optionally `client_id`).
#[utoipa::path(post, path = "/api/v1/contacts/import", tag = "Tickets", summary = "Import", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn import(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<ImportQuery>,
    req: Request,
) -> ApiResult<Json<Value>> {
    let is_multipart = req
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.to_ascii_lowercase().starts_with("multipart/form-data"));
    let mut client_id = q.client_id.filter(|c| !c.is_empty());
    let data: Vec<u8> = if is_multipart {
        let mut multipart = Multipart::from_request(req, &state)
            .await
            .map_err(|e| ApiError::bad_request(e.body_text()))?;
        let mut file = None;
        while let Some(field) = multipart
            .next_field()
            .await
            .map_err(|e| ApiError::bad_request(e.body_text()))?
        {
            match field.name() {
                Some("client_id") => {
                    client_id = Some(
                        field
                            .text()
                            .await
                            .map_err(|e| ApiError::bad_request(e.body_text()))?,
                    )
                    .filter(|c| !c.is_empty())
                }
                Some("file") => {
                    let bytes = field
                        .bytes()
                        .await
                        .map_err(|e| ApiError::bad_request(e.body_text()))?;
                    if bytes.len() > MAX_CSV_BYTES {
                        return Err(ApiError::validation("the CSV file is larger than 5 MiB"));
                    }
                    file = Some(bytes.to_vec());
                }
                _ => {}
            }
        }
        file.ok_or_else(|| ApiError::validation("a file field is required"))?
    } else {
        axum::body::to_bytes(req.into_body(), MAX_CSV_BYTES)
            .await
            .map_err(|_| ApiError::validation("the CSV file is larger than 5 MiB"))?
            .to_vec()
    };
    let client_id = client_id.ok_or_else(|| ApiError::validation("client_id is required"))?;
    if !ctx.scope.can_see_client(perm::TICKETS_VIEW, &client_id) {
        return Err(ApiError::not_found("Client"));
    }
    ctx.require_client(perm::TICKETS_SETTINGS, &client_id)?;
    let client_name: String = sqlx::query_scalar("SELECT name FROM clients WHERE id = ?")
        .bind(&client_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| ApiError::not_found("Client"))?;
    let text =
        String::from_utf8(data).map_err(|_| ApiError::validation("the CSV file must be UTF-8"))?;
    let (rows, parse_errors) = parse_import(&text).map_err(ApiError::validation)?;
    let sites: Vec<(String, String)> =
        sqlx::query_as("SELECT id, name FROM sites WHERE client_id = ?")
            .bind(&client_id)
            .fetch_all(&state.db)
            .await?;
    let mut errors: Vec<Value> = parse_errors
        .into_iter()
        .map(|(row, message)| json!({ "row": row, "message": message }))
        .collect();
    let (mut created, mut updated) = (0u64, 0u64);
    let now = rustrmm_common::now();
    for item in rows {
        let site_id = if item.site.is_empty() {
            None
        } else {
            match sites
                .iter()
                .find(|(_, n)| n.eq_ignore_ascii_case(&item.site))
            {
                Some((id, _)) => Some(id.clone()),
                None => {
                    errors.push(json!({ "row": item.row, "message": format!("unknown site '{}'", item.site) }));
                    continue;
                }
            }
        };
        match by_email_in_client(&state.db, &client_id, &item.email).await? {
            Some(existing) => {
                sqlx::query("UPDATE contacts SET name = ?, phone = ?, title = ?, site_id = COALESCE(?, site_id), updated_at = ? WHERE id = ?")
                    .bind(&item.name)
                    .bind(&item.phone)
                    .bind(&item.title)
                    .bind(&site_id)
                    .bind(now)
                    .bind(&existing.id)
                    .execute(&state.db)
                    .await?;
                updated += 1;
            }
            None => {
                sqlx::query("INSERT INTO contacts (id, client_id, site_id, name, email, phone, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
                    .bind(rustrmm_common::new_id())
                    .bind(&client_id)
                    .bind(&site_id)
                    .bind(&item.name)
                    .bind(&item.email)
                    .bind(&item.phone)
                    .bind(&item.title)
                    .bind(now)
                    .bind(now)
                    .execute(&state.db)
                    .await?;
                created += 1;
            }
        }
    }
    errors.sort_by_key(|e| e["row"].as_u64());
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("contact.imported")
                .target("client", &client_id, &client_name)
                .client(&client_id)
                .details(json!({ "created": created, "updated": updated, "errors": errors.len() })),
        )
        .await;
    Ok(Json(
        json!({ "created": created, "updated": updated, "errors": errors }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_handles_quotes_bom_and_line_endings() {
        let rows = parse_csv(
            "\u{feff}name,email,notes\r\n\"Reyes, Dana\",dana@example.com,\"said \"\"hi\"\"\"\r\n\r\nBo,bo@example.com,\"multi\nline\"\nlast,l@example.com,",
        )
        .expect("csv");
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[0], vec!["name", "email", "notes"]);
        assert_eq!(
            rows[1],
            vec!["Reyes, Dana", "dana@example.com", "said \"hi\""]
        );
        assert_eq!(rows[2][2], "multi\nline");
        assert_eq!(rows[3], vec!["last", "l@example.com", ""]);
        assert!(parse_csv("a,\"unterminated").is_err());
        assert!(parse_csv("a,b\"c\n").is_err());
    }

    #[test]
    fn import_maps_headers_and_reports_row_errors() {
        let (rows, errors) = parse_import(
            "Email,Name,Site,Phone,Title,Extra\ndana@example.com,Dana Reyes,Main Office,555-0100,Office manager,x\nnot-an-email,Bad,,,,\n,,,,,\n,missing@example.com,,,,\n",
        )
        .expect("parsed");
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0],
            ImportRow {
                row: 2,
                name: "Dana Reyes".into(),
                email: "dana@example.com".into(),
                phone: "555-0100".into(),
                title: "Office manager".into(),
                site: "Main Office".into(),
            }
        );
        assert_eq!(errors.len(), 3);
        assert_eq!(errors[0].0, 3);
        assert!(errors[0].1.contains("not a valid"));
        assert_eq!(errors[1], (4, "name is required".to_string()));
        assert_eq!(errors[2].0, 5);
        assert!(parse_import("first,last\nx,y\n").is_err());
        assert!(parse_import("").is_err());
    }
}
