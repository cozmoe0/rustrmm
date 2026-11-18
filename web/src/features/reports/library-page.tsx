/* The report library: every report type you can run, with recent runs and upcoming deliveries. */
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowRight, CalendarClock, CalendarPlus, Download, Eye, Play } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, RelativeTime } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { reportRunsQuery, reportSchedulesQuery, reportTypesQuery } from '@/lib/api/queries'
import type { ReportTypeInfo } from '@/lib/api/types'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { emptyReportForm, searchFromForm } from '@/lib/reports/params'
import { describeReportCron } from '@/lib/reports/schedule'
import { useScope } from '@/lib/scope'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { CATEGORY_ORDER, PERMISSION_LABEL, reportMeta } from './report-meta'
import { FormatChip, ReportTypeIcon, RunStatus } from './report-ui'
import { RunDialog } from './run-dialog'
import { useReportFiles } from './use-report-runner'

function ReportCard({ type, onRun, canSchedule, scopeClient }: { type: ReportTypeInfo; onRun: () => void; canSchedule: boolean; scopeClient: string | null }) {
  const meta = reportMeta(type.type)
  const extras = type.parameters.filter((param) => !['client_id', 'site_id', 'from', 'to'].includes(param.name))
  return (
    <article className="group relative flex min-w-0 flex-col gap-3 rounded-xl bg-card p-4 shadow-card transition-colors hover:bg-surface-2">
      <div className="flex items-start gap-3">
        <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg ring-1 [&_svg]:size-4', meta.tone)}>
          <meta.icon />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold tracking-tight">
            <Link to="/reports/view" search={searchFromForm(type.type, emptyReportForm(scopeClient))} className="outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-ring">
              {type.name}
            </Link>
          </h3>
          <p className="mt-0.5 line-clamp-2 text-dense text-muted-foreground">{type.description}</p>
        </div>
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="font-normal">
          {PERMISSION_LABEL[type.permission] ?? type.permission} data
        </Badge>
        {extras.map((param) => (
          <Badge key={param.name} variant="secondary" className="font-normal capitalize">
            {param.name}
          </Badge>
        ))}
        {meta.audience && <span className="hidden min-w-0 truncate text-micro text-subtle-foreground sm:inline">{meta.audience}</span>}
      </div>
      <div className="relative z-[1] flex items-center gap-1.5 border-t border-border pt-3">
        <Button size="sm" variant="outline" onClick={onRun}>
          <Play data-icon="inline-start" />
          Run…
        </Button>
        <Button size="sm" variant="ghost" render={<Link to="/reports/view" search={searchFromForm(type.type, emptyReportForm(scopeClient))} />} nativeButton={false}>
          <Eye data-icon="inline-start" />
          Last 30 days
        </Button>
        {canSchedule && (
          <Tooltip>
            <TooltipTrigger render={<Button size="icon-sm" variant="ghost" className="ml-auto" aria-label={`Schedule ${type.name}`} render={<Link to="/reports/schedules" search={{ edit: 'new', type: type.type }} />} nativeButton={false} />}>
              <CalendarPlus />
            </TooltipTrigger>
            <TooltipContent>Schedule by e-mail</TooltipContent>
          </Tooltip>
        )}
      </div>
    </article>
  )
}

export function LibraryPage({ runType }: { runType?: string }) {
  useTitle('Reports')
  const me = useMe()
  const navigate = useNavigate({ from: '/reports/' })
  const { clientId } = useScope()
  const canManage = hasPermission(me, PERMISSIONS.reportsManage)
  const { data: types, isLoading, error, refetch } = useQuery(reportTypesQuery)
  const { data: runs } = useQuery(reportRunsQuery(100))
  const { data: schedules } = useQuery({ ...reportSchedulesQuery, enabled: canManage })
  const { downloadRun } = useReportFiles()
  const [dialog, setDialog] = useState<string | null>(null)
  const open = dialog ?? runType ?? null

  const grouped = useMemo(
    () => CATEGORY_ORDER.map((category) => ({ category, items: (types ?? []).filter((type) => reportMeta(type.type).category === category) })).filter((group) => group.items.length),
    [types],
  )
  const recent = (runs ?? []).slice(0, 6)
  const upcoming = (schedules ?? []).filter((schedule) => schedule.enabled && schedule.next_run_at).sort((a, b) => a.next_run_at!.localeCompare(b.next_run_at!)).slice(0, 4)
  const typeName = (type: string) => types?.find((item) => item.type === type)?.name ?? type

  return (
    <PageContainer className="grid grid-cols-1 gap-6">
      <PageHeader
        title="Report library"
        description="Executive summaries and detailed exports for one client or all of them — on screen, as a branded PDF, or as CSV."
        actions={
          <>
            {canManage && (
              <Button size="sm" variant="outline" render={<Link to="/reports/schedules" search={{ edit: 'new' }} />} nativeButton={false}>
                <CalendarPlus data-icon="inline-start" />
                New schedule
              </Button>
            )}
            <Button size="sm" onClick={() => setDialog(types?.[0]?.type ?? '')} disabled={!types?.length}>
              <Play data-icon="inline-start" />
              Run a report
            </Button>
          </>
        }
      />

      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="grid min-w-0 content-start gap-6">
            {isLoading ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {Array.from({ length: 6 }, (_, index) => (
                  <Skeleton key={index} className="h-44 rounded-xl" />
                ))}
              </div>
            ) : grouped.length === 0 ? (
              <EmptyState illustration="reports" title="No reports you can run" description="Each report needs the view permission of its data (devices, patches, alerts, tickets, software or audit)." />
            ) : (
              grouped.map((group) => (
                <section key={group.category} className="grid min-w-0 gap-3">
                  <h2 className="eyebrow">{group.category}</h2>
                  <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                    {group.items.map((type) => (
                      <ReportCard key={type.type} type={type} onRun={() => setDialog(type.type)} canSchedule={canManage} scopeClient={clientId ?? null} />
                    ))}
                  </div>
                </section>
              ))
            )}
          </div>

          <aside className="grid min-w-0 content-start gap-4">
            <section className="overflow-hidden rounded-xl bg-card shadow-card">
              <header className="flex items-center justify-between border-b border-border px-4 py-2.5">
                <h2 className="text-sm font-semibold">Recent runs</h2>
                <Link to="/reports/runs" className="inline-flex items-center gap-1 text-micro text-muted-foreground hover:text-foreground">
                  History
                  <ArrowRight className="size-3" />
                </Link>
              </header>
              {recent.length === 0 ? (
                <p className="px-4 py-5 text-dense text-muted-foreground">Reports you run appear here, with their files for 30 days.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {recent.map((run) => (
                    <li key={run.id} className="flex items-center gap-3 px-4 py-2.5">
                      <ReportTypeIcon type={run.type} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-dense font-medium">{run.title}</span>
                          <FormatChip format={run.format} />
                        </div>
                        <div className="truncate text-micro text-muted-foreground">
                          {run.trigger === 'schedule' ? 'Scheduled' : run.user_name} · <RelativeTime value={run.created_at} />
                        </div>
                      </div>
                      {run.status === 'completed' && run.downloadable && run.format !== 'json' ? (
                        <Button variant="ghost" size="icon-sm" aria-label={`Download ${run.file_name ?? run.title}`} onClick={() => void downloadRun(run)}>
                          <Download />
                        </Button>
                      ) : run.status === 'completed' && run.format === 'json' && run.downloadable ? (
                        <Button variant="ghost" size="icon-sm" aria-label={`Open ${run.title}`} render={<Link to="/reports/view" search={{ type: run.type, run: run.id }} />} nativeButton={false}>
                          <Eye />
                        </Button>
                      ) : (
                        <RunStatus run={run} />
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {canManage && (
              <section className="overflow-hidden rounded-xl bg-card shadow-card">
                <header className="flex items-center justify-between border-b border-border px-4 py-2.5">
                  <h2 className="flex items-center gap-2 text-sm font-semibold">
                    <CalendarClock className="size-4 text-subtle-foreground" />
                    Next deliveries
                  </h2>
                  <Link to="/reports/schedules" className="inline-flex items-center gap-1 text-micro text-muted-foreground hover:text-foreground">
                    Schedules
                    <ArrowRight className="size-3" />
                  </Link>
                </header>
                {upcoming.length === 0 ? (
                  <p className="px-4 py-5 text-dense text-muted-foreground">No enabled schedule. Schedule a report to e-mail it every week, month or quarter.</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {upcoming.map((schedule) => (
                      <li key={schedule.id}>
                        <Link to="/reports/schedules" search={{ edit: schedule.id }} className="grid gap-0.5 px-4 py-2.5 outline-none hover:bg-surface-2 focus-visible:bg-surface-2">
                          <span className="truncate text-dense font-medium">{schedule.name}</span>
                          <span className="truncate text-micro text-muted-foreground">
                            {typeName(schedule.type)} · {describeReportCron(schedule.cron)}
                          </span>
                          <span className="text-micro text-subtle-foreground">
                            Next <RelativeTime value={schedule.next_run_at} /> · {schedule.per_client ? 'one per client' : `${schedule.recipients.length} ${schedule.recipients.length === 1 ? 'recipient' : 'recipients'}`}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </aside>
        </div>
      )}

      {types && (
        <RunDialog
          open={open !== null}
          onOpenChange={(next) => {
            if (!next) {
              setDialog(null)
              if (runType) void navigate({ search: {}, replace: true })
            }
          }}
          types={types}
          initialType={open ?? undefined}
          initialForm={emptyReportForm(clientId ?? null)}
        />
      )}
    </PageContainer>
  )
}
