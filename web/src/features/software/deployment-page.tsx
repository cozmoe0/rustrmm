import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { ArrowLeft, ArrowUpRight, CircleStop, Rocket } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { DataTable } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/misc'
import { PageContainer } from '@/components/common/page-header'
import { softwareApi } from '@/lib/api/endpoints'
import { errorMessage, isApiError } from '@/lib/api/errors'
import { deploymentQuery, keys } from '@/lib/api/queries'
import type { DeploymentResult, DeploymentResultStatus, DeploymentSchedule } from '@/lib/api/types'
import { RESULT_ORDER } from '@/lib/software/labels'
import { formatDateTime, formatNumber } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { SearchField } from '@/features/devices/remote-ui'
import { MetaItem, OutputBlock, TargetLabel } from '@/features/automation/automation-ui'
import { FilterPill, StatButton } from '@/features/patching/patching-ui'
import { ActionBadge, DeploymentBar, DeploymentStatusBadge, ResultBadge } from './software-ui'

type Filter = 'all' | DeploymentResultStatus

function describeSchedule(schedule: DeploymentSchedule | undefined) {
  if (!schedule || schedule.type === 'now') return 'Immediately'
  if (schedule.type === 'once') return `Once, ${formatDateTime(schedule.at)}`
  return 'Each device’s maintenance window'
}

export function DeploymentPage({ deploymentId }: { deploymentId: string }) {
  const queryClient = useQueryClient()
  const me = useMe()
  const canDeploy = hasPermission(me, PERMISSIONS.softwareDeploy)
  const { data, isLoading, error, refetch } = useQuery(deploymentQuery(deploymentId))
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [cancelling, setCancelling] = useState(false)
  const [output, setOutput] = useState<DeploymentResult | null>(null)
  useTitle(data ? `${data.deployment.package.name} · deployment` : 'Deployment')
  const results = useMemo(() => data?.results ?? [], [data])
  const count = (status: DeploymentResultStatus) => results.filter((result) => result.status === status).length
  const needle = query.trim().toLowerCase()
  const visible = results.filter((result) => filter === 'all' || result.status === filter).filter((result) => !needle || `${result.hostname} ${result.error ?? ''}`.toLowerCase().includes(needle))

  const cancel = useMutation({
    mutationFn: () => softwareApi.cancelDeployment(deploymentId),
    meta: { silent: true },
    onSuccess: (detail) => {
      if (detail) queryClient.setQueryData(keys.deployment(deploymentId), detail)
      void queryClient.invalidateQueries({ queryKey: keys.deployments })
      setCancelling(false)
      toast.success('Deployment cancelled — actions already running will finish')
    },
    onError: (failure) => {
      setCancelling(false)
      toast.error(isApiError(failure) && failure.code === 'invalid_status' ? 'This deployment has already finished.' : errorMessage(failure))
    },
  })

  const columns = useMemo<ColumnDef<DeploymentResult>[]>(
    () => [
      {
        id: 'device',
        accessorFn: (result) => result.hostname.toLowerCase(),
        header: 'Device',
        cell: ({ row }) => (
          <Link to="/devices/$deviceId" params={{ deviceId: row.original.device_id }} search={{ tab: 'software' }} onClick={(event) => event.stopPropagation()} className="block max-w-56 truncate font-medium hover:underline">
            {row.original.hostname}
          </Link>
        ),
      },
      { id: 'status', accessorFn: (result) => RESULT_ORDER.indexOf(result.status), header: 'Status', cell: ({ row }) => <ResultBadge status={row.original.status} /> },
      {
        id: 'exit',
        accessorFn: (result) => result.exit_code ?? -999,
        header: 'Exit',
        meta: { align: 'right' },
        cell: ({ row }) =>
          row.original.exit_code === null ? (
            <span className="text-subtle-foreground">—</span>
          ) : (
            <span className={cn('tabular font-mono text-[12px]', [0, 3010, 1641].includes(row.original.exit_code) ? 'text-muted-foreground' : 'font-semibold text-critical')}>{row.original.exit_code}</span>
          ),
      },
      {
        id: 'detected',
        accessorFn: (result) => (result.detected_after === null ? -1 : result.detected_after ? 1 : 0),
        header: 'Detected after',
        cell: ({ row }) =>
          row.original.detected_after === null ? <span className="text-subtle-foreground">—</span> : row.original.detected_after ? <span className="text-success">Yes</span> : <span className="text-muted-foreground">No</span>,
      },
      {
        id: 'output',
        accessorFn: (result) => result.error ?? result.output_preview ?? '',
        header: 'Output',
        enableSorting: false,
        cell: ({ row }) => {
          const text = row.original.error ?? row.original.output_preview?.split('\n').filter(Boolean).at(-1) ?? ''
          return (
            <span className={cn('block max-w-[28rem] truncate font-mono text-[11.5px]', row.original.status === 'failed' ? 'text-critical/90' : 'text-muted-foreground')} title={text}>
              {text || (row.original.status === 'pending' || row.original.status === 'running' ? '…' : '')}
            </span>
          )
        },
      },
    ],
    [],
  )

  if (error)
    return (
      <PageContainer>
        <ErrorState error={error} title={isApiError(error) && error.status === 404 ? 'Deployment not found' : 'Could not load this deployment'} onRetry={() => void refetch()} />
      </PageContainer>
    )
  if (isLoading || !data)
    return (
      <PageContainer className="grid gap-4">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-80 rounded-xl" />
      </PageContainer>
    )

  const deployment = data.deployment
  const open = deployment.status === 'running' || deployment.status === 'scheduled'
  const finished = deployment.total - deployment.pending
  const skipped = count('skipped')
  const cancelled = count('cancelled')

  return (
    <PageContainer className="grid grid-cols-1 gap-4">
      <header className="grid grid-cols-1 gap-4">
        <Link to="/software/deployments" className="inline-flex w-fit items-center gap-1 text-dense text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" />
          Deployments
        </Link>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 items-start gap-3.5">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary shadow-raised ring-1 ring-primary/20">
              <Rocket className="size-5" />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="font-display truncate text-[22px] leading-tight font-semibold">{deployment.package.name}</h1>
                <ActionBadge action={deployment.action} />
                <DeploymentStatusBadge status={deployment.status} failed={deployment.failed} />
              </div>
              <p className="mt-1 text-dense text-muted-foreground">
                {deployment.target ? <TargetLabel type={deployment.target.type} label={deployment.target_label} /> : deployment.target_label} · by {deployment.created_by_name}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {deployment.package.id && (
              <Button size="sm" variant="outline" render={<Link to="/software/library" search={{ edit: deployment.package.id } as never} />} nativeButton={false}>
                Package
                <ArrowUpRight data-icon="inline-end" />
              </Button>
            )}
            {canDeploy && open && (
              <Button size="sm" variant="outline" disabled={cancel.isPending} onClick={() => setCancelling(true)}>
                {cancel.isPending ? <Spinner data-icon="inline-start" /> : <CircleStop data-icon="inline-start" />}
                Cancel deployment
              </Button>
            )}
          </div>
        </div>
      </header>

      <section className="grid grid-cols-1 gap-4 rounded-xl bg-card p-4 shadow-card">
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <MetaItem label="Created">{formatDateTime(deployment.created_at)}</MetaItem>
          <MetaItem label="Schedule">{describeSchedule(deployment.schedule)}</MetaItem>
          <MetaItem label="Finished">{deployment.finished_at ? formatDateTime(deployment.finished_at) : open ? 'In progress' : '—'}</MetaItem>
          <MetaItem label="Devices">{formatNumber(deployment.total)}</MetaItem>
        </div>
        <div className="grid grid-cols-1 gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-dense text-muted-foreground">
              <span className="tabular font-semibold text-foreground">{formatNumber(finished)}</span> of {formatNumber(deployment.total)} devices finished
            </span>
            <span className="font-display tabular text-lg font-semibold">{deployment.total ? Math.round((finished / deployment.total) * 100) : 100}%</span>
          </div>
          <DeploymentBar counts={deployment} height="h-2.5" />
        </div>
        <div className="-mx-1 grid grid-cols-3 gap-1 sm:grid-cols-5">
          <StatButton label="Succeeded" value={deployment.succeeded} tone="text-success" active={filter === 'succeeded'} onClick={() => setFilter(filter === 'succeeded' ? 'all' : 'succeeded')} />
          <StatButton label="Failed" value={deployment.failed} tone={deployment.failed ? 'text-critical' : undefined} active={filter === 'failed'} onClick={() => setFilter(filter === 'failed' ? 'all' : 'failed')} />
          <StatButton label="Pending" value={deployment.pending} tone={deployment.pending ? 'text-live' : undefined} active={filter === 'pending'} onClick={() => setFilter(filter === 'pending' ? 'all' : 'pending')} />
          <StatButton label="Skipped" value={skipped} active={filter === 'skipped'} onClick={() => setFilter(filter === 'skipped' ? 'all' : 'skipped')} />
          <StatButton label="Cancelled" value={cancelled} active={filter === 'cancelled'} onClick={() => setFilter(filter === 'cancelled' ? 'all' : 'cancelled')} />
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {(['all', 'running', 'pending', 'succeeded', 'failed', 'skipped', 'cancelled'] as Filter[]).map((key) => {
            const total = key === 'all' ? results.length : count(key)
            return (
              <FilterPill key={key} active={filter === key} onClick={() => setFilter(key)} count={total} disabled={key !== 'all' && total === 0}>
                {key === 'all' ? 'All' : key[0].toUpperCase() + key.slice(1)}
              </FilterPill>
            )
          })}
        </div>
        <SearchField value={query} onChange={setQuery} placeholder="Search devices or errors…" label="Search results" className="sm:ml-auto sm:w-64" />
      </div>

      <DataTable
        data={visible}
        columns={columns}
        getRowId={(result) => result.device_id}
        onRowClick={setOutput}
        initialSorting={[{ id: 'status', desc: false }]}
        virtualHeight={visible.length > 14 ? '540px' : undefined}
        caption="Results by device"
        empty={
          <div className="p-6">
            <EmptyState compact illustration="search" title={results.length ? 'No results match' : 'No devices'} description={results.length ? 'Try another filter.' : 'The target resolved to no devices.'} />
          </div>
        }
      />

      <Sheet open={Boolean(output)} onOpenChange={(next) => !next && setOutput(null)}>
        <SheetContent side="right" className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[640px]">
          <SheetHeader className="border-b border-border px-5 pt-5 pb-4">
            <SheetTitle>{output?.hostname}</SheetTitle>
            <SheetDescription>
              {deployment.package.name} · {deployment.action}
            </SheetDescription>
            {output && (
              <div className="mt-2 grid grid-cols-3 gap-3">
                <MetaItem label="Status">
                  <ResultBadge status={output.status} />
                </MetaItem>
                <MetaItem label="Exit code">{output.exit_code ?? '—'}</MetaItem>
                <MetaItem label="Detected after">{output.detected_after === null ? '—' : output.detected_after ? 'Yes' : 'No'}</MetaItem>
              </div>
            )}
          </SheetHeader>
          <div className="grid gap-3 overflow-y-auto p-5">
            {output?.error && <p className="rounded-lg bg-critical/[0.06] px-3 py-2 font-mono text-[12px] text-critical ring-1 ring-critical/25">{output.error}</p>}
            <OutputBlock text={output?.output_preview ?? ''} empty="No output yet" numbered />
            <p className="text-micro text-subtle-foreground">The first 4 KiB of stdout and stderr from the installer.</p>
          </div>
        </SheetContent>
      </Sheet>
      <ConfirmDialog
        open={cancelling}
        onOpenChange={setCancelling}
        title="Cancel this deployment?"
        description="Devices that haven’t started are cancelled. Actions already running finish."
        confirmLabel="Cancel deployment"
        pending={cancel.isPending}
        onConfirm={() => cancel.mutate()}
      />
    </PageContainer>
  )
}
