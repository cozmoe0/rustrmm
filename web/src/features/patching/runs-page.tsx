import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { CalendarClock, Zap } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { DataTable } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, RelativeTime } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { patchRunsQuery } from '@/lib/api/queries'
import type { PatchRun } from '@/lib/api/types'
import { formatDateTime, formatNumber } from '@/lib/format'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { SearchField } from '@/features/devices/remote-ui'
import { FilterPill, RunProgressBar, RunStatusBadge } from './patching-ui'

type Filter = 'all' | 'running' | 'failed' | 'window' | 'manual'

const FILTERS: { key: Filter; label: string; match: (run: PatchRun) => boolean }[] = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'running', label: 'Running', match: (run) => run.status === 'running' },
  { key: 'failed', label: 'With failures', match: (run) => run.failed > 0 },
  { key: 'window', label: 'Maintenance windows', match: (run) => run.trigger !== 'manual' },
  { key: 'manual', label: 'Immediate installs', match: (run) => run.trigger === 'manual' },
]

function windowSpan(run: PatchRun) {
  const start = new Date(run.window_start)
  if (!run.window_end) return formatDateTime(start)
  const end = new Date(run.window_end)
  const sameDay = start.toDateString() === end.toDateString()
  return `${formatDateTime(start)} – ${sameDay ? end.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : formatDateTime(end)}`
}

export function TriggerBadge({ trigger }: { trigger: PatchRun['trigger'] }) {
  return trigger === 'manual' ? (
    <Badge variant="outline">
      <Zap />
      Immediate
    </Badge>
  ) : (
    <Badge variant="outline">
      <CalendarClock />
      Window
    </Badge>
  )
}

export function RunsPage() {
  useTitle('Patch runs')
  const navigate = useNavigate()
  const { data, isLoading, error, refetch } = useQuery(patchRunsQuery(200))
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const runs = useMemo(() => data ?? [], [data])
  const needle = query.trim().toLowerCase()
  const visible = runs.filter((run) => FILTERS.find((item) => item.key === filter)!.match(run)).filter((run) => !needle || run.policy_name.toLowerCase().includes(needle))

  const columns = useMemo<ColumnDef<PatchRun>[]>(
    () => [
      {
        id: 'policy',
        accessorFn: (run) => run.policy_name.toLowerCase(),
        header: 'Run',
        cell: ({ row }) => (
          <div className="min-w-0 leading-tight">
            <div className="max-w-64 truncate font-medium">{row.original.policy_name}</div>
            <div className="max-w-64 truncate text-[10.5px] text-subtle-foreground">{windowSpan(row.original)}</div>
          </div>
        ),
      },
      { id: 'trigger', accessorFn: (run) => run.trigger ?? 'window', header: 'Trigger', cell: ({ row }) => <TriggerBadge trigger={row.original.trigger} /> },
      { id: 'status', accessorFn: (run) => run.status, header: 'Status', cell: ({ row }) => <RunStatusBadge status={row.original.status} failed={row.original.failed} /> },
      {
        id: 'progress',
        accessorFn: (run) => (run.total ? (run.succeeded + run.pending_reboot) / run.total : 0),
        header: 'Progress',
        cell: ({ row }) => <RunProgressBar counts={row.original} className="w-40" />,
      },
      { id: 'total', accessorFn: (run) => run.total, header: 'Devices', meta: { align: 'right' }, cell: ({ row }) => <span className="tabular">{formatNumber(row.original.total)}</span> },
      {
        id: 'succeeded',
        accessorFn: (run) => run.succeeded,
        header: 'Succeeded',
        meta: { align: 'right' },
        cell: ({ row }) => <span className="tabular text-success">{formatNumber(row.original.succeeded)}</span>,
      },
      {
        id: 'restart',
        accessorFn: (run) => run.pending_reboot,
        header: 'Restart',
        meta: { align: 'right' },
        cell: ({ row }) => <span className={cn('tabular', row.original.pending_reboot ? 'text-info' : 'text-subtle-foreground')}>{formatNumber(row.original.pending_reboot)}</span>,
      },
      {
        id: 'failed',
        accessorFn: (run) => run.failed,
        header: 'Failed',
        meta: { align: 'right' },
        cell: ({ row }) => <span className={cn('tabular', row.original.failed ? 'font-semibold text-critical' : 'text-subtle-foreground')}>{formatNumber(row.original.failed)}</span>,
      },
      {
        id: 'pending',
        accessorFn: (run) => run.pending,
        header: 'Pending',
        meta: { align: 'right' },
        cell: ({ row }) => <span className={cn('tabular', row.original.pending ? 'text-live' : 'text-subtle-foreground')}>{formatNumber(row.original.pending)}</span>,
      },
      {
        id: 'started',
        accessorFn: (run) => run.window_start,
        header: 'Started',
        cell: ({ row }) => <RelativeTime value={row.original.window_start} className="text-muted-foreground" />,
      },
    ],
    [],
  )

  return (
    <PageContainer className="grid grid-cols-1 gap-4">
      <PageHeader title="Patch runs" description="One run each time a policy window opens, plus immediate installs. Results stream in live as devices report back." />
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((item) => (
            <FilterPill key={item.key} active={filter === item.key} onClick={() => setFilter(item.key)} count={runs.filter(item.match).length}>
              {item.label}
            </FilterPill>
          ))}
        </div>
        <SearchField value={query} onChange={setQuery} placeholder="Search policies…" label="Search runs" className="sm:ml-auto sm:w-60" />
      </div>
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : !isLoading && runs.length === 0 ? (
        <EmptyState illustration="patching" title="No patch runs yet" description="A run starts when a policy’s maintenance window opens, or when someone installs updates on a device now." />
      ) : (
        <DataTable
          data={visible}
          columns={columns}
          loading={isLoading}
          getRowId={(run) => run.id}
          onRowClick={(run) => void navigate({ to: '/patching/runs/$runId', params: { runId: run.id } })}
          initialSorting={[{ id: 'started', desc: true }]}
          virtualHeight={visible.length > 14 ? 'min(70vh, 720px)' : undefined}
          caption="Patch runs"
          empty={<div className="px-4 py-10 text-center text-dense text-muted-foreground">No runs match.</div>}
        />
      )}
    </PageContainer>
  )
}
