/* Small presentational building blocks shared by the device list, cockpit and deploy screens. */
import type { ReactNode } from 'react'
import { Box, CircleHelp, Laptop, Monitor, Server } from 'lucide-react'
import { OsIcon } from '@/components/common/os-icon'
import { StatusDot } from '@/components/common/status-dot'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { Device, DeviceType, OsFamily } from '@/lib/api/types'
import { DEVICE_TYPE_LABEL, OS_LABEL, formatPct, usageTone } from '@/lib/devices'
import { formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { deviceStatusLabel, deviceTone } from './device-status'

// ------------------------------------------------------------------ OS

export { OsIcon }

/** OS glyph in a soft tile, used by headers and cards. */
export function OsTile({ family, size = 'md', className }: { family: OsFamily; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const sizes = { sm: 'size-7 rounded-lg [&_svg]:size-3.5', md: 'size-9 rounded-xl [&_svg]:size-4', lg: 'size-14 rounded-2xl [&_svg]:size-6' }
  return (
    <span
      aria-label={OS_LABEL[family]}
      role="img"
      className={cn(
        'inline-flex shrink-0 items-center justify-center bg-surface-2 shadow-raised ring-1 ring-border',
        sizes[size],
        className,
      )}
    >
      <OsIcon family={family} />
    </span>
  )
}

const TYPE_ICON: Record<DeviceType | 'unknown', typeof Monitor> = {
  workstation: Monitor,
  laptop: Laptop,
  server: Server,
  virtual: Box,
  unknown: CircleHelp,
}

export function DeviceTypeIcon({ type, className }: { type: DeviceType | null; className?: string }) {
  const Icon = TYPE_ICON[type ?? 'unknown']
  return <Icon aria-label={type ? DEVICE_TYPE_LABEL[type] : 'Unknown type'} className={cn('size-3.5 shrink-0 text-subtle-foreground', className)} />
}

// ------------------------------------------------------------------ status

export function DeviceStatusDot({ device, className }: { device: Pick<Device, 'status' | 'online' | 'last_seen_at'>; className?: string }) {
  const tone = deviceTone(device)
  const label = deviceStatusLabel(device)
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={cn('inline-flex size-4 items-center justify-center', className)} />}>
        <StatusDot tone={tone} pulse={tone === 'live'} label={label} />
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {!device.online && device.last_seen_at && device.status === 'active' && ` · last seen ${formatRelative(device.last_seen_at)}`}
      </TooltipContent>
    </Tooltip>
  )
}

/** "Online" beacon pill for headers. */
export function ConnectionPill({ device }: { device: Pick<Device, 'status' | 'online' | 'last_seen_at'> }) {
  const tone = deviceTone(device)
  const label = deviceStatusLabel(device)
  const styles = {
    live: 'bg-live/12 text-live ring-live/25',
    offline: 'bg-surface-3 text-muted-foreground ring-border-strong',
    info: 'bg-info/12 text-info ring-info/25',
    warning: 'bg-warning/12 text-warning ring-warning/25',
    neutral: 'bg-surface-3 text-subtle-foreground ring-border',
  }
  return (
    <span className={cn('inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-micro font-semibold tracking-wide uppercase ring-1', styles[tone])}>
      <StatusDot tone={tone} pulse={tone === 'live'} />
      {label}
      {tone === 'offline' && device.last_seen_at && (
        <span className="font-normal tracking-normal normal-case opacity-80">· {formatRelative(device.last_seen_at)}</span>
      )}
    </span>
  )
}

// ------------------------------------------------------------------ meters

const BAR_TONE = { live: 'bg-live', warning: 'bg-warning', critical: 'bg-critical', neutral: 'bg-transparent' }
const TEXT_TONE = { live: 'text-foreground', warning: 'text-warning', critical: 'text-critical', neutral: 'text-subtle-foreground' }

/** A thin usage bar with an optional label; tone escalates at 75% and 90%. */
export function UsageBar({ value, className, height = 'h-1' }: { value: number | null | undefined; className?: string; height?: string }) {
  const tone = usageTone(value)
  return (
    <span className={cn('relative block w-full overflow-hidden rounded-full bg-surface-4', height, className)} aria-hidden="true">
      {value != null && (
        <span
          className={cn('absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-(--ease-snappy)', BAR_TONE[tone])}
          style={{ width: `${Math.max(2, Math.min(100, value))}%` }}
        />
      )}
    </span>
  )
}

/** Compact CPU / RAM / disk triplet for grid rows. */
export function ResourceMeters({ device }: { device: Pick<Device, 'cpu_pct' | 'mem_pct' | 'disk_pct' | 'online'> }) {
  const items: [string, number | null][] = [
    ['CPU', device.cpu_pct],
    ['RAM', device.mem_pct],
    ['Disk', device.disk_pct],
  ]
  return (
    <div className={cn('grid w-[168px] grid-cols-3 gap-2', !device.online && 'opacity-55')}>
      {items.map(([label, value]) => {
        const tone = usageTone(value)
        return (
          <Tooltip key={label}>
            <TooltipTrigger render={<div className="grid gap-[3px]" />}>
              <span className="flex items-baseline justify-between text-[10px] leading-none">
                <span className="text-subtle-foreground">{label}</span>
                <span className={cn('tabular font-medium', value == null ? 'text-subtle-foreground' : TEXT_TONE[tone])}>
                  {value == null ? '—' : Math.round(value)}
                </span>
              </span>
              <UsageBar value={value} height="h-[3px]" />
            </TooltipTrigger>
            <TooltipContent>
              {label} {formatPct(value)}
              {!device.online && ' (last reported)'}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}

// ------------------------------------------------------------------ tags

export function TagList({ tags, max = 3, className }: { tags: string[]; max?: number; className?: string }) {
  if (tags.length === 0) return <span className="text-subtle-foreground">—</span>
  const shown = tags.slice(0, max)
  const rest = tags.length - shown.length
  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      {shown.map((tag) => (
        <span key={tag} className="inline-flex h-5 items-center rounded-[5px] bg-surface-3 px-1.5 font-mono text-[10.5px] text-secondary-foreground ring-1 ring-border">
          {tag}
        </span>
      ))}
      {rest > 0 && (
        <Tooltip>
          <TooltipTrigger render={<span className="tabular text-micro text-subtle-foreground" />}>+{rest}</TooltipTrigger>
          <TooltipContent>{tags.slice(max).join(', ')}</TooltipContent>
        </Tooltip>
      )}
    </span>
  )
}

// ------------------------------------------------------------------ sparkline

/** Minimal SVG sparkline (no chart runtime); values are 0–100 unless `max` is given. */
export function Sparkline({
  values,
  max,
  className,
  strokeClassName = 'stroke-live',
  fillClassName = 'fill-live/12',
  height = 36,
}: {
  values: number[]
  max?: number
  className?: string
  strokeClassName?: string
  fillClassName?: string
  height?: number
}) {
  const width = 120
  if (values.length < 2) {
    return <svg viewBox={`0 0 ${width} ${height}`} className={cn('w-full', className)} style={{ height }} aria-hidden="true" />
  }
  const top = max ?? 100
  const ceiling = Math.max(top, ...values) || 1
  const step = width / (values.length - 1)
  const points = values.map((value, index) => [index * step, height - 2 - (Math.max(0, value) / ceiling) * (height - 4)] as const)
  const line = points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = `${line} L${width},${height} L0,${height} Z`
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className={cn('w-full overflow-visible', className)} style={{ height }} aria-hidden="true">
      <path d={area} className={cn('stroke-none', fillClassName)} />
      <path d={line} className={cn('fill-none', strokeClassName)} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  )
}

// ------------------------------------------------------------------ misc

/** Check / cross row for security and readiness lists. */
export function CheckRow({
  ok,
  label,
  detail,
  warn = false,
}: {
  ok: boolean | null | undefined
  label: ReactNode
  detail?: ReactNode
  /** Render a failing check as a warning instead of critical. */
  warn?: boolean
}) {
  const state = ok === null || ok === undefined ? 'unknown' : ok ? 'ok' : warn ? 'warn' : 'bad'
  const styles = {
    ok: 'bg-live/12 text-live ring-live/25',
    warn: 'bg-warning/12 text-warning ring-warning/25',
    bad: 'bg-critical/12 text-critical ring-critical/25',
    unknown: 'bg-surface-3 text-subtle-foreground ring-border',
  }
  const glyph = { ok: '✓', warn: '!', bad: '✕', unknown: '?' }
  return (
    <li className="flex items-center gap-3 py-2">
      <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ring-1', styles[state])} aria-hidden="true">
        {glyph[state]}
      </span>
      <span className="min-w-0 flex-1 text-dense">{label}</span>
      {detail && <span className="shrink-0 text-right text-micro text-muted-foreground">{detail}</span>}
      <span className="sr-only">{state === 'ok' ? 'passing' : state === 'unknown' ? 'unknown' : 'failing'}</span>
    </li>
  )
}
