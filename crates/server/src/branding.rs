//! White-label branding: product name, logos and accent colour, per-client logos, the public
//! `/branding` endpoint for the login page, and the brand applied to report PDFs and e-mails.
//!
//! Logos are PNG or SVG, at most 512 KB. SVGs are rebuilt from an allowlist of elements and
//! attributes: scripts, event handlers, `foreignObject`, `<style>`, images, links, animation and
//! any reference outside the document are dropped.

use axum::Json;
use axum::body::Body;
use axum::extract::{FromRequest, Multipart, Path, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::Response;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use utoipa::ToSchema;

use crate::auth::AuthCtx;
use crate::error::{ApiError, ApiResult};
use crate::rbac::perm;
use crate::state::AppState;

pub const MAX_LOGO_BYTES: usize = 512 * 1024;
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

/// Branding settings (setting key `branding`).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct BrandingSettings {
    pub product_name: String,
    #[serde(default)]
    pub logo_light_file_id: Option<String>,
    #[serde(default)]
    pub logo_dark_file_id: Option<String>,
    /// `#rrggbb`; `null` keeps the default copper accent.
    #[serde(default)]
    pub accent_color: Option<String>,
}

impl Default for BrandingSettings {
    fn default() -> Self {
        Self {
            product_name: rustrmm_common::PRODUCT_NAME.into(),
            logo_light_file_id: None,
            logo_dark_file_id: None,
            accent_color: None,
        }
    }
}

pub async fn load(state: &AppState) -> anyhow::Result<BrandingSettings> {
    Ok(crate::db::get_setting(&state.db, "branding")
        .await?
        .unwrap_or_default())
}

pub fn file_url(id: &str) -> String {
    format!("/api/v1/branding/files/{id}")
}

/// The accent colour as RGB (default copper `#e0703f`).
pub fn accent_rgb(settings: &BrandingSettings) -> (u8, u8, u8) {
    settings
        .accent_color
        .as_deref()
        .and_then(parse_hex_color)
        .unwrap_or((0xe0, 0x70, 0x3f))
}

pub fn parse_hex_color(raw: &str) -> Option<(u8, u8, u8)> {
    let hex = raw.strip_prefix('#')?;
    if hex.len() != 6 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let v = u32::from_str_radix(hex, 16).ok()?;
    Some(((v >> 16) as u8, (v >> 8) as u8, v as u8))
}

/// A stored logo.
pub struct LogoFile {
    pub content_type: String,
    pub data: Vec<u8>,
}

pub async fn load_file(state: &AppState, id: &str) -> anyhow::Result<Option<LogoFile>> {
    let row: Option<(String, Vec<u8>)> =
        sqlx::query_as("SELECT content_type, data FROM branding_files WHERE id = ?")
            .bind(id)
            .fetch_optional(&state.db)
            .await?;
    Ok(row.map(|(content_type, data)| LogoFile { content_type, data }))
}

/// PNG bytes of the MSP logo (light variant) for PDFs, when it is a PNG.
pub async fn msp_png(state: &AppState, settings: &BrandingSettings) -> Option<Vec<u8>> {
    let id = settings.logo_light_file_id.as_deref()?;
    let file = load_file(state, id).await.ok()??;
    (file.content_type == "image/png").then_some(file.data)
}

/// PNG bytes of a client's logo, when it is a PNG.
pub async fn client_png(state: &AppState, client_id: &str) -> Option<Vec<u8>> {
    let id: Option<String> = sqlx::query_scalar("SELECT logo_blob FROM clients WHERE id = ?")
        .bind(client_id)
        .fetch_optional(&state.db)
        .await
        .ok()?
        .flatten();
    let file = load_file(state, &id?).await.ok()??;
    (file.content_type == "image/png").then_some(file.data)
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Wraps an HTML e-mail body (a full `<html><body>…</body></html>` document or a fragment) with
/// the brand header (logo or product name on the accent colour) and footer.
pub fn brand_email_html(state: &AppState, settings: &BrandingSettings, html: &str) -> String {
    let (r, g, b) = accent_rgb(settings);
    let base = crate::monitoring::notify::delivery::console_base(state);
    let logo = settings
        .logo_light_file_id
        .as_deref()
        .map(|id| {
            format!(
                "<img src=\"{}{}\" alt=\"{}\" height=\"28\" style=\"display:block;max-height:28px\">",
                base.trim_end_matches('/'),
                escape_html(&file_url(id)),
                escape_html(&settings.product_name)
            )
        })
        .unwrap_or_else(|| {
            format!(
                "<span style=\"color:#fff;font-weight:600;font-size:16px\">{}</span>",
                escape_html(&settings.product_name)
            )
        });
    let header = format!(
        "<div style=\"background:#{r:02x}{g:02x}{b:02x};padding:12px 16px;margin:0 0 16px 0\">{logo}</div>"
    );
    let footer = format!(
        "<p style=\"color:#999;font-size:11px;margin-top:24px\">Sent by {}</p>",
        escape_html(&settings.product_name)
    );
    let lower = html.to_ascii_lowercase();
    match (lower.find("<body"), lower.rfind("</body>")) {
        (Some(start), Some(end)) if end > start => {
            let open_end = lower[start..]
                .find('>')
                .map(|i| start + i + 1)
                .unwrap_or(start);
            format!(
                "{}{header}{}{footer}{}",
                &html[..open_end],
                &html[open_end..end],
                &html[end..]
            )
        }
        _ => format!(
            "<html><body style=\"font-family:sans-serif\">{header}{html}{footer}</body></html>"
        ),
    }
}

// ------------------------------------------------------------------ routes

/// Public branding for the login page and console title.
#[derive(Debug, Serialize, ToSchema)]
pub struct PublicBranding {
    pub product_name: String,
    pub accent_color: Option<String>,
    pub logo_light_url: Option<String>,
    pub logo_dark_url: Option<String>,
}

/// Branding (public)
///
/// Product name, accent colour and logo URLs for the login page. No authentication.
#[utoipa::path(get, path = "/api/v1/branding", tag = "Branding",
    responses((status = 200, body = PublicBranding)), security(()))]
pub async fn public(State(state): State<AppState>) -> ApiResult<Json<PublicBranding>> {
    let s = load(&state).await?;
    Ok(Json(PublicBranding {
        product_name: s.product_name.clone(),
        accent_color: s.accent_color.clone(),
        logo_light_url: s.logo_light_file_id.as_deref().map(file_url),
        logo_dark_url: s
            .logo_dark_file_id
            .as_deref()
            .or(s.logo_light_file_id.as_deref())
            .map(file_url),
    }))
}

/// A branding file (public)
///
/// Serves an uploaded logo. SVGs are served with a sandboxing CSP.
#[utoipa::path(get, path = "/api/v1/branding/files/{id}", tag = "Branding",
    params(("id" = String, Path)), responses((status = 200, description = "The image"), (status = 404)), security(()))]
pub async fn serve_file(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let file = load_file(&state, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("File"))?;
    let mut response = Response::new(Body::from(file.data));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&file.content_type)
            .unwrap_or(HeaderValue::from_static("application/octet-stream")),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=3600"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; style-src 'unsafe-inline'; sandbox"),
    );
    headers.insert(
        header::HeaderName::from_static("cross-origin-resource-policy"),
        HeaderValue::from_static("cross-origin"),
    );
    Ok(response)
}

/// Get branding settings
#[utoipa::path(get, path = "/api/v1/settings/branding", tag = "Branding",
    responses((status = 200, body = BrandingSettings)))]
pub async fn get_settings(
    State(state): State<AppState>,
    ctx: AuthCtx,
) -> ApiResult<Json<BrandingSettings>> {
    ctx.require_global(perm::SETTINGS_VIEW)?;
    Ok(Json(load(&state).await?))
}

async fn check_file(state: &AppState, id: &Option<String>) -> ApiResult<()> {
    if let Some(id) = id {
        let found: Option<String> =
            sqlx::query_scalar("SELECT id FROM branding_files WHERE id = ?")
                .bind(id)
                .fetch_optional(&state.db)
                .await?;
        if found.is_none() {
            return Err(ApiError::validation(format!("Unknown branding file {id}")));
        }
    }
    Ok(())
}

/// Update branding settings
#[utoipa::path(put, path = "/api/v1/settings/branding", tag = "Branding",
    request_body = BrandingSettings, responses((status = 200, body = BrandingSettings)))]
pub async fn put_settings(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(mut body): Json<BrandingSettings>,
) -> ApiResult<Json<BrandingSettings>> {
    ctx.require_global(perm::SETTINGS_MANAGE)?;
    body.product_name = body.product_name.trim().to_string();
    if body.product_name.is_empty() || body.product_name.chars().count() > 60 {
        return Err(ApiError::validation("product_name must be 1–60 characters"));
    }
    body.accent_color = body
        .accent_color
        .take()
        .map(|c| c.trim().to_ascii_lowercase())
        .filter(|c| !c.is_empty());
    if let Some(c) = &body.accent_color
        && parse_hex_color(c).is_none()
    {
        return Err(ApiError::validation("accent_color must be #rrggbb"));
    }
    body.logo_light_file_id = body.logo_light_file_id.take().filter(|s| !s.is_empty());
    body.logo_dark_file_id = body.logo_dark_file_id.take().filter(|s| !s.is_empty());
    check_file(&state, &body.logo_light_file_id).await?;
    check_file(&state, &body.logo_dark_file_id).await?;
    crate::db::set_setting(&state.db, "branding", &body).await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("settings.branding_updated")
                .details(serde_json::to_value(&body)?),
        )
        .await;
    Ok(Json(body))
}

#[derive(Debug, Serialize, ToSchema)]
pub struct BrandingFile {
    pub id: String,
    /// `image/svg+xml` or `image/png`
    pub content_type: String,
    pub size_bytes: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub url: String,
    /// The SVG was changed by sanitising (elements or attributes removed).
    pub sanitized: bool,
    pub created_at: DateTime<Utc>,
}

/// Upload a logo
///
/// `multipart/form-data` with one `file` field: PNG or SVG, at most 512 KB. Needs
/// `settings.manage` (product logos) or `clients.manage` (client logos).
#[utoipa::path(post, path = "/api/v1/files/branding", tag = "Branding",
    request_body(content_type = "multipart/form-data", description = "One `file` field"),
    responses((status = 201, body = BrandingFile), (status = 422, description = "Not a PNG/SVG, too large, or unsafe")))]
pub async fn upload(
    State(state): State<AppState>,
    ctx: AuthCtx,
    req: Request,
) -> ApiResult<(StatusCode, Json<BrandingFile>)> {
    if !ctx.scope.has_global(perm::SETTINGS_MANAGE) && !ctx.scope.has_anywhere(perm::CLIENTS_MANAGE)
    {
        return Err(ApiError::forbidden("Missing permission: settings.manage")
            .with_details(json!({ "permission": perm::SETTINGS_MANAGE })));
    }
    let mut multipart = Multipart::from_request(req, &state)
        .await
        .map_err(|_| ApiError::bad_request("Expected multipart/form-data with a file field"))?;
    let mut found: Option<(String, Vec<u8>)> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| ApiError::bad_request("Malformed multipart body"))?
    {
        if field.name() != Some("file") {
            continue;
        }
        let name = field.file_name().unwrap_or("logo").to_string();
        let mut data = Vec::new();
        let mut field = field;
        while let Some(chunk) = field
            .chunk()
            .await
            .map_err(|_| ApiError::bad_request("Malformed multipart body"))?
        {
            data.extend_from_slice(&chunk);
            if data.len() > MAX_LOGO_BYTES {
                return Err(ApiError::validation("Logos are at most 512 KB"));
            }
        }
        found = Some((name, data));
        break;
    }
    let (name, data) = found.ok_or_else(|| ApiError::validation("No file field in the upload"))?;
    let (content_type, data, width, height, sanitized) = if data.starts_with(PNG_SIGNATURE) {
        let (w, h) =
            png_dimensions(&data).ok_or_else(|| ApiError::validation("The PNG is invalid"))?;
        if w == 0 || h == 0 || w > 4096 || h > 4096 {
            return Err(ApiError::validation(
                "PNG logos must be at most 4096×4096 pixels",
            ));
        }
        ("image/png", data, Some(w as i64), Some(h as i64), false)
    } else {
        let text = std::str::from_utf8(&data)
            .map_err(|_| ApiError::validation("Logos must be PNG or SVG"))?;
        let clean = sanitize_svg(text).map_err(ApiError::validation)?;
        let changed = clean.removed > 0;
        ("image/svg+xml", clean.svg.into_bytes(), None, None, changed)
    };
    let id = rustrmm_common::new_id();
    let now = rustrmm_common::now();
    let sha = rustrmm_crypto::random::sha256_hex(&data);
    let size = data.len() as i64;
    sqlx::query(
        "INSERT INTO branding_files (id, content_type, data, sha256, size_bytes, width, height, original_name, uploaded_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(content_type)
    .bind(&data)
    .bind(&sha)
    .bind(size)
    .bind(width)
    .bind(height)
    .bind(name.chars().take(200).collect::<String>())
    .bind(&ctx.user.id)
    .bind(now)
    .execute(&state.db)
    .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("branding.file_uploaded")
                .target("branding_file", &id, &name)
                .details(json!({ "content_type": content_type, "size": size, "sha256": sha, "sanitized": sanitized })),
        )
        .await;
    Ok((
        StatusCode::CREATED,
        Json(BrandingFile {
            url: file_url(&id),
            id,
            content_type: content_type.into(),
            size_bytes: size,
            width,
            height,
            sanitized,
            created_at: now,
        }),
    ))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ClientLogoBody {
    /// A branding file id, or `null` to remove the logo.
    pub file_id: Option<String>,
}

/// Set a client's logo
///
/// Used on that client's report PDFs. Needs `clients.manage` over the client.
#[utoipa::path(put, path = "/api/v1/clients/{id}/logo", tag = "Branding",
    params(("id" = String, Path)), request_body = ClientLogoBody,
    responses((status = 200, description = "`{ logo_url }`")))]
pub async fn put_client_logo(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(body): Json<ClientLogoBody>,
) -> ApiResult<Json<serde_json::Value>> {
    let name: Option<String> = sqlx::query_scalar("SELECT name FROM clients WHERE id = ?")
        .bind(&id)
        .fetch_optional(&state.db)
        .await?;
    let name = name
        .filter(|_| ctx.scope.can_see_client(perm::CLIENTS_VIEW, &id))
        .ok_or_else(|| ApiError::not_found("Client"))?;
    ctx.require_client(perm::CLIENTS_MANAGE, &id)?;
    let file_id = body.file_id.filter(|s| !s.is_empty());
    check_file(&state, &file_id).await?;
    sqlx::query("UPDATE clients SET logo_blob = ?, updated_at = ? WHERE id = ?")
        .bind(&file_id)
        .bind(rustrmm_common::now())
        .bind(&id)
        .execute(&state.db)
        .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("client.logo_updated")
                .target("client", &id, &name)
                .client(&id)
                .details(json!({ "file_id": file_id })),
        )
        .await;
    state
        .events
        .publish("clients.changed", Some(id.clone()), json!({ "id": id }));
    Ok(Json(
        json!({ "logo_url": file_id.as_deref().map(file_url) }),
    ))
}

// ------------------------------------------------------------------ PNG and SVG checks

/// Width and height from the IHDR chunk.
pub fn png_dimensions(data: &[u8]) -> Option<(u32, u32)> {
    if !data.starts_with(PNG_SIGNATURE) || data.len() < 33 || &data[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes(data[16..20].try_into().ok()?);
    let h = u32::from_be_bytes(data[20..24].try_into().ok()?);
    Some((w, h))
}

pub struct SanitizedSvg {
    pub svg: String,
    /// Elements and attributes dropped.
    pub removed: usize,
}

const SVG_ELEMENTS: &[&str] = &[
    "svg",
    "g",
    "defs",
    "title",
    "desc",
    "path",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "text",
    "tspan",
    "linearGradient",
    "radialGradient",
    "stop",
    "clipPath",
    "mask",
    "pattern",
    "symbol",
    "use",
];

const SVG_ATTRIBUTES: &[&str] = &[
    "id",
    "x",
    "y",
    "x1",
    "y1",
    "x2",
    "y2",
    "cx",
    "cy",
    "r",
    "rx",
    "ry",
    "fx",
    "fy",
    "fr",
    "width",
    "height",
    "d",
    "points",
    "transform",
    "fill",
    "fill-opacity",
    "fill-rule",
    "stroke",
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-miterlimit",
    "stroke-dasharray",
    "stroke-dashoffset",
    "stroke-opacity",
    "opacity",
    "viewBox",
    "preserveAspectRatio",
    "version",
    "offset",
    "stop-color",
    "stop-opacity",
    "gradientUnits",
    "gradientTransform",
    "spreadMethod",
    "clip-path",
    "clip-rule",
    "mask",
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "text-anchor",
    "dominant-baseline",
    "letter-spacing",
    "patternUnits",
    "patternContentUnits",
    "patternTransform",
    "maskUnits",
    "maskContentUnits",
    "clipPathUnits",
    "display",
    "visibility",
    "color",
    "dx",
    "dy",
    "rotate",
    "textLength",
    "lengthAdjust",
    "vector-effect",
    "shape-rendering",
    "paint-order",
    "style",
    "href",
];

const SVG_NS: &str = "http://www.w3.org/2000/svg";
const XLINK_NS: &str = "http://www.w3.org/1999/xlink";

fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// A value is safe when every `url(…)` it contains is a same-document fragment and it carries
/// no script or import.
fn safe_value(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    if lower.contains("javascript:")
        || lower.contains("vbscript:")
        || lower.contains("data:")
        || lower.contains("@import")
        || lower.contains("expression(")
        || lower.contains('\\')
    {
        return false;
    }
    let mut rest = lower.as_str();
    while let Some(i) = rest.find("url(") {
        let after = rest[i + 4..].trim_start().trim_start_matches(['"', '\'']);
        if !after.starts_with('#') {
            return false;
        }
        rest = &rest[i + 4..];
    }
    true
}

/// Rebuilds an SVG from allowlisted elements and attributes.
pub fn sanitize_svg(input: &str) -> Result<SanitizedSvg, String> {
    let options = roxmltree::ParsingOptions {
        allow_dtd: false,
        ..roxmltree::ParsingOptions::default()
    };
    let doc = roxmltree::Document::parse_with_options(input, options)
        .map_err(|e| format!("The SVG could not be parsed: {e}"))?;
    let root = doc.root_element();
    if root.tag_name().name() != "svg" || root.tag_name().namespace().is_some_and(|ns| ns != SVG_NS)
    {
        return Err("The file is not an SVG image".into());
    }
    let mut out = String::with_capacity(input.len());
    let mut removed = 0usize;
    write_node(root, &mut out, &mut removed, true);
    Ok(SanitizedSvg { svg: out, removed })
}

fn write_node(node: roxmltree::Node<'_, '_>, out: &mut String, removed: &mut usize, is_root: bool) {
    let name = node.tag_name().name();
    let ns_ok = node.tag_name().namespace().is_none_or(|ns| ns == SVG_NS);
    if !ns_ok || !SVG_ELEMENTS.contains(&name) {
        *removed += 1;
        return;
    }
    out.push('<');
    out.push_str(name);
    if is_root {
        out.push_str(&format!(" xmlns=\"{SVG_NS}\""));
    }
    for attr in node.attributes() {
        let local = attr.name();
        let ns = attr.namespace();
        let is_href = local == "href" && (ns.is_none() || ns == Some(XLINK_NS));
        let allowed = if is_href {
            // Only same-document references (`#id`) on <use> and gradients.
            attr.value().starts_with('#') && !attr.value().contains(['(', ')', ' ', '"'])
        } else {
            ns.is_none()
                && SVG_ATTRIBUTES.contains(&local)
                && !local.to_ascii_lowercase().starts_with("on")
                && safe_value(attr.value())
        };
        if !allowed {
            *removed += 1;
            continue;
        }
        out.push_str(&format!(" {local}=\"{}\"", escape_xml(attr.value())));
    }
    let children: Vec<_> = node.children().collect();
    if children.is_empty() {
        out.push_str("/>");
        return;
    }
    out.push('>');
    let keeps_text = matches!(name, "text" | "tspan" | "title" | "desc");
    for child in children {
        if child.is_element() {
            write_node(child, out, removed, false);
        } else if child.is_text() {
            if keeps_text {
                out.push_str(&escape_xml(child.text().unwrap_or_default()));
            }
        } else if !child.is_comment() {
            *removed += 1;
        }
    }
    out.push_str(&format!("</{name}>"));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn svg_sanitiser_strips_active_content() {
        let evil = r##"<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10" onload="alert(1)">
  <script>alert(1)</script>
  <style>@import url(https://evil.example/x.css);</style>
  <defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs>
  <rect width="10" height="10" fill="url(#g)" onclick="steal()"/>
  <circle r="2" fill="url(https://evil.example/p)" style="fill:url(http://evil)"/>
  <foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>
  <image href="https://evil.example/track.png"/>
  <use xlink:href="https://evil.example/s.svg#a"/>
  <use href="#g"/>
  <a href="javascript:alert(1)"><text>Click</text></a>
  <text x="1" y="5">Acme &amp; Co</text>
  <animate attributeName="href" to="javascript:alert(1)"/>
</svg>"##;
        let clean = sanitize_svg(evil).expect("parses");
        let s = clean.svg;
        for bad in [
            "script",
            "onload",
            "onclick",
            "@import",
            "foreignObject",
            "image",
            "evil.example",
            "javascript",
            "animate",
            "<a",
            "style=",
        ] {
            assert!(!s.contains(bad), "{bad} survived: {s}");
        }
        assert!(s.contains("fill=\"url(#g)\""), "{s}");
        assert!(s.contains("<use href=\"#g\"/>"), "{s}");
        assert!(s.contains("Acme &amp; Co"), "{s}");
        assert!(s.starts_with("<svg xmlns=\"http://www.w3.org/2000/svg\""));
        assert!(clean.removed >= 10);
    }

    #[test]
    fn svg_sanitiser_refuses_dtds_and_non_svg() {
        let bomb = r#"<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaa">]><svg xmlns="http://www.w3.org/2000/svg">&a;</svg>"#;
        assert!(sanitize_svg(bomb).is_err());
        assert!(sanitize_svg("<html><body/></html>").is_err());
        assert!(sanitize_svg("not xml").is_err());
    }

    #[test]
    fn png_header_and_colors() {
        let mut png = PNG_SIGNATURE.to_vec();
        png.extend_from_slice(&[0, 0, 0, 13]);
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&64u32.to_be_bytes());
        png.extend_from_slice(&32u32.to_be_bytes());
        png.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(png_dimensions(&png), Some((64, 32)));
        assert_eq!(parse_hex_color("#0a1B2c"), Some((10, 27, 44)));
        assert_eq!(parse_hex_color("0a1b2c"), None);
        assert_eq!(parse_hex_color("#0a1b2"), None);
    }
}
