//! RustRMM agent.
//!
//! ```text
//! rustrmm-agent install --key rrmm1_…     install as a service and enroll (admin/root)
//! rustrmm-agent uninstall                 stop and remove the service and its data
//! rustrmm-agent run --console             run in the foreground (development)
//! rustrmm-agent enroll --key rrmm1_…      enroll only (used with --data-dir for development)
//! rustrmm-agent status                    show enrollment and service state
//! rustrmm-agent collect [section]         print inventory JSON (diagnostics)
//! rustrmm-agent support                   ask IT for help (dialog in the user's session)
//! ```

mod checks;
mod collectors;
mod config;
mod connection;
mod desktop;
mod enroll;
mod escrow;
mod identity;
mod install;
mod metrics;
mod network;
mod outbox;
mod patching;
mod paths;
mod pty;
mod remote;
mod scripts;
mod selftest;
mod service;
mod snmp;
mod software;
mod support;
mod tls;
mod update;
mod util;

use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};
use tokio_util::sync::CancellationToken;

/// The agent's version, including the build stamp (`0.1.0+20261118220341`) of stamped builds.
pub const AGENT_VERSION: &str = rustrmm_common::VERSION;

#[derive(Parser)]
#[command(name = "rustrmm-agent", version = AGENT_VERSION, about = "RustRMM endpoint agent")]
struct Cli {
    /// Override the data directory (development: run without installing).
    #[arg(long, global = true, env = "RUSTRMM_AGENT_DATA_DIR")]
    data_dir: Option<PathBuf>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Install the agent as a system service and enroll it.
    Install {
        /// Deploy key from the RustRMM console.
        #[arg(long)]
        key: String,
        /// Comma-separated capabilities to lock off on this machine (e.g. shell,desktop,scripts).
        #[arg(long, default_value = "")]
        disable_features: String,
    },
    /// Stop and remove the service.
    Uninstall {
        /// Keep the device identity and configuration (for a later reinstall).
        #[arg(long)]
        keep_data: bool,
    },
    /// Enroll this machine without installing a service.
    Enroll {
        #[arg(long)]
        key: String,
    },
    /// Run the agent.
    Run {
        /// Run in the foreground with console logging.
        #[arg(long)]
        console: bool,
    },
    /// Swaps in a staged update and supervises the restart (started by the agent itself).
    #[command(hide = true)]
    UpdateHelper {
        #[arg(long)]
        staged: PathBuf,
        #[arg(long)]
        target: PathBuf,
        #[arg(long)]
        version: String,
        #[arg(long)]
        cmd_id: String,
    },
    /// Entry point used by the Windows service control manager.
    #[command(hide = true)]
    Service,
    /// Remote desktop helper, started by the agent inside a user session (Windows).
    #[command(hide = true)]
    DesktopHelper {
        #[arg(long)]
        session: u32,
        #[arg(long)]
        pipe: String,
        #[arg(long)]
        parent: u32,
    },
    /// Development: start a desktop helper in this session and measure full-frame throughput.
    #[command(hide = true)]
    DesktopBench {
        #[arg(long, default_value_t = 50)]
        frames: u32,
        /// auto | low | medium | high
        #[arg(long, default_value = "medium")]
        quality: String,
        /// Only ack frames (dirty regions) instead of forcing a full refresh after each.
        #[arg(long)]
        incremental: bool,
    },
    /// Show enrollment and service status.
    Status,
    /// Check remote tools, the pseudo-terminal and the script runner on this machine (no server
    /// needed).
    #[command(hide = true)]
    Selftest,
    /// Ask IT for help: opens a dialog for a subject, a description and an optional
    /// screenshot, and creates a ticket.
    Support {
        /// Skip the dialog and use the options below (testing).
        #[arg(long, hide = true)]
        no_dialog: bool,
        #[arg(long, hide = true)]
        subject: Option<String>,
        #[arg(long, hide = true)]
        description: Option<String>,
        #[arg(long, hide = true)]
        email: Option<String>,
        /// Attach a screenshot of this session (with --no-dialog).
        #[arg(long, hide = true)]
        screenshot: bool,
    },
    /// Print collected inventory as JSON.
    Collect {
        /// Section name (system, hardware, storage, network, software, security, users, services, updates).
        section: Option<String>,
    },
}

fn main() -> std::process::ExitCode {
    let cli = Cli::parse();
    let paths = paths::Paths::resolve(cli.data_dir.clone());
    let result = match cli.command {
        Command::Service => service::run_as_service(paths),
        Command::Run { console } => {
            util::init_logging(&paths, console);
            runtime().and_then(|rt| {
                rt.block_on(async {
                    let token = CancellationToken::new();
                    let ctrl = token.clone();
                    tokio::spawn(async move {
                        let _ = tokio::signal::ctrl_c().await;
                        ctrl.cancel();
                    });
                    service::run_agent(paths, token).await
                })
            })
        }
        Command::Install {
            key,
            disable_features,
        } => {
            util::init_logging(&paths, true);
            runtime().and_then(|rt| rt.block_on(install::install(&paths, &key, &disable_features)))
        }
        Command::Uninstall { keep_data } => {
            util::init_logging(&paths, true);
            install::uninstall(&paths, keep_data)
        }
        Command::Enroll { key } => {
            util::init_logging(&paths, true);
            runtime().and_then(|rt| rt.block_on(enroll::enroll(&paths, &key)).map(|_| ()))
        }
        Command::UpdateHelper {
            staged,
            target,
            version,
            cmd_id,
        } => {
            util::init_logging(&paths, false);
            update::run_helper(&paths, &staged, &target, &version, &cmd_id)
        }
        Command::DesktopHelper {
            session,
            pipe,
            parent,
        } => desktop::helper_main(session, &pipe, parent),
        Command::DesktopBench {
            frames,
            quality,
            incremental,
        } => {
            util::init_logging(&paths, true);
            let quality = rustrmm_proto::desktop::Quality::parse(&quality)
                .unwrap_or(rustrmm_proto::desktop::Quality::Medium);
            runtime().and_then(|rt| rt.block_on(desktop::bench(frames, quality, incremental)))
        }
        Command::Status => status(&paths),
        Command::Selftest => runtime().and_then(|rt| rt.block_on(selftest::run())),
        Command::Support {
            no_dialog,
            subject,
            description,
            email,
            screenshot,
        } => {
            util::init_logging(&paths, true);
            let options = support::Options {
                no_dialog,
                subject,
                description,
                email,
                screenshot,
            };
            runtime().and_then(|rt| rt.block_on(support::run(&paths, options)))
        }
        Command::Collect { section } => {
            util::init_logging(&paths, true);
            collect(section)
        }
    };
    match result {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e:#}");
            std::process::ExitCode::FAILURE
        }
    }
}

fn runtime() -> Result<tokio::runtime::Runtime> {
    Ok(tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?)
}

fn status(paths: &paths::Paths) -> Result<()> {
    println!("RustRMM agent {AGENT_VERSION}");
    println!("data directory: {}", paths.data_dir.display());
    match config::AgentConfig::load(paths)? {
        Some(cfg) => {
            println!("device id:      {}", cfg.device_id);
            println!("server:         {}", cfg.server_urls.join(", "));
            println!("client / site:  {} / {}", cfg.client_name, cfg.site_name);
            println!("enrolled:       {}", cfg.enrolled_at);
        }
        None => println!("not enrolled"),
    }
    println!("service:        {}", install::service_state());
    Ok(())
}

fn collect(section: Option<String>) -> Result<()> {
    let sections = match section {
        Some(s) => vec![s],
        None => rustrmm_proto::messages::sections::ALL
            .iter()
            .map(|s| s.to_string())
            .collect(),
    };
    let mut out = serde_json::Map::new();
    for s in sections {
        let started = std::time::Instant::now();
        let value = collectors::collect(&s)?;
        tracing::info!(section = %s, ms = started.elapsed().as_millis() as u64, "collected");
        out.insert(s, value);
    }
    println!("{}", serde_json::to_string_pretty(&out)?);
    Ok(())
}
