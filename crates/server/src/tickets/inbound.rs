//! Inbound e-mail: loop protection, dedupe, threading (reply tag, In-Reply-To, `[#n]` plus a
//! known sender), quote stripping, new tickets from known contacts and unknown-sender handling.

use anyhow::Context;
use mail_parser::{Message, MessageParser};
use serde_json::json;

use super::email::{self, EmailSettings};
use super::model::{self, NewComment, NewTicket, StoredFile, TicketRow, Who};
use super::{comments, contacts, queues};
use crate::state::AppState;

pub const HOLDING_CLIENT_ID: &str = "builtin-unassigned-email";

/// What happened to a message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Comment { ticket_id: String },
    Ticket { ticket_id: String },
    Ignored(String),
    Dropped,
    Duplicate,
}

// ------------------------------------------------------------------ quote stripping

fn is_reply_header(line: &str, next: Option<&str>) -> bool {
    let l = line.trim();
    let joined = match next {
        Some(n) => format!("{l} {}", n.trim()),
        None => l.to_string(),
    };
    let ends_wrote = |s: &str| s.ends_with("wrote:") || s.ends_with("writes:");
    if l.starts_with("On ") && (ends_wrote(l) || ends_wrote(&joined)) {
        return true;
    }
    // Localised attributions ("Am … schrieb …:", "Le … a écrit :", "El … escribió:",
    // "Op … schreef …:"), on one line or wrapped onto the next.
    let lower = l.to_lowercase();
    let localized = |text: &str| {
        let t = text.to_lowercase();
        t.ends_with(':')
            && [
                ("am ", "schrieb"),
                ("le ", "a écrit"),
                ("el ", "escribió"),
                ("op ", "schreef"),
            ]
            .iter()
            .any(|(start, verb)| lower.starts_with(start) && t.contains(verb))
    };
    localized(l) || localized(&joined)
}

fn is_separator(lines: &[&str], i: usize) -> bool {
    let l = lines[i].trim();
    let lower = l.to_lowercase();
    if lower.contains("original message") && l.starts_with("---") {
        return true;
    }
    if l.contains("Please type your reply above this line") {
        return true;
    }
    let header_block = |start: usize| {
        let window: Vec<String> = lines
            .iter()
            .skip(start)
            .take(5)
            .map(|s| s.trim().to_lowercase())
            .collect();
        window.first().is_some_and(|f| f.starts_with("from:"))
            && window
                .iter()
                .any(|w| w.starts_with("sent:") || w.starts_with("date:"))
            && window
                .iter()
                .any(|w| w.starts_with("to:") || w.starts_with("subject:"))
    };
    if l.len() >= 20 && l.chars().all(|c| c == '_') {
        return lines
            .iter()
            .skip(i + 1)
            .find(|s| !s.trim().is_empty())
            .is_some_and(|s| s.trim().to_lowercase().starts_with("from:"));
    }
    lower.starts_with("from:") && header_block(i)
}

/// Removes quoted history below standard reply markers (conservatively: when nothing is left
/// the original text is kept).
pub fn strip_quoted(body: &str) -> String {
    let text = body.replace("\r\n", "\n");
    let lines: Vec<&str> = text.lines().collect();
    let mut cut = lines.len();
    for i in 0..lines.len() {
        if is_separator(&lines, i) || is_reply_header(lines[i], lines.get(i + 1).copied()) {
            cut = i;
            break;
        }
    }
    let mut kept: Vec<&str> = lines[..cut].to_vec();
    while kept
        .last()
        .is_some_and(|l| l.trim().is_empty() || l.trim_start().starts_with('>'))
    {
        kept.pop();
    }
    let result = kept.join("\n").trim().to_string();
    if result.is_empty() {
        text.trim().to_string()
    } else {
        result
    }
}

// ------------------------------------------------------------------ helpers

fn unbracket(id: &str) -> String {
    id.trim()
        .trim_start_matches('<')
        .trim_end_matches('>')
        .to_string()
}

fn message_key(msg: &Message<'_>, raw: &[u8]) -> String {
    msg.message_id()
        .map(unbracket)
        .filter(|id| !id.is_empty())
        .map(|id| id.chars().take(500).collect())
        .unwrap_or_else(|| format!("sha256:{}", rustrmm_crypto::random::sha256_hex(raw)))
}

fn header_text(msg: &Message<'_>, name: &str) -> Vec<String> {
    msg.headers()
        .all(name)
        .map(|h| String::from_utf8_lossy(h.raw_value()).trim().to_string())
        .collect()
}

/// Every recipient address: To, Cc, Delivered-To, X-Original-To, Envelope-To.
fn recipients(msg: &Message<'_>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for list in [msg.to(), msg.cc()].into_iter().flatten() {
        out.extend(
            list.mailboxes()
                .filter_map(|m| m.address().map(str::to_string)),
        );
    }
    for name in ["Delivered-To", "X-Original-To", "Envelope-To"] {
        for value in header_text(msg, name) {
            for part in value.split(',') {
                let a = unbracket(part);
                if a.contains('@') {
                    out.push(a);
                }
            }
        }
    }
    out.retain(|a| !a.is_empty());
    out.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
    out
}

fn same_mailbox(address: &str, base: &str) -> bool {
    let (Some((al, ad)), Some((bl, bd))) = (address.rsplit_once('@'), base.rsplit_once('@')) else {
        return false;
    };
    let al = al.split('+').next().unwrap_or(al);
    let bl = bl.split('+').next().unwrap_or(bl);
    !bl.is_empty() && al.eq_ignore_ascii_case(bl) && ad.eq_ignore_ascii_case(bd)
}

async fn own_addresses(state: &AppState, settings: &EmailSettings) -> anyhow::Result<Vec<String>> {
    let smtp = crate::monitoring::settings::load_smtp(state).await?;
    let mut own = vec![smtp.from_address];
    own.push(settings.outbound.reply_address.clone());
    own.push(settings.inbound.username.clone());
    own.retain(|a| a.contains('@'));
    Ok(own)
}

async fn record(
    state: &AppState,
    key: &str,
    from: &str,
    subject: &str,
    outcome: &str,
    ticket_id: Option<&str>,
    detail: &str,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT OR IGNORE INTO processed_emails (message_id, from_address, subject, outcome, ticket_id, detail, processed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(key)
    .bind(from.chars().take(320).collect::<String>())
    .bind(subject.chars().take(300).collect::<String>())
    .bind(outcome)
    .bind(ticket_id)
    .bind(detail.chars().take(1000).collect::<String>())
    .bind(rustrmm_common::now())
    .execute(&state.db)
    .await?;
    Ok(())
}

/// Saves the attachments of a message; refused types are listed in the returned notes.
async fn save_attachments(
    state: &AppState,
    msg: &Message<'_>,
) -> anyhow::Result<(Vec<StoredFile>, Vec<String>)> {
    let mut files = Vec::new();
    let mut skipped = Vec::new();
    for (i, part) in msg.attachments().enumerate().take(20) {
        let name = part
            .attachment_name()
            .and_then(crate::software::files::clean_file_name)
            .unwrap_or_else(|| {
                if part.is_message() {
                    format!("message-{}.eml", i + 1)
                } else {
                    format!("attachment-{}.bin", i + 1)
                }
            });
        let data = part.decoded();
        if data.is_empty() {
            continue;
        }
        if data.len() as u64 > comments::MAX_FILE_BYTES {
            skipped.push(format!("{name} (larger than 25 MiB)"));
            continue;
        }
        match comments::check_file(&name, &data) {
            Ok(content_type) => {
                files.push(comments::store_bytes(state, &data, &name, &content_type).await?)
            }
            Err(reason) => skipped.push(format!("{name} ({reason})")),
        }
    }
    Ok((files, skipped))
}

async fn holding_client(state: &AppState) -> anyhow::Result<String> {
    let now = rustrmm_common::now();
    sqlx::query(
        "INSERT OR IGNORE INTO clients (id, name, slug, notes, created_at, updated_at)
         VALUES (?, 'Unassigned e-mail', 'unassigned-email', 'Created by RustRMM for e-mail from unknown senders.', ?, ?)",
    )
    .bind(HOLDING_CLIENT_ID)
    .bind(now)
    .bind(now)
    .execute(&state.db)
    .await?;
    let id: Option<String> = sqlx::query_scalar("SELECT id FROM clients WHERE id = ?")
        .bind(HOLDING_CLIENT_ID)
        .fetch_optional(&state.db)
        .await?;
    id.context("a client named 'Unassigned e-mail' already exists, so the holding client cannot be created")
}

/// Finds the ticket a reply belongs to.
async fn thread(
    state: &AppState,
    msg: &Message<'_>,
    rcpts: &[String],
    sender: &str,
    subject: &str,
) -> anyhow::Result<Option<TicketRow>> {
    let key = email::tag_key(state);
    for address in rcpts {
        if let Some(number) = email::parse_tagged(&key[..], address)
            && let Some(t) = model::load_by_number(&state.db, number).await?
        {
            return Ok(Some(t));
        }
    }
    let mut parents: Vec<String> = Vec::new();
    for list in [msg.in_reply_to(), msg.references()].into_iter().flatten() {
        parents.extend(list.iter().map(unbracket));
    }
    for parent in parents.iter().take(50) {
        let ticket: Option<String> =
            sqlx::query_scalar("SELECT ticket_id FROM email_threads WHERE message_id = ?")
                .bind(parent)
                .fetch_optional(&state.db)
                .await?;
        if let Some(id) = ticket
            && let Some(t) = model::load(&state.db, &id).await?
        {
            return Ok(Some(t));
        }
    }
    if let Some(number) = email::subject_number(subject)
        && let Some(t) = model::load_by_number(&state.db, number).await?
    {
        let known = t
            .contact_email
            .as_deref()
            .is_some_and(|e| e.eq_ignore_ascii_case(sender))
            || t.cc().iter().any(|c| c.eq_ignore_ascii_case(sender))
            || contacts::by_email_in_client(&state.db, &t.client_id, sender)
                .await?
                .is_some();
        if known {
            return Ok(Some(t));
        }
    }
    Ok(None)
}

// ------------------------------------------------------------------ processing

/// Processes one raw message.
pub async fn process(
    state: &AppState,
    settings: &EmailSettings,
    raw: &[u8],
) -> anyhow::Result<Outcome> {
    let msg = MessageParser::new()
        .parse(raw)
        .context("the message could not be parsed")?;
    let key = message_key(&msg, raw);
    let seen: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM processed_emails WHERE message_id = ?")
            .bind(&key)
            .fetch_optional(&state.db)
            .await?;
    if seen.is_some() {
        return Ok(Outcome::Duplicate);
    }
    let subject = msg
        .subject()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "(no subject)".into());
    let Some((sender, sender_name)) = msg.from().and_then(|f| f.first()).and_then(|m| {
        m.address()
            .map(|a| (a.trim().to_string(), m.name().map(str::to_string)))
    }) else {
        record(state, &key, "", &subject, "ignored", None, "no sender").await?;
        return Ok(Outcome::Ignored("no sender".into()));
    };

    // Loop protection.
    let own = own_addresses(state, settings).await?;
    if own.iter().any(|o| same_mailbox(&sender, o)) {
        record(
            state,
            &key,
            &sender,
            &subject,
            "ignored",
            None,
            "sent by this server",
        )
        .await?;
        return Ok(Outcome::Ignored("sent by this server".into()));
    }
    if let Some(auto) = header_text(&msg, "Auto-Submitted").first()
        && auto.to_ascii_lowercase().starts_with("auto-")
    {
        record(
            state,
            &key,
            &sender,
            &subject,
            "ignored",
            None,
            "Auto-Submitted",
        )
        .await?;
        return Ok(Outcome::Ignored("automatic message".into()));
    }

    let rcpts = recipients(&msg);
    let body = msg.body_text(0).map(|b| b.to_string()).unwrap_or_default();
    let display = match &sender_name {
        Some(n) if !n.trim().is_empty() => format!("{} <{sender}>", n.trim()),
        _ => sender.clone(),
    };

    // A reply to an existing ticket.
    if let Some(ticket) = thread(state, &msg, &rcpts, &sender, &subject).await? {
        let ticket = model::resolve_merged(&state.db, ticket).await?;
        let contact = contacts::by_email_in_client(&state.db, &ticket.client_id, &sender).await?;
        let who = match &contact {
            Some(c) => Who::contact(Some(c.id.clone()), c.name.clone()),
            None => Who::contact(None, display.clone()),
        };
        let (files, skipped) = save_attachments(state, &msg).await?;
        let mut text = strip_quoted(&body);
        if !skipped.is_empty() {
            text.push_str(&format!(
                "\n\n_Attachments not accepted: {}_",
                skipped.join(", ")
            ));
        }
        if ticket.status == "closed" {
            // Closed tickets stay closed: the reply opens a follow-up ticket.
            let new = NewTicket {
                subject: ticket.subject.clone(),
                description: format!("Follow-up to #{} from {display}:\n\n{text}", ticket.number),
                client_id: ticket.client_id.clone(),
                site_id: ticket.site_id.clone(),
                contact_id: contact
                    .as_ref()
                    .map(|c| c.id.clone())
                    .or(ticket.contact_id.clone()),
                kind: "incident".into(),
                queue_id: ticket.queue_id.clone(),
                source: "email",
                ..NewTicket::default()
            };
            let created = model::create(state, new, &who).await?;
            model::link(&state.db, &created.id, "ticket", &ticket.id).await?;
            model::link(&state.db, &ticket.id, "ticket", &created.id).await?;
            attach_files(state, &created, files).await?;
            finish(state, &key, &sender, &subject, &msg, "ticket", &created.id).await?;
            return Ok(Outcome::Ticket {
                ticket_id: created.id,
            });
        }
        model::add_comment(
            state,
            &ticket,
            NewComment {
                author: who,
                visibility: "public".into(),
                body: text,
                source: "email",
                email_message_id: Some(key.clone()),
                files,
            },
        )
        .await?;
        finish(state, &key, &sender, &subject, &msg, "comment", &ticket.id).await?;
        return Ok(Outcome::Comment {
            ticket_id: ticket.id,
        });
    }

    // A new ticket.
    let contact = contacts::by_email(&state.db, &sender)
        .await?
        .into_iter()
        .next();
    let queue = queues::by_email(&state.db, &rcpts).await?;
    let (client_id, site_id, queue_id, who, description, cc) = match &contact {
        Some(c) => {
            let cc: Vec<String> = msg
                .cc()
                .map(|l| {
                    l.mailboxes()
                        .filter_map(|m| m.address().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            let cc: Vec<String> = cc
                .into_iter()
                .filter(|a| {
                    !own.iter().any(|o| same_mailbox(a, o)) && !a.eq_ignore_ascii_case(&sender)
                })
                .collect();
            (
                c.client_id.clone(),
                c.site_id.clone(),
                queue,
                Who::contact(Some(c.id.clone()), c.name.clone()),
                body.trim().to_string(),
                super::clean_cc(&cc).unwrap_or_default(),
            )
        }
        None if settings.inbound.unknown_sender == "drop" => {
            record(
                state,
                &key,
                &sender,
                &subject,
                "dropped",
                None,
                "unknown sender",
            )
            .await?;
            return Ok(Outcome::Dropped);
        }
        None => {
            let client = holding_client(state).await?;
            let holding = queues::ensure_holding(&state.db).await?;
            (
                client,
                None,
                Some(holding),
                Who::contact(None, display.clone()),
                format!("From: {display}\n\n{}", body.trim()),
                Vec::new(),
            )
        }
    };
    let (files, skipped) = save_attachments(state, &msg).await?;
    let mut description: String = description.chars().take(100_000).collect();
    if !skipped.is_empty() {
        description.push_str(&format!(
            "\n\n_Attachments not accepted: {}_",
            skipped.join(", ")
        ));
    }
    let new = NewTicket {
        subject: subject.chars().take(200).collect(),
        description,
        client_id,
        site_id,
        contact_id: contact.as_ref().map(|c| c.id.clone()),
        kind: "incident".into(),
        queue_id,
        cc,
        source: "email",
        ..NewTicket::default()
    };
    let created = model::create(state, new, &who).await?;
    attach_files(state, &created, files).await?;
    finish(state, &key, &sender, &subject, &msg, "ticket", &created.id).await?;
    Ok(Outcome::Ticket {
        ticket_id: created.id,
    })
}

/// Attachments of a new ticket go on an initial system comment.
async fn attach_files(
    state: &AppState,
    ticket: &TicketRow,
    files: Vec<StoredFile>,
) -> anyhow::Result<()> {
    if files.is_empty() {
        return Ok(());
    }
    model::add_comment(
        state,
        ticket,
        NewComment {
            author: Who::system(),
            visibility: "public".into(),
            body: "Attachments from the original e-mail.".into(),
            source: "email",
            email_message_id: None,
            files,
        },
    )
    .await?;
    Ok(())
}

async fn finish(
    state: &AppState,
    key: &str,
    sender: &str,
    subject: &str,
    msg: &Message<'_>,
    outcome: &str,
    ticket_id: &str,
) -> anyhow::Result<()> {
    record(state, key, sender, subject, outcome, Some(ticket_id), "").await?;
    if msg.message_id().is_some() {
        sqlx::query("INSERT OR IGNORE INTO email_threads (message_id, ticket_id, direction, created_at) VALUES (?, ?, 'inbound', ?)")
            .bind(key)
            .bind(ticket_id)
            .bind(rustrmm_common::now())
            .execute(&state.db)
            .await?;
    }
    tracing::info!(
        ticket = ticket_id,
        outcome,
        from = sender,
        "inbound ticket e-mail processed"
    );
    Ok(())
}

/// A message over the size limit (only its header was fetched).
pub async fn record_too_large(state: &AppState, header: &[u8], size: u64) -> anyhow::Result<()> {
    let parsed = MessageParser::new().parse(header);
    let (key, from, subject) = match &parsed {
        Some(msg) => (
            message_key(msg, header),
            msg.from()
                .and_then(|f| f.first())
                .and_then(|m| m.address().map(str::to_string))
                .unwrap_or_default(),
            msg.subject().unwrap_or_default().to_string(),
        ),
        None => (
            format!("sha256:{}", rustrmm_crypto::random::sha256_hex(header)),
            String::new(),
            String::new(),
        ),
    };
    tracing::warn!(from = %from, size, "skipped an inbound e-mail larger than 25 MiB");
    record(
        state,
        &key,
        &from,
        &subject,
        "too_large",
        None,
        &json!({ "size_bytes": size }).to_string(),
    )
    .await
}

pub async fn record_failure(state: &AppState, raw: &[u8], error: &str) {
    let key = match MessageParser::new().parse(raw) {
        Some(msg) => message_key(&msg, raw),
        None => format!("sha256:{}", rustrmm_crypto::random::sha256_hex(raw)),
    };
    let _ = record(state, &key, "", "", "failed", None, error).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gmail_style_quotes_are_stripped() {
        let body = "Thanks, it works now.\n\nOn Mon, Nov 16, 2026 at 10:00 AM Support <support@example.com> wrote:\n> Please restart the printer.\n> \n";
        assert_eq!(strip_quoted(body), "Thanks, it works now.");
        // The attribution line may wrap.
        let wrapped = "Still broken.\r\n\r\nOn Mon, Nov 16, 2026 at 10:00 AM Support Team <\r\nsupport@example.com> wrote:\r\n> old";
        assert_eq!(strip_quoted(wrapped), "Still broken.");
    }

    #[test]
    fn outlook_and_marker_quotes_are_stripped() {
        let outlook = "See attached.\n\n________________________________\nFrom: Support <support@example.com>\nSent: Monday, November 16, 2026 10:00\nTo: Dana\nSubject: [#1042] Printer\n\nOld text";
        assert_eq!(strip_quoted(outlook), "See attached.");
        let original = "Done\n-----Original Message-----\nFrom: x";
        assert_eq!(strip_quoted(original), "Done");
        let header_block = "Yes please.\n\nFrom: Support <support@example.com>\nDate: Mon, 16 Nov 2026\nSubject: Re: thing\n\nold";
        assert_eq!(strip_quoted(header_block), "Yes please.");
        let marker = format!("New info here\n\n{}\nold body", email::REPLY_MARKER);
        assert_eq!(strip_quoted(&marker), "New info here");
        let german = "Danke!\n\nAm 16.11.2026 um 10:00 schrieb Support <s@example.com>:\n> alt";
        assert_eq!(strip_quoted(german), "Danke!");
    }

    #[test]
    fn stripping_is_conservative() {
        // Inline answers between quotes are kept; only the quoted tail goes.
        let inline = "> Is the printer on?\nYes.\n> Is it plugged in?\nAlso yes.\n> thanks\n";
        assert_eq!(
            strip_quoted(inline),
            "> Is the printer on?\nYes.\n> Is it plugged in?\nAlso yes."
        );
        // A message that is nothing but quotes is kept as is.
        assert_eq!(strip_quoted("> only quoted"), "> only quoted");
        // A sentence mentioning "from:" is not a header block.
        let prose = "The error came from: the spooler.\nPlease check.";
        assert_eq!(strip_quoted(prose), prose);
        // "On" without "wrote:" is ordinary text.
        assert_eq!(
            strip_quoted("On Monday it failed again."),
            "On Monday it failed again."
        );
    }

    #[test]
    fn mailbox_comparison_ignores_tags() {
        assert!(same_mailbox(
            "Support+t1042.abc@Example.com",
            "support@example.com"
        ));
        assert!(!same_mailbox("dana@example.com", "support@example.com"));
        assert!(!same_mailbox("support@other.com", "support@example.com"));
    }
}
