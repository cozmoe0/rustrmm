//! Phase 11 end to end against the real routers: reports (JSON, CSV, PDF magic bytes, queued
//! runs, scheduled per-client e-mail to a scripted SMTP server), dashboards (own/shared, default,
//! widgets), OIDC single sign-on against an in-process fake issuer (discovery, JWKS, token
//! endpoint; ES256 and RS256 ID tokens; role mappings; MFA claims; state/nonce checks; SSO
//! enforcement with owner break glass), API tokens (bearer auth, client scope, step-up and
//! interactive refusals, revocation, rate limit), webhooks (signed deliveries to a local
//! receiver, SSRF guard, client scoping, test, redelivery, retry scheduling), branding (SVG
//! sanitising, PNG logos, public branding, client logos on PDFs), and the carried-over polish
//! routes (patching, tickets, software explorer).

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use clap::Parser;
use http_body_util::BodyExt;
use rustrmm_crypto::sign::SigningKey;
use rustrmm_proto::deploy::{EnrollRequest, EnrollResponse};
use rustrmm_server::state::AppState;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tower::ServiceExt;

const ORIGIN: &str = "https://rmm.test";

// ------------------------------------------------------------------ console client

struct Client {
    router: Router,
    cookie: Option<String>,
    csrf: Option<String>,
    bearer: Option<String>,
}

struct Raw {
    status: StatusCode,
    body: Vec<u8>,
    headers: HeaderMap,
}

impl Client {
    fn new(router: Router) -> Self {
        Self {
            router,
            cookie: None,
            csrf: None,
            bearer: None,
        }
    }

    fn with_token(router: Router, token: &str) -> Self {
        Self {
            router,
            cookie: None,
            csrf: None,
            bearer: Some(token.to_string()),
        }
    }

    async fn raw(
        &mut self,
        method: Method,
        path: &str,
        content_type: Option<&str>,
        body: Vec<u8>,
    ) -> Raw {
        let mut req = Request::builder().method(method).uri(path);
        if self.bearer.is_none() {
            req = req.header(header::ORIGIN, ORIGIN);
        }
        if let Some(cookie) = &self.cookie {
            req = req.header(header::COOKIE, cookie);
        }
        if let Some(csrf) = &self.csrf {
            req = req.header("x-csrf-token", csrf);
        }
        if let Some(token) = &self.bearer {
            req = req.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        if let Some(ct) = content_type {
            req = req.header(header::CONTENT_TYPE, ct);
        }
        let response = self
            .router
            .clone()
            .oneshot(req.body(Body::from(body)).expect("request"))
            .await
            .expect("response");
        let status = response.status();
        let headers = response.headers().clone();
        for set_cookie in headers.get_all(header::SET_COOKIE) {
            let raw = set_cookie.to_str().expect("cookie").to_string();
            let pair = raw.split(';').next().unwrap_or_default().to_string();
            if pair.starts_with("__Host-rustrmm_session=") {
                self.cookie = (!pair.ends_with('=')).then_some(pair);
            }
        }
        let body = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes()
            .to_vec();
        Raw {
            status,
            body,
            headers,
        }
    }

    async fn call(
        &mut self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let (ct, bytes) = match body {
            Some(b) => (Some("application/json"), b.to_string().into_bytes()),
            None => (None, Vec::new()),
        };
        let raw = self.raw(method, path, ct, bytes).await;
        let value: Value = if raw.body.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&raw.body).unwrap_or(Value::Null)
        };
        if let Some(csrf) = value
            .pointer("/me/csrf_token")
            .or_else(|| value.pointer("/csrf_token"))
            .and_then(Value::as_str)
        {
            self.csrf = Some(csrf.to_string());
        }
        (raw.status, value)
    }

    async fn get(&mut self, path: &str) -> (StatusCode, Value) {
        self.call(Method::GET, path, None).await
    }
    async fn post(&mut self, path: &str, body: Value) -> (StatusCode, Value) {
        self.call(Method::POST, path, Some(body)).await
    }
    async fn put(&mut self, path: &str, body: Value) -> (StatusCode, Value) {
        self.call(Method::PUT, path, Some(body)).await
    }
    async fn delete(&mut self, path: &str) -> (StatusCode, Value) {
        self.call(Method::DELETE, path, None).await
    }
}

fn totp_code(secret_b32: &str) -> String {
    let secret = data_encoding::BASE32_NOPAD
        .decode(secret_b32.as_bytes())
        .expect("base32");
    let step = (chrono::Utc::now().timestamp() / 30) as u64;
    format!("{:06}", rustrmm_server::auth::totp::code_at(&secret, step))
}

async fn sign_in(client: &mut Client, email: &str, password: &str) {
    let (status, body) = client
        .post(
            "/api/v1/auth/login",
            json!({ "email": email, "password": password }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let challenge = body["challenge_token"]
        .as_str()
        .expect("challenge")
        .to_string();
    let (_, setup) = client
        .post(
            "/api/v1/auth/mfa/setup/totp/start",
            json!({ "challenge_token": challenge }),
        )
        .await;
    let secret = setup["secret"].as_str().expect("secret").to_string();
    let (status, done) = client
        .post(
            "/api/v1/auth/mfa/setup/totp/finish",
            json!({ "challenge_token": challenge, "code": totp_code(&secret) }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{done}");
    let (status, me) = client.get("/api/v1/auth/me").await;
    assert_eq!(status, StatusCode::OK, "{me}");
}

async fn set_step_up(state: &AppState, email: &str) {
    sqlx::query(
        "UPDATE sessions SET stepped_up_until = ? WHERE user_id = (SELECT id FROM users WHERE email = ?)",
    )
    .bind(rustrmm_common::now() + chrono::Duration::minutes(5))
    .bind(email)
    .execute(&state.db)
    .await
    .expect("step-up");
}

// ------------------------------------------------------------------ server and fakes

async fn start() -> (AppState, Router, SocketAddr, tempfile::TempDir) {
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
        ORIGIN,
    ])
    .serve;
    let prepared = rustrmm_server::prepare(args, false).await.expect("prepare");
    let state = prepared.state.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    let agents = rustrmm_server::listeners::agent_router(state.clone());
    tokio::spawn(async move {
        axum::serve(
            listener,
            agents.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .expect("serve");
    });
    rustrmm_server::webhooks::spawn(state.clone());
    let console = rustrmm_server::listeners::console_router(state.clone());
    (state, console, addr, dir)
}

async fn enroll(state: &AppState, addr: SocketAddr, site_id: &str, host: &str) -> String {
    let key = SigningKey::generate();
    let token_id = rustrmm_common::new_id();
    let secret = rustrmm_crypto::random::token()[..24].to_string();
    sqlx::query("INSERT INTO enrollment_tokens (id, site_id, name, secret_hash, secret, require_approval, created_at) VALUES (?, ?, 't', ?, ?, 0, ?)")
        .bind(&token_id)
        .bind(site_id)
        .bind(rustrmm_crypto::random::sha256_hex(secret.as_bytes()))
        .bind(state.cipher.encrypt_str(&secret, &rustrmm_server::agents::enroll::secret_aad(&token_id)))
        .bind(rustrmm_common::now())
        .execute(&state.db)
        .await
        .expect("token");
    let resp: EnrollResponse = reqwest::Client::new()
        .post(format!("http://{addr}/agent/v1/enroll"))
        .json(&EnrollRequest {
            secret,
            public_key: key.public_key().to_string(),
            hostname: host.into(),
            os_family: "windows".into(),
            os_name: "Windows 11 Pro".into(),
            os_version: "10.0.26100".into(),
            arch: "x86_64".into(),
            hardware_uuid: Some(format!("UUID-{host}")),
            serial: Some(format!("SN-{host}")),
            domain: None,
            agent_version: "0.1.0".into(),
        })
        .send()
        .await
        .expect("enroll")
        .json()
        .await
        .expect("json");
    assert_eq!(resp.status, "active");
    resp.device_id
}

async fn inventory(state: &AppState, device: &str, section: &str, data: Value) {
    sqlx::query(
        "INSERT OR REPLACE INTO device_inventory (device_id, section, data, hash, collected_at) VALUES (?, ?, ?, 'h', ?)",
    )
    .bind(device)
    .bind(section)
    .bind(data.to_string())
    .bind(rustrmm_common::now())
    .execute(&state.db)
    .await
    .expect("inventory");
}

/// A scripted SMTP server: every delivered message (the DATA section) is sent on the channel.
async fn fake_smtp() -> (u16, mpsc::UnboundedReceiver<String>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        loop {
            let Ok((sock, _)) = listener.accept().await else {
                return;
            };
            let tx = tx.clone();
            tokio::spawn(async move {
                let (read, mut write) = sock.into_split();
                let mut lines = BufReader::new(read).lines();
                write.write_all(b"220 fake ESMTP\r\n").await.expect("greet");
                let mut data: Option<String> = None;
                while let Ok(Some(line)) = lines.next_line().await {
                    if let Some(buf) = data.as_mut() {
                        if line == "." {
                            let _ = tx.send(data.take().unwrap_or_default());
                            write.write_all(b"250 queued\r\n").await.expect("queued");
                        } else {
                            buf.push_str(line.strip_prefix('.').unwrap_or(&line));
                            buf.push('\n');
                        }
                        continue;
                    }
                    let reply: &[u8] = if line.starts_with("EHLO") {
                        b"250-fake\r\n250 PIPELINING\r\n"
                    } else if line == "DATA" {
                        data = Some(String::new());
                        b"354 go ahead\r\n"
                    } else if line == "QUIT" {
                        write.write_all(b"221 bye\r\n").await.expect("bye");
                        return;
                    } else {
                        b"250 ok\r\n"
                    };
                    write.write_all(reply).await.expect("reply");
                }
            });
        }
    });
    (port, rx)
}

/// A local webhook receiver: records `(headers, body)` of every POST and answers 200.
async fn receiver() -> (
    u16,
    mpsc::UnboundedReceiver<(HashMap<String, String>, String)>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        loop {
            let Ok((sock, _)) = listener.accept().await else {
                return;
            };
            let tx = tx.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(sock);
                let mut headers = HashMap::new();
                let mut line = String::new();
                if reader.read_line(&mut line).await.unwrap_or(0) == 0 {
                    return;
                }
                loop {
                    line.clear();
                    if reader.read_line(&mut line).await.unwrap_or(0) == 0 {
                        return;
                    }
                    let l = line.trim_end();
                    if l.is_empty() {
                        break;
                    }
                    if let Some((k, v)) = l.split_once(':') {
                        headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
                    }
                }
                let len: usize = headers
                    .get("content-length")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
                let mut body = vec![0u8; len];
                reader.read_exact(&mut body).await.expect("body");
                let mut sock = reader.into_inner();
                let _ = sock
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .await;
                let _ = tx.send((headers, String::from_utf8_lossy(&body).to_string()));
            });
        }
    });
    (port, rx)
}

async fn next_within<T>(rx: &mut mpsc::UnboundedReceiver<T>, what: &str) -> T {
    tokio::time::timeout(Duration::from_secs(20), rx.recv())
        .await
        .unwrap_or_else(|_| panic!("{what} in time"))
        .expect("channel open")
}

// ------------------------------------------------------------------ fake OIDC issuer

const RSA_PKCS1_DER_B64: &str = "MIIEpQIBAAKCAQEAmyOhxD3VqiJUzQKkRShizvVl9/uQ1O1D6+n0MXqLtx99a3Kxq8tnLLfWx6KRRQ7JmJWQQ7+BgiCeSL7Mpv2ifXlHkOPDnUapOPJPXTFNmGYQrBQa3TM2e/Mj66gHTQVARvffW9dbMPCRzaS9TwtSEHPcBOj5hjrX9kZh4R0MPYowBKSawmuOtE6mqdh3Bxw5sB4GY3rGK3tlkS+6FKbxx/SZR68vXSqsCRsjAejJHxfwo/MOIx3vALcPmKV+F7lKnZyCvRTZHdYHOK5FGklBsuyPLeOm2ASJONkghLMwbIal8I9i4JDQWt8CitZ0DNR/57mnYTDBWrKhy8wDZysnNwIDAQABAoIBAClBHu3T8aMF8R35M1yuoiPdzulUTM3KcFLmSkj0CP4/0fbGL6f69WtHUcaRnObLyWEZeJ0DanmDmgPHNR28+b47B4RohOaoWSyrBt7F0xgRICLaT9B9o2HvpKAwdQyOtmqI1K0UBgxsFKGmSq8f2AlG/f2SRHRk5nP3gGS/+DbOw/CiWU8S/DJP4RNE3wLD2xbyF2uopLrQ+AoEHYTu5zpdJAjC0F5S/Fc6DREjqd1QRlqM8Z+p6RKthDOn3BF2uWQ+hR235CyyejN07mGcjx8YQSL+6CBl0jYj0C86HcygtUkYaGE17lJA/LAOZdsBBYDLVY8lEgXh5hwSjals6d0CgYEAzQp0EIjck2SpM69h0dl/c4j8UjNe1+CSDzSZo4Rw1SKO+DHivuyc7blRGYIQsl88Spg+4XozJsCKgatOismRh4F4LDd4SHgA7tHUIAfRV4Fg+J22NNhBI9q0mWB8E8e4Poj0sM09eSPQ6i+kEN5PBicJGTJW9RQ0oWUORMjezFUCgYEAwbI6rS3xNLaJinbvY2HZlyRrNjNLt5jdh3f48o0t3IXWs931fog6U7q61ioVdhOqnsUJM578j3AiOsDHQzJDXZ8C6CoCGZTR31s5N5hKPBATxTpTE+xrBdQKJ9X7ePDy5MvqYPdQyqYytZsd2lgDc7fR1EB7yHx2WTbK4X+rcVsCgYEAx72uMUlSL1e5KPtp/Ia3jPJecylN9Fj1kFB6dvuW+1oOEqRuMfXILiEAayv0Xf8+eaB0aSyk1dRtWUJrYfJYjbvHOLPUviwBJKVN0uIqwebsc2UX0cT1OBtfIacHWDGQP4Mlc3KMtwz4AJrmZfRa4TB3wY7zfQ3w82TBkKppuH0CgYEAvlp/m63ovBsftDoKLKr/AbBCxLNImBfcrcNTnlrsVSoaxA0/s6gBWkPKVapqCO5u4TVWQ6rdHcHfgcnuibUdyyX3311ZTvaYAl9OLbq2SayrIUqeVpgi3Uly6Y87YbG5ouxbXAvxFBadAyh8ABY63kAqL+NnQrI+RJK6cz3aqL0CgYEAh6HF02QNYHhpCDh544zrl6xocMjygUY/VFoDgz/uOBe76AiArwV+Qvik+KTm3m1ykc4ve3bp0TLCGZHbI2BujL5KXC5HROOti9rMSnQFAe+tDZbW0BJG4QrPvSWI6DnQKke0UV93fSUHAjU7TpPqFmxXgezaaSXWLq3fbx8zAWk=";

struct Pending {
    challenge: String,
    redirect_uri: String,
    claims: Value,
    alg: &'static str,
}

struct Issuer {
    url: String,
    ec: ring::signature::EcdsaKeyPair,
    rsa: ring::signature::RsaKeyPair,
    codes: Mutex<HashMap<String, Pending>>,
}

impl Issuer {
    fn sign(&self, alg: &str, claims: &Value) -> String {
        let rng = ring::rand::SystemRandom::new();
        let kid = if alg == "ES256" { "ec1" } else { "rsa1" };
        let header =
            URL_SAFE_NO_PAD.encode(json!({ "alg": alg, "kid": kid, "typ": "JWT" }).to_string());
        let payload = URL_SAFE_NO_PAD.encode(claims.to_string());
        let input = format!("{header}.{payload}");
        let sig = if alg == "ES256" {
            self.ec
                .sign(&rng, input.as_bytes())
                .expect("sign")
                .as_ref()
                .to_vec()
        } else {
            let mut sig = vec![0u8; self.rsa.public().modulus_len()];
            self.rsa
                .sign(
                    &ring::signature::RSA_PKCS1_SHA256,
                    &rng,
                    input.as_bytes(),
                    &mut sig,
                )
                .expect("sign");
            sig
        };
        format!("{input}.{}", URL_SAFE_NO_PAD.encode(sig))
    }
}

async fn fake_issuer() -> Arc<Issuer> {
    use axum::extract::State;
    use axum::routing::{get, post};
    use ring::signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, KeyPair, RsaKeyPair};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let url = format!("http://{}", listener.local_addr().expect("addr"));
    let rng = ring::rand::SystemRandom::new();
    let pkcs8 =
        EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).expect("ec key");
    let ec = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng)
        .expect("ec");
    let rsa = RsaKeyPair::from_der(&STANDARD.decode(RSA_PKCS1_DER_B64).expect("b64")).expect("rsa");
    let issuer = Arc::new(Issuer {
        url: url.clone(),
        ec,
        rsa,
        codes: Mutex::new(HashMap::new()),
    });
    let discovery = |State(i): State<Arc<Issuer>>| async move {
        axum::Json(json!({
            "issuer": i.url, "authorization_endpoint": format!("{}/authorize", i.url),
            "token_endpoint": format!("{}/token", i.url), "jwks_uri": format!("{}/jwks", i.url),
            "token_endpoint_auth_methods_supported": ["client_secret_basic"],
            "id_token_signing_alg_values_supported": ["ES256", "RS256"],
        }))
    };
    let jwks = |State(i): State<Arc<Issuer>>| async move {
        let ec_pub = i.ec.public_key().as_ref().to_vec();
        let rsa = ring::rsa::PublicKeyComponents::<Vec<u8>>::from(i.rsa.public());
        axum::Json(json!({ "keys": [
            { "kty": "EC", "crv": "P-256", "kid": "ec1", "use": "sig", "alg": "ES256",
              "x": URL_SAFE_NO_PAD.encode(&ec_pub[1..33]), "y": URL_SAFE_NO_PAD.encode(&ec_pub[33..65]) },
            { "kty": "RSA", "kid": "rsa1", "use": "sig", "alg": "RS256",
              "n": URL_SAFE_NO_PAD.encode(&rsa.n), "e": URL_SAFE_NO_PAD.encode(&rsa.e) },
        ] }))
    };
    let token = |State(i): State<Arc<Issuer>>, headers: HeaderMap, body: String| async move {
        let form: HashMap<String, String> = url::form_urlencoded::parse(body.as_bytes())
            .into_owned()
            .collect();
        let expected = format!("Basic {}", STANDARD.encode("rmm-app:s3cret-value"));
        if headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            != Some(expected.as_str())
        {
            return (
                StatusCode::UNAUTHORIZED,
                axum::Json(json!({ "error": "invalid_client" })),
            );
        }
        let Some(p) = i
            .codes
            .lock()
            .expect("lock")
            .remove(form.get("code").map(String::as_str).unwrap_or(""))
        else {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(json!({ "error": "invalid_grant" })),
            );
        };
        let verifier = form.get("code_verifier").cloned().unwrap_or_default();
        let challenge = URL_SAFE_NO_PAD.encode(rustrmm_crypto::random::sha256(verifier.as_bytes()));
        if challenge != p.challenge
            || form.get("grant_type").map(String::as_str) != Some("authorization_code")
            || form.get("redirect_uri") != Some(&p.redirect_uri)
        {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(json!({ "error": "invalid_grant", "detail": "pkce" })),
            );
        }
        let id_token = i.sign(p.alg, &p.claims);
        (
            StatusCode::OK,
            axum::Json(
                json!({ "access_token": "at", "token_type": "Bearer", "id_token": id_token }),
            ),
        )
    };
    let app = Router::new()
        .route("/.well-known/openid-configuration", get(discovery))
        .route("/jwks", get(jwks))
        .route("/token", post(token))
        .with_state(issuer.clone());
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("issuer");
    });
    issuer
}

fn query_params(url: &str) -> HashMap<String, String> {
    url::Url::parse(url)
        .expect("url")
        .query_pairs()
        .into_owned()
        .collect()
}

/// One browser round trip through the SSO flow. Returns (callback Location, session cookie).
async fn sso_login(
    router: &Router,
    issuer: &Issuer,
    provider: &str,
    claims_for: impl Fn(&str) -> Value,
    alg: &'static str,
    tamper_state: bool,
) -> (String, Option<String>) {
    let start = router
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/v1/auth/oidc/{provider}/start?return_to=/devices"
                ))
                .body(Body::empty())
                .expect("req"),
        )
        .await
        .expect("start");
    assert_eq!(start.status(), StatusCode::SEE_OTHER);
    let location = start.headers()[header::LOCATION]
        .to_str()
        .expect("loc")
        .to_string();
    assert!(
        location.starts_with(&format!("{}/authorize?", issuer.url)),
        "{location}"
    );
    let flow_cookie = start
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|v| v.to_str().expect("cookie").to_string())
        .find(|c| c.starts_with("__Host-rustrmm_oidc="))
        .expect("flow cookie");
    assert!(
        flow_cookie.contains("HttpOnly")
            && flow_cookie.contains("Secure")
            && flow_cookie.contains("SameSite=Lax")
    );
    let flow_cookie = flow_cookie.split(';').next().expect("pair").to_string();
    let q = query_params(&location);
    assert_eq!(q["code_challenge_method"], "S256");
    assert_eq!(q["client_id"], "rmm-app");
    let code = format!("code-{}", rustrmm_common::new_id());
    issuer.codes.lock().expect("lock").insert(
        code.clone(),
        Pending {
            challenge: q["code_challenge"].clone(),
            redirect_uri: q["redirect_uri"].clone(),
            claims: claims_for(&q["nonce"]),
            alg,
        },
    );
    let state = if tamper_state {
        "forged".to_string()
    } else {
        q["state"].clone()
    };
    let callback = router
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/v1/auth/oidc/{provider}/callback?code={code}&state={state}"
                ))
                .header(header::COOKIE, flow_cookie)
                .body(Body::empty())
                .expect("req"),
        )
        .await
        .expect("callback");
    assert_eq!(callback.status(), StatusCode::SEE_OTHER);
    let location = callback.headers()[header::LOCATION]
        .to_str()
        .expect("loc")
        .to_string();
    let session = callback
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|v| v.to_str().expect("cookie").to_string())
        .find(|c| {
            c.starts_with("__Host-rustrmm_session=") && !c.starts_with("__Host-rustrmm_session=;")
        })
        .map(|c| c.split(';').next().expect("pair").to_string());
    (location, session)
}

fn hmac_hex(secret: &str, data: &[u8]) -> String {
    use hmac::{KeyInit, Mac};
    let mut mac =
        <hmac::Hmac<sha2::Sha256> as KeyInit>::new_from_slice(secret.as_bytes()).expect("mac");
    mac.update(data);
    hex::encode(mac.finalize().into_bytes())
}

fn multipart(boundary: &str, file_name: &str, data: &[u8]) -> Vec<u8> {
    let mut out = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{file_name}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
    )
    .into_bytes();
    out.extend_from_slice(data);
    out.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    out
}

/// A valid 2×2 opaque RGB PNG.
fn tiny_png() -> Vec<u8> {
    fn crc(data: &[u8]) -> u32 {
        let mut c = 0xffff_ffffu32;
        for b in data {
            c ^= *b as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 {
                    0xedb8_8320 ^ (c >> 1)
                } else {
                    c >> 1
                };
            }
        }
        !c
    }
    let chunk = |out: &mut Vec<u8>, kind: &[u8], data: &[u8]| {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let mut body = kind.to_vec();
        body.extend_from_slice(data);
        out.extend_from_slice(&body);
        out.extend_from_slice(&crc(&body).to_be_bytes());
    };
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&2u32.to_be_bytes());
    ihdr.extend_from_slice(&2u32.to_be_bytes());
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
    let raw = [0u8, 224, 112, 63, 224, 112, 63, 0, 20, 20, 20, 20, 20, 20];
    let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    std::io::Write::write_all(&mut z, &raw).expect("deflate");
    let idat = z.finish().expect("finish");
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    chunk(&mut png, b"IHDR", &ihdr);
    chunk(&mut png, b"IDAT", &idat);
    chunk(&mut png, b"IEND", &[]);
    png
}

// ------------------------------------------------------------------ the test

#[tokio::test]
async fn reports_dashboards_sso_tokens_webhooks_branding_and_polish() {
    let (state, router, addr, _dir) = start().await;
    let mut owner = Client::new(router.clone());
    let token = state.setup.current_token().expect("setup token");
    let (status, body) = owner
        .post(
            "/api/v1/setup/complete",
            json!({
                "setup_token": token, "organization_name": "Northwind IT",
                "owner": { "name": "Olivia Owner", "email": "owner@example.com", "password": "correct-horse-battery-staple" },
                "first_client": { "name": "Acme Dental" }, "first_site": { "name": "Main Office" }
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    sign_in(
        &mut owner,
        "owner@example.com",
        "correct-horse-battery-staple",
    )
    .await;
    set_step_up(&state, "owner@example.com").await;

    let acme: String = sqlx::query_scalar("SELECT id FROM clients WHERE name = 'Acme Dental'")
        .fetch_one(&state.db)
        .await
        .expect("acme");
    let acme_site: String = sqlx::query_scalar("SELECT id FROM sites WHERE client_id = ?")
        .bind(&acme)
        .fetch_one(&state.db)
        .await
        .expect("site");
    let (status, globex) = owner
        .post("/api/v1/clients", json!({ "name": "Globex" }))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{globex}");
    let globex = globex["id"].as_str().expect("id").to_string();
    let (status, gsite) = owner
        .post(
            &format!("/api/v1/clients/{globex}/sites"),
            json!({ "name": "HQ" }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{gsite}");
    let globex_site = gsite["id"].as_str().expect("site").to_string();

    // ---- devices with inventory
    let ws1 = enroll(&state, addr, &acme_site, "ACME-WS1").await;
    let gx1 = enroll(&state, addr, &globex_site, "GLOBEX-WS1").await;
    inventory(
        &state,
        &ws1,
        "hardware",
        json!({ "cpu": { "model": "Intel Core i5" }, "memory": { "total_bytes": 17179869184u64 },
        "disks": [{ "size_bytes": 512110190592u64 }], "bios": { "date": "2019-03-01" } }),
    )
    .await;
    inventory(&state, &ws1, "security", json!({ "antivirus": [{ "name": "Defender", "enabled": true, "up_to_date": true }],
        "firewall": { "enabled": true }, "encryption": { "system_volume_encrypted": false },
        "local_admins": ["WS1\\Administrator", "ACME\\Domain Admins", "WS1\\dana"], "uac_enabled": true,
        "smb1_enabled": false, "autologon_enabled": false })).await;
    sqlx::query("UPDATE devices SET health_score = 80, disk_pct = 93 WHERE id = ?")
        .bind(&ws1)
        .execute(&state.db)
        .await
        .expect("health");

    // ====================================================== reports
    let (status, types) = owner.get("/api/v1/reports/types").await;
    assert_eq!(status, StatusCode::OK, "{types}");
    assert_eq!(types["items"].as_array().expect("types").len(), 9);

    let (status, run) = owner
        .post("/api/v1/reports/run", json!({ "type": "executive_summary", "parameters": { "client_id": acme }, "format": "json" }))
        .await;
    assert_eq!(status, StatusCode::OK, "{run}");
    let report = &run["report"];
    assert_eq!(report["type"], "executive_summary");
    assert_eq!(report["client"]["name"], "Acme Dental");
    let sections = report["sections"].as_array().expect("sections");
    assert!(sections.iter().any(|s| s["kind"] == "kpis"));
    assert!(sections.iter().any(|s| s["kind"] == "chart"));
    let recs = sections
        .iter()
        .find(|s| s["title"] == "Recommendations")
        .expect("recommendations");
    assert!(
        recs["items"]
            .as_array()
            .expect("items")
            .iter()
            .any(|i| i.as_str().is_some_and(|t| t.contains("unencrypted"))),
        "{recs}"
    );
    let kpis = &sections[0]["items"];
    assert_eq!(kpis[0]["label"], "Devices");
    assert_eq!(kpis[0]["value"], 1, "only Acme's device");

    // CSV
    let raw = owner
        .raw(
            Method::POST,
            "/api/v1/reports/run",
            Some("application/json"),
            json!({ "type": "hardware_inventory", "parameters": {}, "format": "csv" })
                .to_string()
                .into_bytes(),
        )
        .await;
    assert_eq!(raw.status, StatusCode::OK);
    assert!(
        raw.headers[header::CONTENT_TYPE]
            .to_str()
            .expect("ct")
            .starts_with("text/csv")
    );
    let csv = String::from_utf8(raw.body).expect("utf8");
    assert!(
        csv.contains("ACME-WS1") && csv.contains("GLOBEX-WS1") && csv.contains("Intel Core i5"),
        "{csv}"
    );
    let csv_run = raw.headers["x-report-run-id"]
        .to_str()
        .expect("run")
        .to_string();

    // PDF
    let raw = owner
        .raw(Method::POST, "/api/v1/reports/run", Some("application/json"),
             json!({ "type": "security_posture", "parameters": { "client_id": acme }, "format": "pdf" }).to_string().into_bytes())
        .await;
    assert_eq!(raw.status, StatusCode::OK);
    assert_eq!(raw.headers[header::CONTENT_TYPE], "application/pdf");
    assert!(raw.body.starts_with(b"%PDF-"), "PDF magic bytes");
    assert!(raw.body.windows(5).any(|w| w == b"%%EOF"));

    // Queued run: 202, poll, download.
    let (status, queued) = owner
        .post(
            "/api/v1/reports/run",
            json!({ "type": "agent_status", "format": "pdf", "async": true }),
        )
        .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{queued}");
    let run_id = queued["run_id"].as_str().expect("run").to_string();
    let mut finished = Value::Null;
    for _ in 0..100 {
        let (_, r) = owner.get(&format!("/api/v1/report-runs/{run_id}")).await;
        if r["status"] == "completed" || r["status"] == "failed" {
            finished = r;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(finished["status"], "completed", "{finished}");
    assert_eq!(finished["downloadable"], true);
    let raw = owner
        .raw(
            Method::GET,
            &format!("/api/v1/report-runs/{run_id}/download"),
            None,
            Vec::new(),
        )
        .await;
    assert_eq!(raw.status, StatusCode::OK);
    assert!(raw.body.starts_with(b"%PDF-"));
    let (_, runs) = owner.get("/api/v1/report-runs?limit=10").await;
    assert!(
        runs["items"]
            .as_array()
            .expect("runs")
            .iter()
            .any(|r| r["id"] == csv_run)
    );
    // Every report type renders.
    for t in [
        "software_inventory",
        "patch_compliance",
        "alert_history",
        "tickets_time",
        "audit",
    ] {
        let (status, r) = owner
            .post("/api/v1/reports/run", json!({ "type": t }))
            .await;
        assert_eq!(status, StatusCode::OK, "{t}: {r}");
    }

    // ====================================================== branding
    let evil_svg = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)"><script>alert(1)</script><foreignObject><p>x</p></foreignObject><image href="https://evil.example/x.png"/><rect width="10" height="10" fill="#e0703f"/></svg>"##;
    let raw = owner
        .raw(
            Method::POST,
            "/api/v1/files/branding",
            Some("multipart/form-data; boundary=BOUNDARY"),
            multipart("BOUNDARY", "logo.svg", evil_svg.as_bytes()),
        )
        .await;
    assert_eq!(
        raw.status,
        StatusCode::CREATED,
        "{}",
        String::from_utf8_lossy(&raw.body)
    );
    let svg_file: Value = serde_json::from_slice(&raw.body).expect("json");
    assert_eq!(svg_file["content_type"], "image/svg+xml");
    assert_eq!(svg_file["sanitized"], true);
    let served = Client::new(router.clone())
        .raw(
            Method::GET,
            svg_file["url"].as_str().expect("url"),
            None,
            Vec::new(),
        )
        .await;
    assert_eq!(served.status, StatusCode::OK);
    let text = String::from_utf8(served.body).expect("utf8");
    for bad in [
        "script",
        "onload",
        "foreignObject",
        "evil.example",
        "<image",
    ] {
        assert!(!text.contains(bad), "{bad} survived: {text}");
    }
    assert!(text.contains("<rect"));
    assert!(
        served.headers[header::CONTENT_SECURITY_POLICY]
            .to_str()
            .expect("csp")
            .contains("sandbox")
    );
    let too_big = vec![b'x'; 600 * 1024];
    let raw = owner
        .raw(
            Method::POST,
            "/api/v1/files/branding",
            Some("multipart/form-data; boundary=B"),
            multipart("B", "big.svg", &too_big),
        )
        .await;
    assert!(
        matches!(
            raw.status,
            StatusCode::UNPROCESSABLE_ENTITY | StatusCode::PAYLOAD_TOO_LARGE
        ),
        "{}",
        raw.status
    );
    let raw = owner
        .raw(
            Method::POST,
            "/api/v1/files/branding",
            Some("multipart/form-data; boundary=B"),
            multipart("B", "logo.png", &tiny_png()),
        )
        .await;
    assert_eq!(
        raw.status,
        StatusCode::CREATED,
        "{}",
        String::from_utf8_lossy(&raw.body)
    );
    let png: Value = serde_json::from_slice(&raw.body).expect("json");
    assert_eq!(png["width"], 2);
    let png_id = png["id"].as_str().expect("id").to_string();
    let (status, body) = owner
        .put("/api/v1/settings/branding", json!({ "product_name": "Northwind RMM", "accent_color": "#1A6CF0",
                                                  "logo_light_file_id": png_id, "logo_dark_file_id": svg_file["id"] }))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, bad) = owner
        .put(
            "/api/v1/settings/branding",
            json!({ "product_name": "X", "accent_color": "blue" }),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{bad}");
    let (status, public) = Client::new(router.clone()).get("/api/v1/branding").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(public["product_name"], "Northwind RMM");
    assert_eq!(public["accent_color"], "#1a6cf0");
    assert_eq!(
        public["logo_light_url"],
        format!("/api/v1/branding/files/{png_id}")
    );
    let (status, body) = owner
        .put(
            &format!("/api/v1/clients/{acme}/logo"),
            json!({ "file_id": png_id }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (_, client) = owner.get(&format!("/api/v1/clients/{acme}")).await;
    assert_eq!(
        client["logo_url"],
        format!("/api/v1/branding/files/{png_id}")
    );
    // Branded PDF: both logos are embedded as image XObjects.
    let raw = owner
        .raw(Method::POST, "/api/v1/reports/run", Some("application/json"),
             json!({ "type": "executive_summary", "parameters": { "client_id": acme }, "format": "pdf" }).to_string().into_bytes())
        .await;
    assert!(raw.body.starts_with(b"%PDF-"));
    let pdf = String::from_utf8_lossy(&raw.body);
    assert!(
        pdf.contains("/Im1") && pdf.contains("/Im2"),
        "MSP and client logos embedded"
    );

    // ====================================================== scheduled per-client e-mail
    let (smtp_port, mut mails) = fake_smtp().await;
    let (status, body) = owner
        .put("/api/v1/settings/smtp", json!({ "host": "127.0.0.1", "port": smtp_port, "security": "none", "username": "",
                                              "from_address": "rmm@rmm.test", "from_name": "Northwind" }))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, contact) = owner
        .post("/api/v1/contacts", json!({ "client_id": acme, "name": "Dana Reyes", "email": "dana@acme.test", "is_primary": true }))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{contact}");
    let dana = contact["id"].as_str().expect("id").to_string();
    let (status, bad) = owner
        .post(
            "/api/v1/report-schedules",
            json!({ "name": "x", "type": "nope", "format": "pdf", "cron": "0 7 * * 1" }),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{bad}");
    let (status, schedule) = owner
        .post("/api/v1/report-schedules", json!({
            "name": "Monthly executive summary", "type": "executive_summary", "parameters": { "client_id": acme },
            "format": "pdf", "cron": "0 7 1 * *", "timezone": "Europe/London",
            "recipients": ["Boss@Northwind.test"], "per_client": true, "enabled": true }))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{schedule}");
    assert_eq!(schedule["recipients"][0], "boss@northwind.test");
    assert!(schedule["next_run_at"].is_string());
    let schedule_id = schedule["id"].as_str().expect("id").to_string();
    let (status, ran) = owner
        .post(
            &format!("/api/v1/report-schedules/{schedule_id}/run-now"),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{ran}");
    let mail = next_within(&mut mails, "the scheduled report e-mail").await;
    assert!(
        mail.contains("boss@northwind.test") && mail.contains("dana@acme.test"),
        "{mail}"
    );
    assert!(
        mail.contains("application/pdf") && mail.contains("executive-summary-acme-dental"),
        "{mail}"
    );
    let (_, sched_runs) = owner
        .get(&format!("/api/v1/report-runs?schedule_id={schedule_id}"))
        .await;
    assert_eq!(
        sched_runs["items"][0]["status"], "completed",
        "{sched_runs}"
    );
    assert_eq!(sched_runs["items"][0]["trigger"], "schedule");

    // ====================================================== a client-scoped technician
    let (status, tech) = owner
        .post("/api/v1/users", json!({ "name": "Tara Tech", "email": "tara@example.com", "password": "another-strong-passphrase",
                                       "assignments": [{ "role_id": "builtin-technician", "scope_type": "client", "scope_id": acme }] }))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{tech}");
    let mut tara = Client::new(router.clone());
    sign_in(&mut tara, "tara@example.com", "another-strong-passphrase").await;

    // ====================================================== dashboards
    let (status, home) = tara.get("/api/v1/dashboards/default").await;
    assert_eq!(status, StatusCode::OK, "{home}");
    assert_eq!(home["id"], "builtin-home");
    let (status, mine) = tara
        .post("/api/v1/dashboards", json!({ "name": "My board", "is_default": true, "layout": [
            { "widget": "fleet_health", "x": 0, "y": 0, "w": 6, "h": 3 },
            { "widget": "top_disk_usage", "x": 6, "y": 0, "w": 6, "h": 3, "config": { "limit": 5 } } ] }))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{mine}");
    assert_eq!(mine["is_default"], true);
    let (_, home) = tara.get("/api/v1/dashboards/default").await;
    assert_eq!(home["id"], mine["id"]);
    let (status, denied) = tara
        .post(
            "/api/v1/dashboards",
            json!({ "name": "Team board", "shared": true, "layout": [] }),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "shared dashboards need reports.manage: {denied}"
    );
    let (status, bad) = tara
        .post("/api/v1/dashboards", json!({ "name": "Bad", "layout": [{ "widget": "fleet_health", "x": 10, "y": 0, "w": 4, "h": 2 }] }))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{bad}");
    let (status, shared) = owner
        .post("/api/v1/dashboards", json!({ "name": "NOC wall", "shared": true, "layout": [{ "widget": "alerts_list", "x": 0, "y": 0, "w": 12, "h": 6 }] }))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{shared}");
    let (_, list) = tara.get("/api/v1/dashboards").await;
    let names: Vec<&str> = list["items"]
        .as_array()
        .expect("items")
        .iter()
        .filter_map(|d| d["name"].as_str())
        .collect();
    assert!(
        names.contains(&"My board") && names.contains(&"NOC wall"),
        "{names:?}"
    );
    assert_eq!(
        list["items"]
            .as_array()
            .expect("items")
            .iter()
            .find(|d| d["name"] == "NOC wall")
            .expect("noc")["editable"],
        false
    );
    let (status, fleet) = tara.get("/api/v1/dashboards/widgets/fleet_health").await;
    assert_eq!(status, StatusCode::OK, "{fleet}");
    assert_eq!(fleet["data"]["devices"], 1, "Tara sees only Acme");
    let cfg = url::form_urlencoded::byte_serialize(json!({ "limit": 3 }).to_string().as_bytes())
        .collect::<String>();
    let (status, disks) = owner
        .get(&format!(
            "/api/v1/dashboards/widgets/top_disk_usage?config={cfg}"
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{disks}");
    assert_eq!(disks["data"]["items"][0]["hostname"], "ACME-WS1");
    for w in [
        "alerts_by_severity",
        "alerts_list",
        "patch_compliance",
        "tickets_open",
        "sla_breaches",
        "devices_offline",
        "os_mix",
        "agent_versions",
        "recent_jobs",
    ] {
        let (status, body) = owner.get(&format!("/api/v1/dashboards/widgets/{w}")).await;
        assert_eq!(status, StatusCode::OK, "{w}: {body}");
    }
    let (status, _) = owner.get("/api/v1/dashboards/widgets/nope").await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // ====================================================== API tokens
    set_step_up(&state, "owner@example.com").await;
    let (status, denied) = owner
        .post(
            "/api/v1/api-tokens",
            json!({ "name": "too much", "permissions": ["not.a.permission"] }),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{denied}");
    let (status, created) = owner
        .post("/api/v1/api-tokens", json!({ "name": "PSA sync", "permissions": ["devices.view", "devices.delete", "tickets.view", "tickets.manage"],
                                            "client_ids": [acme] }))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let secret = created["token"].as_str().expect("token").to_string();
    assert!(secret.starts_with("rrmm_pat_") && secret.len() == "rrmm_pat_".len() + 43);
    assert!(
        created["item"]["prefix"]
            .as_str()
            .expect("prefix")
            .starts_with("rrmm_pat_")
    );
    let token_id = created["item"]["id"].as_str().expect("id").to_string();
    let stored: String = sqlx::query_scalar("SELECT token_hash FROM api_tokens WHERE id = ?")
        .bind(&token_id)
        .fetch_one(&state.db)
        .await
        .expect("hash");
    assert_eq!(
        stored,
        rustrmm_crypto::random::sha256_hex(secret.as_bytes()),
        "only the SHA-256 is stored"
    );
    let mut api = Client::with_token(router.clone(), &secret);
    let (status, devices) = api.get("/api/v1/devices").await;
    assert_eq!(status, StatusCode::OK, "{devices}");
    let hosts: Vec<&str> = devices["items"]
        .as_array()
        .expect("items")
        .iter()
        .filter_map(|d| d["hostname"].as_str())
        .collect();
    assert_eq!(hosts, vec!["ACME-WS1"], "client scope applies");
    let (status, _) = api.get(&format!("/api/v1/devices/{gx1}")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, body) = api.get("/api/v1/users").await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "permissions are a subset: {body}"
    );
    // Mutations need no CSRF token.
    let (status, ticket) = api
        .post(
            "/api/v1/tickets",
            json!({ "subject": "Created over the API", "client_id": acme, "contact_id": dana }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{ticket}");
    let (status, body) = api
        .post(&format!("/api/v1/devices/{ws1}/revoke"), json!({}))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"]["code"], "step_up_required", "{body}");
    let (status, body) = api
        .post(&format!("/api/v1/devices/{ws1}/shell"), json!({}))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"]["code"], "token_not_allowed", "{body}");
    let (status, body) = api
        .post(
            "/api/v1/api-tokens",
            json!({ "name": "x", "permissions": ["devices.view"] }),
        )
        .await;
    assert_eq!(
        body["error"]["code"], "token_not_allowed",
        "{status} {body}"
    );
    let (status, me) = api.get("/api/v1/auth/me").await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        !me["permissions"]
            .as_array()
            .expect("perms")
            .iter()
            .any(|p| p == "users.manage")
    );
    let (status, all) = owner.get("/api/v1/api-tokens?all=true").await;
    assert_eq!(status, StatusCode::OK, "{all}");
    assert_eq!(all["items"][0]["user"]["email"], "owner@example.com");
    let (status, _) = tara.get("/api/v1/api-tokens?all=true").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let used: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_log WHERE action = 'api_token.used' AND target_id = ?",
    )
    .bind(&token_id)
    .fetch_one(&state.db)
    .await
    .expect("count");
    assert_eq!(used, 1, "use is audited once per hour");
    // Rate limit: 600 requests per minute per token.
    let (_, limited) = owner
        .post(
            "/api/v1/api-tokens",
            json!({ "name": "busy", "permissions": ["devices.view"] }),
        )
        .await;
    let mut busy = Client::with_token(router.clone(), limited["token"].as_str().expect("token"));
    let mut throttled_at = None;
    for i in 0..3000 {
        let raw = busy
            .raw(Method::GET, "/api/v1/auth/me", None, Vec::new())
            .await;
        if raw.status == StatusCode::TOO_MANY_REQUESTS {
            throttled_at = Some(i);
            break;
        }
    }
    assert!(throttled_at.is_some_and(|i| i >= 600), "{throttled_at:?}");
    // Revocation and network allowlists.
    let (status, _) = owner
        .delete(&format!("/api/v1/api-tokens/{token_id}"))
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, body) = api.get("/api/v1/devices").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    let (_, fenced) = owner
        .post("/api/v1/api-tokens", json!({ "name": "fenced", "permissions": ["devices.view"], "allowed_cidrs": ["203.0.113.0/24"] }))
        .await;
    let (status, body) =
        Client::with_token(router.clone(), fenced["token"].as_str().expect("token"))
            .get("/api/v1/devices")
            .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");

    // ====================================================== webhooks
    let (rx_port, mut deliveries) = receiver().await;
    let hook_url = format!("http://127.0.0.1:{rx_port}/hook");
    let (status, hook) = owner
        .post(
            "/api/v1/webhooks",
            json!({ "name": "SIEM", "url": hook_url, "secret": "whsec-0123456789abcdef",
                                          "events": ["ticket.created", "ticket.updated"] }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{hook}");
    assert!(
        hook.get("secret").is_none(),
        "a supplied secret is never echoed"
    );
    let hook_id = hook["id"].as_str().expect("id").to_string();
    let (status, bad) = owner
        .post(
            "/api/v1/webhooks",
            json!({ "url": hook_url, "events": ["bogus.event"] }),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{bad}");
    // The SSRF guard refuses loopback until it is allowlisted.
    let (status, test) = owner
        .post(&format!("/api/v1/webhooks/{hook_id}/test"), json!({}))
        .await;
    assert_eq!(status, StatusCode::OK, "{test}");
    assert_eq!(test["status"], "failed");
    assert!(
        test["error"].as_str().expect("error").contains("allowlist"),
        "{test}"
    );
    let (status, body) = owner
        .put(
            "/api/v1/settings/monitoring",
            json!({ "default_offline_minutes": 15, "unknown_threshold": 3, "retention_days": 180,
                                                     "webhook_allowlist": ["127.0.0.1"] }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (_, test) = owner
        .post(&format!("/api/v1/webhooks/{hook_id}/test"), json!({}))
        .await;
    assert_eq!(test["status"], "delivered", "{test}");
    let (headers, _) = next_within(&mut deliveries, "the test delivery").await;
    assert_eq!(headers["x-rustrmm-event"], "webhook.test");
    // A Globex-only webhook must not receive Acme events.
    let (status, scoped) = owner
        .post("/api/v1/webhooks", json!({ "url": hook_url, "secret": "globex-secret-0123456", "events": ["ticket.created"], "client_ids": [globex] }))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{scoped}");
    let (status, t) = owner
        .post(
            "/api/v1/tickets",
            json!({ "subject": "Webhook me", "client_id": acme, "contact_id": dana }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{t}");
    let mut created_event = None;
    for _ in 0..4 {
        let (headers, body) = next_within(&mut deliveries, "a ticket webhook").await;
        let payload: Value = serde_json::from_str(&body).expect("json");
        if payload["event"] == "ticket.created"
            && payload["data"]["ticket"]["subject"] == "Webhook me"
        {
            created_event = Some((headers, body, payload));
            break;
        }
    }
    let (headers, body, payload) = created_event.expect("ticket.created delivered");
    assert!(payload["id"].is_string() && payload["created_at"].is_string());
    let signature = headers["x-rustrmm-signature"].clone();
    let (t_part, v1_part) = signature.split_once(',').expect("t=..,v1=..");
    let ts = t_part.strip_prefix("t=").expect("t");
    let mac = v1_part.strip_prefix("v1=").expect("v1");
    assert_eq!(
        mac,
        hmac_hex("whsec-0123456789abcdef", format!("{ts}.{body}").as_bytes()),
        "signature verifies"
    );
    tokio::time::sleep(Duration::from_millis(500)).await;
    let scoped_deliveries: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM webhook_deliveries WHERE webhook_id = ?")
            .bind(scoped["id"].as_str().expect("id"))
            .fetch_one(&state.db)
            .await
            .expect("count");
    assert_eq!(scoped_deliveries, 0, "client scoping");
    let (status, history) = owner
        .get(&format!("/api/v1/webhooks/{hook_id}/deliveries"))
        .await;
    assert_eq!(status, StatusCode::OK, "{history}");
    let original = history["items"]
        .as_array()
        .expect("items")
        .iter()
        .find(|d| d["event"] == "ticket.created" && d["status"] == "delivered")
        .expect("delivered row")
        .clone();
    let (status, again) = owner
        .post(
            &format!(
                "/api/v1/webhook-deliveries/{}/redeliver",
                original["id"].as_str().expect("id")
            ),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{again}");
    assert_eq!(again["event_id"], original["event_id"]);
    let mut redelivered = false;
    for _ in 0..5 {
        let (_, body) = next_within(&mut deliveries, "the redelivery").await;
        if serde_json::from_str::<Value>(&body).expect("json")["id"] == payload["id"] {
            redelivered = true;
            break;
        }
    }
    assert!(redelivered, "the same payload id is delivered again");
    // A failing endpoint is retried with backoff.
    let dead = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let dead_port = dead.local_addr().expect("addr").port();
    drop(dead);
    let (_, dead_hook) = owner
        .post("/api/v1/webhooks", json!({ "url": format!("http://127.0.0.1:{dead_port}/x"), "events": ["ticket.updated"] }))
        .await;
    assert!(
        dead_hook["secret"].as_str().is_some_and(|s| s.len() >= 32),
        "generated secret shown once: {dead_hook}"
    );
    let (status, _) = owner
        .call(
            Method::PATCH,
            &format!("/api/v1/tickets/{}", t["id"].as_str().expect("id")),
            Some(json!({ "priority": "high" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let mut retry = Value::Null;
    for _ in 0..100 {
        let (_, h) = owner
            .get(&format!(
                "/api/v1/webhooks/{}/deliveries",
                dead_hook["id"].as_str().expect("id")
            ))
            .await;
        if h["items"][0]["attempts"].as_i64().unwrap_or(0) >= 1 {
            retry = h["items"][0].clone();
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(retry["status"], "pending", "{retry}");
    assert!(
        retry["next_attempt_at"].is_string() && retry["error"].is_string(),
        "{retry}"
    );

    // ====================================================== OIDC single sign-on
    set_step_up(&state, "owner@example.com").await;
    let issuer = fake_issuer().await;
    let (status, provider) = owner
        .post("/api/v1/settings/sso/providers", json!({
            "name": "Example IdP", "issuer_url": issuer.url, "client_id": "rmm-app", "client_secret": "s3cret-value",
            "role_mappings": [{ "group": "rmm-techs", "role_id": "builtin-technician", "scope_type": "client", "scope_id": acme }],
            "auto_provision": true, "button_label": "Sign in with Example" }))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{provider}");
    assert_eq!(provider["has_client_secret"], true);
    assert!(provider.get("client_secret").is_none());
    let provider_id = provider["id"].as_str().expect("id").to_string();
    let (status, bad) = owner
        .post("/api/v1/settings/sso/providers", json!({ "name": "Owner grab", "issuer_url": "https://idp.example", "client_id": "x",
              "role_mappings": [{ "group": "g", "role_id": "builtin-owner", "scope_type": "global" }] }))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{bad}");
    let (status, public) = Client::new(router.clone())
        .get("/api/v1/auth/providers")
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(public["items"][0]["button_label"], "Sign in with Example");
    assert_eq!(public["items"][0]["id"], provider_id);

    let now = chrono::Utc::now().timestamp();
    let claims = |amr: Value, sub: &'static str| {
        let iss = issuer.url.clone();
        move |nonce: &str| {
            json!({ "iss": iss, "aud": "rmm-app", "sub": sub, "email": "sam.sso@example.com", "email_verified": true,
                                   "name": "Sam SSO", "groups": ["rmm-techs", "other"], "amr": amr, "nonce": nonce,
                                   "iat": now, "exp": now + 300 })
        }
    };
    // ES256 with MFA asserted: a session straight away.
    let (location, session) = sso_login(
        &router,
        &issuer,
        &provider_id,
        claims(json!(["pwd", "mfa"]), "sub-1"),
        "ES256",
        false,
    )
    .await;
    assert_eq!(location, "/devices", "return_to is honoured");
    let session = session.expect("a session cookie");
    let mut sam = Client::new(router.clone());
    sam.cookie = Some(session);
    let (status, me) = sam.get("/api/v1/auth/me").await;
    assert_eq!(status, StatusCode::OK, "{me}");
    assert_eq!(me["user"]["email"], "sam.sso@example.com");
    let perms: Vec<&str> = me["permissions"]
        .as_array()
        .expect("perms")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert!(
        perms.contains(&"devices.view") && !perms.contains(&"users.manage"),
        "{perms:?}"
    );
    let managed: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM role_assignments WHERE managed_by = ?")
            .bind(&provider_id)
            .fetch_one(&state.db)
            .await
            .expect("count");
    assert_eq!(managed, 1, "role mapping applied");
    // RS256 without MFA claims: local MFA (enrolment, since Sam has none) is required.
    let (location, session) = sso_login(
        &router,
        &issuer,
        &provider_id,
        claims(json!(["pwd"]), "sub-1"),
        "RS256",
        false,
    )
    .await;
    assert!(
        location.starts_with("/login#sso_challenge=") && location.ends_with("&mfa=setup"),
        "{location}"
    );
    assert!(session.is_none());
    // Forged state and a wrong nonce are refused.
    let (location, session) = sso_login(
        &router,
        &issuer,
        &provider_id,
        claims(json!(["mfa"]), "sub-1"),
        "ES256",
        true,
    )
    .await;
    assert_eq!(location, "/login#sso_error=state_mismatch");
    assert!(session.is_none());
    let iss = issuer.url.clone();
    let (location, _) = sso_login(&router, &issuer, &provider_id, move |_nonce: &str| json!({
        "iss": iss, "aud": "rmm-app", "sub": "sub-1", "email": "sam.sso@example.com", "email_verified": true,
        "amr": ["mfa"], "nonce": "not-the-nonce", "iat": now, "exp": now + 300 }), "ES256", false).await;
    assert_eq!(location, "/login#sso_error=invalid_token");
    // Unverified e-mail of a new subject is refused.
    let iss = issuer.url.clone();
    let (location, _) = sso_login(&router, &issuer, &provider_id, move |nonce: &str| json!({
        "iss": iss, "aud": "rmm-app", "sub": "sub-2", "email": "mallory@example.com", "email_verified": false,
        "amr": ["mfa"], "nonce": nonce, "iat": now, "exp": now + 300 }), "ES256", false).await;
    assert_eq!(location, "/login#sso_error=email_not_verified");
    // Enforcement: password sign-in is blocked except for the owner (break glass).
    let (status, body) = owner
        .put("/api/v1/settings/sso", json!({ "enforce": true }))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = Client::new(router.clone())
        .post(
            "/api/v1/auth/login",
            json!({ "email": "tara@example.com", "password": "another-strong-passphrase" }),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "sso_required");
    let (status, body) = Client::new(router.clone())
        .post(
            "/api/v1/auth/login",
            json!({ "email": "owner@example.com", "password": "correct-horse-battery-staple" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "owner keeps password + MFA: {body}");
    let (status, _) = owner
        .put("/api/v1/settings/sso", json!({ "enforce": false }))
        .await;
    assert_eq!(status, StatusCode::OK);

    // ====================================================== polish: tickets
    let (status, by_contact) = owner
        .get(&format!("/api/v1/tickets?status=all&contact_id={dana}"))
        .await;
    assert_eq!(status, StatusCode::OK, "{by_contact}");
    assert!(
        by_contact["items"]
            .as_array()
            .expect("items")
            .iter()
            .all(|t| t["contact"]["id"] == dana)
    );
    assert_eq!(by_contact["items"].as_array().expect("items").len(), 2);
    assert!(
        by_contact["counts"]["resolved"].is_i64() && by_contact["counts"]["due_soon"].is_i64(),
        "{by_contact}"
    );
    let (status, _) = owner
        .post(
            "/api/v1/tickets",
            json!({ "subject": "Globex printer", "client_id": globex }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let (_, queues) = owner.get("/api/v1/ticket-queues").await;
    let (_, tara_queues) = tara.get("/api/v1/ticket-queues").await;
    let open = |q: &Value| q["items"][0]["open_tickets"].as_i64().expect("open");
    assert_eq!(open(&queues), 3);
    assert_eq!(
        open(&tara_queues),
        2,
        "queue counts respect the client scope"
    );

    // ====================================================== polish: patching
    let (status, compliance) = owner
        .get(&format!("/api/v1/patching/compliance?client_id={acme}"))
        .await;
    assert_eq!(status, StatusCode::OK, "{compliance}");
    let (status, _) = owner
        .get("/api/v1/patching/compliance?client_id=missing")
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let now_t = rustrmm_common::now();
    sqlx::query(
        "INSERT INTO device_patch_status (device_id, scanned_at, updated_at) VALUES (?, ?, ?)",
    )
    .bind(&ws1)
    .bind(now_t)
    .bind(now_t)
    .execute(&state.db)
    .await
    .expect("scan status");
    sqlx::query("INSERT INTO patch_catalog (id, platform, key, title, classification, severity, first_seen_at, updated_at)
                 VALUES ('p1', 'windows', 'kb1', 'Cumulative update', 'SecurityUpdates', 'Critical', ?, ?)")
        .bind(now_t)
        .bind(now_t)
        .execute(&state.db)
        .await
        .expect("catalog");
    sqlx::query("INSERT INTO device_patches (device_id, patch_id, state, detected_at, updated_at) VALUES (?, 'p1', 'missing', ?, ?)")
        .bind(&ws1)
        .bind(now_t)
        .bind(now_t)
        .execute(&state.db)
        .await
        .expect("device patch");
    sqlx::query("INSERT INTO patch_approvals (id, patch_id, client_id, decision, source, by_name, at, delay_days)
                 VALUES ('a1', 'p1', ?, 'approved', 'rule', 'Auto-approval rule', ?, '{}')")
        .bind(&acme)
        .bind(now_t)
        .execute(&state.db)
        .await
        .expect("rule approval");
    let (status, catalog) = owner.get("/api/v1/patches?status=any").await;
    assert_eq!(status, StatusCode::OK, "{catalog}");
    let item = &catalog["items"][0];
    assert_eq!(item["approval"]["source"], "rule", "{item}");
    assert_eq!(item["approval"]["clients"], 1);
    assert_eq!(item["rule_approved_clients"], 1);
    let (_, approved) = owner
        .get("/api/v1/patches?status=any&approval=approved")
        .await;
    assert_eq!(approved["items"].as_array().expect("items").len(), 1);
    let (_, missing_crit) = owner
        .get("/api/v1/devices?patch_state=missing_critical")
        .await;
    let hosts: Vec<&str> = missing_crit["items"]
        .as_array()
        .expect("items")
        .iter()
        .filter_map(|d| d["hostname"].as_str())
        .collect();
    assert_eq!(hosts, vec!["ACME-WS1"]);
    let (_, unscanned) = owner.get("/api/v1/devices?patch_state=not_scanned").await;
    let hosts: Vec<&str> = unscanned["items"]
        .as_array()
        .expect("items")
        .iter()
        .filter_map(|d| d["hostname"].as_str())
        .collect();
    assert_eq!(hosts, vec!["GLOBEX-WS1"]);
    let (status, _) = owner.get("/api/v1/devices?patch_state=bogus").await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let (status, policy) = owner
        .post("/api/v1/policies", json!({ "name": "Acme patching", "document": { "patching": {
            "enabled": true, "window": { "cron": "0 2 * * 3", "duration_minutes": 90, "timezone": "UTC" } } } }))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{policy}");
    let policy_id = policy["id"].as_str().expect("id").to_string();
    let (status, body) = owner
        .post(
            &format!("/api/v1/policies/{policy_id}/assignments"),
            json!({ "target_type": "client", "target_id": acme }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    set_step_up(&state, "owner@example.com").await;
    let (status, started) = owner
        .post(
            &format!("/api/v1/patching/policies/{policy_id}/run-now"),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{started}");
    assert_eq!(started["devices"], 1);
    let (status, patch_run) = owner
        .get(&format!(
            "/api/v1/patch-runs/{}",
            started["run_id"].as_str().expect("run")
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{patch_run}");
    assert_eq!(patch_run["run"]["trigger"], "manual");
    assert_eq!(
        patch_run["results"][0]["status"], "pending",
        "offline devices wait for the run window"
    );
    let (status, _) = tara
        .post(
            &format!("/api/v1/patching/policies/{policy_id}/run-now"),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "patches.approve needed");

    // ====================================================== polish: software publishers
    for (name, publisher) in [
        ("7-Zip 24.08 (x64)", "Igor Pavlov"),
        ("Microsoft Edge", "Microsoft Corporation"),
    ] {
        sqlx::query("INSERT INTO device_software (device_id, name, version, publisher) VALUES (?, ?, '1.0', ?)")
            .bind(&ws1)
            .bind(name)
            .bind(publisher)
            .execute(&state.db)
            .await
            .expect("software");
    }
    sqlx::query("INSERT INTO device_software (device_id, name, version, publisher) VALUES (?, 'Microsoft Edge', '1.1', 'Microsoft Corp.')")
        .bind(&gx1)
        .execute(&state.db)
        .await
        .expect("software");
    let (_, software) = owner.get("/api/v1/software?q=edge").await;
    let items = software["items"].as_array().expect("items");
    assert_eq!(
        items.len(),
        1,
        "publisher legal suffixes are normalised: {software}"
    );
    assert_eq!(items[0]["devices"], 2);

    // ====================================================== OpenAPI and docs
    let raw = Client::new(router.clone())
        .raw(Method::GET, "/api/openapi.json", None, Vec::new())
        .await;
    assert_eq!(raw.status, StatusCode::OK);
    let spec: Value = serde_json::from_slice(&raw.body).expect("spec");
    assert!(spec["paths"]["/api/v1/reports/run"]["post"].is_object());
    let raw = Client::new(router.clone())
        .raw(Method::GET, "/api/docs", None, Vec::new())
        .await;
    assert_eq!(raw.status, StatusCode::OK);
    assert!(String::from_utf8_lossy(&raw.body).contains("/api/docs/app.js"));
    assert!(
        raw.headers[header::CONTENT_SECURITY_POLICY]
            .to_str()
            .expect("csp")
            .contains("script-src 'self'")
    );
    let raw = Client::new(router.clone())
        .raw(Method::GET, "/api/docs/app.js", None, Vec::new())
        .await;
    assert_eq!(raw.status, StatusCode::OK);

    // Audit trail of the platform actions.
    for action in [
        "api_token.created",
        "api_token.revoked",
        "webhook.created",
        "sso.provider_created",
        "report.run",
        "report_schedule.created",
        "settings.branding_updated",
        "patch_run.started",
        "user.provisioned",
    ] {
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audit_log WHERE action = ?")
            .bind(action)
            .fetch_one(&state.db)
            .await
            .expect("count");
        assert!(n > 0, "{action} audited");
    }
    let verify = rustrmm_server::audit::verify(&state.db)
        .await
        .expect("verify");
    assert!(verify.ok, "audit chain intact");
}
