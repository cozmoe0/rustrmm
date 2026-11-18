//! Role-based access control.
//!
//! Permissions are string keys from a fixed catalog. Roles bundle permissions; users receive
//! roles through assignments scoped to the whole installation, a client, or a single site.
//! [`AccessScope`] is computed per request and every repository query filters through it.

use std::collections::{BTreeSet, HashMap, HashSet};

use anyhow::Result;
use serde::Serialize;
use sqlx::Row;

use crate::db::Db;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Risk {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Serialize)]
pub struct PermissionDef {
    pub key: &'static str,
    pub group: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub risk: Risk,
}

/// Permission keys used by handlers.
pub mod perm {
    pub const CLIENTS_VIEW: &str = "clients.view";
    pub const CLIENTS_MANAGE: &str = "clients.manage";
    pub const SITES_MANAGE: &str = "sites.manage";
    pub const USERS_VIEW: &str = "users.view";
    pub const USERS_MANAGE: &str = "users.manage";
    pub const ROLES_MANAGE: &str = "roles.manage";
    pub const AUDIT_VIEW: &str = "audit.view";
    pub const AUDIT_EXPORT: &str = "audit.export";
    pub const BACKUPS_VIEW: &str = "backups.view";
    pub const BACKUPS_MANAGE: &str = "backups.manage";
    pub const SETTINGS_VIEW: &str = "settings.view";
    pub const SETTINGS_MANAGE: &str = "settings.manage";
    pub const DEVICES_VIEW: &str = "devices.view";
    pub const DEVICES_MANAGE: &str = "devices.manage";
    pub const SCRIPTS_VIEW: &str = "scripts.view";
    pub const SCRIPTS_MANAGE: &str = "scripts.manage";
    pub const SCRIPTS_RUN: &str = "scripts.run";
    pub const SCRIPTS_APPROVE: &str = "scripts.approve";
    pub const POLICIES_MANAGE: &str = "policies.manage";
    pub const ALERTS_VIEW: &str = "alerts.view";
    pub const ALERTS_MANAGE: &str = "alerts.manage";
    pub const MONITORS_MANAGE: &str = "monitors.manage";
    pub const NOTIFICATIONS_MANAGE: &str = "notifications.manage";
    pub const PATCHES_VIEW: &str = "patches.view";
    pub const PATCHES_APPROVE: &str = "patches.approve";
    pub const SOFTWARE_VIEW: &str = "software.view";
    pub const SOFTWARE_LIBRARY: &str = "software.library";
    pub const SOFTWARE_DEPLOY: &str = "software.deploy";
    pub const TICKETS_VIEW: &str = "tickets.view";
    pub const TICKETS_MANAGE: &str = "tickets.manage";
    pub const TICKETS_TIME: &str = "tickets.time";
    pub const TICKETS_SETTINGS: &str = "tickets.settings";
    pub const SECRETS_REVEAL: &str = "secrets.reveal";
    pub const SECRETS_MANAGE: &str = "secrets.manage";
    pub const NETWORK_VIEW: &str = "network.view";
    pub const NETWORK_MANAGE: &str = "network.manage";
    pub const REPORTS_VIEW: &str = "reports.view";
    pub const REPORTS_MANAGE: &str = "reports.manage";
    pub const API_MANAGE: &str = "api.manage";
}

const fn p(
    key: &'static str,
    group: &'static str,
    label: &'static str,
    description: &'static str,
    risk: Risk,
) -> PermissionDef {
    PermissionDef {
        key,
        group,
        label,
        description,
        risk,
    }
}

/// The complete permission catalog (later phases light up the corresponding features).
pub static CATALOG: &[PermissionDef] = &[
    p(
        "clients.view",
        "Clients & sites",
        "View clients",
        "See clients, sites and their contacts",
        Risk::Low,
    ),
    p(
        "clients.manage",
        "Clients & sites",
        "Manage clients",
        "Create, edit and delete clients",
        Risk::Medium,
    ),
    p(
        "sites.manage",
        "Clients & sites",
        "Manage sites",
        "Create, edit and delete sites",
        Risk::Medium,
    ),
    p(
        "devices.view",
        "Devices",
        "View devices",
        "See devices, inventory, metrics and timelines",
        Risk::Low,
    ),
    p(
        "devices.manage",
        "Devices",
        "Manage devices",
        "Edit device details, tags, notes and site membership",
        Risk::Medium,
    ),
    p(
        "devices.delete",
        "Devices",
        "Retire devices",
        "Retire, revoke and delete devices",
        Risk::High,
    ),
    p(
        "agents.deploy",
        "Devices",
        "Deploy agents",
        "Download installers and manage deploy keys",
        Risk::Medium,
    ),
    p(
        "agents.approve",
        "Devices",
        "Approve enrollments",
        "Approve or reject pending agent enrollments",
        Risk::Medium,
    ),
    p(
        "agents.update",
        "Devices",
        "Manage agent updates",
        "Import agent releases and control rollouts",
        Risk::High,
    ),
    p(
        "remote.shell",
        "Remote access",
        "Remote shell",
        "Open interactive command shells on devices",
        Risk::High,
    ),
    p(
        "remote.desktop",
        "Remote access",
        "Remote desktop",
        "View and control device screens",
        Risk::High,
    ),
    p(
        "remote.files",
        "Remote access",
        "File transfer",
        "Browse, upload and download files on devices",
        Risk::High,
    ),
    p(
        "remote.system",
        "Remote access",
        "System tools",
        "Manage processes, services, event logs and registry",
        Risk::Medium,
    ),
    p(
        "remote.power",
        "Remote access",
        "Power & messages",
        "Reboot, shut down, lock devices and message users",
        Risk::Medium,
    ),
    p(
        "remote.recordings",
        "Remote access",
        "Session recordings",
        "Replay recorded remote sessions",
        Risk::Medium,
    ),
    p(
        "scripts.view",
        "Automation",
        "View scripts",
        "See the script library and job history",
        Risk::Low,
    ),
    p(
        "scripts.manage",
        "Automation",
        "Manage scripts",
        "Create and edit scripts and variables",
        Risk::High,
    ),
    p(
        "scripts.run",
        "Automation",
        "Run scripts",
        "Run scripts and jobs on devices",
        Risk::High,
    ),
    p(
        "scripts.approve",
        "Automation",
        "Approve scripts",
        "Approve script versions and high-risk jobs",
        Risk::High,
    ),
    p(
        "policies.manage",
        "Automation",
        "Manage policies",
        "Create policies and assign them to clients, sites and groups",
        Risk::High,
    ),
    p(
        "alerts.view",
        "Monitoring",
        "View alerts",
        "See alerts and monitoring status",
        Risk::Low,
    ),
    p(
        "alerts.manage",
        "Monitoring",
        "Manage alerts",
        "Acknowledge, snooze and resolve alerts",
        Risk::Medium,
    ),
    p(
        "monitors.manage",
        "Monitoring",
        "Manage monitors",
        "Configure checks, thresholds and maintenance windows",
        Risk::Medium,
    ),
    p(
        "notifications.manage",
        "Monitoring",
        "Manage notifications",
        "Configure notification channels and rules",
        Risk::Medium,
    ),
    p(
        "patches.view",
        "Patching & software",
        "View patches",
        "See patch status and compliance",
        Risk::Low,
    ),
    p(
        "patches.approve",
        "Patching & software",
        "Approve patches",
        "Approve, reject and schedule updates",
        Risk::Medium,
    ),
    p(
        "software.view",
        "Patching & software",
        "View software",
        "See installed software across the fleet",
        Risk::Low,
    ),
    p(
        "software.deploy",
        "Patching & software",
        "Deploy software",
        "Install and uninstall software on devices",
        Risk::High,
    ),
    p(
        "software.library",
        "Patching & software",
        "Manage software library",
        "Upload packages and edit deployment definitions",
        Risk::Medium,
    ),
    p(
        "tickets.view",
        "Tickets",
        "View tickets",
        "See tickets and their history",
        Risk::Low,
    ),
    p(
        "tickets.manage",
        "Tickets",
        "Work tickets",
        "Create, update, assign and close tickets",
        Risk::Medium,
    ),
    p(
        "tickets.time",
        "Tickets",
        "Log time",
        "Record time entries on tickets",
        Risk::Low,
    ),
    p(
        "tickets.settings",
        "Tickets",
        "Ticket settings",
        "Configure queues, SLAs and canned responses",
        Risk::Medium,
    ),
    p(
        "secrets.reveal",
        "Security",
        "Reveal secrets",
        "Reveal escrowed BitLocker keys and managed admin passwords",
        Risk::High,
    ),
    p(
        "secrets.manage",
        "Security",
        "Manage escrow",
        "Configure key escrow and password rotation policies",
        Risk::High,
    ),
    p(
        "network.view",
        "Network",
        "View network",
        "See discovered assets and SNMP devices",
        Risk::Low,
    ),
    p(
        "network.manage",
        "Network",
        "Manage network",
        "Run discovery scans and manage SNMP monitoring",
        Risk::Medium,
    ),
    p(
        "reports.view",
        "Reports",
        "View reports",
        "Open and export reports",
        Risk::Low,
    ),
    p(
        "reports.manage",
        "Reports",
        "Manage reports",
        "Create report definitions and schedules",
        Risk::Medium,
    ),
    p(
        "users.view",
        "Users & roles",
        "View users",
        "See users and their role assignments",
        Risk::Low,
    ),
    p(
        "users.manage",
        "Users & roles",
        "Manage users",
        "Create, edit, disable users and reset their MFA",
        Risk::High,
    ),
    p(
        "roles.manage",
        "Users & roles",
        "Manage roles",
        "Create and edit custom roles",
        Risk::High,
    ),
    p(
        "audit.view",
        "Administration",
        "View audit log",
        "Read the audit trail",
        Risk::Low,
    ),
    p(
        "audit.export",
        "Administration",
        "Export audit log",
        "Export the audit trail",
        Risk::Medium,
    ),
    p(
        "backups.view",
        "Administration",
        "View backups",
        "See backup history and settings",
        Risk::Low,
    ),
    p(
        "backups.manage",
        "Administration",
        "Manage backups",
        "Run, download and configure backups",
        Risk::High,
    ),
    p(
        "settings.view",
        "Administration",
        "View settings",
        "See system settings",
        Risk::Low,
    ),
    p(
        "settings.manage",
        "Administration",
        "Manage settings",
        "Change system, security and integration settings",
        Risk::High,
    ),
    p(
        "api.manage",
        "Administration",
        "Manage API access",
        "Create API tokens and webhooks",
        Risk::High,
    ),
];

pub fn is_known(key: &str) -> bool {
    CATALOG.iter().any(|p| p.key == key)
}

pub const OWNER_ROLE_ID: &str = "builtin-owner";

struct BuiltinRole {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    permissions: fn() -> Vec<&'static str>,
}

fn all() -> Vec<&'static str> {
    CATALOG.iter().map(|p| p.key).collect()
}

fn technician() -> Vec<&'static str> {
    vec![
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
    ]
}

fn helpdesk() -> Vec<&'static str> {
    vec![
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
    ]
}

fn auditor() -> Vec<&'static str> {
    let mut perms: Vec<&'static str> = CATALOG
        .iter()
        .map(|p| p.key)
        .filter(|k| k.ends_with(".view") && *k != "secrets.reveal")
        .collect();
    perms.extend(["audit.export", "remote.recordings"]);
    perms
}

static BUILTIN_ROLES: &[BuiltinRole] = &[
    BuiltinRole {
        id: OWNER_ROLE_ID,
        name: "Owner",
        description: "Full control, including managing other owners. Assign sparingly.",
        permissions: all,
    },
    BuiltinRole {
        id: "builtin-admin",
        name: "Administrator",
        description: "Full control of the platform except managing owners.",
        permissions: all,
    },
    BuiltinRole {
        id: "builtin-technician",
        name: "Technician",
        description: "Day-to-day device management, remote access, scripts and tickets.",
        permissions: technician,
    },
    BuiltinRole {
        id: "builtin-helpdesk",
        name: "Help Desk",
        description: "Front-line support: view devices, remote desktop and work tickets.",
        permissions: helpdesk,
    },
    BuiltinRole {
        id: "builtin-auditor",
        name: "Auditor",
        description: "Read-only access to everything plus audit export. Cannot reveal secrets.",
        permissions: auditor,
    },
];

/// Creates/updates the built-in roles so their permission sets always match this binary.
pub async fn seed_builtin_roles(db: &Db) -> Result<()> {
    let now = rustrmm_common::now();
    let mut tx = db.begin().await?;
    for role in BUILTIN_ROLES {
        sqlx::query(
            "INSERT INTO roles (id, name, description, builtin, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)
             ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description, builtin = 1",
        )
        .bind(role.id)
        .bind(role.name)
        .bind(role.description)
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await?;
        sqlx::query("DELETE FROM role_permissions WHERE role_id = ?")
            .bind(role.id)
            .execute(&mut *tx)
            .await?;
        for permission in (role.permissions)() {
            sqlx::query(
                "INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES (?, ?)",
            )
            .bind(role.id)
            .bind(permission)
            .execute(&mut *tx)
            .await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

/// Which clients a user may see for a permission.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientFilter {
    All,
    Only(HashSet<String>),
}

impl ClientFilter {
    pub fn allows(&self, client_id: &str) -> bool {
        match self {
            Self::All => true,
            Self::Only(ids) => ids.contains(client_id),
        }
    }
}

#[derive(Debug, Clone)]
struct SiteGrant {
    client_id: String,
    perms: HashSet<String>,
}

/// Effective permissions of one user, by scope.
#[derive(Debug, Clone, Default)]
pub struct AccessScope {
    pub user_id: String,
    pub is_owner: bool,
    has_global_assignment: bool,
    global: HashSet<String>,
    clients: HashMap<String, HashSet<String>>,
    sites: HashMap<String, SiteGrant>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScopeSummary {
    pub global: bool,
    pub client_ids: Vec<String>,
    pub site_ids: Vec<String>,
}

impl AccessScope {
    pub async fn load(db: &Db, user_id: &str) -> Result<Self> {
        let rows = sqlx::query(
            "SELECT ra.role_id, ra.scope_type, ra.scope_id, rp.permission, s.client_id AS site_client_id
             FROM role_assignments ra
             LEFT JOIN role_permissions rp ON rp.role_id = ra.role_id
             LEFT JOIN sites s ON ra.scope_type = 'site' AND s.id = ra.scope_id
             WHERE ra.user_id = ?",
        )
        .bind(user_id)
        .fetch_all(db)
        .await?;

        let mut scope = Self {
            user_id: user_id.to_string(),
            ..Self::default()
        };
        for row in rows {
            let role_id: String = row.try_get("role_id")?;
            let scope_type: String = row.try_get("scope_type")?;
            let scope_id: Option<String> = row.try_get("scope_id")?;
            let permission: Option<String> = row.try_get("permission")?;
            let site_client: Option<String> = row.try_get("site_client_id")?;
            match scope_type.as_str() {
                "global" => {
                    scope.has_global_assignment = true;
                    if role_id == OWNER_ROLE_ID {
                        scope.is_owner = true;
                    }
                    if let Some(p) = permission {
                        scope.global.insert(p);
                    }
                }
                "client" => {
                    if let Some(client_id) = scope_id {
                        let entry = scope.clients.entry(client_id).or_default();
                        if let Some(p) = permission {
                            entry.insert(p);
                        }
                    }
                }
                "site" => {
                    if let (Some(site_id), Some(client_id)) = (scope_id, site_client) {
                        let entry = scope.sites.entry(site_id).or_insert_with(|| SiteGrant {
                            client_id,
                            perms: HashSet::new(),
                        });
                        if let Some(p) = permission {
                            entry.perms.insert(p);
                        }
                    }
                }
                _ => {}
            }
        }
        Ok(scope)
    }

    /// Union of every permission the user holds at any scope (for UI gating).
    pub fn all_permissions(&self) -> BTreeSet<String> {
        let mut all: BTreeSet<String> = self.global.iter().cloned().collect();
        for perms in self.clients.values() {
            all.extend(perms.iter().cloned());
        }
        for grant in self.sites.values() {
            all.extend(grant.perms.iter().cloned());
        }
        all
    }

    pub fn has_global(&self, perm: &str) -> bool {
        self.global.contains(perm)
    }

    pub fn has_anywhere(&self, perm: &str) -> bool {
        self.has_global(perm)
            || self.clients.values().any(|p| p.contains(perm))
            || self.sites.values().any(|g| g.perms.contains(perm))
    }

    /// Permission over the whole client (global or client-level grant).
    pub fn can_client(&self, perm: &str, client_id: &str) -> bool {
        self.has_global(perm)
            || self
                .clients
                .get(client_id)
                .is_some_and(|p| p.contains(perm))
    }

    /// Permission over a specific site (global, its client, or the site itself).
    pub fn can_site(&self, perm: &str, client_id: &str, site_id: &str) -> bool {
        self.can_client(perm, client_id)
            || self
                .sites
                .get(site_id)
                .is_some_and(|g| g.perms.contains(perm))
    }

    /// Whether the user can see the client at all (full client access or any site inside it).
    pub fn can_see_client(&self, perm: &str, client_id: &str) -> bool {
        self.can_client(perm, client_id)
            || self
                .sites
                .values()
                .any(|g| g.client_id == client_id && g.perms.contains(perm))
    }

    /// Clients where `perm` is granted for the whole client (site-level grants excluded).
    pub fn client_level(&self, perm: &str) -> ClientFilter {
        if self.has_global(perm) {
            return ClientFilter::All;
        }
        ClientFilter::Only(
            self.clients
                .iter()
                .filter(|(_, p)| p.contains(perm))
                .map(|(id, _)| id.clone())
                .collect(),
        )
    }

    /// Sites where `perm` is granted at site level.
    pub fn sites_with(&self, perm: &str) -> Vec<String> {
        let mut sites: Vec<String> = self
            .sites
            .iter()
            .filter(|(_, g)| g.perms.contains(perm))
            .map(|(id, _)| id.clone())
            .collect();
        sites.sort();
        sites
    }

    /// Clients visible for `perm`.
    pub fn client_filter(&self, perm: &str) -> ClientFilter {
        if self.has_global(perm) {
            return ClientFilter::All;
        }
        let mut ids: HashSet<String> = self
            .clients
            .iter()
            .filter(|(_, p)| p.contains(perm))
            .map(|(id, _)| id.clone())
            .collect();
        ids.extend(
            self.sites
                .values()
                .filter(|g| g.perms.contains(perm))
                .map(|g| g.client_id.clone()),
        );
        ClientFilter::Only(ids)
    }

    /// The scope narrowed to `permissions` and, when given, to `client_ids` (API tokens). Global
    /// grants become grants over each listed client; owner status never carries over.
    pub fn restrict(
        &self,
        permissions: &HashSet<String>,
        client_ids: Option<&HashSet<String>>,
    ) -> Self {
        let keep = |perms: &HashSet<String>| -> HashSet<String> {
            perms.intersection(permissions).cloned().collect()
        };
        match client_ids {
            None => Self {
                user_id: self.user_id.clone(),
                is_owner: false,
                has_global_assignment: self.has_global_assignment,
                global: keep(&self.global),
                clients: self
                    .clients
                    .iter()
                    .map(|(id, p)| (id.clone(), keep(p)))
                    .collect(),
                sites: self
                    .sites
                    .iter()
                    .map(|(id, g)| {
                        (
                            id.clone(),
                            SiteGrant {
                                client_id: g.client_id.clone(),
                                perms: keep(&g.perms),
                            },
                        )
                    })
                    .collect(),
            },
            Some(allowed) => {
                let global = keep(&self.global);
                let mut clients: HashMap<String, HashSet<String>> = HashMap::new();
                for client in allowed {
                    let mut perms = global.clone();
                    if let Some(p) = self.clients.get(client) {
                        perms.extend(keep(p));
                    }
                    if !perms.is_empty() {
                        clients.insert(client.clone(), perms);
                    }
                }
                let sites = self
                    .sites
                    .iter()
                    .filter(|(_, g)| allowed.contains(&g.client_id))
                    .map(|(id, g)| {
                        (
                            id.clone(),
                            SiteGrant {
                                client_id: g.client_id.clone(),
                                perms: keep(&g.perms),
                            },
                        )
                    })
                    .collect();
                Self {
                    user_id: self.user_id.clone(),
                    is_owner: false,
                    has_global_assignment: false,
                    global: HashSet::new(),
                    clients,
                    sites,
                }
            }
        }
    }

    pub fn summary(&self) -> ScopeSummary {
        let mut client_ids: Vec<String> = self.clients.keys().cloned().collect();
        client_ids.sort();
        let mut site_ids: Vec<String> = self.sites.keys().cloned().collect();
        site_ids.sort();
        ScopeSummary {
            global: self.has_global_assignment,
            client_ids,
            site_ids,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_keys_are_unique_and_builtins_are_valid() {
        let mut seen = HashSet::new();
        for p in CATALOG {
            assert!(seen.insert(p.key), "duplicate permission {}", p.key);
        }
        for role in BUILTIN_ROLES {
            for key in (role.permissions)() {
                assert!(
                    is_known(key),
                    "role {} references unknown permission {key}",
                    role.id
                );
            }
        }
        assert!(!auditor().contains(&"secrets.reveal"));
    }

    #[test]
    fn scope_checks() {
        let mut scope = AccessScope {
            user_id: "u".into(),
            ..AccessScope::default()
        };
        scope
            .clients
            .insert("c1".into(), HashSet::from(["clients.view".to_string()]));
        scope.sites.insert(
            "s9".into(),
            SiteGrant {
                client_id: "c2".into(),
                perms: HashSet::from(["clients.view".to_string()]),
            },
        );
        assert!(scope.can_client("clients.view", "c1"));
        assert!(!scope.can_client("clients.view", "c2"));
        assert!(scope.can_see_client("clients.view", "c2"));
        assert!(scope.can_site("clients.view", "c2", "s9"));
        assert!(!scope.can_site("clients.view", "c2", "s8"));
        match scope.client_filter("clients.view") {
            ClientFilter::Only(ids) => assert_eq!(ids.len(), 2),
            ClientFilter::All => panic!("expected a restricted filter"),
        }
        assert!(!scope.has_anywhere("users.manage"));
    }

    #[test]
    fn restricted_scopes_for_api_tokens() {
        let mut scope = AccessScope {
            user_id: "u".into(),
            is_owner: true,
            has_global_assignment: true,
            ..AccessScope::default()
        };
        scope.global.extend([
            "devices.view".to_string(),
            "alerts.view".to_string(),
            "users.manage".to_string(),
        ]);
        let perms: HashSet<String> = ["devices.view".to_string(), "tickets.view".to_string()]
            .into_iter()
            .collect();
        let narrowed = scope.restrict(&perms, None);
        assert!(!narrowed.is_owner);
        assert!(narrowed.has_global("devices.view"));
        assert!(!narrowed.has_anywhere("alerts.view"));
        assert!(
            !narrowed.has_anywhere("tickets.view"),
            "never more than the user holds"
        );
        let clients: HashSet<String> = ["c1".to_string()].into_iter().collect();
        let per_client = scope.restrict(&perms, Some(&clients));
        assert!(!per_client.has_global("devices.view"));
        assert!(per_client.can_client("devices.view", "c1"));
        assert!(!per_client.can_client("devices.view", "c2"));
    }
}
