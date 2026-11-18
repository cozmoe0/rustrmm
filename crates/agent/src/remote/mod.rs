//! Remote tools run on behalf of an operator. Every request arrives as a signed command; results
//! travel back as the command result's `data` document.

mod diag;
mod eventlog;
mod files;
mod message;
mod power;
mod processes;
#[cfg(windows)]
mod registry;
pub(crate) mod services;
pub mod tunnel;

use anyhow::{Result, bail};
use rustrmm_proto::commands::Command;
use serde_json::Value;

/// Runs a short request/response tool on a blocking thread and returns its result document.
pub async fn execute(command: Command) -> Result<Value> {
    tokio::task::spawn_blocking(move || run_blocking(command)).await?
}

fn run_blocking(command: Command) -> Result<Value> {
    match command {
        Command::ListProcesses => processes::list(),
        Command::KillProcess { pid, tree } => processes::kill(pid, tree),
        Command::ListServices => services::list(),
        Command::ControlService { name, action } => services::control(&name, action),
        Command::Power {
            action,
            delay_secs,
            message,
        } => power::run(action, delay_secs, &message),
        Command::MessageUser {
            title,
            body,
            timeout_secs,
        } => message::show(&title, &body, timeout_secs),
        Command::Diagnostic { kind, target, port } => diag::run(kind, &target, port),
        Command::ListDir { path } => files::list(&path),
        Command::FileOp(op) => files::apply(op),
        Command::EventLog {
            log,
            max_level,
            limit,
            hours,
        } => eventlog::query(&log, max_level, limit, hours),
        Command::RegistryList { path } => registry_list(&path),
        Command::DesktopSessions => crate::desktop::list_sessions(),
        other => bail!("{} is not a remote tool", other.kind()),
    }
}

#[cfg(windows)]
fn registry_list(path: &str) -> Result<Value> {
    registry::list(path)
}

#[cfg(not(windows))]
fn registry_list(_path: &str) -> Result<Value> {
    bail!("the registry exists only on Windows")
}
