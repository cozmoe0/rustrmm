import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { ArrowUpRight, CalendarClock, Check, Hourglass, Inbox, ShieldCheck, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { DataTable } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, RelativeTime, UserAvatar } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { approvalsApi } from '@/lib/api/endpoints'
import { approvalsQuery, keys } from '@/lib/api/queries'
import type { Approval } from '@/lib/api/types'
import { describeSchedule, offlineWaitLabel } from '@/lib/automation/labels'
import { formatDateTime } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { LanguageMark, RiskBadge, TargetLabel } from './automation-ui'

const EXPIRY_MS = 7 * 86_400_000

function expiresIn(approval: Approval) {
  const left = new Date(approval.requested_at).getTime() + EXPIRY_MS - Date.now()
  const days = Math.floor(left / 86_400_000)
  const hours = Math.floor((left % 86_400_000) / 3_600_000)
  if (left <= 0) return 'Expired'
  return days > 0 ? `Expires in ${days}d ${hours}h` : `Expires in ${hours}h`
}

function DecisionDialog({
  approval,
  decision,
  onOpenChange,
}: {
  approval: Approval | null
  decision: 'approve' | 'reject'
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [comment, setComment] = useState('')
  const [attempted, setAttempted] = useState(false)
  const needsComment = decision === 'reject'
  const mutation = useMutation({
    mutationFn: () =>
      decision === 'approve'
        ? approvalsApi.approve(approval!.id, comment.trim() || undefined)
        : approvalsApi.reject(approval!.id, comment.trim()),
    meta: { successMessage: decision === 'approve' ? 'Approved — the job is on its way' : 'Rejected' },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.approvals })
      void queryClient.invalidateQueries({ queryKey: keys.jobs })
      onOpenChange(false)
    },
  })
  return (
    <Dialog
      open={Boolean(approval)}
      onOpenChange={(open) => {
        if (!open) {
          setComment('')
          setAttempted(false)
        }
        onOpenChange(open)
      }}
    >
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>
            {decision === 'approve' ? `Approve “${approval?.subject.name}”?` : `Reject “${approval?.subject.name}”?`}
          </DialogTitle>
          <DialogDescription>
            {decision === 'approve'
              ? `${approval?.subject.script.name} will run on ${approval?.subject.target.label}${approval?.subject.schedule.type === 'now' ? ' immediately' : ' on its schedule'}. You'll confirm it's you.`
              : 'The job won’t run. Your comment is shown to the requester.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid grid-cols-1 gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            setAttempted(true)
            if (needsComment && !comment.trim()) return
            mutation.mutate()
          }}
        >
          <Field data-invalid={Boolean(attempted && needsComment && !comment.trim()) || undefined}>
            <FieldLabel htmlFor="approval-comment">{needsComment ? 'Reason' : 'Comment (optional)'}</FieldLabel>
            <Textarea
              id="approval-comment"
              rows={3}
              value={comment}
              maxLength={500}
              autoFocus
              onChange={(event) => setComment(event.target.value)}
              placeholder={needsComment ? 'Why shouldn’t this run?' : 'Anything the requester should know'}
            />
            {attempted && needsComment && !comment.trim() ? (
              <FieldError>Explain why you are rejecting it.</FieldError>
            ) : (
              <FieldDescription>Recorded in the audit log.</FieldDescription>
            )}
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={decision === 'approve' ? 'default' : 'destructive'}
              disabled={mutation.isPending}
            >
              {mutation.isPending ? (
                <Spinner data-icon="inline-start" />
              ) : decision === 'approve' ? (
                <ShieldCheck data-icon="inline-start" />
              ) : (
                <X data-icon="inline-start" />
              )}
              {decision === 'approve' ? 'Approve and run' : 'Reject'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function PendingCard({
  approval,
  mine,
  canApprove,
  onDecide,
}: {
  approval: Approval
  mine: boolean
  canApprove: boolean
  onDecide: (decision: 'approve' | 'reject') => void
}) {
  const job = approval.subject
  const params = Object.entries(job.parameters)
  return (
    <article className="grid grid-cols-1 gap-4 rounded-xl bg-card p-4 shadow-card sm:p-5">
      <div className="flex flex-wrap items-start gap-3">
        <LanguageMark language={job.script.language} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to="/automation/jobs/$jobId"
              params={{ jobId: job.id }}
              className="truncate font-medium hover:underline"
            >
              {job.name}
            </Link>
            <RiskBadge risk={job.script.risk} />
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-micro text-muted-foreground">
            <span>
              {job.script.name} · v{job.script_version}
            </span>
          </div>
        </div>
        <Badge variant="warning">
          <Hourglass />
          {expiresIn(approval)}
        </Badge>
      </div>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-dense sm:grid-cols-3">
        <div className="min-w-0">
          <dt className="text-micro text-subtle-foreground">Target</dt>
          <dd className="mt-0.5 min-w-0">
            <TargetLabel type={job.target.type} label={job.target.label} />
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-micro text-subtle-foreground">When</dt>
          <dd className="mt-0.5 flex min-w-0 items-center gap-1.5">
            <CalendarClock className="size-3.5 shrink-0 text-subtle-foreground" />
            <span className="truncate">
              {job.schedule.type === 'once' ? formatDateTime(job.schedule.at) : describeSchedule(job.schedule)}
            </span>
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-micro text-subtle-foreground">Offline devices</dt>
          <dd className="mt-0.5 truncate">{offlineWaitLabel(job.offline_wait_minutes)}</dd>
        </div>
      </dl>

      {params.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {params.map(([key, value]) => (
            <span
              key={key}
              className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-md bg-surface-2 px-2 font-mono text-[11px] ring-1 ring-border"
            >
              <span className="text-subtle-foreground">{key}</span>
              <span className="truncate">{String(value)}</span>
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3.5">
        <div className="flex min-w-0 items-center gap-2 text-dense">
          <UserAvatar name={approval.requested_by_name} size="sm" />
          <span className="truncate">
            <span className="font-medium">{mine ? 'You' : approval.requested_by_name}</span>{' '}
            <span className="text-muted-foreground">requested</span>{' '}
            <RelativeTime value={approval.requested_at} className="text-muted-foreground" />
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            render={<Link to="/automation/jobs/$jobId" params={{ jobId: job.id }} />}
            nativeButton={false}
          >
            Details
            <ArrowUpRight data-icon="inline-end" />
          </Button>
          {canApprove && (
            <>
              <Button size="sm" variant="outline" onClick={() => onDecide('reject')}>
                <X data-icon="inline-start" />
                Reject
              </Button>
              <Button
                size="sm"
                disabled={mine}
                title={mine ? 'Another approver has to review your own request' : undefined}
                onClick={() => onDecide('approve')}
              >
                <Check data-icon="inline-start" />
                Approve
              </Button>
            </>
          )}
        </div>
        {mine && (
          <p className="w-full text-micro text-subtle-foreground">
            You requested this job, so someone else with approval rights has to approve it.
          </p>
        )}
      </div>
    </article>
  )
}

const DECISION_VARIANT = {
  approved: 'success',
  rejected: 'critical',
  expired: 'secondary',
  pending: 'warning',
} as const

export function ApprovalsPage({ tab }: { tab: 'pending' | 'decided' }) {
  useTitle('Approvals')
  const navigate = useNavigate()
  const me = useMe()
  const canApprove = hasPermission(me, PERMISSIONS.scriptsApprove)
  const { data, isLoading, error, refetch } = useQuery(approvalsQuery())
  const [deciding, setDeciding] = useState<{ approval: Approval; decision: 'approve' | 'reject' } | null>(null)
  const all = useMemo(() => data ?? [], [data])
  const pending = all.filter((approval) => approval.status === 'pending')
  const decided = all.filter((approval) => approval.status !== 'pending')

  const columns = useMemo<ColumnDef<Approval>[]>(
    () => [
      {
        id: 'job',
        accessorFn: (approval) => approval.subject.name.toLowerCase(),
        header: 'Job',
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-2.5">
            <LanguageMark language={row.original.subject.script.language} size="sm" />
            <div className="min-w-0 leading-tight">
              <div className="max-w-72 truncate font-medium">{row.original.subject.name}</div>
              <div className="max-w-72 truncate text-[10.5px] text-subtle-foreground">
                {row.original.subject.target.label}
              </div>
            </div>
          </div>
        ),
      },
      {
        id: 'status',
        accessorKey: 'status',
        header: 'Decision',
        cell: ({ row }) => (
          <Badge variant={DECISION_VARIANT[row.original.status]}>
            {row.original.status[0].toUpperCase() + row.original.status.slice(1)}
          </Badge>
        ),
      },
      {
        id: 'requested',
        accessorKey: 'requested_by_name',
        header: 'Requested by',
        cell: ({ row }) => <span>{row.original.requested_by_name}</span>,
      },
      {
        id: 'decided',
        accessorFn: (approval) => approval.decided_at ?? '',
        header: 'Decided',
        cell: ({ row }) => (
          <div className="leading-tight">
            <div>{row.original.decided_by_name ?? '—'}</div>
            {row.original.decided_at && (
              <RelativeTime value={row.original.decided_at} className="text-[10.5px] text-subtle-foreground" />
            )}
          </div>
        ),
      },
      {
        id: 'comment',
        accessorFn: (approval) => approval.comment ?? '',
        header: 'Comment',
        enableSorting: false,
        cell: ({ getValue }) => (
          <span className="block max-w-80 truncate text-muted-foreground">{getValue<string>() || '—'}</span>
        ),
      },
    ],
    [],
  )

  return (
    <PageContainer className="grid grid-cols-1 gap-4">
      <PageHeader
        icon={<Inbox />}
        title="Approvals"
        description="Four-eyes review for mass actions and high-risk scripts. A requester can't approve their own request."
      />
      <Tabs
        value={tab}
        onValueChange={(value) =>
          void navigate({
            to: '/automation/approvals',
            search: { tab: value === 'pending' ? undefined : 'decided' },
            replace: true,
          })
        }
        className="gap-0"
      >
        <TabsList>
          <TabsTrigger value="pending" className="px-3">
            Pending
            {pending.length > 0 && (
              <span className="tabular rounded-full bg-warning/15 px-1.5 text-[10px] text-warning">
                {pending.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="decided" className="px-3">
            Decided
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : tab === 'pending' ? (
        isLoading ? (
          <div className="grid grid-cols-1 gap-3">
            {Array.from({ length: 2 }, (_, index) => (
              <Skeleton key={index} className="h-56 rounded-xl" />
            ))}
          </div>
        ) : pending.length === 0 ? (
          <EmptyState
            illustration="automation"
            title="Nothing waiting for approval"
            description="Jobs above the mass-action threshold or using high-risk scripts land here when four-eyes approval is on."
          />
        ) : (
          <div className={cn('grid gap-3', pending.length > 1 && '2xl:grid-cols-2')}>
            {pending.map((approval) => (
              <PendingCard
                key={approval.id}
                approval={approval}
                mine={approval.requested_by_name === me?.user.name}
                canApprove={canApprove}
                onDecide={(decision) => setDeciding({ approval, decision })}
              />
            ))}
          </div>
        )
      ) : (
        <DataTable
          data={decided}
          columns={columns}
          loading={isLoading}
          getRowId={(approval) => approval.id}
          onRowClick={(approval) =>
            void navigate({ to: '/automation/jobs/$jobId', params: { jobId: approval.subject.id } })
          }
          initialSorting={[{ id: 'decided', desc: true }]}
          caption="Decided approvals"
          empty={
            <div className="p-6">
              <EmptyState compact illustration="automation" title="No decisions yet" />
            </div>
          }
        />
      )}
      <DecisionDialog
        approval={deciding?.approval ?? null}
        decision={deciding?.decision ?? 'approve'}
        onOpenChange={(open) => !open && setDeciding(null)}
      />
    </PageContainer>
  )
}
