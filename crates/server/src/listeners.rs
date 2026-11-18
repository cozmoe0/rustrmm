//! HTTP(S) listeners: the console (UI + API) and the agent gateway.

use std::net::SocketAddr;
use std::time::Duration;

use anyhow::{Context, Result};
use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::routing::get;
use axum_server::Handle;
use axum_server::tls_rustls::RustlsConfig;
use tower_http::catch_panic::CatchPanicLayer;
use tower_http::compression::CompressionLayer;
use tower_http::compression::predicate::{DefaultPredicate, NotForContentType, Predicate};

use crate::state::AppState;
use crate::tls::TlsSetup;
use crate::{api, web};

/// Routes served on the console listener.
pub fn console_router(state: AppState) -> Router {
    let mut router = Router::new()
        .nest("/api/v1", api::router())
        .route("/api/openapi.json", get(crate::openapi::spec))
        .route("/api/docs", get(crate::openapi::docs_page))
        .route("/api/docs/app.js", get(crate::openapi::docs_script))
        .route("/healthz", get(api::system::healthz))
        .fallback(web::static_handler);
    if state.args.single_listener {
        router = router.merge(agent_routes());
    }
    router
        .layer(axum::middleware::from_fn(web::security_headers))
        // Binary transfers (file downloads, backups) stream untouched: compressing them wastes CPU
        // and buffers long-running streams.
        .layer(
            CompressionLayer::new().compress_when(
                DefaultPredicate::new()
                    .and(NotForContentType::const_new("application/octet-stream"))
                    .and(NotForContentType::const_new("application/zip")),
            ),
        )
        .layer(DefaultBodyLimit::max(16 * 1024 * 1024))
        .layer(CatchPanicLayer::new())
        .with_state(state)
}

/// Agent gateway routes (enrollment, control and tunnel sockets arrive in Phase 2).
fn agent_routes() -> Router<AppState> {
    use crate::agents::{enroll, gateway, installers};
    Router::new()
        .route("/agent/v1/health", get(|| async { axum::Json(serde_json::json!({ "status": "ok", "protocol": rustrmm_proto::PROTOCOL_MAJOR })) }))
        .route("/agent/v1/enroll", axum::routing::post(enroll::enroll))
        .route("/agent/v1/connect", get(gateway::connect))
        .route("/agent/v1/tunnel/{id}", get(crate::agents::tunnels::agent_tunnel))
        .route("/agent/v1/download/{platform}/{file}", get(installers::download))
        .route("/agent/v1/releases/{version}/{platform}/{file}", get(crate::agents::releases::download))
        .route("/agent/v1/files/{sha256}", get(crate::software::files::agent_download))
        .route(rustrmm_proto::support::PATH, axum::routing::post(crate::tickets::support::support_request))
}

pub fn agent_router(state: AppState) -> Router {
    agent_routes()
        .route("/healthz", get(api::system::healthz))
        .layer(DefaultBodyLimit::max(32 * 1024 * 1024))
        .layer(CatchPanicLayer::new())
        .with_state(state)
}

/// Binds every configured listener and serves until shutdown.
pub async fn serve(state: AppState, tls: TlsSetup) -> Result<()> {
    let handle: Handle<SocketAddr> = Handle::new();
    let mut tasks = tokio::task::JoinSet::new();

    let console = console_router(state.clone());
    tasks.spawn(serve_one(
        state.args.console_bind,
        console,
        tls.server_config.clone(),
        handle.clone(),
        "console",
    ));

    if !state.args.single_listener {
        let agent = agent_router(state.clone());
        tasks.spawn(serve_one(
            state.args.agent_bind,
            agent,
            tls.server_config.clone(),
            handle.clone(),
            "agent gateway",
        ));
    }

    if let Some(addr) = state.args.http_bind {
        let console_url = state.args.console_url.clone();
        let redirect = Router::new().fallback(move |uri: axum::http::Uri| {
            let mut target = console_url.clone();
            target.set_path(uri.path());
            target.set_query(uri.query());
            async move { axum::response::Redirect::permanent(target.as_str()) }
        });
        tasks.spawn(serve_one(
            addr,
            redirect,
            None,
            handle.clone(),
            "http redirect",
        ));
    }

    let shutdown_handle = handle.clone();
    tokio::spawn(async move {
        shutdown_signal().await;
        tracing::info!("shutdown requested; draining connections");
        shutdown_handle.graceful_shutdown(Some(Duration::from_secs(10)));
    });

    while let Some(result) = tasks.join_next().await {
        result.context("listener task panicked")??;
    }
    Ok(())
}

async fn serve_one(
    addr: SocketAddr,
    router: Router,
    tls: Option<std::sync::Arc<rustls::ServerConfig>>,
    handle: Handle<SocketAddr>,
    name: &'static str,
) -> Result<()> {
    let service = router.into_make_service_with_connect_info::<SocketAddr>();
    match tls {
        Some(config) => {
            tracing::info!(%addr, listener = name, "listening (https)");
            axum_server::bind_rustls(addr, RustlsConfig::from_config(config))
                .handle(handle)
                .serve(service)
                .await
                .with_context(|| format!("{name} listener on {addr}"))
        }
        None => {
            tracing::info!(%addr, listener = name, "listening (http)");
            axum_server::bind(addr)
                .handle(handle)
                .serve(service)
                .await
                .with_context(|| format!("{name} listener on {addr}"))
        }
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
