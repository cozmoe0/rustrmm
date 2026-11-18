//! Fuzz target bodies.
//!
//! Each `pub fn` takes arbitrary bytes and must never panic, hang or allocate without bound. The
//! cargo-fuzz crate in `fuzz/` (nightly, libFuzzer) calls them from its `fuzz_targets/`, and the
//! tests below run a few thousand random and mutated inputs through each on stable, so CI
//! exercises every target on every push.
//!
//! | Target | Attack surface |
//! |---|---|
//! | [`frame_decode`] | every agent WebSocket message (MessagePack frame, zstd body, typed bodies) and the Noise handshake/transport parsers |
//! | [`command_payload`] | signed command envelopes and payloads (agent side) |
//! | [`deploy_key`] | `rrmm1_…` deploy keys pasted into installers |
//! | [`tunnel_control`] | JSON control messages on shell/file tunnels |
//! | [`desktop_message`] | remote desktop binary media and JSON control messages |
//! | [`rule_engine`] | dynamic group rule documents (validation, regex compilation, evaluation) |

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use rustrmm_proto::Frame;
use rustrmm_proto::commands::{CommandPayload, CommandResult, SignedCommand};
use rustrmm_proto::deploy::DeployKey;
use rustrmm_proto::desktop::{DesktopControl, Media};
use rustrmm_proto::handshake::{Challenge, Hello, Proof, Rejected, Welcome};
use rustrmm_proto::messages::{AgentLog, Bye, Heartbeat, InventorySection, Metrics};
use rustrmm_proto::noise::{self, NoiseCodec, NoiseInit, StaticKeypair};
use rustrmm_proto::remote::TunnelControl;
use rustrmm_server::automation::rules::{self, DeviceFacts, RuleDocument};

/// A fixed responder key and an established transport (fuzzed transport messages almost always
/// fail authentication, which is exactly the path an attacker reaches).
fn noise_fixture() -> &'static (StaticKeypair, Mutex<NoiseCodec>) {
    static FIXTURE: OnceLock<(StaticKeypair, Mutex<NoiseCodec>)> = OnceLock::new();
    FIXTURE.get_or_init(|| {
        let server = StaticKeypair::from_secret(&[7u8; 32]).expect("key");
        let agent = StaticKeypair::from_secret(&[9u8; 32]).expect("key");
        let (initiator, first) =
            noise::Initiator::start(&agent, &server.public_key(), b"fuzz").expect("start");
        let accepted = noise::respond(&server, b"fuzz", &first).expect("respond");
        let _agent_side = initiator.finish(&accepted.reply).expect("finish");
        (server, Mutex::new(accepted.codec))
    })
}

/// Agent WebSocket messages: frame envelope, every typed body, the Noise handshake and transport.
pub fn frame_decode(data: &[u8]) {
    if let Ok(frame) = Frame::decode(data) {
        let _ = frame.body::<Hello>();
        let _ = frame.body::<Challenge>();
        let _ = frame.body::<Proof>();
        let _ = frame.body::<Welcome>();
        let _ = frame.body::<Rejected>();
        let _ = frame.body::<Heartbeat>();
        let _ = frame.body::<Metrics>();
        let _ = frame.body::<InventorySection>();
        let _ = frame.body::<AgentLog>();
        let _ = frame.body::<Bye>();
        let _ = frame.body::<CommandResult>();
        let _ = frame.body::<SignedCommand>();
        if let Ok(init) = frame.body::<NoiseInit>() {
            let (server, _) = noise_fixture();
            let device = rustrmm_crypto::sign::SigningKey::from_secret_bytes(
                rustrmm_crypto::sign::KeyAlgorithm::Ed25519,
                &[3u8; 32],
            )
            .expect("key")
            .public_key();
            let _ = noise::accept_control(server, &device, &init, &[1; 32], &[2; 32], "dev");
        }
        let _ = frame.encode();
    }
    let (server, codec) = noise_fixture();
    // An unauthenticated first handshake message (what the server parses before trusting anyone).
    let _ = noise::respond(server, &noise::tunnel_prologue("fuzz"), data);
    if let Ok(mut codec) = codec.lock() {
        let _ = codec.open(data);
    }
}

/// Signed command envelopes and payloads.
pub fn command_payload(data: &[u8]) {
    if let Ok(signed) = rmp_serde::from_slice::<SignedCommand>(data) {
        let _ = rustrmm_proto::commands::command_signing_bytes(&signed.payload);
        let _ = rmp_serde::from_slice::<CommandPayload>(&signed.payload);
    }
    if let Ok(payload) = rmp_serde::from_slice::<CommandPayload>(data) {
        let _ = payload.command.kind();
        let _ = payload.command.feature();
        let _ = rmp_serde::to_vec_named(&payload);
    }
}

/// Deploy keys (`rrmm1_<base64url JSON>`).
pub fn deploy_key(data: &[u8]) {
    if let Ok(text) = std::str::from_utf8(data)
        && let Ok(key) = DeployKey::parse(text)
    {
        let round = DeployKey::parse(&key.encode()).expect("a parsed key re-encodes");
        assert_eq!(round, key);
        let _ = key.identity_key();
    }
}

/// Tunnel control messages (JSON text frames).
pub fn tunnel_control(data: &[u8]) {
    if let Ok(control) = serde_json::from_slice::<TunnelControl>(data) {
        let back: TunnelControl =
            serde_json::from_str(&control.to_text()).expect("control round-trips");
        assert_eq!(back, control);
    }
}

/// Remote desktop media (binary) and control (JSON) messages.
pub fn desktop_message(data: &[u8]) {
    if let Ok(media) = Media::decode(data) {
        let again = Media::decode(&media.encode()).expect("media round-trips");
        assert_eq!(again, media);
    }
    if let Ok(control) = serde_json::from_slice::<DesktopControl>(data) {
        let _ = control.is_input();
        let _ = serde_json::to_string(&control);
    }
}

/// Dynamic group rule documents: validation, compilation (regular expressions included) and
/// evaluation against a device.
pub fn rule_engine(data: &[u8]) {
    let Ok(doc) = serde_json::from_slice::<RuleDocument>(data) else {
        return;
    };
    let custom: HashMap<String, String> = [
        ("asset_tag".to_string(), "text".to_string()),
        ("rack".to_string(), "number".to_string()),
        ("managed".to_string(), "boolean".to_string()),
        ("warranty".to_string(), "date".to_string()),
    ]
    .into_iter()
    .collect();
    if let Ok(rule) = rules::compile(&doc, &custom) {
        let facts = DeviceFacts {
            id: "dev-1".into(),
            client_id: "c".into(),
            site_id: "s".into(),
            hostname: "WS-ACME-01".into(),
            os_family: "windows".into(),
            os_name: "Windows 11 Pro".into(),
            os_version: "10.0.26100".into(),
            agent_version: "0.1.0".into(),
            tags: vec!["finance".into(), "laptop".into()],
            online: true,
            health_score: Some(87.0),
            ram_gb: Some(16.0),
            disk_free_pct: Some(12.5),
            custom: [
                ("asset_tag".to_string(), serde_json::json!("A-100")),
                ("rack".to_string(), serde_json::json!(4)),
            ]
            .into_iter()
            .collect(),
            ..Default::default()
        };
        let _ = rule.matches(&facts);
        let _ = rule.matches(&DeviceFacts::default());
        let mut keys = std::collections::HashSet::new();
        rule.custom_keys(&mut keys);
    }
}

/// Valid inputs for each target (seed corpus and mutation bases).
pub fn seeds(target: &str) -> Vec<Vec<u8>> {
    use rustrmm_proto::commands::Command;
    match target {
        "frame_decode" => {
            let hb = Heartbeat {
                uptime_s: 1,
                cpu_pct: 2.0,
                mem_pct: 3.0,
                disk_pct: 4.0,
                logged_in_user: Some("alice".into()),
            };
            let section = InventorySection {
                section: "software".into(),
                hash: "h".into(),
                data: serde_json::json!({ "items": (0..400).map(|i| format!("pkg {i}")).collect::<Vec<_>>() }),
            };
            let init = NoiseInit {
                signature: vec![1; 64],
                payload: vec![2; 96],
            };
            vec![
                rustrmm_proto::encode(&hb).expect("encode"),
                rustrmm_proto::encode(&section).expect("encode"),
                rustrmm_proto::encode(&init).expect("encode"),
            ]
        }
        "command_payload" => {
            let payload = CommandPayload {
                cmd_id: "c1".into(),
                device_id: "d1".into(),
                session_nonce: vec![0; 32],
                seq: 1,
                issued_at: 0,
                expires_at: 1,
                command: Command::Ping,
            };
            let bytes = rmp_serde::to_vec_named(&payload).expect("encode");
            let signed = SignedCommand {
                payload: bytes.clone(),
                signature: vec![0; 64],
            };
            vec![bytes, rmp_serde::to_vec_named(&signed).expect("encode")]
        }
        "deploy_key" => vec![
            DeployKey {
                v: 1,
                urls: vec!["https://rmm.example.test:8444".into()],
                secret: "c2VjcmV0LXNlY3JldC1zZWNyZXQ".into(),
                identity: rustrmm_crypto::sign::SigningKey::from_secret_bytes(
                    rustrmm_crypto::sign::KeyAlgorithm::Ed25519,
                    &[5u8; 32],
                )
                .expect("key")
                .public_key()
                .to_string(),
                ca_pin: None,
                label: "Acme / HQ".into(),
            }
            .encode()
            .into_bytes(),
        ],
        "tunnel_control" => vec![
            br#"{"type":"resize","cols":120,"rows":40}"#.to_vec(),
            br#"{"type":"meta","name":"a.txt","size":12}"#.to_vec(),
            br#"{"type":"exit","code":0}"#.to_vec(),
        ],
        "desktop_message" => vec![
            Media::FrameEnd {
                frame_seq: 7,
                tiles: 3,
            }
            .encode(),
            Media::CursorPosition {
                x: 10,
                y: -4,
                visible: true,
            }
            .encode(),
            br#"{"type":"key","code":"KeyA","down":true}"#.to_vec(),
        ],
        "rule_engine" => vec![
            br#"{"match":"all","conditions":[{"field":"hostname","op":"matches","value":"^WS-"},{"field":"os_family","op":"eq","value":"windows"}]}"#.to_vec(),
            br#"{"match":"any","conditions":[{"field":"ram_gb","op":"gte","value":8},{"match":"all","conditions":[{"field":"custom.rack","op":"eq","value":4}]}]}"#.to_vec(),
        ],
        _ => Vec::new(),
    }
}

/// A fuzz target body.
pub type Target = fn(&[u8]);

/// Every target by name (the cargo-fuzz binaries use the same names).
pub const TARGETS: &[(&str, Target)] = &[
    ("frame_decode", frame_decode),
    ("command_payload", command_payload),
    ("deploy_key", deploy_key),
    ("tunnel_control", tunnel_control),
    ("desktop_message", desktop_message),
    ("rule_engine", rule_engine),
];

#[cfg(test)]
mod tests {
    use super::*;

    /// xorshift64*: deterministic, dependency-free input generator.
    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }
        fn below(&mut self, n: usize) -> usize {
            (self.next() % n.max(1) as u64) as usize
        }
    }

    /// Random bytes, then mutations of the seeds (bit flips, truncation, splices, insertions)
    /// so the decoders get past their first checks.
    fn inputs(target: &str, count: usize, seed: u64) -> Vec<Vec<u8>> {
        let mut rng = Rng(seed);
        let seeds = seeds(target);
        let mut out = Vec::with_capacity(count);
        for i in 0..count {
            if seeds.is_empty() || i % 3 == 0 {
                let len = rng.below(600);
                out.push((0..len).map(|_| rng.next() as u8).collect());
                continue;
            }
            let mut data = seeds[rng.below(seeds.len())].clone();
            for _ in 0..=rng.below(4) {
                match rng.below(5) {
                    0 if !data.is_empty() => {
                        let at = rng.below(data.len());
                        data[at] ^= 1 << rng.below(8);
                    }
                    1 if !data.is_empty() => data.truncate(rng.below(data.len())),
                    2 => {
                        let at = rng.below(data.len() + 1);
                        let byte = rng.next() as u8;
                        data.insert(at, byte);
                    }
                    3 if !data.is_empty() => {
                        let at = rng.below(data.len());
                        data[at] = [0x00, 0xff, 0x7f, 0x80, b'"', b'{', b'['][rng.below(7)];
                    }
                    _ => {
                        let other = &seeds[rng.below(seeds.len())];
                        let cut = rng.below(other.len());
                        data.extend_from_slice(&other[cut..]);
                    }
                }
            }
            out.push(data);
        }
        out
    }

    #[test]
    fn seeds_are_accepted() {
        // Seeds exercise the success paths (round trips and assertions inside the targets).
        for (name, target) in TARGETS {
            let seeds = seeds(name);
            assert!(!seeds.is_empty(), "{name} has seeds");
            for seed in seeds {
                target(&seed);
            }
        }
    }

    #[test]
    fn every_target_survives_random_and_mutated_inputs() {
        for (index, (name, target)) in TARGETS.iter().enumerate() {
            for input in inputs(name, 3000, 0x9E37_79B9_7F4A_7C15 ^ index as u64) {
                target(&input);
            }
        }
    }

    /// Writes the seeds as a starting corpus for cargo-fuzz:
    /// `cargo test -p rustrmm-fuzzing -- --ignored write_seed_corpus`.
    #[test]
    #[ignore = "writes files into fuzz/corpus"]
    fn write_seed_corpus() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fuzz/corpus");
        for (name, _) in TARGETS {
            let dir = root.join(name);
            std::fs::create_dir_all(&dir).expect("mkdir");
            for (i, seed) in seeds(name).iter().enumerate() {
                std::fs::write(dir.join(format!("seed-{i}")), seed).expect("write");
            }
        }
    }
}
