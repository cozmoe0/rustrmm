/*
 * Builds Phase 11 reports from the mock fleet: the same `Section` model the server returns, plus the
 * CSV export (BOM, one block per section, formula-injection guard) and a tiny valid placeholder PDF.
 */
import type { Report, ReportCell, ReportColumn, ReportKpi, ReportParameters, ReportSection } from '@/lib/api/types'
import { OS_LABEL } from '@/lib/devices'
import { customValuesFor } from './automation-model'
import { db, isManaged } from './db'
import { deviceCpu, deviceRamGb, hashString, type MockDevice } from './devices'
import { patchFactsFor } from './patch-state'
import { explorerItems, softwareOf, normalizeName } from './software-model'
import { computeSla } from './tickets-state'

const DAY = 86_400_000
const ACTIVE_TICKET = ['new', 'open', 'pending', 'on_hold']

export const REPORT_TYPES: { type: string; name: string; description: string; permission: string; extra: [string, 'string' | 'array', string][] }[] = [
  { type: 'executive_summary', name: 'Executive summary', description: 'Fleet size and OS mix, health trend, alerts with MTTA/MTTR, patch compliance, tickets and SLA, security posture, top issues and recommendations', permission: 'devices.view', extra: [] },
  { type: 'hardware_inventory', name: 'Hardware inventory', description: 'Devices with model, serial, CPU, RAM, disks, warranty custom fields and age', permission: 'devices.view', extra: [] },
  { type: 'software_inventory', name: 'Software inventory', description: 'Products with versions and device counts; licence counts for selected products', permission: 'software.view', extra: [['products', 'array', 'Product names to count licences for']] },
  { type: 'patch_compliance', name: 'Patch compliance', description: 'Compliance per client and site, and the devices missing critical or important patches with their age', permission: 'patches.view', extra: [] },
  { type: 'alert_history', name: 'Alert history', description: 'Alerts over the period with severity, duration and resolution', permission: 'alerts.view', extra: [['severity', 'string', 'Only this severity: critical, warning or info']] },
  { type: 'security_posture', name: 'Security posture', description: 'Devices against the security checks (antivirus, firewall, encryption, local admins, UAC, SMBv1, auto-logon) with the failing items', permission: 'devices.view', extra: [] },
  { type: 'agent_status', name: 'Agent status', description: 'Agent versions, offline devices and devices pending approval', permission: 'devices.view', extra: [] },
  { type: 'tickets_time', name: 'Tickets and time', description: 'Tickets opened and resolved, SLA results, time logged by client and user, billable totals', permission: 'tickets.view', extra: [] },
  { type: 'audit', name: 'Audit log', description: 'The audit log for the period, with action and actor filters', permission: 'audit.view', extra: [['action', 'string', 'Action prefix, e.g. auth. or script.run'], ['actor', 'string', 'Actor id or part of the actor name']] },
]

export function reportTypeDef(type: string) {
  return REPORT_TYPES.find((item) => item.type === type)
}

const col = (key: string, label: string, format?: ReportColumn['format'], align?: 'left' | 'right'): ReportColumn => ({ key, label, ...(format ? { format } : {}), ...(align ? { align } : {}) })
const kpi = (label: string, value: number | string | null, unit?: string, tone?: ReportKpi['tone']): ReportKpi => ({ label, value, ...(unit ? { unit } : {}), ...(tone ? { tone } : {}) })
const pct = (part: number, total: number) => (total === 0 ? null : Math.round((part * 1000) / total) / 10)
const avg = (values: number[]) => (values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null)
const toneFor = (value: number | null, good: number, warn: number, higherIsBetter = true): ReportKpi['tone'] => {
  if (value === null) return 'neutral'
  if (higherIsBetter) return value >= good ? 'good' : value >= warn ? 'warn' : 'bad'
  return value <= good ? 'good' : value <= warn ? 'warn' : 'bad'
}

interface Scope {
  clientId: string | null
  siteId: string | null
  from: number
  to: number
}

function scopeOf(params: ReportParameters, now: number): Scope {
  const to = params.to ? new Date(params.to).getTime() : now
  const from = params.from ? new Date(params.from).getTime() : to - 30 * DAY
  return { clientId: params.client_id && params.client_id !== 'all' ? params.client_id : null, siteId: params.site_id ?? null, from, to }
}

function inScope(item: { client_id: string; site_id?: string | null }, scope: Scope) {
  return (!scope.clientId || item.client_id === scope.clientId) && (!scope.siteId || item.site_id === scope.siteId)
}

function devicesIn(scope: Scope) {
  return db.devices.filter((device) => isManaged(device) && inScope(device, scope))
}

function osLabel(device: MockDevice) {
  if (device.os_family === 'windows') return /server/i.test(device.os_name) ? 'Windows Server' : device.os_name.replace(/^Microsoft /, '').replace(/ (Pro|Enterprise|Education|Home).*$/, '')
  return OS_LABEL[device.os_family]
}

// ------------------------------------------------------------------ security checks

const CHECKS = ['Antivirus', 'Firewall', 'Disk encryption', '≤ 2 local admins', 'UAC', 'SMBv1 off', 'No auto-logon'] as const

/** `Pass` / `Fail` / null (not applicable) for each check, deterministic per device. */
function securityRow(device: MockDevice): (string | null)[] {
  const bit = (salt: string, chance: number) => (hashString(`${device.id}:${salt}`) % 1000) / 1000 < chance
  const windows = device.os_family === 'windows'
  return [
    device.sim.avEnabled ? 'Pass' : 'Fail',
    device.sim.firewall ? 'Pass' : 'Fail',
    device.sim.encrypted ? 'Pass' : 'Fail',
    device.sim.extraAdmin ? 'Fail' : 'Pass',
    windows ? (bit('uac', 0.06) ? 'Fail' : 'Pass') : null,
    windows ? (bit('smb1', 0.08) ? 'Fail' : 'Pass') : null,
    bit('autologon', 0.04) ? 'Fail' : 'Pass',
  ]
}

function passRates(devices: MockDevice[]): { check: string; pass: number; fail: number; rate: number | null }[] {
  return CHECKS.map((check, index) => {
    let pass = 0
    let fail = 0
    for (const device of devices) {
      const value = securityRow(device)[index]
      if (value === 'Pass') pass += 1
      else if (value === 'Fail') fail += 1
    }
    return { check, pass, fail, rate: pct(pass, pass + fail) }
  })
}

// ------------------------------------------------------------------ builders

function alertsIn(scope: Scope) {
  return db.monitoring.alerts.filter((alert) => inScope(alert, scope) && new Date(alert.opened_at).getTime() >= scope.from && new Date(alert.opened_at).getTime() <= scope.to)
}

function mtta(alerts: typeof db.monitoring.alerts) {
  return avg(alerts.filter((alert) => alert.acknowledged_at).map((alert) => (new Date(alert.acknowledged_at!).getTime() - new Date(alert.opened_at).getTime()) / 60_000))
}

function mttr(alerts: typeof db.monitoring.alerts) {
  return avg(alerts.filter((alert) => alert.resolved_at).map((alert) => (new Date(alert.resolved_at!).getTime() - new Date(alert.opened_at).getTime()) / 60_000))
}

function dayLabels(scope: Scope, max = 31): { label: string; start: number }[] {
  const days = Math.max(1, Math.min(max, Math.ceil((scope.to - scope.from) / DAY)))
  const step = (scope.to - scope.from) / days
  return Array.from({ length: days }, (_, index) => {
    const start = scope.from + index * step
    return { label: new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date(start)), start }
  })
}

function ticketsIn(scope: Scope) {
  return db.tickets.tickets.filter((ticket) => inScope(ticket, scope) && !ticket.merged_into_id)
}

function executiveSummary(scope: Scope, now: number): ReportSection[] {
  const devices = devicesIn(scope)
  const online = devices.filter((device) => device.online).length
  const health = avg(devices.map((device) => device.health_score).filter((score): score is number => score !== null))
  const facts = patchFactsFor(devices, now)
  const scanned = [...facts.values()].filter((fact) => fact.scanned)
  const compliant = scanned.filter((fact) => fact.compliant).length
  const compliance = pct(compliant, scanned.length)
  const alerts = alertsIn(scope)
  const openCritical = db.monitoring.alerts.filter((alert) => inScope(alert, scope) && alert.status !== 'resolved' && alert.severity === 'critical').length
  const tickets = ticketsIn(scope)
  const opened = tickets.filter((ticket) => new Date(ticket.created_at).getTime() >= scope.from).length
  const resolvedTickets = tickets.filter((ticket) => ticket.resolved_at && new Date(ticket.resolved_at).getTime() >= scope.from)
  const withSla = resolvedTickets.map((ticket) => computeSla(db.tickets, ticket, now)).filter(Boolean)
  const slaMet = pct(withSla.filter((sla) => !sla!.first_response_breached && !sla!.resolution_breached).length, withSla.length)
  const openTickets = tickets.filter((ticket) => ACTIVE_TICKET.includes(ticket.status)).length
  const rates = passRates(devices)
  const clientCount = new Set(devices.map((device) => device.client_id)).size

  const sections: ReportSection[] = [
    {
      kind: 'text',
      title: 'Summary',
      body: `This report covers ${devices.length} managed devices across ${clientCount} ${clientCount === 1 ? 'client' : 'clients'}. ${online} were online when it was generated and the average health score is ${health ?? 'not yet known'}.\n\nPatch compliance stands at ${compliance ?? '—'}% of scanned devices; ${alerts.length} alerts opened during the period and ${openCritical} critical ${openCritical === 1 ? 'alert remains' : 'alerts remain'} open.`,
    },
    {
      kind: 'kpis',
      title: 'Overview',
      items: [
        kpi('Devices', devices.length),
        kpi('Online', pct(online, devices.length), '%', toneFor(pct(online, devices.length), 90, 75)),
        kpi('Average health', health, undefined, toneFor(health, 85, 65)),
        kpi('Patch compliance', compliance, '%', toneFor(compliance, 90, 75)),
        kpi('Alerts (period)', alerts.length),
        kpi('Open critical alerts', openCritical, undefined, openCritical ? 'bad' : 'good'),
        kpi('MTTA', mtta(alerts), 'min'),
        kpi('MTTR', mttr(alerts), 'min'),
        kpi('Tickets opened', opened),
        kpi('Tickets resolved', resolvedTickets.length),
        kpi('SLA met', slaMet, '%', toneFor(slaMet, 95, 85)),
        kpi('Open tickets', openTickets),
      ],
    },
  ]
  const days = dayLabels(scope, 30)
  const base = health ?? 80
  sections.push({
    kind: 'chart',
    title: 'Health score trend',
    chart: 'line',
    labels: days.map((day) => day.label),
    series: [{ name: 'Average health score', values: days.map((day, index) => Math.max(0, Math.min(100, Math.round((base - 3 + (index / days.length) * 3 + Math.sin(index / 2.5) * 0.9 + ((hashString(day.label) % 3) - 1) * 0.3) * 10) / 10))) }],
  })
  const osCounts = new Map<string, number>()
  for (const device of devices) osCounts.set(osLabel(device), (osCounts.get(osLabel(device)) ?? 0) + 1)
  const osEntries = [...osCounts.entries()].sort((a, b) => b[1] - a[1])
  sections.push({ kind: 'chart', title: 'Operating systems', chart: 'donut', labels: osEntries.map(([os]) => os), series: [{ name: 'Devices', values: osEntries.map(([, count]) => count) }] })
  const sev = (severity: string) => alerts.filter((alert) => alert.severity === severity).length
  sections.push({
    kind: 'kpis',
    title: 'Alerts by severity',
    items: [
      kpi('Critical', sev('critical'), undefined, sev('critical') ? 'bad' : 'good'),
      kpi('Warning', sev('warning'), undefined, sev('warning') ? 'warn' : 'good'),
      kpi('Info', sev('info')),
      kpi('Open alerts now', db.monitoring.alerts.filter((alert) => inScope(alert, scope) && alert.status !== 'resolved').length),
    ],
  })
  const missingCritical = scanned.reduce((sum, fact) => sum + fact.missing_critical, 0)
  sections.push({
    kind: 'kpis',
    title: 'Patching',
    items: [
      kpi('Scanned devices', scanned.length),
      kpi('Compliant', compliant, undefined, 'good'),
      kpi('Missing critical', missingCritical, undefined, missingCritical ? 'bad' : 'good'),
      kpi('Missing important', scanned.reduce((sum, fact) => sum + fact.missing_important, 0)),
      kpi('Pending reboot', scanned.filter((fact) => fact.pending_reboot).length),
    ],
  })
  sections.push({
    kind: 'table',
    title: 'Security posture',
    columns: [col('check', 'Check'), col('passing', 'Passing', 'number'), col('failing', 'Failing', 'number'), col('rate', 'Pass rate', 'percent')],
    rows: rates.map((rate) => [rate.check, rate.pass, rate.fail, rate.rate]),
  })
  const issues = new Map<string, number>()
  for (const alert of alerts) issues.set(alert.title, (issues.get(alert.title) ?? 0) + alert.occurrences)
  sections.push({
    kind: 'table',
    title: 'Top issues',
    columns: [col('issue', 'Alert'), col('count', 'Occurrences', 'number')],
    rows: [...issues.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([issue, count]) => [issue, count]),
  })
  if (!scope.clientId) {
    const clientRows: ReportCell[][] = db.clients
      .map((client) => {
        const own = devices.filter((device) => device.client_id === client.id)
        if (!own.length) return null
        const ownScanned = own.map((device) => facts.get(device.id)).filter((fact) => fact?.scanned)
        return [
          client.name,
          own.length,
          pct(own.filter((device) => device.online).length, own.length),
          avg(own.map((device) => device.health_score).filter((score): score is number => score !== null)),
          pct(ownScanned.filter((fact) => fact!.compliant).length, ownScanned.length),
          db.monitoring.alerts.filter((alert) => alert.client_id === client.id && alert.status !== 'resolved').length,
          tickets.filter((ticket) => ticket.client_id === client.id && ACTIVE_TICKET.includes(ticket.status)).length,
        ] as ReportCell[]
      })
      .filter((row): row is ReportCell[] => row !== null)
    sections.push({
      kind: 'table',
      title: 'Clients',
      columns: [col('client', 'Client'), col('devices', 'Devices', 'number'), col('online', 'Online', 'percent'), col('health', 'Health', 'number'), col('compliance', 'Patch compliance', 'percent'), col('alerts', 'Open alerts', 'number'), col('tickets', 'Open tickets', 'number')],
      rows: clientRows,
    })
  }
  const recommendations: string[] = []
  if (compliance !== null && compliance < 90) recommendations.push(`Patch compliance is ${compliance}%: review the updates waiting for approval and widen the maintenance windows.`)
  if (missingCritical > 0) recommendations.push(`${missingCritical} critical updates are missing; approve and install them in the next window.`)
  const av = rates[0]
  if (av.fail > 0) recommendations.push(`${av.fail} ${av.fail === 1 ? 'device has' : 'devices have'} antivirus missing, disabled or out of date.`)
  if (rates[2].fail > 0) recommendations.push(`${rates[2].fail} system drives are not encrypted; enable BitLocker or FileVault.`)
  if (rates[1].fail > 0) recommendations.push(`The firewall is disabled on ${rates[1].fail} ${rates[1].fail === 1 ? 'device' : 'devices'}.`)
  if (openCritical > 0) recommendations.push(`${openCritical} critical ${openCritical === 1 ? 'alert is' : 'alerts are'} still open.`)
  if (slaMet !== null && slaMet < 90) recommendations.push(`Only ${slaMet}% of resolved tickets met their SLA.`)
  const longOffline = devices.filter((device) => !device.online && device.last_seen_at && now - new Date(device.last_seen_at).getTime() > 7 * DAY).length
  if (longOffline) recommendations.push(`${longOffline} ${longOffline === 1 ? 'device has' : 'devices have'} been offline for more than a week.`)
  const fullDisks = devices.filter((device) => (device.disk_pct ?? 0) > 90).length
  if (fullDisks) recommendations.push(`${fullDisks} ${fullDisks === 1 ? 'disk is' : 'disks are'} more than 90% full.`)
  const outdated = devices.filter((device) => device.agent_version !== latestAgent()).length
  if (outdated) recommendations.push(`${outdated} agents are outdated; they update at their next check-in.`)
  sections.push({ kind: 'list', title: 'Recommendations', items: recommendations.length ? recommendations : ['No action needed: every check is within its target.'] })
  return sections
}

export function latestAgent() {
  return db.devices.map((device) => device.agent_version).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1) ?? '0.1.0'
}

function hardwareInventory(scope: Scope, now: number): ReportSection[] {
  const devices = devicesIn(scope)
  const rows: ReportCell[][] = devices
    .map((device) => {
      const ram = deviceRamGb(device)
      const age = Math.round(((now - new Date(device.enrolled_at).getTime()) / (365 * DAY) + (hashString(device.id) % 30) / 10) * 10) / 10
      const fields = customValuesFor(db.automation, 'device', device.id)
      const warranty = typeof fields.warranty_end === 'string' ? fields.warranty_end : null
      const disk = device.device_type === 'server' ? 1_920_383_410_176 : device.device_type === 'virtual' ? 137_438_953_472 : 512_110_190_592
      return [device.display_name ?? device.hostname, device.client_name, device.site_name, device.manufacturer, device.model, device.serial, deviceCpu(device), ram, disk, device.os_name, age, warranty] as ReportCell[]
    })
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  const ages = rows.map((row) => Number(row[10])).filter(Number.isFinite)
  const ramTotal = rows.reduce((sum, row) => sum + (Number(row[7]) || 0), 0)
  return [
    {
      kind: 'kpis',
      title: 'Summary',
      items: [
        kpi('Devices', rows.length),
        kpi('Average age', ages.length ? Math.round((ages.reduce((sum, value) => sum + value, 0) / ages.length) * 10) / 10 : null, 'years'),
        kpi('5 years or older', ages.filter((age) => age >= 5).length, undefined, ages.some((age) => age >= 5) ? 'warn' : 'good'),
        kpi('Total RAM', ramTotal, 'GB'),
      ],
    },
    {
      kind: 'table',
      title: 'Devices',
      columns: [col('hostname', 'Device'), col('client', 'Client'), col('site', 'Site'), col('manufacturer', 'Manufacturer'), col('model', 'Model'), col('serial', 'Serial'), col('cpu', 'CPU'), col('ram_gb', 'RAM (GB)', 'number'), col('disk_total', 'Disk', 'bytes'), col('os', 'OS'), col('age_years', 'Age (years)', 'number'), col('warranty', 'Warranty', 'date')],
      rows,
    },
  ]
}

function softwareInventory(scope: Scope, params: ReportParameters): ReportSection[] {
  const world = { automation: db.automation, devices: db.devices, clients: db.clients, sites: db.sites }
  const items = explorerItems(world, { client_id: scope.clientId })
  const devices = devicesIn(scope)
  const sections: ReportSection[] = [
    { kind: 'kpis', title: 'Summary', items: [kpi('Devices', devices.length), kpi('Products', items.length)] },
    {
      kind: 'table',
      title: 'Products',
      columns: [col('name', 'Product'), col('publisher', 'Publisher'), col('versions', 'Versions', 'number'), col('latest', 'Latest version'), col('devices', 'Devices', 'number')],
      rows: items.slice(0, 400).map((item) => [item.name, item.publisher, item.versions, item.latest_version, item.devices]),
      ...(items.length > 400 ? { total_rows: items.length } : {}),
    },
  ]
  const products = params.products ?? []
  if (products.length) {
    const rows: ReportCell[][] = []
    for (const product of products) {
      const wanted = normalizeName(product)
      for (const client of db.clients) {
        const count = devices.filter((device) => device.client_id === client.id && softwareOf(device).some((item) => normalizeName(item.name) === wanted)).length
        if (count) rows.push([product, client.name, count])
      }
    }
    sections.push({ kind: 'table', title: 'Licence count', columns: [col('product', 'Product'), col('client', 'Client'), col('devices', 'Devices', 'number')], rows })
  }
  return sections
}

function patchCompliance(scope: Scope, now: number): ReportSection[] {
  const devices = devicesIn(scope)
  const facts = patchFactsFor(devices, now)
  const scanned = devices.filter((device) => facts.get(device.id)?.scanned)
  const compliant = scanned.filter((device) => facts.get(device.id)!.compliant).length
  const rate = pct(compliant, scanned.length)
  const critical = scanned.reduce((sum, device) => sum + facts.get(device.id)!.missing_critical, 0)
  const groups = new Map<string, { client: string; site: string; devices: number; compliant: number }>()
  for (const device of scanned) {
    const key = device.site_id
    const entry = groups.get(key) ?? { client: device.client_name, site: device.site_name, devices: 0, compliant: 0 }
    entry.devices += 1
    if (facts.get(device.id)!.compliant) entry.compliant += 1
    groups.set(key, entry)
  }
  const missing = scanned
    .filter((device) => facts.get(device.id)!.missing_critical + facts.get(device.id)!.missing_important > 0 || facts.get(device.id)!.failed)
    .map((device) => {
      const fact = facts.get(device.id)!
      return [device.display_name ?? device.hostname, device.client_name, device.site_name, fact.missing_critical, fact.missing_important, fact.oldest_missing_days, fact.failed ? 1 : 0] as ReportCell[]
    })
    .sort((a, b) => Number(b[3]) - Number(a[3]) || Number(b[5] ?? 0) - Number(a[5] ?? 0))
  return [
    {
      kind: 'kpis',
      title: 'Summary',
      items: [
        kpi('Scanned devices', scanned.length),
        kpi('Compliance', rate, '%', toneFor(rate, 90, 75)),
        kpi('Missing critical', critical, undefined, critical ? 'bad' : 'good'),
        kpi('Missing important', scanned.reduce((sum, device) => sum + facts.get(device.id)!.missing_important, 0)),
        kpi('Pending reboot', scanned.filter((device) => facts.get(device.id)!.pending_reboot).length),
      ],
    },
    {
      kind: 'table',
      title: 'Compliance by client and site',
      columns: [col('client', 'Client'), col('site', 'Site'), col('devices', 'Devices', 'number'), col('compliant', 'Compliant', 'number'), col('rate', 'Compliance', 'percent')],
      rows: [...groups.values()].sort((a, b) => a.client.localeCompare(b.client) || a.site.localeCompare(b.site)).map((group) => [group.client, group.site, group.devices, group.compliant, pct(group.compliant, group.devices)]),
    },
    {
      kind: 'table',
      title: 'Devices missing critical or important updates',
      columns: [col('hostname', 'Device'), col('client', 'Client'), col('site', 'Site'), col('critical', 'Critical', 'number'), col('important', 'Important', 'number'), col('oldest', 'Oldest (days)', 'number'), col('failed', 'Failed installs', 'number')],
      rows: missing,
    },
  ]
}

function alertHistory(scope: Scope, params: ReportParameters, now: number): ReportSection[] {
  const alerts = alertsIn(scope).filter((alert) => !params.severity || alert.severity === params.severity)
  const days = dayLabels(scope, 31)
  const severities = params.severity ? [params.severity] : ['critical', 'warning', 'info']
  const series = severities.map((severity) => ({
    name: severity[0].toUpperCase() + severity.slice(1),
    values: days.map((day, index) => {
      const end = days[index + 1]?.start ?? scope.to + 1
      return alerts.filter((alert) => alert.severity === severity && new Date(alert.opened_at).getTime() >= day.start && new Date(alert.opened_at).getTime() < end).length
    }),
  }))
  const sev = (severity: string) => alerts.filter((alert) => alert.severity === severity).length
  return [
    {
      kind: 'kpis',
      title: 'Summary',
      items: [
        kpi('Alerts', alerts.length),
        kpi('Critical', sev('critical'), undefined, sev('critical') ? 'bad' : 'good'),
        kpi('Warning', sev('warning'), undefined, sev('warning') ? 'warn' : 'good'),
        kpi('Info', sev('info')),
        kpi('MTTA', mtta(alerts), 'min'),
        kpi('MTTR', mttr(alerts), 'min'),
      ],
    },
    { kind: 'chart', title: 'Alerts per day', chart: 'bar', labels: days.map((day) => day.label), series },
    {
      kind: 'table',
      title: 'Alerts',
      columns: [col('opened_at', 'Opened', 'datetime'), col('device', 'Device'), col('client', 'Client'), col('severity', 'Severity'), col('title', 'Alert'), col('status', 'Status'), col('duration', 'Duration', 'duration'), col('resolution', 'Resolution')],
      rows: [...alerts]
        .sort((a, b) => b.opened_at.localeCompare(a.opened_at))
        .map((alert) => [
          alert.opened_at,
          alert.hostname,
          alert.client_name,
          alert.severity,
          alert.title,
          alert.status,
          Math.round(((alert.resolved_at ? new Date(alert.resolved_at).getTime() : now) - new Date(alert.opened_at).getTime()) / 60_000),
          alert.resolution ?? null,
        ]),
    },
  ]
}

function securityPosture(scope: Scope): ReportSection[] {
  const devices = devicesIn(scope)
  const rates = passRates(devices)
  const rows = devices.map((device) => {
    const row = securityRow(device)
    const failing = CHECKS.filter((_, index) => row[index] === 'Fail')
    return [device.display_name ?? device.hostname, device.client_name, ...row, failing.join(', ') || null] as ReportCell[]
  })
  const allPass = rows.filter((row) => row[9] === null).length
  return [
    {
      kind: 'kpis',
      title: 'Summary',
      items: [kpi('Devices', devices.length), kpi('Passing every check', allPass, undefined, 'good'), kpi('With failures', devices.length - allPass, undefined, devices.length - allPass ? 'warn' : 'good'), kpi('Encrypted', rates[2].rate, '%', toneFor(rates[2].rate, 95, 80))],
    },
    { kind: 'table', title: 'Pass rates', columns: [col('check', 'Check'), col('passing', 'Passing', 'number'), col('failing', 'Failing', 'number'), col('rate', 'Pass rate', 'percent')], rows: rates.map((rate) => [rate.check, rate.pass, rate.fail, rate.rate]) },
    {
      kind: 'table',
      title: 'Devices',
      columns: [col('hostname', 'Device'), col('client', 'Client'), col('antivirus', 'AV'), col('firewall', 'Firewall'), col('encryption', 'Encryption'), col('local_admins', 'Admins'), col('uac', 'UAC'), col('smb1', 'SMBv1 off'), col('autologon', 'No auto-logon'), col('failing', 'Failing items')],
      rows: rows.sort((a, b) => (a[9] === null ? 1 : 0) - (b[9] === null ? 1 : 0) || String(a[0]).localeCompare(String(b[0]))),
    },
  ]
}

function agentStatus(scope: Scope, now: number): ReportSection[] {
  const active = devicesIn(scope)
  const offline = active.filter((device) => !device.online)
  const pending = db.devices.filter((device) => device.status === 'pending' && inScope(device, scope))
  const latest = latestAgent()
  const versions = new Map<string, number>()
  for (const device of active) versions.set(device.agent_version, (versions.get(device.agent_version) ?? 0) + 1)
  const outdated = active.filter((device) => device.agent_version !== latest).length
  return [
    {
      kind: 'kpis',
      title: 'Summary',
      items: [kpi('Active agents', active.length), kpi('Online', active.length - offline.length, undefined, 'good'), kpi('Offline', offline.length, undefined, offline.length ? 'warn' : 'good'), kpi('Pending approval', pending.length, undefined, pending.length ? 'warn' : 'neutral'), kpi('Outdated', outdated, undefined, outdated ? 'warn' : 'good')],
    },
    {
      kind: 'table',
      title: 'Versions',
      columns: [col('version', 'Version'), col('devices', 'Devices', 'number'), col('current', 'Current')],
      rows: [...versions.entries()].sort((a, b) => b[0].localeCompare(a[0], undefined, { numeric: true })).map(([version, count]) => [version, count, version === latest ? 'Yes' : null]),
    },
    {
      kind: 'table',
      title: 'Offline devices',
      columns: [col('hostname', 'Device'), col('client', 'Client'), col('site', 'Site'), col('last_seen', 'Last seen', 'datetime'), col('days', 'Days offline', 'number'), col('version', 'Agent')],
      rows: offline
        .map((device) => [device.display_name ?? device.hostname, device.client_name, device.site_name, device.last_seen_at, device.last_seen_at ? Math.floor((now - new Date(device.last_seen_at).getTime()) / DAY) : null, device.agent_version] as ReportCell[])
        .sort((a, b) => Number(b[4] ?? 0) - Number(a[4] ?? 0)),
    },
    {
      kind: 'table',
      title: 'Pending approval',
      columns: [col('hostname', 'Device'), col('client', 'Client'), col('site', 'Site'), col('enrolled', 'Enrolled', 'datetime'), col('os', 'OS')],
      rows: pending.map((device) => [device.hostname, device.client_name, device.site_name, device.enrolled_at, device.os_name]),
    },
  ]
}

function ticketsTime(scope: Scope, now: number): ReportSection[] {
  const tickets = ticketsIn(scope)
  const opened = tickets.filter((ticket) => new Date(ticket.created_at).getTime() >= scope.from && new Date(ticket.created_at).getTime() <= scope.to)
  const resolved = tickets.filter((ticket) => ticket.resolved_at && new Date(ticket.resolved_at).getTime() >= scope.from && new Date(ticket.resolved_at).getTime() <= scope.to)
  const slas = resolved.map((ticket) => ({ ticket, sla: computeSla(db.tickets, ticket, now) })).filter((entry) => entry.sla)
  const met = slas.filter((entry) => !entry.sla!.first_response_breached && !entry.sla!.resolution_breached)
  const ticketIds = new Set(tickets.map((ticket) => ticket.id))
  const entries = db.tickets.time.filter((entry) => ticketIds.has(entry.ticket_id) && new Date(entry.started_at).getTime() >= scope.from && new Date(entry.started_at).getTime() <= scope.to)
  const hours = (minutes: number) => Math.round((minutes / 60) * 10) / 10
  const minutes = entries.reduce((sum, entry) => sum + entry.minutes, 0)
  const billable = entries.filter((entry) => entry.billable).reduce((sum, entry) => sum + entry.minutes, 0)
  const ticketClient = new Map(tickets.map((ticket) => [ticket.id, ticket.client_id]))
  const byClient: ReportCell[][] = db.clients
    .filter((client) => !scope.clientId || client.id === scope.clientId)
    .map((client) => {
      const own = (list: typeof tickets) => list.filter((ticket) => ticket.client_id === client.id)
      const ownSla = slas.filter((entry) => entry.ticket.client_id === client.id)
      const ownEntries = entries.filter((entry) => ticketClient.get(entry.ticket_id) === client.id)
      return [
        client.name,
        own(opened).length,
        own(resolved).length,
        ownSla.filter((entry) => !entry.sla!.first_response_breached && !entry.sla!.resolution_breached).length,
        ownSla.filter((entry) => entry.sla!.first_response_breached || entry.sla!.resolution_breached).length,
        hours(ownEntries.reduce((sum, entry) => sum + entry.minutes, 0)),
        hours(ownEntries.filter((entry) => entry.billable).reduce((sum, entry) => sum + entry.minutes, 0)),
      ] as ReportCell[]
    })
    .filter((row) => row.slice(1).some((value) => Number(value) > 0))
  const users = new Map<string, { entries: number; minutes: number; billable: number }>()
  for (const entry of entries) {
    const user = users.get(entry.user_name) ?? { entries: 0, minutes: 0, billable: 0 }
    user.entries += 1
    user.minutes += entry.minutes
    if (entry.billable) user.billable += entry.minutes
    users.set(entry.user_name, user)
  }
  const slaPct = pct(met.length, slas.length)
  return [
    {
      kind: 'kpis',
      title: 'Summary',
      items: [kpi('Opened', opened.length), kpi('Resolved', resolved.length), kpi('SLA met', slaPct, '%', toneFor(slaPct, 95, 85)), kpi('Time logged', hours(minutes), 'h'), kpi('Billable', hours(billable), 'h')],
    },
    {
      kind: 'table',
      title: 'By client',
      columns: [col('client', 'Client'), col('opened', 'Opened', 'number'), col('resolved', 'Resolved', 'number'), col('within_sla', 'Within SLA', 'number'), col('breached', 'Breached', 'number'), col('hours', 'Hours', 'number'), col('billable', 'Billable hours', 'number')],
      rows: byClient,
    },
    {
      kind: 'table',
      title: 'Time per user',
      columns: [col('user', 'User'), col('entries', 'Entries', 'number'), col('hours', 'Hours', 'number'), col('billable', 'Billable hours', 'number')],
      rows: [...users.entries()].sort((a, b) => b[1].minutes - a[1].minutes).map(([user, value]) => [user, value.entries, hours(value.minutes), hours(value.billable)]),
    },
  ]
}

function auditLog(scope: Scope, params: ReportParameters): ReportSection[] {
  const actor = params.actor?.toLowerCase()
  const entries = [...db.audit]
    .reverse()
    .filter((event) => {
      const at = new Date(event.at).getTime()
      if (at < scope.from || at > scope.to) return false
      if (scope.clientId && event.client_id !== scope.clientId) return false
      if (params.action && !event.action.startsWith(params.action)) return false
      if (actor && event.actor.id !== params.actor && !(event.actor.name ?? '').toLowerCase().includes(actor)) return false
      return true
    })
  const counts = new Map<string, number>()
  for (const event of entries) counts.set(event.action, (counts.get(event.action) ?? 0) + 1)
  const clientName = new Map(db.clients.map((client) => [client.id, client.name]))
  const shown = entries.slice(0, 500)
  return [
    { kind: 'kpis', title: 'Summary', items: [kpi('Entries', entries.length), kpi('Distinct actions', counts.size)] },
    {
      kind: 'table',
      title: 'Most frequent actions',
      columns: [col('action', 'Action'), col('count', 'Entries', 'number')],
      rows: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([action, count]) => [action, count]),
    },
    {
      kind: 'table',
      title: 'Entries',
      columns: [col('at', 'Time', 'datetime'), col('actor', 'Actor'), col('action', 'Action'), col('target', 'Target'), col('client', 'Client'), col('ip', 'IP')],
      rows: shown.map((event) => [event.at, event.actor.name ?? event.actor.type, event.action, event.target?.name ?? null, event.client_id ? (clientName.get(event.client_id) ?? null) : null, event.ip]),
      ...(entries.length > shown.length ? { total_rows: entries.length } : {}),
    },
  ]
}

/** Builds a report; throws for an unknown type or client. */
export function buildReport(type: string, params: ReportParameters, now = Date.now()): Report {
  const def = reportTypeDef(type)
  if (!def) throw new Error(`Unknown report type ${type}`)
  const scope = scopeOf(params, now)
  const client = scope.clientId ? db.clients.find((item) => item.id === scope.clientId) : undefined
  const site = scope.siteId ? db.sites.find((item) => item.id === scope.siteId) : undefined
  const sections =
    type === 'executive_summary'
      ? executiveSummary(scope, now)
      : type === 'hardware_inventory'
        ? hardwareInventory(scope, now)
        : type === 'software_inventory'
          ? softwareInventory(scope, params)
          : type === 'patch_compliance'
            ? patchCompliance(scope, now)
            : type === 'alert_history'
              ? alertHistory(scope, params, now)
              : type === 'security_posture'
                ? securityPosture(scope)
                : type === 'agent_status'
                  ? agentStatus(scope, now)
                  : type === 'tickets_time'
                    ? ticketsTime(scope, now)
                    : auditLog(scope, params)
  const period = `${new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(scope.from))} – ${new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(scope.to))}`
  return {
    type,
    title: def.name,
    subtitle: [client?.name ?? 'All clients', site?.name, period].filter(Boolean).join(' · '),
    generated_at: new Date(now).toISOString(),
    period: { from: new Date(scope.from).toISOString(), to: new Date(scope.to).toISOString() },
    client: client ? { id: client.id, name: client.name } : null,
    sections,
  }
}

// ------------------------------------------------------------------ files

function csvCell(value: ReportCell): string {
  if (value === null || value === undefined) return ''
  let text = String(value)
  if (typeof value !== 'number' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`
  return text
}

/** Every section in order: a title row, then the rows; sections separated by a blank line. */
export function reportCsv(report: Report): string {
  const blocks = report.sections.map((section) => {
    const lines: string[] = [csvCell(section.title)]
    if (section.kind === 'kpis') {
      lines.push('Metric,Value,Unit')
      for (const item of section.items) lines.push([item.label, item.value, item.unit ?? ''].map((value) => csvCell(value as ReportCell)).join(','))
    } else if (section.kind === 'table') {
      lines.push(section.columns.map((column) => csvCell(column.label)).join(','))
      for (const row of section.rows) lines.push(row.map(csvCell).join(','))
    } else if (section.kind === 'chart') {
      lines.push(['Label', ...section.series.map((series) => series.name)].map(csvCell).join(','))
      section.labels.forEach((label, index) => lines.push([label, ...section.series.map((series) => series.values[index] ?? '')].map((value) => csvCell(value as ReportCell)).join(',')))
    } else if (section.kind === 'text') {
      lines.push(csvCell(section.body))
    } else {
      for (const item of section.items) lines.push(csvCell(item))
    }
    return lines.join('\r\n')
  })
  return `\uFEFF${blocks.join('\r\n\r\n')}\r\n`
}

/** A minimal one-page PDF (Helvetica, WinAnsi) carrying the title; byte offsets computed for a valid xref. */
export function placeholderPdf(report: Report): Uint8Array {
  const ascii = (text: string) => text.replace(/[^\x20-\x7e]/g, '?').replace(/[()\\]/g, (char) => `\\${char}`)
  const lines = [
    { size: 20, y: 760, text: report.title },
    { size: 11, y: 736, text: report.subtitle ?? '' },
    { size: 10, y: 700, text: `Generated ${report.generated_at.slice(0, 16).replace('T', ' ')} UTC by the RustRMM mock server.` },
    { size: 10, y: 684, text: 'The real server renders every section with the pdf-writer layout engine.' },
    ...report.sections.slice(0, 20).map((section, index) => ({ size: 10, y: 650 - index * 16, text: `- ${section.title} (${section.kind})` })),
  ]
  const content = lines.map((line) => `BT /F1 ${line.size} Tf 56 ${line.y} Td (${ascii(line.text)}) Tj ET`).join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(body.length)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(body)
}

export function reportFileName(report: Report, format: 'csv' | 'pdf' | 'json'): string {
  const slug = (value: string) => value.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const stamp = report.generated_at.slice(0, 16).replace(/[-:]/g, '').replace('T', '-')
  return `${report.type.replace(/_/g, '-')}${report.client ? `-${slug(report.client.name)}` : ''}-${stamp}.${format}`
}
