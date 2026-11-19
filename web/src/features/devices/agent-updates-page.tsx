import { useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import {
  ArrowRight,
  CircleCheck,
  CircleExclamationPoint,
  CircleFadingArrowUp,
  Loader,
  Pause,
  Play,
  RefreshCw,
  Server,
  X,
  Zap,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Can } from '@/components/common/can'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { DataTable } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, Mono, RelativeTime } from '@/components/common/misc'
import { OsIcon } from '@/components/common/os-icon'
import { PageContainer, PageHeader, SectionTitle } from '@/components/common/page-header'
import { agentUpdatesApi } from '@/lib/api/endpoints'
import { errorMessage } from '@/lib/api/errors'
import { agentUpdatesQuery, keys, rolloutsQuery } from '@/lib/api/queries'
import { useStreamEvent } from '@/lib/api/stream'
import type { AgentRollout, AgentUpdateDevice, AgentUpdateState } from '@/lib/api/types'
import {
  UPDATE_STATE_BADGE,
  UPDATE_STATE_LABEL,
  canUpdateNow,
  compareAgentVersions,
  formatAgentVersion,
} from '@/lib/agent-version'
import { formatNumber } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useScope } from '@/lib/scope'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { AGENT_UPDATE_VIEWS, announceUpdate, type AgentUpdateView, type AgentUpdatesSearch } from './agent-updates'
import { DevicesContextPanel } from './devices-context'


const VIEW_LABEL: Record<AgentUpdateView, string> = {
  attention: 'Needs update',
  updating: 'In progress',
  failed: 'Failed',
  current: 'Up to date',
  all: 'All devices',
}

const VIEW_STATES: Record<AgentUpdateView, AgentUpdateState[] | null> = {
  attention: ['outdated', 'failed', 'queued', 'updating'],
  updating: ['queued', 'updating'],
  failed: ['failed'],
  current: ['current'],
  all: null,
}

function SummaryTile({ label, value, icon, tone }: { label: string; value: ReactNode; icon: ReactNode; tone?: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-card px-4 py-3 shadow-card">
      <span
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-muted-foreground ring-1 ring-border [&_svg]:size-4',
          tone,
        )}
      >
        {icon}
      </span>
      <div className="min-w-0">
        <div className="font-display tabular text-lg leading-tight font-semibold">{value}</div>
        <div className="truncate text-micro text-muted-foreground">{label}</div>
      </div>
    </div>
  )
}

export function UpdateStateBadge({ state, error }: { state: AgentUpdateState; error?: string | null }) {
  const badge = (
    <Badge variant={UPDATE_STATE_BADGE[state]} className="gap-1">
      {state === 'updating' && <Loader className="size-3 animate-spin" />}
      {UPDATE_STATE_LABEL[state]}
    </Badge>
  )
  if (!error) return badge
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex cursor-help" />}>{badge}</TooltipTrigger>
      <TooltipContent className="max-w-80">{error}</TooltipContent>
    </Tooltip>
  )
}

function rolloutLabel(rollout: AgentRollout) {
  if (rollout.kind === 'auto') return 'Automatic'
  const scope = rollout.scope
  if (scope?.type === 'devices') {
    const n = scope.ids?.length ?? 0
    return `${n} ${n === 1 ? 'device' : 'devices'}`
  }
  if (scope?.type === 'all') return 'All devices'
  return scope?.type === 'client' ? 'One client' : 'One site'
}

const ROLLOUT_BADGE: Record<AgentRollout['status'], 'live' | 'warning' | 'secondary' | 'outline'> = {
  active: 'live',
  paused: 'warning',
  completed: 'secondary',
  cancelled: 'outline',
}

function RolloutsCard({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient()
  const rollouts = useQuery(rolloutsQuery())
  const action = useMutation({
    mutationFn: ({ id, verb }: { id: string; verb: 'pause' | 'resume' | 'cancel' }) => agentUpdatesApi.rolloutAction(id, verb),
    onSuccess: (_, { verb }) => {
      toast.success(verb === 'pause' ? 'Rollout paused' : verb === 'resume' ? 'Rollout resumed' : 'Rollout cancelled')
      void queryClient.invalidateQueries({ queryKey: keys.agentUpdates })
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not change the rollout')),
  })
  const items = (rollouts.data?.items ?? []).slice(0, 8)
  return (
    <section className="grid gap-3">
      <SectionTitle description="Automatic rollouts are created by the server for each new release; “Update now” creates a manual one. Pausing stops new installs; cancelling an automatic rollout turns automatic updates off for that release.">
        Recent rollouts
      </SectionTitle>
      <div className="overflow-hidden rounded-xl bg-card shadow-card">
        {rollouts.error ? (
          <div className="p-4">
            <ErrorState error={rollouts.error} onRetry={() => void rollouts.refetch()} />
          </div>
        ) : items.length === 0 ? (
          <p className="px-4 py-5 text-dense text-muted-foreground">
            {rollouts.isLoading ? 'Loading…' : 'No rollouts yet. They appear when devices are updated.'}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((rollout) => {
              const done = rollout.counts.succeeded ?? 0
              const failed = rollout.counts.failed ?? 0
              const open = (rollout.counts.pending ?? 0) + (rollout.counts.sent ?? 0)
              const total = done + failed + open + (rollout.counts.skipped ?? 0)
              const live = rollout.status === 'active' || rollout.status === 'paused'
              return (
                <li key={rollout.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-dense font-medium">
                      {rolloutLabel(rollout)}
                      <ArrowRight className="size-3.5 text-subtle-foreground" />
                      <Mono className="text-[13px]">{formatAgentVersion(rollout.version)}</Mono>
                      <Badge variant={ROLLOUT_BADGE[rollout.status]} className="capitalize">
                        {rollout.status}
                      </Badge>
                    </div>
                    <div className="mt-0.5 text-micro text-muted-foreground">
                      {rollout.kind === 'auto' ? 'Started by the server' : `By ${rollout.created_by ?? 'a former user'}`} ·{' '}
                      <RelativeTime value={rollout.created_at} />
                    </div>
                  </div>
                  <div className="tabular flex shrink-0 items-center gap-3 text-micro text-muted-foreground">
                    <span>
                      <span className="font-medium text-success">{formatNumber(done)}</span> updated
                    </span>
                    {failed > 0 && (
                      <span>
                        <span className="font-medium text-critical">{formatNumber(failed)}</span> failed
                      </span>
                    )}
                    {open > 0 && (
                      <span>
                        <span className="font-medium text-info">{formatNumber(open)}</span> waiting
                      </span>
                    )}
                    <span className="text-subtle-foreground">of {formatNumber(total)}</span>
                  </div>
                  {canManage && live && (
                    <div className="flex shrink-0 gap-1">
                      {rollout.status === 'active' ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={action.isPending}
                          onClick={() => action.mutate({ id: rollout.id, verb: 'pause' })}
                        >
                          <Pause data-icon="inline-start" />
                          Pause
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={action.isPending}
                          onClick={() => action.mutate({ id: rollout.id, verb: 'resume' })}
                        >
                          <Play data-icon="inline-start" />
                          Resume
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={action.isPending}
                        onClick={() => action.mutate({ id: rollout.id, verb: 'cancel' })}
                      >
                        <X data-icon="inline-start" />
                        Cancel
                      </Button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}

export function AgentUpdatesPage({ search }: { search: AgentUpdatesSearch }) {
  useTitle('Agent updates')
  const me = useMe()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { clientId, siteId } = useScope()
  const canUpdate = hasPermission(me, PERMISSIONS.agentsUpdate)
  const filters = { client_id: clientId, site_id: siteId }
  const updates = useQuery({
    ...agentUpdatesQuery(filters),
    // Poll while updates are moving; live events refresh the rest.
    refetchInterval: (query) => {
      const summary = query.state.data?.summary
      return summary && summary.queued + summary.updating > 0 ? 10_000 : 60_000
    },
  })
  const refresh = () => void queryClient.invalidateQueries({ queryKey: keys.agentUpdates })
  useStreamEvent('agent_updates.changed', refresh)
  useStreamEvent('devices.changed', refresh)

  const view = search.show ?? 'attention'
  const setView = (next: AgentUpdateView) =>
    void navigate({ from: '/devices/updates', to: '/devices/updates', search: (prev) => ({ ...prev, show: next }), replace: true })

  const data = updates.data
  const items = useMemo(() => data?.items ?? [], [data])
  const visible = useMemo(() => {
    const states = VIEW_STATES[view]
    return states ? items.filter((item) => states.includes(item.state)) : items
  }, [items, view])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const selectable = visible.filter((item) => canUpdateNow(item.state))
  const chosen = selectable.filter((item) => selected.has(item.id))
  const allSelected = selectable.length > 0 && chosen.length === selectable.length
  const outdated = items.filter((item) => item.state === 'outdated' || item.state === 'failed').length
  const [confirmAll, setConfirmAll] = useState(false)

  const update = useMutation({
    mutationFn: (body: { device_ids?: string[]; all_outdated?: boolean }) =>
      agentUpdatesApi.update({ ...body, client_id: body.all_outdated ? clientId : undefined, site_id: body.all_outdated ? siteId : undefined }),
    onSuccess: (result, body) => {
      announceUpdate(result, body.device_ids?.length ?? outdated)
      setSelected(new Set())
      setConfirmAll(false)
      refresh()
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not start the update')),
  })

  const columns = useMemo<ColumnDef<AgentUpdateDevice>[]>(() => {
    const list: ColumnDef<AgentUpdateDevice>[] = []
    if (canUpdate) {
      list.push({
        id: 'select',
        enableSorting: false,
        size: 40,
        meta: { className: 'w-10 pr-0', headerClassName: 'w-10 pr-0' },
        header: () => (
          <Checkbox
            aria-label={allSelected ? 'Clear selection' : 'Select every device that can be updated'}
            checked={allSelected}
            indeterminate={!allSelected && chosen.length > 0}
            disabled={selectable.length === 0}
            onCheckedChange={() => setSelected(allSelected ? new Set() : new Set(selectable.map((item) => item.id)))}
          />
        ),
        cell: ({ row }) => (
          <span className="flex" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
            <Checkbox
              aria-label={`Select ${row.original.display_name ?? row.original.hostname}`}
              checked={selected.has(row.original.id)}
              disabled={!canUpdateNow(row.original.state)}
              onCheckedChange={() =>
                setSelected((prev) => {
                  const next = new Set(prev)
                  if (next.has(row.original.id)) next.delete(row.original.id)
                  else next.add(row.original.id)
                  return next
                })
              }
            />
          </span>
        ),
      })
    }
    list.push(
      {
        id: 'device',
        header: 'Device',
        accessorFn: (item) => item.display_name ?? item.hostname,
        cell: ({ row }) => {
          const item = row.original
          return (
            <div className="flex min-w-0 items-center gap-2.5">
              <span
                className={cn('size-2 shrink-0 rounded-full', item.online ? 'bg-live' : 'bg-surface-4 ring-1 ring-border-strong')}
                aria-label={item.online ? 'Online' : 'Offline'}
              />
              <OsIcon family={item.os_family} />
              <div className="min-w-0">
                <Link
                  to="/devices/$deviceId"
                  params={{ deviceId: item.id }}
                  className="block truncate font-medium hover:underline"
                  onClick={(event) => event.stopPropagation()}
                >
                  {item.display_name ?? item.hostname}
                </Link>
                <div className="truncate text-micro text-subtle-foreground">
                  {item.client_name} · {item.site_name}
                </div>
              </div>
            </div>
          )
        },
      },
      {
        id: 'version',
        header: 'Agent',
        accessorFn: (item) => item.agent_version,
        sortingFn: (a, b) => compareAgentVersions(a.original.agent_version, b.original.agent_version),
        cell: ({ row }) => {
          const item = row.original
          const behind = item.state !== 'current' && item.state !== 'unsupported' && item.latest_version
          return (
            <div className="min-w-0 text-[13px]">
              <Mono className={cn('block truncate', behind && 'text-warning')}>{formatAgentVersion(item.agent_version)}</Mono>
              {behind && (
                <div className="flex min-w-0 items-center gap-1 text-micro text-subtle-foreground">
                  <ArrowRight className="size-3 shrink-0" />
                  <span className="truncate font-mono">{formatAgentVersion(item.latest_version)}</span>
                </div>
              )}
            </div>
          )
        },
      },
      {
        id: 'state',
        header: 'Status',
        accessorFn: (item) => UPDATE_STATE_LABEL[item.state],
        cell: ({ row }) => (
          <div className="flex flex-col items-start gap-0.5">
            <UpdateStateBadge state={row.original.state} error={row.original.last_error} />
            {row.original.attempt_at && row.original.state !== 'current' && (
              <span className="text-micro text-subtle-foreground">
                {row.original.attempt_kind === 'auto' ? 'Automatic' : 'Manual'} · <RelativeTime value={row.original.attempt_at} />
              </span>
            )}
          </div>
        ),
      },
      {
        id: 'auto',
        header: 'Automatic updates',
        accessorFn: (item) => (item.auto_update ? 1 : 0),
        cell: ({ row }) => (
          <div className="text-[13px]">
            <span className={row.original.auto_update ? 'text-foreground' : 'text-muted-foreground'}>
              {row.original.auto_update ? 'On' : 'Off'}
            </span>
            <div className="truncate text-micro text-subtle-foreground">{row.original.auto_update_policy ?? 'Default'}</div>
          </div>
        ),
      },
      {
        id: 'seen',
        header: 'Last seen',
        accessorFn: (item) => item.last_seen_at ?? '',
        cell: ({ row }) =>
          row.original.online ? (
            <span className="text-[13px] text-live">Connected</span>
          ) : (
            <RelativeTime value={row.original.last_seen_at} className="text-[13px]" />
          ),
      },
    )
    if (canUpdate) {
      list.push({
        id: 'actions',
        enableSorting: false,
        header: () => <span className="sr-only">Actions</span>,
        meta: { className: 'text-right', headerClassName: 'text-right' },
        cell: ({ row }) =>
          canUpdateNow(row.original.state) ? (
            <Button
              size="sm"
              variant="outline"
              disabled={update.isPending}
              onClick={(event) => {
                event.stopPropagation()
                update.mutate({ device_ids: [row.original.id] })
              }}
            >
              <CircleFadingArrowUp data-icon="inline-start" />
              Update now
            </Button>
          ) : null,
      })
    }
    return list
  }, [allSelected, canUpdate, chosen.length, selectable, selected, update])

  const summary = data?.summary
  const latest = data?.latest

  return (
    <div className="flex h-full">
      <DevicesContextPanel />
      <div className="min-w-0 flex-1 overflow-y-auto">
        <PageContainer className="grid gap-5 [&>*]:min-w-0">
          <PageHeader
            icon={<CircleFadingArrowUp />}
            title="Agent updates"
            description="Keep device agents on the same build as the server. Each server image you rebuild and redeploy publishes a new agent release; devices update automatically where policy allows, or when you choose “Update now”."
            actions={
              <Can permission={PERMISSIONS.agentsUpdate}>
                <Button disabled={!latest || outdated === 0 || update.isPending} onClick={() => setConfirmAll(true)}>
                  <Zap data-icon="inline-start" />
                  Update all outdated
                  {outdated > 0 && <span className="tabular opacity-80">({formatNumber(outdated)})</span>}
                </Button>
              </Can>
            }
          />

          {updates.error ? (
            <ErrorState error={updates.error} onRetry={() => void updates.refetch()} />
          ) : (
            <>
              <div className="flex flex-col gap-3 rounded-xl bg-card p-4 shadow-card sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
                    <Server className="size-4.5" />
                  </span>
                  <div className="min-w-0">
                    <div className="text-micro text-muted-foreground">Latest agent release</div>
                    <div className="truncate font-display text-lg font-semibold">
                      {latest ? formatAgentVersion(latest.version) : updates.isLoading ? '…' : 'None imported yet'}
                    </div>
                    <div className="text-micro text-subtle-foreground">
                      {latest ? (
                        <>
                          Imported <RelativeTime value={latest.imported_at} /> · builds for {latest.platforms.join(', ') || 'no platform'}
                        </>
                      ) : (
                        'Rebuild and redeploy the server image; the bundled agents are imported when it starts.'
                      )}
                    </div>
                  </div>
                </div>
                <div className="shrink-0 text-micro text-muted-foreground sm:text-right">
                  Server build
                  <div className="font-mono text-[13px] text-foreground">{data ? formatAgentVersion(data.server_version) : '…'}</div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <SummaryTile
                  label="Up to date"
                  value={summary ? formatNumber(summary.current) : '—'}
                  icon={<CircleCheck />}
                  tone="text-success bg-success/10 ring-success/20"
                />
                <SummaryTile
                  label="Need an update"
                  value={summary ? formatNumber(summary.outdated + summary.failed) : '—'}
                  icon={<CircleFadingArrowUp />}
                  tone={summary && summary.outdated + summary.failed > 0 ? 'text-warning bg-warning/10 ring-warning/25' : undefined}
                />
                <SummaryTile
                  label="Updating now"
                  value={summary ? formatNumber(summary.queued + summary.updating) : '—'}
                  icon={<RefreshCw />}
                  tone={summary && summary.queued + summary.updating > 0 ? 'text-info bg-info/10 ring-info/25' : undefined}
                />
                <SummaryTile
                  label="Automatic updates on"
                  value={summary ? `${formatNumber(summary.auto_update)} / ${formatNumber(summary.total)}` : '—'}
                  icon={<Zap />}
                />
              </div>

              {summary && summary.failed > 0 && (
                <div className="flex items-start gap-2.5 rounded-xl bg-critical/8 px-4 py-3 text-dense ring-1 ring-critical/20">
                  <CircleExclamationPoint className="mt-0.5 size-4 shrink-0 text-critical" />
                  <div>
                    {formatNumber(summary.failed)} {summary.failed === 1 ? 'device' : 'devices'} could not update. The agent rolls back by
                    itself when a new build does not reconnect within 3 minutes; hover the status for the reason, then try “Update now”
                    again.
                  </div>
                </div>
              )}

              <div className="grid gap-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                  <Tabs value={view} onValueChange={(value) => setView(value as AgentUpdateView)}>
                    <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0">
                      <TabsList variant="line" className="-mb-px h-10 w-max gap-5">
                        {AGENT_UPDATE_VIEWS.map((key) => {
                          const states = VIEW_STATES[key]
                          const count = states ? items.filter((item) => states.includes(item.state)).length : items.length
                          return (
                            <TabsTrigger key={key} value={key} className="flex-none px-0">
                              {VIEW_LABEL[key]} <span className="tabular text-micro text-subtle-foreground">{formatNumber(count)}</span>
                            </TabsTrigger>
                          )
                        })}
                      </TabsList>
                    </div>
                  </Tabs>
                  {canUpdate && chosen.length > 0 && (
                    <div className="flex items-center gap-2">
                      <span className="text-micro text-muted-foreground">{formatNumber(chosen.length)} selected</span>
                      <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                        Clear
                      </Button>
                      <Button size="sm" disabled={update.isPending} onClick={() => update.mutate({ device_ids: chosen.map((item) => item.id) })}>
                        {update.isPending ? <Spinner data-icon="inline-start" /> : <CircleFadingArrowUp data-icon="inline-start" />}
                        Update selected
                      </Button>
                    </div>
                  )}
                </div>
                <DataTable
                  data={visible}
                  columns={columns}
                  getRowId={(item) => item.id}
                  loading={updates.isLoading}
                  onRowClick={(item) => void navigate({ to: '/devices/$deviceId', params: { deviceId: item.id } })}
                  rowClassName={(item) => selected.has(item.id) && 'bg-primary/5'}
                  initialSorting={[{ id: 'version', desc: false }]}
                  empty={
                    <EmptyState
                      compact
                      illustration="devices"
                      title={view === 'attention' ? 'Every agent is up to date' : `No devices in “${VIEW_LABEL[view]}”`}
                      description={
                        latest
                          ? `Devices in scope run ${formatAgentVersion(latest.version)} or have nothing to install.`
                          : 'No agent release has been imported yet.'
                      }
                    />
                  }
                />
              </div>

              <RolloutsCard canManage={hasPermission(me, PERMISSIONS.agentsUpdate)} />

              <section className="rounded-xl bg-card p-4 text-dense text-muted-foreground shadow-card">
                <div className="mb-1.5 font-medium text-foreground">How updates reach devices</div>
                <ol className="grid list-decimal gap-1 pl-5">
                  <li>
                    Pull the new code on the server host and run <Mono>docker compose up -d --build</Mono>. The image stamps the agents with
                    the build time, so each rebuild is a newer release.
                  </li>
                  <li>When the server starts it imports and signs the bundled agents; the old release files are pruned after three builds.</li>
                  <li>
                    Devices with <span className="text-foreground">Automatic agent updates</span> on (the default; set it per client, site
                    or group under Automation → Policies → Agent) update within a few minutes, 25 at a time.
                  </li>
                  <li>Use “Update now” for any device, including those with automatic updates off. Offline devices update when they reconnect.</li>
                </ol>
              </section>
            </>
          )}
        </PageContainer>
      </div>

      <ConfirmDialog
        open={confirmAll}
        onOpenChange={setConfirmAll}
        title={`Update ${formatNumber(outdated)} ${outdated === 1 ? 'agent' : 'agents'} now?`}
        description={`Every outdated device in this view installs ${formatAgentVersion(latest?.version)} now, whatever its automatic-update policy says. Each agent restarts briefly and rolls back by itself if the new build does not come back.`}
        confirmLabel="Update all"
        destructive={false}
        pending={update.isPending}
        onConfirm={() => update.mutate({ all_outdated: true })}
      />
    </div>
  )
}
