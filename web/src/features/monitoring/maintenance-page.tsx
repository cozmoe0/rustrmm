/* Maintenance windows: live status, upcoming starts and the editor (search `edit` = id or `new`). */
import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { BellOff, CalendarCheck, CalendarClock, CirclePause, Plus, Repeat, ShieldOff, Wrench } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { maintenanceApi } from '@/lib/api/endpoints'
import { keys, maintenanceWindowsQuery } from '@/lib/api/queries'
import type { MaintenanceWindow } from '@/lib/api/types'
import { formatDateTime } from '@/lib/format'
import { currentOccurrence, describeSchedule, endsIn, startsIn, type WindowPhase } from '@/lib/monitoring/maintenance'
import { phaseCounts, phaseOf, sortWindows, targetKey, windowToInput } from '@/lib/monitoring/maintenance-editor'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { SearchField } from '@/features/devices/remote-ui'
import { TARGET_ICON } from '@/features/automation/target-icons'
import { MaintenanceEditor } from './maintenance-editor'

type Filter = 'all' | WindowPhase

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active now' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'disabled', label: 'Disabled' },
  { value: 'ended', label: 'Ended' },
]

/** The current time, refreshed every `interval` ms so countdowns stay live. */
function useNow(interval = 30_000) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), interval)
    return () => window.clearInterval(timer)
  }, [interval])
  return now
}

function PhaseTile({ phase }: { phase: WindowPhase }) {
  const style = {
    active: 'bg-live/12 text-live ring-live/25',
    scheduled: 'bg-surface-3 text-muted-foreground ring-border',
    disabled: 'bg-surface-3 text-subtle-foreground ring-border',
    ended: 'bg-surface-3 text-subtle-foreground ring-border',
  }[phase]
  const Icon = { active: Wrench, scheduled: CalendarClock, disabled: CirclePause, ended: CalendarCheck }[phase]
  return (
    <span className={cn('relative flex size-10 shrink-0 items-center justify-center rounded-xl ring-1 [&_svg]:size-[18px]', style)}>
      <Icon aria-hidden="true" />
      {phase === 'active' && (
        <span className="absolute -top-0.5 -right-0.5 size-2.5 animate-pulse-ring rounded-full bg-live text-live ring-2 ring-card" />
      )}
    </span>
  )
}

function WindowRow({
  item,
  now,
  canManage,
  onOpen,
}: {
  item: MaintenanceWindow
  now: Date
  canManage: boolean
  onOpen: () => void
}) {
  const queryClient = useQueryClient()
  const phase = phaseOf(item, now)
  const current = phase === 'active' ? currentOccurrence(item.schedule, now) : null
  const progress = current
    ? Math.min(100, Math.max(0, ((now.getTime() - current.start.getTime()) / (current.end.getTime() - current.start.getTime())) * 100))
    : 0
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => maintenanceApi.update(item.id, { ...windowToInput(item), enabled }),
    meta: { successMessage: item.enabled ? `Disabled “${item.name}”` : `Enabled “${item.name}”` },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.maintenance }),
  })
  const global = item.targets.some((target) => target.type === 'global')
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onOpen()
          }
        }}
        className={cn(
          'grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] gap-x-3.5 gap-y-3 rounded-xl bg-card p-4 shadow-card outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring md:grid-cols-[auto_minmax(0,1fr)_auto] md:items-center',
          phase === 'active' && 'ring-1 ring-live/25',
          (phase === 'disabled' || phase === 'ended') && 'opacity-80',
        )}
      >
        <PhaseTile phase={phase} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate font-medium">{item.name}</span>
            {phase === 'active' && (
              <Badge variant="live">
                <span className="size-1.5 animate-pulse-ring rounded-full bg-live text-live" />
                Active now
              </Badge>
            )}
            {phase === 'disabled' && <Badge variant="outline">Disabled</Badge>}
            {phase === 'ended' && <Badge variant="outline">Ended</Badge>}
            {item.suppress === 'alerts' ? (
              <Badge variant="secondary">
                <ShieldOff />
                No alerts
              </Badge>
            ) : (
              <Badge variant="secondary">
                <BellOff />
                Notifications held
              </Badge>
            )}
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-1.5 text-micro text-muted-foreground">
            {item.schedule.type === 'recurring' ? (
              <Repeat className="size-3 shrink-0 text-subtle-foreground" />
            ) : (
              <CalendarClock className="size-3 shrink-0 text-subtle-foreground" />
            )}
            <span className="truncate">{describeSchedule(item.schedule)}</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {global ? (
              <span className="inline-flex h-6 items-center gap-1.5 rounded-md bg-surface-2 px-2 text-micro ring-1 ring-border">
                <TARGET_ICON.global className="size-3 text-subtle-foreground" />
                Every managed device
              </span>
            ) : (
              item.targets.map((target) => {
                const Icon = TARGET_ICON[target.type]
                return (
                  <span
                    key={targetKey(target)}
                    className="inline-flex h-6 max-w-56 items-center gap-1.5 rounded-md bg-surface-2 px-2 text-micro ring-1 ring-border"
                  >
                    <Icon className="size-3 shrink-0 text-subtle-foreground" />
                    <span className="truncate">{target.name ?? target.type}</span>
                  </span>
                )
              })
            )}
            <span className="text-micro text-subtle-foreground">· by {item.created_by_name}</span>
          </div>
        </div>
        <div className="col-span-2 flex items-center justify-between gap-4 border-t border-border pt-3 md:col-span-1 md:justify-end md:border-0 md:pt-0">
          <div className="min-w-0 md:w-48 md:text-right">
            {current ? (
              <>
                <div className="tabular text-dense font-medium text-live">{endsIn(current.end, now.getTime())}</div>
                <div
                  className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-surface-4"
                  role="progressbar"
                  aria-label="Window elapsed"
                  aria-valuenow={Math.round(progress)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <span className="block h-full rounded-full bg-live transition-[width] duration-700" style={{ width: `${progress}%` }} />
                </div>
              </>
            ) : item.next_start && item.enabled ? (
              <Tooltip>
                <TooltipTrigger render={<div className="cursor-default" />}>
                  <div className="tabular text-dense font-medium">Starts {startsIn(item.next_start, now.getTime())}</div>
                  <div className="tabular truncate text-micro text-muted-foreground">
                    {new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(item.next_start))}
                  </div>
                </TooltipTrigger>
                <TooltipContent>{formatDateTime(item.next_start)}</TooltipContent>
              </Tooltip>
            ) : (
              <div className="text-dense text-subtle-foreground">{item.enabled ? 'No upcoming occurrence' : 'Paused'}</div>
            )}
          </div>
          <span onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} className="flex">
            <Switch
              checked={item.enabled}
              disabled={!canManage || toggle.isPending}
              aria-label={item.enabled ? `Disable ${item.name}` : `Enable ${item.name}`}
              onCheckedChange={(enabled) => toggle.mutate(enabled)}
            />
          </span>
        </div>
      </div>
    </li>
  )
}

export function MaintenancePage({ edit }: { edit?: string }) {
  useTitle('Maintenance windows')
  const navigate = useNavigate()
  const me = useMe()
  const canView = hasPermission(me, PERMISSIONS.alertsView)
  const canManage = hasPermission(me, PERMISSIONS.monitorsManage)
  const { data, isLoading, error, refetch } = useQuery({ ...maintenanceWindowsQuery, enabled: canView })
  const now = useNow()
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const all = useMemo(() => sortWindows(data ?? [], now), [data, now])
  const counts = phaseCounts(all, now)
  const needle = query.trim().toLowerCase()
  const visible = all.filter(
    (item) =>
      (filter === 'all' || phaseOf(item, now) === filter) &&
      (!needle || `${item.name} ${item.targets.map((target) => target.name ?? '').join(' ')}`.toLowerCase().includes(needle)),
  )
  const editing = edit && edit !== 'new' ? (data?.find((item) => item.id === edit) ?? null) : null
  const editorOpen = edit === 'new' ? canManage : Boolean(editing)
  const setEdit = (next: string | undefined) =>
    void navigate({ to: '/alerts/maintenance', search: (prev) => ({ ...prev, edit: next }), replace: true })

  return (
    <div className="h-full overflow-y-auto">
      <PageContainer className="grid grid-cols-1 gap-4">
        <PageHeader
          icon={<Wrench />}
          title="Maintenance windows"
          description="Hold notifications or suppress new alerts while you patch, upgrade or move devices. Remediation never runs during a window."
          actions={
            canManage && (
              <Button onClick={() => setEdit('new')}>
                <Plus data-icon="inline-start" />
                New window
              </Button>
            )
          }
        />
        {!canView ? (
          <ErrorState error={new Error('You need the “View alerts” permission.')} title="No access" />
        ) : error ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Tabs value={filter} onValueChange={(value) => setFilter(value as Filter)} className="max-w-full min-w-0 gap-0">
                <div className="[scrollbar-width:none] overflow-x-auto">
                  <TabsList className="w-max">
                    {FILTERS.map((item) => (
                      <TabsTrigger key={item.value} value={item.value} className="px-2.5">
                        {item.label}
                        {counts[item.value] > 0 && (
                          <span
                            className={cn(
                              'tabular rounded-full px-1.5 text-[10px]',
                              item.value === 'active' ? 'bg-live/15 text-live' : 'bg-surface-4 text-muted-foreground',
                            )}
                          >
                            {counts[item.value]}
                          </span>
                        )}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </div>
              </Tabs>
              <SearchField
                value={query}
                onChange={setQuery}
                placeholder="Filter windows…"
                label="Filter maintenance windows"
                className="sm:ml-auto sm:w-64"
              />
            </div>
            {isLoading ? (
              <div className="grid grid-cols-1 gap-2">
                {Array.from({ length: 4 }, (_, index) => (
                  <Skeleton key={index} className="h-[104px] rounded-xl" />
                ))}
              </div>
            ) : all.length === 0 ? (
              <EmptyState
                illustration="alerts"
                title="No maintenance windows yet"
                description="Plan patch nights and upgrades so the on-call team isn’t paged for work you expect. Windows can repeat on a schedule."
                actions={
                  canManage && (
                    <Button onClick={() => setEdit('new')}>
                      <Plus data-icon="inline-start" />
                      New window
                    </Button>
                  )
                }
              />
            ) : visible.length === 0 ? (
              <EmptyState compact illustration="search" title="No windows match" description="Try another filter or search." />
            ) : (
              <ul className="grid grid-cols-1 gap-2">
                {visible.map((item) => (
                  <WindowRow key={item.id} item={item} now={now} canManage={canManage} onOpen={() => setEdit(item.id)} />
                ))}
              </ul>
            )}
          </>
        )}
      </PageContainer>
      {editorOpen && (
        <MaintenanceEditor
          key={edit}
          existing={editing}
          creating={edit === 'new'}
          open
          canManage={canManage}
          onClose={() => setEdit(undefined)}
        />
      )}
    </div>
  )
}
