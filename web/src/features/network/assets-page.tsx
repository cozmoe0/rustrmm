import { useCallback, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { Activity, Boxes, Ellipsis, Eye, EyeOff, MonitorSmartphone, StickyNote, Tag } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Label } from '@/components/ui/label'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DataTable } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, KeyValue, Mono, RelativeTime } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/simple-select'
import { assetsApi } from '@/lib/api/endpoints'
import { networkKeys, assetsQuery } from '@/lib/api/queries'
import type { AssetPatch, AssetType, NetworkAsset } from '@/lib/api/types'
import { formatDateTime, formatNumber } from '@/lib/format'
import { ASSET_TYPE_LABEL, ASSET_TYPES, PORT_NAME, assetName } from '@/lib/network/assets'
import { compareIp } from '@/lib/network/cidr'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { SearchField } from '@/features/devices/remote-ui'
import { SEGMENTED } from '@/features/automation/styles'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { MonitorDialog } from './monitor-dialog'
import { AssetTypeTile, PortChips, SiteSelect } from './network-ui'
import { networkErrorMessage, siteLabel, useScopedSites } from './use-network'

export interface AssetsSearch {
  site_id?: string
  type?: AssetType
  managed?: 'managed' | 'unmanaged'
  q?: string
  ignored?: boolean
  asset?: string
}

function useAssetUpdate() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ asset, patch }: { asset: NetworkAsset; patch: AssetPatch }) => assetsApi.update(asset.id, patch),
    meta: { silent: true },
    onSuccess: (updated) => {
      queryClient.setQueriesData<NetworkAsset[]>({ queryKey: networkKeys.assets }, (list) => list?.map((item) => (item.id === updated.id ? updated : item)))
      void queryClient.invalidateQueries({ queryKey: networkKeys.topology(updated.site_id) })
    },
    onError: (failure) => toast.error(networkErrorMessage(failure)),
  })
}

export function AssetsPage({ search }: { search: AssetsSearch }) {
  useTitle('Discovered assets')
  const me = useMe()
  const navigate = useNavigate({ from: '/network/assets' })
  const canManage = hasPermission(me, PERMISSIONS.networkManage)
  const { sites, byId } = useScopedSites()
  const { data, isLoading, error, refetch } = useQuery(assetsQuery({ site_id: search.site_id }))
  const update = useAssetUpdate()
  const [query, setQuery] = useState(search.q ?? '')
  const [monitoring, setMonitoring] = useState<NetworkAsset | null>(null)
  const setSearch = useCallback((patch: Partial<AssetsSearch>) => void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true }), [navigate])

  const all = useMemo(() => (data ?? []).filter((asset) => byId.has(asset.site_id)), [data, byId])
  const needle = query.trim().toLowerCase()
  const base = all
    .filter((asset) => search.ignored || !asset.ignored)
    .filter((asset) => !search.managed || (search.managed === 'managed') === Boolean(asset.managed_device_id))
    .filter(
      (asset) =>
        !needle ||
        [asset.ip, asset.mac, asset.vendor, asset.hostname, asset.snmp_sys_name, asset.netbios_name, asset.managed_hostname, asset.notes, ...(asset.mdns ?? [])].some((value) => value?.toLowerCase().includes(needle)),
    )
  const visible = base.filter((asset) => !search.type || asset.type_guess === search.type)
  const typeCounts = ASSET_TYPES.map((type) => ({ type, count: base.filter((asset) => asset.type_guess === type).length })).filter((item) => item.count > 0)
  const unmanaged = all.filter((asset) => !asset.ignored && !asset.managed_device_id && !asset.snmp_device_id).length
  const selected = search.asset ? all.find((asset) => asset.id === search.asset) ?? null : null
  const ignoredCount = all.filter((asset) => asset.ignored).length

  const columns = useMemo<ColumnDef<NetworkAsset>[]>(
    () => [
      {
        id: 'name',
        accessorFn: (asset) => assetName(asset).toLowerCase(),
        header: 'Asset',
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-2.5">
            <AssetTypeTile type={row.original.type_guess} />
            <div className="min-w-0 leading-tight">
              <span className={cn('flex max-w-56 items-center gap-1.5 truncate font-medium', row.original.ignored && 'text-muted-foreground line-through decoration-subtle-foreground/60')}>
                <span className="truncate">{assetName(row.original)}</span>
                {row.original.notes && <StickyNote className="size-3 shrink-0 text-subtle-foreground" aria-label="Has notes" />}
              </span>
              <span className="block max-w-56 truncate text-[10.5px] text-subtle-foreground">
                {row.original.vendor ?? 'Unknown vendor'} · {ASSET_TYPE_LABEL[row.original.type_guess]}
                {row.original.type_source === 'manual' && ' (set)'}
              </span>
            </div>
          </div>
        ),
      },
      { id: 'ip', accessorFn: (asset) => asset.ip, header: 'IP', sortingFn: (a, b) => compareIp(a.original.ip, b.original.ip), cell: ({ row }) => <span className="font-mono text-[12px]">{row.original.ip}</span> },
      { id: 'mac', accessorFn: (asset) => asset.mac ?? '', header: 'MAC', cell: ({ row }) => <span className="font-mono text-[11.5px] text-muted-foreground">{row.original.mac ?? '—'}</span> },
      {
        id: 'managed',
        accessorFn: (asset) => (asset.managed_device_id ? 1 : 0),
        header: 'Agent',
        cell: ({ row }) =>
          row.original.managed_device_id ? (
            <Link to="/devices/$deviceId" params={{ deviceId: row.original.managed_device_id }} onClick={(event) => event.stopPropagation()} className="inline-flex max-w-40 items-center gap-1.5 truncate text-dense hover:underline">
              <MonitorSmartphone className="size-3.5 shrink-0 text-live" />
              <span className="truncate">{row.original.managed_hostname ?? 'Managed'}</span>
            </Link>
          ) : row.original.snmp_device_id ? (
            <Link to="/network/snmp/$snmpDeviceId" params={{ snmpDeviceId: row.original.snmp_device_id }} onClick={(event) => event.stopPropagation()} className="inline-flex items-center gap-1.5 text-dense hover:underline">
              <Activity className="size-3.5 shrink-0 text-info" />
              SNMP
            </Link>
          ) : (
            <Badge variant="outline">Unmanaged</Badge>
          ),
      },
      { id: 'ports', accessorFn: (asset) => asset.open_ports.length, header: 'Open ports', cell: ({ row }) => <PortChips ports={row.original.open_ports} /> },
      { id: 'first', accessorFn: (asset) => asset.first_seen_at, header: 'First seen', cell: ({ row }) => <RelativeTime value={row.original.first_seen_at} className="text-muted-foreground" /> },
      { id: 'last', accessorFn: (asset) => asset.last_seen_at, header: 'Last seen', cell: ({ row }) => <RelativeTime value={row.original.last_seen_at} className="text-muted-foreground" /> },
      {
        id: 'actions',
        header: '',
        enableSorting: false,
        meta: { align: 'right', className: 'w-12' },
        cell: ({ row }) =>
          canManage ? (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${assetName(row.original)}`} onClick={(event) => event.stopPropagation()} />}>
                <Ellipsis />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                {row.original.snmp_device_id ? (
                  <DropdownMenuItem render={<Link to="/network/snmp/$snmpDeviceId" params={{ snmpDeviceId: row.original.snmp_device_id }} />}>
                    <Activity />
                    Open SNMP device
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onClick={() => setMonitoring(row.original)}>
                    <Activity />
                    Monitor via SNMP…
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => setSearch({ asset: row.original.id })}>
                  <Tag />
                  Type and notes…
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => update.mutate({ asset: row.original, patch: { ignored: !row.original.ignored } })}>
                  {row.original.ignored ? <Eye /> : <EyeOff />}
                  {row.original.ignored ? 'Stop ignoring' : 'Ignore'}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null,
      },
    ],
    [canManage, setSearch, update],
  )

  return (
    <PageContainer className="grid grid-cols-1 gap-4">
      <PageHeader
        icon={<Boxes />}
        title="Discovered assets"
        description={`Everything the probes found on your networks. ${formatNumber(unmanaged)} unmanaged ${unmanaged === 1 ? 'device' : 'devices'} without an agent or SNMP monitoring.`}
      />
      <div className="flex flex-wrap items-center gap-2">
        <SiteSelect value={search.site_id ?? ''} onChange={(value) => setSearch({ site_id: value || undefined })} sites={sites} />
        <ToggleGroup
          className={SEGMENTED}
          value={[search.managed ?? 'all']}
          onValueChange={(next: string[]) => next[0] && setSearch({ managed: next[0] === 'all' ? undefined : (next[0] as 'managed' | 'unmanaged') })}
          variant="outline"
          spacing={0}
          size="sm"
          aria-label="Agent"
        >
          <ToggleGroupItem value="all" className="px-2.5">
            All
          </ToggleGroupItem>
          <ToggleGroupItem value="managed" className="px-2.5">
            Managed
          </ToggleGroupItem>
          <ToggleGroupItem value="unmanaged" className="px-2.5">
            Unmanaged
          </ToggleGroupItem>
        </ToggleGroup>
        <div className="flex items-center gap-2">
          <Switch id="show-ignored" checked={Boolean(search.ignored)} onCheckedChange={(checked) => setSearch({ ignored: checked || undefined })} />
          <Label htmlFor="show-ignored" className="text-dense font-normal text-muted-foreground">
            Show ignored{ignoredCount ? ` (${ignoredCount})` : ''}
          </Label>
        </div>
        <SearchField
          value={query}
          onChange={(value) => {
            setQuery(value)
            setSearch({ q: value.trim() || undefined })
          }}
          placeholder="IP, MAC, vendor, name…"
          label="Search assets"
          className="sm:ml-auto sm:w-64"
        />
      </div>
      {typeCounts.length > 0 && (
        <div className="flex [scrollbar-width:none] gap-1.5 overflow-x-auto pb-0.5">
          {typeCounts.map(({ type, count }) => (
            <button
              key={type}
              type="button"
              aria-pressed={search.type === type}
              onClick={() => setSearch({ type: search.type === type ? undefined : type })}
              className={cn(
                'inline-flex h-8 shrink-0 items-center gap-2 rounded-lg bg-card pr-2.5 pl-1 text-dense shadow-card ring-1 ring-transparent transition-colors outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring',
                search.type === type && 'ring-primary/40',
              )}
            >
              <AssetTypeTile type={type} size="sm" />
              <span>{ASSET_TYPE_LABEL[type]}</span>
              <span className="tabular text-micro text-subtle-foreground">{count}</span>
            </button>
          ))}
        </div>
      )}
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : !isLoading && all.length === 0 ? (
        <EmptyState
          illustration="network"
          title="Nothing discovered yet"
          description="Assign a probe to a site and run a scan. Printers, switches, cameras and unmanaged computers show up here."
          actions={
            <Button variant="outline" size="sm" render={<Link to="/network/scans" />} nativeButton={false}>
              Go to scans
            </Button>
          }
        />
      ) : (
        <DataTable
          data={visible}
          columns={columns}
          loading={isLoading}
          getRowId={(asset) => asset.id}
          onRowClick={(asset) => setSearch({ asset: asset.id })}
          activeRowId={search.asset}
          initialSorting={[{ id: 'ip', desc: false }]}
          virtualHeight={visible.length > 16 ? 'min(68vh, 720px)' : undefined}
          caption="Discovered assets"
          empty={<div className="px-4 py-10 text-center text-dense text-muted-foreground">No assets match.</div>}
        />
      )}
      <AssetSheet asset={selected} siteName={selected ? siteLabel(byId.get(selected.site_id), selected.site_name) : ''} canManage={canManage} onClose={() => setSearch({ asset: undefined })} onMonitor={setMonitoring} />
      <MonitorDialog asset={monitoring} onClose={() => setMonitoring(null)} />
    </PageContainer>
  )
}

function AssetSheet({ asset, siteName, canManage, onClose, onMonitor }: { asset: NetworkAsset | null; siteName: string; canManage: boolean; onClose: () => void; onMonitor: (asset: NetworkAsset) => void }) {
  return (
    <Sheet open={Boolean(asset)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="gap-0 p-0 shadow-popover data-[side=right]:w-full data-[side=right]:sm:max-w-[520px]">
        {asset && <AssetDetail key={asset.id} asset={asset} siteName={siteName} canManage={canManage} onMonitor={onMonitor} />}
      </SheetContent>
    </Sheet>
  )
}

function AssetDetail({ asset, siteName, canManage, onMonitor }: { asset: NetworkAsset; siteName: string; canManage: boolean; onMonitor: (asset: NetworkAsset) => void }) {
  const update = useAssetUpdate()
  const [notes, setNotes] = useState(asset.notes)
  const dirty = notes !== asset.notes
  return (
    <>
      <SheetHeader className="gap-3 border-b border-border px-5 pt-5 pb-4">
        <div className="flex items-start gap-3 pr-8">
          <AssetTypeTile type={asset.type_guess} size="lg" />
          <div className="min-w-0">
            <SheetTitle className="text-base leading-snug break-words">{assetName(asset)}</SheetTitle>
            <SheetDescription>
              {asset.ip} · {siteName}
            </SheetDescription>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {asset.managed_device_id ? (
            <Button variant="outline" size="sm" render={<Link to="/devices/$deviceId" params={{ deviceId: asset.managed_device_id }} />} nativeButton={false}>
              <MonitorSmartphone data-icon="inline-start" />
              {asset.managed_hostname ?? 'Open device'}
            </Button>
          ) : (
            <Badge variant="outline">No agent</Badge>
          )}
          {asset.snmp_device_id ? (
            <Button variant="outline" size="sm" render={<Link to="/network/snmp/$snmpDeviceId" params={{ snmpDeviceId: asset.snmp_device_id }} />} nativeButton={false}>
              <Activity data-icon="inline-start" />
              SNMP device
            </Button>
          ) : (
            canManage && (
              <Button size="sm" onClick={() => onMonitor(asset)}>
                <Activity data-icon="inline-start" />
                Monitor via SNMP
              </Button>
            )
          )}
          {asset.ignored && <Badge variant="secondary">Ignored</Badge>}
        </div>
      </SheetHeader>
      <div className="grid flex-1 content-start gap-5 overflow-y-auto px-5 py-4">
        <dl>
          <KeyValue label="IP address">
            <Mono>{asset.ip}</Mono>
          </KeyValue>
          <KeyValue label="MAC address">{asset.mac ? <Mono>{asset.mac}</Mono> : '—'}</KeyValue>
          <KeyValue label="Vendor (OUI)">{asset.vendor ?? <span className="text-subtle-foreground">Unknown or randomised MAC</span>}</KeyValue>
          {asset.hostname && <KeyValue label="Host name">{asset.hostname}</KeyValue>}
          {asset.netbios_name && <KeyValue label="NetBIOS">{asset.netbios_name}</KeyValue>}
          {(asset.mdns?.length ?? 0) > 0 && <KeyValue label="mDNS">{asset.mdns!.join(', ')}</KeyValue>}
          {asset.snmp_sys_name && <KeyValue label="sysName">{asset.snmp_sys_name}</KeyValue>}
          {asset.snmp_sys_descr && <KeyValue label="sysDescr"><span className="text-muted-foreground">{asset.snmp_sys_descr}</span></KeyValue>}
          {asset.snmp_sys_object_id && (
            <KeyValue label="sysObjectID">
              <Mono className="break-all">{asset.snmp_sys_object_id}</Mono>
            </KeyValue>
          )}
          {asset.rtt_ms != null && <KeyValue label="Round trip">{asset.rtt_ms} ms</KeyValue>}
          <KeyValue label="First seen">{formatDateTime(asset.first_seen_at)}</KeyValue>
          <KeyValue label="Last seen">
            <RelativeTime value={asset.last_seen_at} />
          </KeyValue>
        </dl>
        <section className="grid gap-2">
          <h3 className="text-sm font-semibold">Open ports</h3>
          {asset.open_ports.length === 0 ? (
            <p className="text-micro text-muted-foreground">None of the probed TCP ports answered.</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {asset.open_ports.map((port) => (
                <li key={port} className="inline-flex items-center gap-1.5 rounded-md bg-surface-2 px-2 py-1 text-dense ring-1 ring-border">
                  <span className="tabular font-mono text-[12px]">{port}</span>
                  {PORT_NAME[port] && <span className="text-micro text-muted-foreground">{PORT_NAME[port]}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
        <Field>
          <FieldLabel htmlFor="asset-type">Type</FieldLabel>
          <SimpleSelect
            id="asset-type"
            disabled={!canManage || update.isPending}
            value={asset.type_source === 'manual' ? asset.type_guess : ''}
            onValueChange={(value) => update.mutate({ asset, patch: { type: (value || null) as AssetType | null } }, { onSuccess: () => toast.success(value ? `Marked as ${ASSET_TYPE_LABEL[value as AssetType].toLowerCase()}` : 'Back to the automatic guess') })}
            options={[{ value: '', label: `Automatic (${asset.type_source === 'manual' ? 'guess' : ASSET_TYPE_LABEL[asset.type_guess]})` }, ...ASSET_TYPES.map((type) => ({ value: type, label: ASSET_TYPE_LABEL[type] }))]}
          />
          <FieldDescription>The guess combines the vendor, SNMP description and open ports. A type you set wins.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="asset-notes">Notes</FieldLabel>
          <Textarea id="asset-notes" rows={3} maxLength={2000} disabled={!canManage} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Location, owner, why it’s here…" />
          {canManage && (
            <div className="flex items-center justify-end gap-2">
              {dirty && (
                <Button variant="ghost" size="xs" onClick={() => setNotes(asset.notes)}>
                  Reset
                </Button>
              )}
              <Button size="xs" variant="outline" disabled={!dirty || update.isPending} onClick={() => update.mutate({ asset, patch: { notes } }, { onSuccess: () => toast.success('Notes saved') })}>
                {update.isPending && <Spinner data-icon="inline-start" />}
                Save notes
              </Button>
            </div>
          )}
        </Field>
        {canManage && (
          <div className="flex items-start justify-between gap-3 rounded-lg bg-surface-2 px-3 py-2.5 ring-1 ring-border">
            <div>
              <p className="text-dense font-medium">Ignore this asset</p>
              <p className="text-micro text-muted-foreground">Hidden from lists and topology; scans keep updating it.</p>
            </div>
            <Tooltip>
              <TooltipTrigger render={<span />}>
                <Switch checked={asset.ignored} aria-label="Ignore this asset" onCheckedChange={(checked) => update.mutate({ asset, patch: { ignored: checked } })} />
              </TooltipTrigger>
              <TooltipContent>{asset.ignored ? 'Ignored' : 'Shown'}</TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>
    </>
  )
}
