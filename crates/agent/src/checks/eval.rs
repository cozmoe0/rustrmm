//! Pure threshold evaluation and debouncing, kept free of I/O so every rule is unit-tested.

use rustrmm_proto::monitoring::CheckState;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Outcome of one evaluation.
#[derive(Debug, Clone, PartialEq)]
pub struct Evaluation {
    pub state: CheckState,
    pub message: String,
    pub value: Option<f64>,
}

impl Evaluation {
    pub fn new(state: CheckState, message: impl Into<String>, value: Option<f64>) -> Self {
        Self {
            state,
            message: message.into(),
            value,
        }
    }

    pub fn ok(message: impl Into<String>) -> Self {
        Self::new(CheckState::Ok, message, None)
    }

    /// A failing single-condition check (the server applies the configured severity).
    pub fn failing(message: impl Into<String>) -> Self {
        Self::new(CheckState::Critical, message, None)
    }

    pub fn unknown(message: impl Into<String>) -> Self {
        Self::new(CheckState::Unknown, message, None)
    }

    pub fn with_value(mut self, value: f64) -> Self {
        self.value = value.is_finite().then_some(value);
        self
    }
}

/// Typed access to a check's `config`.
pub struct Config<'a>(pub &'a Map<String, Value>);

impl Config<'_> {
    pub fn num(&self, key: &str) -> Option<f64> {
        self.0
            .get(key)
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite())
    }

    pub fn num_or(&self, key: &str, default: f64) -> f64 {
        self.num(key).unwrap_or(default)
    }

    pub fn text(&self, key: &str) -> Option<&str> {
        self.0
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
    }

    pub fn flag(&self, key: &str, default: bool) -> bool {
        self.0.get(key).and_then(Value::as_bool).unwrap_or(default)
    }

    pub fn numbers(&self, key: &str) -> Vec<u64> {
        self.0
            .get(key)
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_u64).collect())
            .unwrap_or_default()
    }
}

/// Higher is worse (CPU, memory, uptime).
pub fn high(value: f64, warn: f64, crit: f64) -> CheckState {
    if value >= crit {
        CheckState::Critical
    } else if value >= warn {
        CheckState::Warning
    } else {
        CheckState::Ok
    }
}

fn worse(a: CheckState, b: CheckState) -> CheckState {
    let rank = |s: CheckState| match s {
        CheckState::Ok => 0,
        CheckState::Unknown => 1,
        CheckState::Warning => 2,
        CheckState::Critical => 3,
    };
    if rank(b) > rank(a) { b } else { a }
}

pub fn usage(label: &str, avg: f64, window_minutes: f64, cfg: &Config<'_>) -> Evaluation {
    let state = high(
        avg,
        cfg.num_or("warn_pct", 85.0),
        cfg.num_or("crit_pct", 95.0),
    );
    Evaluation::new(
        state,
        format!("{label} {avg:.0}% (average over {window_minutes:.0} min)"),
        Some(avg),
    )
}

/// One volume for the disk check.
#[derive(Debug, Clone, PartialEq)]
pub struct Volume {
    pub mount: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
}

const GB: f64 = 1_073_741_824.0;

/// Whether a volume matches the configured one (`C:`, `C:\`, `/`, case-insensitive on
/// Windows-style drive letters).
pub fn volume_matches(mount: &str, wanted: &str) -> bool {
    let norm = |s: &str| {
        let s = s.trim();
        let s = if s.len() > 1 {
            s.trim_end_matches(['\\', '/'])
        } else {
            s
        };
        if s.len() == 2 && s.ends_with(':') {
            s.to_ascii_uppercase()
        } else {
            s.to_string()
        }
    };
    norm(mount) == norm(wanted)
}

pub fn disk(volumes: &[Volume], cfg: &Config<'_>) -> Evaluation {
    let wanted = cfg.text("volume").unwrap_or("*");
    let selected: Vec<&Volume> = volumes
        .iter()
        .filter(|v| v.total_bytes > 0 && (wanted == "*" || volume_matches(&v.mount, wanted)))
        .collect();
    if selected.is_empty() {
        return Evaluation::unknown(if wanted == "*" {
            "no fixed volumes found".to_string()
        } else {
            format!("volume {wanted} not found")
        });
    }
    let mut worst: Option<(CheckState, f64, &Volume)> = None;
    for v in selected {
        let pct = v.free_bytes as f64 / v.total_bytes as f64 * 100.0;
        let gb = v.free_bytes as f64 / GB;
        let below = |key: &str, value: f64| cfg.num(key).is_some_and(|t| value < t);
        let state = if below("crit_free_pct", pct) || below("crit_free_gb", gb) {
            CheckState::Critical
        } else if below("warn_free_pct", pct) || below("warn_free_gb", gb) {
            CheckState::Warning
        } else {
            CheckState::Ok
        };
        let replace = match &worst {
            None => true,
            Some((s, p, _)) => worse(*s, state) != *s || (state == *s && pct < *p),
        };
        if replace {
            worst = Some((state, pct, v));
        }
    }
    let (state, pct, v) = worst.expect("at least one volume");
    Evaluation::new(
        state,
        format!(
            "{} {pct:.0}% free ({:.1} GB of {:.0} GB)",
            v.mount,
            v.free_bytes as f64 / GB,
            v.total_bytes as f64 / GB
        ),
        Some((pct * 10.0).round() / 10.0),
    )
}

pub fn uptime(seconds: u64, cfg: &Config<'_>) -> Evaluation {
    let days = seconds as f64 / 86_400.0;
    let state = high(
        days,
        cfg.num_or("warn_days", 30.0),
        cfg.num_or("crit_days", 60.0),
    );
    Evaluation::new(
        state,
        format!("up {days:.1} days"),
        Some((days * 10.0).round() / 10.0),
    )
}

/// Certificate expiry: `days_left` may be negative (expired).
pub fn certificate(subject: &str, days_left: f64, cfg: &Config<'_>) -> Evaluation {
    let crit = cfg.num_or("crit_days", 7.0);
    let warn = cfg.num_or("warn_days", 30.0);
    let state = if days_left <= crit {
        CheckState::Critical
    } else if days_left <= warn {
        CheckState::Warning
    } else {
        CheckState::Ok
    };
    let message = if days_left < 0.0 {
        format!("{subject} expired {:.0} days ago", -days_left)
    } else {
        format!("{subject} expires in {:.0} days", days_left.floor())
    };
    Evaluation::new(state, message, Some(days_left.floor()))
}

/// Script exit codes: 0 ok, 1 warning, anything else (or no code) critical.
pub fn script_exit(code: Option<i64>, timed_out: bool, last_line: &str) -> Evaluation {
    let state = match (timed_out, code) {
        (true, _) => CheckState::Critical,
        (false, Some(0)) => CheckState::Ok,
        (false, Some(1)) => CheckState::Warning,
        _ => CheckState::Critical,
    };
    let message = if timed_out {
        "the script timed out".to_string()
    } else if last_line.is_empty() {
        match code {
            Some(c) => format!("exit code {c}"),
            None => "the script was killed".to_string(),
        }
    } else {
        last_line.chars().take(300).collect()
    };
    let mut e = Evaluation::new(state, message, None);
    if let Some(c) = code {
        e = e.with_value(c as f64);
    }
    e
}

/// The last non-empty line of script output.
pub fn last_line(stdout: &str) -> String {
    stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or_default()
        .to_string()
}

pub fn ping(target: &str, loss_pct: f64, avg_rtt: Option<f64>, cfg: &Config<'_>) -> Evaluation {
    let max_loss = cfg.num_or("max_loss_pct", 50.0);
    let rtt_text = avg_rtt
        .map(|r| format!(", {r:.0} ms average"))
        .unwrap_or_default();
    if loss_pct > max_loss || avg_rtt.is_none() && loss_pct >= 100.0 {
        return Evaluation::failing(format!("{target}: {loss_pct:.0}% loss{rtt_text}"))
            .with_value(loss_pct);
    }
    if let (Some(max), Some(rtt)) = (cfg.num("max_rtt_ms"), avg_rtt)
        && rtt > max
    {
        return Evaluation::failing(format!("{target}: {rtt:.0} ms average (limit {max:.0} ms)"))
            .with_value(rtt);
    }
    Evaluation::ok(format!("{target}: {loss_pct:.0}% loss{rtt_text}"))
        .with_value(avg_rtt.unwrap_or(loss_pct))
}

/// Facts gathered by the HTTP probe.
#[derive(Debug, Clone, Default)]
pub struct HttpFacts {
    pub status: u16,
    pub latency_ms: f64,
    pub keyword_found: Option<bool>,
    pub cert_days_left: Option<f64>,
}

pub fn http(url: &str, f: &HttpFacts, cfg: &Config<'_>) -> Evaluation {
    let expect = cfg.num_or("expect_status", 200.0) as u16;
    if f.status != expect {
        return Evaluation::new(
            CheckState::Critical,
            format!("{url} answered {} (expected {expect})", f.status),
            Some(f64::from(f.status)),
        );
    }
    if f.keyword_found == Some(false) {
        return Evaluation::new(
            CheckState::Critical,
            format!("{url}: keyword not found"),
            Some(f.latency_ms),
        );
    }
    if let Some(max) = cfg.num("max_latency_ms")
        && f.latency_ms > max
    {
        return Evaluation::new(
            CheckState::Warning,
            format!("{url} took {:.0} ms (limit {max:.0} ms)", f.latency_ms),
            Some(f.latency_ms),
        );
    }
    if let Some(days) = f.cert_days_left {
        let warn = cfg.num_or("cert_warn_days", 14.0);
        if days < 0.0 {
            return Evaluation::new(
                CheckState::Critical,
                format!("{url}: certificate expired"),
                Some(days),
            );
        }
        if warn > 0.0 && days <= warn {
            return Evaluation::new(
                CheckState::Warning,
                format!("{url}: certificate expires in {:.0} days", days.floor()),
                Some(days.floor()),
            );
        }
    }
    Evaluation::ok(format!(
        "{url} answered {} in {:.0} ms",
        f.status, f.latency_ms
    ))
    .with_value(f.latency_ms)
}

pub fn pending_reboot(pending: bool, hours: f64, cfg: &Config<'_>) -> Evaluation {
    if !pending {
        return Evaluation::ok("no restart pending");
    }
    let limit = cfg.num_or("warn_after_hours", 72.0);
    let e = if hours >= limit {
        Evaluation::failing(format!("a restart has been pending for {hours:.0} h"))
    } else {
        Evaluation::ok(format!("a restart is pending ({hours:.0} h)"))
    };
    e.with_value(hours.floor())
}

pub fn antivirus(
    real_time: Option<bool>,
    signature_age_hours: Option<f64>,
    product: &str,
    cfg: &Config<'_>,
) -> Evaluation {
    match real_time {
        None => Evaluation::unknown("no antivirus status available"),
        Some(false) => Evaluation::new(
            CheckState::Critical,
            format!("{product}: real-time protection is off"),
            None,
        ),
        Some(true) => {
            let max = cfg.num_or("max_signature_age_hours", 72.0);
            match signature_age_hours {
                Some(age) if age > max => Evaluation::new(
                    CheckState::Warning,
                    format!("{product}: signatures are {age:.0} h old"),
                    Some(age),
                ),
                Some(age) => Evaluation::ok(format!(
                    "{product}: protection on, signatures {age:.0} h old"
                ))
                .with_value(age),
                None => Evaluation::ok(format!("{product}: protection on")),
            }
        }
    }
}

pub fn firewall(profiles: &[(String, bool)]) -> Evaluation {
    if profiles.is_empty() {
        return Evaluation::unknown("firewall state unavailable");
    }
    let off: Vec<&str> = profiles
        .iter()
        .filter(|(_, on)| !on)
        .map(|(n, _)| n.as_str())
        .collect();
    if off.is_empty() {
        Evaluation::ok("firewall enabled")
    } else {
        Evaluation::failing(format!("firewall disabled: {}", off.join(", ")))
    }
}

/// File facts: `None` when the file does not exist.
pub fn file(path: &str, facts: Option<(f64, f64)>, cfg: &Config<'_>) -> Evaluation {
    let condition = cfg.text("condition").unwrap_or("exists");
    match (condition, facts) {
        ("exists", Some(_)) => Evaluation::ok(format!("{path} exists")),
        ("exists", None) => Evaluation::failing(format!("{path} is missing")),
        ("missing", None) => Evaluation::ok(format!("{path} is absent")),
        ("missing", Some(_)) => Evaluation::failing(format!("{path} exists")),
        (_, None) => Evaluation::failing(format!("{path} is missing")),
        ("older_than", Some((age_min, _))) => {
            let limit = cfg.num_or("minutes", 60.0);
            if age_min > limit {
                Evaluation::failing(format!("{path} was last modified {age_min:.0} min ago"))
                    .with_value(age_min)
            } else {
                Evaluation::ok(format!("{path} modified {age_min:.0} min ago")).with_value(age_min)
            }
        }
        ("larger_than", Some((_, size_mb))) => {
            let limit = cfg.num_or("size_mb", 100.0);
            if size_mb > limit {
                Evaluation::failing(format!("{path} is {size_mb:.1} MB (limit {limit} MB)"))
                    .with_value(size_mb)
            } else {
                Evaluation::ok(format!("{path} is {size_mb:.1} MB")).with_value(size_mb)
            }
        }
        (other, _) => Evaluation::unknown(format!("unknown condition {other}")),
    }
}

pub fn windows_update(
    days_since: Option<f64>,
    recent_failures: u32,
    cfg: &Config<'_>,
) -> Evaluation {
    let limit = cfg.num_or("warn_days_since_install", 35.0);
    if cfg.flag("alert_on_failures", true) && recent_failures > 0 {
        return Evaluation::failing(format!(
            "{recent_failures} update installation(s) failed recently"
        ));
    }
    match days_since {
        None => Evaluation::unknown("no update installation history"),
        Some(days) if days > limit => {
            Evaluation::failing(format!("updates last installed {days:.0} days ago"))
                .with_value(days.floor())
        }
        Some(days) => {
            Evaluation::ok(format!("updates installed {days:.0} days ago")).with_value(days.floor())
        }
    }
}

pub fn battery(health_pct: Option<f64>, cfg: &Config<'_>) -> Evaluation {
    match health_pct {
        None => Evaluation::ok("no battery present"),
        Some(h) => {
            let min = cfg.num_or("min_health_pct", 60.0);
            if h < min {
                Evaluation::failing(format!("battery health {h:.0}% (minimum {min:.0}%)"))
                    .with_value(h)
            } else {
                Evaluation::ok(format!("battery health {h:.0}%")).with_value(h)
            }
        }
    }
}

pub fn event_log(log: &str, count: u64, cfg: &Config<'_>) -> Evaluation {
    let threshold = cfg.num_or("threshold", 1.0).max(1.0) as u64;
    let window = cfg.num_or("window_minutes", 15.0);
    let message = format!("{count} matching event(s) in {log} in the last {window:.0} min");
    if count >= threshold {
        Evaluation::failing(message).with_value(count as f64)
    } else {
        Evaluation::ok(message).with_value(count as f64)
    }
}

/// Facts for the process check: matching process count, summed CPU (% of the machine) and
/// memory (MB).
pub fn process(name: &str, count: usize, cpu: f64, memory_mb: f64, cfg: &Config<'_>) -> Evaluation {
    let expected = cfg.text("expected").unwrap_or("running");
    if expected == "not_running" {
        return if count == 0 {
            Evaluation::ok(format!("{name} is not running"))
        } else {
            Evaluation::failing(format!("{name} is running ({count} process(es))"))
        };
    }
    if count == 0 {
        return Evaluation::failing(format!("{name} is not running"));
    }
    if let Some(max) = cfg.num("max_cpu_pct")
        && cpu > max
    {
        return Evaluation::failing(format!("{name} uses {cpu:.0}% CPU (limit {max:.0}%)"))
            .with_value(cpu);
    }
    if let Some(max) = cfg.num("max_memory_mb")
        && memory_mb > max
    {
        return Evaluation::failing(format!("{name} uses {memory_mb:.0} MB (limit {max:.0} MB)"))
            .with_value(memory_mb);
    }
    Evaluation::ok(format!(
        "{name} running ({count}), {cpu:.0}% CPU, {memory_mb:.0} MB"
    ))
    .with_value(cpu)
}

/// Service state against the expectation. `state` is `None` when the service does not exist.
pub fn service(name: &str, state: Option<&str>, cfg: &Config<'_>) -> Evaluation {
    let expected = cfg.text("expected").unwrap_or("running");
    match state {
        None => Evaluation::failing(format!("service {name} not found")),
        Some(s) if (expected == "running") == (s == "running") => {
            Evaluation::ok(format!("{name} is {s}"))
        }
        Some(s) => Evaluation::failing(format!("{name} is {s} (expected {expected})")),
    }
}

/// Debounce: a new state must hold for two consecutive evaluations unless it is critical. The
/// first `ok` after start is reported immediately.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Debounce {
    pub reported: Option<CheckState>,
    pub candidate: Option<CheckState>,
    pub count: u32,
    pub raw: Option<CheckState>,
    pub streak: u32,
}

impl Debounce {
    /// Feeds one evaluation; returns the new reported state on a transition.
    pub fn feed(&mut self, state: CheckState) -> Option<CheckState> {
        if self.raw == Some(state) {
            self.streak = self.streak.saturating_add(1);
        } else {
            self.raw = Some(state);
            self.streak = 1;
        }
        if self.reported == Some(state) {
            self.candidate = None;
            self.count = 0;
            return None;
        }
        let immediate =
            state == CheckState::Critical || (self.reported.is_none() && state == CheckState::Ok);
        if self.candidate == Some(state) {
            self.count += 1;
        } else {
            self.candidate = Some(state);
            self.count = 1;
        }
        if immediate || self.count >= 2 {
            self.reported = Some(state);
            self.candidate = None;
            self.count = 0;
            return Some(state);
        }
        None
    }

    /// Consecutive evaluations of the reported state.
    pub fn reported_streak(&self) -> u32 {
        if self.raw.is_some() && self.raw == self.reported {
            self.streak
        } else {
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use CheckState::*;
    use serde_json::json;

    fn cfg(v: Value) -> Map<String, Value> {
        v.as_object().cloned().expect("object")
    }

    #[test]
    fn debounce_needs_two_evaluations_unless_critical() {
        let mut d = Debounce::default();
        assert_eq!(d.feed(Ok), Some(Ok), "first ok is reported at once");
        assert_eq!(d.feed(Ok), None);
        assert_eq!(d.feed(Warning), None, "one warning is not enough");
        assert_eq!(d.feed(Ok), None, "flapping back resets the candidate");
        assert_eq!(d.feed(Warning), None);
        assert_eq!(d.feed(Warning), Some(Warning));
        assert_eq!(d.feed(Critical), Some(Critical), "critical is immediate");
        assert_eq!(d.feed(Critical), None);
        assert_eq!(d.reported_streak(), 2);
        assert_eq!(d.feed(Ok), None);
        assert_eq!(d.feed(Ok), Some(Ok), "recovery is debounced too");
        assert_eq!(d.feed(Unknown), None);
        assert_eq!(d.feed(Unknown), Some(Unknown));
        assert_eq!(d.feed(Unknown), None);
        assert_eq!(d.reported_streak(), 3, "unknown streak keeps counting");
        let mut fresh = Debounce::default();
        assert_eq!(fresh.feed(Warning), None, "a first warning waits");
        assert_eq!(fresh.feed(Warning), Some(Warning));
        let mut fresh = Debounce::default();
        assert_eq!(fresh.feed(Critical), Some(Critical));
    }

    #[test]
    fn usage_thresholds() {
        let c = cfg(json!({ "warn_pct": 80, "crit_pct": 90 }));
        assert_eq!(usage("CPU", 79.9, 5.0, &Config(&c)).state, Ok);
        assert_eq!(usage("CPU", 80.0, 5.0, &Config(&c)).state, Warning);
        assert_eq!(usage("CPU", 95.0, 5.0, &Config(&c)).state, Critical);
        let defaults = Map::new();
        assert_eq!(
            usage("Memory", 90.0, 5.0, &Config(&defaults)).state,
            Warning
        );
    }

    #[test]
    fn disk_thresholds_and_worst_volume() {
        let gb = 1_073_741_824u64;
        let volumes = vec![
            Volume {
                mount: "C:\\".into(),
                total_bytes: 100 * gb,
                free_bytes: 40 * gb,
            },
            Volume {
                mount: "D:\\".into(),
                total_bytes: 100 * gb,
                free_bytes: 8 * gb,
            },
            Volume {
                mount: "E:\\".into(),
                total_bytes: 1000 * gb,
                free_bytes: 300 * gb,
            },
        ];
        let c = cfg(json!({ "volume": "*", "warn_free_pct": 15, "crit_free_pct": 5 }));
        let e = disk(&volumes, &Config(&c));
        assert_eq!(e.state, Warning);
        assert!(e.message.starts_with("D:\\ 8% free"), "{}", e.message);
        let c = cfg(json!({ "volume": "c:", "warn_free_pct": 50 }));
        assert_eq!(
            disk(&volumes, &Config(&c)).state,
            Warning,
            "C: has 40% free"
        );
        let c = cfg(json!({ "volume": "*", "crit_free_gb": 10 }));
        assert_eq!(disk(&volumes, &Config(&c)).state, Critical, "D: has 8 GB");
        let c = cfg(json!({ "volume": "Z:", "warn_free_pct": 10 }));
        assert_eq!(disk(&volumes, &Config(&c)).state, Unknown);
        assert!(volume_matches("/", "/"));
        assert!(volume_matches("/var/", "/var"));
        assert!(!volume_matches("/var", "/"));
    }

    #[test]
    fn single_and_graded_checks() {
        let none = Map::new();
        let c = Config(&none);
        assert_eq!(uptime(31 * 86_400, &c).state, Warning);
        assert_eq!(uptime(61 * 86_400, &c).state, Critical);
        assert_eq!(uptime(86_400, &c).state, Ok);
        assert_eq!(certificate("CN=x", 40.0, &c).state, Ok);
        assert_eq!(certificate("CN=x", 20.0, &c).state, Warning);
        assert_eq!(certificate("CN=x", 3.0, &c).state, Critical);
        assert!(certificate("CN=x", -2.0, &c).message.contains("expired"));
        assert_eq!(script_exit(Some(0), false, "all good").state, Ok);
        assert_eq!(script_exit(Some(1), false, "").state, Warning);
        assert_eq!(script_exit(Some(2), false, "").state, Critical);
        assert_eq!(script_exit(Some(7), false, "").state, Critical);
        assert_eq!(script_exit(None, true, "").state, Critical);
        assert_eq!(
            script_exit(Some(1), false, "disk nearly full").message,
            "disk nearly full"
        );
        assert_eq!(last_line("a\nb\n\n  \n"), "b");
        assert_eq!(ping("gw", 0.0, Some(3.0), &c).state, Ok);
        assert_eq!(ping("gw", 66.0, Some(3.0), &c).state, Critical);
        let rtt = cfg(json!({ "max_rtt_ms": 100 }));
        assert_eq!(ping("gw", 0.0, Some(150.0), &Config(&rtt)).state, Critical);
        assert_eq!(ping("gw", 100.0, None, &c).state, Critical);
        assert_eq!(pending_reboot(false, 0.0, &c).state, Ok);
        assert_eq!(pending_reboot(true, 10.0, &c).state, Ok);
        assert_eq!(pending_reboot(true, 80.0, &c).state, Critical);
        assert_eq!(
            antivirus(Some(false), Some(1.0), "Defender", &c).state,
            Critical
        );
        assert_eq!(
            antivirus(Some(true), Some(100.0), "Defender", &c).state,
            Warning
        );
        assert_eq!(antivirus(Some(true), Some(10.0), "Defender", &c).state, Ok);
        assert_eq!(antivirus(None, None, "?", &c).state, Unknown);
        assert_eq!(
            firewall(&[("Domain".into(), true), ("Public".into(), false)]).state,
            Critical
        );
        assert_eq!(firewall(&[("Domain".into(), true)]).state, Ok);
        assert_eq!(firewall(&[]).state, Unknown);
        assert_eq!(battery(None, &c).state, Ok);
        assert_eq!(battery(Some(50.0), &c).state, Critical);
        assert_eq!(battery(Some(80.0), &c).state, Ok);
        assert_eq!(windows_update(Some(40.0), 0, &c).state, Critical);
        assert_eq!(windows_update(Some(10.0), 0, &c).state, Ok);
        assert_eq!(windows_update(Some(10.0), 2, &c).state, Critical);
        assert_eq!(windows_update(None, 0, &c).state, Unknown);
        let ev = cfg(json!({ "threshold": 3 }));
        assert_eq!(event_log("System", 2, &Config(&ev)).state, Ok);
        assert_eq!(event_log("System", 3, &Config(&ev)).state, Critical);
    }

    #[test]
    fn http_file_process_service() {
        let none = Map::new();
        let c = Config(&none);
        let ok = HttpFacts {
            status: 200,
            latency_ms: 120.0,
            keyword_found: None,
            cert_days_left: Some(90.0),
        };
        assert_eq!(http("https://x", &ok, &c).state, Ok);
        assert_eq!(
            http(
                "https://x",
                &HttpFacts {
                    status: 503,
                    ..ok.clone()
                },
                &c
            )
            .state,
            Critical
        );
        assert_eq!(
            http(
                "https://x",
                &HttpFacts {
                    keyword_found: Some(false),
                    ..ok.clone()
                },
                &c
            )
            .state,
            Critical
        );
        assert_eq!(
            http(
                "https://x",
                &HttpFacts {
                    cert_days_left: Some(5.0),
                    ..ok.clone()
                },
                &c
            )
            .state,
            Warning
        );
        let lat = cfg(json!({ "max_latency_ms": 100 }));
        assert_eq!(http("https://x", &ok, &Config(&lat)).state, Warning);

        let exists = cfg(json!({ "condition": "exists" }));
        assert_eq!(file("/f", Some((1.0, 1.0)), &Config(&exists)).state, Ok);
        assert_eq!(file("/f", None, &Config(&exists)).state, Critical);
        let missing = cfg(json!({ "condition": "missing" }));
        assert_eq!(file("/f", None, &Config(&missing)).state, Ok);
        let older = cfg(json!({ "condition": "older_than", "minutes": 30 }));
        assert_eq!(
            file("/f", Some((45.0, 1.0)), &Config(&older)).state,
            Critical
        );
        assert_eq!(file("/f", Some((5.0, 1.0)), &Config(&older)).state, Ok);
        let larger = cfg(json!({ "condition": "larger_than", "size_mb": 10 }));
        assert_eq!(
            file("/f", Some((5.0, 11.0)), &Config(&larger)).state,
            Critical
        );

        let p = cfg(json!({ "max_cpu_pct": 50, "max_memory_mb": 500 }));
        assert_eq!(process("app", 0, 0.0, 0.0, &Config(&p)).state, Critical);
        assert_eq!(process("app", 2, 60.0, 100.0, &Config(&p)).state, Critical);
        assert_eq!(process("app", 2, 10.0, 600.0, &Config(&p)).state, Critical);
        assert_eq!(process("app", 1, 10.0, 100.0, &Config(&p)).state, Ok);
        let not = cfg(json!({ "expected": "not_running" }));
        assert_eq!(process("app", 0, 0.0, 0.0, &Config(&not)).state, Ok);
        assert_eq!(process("app", 1, 0.0, 0.0, &Config(&not)).state, Critical);

        assert_eq!(service("Spooler", Some("running"), &c).state, Ok);
        assert_eq!(service("Spooler", Some("stopped"), &c).state, Critical);
        assert_eq!(service("Spooler", None, &c).state, Critical);
        let stopped = cfg(json!({ "expected": "stopped" }));
        assert_eq!(
            service("Spooler", Some("stopped"), &Config(&stopped)).state,
            Ok
        );
    }
}
