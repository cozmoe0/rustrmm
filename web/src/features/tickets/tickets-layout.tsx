/* The Tickets section frame: views with counts, queues, contacts, time and settings links. */
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, Outlet, useLocation, useSearch } from '@tanstack/react-router'
import { AlarmClock, BookUser, CircleCheck, CirclePause, Hourglass, Inbox, Layers, ListTodo, Settings2, TicketPlus, Timer, UserRound, UserRoundX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ContextGroup, ContextLink, ContextPanel } from '@/components/shell/context-panel'
import { ticketQueuesQuery } from '@/lib/api/queries'
import { formatNumber } from '@/lib/format'
import { VIEWS, viewCount, viewMatches, type TicketsSearch, type ViewId } from '@/lib/tickets/queue'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useScope } from '@/lib/scope'
import { cn } from '@/lib/utils'
import { openNewTicket } from './ticket-stores'
import { useTicketCounts } from './use-ticket-counts'

const VIEW_ICON: Record<ViewId, ReactNode> = {
  mine: <UserRound />,
  unassigned: <UserRoundX />,
  open: <Inbox />,
  breached: <AlarmClock />,
  due_soon: <Hourglass />,
  pending: <CirclePause />,
  resolved: <CircleCheck />,
  all: <ListTodo />,
}

function Count({ value, tone }: { value: number | undefined; tone?: 'critical' | 'warning' | 'neutral' }) {
  if (!value) return null
  return (
    <span
      className={cn(
        'tabular inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[10.5px] font-semibold',
        tone === 'critical' ? 'bg-critical/15 text-critical ring-1 ring-critical/30' : tone === 'warning' ? 'bg-warning/15 text-warning ring-1 ring-warning/30' : 'bg-surface-4 text-muted-foreground',
      )}
    >
      {formatNumber(value)}
    </span>
  )
}

function NavItem({ active, search, icon, label, badge }: { active: boolean; search: TicketsSearch; icon: ReactNode; label: string; badge?: ReactNode }) {
  return (
    <li className="min-w-0">
      <Link
        to="/tickets"
        search={(prev) => ({ client: (prev as { client?: string }).client, site: (prev as { site?: string }).site, ...search })}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'group flex h-8 items-center gap-2.5 rounded-md px-2 text-dense text-muted-foreground outline-none transition-colors',
          'hover:bg-surface-3 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
          '[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-subtle-foreground',
          active && 'bg-surface-3 font-medium text-foreground [&_svg]:text-primary',
        )}
      >
        {icon}
        <span className="min-w-0 truncate">{label}</span>
        {badge && <span className="ml-auto shrink-0">{badge}</span>}
      </Link>
    </li>
  )
}

export function TicketsLayout() {
  const me = useMe()
  const { pathname } = useLocation()
  const search = useSearch({ strict: false }) as TicketsSearch
  const { clientId, siteId } = useScope()
  const canView = hasPermission(me, PERMISSIONS.ticketsView)
  const { counts } = useTicketCounts({ client_id: clientId, site_id: siteId }, canView)
  const { data: queues = [] } = useQuery({ ...ticketQueuesQuery, enabled: canView, meta: { silent: true } })
  const onQueue = pathname === '/tickets' || pathname === '/tickets/'

  return (
    <div className="flex h-full">
      <ContextPanel section="tickets" title="Tickets">
        {hasPermission(me, PERMISSIONS.ticketsManage) && (
          <div className="px-1 pb-2">
            <Button size="sm" className="w-full justify-start" onClick={() => openNewTicket({ client_id: clientId })}>
              <TicketPlus data-icon="inline-start" />
              New ticket
              <kbd className="ml-auto rounded-[4px] bg-black/15 px-1 font-sans text-[10px] font-medium">C</kbd>
            </Button>
          </div>
        )}
        <ContextGroup label="Views">
          {VIEWS.map((view) => (
            <NavItem
              key={view.id}
              active={onQueue && viewMatches(view, search)}
              search={view.search}
              icon={VIEW_ICON[view.id]}
              label={view.label}
              badge={<Count value={viewCount(view.id, counts)} tone={view.id === 'breached' ? 'critical' : view.id === 'due_soon' ? 'warning' : 'neutral'} />}
            />
          ))}
        </ContextGroup>
        {queues.length > 0 && (
          <ContextGroup label="Queues">
            {queues.map((queue) => (
              <NavItem
                key={queue.id}
                active={onQueue && search.queue === queue.id && !search.status && !search.assignee && !search.sla}
                search={{ queue: queue.id }}
                icon={<Layers />}
                label={queue.name}
                badge={<Count value={queue.open_tickets} />}
              />
            ))}
          </ContextGroup>
        )}
        <ContextGroup label="Workspace">
          <ContextLink to="/tickets/contacts" icon={<BookUser />}>
            Contacts
          </ContextLink>
          {hasPermission(me, PERMISSIONS.ticketsTime) && (
            <ContextLink to="/tickets/time" icon={<Timer />}>
              Time report
            </ContextLink>
          )}
        </ContextGroup>
        {hasPermission(me, PERMISSIONS.ticketsSettings) && (
          <ContextGroup label="Configure">
            <ContextLink to="/settings/tickets" icon={<Settings2 />}>
              Helpdesk settings
            </ContextLink>
          </ContextGroup>
        )}
      </ContextPanel>
      <div className="flex min-w-0 flex-1 flex-col">
        <nav aria-label="Tickets sections" className="flex shrink-0 [scrollbar-width:none] gap-1 overflow-x-auto border-b border-border bg-surface-1/60 px-3 py-2 md:hidden">
          {[
            { to: '/tickets' as const, label: 'Queue', icon: <Inbox />, active: onQueue || /^\/tickets\/(?!contacts|time)/.test(pathname) },
            { to: '/tickets/contacts' as const, label: 'Contacts', icon: <BookUser />, active: pathname.startsWith('/tickets/contacts') },
            ...(hasPermission(me, PERMISSIONS.ticketsTime) ? [{ to: '/tickets/time' as const, label: 'Time', icon: <Timer />, active: pathname.startsWith('/tickets/time') }] : []),
          ].map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={cn(
                'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-dense text-muted-foreground outline-none hover:bg-surface-3 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5',
                item.active && 'bg-surface-3 font-medium text-foreground',
              )}
            >
              {item.icon}
              {item.label}
            </Link>
          ))}
          {onQueue &&
            VIEWS.slice(0, 4).map((view) => (
              <Link
                key={view.id}
                to="/tickets"
                search={view.search}
                className={cn(
                  'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-dense text-muted-foreground outline-none hover:bg-surface-3 hover:text-foreground [&_svg]:size-3.5',
                  viewMatches(view, search) && 'bg-surface-3 font-medium text-foreground',
                )}
              >
                {VIEW_ICON[view.id]}
                {view.label}
                {viewCount(view.id, counts) ? <span className="tabular text-micro text-subtle-foreground">{viewCount(view.id, counts)}</span> : null}
              </Link>
            ))}
        </nav>
        <div className="min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
