/* Shared visual vocabulary for Phase 6: severity, check states, alert status, sparklines and icons. */
import { useId } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  CircleCheck,
  CircleDashed,
  CircleHelp,
  Clock,
  FileText,
  Moon,
  OctagonAlert,
  RefreshCw,
  TriangleExclamationPoint,
  UserRound,
  Wrench,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type {
  Alert,
  AlertRemediation,
  AlertSeverity,
  CheckState,
  NotificationChannelKind,
  NotificationDeliveryStatus,
} from '@/lib/api/types'
import { formatDateTime, formatRelative } from '@/lib/format'
import {
  CHECK_STATE_LABEL,
  DELIVERY_STATUS_LABEL,
  REMEDIATION_LABEL,
  SEVERITY_LABEL,
} from '@/lib/monitoring/labels'
import { cn } from '@/lib/utils'
import { CHANNEL_KIND_ICON, CHECK_TYPE_ICON, SEVERITY_STYLE } from './monitoring-styles'

// ------------------------------------------------------------------ severity

export function SeverityIcon({ severity, className }: { severity: AlertSeverity; className?: string }) {
  const Icon = SEVERITY_STYLE[severity].icon
  return <Icon aria-hidden="true" className={cn('size-4 shrink-0', SEVERITY_STYLE[severity].text, className)} />
}

/** A square, tinted severity tile for list rows and headers. */
export function SeverityTile({ severity, size = 'md', className }: { severity: AlertSeverity; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const Icon = SEVERITY_STYLE[severity].icon
  const sizes = { sm: 'size-6 rounded-md [&_svg]:size-3.5', md: 'size-8 rounded-lg [&_svg]:size-4', lg: 'size-10 rounded-xl [&_svg]:size-5' }
  return (
    <span
      className={cn('flex shrink-0 items-center justify-center', SEVERITY_STYLE[severity].soft, sizes[size], className)}
      role="img"
      aria-label={SEVERITY_LABEL[severity]}
    >
      <Icon />
    </span>
  )
}

export function SeverityBadge({ severity, className }: { severity: AlertSeverity; className?: string }) {
  const Icon = SEVERITY_STYLE[severity].icon
  return (
    <Badge variant={SEVERITY_STYLE[severity].variant} className={className}>
      <Icon />
      {SEVERITY_LABEL[severity]}
    </Badge>
  )
}

// ------------------------------------------------------------------ check state

const STATE_STYLE: Record<CheckState | 'pending', { icon: LucideIcon; className: string }> = {
  ok: { icon: CircleCheck, className: 'bg-success/12 text-success ring-success/25' },
  warning: { icon: TriangleExclamationPoint, className: 'bg-warning/14 text-warning ring-warning/30' },
  critical: { icon: OctagonAlert, className: 'bg-critical/12 text-critical ring-critical/30' },
  unknown: { icon: CircleHelp, className: 'bg-surface-3 text-muted-foreground ring-border-strong' },
  pending: { icon: CircleDashed, className: 'bg-surface-2 text-subtle-foreground ring-border' },
}

/** State pill for a check; `null` means the agent has not reported it yet. */
export function CheckStateChip({ state, className }: { state: CheckState | null; className?: string }) {
  const style = STATE_STYLE[state ?? 'pending']
  const Icon = style.icon
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 pr-2 text-micro font-medium ring-1 ring-inset [&_svg]:size-3',
        style.className,
        className,
      )}
    >
      <Icon aria-hidden="true" />
      {state ? CHECK_STATE_LABEL[state] : 'Waiting'}
    </span>
  )
}

const STATE_COLOR: Record<CheckState, string> = {
  ok: 'var(--success)',
  warning: 'var(--warning)',
  critical: 'var(--critical)',
  unknown: 'var(--subtle-foreground)',
}

// ------------------------------------------------------------------ sparkline

/**
 * A small inline trend line. Needs at least two points; with one it draws a flat line. The last point is
 * marked so the current value reads at a glance.
 */
export function Sparkline({
  values,
  state = 'ok',
  width = 96,
  height = 24,
  className,
  label,
}: {
  values: number[]
  state?: CheckState | null
  width?: number
  height?: number
  className?: string
  label?: string
}) {
  const gradientId = useId()
  const points = values.filter((value) => Number.isFinite(value))
  if (points.length === 0) return null
  const series = points.length === 1 ? [points[0], points[0]] : points
  const min = Math.min(...series)
  const max = Math.max(...series)
  const span = max - min || Math.max(1, Math.abs(max) * 0.1)
  const pad = 2.5
  const x = (index: number) => pad + (index / (series.length - 1)) * (width - pad * 2)
  const y = (value: number) => height - pad - ((value - (max === min ? min - span / 2 : min)) / span) * (height - pad * 2)
  const line = series.map((value, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(' ')
  const area = `${line} L${x(series.length - 1).toFixed(1)},${height} L${x(0).toFixed(1)},${height} Z`
  const color = STATE_COLOR[state ?? 'unknown'] === STATE_COLOR.ok ? 'var(--live)' : STATE_COLOR[state ?? 'unknown']
  const last = series[series.length - 1]
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn('shrink-0 overflow-visible', className)}
      role="img"
      aria-label={label ?? `Trend of ${points.length} values`}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(series.length - 1)} cy={y(last)} r="2.25" fill={color} />
    </svg>
  )
}

// ------------------------------------------------------------------ alert status

export function AlertStatusBadge({ alert, className }: { alert: Pick<Alert, 'status' | 'resolution' | 'acknowledged_by_name' | 'resolved_by_name'>; className?: string }) {
  if (alert.status === 'resolved')
    return (
      <Badge variant="success" className={className}>
        <CircleCheck />
        {alert.resolution === 'auto' ? 'Auto-resolved' : 'Resolved'}
      </Badge>
    )
  if (alert.status === 'acknowledged')
    return (
      <Badge variant="secondary" className={className}>
        <UserRound />
        Acknowledged
      </Badge>
    )
  return (
    <Badge variant="outline" className={cn('text-foreground', className)}>
      <span className="size-1.5 animate-pulse-ring rounded-full bg-critical text-critical" />
      Open
    </Badge>
  )
}

export function SnoozedBadge({ until, className }: { until: string; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={cn('inline-flex', className)} />}>
        <Badge variant="info">
          <Moon />
          Snoozed
        </Badge>
      </TooltipTrigger>
      <TooltipContent>Notifications held until {formatDateTime(until)}</TooltipContent>
    </Tooltip>
  )
}

export function MaintenanceBadge({ className, label = 'Maintenance' }: { className?: string; label?: string }) {
  return (
    <Badge variant="secondary" className={cn('text-info', className)}>
      <Wrench />
      {label}
    </Badge>
  )
}

export function RemediationBadge({ remediation, className }: { remediation: AlertRemediation; className?: string }) {
  const variant = remediation.status === 'succeeded' ? 'success' : remediation.status === 'failed' ? 'critical' : 'live'
  return (
    <Badge variant={variant} className={className}>
      <RefreshCw className={cn(remediation.status === 'running' && 'animate-spin')} />
      Fix {REMEDIATION_LABEL[remediation.status].toLowerCase()}
    </Badge>
  )
}

export function DeliveryStatusBadge({ status }: { status: NotificationDeliveryStatus }) {
  const variant = { sent: 'success', failed: 'critical', pending: 'warning', suppressed: 'secondary' } as const
  const Icon = { sent: CircleCheck, failed: OctagonAlert, pending: Clock, suppressed: Moon }[status]
  return (
    <Badge variant={variant[status]}>
      <Icon />
      {DELIVERY_STATUS_LABEL[status]}
    </Badge>
  )
}

/** "4 min ago" with the absolute time in a tooltip, or a dash. */
export function When({ value, className }: { value: string | null | undefined; className?: string }) {
  if (!value) return <span className={cn('text-subtle-foreground', className)}>—</span>
  return (
    <Tooltip>
      <TooltipTrigger render={<time dateTime={value} className={cn('tabular whitespace-nowrap', className)} />}>
        {formatRelative(value)}
      </TooltipTrigger>
      <TooltipContent>{formatDateTime(value)}</TooltipContent>
    </Tooltip>
  )
}

// ------------------------------------------------------------------ icons

export function CheckTypeIcon({ type, className }: { type: string; className?: string }) {
  const Icon = CHECK_TYPE_ICON[type] ?? CHECK_TYPE_ICON[type.split('.')[0]] ?? FileText
  return <Icon aria-hidden="true" className={cn('size-4 shrink-0', className)} />
}

/** A neutral tile with the check type's icon. */
export function CheckTypeTile({ type, className }: { type: string; className?: string }) {
  const Icon = CHECK_TYPE_ICON[type] ?? CHECK_TYPE_ICON[type.split('.')[0]] ?? FileText
  return (
    <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-muted-foreground ring-1 ring-border [&_svg]:size-4', className)}>
      <Icon aria-hidden="true" />
    </span>
  )
}

/** Channel kinds get a tinted tile so lists scan quickly; colours are muted hints, not brand marks. */
const CHANNEL_TINT: Record<NotificationChannelKind, string> = {
  email: 'bg-info/12 text-info ring-info/25',
  slack: 'bg-chart-4/14 text-chart-4 ring-chart-4/25',
  teams: 'bg-chart-3/14 text-chart-3 ring-chart-3/25',
  discord: 'bg-chart-3/10 text-chart-3 ring-chart-3/20',
  ntfy: 'bg-live/12 text-live ring-live/25',
  webhook: 'bg-primary/12 text-primary ring-primary/25',
}

export function ChannelKindTile({ kind, size = 'md', className }: { kind: NotificationChannelKind; size?: 'sm' | 'md'; className?: string }) {
  const Icon = CHANNEL_KIND_ICON[kind]
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center ring-1',
        size === 'sm' ? 'size-6 rounded-md [&_svg]:size-3.5' : 'size-8 rounded-lg [&_svg]:size-4',
        CHANNEL_TINT[kind],
        className,
      )}
    >
      <Icon aria-hidden="true" />
    </span>
  )
}
