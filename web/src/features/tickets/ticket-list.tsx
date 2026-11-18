/* The queue list: virtualised ticket rows with selection, SLA chips and keyboard focus. */
import { useEffect, useRef, type MouseEvent, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { UserAvatar } from '@/components/common/misc'
import type { Ticket } from '@/lib/api/types'
import { shortAge } from '@/lib/monitoring/alerts'
import { ticketNumber } from '@/lib/tickets/labels'
import { cn } from '@/lib/utils'
import { FRESH_MS } from './ticket-stores'
import { PriorityGlyph, SlaChip, SourceIcon, TagList, TicketStatusBadge } from './ticket-ui'
import { PRIORITY_STYLE } from './ticket-styles'

const ROW_H = 74

function TicketRow({
  ticket,
  current,
  selected,
  selecting,
  fresh,
  meId,
  onOpen,
  onToggle,
}: {
  ticket: Ticket
  current: boolean
  selected: boolean
  selecting: boolean
  fresh: boolean
  meId: string | undefined
  onOpen: (event: MouseEvent) => void
  onToggle: (shift: boolean) => void
}) {
  const done = ticket.status === 'resolved' || ticket.status === 'closed'
  const unread = ticket.status === 'new'
  return (
    <div
      role="option"
      aria-selected={current}
      tabIndex={-1}
      data-ticket-id={ticket.id}
      onClick={onOpen}
      className={cn(
        'group relative flex h-full cursor-pointer items-start gap-2.5 border-b border-border py-2.5 pr-3 pl-3.5 outline-none transition-colors',
        'hover:bg-surface-2',
        selected && 'bg-primary/[0.05] hover:bg-primary/[0.08]',
        current && 'bg-surface-3 hover:bg-surface-3',
        fresh && !current && 'animate-[alert-arrive_1.6s_ease-out]',
      )}
    >
      <span aria-hidden="true" className={cn('absolute inset-y-0 left-0 w-[3px]', PRIORITY_STYLE[ticket.priority].stripe, done ? 'opacity-20' : current ? 'opacity-100' : 'opacity-75')} />
      <span
        className={cn('mt-0.5 flex shrink-0 transition-opacity', selected || selecting ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100 max-lg:opacity-100')}
        onClick={(event) => {
          event.stopPropagation()
          onToggle(event.shiftKey)
        }}
      >
        <Checkbox checked={selected} aria-label={`Select ${ticketNumber(ticket.number)}`} />
      </span>
      <Tooltip>
        <TooltipTrigger render={<span className="mt-[3px] inline-flex shrink-0" />}>
          <PriorityGlyph priority={ticket.priority} className={cn(done && 'opacity-50')} />
        </TooltipTrigger>
        <TooltipContent className="capitalize">{ticket.priority} priority</TooltipContent>
      </Tooltip>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="tabular shrink-0 font-mono text-[11px] text-subtle-foreground">{ticketNumber(ticket.number)}</span>
          <span className={cn('min-w-0 flex-1 truncate text-dense', unread ? 'font-semibold' : 'font-medium', done && 'font-normal text-muted-foreground')}>{ticket.subject}</span>
          <Tooltip>
            <TooltipTrigger render={<span className="tabular shrink-0 text-[10.5px] text-subtle-foreground" />}>{shortAge(ticket.last_activity_at)}</TooltipTrigger>
            <TooltipContent>Last activity {new Date(ticket.last_activity_at).toLocaleString()}</TooltipContent>
          </Tooltip>
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-micro text-muted-foreground">
            <span className="font-medium text-secondary-foreground">{ticket.client_name}</span>
            {ticket.contact && (
              <>
                <span className="text-subtle-foreground"> · </span>
                {ticket.contact.name}
              </>
            )}
            <span className="text-subtle-foreground"> · </span>
            {ticket.queue.name}
          </span>
          <SourceIcon source={ticket.source} />
        </div>
        <div className="mt-1.5 flex min-w-0 items-center gap-1.5">
          <TicketStatusBadge status={ticket.status} />
          <SlaChip ticket={ticket} />
          <TagList tags={ticket.tags} max={2} className="min-w-0 max-sm:hidden" />
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {ticket.assignee ? (
              <Tooltip>
                <TooltipTrigger render={<span className="inline-flex" />}>
                  <UserAvatar name={ticket.assignee.name} size="xs" className={cn('size-[18px] text-[8.5px]', ticket.assignee.id === meId && 'bg-primary/15 text-primary ring-primary/30')} />
                </TooltipTrigger>
                <TooltipContent>Assigned to {ticket.assignee.id === meId ? 'you' : ticket.assignee.name}</TooltipContent>
              </Tooltip>
            ) : (
              <span className="text-[10.5px] text-subtle-foreground">Unassigned</span>
            )}
          </span>
        </div>
      </div>
    </div>
  )
}

export function TicketList({
  tickets,
  currentId,
  selectedIds,
  freshIds,
  meId,
  onOpen,
  onToggle,
  onRange,
  footer,
}: {
  tickets: Ticket[]
  currentId: string | undefined
  selectedIds: Set<string>
  freshIds: Record<string, number>
  meId: string | undefined
  onOpen: (ticket: Ticket) => void
  onToggle: (ticket: Ticket) => void
  onRange: (ticket: Ticket) => void
  footer?: ReactNode
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: tickets.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 10,
  })
  const currentIndex = tickets.findIndex((ticket) => ticket.id === currentId)
  useEffect(() => {
    if (currentIndex >= 0) virtualizer.scrollToIndex(currentIndex, { align: 'auto' })
  }, [currentIndex, virtualizer])
  const now = Date.now()
  const selecting = selectedIds.size > 0
  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="Tickets" aria-multiselectable="true">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtual) => {
          const ticket = tickets[virtual.index]
          return (
            <div key={ticket.id} className="absolute inset-x-0 top-0" style={{ height: virtual.size, transform: `translateY(${virtual.start}px)` }}>
              <TicketRow
                ticket={ticket}
                current={ticket.id === currentId}
                selected={selectedIds.has(ticket.id)}
                selecting={selecting}
                fresh={Boolean(freshIds[ticket.id] && now - freshIds[ticket.id] < FRESH_MS)}
                meId={meId}
                onOpen={(event) => {
                  if (event.shiftKey) onRange(ticket)
                  else if (event.metaKey || event.ctrlKey) onToggle(ticket)
                  else onOpen(ticket)
                }}
                onToggle={(shift) => (shift ? onRange(ticket) : onToggle(ticket))}
              />
            </div>
          )
        })}
      </div>
      {footer}
      {tickets.length > 0 && <div className="h-6" aria-hidden="true" />}
    </div>
  )
}

