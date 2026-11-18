/* The alerts inbox: a filterable, grouped list with keyboard triage and bulk actions, beside the detail pane. */
import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  ChevronDown,
  CircleCheck,
  ListFilter,
  Moon,
  RefreshCw,
  Rows3,
  Search,
  UserCheck,
  UserRound,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, Kbd } from '@/components/common/misc'
import { SimpleSelect } from '@/components/common/simple-select'
import { StatusDot } from '@/components/common/status-dot'
import { alertsApi } from '@/lib/api/endpoints'
import { checkTypesQuery, clientsQuery, fleetQuery, keys, sitesQuery } from '@/lib/api/queries'
import { useStreamStatus } from '@/lib/api/stream'
import type { Alert, AlertSeverity, AlertSource, AlertStatus } from '@/lib/api/types'
import {
  activeFilterCount,
  DEFAULT_STATUSES,
  flattenGroups,
  groupAlerts,
  toApiFilters,
  type AlertGrouping,
  type InboxFilters,
} from '@/lib/monitoring/alerts'
import { EMPTY_SELECTION, selectionReducer } from '@/lib/monitoring/bulk'
import {
  checkTypeLabel,
  SERVER_CHECK_LABEL,
  SEVERITY_LABEL,
  SEVERITY_ORDER,
  SNOOZE_PRESETS,
  SOURCE_LABEL,
  STATUS_LABEL,
  STATUS_ORDER,
} from '@/lib/monitoring/labels'
import { formatNumber } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useScope } from '@/lib/scope'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { AssignMenu, ResolveDialog, SnoozeDialog, SnoozeMenu, type SnoozeChoice } from './alert-action-controls'
import { AlertDetailPane } from './alert-detail'
import { AllClear, AlertList } from './alert-list'
import { selectedAlertStore, useFreshAlerts } from './alert-stores'
import { useAlertActions } from './use-alert-actions'
import { SEVERITY_STYLE } from './monitoring-styles'

export interface AlertsSearch {
  status?: string
  severity?: string
  source?: AlertSource
  check_type?: string
  assigned?: string
  q?: string
  group?: 'severity' | 'client' | 'status' | 'none'
  alert?: string
}

const split = (value: string | undefined) => (value ? value.split(',').filter(Boolean) : [])

function filtersFrom(search: AlertsSearch, clientId?: string, siteId?: string): InboxFilters {
  return {
    status: search.status === 'all' ? [] : search.status ? (split(search.status) as AlertStatus[]) : [...DEFAULT_STATUSES],
    severity: split(search.severity) as AlertSeverity[],
    client_id: clientId,
    site_id: siteId,
    source: search.source,
    check_type: search.check_type,
    assigned: search.assigned,
    q: search.q,
  }
}

function isTyping(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

function ToggleChip({ active, onClick, children, className }: { active: boolean; onClick: () => void; children: ReactNode; className?: string }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-dense ring-1 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active ? 'bg-surface-4 font-medium text-foreground ring-border-strong' : 'text-muted-foreground ring-border hover:bg-surface-3 hover:text-foreground',
        className,
      )}
    >
      {children}
    </button>
  )
}

/** Quick snooze picker for the `s` shortcut: number keys pick a preset. */
function SnoozePicker({ count, onPick, onClose }: { count: number; onPick: (choice: SnoozeChoice) => void; onClose: () => void }) {
  const [custom, setCustom] = useState(false)
  if (custom) return <SnoozeDialog open count={count} onOpenChange={(open) => !open && onClose()} onConfirm={onPick} />
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="sm:max-w-[380px]"
        onKeyDown={(event) => {
          const preset = SNOOZE_PRESETS[Number(event.key) - 1]
          if (preset) {
            event.preventDefault()
            onPick({ minutes: preset.minutes })
            onClose()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Snooze {count > 1 ? `${count} alerts` : 'alert'}</DialogTitle>
          <DialogDescription>Notifications and escalation pause. Press a number to pick.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          {SNOOZE_PRESETS.map((preset, index) => (
            <Button
              key={preset.minutes}
              variant="outline"
              className="justify-between"
              autoFocus={index === 1}
              onClick={() => {
                onPick({ minutes: preset.minutes })
                onClose()
              }}
            >
              <span className="inline-flex items-center gap-2">
                <Moon className="text-subtle-foreground" />
                {preset.label}
              </span>
              <Kbd>{index + 1}</Kbd>
            </Button>
          ))}
          <Button variant="ghost" className="col-span-2" onClick={() => setCustom(true)}>
            Pick a date and time…
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function DetailPlaceholder({ counts }: { counts: { critical: number; warning: number; info: number } | undefined }) {
  const hints: [string[], string][] = [
    [['j', 'k'], 'Next / previous alert'],
    [['x'], 'Select for bulk actions'],
    [['a'], 'Acknowledge'],
    [['r'], 'Resolve with a note'],
    [['s'], 'Snooze'],
    [['Esc'], 'Clear the selection'],
  ]
  return (
    <div className="relative flex h-full flex-col items-center justify-center overflow-hidden p-8 text-center">
      <div className="bg-grid bg-grid-fade pointer-events-none absolute inset-0 opacity-50" aria-hidden="true" />
      <div className="relative w-full max-w-sm">
        {counts && (
          <div className="mb-6 grid grid-cols-3 gap-2">
            {SEVERITY_ORDER.map((severity) => (
              <div key={severity} className="rounded-xl bg-card px-3 py-3 shadow-card">
                <div className={cn('tabular font-display text-2xl leading-none font-semibold', counts[severity] ? SEVERITY_STYLE[severity].text : 'text-subtle-foreground')}>
                  {formatNumber(counts[severity])}
                </div>
                <div className="mt-1 text-micro text-muted-foreground">{SEVERITY_LABEL[severity]}</div>
              </div>
            ))}
          </div>
        )}
        <p className="text-sm font-medium">Choose an alert to see its timeline</p>
        <p className="mt-1 text-dense text-muted-foreground">Triage faster from the keyboard:</p>
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

export function AlertsPage({ search }: { search: AlertsSearch }) {
  useTitle('Alerts')
  const navigate = useNavigate()
  const me = useMe()
  const { clientId, siteId, setClient, setSite } = useScope()
  const canView = hasPermission(me, PERMISSIONS.alertsView)
  const actions = useAlertActions()
  const fresh = useFreshAlerts()
  const live = useStreamStatus() === 'open'
  const filters = useMemo(() => filtersFrom(search, clientId, siteId), [search, clientId, siteId])
  const apiFilters = useMemo(() => toApiFilters(filters), [filters])
  const grouping: AlertGrouping = search.group ?? 'severity'
  const { data: catalog } = useQuery({ ...checkTypesQuery, enabled: canView, meta: { silent: true } })
  const { data: clients = [] } = useQuery(clientsQuery())
  const { data: sites = [] } = useQuery({ ...sitesQuery(clientId), enabled: Boolean(clientId) })
  const { data: fleet } = useQuery(fleetQuery(clientId, siteId))

  const query = useInfiniteQuery({
    queryKey: keys.alertList(apiFilters),
    queryFn: ({ pageParam }) => alertsApi.list(apiFilters, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    enabled: canView,
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  })
  const alerts = useMemo(() => {
    const seen = new Set<string>()
    return (query.data?.pages ?? []).flatMap((page) => page.items).filter((alert) => !seen.has(alert.id) && Boolean(seen.add(alert.id)))
  }, [query.data])
  const counts = query.data?.pages[0]?.counts
  const groups = useMemo(() => groupAlerts(alerts, grouping), [alerts, grouping])
  const ordered = useMemo(() => flattenGroups(groups), [groups])
  const [selection, dispatch] = useReducer(selectionReducer, EMPTY_SELECTION)
  const visibleIds = useMemo(() => new Set(ordered.map((alert) => alert.id)), [ordered])
  const selectedIds = useMemo(() => new Set(selection.ids.filter((id) => visibleIds.has(id))), [selection.ids, visibleIds])
  const selected = ordered.filter((alert) => selectedIds.has(alert.id))
  const current = search.alert ? (alerts.find((alert) => alert.id === search.alert) ?? null) : null
  const [resolving, setResolving] = useState<Alert[] | null>(null)
  const [snoozing, setSnoozing] = useState<Alert[] | null>(null)
  const [draft, setDraft] = useState(search.q ?? '')
  const [syncedQ, setSyncedQ] = useState(search.q)
  if (syncedQ !== search.q) {
    setSyncedQ(search.q)
    setDraft(search.q ?? '')
  }
  const filterCount = activeFilterCount(filters) - (clientId ? 1 : 0) - (siteId ? 1 : 0)

  const setSearch = (patch: Partial<AlertsSearch>) =>
    void navigate({ from: '/alerts/', to: '/alerts', search: (prev) => ({ ...prev, ...patch }), replace: true })
  const open = (alert: Alert | null) => setSearch({ alert: alert?.id })

  // Debounced search box → URL.
  useEffect(() => {
    if ((draft || undefined) === search.q) return
    const timer = window.setTimeout(() => setSearch({ q: draft.trim() || undefined }), 250)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])

  // Share the open alert with the command palette.
  const detailAlert = current
  useEffect(() => {
    selectedAlertStore.set(detailAlert)
  }, [detailAlert])
  useEffect(() => () => selectedAlertStore.set(null), [])

  const targets = () => (selected.length ? selected : current ? [current] : [])
  const acknowledge = (list: Alert[]) => {
    if (!actions.canManage || list.length === 0) return
    if (list.length === 1) {
      const [alert] = list
      if (alert.status === 'open') actions.act(alert, { action: 'acknowledge' })
      else if (alert.status === 'acknowledged') actions.act(alert, { action: 'unacknowledge' })
    } else actions.bulk(list, { action: 'acknowledge' })
  }
  const snooze = (list: Alert[], choice: SnoozeChoice) => {
    if (list.length === 1) actions.act(list[0], { action: 'snooze', ...choice })
    else actions.bulk(list, 'minutes' in choice ? { action: 'snooze', minutes: choice.minutes } : { action: 'snooze', until: choice.until })
  }

  // Keyboard triage. The latest state lives in a ref so the listener is installed once.
  const latest = useRef({ ordered, current, selectedIds, targets, acknowledge })
  useEffect(() => {
    latest.current = { ordered, current, selectedIds, targets, acknowledge }
  })
  useEffect(() => {
    let lastG = 0
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return
      if (isTyping(event.target)) return
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"][data-open]')) return
      const now = Date.now()
      const key = event.key
      // "g" starts the global go-to sequences (g a, g s …); never treat its second key as a triage action.
      if (now - lastG < 1000) {
        lastG = 0
        return
      }
      if (key === 'g') {
        lastG = now
        return
      }
      const state = latest.current
      const move = (delta: number) => {
        if (!state.ordered.length) return
        const index = state.current ? state.ordered.findIndex((alert) => alert.id === state.current!.id) : -1
        const next = state.ordered[Math.max(0, Math.min(state.ordered.length - 1, index < 0 ? 0 : index + delta))]
        event.preventDefault()
        open(next)
      }
      switch (key) {
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
        case 'a':
          event.preventDefault()
          state.acknowledge(state.targets().filter((alert) => alert.status !== 'resolved'))
          break
        case 'r': {
          const list = state.targets().filter((alert) => alert.status !== 'resolved')
          if (list.length && actions.canManage) {
            event.preventDefault()
            setResolving(list)
          }
          break
        }
        case 's': {
          const list = state.targets().filter((alert) => alert.status !== 'resolved')
          if (list.length && actions.canManage) {
            event.preventDefault()
            setSnoozing(list)
          }
          break
        }
        case 'Escape':
          if (state.selectedIds.size) dispatch({ type: 'clear' })
          else if (state.current) open(null)
          break
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions.canManage])

  if (!canView) {
    return (
      <div className="h-full overflow-y-auto p-6">
        <EmptyState illustration="alerts" title="You can’t view alerts" description="Ask an administrator for the “View alerts” permission." />
      </div>
    )
  }

  const scopeName = clientId ? clients.find((client) => client.id === clientId)?.name : undefined
  const isDefaultView = filterCount === 0 && !search.q
  const allSelected = ordered.length > 0 && ordered.every((alert) => selectedIds.has(alert.id))
  const someSelected = selectedIds.size > 0 && !allSelected
  const checkTypeOptions = [
    { value: '', label: 'Any check' },
    ...(catalog ?? []).map((type) => ({ value: type.type, label: type.label, group: 'Agent checks' })),
    ...['offline', 'agent_outdated', 'disk_forecast', 'security', 'patching'].map((type) => ({
      value: type,
      label: type === 'security' ? 'Security changes' : type === 'patching' ? 'Patch installs' : (SERVER_CHECK_LABEL[type] ?? checkTypeLabel(type)),
      group: 'Server checks',
    })),
  ]
  const toggleList = <T extends string>(list: T[], value: T) => (list.includes(value) ? list.filter((item) => item !== value) : [...list, value])
  const chips: { key: string; label: string; clear: () => void }[] = []
  if (search.status) chips.push({ key: 'status', label: search.status === 'all' ? 'Any status' : filters.status.map((status) => STATUS_LABEL[status]).join(', '), clear: () => setSearch({ status: undefined }) })
  if (filters.severity.length) chips.push({ key: 'severity', label: filters.severity.map((severity) => SEVERITY_LABEL[severity]).join(', '), clear: () => setSearch({ severity: undefined }) })
  if (search.source) chips.push({ key: 'source', label: SOURCE_LABEL[search.source], clear: () => setSearch({ source: undefined }) })
  if (search.check_type) chips.push({ key: 'check', label: checkTypeOptions.find((option) => option.value === search.check_type)?.label ?? search.check_type, clear: () => setSearch({ check_type: undefined }) })
  if (search.assigned)
    chips.push({
      key: 'assigned',
      label: search.assigned === 'me' ? 'Assigned to me' : search.assigned === 'none' ? 'Unassigned' : `Assigned to ${actions.users.find((user) => user.id === search.assigned)?.name ?? 'someone'}`,
      clear: () => setSearch({ assigned: undefined }),
    })
  if (clientId) chips.push({ key: 'client', label: scopeName ?? 'Client', clear: () => setClient(null) })
  if (siteId) chips.push({ key: 'site', label: sites.find((site) => site.id === siteId)?.name ?? 'Site', clear: () => setSite(null) })

  return (
    <div className="flex h-full min-h-0">
      {/* ------------------------------------------------ list pane */}
      <section
        aria-label="Alert list"
        className={cn(
          'min-h-0 w-full shrink-0 flex-col border-border lg:w-[420px] lg:border-r xl:w-[460px] 2xl:w-[500px]',
          search.alert ? 'hidden lg:flex' : 'flex',
        )}
      >
        <div className="grid shrink-0 gap-3 border-b border-border px-3.5 pt-4 pb-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2.5">
              <h1 className="font-display text-[19px] leading-tight font-semibold tracking-tight">Alerts</h1>
              <StatusDot tone={live ? 'live' : 'offline'} pulse={live} label={live ? 'Live' : 'Reconnecting'} />
              {query.isFetching && !query.isLoading && <Spinner className="size-3.5 text-subtle-foreground" />}
            </div>
            <div className="flex items-center gap-1">
              <SimpleSelect
                size="sm"
                ariaLabel="Group alerts by"
                className="h-7 w-auto gap-1.5 border-transparent bg-transparent px-2 text-dense text-muted-foreground shadow-none hover:bg-surface-3"
                value={grouping}
                onValueChange={(value) => setSearch({ group: value === 'severity' ? undefined : (value as AlertGrouping) })}
                options={[
                  { value: 'severity', label: 'By severity', icon: <Rows3 className="size-3.5" /> },
                  { value: 'client', label: 'By client', icon: <Rows3 className="size-3.5" /> },
                  { value: 'status', label: 'By status', icon: <Rows3 className="size-3.5" /> },
                  { value: 'none', label: 'Not grouped', icon: <Rows3 className="size-3.5" /> },
                ]}
              />
              <Button variant="ghost" size="icon-sm" aria-label="Refresh" onClick={() => void query.refetch()}>
                <RefreshCw className={cn(query.isFetching && 'animate-spin')} />
              </Button>
            </div>
          </div>
          {counts && (
            <div className="flex flex-wrap items-center gap-1.5">
              {SEVERITY_ORDER.map((severity) => {
                const active = filters.severity.length === 1 && filters.severity[0] === severity
                return (
                  <button
                    key={severity}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setSearch({ severity: active ? undefined : severity })}
                    className={cn(
                      'inline-flex h-6 items-center gap-1.5 rounded-full px-2 text-micro ring-1 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active ? SEVERITY_STYLE[severity].soft : 'text-muted-foreground ring-border hover:bg-surface-3',
                    )}
                  >
                    <span className={cn('size-1.5 rounded-full', counts[severity] ? SEVERITY_STYLE[severity].dot : 'bg-surface-4')} />
                    <span className="tabular font-semibold text-foreground">{formatNumber(counts[severity])}</span>
                    {SEVERITY_LABEL[severity].toLowerCase()}
                  </button>
                )
              })}
              <span className="ml-auto text-micro text-subtle-foreground tabular">
                {formatNumber(counts.open)} open · {formatNumber(counts.acknowledged)} acknowledged
              </span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Checkbox
              aria-label={allSelected ? 'Clear selection' : 'Select all visible alerts'}
              checked={allSelected}
              indeterminate={someSelected}
              disabled={!ordered.length}
              onCheckedChange={() => dispatch({ type: 'all', ids: ordered.map((alert) => alert.id) })}
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
                placeholder="Search title, host, message…"
                aria-label="Search alerts"
                className="h-8 pl-8"
              />
            </div>
            <Popover>
              <PopoverTrigger render={<Button variant="outline" size="sm" className="h-8 shrink-0" />}>
                <ListFilter data-icon="inline-start" />
                Filters
                {filterCount > 0 && <span className="tabular rounded-full bg-primary/15 px-1.5 text-[10px] font-semibold text-primary">{filterCount}</span>}
              </PopoverTrigger>
              <PopoverContent align="end" className="grid w-[min(22rem,calc(100vw-2rem))] gap-4">
                <div className="grid gap-1.5">
                  <span className="eyebrow">Status</span>
                  <div className="flex flex-wrap gap-1.5">
                    {STATUS_ORDER.map((status) => (
                      <ToggleChip
                        key={status}
                        active={filters.status.includes(status)}
                        onClick={() => {
                          const next = toggleList(filters.status, status)
                          const isDefault = next.length === 2 && DEFAULT_STATUSES.every((item) => next.includes(item))
                          setSearch({ status: next.length === 0 || next.length === 3 ? 'all' : isDefault ? undefined : next.join(',') })
                        }}
                      >
                        {STATUS_LABEL[status]}
                      </ToggleChip>
                    ))}
                  </div>
                </div>
                <div className="grid gap-1.5">
                  <span className="eyebrow">Severity</span>
                  <div className="flex flex-wrap gap-1.5">
                    {SEVERITY_ORDER.map((severity) => (
                      <ToggleChip
                        key={severity}
                        active={filters.severity.includes(severity)}
                        onClick={() => setSearch({ severity: toggleList(filters.severity, severity).join(',') || undefined })}
                      >
                        <span className={cn('size-1.5 rounded-full', SEVERITY_STYLE[severity].dot)} />
                        {SEVERITY_LABEL[severity]}
                      </ToggleChip>
                    ))}
                  </div>
                </div>
                <div className="grid gap-1.5">
                  <span className="eyebrow">Source</span>
                  <div className="flex flex-wrap gap-1.5">
                    {([undefined, 'check', 'server', 'snmp'] as (AlertSource | undefined)[]).map((source) => (
                      <ToggleChip key={source ?? 'any'} active={search.source === source} onClick={() => setSearch({ source })}>
                        {source ? SOURCE_LABEL[source] : 'Any'}
                      </ToggleChip>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="grid gap-1.5">
                    <span className="eyebrow">Check</span>
                    <SimpleSelect
                      size="sm"
                      ariaLabel="Check type"
                      value={search.check_type ?? ''}
                      onValueChange={(value) => setSearch({ check_type: value || undefined })}
                      options={checkTypeOptions}
                    />
                  </label>
                  <label className="grid gap-1.5">
                    <span className="eyebrow">Assignee</span>
                    <SimpleSelect
                      size="sm"
                      ariaLabel="Assignee"
                      value={search.assigned ?? ''}
                      onValueChange={(value) => setSearch({ assigned: value || undefined })}
                      options={[
                        { value: '', label: 'Anyone' },
                        { value: 'me', label: 'Me' },
                        { value: 'none', label: 'Unassigned' },
                        ...actions.users.filter((user) => user.id !== me?.user.id).map((user) => ({ value: user.id, label: user.name, group: 'Team' })),
                      ]}
                    />
                  </label>
                  <label className="grid gap-1.5">
                    <span className="eyebrow">Client</span>
                    <SimpleSelect
                      size="sm"
                      ariaLabel="Client"
                      value={clientId ?? ''}
                      onValueChange={(value) => setClient(value || null)}
                      options={[{ value: '', label: 'All clients' }, ...clients.map((client) => ({ value: client.id, label: client.name }))]}
                    />
                  </label>
                  <label className="grid gap-1.5">
                    <span className="eyebrow">Site</span>
                    <SimpleSelect
                      size="sm"
                      ariaLabel="Site"
                      disabled={!clientId}
                      placeholder={clientId ? 'All sites' : 'Choose a client first'}
                      value={siteId ?? ''}
                      onValueChange={(value) => setSite(value || null)}
                      options={[{ value: '', label: 'All sites' }, ...sites.map((site) => ({ value: site.id, label: site.name }))]}
                    />
                  </label>
                </div>
                {chips.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="justify-self-start"
                    onClick={() => {
                      void navigate({ to: '/alerts', search: () => ({ group: search.group }), replace: true })
                    }}
                  >
                    <X data-icon="inline-start" />
                    Clear filters
                  </Button>
                )}
              </PopoverContent>
            </Popover>
          </div>
          {chips.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {chips.map((chip) => (
                <span key={chip.key} className="inline-flex h-6 max-w-full items-center gap-1 rounded-md bg-surface-3 pr-0.5 pl-2 text-micro ring-1 ring-border">
                  <span className="truncate">{chip.label}</span>
                  <button
                    type="button"
                    aria-label={`Remove filter ${chip.label}`}
                    onClick={chip.clear}
                    className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-surface-4 hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {selected.length > 0 && (
          <div className="flex shrink-0 items-center gap-2 border-b border-border bg-primary/[0.04] px-3.5 py-2">
            <span className="shrink-0 text-dense font-medium tabular">{formatNumber(selected.length)} selected</span>
            {actions.canManage ? (
              <div className="flex min-w-0 flex-1 items-center justify-end gap-1 overflow-x-auto [scrollbar-width:none]">
                <Button size="xs" variant="outline" className="shrink-0" title="Acknowledge (a)" onClick={() => actions.bulk(selected, { action: 'acknowledge' })}>
                  <UserCheck data-icon="inline-start" />
                  Ack
                </Button>
                <Button size="xs" variant="outline" className="shrink-0" title="Resolve (r)" onClick={() => setResolving(selected)}>
                  <CircleCheck data-icon="inline-start" />
                  Resolve
                </Button>
                <SnoozeMenu
                  count={selected.length}
                  onSnooze={(choice) => snooze(selected, choice)}
                  trigger={
                    <Button size="xs" variant="outline" className="shrink-0" title="Snooze (s)">
                      <Moon data-icon="inline-start" />
                      Snooze
                      <ChevronDown data-icon="inline-end" />
                    </Button>
                  }
                />
                <AssignMenu
                  users={actions.users}
                  meId={me?.user.id}
                  currentId={null}
                  onAssign={(userId) => actions.bulk(selected, { action: 'assign', user_id: userId })}
                  trigger={
                    <Button size="xs" variant="outline" className="shrink-0">
                      <UserRound data-icon="inline-start" />
                      Assign
                      <ChevronDown data-icon="inline-end" />
                    </Button>
                  }
                />
              </div>
            ) : (
              <span className="min-w-0 flex-1 truncate text-micro text-muted-foreground">Triage needs the “Triage alerts” permission</span>
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
              <Skeleton key={index} className="h-14 rounded-lg" />
            ))}
          </div>
        ) : ordered.length === 0 ? (
          isDefaultView ? (
            <AllClear scopeName={scopeName} devices={fleet?.devices_total} />
          ) : (
            <div className="p-4">
              <EmptyState
                compact
                illustration="search"
                title="No alerts match"
                description={search.q ? `Nothing matches “${search.q}” with these filters.` : 'Try widening the filters.'}
                actions={
                  <Button size="sm" variant="outline" onClick={() => void navigate({ to: '/alerts', search: () => ({}), replace: true })}>
                    Clear filters
                  </Button>
                }
              />
            </div>
          )
        ) : (
          <AlertList
            groups={groups}
            ordered={ordered}
            currentId={search.alert}
            selectedIds={selectedIds}
            freshIds={fresh}
            meId={me?.user.id}
            catalog={catalog}
            onOpen={open}
            onToggle={(alert) => dispatch({ type: 'toggle', id: alert.id })}
            onRange={(alert) => dispatch({ type: 'range', id: alert.id, order: ordered.map((item) => item.id) })}
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
      <section aria-label="Alert detail" className={cn('min-h-0 min-w-0 flex-1 flex-col bg-surface-1/40', search.alert ? 'flex' : 'hidden lg:flex')}>
        {search.alert ? (
          <AlertDetailPane key={search.alert} alertId={search.alert} actions={actions} onBack={() => open(null)} onResolve={(alert) => setResolving([alert])} />
        ) : (
          <DetailPlaceholder counts={counts} />
        )}
      </section>

      {resolving && (
        <ResolveDialog
          open
          count={resolving.length}
          title={resolving[0]?.title}
          onOpenChange={(next) => !next && setResolving(null)}
          onConfirm={(note) => {
            if (resolving.length === 1) actions.act(resolving[0], { action: 'resolve' }, note || undefined)
            else actions.bulk(resolving, { action: 'resolve', note })
            dispatch({ type: 'clear' })
          }}
        />
      )}
      {snoozing && <SnoozePicker count={snoozing.length} onClose={() => setSnoozing(null)} onPick={(choice) => snooze(snoozing, choice)} />}
    </div>
  )
}
