import { useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  ArrowLeft,
  ArrowUpRight,
  CalendarClock,
  CircleStop,
  CircleX,
  Ellipsis,
  Hourglass,
  Play,
  ScrollText,
  Trash,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, Mono, RelativeTime } from '@/components/common/misc'
import { PageContainer } from '@/components/common/page-header'
import { jobsApi } from '@/lib/api/endpoints'
import { isApiError } from '@/lib/api/errors'
import { approvalsQuery, jobQuery, keys, scriptQuery } from '@/lib/api/queries'
import type { Job, JobRun } from '@/lib/api/types'
import { TRIGGER_LABEL, describeSchedule, formatTimeout, offlineWaitLabel } from '@/lib/automation/labels'
import { displayParameterValue } from '@/lib/automation/params'
import { formatDateTime, formatNumber, truncateMiddle } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { openWorkspaceTab } from '@/lib/workspace'
import { JobStatusBadge, LanguageMark, RiskBadge, SegmentedProgress, TargetLabel } from './automation-ui'
import { OutputDrawer } from './output-drawer'
import { RunView } from './run-view'

function SummaryCard({ label, icon, children }: { label: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-1 content-start gap-1.5 rounded-xl bg-card p-3.5 shadow-card">
      <div className="flex items-center gap-1.5 text-micro text-subtle-foreground [&_svg]:size-3.5">
        {icon}
        {label}
      </div>
      <div className="min-w-0 text-dense">{children}</div>
    </div>
  )
}

function RunList({
  runs,
  selected,
  onSelect,
}: {
  runs: JobRun[]
  selected: string | undefined
  onSelect: (id: string) => void
}) {
  return (
    <ul className="grid grid-cols-1 gap-1 rounded-xl bg-card p-1.5 shadow-card lg:max-h-[720px] lg:overflow-y-auto">
      {runs.map((run) => {
        const active = run.id === selected
        return (
          <li key={run.id}>
            <button
              type="button"
              onClick={() => onSelect(run.id)}
              aria-current={active || undefined}
              className={cn(
                'grid w-full gap-2 rounded-lg px-3 py-2.5 text-left transition-colors outline-none hover:bg-surface-3/60 focus-visible:ring-2 focus-visible:ring-ring',
                active && 'bg-primary/[0.07] ring-1 ring-primary/25 hover:bg-primary/10',
              )}
            >
              <div className="flex items-center gap-2">
                {run.status === 'running' && (
                  <span className="inline-flex size-1.5 animate-pulse-ring rounded-full bg-live text-live" />
                )}
                <span className="tabular truncate text-dense font-medium">{formatDateTime(run.started_at)}</span>
                <span className="ml-auto shrink-0 text-micro text-subtle-foreground">{TRIGGER_LABEL[run.trigger]}</span>
              </div>
              <SegmentedProgress counts={run} showTooltip={false} />
              <div className="tabular flex items-center gap-2 text-[10.5px] text-subtle-foreground">
                <span className="text-success">{formatNumber(run.succeeded)} ok</span>
                {run.failed > 0 && <span className="text-critical">{formatNumber(run.failed)} failed</span>}
                <span className="ml-auto">{formatNumber(run.total)} devices</span>
              </div>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function ApprovalBanner({ job }: { job: Job }) {
  const me = useMe()
  const canApprove = hasPermission(me, PERMISSIONS.scriptsApprove)
  const { data: approvals = [] } = useQuery({ ...approvalsQuery(), meta: { silent: true } })
  const approval = approvals.find((item) => item.subject.id === job.id)
  if (job.status === 'pending_approval') {
    const mine = approval?.requested_by_name === me?.user.name
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-warning/[0.07] px-4 py-3 ring-1 ring-warning/25">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-warning/15 text-warning">
          <Hourglass className="size-4" />
        </span>
        <div className="min-w-0 flex-1 basis-64">
          <p className="text-dense font-medium">Waiting for a second approver</p>
          <p className="text-micro text-muted-foreground">
            {approval ? `Requested by ${approval.requested_by_name} ` : ''}
            {approval && <RelativeTime value={approval.requested_at} />}. Nothing runs until someone else with approval
            rights approves it. Requests expire after 7 days.
          </p>
        </div>
        {canApprove && !mine && (
          <Button size="sm" variant="outline" render={<Link to="/automation/approvals" />} nativeButton={false}>
            Review
            <ArrowUpRight data-icon="inline-end" />
          </Button>
        )}
      </div>
    )
  }
  if (job.status === 'rejected') {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-critical/[0.05] px-4 py-3 ring-1 ring-critical/25">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-critical/12 text-critical">
          <CircleX className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-dense font-medium">
            Rejected{approval?.decided_by_name ? ` by ${approval.decided_by_name}` : ''}
          </p>
          {approval?.comment && <p className="text-micro text-muted-foreground">“{approval.comment}”</p>}
        </div>
      </div>
    )
  }
  return null
}

export function JobPage({ jobId, runId, deviceId }: { jobId: string; runId?: string; deviceId?: string }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const me = useMe()
  const { data: job, isLoading, error, refetch } = useQuery(jobQuery(jobId))
  const { data: script } = useQuery({
    ...scriptQuery(job?.script.id ?? ''),
    enabled: Boolean(job),
    meta: { silent: true },
  })
  const [confirm, setConfirm] = useState<'cancel' | 'delete' | null>(null)
  useTitle(job?.name)
  const canRun = hasPermission(me, PERMISSIONS.scriptsRun)
  const selectedRun = runId ?? job?.runs[0]?.id

  useEffect(() => {
    if (job)
      openWorkspaceTab({
        id: `job:${job.id}`,
        kind: 'job',
        title: job.name,
        to: '/automation/jobs/$jobId',
        params: { jobId: job.id },
      })
  }, [job])

  const setSearch = (patch: { run?: string; device?: string }) =>
    void navigate({
      to: '/automation/jobs/$jobId',
      params: { jobId },
      search: (prev) => ({ ...prev, ...patch }),
      replace: true,
    })

  const afterChange = (updated?: Job) => {
    if (updated) queryClient.setQueryData(keys.job(jobId), updated)
    void queryClient.invalidateQueries({ queryKey: keys.jobs })
    void queryClient.invalidateQueries({ queryKey: keys.approvals })
  }

  const runNow = useMutation({
    mutationFn: () => jobsApi.runNow(jobId),
    onSuccess: (updated) => {
      afterChange(updated)
      if (updated.runs[0]) setSearch({ run: updated.runs[0].id, device: undefined })
      toast.success('Run started')
    },
  })
  const cancelJob = useMutation({
    mutationFn: () => jobsApi.cancel(jobId),
    onSuccess: (updated) => {
      afterChange(updated)
      setConfirm(null)
      toast.success('Job cancelled')
    },
  })
  const remove = useMutation({
    mutationFn: () => jobsApi.remove(jobId),
    onSuccess: () => {
      afterChange()
      setConfirm(null)
      toast.success('Job deleted; its runs stay in the history')
      void navigate({ to: '/automation/jobs' })
    },
  })

  if (error) {
    return (
      <PageContainer>
        <ErrorState
          error={error}
          title={isApiError(error) && error.status === 404 ? 'Job not found' : 'Could not load this job'}
          onRetry={() => void refetch()}
        />
      </PageContainer>
    )
  }
  if (isLoading || !job) {
    return (
      <PageContainer className="grid grid-cols-1 gap-4">
        <Skeleton className="h-24 rounded-xl" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-24 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-96 rounded-xl" />
      </PageContainer>
    )
  }

  const active = job.runs.some((run) => run.status === 'running')
  const recurring = job.schedule.type !== 'now'
  const parameters = Object.entries(job.parameters)
  const policyJob = job.created_by_name.startsWith('Policy:')

  return (
    <PageContainer className="grid grid-cols-1 gap-5">
      <header className="grid grid-cols-1 gap-4">
        <Link
          to="/automation/jobs"
          className="inline-flex w-fit items-center gap-1 text-dense text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Jobs
        </Link>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-display truncate text-[22px] leading-tight font-semibold">{job.name}</h1>
              <JobStatusBadge status={job.status} />
              {policyJob && (
                <Badge variant="outline">
                  <ScrollText />
                  Policy task
                </Badge>
              )}
              <RiskBadge risk={job.script.risk} />
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-dense text-muted-foreground">
              <LanguageMark language={job.script.language} size="sm" />
              <Link
                to="/automation/scripts/$scriptId"
                params={{ scriptId: job.script.id }}
                className="font-medium text-foreground/90 hover:underline"
              >
                {job.script.name}
              </Link>
              <span>v{job.script_version}</span>
              <Mono className="text-[10.5px]">{truncateMiddle(job.content_sha256, 6)}</Mono>
              <span className="text-subtle-foreground">·</span>
              <TargetLabel type={job.target.type} label={job.target.label} />
            </div>
          </div>
          {canRun && (
            <div className="flex flex-wrap items-center gap-2">
              {recurring && (job.status === 'scheduled' || job.status === 'running') && (
                <Button size="sm" disabled={runNow.isPending} onClick={() => runNow.mutate()}>
                  {runNow.isPending ? <Spinner data-icon="inline-start" /> : <Play data-icon="inline-start" />}
                  Run now
                </Button>
              )}
              {(job.status === 'scheduled' || job.status === 'running' || job.status === 'pending_approval') && (
                <Button size="sm" variant="outline" onClick={() => setConfirm('cancel')}>
                  <CircleStop data-icon="inline-start" />
                  {job.status === 'pending_approval' ? 'Withdraw request' : 'Cancel job'}
                </Button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="outline" size="icon-sm" aria-label="More actions" />}>
                  <Ellipsis />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuItem variant="destructive" disabled={active} onClick={() => setConfirm('delete')}>
                    <Trash />
                    Delete job…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
      </header>

      <ApprovalBanner job={job} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard label="Schedule" icon={<CalendarClock />}>
          <div className="font-medium">{describeSchedule(job.schedule)}</div>
          <div className="text-micro text-muted-foreground">
            {job.next_run_at ? (
              <>
                Next <RelativeTime value={job.next_run_at} /> · {formatDateTime(job.next_run_at)}
              </>
            ) : job.schedule.type === 'once' ? (
              `Set for ${formatDateTime(job.schedule.at)}`
            ) : (
              'No further runs'
            )}
          </div>
        </SummaryCard>
        <SummaryCard label="Execution">
          <div className="font-medium">{offlineWaitLabel(job.offline_wait_minutes)}</div>
          <div className="text-micro text-muted-foreground">
            {job.concurrency} at a time · {formatTimeout(job.timeout_secs)} timeout
          </div>
        </SummaryCard>
        <SummaryCard label="Created">
          <div className="font-medium">{job.created_by_name}</div>
          <div className="text-micro text-muted-foreground">
            <RelativeTime value={job.created_at} />
            {job.approved_by_name && ` · approved by ${job.approved_by_name}`}
          </div>
        </SummaryCard>
        <SummaryCard label="Parameters">
          {parameters.length === 0 ? (
            <span className="text-muted-foreground">None</span>
          ) : (
            <dl className="grid grid-cols-1 gap-0.5">
              {parameters.slice(0, 4).map(([key, value]) => (
                <div key={key} className="flex min-w-0 items-baseline gap-2">
                  <dt className="shrink-0 font-mono text-[11px] text-subtle-foreground">{key}</dt>
                  <dd className="truncate font-mono text-[11.5px]">
                    {displayParameterValue(
                      script?.parameters.find((param) => param.name === key),
                      value,
                    )}
                  </dd>
                </div>
              ))}
              {parameters.length > 4 && (
                <dd className="text-micro text-subtle-foreground">+{parameters.length - 4} more</dd>
              )}
            </dl>
          )}
        </SummaryCard>
      </div>

      {job.runs.length === 0 ? (
        <EmptyState
          illustration="automation"
          title={
            job.status === 'pending_approval'
              ? 'Waiting for approval'
              : job.status === 'scheduled'
                ? 'No runs yet'
                : 'This job never ran'
          }
          description={
            job.status === 'scheduled' && job.next_run_at
              ? `The first run starts ${formatDateTime(job.next_run_at)}.`
              : job.status === 'pending_approval'
                ? 'Runs appear here once the job is approved.'
                : undefined
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          <div className="grid grid-cols-1 content-start gap-2">
            <div className="flex items-center justify-between px-1">
              <h2 className="text-sm font-semibold">Runs</h2>
              <span className="text-micro text-muted-foreground">Latest {job.runs.length}</span>
            </div>
            <RunList
              runs={job.runs}
              selected={selectedRun}
              onSelect={(id) => setSearch({ run: id, device: undefined })}
            />
          </div>
          {selectedRun && (
            <RunView
              key={selectedRun}
              runId={selectedRun}
              canRun={canRun && job.status !== 'pending_approval' && job.status !== 'rejected'}
              onOpenResult={(device) => setSearch({ device })}
              onRunCreated={(id) => setSearch({ run: id, device: undefined })}
            />
          )}
        </div>
      )}

      <OutputDrawer
        runId={deviceId ? (selectedRun ?? null) : null}
        deviceId={deviceId ?? null}
        title={job.name}
        onClose={() => setSearch({ device: undefined })}
      />

      <ConfirmDialog
        open={confirm === 'cancel'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={job.status === 'pending_approval' ? 'Withdraw this request?' : `Cancel “${job.name}”?`}
        description={
          job.status === 'pending_approval'
            ? 'The approval request is closed and the job will not run.'
            : 'The schedule stops and devices that haven’t started are cancelled. Scripts already running finish on their own.'
        }
        confirmLabel={job.status === 'pending_approval' ? 'Withdraw' : 'Cancel job'}
        pending={cancelJob.isPending}
        onConfirm={() => cancelJob.mutate()}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={`Delete “${job.name}”?`}
        description="The job disappears from the list and won't run again. Its runs and results stay in the device history and audit log."
        confirmLabel="Delete job"
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </PageContainer>
  )
}
