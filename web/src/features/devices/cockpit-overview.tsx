import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowUpRight, CircuitBoard, Gauge, HardDrive, History, Info, Network, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { HealthRing } from '@/components/common/health-ring'
import { KeyValue, Mono, RelativeTime } from '@/components/common/misc'
import { StatusDot } from '@/components/common/status-dot'
import { metricsQuery } from '@/lib/api/queries'
import type { DeviceDetail, InventoryResponse, LiveSample } from '@/lib/api/types'
import { DEVICE_TYPE_LABEL, formatBitrate } from '@/lib/devices'
import { formatBytes, formatDate, formatDuration } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { CockpitTab } from './cockpit-tabs'
import { securityChecks } from './security-checks'
import { RecentTimeline } from './cockpit-timeline'
import { CheckRow, Sparkline, UsageBar } from './device-ui'
import { DeviceCustomFieldsCard, DeviceGroupsCard } from '@/features/automation/device-automation'
import { DesktopScreenshotCard } from './desktop/desktop-screenshot-card'

interface LiveState {
  samples: LiveSample[]
  latest: LiveSample | null
  live: boolean
}

function BentoCard({
  title,
  icon,
  action,
  children,
  className,
}: {
  title: ReactNode
  icon: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <Card size="sm" className={cn('gap-3', className)}>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-sm [&_svg]:size-4 [&_svg]:text-subtle-foreground">
          {icon}
          {title}
        </CardTitle>
        {action}
      </CardHeader>
      <CardContent className="min-w-0">{children}</CardContent>
    </Card>
  )
}

function TabLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={onClick}>
      {children}
      <ArrowUpRight data-icon="inline-end" />
    </Button>
  )
}

function TelemetryTile({
  label,
  value,
  sub,
  values,
  max,
  stroke,
  fill,
}: {
  label: string
  value: string
  sub?: ReactNode
  values: number[]
  max?: number
  stroke: string
  fill: string
}) {
  return (
    <div className="grid min-w-0 gap-2 rounded-lg bg-surface-2/60 p-3 ring-1 ring-border/60">
      <div className="flex items-baseline justify-between gap-2">
        <span className="shrink-0 text-micro font-medium text-muted-foreground">{label}</span>
        {sub && <span className="truncate text-[10.5px] text-subtle-foreground">{sub}</span>}
      </div>
      <div className="font-display tabular text-[22px] leading-none font-semibold tracking-tight">{value}</div>
      <Sparkline values={values} max={max} strokeClassName={stroke} fillClassName={fill} height={34} />
    </div>
  )
}

function LiveTelemetry({ device, live }: { device: DeviceDetail; live: LiveState }) {
  const { data } = useQuery({ ...metricsQuery(device.id, '1h'), enabled: device.status === 'active' })
  const history = (data?.points ?? []).slice(-40)
  const useLive = live.samples.length >= 6
  const series = (pick: (sample: LiveSample) => number, fallback: (index: number) => number | null) =>
    useLive ? live.samples.slice(-60).map(pick) : history.map((_, index) => fallback(index) ?? 0)

  const latest = live.latest
  const cpu = latest?.cpu ?? device.cpu_pct
  const mem = latest?.mem ?? device.mem_pct
  const lastPoint = history.at(-1)
  const rx = latest?.net_rx_bps ?? lastPoint?.net_rx ?? null
  const tx = latest?.net_tx_bps ?? lastPoint?.net_tx ?? null

  return (
    <BentoCard
      title="Live telemetry"
      icon={<Gauge />}
      className="xl:col-span-2"
      action={
        <span className="flex items-center gap-1.5 text-micro font-medium tracking-wide text-subtle-foreground uppercase">
          <StatusDot tone={live.live ? 'live' : 'offline'} pulse={live.live} />
          {live.live ? 'Streaming · 2s' : device.online ? 'Connecting…' : 'Offline · last known'}
        </span>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <TelemetryTile
          label="CPU"
          value={cpu == null ? '—' : `${Math.round(cpu)}%`}
          values={series((sample) => sample.cpu, (index) => history[index].cpu)}
          stroke="stroke-chart-1"
          fill="fill-chart-1/15"
        />
        <TelemetryTile
          label="Memory"
          value={mem == null ? '—' : `${Math.round(mem)}%`}
          values={series((sample) => sample.mem, (index) => history[index].mem)}
          stroke="stroke-chart-3"
          fill="fill-chart-3/15"
        />
        <TelemetryTile
          label="Network in"
          value={formatBitrate(rx)}
          sub={tx != null ? `out ${formatBitrate(tx)}` : undefined}
          values={series((sample) => sample.net_rx_bps, (index) => history[index].net_rx)}
          max={1}
          stroke="stroke-chart-2"
          fill="fill-chart-2/15"
        />
        <TelemetryTile
          label="Disk I/O"
          value={latest ? `${formatBytes(latest.disk_read_bps + latest.disk_write_bps)}/s` : '—'}
          sub={latest ? `R ${formatBytes(latest.disk_read_bps)} · W ${formatBytes(latest.disk_write_bps)}` : 'live only'}
          values={useLive ? live.samples.slice(-60).map((sample) => sample.disk_read_bps + sample.disk_write_bps) : []}
          max={1}
          stroke="stroke-chart-5"
          fill="fill-chart-5/15"
        />
      </div>
    </BentoCard>
  )
}

function HealthCard({ device, inventory, onTab }: { device: DeviceDetail; inventory: InventoryResponse | undefined; onTab: (tab: CockpitTab) => void }) {
  const security = inventory?.sections.security?.data
  const checks = securityChecks(device, security, inventory?.sections.system?.data.pending_reboot)
  const failing = checks.filter((check) => check.ok === false)
  const reasons = device.health.reasons
  return (
    <BentoCard title="Health" icon={<ShieldCheck />} action={<TabLink onClick={() => onTab('security')}>Security</TabLink>}>
      <div className="flex items-center gap-4">
        <HealthRing score={device.status === 'active' ? device.health.score : null} size={68} strokeWidth={5} className="[&_span]:text-base" />
        <div className="min-w-0">
          <p className="text-dense font-medium">
            {device.status !== 'active'
              ? 'Scored once the device is active'
              : reasons.length === 0
                ? 'All health checks passing'
                : `${reasons.length} ${reasons.length === 1 ? 'issue' : 'issues'} lowering the score`}
          </p>
          <p className="mt-0.5 text-micro text-muted-foreground">
            {checks.length > 0 ? `${checks.length - failing.length} of ${checks.length} security checks passing` : 'Security posture not reported yet'}
          </p>
        </div>
      </div>
      {reasons.length > 0 && (
        <ul className="mt-3 grid gap-1.5">
          {reasons.map((reason) => (
            <li key={reason.label} className="flex items-center gap-2 rounded-md bg-surface-2/70 px-2.5 py-1.5 text-dense">
              <span className="min-w-0 flex-1 truncate">{reason.label}</span>
              <span className="tabular font-mono text-[11px] text-critical">−{reason.penalty}</span>
            </li>
          ))}
        </ul>
      )}
    </BentoCard>
  )
}

function SystemCard({ device, inventory }: { device: DeviceDetail; inventory: InventoryResponse | undefined }) {
  const system = inventory?.sections.system?.data
  return (
    <BentoCard title="System" icon={<Info />}>
      <dl>
        <KeyValue label="Operating system">{device.os_name}</KeyValue>
        <KeyValue label="Version">
          <span className="tabular">
            {system?.os?.display_version ? `${system.os.display_version} · ` : ''}
            {device.os_version}
            {system?.os?.build && device.os_family !== 'windows' ? ` (${system.os.build})` : ''}
          </span>
        </KeyValue>
        {system?.os?.kernel && device.os_family !== 'windows' && (
          <KeyValue label="Kernel">
            <span className="font-mono text-[11.5px]">{system.os.kernel}</span>
          </KeyValue>
        )}
        <KeyValue label="Architecture">
          <span className="font-mono text-[11.5px]">{device.arch}</span>
        </KeyValue>
        <KeyValue label="Domain">{device.domain ?? (system?.entra_joined ? 'Microsoft Entra joined' : system?.workgroup) ?? '—'}</KeyValue>
        <KeyValue label="Uptime">{device.uptime_s ? formatDuration(device.uptime_s) : '—'}</KeyValue>
        <KeyValue label="Last boot">{system?.last_boot ? <RelativeTime value={system.last_boot} /> : '—'}</KeyValue>
        <KeyValue label="Enrolled">{formatDate(device.enrolled_at)}</KeyValue>
      </dl>
    </BentoCard>
  )
}

function HardwareCard({ device, inventory, onTab }: { device: DeviceDetail; inventory: InventoryResponse | undefined; onTab: (tab: CockpitTab) => void }) {
  const hw = inventory?.sections.hardware?.data
  return (
    <BentoCard title="Hardware" icon={<CircuitBoard />} action={<TabLink onClick={() => onTab('hardware')}>Details</TabLink>}>
      <dl>
        <KeyValue label="Model">{[device.manufacturer, device.model].filter(Boolean).join(' ') || '—'}</KeyValue>
        <KeyValue label="Type">{device.device_type ? DEVICE_TYPE_LABEL[device.device_type] : '—'}</KeyValue>
        <KeyValue label="Processor">
          {hw?.cpu?.model ? (
            <span>
              {hw.cpu.model}
              {hw.cpu.cores ? <span className="text-muted-foreground"> · {hw.cpu.cores} cores</span> : null}
            </span>
          ) : (
            '—'
          )}
        </KeyValue>
        <KeyValue label="Memory">{hw?.memory?.total_bytes ? formatBytes(hw.memory.total_bytes) : '—'}</KeyValue>
        <KeyValue label="Graphics">{hw?.gpus?.[0]?.name ?? '—'}</KeyValue>
        <KeyValue label="Serial">{device.serial ? <Mono>{device.serial}</Mono> : '—'}</KeyValue>
      </dl>
    </BentoCard>
  )
}

function StorageCard({ inventory, onTab }: { inventory: InventoryResponse | undefined; onTab: (tab: CockpitTab) => void }) {
  const volumes = inventory?.sections.storage?.data.volumes ?? []
  return (
    <BentoCard title="Storage" icon={<HardDrive />} action={<TabLink onClick={() => onTab('storage')}>Volumes</TabLink>}>
      {volumes.length === 0 ? (
        <p className="text-dense text-muted-foreground">No volumes reported yet.</p>
      ) : (
        <ul className="grid gap-3">
          {volumes.slice(0, 4).map((volume, index) => {
            const total = volume.total_bytes ?? 0
            const used = total - (volume.free_bytes ?? 0)
            const pct = total ? (used / total) * 100 : null
            return (
              <li key={`${volume.mount}-${index}`} className="grid gap-1.5">
                <div className="flex items-baseline justify-between gap-2 text-dense">
                  <span className="font-mono text-[12px] font-medium">{volume.mount}</span>
                  <span className="tabular text-micro text-muted-foreground">
                    {formatBytes(volume.free_bytes ?? 0)} free of {formatBytes(total)}
                  </span>
                </div>
                <UsageBar value={pct} height="h-2" />
              </li>
            )
          })}
        </ul>
      )}
    </BentoCard>
  )
}

function NetworkCard({ device, inventory, onTab }: { device: DeviceDetail; inventory: InventoryResponse | undefined; onTab: (tab: CockpitTab) => void }) {
  const net = inventory?.sections.network?.data
  const primary = net?.interfaces?.find((iface) => iface.ipv4?.length) ?? net?.interfaces?.[0]
  const adapter = net?.adapters?.find((item) => item.mac === primary?.mac)
  const gateway = adapter?.gateways?.[0] ?? net?.gateways?.[0]
  const dns = adapter?.dns_servers ?? net?.dns_servers
  return (
    <BentoCard title="Network" icon={<Network />} action={<TabLink onClick={() => onTab('network')}>Interfaces</TabLink>}>
      <dl>
        <KeyValue label="IP address">{device.last_ip ? <Mono>{device.last_ip}</Mono> : '—'}</KeyValue>
        <KeyValue label="Interface">{primary?.name ?? '—'}</KeyValue>
        <KeyValue label="MAC">{primary?.mac ? <span className="font-mono text-[11.5px]">{primary.mac}</span> : '—'}</KeyValue>
        <KeyValue label="Gateway">{gateway ? <span className="font-mono text-[11.5px]">{gateway}</span> : '—'}</KeyValue>
        <KeyValue label="DNS">{dns?.length ? <span className="font-mono text-[11.5px]">{dns.join(', ')}</span> : '—'}</KeyValue>
        {net?.wifi?.ssid && (
          <KeyValue label="Wi-Fi">
            {net.wifi.ssid} <span className="text-muted-foreground">· {net.wifi.signal}</span>
          </KeyValue>
        )}
      </dl>
    </BentoCard>
  )
}

function PostureCard({ device, inventory }: { device: DeviceDetail; inventory: InventoryResponse | undefined }) {
  const checks = securityChecks(device, inventory?.sections.security?.data, inventory?.sections.system?.data.pending_reboot).slice(0, 6)
  return (
    <BentoCard title="Security checklist" icon={<ShieldCheck />}>
      {checks.length === 0 ? (
        <p className="text-dense text-muted-foreground">Security posture not reported yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {checks.map((check) => (
            <CheckRow key={check.key} ok={check.ok} label={check.label} detail={check.detail} warn={check.warn} />
          ))}
        </ul>
      )}
    </BentoCard>
  )
}

export function OverviewTab({
  device,
  inventory,
  inventoryLoading,
  live,
  onTab,
}: {
  device: DeviceDetail
  inventory: InventoryResponse | undefined
  inventoryLoading: boolean
  live: LiveState
  onTab: (tab: CockpitTab) => void
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
      {device.status === 'active' ? <LiveTelemetry device={device} live={live} /> : null}
      <HealthCard device={device} inventory={inventory} onTab={onTab} />
      <DesktopScreenshotCard device={device} onOpenDesktop={() => onTab('desktop')} />
      {inventoryLoading ? (
        Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="h-56 rounded-xl" />)
      ) : (
        <>
          <SystemCard device={device} inventory={inventory} />
          <HardwareCard device={device} inventory={inventory} onTab={onTab} />
          <StorageCard inventory={inventory} onTab={onTab} />
          <PostureCard device={device} inventory={inventory} />
          <NetworkCard device={device} inventory={inventory} onTab={onTab} />
        </>
      )}
      <DeviceCustomFieldsCard device={device} />
      <DeviceGroupsCard device={device} />
      <BentoCard title="Recent activity" icon={<History />} className="lg:col-span-2 xl:col-span-1">
        <RecentTimeline deviceId={device.id} onShowAll={() => onTab('timeline')} />
      </BentoCard>
    </div>
  )
}
