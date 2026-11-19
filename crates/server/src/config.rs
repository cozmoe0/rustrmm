//! Command line and environment configuration.
//!
//! Every option can be given as a flag or as a `RUSTRMM_*` environment variable, so the same
//! binary is configured by `docker-compose.yml`, a Windows service, or a developer shell.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use clap::{Args, Parser, Subcommand, ValueEnum};
use ipnet::IpNet;
use url::Url;

#[derive(Debug, Parser)]
#[command(
    name = "rustrmm-server",
    version = rustrmm_common::VERSION,
    about = "RustRMM server: web console, REST API and agent gateway"
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Command>,

    #[command(flatten)]
    pub serve: ServeArgs,
}

#[derive(Debug, Subcommand)]
#[allow(clippy::large_enum_variant)] // parsed once at startup
pub enum Command {
    /// Run the server (default when no subcommand is given).
    Serve(ServeArgs),
    /// Generate a master key and a starter `.env` for docker compose.
    Init(InitArgs),
    /// Probe the local console listener; exits non-zero when unhealthy (container healthcheck).
    Healthcheck(HealthcheckArgs),
    /// Restore a backup archive into a data directory (server must be stopped).
    Restore(RestoreArgs),
}

/// TLS termination mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TlsMode {
    /// Built-in certificate authority (default). Agents pin the CA.
    Internal,
    /// Operator-provided certificate and key (e.g. issued by AD CS).
    Custom,
    /// Plain HTTP behind a trusted TLS-terminating reverse proxy.
    Proxy,
}

impl TlsMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Internal => "internal",
            Self::Custom => "custom",
            Self::Proxy => "proxy",
        }
    }
}

/// Whether agents must use the Noise IK end-to-end channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentNoise {
    /// Use the channel with every agent that supports it; older agents stay on TLS only.
    Auto,
    /// Refuse agents that do not support the channel (default in `proxy` TLS mode).
    Required,
}

#[derive(Debug, Clone, Args)]
pub struct ServeArgs {
    /// Directory holding the database, keys, PKI and blobs.
    #[arg(long, env = "RUSTRMM_DATA_DIR", default_value = "./data")]
    pub data_dir: PathBuf,

    /// Address for the console/API listener (keep LAN/VPN-only).
    #[arg(long, env = "RUSTRMM_CONSOLE_BIND", default_value = "0.0.0.0:8443")]
    pub console_bind: SocketAddr,

    /// Address for the agent gateway listener (the only port to expose to the internet).
    #[arg(long, env = "RUSTRMM_AGENT_BIND", default_value = "0.0.0.0:8444")]
    pub agent_bind: SocketAddr,

    /// Serve console and agent endpoints on the console listener only (dev / simple LAN setups).
    #[arg(long, env = "RUSTRMM_SINGLE_LISTENER", default_value_t = false)]
    pub single_listener: bool,

    /// Optional plain-HTTP listener that redirects to HTTPS.
    #[arg(long, env = "RUSTRMM_HTTP_BIND")]
    pub http_bind: Option<SocketAddr>,

    /// Public URL of the console as seen by browsers.
    #[arg(
        long,
        env = "RUSTRMM_CONSOLE_URL",
        default_value = "https://localhost:8443"
    )]
    pub console_url: Url,

    /// Public URL agents use to reach the gateway. Defaults to the console host on the agent port.
    #[arg(long, env = "RUSTRMM_AGENT_URL")]
    pub agent_url: Option<Url>,

    /// TLS mode.
    #[arg(long, env = "RUSTRMM_TLS_MODE", value_enum, default_value = "internal")]
    pub tls_mode: TlsMode,

    /// Noise IK end-to-end channel for agents: `auto` or `required`. Defaults to `required` in
    /// `proxy` TLS mode (the proxy terminates TLS, so only Noise keeps agent traffic private from
    /// it) and `auto` otherwise.
    #[arg(long, env = "RUSTRMM_AGENT_NOISE", value_enum)]
    pub agent_noise: Option<AgentNoise>,

    /// Certificate chain (PEM) for `custom` TLS mode.
    #[arg(long, env = "RUSTRMM_TLS_CERT")]
    pub tls_cert: Option<PathBuf>,

    /// Private key (PEM) for `custom` TLS mode.
    #[arg(long, env = "RUSTRMM_TLS_KEY")]
    pub tls_key: Option<PathBuf>,

    /// Extra subject alternative names for the internal certificate (comma separated).
    #[arg(long, env = "RUSTRMM_EXTRA_SANS", value_delimiter = ',')]
    pub extra_sans: Vec<String>,

    /// Master key file (base64). Defaults to `<data-dir>/keys/master.key`, generated if missing.
    #[arg(long, env = "RUSTRMM_MASTER_KEY_FILE")]
    pub master_key_file: Option<PathBuf>,

    /// Local backup destination. Defaults to `<data-dir>/backups`.
    #[arg(long, env = "RUSTRMM_BACKUP_DIR")]
    pub backup_dir: Option<PathBuf>,

    /// Directory with agent binaries served to installers (`<platform>/<file>`).
    #[arg(long, env = "RUSTRMM_AGENT_DIST")]
    pub agent_dist: Option<PathBuf>,

    /// Reverse proxies whose `X-Forwarded-For` header is trusted (CIDRs, comma separated).
    #[arg(long, env = "RUSTRMM_TRUSTED_PROXIES", value_delimiter = ',')]
    pub trusted_proxies: Vec<IpNet>,

    /// Extra browser origins allowed to call the API (e.g. a dev server), comma separated.
    #[arg(long, env = "RUSTRMM_ALLOWED_ORIGINS", value_delimiter = ',')]
    pub allowed_origins: Vec<Url>,

    /// Development mode: allows http://localhost origins (Vite) and relaxes nothing else.
    #[arg(long, env = "RUSTRMM_DEV", default_value_t = false)]
    pub dev: bool,

    /// Log format: pretty or json.
    #[arg(long, env = "RUSTRMM_LOG_FORMAT", default_value = "pretty")]
    pub log_format: rustrmm_common::logging::LogFormat,

    /// Minutes of inactivity before a console session expires.
    #[arg(long, env = "RUSTRMM_SESSION_IDLE_MINUTES", default_value_t = 30)]
    pub session_idle_minutes: i64,

    /// Absolute console session lifetime in hours.
    #[arg(long, env = "RUSTRMM_SESSION_MAX_HOURS", default_value_t = 12)]
    pub session_max_hours: i64,
}

impl ServeArgs {
    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("rustrmm.db")
    }

    pub fn keys_dir(&self) -> PathBuf {
        self.data_dir.join("keys")
    }

    pub fn pki_dir(&self) -> PathBuf {
        self.data_dir.join("pki")
    }

    pub fn files_dir(&self) -> PathBuf {
        self.data_dir.join("files")
    }

    pub fn tmp_dir(&self) -> PathBuf {
        self.data_dir.join("tmp")
    }

    pub fn master_key_path(&self) -> PathBuf {
        self.master_key_file
            .clone()
            .unwrap_or_else(|| self.keys_dir().join("master.key"))
    }

    pub fn backup_path(&self) -> PathBuf {
        self.backup_dir
            .clone()
            .unwrap_or_else(|| self.data_dir.join("backups"))
    }

    /// True when agents without the Noise channel are refused.
    pub fn noise_required(&self) -> bool {
        match self.agent_noise {
            Some(mode) => mode == AgentNoise::Required,
            None => self.tls_mode == TlsMode::Proxy,
        }
    }

    /// The URL agents should use, derived from the console URL when not set explicitly.
    pub fn effective_agent_url(&self) -> Url {
        if let Some(url) = &self.agent_url {
            return url.clone();
        }
        let mut url = self.console_url.clone();
        if !self.single_listener {
            let _ = url.set_port(Some(self.agent_bind.port()));
        }
        url
    }

    /// Origin string (`scheme://host[:port]`) of the console URL.
    pub fn console_origin(&self) -> String {
        origin_of(&self.console_url)
    }
}

/// `scheme://host[:port]` for a URL (default ports omitted, as browsers do).
pub fn origin_of(url: &Url) -> String {
    url.origin().ascii_serialization()
}

#[derive(Debug, Clone, Args)]
pub struct InitArgs {
    /// Where to write `master.key` (docker secret file).
    #[arg(long, default_value = "./secrets")]
    pub secrets_dir: PathBuf,
    /// Where to write a starter `.env` (skipped if it already exists).
    #[arg(long, default_value = "./.env")]
    pub env_file: PathBuf,
    /// Public console URL to put in the starter `.env`.
    #[arg(long, default_value = "https://rmm.example.internal")]
    pub console_url: Url,
}

#[derive(Debug, Clone, Args)]
pub struct HealthcheckArgs {
    /// Local console address to probe.
    #[arg(
        long,
        env = "RUSTRMM_HEALTHCHECK_ADDR",
        default_value = "127.0.0.1:8443"
    )]
    pub addr: SocketAddr,
    /// Use plain HTTP instead of TLS (for `proxy` mode).
    #[arg(long, env = "RUSTRMM_HEALTHCHECK_PLAIN", default_value_t = false)]
    pub plain: bool,
}

#[derive(Debug, Clone, Args)]
pub struct RestoreArgs {
    /// Backup archive (`.tar.zst.age`).
    #[arg(long)]
    pub file: PathBuf,
    /// age identity file from the recovery kit (`AGE-SECRET-KEY-1...`).
    #[arg(long)]
    pub identity_file: PathBuf,
    /// Data directory to restore into.
    #[arg(long, env = "RUSTRMM_DATA_DIR", default_value = "./data")]
    pub data_dir: PathBuf,
}

/// Ensures runtime directories exist.
pub fn ensure_dirs(args: &ServeArgs) -> std::io::Result<()> {
    for dir in [
        args.data_dir.clone(),
        args.keys_dir(),
        args.pki_dir(),
        args.files_dir(),
        args.tmp_dir(),
    ] {
        std::fs::create_dir_all(&dir)?;
    }
    std::fs::create_dir_all(args.backup_path())?;
    Ok(())
}

/// Returns true if `path` is inside `dir` (lexically, after canonicalisation when possible).
pub fn is_within(path: &Path, dir: &Path) -> bool {
    match (path.canonicalize(), dir.canonicalize()) {
        (Ok(p), Ok(d)) => p.starts_with(d),
        _ => path.starts_with(dir),
    }
}
