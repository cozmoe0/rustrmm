//! `/api/v1` router.

pub mod audit;
pub mod backups;
pub mod desktop;
pub mod devices;
pub mod enrollment;
pub mod releases;
pub mod remote;
pub mod system;
pub mod tenancy;
pub mod users;

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::routing::{delete, get, patch, post, put};

use crate::auth::{handlers as auth, me, oidc, tokens};
use crate::automation::{
    approvals, custom_fields, groups, jobs, policies, scripts, settings as automation_settings,
    variables,
};
use crate::monitoring::notify::{self, channels, rules};
use crate::monitoring::{self, alerts, ingest, maintenance, settings as monitoring_settings};
use crate::network::{
    assets as net_assets, credentials as snmp_credentials, devices as snmp_devices,
    metrics as snmp_metrics, probes, scans, templates as snmp_templates, topology, traps,
};
use crate::patching::{api as patches, approvals as patch_approvals, compliance};
use crate::software::{deployments, explorer, files as software_files, library};
use crate::state::AppState;
use crate::tickets::{
    api as tickets, canned, comments as ticket_comments, contacts, email as ticket_email,
    queues as ticket_queues, rules as alert_ticket_rules, sla, time as time_entries,
};
use crate::{branding, dashboards, escrow, events, network, reports, setup, webhooks};

pub fn router() -> Router<AppState> {
    Router::new()
        // setup
        .route("/setup/status", get(setup::status))
        .route("/setup/complete", post(setup::complete))
        // authentication
        .route("/auth/login", post(auth::login))
        .route("/auth/logout", post(auth::logout))
        .route("/auth/me", get(me::me))
        .route("/auth/mfa/totp", post(auth::mfa_totp))
        .route("/auth/mfa/recovery", post(auth::mfa_recovery))
        .route("/auth/mfa/webauthn/start", post(auth::mfa_webauthn_start))
        .route("/auth/mfa/webauthn/finish", post(auth::mfa_webauthn_finish))
        .route("/auth/mfa/setup/totp/start", post(auth::totp_setup_start))
        .route("/auth/mfa/setup/totp/finish", post(auth::totp_setup_finish))
        .route("/auth/step-up", post(me::step_up))
        // single sign-on
        .route("/auth/providers", get(oidc::public_providers))
        .route("/auth/oidc/{id}/start", get(oidc::start))
        .route("/auth/oidc/{id}/callback", get(oidc::callback))
        .route(
            "/settings/sso",
            get(oidc::get_settings).put(oidc::put_settings),
        )
        .route(
            "/settings/sso/providers",
            get(oidc::list_providers).post(oidc::create_provider),
        )
        .route(
            "/settings/sso/providers/{id}",
            get(oidc::get_provider)
                .put(oidc::update_provider)
                .delete(oidc::delete_provider),
        )
        // API tokens
        .route("/api-tokens", get(tokens::list).post(tokens::create))
        .route("/api-tokens/{id}", delete(tokens::revoke))
        .route(
            "/auth/step-up/webauthn/start",
            post(me::step_up_webauthn_start),
        )
        .route(
            "/auth/step-up/webauthn/finish",
            post(me::step_up_webauthn_finish),
        )
        // my account
        .route("/me/sessions", get(me::list_sessions))
        .route("/me/sessions/{id}", delete(me::revoke_session))
        .route("/me/password", post(me::change_password))
        .route("/me/recovery-codes", post(me::new_recovery_codes))
        .route("/me/passkeys", get(me::list_passkeys))
        .route(
            "/me/passkeys/register/start",
            post(me::passkey_register_start),
        )
        .route(
            "/me/passkeys/register/finish",
            post(me::passkey_register_finish),
        )
        .route("/me/passkeys/{id}", delete(me::delete_passkey))
        // tenancy
        .route(
            "/clients",
            get(tenancy::list_clients).post(tenancy::create_client),
        )
        .route(
            "/clients/{id}",
            get(tenancy::get_client)
                .patch(tenancy::update_client)
                .delete(tenancy::delete_client),
        )
        .route("/clients/{id}/sites", post(tenancy::create_site))
        .route("/clients/{id}/logo", put(branding::put_client_logo))
        .route("/sites", get(tenancy::list_sites))
        .route(
            "/sites/{id}",
            axum::routing::patch(tenancy::update_site).delete(tenancy::delete_site),
        )
        // users & roles
        .route("/users", get(users::list_users).post(users::create_user))
        .route(
            "/users/{id}",
            axum::routing::patch(users::update_user).delete(users::delete_user),
        )
        .route("/users/{id}/reset-mfa", post(users::reset_mfa))
        .route("/roles", get(users::list_roles).post(users::create_role))
        .route(
            "/roles/{id}",
            axum::routing::patch(users::update_role).delete(users::delete_role),
        )
        .route("/permissions", get(users::list_permissions))
        // devices
        .route("/devices", get(devices::list))
        .route(
            "/devices/{id}",
            get(devices::get)
                .patch(devices::update)
                .delete(devices::delete),
        )
        .route("/devices/{id}/inventory", get(devices::inventory))
        .route(
            "/devices/{id}/inventory/refresh",
            post(devices::refresh_inventory),
        )
        .route("/devices/{id}/metrics", get(devices::metrics))
        .route("/devices/{id}/timeline", get(devices::timeline))
        .route("/devices/{id}/approve", post(devices::approve))
        .route("/devices/{id}/reject", post(devices::reject))
        .route("/devices/{id}/revoke", post(devices::revoke))
        .route("/devices/{id}/live", post(devices::live))
        .route("/devices/{id}/ping", post(releases::ping))
        .route("/devices/{id}/commands", get(releases::device_commands))
        .route("/devices/{id}/update", post(releases::update_device))
        // remote tools
        .route("/devices/{id}/processes", get(remote::processes))
        .route(
            "/devices/{id}/processes/{pid}/kill",
            post(remote::kill_process),
        )
        .route("/devices/{id}/services", get(remote::services))
        .route(
            "/devices/{id}/services/{name}/{action}",
            post(remote::control_service),
        )
        .route("/devices/{id}/event-logs", get(remote::event_logs))
        .route("/devices/{id}/registry", get(remote::registry))
        .route("/devices/{id}/power", post(remote::power))
        .route("/devices/{id}/message", post(remote::message))
        .route("/devices/{id}/diagnostics", post(remote::diagnostics))
        .route("/devices/{id}/files", get(remote::list_files))
        .route("/devices/{id}/files/op", post(remote::file_op))
        .route("/devices/{id}/files/download", get(remote::download))
        .route("/devices/{id}/files/upload", post(remote::upload))
        .route("/devices/{id}/shell", post(remote::create_shell))
        .route("/devices/{id}/desktop", post(desktop::create))
        .route("/devices/{id}/desktop/sessions", get(desktop::sessions))
        .route("/devices/{id}/screenshot", get(desktop::screenshot))
        .route("/remote-sessions", get(remote::list_sessions))
        .route("/remote-sessions/{id}/ws", get(remote::shell_socket))
        .route("/remote-sessions/{id}/recording", get(remote::recording))
        .route("/remote-sessions/{id}/end", post(remote::end_session))
        .route("/agent-releases", get(releases::list))
        .route("/agent-releases/import", post(releases::import))
        .route(
            "/agent-releases/{id}/rollouts",
            post(releases::create_rollout),
        )
        .route("/rollouts", get(releases::list_rollouts))
        .route("/rollouts/{id}/{action}", post(releases::rollout_action))
        // automation: scripts and variables
        .route("/scripts", get(scripts::list).post(scripts::create))
        .route(
            "/scripts/{id}",
            get(scripts::get)
                .put(scripts::update)
                .delete(scripts::archive),
        )
        .route("/scripts/{id}/duplicate", post(scripts::duplicate))
        .route(
            "/scripts/{id}/versions/{version}",
            get(scripts::get_version),
        )
        .route(
            "/scripts/{id}/versions/{version}/approve",
            post(scripts::approve_version),
        )
        .route("/script-categories", get(scripts::categories))
        .route("/variables", get(variables::list).post(variables::create))
        .route(
            "/variables/{id}",
            put(variables::update).delete(variables::delete),
        )
        // automation: jobs and approvals
        .route("/jobs", get(jobs::list).post(jobs::create))
        .route("/jobs/{id}", get(jobs::get).delete(jobs::delete))
        .route("/jobs/{id}/run-now", post(jobs::run_now))
        .route("/jobs/{id}/cancel", post(jobs::cancel))
        .route("/job-runs/{id}", get(jobs::get_run))
        .route("/job-runs/{id}/results/{device_id}", get(jobs::get_result))
        .route("/job-runs/{id}/rerun", post(jobs::rerun))
        .route("/job-runs/{id}/cancel", post(jobs::cancel_run))
        .route("/devices/{id}/script-runs", get(jobs::device_runs))
        .route("/devices/{id}/run-script", post(jobs::device_run_script))
        .route("/approvals", get(approvals::list))
        .route("/approvals/{id}/approve", post(approvals::approve))
        .route("/approvals/{id}/reject", post(approvals::reject))
        .route(
            "/settings/automation",
            get(automation_settings::get).put(automation_settings::put),
        )
        // automation: custom fields
        .route(
            "/custom-fields",
            get(custom_fields::list).post(custom_fields::create),
        )
        .route(
            "/custom-fields/{id}",
            put(custom_fields::update).delete(custom_fields::delete),
        )
        .route(
            "/devices/{id}/custom-fields",
            get(custom_fields::device_get).put(custom_fields::device_put),
        )
        .route(
            "/clients/{id}/custom-fields",
            get(custom_fields::client_get).put(custom_fields::client_put),
        )
        .route(
            "/sites/{id}/custom-fields",
            get(custom_fields::site_get).put(custom_fields::site_put),
        )
        // automation: device groups
        .route("/groups", get(groups::list).post(groups::create))
        .route("/groups/preview", post(groups::preview))
        .route("/groups/{id}", put(groups::update).delete(groups::delete))
        .route(
            "/groups/{id}/members",
            get(groups::members)
                .post(groups::add_members)
                .delete(groups::remove_members),
        )
        .route("/devices/{id}/groups", get(groups::device_groups))
        // automation: policies
        .route("/policies", get(policies::list).post(policies::create))
        .route(
            "/policies/{id}",
            get(policies::get)
                .put(policies::update)
                .delete(policies::delete),
        )
        .route("/policies/{id}/assignments", post(policies::assign))
        .route("/policy-assignments/{id}", delete(policies::unassign))
        .route(
            "/devices/{id}/effective-policy",
            get(policies::device_effective),
        )
        // monitoring: alerts and checks
        .route("/alerts", get(alerts::list))
        .route("/alerts/summary", get(alerts::summary))
        .route("/alerts/bulk", post(alerts::bulk))
        .route("/alerts/{id}", get(alerts::get))
        .route("/alerts/{id}/acknowledge", post(alerts::acknowledge))
        .route("/alerts/{id}/unacknowledge", post(alerts::unacknowledge))
        .route("/alerts/{id}/resolve", post(alerts::resolve))
        .route("/alerts/{id}/snooze", post(alerts::snooze))
        .route("/alerts/{id}/assign", post(alerts::assign))
        .route("/alerts/{id}/notes", post(alerts::add_note))
        .route("/devices/{id}/checks", get(ingest::device_checks))
        .route("/devices/{id}/alerts", get(alerts::device_alerts))
        .route(
            "/devices/{id}/maintenance",
            get(maintenance::device_windows),
        )
        .route("/monitoring/check-types", get(monitoring::check_types))
        // monitoring: notifications
        .route(
            "/notification-channels",
            get(channels::list).post(channels::create),
        )
        .route(
            "/notification-channels/{id}",
            put(channels::update).delete(channels::delete),
        )
        .route("/notification-channels/{id}/test", post(channels::test))
        .route("/notification-rules", get(rules::list).post(rules::create))
        .route(
            "/notification-rules/{id}",
            get(rules::get).put(rules::update).delete(rules::delete),
        )
        .route("/notification-log", get(notify::log))
        // monitoring: maintenance and settings
        .route(
            "/maintenance-windows",
            get(maintenance::list).post(maintenance::create),
        )
        .route(
            "/maintenance-windows/{id}",
            put(maintenance::update).delete(maintenance::delete),
        )
        .route(
            "/settings/monitoring",
            get(monitoring_settings::get).put(monitoring_settings::put),
        )
        .route(
            "/settings/smtp",
            get(monitoring_settings::get_smtp).put(monitoring_settings::put_smtp),
        )
        .route("/settings/smtp/test", post(monitoring_settings::test_smtp))
        // patching
        .route("/patches", get(patches::list))
        .route("/patches/approve", post(patch_approvals::approve))
        .route("/patches/{id}", get(patches::get))
        .route("/patch-approval-rules", get(patches::approval_rules))
        .route("/devices/{id}/patches", get(patches::device_patches))
        .route("/devices/{id}/patches/scan", post(patches::scan))
        .route("/devices/{id}/patches/install", post(patches::install))
        .route("/patch-runs", get(patches::list_runs))
        .route("/patch-runs/{id}", get(patches::get_run))
        .route("/patching/compliance", get(compliance::get))
        .route(
            "/patching/policies/{id}/run-now",
            post(patches::run_window_now),
        )
        // software
        .route("/software", get(explorer::list))
        .route("/software/product", get(explorer::product))
        .route("/software/files", post(software_files::upload))
        .route(
            "/software/packages",
            get(library::list).post(library::create),
        )
        .route(
            "/software/packages/{id}",
            get(library::get)
                .put(library::update)
                .delete(library::delete),
        )
        .route(
            "/software/deployments",
            get(deployments::list).post(deployments::create),
        )
        .route("/software/deployments/{id}", get(deployments::get))
        .route(
            "/software/deployments/{id}/cancel",
            post(deployments::cancel),
        )
        .route(
            "/devices/{id}/software-deployments",
            get(deployments::device_list),
        )
        // tickets
        .route("/tickets", get(tickets::list).post(tickets::create))
        .route("/tickets/stats", get(tickets::stats))
        .route("/tickets/bulk", post(tickets::bulk))
        .route("/tickets/attachments/{id}", get(ticket_comments::download))
        .route(
            "/tickets/{id}",
            get(tickets::get)
                .patch(tickets::update)
                .delete(tickets::delete),
        )
        .route(
            "/tickets/{id}/comments",
            post(ticket_comments::create)
                .layer(DefaultBodyLimit::max(ticket_comments::MAX_REQUEST_BYTES)),
        )
        .route("/tickets/{id}/comments/{cid}", patch(ticket_comments::edit))
        .route("/tickets/{id}/merge", post(tickets::merge))
        .route(
            "/tickets/{id}/links",
            post(tickets::add_links).delete(tickets::remove_links),
        )
        .route("/tickets/{id}/time", post(time_entries::create))
        .route("/devices/{id}/tickets", get(tickets::device_tickets))
        .route(
            "/ticket-queues",
            get(ticket_queues::list).post(ticket_queues::create),
        )
        .route(
            "/ticket-queues/{id}",
            get(ticket_queues::get)
                .put(ticket_queues::update)
                .delete(ticket_queues::delete),
        )
        .route("/sla-policies", get(sla::list).post(sla::create))
        .route(
            "/sla-policies/{id}",
            get(sla::get).put(sla::update).delete(sla::delete),
        )
        .route("/canned-responses", get(canned::list).post(canned::create))
        .route(
            "/canned-responses/{id}",
            get(canned::get).put(canned::update).delete(canned::delete),
        )
        .route(
            "/canned-responses/{id}/render",
            post(canned::render_for_ticket),
        )
        .route("/contacts", get(contacts::list).post(contacts::create))
        .route("/contacts/import", post(contacts::import))
        .route(
            "/contacts/{id}",
            get(contacts::get)
                .put(contacts::update)
                .delete(contacts::delete),
        )
        .route("/time-entries", get(time_entries::list))
        .route(
            "/time-entries/{id}",
            put(time_entries::update).delete(time_entries::delete),
        )
        .route(
            "/settings/ticket-email",
            get(ticket_email::get).put(ticket_email::put),
        )
        .route(
            "/settings/ticket-email/test-imap",
            post(ticket_email::test_imap),
        )
        .route(
            "/alert-ticket-rules",
            get(alert_ticket_rules::list).post(alert_ticket_rules::create),
        )
        .route(
            "/alert-ticket-rules/{id}",
            get(alert_ticket_rules::get)
                .put(alert_ticket_rules::update)
                .delete(alert_ticket_rules::delete),
        )
        .route(
            "/alerts/{id}/ticket",
            post(alert_ticket_rules::create_from_alert),
        )
        // secrets escrow
        .route("/escrow", get(escrow::list))
        .route("/escrow/stats", get(escrow::stats))
        .route("/escrow/{id}", delete(escrow::delete))
        .route("/escrow/{id}/reveal", post(escrow::reveal))
        .route("/devices/{id}/escrow", get(escrow::device_items))
        .route("/devices/{id}/escrow/refresh", post(escrow::refresh))
        .route("/devices/{id}/laps/rotate", post(escrow::rotate_now))
        // network discovery and SNMP
        .route("/sites/{id}/probe", get(probes::get).put(probes::put))
        .route("/network/probes", get(probes::list))
        .route("/network/scans", get(scans::list).post(scans::create))
        .route(
            "/network/scans/{id}",
            put(scans::update).delete(scans::delete),
        )
        .route("/network/scans/{id}/run", post(scans::run))
        .route("/network/assets", get(net_assets::list))
        .route("/network/assets/{id}", patch(net_assets::update))
        .route("/network/assets/{id}/monitor", post(net_assets::monitor))
        .route(
            "/network/snmp/credentials",
            get(snmp_credentials::list).post(snmp_credentials::create),
        )
        .route(
            "/network/snmp/credentials/{id}",
            put(snmp_credentials::update).delete(snmp_credentials::delete),
        )
        .route(
            "/network/snmp/templates",
            get(snmp_templates::list).post(snmp_templates::create),
        )
        .route(
            "/network/snmp/templates/{id}",
            put(snmp_templates::update).delete(snmp_templates::delete),
        )
        .route(
            "/network/snmp/devices",
            get(snmp_devices::list).post(snmp_devices::create),
        )
        .route(
            "/network/snmp/devices/{id}",
            put(snmp_devices::update).delete(snmp_devices::delete),
        )
        .route("/network/snmp/devices/{id}/test", post(snmp_devices::test))
        .route(
            "/network/snmp/devices/{id}/metrics",
            get(snmp_metrics::device_metrics),
        )
        .route("/network/snmp/traps", get(traps::list))
        .route(
            "/network/snmp/trap-rules",
            get(traps::list_rules).post(traps::create_rule),
        )
        .route(
            "/network/snmp/trap-rules/{id}",
            put(traps::update_rule).delete(traps::delete_rule),
        )
        .route("/network/topology", get(topology::get))
        .route(
            "/settings/network",
            get(network::get_settings).put(network::put_settings),
        )
        // deployment
        .route("/enrollment-tokens", get(enrollment::list))
        .route("/sites/{id}/enrollment-tokens", post(enrollment::create))
        .route("/enrollment-tokens/{id}", delete(enrollment::revoke))
        .route(
            "/enrollment-tokens/{id}/deploy-key",
            get(enrollment::deploy_key),
        )
        .route(
            "/enrollment-tokens/{id}/installer/{kind}",
            get(enrollment::installer),
        )
        // reports and dashboards
        .route("/reports/types", get(reports::types))
        .route("/reports/run", post(reports::run))
        .route("/report-runs", get(reports::list_runs))
        .route("/report-runs/{id}", get(reports::get_run))
        .route("/report-runs/{id}/download", get(reports::download_run))
        .route(
            "/report-schedules",
            get(reports::list_schedules).post(reports::create_schedule),
        )
        .route(
            "/report-schedules/{id}",
            get(reports::get_schedule)
                .put(reports::update_schedule)
                .delete(reports::delete_schedule),
        )
        .route(
            "/report-schedules/{id}/run-now",
            post(reports::run_schedule_now),
        )
        .route(
            "/dashboards",
            get(dashboards::list).post(dashboards::create),
        )
        .route("/dashboards/default", get(dashboards::get_default))
        .route("/dashboards/widgets/{widget}", get(dashboards::widget))
        .route(
            "/dashboards/{id}",
            get(dashboards::get)
                .put(dashboards::update)
                .delete(dashboards::delete),
        )
        // webhooks
        .route("/webhooks", get(webhooks::list).post(webhooks::create))
        .route(
            "/webhooks/{id}",
            get(webhooks::get)
                .put(webhooks::update)
                .delete(webhooks::delete),
        )
        .route("/webhooks/{id}/deliveries", get(webhooks::deliveries))
        .route("/webhooks/{id}/test", post(webhooks::test))
        .route(
            "/webhook-deliveries/{id}/redeliver",
            post(webhooks::redeliver),
        )
        // branding
        .route("/branding", get(branding::public))
        .route("/branding/files/{id}", get(branding::serve_file))
        .route(
            "/settings/branding",
            get(branding::get_settings).put(branding::put_settings),
        )
        // code signing status of the agent bundle
        .route("/settings/signing-status", get(crate::signing::status))
        .route(
            "/files/branding",
            post(branding::upload).layer(DefaultBodyLimit::max(branding::MAX_LOGO_BYTES * 2)),
        )
        // audit
        .route("/audit", get(audit::list))
        .route("/audit/verify", post(audit::verify))
        .route("/audit/export", get(audit::export))
        // backups
        .route(
            "/settings/backups",
            get(backups::get_settings).put(backups::put_settings),
        )
        .route("/backups", get(backups::list).post(backups::run_now))
        .route("/backups/test-s3", post(backups::test_s3))
        .route("/backups/{id}", delete(backups::delete))
        .route("/backups/{id}/download", get(backups::download))
        // system & live
        .route("/system/health", get(system::health))
        .route("/system/ca.crt", get(system::ca_certificate))
        .route("/fleet/summary", get(devices::fleet_summary))
        .route("/stream/ticket", post(events::issue_ticket))
        .route("/stream", get(events::stream))
        .fallback(system::not_found)
        .layer(axum::middleware::from_fn(no_store))
}

/// API responses are never cached by browsers or proxies.
async fn no_store(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let mut response = next.run(req).await;
    response
        .headers_mut()
        .entry(axum::http::header::CACHE_CONTROL)
        .or_insert(axum::http::HeaderValue::from_static("no-store"));
    response
}
