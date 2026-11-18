//! Agent gateway end-to-end: enrollment, mutual-auth handshake, telemetry/inventory ingestion,
//! and refusal of bad signatures, pending and revoked devices — over a real socket.

use std::net::SocketAddr;

use clap::Parser;
use futures::{SinkExt, StreamExt};
use rustrmm_crypto::sign::SigningKey;
use rustrmm_proto::deploy::{EnrollRequest, EnrollResponse};
use rustrmm_proto::handshake::{self, Challenge, Hello, Proof, Rejected, Welcome};
use rustrmm_proto::messages::{Heartbeat, InventoryAck, InventorySection};
use rustrmm_proto::{Frame, Message as _};
use rustrmm_server::state::AppState;
use serde_json::json;
use tokio_tungstenite::tungstenite::Message as WsMessage;

struct Harness {
    state: AppState,
    addr: SocketAddr,
    _dir: tempfile::TempDir,
}

async fn harness() -> Harness {
    let dir = tempfile::tempdir().expect("tempdir");
    let args = rustrmm_server::config::Cli::parse_from([
        "rustrmm-server",
        "--data-dir",
        dir.path().to_str().expect("utf8"),
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
        _dir: dir,
    }
}

/// Creates client → site → enrollment token directly in the database; returns the secret.
async fn token(state: &AppState, require_approval: bool) -> String {
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
        "INSERT INTO enrollment_tokens (id, site_id, name, secret_hash, secret, require_approval, created_at) VALUES (?, ?, 'test', ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&site)
    .bind(rustrmm_crypto::random::sha256_hex(secret.as_bytes()))
    .bind(state.cipher.encrypt_str(&secret, &rustrmm_server::agents::enroll::secret_aad(&id)))
    .bind(require_approval)
    .bind(now)
    .execute(&state.db)
    .await
    .expect("token");
    secret
}

async fn enroll(h: &Harness, secret: &str, key: &SigningKey, serial: &str) -> reqwest::Response {
    reqwest::Client::new()
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
            domain: Some("corp.example.test".into()),
            agent_version: "0.1.0".into(),
        })
        .send()
        .await
        .expect("enroll request")
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

/// Runs the handshake; returns the socket and the last frame (Welcome or Rejected).
async fn connect(h: &Harness, device_id: &str, key: &SigningKey) -> (Ws, Frame) {
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{}/agent/v1/connect", h.addr))
        .await
        .expect("ws");
    let nonce = rustrmm_crypto::random::bytes::<32>().to_vec();
    let hello = Hello {
        device_id: device_id.into(),
        agent_nonce: nonce.clone(),
        protocol_major: rustrmm_proto::PROTOCOL_MAJOR,
        protocol_minor: rustrmm_proto::PROTOCOL_MINOR,
        agent_version: "0.1.0".into(),
        os_family: "windows".into(),
        hostname: "WS-TEST".into(),
        capabilities: vec![],
    };
    ws.send(WsMessage::Binary(
        rustrmm_proto::encode(&hello).expect("hello").into(),
    ))
    .await
    .expect("send");
    let frame = recv(&mut ws).await;
    if frame.is::<Rejected>() {
        return (ws, frame);
    }
    let challenge: Challenge = frame.body().expect("challenge");
    let signed = handshake::challenge_message(
        &nonce,
        &challenge.server_nonce,
        device_id,
        challenge.server_time,
    );
    h.state
        .keys
        .identity_public()
        .verify(&signed, &challenge.signature)
        .expect("server proves its identity");
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
    let frame = recv(&mut ws).await;
    (ws, frame)
}

#[tokio::test]
async fn enroll_connect_and_report() {
    let h = harness().await;
    let secret = token(&h.state, false).await;
    let key = SigningKey::generate();
    let resp = enroll(&h, &secret, &key, "SN001").await;
    assert_eq!(resp.status(), 200);
    let body: EnrollResponse = resp.json().await.expect("json");
    assert_eq!(body.status, "active");
    assert_eq!(body.identity, h.state.keys.identity_public().to_string());

    let (mut ws, frame) = connect(&h, &body.device_id, &key).await;
    let welcome: Welcome = frame.body().expect("welcome");
    assert!(welcome.inventory_hashes.is_empty());
    assert!(h.state.agents.is_online(&body.device_id));

    let hb = Heartbeat {
        uptime_s: 99,
        cpu_pct: 12.5,
        mem_pct: 55.0,
        disk_pct: 61.0,
        logged_in_user: Some("CORP\\alex".into()),
    };
    ws.send(WsMessage::Binary(
        rustrmm_proto::encode(&hb).expect("hb").into(),
    ))
    .await
    .expect("send");
    let section = InventorySection {
        section: "system".into(),
        hash: "h1".into(),
        data: json!({ "hostname": "WS-SN001", "os": { "family": "windows", "name": "Windows 11 Pro", "version": "24H2" }, "device_type": "laptop", "pending_reboot": true }),
    };
    ws.send(WsMessage::Binary(
        rustrmm_proto::encode(&section).expect("inv").into(),
    ))
    .await
    .expect("send");
    let ack: InventoryAck = loop {
        let f = recv(&mut ws).await;
        if f.t == InventoryAck::TYPE {
            break f.body().expect("ack");
        }
    };
    assert_eq!((ack.section.as_str(), ack.hash.as_str()), ("system", "h1"));

    let (online, cpu, device_type, last_user, health): (
        bool,
        Option<f64>,
        Option<String>,
        Option<String>,
        Option<i64>,
    ) = sqlx::query_as(
        "SELECT online, cpu_pct, device_type, last_user, health_score FROM devices WHERE id = ?",
    )
    .bind(&body.device_id)
    .fetch_one(&h.state.db)
    .await
    .expect("device row");
    assert!(online);
    assert_eq!(cpu, Some(12.5));
    assert_eq!(device_type.as_deref(), Some("laptop"));
    assert_eq!(last_user.as_deref(), Some("CORP\\alex"));
    assert_eq!(health, Some(95), "pending restart costs 5 points");

    // Reconnecting returns the stored hash so the agent can skip unchanged sections.
    drop(ws);
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let (_ws, frame) = connect(&h, &body.device_id, &key).await;
    let welcome: Welcome = frame.body().expect("welcome");
    assert_eq!(
        welcome.inventory_hashes.get("system").map(String::as_str),
        Some("h1")
    );
}

#[tokio::test]
async fn refuses_wrong_key_pending_and_revoked_devices() {
    let h = harness().await;
    let secret = token(&h.state, false).await;
    let key = SigningKey::generate();
    let body: EnrollResponse = enroll(&h, &secret, &key, "SN100")
        .await
        .json()
        .await
        .expect("json");

    // Wrong device key → bad_signature.
    let (_ws, frame) = connect(&h, &body.device_id, &SigningKey::generate()).await;
    let rejected: Rejected = frame.body().expect("rejected");
    assert_eq!(rejected.code, "bad_signature");

    // Revoked → refused before the challenge.
    sqlx::query("UPDATE devices SET status = 'revoked' WHERE id = ?")
        .bind(&body.device_id)
        .execute(&h.state.db)
        .await
        .expect("revoke");
    let (_ws, frame) = connect(&h, &body.device_id, &key).await;
    assert_eq!(frame.body::<Rejected>().expect("rejected").code, "revoked");

    // Same hardware enrolling again needs approval (possible clone / reinstall).
    sqlx::query("UPDATE devices SET status = 'active' WHERE id = ?")
        .bind(&body.device_id)
        .execute(&h.state.db)
        .await
        .expect("restore");
    let second_key = SigningKey::generate();
    let dup: EnrollResponse = enroll(&h, &secret, &second_key, "SN100")
        .await
        .json()
        .await
        .expect("json");
    assert_eq!(dup.status, "pending");
    let (_ws, frame) = connect(&h, &dup.device_id, &second_key).await;
    assert_eq!(
        frame.body::<Rejected>().expect("rejected").code,
        "pending_approval"
    );

    // Tokens that require approval park new devices.
    let approval_secret = token(&h.state, true).await;
    let k3 = SigningKey::generate();
    let parked: EnrollResponse = enroll(&h, &approval_secret, &k3, "SN200")
        .await
        .json()
        .await
        .expect("json");
    assert_eq!(parked.status, "pending");

    // Unknown secrets are rejected.
    let resp = enroll(
        &h,
        "not-a-real-secret-value",
        &SigningKey::generate(),
        "SN300",
    )
    .await;
    assert_eq!(resp.status(), 403);
}
