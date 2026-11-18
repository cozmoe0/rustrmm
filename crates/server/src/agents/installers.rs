//! Agent binaries served to installers, and generated install scripts.
//!
//! Binaries live under the agent distribution directory (`RUSTRMM_AGENT_DIST`, default
//! `<data>/agents/current`) as `<platform>/<file>`, e.g. `windows-x86_64/rustrmm-agent.exe`.

use std::path::{Path, PathBuf};

use axum::body::Body;
use axum::extract::{Path as UrlPath, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use tokio_util::io::ReaderStream;

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

/// Platforms and the agent file each one downloads.
pub const PLATFORMS: &[(&str, &str, &str)] = &[
    ("windows-x86_64", "rustrmm-agent.exe", "Windows (x64)"),
    (
        "windows-x86_64",
        "RustRMMAgent-x64.msi",
        "Windows MSI (x64)",
    ),
    ("linux-x86_64", "rustrmm-agent", "Linux (x86-64)"),
    ("linux-aarch64", "rustrmm-agent", "Linux (ARM64)"),
    (
        "macos-universal",
        "rustrmm-agent",
        "macOS (Apple silicon & Intel)",
    ),
];

pub fn dist_dir(state: &AppState) -> PathBuf {
    state
        .args
        .agent_dist
        .clone()
        .unwrap_or_else(|| state.args.data_dir.join("agents").join("current"))
}

fn safe_component(s: &str) -> bool {
    !s.is_empty()
        && s.len() < 80
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
        && !s.contains("..")
}

#[derive(Debug, Clone, Serialize)]
pub struct Artifact {
    pub platform: String,
    pub file: String,
    pub label: String,
    pub size_bytes: u64,
    pub sha256: String,
}

/// Lists available agent artifacts with their hashes.
pub async fn artifacts(state: &AppState) -> Vec<Artifact> {
    let dir = dist_dir(state);
    let mut out = Vec::new();
    for (platform, file, label) in PLATFORMS {
        let path = dir.join(platform).join(file);
        if let Ok(meta) = tokio::fs::metadata(&path).await
            && let Ok(sha256) = sha256_file(&path).await
        {
            out.push(Artifact {
                platform: platform.to_string(),
                file: file.to_string(),
                label: label.to_string(),
                size_bytes: meta.len(),
                sha256,
            });
        }
    }
    out
}

async fn sha256_file(path: &Path) -> std::io::Result<String> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        use sha2::{Digest, Sha256};
        use std::io::Read;
        let mut file = std::fs::File::open(path)?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 1 << 16];
        loop {
            let n = file.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        Ok(hex::encode(hasher.finalize()))
    })
    .await
    .map_err(std::io::Error::other)?
}

/// `GET /agent/v1/download/{platform}/{file}` (agent listener; binaries are not secret).
pub async fn download(
    State(state): State<AppState>,
    UrlPath((platform, file)): UrlPath<(String, String)>,
) -> ApiResult<Response> {
    if !safe_component(&platform)
        || !safe_component(&file)
        || !PLATFORMS
            .iter()
            .any(|(p, f, _)| *p == platform && *f == file)
    {
        return Err(ApiError::not_found("Agent artifact"));
    }
    let path = dist_dir(&state).join(&platform).join(&file);
    let handle = tokio::fs::File::open(&path)
        .await
        .map_err(|_| ApiError::not_found("Agent artifact"))?;
    let size = handle.metadata().await.map(|m| m.len()).unwrap_or(0);
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (header::CONTENT_LENGTH, size.to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{file}\""),
            ),
            (header::CACHE_CONTROL, "no-cache".to_string()),
        ],
        Body::from_stream(ReaderStream::new(handle)),
    )
        .into_response())
}

fn sha_for(artifacts: &[Artifact], platform: &str, file: &str) -> String {
    artifacts
        .iter()
        .find(|a| a.platform == platform && a.file == file)
        .map(|a| a.sha256.clone())
        .unwrap_or_default()
}

fn base_url(state: &AppState) -> String {
    state
        .args
        .effective_agent_url()
        .as_str()
        .trim_end_matches('/')
        .to_string()
}

/// Escapes a value for a single-quoted PowerShell string.
fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// Escapes a value for a single-quoted POSIX shell string.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Windows PowerShell installer (works on Windows PowerShell 5.1).
pub fn powershell(
    state: &AppState,
    deploy_key: &str,
    label: &str,
    artifacts: &[Artifact],
) -> String {
    let pin = state.tls.leaf_spki_pin.clone().unwrap_or_default();
    let sha = sha_for(artifacts, "windows-x86_64", "rustrmm-agent.exe");
    format!(
        r#"#Requires -RunAsAdministrator
# RustRMM agent installer — {label}
# Generated {generated}. Run in an elevated PowerShell window.
$ErrorActionPreference = 'Stop'
$DeployKey = {key}
$BaseUrl   = {base}
$Sha256    = {sha}
$SpkiPin   = {pin}

try {{ [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]'Tls13' }} catch {{ [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 }}
if ($SpkiPin) {{
  # Trust exactly the RustRMM server key (P-256 SubjectPublicKeyInfo pin), not any certificate.
  $header = [byte[]](0x30,0x59,0x30,0x13,0x06,0x07,0x2a,0x86,0x48,0xce,0x3d,0x02,0x01,0x06,0x08,0x2a,0x86,0x48,0xce,0x3d,0x03,0x01,0x07,0x03,0x42,0x00)
  [Net.ServicePointManager]::ServerCertificateValidationCallback = {{
    param($sender, $cert, $chain, $errors)
    $c = [Security.Cryptography.X509Certificates.X509Certificate2]$cert
    $spki = $header + $c.GetPublicKey()
    $hash = [Convert]::ToBase64String([Security.Cryptography.SHA256]::Create().ComputeHash($spki))
    return $hash -eq $SpkiPin
  }}
}}

$exe = Join-Path $env:TEMP 'rustrmm-agent-setup.exe'
Write-Host 'Downloading RustRMM agent...'
(New-Object Net.WebClient).DownloadFile("$BaseUrl/agent/v1/download/windows-x86_64/rustrmm-agent.exe", $exe)
if ($Sha256 -and ((Get-FileHash -Algorithm SHA256 $exe).Hash.ToLower() -ne $Sha256)) {{
  Remove-Item $exe -Force; throw 'Downloaded agent failed its integrity check.'
}}
Write-Host 'Installing service...'
& $exe install --key $DeployKey
$code = $LASTEXITCODE
Remove-Item $exe -Force -ErrorAction SilentlyContinue
if ($code -ne 0) {{ throw "Agent installation failed (exit code $code)." }}
Write-Host 'RustRMM agent installed.'
"#,
        label = label.replace(['\r', '\n'], " "),
        generated = rustrmm_common::now().format("%Y-%m-%d %H:%M UTC"),
        key = ps_quote(deploy_key),
        base = ps_quote(&base_url(state)),
        sha = ps_quote(&sha),
        pin = ps_quote(&pin),
    )
}

/// Linux / macOS shell installer.
pub fn posix(
    state: &AppState,
    deploy_key: &str,
    label: &str,
    artifacts: &[Artifact],
    macos: bool,
) -> String {
    let pin = state
        .tls
        .leaf_spki_pin
        .clone()
        .map(|p| format!("sha256//{p}"))
        .unwrap_or_default();
    let (sha_x64, sha_arm, sha_mac) = (
        sha_for(artifacts, "linux-x86_64", "rustrmm-agent"),
        sha_for(artifacts, "linux-aarch64", "rustrmm-agent"),
        sha_for(artifacts, "macos-universal", "rustrmm-agent"),
    );
    let platform_block = if macos {
        "plat=macos-universal; expected=\"$SHA_MAC\"".to_string()
    } else {
        "case \"$(uname -m)\" in\n  x86_64|amd64) plat=linux-x86_64; expected=\"$SHA_X64\" ;;\n  aarch64|arm64) plat=linux-aarch64; expected=\"$SHA_ARM\" ;;\n  *) echo \"Unsupported architecture: $(uname -m)\" >&2; exit 1 ;;\nesac".to_string()
    };
    let hash_cmd = if macos { "shasum -a 256" } else { "sha256sum" };
    format!(
        r#"#!/bin/sh
# RustRMM agent installer — {label}
# Generated {generated}. Usage: curl … | sudo sh   (or save and run with sudo)
set -eu
DEPLOY_KEY={key}
BASE_URL={base}
PIN={pin}
SHA_X64={sha_x64}
SHA_ARM={sha_arm}
SHA_MAC={sha_mac}

if [ "$(id -u)" -ne 0 ]; then echo "Please run as root (sudo)." >&2; exit 1; fi
{platform_block}
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
if [ -n "$PIN" ]; then
  # -k skips public CA validation (the server uses its own CA) while --pinnedpubkey enforces its exact key.
  curl -fsSL -k --pinnedpubkey "$PIN" "$BASE_URL/agent/v1/download/$plat/rustrmm-agent" -o "$tmp/rustrmm-agent"
else
  curl -fsSL "$BASE_URL/agent/v1/download/$plat/rustrmm-agent" -o "$tmp/rustrmm-agent"
fi
if [ -n "$expected" ]; then
  actual="$({hash_cmd} "$tmp/rustrmm-agent" | cut -d' ' -f1)"
  [ "$actual" = "$expected" ] || {{ echo "Downloaded agent failed its integrity check." >&2; exit 1; }}
fi
chmod 0755 "$tmp/rustrmm-agent"
"$tmp/rustrmm-agent" install --key "$DEPLOY_KEY"
echo "RustRMM agent installed."
"#,
        label = label.replace(['\r', '\n'], " "),
        generated = rustrmm_common::now().format("%Y-%m-%d %H:%M UTC"),
        key = sh_quote(deploy_key),
        base = sh_quote(&base_url(state)),
        pin = sh_quote(&pin),
        sha_x64 = sh_quote(&sha_x64),
        sha_arm = sh_quote(&sha_arm),
        sha_mac = sh_quote(&sha_mac),
    )
}

/// Group Policy computer startup script: installs the MSI from the share when missing.
pub fn gpo_startup_script(deploy_key: &str, label: &str) -> String {
    format!(
        r#"# RustRMM — Group Policy computer startup script ({label})
# Place this file and RustRMMAgent-x64.msi on a share readable by "Domain Computers", then add it under
# Computer Configuration > Policies > Windows Settings > Scripts (Startup/Shutdown) > Startup > PowerShell Scripts.
$ErrorActionPreference = 'Stop'
$DeployKey = {key}
$Msi = Join-Path $PSScriptRoot 'RustRMMAgent-x64.msi'
$Log = Join-Path $env:WINDIR 'Temp\RustRMM-install.log'
if (Get-Service -Name 'RustRMMAgent' -ErrorAction SilentlyContinue) {{ exit 0 }}
if (-not (Test-Path $Msi)) {{ Write-EventLog -LogName Application -Source 'MsiInstaller' -EventId 1001 -EntryType Warning -Message "RustRMM MSI not found at $Msi" -ErrorAction SilentlyContinue; exit 1 }}
$msiArgs = @('/i', "`"$Msi`"", '/qn', '/norestart', '/l*v', "`"$Log`"")
# With deploy.key next to the MSI the agent reads it from the install source, so the key never
# appears on a command line or in the verbose log. The property is only a fallback.
if (-not (Test-Path (Join-Path $PSScriptRoot 'deploy.key'))) {{ $msiArgs += "DEPLOY_KEY=$DeployKey" }}
$p = Start-Process -FilePath 'msiexec.exe' -ArgumentList $msiArgs -Wait -PassThru
exit $p.ExitCode
"#,
        label = label.replace(['\r', '\n'], " "),
        key = ps_quote(deploy_key),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_neutralises_injection() {
        assert_eq!(ps_quote("a'b"), "'a''b'");
        assert_eq!(sh_quote("a'b"), "'a'\\''b'");
        assert!(safe_component("windows-x86_64"));
        assert!(!safe_component("../etc"));
        assert!(!safe_component("a/b"));
    }
}
