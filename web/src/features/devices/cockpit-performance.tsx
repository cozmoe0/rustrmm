import { useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Area, AreaChart, CartesianGrid, Line, LineChart, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts'
import { Activity, Cpu, HardDrive, Network } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ChartContainer, type ChartConfig } from '@/components/ui/chart'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/misc'
import { metricsQuery } from '@/lib/api/queries'
import type { DeviceDetail, MetricPoint, MetricsRange } from '@/lib/api/types'
import { formatBitrate } from '@/lib/devices'
import { cn } from '@/lib/utils'

const RANGES: { value: MetricsRange; label: string; description: string }[] = [
  { value: '1h', label: '1H', description: 'Last hour · 1-minute samples' },
  { value: '24h', label: '24H', description: 'Last 24 hours · 5-minute samples' },
  { value: '7d', label: '7D', description: 'Last 7 days · 15-minute averages' },
  { value: '30d', label: '30D', description: 'Last 30 days · hourly averages' },
]

const config = {
  cpu: { label: 'CPU', color: 'var(--chart-1)' },
  mem: { label: 'Memory', color: 'var(--chart-3)' },
  disk: { label: 'Disk used', color: 'var(--chart-5)' },
  net_rx: { label: 'Received', color: 'var(--chart-2)' },
  net_tx: { label: 'Sent', color: 'var(--chart-4)' },
} satisfies ChartConfig

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

function MetricTooltip({
  active,
  payload,
  label,
  format,
}: {
  active?: boolean
  payload?: readonly TooltipItem[]
  label?: unknown
  format: (value: number) => string
}) {
  if (!active || !payload?.length) return null
  return (
    <div className="grid min-w-36 gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">{typeof label === 'number' ? fullTime.format(label * 1000) : null}</div>
      {payload.map((item) => {
        const key = String(item.dataKey) as keyof typeof config
        return (
          <div key={key} className="flex items-center gap-2">
            <span className="size-2.5 rounded-[2px]" style={{ background: item.color }} />
            <span className="flex-1 text-muted-foreground">{config[key]?.label ?? key}</span>
            <span className="font-mono font-medium tabular-nums">{typeof item.value === 'number' ? format(item.value) : '—'}</span>
          </div>
        )
      })}
    </div>
  )
}

function stats(points: MetricPoint[], key: 'cpu' | 'mem' | 'disk' | 'net_rx' | 'net_tx') {
  const values = points.map((point) => point[key]).filter((value): value is number => value !== null)
  if (values.length === 0) return { avg: null, max: null, last: null }
  return {
    avg: values.reduce((sum, value) => sum + value, 0) / values.length,
    max: Math.max(...values),
    last: values[values.length - 1],
  }
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-micro text-subtle-foreground">{label}</div>
      <div className={cn('tabular text-base font-semibold tracking-tight', tone)}>{value}</div>
    </div>
  )
}

function ChartCard({ title, icon, stats: statRow, children }: { title: string; icon: ReactNode; stats: ReactNode; children: ReactNode }) {
  return (
    <Card size="sm" className="gap-3">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <CardTitle className="flex items-center gap-2 text-sm [&_svg]:size-4 [&_svg]:text-subtle-foreground">
          {icon}
          {title}
        </CardTitle>
        <div className="flex gap-5">{statRow}</div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

const pct = (value: number | null) => (value === null ? '—' : `${value.toFixed(1)}%`)

export function PerformanceTab({ device }: { device: DeviceDetail }) {
  const [range, setRange] = useState<MetricsRange>('24h')
  const { data, isLoading, error, refetch } = useQuery(metricsQuery(device.id, range))
  const points = useMemo(() => data?.points ?? [], [data])
  const format = tickFormatter(range)
  const cpu = stats(points, 'cpu')
  const mem = stats(points, 'mem')
  const disk = stats(points, 'disk')
  const rx = stats(points, 'net_rx')
  const tx = stats(points, 'net_tx')
  const diskMin = Math.max(0, Math.floor(((disk.avg ?? 50) - 10) / 10) * 10)

  const axis = {
    dataKey: 'ts',
    type: 'number' as const,
    domain: ['dataMin', 'dataMax'] as [string, string],
    scale: 'time' as const,
    tickFormatter: format,
    tickLine: false,
    axisLine: false,
    tickMargin: 8,
    minTickGap: 48,
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-dense text-muted-foreground">{RANGES.find((item) => item.value === range)?.description}</p>
        <ToggleGroup value={[range]} onValueChange={(value: string[]) => value[0] && setRange(value[0] as MetricsRange)} aria-label="Time range">
          {RANGES.map((item) => (
            <ToggleGroupItem key={item.value} value={item.value} size="sm" className="font-mono text-[11.5px]">
              {item.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isLoading ? (
        <div className="grid gap-4 xl:grid-cols-2">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-72 rounded-xl" />
          ))}
        </div>
      ) : points.length === 0 ? (
        <EmptyState
          illustration="reports"
          title="No performance data in this range"
          description={device.status === 'pending' ? 'Metrics start flowing once the device is approved.' : 'The agent reports a sample every minute while connected.'}
        />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <ChartCard
            title="CPU & memory"
            icon={<Cpu />}
            stats={
              <>
                <Stat label="CPU avg" value={pct(cpu.avg)} />
                <Stat label="CPU peak" value={pct(cpu.max)} tone={(cpu.max ?? 0) >= 90 ? 'text-critical' : undefined} />
                <Stat label="Mem avg" value={pct(mem.avg)} />
              </>
            }
          >
            <ChartContainer config={config} className="aspect-auto h-56 w-full">
              <AreaChart data={points} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
                <defs>
                  <linearGradient id="perf-cpu" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-cpu)" stopOpacity={0.32} />
                    <stop offset="100%" stopColor="var(--color-cpu)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} strokeDasharray="3 4" />
                <XAxis {...axis} />
                <YAxis domain={[0, 100]} tickLine={false} axisLine={false} width={36} tickFormatter={(value: number) => `${value}%`} />
                <ChartTooltip content={(props) => <MetricTooltip active={props.active} payload={props.payload as readonly TooltipItem[]} label={props.label} format={(value) => `${value.toFixed(1)}%`} />} />
                <Area dataKey="mem" type="monotone" stroke="var(--color-mem)" fill="transparent" strokeWidth={1.75} dot={false} isAnimationActive={false} />
                <Area dataKey="cpu" type="monotone" stroke="var(--color-cpu)" fill="url(#perf-cpu)" strokeWidth={1.75} dot={false} isAnimationActive={false} />
              </AreaChart>
            </ChartContainer>
          </ChartCard>

          <ChartCard
            title="Network throughput"
            icon={<Network />}
            stats={
              <>
                <Stat label="In avg" value={formatBitrate(rx.avg)} />
                <Stat label="In peak" value={formatBitrate(rx.max)} />
                <Stat label="Out avg" value={formatBitrate(tx.avg)} />
              </>
            }
          >
            <ChartContainer config={config} className="aspect-auto h-56 w-full">
              <AreaChart data={points} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
                <defs>
                  <linearGradient id="perf-rx" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-net_rx)" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="var(--color-net_rx)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} strokeDasharray="3 4" />
                <XAxis {...axis} />
                <YAxis tickLine={false} axisLine={false} width={64} tickFormatter={(value: number) => formatBitrate(value)} />
                <ChartTooltip content={(props) => <MetricTooltip active={props.active} payload={props.payload as readonly TooltipItem[]} label={props.label} format={formatBitrate} />} />
                <Area dataKey="net_rx" type="monotone" stroke="var(--color-net_rx)" fill="url(#perf-rx)" strokeWidth={1.75} dot={false} isAnimationActive={false} />
                <Area dataKey="net_tx" type="monotone" stroke="var(--color-net_tx)" fill="transparent" strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
              </AreaChart>
            </ChartContainer>
          </ChartCard>

          <ChartCard
            title="Disk usage"
            icon={<HardDrive />}
            stats={
              <>
                <Stat label="Now" value={pct(disk.last)} tone={(disk.last ?? 0) >= 90 ? 'text-critical' : (disk.last ?? 0) >= 80 ? 'text-warning' : undefined} />
                <Stat label="Peak" value={pct(disk.max)} />
              </>
            }
          >
            <ChartContainer config={config} className="aspect-auto h-56 w-full">
              <LineChart data={points} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 4" />
                <XAxis {...axis} />
                <YAxis domain={[diskMin, 100]} tickLine={false} axisLine={false} width={36} tickFormatter={(value: number) => `${value}%`} />
                <ChartTooltip content={(props) => <MetricTooltip active={props.active} payload={props.payload as readonly TooltipItem[]} label={props.label} format={(value) => `${value.toFixed(1)}%`} />} />
                <Line dataKey="disk" type="monotone" stroke="var(--color-disk)" strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ChartContainer>
          </ChartCard>

          <Card size="sm" className="gap-3">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm [&_svg]:size-4 [&_svg]:text-subtle-foreground">
                <Activity />
                Range summary
              </CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
                <Stat label="Samples" value={points.length.toLocaleString()} />
                <Stat label="Resolution" value={data?.resolution === 'raw' ? 'Raw' : data?.resolution ?? '—'} />
                <Stat label="Memory peak" value={pct(mem.max)} tone={(mem.max ?? 0) >= 95 ? 'text-critical' : undefined} />
                <Stat label="Out peak" value={formatBitrate(tx.max)} />
                <Stat label="CPU now" value={pct(cpu.last)} />
                <Stat label="Memory now" value={pct(mem.last)} />
              </dl>
              <p className="mt-4 text-micro text-subtle-foreground">
                Longer ranges show averaged rollups, so short spikes appear smoothed out.
              </p>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
