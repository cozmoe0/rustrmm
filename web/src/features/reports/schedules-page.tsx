/* Report schedules: deliveries by e-mail with their next and last runs, run-now, enable and edit. */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Building2, CalendarClock, CalendarPlus, CircleAlert, CircleCheck, Ellipsis, History, Mail, Pencil, Play, Trash } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, RelativeTime } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { reportsApi } from '@/lib/api/endpoints'
import { errorMessage } from '@/lib/api/errors'
import { clientsQuery, platformKeys, reportSchedulesQuery, reportTypesQuery, usersQuery } from '@/lib/api/queries'
import type { ReportSchedule, ReportScheduleInput } from '@/lib/api/types'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { parameterChips } from '@/lib/reports/params'
import { describeReportCron } from '@/lib/reports/schedule'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { FormatChip, ReportTypeIcon } from './report-ui'
import { ScheduleEditor } from './schedule-editor'

function toInput(schedule: ReportSchedule, patch: Partial<ReportScheduleInput>): ReportScheduleInput {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { from, to, ...parameters } = schedule.parameters
  return {
    name: schedule.name,
    type: schedule.type,
    parameters,
    format: schedule.format,
    cron: schedule.cron,
    timezone: schedule.timezone,
    recipients: schedule.recipients,
    per_client: schedule.per_client,
    enabled: schedule.enabled,
    ...patch,
  }
}

export function SchedulesPage({ search }: { search: { edit?: string; type?: string } }) {
  useTitle('Report schedules')
  const me = useMe()
  const navigate = useNavigate({ from: '/reports/schedules' })
  const queryClient = useQueryClient()
  const canManage = hasPermission(me, PERMISSIONS.reportsManage)
  const { data: schedules = [], isLoading, error, refetch } = useQuery({ ...reportSchedulesQuery, enabled: canManage })
  const { data: types = [] } = useQuery(reportTypesQuery)
  const { data: clients = [] } = useQuery(clientsQuery())
  const { data: users = [] } = useQuery({ ...usersQuery, enabled: hasPermission(me, PERMISSIONS.usersView), meta: { silent: true } })
  const [deleting, setDeleting] = useState<ReportSchedule | null>(null)
  const editing = search.edit && search.edit !== 'new' ? (schedules.find((item) => item.id === search.edit) ?? null) : null
  const editorOpen = search.edit === 'new' || Boolean(editing)
  const setEdit = (edit: string | undefined) => void navigate({ search: (prev) => ({ ...prev, edit, type: edit === 'new' ? prev.type : undefined }), replace: true })
  const typeName = (type: string) => types.find((item) => item.type === type)?.name ?? type
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: platformKeys.reportSchedules })
    void queryClient.invalidateQueries({ queryKey: platformKeys.reportRuns })
  }

  const toggle = useMutation({
    mutationFn: (schedule: ReportSchedule) => reportsApi.updateSchedule(schedule.id, toInput(schedule, { enabled: !schedule.enabled })),
    meta: { silent: true },
    onSuccess: (saved) => {
      toast.success(saved.enabled ? `“${saved.name}” enabled` : `“${saved.name}” paused`)
      refresh()
    },
    onError: (failure) => toast.error(errorMessage(failure)),
  })
  const runNow = useMutation({
    mutationFn: (schedule: ReportSchedule) => reportsApi.runScheduleNow(schedule.id),
    meta: { silent: true },
    onSuccess: (result, schedule) => {
      toast.success(`Generating “${schedule.name}”`, {
        description: result.run_ids.length > 1 ? `${result.run_ids.length} reports, one per client, are e-mailed when ready.` : 'It is e-mailed to the recipients when ready.',
        action: { label: 'View runs', onClick: () => void navigate({ to: '/reports/runs', search: { schedule: schedule.id } }) },
      })
      refresh()
    },
    onError: (failure) => toast.error(errorMessage(failure)),
  })
  const remove = useMutation({
    mutationFn: (schedule: ReportSchedule) => reportsApi.removeSchedule(schedule.id),
    meta: { silent: true },
    onSuccess: (_result, schedule) => {
      toast.success(`Deleted “${schedule.name}”`)
      setDeleting(null)
      refresh()
    },
    onError: (failure) => toast.error(errorMessage(failure)),
  })

  if (!canManage) {
    return (
      <PageContainer>
        <EmptyState illustration="reports" title="Schedules need “Manage reports”" description="Ask an administrator for the Manage reports permission to e-mail reports on a schedule." />
      </PageContainer>
    )
  }

  return (
    <PageContainer className="grid grid-cols-1 gap-5">
      <PageHeader
        title="Schedules"
        description="Reports e-mailed automatically. Each run covers the 30 days before it, using its creator’s current access."
        actions={
          <Button size="sm" onClick={() => setEdit('new')}>
            <CalendarPlus data-icon="inline-start" />
            New schedule
          </Button>
        }
      />
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isLoading ? (
        <div className="grid gap-3">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-28 rounded-xl" />
          ))}
        </div>
      ) : schedules.length === 0 ? (
        <EmptyState
          illustration="reports"
          title="Nothing is scheduled"
          description="Send a monthly executive summary to every client, or a weekly patch report to your team."
          actions={
            <Button size="sm" onClick={() => setEdit('new')}>
              New schedule
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3">
          {schedules.map((schedule) => {
            const creator = users.find((user) => user.id === schedule.created_by)
            const failed = schedule.last_status === 'failed'
            return (
              <article key={schedule.id} className={cn('grid min-w-0 gap-4 rounded-xl bg-card p-4 shadow-card lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-start', !schedule.enabled && 'opacity-75', failed && schedule.enabled && 'ring-1 ring-critical/30')}>
                <div className="flex min-w-0 items-start gap-3">
                  <ReportTypeIcon type={schedule.type} className="size-9 rounded-lg [&_svg]:size-4" />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <h3 className="truncate text-sm font-semibold">{schedule.name}</h3>
                      <FormatChip format={schedule.format} />
                      {!schedule.enabled && <Badge variant="outline">Paused</Badge>}
                    </div>
                    <p className="truncate text-micro text-muted-foreground">
                      {typeName(schedule.type)} · {parameterChips(schedule.parameters, { client: (id) => clients.find((client) => client.id === id)?.name }).join(' · ')}
                    </p>
                    {creator && <p className="truncate text-micro text-subtle-foreground">Runs as {creator.name}</p>}
                  </div>
                </div>
                <div className="grid min-w-0 content-start gap-1 text-dense">
                  <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                    <CalendarClock className="size-3.5 shrink-0 text-subtle-foreground" />
                    <span className="truncate">{describeReportCron(schedule.cron)}</span>
                  </span>
                  <span className="truncate text-micro text-subtle-foreground">
                    {schedule.timezone.replace(/_/g, ' ')}
                    {schedule.enabled && schedule.next_run_at && (
                      <>
                        {' '}
                        · next <RelativeTime value={schedule.next_run_at} />
                      </>
                    )}
                  </span>
                </div>
                <div className="grid min-w-0 content-start gap-1 text-dense">
                  <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                    {schedule.per_client ? <Building2 className="size-3.5 shrink-0 text-subtle-foreground" /> : <Mail className="size-3.5 shrink-0 text-subtle-foreground" />}
                    <span className="truncate">{schedule.per_client ? `Per client${schedule.recipients.length ? ` + ${schedule.recipients.length}` : ''}` : schedule.recipients.join(', ')}</span>
                  </span>
                  {schedule.last_run_at ? (
                    failed ? (
                      <Tooltip>
                        <TooltipTrigger render={<span className="flex min-w-0 items-center gap-1 text-micro text-critical" />}>
                          <CircleAlert className="size-3 shrink-0" />
                          <span className="truncate">
                            Failed <RelativeTime value={schedule.last_run_at} /> · {schedule.last_error}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-80">{schedule.last_error}</TooltipContent>
                      </Tooltip>
                    ) : (
                      <span className="flex items-center gap-1 text-micro text-success">
                        <CircleCheck className="size-3" />
                        Sent <RelativeTime value={schedule.last_run_at} />
                      </span>
                    )
                  ) : (
                    <span className="text-micro text-subtle-foreground">Not run yet</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 lg:justify-end">
                  <Switch checked={schedule.enabled} onCheckedChange={() => toggle.mutate(schedule)} disabled={toggle.isPending && toggle.variables?.id === schedule.id} aria-label={schedule.enabled ? `Pause ${schedule.name}` : `Enable ${schedule.name}`} />
                  <Button variant="outline" size="sm" disabled={runNow.isPending && runNow.variables?.id === schedule.id} onClick={() => runNow.mutate(schedule)}>
                    {runNow.isPending && runNow.variables?.id === schedule.id ? <Spinner data-icon="inline-start" /> : <Play data-icon="inline-start" />}
                    Run now
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`More for ${schedule.name}`} />}>
                      <Ellipsis />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                      <DropdownMenuItem onClick={() => setEdit(schedule.id)}>
                        <Pencil />
                        Edit schedule
                      </DropdownMenuItem>
                      <DropdownMenuItem render={<Link to="/reports/runs" search={{ schedule: schedule.id }} />}>
                        <History />
                        View runs
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onClick={() => setDeleting(schedule)}>
                        <Trash />
                        Delete schedule
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </article>
            )
          })}
        </div>
      )}
      <ScheduleEditor schedule={editing} initialType={search.type} open={editorOpen} onOpenChange={(open) => !open && setEdit(undefined)} />
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete “${deleting?.name}”?`}
        description="No more reports are sent. Past runs and their files stay in Run history."
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </PageContainer>
  )
}
