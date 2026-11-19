/*
 * In-memory (localStorage-persisted) state behind the MSW mock API.
 * Data is fictional and deterministic so screenshots and tests are stable.
 *
 * URL switches:  ?mock-reset         reseed the demo data (signed out)
 *                ?mock-reset=setup   start from a fresh install that needs setup
 */
import type {
  AgentArtifact,
  AuditEvent,
  Backup,
  BackupSettings,
  Client,
  FleetSummary,
  Passkey,
  Permission,
  Role,
  SessionInfo,
  Site,
  User,
} from '@/lib/api/types'
import { emptyAutomation, type MockAutomation } from './automation-model'
import { seedAutomation } from './automation-seed'
import { evaluateHealth, seedArtifacts, seedDevices, seedTokens, type MockDevice, type MockToken } from './devices'
import { emptyMonitoring, setIdFactory, type MockMonitoring } from './monitoring-model'
import { seedMonitoring } from './monitoring-seed'
import { complianceFacts, configCache, emptyPatching, type MockPatching } from './patching-model'
import { seedPatching } from './patching-seed'
import { seedTickets } from './tickets-seed'
import { emptyTickets, type MockTickets } from './tickets-state'
import type { MockRemoteSession } from './remote-data'
import { seedEscrow } from './escrow-seed'
import { emptyEscrow, type MockEscrow } from './escrow-state'
import { seedSnmpAlerts } from './network-model'
import { seedNetwork } from './network-seed'
import { emptyNetwork, type MockNetwork } from './network-state'
import { emptyPlatform, type MockPlatform } from './platform-state'
import { seedPlatform, seedSigning } from './platform-seed'
import { deviceCompliant } from '@/lib/patching/compliance'

/**
 * Bumped to v10 for Phase 11: reports and API permissions in roles, report runs and schedules,
 * dashboards, SSO providers, API tokens, webhooks, branding and the signing status.
 */
const STORAGE_KEY = 'rustrmm.mock.v10'

export interface MockUser extends User {
  password: string
  totp_enabled: boolean
}

export interface MockState {
  needsSetup: boolean
  organization: string
  meUserId: string
  session: { id: string; csrf: string; steppedUpUntil: number | null; createdAt: string } | null
  challenge: { token: string; kind: 'mfa' | 'setup'; userId: string } | null
  clients: Client[]
  sites: Site[]
  users: MockUser[]
  roles: Role[]
  audit: AuditEvent[]
  backups: Backup[]
  backupSettings: BackupSettings
  s3Secret: string | null
  sessions: SessionInfo[]
  passkeys: Passkey[]
  nextAuditId: number
  devices: MockDevice[]
  tokens: MockToken[]
  artifacts: AgentArtifact[]
  /** Remote session history (Phase 4). Devices are seeded lazily the first time they are viewed. */
  remoteSessions: MockRemoteSession[]
  remoteSeeded: string[]
  /** Recordings of shells opened in the mock, keyed by session id (seeded ones are generated on demand). */
  recordings: Record<string, string>
  /** Scripts, jobs, groups, policies, custom fields and approvals (Phase 5). */
  automation: MockAutomation
  /** Check states, alerts, notification channels and rules, maintenance windows (Phase 6). */
  monitoring: MockMonitoring
  /** Patch catalog, approvals, device patch states, patch runs, the software library and deployments (Phase 7). */
  patching: MockPatching
  /** Tickets, comments, SLA policies, queues, contacts, time entries and e-mail settings (Phase 9). */
  tickets: MockTickets
  /** Escrowed BitLocker keys and LAPS passwords, reveal history and LAPS state (Phase 10). */
  escrow: MockEscrow
  /** Probes, scans, discovered assets, SNMP credentials, templates, devices, traps and trap rules (Phase 10). */
  network: MockNetwork
  /** Report runs and schedules, dashboards, SSO, API tokens, webhooks, branding and signing status (Phase 11). */
  platform: MockPlatform
}

// ------------------------------------------------------------------ deterministic random

function mulberry32(seed: number) {
  let state = seed
  return () => {
    state |= 0
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let random = mulberry32(7)
const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]
const between = (min: number, max: number) => Math.floor(min + random() * (max - min + 1))

export function uuid(): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(random() * 16).toString(16)).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export function randomHex(length: number): string {
  return Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join('')
}

const DAY = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString()

// ------------------------------------------------------------------ catalog

export const PERMISSION_CATALOG: Permission[] = [
  { key: 'clients.view', group: 'Clients & sites', label: 'View clients', description: 'See clients, sites and their summaries.', risk: 'low' },
  { key: 'clients.manage', group: 'Clients & sites', label: 'Manage clients', description: 'Create, rename and delete clients.', risk: 'medium' },
  { key: 'sites.manage', group: 'Clients & sites', label: 'Manage sites', description: 'Create, edit and delete sites within clients.', risk: 'medium' },
  { key: 'users.view', group: 'Users & access', label: 'View users and roles', description: 'See team members, roles and assignments.', risk: 'low' },
  { key: 'users.manage', group: 'Users & access', label: 'Manage users', description: 'Invite, edit, disable users and reset their MFA.', risk: 'high' },
  { key: 'roles.manage', group: 'Users & access', label: 'Manage roles', description: 'Create custom roles and change permissions.', risk: 'high' },
  { key: 'devices.view', group: 'Devices', label: 'View devices', description: 'See devices, inventory, performance and timelines.', risk: 'low' },
  { key: 'devices.manage', group: 'Devices', label: 'Manage devices', description: 'Rename, tag, move and refresh devices; revoke agents.', risk: 'medium' },
  { key: 'devices.delete', group: 'Devices', label: 'Delete devices', description: 'Permanently remove revoked devices and their history.', risk: 'high' },
  { key: 'agents.deploy', group: 'Deployment', label: 'Deploy agents', description: 'Create deploy keys and download installers.', risk: 'high' },
  { key: 'agents.approve', group: 'Deployment', label: 'Approve enrollments', description: 'Approve or reject devices waiting to join.', risk: 'medium' },
  { key: 'agents.update', group: 'Deployment', label: 'Manage agent updates', description: 'Update agents to the latest release and control rollouts.', risk: 'high' },
  { key: 'audit.view', group: 'Audit', label: 'View audit log', description: 'Read the tamper-evident audit trail.', risk: 'low' },
  { key: 'audit.export', group: 'Audit', label: 'Export audit log', description: 'Download the audit trail as CSV or JSON.', risk: 'medium' },
  { key: 'backups.view', group: 'Backups', label: 'View backups', description: 'See backup history and settings.', risk: 'low' },
  { key: 'backups.manage', group: 'Backups', label: 'Manage backups', description: 'Change schedules and destinations, download and delete backups.', risk: 'high' },
  { key: 'settings.view', group: 'Settings', label: 'View settings', description: 'Read server configuration.', risk: 'low' },
  { key: 'settings.manage', group: 'Settings', label: 'Manage settings', description: 'Change server-wide configuration.', risk: 'high' },
  { key: 'remote.system', group: 'Remote tools', label: 'System tools', description: 'Processes, services, event logs, registry and network diagnostics.', risk: 'high' },
  { key: 'remote.files', group: 'Remote tools', label: 'File browser', description: 'Browse, upload, download, rename and delete files on devices.', risk: 'high' },
  { key: 'remote.power', group: 'Remote tools', label: 'Power and messages', description: 'Restart, shut down, lock, sign out and message users.', risk: 'high' },
  { key: 'remote.shell', group: 'Remote tools', label: 'Remote shell', description: 'Open interactive, recorded shells and end live sessions.', risk: 'high' },
  { key: 'remote.recordings', group: 'Remote tools', label: 'Shell recordings', description: 'Replay recorded shell sessions.', risk: 'medium' },
  { key: 'remote.desktop', group: 'Remote tools', label: 'Remote desktop', description: 'View and control device screens, take screenshots and end live desktop sessions.', risk: 'high' },
  { key: 'scripts.view', group: 'Automation', label: 'View scripts and jobs', description: 'See the script library, variables (without secret values), jobs, runs and results.', risk: 'low' },
  { key: 'scripts.manage', group: 'Automation', label: 'Manage scripts', description: 'Create and edit scripts and variables.', risk: 'high' },
  { key: 'scripts.run', group: 'Automation', label: 'Run scripts', description: 'Start, cancel and re-run jobs; quick runs on a device.', risk: 'high' },
  { key: 'scripts.approve', group: 'Automation', label: 'Approve scripts and jobs', description: 'Approve script versions and jobs waiting for a second person.', risk: 'high' },
  { key: 'policies.manage', group: 'Automation', label: 'Manage policies', description: 'Create policies and assign them to clients, sites, groups and devices.', risk: 'high' },
  { key: 'alerts.view', group: 'Monitoring', label: 'View alerts', description: 'See alerts, check states and maintenance windows.', risk: 'low' },
  { key: 'alerts.manage', group: 'Monitoring', label: 'Triage alerts', description: 'Acknowledge, resolve, snooze, assign and annotate alerts.', risk: 'medium' },
  { key: 'monitors.manage', group: 'Monitoring', label: 'Manage monitoring', description: 'Edit monitoring checks in policies, maintenance windows and monitoring settings.', risk: 'high' },
  { key: 'notifications.manage', group: 'Monitoring', label: 'Manage notifications', description: 'Configure notification channels and rules, the SMTP server and send tests.', risk: 'high' },
  { key: 'patches.view', group: 'Patching & software', label: 'View patches', description: 'See patch status, the update catalog, compliance and patch runs.', risk: 'low' },
  { key: 'patches.approve', group: 'Patching & software', label: 'Approve patches', description: 'Approve, decline and defer updates, edit approval rules and install updates now.', risk: 'high' },
  { key: 'software.view', group: 'Patching & software', label: 'View software', description: 'See the software explorer, the library and deployments.', risk: 'low' },
  { key: 'software.library', group: 'Patching & software', label: 'Manage the software library', description: 'Create and edit library packages and upload installers.', risk: 'high' },
  { key: 'tickets.view', group: 'Helpdesk', label: 'View tickets', description: 'Read tickets, comments, contacts and SLAs.', risk: 'low' },
  { key: 'tickets.manage', group: 'Helpdesk', label: 'Work tickets', description: 'Create and edit tickets, comment, assign, change status, merge and link.', risk: 'medium' },
  { key: 'tickets.time', group: 'Helpdesk', label: 'Log time', description: 'Log, edit and delete your own time entries; view time reports.', risk: 'low' },
  { key: 'tickets.settings', group: 'Helpdesk', label: 'Helpdesk settings', description: 'Queues, SLA policies, canned responses, e-mail settings, alert-to-ticket rules and contact import.', risk: 'high' },
  { key: 'software.deploy', group: 'Patching & software', label: 'Deploy software', description: 'Install and uninstall library packages on devices.', risk: 'high' },
  { key: 'secrets.reveal', group: 'Security', label: 'Reveal secrets', description: 'Reveal escrowed BitLocker keys and managed admin passwords (with step-up and a typed reason).', risk: 'high' },
  { key: 'secrets.manage', group: 'Security', label: 'Manage escrow', description: 'Escrow and LAPS policies, rotate passwords now and delete escrowed items.', risk: 'high' },
  { key: 'network.view', group: 'Network', label: 'View network', description: 'See discovered assets, SNMP devices, metrics and traps.', risk: 'low' },
  { key: 'network.manage', group: 'Network', label: 'Manage network', description: 'Assign probes, run discovery scans and manage SNMP credentials, templates and devices.', risk: 'medium' },
  { key: 'reports.view', group: 'Reports & API', label: 'View reports', description: 'Run and view reports and report runs, and see shared dashboards.', risk: 'low' },
  { key: 'reports.manage', group: 'Reports & API', label: 'Manage reports', description: 'Report schedules, everyone’s report runs and shared dashboards.', risk: 'medium' },
  { key: 'api.manage', group: 'Reports & API', label: 'Manage API access', description: 'Webhooks, and everyone’s API tokens (list and revoke).', risk: 'high' },
]

const ALL_KEYS = PERMISSION_CATALOG.map((permission) => permission.key)

// ------------------------------------------------------------------ seed

const CLIENT_SEED: { name: string; accent: string | null; sites: string[]; devices: number[] }[] = [
  { name: 'Northwind Dental', accent: '#3FB8A9', sites: ['Main Clinic', 'Eastside Clinic', 'Imaging Lab'], devices: [28, 14, 6] },
  { name: 'Harbor & Pine Legal', accent: '#5B9CF0', sites: ['Downtown Office', 'Records Annex'], devices: [41, 7] },
  { name: 'Summit Freight', accent: '#E07444', sites: ['Headquarters', 'Dock 4 Warehouse', 'Reno Depot', 'Tacoma Yard'], devices: [36, 18, 11, 9] },
  { name: 'Bluebird Bakery Co.', accent: null, sites: ['Production Kitchen', 'Retail — Pearl St'], devices: [6, 4] },
  { name: 'Cedar Ridge Veterinary', accent: '#4FB477', sites: ['Hospital', 'Mobile Unit'], devices: [17, 3] },
  { name: 'Atlas Architecture', accent: '#A47CF3', sites: ['Studio', 'Remote Staff', 'Plotter Room'], devices: [22, 12, 2] },
  { name: 'Meridian Credit Union', accent: '#E2B34A', sites: ['Head Office', 'Branch — Lakeview', 'Branch — Midtown', 'Data Room'], devices: [33, 12, 12, 5] },
  { name: 'Oakline Schools Foundation', accent: null, sites: ['Administration', 'Learning Center'], devices: [9, 15] },
]

const TIMEZONES = ['America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York']

function slugify(name: string) {
  return name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function seedRoles(): Role[] {
  const technician = ['clients.view', 'sites.manage', 'devices.view', 'devices.manage', 'agents.deploy', 'agents.approve', 'users.view', 'audit.view', 'backups.view', 'settings.view', 'remote.system', 'remote.files', 'remote.power', 'remote.shell', 'remote.desktop', 'scripts.view', 'scripts.manage', 'scripts.run', 'alerts.view', 'alerts.manage', 'patches.view', 'patches.approve', 'software.view', 'software.deploy', 'tickets.view', 'tickets.manage', 'tickets.time', 'network.view', 'reports.view']
  return [
    { id: uuid(), name: 'Owner', description: 'Full control, including ownership-level settings.', builtin: true, permissions: ALL_KEYS, user_count: 0 },
    { id: uuid(), name: 'Administrator', description: 'Manages the platform, users and configuration.', builtin: true, permissions: ALL_KEYS.filter((key) => key !== 'roles.manage'), user_count: 0 },
    { id: uuid(), name: 'Technician', description: 'Works on clients and devices day to day.', builtin: true, permissions: technician, user_count: 0 },
    { id: uuid(), name: 'Help Desk', description: 'First-line support with read access.', builtin: true, permissions: ['clients.view', 'devices.view', 'users.view', 'remote.system', 'remote.power', 'scripts.view', 'alerts.view', 'alerts.manage', 'patches.view', 'software.view', 'tickets.view', 'tickets.manage', 'tickets.time', 'reports.view'], user_count: 0 },
    { id: uuid(), name: 'Auditor', description: 'Read-only access to everything, plus audit export.', builtin: true, permissions: ALL_KEYS.filter((key) => key.endsWith('.view') || key === 'audit.export' || key === 'remote.recordings'), user_count: 0 },
    { id: uuid(), name: 'Backup Operator', description: 'Custom role for the on-call backup rotation.', builtin: false, permissions: ['backups.view', 'backups.manage', 'settings.view'], user_count: 0 },
  ]
}

function seed(needsSetup: boolean): MockState {
  random = mulberry32(7)
  const now = Date.now()
  const roles = seedRoles()
  const roleByName = (name: string) => roles.find((role) => role.name === name)!

  const clients: Client[] = []
  const sites: Site[] = []
  CLIENT_SEED.forEach((entry, index) => {
    const id = uuid()
    const created = now - (420 - index * 37) * DAY
    clients.push({
      id,
      name: entry.name,
      slug: slugify(entry.name),
      notes: index === 0 ? 'Primary contact: practice manager. After-hours escalations go to the on-call tech.' : '',
      accent_color: entry.accent,
      logo_url: null,
      site_count: entry.sites.length,
      device_count: entry.devices.reduce((sum, value) => sum + value, 0),
      created_at: iso(created),
      updated_at: iso(created + between(1, 60) * DAY),
    })
    entry.sites.forEach((siteName, siteIndex) => {
      sites.push({
        id: uuid(),
        client_id: id,
        name: siteName,
        timezone: pick(TIMEZONES),
        address: siteIndex === 0 ? `${between(100, 9800)} ${pick(['Market', 'Harbor', 'Cedar', 'Main', 'Pine'])} St` : '',
        notes: '',
        device_count: entry.devices[siteIndex],
        created_at: iso(created + siteIndex * DAY),
        updated_at: iso(created + siteIndex * DAY),
      })
    })
  })

  const assignment = (roleName: string, scope: 'global' | 'client' | 'site' = 'global', target?: { id: string; name: string }) => {
    const role = roleByName(roleName)
    return {
      id: uuid(),
      role_id: role.id,
      role_name: role.name,
      scope: { type: scope, id: target?.id ?? null, name: target?.name ?? null },
    }
  }

  const summit = clients[2]
  const meridian = clients[6]
  const mainClinic = sites[0]

  const people: [string, string, MockUser['assignments'], MockUser['status'], boolean][] = [
    ['Avery Chen', 'owner@example.com', [assignment('Owner')], 'active', true],
    ['Jordan Patel', 'jordan.patel@example.com', [assignment('Administrator')], 'active', true],
    ['Sam Rivera', 'sam.rivera@example.com', [assignment('Technician')], 'active', true],
    ['Riley Brooks', 'riley.brooks@example.com', [assignment('Technician', 'client', summit)], 'active', true],
    ['Morgan Lee', 'morgan.lee@example.com', [assignment('Help Desk')], 'active', true],
    ['Casey Nguyen', 'casey.nguyen@example.com', [assignment('Auditor')], 'active', true],
    ['Taylor Kim', 'taylor.kim@example.com', [assignment('Technician', 'site', mainClinic)], 'disabled', false],
    ['Drew Alvarez', 'drew.alvarez@example.com', [assignment('Help Desk', 'client', meridian), assignment('Backup Operator')], 'active', false],
  ]

  const users: MockUser[] = people.map(([name, email, assignments, status, mfa], index) => ({
    id: uuid(),
    name,
    email,
    status,
    mfa_enabled: mfa,
    totp_enabled: mfa,
    password: 'correct-horse-battery',
    last_login_at: status === 'disabled' ? iso(now - 40 * DAY) : index < 6 ? iso(now - between(1, 72) * 3_600_000) : null,
    created_at: iso(now - (300 - index * 20) * DAY),
    assignments,
  }))

  const actors = users.filter((user) => user.status === 'active')
  const ips = ['10.20.0.14', '10.20.0.31', '192.168.10.24', '172.16.4.9', '10.20.0.55']
  const agents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Safari/537.36 Edg/142.0',
  ]

  const ACTIONS: { action: string; weight: number; target?: 'client' | 'site' | 'user' | 'role' | 'backup' | 'session' }[] = [
    { action: 'auth.login', weight: 30 },
    { action: 'auth.logout', weight: 10 },
    { action: 'auth.login_failed', weight: 4 },
    { action: 'auth.step_up', weight: 8 },
    { action: 'auth.mfa_enrolled', weight: 2, target: 'user' },
    { action: 'client.created', weight: 2, target: 'client' },
    { action: 'client.updated', weight: 5, target: 'client' },
    { action: 'site.created', weight: 4, target: 'site' },
    { action: 'site.updated', weight: 4, target: 'site' },
    { action: 'user.created', weight: 2, target: 'user' },
    { action: 'user.updated', weight: 3, target: 'user' },
    { action: 'role.updated', weight: 1, target: 'role' },
    { action: 'session.revoked', weight: 2, target: 'session' },
    { action: 'passkey.registered', weight: 1, target: 'user' },
    { action: 'audit.exported', weight: 1 },
    { action: 'settings.backups_updated', weight: 1 },
  ]
  const totalWeight = ACTIONS.reduce((sum, item) => sum + item.weight, 0)
  const weighted = () => {
    let roll = random() * totalWeight
    for (const item of ACTIONS) {
      roll -= item.weight
      if (roll <= 0) return item
    }
    return ACTIONS[0]
  }

  const audit: AuditEvent[] = []
  const backups: Backup[] = []
  let auditId = 1
  const pushAudit = (event: Omit<AuditEvent, 'id' | 'hash'>) => {
    audit.push({ ...event, id: auditId, hash: randomHexSeeded(64) })
    auditId += 1
  }
  function randomHexSeeded(length: number) {
    return Array.from({ length }, () => Math.floor(random() * 16).toString(16)).join('')
  }

  // Nightly backups for the last 14 days, one failure.
  for (let day = 14; day >= 1; day -= 1) {
    const start = new Date(now - day * DAY)
    start.setHours(2, 0, between(1, 40), 0)
    const failed = day === 6
    const backup: Backup = {
      id: uuid(),
      started_at: start.toISOString(),
      finished_at: iso(start.getTime() + between(18, 55) * 1000),
      status: failed ? 'failed' : 'ok',
      trigger: 'schedule',
      size_bytes: failed ? null : between(38, 47) * 1_048_576 + between(0, 999_999),
      sha256: failed ? null : randomHexSeeded(64),
      destinations: [
        { kind: 'local', status: failed ? 'skipped' : 'ok', location: failed ? null : `/backups/rustrmm-${start.toISOString().slice(0, 10)}.tar.zst.age`, error: null },
        {
          kind: 's3',
          status: failed ? 'failed' : 'ok',
          location: failed ? null : `s3://lumen-rmm-backups/prod/rustrmm-${start.toISOString().slice(0, 10)}.tar.zst.age`,
          error: failed ? 'Upload timed out after 30s (s3.us-west-002.backblazeb2.com)' : null,
        },
      ],
      error: failed ? 'S3 destination failed: upload timed out after 30s' : null,
    }
    backups.push(backup)
  }

  const events: Omit<AuditEvent, 'id' | 'hash'>[] = []
  for (let index = 0; index < 300; index += 1) {
    const kind = weighted()
    const actor = pick(actors)
    const at = now - random() * 30 * DAY
    let target: AuditEvent['target'] = null
    let clientId: string | null = null
    let siteId: string | null = null
    if (kind.target === 'client') {
      const client = pick(clients)
      target = { type: 'client', id: client.id, name: client.name }
      clientId = client.id
    } else if (kind.target === 'site') {
      const site = pick(sites)
      target = { type: 'site', id: site.id, name: site.name }
      clientId = site.client_id
      siteId = site.id
    } else if (kind.target === 'user') {
      const user = pick(users)
      target = { type: 'user', id: user.id, name: user.name }
    } else if (kind.target === 'role') {
      const role = pick(roles)
      target = { type: 'role', id: role.id, name: role.name }
    } else if (kind.target === 'session') {
      target = { type: 'session', id: uuid(), name: 'Browser session' }
    }
    events.push({
      at: iso(at),
      actor: kind.action === 'auth.login_failed' ? { type: 'user', id: null, name: actor.email } : { type: 'user', id: actor.id, name: actor.name },
      action: kind.action,
      target,
      client_id: clientId,
      site_id: siteId,
      ip: pick(ips),
      user_agent: pick(agents),
      details:
        kind.action === 'auth.login'
          ? { method: pick(['totp', 'webauthn']) }
          : kind.action === 'auth.login_failed'
            ? { reason: 'invalid_password' }
            : kind.action === 'client.updated'
              ? { changed: ['notes'] }
              : {},
    })
  }
  for (const backup of backups) {
    events.push({
      at: backup.finished_at ?? backup.started_at,
      actor: { type: 'system', id: null, name: 'Backup scheduler' },
      action: backup.status === 'ok' ? 'backup.completed' : 'backup.failed',
      target: { type: 'backup', id: backup.id, name: backup.started_at.slice(0, 10) },
      client_id: null,
      site_id: null,
      ip: null,
      user_agent: null,
      details: backup.status === 'ok' ? { size_bytes: backup.size_bytes, sha256: backup.sha256 } : { error: backup.error },
    })
  }
  events.sort((a, b) => a.at.localeCompare(b.at))
  events.forEach(pushAudit)

  const sessions: SessionInfo[] = [
    { id: uuid(), created_at: iso(now - 2 * 3_600_000), last_seen_at: iso(now), ip: '10.20.0.14', user_agent: agents[0], current: true },
    { id: uuid(), created_at: iso(now - 2 * DAY), last_seen_at: iso(now - 20 * 3_600_000), ip: '10.20.0.31', user_agent: agents[2], current: false },
    { id: uuid(), created_at: iso(now - 6 * DAY), last_seen_at: iso(now - 5 * DAY), ip: '172.16.4.9', user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1', current: false },
  ]

  const devices = needsSetup ? [] : seedDevices(clients, sites, now)
  const automation = needsSetup ? emptyAutomation() : seedAutomation({ clients, sites, devices, users, now })
  const monitoring = needsSetup
    ? emptyMonitoring()
    : seedMonitoring({ world: { automation, devices, clients, sites }, users, now })
  const patching = needsSetup
    ? emptyPatching()
    : seedPatching({ world: { automation, devices, clients, sites }, clients, sites, users, now, id: uuid, monitoring })
  const tickets = needsSetup
    ? emptyTickets()
    : seedTickets({ clients, sites, devices, users, monitoring, now })
  // Phase 10: escrow (adds the LAPS policies) and network discovery / SNMP (opens SNMP alerts).
  let escrow = emptyEscrow()
  let network = emptyNetwork()
  // Phase 11: dashboards, reports, SSO, tokens, webhooks, branding (also sets a client logo).
  const platform = needsSetup ? emptyPlatform() : seedPlatform({ clients, users, roles, now, id: uuid })
  if (!needsSetup) {
    const seededEscrow = seedEscrow({ devices, clients, sites, users, automation, now, id: uuid })
    escrow = seededEscrow.escrow
    network = seedNetwork({ clients, sites, devices, now, id: uuid })
    setIdFactory(uuid)
    seedSnmpAlerts({ network, monitoring, clients }, now)
    setIdFactory(() => crypto.randomUUID())
    // Merge the escrow audit trail into the chain in time order.
    const merged = [...audit.map(({ id: _id, hash: _hash, ...rest }) => rest), ...seededEscrow.audit].sort((a, b) => a.at.localeCompare(b.at))
    audit.length = 0
    auditId = 1
    merged.forEach(pushAudit)
  }
  const state: MockState = {
    needsSetup,
    organization: needsSetup ? '' : 'Lumen IT Partners',
    meUserId: users[0].id,
    session: null,
    challenge: null,
    clients: needsSetup ? [] : clients,
    sites: needsSetup ? [] : sites,
    users: needsSetup ? [] : users,
    roles,
    audit: needsSetup ? [] : audit,
    backups: needsSetup ? [] : backups,
    backupSettings: {
      enabled: true,
      schedule_cron: '0 2 * * *',
      retention: { hourly: 24, daily: 14, weekly: 8, monthly: 12 },
      include_files: false,
      recipient: 'age1u7xhs9qjd03mk5w8yq2kwzlfr6gx4c9nlt0vp3rh8eam2ys5dzpqk7vfj6',
      destinations: {
        local: { enabled: true, path: '/backups' },
        s3: {
          enabled: !needsSetup,
          endpoint: 'https://s3.us-west-002.backblazeb2.com',
          region: 'us-west-002',
          bucket: 'lumen-rmm-backups',
          prefix: 'prod/',
          access_key_id: '0024a7f3c1e9b6d0000000012',
          has_secret: !needsSetup,
          object_lock_days: 30,
        },
      },
    },
    s3Secret: needsSetup ? null : 'mock-secret',
    sessions,
    passkeys: [{ id: uuid(), name: 'YubiKey 5C', created_at: iso(now - 90 * DAY), last_used_at: iso(now - 3 * DAY) }],
    nextAuditId: auditId,
    devices,
    tokens: needsSetup ? [] : seedTokens(clients, sites, now),
    artifacts: seedArtifacts(),
    remoteSessions: [],
    remoteSeeded: [],
    recordings: {},
    automation,
    monitoring,
    patching,
    tickets,
    escrow,
    network,
    platform,
  }
  recountState(state)
  return state
}

// ------------------------------------------------------------------ persistence

/** Older mock versions are abandoned on upgrade; drop them so they don't exhaust the storage quota. */
function dropOldVersions() {
  try {
    for (const key of Object.keys(localStorage)) {
      if (/^rustrmm\.mock\.v\d+$/.test(key) && key !== STORAGE_KEY) localStorage.removeItem(key)
    }
  } catch {
    // Storage may be unavailable; nothing to clean.
  }
}

function load(): MockState {
  dropOldVersions()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const state = JSON.parse(raw) as MockState
      state.automation ??= emptyAutomation()
      state.monitoring ??= emptyMonitoring()
      state.patching ??= emptyPatching()
      state.tickets ??= emptyTickets()
      state.escrow ??= emptyEscrow()
      state.network ??= emptyNetwork()
      state.platform ??= emptyPlatform()
      // The signing status changed shape within v10: reseed it rather than bumping the version.
      if (!state.platform.signing || !('source' in state.platform.signing)) state.platform.signing = seedSigning(Date.now())
      // Seeding is deterministic; ids minted after a reload must not replay the seed's sequence.
      random = mulberry32(Date.now() ^ (Math.random() * 0x7fffffff))
      return state
    }
  } catch {
    // fall through to a fresh seed
  }
  return seed(false)
}

export let db: MockState = load()

export function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db))
  } catch {
    // Quota errors are not important for a demo backend.
  }
}

export function applyMockResetParam() {
  const url = new URL(window.location.href)
  if (!url.searchParams.has('mock-reset')) return
  db = seed(url.searchParams.get('mock-reset') === 'setup')
  persist()
  url.searchParams.delete('mock-reset')
  window.history.replaceState(null, '', url.toString())
}

// ------------------------------------------------------------------ derived data

/** Devices that count towards totals (enrolled and not revoked). */
export function isManaged(device: MockDevice) {
  return device.status === 'active' || device.status === 'quarantined'
}

function recountState(state: MockState) {
  for (const site of state.sites) {
    site.device_count = state.devices.filter((device) => device.site_id === site.id && isManaged(device)).length
  }
  for (const client of state.clients) {
    const clientSites = state.sites.filter((site) => site.client_id === client.id)
    client.site_count = clientSites.length
    client.device_count = clientSites.reduce((sum, site) => sum + site.device_count, 0)
  }
}

export function recountClients() {
  recountState(db)
}

/** Re-evaluates a device's health score after its state changed. */
export function rescoreDevice(device: MockDevice) {
  device.health_score = isManaged(device) ? evaluateHealth(device).score : null
}

export function rolesWithCounts(): Role[] {
  return db.roles.map((role) => ({
    ...role,
    user_count: db.users.filter((user) => user.assignments.some((item) => item.role_id === role.id)).length,
  }))
}

export function permissionsFor(user: MockUser): string[] {
  const keys = new Set<string>()
  for (const item of user.assignments) {
    db.roles.find((role) => role.id === item.role_id)?.permissions.forEach((key) => keys.add(key))
  }
  return [...keys]
}

/** The share of scanned devices that are compliant (one decimal), as the compliance report computes it. */
function patchCompliance(devices: MockDevice[]): number | null {
  const world = { automation: db.automation, devices: db.devices, clients: db.clients, sites: db.sites, patching: db.patching }
  const config = configCache(world)
  const now = Date.now()
  let scanned = 0
  let compliant = 0
  for (const device of devices) {
    if (!isManaged(device)) continue
    const facts = complianceFacts(world, device, config(device), { key: '', label: '' }, now)
    if (!facts) continue
    scanned += 1
    if (deviceCompliant(facts.patches, now)) compliant += 1
  }
  return scanned === 0 ? null : Math.round((compliant * 1000) / scanned) / 10
}

/** Fleet numbers derived from the mock devices, alerts, patch states and tickets. */
export function fleetSummary(clientId?: string | null, siteId?: string | null): FleetSummary {
  const inScope = db.devices.filter(
    (device) => (!clientId || device.client_id === clientId) && (!siteId || device.site_id === siteId),
  )
  const managed = inScope.filter(isManaged)
  const online = managed.filter((device) => device.online).length
  const scored = managed.map((device) => device.health_score).filter((score): score is number => score !== null)
  const total = managed.length
  const liveAlerts = db.monitoring.alerts.filter(
    (alert) =>
      alert.status !== 'resolved' &&
      (!clientId || alert.client_id === clientId) &&
      (!siteId || alert.site_id === siteId),
  )
  const alerts = {
    critical: liveAlerts.filter((alert) => alert.severity === 'critical').length,
    warning: liveAlerts.filter((alert) => alert.severity === 'warning').length,
  }
  return {
    devices_total: total,
    online,
    offline: total - online,
    pending_approval: inScope.filter((device) => device.status === 'pending').length,
    critical_alerts: alerts.critical,
    warning_alerts: alerts.warning,
    alerts,
    patch_compliance_pct: patchCompliance(inScope),
    open_tickets: db.tickets.tickets.filter(
      (ticket) =>
        ['new', 'open', 'pending', 'on_hold'].includes(ticket.status) &&
        (!clientId || ticket.client_id === clientId) &&
        (!siteId || ticket.site_id === siteId),
    ).length,
    average_health: scored.length === 0 ? null : Math.round(scored.reduce((sum, score) => sum + score, 0) / scored.length),
  }
}

export function recordAudit(event: Omit<AuditEvent, 'id' | 'hash' | 'at'>) {
  db.audit.push({ ...event, at: new Date().toISOString(), id: db.nextAuditId, hash: randomHex(64) })
  db.nextAuditId += 1
}
