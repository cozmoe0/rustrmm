//! Embedded web console (built from `web/dist`) and browser security headers.

use axum::body::Body;
use axum::http::{HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use rust_embed::Embed;

#[derive(Embed)]
#[folder = "../../web/dist/"]
#[allow_missing = true]
struct Assets;

const FALLBACK_PAGE: &str = r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>RustRMM</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0c0e11;color:#e7e9ee;font:15px/1.6 system-ui,sans-serif}
main{max-width:34rem;padding:2rem}code{background:#1a1e24;padding:.15rem .4rem;border-radius:4px}h1{font-size:1.25rem;color:#e0703f}</style>
</head><body><main><h1>RustRMM server is running</h1>
<p>The web console has not been built into this binary. Run <code>npm run build</code> in <code>web/</code>
and rebuild the server, or use the Vite dev server during development.</p></main></body></html>"#;

/// Serves embedded files with an SPA fallback to `index.html`.
pub async fn static_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    if path.starts_with("api/") || path.starts_with("agent/") {
        return crate::error::ApiError::not_found("Endpoint").into_response();
    }
    if !path.is_empty()
        && let Some(file) = Assets::get(path)
    {
        return file_response(path, file);
    }
    // Unknown paths without an extension are client-side routes.
    let looks_like_file = path
        .rsplit('/')
        .next()
        .is_some_and(|last| last.contains('.'));
    if looks_like_file {
        return (StatusCode::NOT_FOUND, "Not found").into_response();
    }
    match Assets::get("index.html") {
        Some(file) => file_response("index.html", file),
        None => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
            FALLBACK_PAGE,
        )
            .into_response(),
    }
}

fn file_response(path: &str, file: rust_embed::EmbeddedFile) -> Response {
    let mime = file.metadata.mimetype().to_string();
    // Hashed build assets are immutable; HTML must always revalidate.
    let cache = if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    let mut response = Response::new(Body::from(file.data.into_owned()));
    let headers = response.headers_mut();
    if let Ok(v) = HeaderValue::from_str(&mime) {
        headers.insert(header::CONTENT_TYPE, v);
    }
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    if let Ok(etag) =
        HeaderValue::from_str(&format!("\"{}\"", hex::encode(file.metadata.sha256_hash())))
    {
        headers.insert(header::ETAG, etag);
    }
    response
}

pub const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
    img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; media-src 'self' blob:; \
    frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

/// Adds browser hardening headers to every console response.
pub async fn security_headers(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let mut response = next.run(req).await;
    let headers = response.headers_mut();
    let set =
        |headers: &mut axum::http::HeaderMap, name: header::HeaderName, value: &'static str| {
            headers
                .entry(name)
                .or_insert(HeaderValue::from_static(value));
        };
    set(
        headers,
        header::CONTENT_SECURITY_POLICY,
        CONTENT_SECURITY_POLICY,
    );
    set(
        headers,
        header::STRICT_TRANSPORT_SECURITY,
        "max-age=31536000; includeSubDomains",
    );
    set(headers, header::X_CONTENT_TYPE_OPTIONS, "nosniff");
    set(headers, header::X_FRAME_OPTIONS, "DENY");
    set(headers, header::REFERRER_POLICY, "no-referrer");
    set(
        headers,
        header::HeaderName::from_static("permissions-policy"),
        "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    );
    set(
        headers,
        header::HeaderName::from_static("cross-origin-opener-policy"),
        "same-origin",
    );
    set(
        headers,
        header::HeaderName::from_static("cross-origin-resource-policy"),
        "same-origin",
    );
    response
}
