/* Seeds the Phase 11 mock state: dashboards, report runs and schedules, SSO, API tokens, webhooks, branding and signing. */
import type { Client, ReportSchedule, Role, SigningStatus, WebhookDelivery, WebhookEvent, WidgetPlacement } from '@/lib/api/types'
import { nextCronRuns } from '@/lib/cron'
import type { MockUser } from './db'
import { bytesToBase64, emptyPlatform, type MockPlatform, type MockReportRun } from './platform-state'

const DAY = 86_400_000
const HOUR = 3_600_000
const iso = (ms: number) => new Date(ms).toISOString()

const NORTHWIND_LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0f766e"/><path d="M20 18c4-3 8-2 12 0 4-2 8-3 12 0 5 4 4 12 1 19-2 5-3 9-4 12-1 3-4 3-5 0l-2-8c-1-2-3-2-4 0l-2 8c-1 3-4 3-5 0-1-3-2-7-4-12-3-7-4-15 1-19z" fill="#f0fdfa"/></svg>`

function placement(widget: WidgetPlacement['widget'], x: number, y: number, w: number, h: number, config: WidgetPlacement['config'] = {}): WidgetPlacement {
  return { widget, x, y, w, h, config }
}

export function seedPlatform(input: { clients: Client[]; users: MockUser[]; roles: Role[]; now: number; id: () => string }): MockPlatform {
  const { clients, users, roles, now, id } = input
  const state = emptyPlatform()
  const user = (email: string) => users.find((item) => item.email === email)!
  const avery = user('owner@example.com')
  const jordan = user('jordan.patel@example.com')
  const sam = user('sam.rivera@example.com')
  const northwind = clients[0]
  const summit = clients[2]
  const role = (name: string) => roles.find((item) => item.name === name)!

  // ---------------------------------------------------------------- dashboards
  state.dashboards = [
    {
      id: id(),
      name: 'Service desk wallboard',
      owner_id: jordan.id,
      shared: true,
      layout: [
        placement('sla_breaches', 0, 0, 6, 5, { limit: 8 }),
        placement('tickets_open', 6, 0, 3, 3),
        placement('alerts_by_severity', 9, 0, 3, 3),
        placement('devices_offline', 6, 3, 6, 4, { limit: 6 }),
        placement('alerts_list', 0, 5, 6, 5, { limit: 8 }),
        placement('recent_jobs', 6, 7, 6, 3, { limit: 5, days: 3 }),
      ],
      created_at: iso(now - 40 * DAY),
      updated_at: iso(now - 6 * DAY),
    },
    {
      id: id(),
      name: 'Morning checks',
      owner_id: avery.id,
      shared: false,
      layout: [
        placement('fleet_health', 0, 0, 4, 3),
        placement('patch_compliance', 4, 0, 4, 3),
        placement('agent_versions', 8, 0, 4, 3),
        placement('top_disk_usage', 0, 3, 4, 5, { limit: 8 }),
        placement('custom_field_breakdown', 4, 3, 4, 5, { field: 'warranty_end', title: 'Warranty ends (by year)' }),
        placement('recent_jobs', 8, 3, 4, 5, { limit: 6, days: 7 }),
      ],
      created_at: iso(now - 21 * DAY),
      updated_at: iso(now - 2 * DAY),
    },
    {
      id: id(),
      name: `${summit.name} overview`,
      owner_id: avery.id,
      shared: false,
      layout: [
        placement('fleet_health', 0, 0, 4, 3, { client_id: summit.id }),
        placement('patch_compliance', 4, 0, 4, 3, { client_id: summit.id }),
        placement('tickets_open', 8, 0, 4, 3, { client_id: summit.id }),
        placement('alerts_list', 0, 3, 8, 4, { client_id: summit.id, limit: 6 }),
        placement('os_mix', 8, 3, 4, 4, { client_id: summit.id }),
      ],
      created_at: iso(now - 12 * DAY),
      updated_at: iso(now - 12 * DAY),
    },
  ]

  // ---------------------------------------------------------------- report schedules and runs
  const schedule = (input: Omit<ReportSchedule, 'id' | 'next_run_at' | 'created_at' | 'updated_at'> & { created_days: number }): ReportSchedule => {
    const { created_days, ...rest } = input
    return {
      ...rest,
      id: id(),
      next_run_at: rest.enabled ? (nextCronRuns(rest.cron, { timeZone: rest.timezone, count: 1, from: new Date(now) })[0]?.toISOString() ?? null) : null,
      created_at: iso(now - created_days * DAY),
      updated_at: iso(now - Math.min(created_days, 9) * DAY),
    }
  }
  const lastMonthly = new Date(now)
  lastMonthly.setDate(1)
  lastMonthly.setHours(12, 0, 0, 0)
  const lastMonday = new Date(now - ((new Date(now).getDay() + 6) % 7) * DAY)
  lastMonday.setHours(12, 0, 0, 0)
  state.reportSchedules = [
    schedule({
      name: 'Monthly executive summary (per client)',
      type: 'executive_summary',
      parameters: { client_id: 'all' },
      format: 'pdf',
      cron: '0 7 1 * *',
      timezone: 'America/New_York',
      recipients: ['reports@lumen-it.example'],
      per_client: true,
      enabled: true,
      last_run_at: iso(lastMonthly.getTime()),
      last_status: 'ok',
      last_error: null,
      created_by: avery.id,
      created_days: 120,
    }),
    schedule({
      name: 'Weekly patch compliance',
      type: 'patch_compliance',
      parameters: { client_id: 'all' },
      format: 'pdf',
      cron: '0 7 * * 1',
      timezone: 'America/Los_Angeles',
      recipients: ['ops@lumen-it.example', sam.email],
      per_client: false,
      enabled: true,
      last_run_at: iso(lastMonday.getTime()),
      last_status: 'ok',
      last_error: null,
      created_by: jordan.id,
      created_days: 64,
    }),
    schedule({
      name: `Quarterly hardware refresh — ${summit.name}`,
      type: 'hardware_inventory',
      parameters: { client_id: summit.id },
      format: 'csv',
      cron: '0 7 1 1,4,7,10 *',
      timezone: 'America/Chicago',
      recipients: ['it@summitfreight.example'],
      per_client: false,
      enabled: false,
      last_run_at: iso(now - 48 * DAY),
      last_status: 'failed',
      last_error: 'SMTP server refused the recipient it@summitfreight.example (550 5.1.1 user unknown)',
      created_by: avery.id,
      created_days: 210,
    }),
  ]
  const [monthly, weekly, quarterly] = state.reportSchedules
  const run = (input: Partial<MockReportRun> & Pick<MockReportRun, 'type' | 'title' | 'format' | 'created_at'>): MockReportRun => {
    const created = new Date(input.created_at).getTime()
    const failed = input.status === 'failed'
    return {
      id: id(),
      status: 'completed',
      trigger: 'manual',
      schedule_id: null,
      client_id: null,
      user_id: avery.id,
      user_name: avery.name,
      file_name: input.format === 'json' || failed ? null : `${input.type.replace(/_/g, '-')}-${input.created_at.slice(0, 10).replace(/-/g, '')}.${input.format}`,
      size_bytes: input.format === 'json' || failed ? null : input.format === 'pdf' ? 180_000 + Math.round((created % 97) * 1300) : 24_000 + Math.round((created % 89) * 400),
      error: null,
      emailed_to: [],
      started_at: input.created_at,
      finished_at: iso(created + 4_000 + (created % 7) * 900),
      downloadable: input.format !== 'json' && !failed && now - created < 30 * DAY,
      parameters: { client_id: 'all' },
      ...input,
    }
  }
  const runs: MockReportRun[] = []
  for (const client of clients.slice(0, 6)) {
    runs.push(run({ type: 'executive_summary', title: 'Executive summary', format: 'pdf', created_at: iso(lastMonthly.getTime() + runs.length * 9_000), trigger: 'schedule', schedule_id: monthly.id, client_id: client.id, user_id: avery.id, user_name: avery.name, parameters: { client_id: client.id }, emailed_to: ['reports@lumen-it.example', `office@${client.slug}.example`] }))
  }
  runs.push(run({ type: 'patch_compliance', title: 'Patch compliance', format: 'pdf', created_at: iso(lastMonday.getTime()), trigger: 'schedule', schedule_id: weekly.id, user_id: jordan.id, user_name: jordan.name, emailed_to: ['ops@lumen-it.example', sam.email] }))
  runs.push(run({ type: 'patch_compliance', title: 'Patch compliance', format: 'pdf', created_at: iso(lastMonday.getTime() - 7 * DAY), trigger: 'schedule', schedule_id: weekly.id, user_id: jordan.id, user_name: jordan.name, emailed_to: ['ops@lumen-it.example', sam.email] }))
  runs.push(run({ type: 'hardware_inventory', title: 'Hardware inventory', format: 'csv', created_at: iso(now - 48 * DAY), trigger: 'schedule', schedule_id: quarterly.id, client_id: summit.id, parameters: { client_id: summit.id }, status: 'failed', error: 'SMTP server refused the recipient it@summitfreight.example (550 5.1.1 user unknown)' }))
  runs.push(run({ type: 'security_posture', title: 'Security posture', format: 'pdf', created_at: iso(now - 3 * DAY - 2 * HOUR), client_id: northwind.id, parameters: { client_id: northwind.id, from: iso(now - 33 * DAY), to: iso(now - 3 * DAY) } }))
  runs.push(run({ type: 'alert_history', title: 'Alert history', format: 'csv', created_at: iso(now - 5 * DAY), user_id: sam.id, user_name: sam.name, parameters: { client_id: 'all', severity: 'critical', from: iso(now - 35 * DAY), to: iso(now - 5 * DAY) } }))
  runs.push(run({ type: 'executive_summary', title: 'Executive summary', format: 'json', created_at: iso(now - 26 * HOUR), client_id: summit.id, parameters: { client_id: summit.id } }))
  runs.push(run({ type: 'software_inventory', title: 'Software inventory', format: 'csv', created_at: iso(now - 9 * DAY), user_id: jordan.id, user_name: jordan.name, parameters: { client_id: 'all', products: ['Microsoft 365 Apps for enterprise', '7-Zip'] } }))
  runs.push(run({ type: 'tickets_time', title: 'Tickets and time', format: 'pdf', created_at: iso(now - 34 * DAY), parameters: { client_id: 'all' } }))
  state.reportRuns = runs.sort((a, b) => b.created_at.localeCompare(a.created_at))

  // ---------------------------------------------------------------- SSO
  state.ssoProviders = [
    {
      id: id(),
      name: 'Microsoft Entra ID',
      issuer_url: 'https://login.microsoftonline.com/4f9c2a17-8b3e-4d6a-9f21-7c0e5d3b1a42/v2.0',
      client_id: '9a7d4e2c-1b6f-4c8a-8e3d-5f2a0b7c6d91',
      client_secret: 'mock-entra-secret',
      scopes: ['openid', 'email', 'profile'],
      group_claim: 'groups',
      role_mappings: [
        { group: 'RMM-Admins', role_id: role('Administrator').id, scope_type: 'global', scope_id: null },
        { group: 'RMM-Technicians', role_id: role('Technician').id, scope_type: 'global', scope_id: null },
        { group: 'Summit-OnSite', role_id: role('Technician').id, scope_type: 'client', scope_id: summit.id },
        { group: 'RMM-HelpDesk', role_id: role('Help Desk').id, scope_type: 'global', scope_id: null },
      ],
      auto_provision: true,
      require_local_mfa: false,
      trust_unverified_email: true,
      enabled: true,
      button_label: 'Sign in with Microsoft',
      created_at: iso(now - 90 * DAY),
      updated_at: iso(now - 14 * DAY),
    },
    {
      id: id(),
      name: 'Keycloak (lab)',
      issuer_url: 'http://127.0.0.1:8080/realms/rmm',
      client_id: 'rustrmm-console',
      client_secret: null,
      scopes: ['openid', 'email', 'profile', 'roles'],
      group_claim: 'realm_access.roles',
      role_mappings: [{ group: 'rmm-auditor', role_id: role('Auditor').id, scope_type: 'global', scope_id: null }],
      auto_provision: false,
      require_local_mfa: true,
      trust_unverified_email: false,
      enabled: false,
      button_label: 'Sign in with Keycloak',
      created_at: iso(now - 30 * DAY),
      updated_at: iso(now - 30 * DAY),
    },
  ]

  // ---------------------------------------------------------------- API tokens
  state.apiTokens = [
    {
      id: id(),
      name: 'PSA sync (HaloPSA)',
      prefix: 'rrmm_pat_Hq7Kx2',
      permissions: ['clients.view', 'tickets.view', 'tickets.manage'],
      client_ids: null,
      expires_at: iso(now + 61 * DAY),
      allowed_cidrs: ['203.0.113.0/24'],
      last_used_at: iso(now - 2 * HOUR),
      last_used_ip: '203.0.113.24',
      created_at: iso(now - 29 * DAY),
      user_id: avery.id,
      revoked_at: null,
      token_hash: 'seed',
    },
    {
      id: id(),
      name: 'Grafana read-only',
      prefix: 'rrmm_pat_bW3n9Q',
      permissions: ['devices.view', 'alerts.view'],
      client_ids: null,
      expires_at: iso(now - 10 * DAY),
      allowed_cidrs: null,
      last_used_at: iso(now - 11 * DAY),
      last_used_ip: '10.20.0.55',
      created_at: iso(now - 100 * DAY),
      user_id: avery.id,
      revoked_at: null,
      token_hash: 'seed',
    },
    {
      id: id(),
      name: 'Nightly asset export',
      prefix: 'rrmm_pat_Zt0pLm',
      permissions: ['devices.view', 'software.view'],
      client_ids: [summit.id],
      expires_at: iso(now + 200 * DAY),
      allowed_cidrs: ['10.20.0.0/16', '2001:db8:42::/48'],
      last_used_at: iso(now - 7 * HOUR),
      last_used_ip: '10.20.4.17',
      created_at: iso(now - 45 * DAY),
      user_id: jordan.id,
      revoked_at: null,
      token_hash: 'seed',
    },
  ]

  // ---------------------------------------------------------------- webhooks
  const psa = { id: id(), name: 'PSA ticket bridge', url: 'https://psa.lumen-it.example/hooks/rustrmm', secret: 'whsec_mock_psa_bridge_0123456789', events: ['ticket.created', 'ticket.updated', 'alert.opened'] as WebhookEvent[], client_ids: null, enabled: true, created_at: iso(now - 60 * DAY), updated_at: iso(now - 8 * DAY) }
  const slack = { id: id(), name: 'NOC chat relay', url: 'https://relay.noc-chat.example/rmm', secret: 'whsec_mock_noc_relay_0123456789ab', events: ['alert.opened', 'alert.resolved', 'device.offline'] as WebhookEvent[], client_ids: null, enabled: true, created_at: iso(now - 33 * DAY), updated_at: iso(now - 33 * DAY) }
  const siem = { id: id(), name: `${summit.name} SIEM`, url: 'http://siem.summitfreight.example:8088/ingest/rustrmm', secret: 'whsec_mock_summit_siem_0123456789', events: ['secret.revealed', 'device.enrolled'] as WebhookEvent[], client_ids: [summit.id], enabled: false, created_at: iso(now - 20 * DAY), updated_at: iso(now - 4 * DAY) }
  state.webhooks = [psa, slack, siem]
  const deliveries: WebhookDelivery[] = []
  const delivery = (webhookId: string, event: string, at: number, outcome: 'delivered' | 'failed' | 'retrying', data: unknown, response: number | null, error: string | null, attempts = 1): WebhookDelivery => {
    const eventId = `evt_${id().replace(/-/g, '').slice(0, 20)}`
    return {
      id: id(),
      webhook_id: webhookId,
      event_id: eventId,
      event,
      status: outcome === 'retrying' ? 'pending' : outcome,
      attempts,
      next_attempt_at: outcome === 'retrying' ? iso(now + 9 * 60_000) : null,
      last_attempt_at: iso(at + (attempts - 1) * 2 * 60_000),
      response_status: response,
      error,
      redelivery_of: null,
      created_at: iso(at),
      delivered_at: outcome === 'delivered' ? iso(at + (attempts - 1) * 2 * 60_000 + 340) : null,
      payload: { id: eventId, event, created_at: iso(at), data },
    }
  }
  const ticketData = (number: number, subject: string, client: Client) => ({ ticket: { id: id(), number, subject, status: 'new', priority: 'normal', client_id: client.id, client_name: client.name } })
  for (let index = 0; index < 9; index += 1) {
    const at = now - (index * 7 + 3) * HOUR
    const client = clients[index % clients.length]
    deliveries.push(
      index % 3 === 2
        ? delivery(psa.id, 'ticket.updated', at, 'delivered', { ticket_id: id(), changes: { status: { from: 'new', to: 'open' } } }, 200, null)
        : delivery(psa.id, 'ticket.created', at, 'delivered', ticketData(1180 - index, ['Printer offline in reception', 'Outlook keeps asking for password', 'New starter laptop', 'VPN drops every hour'][index % 4], client), index === 4 ? 202 : 200, null),
    )
  }
  deliveries.push(delivery(slack.id, 'alert.opened', now - 25 * 60_000, 'retrying', { alert: { id: id(), title: 'Disk C: above 90%', severity: 'warning', hostname: 'SFR-DOCK4-WS02', client_name: summit.name } }, 503, 'Receiver answered 503 Service Unavailable', 3))
  deliveries.push(
    delivery(
      slack.id,
      'device.offline',
      now - 3 * HOUR,
      'delivered',
      { device_id: id(), hostname: 'CRV-MOBILE-LT', client_id: clients[4].id, site_id: id(), last_seen_at: iso(now - 3 * HOUR - 15 * 60_000), reason: 'connection_lost', offline_minutes: 15 },
      200,
      null,
      2,
    ),
  )
  deliveries.push(delivery(slack.id, 'alert.resolved', now - 5 * HOUR, 'delivered', { alert: { id: id(), title: 'Service Spooler stopped', severity: 'critical', hostname: 'HPL-DT-RECEPT', client_name: clients[1].name } }, 200, null))
  deliveries.push(delivery(slack.id, 'alert.opened', now - 30 * HOUR, 'failed', { alert: { id: id(), title: 'Agent offline for 1 hour', severity: 'critical', hostname: 'MCU-LKV-ATM01', client_name: clients[6].name } }, null, 'Connection timed out after 10 s', 9))
  deliveries.push(delivery(siem.id, 'secret.revealed', now - 4 * DAY, 'failed', { item_id: id(), kind: 'bitlocker', identifier: 'C:', hostname: 'SFR-HQ-ACCT01', client_id: summit.id, revealed_by: { id: jordan.id, name: jordan.name }, reason: 'User locked out after BIOS update', at: iso(now - 4 * DAY) }, null, 'Connection refused (siem.summitfreight.example:8088)', 9))
  state.deliveries = deliveries.sort((a, b) => b.created_at.localeCompare(a.created_at))

  // ---------------------------------------------------------------- branding
  const logoBytes = new TextEncoder().encode(NORTHWIND_LOGO)
  const logoId = id().replace(/-/g, '')
  state.brandingFiles = [{ id: logoId, content_type: 'image/svg+xml', size_bytes: logoBytes.length, width: 64, height: 64, sanitized: false, created_at: iso(now - 50 * DAY), data: bytesToBase64(logoBytes) }]
  northwind.logo_url = `/api/v1/branding/files/${logoId}`

  state.signing = seedSigning(now)
  return state
}

/**
 * The signing status of the newest imported release: Windows signed (exe + MSI), macOS with an
 * ad-hoc signature only (reported unsigned), Linux without minisign files.
 */
export function seedSigning(now: number): SigningStatus {
  const signer = {
    subject: 'C=US, ST=Oregon, L=Portland, O=Lumen IT Partners LLC, CN=Lumen IT Partners LLC',
    issuer: 'C=GB, O=Sectigo Limited, CN=Sectigo Public Code Signing CA R36',
    serial: '6f2a91c04be35d7e8a1f0c3349d2b7e5',
    thumbprint_sha1: '3F8A1C9D2E7B04A6F5C38D19E2B7A0C4D6E9F1B2',
    not_before: iso(now - 75 * DAY),
    not_after: iso(now + 290 * DAY),
  }
  return {
    source: 'release',
    version: '0.1.0',
    imported_at: iso(now - 3 * DAY),
    platforms: [
      {
        platform: 'windows-x86_64',
        status: 'signed',
        files: [
          { file: 'rustrmm-agent.exe', format: 'pe', status: 'signed', method: 'authenticode', signer, timestamped: true, digest_valid: true, detail: null },
          { file: 'rustrmm-agent-0.1.0-x64.msi', format: 'msi', status: 'signed', method: 'authenticode', signer, timestamped: true, digest_valid: null, detail: null },
        ],
      },
      {
        platform: 'macos-universal',
        status: 'unsigned',
        files: [{ file: 'rustrmm-agent', format: 'macho', status: 'unsigned', method: 'adhoc', signer: null, timestamped: null, digest_valid: null, detail: 'Ad-hoc signature (no signing identity)' }],
      },
      {
        platform: 'linux-x86_64',
        status: 'unsigned',
        files: [{ file: 'rustrmm-agent', format: 'elf', status: 'unsigned', method: null, signer: null, timestamped: null, digest_valid: null, detail: null }],
      },
      {
        platform: 'linux-aarch64',
        status: 'unsigned',
        files: [{ file: 'rustrmm-agent', format: 'elf', status: 'unsigned', method: null, signer: null, timestamped: null, digest_valid: null, detail: null }],
      },
    ],
  }
}
