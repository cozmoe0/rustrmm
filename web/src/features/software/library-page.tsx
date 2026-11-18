import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { Ellipsis, Pencil, Plus, Rocket, Trash, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { DataTable } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, RelativeTime } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { softwareApi } from '@/lib/api/endpoints'
import { errorMessage, isApiError } from '@/lib/api/errors'
import { keys, packagesQuery } from '@/lib/api/queries'
import type { SoftwarePackage } from '@/lib/api/types'
import { describeDetection } from '@/lib/software/detection'
import { DETECTION_LABEL, SOURCE_META, canUninstall } from '@/lib/software/labels'
import { formatNumber } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { SearchField } from '@/features/devices/remote-ui'
import { PlatformIcons } from '@/features/automation/automation-ui'
import { openDeployDialog } from './deploy-dialog-store'
import { PackageEditor } from './package-editor'
import { SourceText, SourceTile } from './software-ui'

export function LibraryPage({ edit }: { edit?: string }) {
  useTitle('Software library')
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const me = useMe()
  const canManage = hasPermission(me, PERMISSIONS.softwareLibrary)
  const canDeploy = hasPermission(me, PERMISSIONS.softwareDeploy)
  const { data, isLoading, error, refetch } = useQuery(packagesQuery)
  const [query, setQuery] = useState('')
  const [deleting, setDeleting] = useState<SoftwarePackage | null>(null)
  const packages = useMemo(() => data ?? [], [data])
  const needle = query.trim().toLowerCase()
  const visible = packages.filter((pkg) => !needle || `${pkg.name} ${pkg.publisher} ${pkg.source.type} ${pkg.source.type === 'file' ? pkg.source.file_name : pkg.source.id}`.toLowerCase().includes(needle))
  const editing = edit === 'new' ? null : packages.find((pkg) => pkg.id === edit)
  const setEdit = (value: string | undefined) => void navigate({ to: '/software/library', search: (prev) => ({ ...prev, edit: value }), replace: true })

  const remove = useMutation({
    mutationFn: (pkg: SoftwarePackage) => softwareApi.removePackage(pkg.id),
    meta: { silent: true },
    onSuccess: (_result, pkg) => {
      setDeleting(null)
      void queryClient.invalidateQueries({ queryKey: keys.packages })
      toast.success(`Deleted “${pkg.name}”`, { description: 'Past deployments keep their history.' })
    },
    onError: (failure) => {
      setDeleting(null)
      toast.error(isApiError(failure) && failure.code === 'package_in_use' ? failure.message : errorMessage(failure))
    },
  })

  const columns = useMemo<ColumnDef<SoftwarePackage>[]>(
    () => [
      {
        id: 'name',
        accessorFn: (pkg) => pkg.name.toLowerCase(),
        header: 'Package',
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-2.5">
            <SourceTile type={row.original.source.type} />
            <div className="min-w-0 leading-tight">
              <div className="max-w-64 truncate font-medium">{row.original.name}</div>
              <div className="max-w-64 truncate text-[10.5px] text-subtle-foreground">{row.original.publisher || '—'}</div>
            </div>
          </div>
        ),
      },
      {
        id: 'source',
        accessorFn: (pkg) => SOURCE_META[pkg.source.type].label,
        header: 'Source',
        cell: ({ row }) => (
          <span className="flex max-w-64 min-w-0">
            <SourceText source={row.original.source} />
          </span>
        ),
      },
      { id: 'platforms', accessorFn: (pkg) => pkg.platforms.join(','), header: 'Platforms', cell: ({ row }) => <PlatformIcons platforms={row.original.platforms} className="text-muted-foreground" /> },
      {
        id: 'detection',
        accessorFn: (pkg) => pkg.detection.type,
        header: 'Detection',
        cell: ({ row }) => (
          <span className="block max-w-64 truncate text-muted-foreground" title={describeDetection(row.original.detection)}>
            <span className="text-foreground">{DETECTION_LABEL[row.original.detection.type]}</span>
            {row.original.detection.type !== 'none' && <span className="font-mono text-[11px]"> · {describeDetection(row.original.detection).replace(/^Software named /, '')}</span>}
          </span>
        ),
      },
      {
        id: 'installed',
        accessorFn: (pkg) => pkg.installed_on,
        header: 'Installed on',
        meta: { align: 'right' },
        cell: ({ row }) => <span className="tabular">{formatNumber(row.original.installed_on)}</span>,
      },
      { id: 'updated', accessorFn: (pkg) => pkg.updated_at, header: 'Updated', cell: ({ row }) => <RelativeTime value={row.original.updated_at} className="text-muted-foreground" /> },
      {
        id: 'actions',
        enableSorting: false,
        header: () => <span className="sr-only">Actions</span>,
        meta: { align: 'right' },
        cell: ({ row }) => (
          <span className="flex justify-end gap-1" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
            {canDeploy && (
              <Button size="xs" variant="outline" onClick={() => openDeployDialog({ packageId: row.original.id })}>
                <Rocket data-icon="inline-start" />
                Deploy
              </Button>
            )}
            {(canManage || canDeploy) && (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" aria-label={`More actions for ${row.original.name}`} />}>
                  <Ellipsis />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  {canDeploy && canUninstall(row.original.source) && (
                    <DropdownMenuItem onClick={() => openDeployDialog({ packageId: row.original.id, action: 'uninstall' })}>
                      <Trash2 />
                      Uninstall from devices…
                    </DropdownMenuItem>
                  )}
                  {canManage && (
                    <>
                      <DropdownMenuItem onClick={() => setEdit(row.original.id)}>
                        <Pencil />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onClick={() => setDeleting(row.original)}>
                        <Trash />
                        Delete…
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </span>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canDeploy, canManage],
  )

  return (
    <PageContainer className="grid grid-cols-1 gap-4">
      <PageHeader
        title="Software library"
        description="Packages you can install and remove across the fleet: package-manager IDs or installers you upload, each with a detection rule."
        actions={
          canManage && (
            <Button size="sm" onClick={() => setEdit('new')}>
              <Plus data-icon="inline-start" />
              New package
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <SearchField value={query} onChange={setQuery} placeholder="Search packages…" label="Search packages" className="sm:w-72" />
        <span className="tabular text-dense text-muted-foreground sm:ml-auto">{formatNumber(packages.length)} packages</span>
      </div>
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : !isLoading && packages.length === 0 ? (
        <EmptyState
          illustration="software"
          title="The library is empty"
          description="Add a winget, Chocolatey, Homebrew or Linux package by ID, or upload an MSI, EXE, PKG, DEB or RPM installer."
          actions={
            canManage && (
              <Button size="sm" onClick={() => setEdit('new')}>
                <Plus data-icon="inline-start" />
                New package
              </Button>
            )
          }
        />
      ) : (
        <DataTable
          data={visible}
          columns={columns}
          loading={isLoading}
          getRowId={(pkg) => pkg.id}
          onRowClick={canManage ? (pkg) => setEdit(pkg.id) : undefined}
          initialSorting={[{ id: 'name', desc: false }]}
          caption="Library packages"
          empty={<div className="px-4 py-10 text-center text-dense text-muted-foreground">No packages match “{query}”.</div>}
        />
      )}
      {canManage && (edit === 'new' || editing) && <PackageEditor key={edit} pkg={editing ?? null} open onOpenChange={(open) => !open && setEdit(undefined)} />}
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete “${deleting?.name}”?`}
        description="The package leaves the library. Past deployments keep their history; a scheduled or running deployment blocks the delete."
        confirmLabel="Delete package"
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </PageContainer>
  )
}
