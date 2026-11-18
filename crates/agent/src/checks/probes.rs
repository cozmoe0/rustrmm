//! Probes: gather the facts for each check type (per platform) and hand them to [`super::eval`].
//! Blocking work runs on the blocking pool; nothing here touches the control connection.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use rustrmm_proto::commands::RunScript;
use rustrmm_proto::monitoring::{CheckDefinition, CheckState};
use serde_json::{Map, Value};
use sysinfo::{Disks, ProcessRefreshKind, ProcessesToUpdate, System};

use super::ProbeCtx;
use super::eval::{self, Config, Evaluation, HttpFacts, Volume};

/// CPU and memory samples kept for windowed averages (one hour).
#[derive(Default)]
pub struct Samples {
    system: Option<System>,
    buf: VecDeque<(Instant, f64, f64)>,
}

const SAMPLE_WINDOW: Duration = Duration::from_secs(3600);

fn memory_pct(system: &System) -> f64 {
    let total = system.total_memory();
    if total == 0 {
        0.0
    } else {
        system.used_memory() as f64 / total as f64 * 100.0
    }
}

/// Takes one sample (blocking: the first call waits for a CPU delta).
pub fn take_sample(samples: &Mutex<Samples>) {
    let Ok(mut s) = samples.lock() else {
        return;
    };
    if s.system.is_none() {
        let Ok(mut system) = System::new() else {
            return;
        };
        system.refresh_cpu_usage();
        std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL.max(Duration::from_millis(250)));
        s.system = Some(system);
    }
    let Some(system) = s.system.as_mut() else {
        return;
    };
    system.refresh_cpu_usage();
    system.refresh_memory();
    let cpu = f64::from(system.global_cpu_usage());
    let mem = memory_pct(system);
    let now = Instant::now();
    s.buf.push_back((now, cpu, mem));
    while s
        .buf
        .front()
        .is_some_and(|(t, _, _)| now.duration_since(*t) > SAMPLE_WINDOW)
    {
        s.buf.pop_front();
    }
}

/// Average CPU and memory over the last `window` (`None` without samples).
fn average(samples: &Mutex<Samples>, window: Duration) -> Option<(f64, f64)> {
    let s = samples.lock().ok()?;
    let now = Instant::now();
    let recent: Vec<&(Instant, f64, f64)> = s
        .buf
        .iter()
        .filter(|(t, _, _)| now.duration_since(*t) <= window)
        .collect();
    if recent.is_empty() {
        return None;
    }
    let n = recent.len() as f64;
    Some((
        recent.iter().map(|r| r.1).sum::<f64>() / n,
        recent.iter().map(|r| r.2).sum::<f64>() / n,
    ))
}

async fn blocking<F>(f: F) -> Evaluation
where
    F: FnOnce() -> Evaluation + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .unwrap_or_else(|e| Evaluation::unknown(format!("the check failed: {e}")))
}

fn unsupported(kind: &str) -> Evaluation {
    Evaluation::unknown(format!(
        "{kind} checks are not supported on {}",
        crate::collectors::os_family()
    ))
}

/// Runs one check.
pub async fn run(ctx: Arc<ProbeCtx>, def: CheckDefinition) -> Evaluation {
    let config: Map<String, Value> = def.config.as_object().cloned().unwrap_or_default();
    match def.kind.as_str() {
        "cpu" | "memory" => usage(&ctx, &def.kind, &config).await,
        "disk" => {
            blocking(move || {
                let all = Config(&config).text("volume").unwrap_or("*") == "*";
                eval::disk(&volumes(all), &Config(&config))
            })
            .await
        }
        "uptime" => match System::uptime() {
            Ok(secs) => eval::uptime(secs, &Config(&config)),
            Err(e) => Evaluation::unknown(format!("uptime unavailable: {e}")),
        },
        "service" => {
            let ctx = ctx.clone();
            blocking(move || service(&ctx, &config)).await
        }
        "process" => blocking(move || process(&config)).await,
        "event_log" => blocking(move || event_log(&config)).await,
        "script" => script(&ctx, &def, &config).await,
        "ping" => blocking(move || ping(&config)).await,
        "tcp_port" => tcp_port(&config).await,
        "http" => http(&config).await,
        "certificate" => blocking(move || certificate(&config)).await,
        "pending_reboot" => {
            let ctx = ctx.clone();
            blocking(move || pending_reboot(&ctx, &config)).await
        }
        "antivirus" => {
            blocking(move || match platform::antivirus() {
                Some((real_time, age, product)) => {
                    eval::antivirus(real_time, age, &product, &Config(&config))
                }
                None => unsupported("antivirus"),
            })
            .await
        }
        "firewall" => {
            blocking(|| match platform::firewall() {
                Ok(profiles) => eval::firewall(&profiles),
                Err(e) => Evaluation::unknown(format!("{e:#}")),
            })
            .await
        }
        "file" => blocking(move || file(&config)).await,
        "windows_update" => {
            blocking(move || match platform::windows_update() {
                Some(Ok((days, failures))) => {
                    eval::windows_update(days, failures, &Config(&config))
                }
                Some(Err(e)) => Evaluation::unknown(format!("{e:#}")),
                None => unsupported("windows_update"),
            })
            .await
        }
        "battery" => {
            blocking(move || eval::battery(platform::battery_health(), &Config(&config))).await
        }
        other => Evaluation::unknown(format!(
            "check type {other} is not supported by this agent version"
        )),
    }
}

async fn usage(ctx: &Arc<ProbeCtx>, kind: &str, config: &Map<String, Value>) -> Evaluation {
    let cfg = Config(config);
    let window_minutes = cfg.num_or("window_minutes", 5.0).clamp(1.0, 60.0);
    let window = Duration::from_secs_f64(window_minutes * 60.0);
    if average(&ctx.samples, window).is_none() {
        let samples = ctx.samples.clone();
        let _ = tokio::task::spawn_blocking(move || take_sample(&samples)).await;
    }
    match average(&ctx.samples, window) {
        Some((cpu, _)) if kind == "cpu" => eval::usage("CPU", cpu, window_minutes, &cfg),
        Some((_, mem)) => eval::usage("Memory", mem, window_minutes, &cfg),
        None => Evaluation::unknown("no performance samples yet"),
    }
}

/// Volumes for the disk check. With `*` only fixed local volumes count (removable media,
/// network shares, pseudo and tiny file systems are left out); a named volume is matched
/// whatever it is.
fn volumes(all_fixed: bool) -> Vec<Volume> {
    let Ok(disks) = Disks::new_with_refreshed_list() else {
        return Vec::new();
    };
    let mut out: Vec<Volume> = disks
        .iter()
        .filter(|d| {
            if !all_fixed {
                return true;
            }
            let fs = d.file_system().to_string_lossy().to_ascii_lowercase();
            !d.is_removable()
                && d.total_space() > 1_000_000_000
                && !fs.starts_with("fuse.")
                && !matches!(
                    fs.as_str(),
                    "squashfs"
                        | "overlay"
                        | "tmpfs"
                        | "devtmpfs"
                        | "ramfs"
                        | "iso9660"
                        | "udf"
                        | "nfs"
                        | "nfs4"
                        | "cifs"
                        | "smb3"
                        | "smbfs"
                        | "9p"
                        | "drvfs"
                        | "autofs"
                        | "afpfs"
                        | "webdav"
                )
        })
        .map(|d| Volume {
            mount: d.mount_point().to_string_lossy().to_string(),
            total_bytes: d.total_space(),
            free_bytes: d.available_space(),
        })
        .collect();
    out.sort_by(|a, b| a.mount.cmp(&b.mount));
    out.dedup_by(|a, b| a.mount == b.mount);
    out
}

fn service(ctx: &ProbeCtx, config: &Map<String, Value>) -> Evaluation {
    let cfg = Config(config);
    let Some(name) = cfg.text("name") else {
        return Evaluation::unknown("no service name configured");
    };
    let current = match crate::remote::services::state(name) {
        Ok(s) => s,
        Err(e) => return Evaluation::unknown(format!("{e:#}")),
    };
    let expected_running = cfg.text("expected").unwrap_or("running") == "running";
    let stopped = current.as_deref().is_some_and(|s| s != "running");
    if expected_running && stopped && cfg.flag("auto_restart", false) {
        if !crate::config::LocalPolicy::load(&ctx.paths)
            .allows(rustrmm_proto::remote::features::SYSTEM)
        {
            let mut e = eval::service(name, current.as_deref(), &cfg);
            e.message
                .push_str(" (automatic restart is disabled by local policy)");
            return e;
        }
        let attempts = cfg.num_or("restart_attempts", 2.0).clamp(0.0, 5.0) as u32;
        for attempt in 1..=attempts {
            tracing::info!(
                service = name,
                attempt,
                "restarting a stopped service (monitoring)"
            );
            let _ =
                crate::remote::services::control(name, rustrmm_proto::remote::ServiceAction::Start);
            std::thread::sleep(Duration::from_secs(2));
            if crate::remote::services::state(name)
                .ok()
                .flatten()
                .as_deref()
                == Some("running")
            {
                return Evaluation::ok(format!(
                    "{name} was {} and was restarted (attempt {attempt})",
                    current.as_deref().unwrap_or("stopped")
                ));
            }
        }
        let mut e = eval::service(name, current.as_deref(), &cfg);
        if attempts > 0 {
            e.message
                .push_str(&format!(" after {attempts} restart attempt(s)"));
        }
        return e;
    }
    eval::service(name, current.as_deref(), &cfg)
}

fn process(config: &Map<String, Value>) -> Evaluation {
    let cfg = Config(config);
    let Some(name) = cfg.text("name") else {
        return Evaluation::unknown("no process name configured");
    };
    let wanted = name.to_ascii_lowercase();
    let wanted = wanted.trim_end_matches(".exe").to_string();
    let Ok(mut system) = System::new() else {
        return Evaluation::unknown("process list unavailable");
    };
    let kind = ProcessRefreshKind::nothing().with_cpu().with_memory();
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
    let needs_cpu = cfg.num("max_cpu_pct").is_some();
    if needs_cpu {
        std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL.max(Duration::from_millis(250)));
        system.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
    }
    let logical = std::thread::available_parallelism()
        .map(|n| n.get() as f64)
        .unwrap_or(1.0);
    let matching: Vec<&sysinfo::Process> = system
        .processes()
        .values()
        .filter(|p| {
            let n = p.name().to_string_lossy().to_ascii_lowercase();
            n.trim_end_matches(".exe") == wanted
        })
        .collect();
    let cpu: f64 = matching
        .iter()
        .map(|p| f64::from(p.cpu_usage()))
        .sum::<f64>()
        / logical;
    let memory_mb: f64 = matching.iter().map(|p| p.memory() as f64).sum::<f64>() / 1_048_576.0;
    eval::process(name, matching.len(), cpu, memory_mb, &cfg)
}

/// Same character rules as the remote event-log tool (no quotes, no option injection).
fn valid_log_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && !s.starts_with('-')
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '/' | '-' | '_' | '.' | '@'))
}

fn event_log(config: &Map<String, Value>) -> Evaluation {
    let cfg = Config(config);
    let log = cfg.text("log").unwrap_or("System");
    let source = cfg.text("source");
    if !valid_log_name(log) || source.is_some_and(|s| !valid_log_name(s)) {
        return Evaluation::unknown("invalid log or source name");
    }
    let ids = cfg.numbers("event_ids");
    let min_level = cfg.num_or("min_level", 2.0).clamp(1.0, 4.0) as u8;
    let window = cfg.num_or("window_minutes", 15.0).clamp(1.0, 1440.0) as u32;
    match platform::event_count(log, source, &ids, min_level, window) {
        Some(Ok(count)) => eval::event_log(log, count, &cfg),
        Some(Err(e)) => Evaluation::unknown(format!("{e:#}")),
        None => unsupported("event_log"),
    }
}

async fn script(
    ctx: &Arc<ProbeCtx>,
    def: &CheckDefinition,
    config: &Map<String, Value>,
) -> Evaluation {
    if !crate::config::LocalPolicy::load(&ctx.paths)
        .allows(rustrmm_proto::remote::features::SCRIPTS)
    {
        return Evaluation::unknown("scripts are disabled on this device by local policy");
    }
    if let Some(reason) = config.get("unavailable").and_then(Value::as_str) {
        return Evaluation::unknown(reason.to_string());
    }
    let Some(embedded) = &def.script else {
        return Evaluation::unknown("the server did not provide the script");
    };
    let timeout = Config(config)
        .num_or("timeout_secs", 60.0)
        .clamp(5.0, 3600.0) as u32;
    let run = RunScript {
        language: embedded.language.clone(),
        content: embedded.content.clone(),
        content_sha256: embedded.content_sha256.clone(),
        env: embedded.env.clone(),
        mask: embedded.mask.clone(),
        timeout_secs: timeout,
        max_output_bytes: 64 * 1024,
    };
    let safe_id: String = def
        .id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(40)
        .collect();
    let cmd_id = format!(
        "check-{safe_id}-{}",
        hex::encode(rustrmm_crypto::random::bytes::<4>())
    );
    match crate::scripts::run(&ctx.paths, &ctx.device_id, &cmd_id, run).await {
        crate::scripts::Outcome::Ran(data) => {
            let code = data.get("exit_code").and_then(Value::as_i64);
            let timed_out = data
                .get("timed_out")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let stdout = data
                .get("stdout")
                .and_then(Value::as_str)
                .unwrap_or_default();
            eval::script_exit(code, timed_out, &eval::last_line(stdout))
        }
        crate::scripts::Outcome::Rejected(m) | crate::scripts::Outcome::Failed(m) => {
            Evaluation::unknown(m)
        }
    }
}

/// Parses ping output: loss percentage and average round trip (ms). Handles Linux, macOS and
/// (localised) Windows output.
pub fn parse_ping(output: &str) -> Option<(f64, Option<f64>)> {
    let mut loss = None;
    for line in output.lines() {
        if let Some(idx) = line.find('%') {
            let digits: String = line[..idx]
                .chars()
                .rev()
                .take_while(|c| c.is_ascii_digit() || *c == '.')
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            if let Ok(v) = digits.parse::<f64>() {
                loss = Some(v);
            }
        }
    }
    let loss = loss?;
    let mut avg = None;
    for line in output.lines() {
        // Unix: "rtt min/avg/max/mdev = 0.04/0.05/0.06/0.01 ms" or "round-trip … = a/b/c/d ms".
        if line.contains("min/avg/max")
            && let Some((_, values)) = line.split_once('=')
        {
            avg = values
                .trim()
                .split('/')
                .nth(1)
                .and_then(|v| v.trim().parse().ok());
        }
    }
    if avg.is_none() {
        // Windows: the last "<n>ms" figure of the summary is the average.
        let summary: Vec<f64> = output
            .lines()
            .filter(|l| l.matches("ms").count() >= 3 && l.contains('='))
            .flat_map(|l| {
                l.split(['=', ',', ' '])
                    .filter_map(|w| {
                        w.trim()
                            .strip_suffix("ms")
                            .and_then(|n| n.trim().parse::<f64>().ok())
                    })
                    .collect::<Vec<_>>()
            })
            .collect();
        avg = summary.last().copied();
    }
    Some((loss, avg))
}

fn ping(config: &Map<String, Value>) -> Evaluation {
    let cfg = Config(config);
    let Some(target) = cfg.text("target") else {
        return Evaluation::unknown("no target configured");
    };
    if !rustrmm_proto::remote::valid_target(target) {
        return Evaluation::unknown("invalid target");
    }
    let count = cfg.num_or("count", 3.0).clamp(1.0, 20.0) as u32;
    let count_s = count.to_string();
    let program = crate::util::system_tool("ping");
    let args: Vec<&str> = if cfg!(windows) {
        vec!["-n", &count_s, "-w", "2000", target]
    } else if cfg!(target_os = "macos") {
        vec!["-c", &count_s, "-t", "20", target]
    } else {
        vec!["-c", &count_s, "-W", "2", target]
    };
    let out = match crate::util::run_capture(
        &program,
        &args,
        Duration::from_secs(u64::from(count) * 3 + 10),
    ) {
        Ok(o) => o,
        Err(e) => return Evaluation::unknown(format!("{e:#}")),
    };
    match parse_ping(&out.stdout) {
        Some((loss, avg)) => eval::ping(target, loss, avg, &cfg),
        None if out.code != Some(0) => {
            Evaluation::failing(format!("{target}: no reply ({})", out.stderr.trim()))
                .with_value(100.0)
        }
        None => Evaluation::unknown("could not read the ping output"),
    }
}

async fn tcp_port(config: &Map<String, Value>) -> Evaluation {
    let cfg = Config(config);
    let Some(host) = cfg.text("host").map(str::to_string) else {
        return Evaluation::unknown("no host configured");
    };
    if !rustrmm_proto::remote::valid_target(&host) {
        return Evaluation::unknown("invalid host");
    }
    let Some(port) = cfg
        .num("port")
        .filter(|p| (1.0..=65_535.0).contains(p))
        .map(|p| p as u16)
    else {
        return Evaluation::unknown("no port configured");
    };
    let timeout =
        Duration::from_millis(cfg.num_or("timeout_ms", 3000.0).clamp(100.0, 60_000.0) as u64);
    let started = Instant::now();
    let target = format!("{host}:{port}");
    match tokio::time::timeout(
        timeout,
        tokio::net::TcpStream::connect((host.as_str(), port)),
    )
    .await
    {
        Ok(Ok(_)) => {
            let ms = started.elapsed().as_secs_f64() * 1000.0;
            Evaluation::ok(format!("{target} accepted a connection in {ms:.0} ms")).with_value(ms)
        }
        Ok(Err(e)) => Evaluation::failing(format!("{target}: {e}")),
        Err(_) => Evaluation::failing(format!(
            "{target}: no answer within {} ms",
            timeout.as_millis()
        )),
    }
}

/// Accepts any server certificate: used only for `http` checks with `verify_tls: false`.
#[derive(Debug)]
struct NoVerify(Arc<rustls::crypto::CryptoProvider>);

impl rustls::client::danger::ServerCertVerifier for NoVerify {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

fn http_client(verify: bool) -> Result<reqwest::Client> {
    let mut config = if verify {
        (*crate::tls::client_config(None)?).clone()
    } else {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        rustls::ClientConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions()?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(NoVerify(provider)))
            .with_no_client_auth()
    };
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    reqwest::Client::builder()
        .use_preconfigured_tls(config)
        .tls_info(true)
        .redirect(reqwest::redirect::Policy::limited(5))
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(10))
        .user_agent(format!(
            "rustrmm-agent/{} (monitoring)",
            crate::AGENT_VERSION
        ))
        .build()
        .context("building the HTTP client")
}

fn cert_days_left(der: &[u8]) -> Option<f64> {
    let (_, cert) = x509_parser::parse_x509_certificate(der).ok()?;
    let not_after = cert.validity().not_after.timestamp();
    Some((not_after - chrono::Utc::now().timestamp()) as f64 / 86_400.0)
}

async fn http(config: &Map<String, Value>) -> Evaluation {
    let cfg = Config(config);
    let Some(url) = cfg.text("url").map(str::to_string) else {
        return Evaluation::unknown("no URL configured");
    };
    let parsed = match url::Url::parse(&url) {
        Ok(u) if matches!(u.scheme(), "http" | "https") => u,
        _ => return Evaluation::unknown("only http(s) URLs are allowed"),
    };
    let client = match http_client(cfg.flag("verify_tls", true)) {
        Ok(c) => c,
        Err(e) => return Evaluation::unknown(format!("{e:#}")),
    };
    let method = match cfg.text("method").unwrap_or("GET") {
        "HEAD" => reqwest::Method::HEAD,
        "POST" => reqwest::Method::POST,
        _ => reqwest::Method::GET,
    };
    let started = Instant::now();
    let response = match client.request(method, parsed).send().await {
        Ok(r) => r,
        Err(e) => {
            let reason = if e.is_timeout() {
                "timed out".to_string()
            } else if e.is_connect() {
                "could not connect".to_string()
            } else {
                let mut source: Option<&dyn std::error::Error> = std::error::Error::source(&e);
                let mut last = e.to_string();
                while let Some(s) = source {
                    last = s.to_string();
                    source = s.source();
                }
                last
            };
            return Evaluation::new(CheckState::Critical, format!("{url}: {reason}"), None);
        }
    };
    let status = response.status().as_u16();
    let cert_days = response
        .extensions()
        .get::<reqwest::tls::TlsInfo>()
        .and_then(|i| i.peer_certificate())
        .and_then(cert_days_left);
    let keyword = cfg.text("keyword").map(str::to_string);
    let mut keyword_found = None;
    if let Some(k) = &keyword {
        let mut body = Vec::new();
        let mut response = response;
        while let Ok(Some(chunk)) = response.chunk().await {
            body.extend_from_slice(&chunk);
            if body.len() > 1024 * 1024 {
                break;
            }
        }
        keyword_found = Some(String::from_utf8_lossy(&body).contains(k.as_str()));
    }
    let facts = HttpFacts {
        status,
        latency_ms: started.elapsed().as_secs_f64() * 1000.0,
        keyword_found,
        cert_days_left: cert_days,
    };
    eval::http(&url, &facts, &cfg)
}

/// Earliest-expiring certificate in a PEM bundle or DER file.
fn file_certificate(path: &str) -> Result<(String, f64)> {
    let data = std::fs::read(path).with_context(|| format!("cannot read {path}"))?;
    let mut best: Option<(String, f64)> = None;
    let mut consider = |der: &[u8]| {
        if let Ok((_, cert)) = x509_parser::parse_x509_certificate(der) {
            let days = (cert.validity().not_after.timestamp() - chrono::Utc::now().timestamp())
                as f64
                / 86_400.0;
            let subject = cert.subject().to_string();
            if best.as_ref().is_none_or(|(_, d)| days < *d) {
                best = Some((subject, days));
            }
        }
    };
    if data.windows(10).any(|w| w == b"-----BEGIN") {
        for pem in x509_parser::pem::Pem::iter_from_buffer(&data).flatten() {
            if pem.label.contains("CERTIFICATE") {
                consider(&pem.contents);
            }
        }
    } else {
        consider(&data);
    }
    best.context("no certificate found in the file")
}

fn certificate(config: &Map<String, Value>) -> Evaluation {
    let cfg = Config(config);
    let found = match cfg.text("source").unwrap_or("store") {
        "file" => match cfg.text("path") {
            Some(path) => file_certificate(path).map(Some),
            None => return Evaluation::unknown("no certificate file configured"),
        },
        _ => {
            let store = cfg.text("store").unwrap_or("LocalMachine\\My");
            match platform::store_certificate(store) {
                Some(result) => result,
                None => return unsupported("certificate store"),
            }
        }
    };
    match found {
        Ok(Some((subject, days))) => eval::certificate(&subject, days, &cfg),
        Ok(None) => Evaluation::ok("no certificates in the store"),
        Err(e) => Evaluation::unknown(format!("{e:#}")),
    }
}

fn pending_reboot(ctx: &ProbeCtx, config: &Map<String, Value>) -> Evaluation {
    let Some((pending, os_since)) = platform::pending_reboot() else {
        return unsupported("pending_reboot");
    };
    let now = chrono::Utc::now().timestamp();
    let since = {
        let Ok(mut shared) = ctx.shared.lock() else {
            return Evaluation::unknown("internal state unavailable");
        };
        if pending {
            let first = shared
                .reboot_pending_since
                .get_or_insert(os_since.unwrap_or(now));
            if let Some(os) = os_since {
                *first = (*first).min(os);
            }
            *first
        } else {
            shared.reboot_pending_since = None;
            now
        }
    };
    eval::pending_reboot(
        pending,
        (now - since).max(0) as f64 / 3600.0,
        &Config(config),
    )
}

fn file(config: &Map<String, Value>) -> Evaluation {
    let cfg = Config(config);
    let Some(path) = cfg.text("path") else {
        return Evaluation::unknown("no path configured");
    };
    let facts = match std::fs::metadata(path) {
        Ok(meta) => {
            let age_min = meta
                .modified()
                .ok()
                .and_then(|m| m.elapsed().ok())
                .map(|d| d.as_secs_f64() / 60.0)
                .unwrap_or(0.0);
            Some((age_min, meta.len() as f64 / 1_048_576.0))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Evaluation::unknown(format!("cannot read {path}: {e}")),
    };
    eval::file(path, facts, &cfg)
}

// ------------------------------------------------------------------ platforms

#[cfg(windows)]
mod platform {
    use super::*;
    use crate::collectors::windows::{b, query, s, u, wmi_date};

    fn powershell(script: &str, timeout: Duration) -> Result<String> {
        let program = crate::util::system_tool(r"WindowsPowerShell\v1.0\powershell.exe");
        let out = crate::util::run_capture(
            &program,
            &[
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                script,
            ],
            timeout,
        )?;
        if out.timed_out {
            bail!("PowerShell timed out");
        }
        if out.code != Some(0) {
            let first = out
                .stderr
                .lines()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("PowerShell failed");
            bail!("{}", first.trim());
        }
        Ok(out.stdout)
    }

    pub fn event_count(
        log: &str,
        source: Option<&str>,
        ids: &[u64],
        min_level: u8,
        window: u32,
    ) -> Option<Result<u64>> {
        let levels: Vec<String> = (1..=min_level).map(|l| l.to_string()).collect();
        let mut filter = format!(
            "LogName = '{log}'; StartTime = (Get-Date).AddMinutes(-{window}); Level = @({})",
            levels.join(",")
        );
        if let Some(src) = source {
            filter.push_str(&format!("; ProviderName = '{src}'"));
        }
        if !ids.is_empty() {
            let list: Vec<String> = ids.iter().map(u64::to_string).collect();
            filter.push_str(&format!("; Id = @({})", list.join(",")));
        }
        // Names are validated (no quotes), so single-quoting is safe.
        let script = format!(
            "$ErrorActionPreference = 'Stop'; $null = Get-WinEvent -ListLog '{log}'; \
             @(Get-WinEvent -FilterHashtable @{{ {filter} }} -ErrorAction SilentlyContinue).Count"
        );
        Some(
            powershell(&script, Duration::from_secs(120)).and_then(|out| {
                out.trim()
                    .parse::<u64>()
                    .context("unexpected PowerShell output")
            }),
        )
    }

    pub fn pending_reboot() -> Option<(bool, Option<i64>)> {
        Some((
            !crate::collectors::windows::pending_reboot_reasons().is_empty(),
            None,
        ))
    }

    fn age_hours(rfc3339: &str) -> Option<f64> {
        let t = chrono::DateTime::parse_from_rfc3339(rfc3339).ok()?;
        Some((chrono::Utc::now() - t.with_timezone(&chrono::Utc)).num_minutes() as f64 / 60.0)
    }

    pub fn antivirus() -> Option<(Option<bool>, Option<f64>, String)> {
        // Third-party products registered with Security Center take precedence.
        let products = query(
            "ROOT\\SecurityCenter2",
            "SELECT displayName, productState FROM AntiVirusProduct",
        );
        let third_party = products.iter().find(|p| {
            let name = s(p, "displayName").unwrap_or_default().to_ascii_lowercase();
            let state = u(p, "productState").unwrap_or(0);
            !name.contains("defender") && state & 0x1000 != 0
        });
        if let Some(p) = third_party {
            let state = u(p, "productState").unwrap_or(0);
            let age = if state & 0x10 == 0 {
                Some(0.0)
            } else {
                Some(f64::MAX)
            };
            return Some((
                Some(true),
                age,
                s(p, "displayName").unwrap_or_else(|| "Antivirus".into()),
            ));
        }
        let defender = query(
            "ROOT\\Microsoft\\Windows\\Defender",
            "SELECT AntivirusEnabled, RealTimeProtectionEnabled, AntivirusSignatureAge, AntivirusSignatureLastUpdated FROM MSFT_MpComputerStatus",
        );
        if let Some(d) = defender.first() {
            let on = b(d, "AntivirusEnabled").unwrap_or(false)
                && b(d, "RealTimeProtectionEnabled").unwrap_or(false);
            let age = s(d, "AntivirusSignatureLastUpdated")
                .and_then(|raw| wmi_date(&raw))
                .and_then(|t| age_hours(&t))
                .or_else(|| u(d, "AntivirusSignatureAge").map(|days| days as f64 * 24.0));
            return Some((Some(on), age, "Microsoft Defender".into()));
        }
        if let Some(p) = products.first() {
            let state = u(p, "productState").unwrap_or(0);
            return Some((
                Some(state & 0x1000 != 0),
                None,
                s(p, "displayName").unwrap_or_else(|| "Antivirus".into()),
            ));
        }
        Some((None, None, "Antivirus".into()))
    }

    pub fn firewall() -> Result<Vec<(String, bool)>> {
        let profiles: Vec<(String, bool)> = query(
            "ROOT\\StandardCimv2",
            "SELECT Name, Enabled FROM MSFT_NetFirewallProfile",
        )
        .iter()
        .map(|p| {
            (
                s(p, "Name").unwrap_or_else(|| "Profile".into()),
                b(p, "Enabled").unwrap_or(false),
            )
        })
        .collect();
        if profiles.is_empty() {
            bail!("Windows Firewall profiles are unavailable");
        }
        Ok(profiles)
    }

    pub fn windows_update() -> Option<Result<(Option<f64>, u32)>> {
        // Defender intelligence and platform updates are excluded: they install daily.
        let script = "$ErrorActionPreference = 'Stop'; $s = New-Object -ComObject Microsoft.Update.Session; \
            $h = $s.CreateUpdateSearcher(); $n = $h.GetTotalHistoryCount(); \
            $items = if ($n -gt 0) { @($h.QueryHistory(0, [Math]::Min($n, 300))) } else { @() }; \
            $items = @($items | Where-Object { $_.Operation -eq 1 -and $_.Title -notmatch 'KB2267602|KB2461484|KB4052623|KB915597' }); \
            $ok = $items | Where-Object { $_.ResultCode -eq 2 -or $_.ResultCode -eq 3 } | Sort-Object Date -Descending | Select-Object -First 1; \
            $since = (Get-Date).AddDays(-30); if ($ok -and $ok.Date -gt $since) { $since = $ok.Date }; \
            $fail = @($items | Where-Object { ($_.ResultCode -eq 4 -or $_.ResultCode -eq 5) -and $_.Date -gt $since }).Count; \
            $last = if ($ok) { $ok.Date.ToUniversalTime().ToString('o') } else { '' }; \"$last|$fail\"";
        Some(
            powershell(script, Duration::from_secs(180)).and_then(|out| {
                let line = out
                    .lines()
                    .rev()
                    .find(|l| l.contains('|'))
                    .context("unexpected PowerShell output")?;
                let (last, fail) = line
                    .trim()
                    .split_once('|')
                    .context("unexpected PowerShell output")?;
                let days = chrono::DateTime::parse_from_rfc3339(last.trim())
                    .ok()
                    .map(|t| {
                        (chrono::Utc::now() - t.with_timezone(&chrono::Utc)).num_hours() as f64
                            / 24.0
                    });
                Ok((days, fail.trim().parse().unwrap_or(0)))
            }),
        )
    }

    pub fn battery_health() -> Option<f64> {
        let full = query(
            "ROOT\\WMI",
            "SELECT FullChargedCapacity FROM BatteryFullChargedCapacity",
        )
        .first()
        .and_then(|r| u(r, "FullChargedCapacity"));
        let design = query(
            "ROOT\\WMI",
            "SELECT DesignedCapacity FROM BatteryStaticData",
        )
        .first()
        .and_then(|r| u(r, "DesignedCapacity"));
        match (full, design) {
            (Some(f), Some(d)) if d > 0 => Some((f as f64 / d as f64 * 100.0).min(100.0)),
            _ => {
                let row = crate::collectors::windows::query(
                    "ROOT\\CIMV2",
                    "SELECT DesignCapacity, FullChargeCapacity FROM Win32_Battery",
                );
                let r = row.first()?;
                match (u(r, "FullChargeCapacity"), u(r, "DesignCapacity")) {
                    (Some(f), Some(d)) if d > 0 => Some((f as f64 / d as f64 * 100.0).min(100.0)),
                    // A battery without capacity data counts as healthy.
                    _ => Some(100.0),
                }
            }
        }
    }

    pub fn store_certificate(store: &str) -> Option<Result<Option<(String, f64)>>> {
        let valid = store.split('\\').count() == 2
            && store
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '\\' || c == ' ')
            && (store.starts_with("LocalMachine\\") || store.starts_with("CurrentUser\\"));
        if !valid {
            return Some(Err(anyhow::anyhow!("invalid certificate store {store}")));
        }
        // Certificates that expired more than 30 days ago are ignored (old leftovers).
        let script = format!(
            "$ErrorActionPreference = 'Stop'; $limit = (Get-Date).AddDays(-30); \
             $c = Get-ChildItem -Path 'Cert:\\{store}' | Where-Object {{ $_.NotAfter -gt $limit }} | Sort-Object NotAfter | Select-Object -First 1; \
             if ($c) {{ \"{{0}}|{{1}}\" -f $c.NotAfter.ToUniversalTime().ToString('o'), $c.Subject }}"
        );
        Some(
            powershell(&script, Duration::from_secs(60)).and_then(|out| {
                let Some(line) = out.lines().find(|l| l.contains('|')) else {
                    return Ok(None);
                };
                let (when, subject) = line
                    .split_once('|')
                    .context("unexpected PowerShell output")?;
                let t = chrono::DateTime::parse_from_rfc3339(when.trim())
                    .context("unexpected certificate date")?;
                let days = (t.with_timezone(&chrono::Utc) - chrono::Utc::now()).num_minutes()
                    as f64
                    / 1440.0;
                Ok(Some((subject.trim().to_string(), days)))
            }),
        )
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;

    pub fn event_count(
        log: &str,
        source: Option<&str>,
        _ids: &[u64],
        min_level: u8,
        window: u32,
    ) -> Option<Result<u64>> {
        let since = format!("--since=-{window}min");
        let priority = match min_level {
            1 => "0..2",
            2 => "0..3",
            3 => "0..4",
            _ => "0..6",
        };
        let mut args = vec![
            "-o",
            "json",
            "--no-pager",
            "-q",
            since.as_str(),
            "-p",
            priority,
        ];
        if !log.eq_ignore_ascii_case("system") {
            args.extend(["-u", log]);
        }
        let out = match crate::util::run_capture(
            &crate::util::system_tool("journalctl"),
            &args,
            Duration::from_secs(120),
        ) {
            Ok(o) => o,
            Err(e) => return Some(Err(e)),
        };
        if out.code != Some(0) && out.stdout.trim().is_empty() {
            return Some(Err(anyhow::anyhow!(
                "journalctl failed: {}",
                out.stderr.trim()
            )));
        }
        let count = out
            .stdout
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|e| {
                source.is_none_or(|s| {
                    e["SYSLOG_IDENTIFIER"].as_str() == Some(s) || e["_COMM"].as_str() == Some(s)
                })
            })
            .count();
        Some(Ok(count as u64))
    }

    pub fn pending_reboot() -> Option<(bool, Option<i64>)> {
        let flag = std::path::Path::new("/var/run/reboot-required");
        match std::fs::metadata(flag) {
            Ok(meta) => {
                let since = meta
                    .modified()
                    .ok()
                    .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64);
                Some((true, since))
            }
            Err(_) => {
                let tool = crate::util::system_tool("needs-restarting");
                if tool.exists()
                    && let Ok(out) =
                        crate::util::run_capture(&tool, &["-r"], Duration::from_secs(60))
                {
                    return Some((out.code == Some(1), None));
                }
                Some((false, None))
            }
        }
    }

    pub fn antivirus() -> Option<(Option<bool>, Option<f64>, String)> {
        None
    }

    pub fn firewall() -> Result<Vec<(String, bool)>> {
        let tool = |name: &str| {
            let path = crate::util::system_tool(name);
            path.exists().then_some(path)
        };
        let run = |path: &std::path::Path, args: &[&str]| {
            crate::util::run_capture(path, args, Duration::from_secs(20))
        };
        if let Some(ufw) = tool("ufw") {
            let out = run(&ufw, &["status"])?;
            return Ok(vec![("ufw".into(), out.stdout.contains("Status: active"))]);
        }
        if let Some(fw) = tool("firewall-cmd") {
            let out = run(&fw, &["--state"])?;
            return Ok(vec![("firewalld".into(), out.stdout.trim() == "running")]);
        }
        if let Some(nft) = tool("nft") {
            let out = run(&nft, &["list", "ruleset"])?;
            if out.code == Some(0) {
                return Ok(vec![(
                    "nftables".into(),
                    out.stdout.lines().any(|l| l.contains("hook input")),
                )]);
            }
        }
        bail!("no supported firewall found (ufw, firewalld or nftables)")
    }

    pub fn windows_update() -> Option<Result<(Option<f64>, u32)>> {
        None
    }

    fn read_num(path: &std::path::Path) -> Option<f64> {
        std::fs::read_to_string(path).ok()?.trim().parse().ok()
    }

    pub fn battery_health() -> Option<f64> {
        let entries = std::fs::read_dir("/sys/class/power_supply").ok()?;
        for entry in entries.flatten() {
            let dir = entry.path();
            let kind = std::fs::read_to_string(dir.join("type")).unwrap_or_default();
            if kind.trim() != "Battery" {
                continue;
            }
            for (full, design) in [
                ("energy_full", "energy_full_design"),
                ("charge_full", "charge_full_design"),
            ] {
                if let (Some(f), Some(d)) = (read_num(&dir.join(full)), read_num(&dir.join(design)))
                    && d > 0.0
                {
                    return Some((f / d * 100.0).min(100.0));
                }
            }
            return Some(100.0);
        }
        None
    }

    pub fn store_certificate(_store: &str) -> Option<Result<Option<(String, f64)>>> {
        None
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;

    pub fn event_count(
        _log: &str,
        _source: Option<&str>,
        _ids: &[u64],
        _min_level: u8,
        _window: u32,
    ) -> Option<Result<u64>> {
        None
    }

    pub fn pending_reboot() -> Option<(bool, Option<i64>)> {
        let out = crate::util::run_capture(
            &crate::util::system_tool("softwareupdate"),
            &["--list", "--no-scan"],
            Duration::from_secs(60),
        )
        .ok()?;
        Some((
            out.stdout.contains("[restart]") || out.stdout.contains("Action: restart"),
            None,
        ))
    }

    pub fn antivirus() -> Option<(Option<bool>, Option<f64>, String)> {
        None
    }

    pub fn firewall() -> Result<Vec<(String, bool)>> {
        let out = crate::util::run_capture(
            std::path::Path::new("/usr/libexec/ApplicationFirewall/socketfilterfw"),
            &["--getglobalstate"],
            Duration::from_secs(20),
        )?;
        let text = out.stdout.to_ascii_lowercase();
        if text.trim().is_empty() {
            bail!("the application firewall state is unavailable");
        }
        Ok(vec![(
            "Application Firewall".into(),
            text.contains("enabled") || text.contains("state = 1"),
        )])
    }

    pub fn windows_update() -> Option<Result<(Option<f64>, u32)>> {
        None
    }

    fn ioreg_number(text: &str, key: &str) -> Option<f64> {
        text.lines()
            .find(|l| l.trim_start().starts_with(&format!("\"{key}\" =")))
            .and_then(|l| l.split('=').nth(1))
            .and_then(|v| v.trim().parse().ok())
    }

    pub fn battery_health() -> Option<f64> {
        let out = crate::util::run_capture(
            &crate::util::system_tool("ioreg"),
            &["-rn", "AppleSmartBattery"],
            Duration::from_secs(20),
        )
        .ok()?;
        if out.stdout.trim().is_empty() {
            return None;
        }
        let full = ioreg_number(&out.stdout, "AppleRawMaxCapacity")
            .or_else(|| ioreg_number(&out.stdout, "MaxCapacity"));
        let design = ioreg_number(&out.stdout, "DesignCapacity");
        match (full, design) {
            (Some(f), Some(d)) if d > 0.0 && f > 100.0 => Some((f / d * 100.0).min(100.0)),
            (Some(f), _) if f <= 100.0 => Some(f),
            _ => Some(100.0),
        }
    }

    pub fn store_certificate(_store: &str) -> Option<Result<Option<(String, f64)>>> {
        None
    }
}

// ------------------------------------------------------------------ selftest

fn cfg_of(v: Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}

/// `rustrmm-agent selftest` check: evaluates cpu, memory, disk, uptime and a tcp_port check
/// against a local listener (and a closed port).
pub async fn selftest() -> Result<String> {
    let dir = std::env::temp_dir().join(format!("rustrmm-checks-{}", std::process::id()));
    let ctx = Arc::new(ProbeCtx {
        paths: crate::paths::Paths::resolve(Some(dir.clone())),
        device_id: "selftest".into(),
        samples: Arc::new(Mutex::new(Samples::default())),
        shared: Arc::new(Mutex::new(super::Shared::default())),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let accept = tokio::spawn(async move { while let Ok((_sock, _)) = listener.accept().await {} });
    // A port that was free a moment ago is (almost certainly) closed now.
    let closed = {
        let probe = std::net::TcpListener::bind("127.0.0.1:0")?;
        probe.local_addr()?.port()
    };
    let def = |id: &str, kind: &str, config: Value| CheckDefinition {
        id: id.into(),
        kind: kind.into(),
        name: id.into(),
        interval_secs: 60,
        config,
        script: None,
    };
    let checks = [
        def(
            "cpu",
            "cpu",
            serde_json::json!({ "warn_pct": 101, "crit_pct": 101, "window_minutes": 1 }),
        ),
        def(
            "memory",
            "memory",
            serde_json::json!({ "warn_pct": 101, "crit_pct": 101, "window_minutes": 1 }),
        ),
        def(
            "disk",
            "disk",
            serde_json::json!({ "volume": "*", "crit_free_pct": 0 }),
        ),
        def(
            "uptime",
            "uptime",
            serde_json::json!({ "warn_days": 3650, "crit_days": 3650 }),
        ),
        def(
            "tcp",
            "tcp_port",
            serde_json::json!({ "host": "127.0.0.1", "port": port, "timeout_ms": 2000 }),
        ),
    ];
    let mut parts = Vec::new();
    let started = Instant::now();
    for check in checks {
        let id = check.id.clone();
        let e = run(ctx.clone(), check).await;
        if e.state != CheckState::Ok {
            accept.abort();
            let _ = std::fs::remove_dir_all(&dir);
            bail!("{id} check reported {}: {}", e.state, e.message);
        }
        parts.push(format!("{id}: {}", e.message));
    }
    let closed_check = def(
        "closed",
        "tcp_port",
        serde_json::json!({ "host": "127.0.0.1", "port": closed, "timeout_ms": 1000 }),
    );
    let e = run(ctx.clone(), closed_check).await;
    accept.abort();
    let _ = std::fs::remove_dir_all(&dir);
    if e.state != CheckState::Critical {
        bail!("a closed port was reported {} ({})", e.state, e.message);
    }
    let cfg = cfg_of(serde_json::json!({ "warn_free_pct": 101 }));
    if eval::disk(&volumes(true), &Config(&cfg)).state != CheckState::Warning {
        bail!("disk thresholds did not grade a volume");
    }
    Ok(format!(
        "{}; closed port failed as expected ({} ms)",
        parts.join("; "),
        started.elapsed().as_millis()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_output_is_parsed_on_every_platform() {
        let linux = "PING 10.0.0.1 (10.0.0.1) 56(84) bytes of data.\n64 bytes from 10.0.0.1: icmp_seq=1 ttl=64 time=0.045 ms\n\n--- 10.0.0.1 ping statistics ---\n3 packets transmitted, 3 received, 0% packet loss, time 2046ms\nrtt min/avg/max/mdev = 0.040/0.052/0.071/0.013 ms\n";
        assert_eq!(parse_ping(linux), Some((0.0, Some(0.052))));
        let mac = "3 packets transmitted, 2 packets received, 33.3% packet loss\nround-trip min/avg/max/stddev = 10.1/12.5/14.9/2.4 ms\n";
        assert_eq!(parse_ping(mac), Some((33.3, Some(12.5))));
        let windows = "Ping statistics for 8.8.8.8:\n    Packets: Sent = 4, Received = 3, Lost = 1 (25% loss),\nApproximate round trip times in milli-seconds:\n    Minimum = 11ms, Maximum = 15ms, Average = 13ms\n";
        assert_eq!(parse_ping(windows), Some((25.0, Some(13.0))));
        let german = "    Pakete: Gesendet = 4, Empfangen = 4, Verloren = 0\n    (0% Verlust),\n    Minimum = 1ms, Maximum = 2ms, Mittelwert = 1ms\n";
        assert_eq!(parse_ping(german), Some((0.0, Some(1.0))));
        let lost = "4 packets transmitted, 0 received, 100% packet loss, time 3062ms\n";
        assert_eq!(parse_ping(lost), Some((100.0, None)));
        assert_eq!(parse_ping("garbage"), None);
    }

    #[test]
    fn certificate_files_are_read() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("cert.pem");
        let ca = rustrmm_crypto::pki::generate_ca("selftest").expect("certificate");
        std::fs::write(&path, &ca.cert_pem).expect("write");
        let (subject, days) = file_certificate(path.to_str().expect("utf8")).expect("parsed");
        assert!(subject.contains("selftest"), "{subject}");
        assert!(days > 3000.0, "{days}");
        assert!(file_certificate(dir.path().join("missing.pem").to_str().expect("utf8")).is_err());
    }
}
