import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Boxes, CalendarClock, CircleAlert, Ellipsis, Pencil, Play, Plus, ScanSearch, Trash } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, RelativeTime } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { scansApi } from '@/lib/api/endpoints'
import { networkKeys, probesQuery, scansQuery } from '@/lib/api/queries'
import type { NetworkScan } from '@/lib/api/types'
import { describeCron } from '@/lib/cron'
import { formatNumber, formatSpan } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { useNow } from '@/features/tickets/use-now'
import { MethodChips, ProbeBadge } from './network-ui'
import { ScanEditor } from './scan-editor'
import { networkErrorMessage, siteLabel, useScopedSites } from './use-network'

function LastRun({ scan }: { scan: NetworkScan }) {
  const now = useNow(1_000)
  const run = scan.last_run
  if (!run) return <span className="text-dense text-subtle-foreground">Never run</span>
  if (run.status === 'running') {
    const elapsed = Math.max(0, Math.round((now - new Date(run.at).getTime()) / 1000))
    return (
      <div className="grid gap-1.5">
        <span className="flex items-center gap-2 text-dense font-medium text-live">
          <span className="inline-flex size-1.5 animate-pulse-ring rounded-full bg-live text-live" />
          Scanning · {elapsed}s
        </span>
        <div className="relative h-1 w-full overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-label="Scan in progress">
          <span className="absolute inset-y-0 w-1/3 animate-[scan-sweep_1.6s_ease-in-out_infinite] rounded-full bg-live" />
        </div>
      </div>
    )
  }
  return (
    <div className="grid gap-0.5">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-dense">
        {run.status === 'succeeded' ? <Badge variant="success">Succeeded</Badge> : <Badge variant="critical">Failed</Badge>}
        {run.status === 'succeeded' && (
          <span className="tabular">
            {formatNumber(run.hosts_found)} {run.hosts_found === 1 ? 'host' : 'hosts'}
          </span>
        )}
        {run.duration_ms != null && <span className="tabular text-muted-foreground">in {formatSpan(run.duration_ms / 1000)}</span>}
      </span>
      <span className="text-micro text-subtle-foreground">
        <RelativeTime value={run.at} />
      </span>
      {run.error && (
        <span className="flex items-start gap-1.5 text-micro text-critical">
          <CircleAlert className="mt-px size-3 shrink-0" />
          {run.error}
        </span>
      )}
    </div>
  )
}

export function ScansPage({ search }: { search: { edit?: string } }) {
  useTitle('Scans')
  const me = useMe()
  const navigate = useNavigate({ from: '/network/scans' })
  const queryClient = useQueryClient()
  const canManage = hasPermission(me, PERMISSIONS.networkManage)
  const { byId } = useScopedSites()
  const { data, isLoading, error, refetch } = useQuery(scansQuery)
  const probes = useQuery(probesQuery)
  const [deleting, setDeleting] = useState<NetworkScan | null>(null)
  const scans = (data ?? []).filter((scan) => byId.has(scan.site_id))
  const editing = search.edit === 'new' ? null : scans.find((scan) => scan.id === search.edit) ?? null
  const editorOpen = canManage && (search.edit === 'new' || Boolean(editing))
  const setEdit = (edit: string | undefined) => void navigate({ search: { edit }, replace: true })

  const run = useMutation({
    mutationFn: (scan: NetworkScan) => scansApi.run(scan.id),
    meta: { silent: true },
    onSuccess: (_result, scan) => {
      toast.success(`Scanning ${scan.ranges.join(', ')}`, { description: 'Hosts appear under Discovered assets as the probe reports them.' })
      void queryClient.invalidateQueries({ queryKey: networkKeys.scans })
    },
    onError: (failure) => toast.error(networkErrorMessage(failure)),
  })

  const remove = useMutation({
    mutationFn: (scan: NetworkScan) => scansApi.remove(scan.id),
    meta: { silent: true },
    onSuccess: (_result, scan) => {
      toast.success(`Deleted “${scan.name}”`)
      setDeleting(null)
      void queryClient.invalidateQueries({ queryKey: networkKeys.scans })
    },
    onError: (failure) => toast.error(networkErrorMessage(failure)),
  })

  return (
    <PageContainer className="grid grid-cols-1 gap-5">
      <PageHeader
        icon={<ScanSearch />}
        title="Scans"
        description="Discovery sweeps run by each site’s probe: ICMP, ARP, TCP ports, SNMP, mDNS and NetBIOS. Results land in Discovered assets."
        actions={
          canManage && (
            <Button size="sm" onClick={() => setEdit('new')}>
              <Plus data-icon="inline-start" />
              New scan
            </Button>
          )
        }
      />
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isLoading ? (
        <div className="grid gap-3">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-32 rounded-xl" />
          ))}
        </div>
      ) : scans.length === 0 ? (
        <EmptyState
          illustration="network"
          title="No scans yet"
          description="Create a scan for a site with a probe to find printers, switches, cameras and unmanaged computers."
          actions={canManage && <Button size="sm" onClick={() => setEdit('new')}>New scan</Button>}
        />
      ) : (
        <div className="grid gap-3">
          {scans.map((scan) => {
            const site = byId.get(scan.site_id)
            const probe = probes.data?.find((item) => item.site_id === scan.site_id)
            const running = scan.last_run?.status === 'running'
            return (
              <article key={scan.id} className={cn('grid min-w-0 gap-4 rounded-xl bg-card p-4 shadow-card lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,14rem)_auto] lg:items-start', running && 'ring-1 ring-live/30')}>
                <div className="grid min-w-0 gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold">{scan.name}</h3>
                    <p className="truncate text-micro text-subtle-foreground">{siteLabel(site, scan.site_name)}</p>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {scan.ranges.map((range) => (
                      <span key={range} className="inline-flex h-5 items-center rounded-[5px] bg-primary/10 px-1.5 font-mono text-[11px] text-primary ring-1 ring-primary/20">
                        {range}
                      </span>
                    ))}
                  </div>
                  <MethodChips methods={scan.methods} />
                </div>
                <div className="grid min-w-0 content-start gap-1.5 text-dense">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <CalendarClock className="size-3.5 shrink-0 text-subtle-foreground" />
                    {scan.schedule ? (
                      <span className="min-w-0 truncate">
                        {describeCron(scan.schedule.cron)}
                        {scan.next_run_at && (
                          <span className="text-subtle-foreground">
                            {' '}
                            · next <RelativeTime value={scan.next_run_at} />
                          </span>
                        )}
                      </span>
                    ) : (
                      'On demand'
                    )}
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                    <span className="text-subtle-foreground">Probe</span>
                    <ProbeBadge probe={probe} />
                  </span>
                  {scan.snmp_credential_ids.length > 0 && scan.methods.snmp && (
                    <span className="text-micro text-subtle-foreground">
                      Tries {scan.snmp_credential_ids.length} SNMP {scan.snmp_credential_ids.length === 1 ? 'credential' : 'credentials'}
                    </span>
                  )}
                </div>
                <LastRun scan={scan} />
                <div className="flex items-center gap-1.5 lg:justify-end">
                  {canManage && (
                    <Button variant="outline" size="sm" disabled={running || (run.isPending && run.variables?.id === scan.id)} onClick={() => run.mutate(scan)}>
                      {run.isPending && run.variables?.id === scan.id ? <Spinner data-icon="inline-start" /> : <Play data-icon="inline-start" />}
                      {running ? 'Running' : 'Run now'}
                    </Button>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`More for ${scan.name}`} />}>
                      <Ellipsis />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                      <DropdownMenuItem render={<Link to="/network/assets" search={{ site_id: scan.site_id }} />}>
                        <Boxes />
                        View assets
                      </DropdownMenuItem>
                      {canManage && (
                        <>
                          <DropdownMenuItem onClick={() => setEdit(scan.id)}>
                            <Pencil />
                            Edit scan
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onClick={() => setDeleting(scan)}>
                            <Trash />
                            Delete scan
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </article>
            )
          })}
        </div>
      )}
      <ScanEditor scan={editing} open={editorOpen} onOpenChange={(open) => !open && setEdit(undefined)} />
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete “${deleting?.name}”?`}
        description="The scan and its run history are removed. Discovered assets stay."
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </PageContainer>
  )
}
