import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { Layers, Library, Rocket } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DataTable } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/simple-select'
import { packagesQuery, softwareQuery } from '@/lib/api/queries'
import type { SoftwareProductSummary } from '@/lib/api/types'
import { findPackageFor } from '@/lib/software/detection'
import { formatNumber } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useScope } from '@/lib/scope'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { SearchField } from '@/features/devices/remote-ui'
import { openDeployDialog } from './deploy-dialog-store'

export interface ExplorerSearch {
  q?: string
  publisher?: string
  client?: string
  site?: string
}

export function ExplorerPage({ search }: { search: ExplorerSearch }) {
  useTitle('Software explorer')
  const navigate = useNavigate()
  const me = useMe()
  const canDeploy = hasPermission(me, PERMISSIONS.softwareDeploy)
  const { clientId } = useScope()
  const { data, isLoading, error, refetch } = useQuery(softwareQuery({ client_id: clientId }))
  const { data: packages = [] } = useQuery(packagesQuery)
  const all = useMemo(() => data ?? [], [data])
  const needle = search.q?.trim().toLowerCase()
  const filtered = all.filter(
    (item) => (!needle || `${item.name} ${item.publisher ?? ''}`.toLowerCase().includes(needle)) && (!search.publisher || (item.publisher ?? '') === search.publisher),
  )
  const publishers = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of all) if (item.publisher) counts.set(item.publisher, (counts.get(item.publisher) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [all])
  const max = Math.max(1, ...all.map((item) => item.devices))
  const setSearch = (patch: Partial<ExplorerSearch>) => void navigate({ to: '/software', search: (prev) => ({ ...prev, ...patch }), replace: true })
  const open = (item: SoftwareProductSummary) => void navigate({ to: '/software/product', search: { name: item.name, publisher: item.publisher ?? undefined } as never })

  const columns = useMemo<ColumnDef<SoftwareProductSummary>[]>(
    () => [
      {
        id: 'name',
        accessorFn: (item) => item.name.toLowerCase(),
        header: 'Product',
        cell: ({ row }) => (
          <div className="min-w-0 leading-tight">
            <div className="max-w-80 truncate font-medium">{row.original.name}</div>
            <div className="max-w-80 truncate text-[10.5px] text-subtle-foreground">{row.original.publisher ?? 'Unknown publisher'}</div>
          </div>
        ),
      },
      {
        id: 'devices',
        accessorFn: (item) => item.devices,
        header: 'Devices',
        cell: ({ row }) => (
          <div className="flex min-w-36 items-center gap-2.5">
            <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
              <span className="absolute inset-y-0 left-0 rounded-full bg-primary/70" style={{ width: `${(row.original.devices / max) * 100}%` }} />
            </span>
            <span className="tabular w-8 text-right">{formatNumber(row.original.devices)}</span>
          </div>
        ),
      },
      {
        id: 'versions',
        accessorFn: (item) => item.versions,
        header: 'Versions',
        meta: { align: 'right' },
        cell: ({ row }) => (
          <span className={cn('tabular inline-flex items-center gap-1', row.original.versions > 2 ? 'font-medium text-warning' : 'text-muted-foreground')} title={row.original.versions > 2 ? 'Several versions in use' : undefined}>
            {row.original.versions > 1 && <Layers className="size-3" />}
            {formatNumber(row.original.versions)}
          </span>
        ),
      },
      {
        id: 'latest',
        accessorFn: (item) => item.latest_version ?? '',
        header: 'Latest seen',
        cell: ({ row }) => <span className="font-mono text-[11.5px] text-muted-foreground">{row.original.latest_version ?? '—'}</span>,
      },
      {
        id: 'library',
        accessorFn: (item) => (findPackageFor(packages, item) ? 0 : 1),
        header: 'Library',
        cell: ({ row }) => {
          const pkg = findPackageFor(packages, row.original)
          if (!pkg) return <span className="text-subtle-foreground">—</span>
          return (
            <span className="flex items-center gap-1.5">
              <Badge variant="secondary">
                <Library />
                {pkg.name}
              </Badge>
              {canDeploy && (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={(event) => {
                    event.stopPropagation()
                    openDeployDialog({ packageId: pkg.id })
                  }}
                >
                  <Rocket data-icon="inline-start" />
                  Deploy
                </Button>
              )}
            </span>
          )
        },
      },
    ],
    [packages, max, canDeploy],
  )

  return (
    <PageContainer className="flex min-h-full flex-col gap-4 lg:h-full lg:min-h-[640px]">
      <PageHeader title="Software explorer" description="Every application your agents report, grouped by product and publisher across the fleet." />
      <div className="flex flex-wrap items-center gap-2">
        <SearchField value={search.q ?? ''} onChange={(value) => setSearch({ q: value || undefined })} placeholder="Search products or publishers…" label="Search software" className="sm:w-80" />
        <SimpleSelect
          value={search.publisher ?? '__all'}
          onValueChange={(value) => setSearch({ publisher: value === '__all' ? undefined : value })}
          size="sm"
          className="w-full sm:w-60"
          ariaLabel="Publisher"
          options={[{ value: '__all', label: 'Every publisher' }, ...publishers.slice(0, 60).map(([name, count]) => ({ value: name, label: `${name} (${count})` }))]}
        />
        <span className="tabular text-dense text-muted-foreground sm:ml-auto">
          {formatNumber(filtered.length)} of {formatNumber(all.length)} products
        </span>
      </div>
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : !isLoading && all.length === 0 ? (
        <EmptyState illustration="software" title="No software reported yet" description="Agents send their software inventory shortly after they connect." />
      ) : (
        <div className="h-[560px] min-h-0 lg:h-auto lg:flex-1">
          <DataTable
            data={filtered}
            columns={columns}
            loading={isLoading}
            getRowId={(item) => `${item.name}|${item.publisher ?? ''}`}
            onRowClick={open}
            initialSorting={[{ id: 'devices', desc: true }]}
            virtualHeight="100%"
            caption="Software products"
            empty={<div className="px-4 py-10 text-center text-dense text-muted-foreground">No products match.</div>}
          />
        </div>
      )}
    </PageContainer>
  )
}
