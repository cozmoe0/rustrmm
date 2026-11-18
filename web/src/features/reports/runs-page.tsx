/* Report run history: manual and scheduled runs with their files (kept 30 days) and e-mail recipients. */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { CalendarClock, Download, Eye, Mail, RotateCcw, UserRound, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DataTable } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, RelativeTime } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { clientsQuery, reportRunsQuery, reportSchedulesQuery } from '@/lib/api/queries'
import type { ReportRun, ReportRunStatus } from '@/lib/api/types'
import { formatBytes, formatNumber } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { formFromParameters, parameterChips, searchFromForm } from '@/lib/reports/params'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { FilterPill } from '@/features/patching/patching-ui'
import { FormatChip, ReportTypeIcon, RunStatus } from './report-ui'
import { useReportFiles } from './use-report-runner'

const STATUS_LABEL: Record<ReportRunStatus, string> = { queued: 'Queued', running: 'Generating', completed: 'Ready', failed: 'Failed' }

function duration(run: ReportRun): string | null {
  if (!run.started_at || !run.finished_at) return null
  const seconds = Math.max(0, Math.round((new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 1000))
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`
}

export function RunsPage({ search }: { search: { schedule?: string; status?: ReportRunStatus } }) {
  useTitle('Run history')
  const me = useMe()
  const navigate = useNavigate({ from: '/reports/runs' })
  const canManage = hasPermission(me, PERMISSIONS.reportsManage)
  const { data: runs = [], isLoading, error, refetch } = useQuery(reportRunsQuery(200, search.schedule))
  const { data: clients = [] } = useQuery(clientsQuery())
  const { data: schedules = [] } = useQuery({ ...reportSchedulesQuery, enabled: canManage })
  const { downloadRun } = useReportFiles()
  const clientName = (id: string) => clients.find((client) => client.id === id)?.name
  const schedule = schedules.find((item) => item.id === search.schedule)
  const filtered = runs.filter((run) => !search.status || run.status === search.status)
  const counts = useMemo(() => {
    const out: Record<ReportRunStatus, number> = { queued: 0, running: 0, completed: 0, failed: 0 }
    for (const run of runs) out[run.status] += 1
    return out
  }, [runs])

  const columns = useMemo<ColumnDef<ReportRun>[]>(
    () => [
      {
        id: 'report',
        accessorFn: (run) => run.title.toLowerCase(),
        header: 'Report',
        cell: ({ row }) => {
          const run = row.original
          return (
            <div className="flex min-w-0 items-center gap-2.5">
              <ReportTypeIcon type={run.type} />
              <div className="min-w-0 leading-tight">
                <div className="flex items-center gap-1.5">
                  <span className="max-w-56 truncate font-medium">{run.title}</span>
                  <FormatChip format={run.format} />
                </div>
                <div className="max-w-80 truncate text-[10.5px] text-subtle-foreground">{parameterChips(run.parameters, { client: clientName }).join(' · ')}</div>
              </div>
            </div>
          )
        },
      },
      {
        id: 'status',
        accessorFn: (run) => run.status,
        header: 'Status',
        cell: ({ row }) => <RunStatus run={row.original} />,
      },
      {
        id: 'trigger',
        accessorFn: (run) => (run.trigger === 'schedule' ? (schedules.find((item) => item.id === run.schedule_id)?.name ?? 'Schedule') : run.user_name),
        header: 'Started by',
        cell: ({ row }) => {
          const run = row.original
          const name = run.trigger === 'schedule' ? (schedules.find((item) => item.id === run.schedule_id)?.name ?? 'Scheduled run') : run.user_name
          return (
            <span className="inline-flex max-w-56 items-center gap-1.5 truncate text-muted-foreground">
              {run.trigger === 'schedule' ? <CalendarClock className="size-3.5 shrink-0 text-subtle-foreground" /> : <UserRound className="size-3.5 shrink-0 text-subtle-foreground" />}
              <span className="truncate">{name}</span>
              {run.emailed_to.length > 0 && (
                <Tooltip>
                  <TooltipTrigger render={<span className="inline-flex shrink-0 items-center gap-0.5 rounded-sm px-1 text-[10.5px] ring-1 ring-border" />}>
                    <Mail className="size-3" />
                    {run.emailed_to.length}
                  </TooltipTrigger>
                  <TooltipContent className="max-w-72">E-mailed to {run.emailed_to.join(', ')}</TooltipContent>
                </Tooltip>
              )}
            </span>
          )
        },
      },
      {
        id: 'created',
        accessorFn: (run) => run.created_at,
        header: 'Created',
        cell: ({ row }) => <RelativeTime value={row.original.created_at} className="text-muted-foreground" />,
      },
      {
        id: 'duration',
        accessorFn: (run) => (run.finished_at && run.started_at ? new Date(run.finished_at).getTime() - new Date(run.started_at).getTime() : -1),
        header: 'Took',
        meta: { align: 'right' },
        cell: ({ row }) => <span className="tabular text-muted-foreground">{duration(row.original) ?? '—'}</span>,
      },
      {
        id: 'size',
        accessorFn: (run) => run.size_bytes ?? -1,
        header: 'Size',
        meta: { align: 'right' },
        cell: ({ row }) => <span className="tabular text-muted-foreground">{row.original.size_bytes ? formatBytes(row.original.size_bytes) : '—'}</span>,
      },
      {
        id: 'actions',
        enableSorting: false,
        header: () => <span className="sr-only">Actions</span>,
        meta: { align: 'right' },
        cell: ({ row }) => {
          const run = row.original
          const ready = run.status === 'completed' && run.downloadable
          return (
            <span className="flex justify-end gap-1" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
              {ready && run.format !== 'json' && (
                <Button variant="outline" size="xs" onClick={() => void downloadRun(run)}>
                  <Download data-icon="inline-start" />
                  {run.format.toUpperCase()}
                </Button>
              )}
              {ready && run.format === 'json' && (
                <Button variant="outline" size="xs" render={<Link to="/reports/view" search={{ type: run.type, run: run.id }} />} nativeButton={false}>
                  <Eye data-icon="inline-start" />
                  Open
                </Button>
              )}
              {(!ready || run.format === 'json') && (
                <Tooltip>
                  <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label="Run again with the same parameters" render={<Link to="/reports/view" search={searchFromForm(run.type, formFromParameters(run.parameters))} />} nativeButton={false} />}>
                    <RotateCcw />
                  </TooltipTrigger>
                  <TooltipContent>Run again on screen</TooltipContent>
                </Tooltip>
              )}
            </span>
          )
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [schedules, clients, downloadRun],
  )

  return (
    <PageContainer className="flex min-h-full flex-col gap-4">
      <PageHeader
        title="Run history"
        description={canManage ? 'Every report run in the installation, manual and scheduled. Files are kept for 30 days and run records for 180.' : 'Reports you ran. Files are kept for 30 days.'}
      />
      <div className="flex flex-wrap items-center gap-1.5">
        {(['completed', 'running', 'queued', 'failed'] as ReportRunStatus[]).map((status) => (
          <FilterPill key={status} active={search.status === status} onClick={() => void navigate({ search: (prev) => ({ ...prev, status: prev.status === status ? undefined : status }), replace: true })} count={counts[status]}>
            {STATUS_LABEL[status]}
          </FilterPill>
        ))}
        {schedule && (
          <Badge variant="secondary" className="h-6 gap-1 pr-1">
            <CalendarClock />
            {schedule.name}
            <button type="button" aria-label="Show every run" onClick={() => void navigate({ search: (prev) => ({ ...prev, schedule: undefined }), replace: true })} className="rounded-sm p-0.5 hover:bg-surface-4">
              <X className="size-3" />
            </button>
          </Badge>
        )}
        <span className="tabular ml-auto text-dense text-muted-foreground">{formatNumber(filtered.length)} runs</span>
      </div>
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : !isLoading && runs.length === 0 ? (
        <EmptyState
          illustration="reports"
          title="No report runs yet"
          description="Run a report from the library; on-screen, PDF and CSV runs all land here."
          actions={
            <Button size="sm" render={<Link to="/reports" />} nativeButton={false}>
              Open the library
            </Button>
          }
        />
      ) : (
        <div className={cn('min-h-0 flex-1')}>
          <DataTable data={filtered} columns={columns} loading={isLoading} getRowId={(run) => run.id} initialSorting={[{ id: 'created', desc: true }]} caption="Report runs" />
        </div>
      )}
    </PageContainer>
  )
}
