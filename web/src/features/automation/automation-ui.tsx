/* Small presentational pieces shared by the automation screens. */
import type { ReactNode } from 'react'
import {
  BadgeCheck,
  Boxes,
  Building,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  Hourglass,
  LoaderCircle,
  MapPin,
  MonitorSmartphone,
  ShieldExclamationPoint,
  ShieldQuestionMark,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { OsIcon } from '@/components/common/os-icon'
import type {
  JobResultStatus,
  JobRunCounts,
  JobStatus,
  JobTargetType,
  OsFamily,
  ScriptLanguage,
  ScriptRisk,
  ScriptSummary,
} from '@/lib/api/types'
import { JOB_STATUS, LANGUAGES, PLATFORM_ORDER, RESULT_STATUS, otherCount, type Tone } from '@/lib/automation/labels'
import { OS_LABEL } from '@/lib/devices'
import { formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'

const TONE_VARIANT: Record<Tone, 'live' | 'success' | 'warning' | 'critical' | 'info' | 'secondary' | 'default'> = {
  live: 'live',
  success: 'success',
  warning: 'warning',
  critical: 'critical',
  info: 'info',
  neutral: 'secondary',
  primary: 'default',
}

const TONE_BG: Record<Tone, string> = {
  live: 'bg-live',
  success: 'bg-success',
  warning: 'bg-warning',
  critical: 'bg-critical',
  info: 'bg-info',
  neutral: 'bg-subtle-foreground/50',
  primary: 'bg-primary',
}

const LANGUAGE_TINT: Record<ScriptLanguage, string> = {
  powershell: 'text-info bg-info/10 ring-info/25',
  pwsh: 'text-info bg-info/10 ring-info/25',
  cmd: 'text-muted-foreground bg-surface-3 ring-border-strong',
  bash: 'text-success bg-success/10 ring-success/25',
  sh: 'text-success bg-success/10 ring-success/25',
  zsh: 'text-chart-4 bg-chart-4/10 ring-chart-4/25',
  python: 'text-warning bg-warning/12 ring-warning/30',
}

/** A compact monospace tile such as “PS” or “PY” for the script language. */
export function LanguageMark({
  language,
  size = 'md',
  className,
}: {
  language: ScriptLanguage
  size?: 'sm' | 'md' | 'lg'
  className?: string
}) {
  const sizes = {
    sm: 'h-5 min-w-7 px-1 text-[9.5px] rounded-[5px]',
    md: 'h-7 min-w-9 px-1.5 text-[10.5px] rounded-md',
    lg: 'size-10 text-[12px] rounded-lg',
  }
  return (
    <span
      title={LANGUAGES[language].label}
      className={cn(
        'inline-flex shrink-0 items-center justify-center font-mono font-semibold tracking-tight ring-1 ring-inset',
        LANGUAGE_TINT[language],
        sizes[size],
        className,
      )}
    >
      {LANGUAGES[language].short}
    </span>
  )
}

export function PlatformIcons({ platforms, className }: { platforms: OsFamily[]; className?: string }) {
  return (
    <span
      className={cn('inline-flex items-center gap-1', className)}
      aria-label={platforms.map((os) => OS_LABEL[os]).join(', ')}
    >
      {PLATFORM_ORDER.filter((os) => platforms.includes(os)).map((os) => (
        <OsIcon key={os} family={os} className="size-3" />
      ))}
    </span>
  )
}

export function RiskBadge({ risk }: { risk: ScriptRisk }) {
  if (risk !== 'high') return null
  return (
    <Badge variant="critical">
      <ShieldExclamationPoint />
      High risk
    </Badge>
  )
}

/** Approval state of a script's current version. */
export function ApprovalBadge({
  script,
  compact = false,
}: {
  script: Pick<ScriptSummary, 'approved_version' | 'current_version' | 'builtin'>
  compact?: boolean
}) {
  if (script.approved_version === script.current_version) {
    return (
      <Badge variant="success">
        <BadgeCheck />
        {compact ? `v${script.current_version}` : `Approved v${script.current_version}`}
      </Badge>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        <Badge variant="warning">
          <ShieldQuestionMark />
          {compact
            ? `v${script.current_version}`
            : script.approved_version
              ? `v${script.current_version} unapproved`
              : 'Not approved'}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">
        {script.approved_version
          ? `Version ${script.approved_version} is approved; version ${script.current_version} is waiting for review.`
          : 'No version of this script has been approved yet.'}
      </TooltipContent>
    </Tooltip>
  )
}

export function BuiltinBadge() {
  return <Badge variant="outline">Built-in</Badge>
}

export function JobStatusBadge({ status }: { status: JobStatus }) {
  const meta = JOB_STATUS[status]
  return (
    <Badge variant={TONE_VARIANT[meta.tone]}>
      {status === 'running' ? (
        <LoaderCircle className="animate-spin" />
      ) : status === 'scheduled' ? (
        <Clock />
      ) : status === 'pending_approval' ? (
        <Hourglass />
      ) : status === 'rejected' ? (
        <CircleX />
      ) : status === 'completed' ? (
        <CircleCheck />
      ) : (
        <CircleDashed />
      )}
      {meta.label}
    </Badge>
  )
}

export function ResultStatusBadge({ status }: { status: JobResultStatus }) {
  const meta = RESULT_STATUS[status]
  return (
    <Badge variant={TONE_VARIANT[meta.tone]}>
      {status === 'running' && <LoaderCircle className="animate-spin" />}
      {meta.label}
    </Badge>
  )
}

export function ResultStatusDot({ status, className }: { status: JobResultStatus; className?: string }) {
  const tone = RESULT_STATUS[status].tone
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex size-2 shrink-0 rounded-full',
        TONE_BG[tone],
        status === 'running' && 'animate-pulse-ring text-live',
        className,
      )}
    />
  )
}

const SEGMENTS: { key: keyof JobRunCounts | 'other'; label: string; className: string }[] = [
  { key: 'succeeded', label: 'Succeeded', className: 'bg-success' },
  { key: 'failed', label: 'Failed', className: 'bg-critical' },
  { key: 'running', label: 'Running', className: 'bg-live animate-pulse' },
  { key: 'waiting_offline', label: 'Waiting for device', className: 'bg-warning' },
  { key: 'pending', label: 'Queued', className: 'bg-info/50' },
  { key: 'other', label: 'Skipped or cancelled', className: 'bg-subtle-foreground/35' },
]

/** A progress bar split by outcome: succeeded, failed, running, waiting, queued, skipped. */
export function SegmentedProgress({
  counts,
  className,
  height = 'h-1.5',
  showTooltip = true,
}: {
  counts: JobRunCounts
  className?: string
  height?: string
  showTooltip?: boolean
}) {
  const total = Math.max(1, counts.total)
  const value = (key: keyof JobRunCounts | 'other') => (key === 'other' ? otherCount(counts) : counts[key])
  const bar = (
    <div
      className={cn('flex w-full gap-px overflow-hidden rounded-full bg-surface-3', height, className)}
      role="img"
      aria-label={SEGMENTS.map((segment) => `${segment.label} ${value(segment.key)}`).join(', ')}
    >
      {SEGMENTS.map((segment) => {
        const amount = value(segment.key)
        if (!amount) return null
        return (
          <span
            key={segment.key}
            className={cn('h-full transition-[flex-grow] duration-500 ease-(--ease-snappy)', segment.className)}
            style={{ flexGrow: amount, flexBasis: 0, minWidth: 3, maxWidth: `${(amount / total) * 100}%` }}
          />
        )
      })}
    </div>
  )
  if (!showTooltip) return bar
  return (
    <Tooltip>
      <TooltipTrigger render={<div className="w-full" />}>{bar}</TooltipTrigger>
      <TooltipContent>
        <div className="grid grid-cols-1 gap-1">
          {SEGMENTS.filter((segment) => value(segment.key)).map((segment) => (
            <div key={segment.key} className="flex items-center gap-2">
              <span className={cn('size-2 rounded-[3px]', segment.className)} />
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

export function SegmentLegend({ counts, className }: { counts: JobRunCounts; className?: string }) {
  return (
    <div className={cn('flex flex-wrap gap-x-3 gap-y-1 text-micro text-muted-foreground', className)}>
      {SEGMENTS.map((segment) => {
        const amount = segment.key === 'other' ? otherCount(counts) : counts[segment.key]
        if (!amount) return null
        return (
          <span key={segment.key} className="inline-flex items-center gap-1.5">
            <span
              className={cn('size-2 rounded-[3px]', segment.className.replace('animate-pulse', ''))}
              aria-hidden="true"
            />
            {segment.label}
            <span className="tabular text-foreground">{formatNumber(amount)}</span>
          </span>
        )
      })}
    </div>
  )
}

const TARGET_ICON = { devices: MonitorSmartphone, group: Boxes, site: MapPin, client: Building }

export function TargetIcon({ type, className }: { type: JobTargetType; className?: string }) {
  const Icon = TARGET_ICON[type]
  return <Icon className={cn('size-3.5 shrink-0 text-subtle-foreground', className)} />
}

export function TargetLabel({ type, label, className }: { type: JobTargetType; label: string; className?: string }) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      <TargetIcon type={type} />
      <span className="truncate">{label}</span>
    </span>
  )
}

/** A labelled stat used in automation headers. */
export function MetaItem({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="text-micro text-subtle-foreground">{label}</div>
      <div className="mt-0.5 truncate text-dense font-medium">{children}</div>
    </div>
  )
}

/** Monospace block for code and output, with optional line numbers. */
export function OutputBlock({
  text,
  empty,
  className,
  numbered = false,
}: {
  text: string
  empty?: ReactNode
  className?: string
  numbered?: boolean
}) {
  if (!text)
    return (
      <div
        className={cn(
          'rounded-lg bg-surface-2 px-4 py-6 text-center text-dense text-subtle-foreground ring-1 ring-border',
          className,
        )}
      >
        {empty ?? 'No output'}
      </div>
    )
  const lines = text.split('\n')
  return (
    <pre
      className={cn(
        'overflow-auto rounded-lg bg-surface-2 py-3 font-mono text-[12px] leading-[1.6] text-foreground/90 ring-1 ring-border',
        className,
      )}
    >
      {numbered ? (
        <code className="grid min-w-max grid-cols-[auto_1fr]">
          {lines.map((line, index) => (
            <span key={index} className="contents">
              <span className="sticky left-0 bg-surface-2 pr-3 pl-3 text-right text-subtle-foreground/70 select-none">
                {index + 1}
              </span>
              <span className={cn('pr-4 whitespace-pre', line.startsWith('::rustrmm::') && 'text-primary')}>
                {line || ' '}
              </span>
            </span>
          ))}
        </code>
      ) : (
        <code className="block px-4 whitespace-pre">{text}</code>
      )}
    </pre>
  )
}
