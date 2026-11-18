//! Network diagnostics run from the device: ping, traceroute, DNS lookup and TCP port test.

use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

use anyhow::{Result, bail};
use rustrmm_proto::remote::{DiagnosticKind, valid_target};
use serde_json::{Value, json};

use crate::util::{run_capture, system_tool};

pub fn run(kind: DiagnosticKind, target: &str, port: Option<u16>) -> Result<Value> {
    let target = target.trim();
    if !valid_target(target) {
        bail!("invalid host name or address");
    }
    match kind {
        DiagnosticKind::Ping => tool(ping_command(target), Duration::from_secs(30)),
        DiagnosticKind::Traceroute => tool(trace_command(target), Duration::from_secs(90)),
        DiagnosticKind::Dns => dns(target),
        DiagnosticKind::Port => {
            let Some(port) = port.filter(|p| *p != 0) else {
                bail!("a port number is required");
            };
            tcp(target, port)
        }
    }
}

fn ping_command(target: &str) -> (std::path::PathBuf, Vec<String>) {
    if cfg!(windows) {
        (
            system_tool("ping"),
            vec![
                "-n".into(),
                "4".into(),
                "-w".into(),
                "2000".into(),
                target.into(),
            ],
        )
    } else {
        (
            system_tool("ping"),
            vec![
                "-c".into(),
                "4".into(),
                "-W".into(),
                "2".into(),
                target.into(),
            ],
        )
    }
}

fn trace_command(target: &str) -> (std::path::PathBuf, Vec<String>) {
    if cfg!(windows) {
        (
            system_tool("tracert"),
            vec![
                "-d".into(),
                "-h".into(),
                "20".into(),
                "-w".into(),
                "1000".into(),
                target.into(),
            ],
        )
    } else {
        let traceroute = system_tool("traceroute");
        if traceroute.exists() {
            (
                traceroute,
                vec![
                    "-n".into(),
                    "-m".into(),
                    "20".into(),
                    "-w".into(),
                    "1".into(),
                    target.into(),
                ],
            )
        } else {
            (system_tool("tracepath"), vec!["-n".into(), target.into()])
        }
    }
}

fn tool((program, args): (std::path::PathBuf, Vec<String>), timeout: Duration) -> Result<Value> {
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let started = Instant::now();
    let out = run_capture(&program, &args, timeout)?;
    let mut output = out.stdout;
    if !out.stderr.trim().is_empty() {
        output.push_str(&out.stderr);
    }
    Ok(json!({
        "command": format!("{} {}", program.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default(), args.join(" ")),
        "exit_code": out.code,
        "timed_out": out.timed_out,
        "duration_ms": started.elapsed().as_millis() as u64,
        "output": output,
    }))
}

fn dns(target: &str) -> Result<Value> {
    let started = Instant::now();
    let addresses: Vec<String> = match (target, 0u16).to_socket_addrs() {
        Ok(addrs) => {
            let mut v: Vec<String> = addrs.map(|a| a.ip().to_string()).collect();
            v.sort();
            v.dedup();
            v
        }
        Err(e) => {
            return Ok(
                json!({ "resolved": false, "error": e.to_string(), "duration_ms": started.elapsed().as_millis() as u64 }),
            );
        }
    };
    Ok(
        json!({ "resolved": !addresses.is_empty(), "addresses": addresses, "duration_ms": started.elapsed().as_millis() as u64 }),
    )
}

fn tcp(target: &str, port: u16) -> Result<Value> {
    let started = Instant::now();
    let addrs: Vec<_> = match (target, port).to_socket_addrs() {
        Ok(a) => a.collect(),
        Err(e) => return Ok(json!({ "open": false, "error": format!("lookup failed: {e}") })),
    };
    let mut last_error = String::from("no addresses");
    for addr in addrs.iter().take(4) {
        let attempt = Instant::now();
        match TcpStream::connect_timeout(addr, Duration::from_secs(5)) {
            Ok(_) => {
                return Ok(json!({
                    "open": true,
                    "address": addr.to_string(),
                    "latency_ms": attempt.elapsed().as_secs_f64() * 1000.0,
                }));
            }
            Err(e) => last_error = format!("{addr}: {e}"),
        }
    }
    Ok(
        json!({ "open": false, "error": last_error, "duration_ms": started.elapsed().as_millis() as u64 }),
    )
}
