/* One SNMP device: status, open alerts, metric graphs per series, the interface table, printer supplies and the UPS panel. */
import { useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { CartesianGrid, Line, LineChart, ReferenceLine, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts'
import { Activity, ArrowLeft, BatteryCharging, Boxes, Cable, Ellipsis, Gauge, Network, Pencil, PlugZap, Printer, Trash, TriangleAlert, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ChartContainer, type ChartConfig } from '@/components/ui/chart'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, Mono, RelativeTime } from '@/components/common/misc'
import { PageContainer } from '@/components/common/page-header'
import { alertsApi, snmpApi } from '@/lib/api/endpoints'
import { networkKeys, snmpDevicesQuery, snmpMetricsQuery, snmpTemplatesQuery } from '@/lib/api/queries'
import type { MetricsRange, SnmpMetricDef, SnmpMetricsResponse, SnmpTestResult } from '@/lib/api/types'
import { formatBitrate } from '@/lib/devices'
import { formatDuration, formatSpan } from '@/lib/format'
import {
  PANEL_KEYS,
  PRINTER_STATUS,
  chartRows,
  currentValue,
  formatSnmpValue,
  groupSeries,
  interfaceRows,
  printerSupplies,
  rowLabel,
  seriesStats,
  upsPanel,
  type SeriesGroup,
  type SupplyColor,
} from '@/lib/network/snmp'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { SeverityIcon } from '@/features/monitoring/monitoring-ui'
import { MiniSparkline, SectionCard, SnmpStatusBadge } from './network-ui'
import { SnmpDeviceEditor, TestResultCard } from './snmp-device-editor'
import { networkErrorMessage, siteLabel, useScopedSites } from './use-network'

const RANGES: { value: MetricsRange; label: string; description: string }[] = [
  { value: '1h', label: '1H', description: 'Last hour · raw samples' },
  { value: '24h', label: '24H', description: 'Last 24 hours · raw samples' },
  { value: '7d', label: '7D', description: 'Last 7 days · 15-minute averages' },
  { value: '30d', label: '30D', description: 'Last 30 days · hourly averages' },
]

const COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)']
const MAX_LINES = 6

const SUPPLY_BAR: Record<SupplyColor, string> = {
  black: 'bg-foreground/80',
  cyan: 'bg-[oklch(0.72_0.13_215)]',
  magenta: 'bg-[oklch(0.62_0.22_350)]',
  yellow: 'bg-[oklch(0.84_0.16_95)]',
  other: 'bg-subtle-foreground/60',
}

function tickFormatter(range: MetricsRange) {
  const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
  const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
  return (ts: number) => (range === '1h' || range === '24h' ? time.format(ts * 1000) : day.format(ts * 1000))
}
const fullTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

interface TooltipItem {
  dataKey?: unknown
  value?: unknown
  color?: string
}

function SeriesTooltip({ active, payload, label, names, format }: { active?: boolean; payload?: readonly TooltipItem[]; label?: unknown; names: Record<string, string>; format: (value: number) => string }) {
  if (!active || !payload?.length) return null
  return (
    <div className="grid min-w-40 gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">{typeof label === 'number' ? fullTime.format(label * 1000) : null}</div>
      {payload.map((item) => (
        <div key={String(item.dataKey)} className="flex items-center gap-2">
          <span className="size-2.5 rounded-[2px]" style={{ background: item.color }} />
          <span className="flex-1 truncate text-muted-foreground">{names[String(item.dataKey)] ?? String(item.dataKey)}</span>
          <span className="font-mono font-medium tabular-nums">{typeof item.value === 'number' ? format(item.value) : '—'}</span>
        </div>
      ))}
    </div>
  )
}

/** A multi-line chart for one metric key; each row (interface, volume, supply…) is a line. */
function MetricChart({ group, metric, range }: { group: SeriesGroup; metric?: SnmpMetricDef; range: MetricsRange }) {
  const series = useMemo(
    () => [...group.series].sort((a, b) => (seriesStats(b).avg ?? 0) - (seriesStats(a).avg ?? 0)).slice(0, MAX_LINES),
    [group.series],
  )
  const bits = group.unit === 'B/s'
  const keyed = series.map((item, index) => ({ item, key: `s${index}` }))
  const rows = useMemo(() => {
    const aligned = chartRows(series, bits ? (value) => value * 8 : undefined)
    return aligned.map((row) => {
      const out: Record<string, number | null> = { ts: row.ts }
      keyed.forEach(({ item, key }) => (out[key] = row[item.index ? `${item.key}:${item.index}` : item.key] ?? null))
      return out
    })
  }, [series, bits, keyed])
  const names = Object.fromEntries(keyed.map(({ item, key }) => [key, rowLabel(item) ?? group.label]))
  const config = Object.fromEntries(keyed.map(({ key }, index) => [key, { label: names[key], color: COLORS[index % COLORS.length] }])) satisfies ChartConfig
  const format = (value: number) => (bits ? formatBitrate(value) : formatSnmpValue(value, group.unit))
  const percent = group.unit === '%'
  const thresholds = metric?.thresholds
  const latestStats = seriesStats(series[0])
  return (
    <section className="grid min-w-0 gap-3 rounded-xl bg-card p-4 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{group.label}</h3>
          <p className="text-micro text-subtle-foreground">
            {group.series.length > 1 ? `${group.series.length} rows${group.series.length > MAX_LINES ? `, busiest ${MAX_LINES} shown` : ''}` : (group.unit || 'value')}
            {thresholds && (thresholds.warn != null || thresholds.crit != null) && ` · alerts at ${thresholds.direction === 'above' ? '≥' : '≤'} ${[thresholds.warn, thresholds.crit].filter((value) => value != null).join(' / ')}${percent ? '%' : ''}`}
          </p>
        </div>
        {series.length === 1 && (
          <div className="flex gap-4 text-right">
            <div>
              <div className="text-micro text-subtle-foreground">Now</div>
              <div className="tabular text-sm font-semibold">{latestStats.last == null ? '—' : format(bits ? latestStats.last * 8 : latestStats.last)}</div>
            </div>
            <div>
              <div className="text-micro text-subtle-foreground">Peak</div>
              <div className="tabular text-sm font-semibold">{latestStats.max == null ? '—' : format(bits ? latestStats.max * 8 : latestStats.max)}</div>
            </div>
          </div>
        )}
      </div>
      <ChartContainer config={config} className="aspect-auto h-48 w-full">
        <LineChart data={rows} margin={{ left: 0, right: 8, top: 6, bottom: 0 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 4" />
          <XAxis dataKey="ts" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={tickFormatter(range)} tickLine={false} axisLine={false} tickMargin={8} minTickGap={48} />
          <YAxis domain={percent ? [0, 100] : ['auto', 'auto']} tickLine={false} axisLine={false} width={bits ? 64 : 44} tickFormatter={(value: number) => (bits ? formatBitrate(value) : percent ? `${value}%` : formatSnmpValue(value, group.unit))} />
          {thresholds?.warn != null && <ReferenceLine y={thresholds.warn} stroke="var(--warning)" strokeDasharray="4 4" ifOverflow="extendDomain" />}
          {thresholds?.crit != null && <ReferenceLine y={thresholds.crit} stroke="var(--critical)" strokeDasharray="4 4" ifOverflow="extendDomain" />}
          <ChartTooltip content={(props) => <SeriesTooltip active={props.active} payload={props.payload as readonly TooltipItem[]} label={props.label} names={names} format={format} />} />
          {keyed.map(({ key }) => (
            <Line key={key} dataKey={key} type="monotone" stroke={`var(--color-${key})`} strokeWidth={1.6} dot={false} connectNulls isAnimationActive={false} />
          ))}
        </LineChart>
      </ChartContainer>
      {keyed.length > 1 && (
        <ul className="flex flex-wrap gap-x-3 gap-y-1">
          {keyed.map(({ key }) => (
            <li key={key} className="flex items-center gap-1.5 text-micro text-muted-foreground">
              <span className="size-2 rounded-[2px]" style={{ background: config[key].color }} />
              {names[key]}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function UpsPanelCard({ metrics }: { metrics: SnmpMetricsResponse }) {
  const ups = upsPanel(metrics)
  if (!ups) return null
  const onBattery = ups.inputVolts === 0
  const charge = ups.chargePct ?? 0
  const tone = ups.battery === 'depleted' || charge <= 20 ? 'critical' : ups.battery === 'low' || charge <= 50 || onBattery ? 'warning' : 'success'
  return (
    <SectionCard
      icon={<BatteryCharging />}
      title="UPS battery"
      description="UPS-MIB: battery status, charge, runtime, input voltage and load."
      actions={onBattery ? <Badge variant="warning"><Zap />On battery</Badge> : <Badge variant={ups.battery === 'normal' ? 'success' : ups.battery === 'unknown' ? 'secondary' : 'warning'}>{ups.battery === 'normal' ? 'Normal' : ups.battery === 'low' ? 'Battery low' : ups.battery === 'depleted' ? 'Depleted' : 'Unknown'}</Badge>}
    >
      <div className="grid gap-4 p-4 sm:grid-cols-[minmax(0,14rem)_1fr] sm:items-center">
        <div className="flex items-center gap-3">
          <div className="relative h-14 w-28 rounded-lg p-1 ring-2 ring-border-strong" role="img" aria-label={`Charge ${Math.round(charge)}%`}>
            <span className="absolute top-1/2 -right-2 h-5 w-1.5 -translate-y-1/2 rounded-r-sm bg-border-strong" />
            <span className={cn('block h-full rounded-[5px] transition-[width] duration-700', tone === 'critical' ? 'bg-critical' : tone === 'warning' ? 'bg-warning' : 'bg-success')} style={{ width: `${Math.max(3, charge)}%` }} />
          </div>
          <div>
            <div className="font-display tabular text-[26px] leading-none font-semibold">{ups.chargePct == null ? '—' : `${Math.round(charge)}%`}</div>
            <div className="text-micro text-muted-foreground">charge</div>
          </div>
        </div>
        <dl className="grid grid-cols-3 gap-3 text-dense">
          <div>
            <dt className="text-micro text-subtle-foreground">Runtime</dt>
            <dd className="tabular font-semibold">{ups.runtimeMin == null ? '—' : `${ups.runtimeMin} min`}</dd>
          </div>
          <div>
            <dt className="text-micro text-subtle-foreground">Input</dt>
            <dd className={cn('tabular font-semibold', onBattery && 'text-warning')}>{ups.inputVolts == null ? '—' : `${ups.inputVolts} V`}</dd>
          </div>
          <div>
            <dt className="text-micro text-subtle-foreground">Load</dt>
            <dd className="tabular font-semibold">{ups.loadPct == null ? '—' : `${ups.loadPct}%`}</dd>
            {ups.loadPct != null && (
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-3">
                <div className={cn('h-full rounded-full', ups.loadPct >= 95 ? 'bg-critical' : ups.loadPct >= 80 ? 'bg-warning' : 'bg-info')} style={{ width: `${Math.min(100, ups.loadPct)}%` }} />
              </div>
            )}
          </div>
        </dl>
        {ups.chargeTrend.length > 1 && (
          <div className="flex items-center gap-2 sm:col-span-2">
            <span className="text-micro text-subtle-foreground">Charge trend</span>
            <MiniSparkline values={ups.chargeTrend} className="h-6 flex-1" tone="var(--success)" />
          </div>
        )}
      </div>
    </SectionCard>
  )
}

function PrinterCard({ metrics }: { metrics: SnmpMetricsResponse }) {
  const supplies = printerSupplies(metrics)
  if (supplies.length === 0) return null
  const status = currentValue(metrics, 'hrPrinterStatus', '1')?.value
  return (
    <SectionCard icon={<Printer />} title="Supplies" description="Printer-MIB levels as a share of each supply’s capacity. Alerts at 20% and 10%." actions={status != null && <Badge variant="secondary">{PRINTER_STATUS[status] ?? `Status ${status}`}</Badge>}>
      <ul className="grid gap-3 p-4 sm:grid-cols-2">
        {supplies.map((supply) => (
          <li key={supply.index} className="grid gap-1.5">
            <div className="flex items-baseline justify-between gap-2 text-dense">
              <span className="truncate">{supply.name}</span>
              <span className={cn('tabular font-semibold', supply.state === 'critical' ? 'text-critical' : supply.state === 'warning' ? 'text-warning' : 'text-foreground')}>{supply.pct == null ? '—' : `${supply.pct}%`}</span>
            </div>
            <div className="relative h-2 overflow-hidden rounded-full bg-surface-3">
              <div className={cn('h-full rounded-full transition-[width] duration-700', SUPPLY_BAR[supply.color])} style={{ width: `${supply.pct ?? 0}%` }} />
              <span className="absolute inset-y-0 left-[10%] w-px bg-critical/50" aria-hidden="true" />
              <span className="absolute inset-y-0 left-[20%] w-px bg-warning/50" aria-hidden="true" />
            </div>
          </li>
        ))}
      </ul>
    </SectionCard>
  )
}

function InterfacesCard({ metrics }: { metrics: SnmpMetricsResponse }) {
  const rows = interfaceRows(metrics)
  const [showDown, setShowDown] = useState(false)
  if (rows.length === 0) return null
  const up = rows.filter((row) => row.status === 'up').length
  const shown = showDown ? rows : rows.filter((row) => row.status !== 'down')
  return (
    <SectionCard
      icon={<Cable />}
      title="Interfaces"
      description={`${up} of ${rows.length} up · IF-MIB rates in bits per second`}
      actions={
        rows.length !== up && (
          <Button variant="ghost" size="xs" onClick={() => setShowDown(!showDown)}>
            {showDown ? 'Hide down ports' : `Show ${rows.length - up} down`}
          </Button>
        )
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[620px] text-dense">
          <thead>
            <tr className="text-left text-micro font-semibold tracking-[0.06em] text-subtle-foreground uppercase">
              <th className="px-4 py-2">Interface</th>
              <th className="px-3 py-2 text-right">In</th>
              <th className="px-3 py-2 text-right">Out</th>
              <th className="px-3 py-2 text-right">Errors</th>
              <th className="px-4 py-2">Traffic</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => {
              const errors = (row.inErrors ?? 0) + (row.outErrors ?? 0)
              return (
                <tr key={row.index} className="border-t border-border">
                  <td className="px-4 py-2">
                    <span className="flex items-center gap-2">
                      <span className={cn('size-2 shrink-0 rounded-full', row.status === 'up' ? 'bg-success' : row.status === 'down' ? 'bg-subtle-foreground/50' : 'bg-warning')} aria-label={row.status} />
                      <span className="truncate font-medium">{row.name}</span>
                    </span>
                  </td>
                  <td className="tabular px-3 py-2 text-right">{row.status === 'down' ? '—' : formatBitrate(row.inBps)}</td>
                  <td className="tabular px-3 py-2 text-right">{row.status === 'down' ? '—' : formatBitrate(row.outBps)}</td>
                  <td className={cn('tabular px-3 py-2 text-right', errors > 0 ? 'font-medium text-warning' : 'text-subtle-foreground')}>{errors > 0 ? formatSnmpValue(errors, 'errors/s') : '0'}</td>
                  <td className="px-4 py-2">{row.status === 'down' ? <span className="text-micro text-subtle-foreground">down</span> : <MiniSparkline values={row.trend} />}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </SectionCard>
  )
}

function NeighboursCard({ metrics }: { metrics: SnmpMetricsResponse }) {
  const rows = (metrics.current ?? []).filter((item) => item.key === 'lldpRemSysName' && item.text)
  if (rows.length === 0) return null
  return (
    <SectionCard icon={<Network />} title="LLDP neighbours" description="Devices this one sees on its ports (used for the topology view).">
      <ul className="grid gap-px p-2">
        {rows.map((row) => (
          <li key={row.index ?? row.text} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-dense">
            <Network className="size-3.5 text-subtle-foreground" />
            <span className="font-medium">{row.text}</span>
            <span className="ml-auto font-mono text-[10.5px] text-subtle-foreground">port {row.index?.split('.')[1] ?? row.index}</span>
          </li>
        ))}
      </ul>
    </SectionCard>
  )
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-20">
      <div className="text-micro text-subtle-foreground">{label}</div>
      <div className="tabular mt-0.5 text-[13px] font-semibold">{children}</div>
    </div>
  )
}

export function SnmpDevicePage({ deviceId, range }: { deviceId: string; range: MetricsRange }) {
  const me = useMe()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const canManage = hasPermission(me, PERMISSIONS.networkManage)
  const canAlerts = hasPermission(me, PERMISSIONS.alertsView)
  const { byId } = useScopedSites()
  const devices = useQuery(snmpDevicesQuery())
  const device = devices.data?.find((item) => item.id === deviceId)
  const templates = useQuery(snmpTemplatesQuery)
  const metrics = useQuery({ ...snmpMetricsQuery(deviceId, range), enabled: Boolean(device) })
  const alerts = useQuery({
    queryKey: ['alerts', 'snmp-device', deviceId],
    queryFn: async () => (await alertsApi.list({ source: 'snmp', q: device!.name, limit: 50 })).items.filter((alert) => alert.snmp_device_id === deviceId),
    enabled: Boolean(device) && canAlerts,
    refetchInterval: 60_000,
  })
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [test, setTest] = useState<SnmpTestResult | null>(null)
  useTitle(device?.name)

  const runTest = useMutation({
    mutationFn: () => snmpApi.test(deviceId),
    meta: { silent: true },
    onMutate: () => setTest(null),
    onSuccess: setTest,
    onError: (failure) => setTest({ ok: false, error: networkErrorMessage(failure) }),
  })
  const remove = useMutation({
    mutationFn: () => snmpApi.removeDevice(deviceId),
    meta: { silent: true },
    onSuccess: () => {
      toast.success(`Stopped monitoring ${device?.name}`)
      void queryClient.invalidateQueries({ queryKey: networkKeys.devices })
      void queryClient.invalidateQueries({ queryKey: ['alerts'] })
      void navigate({ to: '/network/snmp' })
    },
    onError: (failure) => toast.error(networkErrorMessage(failure)),
  })

  const metricDefs = useMemo(() => {
    const map = new Map<string, SnmpMetricDef>()
    for (const template of templates.data ?? []) if (device?.template_ids.includes(template.id)) for (const metric of template.metrics) map.set(metric.key, metric)
    return map
  }, [templates.data, device])
  const groups = useMemo(() => groupSeries(metrics.data?.series ?? []), [metrics.data])
  const generic = groups.filter((group) => !PANEL_KEYS.has(group.key) || group.key === 'ifHCInOctets' || group.key === 'ifHCOutOctets' || group.key === 'upsEstimatedChargeRemaining' || group.key === 'prtMarkerSuppliesLevel')
  const openAlerts = (alerts.data ?? []).filter((alert) => alert.status !== 'resolved')

  if (devices.error) return <PageContainer><ErrorState error={devices.error} onRetry={() => void devices.refetch()} /></PageContainer>
  if (devices.isLoading) {
    return (
      <PageContainer className="grid gap-4">
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </PageContainer>
    )
  }
  if (!device) {
    return (
      <PageContainer>
        <EmptyState illustration="network" title="SNMP device not found" description="It may have been removed, or it belongs to a client outside your scope." actions={<Button variant="outline" size="sm" render={<Link to="/network/snmp" />} nativeButton={false}>All SNMP devices</Button>} />
      </PageContainer>
    )
  }

  return (
    <PageContainer className="grid grid-cols-1 gap-5">
      <header className="grid gap-4">
        <Link to="/network/snmp" className="inline-flex w-fit items-center gap-1 text-dense text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" />
          SNMP devices
        </Link>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 items-start gap-3.5">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary shadow-raised ring-1 ring-primary/20">
              <Activity className="size-5" />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="font-display truncate text-[22px] leading-tight font-semibold">{device.name}</h1>
                <SnmpStatusBadge status={device.status} enabled={device.enabled} />
              </div>
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-dense text-muted-foreground">
                <Mono>{`${device.ip}:${device.port}`}</Mono>
                <span className="text-subtle-foreground">·</span>
                <span>{siteLabel(byId.get(device.site_id), device.site_name)}</span>
                {device.asset_id && (
                  <>
                    <span className="text-subtle-foreground">·</span>
                    <Link to="/network/assets" search={{ asset: device.asset_id }} className="inline-flex items-center gap-1 hover:text-foreground hover:underline">
                      <Boxes className="size-3.5" />
                      Asset
                    </Link>
                  </>
                )}
              </p>
              {device.sys_descr && <p className="mt-1 max-w-3xl truncate text-micro text-subtle-foreground" title={device.sys_descr}>{device.sys_descr}</p>}
            </div>
          </div>
          {canManage && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" disabled={runTest.isPending} onClick={() => runTest.mutate()}>
                {runTest.isPending ? <Spinner data-icon="inline-start" /> : <PlugZap data-icon="inline-start" />}
                Test
              </Button>
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                <Pencil data-icon="inline-start" />
                Edit
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="outline" size="icon-sm" aria-label="More actions" />}>
                  <Ellipsis />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem render={<Link to="/network/topology" search={{ site_id: device.site_id }} />}>
                    <Network />
                    Site topology
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}>
                    <Trash />
                    Stop monitoring…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-x-7 gap-y-3">
          <Stat label="Uptime">{device.uptime_secs != null ? formatDuration(device.uptime_secs) : '—'}</Stat>
          <Stat label="Last poll">{device.last_poll_at ? <RelativeTime value={device.last_poll_at} /> : 'Not yet'}</Stat>
          <Stat label="Poll every">{formatSpan(device.poll_interval_secs)}</Stat>
          <Stat label="Templates">{device.template_ids.length}</Stat>
          {canAlerts && <Stat label="Open alerts">{openAlerts.length}</Stat>}
        </div>
        {test && <TestResultCard result={test} className="max-w-2xl" />}
        {device.status === 'unreachable' && device.last_error && (
          <p className="flex max-w-3xl items-start gap-2 rounded-lg bg-critical/[0.05] px-3 py-2 text-dense text-critical ring-1 ring-critical/25">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            {device.last_error}
          </p>
        )}
      </header>

      {openAlerts.length > 0 && (
        <SectionCard icon={<TriangleAlert />} title="Open alerts" description="Thresholds and reachability resolve on their own; trap alerts need a manual resolve.">
          <ul className="divide-y divide-border">
            {openAlerts.map((alert) => (
              <li key={alert.id}>
                <Link to="/alerts" search={{ alert: alert.id }} className="flex min-w-0 items-center gap-3 px-4 py-2.5 text-dense hover:bg-surface-2">
                  <SeverityIcon severity={alert.severity} />
                  <span className="min-w-0 flex-1 truncate font-medium">{alert.title}</span>
                  {alert.status === 'acknowledged' && <Badge variant="secondary">Acknowledged</Badge>}
                  <RelativeTime value={alert.opened_at} className="shrink-0 text-micro text-subtle-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-dense text-muted-foreground">
          <Gauge className="size-4 text-subtle-foreground" />
          {RANGES.find((item) => item.value === range)?.description}
        </p>
        <ToggleGroup value={[range]} onValueChange={(value: string[]) => value[0] && void navigate({ to: '/network/snmp/$snmpDeviceId', params: { snmpDeviceId: deviceId }, search: { range: value[0] as MetricsRange }, replace: true })} aria-label="Time range">
          {RANGES.map((item) => (
            <ToggleGroupItem key={item.value} value={item.value} size="sm" className="font-mono text-[11.5px]">
              {item.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {metrics.error ? (
        <ErrorState error={metrics.error} onRetry={() => void metrics.refetch()} />
      ) : metrics.isLoading || !metrics.data ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <Skeleton className="h-60 rounded-xl" />
          <Skeleton className="h-60 rounded-xl" />
        </div>
      ) : metrics.data.series.length === 0 && (metrics.data.current ?? []).length === 0 ? (
        <EmptyState
          illustration="reports"
          title={device.status === 'pending' ? 'Waiting for the first poll' : 'No samples in this range'}
          description={device.status === 'pending' ? 'The site’s probe polls new devices within a minute.' : 'The probe stores a sample each poll while the device answers.'}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4">
          <div className="grid gap-4 xl:grid-cols-2 [&>*]:min-w-0">
            <UpsPanelCard metrics={metrics.data} />
            <PrinterCard metrics={metrics.data} />
          </div>
          <InterfacesCard metrics={metrics.data} />
          <div className="grid gap-4 xl:grid-cols-2 [&>*]:min-w-0">
            {generic.map((group) => (
              <MetricChart key={group.key} group={group} metric={metricDefs.get(group.key)} range={range} />
            ))}
          </div>
          <NeighboursCard metrics={metrics.data} />
        </div>
      )}

      <SnmpDeviceEditor device={device} open={editing} onOpenChange={setEditing} />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Stop monitoring ${device.name}?`}
        description="The device, its metric history and its SNMP alerts are removed. The discovered asset stays."
        confirmLabel="Stop monitoring"
        confirmText={device.name}
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </PageContainer>
  )
}
