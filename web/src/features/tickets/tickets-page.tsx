/* The ticket queue: a filterable, virtualised list with keyboard triage and bulk actions, beside the ticket pane. */
import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ArrowUpDown, ChevronDown, CircleCheck, Layers, ListFilter, RefreshCw, Search, Tag, TicketPlus, UserRound, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, Kbd } from '@/components/common/misc'
import { SimpleSelect } from '@/components/common/simple-select'
import { StatusDot } from '@/components/common/status-dot'
import { ticketsApi } from '@/lib/api/endpoints'
import { ticketKeys } from '@/lib/api/queries'
import { useStreamStatus } from '@/lib/api/stream'
import type { Ticket, TicketPriority, TicketSort, TicketSource, TicketStatus, TicketType } from '@/lib/api/types'
import { formatNumber } from '@/lib/format'
import { EMPTY_SELECTION, selectionReducer } from '@/lib/tickets/bulk'
import { parseTicketJump } from '@/lib/tickets/jump'
import {
  ACTIVE_STATUSES,
  PRIORITY_LABEL,
  PRIORITY_ORDER,
  SORT_LABEL,
  SORT_ORDER,
  SOURCE_LABEL,
  SOURCE_ORDER,
  STATUS_LABEL,
  STATUS_ORDER,
  TYPE_LABEL,
  TYPE_ORDER,
} from '@/lib/tickets/labels'
import { activeView, refinementCount, split, toggleIn, toTicketFilters, type TicketsSearch } from '@/lib/tickets/queue'
import { useScope } from '@/lib/scope'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { AssigneeMenu, PriorityMenu, QueueMenu, StatusMenu, TagPopover } from './ticket-controls'
import { TicketList } from './ticket-list'
import { openNewTicket, useFreshTickets } from './ticket-stores'
import { PriorityGlyph } from './ticket-ui'
import { STATUS_STYLE } from './ticket-styles'
import { TicketView } from './ticket-view'
import { useTicketActions } from './use-ticket-actions'

function isTyping(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

function ToggleChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-dense ring-1 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active ? 'bg-surface-4 font-medium text-foreground ring-border-strong' : 'text-muted-foreground ring-border hover:bg-surface-3 hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

function Placeholder({ counts }: { counts: { new: number; open: number; pending: number; on_hold: number; breached: number; mine: number } | undefined }) {
  const hints: [string[], string][] = [
    [['j', 'k'], 'Next / previous ticket'],
    [['Enter'], 'Open the full ticket page'],
    [['x'], 'Select for bulk actions'],
    [['a'], 'Assign to me'],
    [['e'], 'Mark resolved'],
    [['r'], 'Reply'],
    [['c'], 'New ticket'],
  ]
  const tiles: [string, number | undefined, string][] = [
    ['Mine', counts?.mine, 'text-primary'],
    ['New', counts?.new, 'text-info'],
    ['Breached', counts?.breached, counts?.breached ? 'text-critical' : 'text-subtle-foreground'],
  ]
  return (
    <div className="relative flex h-full flex-col items-center justify-center overflow-hidden p-8 text-center">
      <div className="bg-grid bg-grid-fade pointer-events-none absolute inset-0 opacity-50" aria-hidden="true" />
      <div className="relative w-full max-w-sm">
        <div className="mb-6 grid grid-cols-3 gap-2">
          {tiles.map(([label, value, tone]) => (
            <div key={label} className="rounded-xl bg-card px-3 py-3 shadow-card">
              <div className={cn('tabular font-display text-2xl leading-none font-semibold', value ? tone : 'text-subtle-foreground')}>{formatNumber(value ?? 0)}</div>
              <div className="mt-1 text-micro text-muted-foreground">{label}</div>
            </div>
          ))}
        </div>
        <p className="text-sm font-medium">Choose a ticket to read the conversation</p>
        <p className="mt-1 text-dense text-muted-foreground">Work the queue from the keyboard:</p>
        <ul className="mt-4 grid gap-1.5 text-left">
          {hints.map(([keysList, label]) => (
            <li key={label} className="flex items-center justify-between gap-3 rounded-lg bg-surface-2/70 px-3 py-1.5 text-dense ring-1 ring-border">
              <span className="text-muted-foreground">{label}</span>
              <span className="flex gap-1">
                {keysList.map((key) => (
                  <Kbd key={key}>{key}</Kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

export function TicketsPage({ search }: { search: TicketsSearch }) {
  useTitle('Tickets')
  const navigate = useNavigate()
  const me = useMe()
  const { clientId, siteId, setClient } = useScope()
  const canView = hasPermission(me, PERMISSIONS.ticketsView)
  const actions = useTicketActions()
  const fresh = useFreshTickets()
  const live = useStreamStatus() === 'open'
  const filters = useMemo(() => ({ ...toTicketFilters(search, clientId, siteId), limit: 100 }), [search, clientId, siteId])
  const composerRef = useRef<HTMLTextAreaElement | null>(null)

  const query = useInfiniteQuery({
    queryKey: ticketKeys.list(filters),
    queryFn: ({ pageParam }) => ticketsApi.list(filters, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    enabled: canView,
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  })
  const tickets = useMemo(() => {
    const seen = new Set<string>()
    return (query.data?.pages ?? []).flatMap((page) => page.items).filter((ticket) => !seen.has(ticket.id) && Boolean(seen.add(ticket.id)))
  }, [query.data])
  const counts = query.data?.pages[0]?.counts
  const [selection, dispatch] = useReducer(selectionReducer, EMPTY_SELECTION)
  const visibleIds = useMemo(() => new Set(tickets.map((ticket) => ticket.id)), [tickets])
  const selectedIds = useMemo(() => new Set(selection.ids.filter((id) => visibleIds.has(id))), [selection.ids, visibleIds])
  const selected = tickets.filter((ticket) => selectedIds.has(ticket.id))
  const current = search.ticket ? (tickets.find((ticket) => ticket.id === search.ticket) ?? null) : null
  const [draft, setDraft] = useState(search.q ?? '')
  const [syncedQ, setSyncedQ] = useState(search.q)
  if (syncedQ !== search.q) {
    setSyncedQ(search.q)
    setDraft(search.q ?? '')
  }
  const view = activeView(search)
  const queue = search.queue ? actions.queues.find((item) => item.id === search.queue) : undefined
  const title = queue ? queue.name : (view?.label ?? 'Tickets')

  const setSearch = (patch: Partial<TicketsSearch>) => void navigate({ from: '/tickets/', to: '/tickets', search: (prev) => ({ ...prev, ...patch }), replace: true })
  const open = (ticket: Ticket | null) => setSearch({ ticket: ticket?.id })

  // Debounced search box → URL; "#1042" jumps straight to that ticket when it is listed.
  useEffect(() => {
    if ((draft || undefined) === search.q) return
    const timer = window.setTimeout(() => setSearch({ q: draft.trim() || undefined }), 250)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])
  useEffect(() => {
    const number = search.q ? parseTicketJump(search.q) : null
    if (!number) return
    const match = tickets.find((ticket) => ticket.number === number)
    if (match && search.ticket !== match.id) setSearch({ ticket: match.id })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.q, tickets])

  const targets = () => (selected.length ? selected : current ? [current] : [])

  // Keyboard triage, installed once; the latest state lives in a ref.
  const latest = useRef({ tickets, current, selectedIds, targets, actions })
  useEffect(() => {
    latest.current = { tickets, current, selectedIds, targets, actions }
  })
  useEffect(() => {
    let lastG = 0
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return
      if (isTyping(event.target)) return
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"][data-open]')) return
      const now = Date.now()
      if (now - lastG < 1000) {
        lastG = 0
        return
      }
      if (event.key === 'g') {
        lastG = now
        return
      }
      const state = latest.current
      const move = (delta: number) => {
        if (!state.tickets.length) return
        const index = state.current ? state.tickets.findIndex((ticket) => ticket.id === state.current!.id) : -1
        const next = state.tickets[Math.max(0, Math.min(state.tickets.length - 1, index < 0 ? 0 : index + delta))]
        event.preventDefault()
        open(next)
      }
      switch (event.key) {
        case 'j':
        case 'ArrowDown':
          move(1)
          break
        case 'k':
        case 'ArrowUp':
          move(-1)
          break
        case 'x':
          if (state.current) {
            event.preventDefault()
            dispatch({ type: 'toggle', id: state.current.id })
          }
          break
        case 'Enter':
        case 'o':
          if (state.current) {
            event.preventDefault()
            void navigate({ to: '/tickets/$ticketId', params: { ticketId: state.current.id } })
          }
          break
        case 'a': {
          const list = state.targets()
          if (list.length && state.actions.canManage && state.actions.meId) {
            event.preventDefault()
            if (list.length === 1) state.actions.update(list[0], { assignee_id: state.actions.meId })
            else state.actions.bulk(list, { action: 'assign', value: state.actions.meId })
          }
          break
        }
        case 'e': {
          const list = state.targets().filter((ticket) => ticket.status !== 'resolved' && ticket.status !== 'closed')
          if (list.length && state.actions.canManage) {
            event.preventDefault()
            if (list.length === 1) state.actions.update(list[0], { status: 'resolved' })
            else state.actions.bulk(list, { action: 'status', value: 'resolved' })
          }
          break
        }
        case 'r':
          if (state.current) {
            event.preventDefault()
            composerRef.current?.focus()
          }
          break
        case 'c':
          if (state.actions.canManage) {
            event.preventDefault()
            openNewTicket({ client_id: clientId })
          }
          break
        case 'Escape':
          if (state.selectedIds.size) dispatch({ type: 'clear' })
          else if (state.current) open(null)
          break
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId])

  if (!canView) {
    return (
      <div className="h-full overflow-y-auto p-6">
        <EmptyState illustration="tickets" title="You can’t view tickets" description="Ask an administrator for the “View tickets” permission." />
      </div>
    )
  }

  const statuses = search.status === 'all' ? [] : search.status ? (split(search.status) as TicketStatus[]) : [...ACTIVE_STATUSES]
  const priorities = split(search.priority) as TicketPriority[]
  const types = split(search.type) as TicketType[]
  const sources = split(search.source) as TicketSource[]
  const refinements = refinementCount(search) + (search.assignee && !view ? 1 : 0)
  const allSelected = tickets.length > 0 && tickets.every((ticket) => selectedIds.has(ticket.id))
  const someSelected = selectedIds.size > 0 && !allSelected
  const isDefault = !search.q && refinementCount(search) === 0
  const tagSuggestions = [...new Set(tickets.flatMap((ticket) => ticket.tags))].sort()
  const chips: { key: string; label: string; clear: () => void }[] = []
  if (search.status && !view) chips.push({ key: 'status', label: search.status === 'all' ? 'Any status' : statuses.map((status) => STATUS_LABEL[status]).join(', '), clear: () => setSearch({ status: undefined }) })
  if (priorities.length) chips.push({ key: 'priority', label: priorities.map((priority) => PRIORITY_LABEL[priority]).join(', '), clear: () => setSearch({ priority: undefined }) })
  if (types.length) chips.push({ key: 'type', label: types.map((type) => TYPE_LABEL[type]).join(', '), clear: () => setSearch({ type: undefined }) })
  if (sources.length) chips.push({ key: 'source', label: `Via ${sources.map((source) => SOURCE_LABEL[source].toLowerCase()).join(', ')}`, clear: () => setSearch({ source: undefined }) })
  if (search.tag) chips.push({ key: 'tag', label: `#${search.tag}`, clear: () => setSearch({ tag: undefined }) })
  if (search.assignee && !view)
    chips.push({
      key: 'assignee',
      label: search.assignee === 'me' ? 'Assigned to me' : search.assignee === 'none' ? 'Unassigned' : `Assigned to ${actions.users.find((user) => user.id === search.assignee)?.name ?? 'someone'}`,
      clear: () => setSearch({ assignee: undefined }),
    })

  return (
    <div className="flex h-full min-h-0">
      {/* ------------------------------------------------ list pane */}
      <section
        aria-label="Ticket list"
        className={cn('min-h-0 w-full shrink-0 flex-col border-border lg:w-[440px] lg:border-r xl:w-[500px] 2xl:w-[540px]', search.ticket ? 'hidden lg:flex' : 'flex')}
      >
        <div className="grid shrink-0 gap-3 border-b border-border px-3.5 pt-4 pb-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2.5">
              <h1 className="font-display truncate text-[19px] leading-tight font-semibold tracking-tight">{title}</h1>
              <StatusDot tone={live ? 'live' : 'offline'} pulse={live} label={live ? 'Live' : 'Reconnecting'} />
              {query.isFetching && !query.isLoading && <Spinner className="size-3.5 text-subtle-foreground" />}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <SimpleSelect
                size="sm"
                ariaLabel="Sort tickets"
                className="h-7 w-auto gap-1.5 border-transparent bg-transparent px-2 text-dense text-muted-foreground shadow-none hover:bg-surface-3"
                value={search.sort ?? 'last_activity'}
                onValueChange={(value) => setSearch({ sort: value === 'last_activity' ? undefined : (value as TicketSort) })}
                options={SORT_ORDER.map((value) => ({ value, label: SORT_LABEL[value], icon: <ArrowUpDown className="size-3.5" /> }))}
              />
              <Button variant="ghost" size="icon-sm" aria-label="Refresh" onClick={() => void query.refetch()}>
                <RefreshCw className={cn(query.isFetching && 'animate-spin')} />
              </Button>
              {actions.canManage && (
                <Button size="sm" className="ml-1" onClick={() => openNewTicket({ client_id: clientId })} title="New ticket (c)">
                  <TicketPlus data-icon="inline-start" />
                  <span className="max-sm:sr-only">New</span>
                </Button>
              )}
            </div>
          </div>
          {counts && (
            <div className="flex flex-wrap items-center gap-1.5">
              {(['new', 'open', 'pending', 'on_hold'] as const).map((status) => {
                const active = statuses.length === 1 && statuses[0] === status
                return (
                  <button
                    key={status}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setSearch({ status: active ? undefined : status })}
                    className={cn(
                      'inline-flex h-6 items-center gap-1.5 rounded-full px-2 text-micro ring-1 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active ? cn('ring-inset', STATUS_STYLE[status].soft) : 'text-muted-foreground ring-border hover:bg-surface-3',
                    )}
                  >
                    <span className={cn('size-1.5 rounded-full', counts[status] ? STATUS_STYLE[status].dot : 'bg-surface-4')} />
                    <span className="tabular font-semibold text-foreground">{formatNumber(counts[status])}</span>
                    {STATUS_LABEL[status].toLowerCase()}
                  </button>
                )
              })}
              {counts.breached > 0 && (
                <button
                  type="button"
                  onClick={() => setSearch({ sla: search.sla === 'breached' ? undefined : 'breached' })}
                  className="ml-auto inline-flex h-6 items-center gap-1.5 rounded-full bg-critical/10 px-2 text-micro font-medium text-critical ring-1 ring-critical/25 hover:bg-critical/15"
                >
                  <span className="size-1.5 animate-pulse-ring rounded-full bg-critical text-critical" />
                  <span className="tabular font-semibold">{counts.breached}</span> breached
                </button>
              )}
            </div>
          )}
          <div className="flex items-center gap-2">
            <Checkbox
              aria-label={allSelected ? 'Clear selection' : 'Select all visible tickets'}
              checked={allSelected}
              indeterminate={someSelected}
              disabled={!tickets.length}
              onCheckedChange={() => dispatch({ type: 'all', ids: tickets.map((ticket) => ticket.id) })}
              className="ml-0.5"
            />
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle-foreground" />
              <Input
                data-filter-input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setDraft('')
                    ;(event.target as HTMLInputElement).blur()
                  }
                }}
                placeholder="Search subject, client, contact, #1042…"
                aria-label="Search tickets"
                className="h-8 pl-8"
              />
            </div>
            <Popover>
              <PopoverTrigger render={<Button variant="outline" size="sm" className="h-8 shrink-0" />}>
                <ListFilter data-icon="inline-start" />
                Filters
                {refinements > 0 && <span className="tabular rounded-full bg-primary/15 px-1.5 text-[10px] font-semibold text-primary">{refinements}</span>}
              </PopoverTrigger>
              <PopoverContent align="end" className="grid w-[min(24rem,calc(100vw-2rem))] gap-4">
                <div className="grid gap-1.5">
                  <span className="eyebrow">Status</span>
                  <div className="flex flex-wrap gap-1.5">
                    {STATUS_ORDER.map((status) => (
                      <ToggleChip
                        key={status}
                        active={statuses.includes(status)}
                        onClick={() => {
                          const next = toggleIn(statuses, status)
                          const isActiveSet = next.length === ACTIVE_STATUSES.length && ACTIVE_STATUSES.every((item) => next.includes(item))
                          setSearch({ status: next.length === 0 || next.length === STATUS_ORDER.length ? 'all' : isActiveSet ? undefined : next.join(',') })
                        }}
                      >
                        <span className={cn('size-1.5 rounded-full', STATUS_STYLE[status].dot)} />
                        {STATUS_LABEL[status]}
                      </ToggleChip>
                    ))}
                  </div>
                </div>
                <div className="grid gap-1.5">
                  <span className="eyebrow">Priority</span>
                  <div className="flex flex-wrap gap-1.5">
                    {PRIORITY_ORDER.map((priority) => (
                      <ToggleChip key={priority} active={priorities.includes(priority)} onClick={() => setSearch({ priority: toggleIn(priorities, priority).join(',') || undefined })}>
                        <PriorityGlyph priority={priority} />
                        {PRIORITY_LABEL[priority]}
                      </ToggleChip>
                    ))}
                  </div>
                </div>
                <div className="grid gap-1.5">
                  <span className="eyebrow">Source</span>
                  <div className="flex flex-wrap gap-1.5">
                    {SOURCE_ORDER.map((source) => (
                      <ToggleChip key={source} active={sources.includes(source)} onClick={() => setSearch({ source: toggleIn(sources, source).join(',') || undefined })}>
                        {SOURCE_LABEL[source]}
                      </ToggleChip>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="grid gap-1.5">
                    <span className="eyebrow">Type</span>
                    <SimpleSelect
                      size="sm"
                      ariaLabel="Type"
                      value={types.length === 1 ? types[0] : ''}
                      onValueChange={(value) => setSearch({ type: value || undefined })}
                      options={[{ value: '', label: 'Any type' }, ...TYPE_ORDER.map((type) => ({ value: type, label: TYPE_LABEL[type] }))]}
                    />
                  </label>
                  <label className="grid gap-1.5">
                    <span className="eyebrow">Queue</span>
                    <SimpleSelect
                      size="sm"
                      ariaLabel="Queue"
                      value={search.queue ?? ''}
                      onValueChange={(value) => setSearch({ queue: value || undefined })}
                      options={[{ value: '', label: 'Every queue' }, ...actions.queues.map((item) => ({ value: item.id, label: item.name }))]}
                    />
                  </label>
                  <label className="grid gap-1.5">
                    <span className="eyebrow">Assignee</span>
                    <SimpleSelect
                      size="sm"
                      ariaLabel="Assignee"
                      value={search.assignee ?? ''}
                      onValueChange={(value) => setSearch({ assignee: value || undefined })}
                      options={[
                        { value: '', label: 'Anyone' },
                        { value: 'me', label: 'Me' },
                        { value: 'none', label: 'Unassigned' },
                        ...actions.users.filter((user) => user.id !== me?.user.id).map((user) => ({ value: user.id, label: user.name, group: 'Team' })),
                      ]}
                    />
                  </label>
                  <label className="grid gap-1.5">
                    <span className="eyebrow">Tag</span>
                    <SimpleSelect
                      size="sm"
                      ariaLabel="Tag"
                      value={search.tag ?? ''}
                      onValueChange={(value) => setSearch({ tag: value || undefined })}
                      options={[{ value: '', label: 'Any tag' }, ...[...new Set([...(search.tag ? [search.tag] : []), ...tagSuggestions])].map((tag) => ({ value: tag, label: tag }))]}
                    />
                  </label>
                </div>
                {(chips.length > 0 || clientId) && (
                  <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => void navigate({ to: '/tickets', search: () => ({ queue: search.queue, sort: search.sort }), replace: true })}>
                    <X data-icon="inline-start" />
                    Clear filters
                  </Button>
                )}
              </PopoverContent>
            </Popover>
          </div>
          {(chips.length > 0 || clientId) && (
            <div className="flex flex-wrap gap-1.5">
              {chips.map((chip) => (
                <span key={chip.key} className="inline-flex h-6 max-w-full items-center gap-1 rounded-md bg-surface-3 pr-0.5 pl-2 text-micro ring-1 ring-border">
                  <span className="truncate">{chip.label}</span>
                  <button type="button" aria-label={`Remove filter ${chip.label}`} onClick={chip.clear} className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-surface-4 hover:text-foreground">
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              {clientId && (
                <span className="inline-flex h-6 max-w-full items-center gap-1 rounded-md bg-primary/8 pr-0.5 pl-2 text-micro text-primary ring-1 ring-primary/20">
                  <span className="truncate">Client scope</span>
                  <button type="button" aria-label="Clear client scope" onClick={() => setClient(null)} className="flex size-5 items-center justify-center rounded-sm hover:bg-primary/10">
                    <X className="size-3" />
                  </button>
                </span>
              )}
            </div>
          )}
        </div>

        {selected.length > 0 && (
          <div className="flex shrink-0 items-center gap-2 border-b border-border bg-primary/[0.04] px-3.5 py-2">
            <span className="shrink-0 text-dense font-medium tabular">{formatNumber(selected.length)} selected</span>
            {actions.canManage ? (
              <div className="flex min-w-0 flex-1 items-center justify-end gap-1 overflow-x-auto [scrollbar-width:none]">
                <AssigneeMenu
                  users={actions.users}
                  meId={actions.meId}
                  value={undefined}
                  align="end"
                  onChange={(id) => actions.bulk(selected, { action: 'assign', value: id })}
                  trigger={
                    <Button size="xs" variant="outline" className="shrink-0" title="Assign (a assigns to me)">
                      <UserRound data-icon="inline-start" />
                      Assign
                      <ChevronDown data-icon="inline-end" />
                    </Button>
                  }
                />
                <StatusMenu
                  align="end"
                  onChange={(status) => actions.bulk(selected, { action: 'status', value: status })}
                  trigger={
                    <Button size="xs" variant="outline" className="shrink-0" title="Status (e resolves)">
                      <CircleCheck data-icon="inline-start" />
                      Status
                      <ChevronDown data-icon="inline-end" />
                    </Button>
                  }
                />
                <PriorityMenu
                  align="end"
                  onChange={(priority) => actions.bulk(selected, { action: 'priority', value: priority })}
                  trigger={
                    <Button size="xs" variant="outline" className="shrink-0">
                      <PriorityGlyph priority="high" />
                      Priority
                      <ChevronDown data-icon="inline-end" />
                    </Button>
                  }
                />
                <QueueMenu
                  align="end"
                  queues={actions.queues}
                  onChange={(id) => actions.bulk(selected, { action: 'queue', value: id })}
                  trigger={
                    <Button size="xs" variant="outline" className="shrink-0">
                      <Layers data-icon="inline-start" />
                      Queue
                      <ChevronDown data-icon="inline-end" />
                    </Button>
                  }
                />
                <TagPopover
                  suggestions={tagSuggestions}
                  onApply={(value) => actions.bulk(selected, { action: 'tag', value })}
                  trigger={
                    <Button size="xs" variant="outline" className="shrink-0">
                      <Tag data-icon="inline-start" />
                      Tag
                    </Button>
                  }
                />
              </div>
            ) : (
              <span className="min-w-0 flex-1 truncate text-micro text-muted-foreground">Bulk changes need the “Work tickets” permission</span>
            )}
            <Button size="icon-xs" variant="ghost" aria-label="Clear selection" onClick={() => dispatch({ type: 'clear' })}>
              <X />
            </Button>
          </div>
        )}

        {query.error ? (
          <div className="p-4">
            <ErrorState error={query.error} onRetry={() => void query.refetch()} />
          </div>
        ) : query.isLoading ? (
          <div className="grid gap-px p-3">
            {Array.from({ length: 8 }, (_, index) => (
              <Skeleton key={index} className="h-16 rounded-lg" />
            ))}
          </div>
        ) : tickets.length === 0 ? (
          <div className="p-4">
            <EmptyState
              compact
              illustration={isDefault ? 'tickets' : 'search'}
              title={isDefault ? (view?.id === 'mine' ? 'Nothing assigned to you' : 'Queue is clear') : 'No tickets match'}
              description={isDefault ? 'New tickets from email, alerts and the agent land here the moment they arrive.' : search.q ? `Nothing matches “${search.q}” with these filters.` : 'Try widening the filters.'}
              actions={
                isDefault ? (
                  actions.canManage && (
                    <Button size="sm" onClick={() => openNewTicket({ client_id: clientId })}>
                      <TicketPlus data-icon="inline-start" />
                      New ticket
                    </Button>
                  )
                ) : (
                  <Button size="sm" variant="outline" onClick={() => void navigate({ to: '/tickets', search: () => ({}), replace: true })}>
                    Clear filters
                  </Button>
                )
              }
            />
          </div>
        ) : (
          <TicketList
            tickets={tickets}
            currentId={search.ticket}
            selectedIds={selectedIds}
            freshIds={fresh}
            meId={me?.user.id}
            onOpen={open}
            onToggle={(ticket) => dispatch({ type: 'toggle', id: ticket.id })}
            onRange={(ticket) => dispatch({ type: 'range', id: ticket.id, order: tickets.map((item) => item.id) })}
            footer={
              query.hasNextPage && (
                <div className="flex justify-center p-3">
                  <Button variant="outline" size="sm" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
                    {query.isFetchingNextPage && <Spinner data-icon="inline-start" />}
                    Load more
                  </Button>
                </div>
              )
            }
          />
        )}
      </section>

      {/* ------------------------------------------------ detail pane */}
      <section aria-label="Ticket detail" className={cn('min-h-0 min-w-0 flex-1 flex-col bg-surface-1/40', search.ticket ? 'flex' : 'hidden lg:flex')}>
        {search.ticket ? (
          <TicketView key={search.ticket} ticketId={search.ticket} variant="pane" onBack={() => open(null)} composerRef={composerRef} />
        ) : (
          <Placeholder counts={counts} />
        )}
      </section>
      <span className="sr-only" aria-live="polite">
        {current ? `Ticket ${current.number} open` : ''}
      </span>
    </div>
  )
}
