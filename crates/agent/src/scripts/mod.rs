//! Executor for signed `run_script` commands.
//!
//! 1. The content hash is verified before anything touches the disk.
//! 2. The script is written to `<data dir>/scripts/<cmd_id>/` (the data directory is restricted
//!    to SYSTEM/Administrators or root) and the directory is deleted afterwards.
//! 3. The interpreter is resolved by absolute path, never through `PATH`.
//! 4. The child gets a fresh, minimal environment: platform defaults, `RUSTRMM_DEVICE_ID`,
//!    `RUSTRMM_JOB=1`, then the server's variables and parameters.
//! 5. The process tree runs in a kill-on-close job object (Windows) or its own process group
//!    (Unix). On timeout, and once the script itself has exited, the whole tree is killed.
//! 6. stdout and stderr are capped, decoded as UTF-8 and every secret is masked.

#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use rustrmm_proto::commands::RunScript;
use rustrmm_proto::scripts::{self as rules, MASK};
use serde_json::{Value, json};

use crate::paths::Paths;

#[cfg(unix)]
use self::unix as platform;
#[cfg(windows)]
use self::windows as platform;

/// Scripts running at the same time on one device; later ones wait for a slot.
const MAX_CONCURRENT: usize = 4;
/// How long to wait for the output pipes to drain after the tree was killed.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(5);
/// Upper bounds the agent enforces whatever the server asks for.
const MAX_TIMEOUT_SECS: u32 = 86_400;
const MAX_OUTPUT_BYTES: u32 = 8 * 1024 * 1024;
const MIN_OUTPUT_BYTES: u32 = 1024;

static SLOTS: LazyLock<tokio::sync::Semaphore> =
    LazyLock::new(|| tokio::sync::Semaphore::new(MAX_CONCURRENT));

/// How a `run_script` command ended, mapped onto a command result by the caller.
#[derive(Debug)]
pub enum Outcome {
    /// The script ran (whatever its exit code): `data` is the result document.
    Ran(Value),
    /// Refused before running (hash mismatch, unknown language).
    Rejected(String),
    /// Could not be started (missing interpreter, I/O error).
    Failed(String),
}

/// Verifies and runs a script; never panics on bad input.
pub async fn run(paths: &Paths, device_id: &str, cmd_id: &str, script: RunScript) -> Outcome {
    if let Err(reason) = verify(&script) {
        return Outcome::Rejected(reason);
    }
    let Ok(_slot) = SLOTS.acquire().await else {
        return Outcome::Failed("script executor is shutting down".into());
    };
    let job = Job {
        dir: work_dir(paths, cmd_id),
        device_id: device_id.to_string(),
        script,
    };
    match tokio::task::spawn_blocking(move || job.execute()).await {
        Ok(Ok(data)) => Outcome::Ran(data),
        Ok(Err(e)) => Outcome::Failed(format!("{e:#}")),
        Err(e) => Outcome::Failed(format!("script task failed: {e}")),
    }
}

/// Checks the language and that the content matches the hash the server signed.
fn verify(script: &RunScript) -> Result<(), String> {
    if !rules::known_language(&script.language) {
        return Err(format!("unsupported script language {}", script.language));
    }
    let actual = rules::sha256_hex(&script.content);
    if !actual.eq_ignore_ascii_case(script.content_sha256.trim()) {
        return Err("script content does not match its SHA-256; refusing to run it".into());
    }
    Ok(())
}

/// Removes script and installer directories left behind by a crash (called once at start-up).
pub fn cleanup_stale(paths: &Paths) {
    for area in ["scripts", "software"] {
        let root = paths.data_dir.join(area);
        if let Ok(entries) = std::fs::read_dir(&root) {
            for entry in entries.flatten() {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
}

fn work_dir(paths: &Paths, cmd_id: &str) -> PathBuf {
    work_dir_in(paths, "scripts", cmd_id)
}

/// `<data dir>/<area>/<sanitised cmd_id>` (installers use the `software` area).
pub(crate) fn work_dir_in(paths: &Paths, area: &str, cmd_id: &str) -> PathBuf {
    let safe: String = cmd_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(64)
        .collect();
    let name = if safe.is_empty() {
        format!("run-{}", hex::encode(rustrmm_crypto::random::bytes::<8>()))
    } else {
        safe
    };
    paths.data_dir.join(area).join(name)
}

struct Job {
    dir: PathBuf,
    device_id: String,
    script: RunScript,
}

impl Job {
    fn execute(self) -> Result<Value> {
        prepare_dir(&self.dir)?;
        let result = self.execute_in_dir();
        remove_dir(&self.dir);
        result
    }

    fn execute_in_dir(&self) -> Result<Value> {
        let script = &self.script;
        let extension = rules::file_extension(&script.language).context("unknown language")?;
        let file = self.dir.join(format!("script.{extension}"));
        write_script(&file, &script.language, &script.content)?;
        let (program, args) = interpreter(&script.language, &file)?;
        if !program.is_file() {
            bail!(
                "{} is not installed on this device ({} not found)",
                script.language,
                program.display()
            );
        }

        let mut cmd = Command::new(&program);
        cmd.args(&args)
            .current_dir(&self.dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env_clear()
            .envs(self.environment(&program));
        let timeout =
            Duration::from_secs(u64::from(script.timeout_secs.clamp(1, MAX_TIMEOUT_SECS)));
        let cap = script
            .max_output_bytes
            .clamp(MIN_OUTPUT_BYTES, MAX_OUTPUT_BYTES) as usize;

        let started = Instant::now();
        let mut child = platform::spawn(&mut cmd)
            .with_context(|| format!("cannot start {}", program.display()))?;
        let stdout = Capture::start(child.take_stdout(), cap);
        let stderr = Capture::start(child.take_stderr(), cap);

        let mut timed_out = false;
        let exit_code = loop {
            match child.try_wait()? {
                Some(code) => break code,
                None if started.elapsed() >= timeout => {
                    timed_out = true;
                    child.kill_tree(true);
                    break child.wait();
                }
                None => std::thread::sleep(Duration::from_millis(50)),
            }
        };
        let duration_ms = started.elapsed().as_millis() as u64;
        // Background processes the script left behind are killed so they cannot hold the
        // output pipes open or outlive the job.
        child.kill_tree(false);

        let (out, out_truncated) = stdout.finish(DRAIN_TIMEOUT);
        let (err, err_truncated) = stderr.finish(DRAIN_TIMEOUT);
        let stdout = clean(&out, &script.mask, out_truncated);
        let stderr = clean(&err, &script.mask, err_truncated);
        Ok(json!({
            "exit_code": exit_code,
            "stdout": stdout,
            "stderr": stderr,
            "duration_ms": duration_ms,
            "timed_out": timed_out,
            "truncated": out_truncated || err_truncated,
        }))
    }

    /// Platform defaults, then the RustRMM markers, then the server's variables and parameters.
    /// Nothing from the agent's own environment is passed through.
    fn environment(&self, program: &Path) -> Vec<(OsString, OsString)> {
        let mut env = platform::default_environment(&self.dir, program);
        if self.script.language == "python" {
            env.push(("PYTHONIOENCODING".into(), "utf-8".into()));
            env.push(("PYTHONUTF8".into(), "1".into()));
            env.push(("PYTHONDONTWRITEBYTECODE".into(), "1".into()));
        }
        env.push(("RUSTRMM_DEVICE_ID".into(), self.device_id.clone().into()));
        env.push(("RUSTRMM_JOB".into(), "1".into()));
        for (name, value) in &self.script.env {
            // The server validates names too; a reserved or malformed name is dropped here.
            if rules::valid_env_name(name)
                && !rules::is_reserved_env_name(name)
                && !value.contains('\0')
            {
                env.push((name.into(), value.into()));
            }
        }
        env
    }
}

/// Creates the per-command directory under the restricted data directory.
pub(crate) fn prepare_dir(dir: &Path) -> Result<()> {
    let root = dir.parent().context("script directory has no parent")?;
    std::fs::create_dir_all(root).with_context(|| format!("creating {}", root.display()))?;
    platform::restrict_dir(root);
    if dir.exists() {
        std::fs::remove_dir_all(dir).with_context(|| format!("clearing {}", dir.display()))?;
    }
    std::fs::create_dir(dir).with_context(|| format!("creating {}", dir.display()))?;
    platform::restrict_dir(dir);
    Ok(())
}

pub(crate) fn remove_dir(dir: &Path) {
    // Just-killed processes can keep a file locked for a moment on Windows.
    for attempt in 0..10 {
        match std::fs::remove_dir_all(dir) {
            Ok(()) => return,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            Err(e) if attempt == 9 => {
                tracing::warn!(dir = %dir.display(), error = %e, "could not remove script directory");
            }
            Err(_) => std::thread::sleep(Duration::from_millis(200)),
        }
    }
}

/// Writes the script exactly as verified, apart from line endings and the PowerShell BOM:
/// Windows PowerShell 5.1 reads BOM-less files in the ANSI code page, cmd wants CRLF and Unix
/// interpreters choke on CR.
fn write_script(path: &Path, language: &str, content: &str) -> Result<()> {
    let mut bytes = Vec::with_capacity(content.len() + 8);
    match language {
        "powershell" | "pwsh" => {
            bytes.extend_from_slice(b"\xEF\xBB\xBF");
            bytes.extend_from_slice(content.as_bytes());
        }
        "cmd" => bytes.extend_from_slice(
            content
                .replace("\r\n", "\n")
                .replace('\n', "\r\n")
                .as_bytes(),
        ),
        _ => bytes.extend_from_slice(content.replace("\r\n", "\n").as_bytes()),
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("creating {}", path.display()))?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    Ok(())
}

/// Absolute interpreter path and arguments for a language.
fn interpreter(language: &str, file: &Path) -> Result<(PathBuf, Vec<OsString>)> {
    let file = file.as_os_str().to_owned();
    #[cfg(windows)]
    {
        let system = crate::util::system_tool("cmd.exe")
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows\System32"));
        let windows_dir = system
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        let ps_args = |file: OsString| -> Vec<OsString> {
            let mut args: Vec<OsString> = [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ]
            .iter()
            .map(OsString::from)
            .collect();
            args.push(file);
            args
        };
        match language {
            "powershell" => Ok((
                system.join(r"WindowsPowerShell\v1.0\powershell.exe"),
                ps_args(file),
            )),
            "pwsh" => Ok((
                PathBuf::from(r"C:\Program Files\PowerShell\7\pwsh.exe"),
                ps_args(file),
            )),
            "cmd" => Ok((system.join("cmd.exe"), vec!["/d".into(), "/c".into(), file])),
            "python" => Ok((windows_dir.join("py.exe"), vec!["-3".into(), file])),
            other => bail!("{other} scripts cannot run on Windows"),
        }
    }
    #[cfg(unix)]
    {
        let find = |candidates: &[&str]| -> PathBuf {
            candidates
                .iter()
                .map(PathBuf::from)
                .find(|p| p.is_file())
                .unwrap_or_else(|| PathBuf::from(candidates[0]))
        };
        match language {
            "bash" => Ok((find(&["/bin/bash", "/usr/bin/bash"]), vec![file])),
            "sh" => Ok((find(&["/bin/sh", "/usr/bin/sh"]), vec![file])),
            "zsh" => Ok((find(&["/bin/zsh", "/usr/bin/zsh"]), vec![file])),
            "python" => Ok((
                find(&["/usr/bin/python3", "/usr/local/bin/python3"]),
                vec![file],
            )),
            other => bail!("{other} scripts cannot run on this operating system"),
        }
    }
}

/// UTF-8 with replacement characters, CRLF → LF, secrets masked.
fn clean(bytes: &[u8], masks: &[String], truncated: bool) -> String {
    let text = String::from_utf8_lossy(bytes).replace("\r\n", "\n");
    rules::mask_output(&text, masks, truncated)
}

/// One output stream read on its own thread, keeping the first `cap` bytes and draining (and
/// discarding) the rest so the child never blocks on a full pipe.
struct Capture {
    shared: Arc<Mutex<(Vec<u8>, bool)>>,
    done: Option<std::sync::mpsc::Receiver<()>>,
}

impl Capture {
    fn start(stream: Option<Box<dyn Read + Send>>, cap: usize) -> Self {
        let shared = Arc::new(Mutex::new((Vec::new(), false)));
        let Some(mut stream) = stream else {
            return Self { shared, done: None };
        };
        let (tx, rx) = std::sync::mpsc::channel();
        let sink = Arc::clone(&shared);
        let spawned = std::thread::Builder::new()
            .name("script-output".into())
            .spawn(move || {
                let mut buf = [0u8; 16 * 1024];
                loop {
                    match stream.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let Ok(mut guard) = sink.lock() else { break };
                            let room = cap.saturating_sub(guard.0.len());
                            if n > room {
                                guard.1 = true;
                            }
                            let keep = n.min(room);
                            guard.0.extend_from_slice(&buf[..keep]);
                        }
                    }
                }
                let _ = tx.send(());
            });
        Self {
            shared,
            done: spawned.ok().map(|_| rx),
        }
    }

    /// Waits (bounded) for EOF and returns what was captured and whether it was cut.
    fn finish(self, timeout: Duration) -> (Vec<u8>, bool) {
        if let Some(done) = &self.done
            && done.recv_timeout(timeout).is_err()
        {
            tracing::debug!("script output pipe still open after the tree was killed");
        }
        match self.shared.lock() {
            Ok(mut guard) => (std::mem::take(&mut guard.0), guard.1),
            Err(_) => (Vec::new(), true),
        }
    }
}

/// Outcome of [`run_program`].
#[derive(Debug, Clone)]
pub struct ProgramRun {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub duration_ms: u64,
}

/// Whether [`run_program`] waits for the program's descendants after it exits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wait {
    /// Done when the program itself exits; anything it left behind is killed.
    Program,
    /// Done when every process of the tree has exited (or the timeout expires). Installers and
    /// bootstrappers often hand off to `msiexec` or a child and exit early; killing the tree at
    /// that point would abort the install half-way.
    Tree,
}

/// Runs a program contained like a script (kill-on-close job object or its own process group)
/// with an explicit environment and a timeout that kills the whole tree. `raw_args` (Windows)
/// is appended verbatim, as installers like `msiexec` parse their own command line.
#[allow(clippy::too_many_arguments)]
pub fn run_program(
    program: &Path,
    args: &[OsString],
    raw_args: Option<&str>,
    dir: &Path,
    env: Vec<(OsString, OsString)>,
    timeout: Duration,
    cap: usize,
    wait: Wait,
) -> Result<ProgramRun> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear()
        .envs(env);
    #[cfg(windows)]
    if let Some(raw) = raw_args.filter(|r| !r.trim().is_empty()) {
        use std::os::windows::process::CommandExt;
        cmd.raw_arg(raw);
    }
    #[cfg(not(windows))]
    if let Some(raw) = raw_args.filter(|r| !r.trim().is_empty()) {
        cmd.args(rustrmm_proto::software::split_args(raw));
    }
    let started = Instant::now();
    let mut child =
        platform::spawn(&mut cmd).with_context(|| format!("cannot start {}", program.display()))?;
    let stdout = Capture::start(child.take_stdout(), cap);
    let stderr = Capture::start(child.take_stderr(), cap);
    let mut timed_out = false;
    let exit_code = loop {
        match child.try_wait()? {
            Some(code) => break code,
            None if started.elapsed() >= timeout => {
                timed_out = true;
                child.kill_tree(true);
                break child.wait();
            }
            None => std::thread::sleep(Duration::from_millis(100)),
        }
    };
    if wait == Wait::Tree && !timed_out {
        // The job (Windows) or process group (Unix) may still hold the real work.
        while child.active_processes().is_some_and(|n| n > 0) {
            if started.elapsed() >= timeout {
                timed_out = true;
                child.kill_tree(true);
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }
    let duration_ms = started.elapsed().as_millis() as u64;
    child.kill_tree(false);
    let (out, _) = stdout.finish(DRAIN_TIMEOUT);
    let (err, _) = stderr.finish(DRAIN_TIMEOUT);
    Ok(ProgramRun {
        exit_code,
        stdout: clean(&out, &[], false),
        stderr: clean(&err, &[], false),
        timed_out,
        duration_ms,
    })
}

/// The environment scripts get, for other contained programs (installers, package managers).
pub fn base_environment(dir: &Path, program: &Path) -> Vec<(OsString, OsString)> {
    platform::default_environment(dir, program)
}

/// A started child whose whole process tree can be killed.
pub trait Contained {
    fn take_stdout(&mut self) -> Option<Box<dyn Read + Send>>;
    fn take_stderr(&mut self) -> Option<Box<dyn Read + Send>>;
    /// `Some(exit code)` once the main process exited (`None` inside: killed by a signal).
    fn try_wait(&mut self) -> Result<Option<Option<i32>>>;
    fn wait(&mut self) -> Option<i32>;
    /// Kills every process in the tree; `graceful` first asks politely where the OS allows it.
    fn kill_tree(&mut self, graceful: bool);
    /// Processes still alive in the tree (job object / process group); `None` when unknown.
    fn active_processes(&self) -> Option<u32>;
}

/// `rustrmm-agent selftest` check: runs a tiny script in the platform's default language with
/// one variable and one secret, and verifies the output, masking, exit code and hash refusal.
pub async fn selftest() -> Result<String> {
    let dir = std::env::temp_dir().join(format!("rustrmm-selftest-{}", std::process::id()));
    let paths = Paths::resolve(Some(dir.clone()));
    let result = selftest_in(&paths).await;
    let _ = std::fs::remove_dir_all(&dir);
    result
}

async fn selftest_in(paths: &Paths) -> Result<String> {
    let (language, content) = if cfg!(windows) {
        (
            "powershell",
            "Write-Output \"greeting=$env:SELFTEST_GREETING\"\nWrite-Output \"secret=$env:SELFTEST_SECRET\"\nWrite-Output \"job=$env:RUSTRMM_JOB\"\nexit 3\n",
        )
    } else {
        let language = if Path::new("/bin/bash").is_file() || Path::new("/usr/bin/bash").is_file() {
            "bash"
        } else {
            "sh"
        };
        (
            language,
            "echo \"greeting=$SELFTEST_GREETING\"\necho \"secret=$SELFTEST_SECRET\"\necho \"job=$RUSTRMM_JOB\"\nexit 3\n",
        )
    };
    let greeting = format!(
        "hello-{}",
        hex::encode(rustrmm_crypto::random::bytes::<4>())
    );
    let secret = format!(
        "s3cret-{}",
        hex::encode(rustrmm_crypto::random::bytes::<6>())
    );
    let script = RunScript {
        language: language.into(),
        content: content.into(),
        content_sha256: rules::sha256_hex(content),
        env: vec![
            ("SELFTEST_GREETING".into(), greeting.clone()),
            ("SELFTEST_SECRET".into(), secret.clone()),
            // Reserved names are dropped by the agent even if a server sent them.
            ("PATH".into(), "/nonexistent".into()),
        ],
        mask: vec![secret.clone()],
        timeout_secs: 60,
        max_output_bytes: 64 * 1024,
    };

    let mut tampered = script.clone();
    tampered.content.push_str("echo injected\n");
    if !matches!(
        run(paths, "selftest", "selftest-tampered", tampered).await,
        Outcome::Rejected(_)
    ) {
        bail!("a script whose content does not match its hash was not refused");
    }

    let data = match run(paths, "selftest", "selftest-script", script).await {
        Outcome::Ran(data) => data,
        Outcome::Rejected(m) | Outcome::Failed(m) => bail!("{language} script did not run: {m}"),
    };
    let stdout = data["stdout"].as_str().unwrap_or_default();
    if !stdout.contains(&format!("greeting={greeting}")) {
        bail!(
            "variable not visible to the script; stdout: {stdout:?}, stderr: {:?}",
            data["stderr"]
        );
    }
    if stdout.contains(&secret) || !stdout.contains(&format!("secret={MASK}")) {
        bail!("secret was not masked; stdout: {stdout:?}");
    }
    if !stdout.contains("job=1") {
        bail!("RUSTRMM_JOB missing; stdout: {stdout:?}");
    }
    if data["exit_code"] != json!(3) {
        bail!("expected exit code 3, got {}", data["exit_code"]);
    }
    if paths
        .data_dir
        .join("scripts")
        .join("selftest-script")
        .exists()
    {
        bail!("script directory was not removed");
    }
    Ok(format!(
        "{language} ran with a variable, masked a secret, exit code 3, tampered copy refused ({} ms)",
        data["duration_ms"]
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Starts a child that outlives the program, like an installer bootstrapper handing off to
    /// `msiexec`, and checks that `Wait::Tree` lets it finish while `Wait::Program` kills it.
    #[test]
    fn tree_wait_keeps_handed_off_children_alive() {
        let dir = tempfile::tempdir().expect("tempdir");
        let marker = dir.path().join("marker.txt");
        let run = |wait: Wait, timeout: Duration| -> ProgramRun {
            let _ = std::fs::remove_file(&marker);
            #[cfg(windows)]
            let (program, args, raw) = (
                crate::util::system_tool("cmd.exe"),
                Vec::<OsString>::new(),
                Some(r#"/c start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & echo done>marker.txt""#),
            );
            #[cfg(not(windows))]
            let (program, args, raw) = (
                std::path::PathBuf::from("/bin/sh"),
                vec![
                    OsString::from("-c"),
                    OsString::from("(sleep 2; echo done > marker.txt) >/dev/null 2>&1 & exit 0"),
                ],
                None,
            );
            let env = base_environment(dir.path(), &program);
            run_program(&program, &args, raw, dir.path(), env, timeout, 4096, wait).expect("run")
        };

        let started = Instant::now();
        let waited = run(Wait::Tree, Duration::from_secs(30));
        assert!(!waited.timed_out);
        assert_eq!(waited.exit_code, Some(0));
        assert!(
            started.elapsed() >= Duration::from_millis(1500),
            "waited for the child"
        );
        assert!(marker.exists(), "the handed-off child finished its work");

        let quick = run(Wait::Program, Duration::from_secs(30));
        assert_eq!(quick.exit_code, Some(0));
        std::thread::sleep(Duration::from_secs(3));
        assert!(
            !marker.exists(),
            "without the tree wait the child is killed"
        );

        let cut = run(Wait::Tree, Duration::from_millis(800));
        assert!(cut.timed_out, "the timeout still bounds the tree wait");
        std::thread::sleep(Duration::from_secs(3));
        assert!(!marker.exists());
    }

    fn script(content: &str) -> RunScript {
        RunScript {
            language: if cfg!(windows) { "cmd" } else { "sh" }.into(),
            content: content.into(),
            content_sha256: rules::sha256_hex(content),
            env: vec![],
            mask: vec![],
            timeout_secs: 30,
            max_output_bytes: 1024,
        }
    }

    #[test]
    fn verification_refuses_tampering_and_unknown_languages() {
        assert!(verify(&script("echo ok")).is_ok());
        let mut bad = script("echo ok");
        bad.content_sha256 = rules::sha256_hex("echo other");
        assert!(verify(&bad).is_err());
        let mut upper = script("echo ok");
        upper.content_sha256 = upper.content_sha256.to_uppercase();
        assert!(verify(&upper).is_ok(), "hex case does not matter");
        let mut perl = script("print 1");
        perl.language = "perl".into();
        assert!(verify(&perl).is_err());
    }

    #[test]
    fn work_dirs_are_sanitised() {
        let paths = Paths::resolve(Some(PathBuf::from("/data")));
        let dir = work_dir(&paths, "../../etc/passwd");
        assert_eq!(dir.file_name().and_then(|n| n.to_str()), Some("etcpasswd"));
        assert!(dir.starts_with(paths.data_dir.join("scripts")));
    }

    #[test]
    fn output_is_cleaned_and_masked() {
        let out = clean(
            b"line\r\nkey=hunter22\r\n\xff",
            &["hunter22".to_string()],
            false,
        );
        assert_eq!(out, format!("line\nkey={MASK}\n\u{fffd}"));
    }

    #[tokio::test]
    async fn runs_scripts_with_caps_timeouts_and_exit_codes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = Paths::resolve(Some(dir.path().to_path_buf()));

        // Exit code and environment.
        let mut s = script(if cfg!(windows) {
            "@echo off\r\necho value=%MY_VALUE%\r\nexit /b 7\r\n"
        } else {
            "echo value=$MY_VALUE\nexit 7\n"
        });
        s.env = vec![("MY_VALUE".into(), "abc".into())];
        let Outcome::Ran(data) = run(&paths, "dev", "cmd-1", s).await else {
            panic!("script did not run");
        };
        assert_eq!(data["exit_code"], 7);
        assert!(
            data["stdout"]
                .as_str()
                .expect("stdout")
                .contains("value=abc")
        );
        assert_eq!(data["timed_out"], false);

        // Output cap.
        let s = script(if cfg!(windows) {
            "@echo off\r\nfor /l %%i in (1,1,400) do echo 0123456789\r\n"
        } else {
            "i=0; while [ $i -lt 400 ]; do echo 0123456789; i=$((i+1)); done\n"
        });
        let Outcome::Ran(data) = run(&paths, "dev", "cmd-2", s).await else {
            panic!("script did not run");
        };
        assert_eq!(data["truncated"], true);
        assert!(data["stdout"].as_str().expect("stdout").len() <= 1024);

        // Timeout kills the tree.
        let mut s = script(if cfg!(windows) {
            "@echo off\r\nping -n 30 127.0.0.1 > nul\r\n"
        } else {
            "sleep 30\n"
        });
        s.timeout_secs = 1;
        let started = Instant::now();
        let Outcome::Ran(data) = run(&paths, "dev", "cmd-3", s).await else {
            panic!("script did not run");
        };
        assert_eq!(data["timed_out"], true);
        assert!(started.elapsed() < Duration::from_secs(20));
        assert!(!dir.path().join("scripts").join("cmd-3").exists());
    }
}
