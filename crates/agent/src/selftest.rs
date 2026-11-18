//! `rustrmm-agent selftest`: exercises the remote tools, the pseudo-terminal and the script runner
//! locally, without a server, so support staff (and CI) can check a platform quickly.

use std::time::{Duration, Instant};

use anyhow::{Result, bail};
use rustrmm_proto::commands::Command;
use rustrmm_proto::remote::DiagnosticKind;

pub async fn run() -> Result<()> {
    let mut failures = 0usize;
    let checks: Vec<(&str, Command)> = vec![
        ("processes", Command::ListProcesses),
        ("services", Command::ListServices),
        (
            "files",
            Command::ListDir {
                path: String::new(),
            },
        ),
        (
            "event log",
            Command::EventLog {
                log: String::new(),
                max_level: 3,
                limit: 5,
                hours: 24,
            },
        ),
        (
            "dns",
            Command::Diagnostic {
                kind: DiagnosticKind::Dns,
                target: "localhost".into(),
                port: None,
            },
        ),
    ];
    for (name, command) in checks {
        let started = Instant::now();
        match crate::remote::execute(command).await {
            Ok(value) => {
                let size = value
                    .get("items")
                    .or_else(|| value.get("entries"))
                    .and_then(|v| v.as_array())
                    .map(|a| format!("{} items", a.len()))
                    .unwrap_or_else(|| "ok".into());
                println!(
                    "PASS  {name:<10} {size} ({} ms)",
                    started.elapsed().as_millis()
                );
            }
            Err(e) => {
                failures += 1;
                println!("FAIL  {name:<10} {e:#}");
            }
        }
    }
    match shell().await {
        Ok(ms) => println!(
            "PASS  {:<10} prompt echoed a marker and exited ({ms} ms)",
            "shell"
        ),
        Err(e) => {
            failures += 1;
            println!("FAIL  {:<10} {e:#}", "shell");
        }
    }
    match crate::scripts::selftest().await {
        Ok(summary) => println!("PASS  {:<10} {summary}", "script"),
        Err(e) => {
            failures += 1;
            println!("FAIL  {:<10} {e:#}", "script");
        }
    }
    match crate::desktop::selftest().await {
        Ok(crate::desktop::SelftestOutcome::Pass(summary)) => {
            println!("PASS  {:<10} {summary}", "desktop")
        }
        Ok(crate::desktop::SelftestOutcome::Skip(reason)) => {
            println!("SKIP  {:<10} {reason}", "desktop")
        }
        Err(e) => {
            failures += 1;
            println!("FAIL  {:<10} {e:#}", "desktop");
        }
    }
    match crate::support::selftest().await {
        Ok(summary) => println!("PASS  {:<10} {summary}", "support"),
        Err(e) => {
            failures += 1;
            println!("FAIL  {:<10} {e:#}", "support");
        }
    }
    match crate::checks::selftest().await {
        Ok(summary) => println!("PASS  {:<10} {summary}", "checks"),
        Err(e) => {
            failures += 1;
            println!("FAIL  {:<10} {e:#}", "checks");
        }
    }
    match crate::escrow::selftest() {
        Ok(summary) => println!("PASS  {:<10} {summary}", "escrow"),
        Err(e) => {
            failures += 1;
            println!("FAIL  {:<10} {e:#}", "escrow");
        }
    }
    match crate::network::selftest().await {
        Ok(summary) => println!("PASS  {:<10} {summary}", "network"),
        Err(e) => {
            failures += 1;
            println!("FAIL  {:<10} {e:#}", "network");
        }
    }
    // Report-only scan: never installs anything (Windows: a real WUA search, up to 5 minutes).
    match crate::patching::selftest().await {
        Ok(summary) => println!("PASS  {:<10} {summary}", "patching"),
        Err(e) => {
            failures += 1;
            println!("FAIL  {:<10} {e:#}", "patching");
        }
    }
    if failures > 0 {
        bail!("{failures} self-test check(s) failed");
    }
    Ok(())
}

/// Spawns the default shell in a PTY, echoes a marker, resizes, and waits for a clean exit.
async fn shell() -> Result<u128> {
    let started = Instant::now();
    let (program, args) = crate::pty::resolve_shell("")?;
    let (pty, mut output, exit) = tokio::task::spawn_blocking(move || {
        crate::pty::PtySession::spawn(&program, &args, 100, 30)
    })
    .await??;
    let marker = "rustrmm-selftest-ok";
    pty.resize(120, 40)?;
    pty.write(format!("echo {marker}\r").into_bytes());
    let mut seen = String::new();
    let found = tokio::time::timeout(Duration::from_secs(20), async {
        while let Some(chunk) = output.recv().await {
            seen.push_str(&String::from_utf8_lossy(&chunk));
            // The marker appears once as typed input and once as output.
            if seen.matches(marker).count() >= 2 {
                return true;
            }
        }
        false
    })
    .await
    .unwrap_or(false);
    pty.write(b"exit\r".to_vec());
    let code = tokio::time::timeout(Duration::from_secs(10), exit).await;
    tokio::task::spawn_blocking(move || pty.close()).await.ok();
    if !found {
        bail!("marker not seen in shell output");
    }
    match code {
        Ok(Ok(0)) => Ok(started.elapsed().as_millis()),
        Ok(Ok(c)) => bail!("shell exited with code {c}"),
        _ => bail!("shell did not exit"),
    }
}
