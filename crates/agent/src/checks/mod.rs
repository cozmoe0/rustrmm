//! The check engine: runs the monitoring checks the server configured, on their intervals,
//! whether or not the agent is connected.
//!
//! * The verified configuration (it arrives in a signed command) is persisted in the data
//!   directory together with each check's debounce state and the queue of unsent results, so
//!   checks keep running offline and across restarts.
//! * Every check runs in its own task (blocking probes on the blocking pool), at most one
//!   evaluation per check at a time; nothing here can stall the control connection.
//! * State changes are debounced ([`eval::Debounce`]) and sent as `check_results`; while
//!   offline they are queued (bounded) and flushed on reconnect, followed by a full snapshot.
//!   A full snapshot is also sent every 15 minutes.

pub mod eval;
mod probes;

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rustrmm_proto::monitoring::{
    CheckDefinition, CheckResult, CheckResults, CheckState, MAX_INTERVAL_SECS, MIN_INTERVAL_SECS,
    MonitoringConfig,
};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::paths::Paths;
use eval::{Debounce, Evaluation};

pub use probes::selftest;

const SNAPSHOT_EVERY: Duration = Duration::from_secs(15 * 60);
const SAMPLE_EVERY: Duration = Duration::from_secs(30);
const PERSIST_EVERY: Duration = Duration::from_secs(10);
/// Results kept while offline; the oldest are dropped first.
const MAX_QUEUE: usize = 1000;
/// Results per `check_results` message.
const CHUNK: usize = 200;

/// Persisted per-check memory.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CheckMemory {
    pub debounce: Debounce,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub value: Option<f64>,
    /// Unix milliseconds of the latest evaluation.
    #[serde(default)]
    pub at: i64,
}

/// Facts probes remember between evaluations (persisted).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Shared {
    /// When a pending restart was first seen (unix seconds).
    #[serde(default)]
    pub reboot_pending_since: Option<i64>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Stored {
    config: Option<MonitoringConfig>,
    #[serde(default)]
    memory: HashMap<String, CheckMemory>,
    #[serde(default)]
    queue: VecDeque<CheckResult>,
    #[serde(default)]
    shared: Shared,
}

fn state_file(paths: &Paths) -> std::path::PathBuf {
    paths.data_dir.join("monitoring.json")
}

fn load(paths: &Paths) -> Stored {
    std::fs::read(state_file(paths))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// Messages from connections to the engine.
enum Msg {
    Config(Box<MonitoringConfig>),
    Attach(mpsc::Sender<CheckResults>),
}

/// Cheap handle used by connections.
#[derive(Clone)]
pub struct Handle {
    tx: mpsc::Sender<Msg>,
}

impl Handle {
    /// Replaces the configuration (already signature-verified by the caller).
    pub fn apply(&self, config: MonitoringConfig) -> bool {
        self.tx.try_send(Msg::Config(Box::new(config))).is_ok()
    }

    /// Routes results to a new connection (queued results are flushed into it first).
    pub fn attach(&self, results: mpsc::Sender<CheckResults>) {
        let _ = self.tx.try_send(Msg::Attach(results));
    }
}

/// Context every probe receives.
pub struct ProbeCtx {
    pub paths: Paths,
    pub device_id: String,
    pub samples: Arc<Mutex<probes::Samples>>,
    pub shared: Arc<Mutex<Shared>>,
}

struct Engine {
    paths: Paths,
    config: MonitoringConfig,
    memory: HashMap<String, CheckMemory>,
    queue: VecDeque<CheckResult>,
    out: Option<mpsc::Sender<CheckResults>>,
    due: HashMap<String, Instant>,
    running: HashSet<String>,
    ctx: Arc<ProbeCtx>,
    dirty: bool,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn interval(def: &CheckDefinition) -> Duration {
    Duration::from_secs(u64::from(
        def.interval_secs
            .clamp(MIN_INTERVAL_SECS, MAX_INTERVAL_SECS),
    ))
}

impl Engine {
    fn persist(&mut self) {
        let shared = self
            .ctx
            .shared
            .lock()
            .map(|s| s.clone())
            .unwrap_or_default();
        let stored = Stored {
            config: Some(self.config.clone()),
            memory: self.memory.clone(),
            queue: self.queue.clone(),
            shared,
        };
        match serde_json::to_vec(&stored) {
            Ok(bytes) => {
                if let Err(e) = crate::config::write_private(&state_file(&self.paths), &bytes) {
                    tracing::warn!(error = %format!("{e:#}"), "could not save monitoring state");
                }
            }
            Err(e) => tracing::warn!(error = %e, "could not encode monitoring state"),
        }
        self.dirty = false;
    }

    /// Spreads first evaluations over a few seconds so a new configuration does not run every
    /// check at once.
    fn schedule_all(&mut self) {
        let start = Instant::now();
        self.due.clear();
        for (i, def) in self.config.checks.iter().enumerate() {
            let offset = Duration::from_millis(500 + (i as u64 % 20) * 750);
            self.due
                .insert(def.id.clone(), start + offset.min(interval(def)));
        }
    }

    fn apply(&mut self, config: MonitoringConfig) {
        if config.version == self.config.version && config.checks == self.config.checks {
            return;
        }
        if config.content_hash() != config.version {
            tracing::warn!(
                "monitoring configuration version does not match its content; using it anyway"
            );
        }
        tracing::info!(version = %config.version, checks = config.checks.len(), "monitoring configuration updated");
        let ids: HashSet<&str> = config.checks.iter().map(|c| c.id.as_str()).collect();
        // A check whose definition changed starts its debounce afresh.
        let changed: Vec<String> = config
            .checks
            .iter()
            .filter(|c| self.config.checks.iter().find(|o| o.id == c.id) != Some(c))
            .map(|c| c.id.clone())
            .collect();
        self.memory.retain(|id, _| ids.contains(id.as_str()));
        for id in changed {
            if let Some(m) = self.memory.get_mut(&id) {
                m.debounce.candidate = None;
                m.debounce.count = 0;
            }
        }
        self.config = config;
        self.schedule_all();
        self.persist();
    }

    fn emit(&mut self, results: Vec<CheckResult>) {
        if results.is_empty() {
            return;
        }
        if let Some(out) = &self.out {
            match out.try_send(CheckResults {
                results: results.clone(),
                full: false,
            }) {
                Ok(()) => return,
                Err(mpsc::error::TrySendError::Closed(_)) => self.out = None,
                Err(mpsc::error::TrySendError::Full(_)) => {}
            }
        }
        for r in results {
            if self.queue.len() >= MAX_QUEUE {
                self.queue.pop_front();
            }
            self.queue.push_back(r);
        }
        self.dirty = true;
    }

    fn snapshot(&self) -> Vec<CheckResult> {
        self.config
            .checks
            .iter()
            .filter_map(|def| {
                let m = self.memory.get(&def.id)?;
                let state = m.debounce.reported?;
                Some(CheckResult {
                    check_id: def.id.clone(),
                    state,
                    message: m.message.clone(),
                    value: m.value,
                    at: m.at,
                    streak: m.debounce.reported_streak(),
                })
            })
            .collect()
    }

    /// Sends the queue and then a full snapshot to the attached connection.
    fn flush(&mut self) {
        let Some(out) = self.out.clone() else {
            return;
        };
        while !self.queue.is_empty() {
            let batch: Vec<CheckResult> = self.queue.iter().take(CHUNK).cloned().collect();
            match out.try_send(CheckResults {
                results: batch.clone(),
                full: false,
            }) {
                Ok(()) => {
                    self.queue.drain(..batch.len());
                    self.dirty = true;
                }
                Err(mpsc::error::TrySendError::Closed(_)) => {
                    self.out = None;
                    return;
                }
                Err(mpsc::error::TrySendError::Full(_)) => return,
            }
        }
        self.send_snapshot();
    }

    fn send_snapshot(&mut self) {
        let Some(out) = &self.out else {
            return;
        };
        let results = self.snapshot();
        if results.is_empty() && self.config.checks.is_empty() {
            return;
        }
        if let Err(mpsc::error::TrySendError::Closed(_)) = out.try_send(CheckResults {
            results,
            full: true,
        }) {
            self.out = None;
        }
    }

    /// Feeds one evaluation through the debounce and emits what the server must hear.
    fn record(&mut self, check_id: &str, e: Evaluation) {
        if !self.config.checks.iter().any(|c| c.id == check_id) {
            return;
        }
        let at = now_ms();
        let threshold = self.config.unknown_threshold.max(1);
        let memory = self.memory.entry(check_id.to_string()).or_default();
        let transition = memory.debounce.feed(e.state);
        if transition.is_some() || memory.debounce.reported == Some(e.state) {
            memory.message = e.message.clone();
            memory.value = e.value;
        }
        memory.at = at;
        let resend_unknown = transition.is_none()
            && memory.debounce.reported == Some(CheckState::Unknown)
            && memory.debounce.raw == Some(CheckState::Unknown)
            && memory.debounce.streak == threshold;
        let streak = memory.debounce.reported_streak();
        self.dirty = true;
        if let Some(state) = transition {
            tracing::info!(check = check_id, state = %state, message = %e.message, "check state changed");
        }
        if transition.is_some() || resend_unknown {
            let state = memory.debounce.reported.unwrap_or(e.state);
            self.emit(vec![CheckResult {
                check_id: check_id.to_string(),
                state,
                message: e.message,
                value: e.value,
                at,
                streak,
            }]);
        }
    }

    fn start_due(&mut self, results: &mpsc::Sender<(String, Evaluation)>) {
        let now = Instant::now();
        let due: Vec<CheckDefinition> = self
            .config
            .checks
            .iter()
            .filter(|c| !self.running.contains(&c.id))
            .filter(|c| self.due.get(&c.id).is_none_or(|t| *t <= now))
            .cloned()
            .collect();
        for def in due {
            self.due.insert(def.id.clone(), now + interval(&def));
            self.running.insert(def.id.clone());
            let ctx = self.ctx.clone();
            let tx = results.clone();
            tokio::spawn(async move {
                let id = def.id.clone();
                // A probe that hangs is abandoned (and reported unknown) after its interval or
                // ten minutes, whichever is longer.
                let limit = interval(&def).max(Duration::from_secs(600));
                let evaluation = match tokio::time::timeout(limit, probes::run(ctx, def)).await {
                    Ok(e) => e,
                    Err(_) => Evaluation::unknown("the check did not finish in time"),
                };
                let _ = tx.send((id, evaluation)).await;
            });
        }
    }

    fn needs_samples(&self) -> bool {
        self.config
            .checks
            .iter()
            .any(|c| matches!(c.kind.as_str(), "cpu" | "memory"))
    }
}

/// Starts the engine; it runs until `shutdown`.
pub fn spawn(paths: Paths, device_id: String, shutdown: CancellationToken) -> Handle {
    let (tx, mut rx) = mpsc::channel::<Msg>(16);
    let stored = load(&paths);
    let ctx = Arc::new(ProbeCtx {
        paths: paths.clone(),
        device_id,
        samples: Arc::new(Mutex::new(probes::Samples::default())),
        shared: Arc::new(Mutex::new(stored.shared.clone())),
    });
    let mut engine = Engine {
        paths,
        config: stored
            .config
            .unwrap_or_else(|| MonitoringConfig::new(Vec::new(), 3)),
        memory: stored.memory,
        queue: stored.queue,
        out: None,
        due: HashMap::new(),
        running: HashSet::new(),
        ctx,
        dirty: false,
    };
    engine.schedule_all();
    if !engine.config.checks.is_empty() {
        tracing::info!(
            checks = engine.config.checks.len(),
            "monitoring checks loaded from disk"
        );
    }
    tokio::spawn(async move {
        let (result_tx, mut result_rx) = mpsc::channel::<(String, Evaluation)>(64);
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        let mut sample = tokio::time::interval(SAMPLE_EVERY);
        let mut snapshot =
            tokio::time::interval_at(Instant::now() + SNAPSHOT_EVERY, SNAPSHOT_EVERY);
        let mut persist = tokio::time::interval(PERSIST_EVERY);
        loop {
            tokio::select! {
                _ = shutdown.cancelled() => {
                    engine.persist();
                    return;
                }
                msg = rx.recv() => match msg {
                    Some(Msg::Config(config)) => engine.apply(*config),
                    Some(Msg::Attach(out)) => {
                        engine.out = Some(out);
                        engine.flush();
                    }
                    None => return,
                },
                Some((id, evaluation)) = result_rx.recv() => {
                    engine.running.remove(&id);
                    engine.record(&id, evaluation);
                }
                _ = tick.tick() => {
                    if engine.out.as_ref().is_some_and(|o| o.is_closed()) {
                        engine.out = None;
                    }
                    if engine.out.is_some() && !engine.queue.is_empty() {
                        engine.flush();
                    }
                    engine.start_due(&result_tx);
                }
                _ = sample.tick() => {
                    if engine.needs_samples() {
                        let samples = engine.ctx.samples.clone();
                        tokio::task::spawn_blocking(move || probes::take_sample(&samples));
                    }
                }
                _ = snapshot.tick() => engine.send_snapshot(),
                _ = persist.tick() => {
                    if engine.dirty {
                        engine.persist();
                    }
                }
            }
        }
    });
    Handle { tx }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn engine(dir: &std::path::Path) -> Engine {
        let paths = Paths::resolve(Some(dir.to_path_buf()));
        Engine {
            ctx: Arc::new(ProbeCtx {
                paths: paths.clone(),
                device_id: "dev".into(),
                samples: Arc::new(Mutex::new(probes::Samples::default())),
                shared: Arc::new(Mutex::new(Shared::default())),
            }),
            paths,
            config: MonitoringConfig::new(
                vec![CheckDefinition {
                    id: "disk".into(),
                    kind: "disk".into(),
                    name: "Disk".into(),
                    interval_secs: 60,
                    config: json!({ "warn_free_pct": 10 }),
                    script: None,
                }],
                2,
            ),
            memory: HashMap::new(),
            queue: VecDeque::new(),
            out: None,
            due: HashMap::new(),
            running: HashSet::new(),
            dirty: false,
        }
    }

    #[test]
    fn transitions_queue_offline_and_flush_with_a_snapshot() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut e = engine(dir.path());
        e.record("disk", Evaluation::ok("fine"));
        e.record(
            "disk",
            Evaluation::new(CheckState::Warning, "low", Some(9.0)),
        );
        e.record(
            "disk",
            Evaluation::new(CheckState::Warning, "low", Some(8.0)),
        );
        e.record("other", Evaluation::failing("not configured"));
        assert_eq!(e.queue.len(), 2, "ok, then the debounced warning");
        assert_eq!(e.queue[1].state, CheckState::Warning);
        assert_eq!(e.queue[1].streak, 2);
        e.persist();

        // Restart: the configuration, memory and queue come back from disk.
        let stored = load(&e.paths);
        assert_eq!(stored.queue.len(), 2);
        assert_eq!(
            stored.memory["disk"].debounce.reported,
            Some(CheckState::Warning)
        );
        assert_eq!(stored.config.expect("config").checks.len(), 1);

        let (tx, mut rx) = mpsc::channel(8);
        e.out = Some(tx);
        e.flush();
        let queued = rx.try_recv().expect("queued transitions");
        assert!(!queued.full);
        assert_eq!(queued.results.len(), 2);
        let snapshot = rx.try_recv().expect("snapshot");
        assert!(snapshot.full);
        assert_eq!(snapshot.results[0].state, CheckState::Warning);
        assert_eq!(snapshot.results[0].message, "low");
        assert!(e.queue.is_empty());

        // Unknown results are re-sent once they reach the unknown threshold (2 here).
        e.record("disk", Evaluation::unknown("probe failed"));
        assert!(rx.try_recv().is_err(), "one unknown is debounced");
        e.record("disk", Evaluation::unknown("probe failed"));
        let t = rx.try_recv().expect("unknown transition");
        assert_eq!(
            (t.results[0].state, t.results[0].streak),
            (CheckState::Unknown, 2)
        );
        e.record("disk", Evaluation::unknown("probe failed"));
        assert!(rx.try_recv().is_err(), "streak 3 is past the threshold");

        // A configuration without the check forgets it.
        e.apply(MonitoringConfig::new(Vec::new(), 3));
        assert!(e.memory.is_empty());
        e.record("disk", Evaluation::failing("gone"));
        assert!(rx.try_recv().is_err());
    }
}
