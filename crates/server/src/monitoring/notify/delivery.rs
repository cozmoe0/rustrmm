//! Rendering and delivering notifications: one formatter per channel kind, a database-backed
//! queue in `notification_log` (one row per attempt) and a worker that retries failures after
//! 10 s, 60 s and 300 s.

use std::time::Duration;

use chrono::{DateTime, Utc};
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::Sha256;

use super::channels::{self, Channel};
use super::ssrf::{self, Allowlist};
use crate::state::AppState;

/// Delays before the 2nd, 3rd and 4th attempt.
pub const RETRY_DELAYS: [i64; 3] = [10, 60, 300];
pub const MAX_ATTEMPTS: i64 = 1 + RETRY_DELAYS.len() as i64;
/// Deliveries running at the same time.
const PARALLEL: usize = 8;

/// The rendered message: alert facts only, never secrets or script content.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Payload {
    pub event: String,
    pub alert_id: Option<String>,
    pub title: String,
    pub severity: String,
    pub status: String,
    pub source: String,
    pub check_id: String,
    pub check_type: String,
    pub message: String,
    pub hostname: Option<String>,
    pub client_name: String,
    pub site_name: Option<String>,
    pub opened_at: Option<DateTime<Utc>>,
    pub last_occurrence_at: Option<DateTime<Utc>>,
    pub resolved_at: Option<DateTime<Utc>>,
    pub occurrences: i64,
    pub link: Option<String>,
    pub sent_at: DateTime<Utc>,
}

fn severity_label(severity: &str) -> &'static str {
    match severity {
        "critical" => "CRITICAL",
        "warning" => "WARNING",
        _ => "INFO",
    }
}

fn event_label(event: &str) -> &'static str {
    match event {
        "opened" => "Alert opened",
        "severity_changed" => "Severity changed",
        "resolved" => "Alert resolved",
        "escalated" => "Escalated: still unacknowledged",
        "test" => "Test notification",
        _ => "Alert update",
    }
}

impl Payload {
    pub fn sample(state: &AppState) -> Self {
        let now = rustrmm_common::now();
        Self {
            event: "test".into(),
            alert_id: None,
            title: "Test notification from RustRMM".into(),
            severity: "info".into(),
            status: "open".into(),
            source: "server".into(),
            check_id: "test".into(),
            check_type: "test".into(),
            message: "If you can read this, the channel works.".into(),
            hostname: Some("EXAMPLE-PC".into()),
            client_name: "Example client".into(),
            site_name: Some("Main office".into()),
            opened_at: Some(now),
            last_occurrence_at: Some(now),
            resolved_at: None,
            occurrences: 1,
            link: Some(format!("{}alerts", console_base(state))),
            sent_at: now,
        }
    }

    fn headline(&self) -> String {
        format!("[{}] {}", severity_label(&self.severity), self.title)
    }

    fn place(&self) -> String {
        match &self.site_name {
            Some(site) => format!("{} / {site}", self.client_name),
            None => self.client_name.clone(),
        }
    }

    fn facts(&self) -> Vec<(&'static str, String)> {
        let mut facts = vec![
            ("Event", event_label(&self.event).to_string()),
            ("Severity", severity_label(&self.severity).to_string()),
            (
                "Device",
                self.hostname.clone().unwrap_or_else(|| "—".into()),
            ),
            ("Client / site", self.place()),
        ];
        if let Some(t) = self.opened_at {
            facts.push(("Opened", t.format("%Y-%m-%d %H:%M UTC").to_string()));
        }
        if let Some(t) = self.resolved_at {
            facts.push(("Resolved", t.format("%Y-%m-%d %H:%M UTC").to_string()));
        }
        if self.occurrences > 1 {
            facts.push(("Occurrences", self.occurrences.to_string()));
        }
        facts
    }

    pub fn text(&self) -> String {
        let mut out = format!("{}\n{}\n", self.headline(), self.message);
        for (k, v) in self.facts() {
            out.push_str(&format!("{k}: {v}\n"));
        }
        if let Some(link) = &self.link {
            out.push_str(&format!("Open: {link}\n"));
        }
        out
    }
}

pub fn console_base(state: &AppState) -> String {
    let base = state.args.console_url.to_string();
    if base.ends_with('/') {
        base
    } else {
        format!("{base}/")
    }
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn escape_slack(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

pub fn slack_body(p: &Payload) -> Value {
    let mut text = format!(
        "*{}*\n{}",
        escape_slack(&p.headline()),
        escape_slack(&p.message)
    );
    for (k, v) in p.facts() {
        text.push_str(&format!("\n*{k}:* {}", escape_slack(&v)));
    }
    let mut blocks = vec![json!({ "type": "section", "text": { "type": "mrkdwn", "text": text } })];
    if let Some(link) = &p.link {
        blocks.push(json!({ "type": "actions", "elements": [
            { "type": "button", "text": { "type": "plain_text", "text": "Open alert" }, "url": link }
        ] }));
    }
    json!({ "text": p.headline(), "blocks": blocks })
}

pub fn teams_body(p: &Payload) -> Value {
    let color = match p.severity.as_str() {
        "critical" => "Attention",
        "warning" => "Warning",
        _ => "Accent",
    };
    let facts: Vec<Value> = p
        .facts()
        .into_iter()
        .map(|(k, v)| json!({ "title": k, "value": v }))
        .collect();
    let mut card = json!({
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "type": "AdaptiveCard",
        "version": "1.4",
        "body": [
            { "type": "TextBlock", "text": p.headline(), "weight": "Bolder", "size": "Medium", "color": color, "wrap": true },
            { "type": "TextBlock", "text": p.message, "wrap": true },
            { "type": "FactSet", "facts": facts }
        ]
    });
    if let Some(link) = &p.link {
        card["actions"] = json!([{ "type": "Action.OpenUrl", "title": "Open alert", "url": link }]);
    }
    json!({ "type": "message", "attachments": [
        { "contentType": "application/vnd.microsoft.card.adaptive", "contentUrl": null, "content": card }
    ] })
}

pub fn discord_body(p: &Payload) -> Value {
    let color = match (p.event.as_str(), p.severity.as_str()) {
        ("resolved", _) => 0x2e_cc_71,
        (_, "critical") => 0xe7_4c_3c,
        (_, "warning") => 0xf3_9c_12,
        _ => 0x34_98_db,
    };
    let fields: Vec<Value> = p
        .facts()
        .into_iter()
        .map(|(k, v)| json!({ "name": k, "value": v, "inline": true }))
        .collect();
    let mut embed = json!({
        "title": p.headline().chars().take(256).collect::<String>(),
        "description": p.message.chars().take(2000).collect::<String>(),
        "color": color,
        "fields": fields,
        "timestamp": p.sent_at.to_rfc3339(),
    });
    if let Some(link) = &p.link {
        embed["url"] = json!(link);
    }
    json!({ "username": "RustRMM", "embeds": [embed], "allowed_mentions": { "parse": [] } })
}

pub fn ntfy_priority(p: &Payload) -> u8 {
    match (p.event.as_str(), p.severity.as_str()) {
        ("resolved", _) => 2,
        (_, "critical") => 5,
        (_, "warning") => 4,
        _ => 3,
    }
}

pub fn ntfy_body(p: &Payload, topic: &str) -> Value {
    let tag = match (p.event.as_str(), p.severity.as_str()) {
        ("resolved", _) => "white_check_mark",
        (_, "critical") => "rotating_light",
        (_, "warning") => "warning",
        _ => "information_source",
    };
    let mut body = json!({
        "topic": topic,
        "title": p.headline(),
        "message": format!("{}\n{} · {}", p.message, p.hostname.clone().unwrap_or_default(), p.place()),
        "priority": ntfy_priority(p),
        "tags": [tag],
    });
    if let Some(link) = &p.link {
        body["click"] = json!(link);
    }
    body
}

pub fn webhook_body(p: &Payload) -> Value {
    json!({ "event": p.event, "alert": p, "sent_at": p.sent_at })
}

/// `sha256=<hex HMAC-SHA256 of the body>`
pub fn signature(secret: &str, body: &[u8]) -> String {
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(secret.as_bytes())
        .expect("HMAC accepts any key length");
    mac.update(body);
    format!("sha256={}", hex::encode(mac.finalize().into_bytes()))
}

pub fn email_message(p: &Payload, to: Vec<String>, cc: Vec<String>) -> super::smtp::Email {
    let mut rows = String::new();
    for (k, v) in p.facts() {
        rows.push_str(&format!(
            "<tr><td style=\"padding:2px 12px 2px 0;color:#666\">{}</td><td>{}</td></tr>",
            escape_html(k),
            escape_html(&v)
        ));
    }
    let link = p
        .link
        .as_ref()
        .map(|l| format!("<p><a href=\"{}\">Open alert</a></p>", escape_html(l)))
        .unwrap_or_default();
    super::smtp::Email {
        to,
        cc,
        subject: p.headline(),
        text: p.text(),
        html: format!(
            "<html><body style=\"font-family:sans-serif\"><h3>{}</h3><p>{}</p><table>{rows}</table>{link}</body></html>",
            escape_html(&p.headline()),
            escape_html(&p.message)
        ),
        ..Default::default()
    }
}

/// A failed attempt.
#[derive(Debug, Clone)]
pub struct Failure {
    pub status: Option<u16>,
    pub message: String,
}

impl Failure {
    fn new(message: impl Into<String>) -> Self {
        Self {
            status: None,
            message: message.into(),
        }
    }
}

fn str_of<'a>(channel: &'a Channel, key: &str) -> &'a str {
    channel
        .config
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
}

/// Sends one payload through one channel. Returns the HTTP status for webhook kinds.
pub async fn send(
    state: &AppState,
    channel: &Channel,
    payload: &Payload,
) -> Result<Option<u16>, Failure> {
    let settings = crate::monitoring::settings::load(state)
        .await
        .map_err(|e| Failure::new(format!("{e:#}")))?;
    let allow = Allowlist::new(&settings.webhook_allowlist);
    let json_post = |url: String, body: Value, headers: Vec<(String, String)>| {
        let allow = allow.clone();
        async move {
            let bytes = serde_json::to_vec(&body).map_err(|e| Failure::new(e.to_string()))?;
            post(&url, &allow, headers, bytes).await
        }
    };
    match channel.kind.as_str() {
        "slack" => {
            json_post(
                str_of(channel, "webhook_url").to_string(),
                slack_body(payload),
                Vec::new(),
            )
            .await
        }
        "teams" => {
            json_post(
                str_of(channel, "webhook_url").to_string(),
                teams_body(payload),
                Vec::new(),
            )
            .await
        }
        "discord" => {
            json_post(
                str_of(channel, "webhook_url").to_string(),
                discord_body(payload),
                Vec::new(),
            )
            .await
        }
        "ntfy" => {
            let mut headers = Vec::new();
            if let Some(token) = channel.config.get("token").and_then(Value::as_str) {
                headers.push(("Authorization".to_string(), format!("Bearer {token}")));
            }
            let server = str_of(channel, "server_url")
                .trim_end_matches('/')
                .to_string();
            json_post(
                format!("{server}/"),
                ntfy_body(payload, str_of(channel, "topic")),
                headers,
            )
            .await
        }
        "webhook" => {
            let body = serde_json::to_vec(&webhook_body(payload))
                .map_err(|e| Failure::new(e.to_string()))?;
            let mut headers: Vec<(String, String)> = channel
                .config
                .get("headers")
                .and_then(Value::as_object)
                .map(|h| {
                    h.iter()
                        .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string())))
                        .collect()
                })
                .unwrap_or_default();
            headers.push(("X-RustRMM-Event".into(), payload.event.clone()));
            if let Some(secret) = channel.config.get("secret").and_then(Value::as_str) {
                headers.push(("X-RustRMM-Signature".into(), signature(secret, &body)));
            }
            post(str_of(channel, "url"), &allow, headers, body).await
        }
        "email" => {
            let smtp = crate::monitoring::settings::load_smtp(state)
                .await
                .map_err(|e| Failure::new(format!("{e:#}")))?;
            if !smtp.configured() {
                return Err(Failure::new("SMTP is not configured"));
            }
            let password = smtp
                .password(state)
                .map_err(|e| Failure::new(format!("{e:#}")))?;
            let list = |key: &str| -> Vec<String> {
                channel
                    .config
                    .get(key)
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default()
            };
            let mut message = email_message(payload, list("to"), list("cc"));
            if let Ok(branding) = crate::branding::load(state).await {
                message.html = crate::branding::brand_email_html(state, &branding, &message.html);
            }
            super::smtp::send(&smtp, password.as_deref(), &message)
                .await
                .map(|()| None)
                .map_err(|e| Failure::new(format!("{e:#}")))
        }
        other => Err(Failure::new(format!("unknown channel kind {other}"))),
    }
}

async fn post(
    url: &str,
    allow: &Allowlist,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
) -> Result<Option<u16>, Failure> {
    match ssrf::post(url, allow, &headers, "application/json", body).await {
        Ok(r) if r.ok() => Ok(Some(r.status)),
        Ok(r) => Err(Failure {
            status: Some(r.status),
            message: format!(
                "HTTP {}{}",
                r.status,
                if r.body.trim().is_empty() {
                    String::new()
                } else {
                    format!(": {}", r.body.trim().chars().take(200).collect::<String>())
                }
            ),
        }),
        Err(e) => Err(Failure::new(format!("{e:#}"))),
    }
}

async fn mark_channel(state: &AppState, channel_id: &str, error: Option<&str>) {
    let _ = sqlx::query(
        "UPDATE notification_channels SET last_used_at = ?, last_error = ? WHERE id = ?",
    )
    .bind(rustrmm_common::now())
    .bind(error)
    .bind(channel_id)
    .execute(&state.db)
    .await;
}

/// Synchronous test delivery (logged, not retried).
pub async fn deliver_test(
    state: &AppState,
    channel: &Channel,
    payload: &Payload,
) -> Result<Option<u16>, Failure> {
    let outcome = send(state, channel, payload).await;
    let (status, http, error) = match &outcome {
        Ok(s) => ("sent", *s, None),
        Err(f) => ("failed", f.status, Some(f.message.clone())),
    };
    let now = rustrmm_common::now();
    let _ = sqlx::query("INSERT INTO notification_log (id, delivery_id, alert_id, channel_id, channel_name, channel_kind, rule_id, event, attempt, status, http_status, error, payload, created_at, finished_at)
                         VALUES (?, ?, NULL, ?, ?, ?, NULL, 'test', 1, ?, ?, ?, ?, ?, ?)")
        .bind(rustrmm_common::new_id())
        .bind(rustrmm_common::new_id())
        .bind(&channel.id)
        .bind(&channel.name)
        .bind(&channel.kind)
        .bind(status)
        .bind(http.map(i64::from))
        .bind(&error)
        .bind(serde_json::to_string(payload).unwrap_or_default())
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await;
    mark_channel(state, &channel.id, error.as_deref()).await;
    outcome
}

/// Queues a delivery (first attempt due now) and wakes the worker.
pub async fn enqueue(
    state: &AppState,
    channel: &Channel,
    rule_id: Option<&str>,
    payload: &Payload,
) -> anyhow::Result<()> {
    let now = rustrmm_common::now();
    sqlx::query("INSERT INTO notification_log (id, delivery_id, alert_id, channel_id, channel_name, channel_kind, rule_id, event, attempt, status, payload, created_at, next_attempt_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending', ?, ?, ?)")
        .bind(rustrmm_common::new_id())
        .bind(rustrmm_common::new_id())
        .bind(&payload.alert_id)
        .bind(&channel.id)
        .bind(&channel.name)
        .bind(&channel.kind)
        .bind(rule_id)
        .bind(&payload.event)
        .bind(serde_json::to_string(payload)?)
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await?;
    state.monitoring.kick_delivery();
    Ok(())
}

/// Records a notification that quiet hours (or similar) held back.
pub async fn record_suppressed(
    state: &AppState,
    channel: &Channel,
    rule_id: Option<&str>,
    payload: &Payload,
    reason: &str,
) -> anyhow::Result<()> {
    let now = rustrmm_common::now();
    sqlx::query("INSERT INTO notification_log (id, delivery_id, alert_id, channel_id, channel_name, channel_kind, rule_id, event, attempt, status, error, payload, created_at, finished_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'suppressed', ?, ?, ?, ?)")
        .bind(rustrmm_common::new_id())
        .bind(rustrmm_common::new_id())
        .bind(&payload.alert_id)
        .bind(&channel.id)
        .bind(&channel.name)
        .bind(&channel.kind)
        .bind(rule_id)
        .bind(&payload.event)
        .bind(reason)
        .bind(serde_json::to_string(payload)?)
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await?;
    Ok(())
}

#[derive(sqlx::FromRow)]
struct Due {
    id: String,
    delivery_id: String,
    alert_id: Option<String>,
    channel_id: Option<String>,
    channel_name: String,
    channel_kind: String,
    rule_id: Option<String>,
    event: String,
    attempt: i64,
    payload: String,
}

/// Runs the delivery worker until the process ends.
pub fn spawn_worker(state: AppState) {
    tokio::spawn(async move {
        loop {
            if let Err(e) = process_due(&state).await {
                tracing::warn!(error = %format!("{e:#}"), "notification delivery pass failed");
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(5)) => {}
                _ = state.monitoring.delivery.notified() => {}
            }
        }
    });
}

/// Delivers every due attempt.
pub async fn process_due(state: &AppState) -> anyhow::Result<()> {
    loop {
        let now = rustrmm_common::now();
        let due: Vec<Due> = sqlx::query_as(
            "SELECT id, delivery_id, alert_id, channel_id, channel_name, channel_kind, rule_id, event, attempt, payload
             FROM notification_log WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 50",
        )
        .bind(now)
        .fetch_all(&state.db)
        .await?;
        if due.is_empty() {
            return Ok(());
        }
        let ids: Vec<String> = due.iter().map(|d| d.id.clone()).collect();
        for id in &ids {
            sqlx::query("UPDATE notification_log SET status = 'sending' WHERE id = ? AND status = 'pending'")
                .bind(id)
                .execute(&state.db)
                .await?;
        }
        let mut set = tokio::task::JoinSet::new();
        for item in due {
            while set.len() >= PARALLEL {
                set.join_next().await;
            }
            let state = state.clone();
            set.spawn(async move {
                if let Err(e) = attempt(&state, item).await {
                    tracing::warn!(error = %format!("{e:#}"), "notification attempt failed to record");
                }
            });
        }
        while set.join_next().await.is_some() {}
    }
}

async fn attempt(state: &AppState, item: Due) -> anyhow::Result<()> {
    let payload: Payload = serde_json::from_str(&item.payload)?;
    let channel = match &item.channel_id {
        Some(id) => channels::load(state, id).await?,
        None => None,
    };
    let outcome = match &channel {
        Some(c) if c.enabled => send(state, c, &payload).await,
        Some(_) => Err(Failure::new("the channel is disabled")),
        None => Err(Failure::new("the channel was deleted")),
    };
    let now = rustrmm_common::now();
    let (status, http, error) = match &outcome {
        Ok(s) => ("sent", *s, None),
        Err(f) => ("failed", f.status, Some(f.message.clone())),
    };
    sqlx::query("UPDATE notification_log SET status = ?, http_status = ?, error = ?, finished_at = ? WHERE id = ?")
        .bind(status)
        .bind(http.map(i64::from))
        .bind(&error)
        .bind(now)
        .bind(&item.id)
        .execute(&state.db)
        .await?;
    if let Some(c) = &channel {
        mark_channel(state, &c.id, error.as_deref()).await;
    }
    let retry = outcome.is_err()
        && channel.as_ref().is_some_and(|c| c.enabled)
        && item.attempt < MAX_ATTEMPTS;
    if retry {
        let delay = RETRY_DELAYS[(item.attempt - 1).clamp(0, 2) as usize];
        sqlx::query("INSERT INTO notification_log (id, delivery_id, alert_id, channel_id, channel_name, channel_kind, rule_id, event, attempt, status, payload, created_at, next_attempt_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)")
            .bind(rustrmm_common::new_id())
            .bind(&item.delivery_id)
            .bind(&item.alert_id)
            .bind(&item.channel_id)
            .bind(&item.channel_name)
            .bind(&item.channel_kind)
            .bind(&item.rule_id)
            .bind(&item.event)
            .bind(item.attempt + 1)
            .bind(&item.payload)
            .bind(now)
            .bind(now + chrono::Duration::seconds(delay))
            .execute(&state.db)
            .await?;
    }
    if let Some(alert_id) = &item.alert_id {
        match &outcome {
            Ok(_) => {
                crate::monitoring::alerts::add_event(
                    &state.db,
                    alert_id,
                    "notified",
                    None,
                    &format!("Sent to {} ({})", item.channel_name, item.channel_kind),
                    json!({ "channel_id": item.channel_id, "event": item.event, "rule_id": item.rule_id, "attempt": item.attempt }),
                )
                .await?;
            }
            Err(f) if !retry => {
                crate::monitoring::alerts::add_event(
                    &state.db,
                    alert_id,
                    "notification_failed",
                    None,
                    &format!("Could not notify {}: {}", item.channel_name, f.message),
                    json!({ "channel_id": item.channel_id, "event": item.event, "rule_id": item.rule_id, "attempts": item.attempt }),
                )
                .await?;
            }
            Err(_) => {}
        }
    }
    Ok(())
}

/// Start-up: attempts interrupted by a restart are retried.
pub async fn recover(state: &AppState) -> anyhow::Result<()> {
    sqlx::query("UPDATE notification_log SET status = 'pending' WHERE status = 'sending'")
        .execute(&state.db)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload() -> Payload {
        Payload {
            event: "opened".into(),
            alert_id: Some("a1".into()),
            title: "Low disk space: C: 4% free".into(),
            severity: "critical".into(),
            status: "open".into(),
            source: "check".into(),
            check_id: "disk-c".into(),
            check_type: "disk".into(),
            message: "C: 4% free <b>".into(),
            hostname: Some("WS-ONE".into()),
            client_name: "Acme".into(),
            site_name: Some("HQ".into()),
            opened_at: Some(rustrmm_common::now()),
            last_occurrence_at: Some(rustrmm_common::now()),
            resolved_at: None,
            occurrences: 2,
            link: Some("https://rmm.test/alerts/a1".into()),
            sent_at: rustrmm_common::now(),
        }
    }

    #[test]
    fn webhook_signature_is_hmac_sha256_of_the_body() {
        // RFC 4231 test case 2.
        assert_eq!(
            signature("Jefe", b"what do ya want for nothing?"),
            "sha256=5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        assert_ne!(signature("a", b"body"), signature("b", b"body"));
    }

    #[test]
    fn channel_bodies_carry_the_alert() {
        let p = payload();
        let slack = slack_body(&p).to_string();
        assert!(slack.contains("[CRITICAL] Low disk space") && slack.contains("&lt;b&gt;"));
        assert!(slack.contains("https://rmm.test/alerts/a1"));
        let teams = teams_body(&p);
        assert_eq!(teams["attachments"][0]["content"]["type"], "AdaptiveCard");
        let discord = discord_body(&p);
        assert_eq!(discord["embeds"][0]["color"], 0xe7_4c_3c);
        assert_eq!(ntfy_priority(&p), 5);
        let resolved = Payload {
            event: "resolved".into(),
            ..p.clone()
        };
        assert_eq!(ntfy_priority(&resolved), 2);
        assert_eq!(ntfy_body(&p, "ops")["topic"], "ops");
        assert_eq!(webhook_body(&p)["alert"]["check_id"], "disk-c");
        let email = email_message(&p, vec!["ops@example.com".into()], vec![]);
        assert!(email.html.contains("&lt;b&gt;") && email.text.contains("WS-ONE"));
    }
}
