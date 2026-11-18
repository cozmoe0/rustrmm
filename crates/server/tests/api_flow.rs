//! End-to-end API tests: first-run setup, mandatory MFA, CSRF/origin protection, RBAC scoping,
//! step-up, audit chain integrity and backups — all against the real router in-process.

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use clap::Parser;
use http_body_util::BodyExt;
use rustrmm_server::state::AppState;
use serde_json::{Value, json};
use tower::ServiceExt;

const ORIGIN: &str = "https://rmm.test:8443";
const OWNER_EMAIL: &str = "owner@example.com";
const OWNER_PASSWORD: &str = "correct-horse-battery-staple";

struct Client {
    router: Router,
    cookie: Option<String>,
    csrf: Option<String>,
}

impl Client {
    fn new(router: Router) -> Self {
        Self {
            router,
            cookie: None,
            csrf: None,
        }
    }

    async fn call(
        &mut self,
        method: Method,
        path: &str,
        body: Option<Value>,
        with_csrf: bool,
    ) -> (StatusCode, Value) {
        let mut req = Request::builder()
            .method(method.clone())
            .uri(path)
            .header(header::ORIGIN, ORIGIN);
        if let Some(cookie) = &self.cookie {
            req = req.header(header::COOKIE, cookie);
        }
        if with_csrf && let Some(csrf) = &self.csrf {
            req = req.header("x-csrf-token", csrf);
        }
        let req = match body {
            Some(b) => req
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(b.to_string())),
            None => req.body(Body::empty()),
        }
        .expect("request");
        let response = self.router.clone().oneshot(req).await.expect("response");
        let status = response.status();
        if let Some(set_cookie) = response.headers().get(header::SET_COOKIE) {
            let raw = set_cookie.to_str().expect("cookie").to_string();
            let pair = raw.split(';').next().unwrap_or_default().to_string();
            if pair.ends_with('=') {
                self.cookie = None;
            } else {
                self.cookie = Some(pair);
            }
        }
        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(Value::Null)
        };
        if let Some(csrf) = value
            .pointer("/me/csrf_token")
            .or_else(|| value.pointer("/csrf_token"))
            .and_then(Value::as_str)
        {
            self.csrf = Some(csrf.to_string());
        }
        (status, value)
    }

    async fn get(&mut self, path: &str) -> (StatusCode, Value) {
        self.call(Method::GET, path, None, true).await
    }

    async fn post(&mut self, path: &str, body: Value) -> (StatusCode, Value) {
        self.call(Method::POST, path, Some(body), true).await
    }
}

fn totp_code(secret_b32: &str, offset_steps: i64) -> String {
    let secret = data_encoding::BASE32_NOPAD
        .decode(secret_b32.as_bytes())
        .expect("base32");
    let step = (chrono::Utc::now().timestamp() / 30 + offset_steps) as u64;
    format!("{:06}", rustrmm_server::auth::totp::code_at(&secret, step))
}

async fn app(dir: &std::path::Path) -> (AppState, Router) {
    let args = rustrmm_server::config::Cli::parse_from([
        "rustrmm-server",
        "--data-dir",
        dir.to_str().expect("utf8"),
        "--console-url",
        ORIGIN,
    ])
    .serve;
    let prepared = rustrmm_server::prepare(args, false).await.expect("prepare");
    let router = rustrmm_server::listeners::console_router(prepared.state.clone());
    (prepared.state, router)
}

/// Signs in a user that has no MFA yet: password → TOTP enrollment. Returns the TOTP secret.
async fn first_login(client: &mut Client, email: &str, password: &str) -> String {
    let (status, body) = client
        .post(
            "/api/v1/auth/login",
            json!({ "email": email, "password": password }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "mfa_setup_required");
    let challenge = body["challenge_token"]
        .as_str()
        .expect("challenge")
        .to_string();
    let (status, setup) = client
        .post(
            "/api/v1/auth/mfa/setup/totp/start",
            json!({ "challenge_token": challenge }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{setup}");
    let secret = setup["secret"].as_str().expect("secret").to_string();
    assert!(setup["qr_svg"].as_str().expect("qr").contains("<svg"));
    let (status, done) = client
        .post(
            "/api/v1/auth/mfa/setup/totp/finish",
            json!({ "challenge_token": challenge, "code": totp_code(&secret, 0) }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{done}");
    assert_eq!(done["recovery_codes"].as_array().expect("codes").len(), 10);
    assert!(client.cookie.is_some(), "session cookie set");
    secret
}

#[tokio::test]
async fn full_phase1_flow() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (state, router) = app(dir.path()).await;
    let mut owner = Client::new(router.clone());

    // ---- setup
    let (status, body) = owner.get("/api/v1/setup/status").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["needs_setup"], true);

    let setup_body = |token: &str| {
        json!({
            "setup_token": token,
            "organization_name": "Northwind IT",
            "owner": { "name": "Olivia Owner", "email": OWNER_EMAIL, "password": OWNER_PASSWORD },
            "first_client": { "name": "Acme Dental" },
            "first_site": { "name": "Main Office", "timezone": "America/Chicago" }
        })
    };
    let (status, _) = owner
        .post("/api/v1/setup/complete", setup_body("WRONG-TOKEN"))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let token = state.setup.current_token().expect("setup token");
    let (status, kit) = owner
        .post("/api/v1/setup/complete", setup_body(&token))
        .await;
    assert_eq!(status, StatusCode::OK, "{kit}");
    let backup_identity = kit["recovery_kit"]["backup_identity"]
        .as_str()
        .expect("identity")
        .to_string();
    assert!(backup_identity.starts_with("AGE-SECRET-KEY-1"));
    let (_, body) = owner.get("/api/v1/setup/status").await;
    assert_eq!(body["needs_setup"], false);
    let (status, _) = owner
        .post("/api/v1/setup/complete", setup_body(&token))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "setup cannot run twice");

    // ---- login + mandatory MFA
    let (status, body) = owner
        .post(
            "/api/v1/auth/login",
            json!({ "email": OWNER_EMAIL, "password": "nope-nope-nope" }),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    let secret = first_login(&mut owner, OWNER_EMAIL, OWNER_PASSWORD).await;

    let (status, me) = owner.get("/api/v1/auth/me").await;
    assert_eq!(status, StatusCode::OK, "{me}");
    assert_eq!(me["organization"]["name"], "Northwind IT");
    assert!(
        me["permissions"]
            .as_array()
            .expect("perms")
            .iter()
            .any(|p| p == "users.manage")
    );
    assert_eq!(me["user"]["mfa"]["totp"], true);

    // ---- CSRF and origin enforcement
    let (status, body) = owner
        .call(
            Method::POST,
            "/api/v1/clients",
            Some(json!({ "name": "Harbor Legal" })),
            false,
        )
        .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "missing CSRF must fail: {body}"
    );
    let bad_origin = Request::builder()
        .method(Method::POST)
        .uri("/api/v1/clients")
        .header(header::ORIGIN, "https://evil.example")
        .header(header::COOKIE, owner.cookie.clone().expect("cookie"))
        .header("x-csrf-token", owner.csrf.clone().expect("csrf"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({ "name": "Evil" }).to_string()))
        .expect("request");
    let response = router.clone().oneshot(bad_origin).await.expect("response");
    assert_eq!(
        response.status(),
        StatusCode::FORBIDDEN,
        "foreign origin must fail"
    );

    // ---- tenancy
    let (status, harbor) = owner
        .post(
            "/api/v1/clients",
            json!({ "name": "Harbor & Pine Legal", "notes": "Law firm" }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{harbor}");
    assert_eq!(harbor["slug"], "harbor-pine-legal");
    let harbor_id = harbor["id"].as_str().expect("id").to_string();
    let (status, _) = owner
        .post("/api/v1/clients", json!({ "name": "harbor & pine legal" }))
        .await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "client names are unique, case-insensitively"
    );
    let (status, site) = owner
        .post(
            &format!("/api/v1/clients/{harbor_id}/sites"),
            json!({ "name": "Downtown", "timezone": "Europe/London" }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{site}");
    let (status, list) = owner.get("/api/v1/clients").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list["items"].as_array().expect("items").len(), 2);
    let (status, detail) = owner.get(&format!("/api/v1/clients/{harbor_id}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(detail["sites"].as_array().expect("sites").len(), 1);

    // ---- a client-scoped technician only sees their client and cannot manage users
    let (_, roles) = owner.get("/api/v1/roles").await;
    let tech_role = roles["items"]
        .as_array()
        .expect("roles")
        .iter()
        .find(|r| r["name"] == "Technician")
        .expect("tech")["id"]
        .clone();
    let (status, tech) = owner
        .post(
            "/api/v1/users",
            json!({
                "name": "Terry Tech",
                "email": "terry@example.com",
                "password": "another-strong-passphrase",
                "assignments": [{ "role_id": tech_role, "scope_type": "client", "scope_id": harbor_id }]
            }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{tech}");
    let mut terry = Client::new(router.clone());
    first_login(&mut terry, "terry@example.com", "another-strong-passphrase").await;
    let (_, visible) = terry.get("/api/v1/clients").await;
    let names: Vec<&str> = visible["items"]
        .as_array()
        .expect("items")
        .iter()
        .filter_map(|c| c["name"].as_str())
        .collect();
    assert_eq!(names, vec!["Harbor & Pine Legal"]);
    let (status, _) = terry.get("/api/v1/users").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = terry
        .post("/api/v1/clients", json!({ "name": "Sneaky" }))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // ---- step-up protects destructive actions
    sqlx::query("UPDATE sessions SET stepped_up_until = NULL")
        .execute(&state.db)
        .await
        .expect("reset step-up");
    let (status, body) = owner
        .call(
            Method::DELETE,
            &format!("/api/v1/clients/{harbor_id}"),
            None,
            true,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"]["code"], "step_up_required");
    let (status, body) = owner
        .post(
            "/api/v1/auth/step-up",
            json!({ "method": "totp", "code": totp_code(&secret, 1) }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, _) = owner
        .call(
            Method::DELETE,
            &format!("/api/v1/clients/{harbor_id}"),
            None,
            true,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // ---- audit trail is intact and records the work above
    let (status, audit) = owner.get("/api/v1/audit?limit=200").await;
    assert_eq!(status, StatusCode::OK);
    let actions: Vec<&str> = audit["items"]
        .as_array()
        .expect("items")
        .iter()
        .filter_map(|e| e["action"].as_str())
        .collect();
    for expected in [
        "setup.completed",
        "auth.login",
        "client.created",
        "site.created",
        "user.created",
        "client.deleted",
        "auth.step_up",
    ] {
        assert!(
            actions.contains(&expected),
            "missing audit action {expected}: {actions:?}"
        );
    }
    let (status, verify) = owner.post("/api/v1/audit/verify", json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(verify["ok"], true, "{verify}");

    // ---- backups: run, then decrypt with the recovery-kit identity
    let (status, settings) = owner.get("/api/v1/settings/backups").await;
    assert_eq!(status, StatusCode::OK, "{settings}");
    assert_eq!(settings["schedule_cron"], "0 2 * * *");
    let (status, backup) = owner.post("/api/v1/backups", json!({})).await;
    assert_eq!(status, StatusCode::CREATED, "{backup}");
    assert_eq!(backup["status"], "ok");
    let file_name = backup["file_name"].as_str().expect("file").to_string();
    let archive = state.args.backup_path().join(&file_name);
    assert!(archive.exists());
    let restored = dir.path().join("restore-check");
    let manifest = rustrmm_server::backup::archive::extract(&archive, &backup_identity, &restored)
        .expect("decrypt backup");
    assert_eq!(manifest.product, "RustRMM");
    rustrmm_server::backup::integrity_check(&restored.join("rustrmm.db"))
        .await
        .expect("restored db is valid");
    assert!(
        !restored.join("keys").join("master.key").exists(),
        "master key never leaves the server"
    );

    // ---- logout ends the session
    let (status, _) = owner.post("/api/v1/auth/logout", json!({})).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = owner.get("/api/v1/auth/me").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn security_headers_and_spa_fallback() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (_state, router) = app(dir.path()).await;
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/clients/some-client")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let headers = response.headers();
    assert!(
        headers
            .get(header::CONTENT_SECURITY_POLICY)
            .expect("csp")
            .to_str()
            .expect("csp")
            .contains("script-src 'self'")
    );
    assert_eq!(headers.get(header::X_FRAME_OPTIONS).expect("xfo"), "DENY");
    assert!(headers.get(header::STRICT_TRANSPORT_SECURITY).is_some());

    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/does-not-exist")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        response
            .headers()
            .get(header::CACHE_CONTROL)
            .expect("cache-control"),
        "no-store"
    );
}
