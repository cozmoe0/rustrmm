//! The nine built-in reports: data gathering scoped to the caller (or schedule owner) and the
//! section layout each report produces.

use std::collections::{BTreeMap, HashMap, HashSet};

use anyhow::Result;
use chrono::{DateTime, Duration, Utc};
use serde_json::{Value, json};

use super::{ClientRef, Column, Kpi, Period, Report, ReportParams, Section, Series};
use crate::rbac::{AccessScope, perm};
use crate::state::AppState;

/// Everything a generator needs.
pub struct Ctx<'a> {
    pub state: &'a AppState,
    pub scope: &'a AccessScope,
    pub params: &'a ReportParams,
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    /// `None` = every visible client.
    pub client: Option<String>,
    pub site: Option<String>,
}

impl Ctx<'_> {
    /// The place passes the client/site parameters and the caller's scope for `permission`.
    pub fn allows(&self, permission: &str, client_id: &str, site_id: Option<&str>) -> bool {
        if self.client.as_deref().is_some_and(|c| c != client_id) {
            return false;
        }
        if let Some(s) = &self.site
            && site_id != Some(s.as_str())
        {
            return false;
        }
        match site_id {
            Some(site) => self.scope.can_site(permission, client_id, site),
            None => self.scope.can_client(permission, client_id),
        }
    }
}

pub fn col(key: &str, label: &str) -> Column {
    Column {
        key: key.into(),
        label: label.into(),
        align: None,
        format: None,
    }
}

pub fn num(key: &str, label: &str) -> Column {
    Column {
        key: key.into(),
        label: label.into(),
        align: Some("right".into()),
        format: Some("number".into()),
    }
}

fn fmt(mut c: Column, format: &str) -> Column {
    c.format = Some(format.into());
    if matches!(format, "percent" | "bytes" | "duration") {
        c.align = Some("right".into());
    }
    c
}

fn kpi(label: &str, value: impl Into<Value>) -> Kpi {
    Kpi {
        label: label.into(),
        value: value.into(),
        unit: None,
        tone: None,
    }
}

fn toned(mut k: Kpi, tone: &str) -> Kpi {
    k.tone = Some(tone.into());
    k
}

fn pct(part: usize, whole: usize) -> Option<f64> {
    (whole > 0).then(|| (part as f64 * 1000.0 / whole as f64).round() / 10.0)
}

fn pct_value(p: Option<f64>) -> Value {
    p.map(|v| json!(v)).unwrap_or(Value::Null)
}

fn tone_for(p: Option<f64>, good: f64, warn: f64) -> &'static str {
    match p {
        Some(v) if v >= good => "good",
        Some(v) if v >= warn => "warn",
        Some(_) => "bad",
        None => "neutral",
    }
}

fn table(title: &str, columns: Vec<Column>, rows: Vec<Vec<Value>>) -> Section {
    Section::Table {
        title: title.into(),
        columns,
        rows,
        total_rows: None,
    }
}

fn avg(values: &[f64]) -> Option<f64> {
    (!values.is_empty())
        .then(|| (values.iter().sum::<f64>() / values.len() as f64 * 10.0).round() / 10.0)
}

// ------------------------------------------------------------------ shared loaders

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Dev {
    pub id: String,
    pub hostname: String,
    pub status: String,
    pub online: bool,
    pub os_family: String,
    pub os_name: String,
    pub os_version: String,
    pub manufacturer: Option<String>,
    pub model: Option<String>,
    pub serial: Option<String>,
    pub client_id: String,
    pub client_name: String,
    pub site_id: String,
    pub site_name: String,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub health_score: Option<i64>,
    pub agent_version: String,
    pub enrolled_at: DateTime<Utc>,
    pub disk_pct: Option<f64>,
}

/// Devices the context allows for `permission` (all statuses).
pub async fn devices(ctx: &Ctx<'_>, permission: &str) -> Result<Vec<Dev>> {
    let rows: Vec<Dev> = sqlx::query_as(
        "SELECT d.id, COALESCE(d.display_name, d.hostname) AS hostname, d.status, d.online, d.os_family, d.os_name,
                d.os_version, d.manufacturer, d.model, d.serial, s.client_id, c.name AS client_name, d.site_id,
                s.name AS site_name, d.last_seen_at, d.health_score, d.agent_version, d.enrolled_at, d.disk_pct
         FROM devices d JOIN sites s ON s.id = d.site_id JOIN clients c ON c.id = s.client_id
         ORDER BY c.name COLLATE NOCASE, d.hostname COLLATE NOCASE",
    )
    .fetch_all(&ctx.state.db)
    .await?;
    Ok(rows
        .into_iter()
        .filter(|d| ctx.allows(permission, &d.client_id, Some(&d.site_id)))
        .collect())
}

/// One inventory section of every device.
pub async fn inventory(state: &AppState, section: &str) -> Result<HashMap<String, Value>> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT device_id, data FROM device_inventory WHERE section = ?")
            .bind(section)
            .fetch_all(&state.db)
            .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, data)| serde_json::from_str(&data).ok().map(|v| (id, v)))
        .collect())
}

/// The newest imported agent release.
pub async fn latest_agent(state: &AppState) -> Result<Option<String>> {
    let versions: Vec<String> = sqlx::query_scalar("SELECT version FROM agent_releases")
        .fetch_all(&state.db)
        .await?;
    Ok(versions
        .into_iter()
        .max_by(|a, b| rustrmm_proto::commands::version_cmp(a, b)))
}

fn os_label(d: &Dev) -> String {
    let name = d.os_name.trim();
    if name.is_empty() {
        match d.os_family.as_str() {
            "windows" => "Windows".into(),
            "linux" => "Linux".into(),
            "macos" => "macOS".into(),
            other => other.to_string(),
        }
    } else {
        // "Microsoft Windows 11 Pro" → "Windows 11 Pro"
        name.trim_start_matches("Microsoft ").to_string()
    }
}

#[derive(sqlx::FromRow)]
struct AlertFact {
    client_id: String,
    site_id: Option<String>,
    severity: String,
    title: String,
    check_type: String,
    status: String,
    opened_at: DateTime<Utc>,
    acknowledged_at: Option<DateTime<Utc>>,
    resolved_at: Option<DateTime<Utc>>,
}

async fn alert_facts(ctx: &Ctx<'_>) -> Result<Vec<AlertFact>> {
    let rows: Vec<AlertFact> = sqlx::query_as(
        "SELECT client_id, site_id, severity, title, check_type, status, opened_at, acknowledged_at, resolved_at
         FROM alerts WHERE (opened_at >= ? AND opened_at < ?) OR status <> 'resolved'",
    )
    .bind(ctx.from)
    .bind(ctx.to)
    .fetch_all(&ctx.state.db)
    .await?;
    Ok(rows
        .into_iter()
        .filter(|a| ctx.allows(perm::ALERTS_VIEW, &a.client_id, a.site_id.as_deref()))
        .collect())
}

#[derive(sqlx::FromRow)]
struct TicketFact {
    client_id: String,
    site_id: Option<String>,
    status: String,
    created_at: DateTime<Utc>,
    resolved_at: Option<DateTime<Utc>>,
    first_response_breached: bool,
    resolution_breached: bool,
}

async fn ticket_facts(ctx: &Ctx<'_>) -> Result<Vec<TicketFact>> {
    let rows: Vec<TicketFact> = sqlx::query_as(
        "SELECT client_id, site_id, status, created_at, resolved_at, first_response_breached, resolution_breached
         FROM tickets WHERE merged_into IS NULL
           AND ((created_at >= ? AND created_at < ?) OR (resolved_at >= ? AND resolved_at < ?)
                OR status IN ('new', 'open', 'pending', 'on_hold'))",
    )
    .bind(ctx.from)
    .bind(ctx.to)
    .bind(ctx.from)
    .bind(ctx.to)
    .fetch_all(&ctx.state.db)
    .await?;
    Ok(rows
        .into_iter()
        .filter(|t| ctx.allows(perm::TICKETS_VIEW, &t.client_id, t.site_id.as_deref()))
        .collect())
}

/// Security checks on one device's `security` inventory: `(check, passed?)` with `None` when
/// the device does not report the check.
pub fn security_checks(sec: Option<&Value>) -> Vec<(&'static str, Option<bool>, Option<String>)> {
    let Some(sec) = sec else {
        return vec![
            ("Antivirus", None, None),
            ("Firewall", None, None),
            ("Disk encryption", None, None),
            ("Local admins", None, None),
            ("UAC", None, None),
            ("SMBv1 off", None, None),
            ("No auto-logon", None, None),
        ];
    };
    let av = sec
        .get("antivirus")
        .and_then(Value::as_array)
        .map(|products| {
            if products.is_empty() {
                (false, Some("No antivirus detected".to_string()))
            } else if !products
                .iter()
                .any(|p| p.get("enabled").and_then(Value::as_bool).unwrap_or(false))
            {
                (false, Some("Antivirus disabled".into()))
            } else if products
                .iter()
                .any(|p| p.get("up_to_date").and_then(Value::as_bool) == Some(false))
            {
                (false, Some("Antivirus definitions out of date".into()))
            } else {
                (true, None)
            }
        });
    let firewall = sec.pointer("/firewall/enabled").and_then(Value::as_bool);
    let encryption = sec
        .pointer("/encryption/system_volume_encrypted")
        .and_then(Value::as_bool);
    let admins = sec
        .get("local_admins")
        .and_then(Value::as_array)
        .map(|a| a.len());
    let flag = |key: &str| sec.get(key).and_then(Value::as_bool);
    vec![
        ("Antivirus", av.as_ref().map(|a| a.0), av.and_then(|a| a.1)),
        (
            "Firewall",
            firewall,
            (firewall == Some(false)).then(|| "Firewall disabled".to_string()),
        ),
        (
            "Disk encryption",
            encryption,
            (encryption == Some(false)).then(|| "System drive not encrypted".to_string()),
        ),
        (
            "Local admins",
            admins.map(|n| n <= 2),
            admins
                .filter(|n| *n > 2)
                .map(|n| format!("{n} local administrators")),
        ),
        (
            "UAC",
            flag("uac_enabled"),
            (flag("uac_enabled") == Some(false)).then(|| "UAC disabled".to_string()),
        ),
        (
            "SMBv1 off",
            flag("smb1_enabled").map(|b| !b),
            (flag("smb1_enabled") == Some(true)).then(|| "SMBv1 enabled".to_string()),
        ),
        (
            "No auto-logon",
            flag("autologon_enabled").map(|b| !b),
            (flag("autologon_enabled") == Some(true))
                .then(|| "Automatic logon enabled".to_string()),
        ),
    ]
}

/// Records today's per-client health snapshot (feeds the executive summary trend).
pub async fn snapshot_health(state: &AppState) -> Result<()> {
    let rows: Vec<(String, i64, i64, Option<f64>)> = sqlx::query_as(
        "SELECT s.client_id, COUNT(*), COALESCE(SUM(d.online), 0), AVG(d.health_score)
         FROM devices d JOIN sites s ON s.id = d.site_id WHERE d.status = 'active' GROUP BY s.client_id",
    )
    .fetch_all(&state.db)
    .await?;
    let now = rustrmm_common::now();
    let day = now.format("%Y-%m-%d").to_string();
    for (client, devices, online, health) in rows {
        sqlx::query(
            "INSERT INTO client_health_daily (client_id, day, devices, online, avg_health, updated_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (client_id, day) DO UPDATE SET devices = excluded.devices, online = excluded.online,
                 avg_health = excluded.avg_health, updated_at = excluded.updated_at",
        )
        .bind(&client)
        .bind(&day)
        .bind(devices)
        .bind(online)
        .bind(health)
        .bind(now)
        .execute(&state.db)
        .await?;
    }
    Ok(())
}

// ------------------------------------------------------------------ executive summary

#[derive(Default)]
struct Summary {
    devices: usize,
    online: usize,
    health: Vec<f64>,
    os: BTreeMap<String, usize>,
    alerts: usize,
    alerts_by_sev: BTreeMap<String, usize>,
    open_alerts: usize,
    open_critical: usize,
    mtta: Vec<f64>,
    mttr: Vec<f64>,
    top_issues: BTreeMap<String, usize>,
    patch_devices: usize,
    patch_compliant: usize,
    missing_critical: usize,
    missing_important: usize,
    pending_reboot: usize,
    tickets_opened: usize,
    tickets_resolved: usize,
    resolved_within_sla: usize,
    open_tickets: usize,
    breached_open: usize,
    sec_total: BTreeMap<&'static str, usize>,
    sec_pass: BTreeMap<&'static str, usize>,
    offline_week: usize,
    disk_full: usize,
    outdated_agents: usize,
}

impl Summary {
    fn compliance(&self) -> Option<f64> {
        pct(self.patch_compliant, self.patch_devices)
    }
    fn sla(&self) -> Option<f64> {
        pct(self.resolved_within_sla, self.tickets_resolved)
    }
    fn sec(&self, check: &str) -> Option<f64> {
        pct(
            self.sec_pass.get(check).copied().unwrap_or(0),
            self.sec_total.get(check).copied().unwrap_or(0),
        )
    }
}

async fn summarise(ctx: &Ctx<'_>) -> Result<(Summary, HashMap<String, Summary>)> {
    let now = rustrmm_common::now();
    let mut total = Summary::default();
    let mut per_client: HashMap<String, Summary> = HashMap::new();
    let latest = latest_agent(ctx.state).await?;
    let security = inventory(ctx.state, "security").await?;
    for d in devices(ctx, perm::DEVICES_VIEW).await? {
        if d.status != "active" {
            continue;
        }
        let checks = security_checks(security.get(&d.id));
        for s in [
            &mut total,
            per_client.entry(d.client_id.clone()).or_default(),
        ] {
            s.devices += 1;
            if d.online {
                s.online += 1;
            }
            if let Some(h) = d.health_score {
                s.health.push(h as f64);
            }
            *s.os.entry(os_label(&d)).or_default() += 1;
            if !d.online && d.last_seen_at.is_none_or(|t| now - t > Duration::days(7)) {
                s.offline_week += 1;
            }
            if d.disk_pct.is_some_and(|p| p >= 90.0) {
                s.disk_full += 1;
            }
            if let Some(latest) = &latest
                && rustrmm_proto::commands::version_cmp(&d.agent_version, latest).is_lt()
            {
                s.outdated_agents += 1;
            }
            for (name, passed, _) in &checks {
                if let Some(p) = passed {
                    *s.sec_total.entry(name).or_default() += 1;
                    if *p {
                        *s.sec_pass.entry(name).or_default() += 1;
                    }
                }
            }
        }
    }
    for a in alert_facts(ctx).await? {
        let in_period = a.opened_at >= ctx.from && a.opened_at < ctx.to;
        for s in [
            &mut total,
            per_client.entry(a.client_id.clone()).or_default(),
        ] {
            if a.status != "resolved" {
                s.open_alerts += 1;
                if a.severity == "critical" {
                    s.open_critical += 1;
                }
            }
            if in_period {
                s.alerts += 1;
                *s.alerts_by_sev.entry(a.severity.clone()).or_default() += 1;
                *s.top_issues.entry(a.title.clone()).or_default() += 1;
                if let Some(ack) = a.acknowledged_at {
                    s.mtta.push((ack - a.opened_at).num_seconds() as f64 / 60.0);
                }
                if let Some(res) = a.resolved_at {
                    s.mttr.push((res - a.opened_at).num_seconds() as f64 / 60.0);
                }
            }
        }
        let _ = &a.check_type;
    }
    let scope = ctx.scope.clone();
    let client = ctx.client.clone();
    let site = ctx.site.clone();
    let visible = move |c: &str, s: &str| {
        scope.can_site(perm::PATCHES_VIEW, c, s)
            && client.as_deref().is_none_or(|x| x == c)
            && site.as_deref().is_none_or(|x| x == s)
    };
    for d in crate::patching::compliance::load_status(ctx.state, &visible).await? {
        for s in [
            &mut total,
            per_client.entry(d.client_id.clone()).or_default(),
        ] {
            s.patch_devices += 1;
            if d.compliant(now) {
                s.patch_compliant += 1;
            }
            s.missing_critical += d.missing("Critical");
            s.missing_important += d.missing("Important");
            if d.pending_reboot() {
                s.pending_reboot += 1;
            }
        }
    }
    for t in ticket_facts(ctx).await? {
        for s in [
            &mut total,
            per_client.entry(t.client_id.clone()).or_default(),
        ] {
            if t.created_at >= ctx.from && t.created_at < ctx.to {
                s.tickets_opened += 1;
            }
            if let Some(r) = t.resolved_at
                && r >= ctx.from
                && r < ctx.to
            {
                s.tickets_resolved += 1;
                if !t.resolution_breached {
                    s.resolved_within_sla += 1;
                }
            }
            if matches!(t.status.as_str(), "new" | "open" | "pending" | "on_hold") {
                s.open_tickets += 1;
                if t.first_response_breached || t.resolution_breached {
                    s.breached_open += 1;
                }
            }
        }
    }
    Ok((total, per_client))
}

/// Rule-based recommendations (no AI): each rule names the problem and the next step.
fn recommendations(s: &Summary) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(c) = s.compliance()
        && c < 90.0
    {
        out.push(format!(
            "Patch compliance is {c:.0}% ({} of {} devices compliant). Review the non-compliant devices and approve outstanding updates.",
            s.patch_compliant, s.patch_devices
        ));
    }
    if s.missing_critical > 0 {
        out.push(format!(
            "{} critical update(s) are missing across the fleet. Schedule an install window or run the patch window now.",
            s.missing_critical
        ));
    }
    if let Some(p) = s.sec("Antivirus")
        && p < 100.0
    {
        let bad = s.sec_total.get("Antivirus").copied().unwrap_or(0)
            - s.sec_pass.get("Antivirus").copied().unwrap_or(0);
        out.push(format!(
            "{bad} device(s) have antivirus missing, disabled or out of date. Restore protection on these devices first."
        ));
    }
    if let Some(p) = s.sec("Disk encryption")
        && p < 100.0
    {
        let bad = s.sec_total.get("Disk encryption").copied().unwrap_or(0)
            - s.sec_pass.get("Disk encryption").copied().unwrap_or(0);
        out.push(format!(
            "{bad} device(s) have an unencrypted system drive. Enable BitLocker/FileVault and escrow the recovery keys."
        ));
    }
    if let Some(p) = s.sec("Firewall")
        && p < 100.0
    {
        out.push("Some devices have the firewall disabled. Re-enable it through policy.".into());
    }
    if let Some(p) = s.sec("Local admins")
        && p < 90.0
    {
        out.push(
            "Several devices have more than two local administrators. Remove unneeded admin rights or enable LAPS rotation."
                .into(),
        );
    }
    if s.open_critical > 0 {
        out.push(format!(
            "{} critical alert(s) are still open. Acknowledge and resolve them or adjust the monitors.",
            s.open_critical
        ));
    }
    if let Some(sla) = s.sla()
        && sla < 90.0
    {
        out.push(format!(
            "Only {sla:.0}% of resolved tickets met their SLA. Review queue staffing and SLA targets."
        ));
    }
    if s.offline_week > 0 {
        out.push(format!(
            "{} device(s) have been offline for more than a week. Confirm whether they were retired and remove them.",
            s.offline_week
        ));
    }
    if s.disk_full > 0 {
        out.push(format!(
            "{} device(s) are above 90% disk usage. Run a disk clean-up script or plan storage upgrades.",
            s.disk_full
        ));
    }
    if s.pending_reboot > 0 {
        out.push(format!(
            "{} device(s) are waiting for a restart to finish installing updates.",
            s.pending_reboot
        ));
    }
    if s.outdated_agents > 0 {
        out.push(format!(
            "{} agent(s) run an older version. Start a rollout of the current release.",
            s.outdated_agents
        ));
    }
    if out.is_empty() {
        out.push("No action needed: the fleet meets every check in this report.".into());
    }
    out
}

async fn health_trend(ctx: &Ctx<'_>, clients: &HashSet<String>) -> Result<Section> {
    let rows: Vec<(String, String, i64, Option<f64>)> = sqlx::query_as(
        "SELECT client_id, day, devices, avg_health FROM client_health_daily WHERE day >= ? AND day <= ? ORDER BY day",
    )
    .bind(ctx.from.format("%Y-%m-%d").to_string())
    .bind(ctx.to.format("%Y-%m-%d").to_string())
    .fetch_all(&ctx.state.db)
    .await?;
    let mut by_day: BTreeMap<String, (f64, i64)> = BTreeMap::new();
    for (client, day, devices, health) in rows {
        if !clients.contains(&client) {
            continue;
        }
        if let Some(h) = health {
            let e = by_day.entry(day).or_default();
            e.0 += h * devices as f64;
            e.1 += devices;
        }
    }
    let labels: Vec<String> = by_day.keys().map(|d| d[5..].to_string()).collect();
    let values: Vec<f64> = by_day
        .values()
        .map(|(sum, n)| {
            if *n > 0 {
                (sum / *n as f64 * 10.0).round() / 10.0
            } else {
                0.0
            }
        })
        .collect();
    Ok(Section::Chart {
        title: "Health score trend".into(),
        chart: "line".into(),
        labels,
        series: vec![Series {
            name: "Average health score".into(),
            values,
        }],
        unit: Some("0–100".into()),
    })
}

fn summary_kpis(s: &Summary) -> Vec<Kpi> {
    let compliance = s.compliance();
    let sla = s.sla();
    vec![
        kpi("Devices", s.devices),
        toned(
            kpi("Online", pct_value(pct(s.online, s.devices))).unit_pct(),
            tone_for(pct(s.online, s.devices), 90.0, 75.0),
        ),
        toned(
            kpi(
                "Avg health score",
                avg(&s.health).map(Value::from).unwrap_or(Value::Null),
            ),
            tone_for(avg(&s.health), 85.0, 70.0),
        ),
        toned(
            kpi("Patch compliance", pct_value(compliance)).unit_pct(),
            tone_for(compliance, 95.0, 80.0),
        ),
        kpi("Alerts (period)", s.alerts),
        toned(
            kpi("Open critical alerts", s.open_critical),
            if s.open_critical > 0 { "bad" } else { "good" },
        ),
        kpi("MTTA", avg(&s.mtta).map(Value::from).unwrap_or(Value::Null)).unit("min"),
        kpi("MTTR", avg(&s.mttr).map(Value::from).unwrap_or(Value::Null)).unit("min"),
        kpi("Tickets opened", s.tickets_opened),
        kpi("Tickets resolved", s.tickets_resolved),
        toned(
            kpi("SLA met", pct_value(sla)).unit_pct(),
            tone_for(sla, 95.0, 85.0),
        ),
        kpi("Open tickets", s.open_tickets),
    ]
}

trait KpiExt {
    fn unit(self, unit: &str) -> Self;
    fn unit_pct(self) -> Self;
}

impl KpiExt for Kpi {
    fn unit(mut self, unit: &str) -> Self {
        if !self.value.is_null() {
            self.unit = Some(unit.into());
        }
        self
    }
    fn unit_pct(self) -> Self {
        self.unit("%")
    }
}

fn security_rows(s: &Summary) -> Vec<Vec<Value>> {
    [
        "Antivirus",
        "Firewall",
        "Disk encryption",
        "Local admins",
        "UAC",
        "SMBv1 off",
        "No auto-logon",
    ]
    .iter()
    .map(|check| {
        let total = s.sec_total.get(check).copied().unwrap_or(0);
        let pass = s.sec_pass.get(check).copied().unwrap_or(0);
        vec![
            json!(check),
            json!(pass),
            json!(total - pass),
            pct_value(pct(pass, total)),
        ]
    })
    .collect()
}

pub async fn executive_summary(ctx: &Ctx<'_>) -> Result<Vec<Section>> {
    let (total, per_client) = summarise(ctx).await?;
    let mut sections = vec![Section::Kpis {
        title: "Overview".into(),
        items: summary_kpis(&total),
    }];
    let clients: HashSet<String> = per_client.keys().cloned().collect();
    sections.push(health_trend(ctx, &clients).await?);
    sections.push(Section::Chart {
        title: "Operating systems".into(),
        chart: "donut".into(),
        labels: total.os.keys().cloned().collect(),
        series: vec![Series {
            name: "Devices".into(),
            values: total.os.values().map(|v| *v as f64).collect(),
        }],
        unit: None,
    });
    sections.push(Section::Kpis {
        title: "Alerts by severity".into(),
        items: ["critical", "warning", "info"]
            .iter()
            .map(|sev| {
                let k = kpi(
                    &format!("{sev} alerts"),
                    total.alerts_by_sev.get(*sev).copied().unwrap_or(0),
                );
                toned(
                    k,
                    match *sev {
                        "critical" => "bad",
                        "warning" => "warn",
                        _ => "neutral",
                    },
                )
            })
            .chain([kpi("Open alerts now", total.open_alerts)])
            .collect(),
    });
    sections.push(Section::Kpis {
        title: "Patching".into(),
        items: vec![
            kpi("Scanned devices", total.patch_devices),
            kpi("Compliant", total.patch_compliant),
            toned(
                kpi("Missing critical", total.missing_critical),
                if total.missing_critical > 0 {
                    "bad"
                } else {
                    "good"
                },
            ),
            kpi("Missing important", total.missing_important),
            kpi("Pending reboot", total.pending_reboot),
        ],
    });
    sections.push(table(
        "Security posture",
        vec![
            col("check", "Check"),
            num("passing", "Passing"),
            num("failing", "Failing"),
            fmt(num("pct", "Passing %"), "percent"),
        ],
        security_rows(&total),
    ));
    let mut issues: Vec<(&String, &usize)> = total.top_issues.iter().collect();
    issues.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
    sections.push(table(
        "Top issues",
        vec![col("issue", "Alert"), num("count", "Occurrences")],
        issues
            .into_iter()
            .take(10)
            .map(|(t, n)| vec![json!(t), json!(n)])
            .collect(),
    ));
    if ctx.client.is_none() && per_client.len() > 1 {
        let names: HashMap<String, String> =
            sqlx::query_as::<_, (String, String)>("SELECT id, name FROM clients")
                .fetch_all(&ctx.state.db)
                .await?
                .into_iter()
                .collect();
        let mut rows: Vec<(String, Vec<Value>)> = per_client
            .iter()
            .map(|(id, s)| {
                let name = names.get(id).cloned().unwrap_or_default();
                (
                    name.to_lowercase(),
                    vec![
                        json!(name),
                        json!(s.devices),
                        avg(&s.health).map(Value::from).unwrap_or(Value::Null),
                        pct_value(s.compliance()),
                        json!(s.alerts),
                        json!(s.open_critical),
                        json!(s.tickets_opened),
                        pct_value(s.sla()),
                    ],
                )
            })
            .collect();
        rows.sort_by(|a, b| a.0.cmp(&b.0));
        sections.push(table(
            "By client",
            vec![
                col("client", "Client"),
                num("devices", "Devices"),
                num("health", "Health"),
                fmt(num("compliance", "Patch %"), "percent"),
                num("alerts", "Alerts"),
                num("critical", "Open critical"),
                num("tickets", "Tickets"),
                fmt(num("sla", "SLA met"), "percent"),
            ],
            rows.into_iter().map(|(_, r)| r).collect(),
        ));
    }
    sections.push(Section::List {
        title: "Recommendations".into(),
        items: recommendations(&total),
    });
    Ok(sections)
}

// ------------------------------------------------------------------ hardware inventory

pub async fn hardware_inventory(ctx: &Ctx<'_>) -> Result<Vec<Section>> {
    let hardware = inventory(ctx.state, "hardware").await?;
    let storage = inventory(ctx.state, "storage").await?;
    // Custom fields whose key mentions "warranty" (device scope).
    let warranty_rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT v.entity_id, f.name, v.value FROM custom_field_values v JOIN custom_fields f ON f.id = v.field_id
         WHERE f.scope = 'device' AND (LOWER(f.key) LIKE '%warranty%' OR LOWER(f.name) LIKE '%warranty%')",
    )
    .fetch_all(&ctx.state.db)
    .await?;
    let mut warranty: HashMap<String, String> = HashMap::new();
    for (device, name, value) in warranty_rows {
        let value: Value = serde_json::from_str(&value).unwrap_or(Value::String(value));
        let text = match value {
            Value::String(s) => s,
            other => other.to_string(),
        };
        warranty
            .entry(device)
            .and_modify(|e| e.push_str(&format!("; {name}: {text}")))
            .or_insert(format!("{name}: {text}"));
    }
    let now = rustrmm_common::now();
    let mut rows = Vec::new();
    let mut ages = Vec::new();
    let mut old = 0usize;
    let mut ram_total = 0f64;
    let devices: Vec<Dev> = devices(ctx, perm::DEVICES_VIEW)
        .await?
        .into_iter()
        .filter(|d| d.status == "active" || d.status == "quarantined")
        .collect();
    for d in &devices {
        let hw = hardware.get(&d.id);
        let cpu = hw
            .and_then(|h| h.pointer("/cpu/model"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let ram = hw
            .and_then(|h| h.pointer("/memory/total_bytes"))
            .and_then(Value::as_f64)
            .map(|b| (b / 1024f64.powi(3) * 10.0).round() / 10.0);
        ram_total += ram.unwrap_or(0.0);
        let disk_bytes: f64 = hw
            .and_then(|h| h.get("disks"))
            .and_then(Value::as_array)
            .map(|disks| {
                disks
                    .iter()
                    .filter_map(|d| d.get("size_bytes").and_then(Value::as_f64))
                    .sum()
            })
            .filter(|s: &f64| *s > 0.0)
            .or_else(|| {
                storage
                    .get(&d.id)
                    .and_then(|s| s.get("volumes"))
                    .and_then(Value::as_array)
                    .map(|v| {
                        v.iter()
                            .filter_map(|x| x.get("total_bytes").and_then(Value::as_f64))
                            .sum()
                    })
            })
            .unwrap_or(0.0);
        let bios_date = hw
            .and_then(|h| h.pointer("/bios/date"))
            .and_then(Value::as_str)
            .and_then(crate::patching::approvals::parse_date);
        let since = bios_date.unwrap_or(d.enrolled_at);
        let age = ((now - since).num_days() as f64 / 365.25 * 10.0).round() / 10.0;
        ages.push(age);
        if age >= 5.0 {
            old += 1;
        }
        rows.push(vec![
            json!(d.hostname),
            json!(d.client_name),
            json!(d.site_name),
            json!(d.manufacturer.clone().unwrap_or_default()),
            json!(d.model.clone().unwrap_or_default()),
            json!(d.serial.clone().unwrap_or_default()),
            json!(cpu),
            ram.map(Value::from).unwrap_or(Value::Null),
            if disk_bytes > 0.0 {
                json!(disk_bytes)
            } else {
                Value::Null
            },
            json!(os_label(d)),
            json!(age),
            warranty.get(&d.id).map(|w| json!(w)).unwrap_or(Value::Null),
        ]);
    }
    Ok(vec![
        Section::Kpis {
            title: "Summary".into(),
            items: vec![
                kpi("Devices", devices.len()),
                kpi(
                    "Average age",
                    avg(&ages).map(Value::from).unwrap_or(Value::Null),
                )
                .unit("years"),
                toned(
                    kpi("5 years or older", old),
                    if old > 0 { "warn" } else { "good" },
                ),
                kpi("Total RAM", (ram_total * 10.0).round() / 10.0).unit("GB"),
            ],
        },
        table(
            "Devices",
            vec![
                col("hostname", "Device"),
                col("client", "Client"),
                col("site", "Site"),
                col("manufacturer", "Manufacturer"),
                col("model", "Model"),
                col("serial", "Serial"),
                col("cpu", "CPU"),
                num("ram_gb", "RAM (GB)"),
                fmt(num("disk", "Disk"), "bytes"),
                col("os", "OS"),
                num("age_years", "Age (y)"),
                col("warranty", "Warranty"),
            ],
            rows,
        ),
    ])
}

// ------------------------------------------------------------------ software inventory

pub async fn software_inventory(ctx: &Ctx<'_>) -> Result<Vec<Section>> {
    use crate::software::{normalize_name, normalize_publisher, strip_name};
    let rows: Vec<(String, String, String, String, String, String, String)> = sqlx::query_as(
        "SELECT ds.device_id, ds.name, ds.version, ds.publisher, s.client_id, d.site_id, c.name
         FROM device_software ds JOIN devices d ON d.id = ds.device_id JOIN sites s ON s.id = d.site_id
         JOIN clients c ON c.id = s.client_id WHERE d.status = 'active'",
    )
    .fetch_all(&ctx.state.db)
    .await?;
    #[derive(Default)]
    struct Product {
        names: BTreeMap<String, usize>,
        publishers: BTreeMap<String, usize>,
        versions: HashSet<String>,
        devices: HashSet<String>,
    }
    let mut products: HashMap<(String, String), Product> = HashMap::new();
    let wanted: Vec<String> = ctx
        .params
        .products
        .iter()
        .map(|p| normalize_name(p))
        .collect();
    let mut licences: BTreeMap<String, BTreeMap<String, HashSet<String>>> = BTreeMap::new();
    let mut device_count = HashSet::new();
    for (device, name, version, publisher, client, site, client_name) in rows {
        if !ctx.allows(perm::SOFTWARE_VIEW, &client, Some(&site)) {
            continue;
        }
        device_count.insert(device.clone());
        let key = (normalize_name(&name), normalize_publisher(&publisher));
        if wanted.contains(&key.0) {
            licences
                .entry(strip_name(&name))
                .or_default()
                .entry(client_name)
                .or_default()
                .insert(device.clone());
        }
        let p = products.entry(key).or_default();
        *p.names.entry(strip_name(&name)).or_default() += 1;
        *p.publishers
            .entry(publisher.trim().to_string())
            .or_default() += 1;
        if !version.is_empty() {
            p.versions.insert(version);
        }
        p.devices.insert(device);
    }
    let pick = |m: &BTreeMap<String, usize>| {
        m.iter()
            .max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0)))
            .map(|(n, _)| n.clone())
            .unwrap_or_default()
    };
    let mut list: Vec<(usize, String, Vec<Value>)> = products
        .values()
        .map(|p| {
            let name = pick(&p.names);
            let latest = p
                .versions
                .iter()
                .max_by(|a, b| rustrmm_proto::commands::version_cmp(a, b))
                .cloned();
            (
                p.devices.len(),
                name.to_lowercase(),
                vec![
                    json!(name),
                    json!(pick(&p.publishers)),
                    json!(p.versions.len()),
                    json!(latest),
                    json!(p.devices.len()),
                ],
            )
        })
        .collect();
    list.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    let mut sections = vec![
        Section::Kpis {
            title: "Summary".into(),
            items: vec![
                kpi("Devices", device_count.len()),
                kpi("Products", list.len()),
            ],
        },
        table(
            "Products",
            vec![
                col("name", "Product"),
                col("publisher", "Publisher"),
                num("versions", "Versions"),
                col("latest", "Latest version"),
                num("devices", "Devices"),
            ],
            list.into_iter().map(|(_, _, r)| r).collect(),
        ),
    ];
    if !ctx.params.products.is_empty() {
        let mut rows = Vec::new();
        for (product, by_client) in &licences {
            let total: HashSet<&String> = by_client.values().flatten().collect();
            for (client, devices) in by_client {
                rows.push(vec![json!(product), json!(client), json!(devices.len())]);
            }
            rows.push(vec![json!(product), json!("Total"), json!(total.len())]);
        }
        for p in &ctx.params.products {
            if !licences
                .keys()
                .any(|k| normalize_name(k) == normalize_name(p))
            {
                rows.push(vec![json!(p), json!("Total"), json!(0)]);
            }
        }
        sections.push(table(
            "Licence counts",
            vec![
                col("product", "Product"),
                col("client", "Client"),
                num("installs", "Installed on"),
            ],
            rows,
        ));
    }
    Ok(sections)
}

// ------------------------------------------------------------------ patch compliance

pub async fn patch_compliance(ctx: &Ctx<'_>) -> Result<Vec<Section>> {
    let now = rustrmm_common::now();
    let scope = ctx.scope.clone();
    let client = ctx.client.clone();
    let site = ctx.site.clone();
    let visible = move |c: &str, s: &str| {
        scope.can_site(perm::PATCHES_VIEW, c, s)
            && client.as_deref().is_none_or(|x| x == c)
            && site.as_deref().is_none_or(|x| x == s)
    };
    let statuses = crate::patching::compliance::load_status(ctx.state, &visible).await?;
    let compliant = statuses.iter().filter(|d| d.compliant(now)).count();
    let critical: usize = statuses.iter().map(|d| d.missing("Critical")).sum();
    let important: usize = statuses.iter().map(|d| d.missing("Important")).sum();
    let reboot = statuses.iter().filter(|d| d.pending_reboot()).count();
    let rate = pct(compliant, statuses.len());
    let mut by_place: BTreeMap<(String, String), (usize, usize, usize, usize)> = BTreeMap::new();
    for d in &statuses {
        let e = by_place
            .entry((d.client_name.clone(), d.site_name.clone()))
            .or_default();
        e.0 += 1;
        if d.compliant(now) {
            e.1 += 1;
        }
        e.2 += d.missing("Critical");
        e.3 += d.missing("Important");
    }
    let mut devices: Vec<&crate::patching::compliance::DeviceStatus> = statuses
        .iter()
        .filter(|d| d.missing("Critical") + d.missing("Important") > 0 || d.failed())
        .collect();
    devices.sort_by(|a, b| {
        (b.missing("Critical"), b.missing("Important"))
            .cmp(&(a.missing("Critical"), a.missing("Important")))
            .then(a.hostname.to_lowercase().cmp(&b.hostname.to_lowercase()))
    });
    Ok(vec![
        Section::Kpis {
            title: "Summary".into(),
            items: vec![
                kpi("Scanned devices", statuses.len()),
                toned(
                    kpi("Compliance", pct_value(rate)).unit_pct(),
                    tone_for(rate, 95.0, 80.0),
                ),
                toned(
                    kpi("Missing critical", critical),
                    if critical > 0 { "bad" } else { "good" },
                ),
                kpi("Missing important", important),
                kpi("Pending reboot", reboot),
            ],
        },
        table(
            "By client and site",
            vec![
                col("client", "Client"),
                col("site", "Site"),
                num("devices", "Devices"),
                num("compliant", "Compliant"),
                fmt(num("pct", "Compliance"), "percent"),
                num("critical", "Missing critical"),
                num("important", "Missing important"),
            ],
            by_place
                .into_iter()
                .map(|((client, site), (n, ok, c, i))| {
                    vec![
                        json!(client),
                        json!(site),
                        json!(n),
                        json!(ok),
                        pct_value(pct(ok, n)),
                        json!(c),
                        json!(i),
                    ]
                })
                .collect(),
        ),
        table(
            "Devices missing critical or important patches",
            vec![
                col("hostname", "Device"),
                col("client", "Client"),
                col("site", "Site"),
                num("critical", "Critical"),
                num("important", "Important"),
                num("total", "All missing"),
                num("oldest", "Oldest (days)"),
                col("failed", "Failed installs"),
            ],
            devices
                .into_iter()
                .map(|d| {
                    vec![
                        json!(d.hostname),
                        json!(d.client_name),
                        json!(d.site_name),
                        json!(d.missing("Critical")),
                        json!(d.missing("Important")),
                        json!(d.missing_total()),
                        d.oldest_missing_days(now)
                            .map(Value::from)
                            .unwrap_or(Value::Null),
                        json!(d.failed()),
                    ]
                })
                .collect(),
        ),
    ])
}

// ------------------------------------------------------------------ alert history

pub async fn alert_history(ctx: &Ctx<'_>) -> Result<Vec<Section>> {
    #[derive(sqlx::FromRow)]
    struct Row {
        client_id: String,
        site_id: Option<String>,
        client_name: String,
        hostname: Option<String>,
        severity: String,
        title: String,
        status: String,
        opened_at: DateTime<Utc>,
        acknowledged_at: Option<DateTime<Utc>>,
        resolved_at: Option<DateTime<Utc>>,
        resolution: Option<String>,
        occurrences: i64,
    }
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT a.client_id, a.site_id, c.name AS client_name, COALESCE(d.hostname, sd.name) AS hostname, a.severity, a.title,
                a.status, a.opened_at, a.acknowledged_at, a.resolved_at, a.resolution, a.occurrences
         FROM alerts a JOIN clients c ON c.id = a.client_id LEFT JOIN devices d ON d.id = a.device_id
         LEFT JOIN snmp_devices sd ON sd.id = a.snmp_device_id
         WHERE a.opened_at >= ? AND a.opened_at < ? ORDER BY a.opened_at DESC",
    )
    .bind(ctx.from)
    .bind(ctx.to)
    .fetch_all(&ctx.state.db)
    .await?;
    let wanted_severity = ctx.params.severity.clone().filter(|s| !s.is_empty());
    let rows: Vec<Row> = rows
        .into_iter()
        .filter(|r| ctx.allows(perm::ALERTS_VIEW, &r.client_id, r.site_id.as_deref()))
        .filter(|r| wanted_severity.as_deref().is_none_or(|s| s == r.severity))
        .collect();
    let mut by_day: BTreeMap<String, [f64; 3]> = BTreeMap::new();
    let mut day = ctx.from.date_naive();
    let last = ctx.to.date_naive();
    while day <= last && by_day.len() < 400 {
        by_day.insert(day.format("%Y-%m-%d").to_string(), [0.0; 3]);
        match day.succ_opt() {
            Some(next) => day = next,
            None => break,
        }
    }
    let (mut mtta, mut mttr) = (Vec::new(), Vec::new());
    let mut sev: BTreeMap<&str, usize> = BTreeMap::new();
    for r in &rows {
        let i = match r.severity.as_str() {
            "critical" => 0,
            "warning" => 1,
            _ => 2,
        };
        by_day
            .entry(r.opened_at.format("%Y-%m-%d").to_string())
            .or_insert([0.0; 3])[i] += 1.0;
        *sev.entry(match i {
            0 => "critical",
            1 => "warning",
            _ => "info",
        })
        .or_default() += 1;
        if let Some(a) = r.acknowledged_at {
            mtta.push((a - r.opened_at).num_seconds() as f64 / 60.0);
        }
        if let Some(res) = r.resolved_at {
            mttr.push((res - r.opened_at).num_seconds() as f64 / 60.0);
        }
    }
    let labels: Vec<String> = by_day.keys().map(|d| d[5..].to_string()).collect();
    let series = ["Critical", "Warning", "Info"]
        .iter()
        .enumerate()
        .map(|(i, name)| Series {
            name: (*name).into(),
            values: by_day.values().map(|v| v[i]).collect(),
        })
        .collect();
    let now = rustrmm_common::now();
    Ok(vec![
        Section::Kpis {
            title: "Summary".into(),
            items: vec![
                kpi("Alerts", rows.len()),
                toned(
                    kpi("Critical", sev.get("critical").copied().unwrap_or(0)),
                    "bad",
                ),
                toned(
                    kpi("Warning", sev.get("warning").copied().unwrap_or(0)),
                    "warn",
                ),
                kpi("Info", sev.get("info").copied().unwrap_or(0)),
                kpi("MTTA", avg(&mtta).map(Value::from).unwrap_or(Value::Null)).unit("min"),
                kpi("MTTR", avg(&mttr).map(Value::from).unwrap_or(Value::Null)).unit("min"),
            ],
        },
        Section::Chart {
            title: "Alerts per day".into(),
            chart: "bar".into(),
            labels,
            series,
            unit: None,
        },
        table(
            "Alerts",
            vec![
                fmt(col("opened_at", "Opened"), "datetime"),
                col("device", "Device"),
                col("client", "Client"),
                col("severity", "Severity"),
                col("title", "Alert"),
                col("status", "Status"),
                fmt(num("duration", "Duration"), "duration"),
                col("resolution", "Resolution"),
                num("occurrences", "Count"),
            ],
            rows.iter()
                .map(|r| {
                    let end = r.resolved_at.unwrap_or(now);
                    vec![
                        json!(r.opened_at),
                        json!(r.hostname.clone().unwrap_or_default()),
                        json!(r.client_name),
                        json!(r.severity),
                        json!(r.title),
                        json!(r.status),
                        json!(((end - r.opened_at).num_seconds() as f64 / 60.0).round()),
                        json!(r.resolution.clone().unwrap_or_default()),
                        json!(r.occurrences),
                    ]
                })
                .collect(),
        ),
    ])
}

// ------------------------------------------------------------------ security posture

pub async fn security_posture(ctx: &Ctx<'_>) -> Result<Vec<Section>> {
    let security = inventory(ctx.state, "security").await?;
    let devices: Vec<Dev> = devices(ctx, perm::DEVICES_VIEW)
        .await?
        .into_iter()
        .filter(|d| d.status == "active")
        .collect();
    let mut summary = Summary::default();
    let mut rows = Vec::new();
    let mark = |p: Option<bool>| match p {
        Some(true) => json!("Pass"),
        Some(false) => json!("Fail"),
        None => Value::Null,
    };
    let mut failing_devices = 0usize;
    for d in &devices {
        let checks = security_checks(security.get(&d.id));
        let mut failures = Vec::new();
        let mut row = vec![json!(d.hostname), json!(d.client_name)];
        for (name, passed, reason) in &checks {
            if let Some(p) = passed {
                *summary.sec_total.entry(name).or_default() += 1;
                if *p {
                    *summary.sec_pass.entry(name).or_default() += 1;
                } else {
                    failures.push(reason.clone().unwrap_or_else(|| (*name).to_string()));
                }
            }
            row.push(mark(*passed));
        }
        if !failures.is_empty() {
            failing_devices += 1;
        }
        row.push(json!(failures.join("; ")));
        rows.push(row);
    }
    let all_pass = devices.len() - failing_devices;
    Ok(vec![
        Section::Kpis {
            title: "Summary".into(),
            items: vec![
                kpi("Devices", devices.len()),
                toned(kpi("Passing every check", all_pass), "good"),
                toned(
                    kpi("With failures", failing_devices),
                    if failing_devices > 0 { "bad" } else { "good" },
                ),
                toned(
                    kpi("Encrypted", pct_value(summary.sec("Disk encryption"))).unit_pct(),
                    tone_for(summary.sec("Disk encryption"), 95.0, 80.0),
                ),
            ],
        },
        table(
            "Checks",
            vec![
                col("check", "Check"),
                num("passing", "Passing"),
                num("failing", "Failing"),
                fmt(num("pct", "Passing %"), "percent"),
            ],
            security_rows(&summary),
        ),
        table(
            "Devices",
            vec![
                col("hostname", "Device"),
                col("client", "Client"),
                col("antivirus", "AV"),
                col("firewall", "Firewall"),
                col("encryption", "Encryption"),
                col("local_admins", "Admins"),
                col("uac", "UAC"),
                col("smb1", "SMBv1 off"),
                col("autologon", "No auto-logon"),
                col("failing", "Failing items"),
            ],
            rows,
        ),
    ])
}

// ------------------------------------------------------------------ agent status

pub async fn agent_status(ctx: &Ctx<'_>) -> Result<Vec<Section>> {
    let latest = latest_agent(ctx.state).await?;
    let all = devices(ctx, perm::DEVICES_VIEW).await?;
    let active: Vec<&Dev> = all.iter().filter(|d| d.status == "active").collect();
    let pending: Vec<&Dev> = all.iter().filter(|d| d.status == "pending").collect();
    let offline: Vec<&Dev> = active.iter().copied().filter(|d| !d.online).collect();
    let mut versions: BTreeMap<String, usize> = BTreeMap::new();
    let mut outdated = 0usize;
    for d in &active {
        *versions.entry(d.agent_version.clone()).or_default() += 1;
        if let Some(l) = &latest
            && rustrmm_proto::commands::version_cmp(&d.agent_version, l).is_lt()
        {
            outdated += 1;
        }
    }
    let mut version_rows: Vec<(String, usize)> = versions.into_iter().collect();
    version_rows.sort_by(|a, b| rustrmm_proto::commands::version_cmp(&b.0, &a.0));
    let now = rustrmm_common::now();
    Ok(vec![
        Section::Kpis {
            title: "Summary".into(),
            items: vec![
                kpi("Active agents", active.len()),
                toned(kpi("Online", active.len() - offline.len()), "good"),
                toned(
                    kpi("Offline", offline.len()),
                    if offline.is_empty() { "good" } else { "warn" },
                ),
                toned(
                    kpi("Pending approval", pending.len()),
                    if pending.is_empty() { "good" } else { "warn" },
                ),
                toned(
                    kpi("Outdated", outdated),
                    if outdated > 0 { "warn" } else { "good" },
                ),
                kpi(
                    "Latest release",
                    latest.clone().map(Value::from).unwrap_or(Value::Null),
                ),
            ],
        },
        table(
            "Versions",
            vec![
                col("version", "Version"),
                num("devices", "Devices"),
                col("current", "Current"),
            ],
            version_rows
                .into_iter()
                .map(|(v, n)| {
                    let current = latest.as_deref().map(|l| l == v);
                    vec![
                        json!(v),
                        json!(n),
                        current.map(Value::from).unwrap_or(Value::Null),
                    ]
                })
                .collect(),
        ),
        table(
            "Offline devices",
            vec![
                col("hostname", "Device"),
                col("client", "Client"),
                col("site", "Site"),
                fmt(col("last_seen", "Last seen"), "datetime"),
                num("days", "Days offline"),
                col("version", "Agent"),
            ],
            offline
                .iter()
                .map(|d| {
                    vec![
                        json!(d.hostname),
                        json!(d.client_name),
                        json!(d.site_name),
                        json!(d.last_seen_at),
                        d.last_seen_at
                            .map(|t| Value::from((now - t).num_days()))
                            .unwrap_or(Value::Null),
                        json!(d.agent_version),
                    ]
                })
                .collect(),
        ),
        table(
            "Pending approval",
            vec![
                col("hostname", "Device"),
                col("client", "Client"),
                col("site", "Site"),
                fmt(col("enrolled", "Enrolled"), "datetime"),
                col("os", "OS"),
            ],
            pending
                .iter()
                .map(|d| {
                    vec![
                        json!(d.hostname),
                        json!(d.client_name),
                        json!(d.site_name),
                        json!(d.enrolled_at),
                        json!(os_label(d)),
                    ]
                })
                .collect(),
        ),
    ])
}

// ------------------------------------------------------------------ tickets and time

pub async fn tickets_time(ctx: &Ctx<'_>) -> Result<Vec<Section>> {
    let tickets = ticket_facts(ctx).await?;
    let names: HashMap<String, String> =
        sqlx::query_as::<_, (String, String)>("SELECT id, name FROM clients")
            .fetch_all(&ctx.state.db)
            .await?
            .into_iter()
            .collect();
    #[derive(Default)]
    struct Row {
        opened: usize,
        resolved: usize,
        within: usize,
        breached: usize,
        minutes: i64,
        billable: i64,
    }
    let mut by_client: BTreeMap<String, Row> = BTreeMap::new();
    for t in &tickets {
        let r = by_client
            .entry(names.get(&t.client_id).cloned().unwrap_or_default())
            .or_default();
        if t.created_at >= ctx.from && t.created_at < ctx.to {
            r.opened += 1;
        }
        if let Some(res) = t.resolved_at
            && res >= ctx.from
            && res < ctx.to
        {
            r.resolved += 1;
            if !t.resolution_breached {
                r.within += 1;
            } else {
                r.breached += 1;
            }
        }
    }
    let entries: Vec<(String, Option<String>, String, String, i64, bool)> = sqlx::query_as(
        "SELECT t.client_id, t.site_id, c.name, e.user_name, e.minutes, e.billable FROM time_entries e
         JOIN tickets t ON t.id = e.ticket_id JOIN clients c ON c.id = t.client_id
         WHERE e.started_at >= ? AND e.started_at < ?",
    )
    .bind(ctx.from)
    .bind(ctx.to)
    .fetch_all(&ctx.state.db)
    .await?;
    let mut by_user: BTreeMap<String, (i64, i64)> = BTreeMap::new();
    let (mut minutes, mut billable) = (0i64, 0i64);
    for (client, site, client_name, user, m, bill) in entries {
        if !ctx.allows(perm::TICKETS_VIEW, &client, site.as_deref()) {
            continue;
        }
        let r = by_client.entry(client_name).or_default();
        r.minutes += m;
        minutes += m;
        let u = by_user
            .entry(if user.is_empty() { "—".into() } else { user })
            .or_default();
        u.0 += m;
        if bill {
            r.billable += m;
            u.1 += m;
            billable += m;
        }
    }
    let opened: usize = by_client.values().map(|r| r.opened).sum();
    let resolved: usize = by_client.values().map(|r| r.resolved).sum();
    let within: usize = by_client.values().map(|r| r.within).sum();
    let sla = pct(within, resolved);
    let hours = |m: i64| (m as f64 / 6.0).round() / 10.0;
    Ok(vec![
        Section::Kpis {
            title: "Summary".into(),
            items: vec![
                kpi("Opened", opened),
                kpi("Resolved", resolved),
                toned(
                    kpi("SLA met", pct_value(sla)).unit_pct(),
                    tone_for(sla, 95.0, 85.0),
                ),
                kpi("Time logged", hours(minutes)).unit("h"),
                kpi("Billable", hours(billable)).unit("h"),
            ],
        },
        table(
            "By client",
            vec![
                col("client", "Client"),
                num("opened", "Opened"),
                num("resolved", "Resolved"),
                num("within_sla", "Within SLA"),
                num("breached", "Breached"),
                fmt(num("sla", "SLA met"), "percent"),
                num("hours", "Hours"),
                num("billable", "Billable hours"),
            ],
            by_client
                .iter()
                .filter(|(_, r)| r.opened + r.resolved > 0 || r.minutes > 0)
                .map(|(name, r)| {
                    vec![
                        json!(name),
                        json!(r.opened),
                        json!(r.resolved),
                        json!(r.within),
                        json!(r.breached),
                        pct_value(pct(r.within, r.resolved)),
                        json!(hours(r.minutes)),
                        json!(hours(r.billable)),
                    ]
                })
                .collect(),
        ),
        table(
            "Time by user",
            vec![
                col("user", "User"),
                num("hours", "Hours"),
                num("billable", "Billable hours"),
            ],
            by_user
                .iter()
                .map(|(u, (m, b))| vec![json!(u), json!(hours(*m)), json!(hours(*b))])
                .collect(),
        ),
    ])
}

// ------------------------------------------------------------------ audit

pub async fn audit(ctx: &Ctx<'_>) -> Result<Vec<Section>> {
    let fmt_time = |t: DateTime<Utc>| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
        "SELECT at, actor_name, action, target_type, target_name, client_id, ip FROM audit_log WHERE at >= ",
    );
    qb.push_bind(fmt_time(ctx.from))
        .push(" AND at < ")
        .push_bind(fmt_time(ctx.to));
    if let Some(action) = ctx.params.action.as_deref().filter(|a| !a.is_empty()) {
        qb.push(" AND action LIKE ")
            .push_bind(format!("{}%", action.replace(['%', '_'], "")));
    }
    if let Some(actor) = ctx.params.actor.as_deref().filter(|a| !a.is_empty()) {
        qb.push(" AND (actor_id = ")
            .push_bind(actor.to_string())
            .push(" OR actor_name LIKE ")
            .push_bind(format!("%{}%", actor.replace(['%', '_'], "")))
            .push(")");
    }
    qb.push(" ORDER BY id DESC LIMIT 20000");
    let rows: Vec<(
        String,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    )> = qb.build_query_as().fetch_all(&ctx.state.db).await?;
    let global = ctx.scope.has_global(perm::AUDIT_VIEW);
    let names: HashMap<String, String> =
        sqlx::query_as::<_, (String, String)>("SELECT id, name FROM clients")
            .fetch_all(&ctx.state.db)
            .await?
            .into_iter()
            .collect();
    let mut by_action: BTreeMap<String, usize> = BTreeMap::new();
    let mut out = Vec::new();
    for (at, actor, action, target_type, target_name, client_id, ip) in rows {
        // Installation-wide entries need the permission globally; client entries need it there.
        let visible = match (&client_id, &ctx.client) {
            (Some(c), Some(want)) => c == want && ctx.scope.can_client(perm::AUDIT_VIEW, c),
            (Some(c), None) => ctx.scope.can_client(perm::AUDIT_VIEW, c),
            (None, Some(_)) => false,
            (None, None) => global,
        };
        if !visible {
            continue;
        }
        *by_action.entry(action.clone()).or_default() += 1;
        let target = match (target_type, target_name) {
            (Some(t), Some(n)) => format!("{t}: {n}"),
            (Some(t), None) => t,
            _ => String::new(),
        };
        out.push(vec![
            json!(at),
            json!(actor.unwrap_or_default()),
            json!(action),
            json!(target),
            json!(
                client_id
                    .and_then(|c| names.get(&c).cloned())
                    .unwrap_or_default()
            ),
            json!(ip.unwrap_or_default()),
        ]);
    }
    let mut actions: Vec<(String, usize)> = by_action.into_iter().collect();
    actions.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    Ok(vec![
        Section::Kpis {
            title: "Summary".into(),
            items: vec![
                kpi("Entries", out.len()),
                kpi("Distinct actions", actions.len()),
            ],
        },
        table(
            "Most frequent actions",
            vec![col("action", "Action"), num("count", "Entries")],
            actions
                .into_iter()
                .take(15)
                .map(|(a, n)| vec![json!(a), json!(n)])
                .collect(),
        ),
        table(
            "Audit log",
            vec![
                fmt(col("at", "Time"), "datetime"),
                col("actor", "Actor"),
                col("action", "Action"),
                col("target", "Target"),
                col("client", "Client"),
                col("ip", "IP"),
            ],
            out,
        ),
    ])
}

/// Runs one report type.
pub async fn generate(ctx: &Ctx<'_>, kind: &str) -> Result<Report> {
    let def = super::TYPES
        .iter()
        .find(|t| t.kind == kind)
        .ok_or_else(|| anyhow::anyhow!("unknown report type {kind}"))?;
    if kind == "executive_summary" {
        snapshot_health(ctx.state).await?;
    }
    let sections = match kind {
        "executive_summary" => executive_summary(ctx).await?,
        "hardware_inventory" => hardware_inventory(ctx).await?,
        "software_inventory" => software_inventory(ctx).await?,
        "patch_compliance" => patch_compliance(ctx).await?,
        "alert_history" => alert_history(ctx).await?,
        "security_posture" => security_posture(ctx).await?,
        "agent_status" => agent_status(ctx).await?,
        "tickets_time" => tickets_time(ctx).await?,
        "audit" => audit(ctx).await?,
        other => anyhow::bail!("unknown report type {other}"),
    };
    let client = match &ctx.client {
        Some(id) => sqlx::query_scalar::<_, String>("SELECT name FROM clients WHERE id = ?")
            .bind(id)
            .fetch_optional(&ctx.state.db)
            .await?
            .map(|name| ClientRef {
                id: id.clone(),
                name,
            }),
        None => None,
    };
    let site_name: Option<String> = match &ctx.site {
        Some(id) => {
            sqlx::query_scalar("SELECT name FROM sites WHERE id = ?")
                .bind(id)
                .fetch_optional(&ctx.state.db)
                .await?
        }
        None => None,
    };
    let subtitle = match (&client, site_name) {
        (Some(c), Some(s)) => Some(format!("{} / {s}", c.name)),
        (Some(c), None) => Some(c.name.clone()),
        (None, _) => Some("All clients".into()),
    };
    Ok(Report {
        kind: kind.to_string(),
        title: def.name.to_string(),
        subtitle,
        generated_at: rustrmm_common::now(),
        period: Period {
            from: ctx.from,
            to: ctx.to,
        },
        client,
        sections,
    })
}
