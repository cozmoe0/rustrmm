/* `GET /dashboards/widgets/{widget}?config=` aggregations over the mock fleet. */
import type { WidgetConfig, WidgetDataMap, WidgetName } from '@/lib/api/types'
import { OS_LABEL } from '@/lib/devices'
import { customValuesFor } from './automation-model'
import { db, isManaged } from './db'
import { publicAlert } from './monitoring-model'
import { patchFactsFor } from './patch-state'
import { latestAgent } from './report-builder'
import { computeSla } from './tickets-state'

const ACTIVE_TICKET = ['new', 'open', 'pending', 'on_hold']
const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 } as const
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 }

function matches(item: { client_id: string; site_id?: string | null }, config: WidgetConfig) {
  return (!config.client_id || item.client_id === config.client_id) && (!config.site_id || item.site_id === config.site_id)
}

export function widgetData<W extends WidgetName>(widget: W, config: WidgetConfig, now = Date.now()): WidgetDataMap[W] {
  const limit = Math.min(100, Math.max(1, config.limit ?? 10))
  const devices = db.devices.filter((device) => isManaged(device) && matches(device, config))
  const alerts = db.monitoring.alerts.filter((alert) => alert.status !== 'resolved' && matches(alert, config))
  const tickets = db.tickets.tickets.filter((ticket) => ACTIVE_TICKET.includes(ticket.status) && !ticket.merged_into_id && matches(ticket, config))
  const out = (() => {
    switch (widget) {
      case 'fleet_health': {
        const scores = devices.map((device) => device.health_score).filter((score): score is number => score !== null)
        const online = devices.filter((device) => device.online).length
        return {
          devices: devices.length,
          online,
          offline: devices.length - online,
          avg_health: scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : null,
          buckets: { healthy: scores.filter((score) => score >= 80).length, warning: scores.filter((score) => score >= 50 && score < 80).length, critical: scores.filter((score) => score < 50).length },
        }
      }
      case 'alerts_by_severity': {
        const open = alerts.filter((alert) => alert.status === 'open')
        return {
          total: alerts.length,
          open: { critical: open.filter((alert) => alert.severity === 'critical').length, warning: open.filter((alert) => alert.severity === 'warning').length, info: open.filter((alert) => alert.severity === 'info').length },
          acknowledged: alerts.filter((alert) => alert.status === 'acknowledged').length,
        }
      }
      case 'alerts_list':
        return {
          total: alerts.length,
          items: [...alerts]
            .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.opened_at.localeCompare(a.opened_at))
            .slice(0, limit)
            .map(publicAlert),
        }
      case 'patch_compliance': {
        const facts = [...patchFactsFor(devices, now).values()].filter((fact) => fact.scanned)
        const compliant = facts.filter((fact) => fact.compliant).length
        return {
          devices: facts.length,
          compliant,
          non_compliant: facts.length - compliant,
          compliance_pct: facts.length ? Math.round((compliant * 1000) / facts.length) / 10 : null,
          missing_critical: facts.reduce((sum, fact) => sum + fact.missing_critical, 0),
          missing_important: facts.reduce((sum, fact) => sum + fact.missing_important, 0),
          pending_reboot: facts.filter((fact) => fact.pending_reboot).length,
          failed: facts.filter((fact) => fact.failed).length,
        }
      }
      case 'tickets_open': {
        const by = (key: 'status' | 'priority') => tickets.reduce<Record<string, number>>((acc, ticket) => ({ ...acc, [ticket[key]]: (acc[ticket[key]] ?? 0) + 1 }), {})
        return { total: tickets.length, by_status: by('status'), by_priority: by('priority') }
      }
      case 'sla_breaches': {
        const breached = tickets
          .map((ticket) => ({ ticket, sla: computeSla(db.tickets, ticket, now) }))
          .filter((entry) => entry.sla && (entry.sla.first_response_breached || entry.sla.resolution_breached))
          .sort((a, b) => (PRIORITY_RANK[a.ticket.priority] ?? 9) - (PRIORITY_RANK[b.ticket.priority] ?? 9) || (a.sla!.resolution_due ?? '').localeCompare(b.sla!.resolution_due ?? ''))
        return {
          total: breached.length,
          items: breached.slice(0, limit).map(({ ticket, sla }) => ({
            id: ticket.id,
            number: ticket.number,
            subject: ticket.subject,
            client_id: ticket.client_id,
            status: ticket.status,
            priority: ticket.priority,
            first_response_breached: sla!.first_response_breached,
            resolution_breached: sla!.resolution_breached,
            resolution_due: sla!.resolution_due,
          })),
        }
      }
      case 'devices_offline': {
        const offline = devices.filter((device) => !device.online).sort((a, b) => (a.last_seen_at ?? '').localeCompare(b.last_seen_at ?? ''))
        return {
          total: offline.length,
          items: offline.slice(0, limit).map((device) => ({ device_id: device.id, hostname: device.display_name ?? device.hostname, client_id: device.client_id, client_name: device.client_name, last_seen_at: device.last_seen_at })),
        }
      }
      case 'os_mix': {
        const counts = new Map<string, { os: string; family: string; count: number }>()
        for (const device of devices) {
          const os = device.os_family === 'windows' ? (/server/i.test(device.os_name) ? 'Windows Server' : device.os_name.replace(/^Microsoft /, '').replace(/ (Pro|Enterprise|Education|Home).*$/, '')) : OS_LABEL[device.os_family]
          const entry = counts.get(os) ?? { os, family: device.os_family, count: 0 }
          entry.count += 1
          counts.set(os, entry)
        }
        return { items: [...counts.values()].sort((a, b) => b.count - a.count) }
      }
      case 'agent_versions': {
        const latest = latestAgent()
        const counts = new Map<string, number>()
        for (const device of devices) counts.set(device.agent_version, (counts.get(device.agent_version) ?? 0) + 1)
        return {
          latest,
          outdated: devices.filter((device) => device.agent_version !== latest).length,
          items: [...counts.entries()].sort((a, b) => b[0].localeCompare(a[0], undefined, { numeric: true })).map(([version, count]) => ({ version, count })),
        }
      }
      case 'top_disk_usage':
        return {
          items: devices
            .filter((device) => device.disk_pct !== null)
            .sort((a, b) => (b.disk_pct ?? 0) - (a.disk_pct ?? 0))
            .slice(0, limit)
            .map((device) => ({ device_id: device.id, hostname: device.display_name ?? device.hostname, client_name: device.client_name, disk_pct: Math.round(device.disk_pct ?? 0) })),
        }
      case 'recent_jobs': {
        const since = now - Math.min(90, Math.max(1, config.days ?? 7)) * 86_400_000
        const jobs = new Map(db.automation.jobs.map((job) => [job.id, job]))
        return {
          items: db.automation.runs
            .filter((run) => new Date(run.started_at).getTime() >= since && jobs.has(run.job_id) && !jobs.get(run.job_id)!.deleted)
            .filter((run) => {
              if (!config.client_id) return true
              const target = jobs.get(run.job_id)!.target
              if (target.type === 'client') return target.ids.includes(config.client_id)
              if (target.type === 'site') return target.ids.some((id) => db.sites.find((site) => site.id === id)?.client_id === config.client_id)
              if (target.type === 'devices') return target.ids.some((id) => db.devices.find((device) => device.id === id)?.client_id === config.client_id)
              return true
            })
            .sort((a, b) => b.started_at.localeCompare(a.started_at))
            .slice(0, limit)
            .map((run) => ({ run_id: run.id, job_id: run.job_id, name: jobs.get(run.job_id)!.name, status: run.status, started_at: run.started_at, finished_at: run.finished_at, counts: { ...run.counts } })),
        }
      }
      case 'custom_field_breakdown': {
        const field = db.automation.customFields.find((item) => item.scope === 'device' && item.key === config.field)
        const counts = new Map<string, number>()
        for (const device of devices) {
          const raw = config.field ? customValuesFor(db.automation, 'device', device.id)[config.field] : undefined
          const value = raw === undefined || raw === null || raw === '' ? '(not set)' : Array.isArray(raw) ? raw.join(', ') : String(raw)
          const bucket = field?.type === 'date' && value !== '(not set)' ? value.slice(0, 4) : value
          counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
        }
        return {
          field: config.field ?? '',
          field_name: field?.name ?? config.field ?? '',
          items: [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count).slice(0, limit),
        }
      }
    }
  })()
  return out as WidgetDataMap[W]
}

export const WIDGET_PERMISSION: Record<WidgetName, string> = {
  fleet_health: 'devices.view',
  alerts_by_severity: 'alerts.view',
  alerts_list: 'alerts.view',
  patch_compliance: 'patches.view',
  tickets_open: 'tickets.view',
  sla_breaches: 'tickets.view',
  devices_offline: 'devices.view',
  os_mix: 'devices.view',
  agent_versions: 'devices.view',
  top_disk_usage: 'devices.view',
  recent_jobs: 'scripts.view',
  custom_field_breakdown: 'devices.view',
}
