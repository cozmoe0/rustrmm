import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import {
  ArrowUpRight,
  Check,
  Crosshair,
  Ellipsis,
  MapPin,
  Pencil,
  Plus,
  Rocket,
  Satellite,
  SlidersHorizontal,
  Trash,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { Can } from '@/components/common/can'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { DataTable } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { HealthRing } from '@/components/common/health-ring'
import { EntityAvatar, ErrorState, Mono, RelativeTime } from '@/components/common/misc'
import { OsIcon } from '@/components/common/os-icon'
import { StatusDot } from '@/components/common/status-dot'
import { deviceName } from '@/lib/devices'
import { accentFor } from '@/lib/accent'
import { PageContainer } from '@/components/common/page-header'
import { clientsApi, sitesApi } from '@/lib/api/endpoints'
import { isApiError } from '@/lib/api/errors'
import { clientQuery, complianceQuery, devicesQuery, keys, probesQuery } from '@/lib/api/queries'
import type { ClientDetail, Site } from '@/lib/api/types'
import { formatDate, formatNumber } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useScope } from '@/lib/scope'
import { useTitle } from '@/lib/use-title'
import { closeWorkspaceTab, openWorkspaceTab, renameWorkspaceTab } from '@/lib/workspace'
import { cn } from '@/lib/utils'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { CustomFieldsPanel } from '@/features/automation/custom-fields-panel'
import { SiteDialog } from './client-dialogs'
import { ProbeDialog } from '@/features/network/probe-dialog'
import { ProbeBadge } from '@/features/network/network-ui'
import { ClientsContextPanel } from './clients-context'
import { useClientAlertCounts } from '@/features/monitoring/use-alert-counts'
import { ClientContactsTab, ClientTicketsTab } from '@/features/tickets/entity-tickets'
import { useTicketCounts } from '@/features/tickets/use-ticket-counts'
import { ClientLogo } from '@/components/brand/client-logo'
import { LogoUpload } from '@/features/platform/logo-upload'

export interface ClientDetailSearch {
  tab?: 'overview' | 'sites' | 'tickets' | 'contacts' | 'settings'
  new?: boolean
}

const SWATCHES = ['#E07444', '#3FB8A9', '#5B9CF0', '#A47CF3', '#E2B34A', '#E5646E', '#4FB477', '#7C8B9C']

function HeaderStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-24">
      <div className="text-micro text-subtle-foreground">{label}</div>
      <div className="tabular mt-0.5 text-lg font-semibold tracking-tight">{value}</div>
      {hint && <div className="text-micro text-subtle-foreground">{hint}</div>}
    </div>
  )
}

/** Custom field values for one site, edited in a side sheet. */
function SiteFieldsSheet({ site, onClose }: { site: Site | null; onClose: () => void }) {
  const me = useMe()
  return (
    <Sheet open={Boolean(site)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[440px]">
        <SheetHeader className="border-b border-border px-5 pt-5 pb-4">
          <SheetTitle>{site?.name}</SheetTitle>
          <SheetDescription>Site custom fields</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {site && (
            <CustomFieldsPanel scope="site" entityId={site.id} canEdit={hasPermission(me, PERMISSIONS.clientsManage)} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function SitesTab({
  client,
  createRequested,
  onCreateHandled,
}: {
  client: ClientDetail
  createRequested: boolean
  onCreateHandled: () => void
}) {
  const me = useMe()
  const queryClient = useQueryClient()
  const canManage = hasPermission(me, PERMISSIONS.sitesManage)
  const canNetwork = hasPermission(me, PERMISSIONS.networkView)
  const canProbe = hasPermission(me, PERMISSIONS.networkManage)
  const probes = useQuery({ ...probesQuery, enabled: canNetwork, meta: { silent: true } })
  const [probeFor, setProbeFor] = useState<Site | null>(null)
  const [fieldsFor, setFieldsFor] = useState<Site | null>(null)
  const [editing, setEditing] = useState<Site | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deleting, setDeleting] = useState<Site | null>(null)
  // `?new=true` (from quick-create) opens the dialog for a new site without extra state.
  const creatingFromUrl = createRequested && canManage

  function setOpen(open: boolean) {
    setDialogOpen(open)
    if (!open && createRequested) onCreateHandled()
  }

  const remove = useMutation({
    mutationFn: (site: Site) => sitesApi.remove(site.id),
    meta: { successMessage: 'Site deleted' },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.client(client.id) })
      void queryClient.invalidateQueries({ queryKey: keys.clients })
      setDeleting(null)
    },
  })

  const columns = useMemo<ColumnDef<Site>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Site',
        cell: ({ row }) => (
          <div className="flex items-center gap-2.5">
            <span className="flex size-7 items-center justify-center rounded-md bg-surface-3 text-muted-foreground">
              <MapPin className="size-3.5" />
            </span>
            <div className="min-w-0">
              <div className="truncate font-medium">{row.original.name}</div>
              {row.original.address && (
                <div className="truncate text-micro text-subtle-foreground">{row.original.address}</div>
              )}
            </div>
          </div>
        ),
      },
      {
        accessorKey: 'timezone',
        header: 'Time zone',
        cell: ({ getValue }) => <span className="text-muted-foreground">{getValue<string>().replace(/_/g, ' ')}</span>,
      },
      {
        accessorKey: 'device_count',
        header: 'Devices',
        meta: { align: 'right' },
        cell: ({ getValue }) => <span className="tabular">{formatNumber(getValue<number>())}</span>,
      },
      ...(canNetwork
        ? [
            {
              id: 'probe',
              header: 'Network probe',
              accessorFn: (site: Site) => probes.data?.find((probe) => probe.site_id === site.id)?.hostname ?? '',
              cell: ({ row }: { row: { original: Site } }) => <ProbeBadge probe={probes.data?.find((probe) => probe.site_id === row.original.id)} />,
            } satisfies ColumnDef<Site>,
          ]
        : []),
      {
        accessorKey: 'updated_at',
        header: 'Updated',
        cell: ({ getValue }) => <RelativeTime value={getValue<string>()} className="text-muted-foreground" />,
      },
      {
        id: 'actions',
        header: '',
        enableSorting: false,
        meta: { align: 'right', className: 'w-12' },
        cell: ({ row }) => (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Actions for ${row.original.name}`}
                  onClick={(event) => event.stopPropagation()}
                />
              }
            >
              <Ellipsis />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setFieldsFor(row.original)}>
                <SlidersHorizontal />
                Custom fields
              </DropdownMenuItem>
              {canProbe && (
                <DropdownMenuItem onClick={() => setProbeFor(row.original)}>
                  <Satellite />
                  Network probe…
                </DropdownMenuItem>
              )}
              {canManage && (
                <>
                  <DropdownMenuItem
                    onClick={() => {
                      setEditing(row.original)
                      setDialogOpen(true)
                    }}
                  >
                    <Pencil />
                    Edit site
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => setDeleting(row.original)}>
                    <Trash />
                    Delete site
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ],
    [canManage, canNetwork, canProbe, probes.data],
  )

  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between">
        <p className="text-dense text-muted-foreground">
          {client.sites.length} {client.sites.length === 1 ? 'site' : 'sites'} · devices and policies attach to sites
        </p>
        <Can permission={PERMISSIONS.sitesManage}>
          <Button
            size="sm"
            onClick={() => {
              setEditing(null)
              setDialogOpen(true)
            }}
          >
            <Plus data-icon="inline-start" />
            New site
          </Button>
        </Can>
      </div>
      <DataTable
        data={client.sites}
        columns={columns}
        getRowId={(site) => site.id}
        onRowClick={
          canManage
            ? (site) => {
                setEditing(site)
                setDialogOpen(true)
              }
            : undefined
        }
        caption={`Sites of ${client.name}`}
        empty={
          <div className="p-6">
            <EmptyState
              compact
              illustration="network"
              title="No sites yet"
              description="Add the client's first location."
            />
          </div>
        }
      />
      <SiteDialog
        open={dialogOpen || creatingFromUrl}
        onOpenChange={setOpen}
        clientId={client.id}
        site={creatingFromUrl && !dialogOpen ? null : editing}
      />
      <SiteFieldsSheet site={fieldsFor} onClose={() => setFieldsFor(null)} />
      <ProbeDialog site={probeFor ? { id: probeFor.id, name: probeFor.name, client_name: client.name } : null} probe={probes.data?.find((probe) => probe.site_id === probeFor?.id)} open={Boolean(probeFor)} onOpenChange={(open) => !open && setProbeFor(null)} />
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name}?`}
        description="The site is removed permanently. Sites that still have devices cannot be deleted."
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </div>
  )
}

const settingsSchema = z.object({
  name: z.string().trim().min(2, 'Use at least 2 characters').max(80),
  notes: z.string().max(2000),
  accent_color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #E07444')
    .or(z.literal('')),
})

function SettingsTab({ client }: { client: ClientDetail }) {
  const me = useMe()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const canManage = hasPermission(me, PERMISSIONS.clientsManage)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const form = useForm<z.infer<typeof settingsSchema>>({
    resolver: zodResolver(settingsSchema),
    values: { name: client.name, notes: client.notes, accent_color: client.accent_color ?? '' },
  })
  const accent = form.watch('accent_color')

  const save = useMutation({
    mutationFn: (values: z.infer<typeof settingsSchema>) =>
      clientsApi.update(client.id, {
        name: values.name,
        notes: values.notes,
        accent_color: values.accent_color || null,
      }),
    meta: { successMessage: 'Client updated' },
    onSuccess: (updated) => {
      queryClient.setQueryData<ClientDetail>(keys.client(client.id), (prev) => (prev ? { ...prev, ...updated } : prev))
      void queryClient.invalidateQueries({ queryKey: keys.clients })
      renameWorkspaceTab(`client:${client.id}`, updated.name, updated.accent_color)
    },
  })

  const remove = useMutation({
    mutationFn: () => clientsApi.remove(client.id),
    meta: { silent: true },
    onSuccess: () => {
      toast.success(`${client.name} deleted`)
      closeWorkspaceTab(`client:${client.id}`)
      void queryClient.invalidateQueries({ queryKey: keys.clients })
      void navigate({ to: '/clients' })
    },
    onError: (error) => {
      setConfirmDelete(false)
      toast.error(isApiError(error) ? error.message : 'Could not delete the client')
    },
  })

  return (
    <div className="grid max-w-3xl gap-5">
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>Name, notes and the accent colour used across the console and in reports.</CardDescription>
        </CardHeader>
        <CardContent>
          <form id="client-settings" noValidate onSubmit={form.handleSubmit((values) => save.mutate(values))}>
            <fieldset disabled={!canManage}>
              <FieldGroup className="gap-4">
                <Field data-invalid={Boolean(form.formState.errors.name) || undefined}>
                  <FieldLabel htmlFor="settings-name">Name</FieldLabel>
                  <Input id="settings-name" {...form.register('name')} />
                  <FieldError errors={[form.formState.errors.name]} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="settings-notes">Notes</FieldLabel>
                  <Textarea id="settings-notes" rows={4} {...form.register('notes')} />
                </Field>
                <Field data-invalid={Boolean(form.formState.errors.accent_color) || undefined}>
                  <FieldLabel>Accent colour</FieldLabel>
                  <div className="flex flex-wrap items-center gap-2">
                    {SWATCHES.map((swatch) => (
                      <button
                        key={swatch}
                        type="button"
                        aria-label={`Use ${swatch}`}
                        aria-pressed={accent.toLowerCase() === swatch.toLowerCase()}
                        onClick={() =>
                          form.setValue('accent_color', swatch, { shouldDirty: true, shouldValidate: true })
                        }
                        className="flex size-7 items-center justify-center rounded-md ring-1 ring-black/10 transition-transform outline-none hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring"
                        style={{ background: swatch }}
                      >
                        {accent.toLowerCase() === swatch.toLowerCase() && <Check className="size-3.5 text-white" />}
                      </button>
                    ))}
                    <Input
                      aria-label="Custom hex colour"
                      className="h-7 w-28 font-mono text-[12px]"
                      placeholder="#RRGGBB"
                      {...form.register('accent_color')}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => form.setValue('accent_color', '', { shouldDirty: true })}
                    >
                      Automatic
                    </Button>
                  </div>
                  <FieldDescription>
                    Preview:{' '}
                    <span className="inline-flex translate-y-1 items-center gap-2">
                      <EntityAvatar
                        name={form.watch('name') || client.name}
                        seed={client.id}
                        accent={accent || null}
                        size="sm"
                      />
                    </span>
                  </FieldDescription>
                  <FieldError errors={[form.formState.errors.accent_color]} />
                </Field>
              </FieldGroup>
            </fieldset>
          </form>
        </CardContent>
        {canManage && (
          <div className="flex justify-end gap-2 border-t border-border px-4 pt-4">
            <Button variant="ghost" disabled={!form.formState.isDirty} onClick={() => form.reset()}>
              Discard
            </Button>
            <Button type="submit" form="client-settings" disabled={!form.formState.isDirty || save.isPending}>
              {save.isPending && <Spinner data-icon="inline-start" />}
              Save changes
            </Button>
          </div>
        )}
      </Card>

      <ClientLogoCard client={client} canManage={canManage} />

      {canManage && (
        <Card className="ring-1 ring-critical/25">
          <CardHeader>
            <CardTitle className="text-critical">Danger zone</CardTitle>
            <CardDescription>
              Deleting a client removes it and all of its sites. Clients that still have devices cannot be deleted.
              You&apos;ll be asked to re-authenticate.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="destructive-soft" onClick={() => setConfirmDelete(true)}>
              <Trash data-icon="inline-start" />
              Delete client
            </Button>
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${client.name}?`}
        description={`This permanently removes the client and its ${client.sites.length} sites. This cannot be undone.`}
        confirmText={client.name}
        confirmLabel="Delete client"
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  )
}

function ClientLogoCard({ client, canManage }: { client: ClientDetail; canManage: boolean }) {
  const queryClient = useQueryClient()
  const setLogo = useMutation({
    mutationFn: (fileId: string | null) => clientsApi.setLogo(client.id, fileId),
    meta: { silent: true },
    onSuccess: (result, fileId) => {
      toast.success(fileId ? 'Logo updated' : 'Logo removed', { description: fileId ? 'It appears on this client’s report PDFs (PNG) and across the console.' : undefined })
      queryClient.setQueryData<ClientDetail>(keys.client(client.id), (prev) => (prev ? { ...prev, logo_url: result.logo_url } : prev))
      void queryClient.invalidateQueries({ queryKey: keys.clients })
    },
    onError: (failure) => toast.error(isApiError(failure) ? failure.message : 'Could not update the logo'),
  })
  return (
    <Card>
      <CardHeader>
        <CardTitle>Logo</CardTitle>
        <CardDescription>Shown on this client’s report PDFs and next to its name in the console. PDFs embed PNG logos only.</CardDescription>
      </CardHeader>
      <CardContent className="max-w-lg">
        <LogoUpload label="Client logo" url={client.logo_url} disabled={!canManage || setLogo.isPending} onUploaded={(file) => setLogo.mutate(file.id)} onRemove={() => setLogo.mutate(null)} />
      </CardContent>
    </Card>
  )
}

function useClientDevices(clientId: string) {
  const me = useMe()
  return useQuery({ ...devicesQuery({ client_id: clientId }), enabled: hasPermission(me, PERMISSIONS.devicesView) })
}

function averageHealth(devices: { health_score: number | null }[] | undefined) {
  const scores = (devices ?? []).map((device) => device.health_score).filter((score): score is number => score !== null)
  return scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : null
}

function ClientDevices({ client }: { client: ClientDetail }) {
  const { data: devices, isLoading } = useClientDevices(client.id)
  if (isLoading) return <Skeleton className="h-72 rounded-xl" />
  if (!devices || devices.length === 0) {
    return (
      <EmptyState
        illustration="devices"
        title="No devices enrolled yet"
        description="Create a deploy key for one of this client's sites, then install the agent with a script, the MSI or Group Policy."
        actions={
          <Can permission={PERMISSIONS.agentsDeploy}>
            <Button render={<Link to="/devices/deploy" search={{ new: true }} />} nativeButton={false}>
              <Rocket data-icon="inline-start" />
              Deploy agents
            </Button>
          </Can>
        }
      />
    )
  }
  const online = devices.filter((device) => device.online).length
  const attention = [...devices].sort((a, b) => (a.health_score ?? 101) - (b.health_score ?? 101)).slice(0, 6)
  return (
    <Card size="sm" className="gap-0 py-0">
      <CardHeader className="flex flex-row items-center justify-between border-b border-border py-3">
        <div>
          <CardTitle className="text-sm">Devices</CardTitle>
          <CardDescription>
            {online} of {devices.length} online · lowest health first
          </CardDescription>
        </div>
        <Button
          variant="ghost"
          size="xs"
          render={<Link to="/devices" search={{ client: client.id }} />}
          nativeButton={false}
        >
          View all
          <ArrowUpRight data-icon="inline-end" />
        </Button>
      </CardHeader>
      <ul className="divide-y divide-border">
        {attention.map((device) => (
          <li key={device.id}>
            <Link
              to="/devices/$deviceId"
              params={{ deviceId: device.id }}
              className="flex items-center gap-3 px-4 py-2.5 transition-colors outline-none hover:bg-surface-2 focus-visible:bg-surface-2"
            >
              <StatusDot tone={device.online ? 'live' : 'offline'} pulse={device.online} />
              <OsIcon family={device.os_family} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-dense font-medium">{deviceName(device)}</span>
                <span className="block truncate text-micro text-muted-foreground">
                  {device.site_name} · {device.last_user ?? device.os_name}
                </span>
              </span>
              <HealthRing score={device.health_score} size={28} strokeWidth={3} className="[&_span]:text-[9.5px]" />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function OverviewTab({ client, onShowSites }: { client: ClientDetail; onShowSites: () => void }) {
  const me = useMe()
  const [fieldsFor, setFieldsFor] = useState<Site | null>(null)
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
      <ClientDevices client={client} />
      <div className="grid content-start gap-4">
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm">Notes</CardTitle>
          </CardHeader>
          <CardContent>
            <p
              className={cn(
                'text-dense whitespace-pre-wrap',
                client.notes ? 'text-muted-foreground' : 'text-subtle-foreground italic',
              )}
            >
              {client.notes || 'No notes yet.'}
            </p>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-sm">Custom fields</CardTitle>
            <Button
              variant="link"
              size="xs"
              render={<Link to="/settings/custom-fields" search={{ scope: 'client' }} />}
              nativeButton={false}
            >
              Define
            </Button>
          </CardHeader>
          <CardContent>
            <CustomFieldsPanel
              scope="client"
              entityId={client.id}
              canEdit={hasPermission(me, PERMISSIONS.clientsManage)}
            />
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-sm">Sites</CardTitle>
            <Button variant="link" size="xs" onClick={onShowSites}>
              Manage
            </Button>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-1.5">
              {client.sites.map((site) => (
                <li key={site.id}>
                  <button
                    type="button"
                    onClick={() => setFieldsFor(site)}
                    title="Site custom fields"
                    className="group flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left text-dense outline-none hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <MapPin className="size-3.5 text-subtle-foreground" />
                    <span className="flex-1 truncate">{site.name}</span>
                    <SlidersHorizontal className="size-3.5 text-subtle-foreground opacity-0 group-hover:opacity-100" />
                    <span className="tabular text-micro text-subtle-foreground">{site.device_count}</span>
                  </button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
      <SiteFieldsSheet site={fieldsFor} onClose={() => setFieldsFor(null)} />
    </div>
  )
}

export function ClientDetailPage({ clientId, search }: { clientId: string; search: ClientDetailSearch }) {
  const clientAlerts = useClientAlertCounts().get(clientId)
  const clientTickets = useTicketCounts({ client_id: clientId })
  const navigate = useNavigate()
  const { clientId: scopeClient, setClient } = useScope()
  const { data: client, isLoading, error, refetch } = useQuery(clientQuery(clientId))
  const { data: clientDevices } = useClientDevices(clientId)
  const me = useMe()
  const { data: compliance } = useQuery({ ...complianceQuery('site', clientId), enabled: hasPermission(me, PERMISSIONS.patchesView), meta: { silent: true } })
  useTitle(client?.name)
  const tab = search.tab ?? 'overview'

  useEffect(() => {
    if (client) {
      openWorkspaceTab({
        id: `client:${client.id}`,
        kind: 'client',
        title: client.name,
        to: '/clients/$clientId',
        params: { clientId: client.id },
        accent: client.accent_color,
      })
    }
  }, [client])

  const setTab = (next: string) =>
    void navigate({
      to: '/clients/$clientId',
      params: { clientId },
      search: (prev) => ({
        ...prev,
        tab: next === 'overview' ? undefined : (next as ClientDetailSearch['tab']),
        new: undefined,
      }),
      replace: true,
    })

  if (error) {
    return (
      <PageContainer>
        <ErrorState
          error={error}
          title={isApiError(error) && error.status === 404 ? 'Client not found' : 'Could not load this client'}
          onRetry={() => void refetch()}
        />
      </PageContainer>
    )
  }

  return (
    <div className="flex h-full">
      <ClientsContextPanel />
      <div className="min-w-0 flex-1 overflow-y-auto">
        {isLoading || !client ? (
          <PageContainer className="grid gap-4">
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-80 rounded-xl" />
          </PageContainer>
        ) : (
          <Tabs value={tab} onValueChange={(value) => setTab(String(value))} className="gap-0">
            <div
              className="relative border-b border-border"
              style={{
                background: `linear-gradient(180deg, color-mix(in oklch, ${accentFor(client.id, client.accent_color)} 9%, transparent) 0%, transparent 100%)`,
              }}
            >
              <PageContainer className="grid gap-5 pb-0 sm:pb-0">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex items-start gap-4">
                    <ClientLogo client={client} size="lg" className="size-14 rounded-2xl text-base" />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h1 className="font-display truncate text-2xl font-semibold tracking-tight">{client.name}</h1>
                        {scopeClient === client.id && <Badge variant="default">Current scope</Badge>}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-dense text-muted-foreground">
                        <Mono>{client.slug}</Mono>
                        <span>·</span>
                        <span>Client since {formatDate(client.created_at)}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setClient(scopeClient === client.id ? null : client.id)}
                    >
                      <Crosshair data-icon="inline-start" />
                      {scopeClient === client.id ? 'Clear scope' : 'Scope console to client'}
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
                  <HealthRing score={averageHealth(clientDevices)} size={48} />
                  <HeaderStat label="Sites" value={String(client.site_count)} />
                  <HeaderStat label="Devices" value={formatNumber(client.device_count)} />
                  <HeaderStat
                    label="Open alerts"
                    value={formatNumber((clientAlerts?.critical ?? 0) + (clientAlerts?.warning ?? 0))}
                    hint={clientAlerts?.critical ? `${clientAlerts.critical} critical` : undefined}
                  />
                  <HeaderStat
                    label="Open tickets"
                    value={clientTickets.open === undefined ? '—' : formatNumber(clientTickets.open)}
                    hint={clientTickets.counts?.breached ? `${clientTickets.counts.breached} breaching SLA` : undefined}
                  />
                  <HeaderStat
                    label="Patch compliance"
                    value={compliance && compliance.totals.devices > 0 ? `${((compliance.totals.compliant * 100) / compliance.totals.devices).toFixed(1)}%` : '—'}
                    hint={compliance && compliance.totals.devices > 0 ? `${formatNumber(compliance.totals.compliant)} of ${formatNumber(compliance.totals.devices)} scanned` : undefined}
                  />
                </div>
                <TabsList variant="line" className="-mb-px h-10 gap-4">
                  <TabsTrigger value="overview" className="px-0">
                    Overview
                  </TabsTrigger>
                  <TabsTrigger value="sites" className="px-0">
                    Sites <span className="tabular ml-1 text-micro text-subtle-foreground">{client.sites.length}</span>
                  </TabsTrigger>
                  <TabsTrigger value="tickets" className="px-0">
                    Tickets {clientTickets.open ? <span className="tabular ml-1 text-micro text-subtle-foreground">{clientTickets.open}</span> : null}
                  </TabsTrigger>
                  <TabsTrigger value="contacts" className="px-0">
                    Contacts
                  </TabsTrigger>
                  <TabsTrigger value="settings" className="px-0">
                    Settings
                  </TabsTrigger>
                </TabsList>
              </PageContainer>
            </div>
            <PageContainer>
              <TabsContent value="overview">
                <OverviewTab client={client} onShowSites={() => setTab('sites')} />
              </TabsContent>
              <TabsContent value="sites">
                <SitesTab
                  client={client}
                  createRequested={Boolean(search.new)}
                  onCreateHandled={() =>
                    void navigate({
                      from: '/clients/$clientId',
                      to: '/clients/$clientId',
                      params: { clientId },
                      search: (prev) => ({ ...prev, new: undefined }),
                      replace: true,
                    })
                  }
                />
              </TabsContent>
              <TabsContent value="tickets">
                <ClientTicketsTab client={client} />
              </TabsContent>
              <TabsContent value="contacts">
                <ClientContactsTab client={client} />
              </TabsContent>
              <TabsContent value="settings">
                <SettingsTab client={client} />
              </TabsContent>
            </PageContainer>
          </Tabs>
        )}
      </div>
    </div>
  )
}
