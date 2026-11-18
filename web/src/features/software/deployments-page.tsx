import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { Rocket } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DataTable } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, RelativeTime } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { deploymentsQuery } from '@/lib/api/queries'
import type { DeploymentSummary } from '@/lib/api/types'
import { formatNumber } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { SearchField } from '@/features/devices/remote-ui'
import { FilterPill } from '@/features/patching/patching-ui'
import { openDeployDialog } from './deploy-dialog-store'
import { ActionBadge, DeploymentBar, DeploymentStatusBadge } from './software-ui'

type Filter = 'all' | 'running' | 'scheduled' | 'failed' | 'completed'

const FILTERS: { key: Filter; label: string; match: (item: DeploymentSummary) => boolean }[] = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'running', label: 'Running', match: (item) => item.status === 'running' },
  { key: 'scheduled', label: 'Scheduled', match: (item) => item.status === 'scheduled' },
  { key: 'failed', label: 'With failures', match: (item) => item.failed > 0 },
  { key: 'completed', label: 'Finished', match: (item) => item.status === 'completed' || item.status === 'cancelled' },
]

export function DeploymentsPage() {
  useTitle('Deployments')
  const navigate = useNavigate()
  const me = useMe()
  const { data, isLoading, error, refetch } = useQuery(deploymentsQuery(200))
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const items = useMemo(() => data ?? [], [data])
  const needle = query.trim().toLowerCase()
  const visible = items.filter(FILTERS.find((item) => item.key === filter)!.match).filter((item) => !needle || `${item.package.name} ${item.target_label} ${item.created_by_name}`.toLowerCase().includes(needle))

  const columns = useMemo<ColumnDef<DeploymentSummary>[]>(
    () => [
      {
        id: 'package',
        accessorFn: (item) => item.package.name.toLowerCase(),
        header: 'Package',
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-2">
            <ActionBadge action={row.original.action} />
            <span className="max-w-56 truncate font-medium">{row.original.package.name}</span>
            {row.original.package.id === null && <span className="text-micro text-subtle-foreground">(deleted)</span>}
          </div>
        ),
      },
      { id: 'target', accessorFn: (item) => item.target_label, header: 'Target', cell: ({ row }) => <span className="block max-w-56 truncate text-muted-foreground">{row.original.target_label}</span> },
      { id: 'status', accessorFn: (item) => item.status, header: 'Status', cell: ({ row }) => <DeploymentStatusBadge status={row.original.status} failed={row.original.failed} /> },
      { id: 'progress', accessorFn: (item) => (item.total ? item.succeeded / item.total : 0), header: 'Progress', cell: ({ row }) => <DeploymentBar counts={row.original} className="w-36" /> },
      {
        id: 'counts',
        accessorFn: (item) => item.failed,
        header: 'Results',
        cell: ({ row }) => (
          <span className="tabular flex gap-2 text-micro">
            <span className="text-success">{formatNumber(row.original.succeeded)} ok</span>
            <span className={cn(row.original.failed ? 'font-semibold text-critical' : 'text-subtle-foreground')}>{formatNumber(row.original.failed)} failed</span>
            {row.original.pending > 0 && <span className="text-live">{formatNumber(row.original.pending)} pending</span>}
            {(row.original.skipped ?? 0) > 0 && <span className="text-subtle-foreground">{formatNumber(row.original.skipped ?? 0)} skipped</span>}
          </span>
        ),
      },
      {
        id: 'created',
        accessorFn: (item) => item.created_at,
        header: 'Created',
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            <RelativeTime value={row.original.created_at} /> · {row.original.created_by_name}
          </span>
        ),
      },
    ],
    [],
  )

  return (
    <PageContainer className="grid grid-cols-1 gap-4">
      <PageHeader
        title="Deployments"
        description="Installs and uninstalls of library packages, with per-device results that update live."
        actions={
          hasPermission(me, PERMISSIONS.softwareDeploy) && (
            <Button size="sm" onClick={() => openDeployDialog()}>
              <Rocket data-icon="inline-start" />
              Deploy software
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((item) => (
            <FilterPill key={item.key} active={filter === item.key} onClick={() => setFilter(item.key)} count={items.filter(item.match).length}>
              {item.label}
            </FilterPill>
          ))}
        </div>
        <SearchField value={query} onChange={setQuery} placeholder="Search packages, targets…" label="Search deployments" className="sm:ml-auto sm:w-64" />
      </div>
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : !isLoading && items.length === 0 ? (
        <EmptyState illustration="software" title="No deployments yet" description="Deploy a library package to devices, a group, a site or a whole client." />
      ) : (
        <DataTable
          data={visible}
          columns={columns}
          loading={isLoading}
          getRowId={(item) => item.id}
          onRowClick={(item) => void navigate({ to: '/software/deployments/$deploymentId', params: { deploymentId: item.id } })}
          initialSorting={[{ id: 'created', desc: true }]}
          virtualHeight={visible.length > 14 ? 'min(70vh, 720px)' : undefined}
          caption="Deployments"
          empty={<div className="px-4 py-10 text-center text-dense text-muted-foreground">No deployments match.</div>}
        />
      )}
    </PageContainer>
  )
}
