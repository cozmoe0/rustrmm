/* Presentational pieces shared by the patching and software screens. */
import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import {
  ArrowUpRight,
  Ban,
  BadgeCheck,
  CalendarClock,
  CircleDashed,
  LoaderCircle,
  Package,
  RotateCw,
  ShieldCheck,
  Sparkles,
  UserCheck,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { OsIcon } from '@/components/common/os-icon'
import type {
  DevicePatchState,
  PatchApproval,
  PatchPlatform,
  PatchRunCounts,
  PatchRunResultStatus,
  PatchRunStatus,
  PatchSeverity,
} from '@/lib/api/types'
import { describeApproval } from '@/lib/patching/approval'
import {
  PLATFORM_LABEL,
  RUN_RESULT_LABEL,
  RUN_RESULT_TONE,
  RUN_STATUS_LABEL,
  STATE_LABEL,
  STATE_TONE,
  classificationLabel,
  isSecurityClassification,
} from '@/lib/patching/labels'
import { formatNumber } from '@/lib/format'
import type { Tone } from '@/lib/patching/labels'
import { SEVERITY_BAR, TONE_VARIANT } from './patching-styles'
import { cn } from '@/lib/utils'

export function SeverityPill({ severity, className }: { severity: PatchSeverity | null; className?: string }) {
  if (!severity) return <span className={cn('text-micro text-subtle-foreground', className)}>Unrated</span>
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-dense', className)}>
      <span className={cn('size-2 shrink-0 rounded-[3px]', SEVERITY_BAR[severity])} aria-hidden="true" />
      <span className={cn(severity === 'Critical' && 'font-medium text-critical', severity === 'Important' && 'text-warning')}>{severity}</span>
    </span>
  )
}

export function PlatformMark({ platform, label = true, className }: { platform: PatchPlatform; label?: boolean; className?: string }) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)} title={PLATFORM_LABEL[platform]}>
      {platform === 'winget' ? <Package className="size-3.5 shrink-0 text-subtle-foreground" /> : <OsIcon family={platform} />}
      {label && <span className="truncate">{PLATFORM_LABEL[platform]}</span>}
    </span>
  )
}

export function ClassificationLabel({ platform, classification }: { platform: PatchPlatform; classification: string }) {
  const security = isSecurityClassification(classification)
  return (
    <span className={cn('inline-flex items-center gap-1.5', security ? 'text-foreground' : 'text-muted-foreground')}>
      {security && <ShieldCheck className="size-3.5 shrink-0 text-primary" />}
      <span className="truncate">{classificationLabel(platform, classification)}</span>
    </span>
  )
}

/** The approval as a badge: rule approvals, manual approvals and client overrides look different. */
export function ApprovalBadge({ approval, compact = false }: { approval: PatchApproval; compact?: boolean }) {
  const display = describeApproval(approval)
  const icon =
    approval.status === 'approved' ? (
      display.source === 'rule' ? (
        <Sparkles />
      ) : (
        <UserCheck />
      )
    ) : approval.status === 'declined' ? (
      <Ban />
    ) : approval.status === 'deferred' ? (
      <CalendarClock />
    ) : (
      <CircleDashed />
    )
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex max-w-full items-center gap-1" />}>
        <Badge variant={TONE_VARIANT[display.tone]} className="max-w-full">
          {icon}
          <span className="truncate">{compact && approval.status === 'approved' ? (display.source === 'rule' ? 'Rule' : 'Manual') : display.label}</span>
        </Badge>
        {display.override && (
          <Badge variant="outline" className="px-1 text-[10px]">
            Client
          </Badge>
        )}
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        {display.detail}
        {display.override && ' This is a client override of the global decision.'}
      </TooltipContent>
    </Tooltip>
  )
}

export function PatchStateBadge({ state }: { state: DevicePatchState }) {
  return (
    <Badge variant={TONE_VARIANT[STATE_TONE[state]]}>
      {state === 'installing' && <LoaderCircle className="animate-spin" />}
      {state === 'pending_reboot' && <RotateCw />}
      {state === 'installed' && <BadgeCheck />}
      {STATE_LABEL[state]}
    </Badge>
  )
}

export function RunResultBadge({ status }: { status: PatchRunResultStatus }) {
  return (
    <Badge variant={TONE_VARIANT[RUN_RESULT_TONE[status]]}>
      {status === 'running' && <LoaderCircle className="animate-spin" />}
      {status === 'pending_reboot' && <RotateCw />}
      {RUN_RESULT_LABEL[status]}
    </Badge>
  )
}

export function RunStatusBadge({ status, failed = 0 }: { status: PatchRunStatus; failed?: number }) {
  if (status === 'running')
    return (
      <Badge variant="live">
        <span className="inline-flex size-1.5 animate-pulse-ring rounded-full bg-live" />
        {RUN_STATUS_LABEL.running}
      </Badge>
    )
  return <Badge variant={status === 'cancelled' ? 'secondary' : failed ? 'warning' : 'success'}>{RUN_STATUS_LABEL[status]}</Badge>
}

const RUN_SEGMENTS: { key: 'succeeded' | 'pending_reboot' | 'failed' | 'pending' | 'skipped'; label: string; className: string }[] = [
  { key: 'succeeded', label: 'Succeeded', className: 'bg-success' },
  { key: 'pending_reboot', label: 'Restart pending', className: 'bg-info' },
  { key: 'failed', label: 'Failed', className: 'bg-critical' },
  { key: 'pending', label: 'Waiting or installing', className: 'bg-live animate-pulse' },
  { key: 'skipped', label: 'Skipped or cancelled', className: 'bg-subtle-foreground/35' },
]

/** A bar split by run outcome. `skipped` also absorbs results the counts don't name (cancelled). */
export function RunProgressBar({ counts, height = 'h-1.5', className }: { counts: PatchRunCounts; height?: string; className?: string }) {
  const named = counts.succeeded + counts.pending_reboot + counts.failed + counts.pending
  const rest = Math.max(counts.skipped ?? 0, counts.total - named)
  const value = (key: (typeof RUN_SEGMENTS)[number]['key']) => (key === 'skipped' ? rest : counts[key])
  const total = Math.max(1, counts.total)
  return (
    <Tooltip>
      <TooltipTrigger render={<div className={cn('w-full', className)} />}>
        <div className={cn('flex w-full gap-px overflow-hidden rounded-full bg-surface-3', height)} role="img" aria-label={RUN_SEGMENTS.map((segment) => `${segment.label} ${value(segment.key)}`).join(', ')}>
          {RUN_SEGMENTS.map((segment) => {
            const amount = value(segment.key)
            if (!amount) return null
            return <span key={segment.key} className={cn('h-full transition-[flex-grow] duration-500', segment.className)} style={{ flexGrow: amount, flexBasis: 0, minWidth: 3, maxWidth: `${(amount / total) * 100}%` }} />
          })}
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <div className="grid grid-cols-1 gap-1">
          {RUN_SEGMENTS.filter((segment) => value(segment.key)).map((segment) => (
            <div key={segment.key} className="flex items-center gap-2">
              <span className={cn('size-2 rounded-[3px]', segment.className.replace(' animate-pulse', ''))} />
              <span>{segment.label}</span>
              <span className="tabular ml-auto pl-4 font-medium">{formatNumber(value(segment.key))}</span>
            </div>
          ))}
          {counts.total === 0 && <span>No devices</span>}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

/** A KPI tile that drills into a filtered list. */
export function KpiTile({
  label,
  value,
  icon,
  tone,
  footer,
  to,
  search,
  children,
  className,
}: {
  label: string
  value: ReactNode
  icon: ReactNode
  tone?: Tone
  footer?: ReactNode
  to: string
  search?: Record<string, unknown>
  children?: ReactNode
  className?: string
}) {
  const toneClass: Partial<Record<Tone, string>> = {
    live: 'text-live bg-live/10 ring-live/20',
    critical: 'text-critical bg-critical/10 ring-critical/20',
    warning: 'text-warning bg-warning/10 ring-warning/25',
    info: 'text-info bg-info/10 ring-info/20',
    success: 'text-success bg-success/10 ring-success/20',
  }
  return (
    <Link
      to={to}
      search={search as never}
      className={cn(
        'group relative flex min-w-0 flex-col justify-between gap-3 rounded-xl bg-card p-4 shadow-card outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-dense text-muted-foreground">{label}</span>
        <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-lg ring-1 [&_svg]:size-3.5', (tone && toneClass[tone]) || 'bg-surface-3 text-muted-foreground ring-border')}>
          {icon}
        </span>
      </div>
      {children ?? <div className="font-display tabular text-[28px] leading-none font-semibold tracking-tight">{value}</div>}
      {footer && <div className="text-micro text-subtle-foreground">{footer}</div>}
      <ArrowUpRight className="absolute right-3 bottom-3 size-3.5 text-subtle-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </Link>
  )
}

/** A filter pill with a count, used above lists. */
export function FilterPill({
  active,
  onClick,
  children,
  count,
  disabled,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
  count?: number
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-dense text-muted-foreground ring-1 ring-border transition-colors outline-none hover:bg-surface-3 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40',
        active && 'bg-primary/10 font-medium text-foreground ring-primary/30',
      )}
    >
      {children}
      {count !== undefined && <span className="tabular text-micro text-subtle-foreground">{formatNumber(count)}</span>}
    </button>
  )
}

/** A labelled number for stat strips (click to filter). */
export function StatButton({
  label,
  value,
  tone,
  active,
  onClick,
}: {
  label: string
  value: number
  tone?: string
  active?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'grid min-w-0 gap-0.5 rounded-lg px-3 py-2 text-left transition-colors outline-none hover:bg-surface-3/60 focus-visible:ring-2 focus-visible:ring-ring',
        active && 'bg-surface-3 ring-1 ring-border-strong',
      )}
    >
      <span className="truncate text-micro text-subtle-foreground">{label}</span>
      <span className={cn('font-display tabular text-xl leading-none font-semibold tracking-tight', tone)}>{formatNumber(value)}</span>
    </button>
  )
}
