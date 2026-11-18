//! Phase 5 automation: scripts, variables, jobs, approvals, custom fields, device groups and
//! policies (`docs/api-automation.md`).

pub mod approvals;
pub mod builtin;
pub mod cron;
pub mod custom_fields;
pub mod directives;
pub mod groups;
pub mod jobs;
pub mod params;
pub mod policies;
pub mod rules;
pub mod scripts;
pub mod settings;
pub mod variables;

use std::time::{Duration, Instant};

use dashmap::DashMap;
use serde_json::json;
use tokio::sync::{Mutex, Notify};

use crate::state::AppState;

/// How often the scheduler runs when nothing wakes it earlier.
pub const TICK: Duration = Duration::from_secs(15);
/// `job.updated` is published at most this often per run.
const EVENT_INTERVAL: Duration = Duration::from_secs(1);

/// In-memory scheduler state.
#[derive(Default)]
pub struct Runtime {
    kick: Notify,
    /// Serialises dispatch so concurrency limits hold.
    pub(crate) dispatch: Mutex<()>,
    throttle: DashMap<String, Throttle>,
}

struct Throttle {
    last: Instant,
    pending: bool,
}

impl Runtime {
    pub fn new() -> Self {
        Self::default()
    }

    /// Wakes the scheduler for an immediate tick.
    pub fn kick(&self) {
        self.kick.notify_one();
    }
}

/// Runs the scheduler: due jobs, approvals expiry, offline waits, dispatch and completion.
pub fn spawn_scheduler(state: AppState) {
    tokio::spawn(async move {
        loop {
            if let Err(e) = tick(&state).await {
                tracing::warn!(error = %format!("{e:#}"), "automation scheduler tick failed");
            }
            tokio::select! {
                _ = tokio::time::sleep(TICK) => {}
                _ = state.automation.kick.notified() => {}
            }
        }
    });
}

/// One scheduler pass.
pub async fn tick(state: &AppState) -> anyhow::Result<()> {
    approvals::expire(state).await?;
    jobs::start_due(state).await?;
    jobs::sweep(state).await?;
    state
        .automation
        .throttle
        .retain(|_, t| t.pending || t.last.elapsed() < Duration::from_secs(300));
    Ok(())
}

/// Start-up recovery (before agents connect).
pub async fn recover(state: &AppState) -> anyhow::Result<()> {
    jobs::recover(&state.db).await
}

/// Agent connected: dispatch its waiting results.
pub async fn on_connect(state: &AppState, device_id: &str) {
    if let Err(e) = jobs::on_connect(state, device_id).await {
        tracing::warn!(device = device_id, error = %format!("{e:#}"), "dispatching waiting scripts failed");
    }
}

/// Agent disconnected: running scripts can no longer report back.
pub async fn on_disconnect(state: &AppState, device_id: &str) {
    if let Err(e) = jobs::on_disconnect(state, device_id).await {
        tracing::warn!(device = device_id, error = %format!("{e:#}"), "closing running scripts failed");
    }
}

async fn publish_now(state: &AppState, job_id: &str, run_id: &str) {
    let status: Option<String> = sqlx::query_scalar("SELECT status FROM job_runs WHERE id = ?")
        .bind(run_id)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten();
    let client: Option<String> = sqlx::query_scalar("SELECT client_id FROM jobs WHERE id = ?")
        .bind(job_id)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten();
    let Ok(counts) = jobs::counts(&state.db, run_id).await else {
        return;
    };
    state.events.publish(
        "job.updated",
        client,
        json!({ "job_id": job_id, "run_id": run_id, "status": status, "counts": counts }),
    );
}

/// Publishes `job.updated` for a run, at most once per second (a trailing event carries the
/// latest counts). `force` publishes immediately (run started, completed or cancelled).
pub fn publish_job_updated(state: &AppState, job_id: &str, run_id: &str, force: bool) {
    let now = Instant::now();
    let delay = {
        let mut entry = state
            .automation
            .throttle
            .entry(run_id.to_string())
            .or_insert(Throttle {
                last: now - EVENT_INTERVAL,
                pending: false,
            });
        let since = now.duration_since(entry.last);
        if force || since >= EVENT_INTERVAL {
            entry.last = now;
            Some(Duration::ZERO)
        } else if entry.pending {
            None
        } else {
            entry.pending = true;
            Some(EVENT_INTERVAL - since)
        }
    };
    let Some(delay) = delay else {
        return;
    };
    let state = state.clone();
    let (job_id, run_id) = (job_id.to_string(), run_id.to_string());
    tokio::spawn(async move {
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
            if let Some(mut entry) = state.automation.throttle.get_mut(&run_id) {
                entry.pending = false;
                entry.last = Instant::now();
            }
        }
        publish_now(&state, &job_id, &run_id).await;
    });
}
