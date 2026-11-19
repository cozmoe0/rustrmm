/* Automation panels on the device page: script history, effective policy, groups and custom fields. */
import { useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import {
  ArrowRight,
  Boxes,
  Building,
  CircleCheck,
  CircleSlash,
  Globe,
  Hand,
  MapPin,
  MonitorSmartphone,
  Play,
  ScrollText,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { DataTable } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, RelativeTime } from '@/components/common/misc'
import { SectionTitle } from '@/components/common/page-header'
import { deviceGroupsQuery, deviceScriptRunsQuery, effectivePolicyQuery } from '@/lib/api/queries'
import type { DeviceDetail, DeviceScriptRun, EffectivePolicySource, PolicyTargetType } from '@/lib/api/types'
import { RESULT_STATUS, formatDurationMs } from '@/lib/automation/labels'
import {
  SECTION_LABEL,
  TARGET_TYPE_LABEL,
  effectiveRows,
  sortSources,
  type EffectiveRow,
  type PolicySection,
} from '@/lib/automation/policy'
import { describeCron } from '@/lib/cron'
import { formatNumber } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { cn } from '@/lib/utils'
import { ResultStatusBadge, ResultStatusDot } from './automation-ui'
import { DevicePolicyPatching } from '@/features/patching/device-policy-patching'
import { DevicePolicyMonitoring } from '@/features/monitoring/device-policy-monitoring'
import { CustomFieldsPanel } from './custom-fields-panel'
import { OutputDrawer } from './output-drawer'
import { openRunDialog } from './run-dialog-store'

function PanelCard({
  title,
  icon,
  action,
  children,
  className,
}: {
  title: ReactNode
  icon: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <Card size="sm" className={cn('gap-3', className)}>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-sm [&_svg]:size-4 [&_svg]:text-subtle-foreground">
          {icon}
          {title}
        </CardTitle>
        {action}
      </CardHeader>
      <CardContent className="min-w-0">{children}</CardContent>
    </Card>
  )
}

export function DeviceCustomFieldsCard({ device }: { device: DeviceDetail }) {
  const me = useMe()
  return (
    <PanelCard
      title="Custom fields"
      icon={<SlidersHorizontal />}
      action={
        <Button
          variant="ghost"
          size="xs"
          className="text-muted-foreground"
          render={<Link to="/settings/custom-fields" />}
          nativeButton={false}
        >
          Manage
        </Button>
      }
    >
      <CustomFieldsPanel scope="device" entityId={device.id} canEdit={hasPermission(me, PERMISSIONS.devicesManage)} />
    </PanelCard>
  )
}

export function DeviceGroupsCard({ device }: { device: DeviceDetail }) {
  const { data, isLoading } = useQuery(deviceGroupsQuery(device.id))
  return (
    <PanelCard title="Groups" icon={<Boxes />}>
      {isLoading ? (
        <div className="flex flex-wrap gap-1.5">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-7 w-28 rounded-md" />
          ))}
        </div>
      ) : !data?.length ? (
        <p className="text-dense text-muted-foreground">Not a member of any device group.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {data.map((group) => (
            <Link
              key={group.id}
              to="/automation/groups/$groupId"
              params={{ groupId: group.id }}
              className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-md bg-surface-2 px-2 text-dense ring-1 ring-border transition-colors hover:bg-surface-3"
            >
              {group.kind === 'dynamic' ? (
                <Sparkles className="size-3.5 shrink-0 text-info" />
              ) : (
                <Hand className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">{group.name}</span>
            </Link>
          ))}
        </div>
      )}
    </PanelCard>
  )
}

export function DeviceScriptsTab({ device }: { device: DeviceDetail }) {
  const me = useMe()
  const canView = hasPermission(me, PERMISSIONS.scriptsView)
  const canRun = hasPermission(me, PERMISSIONS.scriptsRun)
  const { data, isLoading, error, refetch } = useQuery({
    ...deviceScriptRunsQuery(device.id),
    enabled: canView,
    refetchInterval: (query) => (query.state.data?.some((run) => !RESULT_STATUS[run.status].done) ? 5000 : false),
  })
  const [open, setOpen] = useState<DeviceScriptRun | null>(null)
  const runs = useMemo(() => data ?? [], [data])
  const succeeded = runs.filter((run) => run.status === 'succeeded').length
  const failed = runs.filter((run) => run.status === 'failed' || run.status === 'timed_out').length

  const columns = useMemo<ColumnDef<DeviceScriptRun>[]>(
    () => [
      {
        id: 'script',
        accessorFn: (run) => run.script_name.toLowerCase(),
        header: 'Script',
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-2.5">
            <ResultStatusDot status={row.original.status} />
            <div className="min-w-0 leading-tight">
              <div className="max-w-64 truncate font-medium">{row.original.script_name}</div>
              <Link
                to="/automation/jobs/$jobId"
                params={{ jobId: row.original.job_id }}
                search={{ run: row.original.run_id }}
                onClick={(event) => event.stopPropagation()}
                className="block max-w-64 truncate text-[10.5px] text-subtle-foreground hover:text-foreground hover:underline"
              >
                {row.original.job_name}
              </Link>
            </div>
          </div>
        ),
      },
      {
        id: 'status',
        accessorKey: 'status',
        header: 'Status',
        cell: ({ row }) => <ResultStatusBadge status={row.original.status} />,
      },
      {
        id: 'exit',
        accessorFn: (run) => run.exit_code ?? -999,
        header: 'Exit',
        meta: { align: 'right' },
        cell: ({ row }) =>
          row.original.exit_code === null ? (
            <span className="text-subtle-foreground">—</span>
          ) : (
            <span
              className={cn(
                'tabular font-mono text-[12px]',
                row.original.exit_code ? 'font-semibold text-critical' : 'text-muted-foreground',
              )}
            >
              {row.original.exit_code}
            </span>
          ),
      },
      {
        id: 'duration',
        accessorFn: (run) => run.duration_ms ?? -1,
        header: 'Duration',
        meta: { align: 'right' },
        cell: ({ row }) => (
          <span className="tabular text-muted-foreground">{formatDurationMs(row.original.duration_ms)}</span>
        ),
      },
      {
        id: 'when',
        accessorFn: (run) => run.started_at ?? '',
        header: 'When',
        cell: ({ row }) => (
          <RelativeTime value={row.original.started_at ?? row.original.finished_at} className="text-muted-foreground" />
        ),
      },
      {
        id: 'output',
        accessorFn: (run) => run.error ?? run.stdout_preview,
        header: 'Output',
        enableSorting: false,
        cell: ({ row }) => {
          const text = row.original.error ?? row.original.stdout_preview.split('\n').find((line) => line.trim()) ?? ''
          return (
            <span
              className={cn(
                'block max-w-[24rem] truncate font-mono text-[11.5px]',
                row.original.error ? 'text-critical/90' : 'text-muted-foreground',
              )}
            >
              {text}
            </span>
          )
        },
      },
    ],
    [],
  )

  if (!canView)
    return (
      <EmptyState
        illustration="automation"
        title="You can’t view scripts"
        description="Ask an administrator for the “View scripts and jobs” permission."
      />
    )

  return (
    <div className="grid grid-cols-1 gap-3">
      <SectionTitle
        description={
          runs.length
            ? `${formatNumber(succeeded)} succeeded and ${formatNumber(failed)} failed across the latest ${formatNumber(runs.length)} runs.`
            : 'Results from jobs that targeted this device.'
        }
        actions={
          canRun && (
            <Button
              size="sm"
              disabled={device.status !== 'active'}
              onClick={() => openRunDialog({ target: { type: 'devices', ids: [device.id] } })}
            >
              <Play data-icon="inline-start" />
              Run script…
            </Button>
          )
        }
      >
        Script runs
      </SectionTitle>
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <DataTable
          data={runs}
          columns={columns}
          loading={isLoading}
          getRowId={(run) => `${run.run_id}:${run.device_id}`}
          onRowClick={setOpen}
          caption="Script runs on this device"
          empty={
            <div className="p-6">
              <EmptyState
                compact
                illustration="automation"
                title="No scripts have run here yet"
                description="Run a script from the library, or schedule one through a policy."
              />
            </div>
          }
        />
      )}
      <OutputDrawer
        runId={open?.run_id ?? null}
        deviceId={open ? device.id : null}
        title={open?.job_name}
        onClose={() => setOpen(null)}
      />
    </div>
  )
}

const TARGET_ICON: Record<PolicyTargetType, typeof Globe> = {
  global: Globe,
  client: Building,
  site: MapPin,
  group: Boxes,
  device: MonitorSmartphone,
}

function SourceChain({ sources }: { sources: EffectivePolicySource[] }) {
  return (
    <ol className="flex flex-wrap items-center gap-1.5">
      {sources.map((source, index) => {
        const Icon = TARGET_ICON[source.target_type]
        return (
          <li key={`${source.policy_id}-${source.target_type}-${index}`} className="flex items-center gap-1.5">
            <Link
              to="/automation/policies/$policyId"
              params={{ policyId: source.policy_id }}
              className="inline-flex h-8 max-w-full items-center gap-2 rounded-lg bg-card px-2.5 text-dense shadow-card transition-colors hover:bg-surface-3"
            >
              <Icon className="size-3.5 shrink-0 text-subtle-foreground" />
              <span className="truncate font-medium">{source.policy_name}</span>
              <span className="truncate text-micro text-subtle-foreground">
                {TARGET_TYPE_LABEL[source.target_type]}
                {source.target_name ? ` · ${source.target_name}` : ''}
                {source.target_type === 'group' ? ` · priority ${source.priority}` : ''}
              </span>
            </Link>
            {index < sources.length - 1 && (
              <ArrowRight className="size-3.5 text-subtle-foreground" aria-hidden="true" />
            )}
          </li>
        )
      })}
    </ol>
  )
}

function OriginChip({ row }: { row: EffectiveRow }) {
  if (!row.origin) return <span className="text-micro text-subtle-foreground">Default</span>
  return (
    <Link
      to="/automation/policies/$policyId"
      params={{ policyId: row.origin.id }}
      className="inline-flex h-6 max-w-full items-center gap-1 rounded-md bg-primary/8 px-2 text-micro font-medium text-primary ring-1 ring-primary/20 hover:bg-primary/12"
    >
      <ScrollText className="size-3 shrink-0" />
      <span className="truncate">{row.origin.name}</span>
    </Link>
  )
}

export function DevicePolicyTab({ device }: { device: DeviceDetail }) {
  const { data, isLoading, error, refetch } = useQuery(effectivePolicyQuery(device.id))
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />
  if (isLoading || !data) {
    return (
      <div className="grid grid-cols-1 gap-3">
        <Skeleton className="h-12 rounded-xl" />
        <Skeleton className="h-80 rounded-xl" />
      </div>
    )
  }
  const sources = sortSources(data.sources)
  const rows = effectiveRows(data)
  const sections: PolicySection[] = ['agent', 'agent_updates', 'remote_access', 'tasks']
  return (
    <div className="grid grid-cols-1 gap-4">
      <SectionTitle description="Policies apply in this order and later layers win: everywhere, the client, the site, groups by priority, then the device itself.">
        Effective policy
      </SectionTitle>
      {sources.length === 0 ? (
        <EmptyState
          compact
          illustration="automation"
          title="No policy applies to this device"
          description="It uses the platform defaults. Assign a policy globally or to its client, site or a group."
        />
      ) : (
        <SourceChain sources={sources} />
      )}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {sections.map((section) => {
          const items = rows.filter((row) => row.section === section)
          return (
            <section
              key={section}
              className={cn('overflow-hidden rounded-xl bg-card shadow-card', section === 'tasks' && 'xl:col-span-2')}
            >
              <h3 className="border-b border-border px-4 py-2.5 text-sm font-semibold">{SECTION_LABEL[section]}</h3>
              {items.length === 0 ? (
                <p className="px-4 py-5 text-dense text-muted-foreground">No scheduled tasks reach this device.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {items.map((row) => (
                    <li
                      key={row.path}
                      className="grid grid-cols-1 gap-x-4 gap-y-1 px-4 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,11rem)] sm:items-center"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-dense font-medium">{row.label}</div>
                        <div
                          className={cn(
                            'truncate text-micro text-subtle-foreground',
                            section === 'tasks' && 'font-mono',
                          )}
                        >
                          {row.description}
                        </div>
                      </div>
                      <div className="text-dense sm:text-right">
                        {row.tone === 'blocked' ? (
                          <Badge variant="critical">
                            <CircleSlash />
                            Blocked
                          </Badge>
                        ) : row.tone === 'allowed' ? (
                          <span className="inline-flex items-center gap-1 text-success">
                            <CircleCheck className="size-3.5" />
                            Allowed
                          </span>
                        ) : section === 'tasks' ? (
                          <span className="tabular" title={row.value}>
                            {row.value === 'Disabled' ? (
                              <Badge variant="outline">Disabled</Badge>
                            ) : (
                              describeCron(row.value)
                            )}
                          </span>
                        ) : (
                          <span className={cn('tabular font-medium', !row.origin && 'text-muted-foreground')}>
                            {row.value}
                          </span>
                        )}
                      </div>
                      <div className="min-w-0 sm:text-right">
                        <OriginChip row={row} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )
        })}
      </div>
      <SectionTitle
        className="mt-2"
        description="Checks and server-side settings this device receives from the same layers. Failing checks open alerts."
      >
        Monitoring
      </SectionTitle>
      <DevicePolicyMonitoring device={device} effective={data} />
      <SectionTitle
        className="mt-2"
        description="Scans, the maintenance window, the ring, approval rules and restarts this device gets from the same layers."
      >
        Patching
      </SectionTitle>
      <DevicePolicyPatching effective={data} />
    </div>
  )
}
