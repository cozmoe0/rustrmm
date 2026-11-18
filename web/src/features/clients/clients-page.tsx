import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { ArrowUpRight, LayoutGrid, LayoutList, MapPin, Plus, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Can } from '@/components/common/can'
import { DataTable } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { HealthRing } from '@/components/common/health-ring'
import { EntityAvatar, ErrorState, KeyValue, Mono, RelativeTime } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { InspectorDrawer } from '@/components/shell/inspector'
import { clientQuery, clientsQuery } from '@/lib/api/queries'
import type { Client } from '@/lib/api/types'
import { formatDate, formatNumber } from '@/lib/format'
import { PERMISSIONS } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { CreateClientDialog } from './client-dialogs'
import { ClientsContextPanel } from './clients-context'
import { useClientAlertCounts } from '@/features/monitoring/use-alert-counts'

export interface ClientsSearch {
  q?: string
  view?: 'cards' | 'table'
  new?: boolean
}

function ClientCard({ client, onPeek }: { client: Client; onPeek: (client: Client) => void }) {
  const alerts = useClientAlertCounts().get(client.id)
  const alertTotal = (alerts?.critical ?? 0) + (alerts?.warning ?? 0)
  return (
    <Link
      to="/clients/$clientId"
      params={{ clientId: client.id }}
      onKeyDown={(event) => {
        if (event.key === ' ') {
          event.preventDefault()
          onPeek(client)
        }
      }}
      className="group relative flex flex-col gap-4 overflow-hidden rounded-xl bg-card p-4 shadow-card outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-[2px] opacity-70"
        style={{ background: client.accent_color ?? 'transparent' }}
      />
      <div className="flex items-start gap-3">
        <EntityAvatar name={client.name} seed={client.id} accent={client.accent_color} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold tracking-tight">{client.name}</div>
          <div className="mt-0.5 font-mono text-[11px] text-subtle-foreground">{client.slug}</div>
        </div>
        <HealthRing score={null} size={40} strokeWidth={3.5} />
      </div>
      <dl className="grid grid-cols-3 gap-2 rounded-lg bg-surface-2/70 p-2.5 text-center">
        <div>
          <dd className="tabular text-sm font-semibold">{client.site_count}</dd>
          <dt className="text-micro text-subtle-foreground">Sites</dt>
        </div>
        <div>
          <dd className="tabular text-sm font-semibold">{formatNumber(client.device_count)}</dd>
          <dt className="text-micro text-subtle-foreground">Devices</dt>
        </div>
        <div>
          <dd className={cn('tabular text-sm font-semibold', alerts?.critical ? 'text-critical' : alertTotal ? 'text-warning' : undefined)}>
            {formatNumber(alertTotal)}
          </dd>
          <dt className="text-micro text-subtle-foreground">Alerts</dt>
        </div>
      </dl>
      <div className="flex items-center justify-between text-micro text-subtle-foreground">
        <span>Updated <RelativeTime value={client.updated_at} /></span>
        <ArrowUpRight className="size-3.5 opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
    </Link>
  )
}

function ClientPeek({ client, onClose }: { client: Client | null; onClose: () => void }) {
  const { data } = useQuery({ ...clientQuery(client?.id ?? ''), enabled: Boolean(client) })
  return (
    <InspectorDrawer
      open={Boolean(client)}
      onOpenChange={(open) => !open && onClose()}
      title={client?.name ?? ''}
      description={client ? `${client.site_count} sites · ${formatNumber(client.device_count)} devices` : undefined}
      icon={client && <EntityAvatar name={client.name} seed={client.id} accent={client.accent_color} size="lg" />}
      actions={
        client && (
          <Button
            size="sm"
            render={<Link to="/clients/$clientId" params={{ clientId: client.id }} />}
            nativeButton={false}
          >
            Open client
            <ArrowUpRight data-icon="inline-end" />
          </Button>
        )
      }
    >
      {client && (
        <div className="grid gap-5">
          <dl>
            <KeyValue label="Slug">
              <Mono>{client.slug}</Mono>
            </KeyValue>
            <KeyValue label="Created">{formatDate(client.created_at)}</KeyValue>
            <KeyValue label="Last updated">
              <RelativeTime value={client.updated_at} />
            </KeyValue>
          </dl>
          {client.notes && (
            <div>
              <h3 className="eyebrow mb-1.5">Notes</h3>
              <p className="text-dense whitespace-pre-wrap text-muted-foreground">{client.notes}</p>
            </div>
          )}
          <div>
            <h3 className="eyebrow mb-2">Sites</h3>
            <ul className="grid gap-1.5">
              {(data?.sites ?? []).map((site) => (
                <li key={site.id} className="flex items-center gap-2.5 rounded-lg bg-surface-2 px-3 py-2 text-dense">
                  <MapPin className="size-3.5 text-subtle-foreground" />
                  <span className="flex-1 truncate">{site.name}</span>
                  <span className="tabular text-micro text-subtle-foreground">{site.device_count} devices</span>
                </li>
              ))}
              {!data &&
                Array.from({ length: client.site_count || 1 }, (_, index) => <Skeleton key={index} className="h-9" />)}
            </ul>
          </div>
        </div>
      )}
    </InspectorDrawer>
  )
}

export function ClientsPage({ search }: { search: ClientsSearch }) {
  useTitle('Clients')
  const navigate = useNavigate()
  const [peek, setPeek] = useState<Client | null>(null)
  const query = search.q ?? ''
  const view = search.view ?? 'cards'
  const { data: clients, isLoading, error, refetch } = useQuery(clientsQuery())

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!clients) return []
    if (!needle) return clients
    return clients.filter((client) => `${client.name} ${client.slug} ${client.notes}`.toLowerCase().includes(needle))
  }, [clients, query])

  const setSearch = (patch: Partial<ClientsSearch>) =>
    void navigate({ to: '/clients', search: (prev) => ({ ...prev, ...patch }), replace: true })

  const columns = useMemo<ColumnDef<Client>[]>(
    () => [
      {
        id: 'name',
        accessorKey: 'name',
        header: 'Client',
        cell: ({ row }) => (
          <div className="flex items-center gap-2.5">
            <EntityAvatar name={row.original.name} seed={row.original.id} accent={row.original.accent_color} size="sm" />
            <div className="min-w-0">
              <div className="truncate font-medium">{row.original.name}</div>
              <div className="font-mono text-[10.5px] text-subtle-foreground">{row.original.slug}</div>
            </div>
          </div>
        ),
      },
      {
        accessorKey: 'site_count',
        header: 'Sites',
        meta: { align: 'right' },
        cell: ({ getValue }) => <span className="tabular">{getValue<number>()}</span>,
      },
      {
        accessorKey: 'device_count',
        header: 'Devices',
        meta: { align: 'right' },
        cell: ({ getValue }) => <span className="tabular">{formatNumber(getValue<number>())}</span>,
      },
      {
        id: 'health',
        header: 'Health',
        enableSorting: false,
        meta: { align: 'center' },
        cell: () => <HealthRing score={null} size={28} strokeWidth={3} className="mx-auto" />,
      },
      {
        accessorKey: 'updated_at',
        header: 'Updated',
        cell: ({ getValue }) => <RelativeTime value={getValue<string>()} className="text-muted-foreground" />,
      },
    ],
    [],
  )

  return (
    <div className="flex h-full">
      <ClientsContextPanel />
      <div className="min-w-0 flex-1 overflow-y-auto">
        <PageContainer className="grid gap-5">
          <PageHeader
            title="Clients"
            description="Every company you manage, with their sites. Press Space on a client for a quick look."
            actions={
              <Can permission={PERMISSIONS.clientsManage}>
                <Button onClick={() => setSearch({ new: true })}>
                  <Plus data-icon="inline-start" />
                  New client
                </Button>
              </Can>
            }
          />

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full max-w-sm">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-subtle-foreground" />
              <Input
                data-filter-input
                value={query}
                onChange={(event) => setSearch({ q: event.target.value || undefined })}
                placeholder="Filter clients…"
                aria-label="Filter clients"
                className="pl-8"
              />
            </div>
            <span className="tabular text-dense text-muted-foreground">
              {filtered.length} of {clients?.length ?? 0}
            </span>
            <ToggleGroup
              className="ml-auto"
              value={[view]}
              onValueChange={(value: string[]) => value[0] && setSearch({ view: value[0] as ClientsSearch['view'] })}
              aria-label="Layout"
            >
              <ToggleGroupItem value="cards" aria-label="Card view" size="sm">
                <LayoutGrid />
              </ToggleGroupItem>
              <ToggleGroupItem value="table" aria-label="Table view" size="sm">
                <LayoutList />
              </ToggleGroupItem>
            </ToggleGroup>
          </div>

          {error ? (
            <ErrorState error={error} onRetry={() => void refetch()} />
          ) : view === 'table' ? (
            <DataTable
              data={filtered}
              columns={columns}
              loading={isLoading}
              getRowId={(client) => client.id}
              onRowClick={(client) => void navigate({ to: '/clients/$clientId', params: { clientId: client.id } })}
              onRowPeek={setPeek}
              caption="Clients"
              empty={
                <div className="p-6">
                  <EmptyState compact illustration="search" title="No clients match" description="Try a different filter." />
                </div>
              }
            />
          ) : isLoading ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {Array.from({ length: 8 }, (_, index) => (
                <Skeleton key={index} className="h-[188px] rounded-xl" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            clients && clients.length > 0 ? (
              <EmptyState illustration="search" title="No clients match" description={`Nothing matches “${query}”.`} />
            ) : (
              <EmptyState
                illustration="clients"
                title="Add your first client"
                description="Clients are the companies you support. Each has sites, devices, policies and reports."
                actions={
                  <Can permission={PERMISSIONS.clientsManage}>
                    <Button onClick={() => setSearch({ new: true })}>
                      <Plus data-icon="inline-start" />
                      New client
                    </Button>
                  </Can>
                }
              />
            )
          ) : (
            <div className={cn('grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4')}>
              {filtered.map((client) => (
                <ClientCard key={client.id} client={client} onPeek={setPeek} />
              ))}
            </div>
          )}
        </PageContainer>
      </div>

      <ClientPeek client={peek} onClose={() => setPeek(null)} />
      <CreateClientDialog
        open={Boolean(search.new)}
        onOpenChange={(open) => !open && setSearch({ new: undefined })}
        onCreated={(client) => void navigate({ to: '/clients/$clientId', params: { clientId: client.id } })}
      />
    </div>
  )
}
