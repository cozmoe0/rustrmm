import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { ArrowLeft, History, RotateCw } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { DataTable } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/misc'
import { PageContainer } from '@/components/common/page-header'
import { isApiError } from '@/lib/api/errors'
import { patchRunQuery } from '@/lib/api/queries'
import type { PatchRunResult, PatchRunResultStatus } from '@/lib/api/types'
import { RUN_RESULT_ORDER } from '@/lib/patching/labels'
import { formatClock, formatDateTime, formatNumber } from '@/lib/format'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { useNow } from '@/features/devices/remote-hooks'
import { SearchField } from '@/features/devices/remote-ui'
import { MetaItem } from '@/features/automation/automation-ui'
import { FilterPill, RunProgressBar, RunResultBadge, RunStatusBadge, StatButton } from './patching-ui'
import { TriggerBadge } from './runs-page'

type Filter = 'all' | 'succeeded' | 'restart' | 'failed' | 'active' | 'skipped'

const MATCH: Record<Filter, (status: PatchRunResultStatus) => boolean> = {
  all: () => true,
  succeeded: (status) => status === 'succeeded',
  restart: (status) => status === 'pending_reboot',
  failed: (status) => status === 'failed',
  active: (status) => status === 'pending' || status === 'running',
  skipped: (status) => status === 'skipped' || status === 'cancelled',
}

const LABEL: Record<Filter, string> = {
  all: 'All',
  succeeded: 'Succeeded',
  restart: 'Restart pending',
  failed: 'Failed',
  active: 'In progress',
  skipped: 'Skipped',
}

const RESULT_DOT: Record<PatchRunResultStatus, string> = {
  pending: 'bg-subtle-foreground/50',
  running: 'bg-live animate-pulse-ring text-live',
  succeeded: 'bg-success',
  failed: 'bg-critical',
  pending_reboot: 'bg-info',
  skipped: 'bg-subtle-foreground/40',
  cancelled: 'bg-subtle-foreground/40',
}

export function RunPage({ runId }: { runId: string }) {
  const navigate = useNavigate()
  const { data, isLoading, error, refetch } = useQuery(patchRunQuery(runId))
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const live = data?.run.status === 'running'
  const now = useNow(1000, live)
  useTitle(data ? `${data.run.policy_name} · patch run` : 'Patch run')
  const results = useMemo(() => data?.results ?? [], [data])
  const counts = useMemo(() => {
    const out = { all: results.length, succeeded: 0, restart: 0, failed: 0, active: 0, skipped: 0 } as Record<Filter, number>
    for (const result of results) for (const key of Object.keys(MATCH) as Filter[]) if (key !== 'all' && MATCH[key](result.status)) out[key] += 1
    return out
  }, [results])
  const needle = query.trim().toLowerCase()
  const visible = results.filter((result) => MATCH[filter](result.status)).filter((result) => !needle || `${result.hostname} ${result.error ?? ''}`.toLowerCase().includes(needle))

  const columns = useMemo<ColumnDef<PatchRunResult>[]>(
    () => [
      {
        id: 'device',
        accessorFn: (result) => result.hostname.toLowerCase(),
        header: 'Device',
        cell: ({ row }) => (
          <span className="flex min-w-0 items-center gap-2.5">
            <span className={cn('inline-flex size-2 shrink-0 rounded-full', RESULT_DOT[row.original.status])} aria-hidden="true" />
            <span className="max-w-56 truncate font-medium">{row.original.hostname}</span>
          </span>
        ),
      },
      { id: 'status', accessorFn: (result) => RUN_RESULT_ORDER.indexOf(result.status), header: 'Status', cell: ({ row }) => <RunResultBadge status={row.original.status} /> },
      {
        id: 'installed',
        accessorFn: (result) => result.installed,
        header: 'Installed',
        meta: { align: 'right' },
        cell: ({ row }) => <span className={cn('tabular', row.original.installed ? 'text-foreground' : 'text-subtle-foreground')}>{formatNumber(row.original.installed)}</span>,
      },
      {
        id: 'failed',
        accessorFn: (result) => result.failed,
        header: 'Failed',
        meta: { align: 'right' },
        cell: ({ row }) => <span className={cn('tabular', row.original.failed ? 'font-semibold text-critical' : 'text-subtle-foreground')}>{formatNumber(row.original.failed)}</span>,
      },
      {
        id: 'rebooted',
        accessorFn: (result) => (result.rebooted ? 1 : 0),
        header: 'Restarted',
        meta: { align: 'center' },
        cell: ({ row }) =>
          row.original.rebooted ? (
            <span className="inline-flex items-center gap-1 text-success">
              <RotateCw className="size-3.5" />
              Yes
            </span>
          ) : (
            <span className="text-subtle-foreground">—</span>
          ),
      },
      {
        id: 'error',
        accessorFn: (result) => result.error ?? '',
        header: 'Error',
        enableSorting: false,
        cell: ({ row }) =>
          row.original.error ? (
            <span className={cn('block max-w-[30rem] truncate font-mono text-[11.5px]', row.original.status === 'failed' ? 'text-critical/90' : 'text-muted-foreground')} title={row.original.error}>
              {row.original.error}
            </span>
          ) : (
            <span className="text-subtle-foreground">—</span>
          ),
      },
    ],
    [],
  )

  if (error) {
    return (
      <PageContainer>
        <ErrorState error={error} title={isApiError(error) && error.status === 404 ? 'Patch run not found' : 'Could not load this run'} onRetry={() => void refetch()} />
      </PageContainer>
    )
  }
  if (isLoading || !data) {
    return (
      <PageContainer className="grid gap-4">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-80 rounded-xl" />
      </PageContainer>
    )
  }

  const { run } = data
  const finishedAt = live ? now : run.window_end ? Math.min(now, new Date(run.window_end).getTime()) : now
  const elapsed = Math.max(0, (finishedAt - new Date(run.window_start).getTime()) / 1000)
  const done = run.total - run.pending

  return (
    <PageContainer className="grid grid-cols-1 gap-4">
      <header className="grid grid-cols-1 gap-4">
        <Link to="/patching/runs" className="inline-flex w-fit items-center gap-1 text-dense text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" />
          Patch runs
        </Link>
        <div className="flex min-w-0 items-start gap-3.5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary shadow-raised ring-1 ring-primary/20">
            <History className="size-5" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-display truncate text-[22px] leading-tight font-semibold">{run.policy_name}</h1>
              <RunStatusBadge status={run.status} failed={run.failed} />
              <TriggerBadge trigger={run.trigger} />
            </div>
            <p className="mt-1 text-dense text-muted-foreground">
              {run.trigger === 'manual' ? 'Installed outside the maintenance window from the console.' : 'Devices install every effective-approved missing update while the window is open.'}
            </p>
          </div>
        </div>
      </header>

      <section className="grid grid-cols-1 gap-4 rounded-xl bg-card p-4 shadow-card">
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <MetaItem label={run.trigger === 'manual' ? 'Started' : 'Window opened'}>{formatDateTime(run.window_start)}</MetaItem>
          <MetaItem label="Window closes">{run.window_end ? formatDateTime(run.window_end) : 'No window'}</MetaItem>
          <MetaItem label={live ? 'Elapsed' : 'Duration'}>
            <span className="tabular">{formatClock(elapsed)}</span>
          </MetaItem>
          <MetaItem label="Policy">
            {run.policy_id ? (
              <Link to="/automation/policies/$policyId" params={{ policyId: run.policy_id }} search={{ tab: 'patching' }} className="text-primary hover:underline">
                Open policy
              </Link>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </MetaItem>
        </div>
        <div className="grid grid-cols-1 gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-dense text-muted-foreground">
              <span className="tabular font-semibold text-foreground">{formatNumber(done)}</span> of {formatNumber(run.total)} devices finished
            </span>
            <span className="font-display tabular text-lg font-semibold">{run.total ? Math.round((done / run.total) * 100) : 100}%</span>
          </div>
          <RunProgressBar counts={run} height="h-2.5" />
        </div>
        <div className="-mx-1 grid grid-cols-3 gap-1 sm:grid-cols-5">
          <StatButton label="Succeeded" value={run.succeeded} tone="text-success" active={filter === 'succeeded'} onClick={() => setFilter(filter === 'succeeded' ? 'all' : 'succeeded')} />
          <StatButton label="Restart pending" value={run.pending_reboot} tone={run.pending_reboot ? 'text-info' : undefined} active={filter === 'restart'} onClick={() => setFilter(filter === 'restart' ? 'all' : 'restart')} />
          <StatButton label="Failed" value={run.failed} tone={run.failed ? 'text-critical' : undefined} active={filter === 'failed'} onClick={() => setFilter(filter === 'failed' ? 'all' : 'failed')} />
          <StatButton label="In progress" value={run.pending} tone={run.pending ? 'text-live' : undefined} active={filter === 'active'} onClick={() => setFilter(filter === 'active' ? 'all' : 'active')} />
          <StatButton label="Skipped" value={counts.skipped} active={filter === 'skipped'} onClick={() => setFilter(filter === 'skipped' ? 'all' : 'skipped')} />
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {(Object.keys(LABEL) as Filter[]).map((key) => (
            <FilterPill key={key} active={filter === key} onClick={() => setFilter(key)} count={counts[key]} disabled={key !== 'all' && counts[key] === 0}>
              {LABEL[key]}
            </FilterPill>
          ))}
        </div>
        <SearchField value={query} onChange={setQuery} placeholder="Search devices or errors…" label="Search results" className="sm:ml-auto sm:w-64" />
      </div>

      <DataTable
        data={visible}
        columns={columns}
        getRowId={(result) => result.device_id}
        onRowClick={(result) => void navigate({ to: '/devices/$deviceId', params: { deviceId: result.device_id }, search: { tab: 'patches' } })}
        initialSorting={[{ id: 'status', desc: false }]}
        virtualHeight={visible.length > 14 ? '560px' : undefined}
        caption="Results by device"
        empty={
          <div className="p-6">
            <EmptyState compact illustration="search" title={results.length ? 'No results match' : 'No devices in this run'} description={results.length ? 'Try another filter.' : 'Devices with nothing to install are not part of a run.'} />
          </div>
        }
      />
    </PageContainer>
  )
}
