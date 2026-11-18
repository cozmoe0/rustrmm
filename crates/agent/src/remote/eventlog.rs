//! Recent event-log entries: Windows event logs, the systemd journal, or the macOS unified log.
//!
//! Every platform returns the same shape: `{ items: [{ time, level, id, source, message }] }`
//! where `level` uses Windows numbering (1 critical, 2 error, 3 warning, 4 information).

use std::time::Duration;

use anyhow::{Result, bail};
use serde_json::{Value, json};

const MAX_LIMIT: u32 = 1000;
const MAX_MESSAGE: usize = 4000;

pub fn query(log: &str, max_level: u8, limit: u32, hours: u32) -> Result<Value> {
    let log = log.trim();
    if !log
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '/' | '-' | '_' | '.' | '@'))
        || log.len() > 128
        || log.starts_with('-')
    {
        bail!("invalid log name");
    }
    let limit = limit.clamp(1, MAX_LIMIT);
    let hours = if hours == 0 { 24 } else { hours.min(24 * 90) };
    let mut items = platform::query(log, max_level.min(4), limit, hours)?;
    for item in &mut items {
        if let Some(msg) = item.get_mut("message")
            && let Some(s) = msg.as_str()
            && s.len() > MAX_MESSAGE
        {
            let cut: String = s.chars().take(MAX_MESSAGE).collect();
            *msg = Value::String(format!("{cut}…"));
        }
    }
    Ok(json!({ "log": log, "hours": hours, "items": items }))
}

#[cfg(windows)]
mod platform {
    use super::*;

    pub fn query(log: &str, max_level: u8, limit: u32, hours: u32) -> Result<Vec<Value>> {
        let log = if log.is_empty() { "System" } else { log };
        let levels = if max_level == 0 {
            String::new()
        } else {
            let list: Vec<String> = (1..=max_level).map(|l| l.to_string()).collect();
            format!("$f.Level = @({});", list.join(","))
        };
        // The log name is validated above (no quotes), so single-quoting it is safe.
        let script = format!(
            "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ErrorActionPreference = 'Stop'; \
             $null = Get-WinEvent -ListLog '{log}'; \
             $f = @{{ LogName = '{log}'; StartTime = (Get-Date).AddHours(-{hours}) }}; {levels} \
             $e = @(Get-WinEvent -FilterHashtable $f -MaxEvents {limit} -ErrorAction SilentlyContinue); \
             $items = @($e | ForEach-Object {{ [pscustomobject]@{{ time = $_.TimeCreated.ToUniversalTime().ToString('o'); level = [int]$_.Level; id = $_.Id; source = $_.ProviderName; message = $_.Message }} }}); \
             ConvertTo-Json -InputObject $items -Compress -Depth 3"
        );
        let powershell = crate::util::system_tool(r"WindowsPowerShell\v1.0\powershell.exe");
        let out = crate::util::run_capture(
            &powershell,
            &[
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &script,
            ],
            Duration::from_secs(60),
        )?;
        if out.timed_out {
            bail!("event log query timed out");
        }
        if out.code != Some(0) {
            let first = out
                .stderr
                .lines()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("query failed");
            bail!("{}", first.trim());
        }
        let text = out.stdout.trim();
        if text.is_empty() {
            return Ok(Vec::new());
        }
        let mut items: Vec<Value> = match serde_json::from_str::<Value>(text)? {
            Value::Array(a) => a,
            other => vec![other],
        };
        for item in &mut items {
            // Level 0 (LogAlways) reads as information.
            if item["level"].as_u64() == Some(0) {
                item["level"] = json!(4);
            }
        }
        Ok(items)
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;

    fn level_of(priority: u64) -> u8 {
        match priority {
            0..=2 => 1,
            3 => 2,
            4 => 3,
            _ => 4,
        }
    }

    pub fn query(log: &str, max_level: u8, limit: u32, hours: u32) -> Result<Vec<Value>> {
        let since = format!("--since=-{hours}h");
        let lines = limit.to_string();
        let mut args = vec![
            "-o",
            "json",
            "--no-pager",
            "-r",
            "-n",
            lines.as_str(),
            since.as_str(),
        ];
        let priority = match max_level {
            1 => Some("0..2"),
            2 => Some("0..3"),
            3 => Some("0..4"),
            4 => Some("0..6"),
            _ => None,
        };
        if let Some(p) = priority {
            args.extend(["-p", p]);
        }
        if !log.is_empty() && !log.eq_ignore_ascii_case("system") {
            args.extend(["-u", log]);
        }
        let out = crate::util::run_capture(
            &crate::util::system_tool("journalctl"),
            &args,
            Duration::from_secs(60),
        )?;
        if out.code != Some(0) && out.stdout.trim().is_empty() {
            bail!("journalctl failed: {}", out.stderr.trim());
        }
        Ok(out
            .stdout
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .map(|e| {
                let micros: i64 = e["__REALTIME_TIMESTAMP"]
                    .as_str()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0);
                let time = chrono::DateTime::from_timestamp_micros(micros)
                    .map(|t| t.to_rfc3339())
                    .unwrap_or_default();
                let priority: u64 = e["PRIORITY"].as_str().and_then(|s| s.parse().ok()).unwrap_or(6);
                let message = match &e["MESSAGE"] {
                    Value::String(s) => s.clone(),
                    Value::Array(bytes) => String::from_utf8_lossy(
                        &bytes.iter().filter_map(|b| b.as_u64().map(|b| b as u8)).collect::<Vec<u8>>(),
                    )
                    .to_string(),
                    _ => String::new(),
                };
                let source = e["SYSLOG_IDENTIFIER"]
                    .as_str()
                    .or_else(|| e["_SYSTEMD_UNIT"].as_str())
                    .or_else(|| e["_COMM"].as_str())
                    .unwrap_or("")
                    .to_string();
                json!({ "time": time, "level": level_of(priority), "id": null, "source": source, "message": message })
            })
            .collect())
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;

    pub fn query(_log: &str, max_level: u8, limit: u32, hours: u32) -> Result<Vec<Value>> {
        let last = format!("{hours}h");
        let predicate = match max_level {
            1 => "messageType == fault",
            2 | 3 => "messageType == error OR messageType == fault",
            _ => "messageType == default OR messageType == error OR messageType == fault",
        };
        let out = crate::util::run_capture(
            &crate::util::system_tool("log"),
            &[
                "show",
                "--style",
                "ndjson",
                "--last",
                &last,
                "--predicate",
                predicate,
            ],
            Duration::from_secs(60),
        )?;
        let mut items: Vec<Value> = out
            .stdout
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|e| e.get("eventMessage").is_some())
            .map(|e| {
                let level = match e["messageType"].as_str() {
                    Some("Fault") => 1,
                    Some("Error") => 2,
                    _ => 4,
                };
                let source = e["processImagePath"]
                    .as_str()
                    .and_then(|p| p.rsplit('/').next())
                    .unwrap_or("")
                    .to_string();
                json!({ "time": e["timestamp"], "level": level, "id": null, "source": source, "message": e["eventMessage"] })
            })
            .collect();
        items.reverse();
        items.truncate(limit as usize);
        Ok(items)
    }
}
