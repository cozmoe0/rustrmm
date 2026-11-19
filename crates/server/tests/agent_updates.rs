//! Agent updates end to end: a stamped release in the distribution directory is imported, a
//! connecting agent running an older build is updated automatically, the `agent_updates` policy
//! can switch that off, newer releases supersede older automatic rollouts and old artifacts are
//! pruned.

use std::net::SocketAddr;
use std::path::Path;
use std::time::Duration;

use clap::Parser;
use futures::{SinkExt, StreamExt};
use rustrmm_crypto::sign::SigningKey;
use rustrmm_proto::commands::{Command, CommandPayload, CommandResult, SignedCommand};
use rustrmm_proto::deploy::{EnrollRequest, EnrollResponse};
use rustrmm_proto::handshake::{self, Challenge, Hello, Proof, Welcome};
use rustrmm_proto::{Frame, Message as _};
use rustrmm_server::agents::releases::{self, UpdateState};
use rustrmm_server::state::AppState;
use sha2::{Digest, Sha256};
use tokio_tungstenite::tungstenite::Message as WsMessage;

struct Harness {
    state: AppState,
    addr: SocketAddr,
    dist: std::path::PathBuf,
    _dir: tempfile::TempDir,
}

async fn harness() -> Harness {
    let dir = tempfile::tempdir().expect("tempdir");
    let dist = dir.path().join("dist");
    std::fs::create_dir_all(&dist).expect("dist");
    let args = rustrmm_server::config::Cli::parse_from([
        "rustrmm-server",
        "--data-dir",
        dir.path().join("data").to_str().expect("utf8"),
        "--agent-dist",
        dist.to_str().expect("utf8"),
        "--tls-mode",
        "proxy",
        "--agent-noise",
        "auto",
        "--console-url",
        "https://rmm.test",
    ])
    .serve;
    let prepared = rustrmm_server::prepare(args, false).await.expect("prepare");
    let state = prepared.state.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    let router = rustrmm_server::listeners::agent_router(state.clone());
    tokio::spawn(async move {
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .expect("serve");
    });
    Harness {
        state,
        addr,
        dist,
        _dir: dir,
    }
}

/// Writes a bundle (Windows and Linux agents) with this version into the distribution directory.
fn publish(dist: &Path, version: &str) {
    let mut files = Vec::new();
    for (platform, file) in [
        ("windows-x86_64", "rustrmm-agent.exe"),
        ("linux-x86_64", "rustrmm-agent"),
    ] {
        let bytes = format!("agent {version} for {platform}").into_bytes();
        let dir = dist.join(platform);
        std::fs::create_dir_all(&dir).expect("platform dir");
        std::fs::write(dir.join(file), &bytes).expect("artifact");
        files.push(serde_json::json!({
            "platform": platform, "file": file, "size_bytes": bytes.len(),
            "sha256": hex::encode(Sha256::digest(&bytes)),
        }));
    }
    let manifest = serde_json::json!({ "version": version, "files": files });
    std::fs::write(
        dist.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).expect("manifest"),
    )
    .expect("write manifest");
}

/// Client → site → enrollment token; returns `(secret, client_id, site_id)`.
async fn token(state: &AppState) -> (String, String, String) {
    let now = rustrmm_common::now();
    let client = rustrmm_common::new_id();
    let site = rustrmm_common::new_id();
    sqlx::query("INSERT INTO clients (id, name, slug, notes, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?)")
        .bind(&client)
        .bind(format!("Client {client}"))
        .bind(format!("client-{client}"))
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await
        .expect("client");
    sqlx::query(
        "INSERT INTO sites (id, client_id, name, created_at, updated_at) VALUES (?, ?, 'HQ', ?, ?)",
    )
    .bind(&site)
    .bind(&client)
    .bind(now)
    .bind(now)
    .execute(&state.db)
    .await
    .expect("site");
    let id = rustrmm_common::new_id();
    let secret = rustrmm_crypto::random::token()[..24].to_string();
    sqlx::query(
        "INSERT INTO enrollment_tokens (id, site_id, name, secret_hash, secret, require_approval, created_at) VALUES (?, ?, 'test', ?, ?, 0, ?)",
    )
    .bind(&id)
    .bind(&site)
    .bind(rustrmm_crypto::random::sha256_hex(secret.as_bytes()))
    .bind(state.cipher.encrypt_str(&secret, &rustrmm_server::agents::enroll::secret_aad(&id)))
    .bind(now)
    .execute(&state.db)
    .await
    .expect("token");
    (secret, client, site)
}

async fn enroll(h: &Harness, secret: &str, key: &SigningKey, serial: &str) -> String {
    let response: EnrollResponse = reqwest::Client::new()
        .post(format!("http://{}/agent/v1/enroll", h.addr))
        .json(&EnrollRequest {
            secret: secret.to_string(),
            public_key: key.public_key().to_string(),
            hostname: format!("WS-{serial}"),
            os_family: "windows".into(),
            os_name: "Windows 11 Pro".into(),
            os_version: "10.0.26100".into(),
            arch: "x86_64".into(),
            hardware_uuid: Some(format!("UUID-{serial}")),
            serial: Some(serial.into()),
            domain: None,
            agent_version: "0.1.0".into(),
        })
        .send()
        .await
        .expect("enroll request")
        .json()
        .await
        .expect("enroll json");
    assert_eq!(response.status, "active");
    response.device_id
}

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn recv(ws: &mut Ws) -> Frame {
    loop {
        match ws.next().await.expect("open").expect("frame") {
            WsMessage::Binary(b) => return Frame::decode(&b).expect("decode"),
            WsMessage::Close(_) => panic!("closed"),
            _ => continue,
        }
    }
}

async fn connect(h: &Harness, device_id: &str, key: &SigningKey, version: &str) -> Ws {
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{}/agent/v1/connect", h.addr))
        .await
        .expect("ws");
    let nonce = rustrmm_crypto::random::bytes::<32>().to_vec();
    let hello = Hello {
        device_id: device_id.into(),
        agent_nonce: nonce.clone(),
        protocol_major: rustrmm_proto::PROTOCOL_MAJOR,
        protocol_minor: rustrmm_proto::PROTOCOL_MINOR,
        agent_version: version.into(),
        os_family: "windows".into(),
        hostname: "WS-TEST".into(),
        capabilities: vec![],
    };
    ws.send(WsMessage::Binary(
        rustrmm_proto::encode(&hello).expect("hello").into(),
    ))
    .await
    .expect("send");
    let challenge: Challenge = recv(&mut ws).await.body().expect("challenge");
    let proof = Proof {
        signature: key.sign(&handshake::proof_message(
            &challenge.server_nonce,
            &nonce,
            device_id,
        )),
    };
    ws.send(WsMessage::Binary(
        rustrmm_proto::encode(&proof).expect("proof").into(),
    ))
    .await
    .expect("send");
    let _welcome: Welcome = recv(&mut ws).await.body().expect("welcome");
    ws
}

/// Waits for the next signed command; returns its id and command.
async fn next_command(ws: &mut Ws) -> (String, Command) {
    let wait = async {
        loop {
            let frame = recv(ws).await;
            if frame.t == SignedCommand::TYPE {
                let signed: SignedCommand = frame.body().expect("signed");
                let payload: CommandPayload =
                    rmp_serde::from_slice(&signed.payload).expect("payload");
                return (payload.cmd_id, payload.command);
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(10), wait)
        .await
        .expect("a command within 10 s")
}

async fn target(state: &AppState, device_id: &str) -> Option<(String, String, String)> {
    sqlx::query_as(
        "SELECT t.status, r.kind, a.version FROM rollout_targets t JOIN rollouts r ON r.id = t.rollout_id
         JOIN agent_releases a ON a.id = r.release_id WHERE t.device_id = ? ORDER BY t.updated_at DESC LIMIT 1",
    )
    .bind(device_id)
    .fetch_optional(&state.db)
    .await
    .expect("target")
}

#[tokio::test]
async fn releases_are_imported_and_agents_update_automatically() {
    let h = harness().await;
    const FIRST: &str = "0.1.0+20261118220341";

    // ---- import: the stamped bundle becomes the latest release; importing again is a no-op
    publish(&h.dist, FIRST);
    assert_eq!(
        releases::import_dist(&h.state)
            .await
            .expect("import")
            .as_deref(),
        Some(FIRST)
    );
    assert_eq!(releases::import_dist(&h.state).await.expect("again"), None);
    let latest = releases::latest_release(&h.state)
        .await
        .expect("latest")
        .expect("a release");
    assert_eq!(latest.version, FIRST);
    assert!(latest.supports("windows", "x86_64"));
    assert!(!latest.supports("macos", "aarch64"));

    // ---- a device on an older build is updated as soon as it connects (default policy: on)
    let (secret, _, _) = token(&h.state).await;
    let key = SigningKey::generate();
    let device = enroll(&h, &secret, &key, "AUTO1").await;
    let mut ws = connect(&h, &device, &key, "0.1.0").await;
    let (cmd_id, command) = next_command(&mut ws).await;
    let Command::UpdateAgent(update) = command else {
        panic!("expected an agent update, got {command:?}");
    };
    assert_eq!(update.version, FIRST);
    assert!(
        update
            .download_base
            .ends_with(&format!("/agent/v1/releases/{FIRST}")),
        "download base points at the versioned artifacts: {}",
        update.download_base
    );
    assert_eq!(
        target(&h.state, &device).await,
        Some(("sent".into(), "auto".into(), FIRST.into()))
    );
    // The versioned artifact downloads (a `+` in the path is fine).
    let artifact = reqwest::get(format!(
        "http://{}/agent/v1/releases/{FIRST}/windows-x86_64/rustrmm-agent.exe",
        h.addr
    ))
    .await
    .expect("download");
    assert_eq!(artifact.status(), 200);

    let attempts = releases::attempts_for(&h.state, &latest.id)
        .await
        .expect("attempts");
    let status = releases::status_for(
        Some(&latest),
        "windows",
        "x86_64",
        "0.1.0",
        attempts.get(&device),
        (true, None),
    );
    assert_eq!(status.state, UpdateState::Updating);
    assert_eq!(status.attempt_kind.as_deref(), Some("auto"));

    // ---- reconnecting on the new build completes the target and the rollout
    let _ = cmd_id;
    drop(ws);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let _ws = connect(&h, &device, &key, FIRST).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(
        target(&h.state, &device).await,
        Some(("succeeded".into(), "auto".into(), FIRST.into()))
    );
    let rollout_status: String =
        sqlx::query_scalar("SELECT status FROM rollouts WHERE kind = 'auto' AND release_id = ?")
            .bind(&latest.id)
            .fetch_one(&h.state.db)
            .await
            .expect("auto rollout");
    assert_eq!(rollout_status, "completed");

    // ---- a site whose policy turns automatic updates off is left alone
    let (secret_off, _, site_off) = token(&h.state).await;
    let now = rustrmm_common::now();
    let policy = rustrmm_common::new_id();
    sqlx::query("INSERT INTO policies (id, name, document, created_at, updated_at) VALUES (?, 'No auto updates', ?, ?, ?)")
        .bind(&policy)
        .bind(r#"{"agent_updates":{"auto_update":false}}"#)
        .bind(now)
        .bind(now)
        .execute(&h.state.db)
        .await
        .expect("policy");
    sqlx::query("INSERT INTO policy_assignments (id, policy_id, target_type, target_id, created_at) VALUES (?, ?, 'site', ?, ?)")
        .bind(rustrmm_common::new_id())
        .bind(&policy)
        .bind(&site_off)
        .bind(now)
        .execute(&h.state.db)
        .await
        .expect("assignment");
    let key_off = SigningKey::generate();
    let device_off = enroll(&h, &secret_off, &key_off, "MANUAL1").await;
    let _ws_off = connect(&h, &device_off, &key_off, "0.1.0").await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(releases::sweep(&h.state).await.expect("sweep"), 0);
    assert_eq!(
        target(&h.state, &device_off).await,
        None,
        "policy off: not queued"
    );
    let effective =
        rustrmm_server::automation::policies::effective_for_device(&h.state.db, &device_off)
            .await
            .expect("effective")
            .expect("active device");
    assert_eq!(
        releases::auto_update_of(&effective),
        (false, Some("No auto updates".to_string()))
    );

    // ---- "Update now" (a manual rollout) still updates it
    let created = releases::create_rollout(
        &h.state,
        &latest.id,
        &releases::RolloutScope::Devices {
            ids: vec![device_off.clone(), device.clone()],
        },
        100,
        "tester",
    )
    .await
    .expect("manual rollout");
    assert_eq!(
        created.targeted, 1,
        "the device already on the release is skipped"
    );
    assert_eq!(
        target(&h.state, &device_off).await,
        Some(("sent".into(), "manual".into(), FIRST.into()))
    );

    // ---- development agents verify but do not install: the attempt is skipped, not failed
    let cmd: String =
        sqlx::query_scalar("SELECT command_id FROM rollout_targets WHERE device_id = ?")
            .bind(&device_off)
            .fetch_one(&h.state.db)
            .await
            .expect("command id");
    releases::on_update_result(
        &h.state,
        &device_off,
        &CommandResult {
            cmd_id: cmd,
            status: "succeeded".into(),
            message: "verified and staged at C:\\x (development mode: not installed)".into(),
            data: serde_json::Value::Null,
        },
    )
    .await
    .expect("result");
    assert_eq!(
        target(&h.state, &device_off).await.map(|t| t.0),
        Some("skipped".into())
    );

    // ---- newer releases: older automatic rollouts close and old artifacts are pruned
    let (secret_late, _, _) = token(&h.state).await;
    let key_late = SigningKey::generate();
    let device_late = enroll(&h, &secret_late, &key_late, "LATE1").await;
    // Queued for FIRST but offline: it must not keep FIRST's files alive once superseded.
    let first_auto: String =
        sqlx::query_scalar("SELECT id FROM rollouts WHERE kind = 'auto' AND release_id = ?")
            .bind(&latest.id)
            .fetch_one(&h.state.db)
            .await
            .expect("auto rollout");
    sqlx::query("UPDATE rollouts SET status = 'active' WHERE id = ?")
        .bind(&first_auto)
        .execute(&h.state.db)
        .await
        .expect("reopen");
    sqlx::query("INSERT INTO rollout_targets (rollout_id, device_id, status, updated_at) VALUES (?, ?, 'pending', ?)")
        .bind(&first_auto)
        .bind(&device_late)
        .bind(rustrmm_common::now())
        .execute(&h.state.db)
        .await
        .expect("queued target");
    // The manual rollout's open target would keep FIRST alive too; finish it.
    sqlx::query("UPDATE rollout_targets SET status = 'failed' WHERE device_id = ?")
        .bind(&device_off)
        .execute(&h.state.db)
        .await
        .expect("finish manual");
    for version in [
        "0.1.0+20261119080000",
        "0.1.0+20261120080000",
        "0.1.0+20261121080000",
    ] {
        publish(&h.dist, version);
        assert_eq!(
            releases::import_dist(&h.state)
                .await
                .expect("import")
                .as_deref(),
            Some(version)
        );
    }
    let late = target(&h.state, &device_late).await.expect("late target");
    assert_eq!(late.0, "skipped", "superseded automatic target");
    let first_status: String = sqlx::query_scalar("SELECT status FROM rollouts WHERE id = ?")
        .bind(&first_auto)
        .fetch_one(&h.state.db)
        .await
        .expect("status");
    assert_eq!(first_status, "completed");
    let pruned: Vec<String> = sqlx::query_scalar(
        "SELECT version FROM agent_releases WHERE pruned_at IS NOT NULL ORDER BY version",
    )
    .fetch_all(&h.state.db)
    .await
    .expect("pruned");
    assert_eq!(
        pruned,
        vec![FIRST.to_string()],
        "only the oldest of four is pruned"
    );
    assert!(
        !releases::releases_root(&h.state).join(FIRST).exists(),
        "its files are gone"
    );
    assert_eq!(
        releases::latest_release(&h.state)
            .await
            .expect("latest")
            .map(|r| r.version)
            .as_deref(),
        Some("0.1.0+20261121080000")
    );
    let refused = releases::create_rollout(
        &h.state,
        &latest.id,
        &releases::RolloutScope::All,
        100,
        "tester",
    )
    .await;
    assert!(refused.is_err(), "a pruned release cannot be rolled out");
}
