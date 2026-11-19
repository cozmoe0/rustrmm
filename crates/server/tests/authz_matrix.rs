//! Authorization matrix: every console API route (read from the router source, so a new route
//! without an expectation fails the test) against Owner, Administrator, Technician, Help Desk,
//! Auditor, a Technician scoped to one client and a user without any role. Also checks that
//! step-up routes demand a recent MFA confirmation, that API tokens can never reach step-up
//! actions, shells, desktops or account routes, and that a client-scoped technician only sees
//! that client's data.
//!
//! Classification of a response: `401` = not signed in; `403 forbidden` = permission denied;
//! `403 step_up_required` / `403 token_not_allowed` as named; a `404` on a route with path
//! parameters counts as denied for roles expected to be denied (the resource is hidden);
//! anything else means the request passed the authorization layer.
//!
//! Request bodies are synthesised from the server's own deserialisation errors (as a user with
//! no permissions, so nothing happens while probing), so permission checks are reached even for
//! typed bodies. Set `AUTHZ_DISCOVER=1` to print the observed matrix instead of asserting (handy
//! when adding routes).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::net::SocketAddr;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use clap::Parser;
use http_body_util::BodyExt;
use rustrmm_crypto::sign::SigningKey;
use rustrmm_proto::deploy::{EnrollRequest, EnrollResponse};
use rustrmm_server::state::AppState;
use serde_json::{Value, json};
use tower::ServiceExt;

const ORIGIN: &str = "https://rmm.test";

/// Who may call a route.
#[derive(Debug, Clone, Copy)]
enum Rule {
    /// No sign-in needed.
    Public,
    /// Any signed-in user, even one without permissions.
    Authenticated,
    /// The permission on a global (installation-wide) assignment.
    Global(&'static str),
    /// The permission at any scope; results and targets are filtered to that scope.
    Scoped(&'static str),
    /// WebSocket upgrade authorised by a one-time ticket (checked when the ticket is issued).
    Ticket,
    /// Only the author of the resource (the owner created the fixture).
    Author,
}

use Rule::*;

/// Expectations for every `/api/v1` route.
const MATRIX: &[(&str, &str, Rule)] = &[
    ("GET", "/setup/status", Public),
    ("POST", "/setup/complete", Public),
    ("POST", "/auth/login", Public),
    ("POST", "/auth/logout", Public),
    ("GET", "/auth/me", Authenticated),
    ("POST", "/auth/mfa/totp", Public),
    ("POST", "/auth/mfa/recovery", Public),
    ("POST", "/auth/mfa/webauthn/start", Public),
    ("POST", "/auth/mfa/webauthn/finish", Public),
    ("POST", "/auth/mfa/setup/totp/start", Public),
    ("POST", "/auth/mfa/setup/totp/finish", Public),
    ("POST", "/auth/step-up", Authenticated),
    ("GET", "/auth/providers", Public),
    ("GET", "/auth/oidc/{id}/start", Public),
    ("GET", "/auth/oidc/{id}/callback", Public),
    ("GET", "/settings/sso", Global("settings.view")),
    ("PUT", "/settings/sso", Global("settings.manage")),
    ("GET", "/settings/sso/providers", Global("settings.manage")),
    ("POST", "/settings/sso/providers", Global("settings.manage")),
    (
        "GET",
        "/settings/sso/providers/{id}",
        Global("settings.manage"),
    ),
    (
        "PUT",
        "/settings/sso/providers/{id}",
        Global("settings.manage"),
    ),
    (
        "DELETE",
        "/settings/sso/providers/{id}",
        Global("settings.manage"),
    ),
    ("GET", "/api-tokens", Authenticated),
    ("POST", "/api-tokens", Authenticated),
    ("DELETE", "/api-tokens/{id}", Global("api.manage")),
    ("POST", "/auth/step-up/webauthn/start", Authenticated),
    ("POST", "/auth/step-up/webauthn/finish", Authenticated),
    ("GET", "/me/sessions", Authenticated),
    ("DELETE", "/me/sessions/{id}", Authenticated),
    ("POST", "/me/password", Authenticated),
    ("POST", "/me/recovery-codes", Authenticated),
    ("GET", "/me/passkeys", Authenticated),
    ("POST", "/me/passkeys/register/start", Authenticated),
    ("POST", "/me/passkeys/register/finish", Authenticated),
    ("DELETE", "/me/passkeys/{id}", Authenticated),
    ("GET", "/clients", Scoped("clients.view")),
    ("POST", "/clients", Global("clients.manage")),
    ("GET", "/clients/{id}", Scoped("clients.view")),
    ("PATCH", "/clients/{id}", Scoped("clients.manage")),
    ("DELETE", "/clients/{id}", Scoped("clients.manage")),
    ("POST", "/clients/{id}/sites", Scoped("sites.manage")),
    ("PUT", "/clients/{id}/logo", Scoped("clients.manage")),
    ("GET", "/sites", Scoped("clients.view")),
    ("PATCH", "/sites/{id}", Scoped("sites.manage")),
    ("DELETE", "/sites/{id}", Scoped("sites.manage")),
    ("GET", "/users", Global("users.view")),
    ("POST", "/users", Global("users.manage")),
    ("PATCH", "/users/{id}", Global("users.manage")),
    ("DELETE", "/users/{id}", Global("users.manage")),
    ("POST", "/users/{id}/reset-mfa", Global("users.manage")),
    ("GET", "/roles", Scoped("users.view")),
    ("POST", "/roles", Global("roles.manage")),
    ("PATCH", "/roles/{id}", Global("roles.manage")),
    ("DELETE", "/roles/{id}", Global("roles.manage")),
    ("GET", "/permissions", Authenticated),
    ("GET", "/devices", Scoped("devices.view")),
    ("GET", "/devices/{id}", Scoped("devices.view")),
    ("PATCH", "/devices/{id}", Scoped("devices.manage")),
    ("DELETE", "/devices/{id}", Scoped("devices.delete")),
    ("GET", "/devices/{id}/inventory", Scoped("devices.view")),
    (
        "POST",
        "/devices/{id}/inventory/refresh",
        Scoped("devices.view"),
    ),
    ("GET", "/devices/{id}/metrics", Scoped("devices.view")),
    ("GET", "/devices/{id}/timeline", Scoped("devices.view")),
    ("POST", "/devices/{id}/approve", Scoped("agents.approve")),
    ("POST", "/devices/{id}/reject", Scoped("agents.approve")),
    ("POST", "/devices/{id}/revoke", Scoped("devices.delete")),
    ("POST", "/devices/{id}/live", Scoped("devices.view")),
    ("POST", "/devices/{id}/ping", Scoped("devices.manage")),
    ("GET", "/devices/{id}/commands", Scoped("devices.view")),
    ("POST", "/devices/{id}/update", Scoped("agents.update")),
    ("GET", "/devices/{id}/processes", Scoped("remote.system")),
    (
        "POST",
        "/devices/{id}/processes/{pid}/kill",
        Scoped("remote.system"),
    ),
    ("GET", "/devices/{id}/services", Scoped("remote.system")),
    (
        "POST",
        "/devices/{id}/services/{name}/{action}",
        Scoped("remote.system"),
    ),
    ("GET", "/devices/{id}/event-logs", Scoped("remote.system")),
    ("GET", "/devices/{id}/registry", Scoped("remote.system")),
    ("POST", "/devices/{id}/power", Scoped("remote.power")),
    ("POST", "/devices/{id}/message", Scoped("remote.power")),
    ("POST", "/devices/{id}/diagnostics", Scoped("remote.system")),
    ("GET", "/devices/{id}/files", Scoped("remote.files")),
    ("POST", "/devices/{id}/files/op", Scoped("remote.files")),
    (
        "GET",
        "/devices/{id}/files/download",
        Scoped("remote.files"),
    ),
    ("POST", "/devices/{id}/files/upload", Scoped("remote.files")),
    ("POST", "/devices/{id}/shell", Scoped("remote.shell")),
    ("POST", "/devices/{id}/desktop", Scoped("remote.desktop")),
    (
        "GET",
        "/devices/{id}/desktop/sessions",
        Scoped("remote.desktop"),
    ),
    ("GET", "/devices/{id}/screenshot", Scoped("remote.desktop")),
    ("GET", "/remote-sessions", Scoped("devices.view")),
    ("GET", "/remote-sessions/{id}/ws", Ticket),
    (
        "GET",
        "/remote-sessions/{id}/recording",
        Scoped("remote.recordings"),
    ),
    ("POST", "/remote-sessions/{id}/end", Scoped("remote.shell")),
    ("GET", "/agent-releases", Scoped("devices.view")),
    ("POST", "/agent-releases/import", Global("agents.update")),
    (
        "POST",
        "/agent-releases/{id}/rollouts",
        Global("agents.update"),
    ),
    ("GET", "/rollouts", Scoped("devices.view")),
    ("GET", "/agent-updates", Scoped("devices.view")),
    ("POST", "/agent-updates/update", Scoped("agents.update")),
    ("GET", "/devices/{id}/agent-update", Scoped("devices.view")),
    ("POST", "/rollouts/{id}/{action}", Global("agents.update")),
    ("GET", "/scripts", Scoped("scripts.view")),
    ("POST", "/scripts", Global("scripts.manage")),
    ("GET", "/scripts/{id}", Scoped("scripts.view")),
    ("PUT", "/scripts/{id}", Global("scripts.manage")),
    ("DELETE", "/scripts/{id}", Global("scripts.manage")),
    ("POST", "/scripts/{id}/duplicate", Global("scripts.manage")),
    (
        "GET",
        "/scripts/{id}/versions/{version}",
        Scoped("scripts.view"),
    ),
    (
        "POST",
        "/scripts/{id}/versions/{version}/approve",
        Global("scripts.approve"),
    ),
    ("GET", "/script-categories", Scoped("scripts.view")),
    ("GET", "/variables", Scoped("scripts.view")),
    ("POST", "/variables", Scoped("scripts.manage")),
    ("PUT", "/variables/{id}", Scoped("scripts.manage")),
    ("DELETE", "/variables/{id}", Scoped("scripts.manage")),
    ("GET", "/jobs", Scoped("scripts.view")),
    ("POST", "/jobs", Scoped("scripts.run")),
    ("GET", "/jobs/{id}", Scoped("scripts.view")),
    ("DELETE", "/jobs/{id}", Scoped("scripts.run")),
    ("POST", "/jobs/{id}/run-now", Scoped("scripts.run")),
    ("POST", "/jobs/{id}/cancel", Scoped("scripts.run")),
    ("GET", "/job-runs/{id}", Scoped("scripts.view")),
    (
        "GET",
        "/job-runs/{id}/results/{device_id}",
        Scoped("scripts.view"),
    ),
    ("POST", "/job-runs/{id}/rerun", Scoped("scripts.run")),
    ("POST", "/job-runs/{id}/cancel", Scoped("scripts.run")),
    ("GET", "/devices/{id}/script-runs", Scoped("scripts.view")),
    ("POST", "/devices/{id}/run-script", Scoped("scripts.run")),
    ("GET", "/approvals", Authenticated),
    ("POST", "/approvals/{id}/approve", Scoped("scripts.approve")),
    ("POST", "/approvals/{id}/reject", Scoped("scripts.approve")),
    ("GET", "/settings/automation", Scoped("settings.view")),
    ("PUT", "/settings/automation", Global("settings.manage")),
    ("GET", "/custom-fields", Authenticated),
    ("POST", "/custom-fields", Global("settings.manage")),
    ("PUT", "/custom-fields/{id}", Global("settings.manage")),
    ("DELETE", "/custom-fields/{id}", Global("settings.manage")),
    ("GET", "/devices/{id}/custom-fields", Scoped("devices.view")),
    (
        "PUT",
        "/devices/{id}/custom-fields",
        Scoped("devices.manage"),
    ),
    ("GET", "/clients/{id}/custom-fields", Scoped("clients.view")),
    (
        "PUT",
        "/clients/{id}/custom-fields",
        Scoped("clients.manage"),
    ),
    ("GET", "/sites/{id}/custom-fields", Scoped("clients.view")),
    ("PUT", "/sites/{id}/custom-fields", Scoped("sites.manage")),
    ("GET", "/groups", Scoped("devices.view")),
    ("POST", "/groups", Global("devices.manage")),
    ("POST", "/groups/preview", Scoped("devices.view")),
    ("PUT", "/groups/{id}", Global("devices.manage")),
    ("DELETE", "/groups/{id}", Global("devices.manage")),
    ("GET", "/groups/{id}/members", Scoped("devices.view")),
    ("POST", "/groups/{id}/members", Global("devices.manage")),
    ("DELETE", "/groups/{id}/members", Global("devices.manage")),
    ("GET", "/devices/{id}/groups", Scoped("devices.view")),
    ("GET", "/policies", Scoped("devices.view")),
    ("POST", "/policies", Scoped("policies.manage")),
    ("GET", "/policies/{id}", Scoped("devices.view")),
    ("PUT", "/policies/{id}", Scoped("policies.manage")),
    ("DELETE", "/policies/{id}", Scoped("policies.manage")),
    (
        "POST",
        "/policies/{id}/assignments",
        Scoped("policies.manage"),
    ),
    (
        "DELETE",
        "/policy-assignments/{id}",
        Scoped("policies.manage"),
    ),
    (
        "GET",
        "/devices/{id}/effective-policy",
        Scoped("devices.view"),
    ),
    ("GET", "/alerts", Scoped("alerts.view")),
    ("GET", "/alerts/summary", Scoped("alerts.view")),
    ("POST", "/alerts/bulk", Scoped("alerts.manage")),
    ("GET", "/alerts/{id}", Scoped("alerts.view")),
    ("POST", "/alerts/{id}/acknowledge", Scoped("alerts.manage")),
    (
        "POST",
        "/alerts/{id}/unacknowledge",
        Scoped("alerts.manage"),
    ),
    ("POST", "/alerts/{id}/resolve", Scoped("alerts.manage")),
    ("POST", "/alerts/{id}/snooze", Scoped("alerts.manage")),
    ("POST", "/alerts/{id}/assign", Scoped("alerts.manage")),
    ("POST", "/alerts/{id}/notes", Scoped("alerts.manage")),
    ("GET", "/devices/{id}/checks", Scoped("alerts.view")),
    ("GET", "/devices/{id}/alerts", Scoped("alerts.view")),
    ("GET", "/devices/{id}/maintenance", Scoped("alerts.view")),
    ("GET", "/monitoring/check-types", Scoped("alerts.view")),
    (
        "GET",
        "/notification-channels",
        Global("notifications.manage"),
    ),
    (
        "POST",
        "/notification-channels",
        Global("notifications.manage"),
    ),
    (
        "PUT",
        "/notification-channels/{id}",
        Global("notifications.manage"),
    ),
    (
        "DELETE",
        "/notification-channels/{id}",
        Global("notifications.manage"),
    ),
    (
        "POST",
        "/notification-channels/{id}/test",
        Global("notifications.manage"),
    ),
    ("GET", "/notification-rules", Global("notifications.manage")),
    (
        "POST",
        "/notification-rules",
        Global("notifications.manage"),
    ),
    (
        "GET",
        "/notification-rules/{id}",
        Global("notifications.manage"),
    ),
    (
        "PUT",
        "/notification-rules/{id}",
        Global("notifications.manage"),
    ),
    (
        "DELETE",
        "/notification-rules/{id}",
        Global("notifications.manage"),
    ),
    ("GET", "/notification-log", Global("notifications.manage")),
    ("GET", "/maintenance-windows", Scoped("alerts.view")),
    ("POST", "/maintenance-windows", Scoped("monitors.manage")),
    (
        "PUT",
        "/maintenance-windows/{id}",
        Scoped("monitors.manage"),
    ),
    (
        "DELETE",
        "/maintenance-windows/{id}",
        Scoped("monitors.manage"),
    ),
    ("GET", "/settings/monitoring", Scoped("settings.view")),
    ("PUT", "/settings/monitoring", Global("monitors.manage")),
    ("GET", "/settings/smtp", Global("notifications.manage")),
    ("PUT", "/settings/smtp", Global("notifications.manage")),
    (
        "POST",
        "/settings/smtp/test",
        Global("notifications.manage"),
    ),
    ("GET", "/patches", Scoped("patches.view")),
    ("POST", "/patches/approve", Global("patches.approve")),
    ("GET", "/patches/{id}", Scoped("patches.view")),
    ("GET", "/patch-approval-rules", Scoped("patches.view")),
    ("GET", "/devices/{id}/patches", Scoped("patches.view")),
    ("POST", "/devices/{id}/patches/scan", Scoped("patches.view")),
    (
        "POST",
        "/devices/{id}/patches/install",
        Scoped("patches.approve"),
    ),
    ("GET", "/patch-runs", Scoped("patches.view")),
    ("GET", "/patch-runs/{id}", Scoped("patches.view")),
    ("GET", "/patching/compliance", Scoped("patches.view")),
    (
        "POST",
        "/patching/policies/{id}/run-now",
        Scoped("patches.approve"),
    ),
    ("GET", "/software", Scoped("software.view")),
    ("GET", "/software/product", Scoped("software.view")),
    ("POST", "/software/files", Scoped("software.library")),
    ("GET", "/software/packages", Scoped("software.view")),
    ("POST", "/software/packages", Global("software.library")),
    ("GET", "/software/packages/{id}", Scoped("software.view")),
    ("PUT", "/software/packages/{id}", Global("software.library")),
    (
        "DELETE",
        "/software/packages/{id}",
        Global("software.library"),
    ),
    ("GET", "/software/deployments", Scoped("software.view")),
    ("POST", "/software/deployments", Scoped("software.deploy")),
    ("GET", "/software/deployments/{id}", Scoped("software.view")),
    (
        "POST",
        "/software/deployments/{id}/cancel",
        Scoped("software.deploy"),
    ),
    (
        "GET",
        "/devices/{id}/software-deployments",
        Scoped("software.view"),
    ),
    ("GET", "/tickets", Scoped("tickets.view")),
    ("POST", "/tickets", Scoped("tickets.manage")),
    ("GET", "/tickets/stats", Scoped("tickets.view")),
    ("POST", "/tickets/bulk", Scoped("tickets.manage")),
    ("GET", "/tickets/attachments/{id}", Scoped("tickets.view")),
    ("GET", "/tickets/{id}", Scoped("tickets.view")),
    ("PATCH", "/tickets/{id}", Scoped("tickets.manage")),
    ("DELETE", "/tickets/{id}", Scoped("tickets.settings")),
    ("POST", "/tickets/{id}/comments", Scoped("tickets.manage")),
    ("PATCH", "/tickets/{id}/comments/{cid}", Author),
    ("POST", "/tickets/{id}/merge", Scoped("tickets.manage")),
    ("POST", "/tickets/{id}/links", Scoped("tickets.manage")),
    ("DELETE", "/tickets/{id}/links", Scoped("tickets.manage")),
    ("POST", "/tickets/{id}/time", Scoped("tickets.time")),
    ("GET", "/devices/{id}/tickets", Scoped("tickets.view")),
    ("GET", "/ticket-queues", Scoped("tickets.view")),
    ("POST", "/ticket-queues", Global("tickets.settings")),
    ("GET", "/ticket-queues/{id}", Scoped("tickets.view")),
    ("PUT", "/ticket-queues/{id}", Global("tickets.settings")),
    ("DELETE", "/ticket-queues/{id}", Global("tickets.settings")),
    ("GET", "/sla-policies", Scoped("tickets.view")),
    ("POST", "/sla-policies", Global("tickets.settings")),
    ("GET", "/sla-policies/{id}", Scoped("tickets.view")),
    ("PUT", "/sla-policies/{id}", Global("tickets.settings")),
    ("DELETE", "/sla-policies/{id}", Global("tickets.settings")),
    ("GET", "/canned-responses", Scoped("tickets.manage")),
    ("POST", "/canned-responses", Scoped("tickets.manage")),
    ("GET", "/canned-responses/{id}", Scoped("tickets.manage")),
    ("PUT", "/canned-responses/{id}", Global("tickets.settings")),
    (
        "DELETE",
        "/canned-responses/{id}",
        Global("tickets.settings"),
    ),
    (
        "POST",
        "/canned-responses/{id}/render",
        Scoped("tickets.manage"),
    ),
    ("GET", "/contacts", Scoped("tickets.view")),
    ("POST", "/contacts", Scoped("tickets.manage")),
    ("POST", "/contacts/import", Scoped("tickets.settings")),
    ("GET", "/contacts/{id}", Scoped("tickets.view")),
    ("PUT", "/contacts/{id}", Scoped("tickets.manage")),
    ("DELETE", "/contacts/{id}", Scoped("tickets.manage")),
    ("GET", "/time-entries", Scoped("tickets.time")),
    ("PUT", "/time-entries/{id}", Scoped("tickets.settings")),
    ("DELETE", "/time-entries/{id}", Scoped("tickets.settings")),
    ("GET", "/settings/ticket-email", Global("tickets.settings")),
    ("PUT", "/settings/ticket-email", Global("tickets.settings")),
    (
        "POST",
        "/settings/ticket-email/test-imap",
        Global("tickets.settings"),
    ),
    ("GET", "/alert-ticket-rules", Global("tickets.settings")),
    ("POST", "/alert-ticket-rules", Global("tickets.settings")),
    (
        "GET",
        "/alert-ticket-rules/{id}",
        Global("tickets.settings"),
    ),
    (
        "PUT",
        "/alert-ticket-rules/{id}",
        Global("tickets.settings"),
    ),
    (
        "DELETE",
        "/alert-ticket-rules/{id}",
        Global("tickets.settings"),
    ),
    ("POST", "/alerts/{id}/ticket", Scoped("tickets.manage")),
    ("GET", "/escrow", Scoped("secrets.manage")),
    ("GET", "/escrow/stats", Scoped("secrets.manage")),
    ("DELETE", "/escrow/{id}", Scoped("secrets.manage")),
    ("POST", "/escrow/{id}/reveal", Scoped("secrets.reveal")),
    ("GET", "/devices/{id}/escrow", Scoped("secrets.manage")),
    (
        "POST",
        "/devices/{id}/escrow/refresh",
        Scoped("secrets.manage"),
    ),
    (
        "POST",
        "/devices/{id}/laps/rotate",
        Scoped("secrets.manage"),
    ),
    ("GET", "/sites/{id}/probe", Scoped("network.view")),
    ("PUT", "/sites/{id}/probe", Scoped("network.manage")),
    ("GET", "/network/probes", Scoped("network.view")),
    ("GET", "/network/scans", Scoped("network.view")),
    ("POST", "/network/scans", Scoped("network.manage")),
    ("PUT", "/network/scans/{id}", Scoped("network.manage")),
    ("DELETE", "/network/scans/{id}", Scoped("network.manage")),
    ("POST", "/network/scans/{id}/run", Scoped("network.manage")),
    ("GET", "/network/assets", Scoped("network.view")),
    ("PATCH", "/network/assets/{id}", Scoped("network.manage")),
    (
        "POST",
        "/network/assets/{id}/monitor",
        Scoped("network.manage"),
    ),
    ("GET", "/network/snmp/credentials", Scoped("network.view")),
    (
        "POST",
        "/network/snmp/credentials",
        Global("network.manage"),
    ),
    (
        "PUT",
        "/network/snmp/credentials/{id}",
        Global("network.manage"),
    ),
    (
        "DELETE",
        "/network/snmp/credentials/{id}",
        Global("network.manage"),
    ),
    ("GET", "/network/snmp/templates", Scoped("network.view")),
    ("POST", "/network/snmp/templates", Global("network.manage")),
    (
        "PUT",
        "/network/snmp/templates/{id}",
        Global("network.manage"),
    ),
    (
        "DELETE",
        "/network/snmp/templates/{id}",
        Global("network.manage"),
    ),
    ("GET", "/network/snmp/devices", Scoped("network.view")),
    ("POST", "/network/snmp/devices", Scoped("network.manage")),
    (
        "PUT",
        "/network/snmp/devices/{id}",
        Scoped("network.manage"),
    ),
    (
        "DELETE",
        "/network/snmp/devices/{id}",
        Scoped("network.manage"),
    ),
    (
        "POST",
        "/network/snmp/devices/{id}/test",
        Scoped("network.manage"),
    ),
    (
        "GET",
        "/network/snmp/devices/{id}/metrics",
        Scoped("network.view"),
    ),
    ("GET", "/network/snmp/traps", Scoped("network.view")),
    ("GET", "/network/snmp/trap-rules", Scoped("network.view")),
    ("POST", "/network/snmp/trap-rules", Global("network.manage")),
    (
        "PUT",
        "/network/snmp/trap-rules/{id}",
        Global("network.manage"),
    ),
    (
        "DELETE",
        "/network/snmp/trap-rules/{id}",
        Global("network.manage"),
    ),
    ("GET", "/network/topology", Scoped("network.view")),
    ("GET", "/settings/network", Scoped("network.view")),
    ("PUT", "/settings/network", Global("network.manage")),
    ("GET", "/enrollment-tokens", Scoped("agents.deploy")),
    (
        "POST",
        "/sites/{id}/enrollment-tokens",
        Scoped("agents.deploy"),
    ),
    ("DELETE", "/enrollment-tokens/{id}", Scoped("agents.deploy")),
    (
        "GET",
        "/enrollment-tokens/{id}/deploy-key",
        Scoped("agents.deploy"),
    ),
    (
        "GET",
        "/enrollment-tokens/{id}/installer/{kind}",
        Scoped("agents.deploy"),
    ),
    ("GET", "/reports/types", Scoped("reports.view")),
    ("POST", "/reports/run", Scoped("reports.view")),
    ("GET", "/report-runs", Scoped("reports.view")),
    ("GET", "/report-runs/{id}", Scoped("reports.view")),
    ("GET", "/report-runs/{id}/download", Scoped("reports.view")),
    ("GET", "/report-schedules", Scoped("reports.manage")),
    ("POST", "/report-schedules", Scoped("reports.manage")),
    ("GET", "/report-schedules/{id}", Scoped("reports.manage")),
    ("PUT", "/report-schedules/{id}", Scoped("reports.manage")),
    ("DELETE", "/report-schedules/{id}", Scoped("reports.manage")),
    (
        "POST",
        "/report-schedules/{id}/run-now",
        Scoped("reports.manage"),
    ),
    ("GET", "/dashboards", Authenticated),
    ("POST", "/dashboards", Authenticated),
    ("GET", "/dashboards/default", Authenticated),
    (
        "GET",
        "/dashboards/widgets/{widget}",
        Scoped("devices.view"),
    ),
    ("GET", "/dashboards/{id}", Scoped("reports.view")),
    ("PUT", "/dashboards/{id}", Scoped("reports.manage")),
    ("DELETE", "/dashboards/{id}", Scoped("reports.manage")),
    ("GET", "/webhooks", Scoped("api.manage")),
    ("POST", "/webhooks", Scoped("api.manage")),
    ("GET", "/webhooks/{id}", Global("api.manage")),
    ("PUT", "/webhooks/{id}", Global("api.manage")),
    ("DELETE", "/webhooks/{id}", Global("api.manage")),
    ("GET", "/webhooks/{id}/deliveries", Global("api.manage")),
    ("POST", "/webhooks/{id}/test", Global("api.manage")),
    (
        "POST",
        "/webhook-deliveries/{id}/redeliver",
        Scoped("api.manage"),
    ),
    ("GET", "/branding", Public),
    ("GET", "/branding/files/{id}", Public),
    ("GET", "/settings/branding", Global("settings.view")),
    ("PUT", "/settings/branding", Global("settings.manage")),
    ("GET", "/settings/signing-status", Global("settings.manage")),
    ("POST", "/files/branding", Scoped("settings.manage")),
    ("GET", "/audit", Scoped("audit.view")),
    ("POST", "/audit/verify", Global("audit.view")),
    ("GET", "/audit/export", Scoped("audit.export")),
    ("GET", "/settings/backups", Global("backups.view")),
    ("PUT", "/settings/backups", Global("backups.manage")),
    ("GET", "/backups", Global("backups.view")),
    ("POST", "/backups", Global("backups.manage")),
    ("POST", "/backups/test-s3", Global("backups.manage")),
    ("DELETE", "/backups/{id}", Global("backups.manage")),
    ("GET", "/backups/{id}/download", Global("backups.manage")),
    ("GET", "/system/health", Global("settings.view")),
    ("GET", "/system/ca.crt", Public),
    ("GET", "/fleet/summary", Authenticated),
    ("POST", "/stream/ticket", Authenticated),
    ("GET", "/stream", Ticket),
];

/// Routes that need a recent MFA confirmation (`403 step_up_required` without one; API tokens can
/// never step up).
///
/// Conditional step-ups are not listed: ad-hoc scripts on `POST /devices/{id}/run-script` (library
/// scripts need none), and jobs or software deployments above the mass-action threshold.
const STEP_UP: &[(&str, &str)] = &[
    ("PUT", "/settings/sso"),
    ("GET", "/settings/sso/providers"),
    ("POST", "/settings/sso/providers"),
    ("GET", "/settings/sso/providers/{id}"),
    ("PUT", "/settings/sso/providers/{id}"),
    ("DELETE", "/settings/sso/providers/{id}"),
    ("POST", "/api-tokens"),
    ("POST", "/me/recovery-codes"),
    ("DELETE", "/clients/{id}"),
    ("DELETE", "/sites/{id}"),
    ("DELETE", "/users/{id}"),
    ("POST", "/users/{id}/reset-mfa"),
    ("DELETE", "/devices/{id}"),
    ("POST", "/devices/{id}/revoke"),
    ("POST", "/devices/{id}/update"),
    ("POST", "/agent-updates/update"),
    ("POST", "/devices/{id}/power"),
    ("POST", "/devices/{id}/shell"),
    ("POST", "/devices/{id}/desktop"),
    ("POST", "/agent-releases/{id}/rollouts"),
    ("DELETE", "/scripts/{id}"),
    ("POST", "/scripts/{id}/versions/{version}/approve"),
    ("POST", "/job-runs/{id}/rerun"),
    ("POST", "/approvals/{id}/approve"),
    ("PUT", "/settings/automation"),
    ("DELETE", "/custom-fields/{id}"),
    ("DELETE", "/policies/{id}"),
    ("PUT", "/settings/smtp"),
    ("POST", "/devices/{id}/patches/install"),
    ("POST", "/patching/policies/{id}/run-now"),
    ("PUT", "/settings/ticket-email"),
    ("DELETE", "/escrow/{id}"),
    ("POST", "/escrow/{id}/reveal"),
    ("POST", "/devices/{id}/laps/rotate"),
    ("PUT", "/settings/network"),
    ("PUT", "/settings/backups"),
    ("DELETE", "/backups/{id}"),
    ("GET", "/backups/{id}/download"),
];

/// Routes an API token can never call (`403 token_not_allowed`): interactive sessions, step-up,
/// account management and minting tokens.
const SESSION_ONLY: &[(&str, &str)] = &[
    ("POST", "/auth/step-up"),
    ("POST", "/auth/step-up/webauthn/start"),
    ("POST", "/auth/step-up/webauthn/finish"),
    ("POST", "/api-tokens"),
    ("GET", "/me/sessions"),
    ("DELETE", "/me/sessions/{id}"),
    ("POST", "/me/password"),
    ("POST", "/me/recovery-codes"),
    ("GET", "/me/passkeys"),
    ("POST", "/me/passkeys/register/start"),
    ("POST", "/me/passkeys/register/finish"),
    ("DELETE", "/me/passkeys/{id}"),
    ("POST", "/devices/{id}/shell"),
    ("POST", "/devices/{id}/desktop"),
    ("POST", "/stream/ticket"),
    ("GET", "/stream"),
    ("GET", "/remote-sessions/{id}/ws"),
];

/// Every permission in the catalog (Owner and Administrator hold all of them).
const ALL: &[&str] = &[
    "clients.view",
    "clients.manage",
    "sites.manage",
    "devices.view",
    "devices.manage",
    "devices.delete",
    "agents.deploy",
    "agents.approve",
    "agents.update",
    "remote.shell",
    "remote.desktop",
    "remote.files",
    "remote.system",
    "remote.power",
    "remote.recordings",
    "scripts.view",
    "scripts.manage",
    "scripts.run",
    "scripts.approve",
    "policies.manage",
    "alerts.view",
    "alerts.manage",
    "monitors.manage",
    "notifications.manage",
    "patches.view",
    "patches.approve",
    "software.view",
    "software.deploy",
    "software.library",
    "tickets.view",
    "tickets.manage",
    "tickets.time",
    "tickets.settings",
    "secrets.reveal",
    "secrets.manage",
    "network.view",
    "network.manage",
    "reports.view",
    "reports.manage",
    "users.view",
    "users.manage",
    "roles.manage",
    "audit.view",
    "audit.export",
    "backups.view",
    "backups.manage",
    "settings.view",
    "settings.manage",
    "api.manage",
];

const TECHNICIAN: &[&str] = &[
    "clients.view",
    "devices.view",
    "devices.manage",
    "agents.deploy",
    "agents.approve",
    "remote.shell",
    "remote.desktop",
    "remote.files",
    "remote.system",
    "remote.power",
    "scripts.view",
    "scripts.run",
    "alerts.view",
    "alerts.manage",
    "patches.view",
    "software.view",
    "software.deploy",
    "tickets.view",
    "tickets.manage",
    "tickets.time",
    "network.view",
    "reports.view",
];

const HELP_DESK: &[&str] = &[
    "clients.view",
    "devices.view",
    "remote.desktop",
    "remote.power",
    "scripts.view",
    "alerts.view",
    "patches.view",
    "software.view",
    "tickets.view",
    "tickets.manage",
    "tickets.time",
    "reports.view",
];

const AUDITOR: &[&str] = &[
    "clients.view",
    "devices.view",
    "scripts.view",
    "alerts.view",
    "patches.view",
    "software.view",
    "tickets.view",
    "network.view",
    "reports.view",
    "users.view",
    "audit.view",
    "backups.view",
    "settings.view",
    "audit.export",
    "remote.recordings",
];

/// A principal of the matrix.
struct Role {
    name: &'static str,
    builtin: Option<&'static str>,
    perms: &'static [&'static str],
    /// Assigned to client A only.
    scoped: bool,
}

const ROLES: &[Role] = &[
    Role {
        name: "nobody",
        builtin: None,
        perms: &[],
        scoped: false,
    },
    Role {
        name: "auditor",
        builtin: Some("builtin-auditor"),
        perms: AUDITOR,
        scoped: false,
    },
    Role {
        name: "helpdesk",
        builtin: Some("builtin-helpdesk"),
        perms: HELP_DESK,
        scoped: false,
    },
    Role {
        name: "tech_scoped",
        builtin: Some("builtin-technician"),
        perms: TECHNICIAN,
        scoped: true,
    },
    Role {
        name: "technician",
        builtin: Some("builtin-technician"),
        perms: TECHNICIAN,
        scoped: false,
    },
    Role {
        name: "admin",
        builtin: Some("builtin-admin"),
        perms: ALL,
        scoped: false,
    },
    Role {
        name: "owner",
        builtin: Some("builtin-owner"),
        perms: ALL,
        scoped: false,
    },
];

impl Rule {
    fn allows(&self, role: &Role) -> bool {
        let has = |p: &str| role.perms.contains(&p);
        match *self {
            Public | Authenticated | Ticket => true,
            Author => role.name == "owner",
            Global(p) => has(p) && !role.scoped,
            Scoped(p) => has(p),
        }
    }
}

// ------------------------------------------------------------------ HTTP

#[derive(Clone)]
enum Auth {
    Anonymous,
    Session { token: String, csrf: String },
    Bearer(String),
}

#[derive(Debug, Clone)]
struct Response {
    status: StatusCode,
    json: Option<Value>,
    code: Option<String>,
    /// Plain-text extractor rejection (body or query did not deserialise).
    rejection: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Seen {
    Unauthenticated,
    Denied,
    StepUp,
    TokenBlocked,
    /// A body/query the server could not parse (permission not reached).
    Rejected,
    Passed(u16),
}

impl Response {
    fn seen(&self) -> Seen {
        match (self.status.as_u16(), self.code.as_deref()) {
            (401, None | Some("unauthenticated")) => Seen::Unauthenticated,
            (403, Some("forbidden")) => Seen::Denied,
            (403, Some("step_up_required")) => Seen::StepUp,
            (403, Some("token_not_allowed")) => Seen::TokenBlocked,
            _ if self.rejection.is_some() => Seen::Rejected,
            (s, _) => Seen::Passed(s),
        }
    }
}

#[derive(Clone)]
enum Payload {
    None,
    Json(Value),
    Raw(&'static str, Vec<u8>),
}

async fn call(
    router: &Router,
    method: &str,
    uri: &str,
    auth: &Auth,
    payload: &Payload,
) -> Response {
    let method = Method::from_bytes(method.as_bytes()).expect("method");
    let mut req = Request::builder().method(method).uri(uri);
    match auth {
        Auth::Anonymous => req = req.header(header::ORIGIN, ORIGIN),
        Auth::Session { token, csrf } => {
            req = req
                .header(header::ORIGIN, ORIGIN)
                .header(header::COOKIE, format!("__Host-rustrmm_session={token}"))
                .header("x-csrf-token", csrf);
        }
        Auth::Bearer(token) => req = req.header(header::AUTHORIZATION, format!("Bearer {token}")),
    }
    let body = match payload {
        Payload::None => Body::empty(),
        Payload::Json(v) => {
            req = req.header(header::CONTENT_TYPE, "application/json");
            Body::from(v.to_string())
        }
        Payload::Raw(ct, bytes) => {
            req = req.header(header::CONTENT_TYPE, *ct);
            Body::from(bytes.clone())
        }
    };
    let response = router
        .clone()
        .oneshot(req.body(body).expect("request"))
        .await
        .expect("response");
    let status = response.status();
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = response
        .into_body()
        .collect()
        .await
        .map(|b| b.to_bytes().to_vec())
        .unwrap_or_default();
    let json: Option<Value> = serde_json::from_slice(&bytes).ok();
    let code = json
        .as_ref()
        .and_then(|v| v.pointer("/error/code"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let rejection = (code.is_none()
        && matches!(status.as_u16(), 400 | 415 | 422)
        && !content_type.starts_with("application/json"))
    .then(|| String::from_utf8_lossy(&bytes).to_string());
    Response {
        status,
        json,
        code,
        rejection,
    }
}

// ------------------------------------------------------------------ body synthesis

/// Applies one serde error (`path: message`) to the body; false when it cannot be fixed.
fn fix_body(body: &mut Value, rejection: &str) -> bool {
    let text = rejection
        .split_once("target type: ")
        .map(|(_, t)| t)
        .or_else(|| rejection.split_once("query string: ").map(|(_, t)| t))
        .unwrap_or(rejection);
    let text = text.split(" at line ").next().unwrap_or(text).trim();
    // `a.b[0]: message` (the path is absent for top-level errors)
    let (path, message) = match text.split_once(": ") {
        Some((p, m))
            if !p.contains(' ') && !p.starts_with("invalid") && !p.starts_with("missing") =>
        {
            (p.to_string(), m.to_string())
        }
        _ => (String::new(), text.to_string()),
    };
    let mut segments: Vec<String> = Vec::new();
    for part in path.split('.').filter(|p| !p.is_empty()) {
        let mut rest = part;
        while let Some(i) = rest.find('[') {
            if i > 0 {
                segments.push(rest[..i].to_string());
            }
            let end = rest.find(']').unwrap_or(rest.len());
            segments.push(rest[i..=end.min(rest.len() - 1)].to_string());
            rest = &rest[(end + 1).min(rest.len())..];
        }
        if !rest.is_empty() {
            segments.push(rest.to_string());
        }
    }
    let value_for = |expected: &str| -> Option<Value> {
        let e = expected.trim();
        Some(if e.contains('`') {
            let first = e.split('`').nth(1)?;
            Value::String(first.to_string())
        } else if e.contains("bool") {
            Value::Bool(true)
        } else if e.contains("sequence") || e.contains("array") || e.contains("tuple") {
            json!([])
        } else if e.contains("map")
            || e.starts_with("struct")
            || e.contains("object")
            || e.contains("tagged enum")
        {
            json!({})
        } else if e.contains("f32") || e.contains("f64") || e.contains("float") {
            json!(1.0)
        } else if e.contains("u8")
            || e.contains("u16")
            || e.contains("u32")
            || e.contains("u64")
            || e.contains("i8")
            || e.contains("i16")
            || e.contains("i32")
            || e.contains("i64")
            || e.contains("usize")
            || e.contains("integer")
            || e.contains("number")
        {
            json!(1)
        } else if e.contains("RFC 3339") || e.contains("datetime") || e.contains("date") {
            json!("2030-01-01T00:00:00Z")
        } else if e.contains("unit") || e.contains("null") {
            Value::Null
        } else {
            json!("x")
        })
    };
    let (target_segments, new_value) = if let Some(field) = message
        .strip_prefix("missing field `")
        .and_then(|m| m.split('`').next())
    {
        let mut s = segments.clone();
        s.push(field.to_string());
        (s, json!("x"))
    } else if let Some(expected) = message.split(", expected ").nth(1) {
        match value_for(expected) {
            Some(v) => (segments.clone(), v),
            None => return false,
        }
    } else if [
        "input contains invalid characters",
        "premature end of input",
        "input is out of range",
        "trailing input",
        "input is not enough",
        "invalid digit",
    ]
    .iter()
    .any(|m| message.contains(m))
    {
        (segments.clone(), json!("2030-01-01T00:00:00Z"))
    } else if message.contains("Invalid input length")
        || message.contains("Invalid symbol")
        || message.contains("Invalid last symbol")
    {
        (segments.clone(), json!("AAAAAAAA"))
    } else if message.starts_with("unknown variant") {
        match value_for(message.split("expected").nth(1).unwrap_or("")) {
            Some(v) => (segments.clone(), v),
            None => return false,
        }
    } else {
        return false;
    };
    set_path(body, &target_segments, new_value)
}

fn set_path(body: &mut Value, segments: &[String], value: Value) -> bool {
    let Some((last, parents)) = segments.split_last() else {
        if *body == value {
            return false;
        }
        *body = value;
        return true;
    };
    let mut cur = body;
    for seg in parents {
        cur = if let Some(idx) = seg.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            let idx: usize = idx.parse().unwrap_or(0);
            if !cur.is_array() {
                *cur = json!([]);
            }
            let arr = cur.as_array_mut().expect("array");
            while arr.len() <= idx {
                arr.push(json!({}));
            }
            &mut arr[idx]
        } else {
            if !cur.is_object() {
                *cur = json!({});
            }
            cur.as_object_mut()
                .expect("object")
                .entry(seg.clone())
                .or_insert(json!({}))
        };
    }
    if let Some(idx) = last.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
        let idx: usize = idx.parse().unwrap_or(0);
        if !cur.is_array() {
            *cur = json!([]);
        }
        let arr = cur.as_array_mut().expect("array");
        while arr.len() <= idx {
            arr.push(Value::Null);
        }
        if arr[idx] == value {
            return false;
        }
        arr[idx] = value;
        return true;
    }
    if !cur.is_object() {
        *cur = json!({});
    }
    let obj = cur.as_object_mut().expect("object");
    if obj.get(last) == Some(&value) {
        return false;
    }
    obj.insert(last.clone(), value);
    true
}

// ------------------------------------------------------------------ fixtures

struct Fixture {
    state: AppState,
    router: Router,
    addr: SocketAddr,
    users: HashMap<&'static str, String>,
    ids: HashMap<&'static str, String>,
    _dir: tempfile::TempDir,
}

/// Table holding the resource a path parameter names (looked up when the route runs).
fn table_for(path: &str, resource: &str, param: &str) -> Option<&'static str> {
    if path.starts_with("/network/snmp/devices") && param == "id" {
        return Some("snmp_devices");
    }
    if path.starts_with("/branding/files") {
        return Some("branding_files");
    }
    if path.starts_with("/settings/sso/providers") || path.starts_with("/auth/oidc") {
        return Some("oidc_providers");
    }
    Some(match (resource, param) {
        ("scripts", "id") => "scripts",
        ("variables", _) => "variables",
        ("jobs", _) => "jobs",
        ("job-runs", _) => "job_runs",
        ("approvals", _) => "approvals",
        ("custom-fields", _) => "custom_fields",
        ("groups", _) => "device_groups",
        ("policies", _) => "policies",
        ("policy-assignments", _) => "policy_assignments",
        ("notification-channels", _) => "notification_channels",
        ("notification-rules", _) => "notification_rules",
        ("maintenance-windows", _) => "maintenance_windows",
        ("patches", _) => "patch_catalog",
        ("patch-runs", _) => "patch_runs",
        ("packages", _) => "software_packages",
        ("deployments", _) => "software_deployments",
        ("attachments", _) => "ticket_attachments",
        ("comments", "cid") => "ticket_comments",
        ("ticket-queues", _) => "ticket_queues",
        ("sla-policies", _) => "sla_policies",
        ("canned-responses", _) => "canned_responses",
        ("contacts", _) => "contacts",
        ("time-entries", _) => "time_entries",
        ("alert-ticket-rules", _) => "alert_ticket_rules",
        ("escrow", _) => "escrow_items",
        ("scans", _) => "network_scans",
        ("assets", _) => "network_assets",
        ("credentials", _) => "snmp_credentials",
        ("templates", _) => "snmp_templates",
        ("trap-rules", _) => "trap_rules",
        ("enrollment-tokens", _) => "enrollment_tokens",
        ("report-runs", _) => "report_runs",
        ("report-schedules", _) => "report_schedules",
        ("dashboards", "id") => "dashboards",
        ("webhooks", _) => "webhooks",
        ("webhook-deliveries", _) => "webhook_deliveries",
        ("backups", _) => "backups",
        ("api-tokens", _) => "api_tokens WHERE name = 'victim'",
        ("agent-releases", _) => "agent_releases",
        ("rollouts", "id") => "rollouts",
        ("remote-sessions", _) => "remote_sessions",
        _ => return None,
    })
}

impl Fixture {
    async fn session(&self, user: &str, stepped_up: bool) -> Auth {
        let user_id = &self.users[user];
        let (token, record) =
            rustrmm_server::auth::session::create(&self.state, user_id, None, None, stepped_up)
                .await
                .expect("session");
        Auth::Session {
            token,
            csrf: record.csrf_token,
        }
    }

    async fn any_id(&self, table: &str) -> Option<String> {
        sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "SELECT id FROM {table} ORDER BY rowid DESC LIMIT 1"
        )))
        .fetch_optional(&self.state.db)
        .await
        .ok()
        .flatten()
    }

    /// Fresh resources for a destructive route (each role sees it until one deletes it).
    async fn victims(&self) -> HashMap<&'static str, String> {
        let now = rustrmm_common::now().to_rfc3339();
        let mut v = HashMap::new();
        let (client, site) = (rustrmm_common::new_id(), rustrmm_common::new_id());
        insert(&self.state, "INSERT INTO clients (id, name, slug, notes, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?)",
            &[&client, &format!("Victim {client}"), &format!("victim-{client}"), &now, &now]).await;
        insert(&self.state, "INSERT INTO sites (id, client_id, name, created_at, updated_at) VALUES (?, ?, 'Victim', ?, ?)",
            &[&site, &client, &now, &now]).await;
        // A site of client A (so client-scoped roles can reach it), and a device and ticket there.
        let site_a = rustrmm_common::new_id();
        insert(&self.state, "INSERT INTO sites (id, client_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            &[&site_a, &self.ids["client_a"], &format!("Victim {site_a}"), &now, &now]).await;
        let device = enroll(
            &self.state,
            self.addr,
            &self.ids["site_a"],
            &format!("V-{}", &site_a[..8]),
        )
        .await;
        let ticket = rustrmm_common::new_id();
        let number = (rand_number() % 900_000 + 10_000).to_string();
        insert(&self.state, "INSERT INTO tickets (id, number, subject, status, priority, type, client_id, queue_id, source, created_at, updated_at, last_activity_at) VALUES (?, ?, 'Victim', 'open', 'normal', 'incident', ?, (SELECT id FROM ticket_queues LIMIT 1), 'console', ?, ?, ?)",
            &[&ticket, &number, &self.ids["client_a"], &now, &now, &now]).await;
        let user = rustrmm_common::new_id();
        insert(&self.state, "INSERT INTO users (id, email, name, password_hash, status, password_changed_at, created_at, updated_at) VALUES (?, ?, 'Victim', 'x', 'active', ?, ?, ?)",
            &[&user, &format!("victim-{user}@example.com"), &now, &now, &now]).await;
        let role = rustrmm_common::new_id();
        insert(&self.state, "INSERT INTO roles (id, name, description, builtin, created_at, updated_at) VALUES (?, ?, '', 0, ?, ?)",
            &[&role, &format!("Victim {role}"), &now, &now]).await;
        v.insert("client", client);
        v.insert("site", site_a);
        v.insert("device", device);
        v.insert("ticket", ticket);
        v.insert("user", user);
        v.insert("role", role);
        v
    }

    /// Fills path parameters: client A's resources (or client B's for scope probes), fresh
    /// victims for destructive routes, and existing rows for everything else.
    async fn uri(&self, method: &str, path: &str, scope_probe: bool) -> String {
        let destructive = method == "DELETE"
            || ["/revoke", "/reject", "/merge", "/reset-mfa"]
                .iter()
                .any(|s| path.ends_with(s));
        let victims = if destructive && !scope_probe {
            self.victims().await
        } else {
            HashMap::new()
        };
        let segments: Vec<&str> = path.split('/').collect();
        let mut out = String::new();
        for (i, seg) in segments.iter().enumerate() {
            if i > 0 {
                out.push('/');
            }
            let Some(param) = seg.strip_prefix('{').and_then(|s| s.strip_suffix('}')) else {
                out.push_str(seg);
                continue;
            };
            let resource = segments.get(i.saturating_sub(1)).copied().unwrap_or("");
            let fixed = |key: &str| self.ids.get(key).cloned();
            let pick = |a: &str, b: &str, victim: &str| {
                if scope_probe {
                    fixed(b)
                } else if let Some(v) = victims.get(victim) {
                    Some(v.clone())
                } else {
                    fixed(a)
                }
            };
            let value = match (resource, param) {
                ("clients", "id") => pick("client_a", "client_b", "client"),
                ("sites", "id") => pick("site_a", "site_b", "site"),
                ("devices", "id") if !path.starts_with("/network") => {
                    pick("device_a", "device_b", "device")
                }
                ("tickets", "id") => pick("ticket_a", "ticket_b", "ticket"),
                ("alerts", "id") => pick("alert_a", "alert_b", "alert"),
                ("users", "id") => victims
                    .get("user")
                    .cloned()
                    .or_else(|| fixed("user_victim")),
                ("roles", "id") => victims
                    .get("role")
                    .cloned()
                    .or_else(|| fixed("role_victim")),
                (_, "device_id") => fixed("device_a"),
                (_, "pid") => Some("4242".into()),
                (_, "name") => Some("Spooler".into()),
                (_, "action") => Some(
                    if path.starts_with("/rollouts") {
                        "pause"
                    } else {
                        "restart"
                    }
                    .into(),
                ),
                (_, "kind") => Some("powershell".into()),
                (_, "version") => Some("1".into()),
                (_, "widget") => Some("fleet_health".into()),
                _ => match table_for(path, resource, param) {
                    Some(table) => self.any_id(table).await,
                    None => None,
                },
            };
            out.push_str(&value.unwrap_or_else(|| "missing-0000".into()));
        }
        format!("/api/v1{out}")
    }
}

fn rand_number() -> u64 {
    u64::from_le_bytes(rustrmm_crypto::random::bytes::<8>())
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
    resp.device_id
}

async fn insert(state: &AppState, sql: &str, binds: &[&str]) {
    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.to_string()));
    for b in binds {
        q = q.bind(*b);
    }
    q.execute(&state.db)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
}

async fn fixture() -> Fixture {
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
    let router = rustrmm_server::listeners::console_router(state.clone());

    let token = state.setup.current_token().expect("setup token");
    let setup = call(
        &router,
        "POST",
        "/api/v1/setup/complete",
        &Auth::Anonymous,
        &Payload::Json(json!({
            "setup_token": token, "organization_name": "Matrix MSP",
            "owner": { "name": "Olivia Owner", "email": "owner@example.com", "password": "correct-horse-battery-staple" },
            "first_client": { "name": "Client A" }, "first_site": { "name": "Site A" }
        })),
    )
    .await;
    assert_eq!(setup.status, StatusCode::OK, "setup: {setup:?}");

    let now = rustrmm_common::now().to_rfc3339();
    let mut ids: HashMap<&'static str, String> = HashMap::new();
    let client_a: String = sqlx::query_scalar("SELECT id FROM clients WHERE name = 'Client A'")
        .fetch_one(&state.db)
        .await
        .expect("client a");
    let site_a: String = sqlx::query_scalar("SELECT id FROM sites WHERE client_id = ?")
        .bind(&client_a)
        .fetch_one(&state.db)
        .await
        .expect("site a");
    ids.insert("client_a", client_a.clone());
    ids.insert("site_a", site_a.clone());
    for (client_key, site_key, name) in [
        ("client_b", "site_b", "Client B"),
        ("client_victim", "site_victim", "Client Victim"),
    ] {
        let (c, s) = (rustrmm_common::new_id(), rustrmm_common::new_id());
        insert(&state, "INSERT INTO clients (id, name, slug, notes, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?)",
            &[&c, name, &name.to_lowercase().replace(' ', "-"), &now, &now]).await;
        insert(&state, "INSERT INTO sites (id, client_id, name, created_at, updated_at) VALUES (?, ?, 'Main', ?, ?)",
            &[&s, &c, &now, &now]).await;
        ids.insert(client_key, c);
        ids.insert(site_key, s);
    }
    // A second site in client A that the destructive site routes may delete.
    let spare_site = rustrmm_common::new_id();
    insert(&state, "INSERT INTO sites (id, client_id, name, created_at, updated_at) VALUES (?, ?, 'Spare', ?, ?)",
        &[&spare_site, &client_a, &now, &now]).await;
    for (key, site, host) in [
        ("device_a", "site_a", "WS-A"),
        ("device_b", "site_b", "WS-B"),
        ("device_victim", "site_a", "WS-VICTIM"),
    ] {
        let device = enroll(&state, addr, &ids[site].clone(), host).await;
        ids.insert(key, device);
    }
    // Tickets and alerts in clients A and B (scope filtering).
    let queue: String = sqlx::query_scalar("SELECT id FROM ticket_queues LIMIT 1")
        .fetch_one(&state.db)
        .await
        .expect("queue");
    for (key, client, number) in [
        ("ticket_a", "client_a", "1001"),
        ("ticket_b", "client_b", "1002"),
        ("ticket_victim", "client_a", "1003"),
    ] {
        let id = rustrmm_common::new_id();
        insert(&state, "INSERT INTO tickets (id, number, subject, status, priority, type, client_id, queue_id, source, created_at, updated_at, last_activity_at) VALUES (?, ?, 'Printer', 'open', 'normal', 'incident', ?, ?, 'console', ?, ?, ?)",
            &[&id, number, &ids[client].clone(), &queue, &now, &now, &now]).await;
        ids.insert(key, id);
    }
    for (key, device, client) in [
        ("alert_a", "device_a", "client_a"),
        ("alert_b", "device_b", "client_b"),
        ("alert_victim", "device_victim", "client_a"),
    ] {
        let id = rustrmm_common::new_id();
        insert(&state, "INSERT INTO alerts (id, device_id, client_id, source, check_id, check_type, severity, status, title, message, opened_at, last_occurrence_at, updated_at) VALUES (?, ?, ?, 'server', 'offline', 'offline', 'warning', 'open', 'Offline', '', ?, ?, ?)",
            &[&id, &ids[device].clone(), &ids[client].clone(), &now, &now, &now]).await;
        ids.insert(key, id);
    }

    // Principals.
    let mut users: HashMap<&'static str, String> = HashMap::new();
    let owner: String =
        sqlx::query_scalar("SELECT id FROM users WHERE email = 'owner@example.com'")
            .fetch_one(&state.db)
            .await
            .expect("owner");
    users.insert("owner", owner);
    for role in ROLES.iter().filter(|r| r.name != "owner") {
        let id = rustrmm_common::new_id();
        insert(&state, "INSERT INTO users (id, email, name, password_hash, status, totp_enabled_at, password_changed_at, created_at, updated_at) VALUES (?, ?, ?, 'x', 'active', ?, ?, ?, ?)",
            &[&id, &format!("{}@example.com", role.name), role.name, &now, &now, &now, &now]).await;
        if let Some(builtin) = role.builtin {
            let (scope_type, scope_id) = if role.scoped {
                ("client", Some(client_a.as_str()))
            } else {
                ("global", None)
            };
            let assignment = rustrmm_common::new_id();
            sqlx::query("INSERT INTO role_assignments (id, user_id, role_id, scope_type, scope_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
                .bind(&assignment).bind(&id).bind(builtin).bind(scope_type).bind(scope_id).bind(&now)
                .execute(&state.db).await.expect("assignment");
        }
        users.insert(role.name, id);
    }
    // Victims for user and role routes.
    let victim = rustrmm_common::new_id();
    insert(&state, "INSERT INTO users (id, email, name, password_hash, status, password_changed_at, created_at, updated_at) VALUES (?, 'victim@example.com', 'Victim', 'x', 'active', ?, ?, ?)",
        &[&victim, &now, &now, &now]).await;
    ids.insert("user_victim", victim);
    let role = rustrmm_common::new_id();
    insert(&state, "INSERT INTO roles (id, name, description, builtin, created_at, updated_at) VALUES (?, 'Victim role', '', 0, ?, ?)",
        &[&role, &now, &now]).await;
    ids.insert("role_victim", role);
    let _ = spare_site;

    Fixture {
        state,
        router,
        addr,
        users,
        ids,
        _dir: dir,
    }
}

/// Hand-written requests for routes whose body cannot be synthesised (or must not reach the
/// network): `(query string, payload)`.
async fn explicit_payload(f: &Fixture, method: &str, path: &str) -> Option<(String, Payload)> {
    let multipart = |field: &str, filename: &str, ct: &str, content: &[u8]| {
        let boundary = "matrixboundary";
        let mut body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{filename}\"\r\nContent-Type: {ct}\r\n\r\n"
        )
        .into_bytes();
        body.extend_from_slice(content);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        Payload::Raw("multipart/form-data; boundary=matrixboundary", body)
    };
    let none = String::new();
    Some(match (method, path) {
        // Never contact a real S3 endpoint.
        ("POST", "/backups/test-s3") => (
            none,
            Payload::Json(json!({
            "enabled": true, "endpoint": "http://127.0.0.1:9", "region": "us-east-1", "bucket": "b",
            "prefix": "", "access_key_id": "a", "secret_access_key": "s" })),
        ),
        ("POST", "/files/branding") => (
            none,
            multipart(
                "file",
                "logo.svg",
                "image/svg+xml",
                b"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"10\"/>",
            ),
        ),
        ("POST", "/software/files") => (
            none,
            multipart("file", "setup.msi", "application/octet-stream", b"MSI"),
        ),
        ("POST", "/agent-releases/import") => (
            none,
            multipart("bundle", "bundle.zip", "application/zip", b"PK"),
        ),
        ("POST", "/devices/{id}/files/upload") => (
            "?path=C:%5CTemp%5Ca.txt".into(),
            Payload::Raw("application/octet-stream", b"hello".to_vec()),
        ),
        ("POST", "/contacts/import") => (
            format!("?client_id={}", f.ids["client_a"]),
            Payload::Raw("text/csv", b"name,email\nAda,ada@example.com\n".to_vec()),
        ),
        // A library script (ad-hoc scripts additionally need scripts.manage and step-up).
        ("POST", "/devices/{id}/run-script") => (
            none,
            Payload::Json(json!({
            "script_id": f.any_id("scripts").await.unwrap_or_default() })),
        ),
        ("POST", "/software/deployments") => (
            none,
            Payload::Json(json!({
            "package_id": f.any_id("software_packages").await.unwrap_or_default(),
            "action": "install",
            "target": { "type": "devices", "ids": [f.ids["device_a"]] } })),
        ),
        ("POST", "/maintenance-windows") | ("PUT", "/maintenance-windows/{id}") => (
            none,
            Payload::Json(json!({
            "name": "Window", "targets": [{ "type": "client", "id": f.ids["client_a"] }],
            "schedule": { "type": "once", "start": "2030-01-01T00:00:00Z", "end": "2030-01-01T01:00:00Z" } })),
        ),
        _ => return None,
    })
}

/// Finds a body (and query) the route accepts, probing as the user without permissions.
async fn synthesize(f: &Fixture, method: &str, path: &str, uri: &str) -> (String, Payload) {
    let (uri, explicit) = match explicit_payload(f, method, path).await {
        Some((query, payload)) => (format!("{uri}{query}"), Some(payload)),
        None => (uri.to_string(), None),
    };
    let uri = uri.as_str();
    let mut body = json!({});
    let mut query = json!({});
    let mut has_body = matches!(method, "POST" | "PUT" | "PATCH");
    let build_uri = |query: &Value| {
        let pairs: Vec<String> = query
            .as_object()
            .map(|o| {
                o.iter()
                    .map(|(k, v)| match v {
                        Value::String(s) => format!("{k}={s}"),
                        other => format!("{k}={other}"),
                    })
                    .collect()
            })
            .unwrap_or_default();
        if pairs.is_empty() {
            uri.to_string()
        } else {
            format!("{uri}?{}", pairs.join("&"))
        }
    };
    let payload_of = |has_body: bool, body: &Value| match &explicit {
        Some(p) => p.clone(),
        None if has_body => Payload::Json(body.clone()),
        None => Payload::None,
    };
    let auth = f.session("nobody", true).await;
    for _ in 0..48 {
        let payload = payload_of(has_body, &body);
        let target = build_uri(&query);
        let resp = call(&f.router, method, &target, &auth, &payload).await;
        let Some(rejection) = resp.rejection else {
            return (target, payload);
        };
        let fixed = if rejection.contains("query string") {
            fix_body(&mut query, &rejection)
        } else if rejection.contains("Content-Type: application/json") && !has_body {
            has_body = true;
            true
        } else if explicit.is_some() {
            false
        } else {
            fix_body(&mut body, &rejection)
        };
        if !fixed {
            if std::env::var("AUTHZ_DISCOVER").is_ok() {
                println!(
                    "synthesis stuck: {method} {path}: {rejection} (body {body}, query {query})"
                );
            }
            break;
        }
    }
    (build_uri(&query), payload_of(has_body, &body))
}

/// Creates one of each resource the matrix addresses by id, through the API as the owner.
async fn seed(f: &Fixture) {
    let discover = std::env::var("AUTHZ_DISCOVER").is_ok();
    let a = f.ids["client_a"].clone();
    let site = f.ids["site_a"].clone();
    let device = f.ids["device_a"].clone();
    let ticket = f.ids["ticket_a"].clone();
    let script = f.any_id("scripts").await.expect("built-in scripts");
    let owner = f.session("owner", true).await;
    let types = call(
        &f.router,
        "GET",
        "/api/v1/reports/types",
        &owner,
        &Payload::None,
    )
    .await;
    let report_type = types
        .json
        .as_ref()
        .and_then(|v| v.pointer("/items/0/type"))
        .and_then(Value::as_str)
        .unwrap_or("executive_summary")
        .to_string();
    let seeds: Vec<(String, Value)> = vec![
        (
            "/variables".into(),
            json!({ "scope": "global", "name": "MATRIX_VAR", "value": "v", "secret": false, "description": "" }),
        ),
        (
            "/jobs".into(),
            json!({ "name": "Matrix job", "script_id": script, "target": { "type": "devices", "ids": [device] }, "schedule": { "type": "once", "at": (rustrmm_common::now() + chrono::Duration::days(30)).to_rfc3339() } }),
        ),
        (
            "/custom-fields".into(),
            json!({ "name": "Matrix field", "key": "matrix_field", "type": "text", "scope": "device" }),
        ),
        (
            "/groups".into(),
            json!({ "kind": "static", "name": "Matrix group" }),
        ),
        (
            "/policies".into(),
            json!({ "name": "Matrix policy", "document": {} }),
        ),
        (
            "/notification-channels".into(),
            json!({ "name": "Matrix channel", "kind": "webhook", "config": { "url": "http://127.0.0.1:9/hook" } }),
        ),
        (
            "/notification-rules".into(),
            json!({ "name": "Matrix rule" }),
        ),
        (
            "/maintenance-windows".into(),
            json!({ "name": "Matrix window", "schedule": { "type": "once", "start": "2030-01-01T00:00:00Z", "end": "2030-01-01T01:00:00Z" }, "targets": [{ "type": "client", "id": a }] }),
        ),
        (
            "/software/packages".into(),
            json!({ "name": "Firefox", "source": { "type": "winget", "id": "Mozilla.Firefox" } }),
        ),
        (
            "/canned-responses".into(),
            json!({ "name": "Matrix canned", "body": "Hello", "shared": true }),
        ),
        (
            "/contacts".into(),
            json!({ "name": "Contact A", "client_id": a, "email": "contact@example.com" }),
        ),
        (
            "/alert-ticket-rules".into(),
            json!({ "name": "Matrix rule", "ticket": {} }),
        ),
        (
            "/network/scans".into(),
            json!({ "name": "Matrix scan", "ranges": ["10.0.0.0/30"], "site_id": site }),
        ),
        (
            "/network/snmp/credentials".into(),
            json!({ "name": "Matrix cred", "version": "v2c", "community": "public" }),
        ),
        (
            "/network/snmp/trap-rules".into(),
            json!({ "name": "Matrix trap", "oid_prefix": "1.3.6.1.4.1" }),
        ),
        (
            "/report-schedules".into(),
            json!({ "name": "Matrix schedule", "type": report_type, "format": "pdf", "cron": "0 6 * * 1", "recipients": ["ops@example.com"] }),
        ),
        (
            "/reports/run".into(),
            json!({ "type": report_type, "format": "csv" }),
        ),
        (
            "/dashboards".into(),
            json!({ "name": "Matrix shared", "shared": true }),
        ),
        (
            "/webhooks".into(),
            json!({ "name": "Matrix hook", "url": "http://127.0.0.1:9/hook", "events": ["device.enrolled"] }),
        ),
        (
            format!("/tickets/{ticket}/comments"),
            json!({ "body": "Note", "public": false }),
        ),
        (
            format!("/tickets/{ticket}/time"),
            json!({ "minutes": 15, "note": "Work" }),
        ),
        ("/backups".into(), json!({})),
        // Revoked by DELETE /api-tokens/{id} (the matrix's own token must survive).
        (
            "/api-tokens".into(),
            json!({ "name": "victim", "permissions": ["devices.view"] }),
        ),
    ];
    for (path, body) in seeds {
        let owner = f.session("owner", true).await;
        let resp = call(
            &f.router,
            "POST",
            &format!("/api/v1{path}"),
            &owner,
            &Payload::Json(body),
        )
        .await;
        if discover && !resp.status.is_success() {
            println!("seed {path}: {} {:?}", resp.status, resp.json);
        }
    }
    if let Some(credential) = f.any_id("snmp_credentials").await {
        let owner = f.session("owner", true).await;
        let resp = call(
            &f.router,
            "POST",
            "/api/v1/network/snmp/devices",
            &owner,
            &Payload::Json(json!({
            "name": "Switch", "ip": "10.0.0.5", "site_id": site, "credential_id": credential })),
        )
        .await;
        if discover && !resp.status.is_success() {
            println!("seed snmp device: {} {:?}", resp.status, resp.json);
        }
    }
}

fn key(method: &str, path: &str) -> String {
    format!("{method} {path}")
}

fn show(seen: Seen) -> String {
    match seen {
        Seen::Passed(s) => s.to_string(),
        other => format!("{other:?}"),
    }
}

/// The owner without step-up and the owner's API token on one route.
#[allow(clippy::too_many_arguments)]
async fn probe(
    f: &Fixture,
    k: &str,
    method: &str,
    target: &str,
    payload: &Payload,
    bearer: &Auth,
    needs: bool,
    only_session: bool,
    public: bool,
) -> (Seen, Seen, Vec<String>) {
    let mut failures = Vec::new();
    let succeeded = |s: Seen| matches!(s, Seen::Passed(200..=299));
    let plain = f.session("owner", false).await;
    let no_step_up = call(&f.router, method, target, &plain, payload)
        .await
        .seen();
    let step_ok = if needs {
        !succeeded(no_step_up) && no_step_up != Seen::Denied
    } else {
        no_step_up != Seen::StepUp
    };
    if !step_ok {
        failures.push(format!(
            "{k}: owner without step-up got {no_step_up:?} ({} step-up)",
            if needs { "expected" } else { "unexpected" }
        ));
    }
    let token_seen = call(&f.router, method, target, bearer, payload)
        .await
        .seen();
    let token_ok = if public {
        token_seen != Seen::TokenBlocked
    } else if only_session {
        token_seen == Seen::TokenBlocked
    } else if needs {
        !succeeded(token_seen) && token_seen != Seen::Unauthenticated
    } else {
        matches!(token_seen, Seen::Passed(_) | Seen::Rejected) && token_seen != Seen::Passed(401)
    };
    if !token_ok {
        failures.push(format!("{k}: API token got {token_seen:?}"));
    }
    (no_step_up, token_seen, failures)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn authorization_matrix() {
    let discover = std::env::var("AUTHZ_DISCOVER").is_ok();
    let f = fixture().await;
    seed(&f).await;

    // The built-in roles still grant exactly what this table assumes.
    for role in ROLES {
        let Some(builtin) = role.builtin else {
            continue;
        };
        let perms: BTreeSet<String> =
            sqlx::query_scalar("SELECT permission FROM role_permissions WHERE role_id = ?")
                .bind(builtin)
                .fetch_all(&f.state.db)
                .await
                .expect("perms")
                .into_iter()
                .collect();
        let expected: BTreeSet<String> = role.perms.iter().map(|p| p.to_string()).collect();
        assert_eq!(
            perms, expected,
            "permissions of {builtin} changed: update the matrix"
        );
    }

    // Every routed endpoint has exactly one expectation, and every expectation is routed.
    let routed: BTreeSet<String> = rustrmm_server::openapi::router_routes()
        .into_iter()
        .map(|(m, p, _)| key(&m.to_uppercase(), p.trim_start_matches("/api/v1")))
        .collect();
    let mut table: BTreeMap<String, Rule> = BTreeMap::new();
    for (m, p, rule) in MATRIX {
        assert!(
            table.insert(key(m, p), *rule).is_none(),
            "duplicate expectation {m} {p}"
        );
    }
    let missing: Vec<&String> = routed.iter().filter(|k| !table.contains_key(*k)).collect();
    let stale: Vec<&String> = table.keys().filter(|k| !routed.contains(*k)).collect();
    assert!(
        missing.is_empty(),
        "routes without an expectation in MATRIX: {missing:#?}"
    );
    assert!(
        stale.is_empty(),
        "MATRIX entries for routes that no longer exist: {stale:#?}"
    );
    for (m, p) in STEP_UP.iter().chain(SESSION_ONLY) {
        assert!(
            routed.contains(&key(m, p)),
            "unknown route in STEP_UP/SESSION_ONLY: {m} {p}"
        );
    }
    let step_up: BTreeSet<String> = STEP_UP.iter().map(|(m, p)| key(m, p)).collect();
    let session_only: BTreeSet<String> = SESSION_ONLY.iter().map(|(m, p)| key(m, p)).collect();

    // An API token of the owner with every permission.
    let owner = f.session("owner", true).await;
    let created = call(
        &f.router,
        "POST",
        "/api/v1/api-tokens",
        &owner,
        &Payload::Json(json!({ "name": "matrix", "permissions": ALL })),
    )
    .await;
    assert_eq!(created.status, StatusCode::CREATED, "{created:?}");
    let bearer = Auth::Bearer(
        created
            .json
            .as_ref()
            .and_then(|v| v["token"].as_str())
            .expect("token")
            .to_string(),
    );

    // Destructive methods run last. Within a route: anonymous, the roles expected to be denied,
    // the owner without step-up and the API token, then the roles expected to be allowed — so a
    // permitted delete can never hide a denial.
    let mut routes: Vec<(&str, &str, Rule)> = MATRIX.to_vec();
    routes.sort_by_key(|(m, p, _)| (*m == "DELETE", p.to_string(), m.to_string()));

    let mut failures: Vec<String> = Vec::new();
    let mut inconclusive: Vec<String> = Vec::new();
    let mut observed: Vec<String> = Vec::new();
    for (method, path, rule) in routes {
        let k = key(method, path);
        let uri = f.uri(method, path, false).await;
        let (target, payload) = if matches!(rule, Ticket) {
            (uri.clone(), Payload::None)
        } else {
            synthesize(&f, method, path, &uri).await
        };

        let anon = call(&f.router, method, &target, &Auth::Anonymous, &payload)
            .await
            .seen();
        let anon_ok = match rule {
            Public => anon != Seen::Unauthenticated,
            Ticket => !matches!(anon, Seen::Passed(200..=299)),
            _ => anon == Seen::Unauthenticated,
        };
        if !anon_ok {
            failures.push(format!("{k}: anonymous caller got {anon:?}"));
        }
        if matches!(rule, Ticket) {
            observed.push(format!(
                "{method:6} {path:55} ticket anonymous={}",
                show(anon)
            ));
            continue;
        }

        let mut results: BTreeMap<&str, Seen> = BTreeMap::new();
        let check = |role: &Role,
                     seen: Seen,
                     failures: &mut Vec<String>,
                     inconclusive: &mut Vec<String>| {
            let expected = rule.allows(role);
            let ok = match (expected, seen) {
                (true, Seen::Passed(_)) => true,
                (_, Seen::Rejected) => {
                    inconclusive.push(format!("{k} as {}: request body not accepted", role.name));
                    true
                }
                (true, _) => false,
                (false, Seen::Denied) => true,
                (false, Seen::Passed(404)) => path.contains('{') || target.contains('?'),
                (false, _) => false,
            };
            if !ok {
                failures.push(format!(
                    "{k}: {} expected {} but got {seen:?}",
                    role.name,
                    if expected { "allowed" } else { "denied" }
                ));
            }
        };
        for role in ROLES.iter().filter(|r| !rule.allows(r)) {
            let auth = f.session(role.name, true).await;
            let seen = call(&f.router, method, &target, &auth, &payload)
                .await
                .seen();
            check(role, seen, &mut failures, &mut inconclusive);
            results.insert(role.name, seen);
        }

        // Step-up: the owner without a recent MFA confirmation must never succeed on a step-up
        // route (handlers may refuse earlier with 404/409/422 — nothing happens either way) and
        // must never be asked for step-up elsewhere. API tokens can never step up and never
        // reach session-only routes. For step-up routes these run before the permitted roles
        // (so the target still exists), for the others afterwards.
        let needs = step_up.contains(&k);
        let mut no_step_up = Seen::Passed(0);
        let mut token_seen = Seen::Passed(0);
        let only_session = session_only.contains(&k);
        if needs {
            let (a, b, mut errs) = probe(
                &f,
                &k,
                method,
                &target,
                &payload,
                &bearer,
                needs,
                only_session,
                matches!(rule, Public),
            )
            .await;
            (no_step_up, token_seen) = (a, b);
            failures.append(&mut errs);
        }
        for role in ROLES.iter().filter(|r| rule.allows(r)) {
            let auth = f.session(role.name, true).await;
            let seen = call(&f.router, method, &target, &auth, &payload)
                .await
                .seen();
            check(role, seen, &mut failures, &mut inconclusive);
            results.insert(role.name, seen);
        }
        if !needs {
            let (a, b, mut errs) = probe(
                &f,
                &k,
                method,
                &target,
                &payload,
                &bearer,
                needs,
                only_session,
                matches!(rule, Public),
            )
            .await;
            (no_step_up, token_seen) = (a, b);
            failures.append(&mut errs);
        }
        let row: Vec<String> = ROLES
            .iter()
            .map(|r| {
                format!(
                    "{}={}",
                    r.name,
                    results.get(r.name).map(|s| show(*s)).unwrap_or_default()
                )
            })
            .collect();
        observed.push(format!(
            "{method:6} {path:55} {} no-step-up={} token={}",
            row.join(" "),
            show(no_step_up),
            show(token_seen)
        ));
    }

    if discover {
        println!("{}", observed.join("\n"));
        println!(
            "--- failures ({}):\n{}",
            failures.len(),
            failures.join("\n")
        );
        println!(
            "--- inconclusive ({}):\n{}",
            inconclusive.len(),
            inconclusive.join("\n")
        );
        return;
    }
    assert!(
        failures.is_empty(),
        "authorization matrix mismatches:\n{}",
        failures.join("\n")
    );
    assert!(
        inconclusive.is_empty(),
        "routes whose request body could not be synthesised (add an explicit payload):\n{}",
        inconclusive.join("\n")
    );
}

/// A client-scoped technician sees only that client's data and cannot reach another client's
/// resources by id.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn client_scoped_technician_is_filtered() {
    let f = fixture().await;
    let scoped = f.session("tech_scoped", true).await;
    let get = |uri: String| {
        let router = f.router.clone();
        let scoped = scoped.clone();
        async move {
            let method = Method::GET;
            let mut req = Request::builder().method(method).uri(uri);
            if let Auth::Session { token, .. } = &scoped {
                req = req.header(header::COOKIE, format!("__Host-rustrmm_session={token}"));
            }
            let resp = router
                .oneshot(req.body(Body::empty()).expect("req"))
                .await
                .expect("resp");
            let status = resp.status();
            let bytes = resp.into_body().collect().await.expect("body").to_bytes();
            (
                status,
                serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null),
            )
        }
    };
    let ids_in = |v: &Value| -> BTreeSet<String> {
        let items = v
            .get("items")
            .or(Some(v))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        items
            .iter()
            .filter_map(|i| i["id"].as_str().map(str::to_string))
            .collect()
    };
    for (list, a, b) in [
        ("/api/v1/devices", "device_a", "device_b"),
        ("/api/v1/clients", "client_a", "client_b"),
        ("/api/v1/sites", "site_a", "site_b"),
        ("/api/v1/tickets", "ticket_a", "ticket_b"),
        ("/api/v1/alerts", "alert_a", "alert_b"),
    ] {
        let (status, body) = get(list.to_string()).await;
        assert_eq!(status, StatusCode::OK, "{list}: {body}");
        let seen = ids_in(&body);
        assert!(seen.contains(&f.ids[a]), "{list} lists client A's item");
        assert!(
            !seen.contains(&f.ids[b]),
            "{list} must not list client B's item"
        );
    }
    // Every GET route with an id of another client's device, client, site, ticket or alert is
    // refused (403) or hidden (404).
    let mut checked = 0;
    for (method, path, rule) in MATRIX {
        if *method != "GET" || !path.contains('{') || matches!(rule, Public | Ticket) {
            continue;
        }
        let first = path.split('/').nth(1).unwrap_or("");
        if !["devices", "clients", "sites", "tickets", "alerts"].contains(&first) {
            continue;
        }
        let uri = f.uri(method, path, true).await;
        let resp = call(&f.router, method, &uri, &scoped, &Payload::None).await;
        assert!(
            matches!(resp.status.as_u16(), 403 | 404),
            "{method} {path} with another client's id returned {}",
            resp.status
        );
        checked += 1;
    }
    assert!(checked >= 30, "only {checked} scoped routes checked");
    // The unscoped technician does see client B.
    let tech = f.session("technician", true).await;
    let resp = call(
        &f.router,
        "GET",
        &format!("/api/v1/devices/{}", f.ids["device_b"]),
        &tech,
        &Payload::None,
    )
    .await;
    assert_eq!(resp.status, StatusCode::OK);
}
