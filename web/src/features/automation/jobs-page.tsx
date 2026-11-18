import { useMemo } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { CalendarClock, ListChecks, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Can } from '@/components/common/can'
import { DataTable } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, RelativeTime } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { jobsApi } from '@/lib/api/endpoints'
import { keys } from '@/lib/api/queries'
import type { JobStatus, JobSummary } from '@/lib/api/types'
import { completedCount, describeSchedule } from '@/lib/automation/labels'
import { formatNumber } from '@/lib/format'
import { PERMISSIONS } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { SearchField } from '@/features/devices/remote-ui'
import { JobStatusBadge, LanguageMark, SegmentedProgress, TargetLabel } from './automation-ui'
import { openRunDialog } from './run-dialog-store'
import { usePendingApprovals } from './use-automation-live'

export interface JobsSearch {
  status?: JobStatus
  q?: string
}

const TABS: { value: JobStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'pending_approval', label: 'Awaiting approval' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'rejected', label: 'Rejected' },
]

export function JobsPage({ search }: { search: JobsSearch }) {
  useTitle('Jobs')
  const navigate = useNavigate()
  const approvals = usePendingApprovals()
  const filters = { status: search.status, limit: 50 }
  const query = useInfiniteQuery({
    queryKey: keys.jobList(filters),
    queryFn: ({ pageParam }) => jobsApi.list(filters, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
    refetchInterval: 30_000,
  })
  const { data: running } = useQuery({
    queryKey: ['jobs', 'list', { status: 'running', limit: 200 }],
    queryFn: () => jobsApi.list({ status: 'running', limit: 200 }),
    meta: { silent: true },
  })
  const all = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data])
  const needle = search.q?.trim().toLowerCase()
  const rows = needle
    ? all.filter((job) =>
        `${job.name} ${job.script.name} ${job.target.label} ${job.created_by_name}`.toLowerCase().includes(needle),
      )
    : all

  const setSearch = (next: JobsSearch) =>
    void navigate({
      to: '/automation/jobs',
      search: (prev) => ({ client: prev.client, site: prev.site, ...next }),
      replace: true,
    })

  const columns = useMemo<ColumnDef<JobSummary>[]>(
    () => [
      {
        id: 'name',
        accessorFn: (job) => job.name.toLowerCase(),
        header: 'Job',
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-2.5">
            <LanguageMark language={row.original.script.language} size="sm" />
            <div className="min-w-0 leading-tight">
              <div className="max-w-72 truncate font-medium">{row.original.name}</div>
              <div className="max-w-72 truncate text-[10.5px] text-subtle-foreground">
                {row.original.script.name} · v{row.original.script_version}
              </div>
            </div>
          </div>
        ),
      },
      {
        id: 'target',
        accessorFn: (job) => job.target.label.toLowerCase(),
        header: 'Target',
        cell: ({ row }) => (
          <TargetLabel
            type={row.original.target.type}
            label={row.original.target.label}
            className="max-w-52 text-muted-foreground"
          />
        ),
      },
      {
        id: 'status',
        accessorKey: 'status',
        header: 'Status',
        cell: ({ row }) => <JobStatusBadge status={row.original.status} />,
      },
      {
        id: 'progress',
        accessorFn: (job) => job.last_run?.started_at ?? '',
        header: 'Last run',
        cell: ({ row }) => {
          const run = row.original.last_run
          if (!run) return <span className="text-subtle-foreground">—</span>
          return (
            <div className="grid w-52 grid-cols-1 gap-1">
              <SegmentedProgress counts={run} />
              <div className="flex items-center justify-between gap-2 text-[10.5px] text-subtle-foreground">
                <span className="tabular">
                  {formatNumber(completedCount(run))}/{formatNumber(run.total)}
                  {run.failed > 0 && <span className="text-critical"> · {formatNumber(run.failed)} failed</span>}
                </span>
                <RelativeTime value={run.started_at} />
              </div>
            </div>
          )
        },
      },
      {
        id: 'next',
        accessorFn: (job) => job.next_run_at ?? '9999',
        header: 'Next run',
        cell: ({ row }) =>
          row.original.next_run_at ? (
            <div className="leading-tight">
              <RelativeTime value={row.original.next_run_at} className="font-medium" />
              <div className="max-w-48 truncate text-[10.5px] text-subtle-foreground">
                {describeSchedule(row.original.schedule)}
              </div>
            </div>
          ) : (
            <span className="text-subtle-foreground">{row.original.schedule.type === 'cron' ? 'Paused' : '—'}</span>
          ),
      },
      {
        id: 'created',
        accessorKey: 'created_at',
        header: 'Created',
        cell: ({ row }) => (
          <div className="leading-tight">
            <div className="max-w-40 truncate">{row.original.created_by_name}</div>
            <RelativeTime value={row.original.created_at} className="text-[10.5px] text-subtle-foreground" />
          </div>
        ),
      },
    ],
    [],
  )

  const runningCount = running?.items.length ?? 0

  return (
    <PageContainer className="flex min-h-full flex-col gap-4 lg:h-full lg:min-h-[640px]">
      <PageHeader
        icon={<ListChecks />}
        title="Jobs"
        description="Every script run — one-off, scheduled, recurring and policy tasks — with live progress per device."
        actions={
          <Can permission={PERMISSIONS.scriptsRun}>
            <Button size="sm" onClick={() => openRunDialog()}>
              <Play data-icon="inline-start" />
              Run a script
            </Button>
          </Can>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <Tabs
          value={search.status ?? 'all'}
          onValueChange={(value) =>
            setSearch({ ...search, status: value === 'all' ? undefined : (value as JobStatus) })
          }
          className="max-w-full min-w-0 gap-0"
        >
          <div className="[scrollbar-width:none] overflow-x-auto">
            <TabsList className="w-max">
              {TABS.map((tab) => (
                <TabsTrigger key={tab.value} value={tab.value} className="px-2.5">
                  {tab.label}
                  {tab.value === 'running' && runningCount > 0 && (
                    <span className="tabular rounded-full bg-live/15 px-1.5 text-[10px] text-live">{runningCount}</span>
                  )}
                  {tab.value === 'pending_approval' && approvals.count > 0 && (
                    <span className="tabular rounded-full bg-warning/15 px-1.5 text-[10px] text-warning">
                      {approvals.count}
                    </span>
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        </Tabs>
        <SearchField
          value={search.q ?? ''}
          onChange={(q) => setSearch({ ...search, q: q || undefined })}
          placeholder="Filter jobs…"
          label="Filter jobs"
          className="sm:ml-auto sm:w-64"
        />
      </div>

      {query.error ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : !query.isLoading && all.length === 0 ? (
        <EmptyState
          illustration="automation"
          title={search.status ? 'No jobs with this status' : 'No jobs yet'}
          description="Run a script on a device, a group, a site or a client — now, at a set time or on a recurring schedule."
          actions={
            <Can permission={PERMISSIONS.scriptsRun}>
              <Button onClick={() => openRunDialog()}>
                <Play data-icon="inline-start" />
                Run a script
              </Button>
            </Can>
          }
        />
      ) : (
        <div className="h-[560px] min-h-0 lg:h-auto lg:flex-1">
          <DataTable
            data={rows}
            columns={columns}
            loading={query.isLoading}
            getRowId={(job) => job.id}
            onRowClick={(job) => void navigate({ to: '/automation/jobs/$jobId', params: { jobId: job.id } })}
            virtualHeight="100%"
            onEndReached={query.hasNextPage && !query.isFetchingNextPage ? () => void query.fetchNextPage() : undefined}
            caption="Jobs"
            empty={
              <div className="p-6">
                <EmptyState compact illustration="search" title="No jobs match" description="Try a different filter." />
              </div>
            }
          />
        </div>
      )}
      {query.isFetchingNextPage && (
        <p className="flex items-center justify-center gap-2 text-micro text-muted-foreground">
          <CalendarClock className="size-3.5" />
          Loading more jobs…
        </p>
      )}
    </PageContainer>
  )
}
