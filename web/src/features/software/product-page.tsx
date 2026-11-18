import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { AppWindow, ArrowLeft, Library, Rocket } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { DataTable } from '@/components/common/data-table'
import { ErrorState } from '@/components/common/misc'
import { PageContainer } from '@/components/common/page-header'
import { isApiError } from '@/lib/api/errors'
import { packagesQuery, softwareProductQuery } from '@/lib/api/queries'
import type { SoftwareProduct } from '@/lib/api/types'
import { compareVersions, findPackageFor } from '@/lib/software/detection'
import { formatDate, formatNumber } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { SearchField } from '@/features/devices/remote-ui'
import { MetaItem } from '@/features/automation/automation-ui'
import { openDeployDialog } from './deploy-dialog-store'
import { SourceText } from './software-ui'

type DeviceRow = SoftwareProduct['devices'][number]

export function ProductPage({ name, publisher }: { name: string; publisher: string | null }) {
  useTitle(name)
  const navigate = useNavigate()
  const me = useMe()
  const canDeploy = hasPermission(me, PERMISSIONS.softwareDeploy)
  const { data, isLoading, error, refetch } = useQuery({ ...softwareProductQuery(name, publisher), enabled: Boolean(name) })
  const { data: packages = [] } = useQuery(packagesQuery)
  const [version, setVersion] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const latest = useMemo(() => [...(data?.versions ?? [])].map((item) => item.version).filter(Boolean).sort(compareVersions).at(-1) ?? null, [data])
  const pkg = data ? findPackageFor(packages, { name: data.name }) : undefined
  const outdated = (data?.devices ?? []).filter((device) => latest && device.version !== latest)
  const maxCount = Math.max(1, ...(data?.versions ?? []).map((item) => item.devices))
  const needle = query.trim().toLowerCase()
  const devices = (data?.devices ?? []).filter((device) => (version === null || device.version === version) && (!needle || `${device.hostname} ${device.client_name}`.toLowerCase().includes(needle)))

  const columns = useMemo<ColumnDef<DeviceRow>[]>(
    () => [
      { id: 'hostname', accessorFn: (row) => row.hostname.toLowerCase(), header: 'Device', cell: ({ row }) => <span className="block max-w-60 truncate font-medium">{row.original.hostname}</span> },
      { id: 'client', accessorFn: (row) => row.client_name, header: 'Client', cell: ({ row }) => <span className="block max-w-56 truncate text-muted-foreground">{row.original.client_name}</span> },
      {
        id: 'version',
        accessorFn: (row) => row.version,
        sortingFn: (a, b) => compareVersions(a.original.version, b.original.version),
        header: 'Version',
        cell: ({ row }) => (
          <span className="flex items-center gap-1.5">
            <span className="font-mono text-[11.5px]">{row.original.version || '—'}</span>
            {latest && row.original.version !== latest && <Badge variant="warning">Older</Badge>}
          </span>
        ),
      },
      { id: 'installed', accessorFn: (row) => row.install_date ?? '', header: 'Installed', cell: ({ row }) => <span className="tabular text-muted-foreground">{row.original.install_date ? formatDate(row.original.install_date) : '—'}</span> },
    ],
    [latest],
  )

  if (error)
    return (
      <PageContainer>
        <ErrorState error={error} title={isApiError(error) && error.status === 404 ? 'No device reports this product' : 'Could not load this product'} onRetry={() => void refetch()} />
      </PageContainer>
    )
  if (isLoading || !data)
    return (
      <PageContainer className="grid gap-4">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-80 rounded-xl" />
      </PageContainer>
    )

  return (
    <PageContainer className="grid grid-cols-1 gap-4">
      <header className="grid grid-cols-1 gap-4">
        <Link to="/software" className="inline-flex w-fit items-center gap-1 text-dense text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" />
          Explorer
        </Link>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 items-start gap-3.5">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted-foreground shadow-raised ring-1 ring-border">
              <AppWindow className="size-5" />
            </span>
            <div className="min-w-0">
              <h1 className="font-display truncate text-[22px] leading-tight font-semibold">{data.name}</h1>
              <p className="mt-1 text-dense text-muted-foreground">{data.publisher ?? 'Unknown publisher'}</p>
            </div>
          </div>
          {pkg && (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" render={<Link to="/software/library" search={{ edit: pkg.id } as never} />} nativeButton={false}>
                <Library data-icon="inline-start" />
                In library
              </Button>
              {canDeploy && (
                <Button
                  size="sm"
                  onClick={() => openDeployDialog({ packageId: pkg.id, action: 'install', target: outdated.length ? { type: 'devices', ids: outdated.map((device) => device.device_id) } : undefined })}
                >
                  <Rocket data-icon="inline-start" />
                  Deploy update{outdated.length ? ` to ${outdated.length}` : ''}
                </Button>
              )}
            </div>
          )}
        </div>
      </header>

      <section className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl bg-card p-4 shadow-card sm:grid-cols-4">
        <MetaItem label="Devices">{formatNumber(data.devices.length)}</MetaItem>
        <MetaItem label="Versions in use">{formatNumber(data.versions.length)}</MetaItem>
        <MetaItem label="Newest version">
          <span className="font-mono text-[12px]">{latest ?? '—'}</span>
        </MetaItem>
        <MetaItem label="Library package">{pkg ? <SourceText source={pkg.source} /> : <span className="text-muted-foreground">None</span>}</MetaItem>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <section className="self-start overflow-hidden rounded-xl bg-card shadow-card">
          <h2 className="border-b border-border px-4 py-2.5 text-sm font-semibold">Versions</h2>
          <ul className="grid gap-px p-1.5">
            <li>
              <button type="button" onClick={() => setVersion(null)} aria-pressed={version === null} className={cn('flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-dense hover:bg-surface-3', version === null && 'bg-surface-3 font-medium')}>
                All versions
                <span className="tabular text-micro text-muted-foreground">{formatNumber(data.devices.length)}</span>
              </button>
            </li>
            {data.versions.map((item) => (
              <li key={item.version}>
                <button
                  type="button"
                  onClick={() => setVersion(version === item.version ? null : item.version)}
                  aria-pressed={version === item.version}
                  className={cn('grid w-full gap-1 rounded-md px-2.5 py-2 text-left hover:bg-surface-3', version === item.version && 'bg-surface-3')}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate font-mono text-[12px]">{item.version || 'Unknown'}</span>
                      {item.version === latest && <Badge variant="success">Newest</Badge>}
                    </span>
                    <span className="tabular text-micro text-muted-foreground">{formatNumber(item.devices)}</span>
                  </span>
                  <span className="relative h-1 overflow-hidden rounded-full bg-surface-4">
                    <span className={cn('absolute inset-y-0 left-0 rounded-full', item.version === latest ? 'bg-success' : 'bg-warning/80')} style={{ width: `${(item.devices / maxCount) * 100}%` }} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section className="grid min-w-0 grid-cols-1 content-start gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">{version === null ? 'All devices' : `Devices on ${version}`}</h2>
            <SearchField value={query} onChange={setQuery} placeholder="Search devices…" label="Search devices" className="sm:ml-auto sm:w-60" />
          </div>
          <DataTable
            data={devices}
            columns={columns}
            getRowId={(row) => `${row.device_id}-${row.version}`}
            onRowClick={(row) => void navigate({ to: '/devices/$deviceId', params: { deviceId: row.device_id }, search: { tab: 'software' } })}
            initialSorting={[{ id: 'hostname', desc: false }]}
            virtualHeight={devices.length > 14 ? '520px' : undefined}
            caption="Devices with this product"
            empty={<div className="px-4 py-10 text-center text-dense text-muted-foreground">No devices match.</div>}
          />
        </section>
      </div>
    </PageContainer>
  )
}
