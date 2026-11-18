/*
 * Deterministic Phase 6 demo data: the "Baseline monitoring" policy (assigned globally) plus monitoring
 * overrides on existing policies, notification channels and rules (with quiet hours and escalation),
 * SMTP and monitoring settings, maintenance windows (one active now) and about forty alerts derived from
 * the fleet's simulated check states, with their timelines and delivery log.
 */
import type { MonitoringCheck, NotificationRule, PolicyMonitoringSection } from '@/lib/api/types'
import { SECRET_MASK } from '@/lib/automation/params'
import type { World } from './automation-model'
import { hashString, rng, type MockDevice } from './devices'
import {
  addEvent,
  alertSeverity,
  alertText,
  deviceCheckDefinitions,
  emptyMonitoring,
  escalateDue,
  evaluateCheck,
  deliver,
  processRetries,
  raiseAlert,
  resolveAlert,
  serverSettingsFor,
  setIdFactory,
  type MockAlert,
  type MockChannel,
  type MockMonitoring,
  type MonitoringWorld,
} from './monitoring-model'

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString()

interface SeedUser {
  id: string | null
  name: string
}

export function seedMonitoring(input: { world: World; users: SeedUser[]; now?: number }): MockMonitoring {
  const now = input.now ?? Date.now()
  const r = rng(20261119)
  const id = () => {
    const hex = r.hex(32)
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-c${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  }
  setIdFactory(id)
  const monitoring = emptyMonitoring()
  const world: MonitoringWorld = { ...input.world, monitoring }
  const { automation, devices, clients, sites } = input.world
  const person = (name: string) => {
    const user = input.users.find((item) => item.name === name)
    return { id: user?.id ?? id(), name }
  }
  const client = (prefix: string) => clients.find((item) => item.name.startsWith(prefix))!
  const site = (clientPrefix: string, name: string) =>
    sites.find((item) => item.client_id === client(clientPrefix).id && item.name === name)!
  const device = (hostname: string) => devices.find((item) => item.hostname === hostname && item.status === 'active')!
  const script = (key: string) => automation.scripts.find((item) => item.key === key)?.id ?? ''
  const group = (name: string) => automation.groups.find((item) => item.name === name)

  // ---------------------------------------------------------------- policies
  // The contract's baseline: id `builtin-baseline-monitoring`, assigned globally at priority −100.
  const baselineChecks: MonitoringCheck[] = [
    { id: 'cpu-high', type: 'cpu', name: 'High CPU', enabled: true, interval_secs: 60, config: { warn_pct: 90, crit_pct: 98, window_minutes: 15 } },
    { id: 'memory-high', type: 'memory', name: 'Memory pressure', enabled: true, interval_secs: 60, config: { warn_pct: 90, crit_pct: 97, window_minutes: 15 } },
    {
      id: 'disk-space-windows',
      type: 'disk',
      name: 'Low disk space',
      enabled: true,
      interval_secs: 300,
      platforms: ['windows'],
      config: { volume: '*', warn_free_pct: 10, crit_free_pct: 5 },
      remediation: { script_id: script('win-clear-temp'), parameters: { MinAgeDays: 7 }, max_attempts: 1 },
    },
    { id: 'disk-space', type: 'disk', name: 'Low disk space', enabled: true, interval_secs: 300, platforms: ['linux', 'macos'], config: { volume: '*', warn_free_pct: 10, crit_free_pct: 5 } },
    { id: 'uptime', type: 'uptime', name: 'Long uptime', enabled: true, interval_secs: 3600, config: { warn_days: 30, crit_days: 60 } },
    { id: 'pending-reboot', type: 'pending_reboot', name: 'Restart pending', enabled: true, interval_secs: 3600, severity: 'info', platforms: ['windows', 'linux'], config: { warn_after_hours: 72 } },
    { id: 'antivirus', type: 'antivirus', name: 'Antivirus protection', enabled: true, interval_secs: 1800, config: { max_signature_age_hours: 72 } },
    { id: 'firewall', type: 'firewall', name: 'Firewall enabled', enabled: true, interval_secs: 600, platforms: ['windows'], config: {} },
    { id: 'windows-update', type: 'windows_update', name: 'Windows Update freshness', enabled: true, interval_secs: 21_600, severity: 'warning', config: { warn_days_since_install: 35, alert_on_failures: true } },
  ]
  const baseline = {
    id: 'builtin-baseline-monitoring',
    name: 'Baseline monitoring',
    description: 'Created by RustRMM on first start: sensible checks for Windows, macOS and Linux, assigned everywhere.',
    version: 3,
    document: {
      monitoring: {
        checks: baselineChecks,
        server: { offline_minutes: 15, offline_severity: 'critical', agent_outdated: true, disk_forecast_days: 14, security_changes: true },
      } satisfies PolicyMonitoringSection,
    },
    assignments: [{ id: id(), target_type: 'global' as const, target_id: null, priority: -100 }],
    updated_at: iso(now - 6 * DAY),
    updated_by_name: 'Avery Chen',
  }
  automation.policies.unshift(baseline)
  automation.policies.push({
    id: id(),
    name: 'Endpoint health extras',
    description: 'Unexpected shutdowns on Windows and battery wear on laptops, on top of the baseline.',
    version: 1,
    document: {
      monitoring: {
        checks: [
          {
            id: 'unexpected-shutdown',
            type: 'event_log',
            name: 'Unexpected shutdown',
            enabled: true,
            interval_secs: 300,
            severity: 'warning',
            platforms: ['windows'],
            config: { log: 'System', event_ids: [41, 6008], min_level: 2, window_minutes: 1440, threshold: 1 },
          },
          { id: 'battery-health', type: 'battery', name: 'Battery health', enabled: true, interval_secs: 21_600, severity: 'info', config: { min_health_pct: 60 } },
        ],
      },
    },
    assignments: [{ id: id(), target_type: 'global', target_id: null, priority: 0 }],
    updated_at: iso(now - 4 * DAY),
    updated_by_name: 'Sam Rivera',
  })

  const servers = automation.policies.find((policy) => policy.name.startsWith('Servers'))
  if (servers) {
    servers.document.monitoring = {
      checks: [
        { id: 'cpu-high', config: { warn_pct: 85, crit_pct: 95 } },
        {
          id: 'svc-windows-time',
          type: 'service',
          name: 'Windows Time service',
          enabled: true,
          interval_secs: 60,
          severity: 'critical',
          config: { name: 'W32Time', expected: 'running', auto_restart: true, restart_attempts: 2 },
          remediation: { script_id: script('win-restart-service'), parameters: { ServiceName: 'W32Time', Force: false }, max_attempts: 2 },
        },
        { id: 'server-certs', type: 'certificate', name: 'Expiring certificates', enabled: true, interval_secs: 21_600, severity: 'warning', config: { source: 'store', store: 'LocalMachine\\My', warn_days: 30, crit_days: 7 } },
      ],
      server: { offline_minutes: 5, offline_severity: 'critical' },
    }
  }
  const meridian = automation.policies.find((policy) => policy.name.startsWith('Meridian'))
  if (meridian) {
    meridian.document.monitoring = {
      checks: [
        {
          id: 'online-banking',
          type: 'http',
          name: 'Online banking portal',
          enabled: true,
          interval_secs: 120,
          severity: 'critical',
          config: { url: 'https://online.meridiancu.org/health', method: 'GET', expect_status: 200, max_latency_ms: 1500, cert_warn_days: 21, verify_tls: true },
        },
        { id: 'core-switch', type: 'ping', name: 'Core switch reachable', enabled: true, interval_secs: 60, severity: 'critical', config: { target: '10.80.4.1', count: 3, max_loss_pct: 50 } },
      ],
    }
  }
  const kiosk = automation.policies.find((policy) => policy.name.startsWith('Kiosk'))
  if (kiosk) kiosk.document.monitoring = { checks: [{ id: 'pending-reboot', enabled: false }, { id: 'uptime', enabled: false }] }
  const wms = device('sf-wms-01')
  if (wms) {
    automation.policies.push({
      id: id(),
      name: 'Summit WMS monitoring',
      description: 'The warehouse management API and its health endpoint.',
      version: 2,
      document: {
        monitoring: {
          checks: [
            {
              id: 'wms-api',
              type: 'service',
              name: 'WMS API service',
              enabled: true,
              interval_secs: 60,
              severity: 'critical',
              config: { name: 'wms-api.service', expected: 'running', auto_restart: true, restart_attempts: 2 },
              remediation: { script_id: script('linux-restart-unit'), parameters: { Unit: 'wms-api.service' }, max_attempts: 1 },
            },
            { id: 'wms-health', type: 'http', name: 'WMS health endpoint', enabled: true, interval_secs: 60, severity: 'critical', config: { url: 'https://wms.summitfreight.local/healthz', method: 'GET', expect_status: 200, keyword: 'ok', max_latency_ms: 2000, verify_tls: true } },
          ],
        },
      },
      assignments: [{ id: id(), target_type: 'device', target_id: wms.id, priority: 0 }],
      updated_at: iso(now - 15 * DAY),
      updated_by_name: 'Riley Brooks',
    })
  }

  // ---------------------------------------------------------------- notifications
  const channel = (spec: Omit<MockChannel, 'id' | 'last_error'> & { last_error?: string | null }): MockChannel => ({
    id: id(),
    last_error: null,
    ...spec,
  })
  const slack = channel({ name: 'Ops Slack · #alerts', kind: 'slack', enabled: true, config: {}, secrets: { webhook_url: 'https://hooks.slack.com/services/T0LUMEN/B07ALERTS/mock' }, failure: null, last_used_at: null })
  const teams = channel({ name: 'Ops Teams', kind: 'teams', enabled: true, config: {}, secrets: { webhook_url: 'https://prod-42.westus.logic.azure.com/workflows/mock' }, failure: null, last_used_at: null })
  const ntfy = channel({ name: 'On-call push (ntfy)', kind: 'ntfy', enabled: true, config: { server_url: 'https://ntfy.sh', topic: 'lumen-oncall-7f3k' }, secrets: { token: 'tk_mock_oncall' }, failure: null, last_used_at: null })
  const email = channel({ name: 'Service desk email', kind: 'email', enabled: true, config: { to: ['servicedesk@lumen-it.example'], cc: ['noc@lumen-it.example'] }, secrets: {}, failure: null, last_used_at: null })
  const meridianTeams = channel({ name: 'Meridian compliance (Teams)', kind: 'teams', enabled: true, config: {}, secrets: { webhook_url: 'https://prod-07.eastus.logic.azure.com/workflows/meridian' }, failure: null, last_used_at: null })
  const siem = channel({ name: 'SIEM webhook', kind: 'webhook', enabled: true, config: { url: 'https://siem.lumen-it.example/ingest/rustrmm', headers: { 'X-Tenant': SECRET_MASK } }, secrets: { secret: 'whsec_mock', 'headers.X-Tenant': 'lumen' }, failure: null, last_used_at: null })
  const discord = channel({ name: 'Info feed (Discord)', kind: 'discord', enabled: true, config: {}, secrets: { webhook_url: 'https://discord.com/api/webhooks/1/mock' }, failure: 'HTTP 404: Unknown Webhook — the webhook was deleted in Discord', last_used_at: null })
  monitoring.channels = [slack, teams, ntfy, email, meridianTeams, siem, discord]

  const rule = (spec: Omit<NotificationRule, 'id'>): NotificationRule => ({ id: id(), ...spec })
  const anyFilters = { client_ids: [], site_ids: [], severities: [], sources: [], check_types: [], check_ids: [] }
  const quietOff = { enabled: false, start: '22:00', end: '07:00', timezone: 'America/Chicago', days: [0, 1, 2, 3, 4, 5, 6], except_critical: true }
  monitoring.rules = [
    rule({
      name: 'Critical to on-call',
      enabled: true,
      filters: { ...anyFilters, severities: ['critical'] },
      events: ['opened', 'escalated', 'resolved'],
      channel_ids: [slack.id, ntfy.id],
      quiet_hours: quietOff,
      escalation: { enabled: true, after_minutes: 30, channel_ids: [teams.id, email.id] },
    }),
    rule({
      name: 'Warnings to the service desk',
      enabled: true,
      filters: { ...anyFilters, severities: ['warning'] },
      events: ['opened', 'severity_changed'],
      channel_ids: [email.id, slack.id],
      quiet_hours: { enabled: true, start: '19:00', end: '07:30', timezone: 'America/Chicago', days: [0, 1, 2, 3, 4, 5, 6], except_critical: true },
      escalation: { enabled: false, after_minutes: 240, channel_ids: [] },
    }),
    rule({
      name: 'Meridian compliance team',
      enabled: true,
      filters: { ...anyFilters, client_ids: [client('Meridian').id], severities: ['critical', 'warning'] },
      events: ['opened', 'resolved'],
      channel_ids: [meridianTeams.id],
      quiet_hours: { enabled: true, start: '22:00', end: '06:00', timezone: 'America/Chicago', days: [0, 1, 2, 3, 4, 5, 6], except_critical: true },
      escalation: { enabled: true, after_minutes: 60, channel_ids: [email.id] },
    }),
    rule({
      name: 'Security changes to SIEM',
      enabled: true,
      filters: { ...anyFilters, sources: ['server'], check_types: ['security'] },
      events: ['opened', 'resolved'],
      channel_ids: [siem.id],
      quiet_hours: quietOff,
      escalation: { enabled: false, after_minutes: 30, channel_ids: [] },
    }),
    rule({
      name: 'Informational feed',
      enabled: true,
      filters: { ...anyFilters, severities: ['info'] },
      events: ['opened'],
      channel_ids: [discord.id],
      quiet_hours: { enabled: true, start: '18:00', end: '08:00', timezone: 'America/Chicago', days: [1, 2, 3, 4, 5], except_critical: false },
      escalation: { enabled: false, after_minutes: 30, channel_ids: [] },
    }),
    rule({
      name: 'Weekend escalation (draft)',
      enabled: false,
      filters: { ...anyFilters, severities: ['critical', 'warning'], sources: ['check'] },
      events: ['opened', 'escalated'],
      channel_ids: [ntfy.id],
      quiet_hours: quietOff,
      escalation: { enabled: true, after_minutes: 15, channel_ids: [teams.id] },
    }),
  ]

  monitoring.smtp = {
    host: 'smtp.postmarkapp.com',
    port: 587,
    security: 'starttls',
    username: 'pm-lumen-rmm',
    password: 'mock-smtp-password',
    from_address: 'alerts@lumen-it.example',
    from_name: 'Lumen IT · RustRMM',
  }
  monitoring.settings = { default_offline_minutes: 15, unknown_threshold: 3, retention_days: 180, webhook_allowlist: ['siem.lumen-it.example'] }

  // ---------------------------------------------------------------- maintenance windows
  const summitUpgradeStart = Math.floor((now - 40 * MINUTE) / (5 * MINUTE)) * 5 * MINUTE
  const nextSaturday = (() => {
    const date = new Date(now)
    date.setUTCDate(date.getUTCDate() + ((6 - date.getUTCDay() + 7) % 7 || 7))
    date.setUTCHours(2, 0, 0, 0) // 20:00 Chicago (CST) on Friday evening, local to the credit union.
    return date.getTime()
  })()
  const winServers = group('Windows servers')
  monitoring.windows = [
    {
      id: id(),
      name: 'Summit WMS 4.2 upgrade',
      enabled: true,
      targets: [{ type: 'client', id: client('Summit').id }],
      schedule: { type: 'once', start: iso(summitUpgradeStart), end: iso(summitUpgradeStart + 2 * HOUR) },
      suppress: 'notifications',
      created_by_name: 'Riley Brooks',
    },
    {
      id: id(),
      name: 'Patch night — Windows servers',
      enabled: true,
      targets: winServers ? [{ type: 'group', id: winServers.id }] : [{ type: 'global' }],
      schedule: { type: 'recurring', cron: '0 22 * * 3', duration_minutes: 180, timezone: 'America/Chicago' },
      suppress: 'notifications',
      created_by_name: 'Jordan Patel',
    },
    {
      id: id(),
      name: 'Core banking cut-over',
      enabled: true,
      targets: [
        { type: 'device', id: device('mcu-core-app')?.id ?? id() },
        { type: 'site', id: site('Meridian', 'Data Room').id },
      ],
      schedule: { type: 'once', start: iso(nextSaturday), end: iso(nextSaturday + 6 * HOUR) },
      suppress: 'alerts',
      created_by_name: 'Jordan Patel',
    },
    {
      id: id(),
      name: 'Monthly reboot — Northwind front desk',
      enabled: true,
      targets: [{ type: 'site', id: site('Northwind', 'Main Clinic').id }, { type: 'site', id: site('Northwind', 'Eastside Clinic').id }],
      schedule: { type: 'recurring', cron: '0 5 1 * *', duration_minutes: 60, timezone: 'America/Chicago' },
      suppress: 'notifications',
      created_by_name: 'Sam Rivera',
    },
    {
      id: id(),
      name: 'Plotter firmware (paused)',
      enabled: false,
      targets: [{ type: 'device', id: device('ATLAS-PLOT-01')?.id ?? id() }],
      schedule: { type: 'recurring', cron: '0 6 * * 6', duration_minutes: 120, timezone: 'America/Denver' },
      suppress: 'alerts',
      created_by_name: 'Sam Rivera',
    },
  ]

  // ---------------------------------------------------------------- incidents forced into the check engine
  const force = (host: string, checkId: string, state: 'warning' | 'critical', message: string, value: number | null, until: number) => {
    const target = device(host)
    if (!target) return
    ;(monitoring.forced[target.id] ??= {})[checkId] = { state, message, value, until }
  }
  force('sf-wms-01', 'wms-api', 'critical', 'wms-api.service is inactive (dead) since the upgrade started', null, summitUpgradeStart + 2 * HOUR + 4 * MINUTE)
  force('sf-wms-01', 'wms-health', 'critical', 'Connection refused (wms.summitfreight.local:443)', null, summitUpgradeStart + 2 * HOUR + 4 * MINUTE)
  force('SF-HQ-DC01', 'svc-windows-time', 'critical', 'Windows Time is stopped; 2 restart attempts failed (error 1079)', null, now + 6 * HOUR)
  force('MCU-MT-TELLER1', 'online-banking', 'warning', '200 OK in 2140 ms (limit 1500 ms)', 2140, now + 3 * HOUR)

  // ---------------------------------------------------------------- triage helpers
  const sam = person('Sam Rivera')
  const riley = person('Riley Brooks')
  const jordan = person('Jordan Patel')
  const avery = person('Avery Chen')
  const ack = (alert: MockAlert | undefined, who: { id: string; name: string }, after: number, note?: string) => {
    if (!alert) return
    const at = new Date(alert.opened_at).getTime() + after
    alert.status = 'acknowledged'
    alert.acknowledged_at = iso(at)
    alert.acknowledged_by_name = who.name
    addEvent(alert, 'acknowledged', at, note ?? 'Acknowledged', who.name, note ? { note } : null)
  }
  const assign = (alert: MockAlert | undefined, who: { id: string; name: string }, by: { name: string }, after: number) => {
    if (!alert) return
    const at = new Date(alert.opened_at).getTime() + after
    alert.assigned_to = { id: who.id, name: who.name }
    addEvent(alert, 'assigned', at, `Assigned to ${who.name}`, by.name, { user_id: who.id })
  }
  const noteOn = (alert: MockAlert | undefined, who: { name: string }, after: number, text: string) => {
    if (!alert) return
    addEvent(alert, 'note', new Date(alert.opened_at).getTime() + after, text, who.name)
  }
  const remediation = (alert: MockAlert | undefined, scriptName: string, ok: boolean, attempts: number, message: string) => {
    if (!alert) return
    const start = new Date(alert.opened_at).getTime() + 20_000
    addEvent(alert, 'remediation_started', start, `Running “${scriptName}” (attempt 1 of ${attempts})`, null, { script: scriptName })
    addEvent(alert, 'remediation_finished', start + 48_000, message, null, { ok, attempts })
    alert.remediation = { status: ok ? 'succeeded' : 'failed', job_id: null, attempts }
  }

  // ---------------------------------------------------------------- resolved history
  const history: { host: string; checkId: string; type: string; severity: 'critical' | 'warning' | 'info'; title: string; message: string; daysAgo: number; minutes: number; manual?: { by: string; note: string }; remediation?: string }[] = [
    { host: 'SF-DISPATCH-01', checkId: 'svc-spooler', type: 'service', severity: 'critical', title: 'Print Spooler is stopped', message: 'Print Spooler stopped unexpectedly (exit code 0xc0000005)', daysAgo: 0.3, minutes: 2, remediation: 'Restart a service' },
    { host: 'NWD-DC01', checkId: 'cpu-high', type: 'cpu', severity: 'critical', title: 'High CPU on NWD-DC01 (98.4%)', message: '98.4% average over 10 min', daysAgo: 0.8, minutes: 24 },
    { host: 'HPL-DMS01', checkId: 'memory-high', type: 'memory', severity: 'warning', title: 'Memory pressure on HPL-DMS01 (93.1% used)', message: '93.1% in use', daysAgo: 1.2, minutes: 41 },
    { host: 'mcu-backup-01', checkId: 'disk-space', type: 'disk', severity: 'critical', title: 'Low disk space on / (4.1% free)', message: '/ 4.1% free (39 GB of 960 GB)', daysAgo: 6.6, minutes: 95, manual: { by: 'Jordan Patel', note: 'Pruned old nightly backups; retention is still too long for this volume.' } },
    { host: 'NWD-OP1', checkId: 'offline', type: 'offline', severity: 'warning', title: 'NWD-OP1 is offline', message: 'No heartbeat for 22 minutes (threshold 15 min)', daysAgo: 2.1, minutes: 31 },
    { host: 'ATLAS-CAD-07', checkId: 'cpu-high', type: 'cpu', severity: 'warning', title: 'High CPU on ATLAS-CAD-07 (91.2%)', message: '91.2% average over 10 min', daysAgo: 2.4, minutes: 67 },
    { host: 'MCU-HO-WS02', checkId: 'antivirus', type: 'antivirus', severity: 'warning', title: 'Antivirus signatures are out of date', message: 'Real-time protection on · signatures 81 h old', daysAgo: 3.1, minutes: 190 },
    { host: 'sf-edge-gw', checkId: 'offline', type: 'offline', severity: 'warning', title: 'sf-edge-gw is offline', message: 'No heartbeat for 19 minutes (threshold 15 min)', daysAgo: 3.6, minutes: 12 },
    { host: 'CRV-EXAM-2', checkId: 'unexpected-shutdown', type: 'event_log', severity: 'warning', title: 'Unexpected shutdown on CRV-EXAM-2', message: 'Event 6008: the previous system shutdown was unexpected', daysAgo: 4.2, minutes: 600, manual: { by: 'Morgan Lee', note: 'Power cut at the hospital — UPS replaced.' } },
    { host: 'HPL-DC01', checkId: 'svc-windows-time', type: 'service', severity: 'critical', title: 'Windows Time service is stopped', message: 'Windows Time is stopped', daysAgo: 5.0, minutes: 3, remediation: 'Restart a service' },
    { host: 'OAK-LC-LAB12', checkId: 'disk-space-windows', type: 'disk', severity: 'warning', title: 'Low disk space on C: (11.8% free)', message: 'C: 11.8% free (56 GB of 476 GB)', daysAgo: 5.5, minutes: 14, remediation: 'Clear temporary files' },
    { host: 'MCU-DC01', checkId: 'server-certs', type: 'certificate', severity: 'warning', title: 'Certificate expires in 21 days', message: 'CN=mcu-dc01.meridiancu.org expires in 21 days', daysAgo: 6.3, minutes: 2880, manual: { by: 'Jordan Patel', note: 'Renewed through the internal CA.' } },
    { host: 'HPL-WS-011', checkId: 'security.local_admin_added', type: 'security', severity: 'warning', title: 'New local administrator on HPL-WS-011', message: 'HARBORPINE\\helpdesk.tmp was added to the local Administrators group', daysAgo: 8, minutes: 300, manual: { by: 'Sam Rivera', note: 'Temporary help desk account removed.' } },
    { host: 'mbp-ines', checkId: 'battery-health', type: 'battery', severity: 'info', title: 'Battery health 58%', message: 'Battery at 58% of design capacity', daysAgo: 9, minutes: 4000, manual: { by: 'Sam Rivera', note: 'Battery replaced under AppleCare.' } },
    { host: 'atlas-render-01', checkId: 'cpu-high', type: 'cpu', severity: 'critical', title: 'High CPU on atlas-render-01 (99.1%)', message: '99.1% average over 10 min', daysAgo: 10, minutes: 140 },
    { host: 'SF-RENO-WS01', checkId: 'firewall', type: 'firewall', severity: 'critical', title: 'Firewall is disabled', message: 'The public firewall profile is disabled', daysAgo: 12, minutes: 8 },
  ]
  for (const entry of history) {
    const target = devices.find((item) => item.hostname === entry.host && item.status === 'active') as MockDevice | undefined
    if (!target) continue
    const openedAt = now - entry.daysAgo * DAY
    const outcome = raiseAlert(
      world,
      {
        device: target,
        source: ['offline', 'security'].includes(entry.type) ? 'server' : 'check',
        check_id: entry.checkId,
        check_type: entry.type,
        severity: entry.severity,
        title: entry.title,
        message: entry.message,
      },
      openedAt,
    )
    const alert = outcome.alert
    if (!alert || outcome.kind !== 'opened') continue
    if (entry.remediation) remediation(alert, entry.remediation, true, 1, `${entry.remediation} finished (exit 0); the check passed on the next run`)
    const resolvedAt = openedAt + entry.minutes * MINUTE
    if (entry.manual) {
      const by = person(entry.manual.by)
      ack(alert, by, Math.min(entry.minutes * MINUTE * 0.3, 40 * MINUTE))
      resolveAlert(monitoring, alert, resolvedAt, 'manual', by.name, entry.manual.note)
    } else {
      resolveAlert(
        monitoring,
        alert,
        resolvedAt,
        'auto',
        null,
        entry.type === 'offline' ? 'The device reconnected; resolved automatically' : undefined,
      )
    }
  }

  // ---------------------------------------------------------------- initial check states and open alerts
  const forcedSince: Record<string, number> = {
    'sf-wms-01:wms-api': summitUpgradeStart + 9 * MINUTE,
    'sf-wms-01:wms-health': summitUpgradeStart + 10 * MINUTE,
    'SF-HQ-DC01:svc-windows-time': now - 52 * MINUTE,
    'MCU-MT-TELLER1:online-banking': now - 18 * MINUTE,
  }
  const opened: MockAlert[] = []
  for (const item of devices) {
    if (item.status !== 'active') continue
    const evaluatedAt = item.online ? now : new Date(item.last_seen_at ?? now).getTime()
    const memory = (monitoring.memory[item.id] ??= {})
    for (const check of deviceCheckDefinitions(world, item)) {
      const result = monitoring.forced[item.id]?.[check.id] ?? evaluateCheck(check, item, evaluatedAt)
      const seed = hashString(`${item.hostname}:${check.id}:since`)
      const bad = result.state === 'warning' || result.state === 'critical'
      const since =
        forcedSince[`${item.hostname}:${check.id}`] ??
        (bad ? evaluatedAt - (20 * MINUTE + (seed % (40 * HOUR))) : evaluatedAt - (seed % (9 * DAY)) - HOUR)
      memory[check.id] = { state: result.state, since: iso(since), last_at: iso(evaluatedAt), message: result.message, value: result.value, pending: null, unknownCount: 0 }
      if (!bad) continue
      const outcome = raiseAlert(
        world,
        {
          device: item,
          source: 'check',
          check_id: check.id,
          check_type: check.type,
          severity: alertSeverity(check, result.state),
          title: alertText(check, result, item),
          message: result.message,
        },
        since,
      )
      if (outcome.alert) {
        opened.push(outcome.alert)
        const repeats = seed % 4
        for (let index = 1; index <= repeats; index += 1) {
          const at = since + ((evaluatedAt - since) * index) / (repeats + 1)
          outcome.alert.occurrences += 1
          outcome.alert.last_occurrence_at = iso(at)
          addEvent(outcome.alert, 'occurred', at, result.message)
        }
      }
    }
    // Offline (server check), timed from the last heartbeat.
    const server = serverSettingsFor(world, item)
    const lastSeen = new Date(item.last_seen_at ?? now).getTime()
    if (!item.online && server.offline_minutes > 0 && now - lastSeen >= server.offline_minutes * MINUTE) {
      const hours = (now - lastSeen) / HOUR
      const outcome = raiseAlert(
        world,
        {
          device: item,
          source: 'server',
          check_id: 'offline',
          check_type: 'offline',
          severity: server.offline_severity,
          title: `${item.hostname} is offline`,
          message: `No heartbeat for ${hours >= 48 ? `${Math.round(hours / 24)} days` : `${Math.round(hours)} hours`} (threshold ${server.offline_minutes} min)`,
        },
        lastSeen + server.offline_minutes * MINUTE,
      )
      if (outcome.alert) opened.push(outcome.alert)
    }
  }

  // Server-side security and forecast alerts.
  const admin = device('HPL-WS-014')
  if (admin) {
    const outcome = raiseAlert(
      world,
      {
        device: admin,
        source: 'server',
        check_id: 'security.local_admin_added',
        check_type: 'security',
        severity: 'warning',
        title: `New local administrator on ${admin.hostname}`,
        message: `${admin.sim.extraAdmin ?? 'HARBORPINE\\d.rossi'} was added to the local Administrators group`,
      },
      now - 2 * DAY - 3 * HOUR,
    )
    if (outcome.alert) opened.push(outcome.alert)
  }
  const forecast = device('CRV-SRV-01')
  if (forecast) {
    const outcome = raiseAlert(
      world,
      {
        device: forecast,
        source: 'server',
        check_id: 'disk_forecast',
        check_type: 'disk_forecast',
        severity: 'warning',
        title: 'C: predicted full in 11 days',
        message: 'Linear trend over 7 days: +1.7 GB/day; 19% (182 GB) free today',
      },
      now - 9 * HOUR,
    )
    if (outcome.alert) opened.push(outcome.alert)
  }

  // ---------------------------------------------------------------- triage history on open alerts
  const byKey = (host: string, checkId: string) => opened.find((alert) => alert.hostname === host && alert.check_id === checkId)
  const fs01 = byKey('NWD-FS01', 'disk-space-windows')
  remediation(fs01, 'Clear temporary files', true, 1, 'Clear temporary files finished (exit 0): freed 3.2 GB — the check still reports low space')
  ack(fs01, sam, 42 * MINUTE, 'Archiving 2019–2021 scans to the NAS tonight')
  assign(fs01, sam, sam, 42 * MINUTE + 5000)

  const scanDisk = byKey('HPL-ANX-SCAN01', 'disk-space-windows')
  remediation(scanDisk, 'Clear temporary files', false, 1, 'Clear temporary files failed (exit 1): access denied to D:\\ScanQueue')
  assign(scanDisk, avery, jordan, 25 * MINUTE)
  noteOn(scanDisk, jordan, 26 * MINUTE, 'The scanner queue is filling D: — Avery, can you look at the retention job?')

  assign(byKey('BB-POS-01', 'firewall'), jordan, jordan, 3 * HOUR)
  const dc = byKey('SF-HQ-DC01', 'svc-windows-time')
  remediation(dc, 'Restart a service', false, 2, 'Restart a service failed twice (exit 1): the service did not start in a timely fashion (1053)')
  assign(dc, riley, riley, 12 * MINUTE)
  ack(dc, riley, 12 * MINUTE, 'Looking into it — NTP peer change last night')

  ack(byKey('HPL-WS-014', 'security.local_admin_added'), sam, 4 * HOUR, 'Approved by Harbor & Pine IT manager — temporary for a CAD install')
  noteOn(byKey('HPL-WS-014', 'security.local_admin_added'), sam, 4 * HOUR + 60_000, 'Remove the account on Friday. Ticket to follow once ticketing is live.')

  const plotter = byKey('ATLAS-PLOT-01', 'windows-update')
  if (plotter) {
    const at = new Date(plotter.opened_at).getTime() + 2 * HOUR
    plotter.snoozed_until = iso(now + 3 * DAY)
    addEvent(plotter, 'snoozed', at, `Snoozed until ${new Date(now + 3 * DAY).toUTCString().slice(0, 16)} — updates deferred until the project deadline`, sam.name, { until: plotter.snoozed_until })
  }
  noteOn(byKey('MCU-MT-TELLER1', 'online-banking'), jordan, 7 * MINUTE, 'Only the Midtown branch sees this — probably the branch uplink.')

  // Escalations that were due while nobody acknowledged.
  escalateDue(monitoring, now)

  // A few channel tests in the delivery log, then the retries that came due since.
  for (const [target, at] of [
    [slack, now - 13 * DAY],
    [ntfy, now - 13 * DAY + 4 * MINUTE],
    [discord, now - 2 * DAY],
  ] as const) {
    deliver(monitoring, target, { alert_id: null, rule_id: null, event: 'test', at })
  }
  processRetries(monitoring, now)
  monitoring.log.sort((a, b) => b.at.localeCompare(a.at))
  for (const alert of monitoring.alerts) alert.events.sort((a, b) => a.at.localeCompare(b.at))
  setIdFactory(() => crypto.randomUUID())
  return monitoring
}
