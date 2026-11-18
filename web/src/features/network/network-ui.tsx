/* Presentational pieces shared by the network discovery and SNMP screens. */
import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { OsIcon } from '@/components/common/os-icon'
import { SimpleSelect } from '@/components/common/simple-select'
import { StatusDot } from '@/components/common/status-dot'
import type { AssetType, ScanMethods, SiteProbe, SnmpDeviceStatus } from '@/lib/api/types'
import { ASSET_TYPE_ICON, ASSET_TYPE_LABEL, PORT_NAME } from '@/lib/network/assets'
import { SNMP_STATUS_LABEL, SNMP_STATUS_TONE } from '@/lib/network/snmp'
import { cn } from '@/lib/utils'
import { siteOptions, type SiteOption } from './use-network'

const TYPE_TONE: Record<AssetType, string> = {
  printer: 'bg-chart-5/12 text-chart-5 ring-chart-5/25',
  switch: 'bg-info/12 text-info ring-info/25',
  router: 'bg-info/12 text-info ring-info/25',
  ap: 'bg-info/12 text-info ring-info/25',
  nas: 'bg-chart-3/12 text-chart-3 ring-chart-3/25',
  camera: 'bg-chart-4/12 text-chart-4 ring-chart-4/25',
  phone: 'bg-live/12 text-live ring-live/25',
  ups: 'bg-warning/12 text-warning ring-warning/25',
  windows: 'bg-surface-3 text-secondary-foreground ring-border',
  linux: 'bg-surface-3 text-secondary-foreground ring-border',
  mac: 'bg-surface-3 text-secondary-foreground ring-border',
  unknown: 'bg-surface-3 text-subtle-foreground ring-border',
}

/** A small tinted tile with the asset type's icon (OS glyphs for computers). */
export function AssetTypeTile({ type, size = 'md', className }: { type: AssetType; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const Icon = ASSET_TYPE_ICON[type]
  const box = size === 'sm' ? 'size-6 rounded-md [&_svg]:size-3.5' : size === 'lg' ? 'size-10 rounded-xl [&_svg]:size-5' : 'size-7 rounded-lg [&_svg]:size-4'
  const os = type === 'windows' ? 'windows' : type === 'linux' ? 'linux' : type === 'mac' ? 'macos' : null
  return (
    <span className={cn('inline-flex shrink-0 items-center justify-center ring-1', box, TYPE_TONE[type], className)} title={ASSET_TYPE_LABEL[type]} aria-label={ASSET_TYPE_LABEL[type]} role="img">
      {os ? <OsIcon family={os} className={size === 'lg' ? 'size-4.5' : 'size-3.5'} /> : <Icon />}
    </span>
  )
}

export function SnmpStatusBadge({ status, enabled = true }: { status: SnmpDeviceStatus; enabled?: boolean }) {
  if (!enabled) return <Badge variant="secondary">Paused</Badge>
  const tone = SNMP_STATUS_TONE[status]
  return (
    <Badge variant={tone === 'live' ? 'success' : tone}>
      <span className={cn('inline-flex size-1.5 rounded-full', tone === 'live' ? 'bg-success' : tone === 'critical' ? 'bg-critical' : tone === 'warning' ? 'bg-warning' : 'animate-pulse bg-info')} />
      {status === 'pending' ? 'Pending' : SNMP_STATUS_LABEL[status]}
    </Badge>
  )
}

export function SnmpStatusDot({ status, enabled = true }: { status: SnmpDeviceStatus; enabled?: boolean }) {
  if (!enabled) return <StatusDot tone="offline" label="Paused" />
  const tone = SNMP_STATUS_TONE[status]
  return <StatusDot tone={tone} pulse={status === 'unreachable'} label={SNMP_STATUS_LABEL[status]} />
}

/** The site's probe: host name with its connection state, or a quiet "No probe". */
export function ProbeBadge({ probe, className }: { probe: SiteProbe | undefined | null; className?: string }) {
  if (!probe?.device_id) return <span className={cn('text-dense text-subtle-foreground', className)}>No probe</span>
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5 text-dense', className)}>
      <StatusDot tone={probe.online ? 'live' : 'offline'} label={probe.online ? 'Online' : 'Offline'} />
      {probe.os_family && <OsIcon family={probe.os_family} />}
      <span className="truncate font-medium">{probe.hostname}</span>
      {!probe.online && <span className="text-micro text-subtle-foreground">offline</span>}
    </span>
  )
}

export function PortChips({ ports, max = 4 }: { ports: number[]; max?: number }) {
  if (ports.length === 0) return <span className="text-subtle-foreground">—</span>
  const shown = ports.slice(0, max)
  return (
    <span className="inline-flex items-center gap-1">
      {shown.map((port) => (
        <Tooltip key={port}>
          <TooltipTrigger render={<span className="tabular inline-flex h-5 items-center rounded-[5px] bg-surface-3 px-1.5 font-mono text-[10.5px] text-secondary-foreground ring-1 ring-border" />}>
            {port}
          </TooltipTrigger>
          <TooltipContent>{PORT_NAME[port] ?? `TCP ${port}`}</TooltipContent>
        </Tooltip>
      ))}
      {ports.length > max && <span className="text-micro text-subtle-foreground">+{ports.length - max}</span>}
    </span>
  )
}

/** A tiny line chart for table cells and panels. */
export function MiniSparkline({ values, className, tone = 'var(--chart-2)' }: { values: number[]; className?: string; tone?: string }) {
  if (values.length < 2) return <span className={cn('inline-block h-5 w-20', className)} />
  const max = Math.max(...values, 1)
  const min = Math.min(...values, 0)
  const span = max - min || 1
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 100},${28 - ((value - min) / span) * 26}`).join(' ')
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className={cn('h-5 w-20', className)} aria-hidden="true">
      <polyline points={`0,30 ${points} 100,30`} fill={tone} fillOpacity={0.12} stroke="none" />
      <polyline points={points} fill="none" stroke={tone} strokeWidth={1.6} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  )
}

export function SiteSelect({
  value,
  onChange,
  sites,
  any = 'All sites',
  className,
  disabled,
  id,
}: {
  value: string
  onChange: (value: string) => void
  sites: SiteOption[]
  any?: string | null
  className?: string
  disabled?: boolean
  id?: string
}) {
  return (
    <SimpleSelect
      id={id}
      size="sm"
      className={cn('w-full sm:w-56', className)}
      ariaLabel="Site"
      value={value}
      disabled={disabled}
      onValueChange={onChange}
      placeholder="Choose a site"
      options={siteOptions(sites, { any: any ?? undefined })}
    />
  )
}

const METHOD_LABEL: { key: keyof Omit<ScanMethods, 'tcp_ports'>; label: string }[] = [
  { key: 'icmp', label: 'ICMP' },
  { key: 'arp', label: 'ARP' },
  { key: 'snmp', label: 'SNMP' },
  { key: 'mdns', label: 'mDNS' },
  { key: 'netbios', label: 'NetBIOS' },
]

export function MethodChips({ methods }: { methods: ScanMethods }) {
  const on = METHOD_LABEL.filter((item) => methods[item.key])
  return (
    <span className="flex flex-wrap items-center gap-1">
      {on.map((item) => (
        <span key={item.key} className="inline-flex h-5 items-center rounded-[5px] bg-surface-3 px-1.5 text-[10.5px] font-medium text-secondary-foreground ring-1 ring-border">
          {item.label}
        </span>
      ))}
      {methods.tcp_ports.length > 0 && (
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex h-5 items-center rounded-[5px] bg-surface-3 px-1.5 text-[10.5px] font-medium text-secondary-foreground ring-1 ring-border" />}>
            TCP · {methods.tcp_ports.length} {methods.tcp_ports.length === 1 ? 'port' : 'ports'}
          </TooltipTrigger>
          <TooltipContent className="max-w-64 font-mono text-[11px]">{methods.tcp_ports.join(', ')}</TooltipContent>
        </Tooltip>
      )}
    </span>
  )
}

export function SectionCard({ title, description, icon, actions, children, className }: { title: ReactNode; description?: ReactNode; icon?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('min-w-0 overflow-hidden rounded-xl bg-card shadow-card', className)}>
      <header className="flex flex-wrap items-start gap-3 border-b border-border px-4 py-3">
        {icon && <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-muted-foreground ring-1 ring-border [&_svg]:size-4">{icon}</span>}
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          {description && <p className="text-micro text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </header>
      {children}
    </section>
  )
}
