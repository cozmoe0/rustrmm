//! Ticket e-mail: settings (`/settings/ticket-email`), reply-address tags, rendering and the
//! outbound queue (`ticket_email_outbox`) delivered through the Phase 6 SMTP client.

use std::time::Duration;

use axum::Json;
use axum::extract::State;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::canned::{self, Placeholders};
use super::markdown;
use super::model::{TicketRow, Who};
use crate::auth::AuthCtx;
use crate::error::{ApiError, ApiResult};
use crate::monitoring::notify::smtp;
use crate::monitoring::settings::{SECRET_PLACEHOLDER, valid_email};
use crate::rbac::perm;
use crate::state::AppState;

pub const KEY: &str = "ticket_email";
const IMAP_PASSWORD_AAD: &str = "settings/ticket_email/imap_password";
/// Customers reply above this line; everything from it down is quoted history.
pub const REPLY_MARKER: &str = "##- Please type your reply above this line -##";
/// Delays before the 2nd … 5th delivery attempt.
const RETRY_DELAYS: [i64; 4] = [30, 120, 600, 3600];
/// Attachments are e-mailed when they add up to at most this much.
const MAX_ATTACH_BYTES: i64 = 10 * 1024 * 1024;

// ------------------------------------------------------------------ settings

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Outbound {
    pub enabled: bool,
    pub notify_contact_on_create: bool,
    pub notify_on_public_comment: bool,
    pub notify_on_resolve: bool,
    pub notify_technician_on_assign: bool,
    /// Base reply address (`support@example.com`); tagged per ticket. Empty = the SMTP sender.
    pub reply_address: String,
}

impl Default for Outbound {
    fn default() -> Self {
        Self {
            enabled: true,
            notify_contact_on_create: true,
            notify_on_public_comment: true,
            notify_on_resolve: true,
            notify_technician_on_assign: true,
            reply_address: String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Inbound {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    /// `tls` | `starttls` (`none` only for loopback hosts).
    pub security: String,
    pub username: String,
    /// base64 of the field-encrypted password (never returned).
    pub password_enc: Option<String>,
    pub folder: String,
    pub processed_folder: String,
    /// `holding_queue` | `drop`
    pub unknown_sender: String,
}

impl Default for Inbound {
    fn default() -> Self {
        Self {
            enabled: false,
            host: String::new(),
            port: 993,
            security: "tls".into(),
            username: String::new(),
            password_enc: None,
            folder: "INBOX".into(),
            processed_folder: "Processed".into(),
            unknown_sender: "holding_queue".into(),
        }
    }
}

impl Inbound {
    pub fn password(&self, state: &AppState) -> anyhow::Result<Option<String>> {
        let Some(enc) = &self.password_enc else {
            return Ok(None);
        };
        let blob = STANDARD.decode(enc)?;
        Ok(Some(
            state
                .cipher
                .decrypt_string(&blob, IMAP_PASSWORD_AAD)?
                .to_string(),
        ))
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct EmailSettings {
    pub outbound: Outbound,
    pub inbound: Inbound,
    pub signature: String,
}

pub async fn load(state: &AppState) -> anyhow::Result<EmailSettings> {
    Ok(crate::db::get_setting(&state.db, KEY)
        .await?
        .unwrap_or_default())
}

fn public(state: &AppState, s: &EmailSettings) -> Value {
    let status = state.helpdesk.poll_status();
    json!({
        "outbound": s.outbound,
        "inbound": {
            "enabled": s.inbound.enabled, "host": s.inbound.host, "port": s.inbound.port,
            "security": s.inbound.security, "username": s.inbound.username,
            "password": s.inbound.password_enc.as_ref().map(|_| SECRET_PLACEHOLDER),
            "folder": s.inbound.folder, "processed_folder": s.inbound.processed_folder,
            "unknown_sender": s.inbound.unknown_sender,
        },
        "signature": s.signature,
        "inbound_status": {
            "last_poll_at": status.last_poll_at, "last_error": status.last_error,
            "last_processed": status.last_processed,
        },
    })
}

/// Whether a host is the local machine (plain IMAP is allowed only there).
pub fn is_loopback(host: &str) -> bool {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

fn valid_folder(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && name
            .chars()
            .all(|c| c.is_ascii() && !c.is_ascii_control() && c != '"' && c != '\\')
}

#[derive(Debug, Default, Deserialize)]
pub struct InboundBody {
    #[serde(default)]
    enabled: bool,
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
    folder: Option<String>,
    #[serde(default)]
    processed_folder: Option<String>,
    #[serde(default)]
    unknown_sender: Option<String>,
}

fn double_option<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<Option<String>>, D::Error> {
    Ok(Some(Option::<String>::deserialize(d)?))
}

#[derive(Debug, Default, Deserialize)]
pub struct SettingsBody {
    #[serde(default)]
    outbound: Option<Outbound>,
    #[serde(default)]
    inbound: Option<InboundBody>,
    #[serde(default)]
    signature: Option<String>,
}

/// Applies an inbound body onto stored settings. Returns whether the password changed.
fn apply_inbound(
    state: &AppState,
    target: &mut Inbound,
    body: InboundBody,
) -> Result<bool, String> {
    let host = body.host.trim().to_string();
    if !host.is_empty() && (host.len() > 253 || host.chars().any(|c| c.is_whitespace() || c == '/'))
    {
        return Err("inbound.host is not a valid host name".into());
    }
    let security = body.security.unwrap_or_else(|| "tls".into());
    if !matches!(security.as_str(), "tls" | "starttls" | "none") {
        return Err("inbound.security must be tls or starttls".into());
    }
    if security == "none" && !host.is_empty() && !is_loopback(&host) {
        return Err("inbound.security none is only allowed for a mail server on this host".into());
    }
    let port = body
        .port
        .unwrap_or(if security == "tls" { 993 } else { 143 });
    if port == 0 {
        return Err("inbound.port must be between 1 and 65535".into());
    }
    let folder = body
        .folder
        .unwrap_or_else(|| "INBOX".into())
        .trim()
        .to_string();
    let processed = body
        .processed_folder
        .unwrap_or_else(|| "Processed".into())
        .trim()
        .to_string();
    if !valid_folder(&folder) || !valid_folder(&processed) {
        return Err("folder names must be 1–200 ASCII characters without quotes".into());
    }
    if folder.eq_ignore_ascii_case(&processed) {
        return Err("folder and processed_folder must differ".into());
    }
    let unknown = body
        .unknown_sender
        .unwrap_or_else(|| "holding_queue".into());
    if !matches!(unknown.as_str(), "holding_queue" | "drop") {
        return Err("inbound.unknown_sender must be holding_queue or drop".into());
    }
    if body.username.len() > 256 || body.username.contains(['\r', '\n']) {
        return Err("inbound.username is too long".into());
    }
    if body.enabled && (host.is_empty() || body.username.trim().is_empty()) {
        return Err("inbound.host and inbound.username are required to enable polling".into());
    }
    target.enabled = body.enabled;
    target.host = host;
    target.port = port;
    target.security = security;
    target.username = body.username.trim().to_string();
    target.folder = folder;
    target.processed_folder = processed;
    target.unknown_sender = unknown;
    Ok(match body.password {
        None => false,
        Some(Some(p)) if p == SECRET_PLACEHOLDER => false,
        Some(None) => {
            target.password_enc = None;
            true
        }
        Some(Some(p)) if p.is_empty() => {
            target.password_enc = None;
            true
        }
        Some(Some(p)) => {
            if p.len() > 1024 || p.contains(['\r', '\n']) {
                return Err("inbound.password is too long".into());
            }
            target.password_enc =
                Some(STANDARD.encode(state.cipher.encrypt_str(&p, IMAP_PASSWORD_AAD)));
            true
        }
    })
}

/// `GET /api/v1/settings/ticket-email`
pub async fn get(State(state): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<Value>> {
    ctx.require_global(perm::TICKETS_SETTINGS)?;
    Ok(Json(public(&state, &load(&state).await?)))
}

/// `PUT /api/v1/settings/ticket-email` (step-up)
pub async fn put(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(body): Json<SettingsBody>,
) -> ApiResult<Json<Value>> {
    ctx.require_global(perm::TICKETS_SETTINGS)?;
    ctx.require_step_up()?;
    let mut settings = load(&state).await?;
    if let Some(mut outbound) = body.outbound {
        outbound.reply_address = outbound.reply_address.trim().to_string();
        if !outbound.reply_address.is_empty() && !valid_email(&outbound.reply_address) {
            return Err(ApiError::validation(
                "outbound.reply_address is not a valid e-mail address",
            ));
        }
        if outbound.reply_address.contains('+') {
            return Err(ApiError::validation(
                "outbound.reply_address must not contain '+' (tags are added per ticket)",
            ));
        }
        settings.outbound = outbound;
    }
    let mut password_changed = false;
    if let Some(inbound) = body.inbound {
        password_changed =
            apply_inbound(&state, &mut settings.inbound, inbound).map_err(ApiError::validation)?;
    }
    if let Some(signature) = body.signature {
        if signature.chars().count() > 10_000 {
            return Err(ApiError::validation(
                "signature is at most 10000 characters",
            ));
        }
        settings.signature = signature;
    }
    crate::db::set_setting(&state.db, KEY, &settings).await?;
    state.helpdesk.imap_wake.notify_one();
    let value = public(&state, &settings);
    let mut details = value.clone();
    details["inbound"]["password_changed"] = json!(password_changed);
    if let Some(obj) = details.as_object_mut() {
        obj.remove("inbound_status");
    }
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("ticket_settings.email_updated").details(details),
        )
        .await;
    Ok(Json(value))
}

#[derive(Debug, Default, Deserialize)]
pub struct TestBody {
    #[serde(default)]
    inbound: Option<InboundBody>,
}

/// `POST /api/v1/settings/ticket-email/test-imap` — logs in and selects the folder, with the
/// saved settings or the unsaved `inbound` in the body.
pub async fn test_imap(
    State(state): State<AppState>,
    ctx: AuthCtx,
    body: Option<Json<TestBody>>,
) -> ApiResult<Json<Value>> {
    ctx.require_global(perm::TICKETS_SETTINGS)?;
    let mut inbound = load(&state).await?.inbound;
    if let Some(Json(TestBody {
        inbound: Some(candidate),
    })) = body
    {
        apply_inbound(&state, &mut inbound, candidate).map_err(ApiError::validation)?;
    }
    if inbound.host.is_empty() || inbound.username.is_empty() {
        return Err(ApiError::conflict(
            "imap_not_configured",
            "Configure the IMAP server first",
        ));
    }
    let password = inbound.password(&state)?.unwrap_or_default();
    let outcome = super::imap::test_login(&inbound, &password).await;
    let (ok, error) = match &outcome {
        Ok(()) => (true, None),
        Err(e) => (false, Some(format!("{e:#}"))),
    };
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("ticket_settings.imap_tested").details(
                json!({ "host": inbound.host, "port": inbound.port, "ok": ok, "error": error }),
            ),
        )
        .await;
    Ok(Json(json!({ "ok": ok, "error": error })))
}

// ------------------------------------------------------------------ reply tags

/// `t<number>.<12 hex HMAC chars>`.
pub fn reply_tag(key: &[u8], number: i64) -> String {
    let mac =
        rustrmm_crypto::random::hmac_sha256_hex(key, format!("ticket-reply/{number}").as_bytes());
    format!("t{number}.{}", &mac[..12])
}

/// `support+t1042.<hmac>@example.com` from the base address.
pub fn tagged_address(base: &str, key: &[u8], number: i64) -> Option<String> {
    let (local, domain) = base.trim().rsplit_once('@')?;
    let local = local.split('+').next().filter(|l| !l.is_empty())?;
    Some(format!("{local}+{}@{domain}", reply_tag(key, number)))
}

/// The ticket number of a tagged address, when the tag verifies.
pub fn parse_tagged(key: &[u8], address: &str) -> Option<i64> {
    let (local, _domain) = address.trim().rsplit_once('@')?;
    let (_, tag) = local.split_once('+')?;
    let tag = tag.to_ascii_lowercase();
    let rest = tag.strip_prefix('t')?;
    let (number, mac) = rest.split_once('.')?;
    let number: i64 = number.parse().ok().filter(|n| *n > 0)?;
    let expected = reply_tag(key, number);
    rustrmm_crypto::random::ct_eq(expected.as_bytes(), format!("t{number}.{mac}").as_bytes())
        .then_some(number)
}

pub fn tag_key(state: &AppState) -> zeroize::Zeroizing<[u8; 32]> {
    state.master.derive("ticket-reply-tag")
}

/// `[#1042]` in a subject.
pub fn subject_number(subject: &str) -> Option<i64> {
    let mut rest = subject;
    while let Some(i) = rest.find("[#") {
        let after = &rest[i + 2..];
        if let Some(end) = after.find(']')
            && let Ok(n) = after[..end].trim().parse::<i64>()
            && n > 0
        {
            return Some(n);
        }
        rest = after;
    }
    None
}

// ------------------------------------------------------------------ rendering and queue

fn console_link(state: &AppState, ticket_id: &str) -> String {
    format!(
        "{}tickets/{ticket_id}",
        crate::monitoring::notify::delivery::console_base(state)
    )
}

fn subject_line(t: &TicketRow) -> String {
    format!("[#{}] {}", t.number, t.subject)
}

struct Rendered {
    text: String,
    html: String,
}

/// Wraps a Markdown body for a customer-facing message: reply marker, body, signature and
/// the ticket reference.
fn customer_message(
    t: &TicketRow,
    body_md: &str,
    signature_md: &str,
    notes: &[String],
) -> Rendered {
    let mut text = format!("{REPLY_MARKER}\n\n{body_md}\n");
    let mut html = format!(
        "<html><body style=\"font-family:sans-serif\"><p style=\"color:#999;font-size:12px\">{}</p>{}",
        markdown::escape(REPLY_MARKER),
        markdown::to_html(body_md)
    );
    for note in notes {
        text.push_str(&format!("\n{note}\n"));
        html.push_str(&format!(
            "<p style=\"color:#666\">{}</p>",
            markdown::escape(note)
        ));
    }
    if !signature_md.trim().is_empty() {
        text.push_str(&format!("\n--\n{signature_md}\n"));
        html.push_str(&format!("<hr>{}", markdown::to_html(signature_md)));
    }
    let reference = format!("Ticket #{}: {}", t.number, t.subject);
    text.push_str(&format!("\n{reference}\n"));
    html.push_str(&format!(
        "<p style=\"color:#999;font-size:12px\">{}</p></body></html>",
        markdown::escape(&reference)
    ));
    Rendered { text, html }
}

/// One message to queue.
struct Outgoing<'a> {
    event: &'static str,
    to: Vec<String>,
    cc: Vec<String>,
    rendered: Rendered,
    tagged: bool,
    attachment_ids: Vec<String>,
    ticket: &'a TicketRow,
}

async fn thread_root(state: &AppState, ticket_id: &str) -> anyhow::Result<Option<String>> {
    Ok(sqlx::query_scalar(
        "SELECT message_id FROM email_threads WHERE ticket_id = ? ORDER BY created_at, message_id LIMIT 1",
    )
    .bind(ticket_id)
    .fetch_optional(&state.db)
    .await?)
}

async fn enqueue(
    state: &AppState,
    settings: &EmailSettings,
    m: Outgoing<'_>,
) -> anyhow::Result<()> {
    let smtp = crate::monitoring::settings::load_smtp(state).await?;
    if !smtp.configured() {
        tracing::debug!(ticket = %m.ticket.id, event = m.event, "SMTP is not configured; ticket e-mail skipped");
        return Ok(());
    }
    let own = [
        smtp.from_address.as_str(),
        settings.outbound.reply_address.as_str(),
    ];
    let keep = |a: &String| {
        valid_email(a)
            && !own
                .iter()
                .any(|o| !o.is_empty() && o.eq_ignore_ascii_case(a))
    };
    let mut to: Vec<String> = m.to.into_iter().filter(keep).collect();
    to.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
    let cc: Vec<String> =
        m.cc.into_iter()
            .filter(keep)
            .filter(|c| !to.iter().any(|t| t.eq_ignore_ascii_case(c)))
            .collect();
    if to.is_empty() && cc.is_empty() {
        return Ok(());
    }
    let (to, cc) = if to.is_empty() {
        (cc, Vec::new())
    } else {
        (to, cc)
    };
    let domain = smtp
        .from_address
        .rsplit_once('@')
        .map(|(_, d)| d.to_string())
        .unwrap_or_else(|| "rustrmm.local".into());
    let message_id = format!(
        "ticket-{}-{}@{domain}",
        m.ticket.number,
        rustrmm_common::new_id()
    );
    let base = if settings.outbound.reply_address.is_empty() {
        smtp.from_address.clone()
    } else {
        settings.outbound.reply_address.clone()
    };
    let reply_to = if m.tagged {
        tagged_address(&base, &tag_key(state)[..], m.ticket.number)
    } else {
        None
    };
    let in_reply_to = thread_root(state, &m.ticket.id).await?;
    let now = rustrmm_common::now();
    sqlx::query(
        "INSERT INTO ticket_email_outbox (id, ticket_id, event, recipients, cc, subject, text_body, html_body, message_id,
            in_reply_to, reply_to, attachment_ids, status, attempts, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)",
    )
    .bind(rustrmm_common::new_id())
    .bind(&m.ticket.id)
    .bind(m.event)
    .bind(serde_json::to_string(&to)?)
    .bind(serde_json::to_string(&cc)?)
    .bind(subject_line(m.ticket))
    .bind(&m.rendered.text)
    .bind(&m.rendered.html)
    .bind(&message_id)
    .bind(&in_reply_to)
    .bind(&reply_to)
    .bind(serde_json::to_string(&m.attachment_ids)?)
    .bind(now)
    .bind(now)
    .execute(&state.db)
    .await?;
    sqlx::query("INSERT OR IGNORE INTO email_threads (message_id, ticket_id, direction, created_at) VALUES (?, ?, 'outbound', ?)")
        .bind(&message_id)
        .bind(&m.ticket.id)
        .bind(now)
        .execute(&state.db)
        .await?;
    state.helpdesk.kick_email();
    Ok(())
}

fn contact_address(t: &TicketRow) -> Option<String> {
    (t.contact_notify.unwrap_or(false))
        .then(|| t.contact_email.clone())
        .flatten()
        .filter(|e| !e.is_empty())
}

fn signature(settings: &EmailSettings, t: &TicketRow, technician: Option<&str>) -> String {
    canned::render(
        &settings.signature,
        &Placeholders::for_ticket(t, technician),
    )
}

async fn run(
    what: &str,
    ticket: &TicketRow,
    f: impl std::future::Future<Output = anyhow::Result<()>>,
) {
    if let Err(e) = f.await {
        tracing::warn!(ticket = %ticket.id, event = what, error = %format!("{e:#}"), "queueing a ticket e-mail failed");
    }
}

/// "We received your request" to the contact.
pub async fn on_created(state: &AppState, t: &TicketRow) {
    run("created", t, async {
        let settings = load(state).await?;
        if !settings.outbound.enabled || !settings.outbound.notify_contact_on_create {
            return Ok(());
        }
        let Some(to) = contact_address(t) else {
            return Ok(());
        };
        let body = format!(
            "We received your request and opened ticket **#{}**. Reply to this e-mail to add information.\n\n**{}**\n\n{}",
            t.number, t.subject, t.description
        );
        let rendered = customer_message(t, &body, &signature(&settings, t, None), &[]);
        enqueue(state, &settings, Outgoing {
            event: "created", to: vec![to], cc: Vec::new(), rendered, tagged: true,
            attachment_ids: Vec::new(), ticket: t,
        })
        .await
    })
    .await;
}

/// A public comment, to the contact and the CCs.
pub async fn on_public_comment(
    state: &AppState,
    t: &TicketRow,
    author: &Who,
    body: &str,
    attachment_ids: &[String],
) {
    run("comment", t, async {
        let settings = load(state).await?;
        if !settings.outbound.enabled || !settings.outbound.notify_on_public_comment {
            return Ok(());
        }
        let to: Vec<String> = contact_address(t).into_iter().collect();
        let cc = t.cc();
        if to.is_empty() && cc.is_empty() {
            return Ok(());
        }
        let mut notes = Vec::new();
        let mut attach = Vec::new();
        if !attachment_ids.is_empty() {
            let mut total = 0i64;
            let mut names = Vec::new();
            for id in attachment_ids {
                let row: Option<(String, i64)> = sqlx::query_as(
                    "SELECT file_name, size_bytes FROM ticket_attachments WHERE id = ?",
                )
                .bind(id)
                .fetch_optional(&state.db)
                .await?;
                if let Some((name, size)) = row {
                    total += size;
                    names.push(name);
                }
            }
            if total <= MAX_ATTACH_BYTES {
                attach = attachment_ids.to_vec();
            } else {
                notes.push(format!(
                    "Attachments too large to e-mail: {}",
                    names.join(", ")
                ));
            }
        }
        let technician = (author.kind == "user").then_some(author.name.as_str());
        let rendered = customer_message(t, body, &signature(&settings, t, technician), &notes);
        enqueue(
            state,
            &settings,
            Outgoing {
                event: "comment",
                to,
                cc,
                rendered,
                tagged: true,
                attachment_ids: attach,
                ticket: t,
            },
        )
        .await
    })
    .await;
}

/// Resolution notice to the contact.
pub async fn on_resolved(state: &AppState, t: &TicketRow) {
    run("resolved", t, async {
        let settings = load(state).await?;
        if !settings.outbound.enabled || !settings.outbound.notify_on_resolve {
            return Ok(());
        }
        let Some(to) = contact_address(t) else {
            return Ok(());
        };
        let body = format!(
            "Ticket **#{}** has been resolved.\n\nIf anything is still not right, reply to this e-mail and the ticket reopens.",
            t.number
        );
        let rendered = customer_message(t, &body, &signature(&settings, t, t.assignee_name.as_deref()), &[]);
        enqueue(state, &settings, Outgoing {
            event: "resolved", to: vec![to], cc: Vec::new(), rendered, tagged: true,
            attachment_ids: Vec::new(), ticket: t,
        })
        .await
    })
    .await;
}

/// Assignment notice to the technician (no reply tag).
pub async fn on_assigned(state: &AppState, t: &TicketRow) {
    run("assigned", t, async {
        let settings = load(state).await?;
        if !settings.outbound.enabled || !settings.outbound.notify_technician_on_assign {
            return Ok(());
        }
        let Some(to) = t.assignee_email.clone().filter(|e| !e.is_empty()) else {
            return Ok(());
        };
        let link = console_link(state, &t.id);
        let text = format!(
            "Ticket #{} was assigned to you.\n\nSubject: {}\nClient: {}\nPriority: {}\nStatus: {}\n\nOpen: {link}\n",
            t.number, t.subject, t.client_name, t.priority, t.status
        );
        let html = format!(
            "<html><body style=\"font-family:sans-serif\"><p>Ticket <strong>#{}</strong> was assigned to you.</p>\
             <table><tr><td style=\"color:#666;padding-right:12px\">Subject</td><td>{}</td></tr>\
             <tr><td style=\"color:#666;padding-right:12px\">Client</td><td>{}</td></tr>\
             <tr><td style=\"color:#666;padding-right:12px\">Priority</td><td>{}</td></tr></table>\
             <p><a href=\"{}\">Open the ticket</a></p></body></html>",
            t.number,
            markdown::escape(&t.subject),
            markdown::escape(&t.client_name),
            markdown::escape(&t.priority),
            markdown::escape(&link)
        );
        enqueue(state, &settings, Outgoing {
            event: "assigned", to: vec![to], cc: Vec::new(), rendered: Rendered { text, html },
            tagged: false, attachment_ids: Vec::new(), ticket: t,
        })
        .await
    })
    .await;
}

// ------------------------------------------------------------------ worker

pub fn spawn_worker(state: AppState) {
    tokio::spawn(async move {
        loop {
            if let Err(e) = process_due(&state).await {
                tracing::warn!(error = %format!("{e:#}"), "ticket e-mail pass failed");
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(5)) => {}
                _ = state.helpdesk.email_wake.notified() => {}
            }
        }
    });
}

#[derive(sqlx::FromRow)]
struct Due {
    id: String,
    ticket_id: Option<String>,
    recipients: String,
    cc: String,
    subject: String,
    text_body: String,
    html_body: String,
    message_id: String,
    in_reply_to: Option<String>,
    reply_to: Option<String>,
    attachment_ids: String,
    attempts: i64,
}

async fn attachments(state: &AppState, ids: &[String]) -> anyhow::Result<Vec<smtp::Attachment>> {
    let mut out = Vec::new();
    for id in ids {
        let row: Option<(String, String, String)> = sqlx::query_as(
            "SELECT sha256, file_name, content_type FROM ticket_attachments WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&state.db)
        .await?;
        let Some((sha, file_name, content_type)) = row else {
            continue;
        };
        let Some(path) = crate::software::files::stored_path(&state.args.files_dir(), &sha) else {
            continue;
        };
        let data = tokio::fs::read(&path).await?;
        out.push(smtp::Attachment {
            file_name,
            content_type,
            data,
        });
    }
    Ok(out)
}

/// Sends every due message.
pub async fn process_due(state: &AppState) -> anyhow::Result<()> {
    loop {
        let now = rustrmm_common::now();
        let due: Vec<Due> = sqlx::query_as(
            "SELECT id, ticket_id, recipients, cc, subject, text_body, html_body, message_id, in_reply_to, reply_to,
                    attachment_ids, attempts
             FROM ticket_email_outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 20",
        )
        .bind(now)
        .fetch_all(&state.db)
        .await?;
        if due.is_empty() {
            return Ok(());
        }
        let smtp_settings = crate::monitoring::settings::load_smtp(state).await?;
        let password = smtp_settings.password(state)?;
        let branding = crate::branding::load(state).await.unwrap_or_default();
        for item in due {
            let claimed = sqlx::query("UPDATE ticket_email_outbox SET status = 'sending' WHERE id = ? AND status = 'pending'")
                .bind(&item.id)
                .execute(&state.db)
                .await?
                .rows_affected();
            if claimed == 0 {
                continue;
            }
            let ids: Vec<String> = serde_json::from_str(&item.attachment_ids).unwrap_or_default();
            let result = async {
                let email = smtp::Email {
                    to: serde_json::from_str(&item.recipients).unwrap_or_default(),
                    cc: serde_json::from_str(&item.cc).unwrap_or_default(),
                    subject: item.subject.clone(),
                    text: item.text_body.clone(),
                    html: crate::branding::brand_email_html(state, &branding, &item.html_body),
                    reply_to: item.reply_to.clone(),
                    message_id: Some(item.message_id.clone()),
                    in_reply_to: item.in_reply_to.clone(),
                    attachments: attachments(state, &ids).await?,
                };
                smtp::send(&smtp_settings, password.as_deref(), &email).await
            }
            .await;
            let attempts = item.attempts + 1;
            match result {
                Ok(()) => {
                    sqlx::query("UPDATE ticket_email_outbox SET status = 'sent', attempts = ?, sent_at = ?, last_error = NULL WHERE id = ?")
                        .bind(attempts)
                        .bind(rustrmm_common::now())
                        .bind(&item.id)
                        .execute(&state.db)
                        .await?;
                }
                Err(e) => {
                    let error: String = format!("{e:#}").chars().take(1000).collect();
                    let delay = RETRY_DELAYS.get(attempts as usize - 1).copied();
                    match delay {
                        Some(secs) => {
                            sqlx::query("UPDATE ticket_email_outbox SET status = 'pending', attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?")
                                .bind(attempts)
                                .bind(&error)
                                .bind(rustrmm_common::now() + chrono::Duration::seconds(secs))
                                .bind(&item.id)
                                .execute(&state.db)
                                .await?;
                        }
                        None => {
                            sqlx::query("UPDATE ticket_email_outbox SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?")
                                .bind(attempts)
                                .bind(&error)
                                .bind(&item.id)
                                .execute(&state.db)
                                .await?;
                            if let Some(ticket) = &item.ticket_id {
                                let _ = super::model::activity(
                                    &state.db,
                                    ticket,
                                    &Who::system(),
                                    "email_failed",
                                    None,
                                    Some(&error),
                                )
                                .await;
                            }
                        }
                    }
                    tracing::warn!(outbox = %item.id, attempt = attempts, error = %error, "ticket e-mail delivery failed");
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reply_tags_verify_and_reject_forgeries() {
        let key = [7u8; 32];
        let tag = reply_tag(&key, 1042);
        assert!(tag.starts_with("t1042."));
        assert_eq!(tag.len(), "t1042.".len() + 12);
        let address = tagged_address("support@example.com", &key, 1042).expect("address");
        assert_eq!(address, format!("support+{tag}@example.com"));
        assert_eq!(parse_tagged(&key, &address), Some(1042));
        // Mail servers may change the case of the local part.
        assert_eq!(parse_tagged(&key, &address.to_uppercase()), Some(1042));
        // A tag for another number, another key or a tampered MAC fails.
        let forged = address.replace("t1042.", "t1043.");
        assert_eq!(parse_tagged(&key, &forged), None);
        assert_eq!(parse_tagged(&[8u8; 32], &address), None);
        let mut tampered = address.clone();
        tampered.replace_range(address.find('@').map(|i| i - 1..i).expect("at"), "z");
        assert_eq!(parse_tagged(&key, &tampered), None);
        assert_eq!(parse_tagged(&key, "support@example.com"), None);
        assert_eq!(parse_tagged(&key, "support+t0.abc@example.com"), None);
        // An existing tag in the base address is replaced.
        assert_eq!(
            tagged_address("support+old@example.com", &key, 7),
            Some(format!("support+{}@example.com", reply_tag(&key, 7)))
        );
        assert_eq!(tagged_address("nope", &key, 7), None);
    }

    #[test]
    fn subject_numbers_and_loopback() {
        assert_eq!(subject_number("Re: [#1042] Printer offline"), Some(1042));
        assert_eq!(subject_number("[#x] then [# 77 ]"), Some(77));
        assert_eq!(subject_number("No number here #12"), None);
        assert!(is_loopback("127.0.0.1"));
        assert!(is_loopback("localhost"));
        assert!(is_loopback("[::1]"));
        assert!(!is_loopback("mail.example.com"));
        assert!(!is_loopback("10.0.0.1"));
        assert!(valid_folder("INBOX/Processed"));
        assert!(!valid_folder("Bad\"Folder"));
    }
}
