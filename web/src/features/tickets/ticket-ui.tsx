/* Small Phase 9 visuals: status and priority badges, the SLA countdown chip, source icons and tags. */
import { CircleCheck, Clock, Pause, TriangleExclamationPoint } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { Ticket, TicketPriority, TicketSource, TicketStatus } from '@/lib/api/types'
import { formatDateTime } from '@/lib/format'
import { PRIORITY_LABEL, SOURCE_LABEL, STATUS_HINT, STATUS_LABEL } from '@/lib/tickets/labels'
import { headlineClock, SLA_KIND_LABEL, type SlaClock } from '@/lib/tickets/sla'
import { cn } from '@/lib/utils'
import { PRIORITY_STYLE, SLA_TONE, SOURCE_ICON, STATUS_STYLE } from './ticket-styles'
import { useNow } from './use-now'

export function TicketStatusBadge({ status, className, hint = false }: { status: TicketStatus; className?: string; hint?: boolean }) {
  const badge = (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-micro font-medium whitespace-nowrap ring-1 ring-inset',
        STATUS_STYLE[status].soft,
        className,
      )}
    >
      <span className={cn('size-1.5 rounded-full', STATUS_STYLE[status].dot)} aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  )
  if (!hint) return badge
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>{badge}</TooltipTrigger>
      <TooltipContent>{STATUS_HINT[status]}</TooltipContent>
    </Tooltip>
  )
}

/** Signal-bar priority glyph; urgent is a filled alert square. */
export function PriorityGlyph({ priority, className }: { priority: TicketPriority; className?: string }) {
  const color = PRIORITY_STYLE[priority].text
  if (priority === 'urgent') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" className={cn('size-3.5 shrink-0', color, className)}>
        <rect x="1" y="1" width="14" height="14" rx="3.5" fill="currentColor" />
        <rect x="7.1" y="3.6" width="1.8" height="5.6" rx="0.9" className="fill-white dark:fill-[oklch(0.2_0.03_20)]" />
        <circle cx="8" cy="11.6" r="1.05" className="fill-white dark:fill-[oklch(0.2_0.03_20)]" />
      </svg>
    )
  }
  const level = priority === 'high' ? 3 : priority === 'normal' ? 2 : 1
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={cn('size-3.5 shrink-0', color, className)}>
      {[0, 1, 2].map((bar) => (
        <rect
          key={bar}
          x={2 + bar * 4.5}
          y={10 - bar * 3.5}
          width="3"
          height={4 + bar * 3.5}
          rx="1"
          fill="currentColor"
          opacity={bar < level ? 1 : 0.22}
        />
      ))}
    </svg>
  )
}

export function PriorityLabel({ priority, className }: { priority: TicketPriority; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap', className)}>
      <PriorityGlyph priority={priority} />
      <span className={cn(priority === 'urgent' && 'font-medium text-critical')}>{PRIORITY_LABEL[priority]}</span>
    </span>
  )
}

export function SourceIcon({ source, className }: { source: TicketSource; className?: string }) {
  const Icon = SOURCE_ICON[source]
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={cn('inline-flex shrink-0 text-subtle-foreground', className)} />}>
        <Icon className="size-3.5" aria-label={SOURCE_LABEL[source]} />
      </TooltipTrigger>
      <TooltipContent>Via {SOURCE_LABEL[source].toLowerCase()}</TooltipContent>
    </Tooltip>
  )
}

function ClockIcon({ clock }: { clock: SlaClock }) {
  if (clock.tone === 'paused') return <Pause className="size-3" aria-hidden="true" />
  if (clock.tone === 'met' || clock.tone === 'met_late') return <CircleCheck className="size-3" aria-hidden="true" />
  if (clock.tone === 'breached') return <TriangleExclamationPoint className="size-3" aria-hidden="true" />
  return <Clock className="size-3" aria-hidden="true" />
}

function clockText(clock: SlaClock) {
  const what = SLA_KIND_LABEL[clock.kind].toLowerCase()
  switch (clock.tone) {
    case 'met':
      return `${SLA_KIND_LABEL[clock.kind]} met ${formatDateTime(clock.met_at)}`
    case 'met_late':
      return `${SLA_KIND_LABEL[clock.kind]} met late ${formatDateTime(clock.met_at)} (due ${formatDateTime(clock.due)})`
    case 'breached':
      return `${SLA_KIND_LABEL[clock.kind]} overdue since ${formatDateTime(clock.due)}`
    case 'paused':
      return `Clock paused; ${what} due times move when it resumes`
    default:
      return `${SLA_KIND_LABEL[clock.kind]} due ${formatDateTime(clock.due)}`
  }
}

export function SlaClockChip({ clock, className, prefix = false }: { clock: SlaClock; className?: string; prefix?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              'tabular inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 text-[10.5px] font-medium whitespace-nowrap ring-1 ring-inset',
              SLA_TONE[clock.tone],
              clock.tone === 'breached' && 'font-semibold',
              className,
            )}
          />
        }
      >
        <ClockIcon clock={clock} />
        {prefix && <span className="font-normal opacity-80">{clock.kind === 'first_response' ? 'Reply' : 'Fix'}</span>}
        {clock.label}
        <span className="sr-only">{clockText(clock)}</span>
      </TooltipTrigger>
      <TooltipContent>{clockText(clock)}</TooltipContent>
    </Tooltip>
  )
}

/** The queue row's SLA chip: first response until met, then resolution. */
export function SlaChip({ ticket, className }: { ticket: Pick<Ticket, 'sla' | 'status'>; className?: string }) {
  const now = useNow(15_000)
  const clock = headlineClock(ticket, now)
  if (!clock) return null
  return <SlaClockChip clock={clock} className={className} prefix />
}

export function TagList({ tags, max = 3, className }: { tags: string[]; max?: number; className?: string }) {
  if (!tags.length) return null
  const shown = tags.slice(0, max)
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1', className)}>
      {shown.map((tag) => (
        <span key={tag} className="inline-flex h-[18px] max-w-28 items-center truncate rounded-[5px] bg-surface-3 px-1.5 text-[10.5px] text-secondary-foreground ring-1 ring-border">
          {tag}
        </span>
      ))}
      {tags.length > max && <span className="text-[10.5px] text-subtle-foreground">+{tags.length - max}</span>}
    </span>
  )
}
