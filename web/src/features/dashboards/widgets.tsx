/* The twelve dashboard widgets, each rendering `GET /dashboards/widgets/{widget}` data for its frame size. */
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Pie, PieChart } from 'recharts'
import { ArrowUpRight, CircleCheck, Clock, OctagonAlert, RotateCw, ShieldCheck } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { ChartContainer, type ChartConfig } from '@/components/ui/chart'
import { HealthRing } from '@/components/common/health-ring'
import { OsIcon } from '@/components/common/os-icon'
import { widgetQuery } from '@/lib/api/queries'
import { errorMessage, isApiError } from '@/lib/api/errors'
import type { OsFamily, TicketPriority, TicketStatus, WidgetConfig, WidgetDataMap, WidgetName } from '@/lib/api/types'
import { formatNumber, formatRelative } from '@/lib/format'
import { shortAge } from '@/lib/monitoring/alerts'
import { ticketNumber } from '@/lib/tickets/labels'
import { cn } from '@/lib/utils'
import { UsageBar } from '@/features/devices/device-ui'
import { SeverityIcon } from '@/features/monitoring/monitoring-ui'
import { PriorityGlyph, TicketStatusBadge } from '@/features/tickets/ticket-ui'

export interface WidgetSize {
  w: number
  h: number
}

const PALETTE = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)']

function useWidget<W extends WidgetName>(widget: W, config: WidgetConfig) {
  return useQuery({ ...widgetQuery(widget, config), meta: { silent: true } })
}

function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="grid gap-2 p-4">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-7 rounded-md" />
      ))}
    </div>
  )
}

function Failure({ error }: { error: unknown }) {
  const forbidden = isApiError(error) && error.status === 403
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-4 py-6 text-center">
      <OctagonAlert className="size-5 text-subtle-foreground" />
      <p className="text-dense font-medium">{forbidden ? 'Not available to you' : 'Could not load'}</p>
      <p className="text-micro text-muted-foreground">{forbidden ? 'This widget needs a permission you don’t hold.' : errorMessage(error)}</p>
    </div>
  )
}

function Empty({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-full items-center gap-3 px-4 py-5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-live/12 text-live ring-1 ring-live/25 [&_svg]:size-4">{icon ?? <CircleCheck />}</span>
      <p className="text-dense text-muted-foreground">{children}</p>
    </div>
  )
}

function Body<W extends WidgetName>({ widget, config, rows, children }: { widget: W; config: WidgetConfig; rows?: number; children: (data: WidgetDataMap[W]) => ReactNode }) {
  const { data, error, isLoading } = useWidget(widget, config)
  if (error) return <Failure error={error} />
  if (isLoading || !data) return <Loading rows={rows} />
  return <>{children(data.data)}</>
}

/** A stacked share bar with an accessible text equivalent. */
function ShareBar({ parts, label }: { parts: { value: number; className: string; label: string }[]; label: string }) {
  const total = parts.reduce((sum, part) => sum + part.value, 0)
  return (
    <div role="img" aria-label={`${label}: ${parts.map((part) => `${part.label} ${part.value}`).join(', ')}`} className="flex h-2 w-full gap-px overflow-hidden rounded-full bg-surface-3">
      {total > 0 && parts.filter((part) => part.value > 0).map((part) => <span key={part.label} className={cn('h-full', part.className)} style={{ width: `${(part.value / total) * 100}%` }} />)}
    </div>
  )
}

function Stat({ label, value, tone, to, search }: { label: string; value: ReactNode; tone?: string; to?: string; search?: Record<string, unknown> }) {
  const inner = (
    <>
      <span className="truncate text-micro text-muted-foreground">{label}</span>
      <span className={cn('font-display tabular text-[19px] leading-tight font-semibold', tone)}>{value}</span>
    </>
  )
  return to ? (
    <Link to={to} search={search as never} className="grid min-w-0 gap-0.5 rounded-md px-1.5 py-1 outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring">
      {inner}
    </Link>
  ) : (
    <div className="grid min-w-0 gap-0.5 px-1.5 py-1">{inner}</div>
  )
}

function ListRow({ to, params, search, children }: { to: string; params?: Record<string, string>; search?: Record<string, unknown>; children: ReactNode }) {
  return (
    <li>
      <Link to={to} params={params as never} search={search as never} className="flex min-w-0 items-center gap-2.5 px-4 py-2 outline-none transition-colors hover:bg-surface-2 focus-visible:bg-surface-2">
        {children}
      </Link>
    </li>
  )
}

// ------------------------------------------------------------------ widgets

function FleetHealth({ config, size }: { config: WidgetConfig; size: WidgetSize }) {
  return (
    <Body widget="fleet_health" config={config}>
      {(data) => {
        const scope = config.client_id ? { client: config.client_id, site: config.site_id ?? undefined } : {}
        return (
          <div className="flex h-full flex-col justify-between gap-3 p-4">
            <div className="flex items-center gap-4">
              <HealthRing score={data.avg_health === null ? null : Math.round(data.avg_health)} size={size.h >= 3 ? 64 : 48} strokeWidth={5} label="Average health score" />
              <div className="grid min-w-0 flex-1 grid-cols-2 gap-1">
                <Stat label="Online" value={<span className="text-live">{formatNumber(data.online)}</span>} to="/devices" search={{ ...scope, state: 'online' }} />
                <Stat label="Offline" value={formatNumber(data.offline)} tone={data.offline ? 'text-warning' : undefined} to="/devices" search={{ ...scope, state: 'offline' }} />
              </div>
            </div>
            <div className="grid gap-1.5">
              <ShareBar
                label="Health bands"
                parts={[
                  { label: 'Healthy', value: data.buckets.healthy, className: 'bg-live' },
                  { label: 'Warning', value: data.buckets.warning, className: 'bg-warning' },
                  { label: 'Critical', value: data.buckets.critical, className: 'bg-critical' },
                ]}
              />
              <div className="tabular flex flex-wrap justify-between gap-x-3 text-micro text-muted-foreground">
                <span>
                  <span className="mr-1 inline-block size-1.5 rounded-full bg-live" />
                  {formatNumber(data.buckets.healthy)} healthy
                </span>
                <span>
                  <span className="mr-1 inline-block size-1.5 rounded-full bg-warning" />
                  {formatNumber(data.buckets.warning)} warning
                </span>
                <span>
                  <span className="mr-1 inline-block size-1.5 rounded-full bg-critical" />
                  {formatNumber(data.buckets.critical)} critical
                </span>
              </div>
            </div>
          </div>
        )
      }}
    </Body>
  )
}

function AlertsBySeverity({ config }: { config: WidgetConfig }) {
  return (
    <Body widget="alerts_by_severity" config={config}>
      {(data) => {
        const scope = config.client_id ? { client: config.client_id } : {}
        return (
          <div className="flex h-full flex-col justify-between gap-3 p-4">
            <div className="grid grid-cols-3 gap-1">
              <Stat label="Critical" value={formatNumber(data.open.critical)} tone={data.open.critical ? 'text-critical' : undefined} to="/alerts" search={{ ...scope, severity: 'critical' }} />
              <Stat label="Warning" value={formatNumber(data.open.warning)} tone={data.open.warning ? 'text-warning' : undefined} to="/alerts" search={{ ...scope, severity: 'warning' }} />
              <Stat label="Info" value={formatNumber(data.open.info)} tone={data.open.info ? 'text-info' : undefined} to="/alerts" search={{ ...scope, severity: 'info' }} />
            </div>
            <div className="grid gap-1.5">
              <ShareBar
                label="Unresolved alerts"
                parts={[
                  { label: 'Critical', value: data.open.critical, className: 'bg-critical' },
                  { label: 'Warning', value: data.open.warning, className: 'bg-warning' },
                  { label: 'Info', value: data.open.info, className: 'bg-info' },
                  { label: 'Acknowledged', value: data.acknowledged, className: 'bg-border-strong' },
                ]}
              />
              <p className="tabular text-micro text-muted-foreground">
                {data.total === 0 ? 'All clear: nothing unresolved.' : `${formatNumber(data.total)} unresolved · ${formatNumber(data.acknowledged)} acknowledged`}
              </p>
            </div>
          </div>
        )
      }}
    </Body>
  )
}

function AlertsList({ config, size }: { config: WidgetConfig; size: WidgetSize }) {
  return (
    <Body widget="alerts_list" config={config} rows={Math.max(2, size.h)}>
      {(data) =>
        data.items.length === 0 ? (
          <Empty icon={<ShieldCheck />}>No unresolved alerts. New ones appear here first.</Empty>
        ) : (
          <div className="flex h-full min-h-0 flex-col">
            <ol className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
              {data.items.map((alert) => (
                <ListRow key={alert.id} to="/alerts" search={{ alert: alert.id }}>
                  <SeverityIcon severity={alert.severity} className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-dense font-medium">{alert.title}</span>
                    <span className="block truncate text-micro text-muted-foreground">
                      {alert.hostname ? `${alert.hostname} · ` : ''}
                      {alert.client_name}
                    </span>
                  </span>
                  <span className="tabular shrink-0 text-[10.5px] text-subtle-foreground">{shortAge(alert.opened_at)}</span>
                </ListRow>
              ))}
            </ol>
            {data.total > data.items.length && (
              <Link to="/alerts" className="flex items-center justify-center gap-1 border-t border-border px-4 py-2 text-micro font-medium text-primary hover:bg-surface-2">
                View all {formatNumber(data.total)}
                <ArrowUpRight className="size-3" />
              </Link>
            )}
          </div>
        )
      }
    </Body>
  )
}

function Ring({ pct, size = 64 }: { pct: number | null; size?: number }) {
  const stroke = 6
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const tone = pct === null ? 'text-subtle-foreground' : pct >= 90 ? 'text-live' : pct >= 75 ? 'text-warning' : 'text-critical'
  return (
    <div className={cn('relative inline-flex shrink-0 items-center justify-center', tone)} style={{ width: size, height: size }} role="img" aria-label={pct === null ? 'No data' : `${pct}% compliant`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} strokeWidth={stroke} className="fill-none stroke-surface-4" />
        {pct !== null && <circle cx={size / 2} cy={size / 2} r={radius} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - pct / 100)} className="fill-none stroke-current" />}
      </svg>
      <span className="tabular absolute text-[13px] font-semibold text-foreground">{pct === null ? '—' : `${Math.round(pct)}%`}</span>
    </div>
  )
}

function PatchCompliance({ config, size }: { config: WidgetConfig; size: WidgetSize }) {
  return (
    <Body widget="patch_compliance" config={config}>
      {(data) => {
        const scope = config.client_id ? { client: config.client_id, site: config.site_id ?? undefined } : {}
        return (
          <div className="flex h-full flex-col justify-between gap-3 p-4">
            <div className="flex items-center gap-4">
              <Ring pct={data.compliance_pct} size={size.h >= 3 ? 64 : 48} />
              <div className="min-w-0">
                <div className="font-display tabular text-[19px] leading-tight font-semibold">
                  {formatNumber(data.compliant)}
                  <span className="text-[14px] font-medium text-subtle-foreground"> / {formatNumber(data.devices)}</span>
                </div>
                <Link to="/devices" search={{ ...scope, patch: 'non_compliant' } as never} className="text-micro text-muted-foreground hover:text-foreground">
                  {data.non_compliant ? `${formatNumber(data.non_compliant)} need attention` : 'scanned devices compliant'}
                </Link>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1">
              <Stat label="Missing critical" value={formatNumber(data.missing_critical)} tone={data.missing_critical ? 'text-critical' : undefined} to="/devices" search={{ ...scope, patch: 'missing_critical' }} />
              <Stat label="Failed installs" value={formatNumber(data.failed)} tone={data.failed ? 'text-critical' : undefined} to="/devices" search={{ ...scope, patch: 'failed' }} />
              {size.h >= 4 && <Stat label="Missing important" value={formatNumber(data.missing_important)} tone={data.missing_important ? 'text-warning' : undefined} to="/patching/updates" search={{ severity: 'Important' }} />}
              {size.h >= 4 && <Stat label="Restart pending" value={formatNumber(data.pending_reboot)} tone={data.pending_reboot ? 'text-info' : undefined} to="/devices" search={{ ...scope, patch: 'pending_reboot' }} />}
            </div>
          </div>
        )
      }}
    </Body>
  )
}

const STATUS_ORDER: TicketStatus[] = ['new', 'open', 'pending', 'on_hold']
const STATUS_TONE: Record<string, string> = { new: 'bg-info', open: 'bg-primary', pending: 'bg-warning', on_hold: 'bg-border-strong' }
const PRIORITY_ORDER: TicketPriority[] = ['urgent', 'high', 'normal', 'low']

function TicketsOpen({ config }: { config: WidgetConfig }) {
  return (
    <Body widget="tickets_open" config={config}>
      {(data) => (
        <div className="flex h-full flex-col justify-between gap-3 p-4">
          <div className="flex items-end justify-between gap-3">
            <Stat label="Active tickets" value={formatNumber(data.total)} to="/tickets" search={config.client_id ? { client: config.client_id } : {}} />
            <div className="flex flex-wrap justify-end gap-1">
              {PRIORITY_ORDER.filter((priority) => data.by_priority[priority]).map((priority) => (
                <Link key={priority} to="/tickets" search={{ priority } as never} className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-micro ring-1 ring-border hover:bg-surface-3">
                  <PriorityGlyph priority={priority} />
                  <span className="tabular">{formatNumber(data.by_priority[priority])}</span>
                </Link>
              ))}
            </div>
          </div>
          <div className="grid gap-1.5">
            <ShareBar label="Tickets by status" parts={STATUS_ORDER.map((status) => ({ label: status, value: data.by_status[status] ?? 0, className: STATUS_TONE[status] }))} />
            <div className="tabular flex flex-wrap gap-x-3 text-micro text-muted-foreground">
              {STATUS_ORDER.map((status) => (
                <span key={status} className="capitalize">
                  <span className={cn('mr-1 inline-block size-1.5 rounded-full', STATUS_TONE[status])} />
                  {formatNumber(data.by_status[status] ?? 0)} {status.replace('_', ' ')}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </Body>
  )
}

function SlaBreaches({ config, size }: { config: WidgetConfig; size: WidgetSize }) {
  return (
    <Body widget="sla_breaches" config={config} rows={Math.max(2, size.h)}>
      {(data) =>
        data.items.length === 0 ? (
          <Empty>Every active ticket is within its SLA.</Empty>
        ) : (
          <div className="flex h-full min-h-0 flex-col">
            <ol className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
              {data.items.map((ticket) => (
                <ListRow key={ticket.id} to="/tickets/$ticketId" params={{ ticketId: ticket.id }}>
                  <PriorityGlyph priority={ticket.priority as TicketPriority} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="tabular shrink-0 font-mono text-[11px] text-muted-foreground">{ticketNumber(ticket.number)}</span>
                      <span className="truncate text-dense font-medium">{ticket.subject}</span>
                    </span>
                    <span className="block truncate text-micro text-critical">
                      {[ticket.first_response_breached && 'First response', ticket.resolution_breached && 'Resolution'].filter(Boolean).join(' and ')} breached
                    </span>
                  </span>
                  <TicketStatusBadge status={ticket.status as TicketStatus} className="hidden shrink-0 sm:inline-flex" />
                </ListRow>
              ))}
            </ol>
            {data.total > data.items.length && (
              <Link to="/tickets" search={{ sla: 'breached' } as never} className="flex items-center justify-center gap-1 border-t border-border px-4 py-2 text-micro font-medium text-primary hover:bg-surface-2">
                {formatNumber(data.total)} breaching
                <ArrowUpRight className="size-3" />
              </Link>
            )}
          </div>
        )
      }
    </Body>
  )
}

function DevicesOffline({ config, size }: { config: WidgetConfig; size: WidgetSize }) {
  return (
    <Body widget="devices_offline" config={config} rows={Math.max(2, size.h)}>
      {(data) =>
        data.items.length === 0 ? (
          <Empty>Every device is online.</Empty>
        ) : (
          <div className="flex h-full min-h-0 flex-col">
            <ol className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
              {data.items.map((device) => (
                <ListRow key={device.device_id} to="/devices/$deviceId" params={{ deviceId: device.device_id }}>
                  <span className="size-1.5 shrink-0 rounded-full bg-subtle-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-dense font-medium">{device.hostname}</span>
                    <span className="block truncate text-micro text-muted-foreground">{device.client_name}</span>
                  </span>
                  <span className="tabular flex shrink-0 items-center gap-1 text-[10.5px] text-subtle-foreground">
                    <Clock className="size-3" />
                    {device.last_seen_at ? formatRelative(device.last_seen_at) : 'never'}
                  </span>
                </ListRow>
              ))}
            </ol>
            <Link to="/devices" search={{ state: 'offline' } as never} className="flex items-center justify-center gap-1 border-t border-border px-4 py-2 text-micro font-medium text-primary hover:bg-surface-2">
              {formatNumber(data.total)} offline
              <ArrowUpRight className="size-3" />
            </Link>
          </div>
        )
      }
    </Body>
  )
}

function OsMix({ config, size }: { config: WidgetConfig; size: WidgetSize }) {
  return (
    <Body widget="os_mix" config={config}>
      {(data) => {
        const total = data.items.reduce((sum, item) => sum + item.count, 0)
        if (total === 0) return <Empty>No devices in scope.</Empty>
        const items = data.items.slice(0, 6).map((item, index) => ({ ...item, key: `os${index}`, color: PALETTE[index % PALETTE.length] }))
        const chartConfig: ChartConfig = Object.fromEntries(items.map((item) => [item.key, { label: item.os, color: item.color }]))
        const ring = size.h >= 3 ? 96 : 64
        return (
          <div className="flex h-full items-center gap-4 p-4">
            <div className="relative shrink-0" style={{ width: ring, height: ring }} role="img" aria-label={items.map((item) => `${item.os} ${item.count}`).join(', ')}>
              <ChartContainer config={chartConfig} className="aspect-square size-full">
                <PieChart>
                  <Pie data={items.map((item) => ({ ...item, fill: `var(--color-${item.key})` }))} dataKey="count" nameKey="os" innerRadius={ring * 0.32} outerRadius={ring * 0.48} paddingAngle={2} strokeWidth={0} isAnimationActive={false} />
                </PieChart>
              </ChartContainer>
              <span className="tabular pointer-events-none absolute inset-0 flex items-center justify-center text-[13px] font-semibold">{formatNumber(total)}</span>
            </div>
            <ul className="grid min-w-0 flex-1 gap-1">
              {items.map((item) => (
                <li key={item.key} className="flex min-w-0 items-center gap-2 text-dense">
                  <span className="size-2 shrink-0 rounded-[2px]" style={{ background: item.color }} />
                  {['windows', 'macos', 'linux'].includes(item.family) && <OsIcon family={item.family as OsFamily} className="size-3.5 shrink-0" />}
                  <span className="min-w-0 flex-1 truncate">{item.os}</span>
                  <span className="tabular text-muted-foreground">{Math.round((item.count / total) * 100)}%</span>
                </li>
              ))}
            </ul>
          </div>
        )
      }}
    </Body>
  )
}

function AgentVersions({ config }: { config: WidgetConfig }) {
  return (
    <Body widget="agent_versions" config={config}>
      {(data) => {
        const total = data.items.reduce((sum, item) => sum + item.count, 0)
        return (
          <div className="flex h-full flex-col gap-3 p-4">
            <div className="grid grid-cols-2 gap-1">
              <Stat label="Current release" value={<span className="font-mono text-[16px]">{data.latest ?? '—'}</span>} />
              <Stat label="Outdated" value={formatNumber(data.outdated)} tone={data.outdated ? 'text-warning' : 'text-live'} />
            </div>
            <ul className="grid min-h-0 gap-1.5 overflow-y-auto">
              {data.items.map((item) => (
                <li key={item.version} className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-2 text-dense">
                  <span className={cn('truncate font-mono text-[11.5px]', item.version === data.latest ? 'text-live' : 'text-muted-foreground')}>{item.version}</span>
                  <span className="h-1.5 overflow-hidden rounded-full bg-surface-3">
                    <span className={cn('block h-full rounded-full', item.version === data.latest ? 'bg-live' : 'bg-warning')} style={{ width: `${total ? Math.max(3, (item.count / total) * 100) : 0}%` }} />
                  </span>
                  <span className="tabular text-micro text-muted-foreground">{formatNumber(item.count)}</span>
                </li>
              ))}
            </ul>
          </div>
        )
      }}
    </Body>
  )
}

function TopDiskUsage({ config, size }: { config: WidgetConfig; size: WidgetSize }) {
  return (
    <Body widget="top_disk_usage" config={config} rows={Math.max(2, size.h)}>
      {(data) =>
        data.items.length === 0 ? (
          <Empty>No disk data yet.</Empty>
        ) : (
          <ol className="h-full divide-y divide-border overflow-y-auto">
            {data.items.map((device) => (
              <ListRow key={device.device_id} to="/devices/$deviceId" params={{ deviceId: device.device_id }}>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-dense font-medium">{device.hostname}</span>
                    <span className={cn('tabular shrink-0 text-dense font-medium', device.disk_pct >= 90 ? 'text-critical' : device.disk_pct >= 80 ? 'text-warning' : 'text-muted-foreground')}>{device.disk_pct}%</span>
                  </span>
                  <span className="mt-1 flex items-center gap-2">
                    <UsageBar value={device.disk_pct} className="flex-1" />
                    <span className="max-w-[45%] truncate text-[10.5px] text-subtle-foreground">{device.client_name}</span>
                  </span>
                </span>
              </ListRow>
            ))}
          </ol>
        )
      }
    </Body>
  )
}

const RUN_TONE: Record<string, string> = { completed: 'text-live', running: 'text-info', cancelled: 'text-subtle-foreground', failed: 'text-critical' }

function RecentJobs({ config, size }: { config: WidgetConfig; size: WidgetSize }) {
  return (
    <Body widget="recent_jobs" config={config} rows={Math.max(2, size.h)}>
      {(data) =>
        data.items.length === 0 ? (
          <Empty icon={<RotateCw />}>No job ran in the last {config.days ?? 7} days.</Empty>
        ) : (
          <ol className="h-full divide-y divide-border overflow-y-auto">
            {data.items.map((run) => {
              const failed = run.counts.failed ?? 0
              const succeeded = run.counts.succeeded ?? 0
              const total = run.counts.total ?? succeeded + failed
              return (
                <ListRow key={run.run_id} to="/automation/jobs/$jobId" params={{ jobId: run.job_id }}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-dense font-medium">{run.name}</span>
                    <span className="tabular block truncate text-micro text-muted-foreground">
                      <span className={cn('capitalize', RUN_TONE[run.status])}>{run.status}</span> · {formatNumber(succeeded)}/{formatNumber(total)} succeeded
                      {failed > 0 && <span className="text-critical"> · {formatNumber(failed)} failed</span>}
                    </span>
                  </span>
                  <span className="tabular shrink-0 text-[10.5px] text-subtle-foreground">{run.started_at ? shortAge(run.started_at) : ''}</span>
                </ListRow>
              )
            })}
          </ol>
        )
      }
    </Body>
  )
}

function CustomFieldBreakdown({ config, size }: { config: WidgetConfig; size: WidgetSize }) {
  if (!config.field) return <Empty icon={<OctagonAlert />}>Choose a device custom field in this widget’s settings.</Empty>
  return (
    <Body widget="custom_field_breakdown" config={config} rows={Math.max(2, size.h)}>
      {(data) => {
        const max = Math.max(1, ...data.items.map((item) => item.count))
        return data.items.length === 0 ? (
          <Empty>No devices in scope.</Empty>
        ) : (
          <ul className="grid h-full content-start gap-2 overflow-y-auto p-4">
            {data.items.map((item, index) => (
              <li key={item.value} className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)_auto] items-center gap-2 text-dense">
                <span className={cn('truncate', item.value === '(not set)' && 'text-subtle-foreground italic')} title={item.value}>
                  {item.value}
                </span>
                <span className="h-2 overflow-hidden rounded-full bg-surface-3">
                  <span className="block h-full rounded-full" style={{ width: `${(item.count / max) * 100}%`, background: item.value === '(not set)' ? 'var(--border-strong)' : PALETTE[index % PALETTE.length] }} />
                </span>
                <span className="tabular text-micro text-muted-foreground">{formatNumber(item.count)}</span>
              </li>
            ))}
          </ul>
        )
      }}
    </Body>
  )
}

/** The body of a widget for its name and frame size. */
export function WidgetBody({ widget, config, size }: { widget: WidgetName; config: WidgetConfig; size: WidgetSize }) {
  switch (widget) {
    case 'fleet_health':
      return <FleetHealth config={config} size={size} />
    case 'alerts_by_severity':
      return <AlertsBySeverity config={config} />
    case 'alerts_list':
      return <AlertsList config={config} size={size} />
    case 'patch_compliance':
      return <PatchCompliance config={config} size={size} />
    case 'tickets_open':
      return <TicketsOpen config={config} />
    case 'sla_breaches':
      return <SlaBreaches config={config} size={size} />
    case 'devices_offline':
      return <DevicesOffline config={config} size={size} />
    case 'os_mix':
      return <OsMix config={config} size={size} />
    case 'agent_versions':
      return <AgentVersions config={config} />
    case 'top_disk_usage':
      return <TopDiskUsage config={config} size={size} />
    case 'recent_jobs':
      return <RecentJobs config={config} size={size} />
    case 'custom_field_breakdown':
      return <CustomFieldBreakdown config={config} size={size} />
    default:
      return <Empty icon={<OctagonAlert />}>Unknown widget.</Empty>
  }
}

