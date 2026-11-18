import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { ArrowRight, CalendarClock, CircleX, ListChecks, OctagonAlert, RotateCw, ShieldCheck, TriangleExclamationPoint } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DataTable } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, RelativeTime } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { clientsQuery, complianceQuery, patchRunsQuery, policiesQuery, sitesQuery } from '@/lib/api/queries'
import type { ComplianceGroupBy, ComplianceRow, OsFamily } from '@/lib/api/types'
import { formatInZone } from '@/lib/cron'
import { formatNumber, formatRelative } from '@/lib/format'
import { COMPLIANCE_SEVERITIES, compliancePct, complianceTone, formatAge, missingTotal, severitySegments } from '@/lib/patching/compliance'
import { describeWindow, windowOccurrences, PATCHING_DEFAULTS } from '@/lib/patching/policy'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useScope } from '@/lib/scope'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { SimpleSelect } from '@/components/common/simple-select'
import { SEGMENTED } from '@/features/automation/styles'
import { useNow } from '@/features/devices/remote-hooks'
import { AssignmentChip } from '@/features/automation/policies-page'
import { KpiTile, RunProgressBar, RunStatusBadge } from './patching-ui'
import { SEVERITY_BAR, TONE_BG, TONE_TEXT } from './patching-styles'

const GROUP_LABEL: Record<ComplianceGroupBy, string> = { client: 'Client', site: 'Site', os: 'Operating system' }

function ComplianceRing({ pct, size = 76 }: { pct: number | null; size?: number }) {
  const stroke = 7
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const value = pct ?? 0
  const tone = complianceTone(pct)
  return (
    <div className={cn('relative inline-flex shrink-0 items-center justify-center', TONE_TEXT[tone])} style={{ width: size, height: size }} role="img" aria-label={pct === null ? 'No data' : `${pct}% compliant`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} strokeWidth={stroke} className="fill-none stroke-surface-4" />
        {pct !== null && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - value / 100)}
            className="fill-none stroke-current transition-[stroke-dashoffset] duration-700 ease-(--ease-snappy)"
          />
        )}
      </svg>
      <span className="tabular absolute text-[15px] font-semibold text-foreground">{pct === null ? '—' : `${Math.round(pct)}%`}</span>
    </div>
  )
}

function ComplianceBar({ pct }: { pct: number }) {
  const tone = complianceTone(pct)
  return (
    <div className="flex min-w-36 items-center gap-2.5">
      <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
        <span className={cn('absolute inset-y-0 left-0 rounded-full transition-[width] duration-700', TONE_BG[tone])} style={{ width: `${pct}%` }} />
      </span>
      <span className={cn('tabular w-12 text-right font-medium', TONE_TEXT[tone])}>{pct.toFixed(pct % 1 ? 1 : 0)}%</span>
    </div>
  )
}

function SeverityBar({ row }: { row: ComplianceRow }) {
  const segments = severitySegments(row)
  const total = missingTotal(row)
  if (total === 0) return <span className="text-micro text-success">Nothing missing</span>
  return (
    <Tooltip>
      <TooltipTrigger render={<div className="flex min-w-40 items-center gap-2.5" />}>
        <span className="flex h-1.5 flex-1 gap-px overflow-hidden rounded-full bg-surface-3">
          {segments.map((segment) => (
            <span key={segment.severity} className={cn('h-full', SEVERITY_BAR[segment.severity])} style={{ width: `${segment.pct}%`, minWidth: 3 }} />
          ))}
        </span>
        <span className="tabular w-10 text-right text-muted-foreground">{formatNumber(total)}</span>
      </TooltipTrigger>
      <TooltipContent>
        <div className="grid grid-cols-1 gap-1">
          {COMPLIANCE_SEVERITIES.filter((severity) => row.missing_by_severity[severity]).map((severity) => (
            <div key={severity} className="flex items-center gap-2">
              <span className={cn('size-2 rounded-[3px]', SEVERITY_BAR[severity])} />
              <span>{severity === 'Unspecified' ? 'Unrated' : severity}</span>
              <span className="tabular ml-auto pl-4 font-medium">{formatNumber(row.missing_by_severity[severity] ?? 0)}</span>
            </div>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

function UpcomingWindows() {
  const me = useMe()
  const { data: policies, isLoading } = useQuery({ ...policiesQuery, enabled: hasPermission(me, PERMISSIONS.devicesView), meta: { silent: true } })
  const now = useNow(60_000)
  const upcoming = useMemo(() => {
    const items: { key: string; policyId: string; policyName: string; start: Date; end: Date; zone: string; open: boolean; describe: string; assignments: NonNullable<typeof policies>[number]['assignments'] }[] = []
    for (const policy of policies ?? []) {
      const window = policy.document.patching?.window
      if (!window) continue
      const duration = (window.duration_minutes ?? PATCHING_DEFAULTS.window.duration_minutes) * 60_000
      const zone = window.timezone ?? 'UTC'
      for (const start of windowOccurrences(window, 3, new Date(now - duration))) {
        items.push({
          key: `${policy.id}-${start.toISOString()}`,
          policyId: policy.id,
          policyName: policy.name,
          start,
          end: new Date(start.getTime() + duration),
          zone,
          open: start.getTime() <= now,
          describe: describeWindow(window),
          assignments: policy.assignments,
        })
      }
    }
    return items.sort((a, b) => a.start.getTime() - b.start.getTime()).slice(0, 5)
  }, [policies, now])
  return (
    <section className="overflow-hidden rounded-xl bg-card shadow-card">
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <CalendarClock className="size-4 text-subtle-foreground" />
          Next maintenance windows
        </h2>
        <Link to="/automation/policies" className="text-micro text-muted-foreground hover:text-foreground">
          Policies
        </Link>
      </header>
      {isLoading ? (
        <div className="grid gap-2 p-4">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-12 rounded-lg" />
          ))}
        </div>
      ) : upcoming.length === 0 ? (
        <p className="px-4 py-5 text-dense text-muted-foreground">No policy sets a maintenance window, so nothing installs automatically.</p>
      ) : (
        <ol className="divide-y divide-border">
          {upcoming.map((item) => (
            <li key={item.key}>
              <Link
                to="/automation/policies/$policyId"
                params={{ policyId: item.policyId }}
                search={{ tab: 'patching' }}
                className="flex items-start gap-3 px-4 py-3 outline-none hover:bg-surface-2 focus-visible:bg-surface-2"
              >
                <span className={cn('flex w-11 shrink-0 flex-col items-center rounded-lg py-1 ring-1', item.open ? 'bg-live/10 text-live ring-live/25' : 'bg-surface-2 ring-border')}>
                  <span className="text-[10px] font-semibold tracking-wide uppercase">{item.start.toLocaleDateString(undefined, { month: 'short' })}</span>
                  <span className="font-display tabular text-lg leading-tight font-semibold">{item.start.getDate()}</span>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-dense font-medium">{item.policyName}</span>
                    {item.open && (
                      <Badge variant="live">
                        <span className="inline-flex size-1.5 animate-pulse-ring rounded-full bg-live" />
                        Open now
                      </Badge>
                    )}
                  </span>
                  <span className="tabular block truncate text-micro text-muted-foreground">
                    {formatInZone(item.start, item.zone)} → {formatInZone(item.end, item.zone).split(' ').pop()} · {item.open ? `closes ${formatRelative(item.end)}` : formatRelative(item.start)}
                  </span>
                  <span className="mt-1.5 flex flex-wrap gap-1">
                    {item.assignments.slice(0, 2).map((assignment) => (
                      <AssignmentChip key={assignment.id} assignment={assignment} className="h-5" />
                    ))}
                    {item.assignments.length > 2 && <span className="text-micro text-subtle-foreground">+{item.assignments.length - 2}</span>}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function RecentRuns() {
  const { data: runs, isLoading } = useQuery(patchRunsQuery(100))
  const recent = (runs ?? []).slice(0, 5)
  return (
    <section className="overflow-hidden rounded-xl bg-card shadow-card">
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <ListChecks className="size-4 text-subtle-foreground" />
          Recent patch runs
        </h2>
        <Link to="/patching/runs" className="inline-flex items-center gap-1 text-micro text-muted-foreground hover:text-foreground">
          All runs
          <ArrowRight className="size-3" />
        </Link>
      </header>
      {isLoading ? (
        <div className="grid gap-2 p-4">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-12 rounded-lg" />
          ))}
        </div>
      ) : recent.length === 0 ? (
        <p className="px-4 py-5 text-dense text-muted-foreground">No patch runs yet. A run starts each time a policy window opens.</p>
      ) : (
        <ul className="divide-y divide-border">
          {recent.map((run) => (
            <li key={run.id}>
              <Link to="/patching/runs/$runId" params={{ runId: run.id }} className="grid gap-2 px-4 py-3 outline-none hover:bg-surface-2 focus-visible:bg-surface-2">
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-dense font-medium">{run.policy_name}</span>
                  <RunStatusBadge status={run.status} failed={run.failed} />
                </span>
                <RunProgressBar counts={run} />
                <span className="tabular flex flex-wrap gap-x-3 text-micro text-muted-foreground">
                  <span>
                    <RelativeTime value={run.window_start} />
                  </span>
                  <span>{formatNumber(run.total)} devices</span>
                  {run.failed > 0 && <span className="text-critical">{run.failed} failed</span>}
                  {run.pending_reboot > 0 && <span className="text-info">{run.pending_reboot} restart pending</span>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function OverviewPage({ group }: { group: ComplianceGroupBy }) {
  useTitle('Patch compliance')
  const navigate = useNavigate()
  const { clientId, siteId, setClient, setSite } = useScope()
  const { data, isLoading, error, refetch } = useQuery(complianceQuery(group, clientId, siteId))
  const { data: sites = [] } = useQuery({ ...sitesQuery(), enabled: group === 'site' || Boolean(clientId) })
  const { data: clients = [] } = useQuery(clientsQuery())
  const clientSites = sites.filter((site) => site.client_id === clientId)
  const totals = data?.totals
  const pct = totals ? compliancePct(totals) : null

  const drill = (row: ComplianceRow) => {
    if (group === 'client') void navigate({ to: '/patching/updates', search: { client: row.key } as never })
    else if (group === 'site') {
      const site = sites.find((item) => item.id === row.key)
      void navigate({ to: '/patching/updates', search: { client: site?.client_id } as never })
    } else void navigate({ to: '/patching/updates', search: { platform: row.key as OsFamily } as never })
  }

  const columns = useMemo<ColumnDef<ComplianceRow>[]>(
    () => [
      {
        id: 'label',
        accessorFn: (row) => row.label.toLowerCase(),
        header: GROUP_LABEL[group],
        cell: ({ row }) => <span className="block max-w-64 truncate font-medium">{row.original.label}</span>,
      },
      {
        id: 'devices',
        accessorFn: (row) => row.devices,
        header: 'Devices',
        meta: { align: 'right' },
        cell: ({ row }) => (
          <span className="tabular text-muted-foreground">
            <span className="text-foreground">{formatNumber(row.original.compliant)}</span> / {formatNumber(row.original.devices)}
          </span>
        ),
      },
      {
        id: 'compliance',
        accessorFn: (row) => row.compliance_pct,
        header: 'Compliance',
        cell: ({ row }) => <ComplianceBar pct={row.original.compliance_pct} />,
      },
      {
        id: 'missing',
        accessorFn: (row) => missingTotal(row),
        header: 'Missing by severity',
        cell: ({ row }) => <SeverityBar row={row.original} />,
      },
      {
        id: 'oldest',
        accessorFn: (row) => row.oldest_missing_days ?? -1,
        header: 'Oldest missing',
        meta: { align: 'right' },
        cell: ({ row }) => (
          <span className={cn('tabular', (row.original.oldest_missing_days ?? 0) > 30 ? 'font-medium text-critical' : (row.original.oldest_missing_days ?? 0) > 14 ? 'text-warning' : 'text-muted-foreground')}>
            {formatAge(row.original.oldest_missing_days)}
          </span>
        ),
      },
    ],
    [group],
  )

  return (
    <PageContainer className="grid grid-cols-1 gap-5">
      <PageHeader
        title="Patch compliance"
        description="How up to date the fleet is against the updates you approved, and what the next windows will install."
        actions={
          <>
            <SimpleSelect
              size="sm"
              ariaLabel="Client"
              className="w-full sm:w-48"
              value={clientId ?? ''}
              onValueChange={(value) => setClient(value || null)}
              options={[{ value: '', label: 'All clients' }, ...clients.map((client) => ({ value: client.id, label: client.name }))]}
            />
            {clientId && (
              <SimpleSelect
                size="sm"
                ariaLabel="Site"
                className="w-full sm:w-44"
                value={siteId ?? ''}
                onValueChange={(value) => setSite(value || null)}
                options={[{ value: '', label: 'All sites' }, ...clientSites.map((site) => ({ value: site.id, label: site.name }))]}
              />
            )}
            <Button size="sm" variant="outline" render={<Link to="/patching/updates" />} nativeButton={false}>
              <ListChecks data-icon="inline-start" />
              Review updates
            </Button>
          </>
        }
      />

      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isLoading || !totals ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className={cn('h-[124px] rounded-xl', index === 0 && 'col-span-2')} />
          ))}
        </div>
      ) : totals.devices === 0 ? (
        <EmptyState
          illustration="patching"
          title="No device has scanned for updates yet"
          description="Turn patching on in a policy (Automation → Policies → Patching). Devices scan on their next check-in and appear here."
          actions={
            <Button size="sm" render={<Link to="/automation/policies" />} nativeButton={false}>
              Open policies
            </Button>
          }
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
            <KpiTile label="Compliance" value={null} icon={<ShieldCheck />} tone={complianceTone(pct)} to="/patching/updates" search={{ approval: 'approved' }} className="col-span-2" footer="Compliant: no approved update missing for over 7 days and no failed install.">
              <div className="flex items-center gap-4">
                <ComplianceRing pct={pct} />
                <div className="min-w-0">
                  <div className="font-display tabular text-[26px] leading-none font-semibold tracking-tight">
                    {formatNumber(totals.compliant)}
                    <span className="text-[17px] font-medium text-subtle-foreground"> / {formatNumber(totals.devices)}</span>
                  </div>
                  <div className="mt-1 text-micro text-muted-foreground">scanned devices compliant</div>
                  {totals.non_compliant > 0 && <div className="tabular mt-0.5 text-micro text-critical">{formatNumber(totals.non_compliant)} need attention</div>}
                </div>
              </div>
            </KpiTile>
            <KpiTile
              label="Critical missing"
              value={formatNumber(totals.missing_critical)}
              icon={<OctagonAlert />}
              tone={totals.missing_critical ? 'critical' : undefined}
              to="/patching/updates"
              search={{ severity: 'Critical' }}
              footer="Missing installs of Critical updates"
            />
            <KpiTile
              label="Important missing"
              value={formatNumber(totals.missing_important)}
              icon={<TriangleExclamationPoint />}
              tone={totals.missing_important ? 'warning' : undefined}
              to="/patching/updates"
              search={{ severity: 'Important' }}
              footer="Missing installs of Important updates"
            />
            <KpiTile
              label="Restart pending"
              value={formatNumber(totals.pending_reboot)}
              icon={<RotateCw />}
              tone={totals.pending_reboot ? 'info' : undefined}
              to="/patching/updates"
              search={{ status: 'any', health: 'restart' }}
              footer={`${totals.pending_reboot === 1 ? 'Device' : 'Devices'} waiting to restart`}
            />
            <KpiTile
              label="Failed installs"
              value={formatNumber(totals.failed)}
              icon={<CircleX />}
              tone={totals.failed ? 'critical' : undefined}
              to="/patching/updates"
              search={{ health: 'failed' }}
              footer={`${totals.failed === 1 ? 'Device' : 'Devices'} with a failed update still missing`}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
            <section className="grid min-w-0 grid-cols-1 content-start gap-3">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h2 className="text-[15px] font-semibold tracking-tight">Compliance by {GROUP_LABEL[group].toLowerCase()}</h2>
                  <p className="mt-0.5 text-dense text-muted-foreground">Only devices that have scanned count. Select a row to see its updates.</p>
                </div>
                <ToggleGroup
                  value={[group]}
                  onValueChange={(next: string[]) => next[0] && void navigate({ to: '/patching', search: (prev) => ({ ...prev, group: next[0] === 'client' ? undefined : (next[0] as ComplianceGroupBy) }), replace: true })}
                  variant="outline"
                  spacing={0}
                  size="sm"
                  className={SEGMENTED}
                  aria-label="Group by"
                >
                  <ToggleGroupItem value="client" className="px-3">
                    Client
                  </ToggleGroupItem>
                  <ToggleGroupItem value="site" className="px-3">
                    Site
                  </ToggleGroupItem>
                  <ToggleGroupItem value="os" className="px-3">
                    OS
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
              <DataTable
                data={data?.rows ?? []}
                columns={columns}
                getRowId={(row) => row.key}
                onRowClick={drill}
                initialSorting={[{ id: 'compliance', desc: false }]}
                caption={`Compliance by ${GROUP_LABEL[group].toLowerCase()}`}
              />
              <div className="flex flex-wrap gap-x-4 gap-y-1 px-1 text-micro text-muted-foreground">
                {COMPLIANCE_SEVERITIES.map((severity) => (
                  <span key={severity} className="inline-flex items-center gap-1.5">
                    <span className={cn('size-2 rounded-[3px]', SEVERITY_BAR[severity])} />
                    {severity === 'Unspecified' ? 'Unrated' : severity}
                  </span>
                ))}
              </div>
            </section>
            <aside className="grid min-w-0 grid-cols-1 content-start gap-4">
              <UpcomingWindows />
              <RecentRuns />
            </aside>
          </div>
        </>
      )}
    </PageContainer>
  )
}
