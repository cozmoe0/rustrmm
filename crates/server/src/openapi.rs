//! OpenAPI document (`GET /api/openapi.json`) built from the `#[utoipa::path]` annotations plus
//! every other route of the `/api/v1` router (read from its source at compile time, so nothing
//! routed is ever missing), and a self-hosted documentation page
//! (`GET /api/docs`) whose script is served from `/api/docs/app.js` so it satisfies the console
//! CSP (`script-src 'self'`).

#[path = "openapi_routes.rs"]
mod routes;

use std::sync::OnceLock;

use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};
use utoipa::OpenApi as _;
use utoipa::openapi::path::{
    HttpMethod, Operation, OperationBuilder, ParameterBuilder, ParameterIn,
};
use utoipa::openapi::schema::{ObjectBuilder, Type};
use utoipa::openapi::security::{
    ApiKey, ApiKeyValue, HttpAuthScheme, HttpBuilder, SecurityRequirement, SecurityScheme,
};
use utoipa::openapi::{InfoBuilder, OpenApi, Required, ResponseBuilder};

/// Tag of a handler module alias used in `api/mod.rs`.
fn tag_for(alias: &str) -> &'static str {
    match alias {
        "auth" => "Authentication",
        "me" => "My account",
        "oidc" => "Single sign-on",
        "tokens" => "API tokens",
        "tenancy" => "Clients & sites",
        "users" => "Users & roles",
        "devices" => "Devices",
        "remote" => "Remote tools",
        "desktop" => "Remote desktop",
        "releases" => "Agent releases",
        "enrollment" => "Deployment",
        "audit" => "Audit",
        "backups" => "Backups",
        "system" => "System",
        "approvals" | "jobs" => "Jobs",
        "custom_fields" => "Custom fields",
        "groups" => "Groups",
        "policies" => "Policies",
        "scripts" | "variables" => "Scripts",
        "automation_settings" | "monitoring_settings" => "Settings",
        "notify" | "channels" | "rules" => "Notifications",
        "alerts" => "Alerts",
        "monitoring" | "ingest" | "maintenance" => "Monitoring",
        "net_assets" | "snmp_credentials" | "snmp_devices" | "snmp_metrics" | "probes"
        | "scans" | "snmp_templates" | "topology" | "traps" | "network" => "Network",
        "patches" | "patch_approvals" | "compliance" => "Patching",
        "explorer" | "software_files" | "library" | "deployments" => "Software",
        "tickets" | "canned" | "ticket_comments" | "contacts" | "ticket_email"
        | "ticket_queues" | "alert_ticket_rules" | "sla" | "time_entries" => "Tickets",
        "escrow" => "Escrow",
        "events" => "Live events",
        "setup" => "Setup",
        "reports" => "Reports",
        "dashboards" => "Dashboards",
        "webhooks" => "Webhooks",
        "branding" => "Branding",
        _ => "Other",
    }
}

/// `list_clients` → "List clients"; `get` on `/clients/{id}` → "Get client".
fn summary_for(function: &str, path: &str) -> String {
    let noun = path
        .split('/')
        .rfind(|s| !s.is_empty() && !s.starts_with('{'))
        .unwrap_or("item")
        .replace('-', " ");
    let singular = match noun.strip_suffix('s') {
        Some(n) if !noun.ends_with("ss") => n.to_string(),
        _ => noun.clone(),
    };
    let text = match function {
        "list" => format!("List {noun}"),
        "get" => format!("Get {singular}"),
        "create" => format!("Create {singular}"),
        "update" | "put" => format!("Update {singular}"),
        "delete" => format!("Delete {singular}"),
        other => other.replace('_', " "),
    };
    let mut chars = text.chars();
    chars
        .next()
        .map(|c| c.to_uppercase().collect::<String>() + chars.as_str())
        .unwrap_or_default()
}

/// Every `(method, path, handler)` routed in `api/mod.rs` (paths include `/api/v1`).
pub fn router_routes() -> Vec<(String, String, String)> {
    static ROUTES: OnceLock<Vec<(String, String, String)>> = OnceLock::new();
    ROUTES
        .get_or_init(|| {
            let source = include_str!("api/mod.rs");
            let route = regex::Regex::new(r#"\.route\(\s*"([^"]+)""#).expect("regex");
            let handler = regex::Regex::new(
                r"(?:^|[^\w])(?:axum::routing::)?(get|post|put|patch|delete)\(\s*([\w:]+)",
            )
            .expect("regex");
            let mut out = Vec::new();
            for m in route.captures_iter(source) {
                let whole = m.get(0).expect("match");
                let path = format!("/api/v1{}", &m[1]);
                // The handler chain runs to the parenthesis closing `.route(`.
                let rest = &source[whole.start() + ".route(".len()..];
                let mut depth = 1;
                let mut end = rest.len();
                for (i, c) in rest.char_indices() {
                    match c {
                        '(' => depth += 1,
                        ')' => {
                            depth -= 1;
                            if depth == 0 {
                                end = i;
                                break;
                            }
                        }
                        _ => {}
                    }
                }
                for h in handler.captures_iter(&rest[..end]) {
                    out.push((h[1].to_string(), path.clone(), h[2].to_string()));
                }
            }
            out
        })
        .clone()
}

fn method(m: &str) -> HttpMethod {
    match m {
        "post" => HttpMethod::Post,
        "put" => HttpMethod::Put,
        "patch" => HttpMethod::Patch,
        "delete" => HttpMethod::Delete,
        _ => HttpMethod::Get,
    }
}

fn path_params(path: &str) -> Vec<String> {
    path.split('/')
        .filter_map(|s| s.strip_prefix('{').and_then(|s| s.strip_suffix('}')))
        .map(str::to_string)
        .collect()
}

/// `get /api/v1/devices/{id}/patches` → `get_devices_id_patches`
fn operation_id(m: &str, path: &str) -> String {
    let mut id = m.to_string();
    for seg in path
        .trim_start_matches("/api/v1")
        .split('/')
        .filter(|s| !s.is_empty())
    {
        id.push('_');
        id.push_str(
            &seg.trim_matches(|c| c == '{' || c == '}')
                .replace(['-', '.'], "_"),
        );
    }
    id
}

fn operations_mut(
    item: &mut utoipa::openapi::path::PathItem,
) -> Vec<(&'static str, &mut Option<Operation>)> {
    vec![
        ("get", &mut item.get),
        ("put", &mut item.put),
        ("post", &mut item.post),
        ("delete", &mut item.delete),
        ("patch", &mut item.patch),
        ("head", &mut item.head),
        ("options", &mut item.options),
        ("trace", &mut item.trace),
    ]
}

/// Builds the document.
pub fn build() -> OpenApi {
    let mut doc = routes::Annotated::openapi();
    doc.info = InfoBuilder::new()
        .title("RustRMM API")
        .version(rustrmm_common::VERSION)
        .description(Some(
            "REST API of the RustRMM server. Authenticate with the console session cookie (plus \
             `X-CSRF-Token` on mutations) or with `Authorization: Bearer rrmm_pat_…` (API tokens; no \
             CSRF token; step-up actions, shells and desktops are refused). Errors use \
             `{ \"error\": { \"code\", \"message\", \"details\" } }`. Results are scoped to the caller.",
        ))
        .build();
    let components = doc.components.get_or_insert_with(Default::default);
    components.add_security_scheme(
        "session",
        SecurityScheme::ApiKey(ApiKey::Cookie(ApiKeyValue::new("__Host-rustrmm_session"))),
    );
    components.add_security_scheme(
        "bearer",
        SecurityScheme::Http(
            HttpBuilder::new()
                .scheme(HttpAuthScheme::Bearer)
                .bearer_format("rrmm_pat")
                .build(),
        ),
    );
    doc.security = Some(vec![
        SecurityRequirement::new("session", Vec::<String>::new()),
        SecurityRequirement::new("bearer", Vec::<String>::new()),
    ]);
    for (m, path, handler) in router_routes() {
        if doc.paths.get_path_operation(&path, method(&m)).is_some() {
            continue;
        }
        let (alias, function) = handler.split_once("::").unwrap_or(("", handler.as_str()));
        let mut op = OperationBuilder::new()
            .tag(tag_for(alias))
            .summary(Some(summary_for(function, &path)))
            .response("200", ResponseBuilder::new().description("Success").build())
            .response(
                "403",
                ResponseBuilder::new()
                    .description("Missing permission or step-up required")
                    .build(),
            );
        for p in path_params(&path) {
            op = op.parameter(
                ParameterBuilder::new()
                    .name(p)
                    .parameter_in(ParameterIn::Path)
                    .required(Required::True)
                    .schema(Some(ObjectBuilder::new().schema_type(Type::String))),
            );
        }
        doc.paths
            .add_path_operation(&path, vec![method(&m)], op.build());
    }
    for (path, item) in doc.paths.paths.iter_mut() {
        for (m, op) in operations_mut(item) {
            if let Some(op) = op {
                op.operation_id = Some(operation_id(m, path));
            }
        }
    }
    doc
}

fn spec_json() -> &'static str {
    static SPEC: OnceLock<String> = OnceLock::new();
    SPEC.get_or_init(|| {
        build()
            .to_json()
            .unwrap_or_else(|e| format!("{{\"error\":\"{e}\"}}"))
    })
}

/// `GET /api/openapi.json` (public)
pub async fn spec() -> Response {
    let mut r = spec_json().to_string().into_response();
    r.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    r
}

const DOCS_HTML: &str = include_str!("openapi_docs.html");
const DOCS_JS: &str = include_str!("openapi_docs.js");

/// `GET /api/docs` (public)
pub async fn docs_page() -> Response {
    let mut r = DOCS_HTML.into_response();
    r.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    r
}

/// `GET /api/docs/app.js` (public)
pub async fn docs_script() -> Response {
    let mut r = DOCS_JS.into_response();
    r.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/javascript; charset=utf-8"),
    );
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    r
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use serde_json::Value;

    use super::*;

    fn spec() -> Value {
        serde_json::from_str(spec_json()).expect("the spec is valid JSON")
    }

    #[test]
    fn spec_parses_and_lists_core_paths() {
        let spec = spec();
        assert_eq!(spec["openapi"], "3.1.0");
        let paths = spec["paths"].as_object().expect("paths");
        for (path, m) in [
            ("/api/v1/auth/login", "post"),
            ("/api/v1/auth/me", "get"),
            ("/api/v1/clients", "get"),
            ("/api/v1/clients/{id}", "patch"),
            ("/api/v1/sites", "get"),
            ("/api/v1/devices", "get"),
            ("/api/v1/devices/{id}", "get"),
            ("/api/v1/alerts", "get"),
            ("/api/v1/tickets", "post"),
            ("/api/v1/scripts", "get"),
            ("/api/v1/jobs", "post"),
            ("/api/v1/patches", "get"),
            ("/api/v1/patching/compliance", "get"),
            ("/api/v1/escrow", "get"),
            ("/api/v1/network/scans", "get"),
            ("/api/v1/reports/run", "post"),
            ("/api/v1/dashboards/widgets/{widget}", "get"),
            ("/api/v1/api-tokens", "post"),
            ("/api/v1/webhooks/{id}/deliveries", "get"),
            ("/api/v1/settings/sso/providers", "post"),
            ("/api/v1/branding", "get"),
        ] {
            assert!(
                paths.get(path).and_then(|p| p.get(m)).is_some(),
                "{m} {path} missing from the spec"
            );
        }
        // Typed Phase 11 schemas are present.
        let schemas = spec["components"]["schemas"].as_object().expect("schemas");
        for name in [
            "Report",
            "Section",
            "ApiToken",
            "Webhook",
            "Dashboard",
            "ProviderDto",
            "BrandingSettings",
        ] {
            assert!(schemas.contains_key(name), "schema {name} missing");
        }
        assert!(spec["components"]["securitySchemes"]["bearer"].is_object());
    }

    #[test]
    fn operation_ids_are_unique_and_every_operation_is_tagged() {
        let spec = spec();
        let mut ids = HashSet::new();
        for (path, item) in spec["paths"].as_object().expect("paths") {
            for (m, op) in item.as_object().expect("item") {
                if !matches!(m.as_str(), "get" | "post" | "put" | "patch" | "delete") {
                    continue;
                }
                let id = op["operationId"].as_str().expect("operationId");
                assert!(ids.insert(id.to_string()), "duplicate operationId {id}");
                assert!(
                    op["tags"].as_array().is_some_and(|t| !t.is_empty()),
                    "{m} {path} has no tag"
                );
                assert!(
                    op["summary"].as_str().is_some_and(|s| !s.is_empty()),
                    "{m} {path} has no summary"
                );
            }
        }
    }

    /// Every route in `api/mod.rs` appears in the spec, and most are documented by annotations
    /// (path parameters and responses, not just the generated summary).
    #[test]
    fn every_router_route_is_documented() {
        let spec = spec();
        let paths = spec["paths"].as_object().expect("paths");
        let routes = router_routes();
        assert!(routes.len() > 300, "parsed only {} routes", routes.len());
        let mut annotated = 0;
        for (method, path, handler) in &routes {
            let op = paths
                .get(path)
                .and_then(|p| p.get(method))
                .unwrap_or_else(|| panic!("{method} {path} ({handler}) is missing"));
            let responses = op["responses"].as_object().expect("responses");
            let generated = responses.len() == 2
                && responses.contains_key("403")
                && responses
                    .get("200")
                    .is_some_and(|r| r.get("content").is_none());
            if !generated {
                annotated += 1;
            }
        }
        assert!(
            annotated * 4 >= routes.len() * 3,
            "only {annotated} of {} routes are annotated",
            routes.len()
        );
    }
}
