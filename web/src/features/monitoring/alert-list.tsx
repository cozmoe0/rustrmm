/* The inbox list: grouped, virtualised alert rows with selection, plus the empty states. */
import { useEffect, useRef, type MouseEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { useVirtualizer } from '@tanstack/react-virtual'
import { CalendarClock, CircleCheck, Moon, Repeat, ShieldCheck, Ticket, UserCheck, Wrench } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { UserAvatar } from '@/components/common/misc'
import type { Alert, CheckTypeDefinition } from '@/lib/api/types'
import { isSnoozed, shortAge, type AlertGroup } from '@/lib/monitoring/alerts'
import { alertCheckLabel } from '@/lib/monitoring/labels'
import { formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import { FRESH_MS } from './alert-stores'
import { SeverityIcon } from './monitoring-ui'
import { SEVERITY_STYLE } from './monitoring-styles'

type Item = { kind: 'header'; group: AlertGroup } | { kind: 'row'; alert: Alert; index: number }

const HEADER_H = 34
const ROW_H = 66

function RowBadges({ alert, meId }: { alert: Alert; meId: string | undefined }) {
  const snoozed = isSnoozed(alert)
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-subtle-foreground [&_svg]:size-3.5">
      {alert.occurrences > 1 && (
        <span className="tabular inline-flex items-center gap-0.5 text-[10.5px]" title={`${alert.occurrences} occurrences`}>
          <Repeat className="size-3!" />
          {alert.occurrences}
        </span>
      )}
      {alert.ticket_id && <Ticket className="text-primary" aria-label="Has a ticket" />}
      {alert.in_maintenance && <Wrench className="text-info" aria-label="In maintenance" />}
      {snoozed && <Moon className="text-info" aria-label="Snoozed" />}
      {alert.status === 'acknowledged' && <UserCheck aria-label={`Acknowledged by ${alert.acknowledged_by_name ?? 'someone'}`} />}
      {alert.status === 'resolved' && <CircleCheck className="text-success" aria-label="Resolved" />}
      {alert.assigned_to && (
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>
            <UserAvatar
              name={alert.assigned_to.name}
              size="xs"
              className={cn('size-[18px] text-[8.5px]', alert.assigned_to.id === meId && 'bg-primary/15 text-primary ring-primary/30')}
            />
          </TooltipTrigger>
          <TooltipContent>Assigned to {alert.assigned_to.id === meId ? 'you' : alert.assigned_to.name}</TooltipContent>
        </Tooltip>
      )}
    </span>
  )
}

function AlertRow({
  alert,
  current,
  selected,
  selecting,
  fresh,
  meId,
  catalog,
  onOpen,
  onToggle,
}: {
  alert: Alert
  current: boolean
  selected: boolean
  selecting: boolean
  fresh: boolean
  meId: string | undefined
  catalog?: CheckTypeDefinition[]
  onOpen: (event: MouseEvent) => void
  onToggle: (shift: boolean) => void
}) {
  const resolved = alert.status === 'resolved'
  return (
    <div
      role="option"
      aria-selected={current}
      tabIndex={-1}
      data-alert-id={alert.id}
      onClick={onOpen}
      className={cn(
        'group relative flex h-full cursor-pointer items-start gap-2.5 border-b border-border py-2.5 pr-3 pl-3.5 outline-none transition-colors',
        'hover:bg-surface-2',
        selected && 'bg-primary/[0.05] hover:bg-primary/[0.08]',
        current && 'bg-surface-3 hover:bg-surface-3',
        fresh && !current && 'animate-[alert-arrive_1.6s_ease-out]',
      )}
    >
      <span
        aria-hidden="true"
        className={cn('absolute inset-y-0 left-0 w-[3px]', SEVERITY_STYLE[alert.severity].stripe, resolved ? 'opacity-25' : current ? 'opacity-100' : 'opacity-70')}
      />
      <span
        className={cn(
          'mt-0.5 flex shrink-0 transition-opacity',
          selected || selecting ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100 max-lg:opacity-100',
        )}
        onClick={(event) => {
          event.stopPropagation()
          onToggle(event.shiftKey)
        }}
      >
        <Checkbox checked={selected} aria-label={`Select ${alert.title}`} />
      </span>
      <SeverityIcon severity={alert.severity} className={cn('mt-0.5', resolved && 'opacity-50')} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className={cn('min-w-0 flex-1 truncate text-dense font-medium', resolved && 'font-normal text-muted-foreground')}>{alert.title}</span>
          <Tooltip>
            <TooltipTrigger render={<span className="tabular shrink-0 text-[10.5px] text-subtle-foreground" />}>
              {shortAge(alert.last_occurrence_at)}
            </TooltipTrigger>
            <TooltipContent>Last occurred {new Date(alert.last_occurrence_at).toLocaleString()}</TooltipContent>
          </Tooltip>
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-micro text-muted-foreground">
            {alert.hostname && <span className="font-medium text-secondary-foreground">{alert.hostname}</span>}
            {alert.hostname && <span className="text-subtle-foreground"> · </span>}
            {alert.client_name}
            <span className="text-subtle-foreground"> · </span>
            {alertCheckLabel(alert, catalog)}
          </span>
          <RowBadges alert={alert} meId={meId} />
        </div>
      </div>
    </div>
  )
}

export function AlertList({
  groups,
  ordered,
  currentId,
  selectedIds,
  freshIds,
  meId,
  catalog,
  onOpen,
  onToggle,
  onRange,
  footer,
}: {
  groups: AlertGroup[]
  ordered: Alert[]
  currentId: string | undefined
  selectedIds: Set<string>
  freshIds: Record<string, number>
  meId: string | undefined
  catalog?: CheckTypeDefinition[]
  onOpen: (alert: Alert) => void
  onToggle: (alert: Alert) => void
  onRange: (alert: Alert) => void
  footer?: React.ReactNode
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const items: Item[] = []
  let index = 0
  const showHeaders = groups.length > 1 || (groups[0] && groups[0].key !== 'all')
  for (const group of groups) {
    if (showHeaders) items.push({ kind: 'header', group })
    for (const alert of group.items) items.push({ kind: 'row', alert, index: index++ })
  }
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (position) => (items[position]?.kind === 'header' ? HEADER_H : ROW_H),
    overscan: 10,
  })
  const currentPosition = items.findIndex((item) => item.kind === 'row' && item.alert.id === currentId)
  useEffect(() => {
    if (currentPosition >= 0) virtualizer.scrollToIndex(currentPosition, { align: 'auto' })
  }, [currentPosition, virtualizer])

  const now = Date.now()
  const selecting = selectedIds.size > 0
  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="Alerts" aria-multiselectable="true">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtual) => {
          const item = items[virtual.index]
          return (
            <div
              key={item.kind === 'header' ? `h-${item.group.key}` : item.alert.id}
              className="absolute inset-x-0 top-0"
              style={{ height: virtual.size, transform: `translateY(${virtual.start}px)` }}
            >
              {item.kind === 'header' ? (
                <div className="flex h-full items-end gap-2 border-b border-border bg-background/95 px-3.5 pb-1.5 backdrop-blur">
                  {item.group.severity && <span className={cn('size-1.5 rounded-full', SEVERITY_STYLE[item.group.severity].dot)} />}
                  <span className="eyebrow">{item.group.label}</span>
                  <span className="tabular text-micro text-subtle-foreground">{formatNumber(item.group.items.length)}</span>
                </div>
              ) : (
                <AlertRow
                  alert={item.alert}
                  current={item.alert.id === currentId}
                  selected={selectedIds.has(item.alert.id)}
                  selecting={selecting}
                  fresh={Boolean(freshIds[item.alert.id] && now - freshIds[item.alert.id] < FRESH_MS)}
                  meId={meId}
                  catalog={catalog}
                  onOpen={(event) => {
                    if (event.shiftKey) onRange(item.alert)
                    else if (event.metaKey || event.ctrlKey) onToggle(item.alert)
                    else onOpen(item.alert)
                  }}
                  onToggle={(shift) => (shift ? onRange(item.alert) : onToggle(item.alert))}
                />
              )}
            </div>
          )
        })}
      </div>
      {footer}
      {ordered.length > 0 && <div className="h-6" aria-hidden="true" />}
    </div>
  )
}

/** The celebratory empty inbox. */
export function AllClear({ scopeName, devices }: { scopeName?: string; devices?: number }) {
  return (
    <div className="relative flex flex-1 flex-col items-center justify-center overflow-hidden px-6 py-16 text-center">
      <div className="bg-grid bg-grid-fade pointer-events-none absolute inset-0 opacity-60" aria-hidden="true" />
      <div className="surface-glow pointer-events-none absolute inset-0 opacity-70" aria-hidden="true" />
      <div className="relative mb-5 flex size-28 items-center justify-center" aria-hidden="true">
        <span className="absolute inset-0 rounded-full bg-live/[0.06] ring-1 ring-live/15" />
        <span className="absolute inset-3.5 rounded-full bg-live/[0.09] ring-1 ring-live/20" />
        <span className="absolute inset-7 animate-pulse-ring rounded-full bg-live/15 text-live ring-1 ring-live/35" />
        <ShieldCheck className="relative size-8 text-live" strokeWidth={1.75} />
      </div>
      <h2 className="font-display relative text-xl font-semibold tracking-tight">All clear</h2>
      <p className="relative mt-1.5 max-w-sm text-dense text-muted-foreground">
        No open alerts{scopeName ? ` for ${scopeName.replace(/\.$/, '')}` : ''}.{' '}
        {devices
          ? `Watching ${formatNumber(devices)} ${devices === 1 ? 'device' : 'devices'}; new problems appear here the moment they’re detected.`
          : 'New problems appear here the moment they’re detected.'}
      </p>
      <div className="relative mt-5 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-dense">
        <Link to="/alerts" search={(prev) => ({ client: (prev as { client?: string }).client, status: 'resolved' })} className="font-medium text-primary hover:underline">
          Recently resolved
        </Link>
        <Link to="/alerts/maintenance" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
          <CalendarClock className="size-3.5" />
          Maintenance windows
        </Link>
      </div>
    </div>
  )
}
