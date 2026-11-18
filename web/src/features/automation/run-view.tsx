import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { CircleStop, RotateCcw, RotateCw } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { DataTable } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, RelativeTime } from '@/components/common/misc'
import { OsIcon } from '@/components/common/os-icon'
import { jobsApi } from '@/lib/api/endpoints'
import { jobRunQuery, keys } from '@/lib/api/queries'
import type { JobResult, JobResultStatus } from '@/lib/api/types'
import {
  RESULT_ORDER,
  RESULT_STATUS,
  TRIGGER_LABEL,
  completedCount,
  formatDurationMs,
  otherCount,
  progressPct,
} from '@/lib/automation/labels'
import { formatClock, formatDateTime, formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useNow } from '@/features/devices/remote-hooks'
import { SearchField } from '@/features/devices/remote-ui'
import { ResultStatusBadge, ResultStatusDot, SegmentedProgress } from './automation-ui'

type Filter = 'all' | 'failed' | 'running' | 'succeeded' | 'waiting' | 'skipped'

const FILTER_MATCH: Record<Filter, (status: JobResultStatus) => boolean> = {
  all: () => true,
  failed: (status) => status === 'failed' || status === 'timed_out',
  running: (status) => status === 'running' || status === 'pending',
  succeeded: (status) => status === 'succeeded',
  waiting: (status) => status === 'waiting_offline',
  skipped: (status) => status === 'skipped' || status === 'cancelled',
}

const FILTER_LABEL: Record<Filter, string> = {
  all: 'All',
  failed: 'Failed',
  running: 'In progress',
  succeeded: 'Succeeded',
  waiting: 'Waiting',
  skipped: 'Skipped',
}

function Stat({
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
      <span className={cn('font-display tabular text-xl leading-none font-semibold tracking-tight', tone)}>
        {formatNumber(value)}
      </span>
    </button>
  )
}

export function RunView({
  runId,
  canRun,
  onOpenResult,
  onRunCreated,
}: {
  runId: string
  canRun: boolean
  onOpenResult: (deviceId: string) => void
  onRunCreated?: (runId: string) => void
}) {
  const queryClient = useQueryClient()
  const { data, isLoading, error, refetch } = useQuery(jobRunQuery(runId))
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const live = data?.run.status === 'running'
  const now = useNow(1000, live)

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: keys.jobRun(runId) })
    void queryClient.invalidateQueries({ queryKey: keys.jobs })
  }

  const rerun = useMutation({
    mutationFn: (only: 'failed' | 'all') => jobsApi.rerun(runId, only),
    onSuccess: (detail, only) => {
      refresh()
      queryClient.setQueryData(keys.jobRun(detail.run.id), detail)
      onRunCreated?.(detail.run.id)
      toast.success(
        only === 'failed'
          ? `Re-running ${detail.run.total} failed ${detail.run.total === 1 ? 'device' : 'devices'}`
          : `Re-running on ${detail.run.total} devices`,
      )
    },
  })

  const cancel = useMutation({
    mutationFn: () => jobsApi.cancelRun(runId),
    onSuccess: (detail) => {
      queryClient.setQueryData(keys.jobRun(runId), detail)
      refresh()
      toast.success('Run cancelled — scripts already running will finish')
    },
  })

  const results = useMemo(() => data?.results ?? [], [data])
  const counts = useMemo(() => {
    const out: Record<Filter, number> = {
      all: results.length,
      failed: 0,
      running: 0,
      succeeded: 0,
      waiting: 0,
      skipped: 0,
    }
    for (const result of results) {
      for (const key of ['failed', 'running', 'succeeded', 'waiting', 'skipped'] as Filter[])
        if (FILTER_MATCH[key](result.status)) out[key] += 1
    }
    return out
  }, [results])
  const needle = query.trim().toLowerCase()
  const visible = useMemo(
    () =>
      results
        .filter((result) => FILTER_MATCH[filter](result.status))
        .filter(
          (result) =>
            !needle ||
            `${result.hostname} ${result.client_name} ${result.stdout_preview} ${result.error ?? ''}`
              .toLowerCase()
              .includes(needle),
        ),
    [results, filter, needle],
  )

  const columns = useMemo<ColumnDef<JobResult>[]>(
    () => [
      {
        id: 'device',
        accessorFn: (result) => result.hostname.toLowerCase(),
        header: 'Device',
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-2.5">
            <ResultStatusDot status={row.original.status} />
            <OsIcon family={row.original.os_family} />
            <div className="min-w-0 leading-tight">
              <div className="max-w-48 truncate font-medium">{row.original.hostname}</div>
              <div className="max-w-48 truncate text-[10.5px] text-subtle-foreground">{row.original.client_name}</div>
            </div>
          </div>
        ),
      },
      {
        id: 'status',
        accessorFn: (result) => RESULT_ORDER.indexOf(result.status),
        header: 'Status',
        cell: ({ row }) => <ResultStatusBadge status={row.original.status} />,
      },
      {
        id: 'exit',
        accessorFn: (result) => result.exit_code ?? -999,
        header: 'Exit',
        meta: { align: 'right' },
        cell: ({ row }) =>
          row.original.exit_code === null ? (
            <span className="text-subtle-foreground">—</span>
          ) : (
            <span
              className={cn(
                'tabular font-mono text-[12px]',
                row.original.exit_code === 0 ? 'text-muted-foreground' : 'font-semibold text-critical',
              )}
            >
              {row.original.exit_code}
            </span>
          ),
      },
      {
        id: 'duration',
        accessorFn: (result) => result.duration_ms ?? -1,
        header: 'Duration',
        meta: { align: 'right' },
        cell: ({ row }) => (
          <span className="tabular text-muted-foreground">{formatDurationMs(row.original.duration_ms)}</span>
        ),
      },
      {
        id: 'started',
        accessorFn: (result) => result.started_at ?? '',
        header: 'Started',
        cell: ({ row }) =>
          row.original.started_at ? (
            <RelativeTime value={row.original.started_at} className="text-muted-foreground" />
          ) : (
            <span className="text-subtle-foreground">—</span>
          ),
      },
      {
        id: 'output',
        accessorFn: (result) => result.error ?? result.stdout_preview,
        header: 'Output',
        enableSorting: false,
        cell: ({ row }) => {
          const text = row.original.error ?? row.original.stdout_preview.split('\n').find((line) => line.trim()) ?? ''
          return (
            <span
              className={cn(
                'block max-w-[28rem] truncate font-mono text-[11.5px]',
                row.original.error ? 'text-critical/90' : 'text-muted-foreground',
              )}
              title={text}
            >
              {text || (RESULT_STATUS[row.original.status].done ? '' : '…')}
            </span>
          )
        },
      },
    ],
    [],
  )

  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />
  if (isLoading || !data) {
    return (
      <div className="grid grid-cols-1 gap-3">
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    )
  }

  const { run } = data
  const elapsed =
    ((run.finished_at ? new Date(run.finished_at).getTime() : now) - new Date(run.started_at).getTime()) / 1000
  const failedCount = run.failed

  return (
    <div className="grid min-w-0 grid-cols-1 gap-3">
      <div className="grid grid-cols-1 gap-4 rounded-xl bg-card p-4 shadow-card">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex min-w-0 items-center gap-2">
            {live ? (
              <Badge variant="live">
                <span className="inline-flex size-1.5 animate-pulse-ring rounded-full bg-live" />
                Live
              </Badge>
            ) : (
              <Badge variant={run.status === 'cancelled' ? 'secondary' : failedCount ? 'warning' : 'success'}>
                {run.status === 'cancelled' ? 'Cancelled' : 'Completed'}
              </Badge>
            )}
            <span className="text-dense font-medium">Run started {formatDateTime(run.started_at)}</span>
            <Badge variant="outline">{TRIGGER_LABEL[run.trigger]}</Badge>
          </div>
          <span className="tabular text-micro text-muted-foreground">
            {live ? `Elapsed ${formatClock(elapsed)}` : `Took ${formatClock(elapsed)}`}
          </span>
          {canRun && (
            <div className="ml-auto flex flex-wrap gap-1.5">
              {live && (
                <Button size="sm" variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
                  {cancel.isPending ? <Spinner data-icon="inline-start" /> : <CircleStop data-icon="inline-start" />}
                  Cancel run
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={rerun.isPending || failedCount === 0}
                onClick={() => rerun.mutate('failed')}
              >
                <RotateCcw data-icon="inline-start" />
                Re-run failed{failedCount ? ` (${failedCount})` : ''}
              </Button>
              <Button size="sm" variant="outline" disabled={rerun.isPending} onClick={() => rerun.mutate('all')}>
                <RotateCw data-icon="inline-start" />
                Re-run all
              </Button>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-dense text-muted-foreground">
              <span className="tabular font-semibold text-foreground">{formatNumber(completedCount(run))}</span> of{' '}
              {formatNumber(run.total)} devices finished
            </span>
            <span className="font-display tabular text-lg font-semibold">{progressPct(run)}%</span>
          </div>
          <SegmentedProgress counts={run} height="h-2.5" />
        </div>

        <div className="-mx-1 grid grid-cols-3 gap-1 sm:grid-cols-6">
          <Stat
            label="Succeeded"
            value={run.succeeded}
            tone="text-success"
            active={filter === 'succeeded'}
            onClick={() => setFilter(filter === 'succeeded' ? 'all' : 'succeeded')}
          />
          <Stat
            label="Failed"
            value={run.failed}
            tone={run.failed ? 'text-critical' : undefined}
            active={filter === 'failed'}
            onClick={() => setFilter(filter === 'failed' ? 'all' : 'failed')}
          />
          <Stat
            label="Running"
            value={run.running}
            tone={run.running ? 'text-live' : undefined}
            active={filter === 'running'}
            onClick={() => setFilter(filter === 'running' ? 'all' : 'running')}
          />
          <Stat
            label="Queued"
            value={run.pending}
            active={false}
            onClick={() => setFilter(filter === 'running' ? 'all' : 'running')}
          />
          <Stat
            label="Waiting"
            value={run.waiting_offline}
            tone={run.waiting_offline ? 'text-warning' : undefined}
            active={filter === 'waiting'}
            onClick={() => setFilter(filter === 'waiting' ? 'all' : 'waiting')}
          />
          <Stat
            label="Skipped"
            value={otherCount(run)}
            active={filter === 'skipped'}
            onClick={() => setFilter(filter === 'skipped' ? 'all' : 'skipped')}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {(Object.keys(FILTER_LABEL) as Filter[]).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
              disabled={key !== 'all' && counts[key] === 0}
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-dense text-muted-foreground ring-1 ring-border transition-colors outline-none hover:bg-surface-3 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40',
                filter === key && 'bg-primary/10 font-medium text-foreground ring-primary/30',
              )}
            >
              {FILTER_LABEL[key]}
              <span className="tabular text-micro text-subtle-foreground">{formatNumber(counts[key])}</span>
            </button>
          ))}
        </div>
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Search devices or output…"
          label="Search results"
          className="sm:ml-auto sm:w-64"
        />
      </div>

      <DataTable
        data={visible}
        columns={columns}
        getRowId={(result) => result.device_id}
        onRowClick={(result) => onOpenResult(result.device_id)}
        virtualHeight={visible.length > 12 ? '520px' : undefined}
        initialSorting={[{ id: 'status', desc: false }]}
        caption="Results by device"
        empty={
          <div className="p-6">
            <EmptyState
              compact
              illustration="search"
              title={results.length ? 'No results match' : 'No devices in this run'}
              description={
                results.length ? 'Try another filter.' : 'The target resolved to no devices when the run started.'
              }
            />
          </div>
        }
      />
    </div>
  )
}
