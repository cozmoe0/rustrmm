//! Remote tools: request/response commands and interactive tunnels.
//!
//! Short operations (process list, service control, directory listing, …) are ordinary signed
//! commands whose [`crate::commands::CommandResult::data`] carries the answer. Interactive or bulk
//! traffic (shells, file transfers) runs over a dedicated tunnel WebSocket that the agent dials
//! after receiving a signed [`OpenTunnel`] command, so it never blocks the control channel.
//!
//! Tunnel framing (agent ⇄ browser, forwarded untouched by the server):
//! * binary frames carry raw bytes — terminal output/keystrokes or file content;
//! * text frames carry JSON [`TunnelControl`] messages.

use serde::{Deserialize, Serialize};

/// Largest tunnel message an agent sends (file chunks, desktop media) before Noise overhead.
pub const MAX_TUNNEL_FROM_AGENT: usize = 8 * 1024 * 1024;
/// Largest tunnel message an agent accepts (uploads, browser input) before Noise overhead.
pub const MAX_TUNNEL_TO_AGENT: usize = 4 * 1024 * 1024;

/// Local capability names an endpoint can disable at install time (`DISABLE_FEATURES`).
pub mod features {
    pub const SHELL: &str = "shell";
    pub const FILES: &str = "files";
    pub const SYSTEM: &str = "system";
    pub const POWER: &str = "power";
    /// Running scripts sent by the server (`run_script`).
    pub const SCRIPTS: &str = "scripts";
    /// Scanning for and installing operating-system patches (`patch_scan`, `patch_install`).
    pub const PATCHING: &str = "patching";
    /// Installing and removing software packages (`software_action`).
    pub const SOFTWARE: &str = "software";
    /// Remote desktop sessions, screenshots and the interactive-session list.
    pub const DESKTOP: &str = "desktop";
    /// Secrets escrow: BitLocker key collection and local administrator password rotation.
    pub const ESCROW: &str = "escrow";
    /// Network discovery scans, SNMP polling and the trap receiver (site probes).
    pub const NETWORK: &str = "network";
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceAction {
    Start,
    Stop,
    Restart,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PowerAction {
    Reboot,
    Shutdown,
    /// Cancels a pending delayed reboot/shutdown.
    Cancel,
    /// Signs out the interactive console user.
    Logoff,
    /// Locks the interactive console session.
    Lock,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticKind {
    Ping,
    Traceroute,
    Dns,
    Port,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum FileOp {
    Mkdir {
        path: String,
    },
    Rename {
        from: String,
        to: String,
    },
    Delete {
        path: String,
        #[serde(default)]
        recursive: bool,
    },
}

impl FileOp {
    pub fn summary(&self) -> String {
        match self {
            Self::Mkdir { path } => format!("Create folder {path}"),
            Self::Rename { from, to } => format!("Rename {from} to {to}"),
            Self::Delete { path, recursive } => {
                if *recursive {
                    format!("Delete {path} (recursive)")
                } else {
                    format!("Delete {path}")
                }
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TunnelKind {
    /// Interactive shell. `shell` is a well-known name (`powershell`, `pwsh`, `cmd`, `bash`, `sh`,
    /// `zsh`) resolved by the agent to an absolute path — never through `PATH`.
    Shell { shell: String, cols: u16, rows: u16 },
    /// Agent streams a file to the server.
    Download { path: String },
    /// Server streams a file to the agent.
    Upload {
        path: String,
        size: u64,
        #[serde(default)]
        overwrite: bool,
    },
    /// Remote desktop (`docs/api-desktop.md`). The consent, banner and technician fields carry
    /// the effective `remote_access` policy so the agent can apply it before streaming.
    Desktop {
        /// Windows session id (`None` = the active console session).
        #[serde(default)]
        session_id: Option<u32>,
        /// Monitor id from the `ready` message (`None` = the primary monitor).
        #[serde(default)]
        monitor: Option<u32>,
        #[serde(default)]
        view_only: bool,
        #[serde(default)]
        quality: crate::desktop::Quality,
        #[serde(default)]
        consent: crate::desktop::ConsentMode,
        #[serde(default = "crate::desktop::default_consent_timeout")]
        consent_timeout_secs: u32,
        /// Show the on-screen "Remote session in progress" banner.
        #[serde(default)]
        banner: bool,
        /// Operator name for the banner and the consent prompt.
        #[serde(default)]
        technician: String,
        /// MSP name for the consent prompt.
        #[serde(default)]
        organization: String,
    },
}

impl TunnelKind {
    pub fn feature(&self) -> &'static str {
        match self {
            Self::Shell { .. } => features::SHELL,
            Self::Download { .. } | Self::Upload { .. } => features::FILES,
            Self::Desktop { .. } => features::DESKTOP,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenTunnel {
    pub tunnel_id: String,
    /// One-time bearer token for `/agent/v1/tunnel/{tunnel_id}` (delivered only inside a signed
    /// command over the authenticated control connection).
    pub token: String,
    pub kind: TunnelKind,
}

/// Header carrying the tunnel token on the agent's tunnel WebSocket request.
pub const TUNNEL_TOKEN_HEADER: &str = "x-rustrmm-tunnel-token";

/// JSON control messages on a tunnel's text frames.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TunnelControl {
    /// Agent side is attached and streaming.
    Ready,
    /// Browser → agent: terminal size changed.
    Resize {
        cols: u16,
        rows: u16,
    },
    /// Shell process ended.
    Exit {
        #[serde(default)]
        code: Option<i64>,
    },
    /// Download: file metadata before the first binary chunk.
    Meta {
        name: String,
        size: u64,
    },
    /// End of a file stream (either direction).
    Eof,
    /// Upload finished and the file was committed.
    Done {
        bytes: u64,
    },
    Error {
        message: String,
    },
}

impl TunnelControl {
    pub fn to_text(&self) -> String {
        serde_json::to_string(self)
            .unwrap_or_else(|_| r#"{"type":"error","message":"encoding"}"#.into())
    }
}

/// Validates a host name or IP literal used for diagnostics: no option injection, no spaces.
pub fn valid_target(target: &str) -> bool {
    !target.is_empty()
        && target.len() <= 253
        && !target.starts_with('-')
        && target.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '_' | '%' | '[' | ']')
        })
}

/// Validates a service/unit name passed to platform tools.
pub fn valid_service_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 256
        && !name.starts_with('-')
        && name.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '@' | ':' | ' ' | '$')
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostics_targets_are_strict() {
        assert!(valid_target("example.com"));
        assert!(valid_target("10.0.0.1"));
        assert!(valid_target("fe80::1%eth0"));
        assert!(!valid_target("-n 1 example.com"));
        assert!(!valid_target("a b"));
        assert!(!valid_target("x;rm"));
        assert!(!valid_target(""));
    }

    #[test]
    fn service_names_reject_options() {
        assert!(valid_service_name("nginx.service"));
        assert!(valid_service_name("MSSQL$SQLEXPRESS"));
        assert!(valid_service_name("getty@tty1.service"));
        assert!(!valid_service_name("--now"));
        assert!(!valid_service_name("a;b"));
    }

    #[test]
    fn control_messages_round_trip() {
        let msg = TunnelControl::Resize {
            cols: 120,
            rows: 40,
        };
        let text = msg.to_text();
        assert_eq!(text, r#"{"type":"resize","cols":120,"rows":40}"#);
        assert_eq!(
            serde_json::from_str::<TunnelControl>(&text).expect("decode"),
            msg
        );
    }
}
