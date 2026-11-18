/* The in-console report viewer: runs (or loads) a JSON report and renders its sections with an outline. */
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowLeft, CalendarClock, ChevronDown, Download, FileSpreadsheet, FileText, RefreshCw, SlidersHorizontal } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/misc'
import { PageContainer } from '@/components/common/page-header'
import { reportsApi } from '@/lib/api/endpoints'
import { reportTypesQuery } from '@/lib/api/queries'
import type { Report, ReportRunStatus } from '@/lib/api/types'
import { formatDateTime } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { buildParameters, formFromSearch, periodLabel, type ReportViewSearch } from '@/lib/reports/params'
import { sectionAnchor, sectionCounts } from '@/lib/reports/sections'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { SECTION_ICON, reportMeta } from './report-meta'
import { ReportSections } from './report-sections'
import { RunDialog } from './run-dialog'
import { useReportFiles, waitForRun } from './use-report-runner'

export function ReportViewPage({ search }: { search: ReportViewSearch & { run?: string } }) {
  const navigate = useNavigate()
  const me = useMe()
  const { runFile } = useReportFiles()
  const { data: types, isLoading: typesLoading } = useQuery(reportTypesQuery)
  const type = types?.find((item) => item.type === search.type)
  const form = useMemo(() => formFromSearch(search), [search])
  const [progress, setProgress] = useState<ReportRunStatus | null>(null)
  const [editing, setEditing] = useState(false)
  const meta = reportMeta(search.type)
  useTitle(type?.name ?? 'Report')

  const query = useQuery({
    queryKey: ['reports', 'view', search],
    enabled: Boolean(type),
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    meta: { silent: true },
    queryFn: async ({ signal }): Promise<{ report: Report; runId: string }> => {
      setProgress(null)
      const follow = async (runId: string) => {
        const run = await waitForRun(runId, { signal, onUpdate: (next) => setProgress(next.status) })
        if (run.status === 'failed') throw new Error(run.error ?? 'The report could not be generated.')
        return { report: await reportsApi.runReport(run.id), runId: run.id }
      }
      if (search.run) return follow(search.run)
      const outcome = await reportsApi.run({ type: search.type, parameters: buildParameters(type, form), format: 'json' })
      if (outcome.kind === 'report') return { report: outcome.report, runId: outcome.run_id }
      if (outcome.kind === 'queued') return follow(outcome.run_id)
      throw new Error('Unexpected response')
    },
  })
  const report = query.data?.report
  const counts = report ? sectionCounts(report.sections) : null

  const download = (format: 'pdf' | 'csv') => type && void runFile({ type: type.type, parameters: buildParameters(type, form), format }, type.name)

  if (!typesLoading && !type) {
    return (
      <PageContainer>
        <EmptyState
          illustration="reports"
          title="This report isn’t available"
          description="The report type is unknown, or you don’t hold the permission its data needs."
          actions={
            <Button size="sm" variant="outline" render={<Link to="/reports" />} nativeButton={false}>
              Back to the library
            </Button>
          }
        />
      </PageContainer>
    )
  }

  return (
    <PageContainer className="grid grid-cols-1 gap-5">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex min-w-0 items-start gap-3.5">
          <span className={cn('mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl ring-1 [&_svg]:size-5', meta.tone)}>
            <meta.icon />
          </span>
          <div className="min-w-0">
            <Link to="/reports" className="eyebrow mb-1 inline-flex items-center gap-1 hover:text-foreground">
              <ArrowLeft className="size-3" />
              Reports
            </Link>
            <h1 className="font-display truncate text-[22px] leading-tight font-semibold">{report?.title ?? type?.name ?? 'Report'}</h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-dense text-muted-foreground">
              {report ? (
                <>
                  <span className="min-w-0 truncate">{report.subtitle}</span>
                  <span className="text-subtle-foreground">·</span>
                  <span className="tabular">Generated {formatDateTime(report.generated_at)}</span>
                </>
              ) : (
                <span>{periodLabel(form)}</span>
              )}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setEditing(true)} disabled={!type}>
            <SlidersHorizontal data-icon="inline-start" />
            Parameters
          </Button>
          <Button variant="outline" size="sm" onClick={() => (search.run ? void navigate({ to: '/reports/view', search: { ...search, run: undefined } }) : void query.refetch())} disabled={query.isFetching}>
            <RefreshCw data-icon="inline-start" className={cn(query.isFetching && 'animate-spin')} />
            {search.run ? 'Run again' : 'Refresh'}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="sm" disabled={!type} />}>
              <Download data-icon="inline-start" />
              Download
              <ChevronDown data-icon="inline-end" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onClick={() => download('pdf')}>
                <FileText />
                PDF document
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => download('csv')}>
                <FileSpreadsheet />
                CSV (every row)
              </DropdownMenuItem>
              {hasPermission(me, PERMISSIONS.reportsManage) && (
                <DropdownMenuItem render={<Link to="/reports/schedules" search={{ edit: 'new', type: search.type }} />}>
                  <CalendarClock />
                  Schedule by e-mail…
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {query.error ? (
        <ErrorState error={query.error} title="The report could not be generated" onRetry={() => void query.refetch()} />
      ) : !report ? (
        <div className="grid gap-4">
          <div className="flex items-center gap-3 rounded-xl bg-card px-4 py-3 shadow-card">
            <Spinner className="text-primary" />
            <div className="min-w-0">
              <p className="text-dense font-medium">{progress === 'queued' ? 'Queued for generation' : 'Generating the report…'}</p>
              <p className="text-micro text-muted-foreground">
                {progress ? 'Large reports run in the background; this page updates when it is ready. You can also pick it up in Run history.' : 'Gathering data from devices, alerts, patches and tickets in scope.'}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-border sm:grid-cols-4">
            {Array.from({ length: 8 }, (_, index) => (
              <Skeleton key={index} className="h-[72px] rounded-none" />
            ))}
          </div>
          <Skeleton className="h-64 rounded-xl" />
          <Skeleton className="h-48 rounded-xl" />
        </div>
      ) : (
        <div className="grid min-w-0 grid-cols-1 gap-5 xl:grid-cols-[220px_minmax(0,1fr)]">
          <aside className="hidden xl:block">
            <nav aria-label="Report sections" className="sticky top-4 grid gap-0.5">
              <div className="mb-1 flex items-center justify-between px-2">
                <span className="eyebrow">Sections</span>
                {counts && <span className="tabular text-micro text-subtle-foreground">{report.sections.length}</span>}
              </div>
              {report.sections.map((section, index) => {
                const Icon = SECTION_ICON[section.kind]
                return (
                  <a
                    key={`${index}-${section.title}`}
                    href={`#${sectionAnchor(section.title, index)}`}
                    className="flex h-8 items-center gap-2 rounded-md px-2 text-dense text-muted-foreground outline-none hover:bg-surface-3 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Icon className="size-3.5 shrink-0 text-subtle-foreground" />
                    <span className="truncate">{section.title}</span>
                  </a>
                )
              })}
              {report.client && (
                <div className="mt-3 rounded-lg bg-surface-2 p-3 text-micro text-muted-foreground ring-1 ring-border">
                  Scoped to <span className="font-medium text-foreground">{report.client.name}</span>. Rows are limited to what you can see.
                </div>
              )}
            </nav>
          </aside>
          <div className="min-w-0">
            {report.sections.length === 0 ? (
              <EmptyState compact illustration="reports" title="Nothing to report" description="No data matched these parameters." />
            ) : (
              <ReportSections sections={report.sections} />
            )}
            <p className="mt-4 flex flex-wrap items-center gap-2 text-micro text-subtle-foreground">
              <Badge variant="outline">Run {query.data?.runId.slice(0, 8)}</Badge>
              Period {formatDateTime(report.period.from)} → {formatDateTime(report.period.to)}
            </p>
          </div>
        </div>
      )}

      {types && <RunDialog open={editing} onOpenChange={setEditing} types={types} initialType={search.type} initialForm={form} />}
    </PageContainer>
  )
}
