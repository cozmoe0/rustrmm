//! RustRMM server library: everything except the CLI entry point, so integration tests can
//! build the application in-process.

// sqlx row tuples are clearer inline than as one-off type aliases.
#![allow(clippy::type_complexity)]

pub mod agents;
pub mod api;
pub mod audit;
pub mod auth;
pub mod automation;
pub mod backup;
pub mod branding;
pub mod config;
pub mod dashboards;
pub mod db;
pub mod error;
pub mod escrow;
pub mod events;
pub mod keys;
pub mod listeners;
pub mod lockfile;
pub mod monitoring;
pub mod network;
pub mod openapi;
pub mod patching;
pub mod ratelimit;
pub mod rbac;
pub mod reports;
pub mod setup;
pub mod signing;
pub mod software;
pub mod state;
pub mod tickets;
pub mod tls;
pub mod web;
pub mod webhooks;

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use rustrmm_crypto::field::FieldCipher;
use rustrmm_crypto::master::MasterKey;

use crate::config::ServeArgs;
use crate::state::{AppState, Inner, TlsInfo};

/// Everything needed to serve, assembled from configuration.
pub struct Prepared {
    pub state: AppState,
    pub tls: tls::TlsSetup,
    _lock: Option<lockfile::DataLock>,
}

/// Builds application state: opens the database (backing up before migrations), loads keys and
/// TLS material, and prepares the setup gate. `lock` should be true for real servers.
pub async fn prepare(args: ServeArgs, lock: bool) -> Result<Prepared> {
    config::ensure_dirs(&args).context("creating data directories")?;
    let lock = if lock {
        Some(lockfile::acquire(&args.data_dir)?)
    } else {
        None
    };

    let master_path = args.master_key_path();
    let (master, created) = if args.master_key_file.is_some() {
        // An explicitly configured key (e.g. a Docker secret) must exist; never invent one there.
        let key = MasterKey::load(&master_path).with_context(|| {
            format!(
                "master key file {} could not be read — create it with `openssl rand -base64 32` (see deploy/README.md)",
                master_path.display()
            )
        })?;
        (key, false)
    } else {
        MasterKey::load_or_create(&master_path)
            .with_context(|| format!("loading master key from {}", master_path.display()))?
    };
    if created {
        tracing::warn!(
            path = %master_path.display(),
            "generated a new master key — back it up (it is part of the recovery kit) or supply RUSTRMM_MASTER_KEY_FILE"
        );
    }
    let master = Arc::new(master);
    let cipher = FieldCipher::new(&master.derive("db-field-encryption"));
    let keys = keys::KeyRing::load_or_create(&args.keys_dir(), &master)?;

    let db = db::connect(&args.db_path()).await?;
    match db::pending_migrations(&db).await? {
        Some(pending) if pending > 0 => {
            tracing::info!(
                pending,
                "database schema upgrade pending; taking a backup first"
            );
            backup::pre_migration(&db, &args, &cipher, &keys.identity_public().to_string()).await;
        }
        _ => {}
    }
    db::migrate(&db).await?;
    rbac::seed_builtin_roles(&db).await?;
    automation::builtin::seed(&db)
        .await
        .context("seeding built-in scripts")?;
    monitoring::baseline::seed(&db)
        .await
        .context("seeding the baseline monitoring policy")?;
    tickets::seed(&db)
        .await
        .context("seeding the default ticket queue and SLA policy")?;
    network::templates::seed(&db)
        .await
        .context("seeding the built-in SNMP templates")?;

    let tls = tls::prepare(&args, &master)?;
    let webauthn = auth::webauthn::build(&args)?;
    let setup = setup::prepare_gate(&db).await?;
    let allowed_origins = auth::allowed_origins(&args);
    let (telemetry, metrics_rx) = agents::telemetry::Telemetry::new();
    agents::telemetry::spawn_writer(db.clone(), metrics_rx);

    let state = AppState::new(Inner {
        tls: TlsInfo {
            mode: tls.mode,
            ca_cert_pem: tls.ca_cert_pem.clone(),
            ca_spki_pin: tls.ca_spki_pin.clone(),
            leaf_spki_pin: tls.leaf_spki_pin.clone(),
        },
        args,
        db,
        master,
        cipher,
        keys,
        audit: audit::AuditLog::new(),
        events: events::EventBus::new(),
        tickets: events::TicketStore::default(),
        webauthn,
        setup,
        limiter: ratelimit::RateLimiter::new(),
        backups: backup::BackupService::new(),
        agents: agents::AgentRegistry::new(),
        automation: automation::Runtime::new(),
        monitoring: monitoring::Runtime::new(),
        helpdesk: tickets::Runtime::new(),
        network: network::Runtime::new(),
        telemetry,
        started: Instant::now(),
        allowed_origins,
    });
    Ok(Prepared {
        state,
        tls,
        _lock: lock,
    })
}

/// Runs the server until shutdown.
pub async fn run(args: ServeArgs) -> Result<()> {
    rustrmm_common::logging::init(
        args.log_format,
        "info,rustrmm_server=info,sqlx=warn,tower_http=warn",
    );
    tracing::info!(version = rustrmm_common::VERSION, data_dir = %args.data_dir.display(), "starting RustRMM server");
    let prepared = prepare(args, true).await?;
    let state = prepared.state.clone();

    backup::BackupService::spawn_scheduler(state.clone());
    agents::telemetry::spawn_rollups(state.db.clone());
    agents::telemetry::spawn_offline_sweeper(state.clone());
    match agents::releases::import_dist(&state).await {
        Ok(Some(version)) => {
            tracing::info!(%version, "agent release imported from the distribution directory")
        }
        Ok(None) => {}
        Err(e) => tracing::warn!(error = %format!("{e:#}"), "could not import agent release"),
    }
    agents::releases::spawn_auto_updates(state.clone());
    // Connections from a previous run are gone.
    sqlx::query(
        "UPDATE devices SET online = 0, offline_reason = COALESCE(offline_reason, 'connection_lost') WHERE online = 1",
    )
        .execute(&state.db)
        .await?;
    automation::recover(&state).await?;
    automation::spawn_scheduler(state.clone());
    monitoring::recover(&state).await?;
    monitoring::spawn(state.clone());
    patching::recover(&state).await?;
    patching::spawn(state.clone());
    tickets::recover(&state).await?;
    tickets::spawn(state.clone());
    escrow::spawn(state.clone());
    network::recover(&state).await?;
    network::spawn(state.clone());
    webhooks::spawn(state.clone());
    reports::spawn(state.clone());
    spawn_housekeeping(state.clone());
    if let Some(resolver) = prepared.tls.resolver.clone()
        && state.tls.mode == config::TlsMode::Internal
    {
        tls::spawn_renewal(state.args.clone(), state.master.clone(), resolver);
    }
    if let Some(pin) = &state.tls.ca_spki_pin {
        tracing::info!(ca_pin = %pin, "internal CA ready (agents pin this key)");
    }
    tracing::info!(console = %state.args.console_url, agents = %state.args.effective_agent_url(), "RustRMM is ready");

    let tls = prepared.tls;
    let _keep_lock = prepared._lock;
    listeners::serve(state, tls).await
}

fn spawn_housekeeping(state: AppState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(3600));
        loop {
            interval.tick().await;
            if let Err(e) = auth::session::purge_expired(&state.db).await {
                tracing::warn!(error = %format!("{e:#}"), "session purge failed");
            }
            state.limiter.sweep(Duration::from_secs(3600));
        }
    });
}

/// `rustrmm-server init`: writes a master key secret and a starter `.env`.
pub fn init(args: config::InitArgs) -> Result<()> {
    let key_path = args.secrets_dir.join("master.key");
    if key_path.exists() {
        anyhow::bail!(
            "{} already exists — refusing to overwrite a master key",
            key_path.display()
        );
    }
    MasterKey::generate().write_to(&key_path)?;
    println!("Wrote master key: {}", key_path.display());
    println!(
        "  Keep a copy somewhere safe — without it, backups and encrypted settings cannot be recovered."
    );
    if args.env_file.exists() {
        println!("Left existing {} untouched", args.env_file.display());
    } else {
        let host = args
            .console_url
            .host_str()
            .unwrap_or("rmm.example.internal");
        let env = format!(
            "# RustRMM docker compose settings\n\
             RUSTRMM_CONSOLE_URL={console}\n\
             RUSTRMM_AGENT_URL=https://{host}:8444\n\
             # internal (built-in CA), custom (mount your own cert), or proxy (behind a TLS proxy)\n\
             RUSTRMM_TLS_MODE=internal\n\
             # Extra names/IPs for the internal certificate, comma separated\n\
             RUSTRMM_EXTRA_SANS=\n\
             RUSTRMM_LOG_FORMAT=json\n\
             TZ=UTC\n",
            console = args.console_url,
        );
        std::fs::write(&args.env_file, env)?;
        println!("Wrote {}", args.env_file.display());
    }
    Ok(())
}

/// `rustrmm-server healthcheck`: succeeds when the console port accepts connections.
pub async fn healthcheck(args: config::HealthcheckArgs) -> Result<()> {
    let connect = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::net::TcpStream::connect(args.addr),
    )
    .await;
    match connect {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(anyhow::anyhow!("cannot connect to {}: {e}", args.addr)),
        Err(_) => Err(anyhow::anyhow!("timed out connecting to {}", args.addr)),
    }
}
