//! Demo scenarios, shared by console mode and service mode. Each scenario logs what it saw and
//! returns PASS / FAIL / SKIP; the log is the deliverable.

use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};

use crate::conpty::{self, PtySession, PtySize, RunAs, SpawnOptions, fmt_ms};
use crate::token;
use crate::win;

const PROMPT_TIMEOUT: Duration = Duration::from_secs(30);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(20);
const EXIT_TIMEOUT: Duration = Duration::from_secs(10);
const INITIAL: PtySize = PtySize { cols: 80, rows: 25 };
const RESIZED: PtySize = PtySize { cols: 120, rows: 40 };

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Pass,
    Fail,
    Skip,
    /// Observation only; never fails the run.
    Info,
}

impl Verdict {
    fn label(self) -> &'static str {
        match self {
            Verdict::Pass => "PASS",
            Verdict::Fail => "FAIL",
            Verdict::Skip => "SKIP",
            Verdict::Info => "INFO",
        }
    }
}

pub struct Outcome {
    pub name: String,
    pub verdict: Verdict,
}

impl Outcome {
    pub fn failed(name: &str) -> Self {
        Self { name: name.into(), verdict: Verdict::Fail }
    }

    fn skipped(name: &str, why: &str) -> Self {
        logln!("=== {name}: SKIP ({why})");
        Self { name: name.into(), verdict: Verdict::Skip }
    }
}

/// Pitfall-reproduction switches; the defaults are the recommended behaviour.
#[derive(Clone, Copy)]
pub struct Options {
    pub use_std_handles: bool,
    pub inherit_environment: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self { use_std_handles: true, inherit_environment: false }
    }
}

/// Process-wide: shells must not inherit an "ignore Ctrl+C" flag from whoever started us.
pub fn reset_ctrl_c_inheritance() {
    match conpty::enable_ctrl_c_for_children() {
        Ok(()) => logln!("Ctrl+C handling re-enabled for child processes (SetConsoleCtrlHandler(NULL, FALSE))"),
        Err(e) => logln!("could not re-enable Ctrl+C for children: {e:#}"),
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Shell {
    Cmd,
    PowerShell,
}

impl Shell {
    fn name(self) -> &'static str {
        match self {
            Shell::Cmd => "cmd",
            Shell::PowerShell => "powershell",
        }
    }

    fn application(self) -> PathBuf {
        let system = win::system_dir();
        match self {
            Shell::Cmd => system.join("cmd.exe"),
            Shell::PowerShell => system.join(r"WindowsPowerShell\v1.0\powershell.exe"),
        }
    }

    fn arguments(self) -> &'static str {
        match self {
            Shell::Cmd => "",
            // No profile scripts: predictable startup, and nothing user-writable runs as SYSTEM.
            Shell::PowerShell => "-NoLogo -NoProfile",
        }
    }

    // The terminal echoes typed input, so markers are assembled at run time (cmd `^` escape,
    // PowerShell string concatenation): the echo never contains the literal marker.
    fn whoami(self) -> &'static str {
        match self {
            Shell::Cmd => "echo RRMM-WHO-^BEGIN & whoami & echo RRMM-WHO-^END\r",
            Shell::PowerShell => {
                "Write-Output ('RRMM-WHO-'+'BEGIN'); whoami; Write-Output ('RRMM-WHO-'+'END')\r"
            }
        }
    }

    fn size_query(self) -> &'static str {
        match self {
            Shell::Cmd => "echo RRMM-SIZE-^BEGIN & mode con & echo RRMM-SIZE-^END\r",
            Shell::PowerShell => {
                "Write-Output ('RRMM-SIZE-'+'BEGIN'); 'Columns: ' + [Console]::WindowWidth; 'Lines: ' + [Console]::WindowHeight; Write-Output ('RRMM-SIZE-'+'END')\r"
            }
        }
    }
}

fn pass_fail(ok: bool) -> &'static str {
    if ok { "ok" } else { "MISMATCH" }
}

fn between(text: &str, begin: &str, end: &str) -> Option<String> {
    let start = text.find(begin)? + begin.len();
    let stop = text[start..].find(end)? + start;
    Some(text[start..stop].to_string())
}

fn number_after(text: &str, label: &str) -> Option<u32> {
    let start = text.find(label)? + label.len();
    let digits: String = text[start..]
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok()
}

fn tail(text: &str, max_chars: usize) -> String {
    let count = text.chars().count();
    text.chars().skip(count.saturating_sub(max_chars)).collect()
}

fn wait_until(timeout: Duration, mut condition: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if condition() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn run_scenario(name: String, steps: impl FnOnce() -> Result<bool>) -> Outcome {
    logln!("=== {name}");
    let verdict = match steps() {
        Ok(true) => Verdict::Pass,
        Ok(false) => Verdict::Fail,
        Err(e) => {
            logln!("error: {e:#}");
            Verdict::Fail
        }
    };
    logln!("=== {name}: {}", verdict.label());
    Outcome { name, verdict }
}

fn spawn_shell(
    shell: Shell,
    run_as: RunAs<'_>,
    opts: Options,
    release_after_spawn: bool,
    start_reader_paused: bool,
) -> Result<PtySession> {
    let cwd = match &run_as {
        RunAs::Caller => Some(win::system_dir()),
        RunAs::Token(user) => token::user_profile_dir(user.token.raw()).ok(),
    };
    let started = Instant::now();
    let session = conpty::spawn(&SpawnOptions {
        application: shell.application(),
        arguments: shell.arguments().into(),
        cwd,
        size: INITIAL,
        run_as,
        use_std_handles: opts.use_std_handles,
        inherit_environment: opts.inherit_environment,
        release_after_spawn,
        start_reader_paused,
    })?;
    logln!("spawned {} in {}: shell {}", shell.name(), fmt_ms(started.elapsed()), session.identity());
    match session.conhost_pid {
        Some(pid) => logln!("conhost: {}", token::pid_identity(pid)),
        None => logln!("conhost: not found among this process's children"),
    }
    Ok(session)
}

fn wait_prompt(session: &PtySession, from: usize) -> bool {
    session
        .output()
        .wait_for(from, PROMPT_TIMEOUT, |text| text.trim_end().ends_with('>').then_some(()))
        .is_some()
}

fn require_prompt(session: &PtySession) -> Result<()> {
    let ok = wait_prompt(session, 0);
    logln!("first output (raw): {}", win::escape_bytes(&session.output().raw_from(0), 240));
    if !ok {
        bail!(
            "no prompt within {PROMPT_TIMEOUT:?}; shell exit code {}; screen text so far: {:?}",
            session.exit_code().map_or_else(|| "none (still running)".to_string(), |c| format!("{c:#x}")),
            tail(&session.output().text_from(0), 400)
        );
    }
    Ok(())
}

/// Types `command` and returns the screen text between the two markers it prints.
fn run_marked(session: &PtySession, command: &str, begin: &str, end: &str) -> Result<String> {
    let offset = session.output().len();
    session.write(command.as_bytes())?;
    session
        .output()
        .wait_for(offset, COMMAND_TIMEOUT, |text| between(text, begin, end))
        .with_context(|| {
            format!(
                "no {begin}..{end} within {COMMAND_TIMEOUT:?}; text since command: {:?}",
                tail(&session.output().text_from(offset), 400)
            )
        })
}

/// Spawn, `whoami`, resize, `exit`, close.
pub fn basic(shell: Shell, run_as: RunAs<'_>, expected_account: &str, opts: Options) -> Outcome {
    let name = format!("basic/{}/{}", shell.name(), run_as.label());
    run_scenario(name, || {
        let session = spawn_shell(shell, run_as, opts, false, false)?;
        require_prompt(&session)?;
        let mut ok = true;

        let printed = run_marked(&session, shell.whoami(), "RRMM-WHO-BEGIN", "RRMM-WHO-END")?;
        let who = printed.lines().map(str::trim).find(|l| l.contains('\\')).unwrap_or_default();
        let who_ok = who.eq_ignore_ascii_case(expected_account);
        logln!("whoami: {who:?}, expected {expected_account:?}: {}", pass_fail(who_ok));
        if !who_ok {
            logln!("whoami: text between markers was {printed:?}");
        }
        ok &= who_ok;

        session.resize(RESIZED)?;
        let size = run_marked(&session, shell.size_query(), "RRMM-SIZE-BEGIN", "RRMM-SIZE-END")?;
        let cols = number_after(&size, "Columns:");
        let rows = number_after(&size, "Lines:");
        let size_ok =
            cols == Some(RESIZED.cols.unsigned_abs().into()) && rows == Some(RESIZED.rows.unsigned_abs().into());
        logln!(
            "after ResizePseudoConsole({}x{}): shell reports cols={cols:?} rows={rows:?}: {}",
            RESIZED.cols,
            RESIZED.rows,
            pass_fail(size_ok)
        );
        ok &= size_ok;

        let typed = Instant::now();
        session.write(b"exit\r")?;
        let code = session.wait_exit(EXIT_TIMEOUT);
        logln!("typed `exit`: exit code {code:?} after {}", fmt_ms(typed.elapsed()));
        ok &= code.is_some();

        let report = session.close();
        report.log();
        Ok(ok && report.clean())
    })
}

/// Ctrl+C reaches the foreground program; a forced close takes down the whole process tree.
pub fn interrupt_and_kill(opts: Options) -> Outcome {
    run_scenario("ctrl-c+forced-close/cmd/caller-token".into(), || {
        let (ctrl_c_ok, kill_ok) = ctrl_c_then_kill(opts)?;
        Ok(ctrl_c_ok && kill_ok)
    })
}

/// Informational: does Ctrl+C work with whatever "ignore Ctrl+C" flag our launcher (the SCM in
/// service mode) handed us? Must run before `reset_ctrl_c_inheritance`.
pub fn observe_inherited_ctrl_c(opts: Options) -> Outcome {
    let name = "observe/ctrl-c-with-launcher-inherited-flag";
    logln!("=== {name}");
    match ctrl_c_then_kill(opts) {
        Ok((ctrl_c_ok, _)) => logln!(
            "=== {name}: INFO - Ctrl+C {} before SetConsoleCtrlHandler(NULL, FALSE)",
            if ctrl_c_ok { "worked" } else { "was IGNORED" }
        ),
        Err(e) => logln!("=== {name}: INFO - error: {e:#}"),
    }
    Outcome { name: name.into(), verdict: Verdict::Info }
}

fn ctrl_c_then_kill(opts: Options) -> Result<(bool, bool)> {
    let session = spawn_shell(Shell::Cmd, RunAs::Caller, opts, false, false)?;
    require_prompt(&session)?;

    session.write(b"ping -n 600 127.0.0.1\r")?;
    if !wait_until(COMMAND_TIMEOUT, || session.job().active_processes().unwrap_or(0) >= 2) {
        bail!("ping did not start (job never had 2 processes)");
    }
    thread::sleep(Duration::from_millis(1500));
    let before = session.job().active_processes()?;
    // ConPTY turns the 0x03 byte into CTRL_C_EVENT for the attached clients.
    session.write(b"\x03")?;
    let stopped = wait_until(Duration::from_secs(8), || {
        session.job().active_processes().unwrap_or(0) == 1
    });
    let after = session.job().active_processes()?;
    let prompt_back = stopped
        && session
            .output()
            .wait_for(0, Duration::from_secs(2), |t| t.trim_end().ends_with('>').then_some(()))
            .is_some();
    let ctrl_c_ok = before >= 2 && after == 1 && prompt_back;
    logln!(
        "ctrl-c: job processes {before} -> {after}, prompt back {prompt_back}: {}",
        pass_fail(ctrl_c_ok)
    );

    if after < 2 {
        session.write(b"ping -n 600 127.0.0.1\r")?;
        if !wait_until(COMMAND_TIMEOUT, || session.job().active_processes().unwrap_or(0) >= 2) {
            bail!("second ping did not start");
        }
    }
    logln!("forced close with a grandchild running (ping under cmd)");
    let report = session.close();
    report.log();
    let kill_ok = report.clean()
        && report.terminated_job
        && report.job_active_after == Some(0)
        && report.total < Duration::from_secs(5);
    logln!("forced close: {}", pass_fail(kill_ok));
    Ok((ctrl_c_ok, kill_ok))
}

/// On 26100+, ReleasePseudoConsole lets conhost exit with its last client, so the reader sees
/// EOF on its own when the shell exits: no separate exit watcher needed to unblock the reader.
pub fn release_eof(opts: Options) -> Outcome {
    let name = "release-eof/cmd/caller-token";
    if conpty::release_pseudoconsole_fn().is_none() {
        return Outcome::skipped(name, "ReleasePseudoConsole not exported; needs build 26100+");
    }
    run_scenario(name.into(), || {
        let session = spawn_shell(Shell::Cmd, RunAs::Caller, opts, true, false)?;
        let released = session.released;
        logln!("ReleasePseudoConsole called right after spawn: {released}");
        require_prompt(&session)?;
        let typed = Instant::now();
        session.write(b"exit\r")?;
        let eof = session.output().wait_eof(EXIT_TIMEOUT);
        match &eof {
            Some((reason, at)) => logln!(
                "reader EOF {} after `exit`, with no ClosePseudoConsole call: {reason}",
                fmt_ms(at.saturating_duration_since(typed))
            ),
            None => logln!("no reader EOF within {EXIT_TIMEOUT:?} after `exit`"),
        }
        let report = session.close();
        report.log();
        Ok(released && eof.is_some() && report.clean())
    })
}

/// Observation: ClosePseudoConsole on a live shell, reader draining, no job kill. Does conhost
/// end the client by itself, or is the job what really guarantees teardown?
pub fn close_with_live_shell(shell: Shell, opts: Options) -> Outcome {
    run_scenario(format!("observe/close-pseudoconsole-live-shell/{}", shell.name()), || {
        let mut session = spawn_shell(shell, RunAs::Caller, opts, false, false)?;
        require_prompt(&session)?;
        let called = Instant::now();
        let closing = session.close_pseudoconsole_async().context("pseudoconsole already closed")?;
        let took = closing.recv_timeout(Duration::from_secs(10)).ok();
        logln!(
            "ClosePseudoConsole with the shell still at its prompt: {}",
            took.map_or_else(|| "TIMED OUT".to_string(), |d| format!("returned in {}", fmt_ms(d)))
        );
        let exited = session.wait_exit(Duration::from_secs(10));
        logln!(
            "shell exit code {} at +{} (no job kill yet); reader EOF: {:?}",
            exited.map_or_else(|| "none (still running)".to_string(), |c| format!("{c:#x}")),
            fmt_ms(called.elapsed()),
            session.output().wait_eof(Duration::from_secs(5)).map(|(reason, _)| reason)
        );
        let report = session.close();
        report.log();
        Ok(took.is_some() && report.clean())
    })
}

/// Reproduces the documented hang: ClosePseudoConsole while nobody drains the output pipe.
/// `kill_first`: terminate the shell before closing (our real shutdown order) or leave it
/// running (does ClosePseudoConsole still return, and does conhost take the client down?).
pub fn close_without_drain(opts: Options, kill_first: bool) -> Outcome {
    let variant = if kill_first { "shell-killed-first" } else { "shell-still-running" };
    run_scenario(format!("pitfall/close-without-drain/{variant}"), || {
        let mut session = spawn_shell(Shell::Cmd, RunAs::Caller, opts, false, true)?;
        session.write(
            b"for /L %i in (1,1,3000) do @echo filler line %i ..................................................\r",
        )?;
        thread::sleep(Duration::from_secs(2));
        logln!("reader paused; output pipe holds {:?} unread bytes", session.pending_output_bytes());
        if kill_first {
            session.job().terminate(1)?;
            thread::sleep(Duration::from_millis(300));
        }
        logln!("job processes before ClosePseudoConsole: {}", session.job().active_processes()?);

        let called = Instant::now();
        let closing = session.close_pseudoconsole_async().context("pseudoconsole already closed")?;
        let mut returned = match closing.recv_timeout(Duration::from_secs(3)) {
            Ok(took) => {
                logln!(
                    "ClosePseudoConsole returned in {} although nobody drained the pipe",
                    fmt_ms(took)
                );
                true
            }
            Err(_) => {
                logln!("ClosePseudoConsole still blocked after 3 s (the documented hang)");
                false
            }
        };
        if !kill_first {
            let exited = session.wait_exit(Duration::from_secs(3));
            logln!(
                "still undrained: shell exit code {exited:?} 3 s after ClosePseudoConsole, job processes {}",
                session.job().active_processes()?
            );
        }
        session.open_gate();
        if !returned {
            returned = closing.recv_timeout(Duration::from_secs(10)).is_ok();
        }
        logln!(
            "reader resumed: ClosePseudoConsole {} ({} since the call)",
            if returned { "has returned" } else { "STILL BLOCKED" },
            fmt_ms(called.elapsed())
        );
        let report = session.close();
        report.log();
        Ok(returned && report.clean())
    })
}

pub fn log_environment(mode: &str) {
    logln!("################ conpty-service-spike: {mode} ################");
    logln!(
        "exe: {}",
        std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default()
    );
    logln!(
        "process: pid {}, account {}, session {}",
        std::process::id(),
        token::current_account().unwrap_or_else(|e| format!("<{e:#}>")),
        token::current_session_id()
    );
    logln!("windows build: {}", win::windows_build());
    logln!(
        "ReleasePseudoConsole export: {}",
        if conpty::release_pseudoconsole_fn().is_some() { "present" } else { "absent" }
    );
    logln!("active console session: {:#x}", token::console_session_id());
    match token::sessions() {
        Ok(list) => {
            for s in list {
                logln!("WTS session {}: {}, station {:?}, user {:?}", s.id, s.state_name(), s.station, s.user);
            }
        }
        Err(e) => logln!("sessions: {e:#}"),
    }
}

pub fn summarize(outcomes: &[Outcome]) -> bool {
    logln!("---------------- summary ----------------");
    for o in outcomes {
        logln!("{} {}", o.verdict.label(), o.name);
    }
    let failed = outcomes.iter().filter(|o| o.verdict == Verdict::Fail).count();
    logln!(
        "RESULT: {} ({} scenarios, {failed} failed)",
        if failed == 0 { "PASS" } else { "FAIL" },
        outcomes.len()
    );
    failed == 0
}

pub fn console_main(args: &[String]) -> Result<bool> {
    let mut shells = vec![Shell::Cmd, Shell::PowerShell];
    let mut self_token = true;
    let mut pitfalls = true;
    let mut reset_ctrl_c = true;
    let mut service_dry_run = false;
    let mut opts = Options::default();
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--shell" => {
                shells = match args.next().map(String::as_str) {
                    Some("cmd") => vec![Shell::Cmd],
                    Some("powershell") => vec![Shell::PowerShell],
                    Some("all") => vec![Shell::Cmd, Shell::PowerShell],
                    other => bail!("--shell expects cmd|powershell|all, got {other:?}"),
                }
            }
            "--skip-self-token" => self_token = false,
            "--skip-pitfalls" => pitfalls = false,
            "--no-usestdhandles" => opts.use_std_handles = false,
            "--inherit-env" => opts.inherit_environment = true,
            "--inherit-ctrl-c-state" => reset_ctrl_c = false,
            "--service-dry-run" => service_dry_run = true,
            other => bail!("unknown console option {other:?}"),
        }
    }

    log_environment(if service_dry_run { "console, service dry run" } else { "console" });
    if service_dry_run {
        // The service's exact sequence and stop-time teardown, minus the SCM. Unelevated, the
        // interactive-user scenarios skip (WTSQueryUserToken needs SeTcbPrivilege).
        let mut outcomes = vec![observe_inherited_ctrl_c(opts)];
        if reset_ctrl_c {
            reset_ctrl_c_inheritance();
        }
        outcomes.extend(service_scenarios(opts, &|| false));
        match start_held_session(opts) {
            Ok(session) => {
                thread::sleep(Duration::from_secs(2));
                outcomes.push(stop_held_session(session));
            }
            Err(e) => {
                logln!("held session failed: {e:#}");
                outcomes.push(Outcome::failed("service-stop/held-session-teardown"));
            }
        }
        return Ok(summarize(&outcomes));
    }
    if reset_ctrl_c {
        reset_ctrl_c_inheritance();
    }
    let me = token::current_account()?;
    let mut outcomes = Vec::new();
    for &shell in &shells {
        outcomes.push(basic(shell, RunAs::Caller, &me, opts));
    }
    outcomes.push(interrupt_and_kill(opts));
    outcomes.push(release_eof(opts));
    for &shell in &shells {
        outcomes.push(close_with_live_shell(shell, opts));
    }
    if self_token {
        match token::own_token_duplicate() {
            Ok(user) => {
                user.log();
                outcomes.push(basic(Shell::Cmd, RunAs::Token(&user), &user.account, opts));
            }
            Err(e) => {
                logln!("own token duplicate failed: {e:#}");
                outcomes.push(Outcome::failed("basic/cmd/user-token(self)"));
            }
        }
    }
    if pitfalls {
        outcomes.push(close_without_drain(opts, true));
        outcomes.push(close_without_drain(opts, false));
    }
    Ok(summarize(&outcomes))
}

/// Everything the service runs before it parks with a live session (see `start_held_session`).
pub fn service_scenarios(opts: Options, stop_requested: &dyn Fn() -> bool) -> Vec<Outcome> {
    let me = token::current_account().unwrap_or_default();
    let mut outcomes = Vec::new();
    for shell in [Shell::Cmd, Shell::PowerShell] {
        if stop_requested() {
            return outcomes;
        }
        outcomes.push(basic(shell, RunAs::Caller, &me, opts));
    }
    if stop_requested() {
        return outcomes;
    }
    outcomes.push(interrupt_and_kill(opts));
    if stop_requested() {
        return outcomes;
    }
    outcomes.push(release_eof(opts));
    if stop_requested() {
        return outcomes;
    }
    outcomes.push(close_with_live_shell(Shell::Cmd, opts));
    if stop_requested() {
        return outcomes;
    }
    match token::interactive_user_token() {
        Ok(user) => {
            user.log();
            for shell in [Shell::Cmd, Shell::PowerShell] {
                if stop_requested() {
                    break;
                }
                outcomes.push(basic(shell, RunAs::Token(&user), &user.account, opts));
            }
        }
        Err(e) => outcomes.push(Outcome::skipped("basic/*/interactive-user-token", &format!("{e:#}"))),
    }
    outcomes
}

/// A SYSTEM PowerShell kept busy (`ping -t`) until the service is told to stop.
pub fn start_held_session(opts: Options) -> Result<PtySession> {
    logln!("=== held session: SYSTEM PowerShell running `ping -t` until service stop");
    let session = spawn_shell(Shell::PowerShell, RunAs::Caller, opts, false, false)?;
    require_prompt(&session)?;
    session.write(b"ping -t 127.0.0.1\r")?;
    if !wait_until(COMMAND_TIMEOUT, || session.job().active_processes().unwrap_or(0) >= 2) {
        bail!("ping -t did not start");
    }
    logln!("held session live: job processes {}", session.job().active_processes()?);
    Ok(session)
}

pub fn stop_held_session(session: PtySession) -> Outcome {
    run_scenario("service-stop/held-session-teardown".into(), || {
        let report = session.close();
        report.log();
        Ok(report.clean()
            && report.terminated_job
            && report.job_active_after == Some(0)
            && report.total < Duration::from_secs(10))
    })
}
