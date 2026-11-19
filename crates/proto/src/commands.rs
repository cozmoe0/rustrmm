//! Signed server → agent commands.
//!
//! Every state-changing instruction travels as a [`SignedCommand`]: MessagePack-encoded
//! [`CommandPayload`] bytes plus an Ed25519 signature by the server's *command* key (pinned by the
//! agent at enrollment, kept in a key file — never in the database). The payload is bound to one
//! device, one connection (`session_nonce`), a strictly increasing `seq`, and an expiry, so a
//! TLS-terminating proxy or a captured frame cannot inject or replay commands.

use serde::{Deserialize, Serialize};

use crate::Message;
use crate::remote::{DiagnosticKind, FileOp, OpenTunnel, PowerAction, ServiceAction, features};

const COMMAND_CONTEXT: &[u8] = b"rustrmm/v1/command";
const MANIFEST_CONTEXT: &[u8] = b"rustrmm/v1/release-manifest";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignedCommand {
    #[serde(with = "serde_bytes")]
    pub payload: Vec<u8>,
    #[serde(with = "serde_bytes")]
    pub signature: Vec<u8>,
}

impl Message for SignedCommand {
    const TYPE: &'static str = "command";
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandPayload {
    pub cmd_id: String,
    pub device_id: String,
    /// The server nonce of the handshake this command is valid for.
    #[serde(with = "serde_bytes")]
    pub session_nonce: Vec<u8>,
    /// Strictly increasing within a session.
    pub seq: u64,
    /// Server clock, unix milliseconds.
    pub issued_at: i64,
    pub expires_at: i64,
    pub command: Command,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    /// Connectivity / signing self-test.
    Ping,
    /// Install a new agent release.
    UpdateAgent(UpdateAgent),
    /// Running processes.
    ListProcesses,
    /// Terminate a process (and, on Windows, its child tree when `tree` is set).
    KillProcess {
        pid: u32,
        #[serde(default)]
        tree: bool,
    },
    /// Services / daemons with state and start mode.
    ListServices,
    ControlService {
        name: String,
        action: ServiceAction,
    },
    /// Reboot, shut down, sign out or lock, optionally delayed with a message for the user.
    Power {
        action: PowerAction,
        #[serde(default)]
        delay_secs: u32,
        #[serde(default)]
        message: String,
    },
    /// Show a message to the interactive user.
    MessageUser {
        title: String,
        body: String,
        #[serde(default)]
        timeout_secs: u32,
    },
    /// Network diagnostics run from the device.
    Diagnostic {
        kind: DiagnosticKind,
        target: String,
        #[serde(default)]
        port: Option<u16>,
    },
    /// Directory listing; an empty path lists drives (Windows) or `/`.
    ListDir {
        path: String,
    },
    FileOp(FileOp),
    /// Recent entries from an event log / the journal.
    EventLog {
        log: String,
        /// 1 = critical … 4 = information (Windows levels); 0 = all.
        #[serde(default)]
        max_level: u8,
        limit: u32,
        #[serde(default)]
        hours: u32,
    },
    /// Subkeys and values of a registry key (Windows).
    RegistryList {
        path: String,
    },
    /// Dial a tunnel socket for a shell or file transfer.
    OpenTunnel(OpenTunnel),
    /// Run a script with a clean environment, a timeout and capped, masked output.
    RunScript(RunScript),
    /// Replace the device's monitoring checks (signed because `script` checks carry code).
    MonitoringConfig(crate::monitoring::MonitoringConfig),
    /// Search for missing patches; the agent answers with a `patch_report` message.
    PatchScan(crate::patching::PatchScan),
    /// Install exactly the listed patch keys, then handle the reboot.
    PatchInstall(crate::patching::PatchInstall),
    /// Install or uninstall a software package (with detection before and after).
    SoftwareAction(crate::software::SoftwareAction),
    /// The device's interactive sessions for remote desktop (`{ items: [...] }`).
    DesktopSessions,
    /// One JPEG of the console session's primary monitor (`{ jpeg: base64, width, height }`).
    Screenshot(crate::desktop::Screenshot),
    /// Set a fresh random password on the managed local administrator and escrow it (the
    /// result never carries the password).
    RotateLocalAdmin(crate::escrow::RotateLocalAdmin),
    /// Collect BitLocker recovery keys (and FileVault/LUKS status) again.
    EscrowRefresh,
    /// Discovery sweep of private ranges; results stream back as `scan_results`.
    NetworkScan(crate::network::NetworkScan),
    /// The probe's SNMP polling and trap receiver configuration (carries credentials).
    SnmpConfig(crate::network::SnmpConfig),
    /// Poll one SNMP device once (`{ ok, sys_descr?, sys_name?, sys_object_id?, uptime_secs?, error? }`).
    SnmpTest(crate::network::SnmpTarget),
    /// Unknown future command (older agents reject it cleanly).
    #[serde(other)]
    Unsupported,
}

impl Command {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Ping => "ping",
            Self::UpdateAgent(_) => "update_agent",
            Self::ListProcesses => "list_processes",
            Self::KillProcess { .. } => "kill_process",
            Self::ListServices => "list_services",
            Self::ControlService { .. } => "control_service",
            Self::Power { .. } => "power",
            Self::MessageUser { .. } => "message_user",
            Self::Diagnostic { .. } => "diagnostic",
            Self::ListDir { .. } => "list_dir",
            Self::FileOp(_) => "file_op",
            Self::EventLog { .. } => "event_log",
            Self::RegistryList { .. } => "registry_list",
            Self::OpenTunnel(_) => "open_tunnel",
            Self::RunScript(_) => "run_script",
            Self::MonitoringConfig(_) => "monitoring_config",
            Self::PatchScan(_) => "patch_scan",
            Self::PatchInstall(_) => "patch_install",
            Self::SoftwareAction(_) => "software_action",
            Self::DesktopSessions => "desktop_sessions",
            Self::Screenshot(_) => "screenshot",
            Self::RotateLocalAdmin(_) => "rotate_local_admin",
            Self::EscrowRefresh => "escrow_refresh",
            Self::NetworkScan(_) => "network_scan",
            Self::SnmpConfig(_) => "snmp_config",
            Self::SnmpTest(_) => "snmp_test",
            Self::Unsupported => "unsupported",
        }
    }

    /// Local capability the command needs (endpoints can disable features at install time).
    pub fn feature(&self) -> Option<&'static str> {
        match self {
            // Script checks inside a monitoring config are refused at run time when the local
            // `scripts` capability is off; the configuration itself needs no capability.
            Self::Ping | Self::UpdateAgent(_) | Self::MonitoringConfig(_) | Self::Unsupported => {
                None
            }
            Self::ListProcesses
            | Self::KillProcess { .. }
            | Self::ListServices
            | Self::ControlService { .. }
            | Self::Diagnostic { .. }
            | Self::EventLog { .. }
            | Self::RegistryList { .. } => Some(features::SYSTEM),
            Self::Power { .. } | Self::MessageUser { .. } => Some(features::POWER),
            Self::ListDir { .. } | Self::FileOp(_) => Some(features::FILES),
            Self::OpenTunnel(t) => Some(t.kind.feature()),
            Self::RunScript(_) => Some(features::SCRIPTS),
            Self::PatchScan(_) | Self::PatchInstall(_) => Some(features::PATCHING),
            Self::SoftwareAction(_) => Some(features::SOFTWARE),
            Self::DesktopSessions | Self::Screenshot(_) => Some(features::DESKTOP),
            Self::RotateLocalAdmin(_) | Self::EscrowRefresh => Some(features::ESCROW),
            Self::NetworkScan(_) | Self::SnmpConfig(_) | Self::SnmpTest(_) => {
                Some(features::NETWORK)
            }
        }
    }
}

/// A script to run on the device (see `docs/api-automation.md`, "Agent protocol additions").
///
/// The agent verifies `content_sha256` before writing anything, runs the script with a fresh
/// minimal environment inside a kill-on-close job object (Windows) or its own process group
/// (Unix), and replaces every `mask` value in the output with [`crate::scripts::MASK`].
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunScript {
    /// `powershell` | `pwsh` | `cmd` | `bash` | `sh` | `zsh` | `python`
    pub language: String,
    pub content: String,
    /// Lowercase hex SHA-256 of `content`.
    pub content_sha256: String,
    /// Variables, then parameters (later entries win).
    #[serde(default)]
    pub env: Vec<(String, String)>,
    /// Secret values to mask in output (each at least 4 characters).
    #[serde(default)]
    pub mask: Vec<String>,
    pub timeout_secs: u32,
    /// Cap per stream.
    pub max_output_bytes: u32,
}

impl std::fmt::Debug for RunScript {
    // Never print environment values or mask entries: they carry secrets.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RunScript")
            .field("language", &self.language)
            .field("content_sha256", &self.content_sha256)
            .field(
                "env",
                &self.env.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(),
            )
            .field("mask", &self.mask.len())
            .field("timeout_secs", &self.timeout_secs)
            .field("max_output_bytes", &self.max_output_bytes)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateAgent {
    pub version: String,
    /// JSON-encoded [`ReleaseManifest`].
    #[serde(with = "serde_bytes")]
    pub manifest: Vec<u8>,
    /// Release-key signature over [`manifest_signing_bytes`].
    #[serde(with = "serde_bytes")]
    pub manifest_signature: Vec<u8>,
    /// Base URL for artifacts: `{base}/{platform}/{file}`.
    pub download_base: String,
    /// Permit installing an older version (explicit, signed rollback).
    #[serde(default)]
    pub allow_downgrade: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReleaseFile {
    pub platform: String,
    pub file: String,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReleaseManifest {
    pub version: String,
    pub files: Vec<ReleaseFile>,
    #[serde(default)]
    pub created_at: Option<String>,
}

impl ReleaseManifest {
    /// The agent binary of a platform (`rustrmm-agent` or `rustrmm-agent.exe`), never an
    /// installer or a detached signature such as `rustrmm-agent.minisig`.
    pub fn agent_file(&self, platform: &str) -> Option<&ReleaseFile> {
        self.files.iter().find(|f| {
            f.platform == platform
                && matches!(f.file.as_str(), "rustrmm-agent" | "rustrmm-agent.exe")
        })
    }
}

/// Agent → server outcome of a command.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandResult {
    pub cmd_id: String,
    /// `accepted` | `rejected` | `running` | `succeeded` | `failed`
    pub status: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub data: serde_json::Value,
}

impl Message for CommandResult {
    const TYPE: &'static str = "command_result";
}

pub fn command_signing_bytes(payload: &[u8]) -> Vec<u8> {
    let mut m = Vec::with_capacity(COMMAND_CONTEXT.len() + payload.len());
    m.extend_from_slice(COMMAND_CONTEXT);
    m.extend_from_slice(payload);
    m
}

pub fn manifest_signing_bytes(manifest: &[u8]) -> Vec<u8> {
    let mut m = Vec::with_capacity(MANIFEST_CONTEXT.len() + manifest.len());
    m.extend_from_slice(MANIFEST_CONTEXT);
    m.extend_from_slice(manifest);
    m
}

/// Compares dotted numeric versions (`0.10.2` > `0.9.9`); non-numeric parts compare as 0.
pub fn version_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let parse = |v: &str| -> Vec<u64> {
        v.split(['.', '-', '+'])
            .take(4)
            .map(|p| p.parse().unwrap_or(0))
            .collect()
    };
    let (mut pa, mut pb) = (parse(a), parse(b));
    let len = pa.len().max(pb.len());
    pa.resize(len, 0);
    pb.resize(len, 0);
    pa.cmp(&pb)
}

/// Platform identifier used for artifacts (`windows-x86_64`, `linux-aarch64`, `macos-universal`).
pub fn current_platform() -> String {
    let os = std::env::consts::OS;
    if os == "macos" {
        return "macos-universal".into();
    }
    format!("{os}-{}", std::env::consts::ARCH)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering;

    #[test]
    fn versions_compare_numerically() {
        assert_eq!(version_cmp("0.10.0", "0.9.9"), Ordering::Greater);
        assert_eq!(version_cmp("1.0", "1.0.0"), Ordering::Equal);
        assert_eq!(version_cmp("0.1.0", "0.1.1"), Ordering::Less);
    }

    #[test]
    fn build_stamps_order_builds_of_one_version() {
        // Stamped builds (`<version>+<UTC build time>`) sort after the unstamped version, after
        // older stamps, and before the next version.
        assert_eq!(
            version_cmp("0.1.0+20261118220341", "0.1.0"),
            Ordering::Greater
        );
        assert_eq!(
            version_cmp("0.1.0+20261118220341", "0.1.0+20261119080000"),
            Ordering::Less
        );
        assert_eq!(
            version_cmp("0.1.0+20261118220341", "0.1.0+20261118220341"),
            Ordering::Equal
        );
        assert_eq!(version_cmp("0.1.0+20261118220341", "0.1.1"), Ordering::Less);
    }

    #[test]
    fn unknown_commands_decode_as_unsupported() {
        #[derive(Serialize)]
        struct Future {
            #[serde(rename = "type")]
            kind: &'static str,
            x: u8,
        }
        let bytes = rmp_serde::to_vec_named(&Future {
            kind: "teleport",
            x: 1,
        })
        .expect("encode");
        let cmd: Command = rmp_serde::from_slice(&bytes).expect("decode");
        assert!(matches!(cmd, Command::Unsupported));
        let op = Command::FileOp(FileOp::Delete {
            path: "/tmp/x".into(),
            recursive: true,
        });
        let bytes = rmp_serde::to_vec_named(&op).expect("encode");
        assert!(matches!(
            rmp_serde::from_slice::<Command>(&bytes).expect("decode"),
            Command::FileOp(FileOp::Delete {
                recursive: true,
                ..
            })
        ));
        let tunnel = Command::OpenTunnel(OpenTunnel {
            tunnel_id: "t".into(),
            token: "k".into(),
            kind: crate::remote::TunnelKind::Shell {
                shell: "powershell".into(),
                cols: 80,
                rows: 24,
            },
        });
        let bytes = rmp_serde::to_vec_named(&tunnel).expect("encode");
        let back: Command = rmp_serde::from_slice(&bytes).expect("decode");
        assert_eq!(back.feature(), Some("shell"));
        let script = Command::RunScript(RunScript {
            language: "bash".into(),
            content: "echo hi".into(),
            content_sha256: crate::scripts::sha256_hex("echo hi"),
            env: vec![("NAME".into(), "value".into())],
            mask: vec!["hunter22".into()],
            timeout_secs: 60,
            max_output_bytes: 1024,
        });
        let bytes = rmp_serde::to_vec_named(&script).expect("encode");
        let back: Command = rmp_serde::from_slice(&bytes).expect("decode");
        assert_eq!(back.kind(), "run_script");
        assert_eq!(back.feature(), Some(features::SCRIPTS));
        match back {
            Command::RunScript(s) => {
                assert_eq!(s.env, vec![("NAME".to_string(), "value".to_string())]);
                assert_eq!(s.mask, vec!["hunter22".to_string()]);
                assert_eq!(s.content_sha256, crate::scripts::sha256_hex("echo hi"));
                assert!(
                    !format!("{s:?}").contains("hunter22"),
                    "debug output hides secrets"
                );
            }
            other => panic!("unexpected {other:?}"),
        }
        let monitoring = Command::MonitoringConfig(crate::monitoring::MonitoringConfig::new(
            vec![crate::monitoring::CheckDefinition {
                id: "cpu".into(),
                kind: "cpu".into(),
                name: "CPU".into(),
                interval_secs: 60,
                config: serde_json::json!({ "warn_pct": 85, "crit_pct": 95 }),
                script: None,
            }],
            3,
        ));
        let bytes = rmp_serde::to_vec_named(&monitoring).expect("encode");
        let back: Command = rmp_serde::from_slice(&bytes).expect("decode");
        assert_eq!(back.kind(), "monitoring_config");
        assert_eq!(back.feature(), None);
        match back {
            Command::MonitoringConfig(cfg) => {
                assert_eq!(cfg.checks[0].kind, "cpu");
                assert_eq!(cfg.checks[0].config["crit_pct"], 95);
                assert_eq!(cfg.version, cfg.content_hash());
            }
            other => panic!("unexpected {other:?}"),
        }
        let scan = Command::PatchScan(crate::patching::PatchScan {
            include_drivers: true,
            ..Default::default()
        });
        let back: Command = rmp_serde::from_slice(&rmp_serde::to_vec_named(&scan).expect("encode"))
            .expect("decode");
        assert_eq!(back.kind(), "patch_scan");
        assert_eq!(back.feature(), Some(features::PATCHING));
        assert!(matches!(back, Command::PatchScan(s) if s.include_drivers));
        let install = Command::PatchInstall(crate::patching::PatchInstall {
            run_id: Some("run-1".into()),
            keys: vec!["apt:openssl:3.0.2-0ubuntu1.15".into()],
            reboot: crate::patching::RebootSpec {
                mode: "force".into(),
                deferrals: 0,
                message: "Restarting".into(),
                deadline_unix: Some(1_700_000_000),
            },
            window_end_unix: Some(1_700_000_000),
        });
        let back: Command =
            rmp_serde::from_slice(&rmp_serde::to_vec_named(&install).expect("encode"))
                .expect("decode");
        assert_eq!(back.kind(), "patch_install");
        assert_eq!(back.feature(), Some(features::PATCHING));
        match back {
            Command::PatchInstall(p) => {
                assert_eq!(p.keys, vec!["apt:openssl:3.0.2-0ubuntu1.15".to_string()]);
                assert_eq!(p.reboot.mode, "force");
                assert_eq!(p.reboot.deadline_unix, Some(1_700_000_000));
            }
            other => panic!("unexpected {other:?}"),
        }
        let action = Command::SoftwareAction(crate::software::SoftwareAction {
            action: "install".into(),
            source: crate::software::PackageSource::Winget {
                id: "7zip.7zip".into(),
            },
            detection: crate::software::Detection::SoftwareName {
                pattern: "7-Zip*".into(),
                min_version: Some("24.0".into()),
            },
            download: None,
            timeout_secs: 1800,
            deployment_id: None,
        });
        let back: Command =
            rmp_serde::from_slice(&rmp_serde::to_vec_named(&action).expect("encode"))
                .expect("decode");
        assert_eq!(back.kind(), "software_action");
        assert_eq!(back.feature(), Some(features::SOFTWARE));
        match back {
            Command::SoftwareAction(a) => {
                assert_eq!(a.source.id(), "7zip.7zip");
                assert!(matches!(
                    a.detection,
                    crate::software::Detection::SoftwareName { .. }
                ));
            }
            other => panic!("unexpected {other:?}"),
        }
        let desktop = Command::OpenTunnel(OpenTunnel {
            tunnel_id: "t".into(),
            token: "k".into(),
            kind: crate::remote::TunnelKind::Desktop {
                session_id: Some(1),
                monitor: None,
                view_only: true,
                quality: crate::desktop::Quality::Medium,
                consent: crate::desktop::ConsentMode::Always,
                consent_timeout_secs: 20,
                banner: true,
                technician: "Ada".into(),
                organization: "Northwind IT".into(),
            },
        });
        let back: Command =
            rmp_serde::from_slice(&rmp_serde::to_vec_named(&desktop).expect("encode"))
                .expect("decode");
        assert_eq!(back.feature(), Some(features::DESKTOP));
        match back {
            Command::OpenTunnel(OpenTunnel {
                kind:
                    crate::remote::TunnelKind::Desktop {
                        session_id,
                        view_only,
                        quality,
                        consent,
                        ..
                    },
                ..
            }) => {
                assert_eq!(session_id, Some(1));
                assert!(view_only);
                assert_eq!(quality, crate::desktop::Quality::Medium);
                assert_eq!(consent, crate::desktop::ConsentMode::Always);
            }
            other => panic!("unexpected {other:?}"),
        }
        let shot = Command::Screenshot(crate::desktop::Screenshot {
            max_width: 1280,
            consent: crate::desktop::ConsentMode::Never,
            consent_timeout_secs: 30,
            technician: String::new(),
            organization: String::new(),
        });
        let back: Command = rmp_serde::from_slice(&rmp_serde::to_vec_named(&shot).expect("encode"))
            .expect("decode");
        assert_eq!(back.kind(), "screenshot");
        assert_eq!(back.feature(), Some(features::DESKTOP));
        let rotate = Command::RotateLocalAdmin(crate::escrow::RotateLocalAdmin::default());
        let back: Command =
            rmp_serde::from_slice(&rmp_serde::to_vec_named(&rotate).expect("encode"))
                .expect("decode");
        assert_eq!(back.kind(), "rotate_local_admin");
        assert_eq!(back.feature(), Some(features::ESCROW));
        assert!(
            matches!(back, Command::RotateLocalAdmin(r) if r.account == "rmm-admin" && r.length == 20)
        );
        let refresh = rmp_serde::to_vec_named(&Command::EscrowRefresh).expect("encode");
        let back: Command = rmp_serde::from_slice(&refresh).expect("decode");
        assert_eq!(back.kind(), "escrow_refresh");
        assert_eq!(back.feature(), Some(features::ESCROW));
        let scan = Command::NetworkScan(crate::network::NetworkScan {
            scan_id: "s1".into(),
            run_id: Some("r1".into()),
            ranges: vec!["192.168.1.0/24".into()],
            methods: crate::network::ScanMethods::default(),
            snmp: vec![crate::network::SnmpCredential {
                version: "v2c".into(),
                community: Some("public".into()),
                v3: None,
            }],
            concurrency: 64,
            timeout_ms: 800,
            allow_public: false,
        });
        let back: Command = rmp_serde::from_slice(&rmp_serde::to_vec_named(&scan).expect("encode"))
            .expect("decode");
        assert_eq!(back.kind(), "network_scan");
        assert_eq!(back.feature(), Some(features::NETWORK));
        match back {
            Command::NetworkScan(s) => {
                assert_eq!(
                    s.methods.tcp_ports,
                    crate::network::DEFAULT_TCP_PORTS.to_vec()
                );
                assert_eq!(s.snmp[0].community.as_deref(), Some("public"));
                assert_eq!(s.run_id.as_deref(), Some("r1"));
            }
            other => panic!("unexpected {other:?}"),
        }
        let target = crate::network::SnmpTarget {
            id: "d1".into(),
            ip: "192.168.1.9".into(),
            port: 161,
            credential: crate::network::SnmpCredential::default(),
            oids: Vec::new(),
            poll_interval_secs: 300,
        };
        let config = Command::SnmpConfig(crate::network::SnmpConfig::new(
            vec![target.clone()],
            crate::network::TrapReceiver::default(),
        ));
        let back: Command =
            rmp_serde::from_slice(&rmp_serde::to_vec_named(&config).expect("encode"))
                .expect("decode");
        assert_eq!(back.kind(), "snmp_config");
        assert_eq!(back.feature(), Some(features::NETWORK));
        assert!(
            matches!(back, Command::SnmpConfig(c) if c.devices.len() == 1 && c.version == c.content_hash())
        );
        let test = Command::SnmpTest(target);
        let back: Command = rmp_serde::from_slice(&rmp_serde::to_vec_named(&test).expect("encode"))
            .expect("decode");
        assert_eq!(back.kind(), "snmp_test");
        assert!(matches!(back, Command::SnmpTest(t) if t.ip == "192.168.1.9"));
        let ping = rmp_serde::to_vec_named(&Command::Ping).expect("encode");
        assert!(matches!(
            rmp_serde::from_slice::<Command>(&ping).expect("decode"),
            Command::Ping
        ));
    }
}
