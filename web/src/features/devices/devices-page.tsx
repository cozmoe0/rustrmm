import { useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import {
  ArrowUpRight,
  Bookmark,
  Columns3,
  Download,
  FileCode,
  Inbox,
  ListFilter,
  MapPin,
  RefreshCw,
  Rocket,
  Search,
  Tag,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Can } from '@/components/common/can'
import { DataTable } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { HealthRing } from '@/components/common/health-ring'
import { ErrorState, KeyValue, Mono, RelativeTime } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { InspectorDrawer } from '@/components/shell/inspector'
import { saveBlob } from '@/lib/api/client'
import { customFieldsQuery, devicesQuery, fleetQuery } from '@/lib/api/queries'
import type { Device, OsFamily } from '@/lib/api/types'
import {
  DEVICE_COLUMNS,
  DEVICE_CSV_COLUMNS,
  DEVICE_TYPE_LABEL,
  HEALTH_BAND_LABEL,
  OS_LABEL,
  PATCH_STATE_LABEL,
  columnVisibilityStore,
  deviceName,
  facetCounts,
  facetsFromSearch,
  filterDevices,
  hasActiveFacets,
  osShortName,
  saveView,
  searchFromFacets,
  toCsv,
  toggleFacet,
  useColumnVisibility,
  type DeviceColumnId,
  type DeviceFacets,
  type DeviceListSearch,
  type HealthBand,
} from '@/lib/devices'
import { formatDuration, formatNumber } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useScope } from '@/lib/scope'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { BulkTagDialog, MoveSiteDialog } from './device-dialogs'
import { useRefreshInventory } from './use-refresh-inventory'
import { deviceStatusLabel } from './device-status'
import { DeviceStatusDot, DeviceTypeIcon, OsIcon, ResourceMeters, TagList, UsageBar } from './device-ui'
import { DeviceFacetSections, DevicesContextPanel } from './devices-context'
import { formatFieldValue } from '@/lib/automation/fields'
import { openRunDialog } from '@/features/automation/run-dialog-store'

// ------------------------------------------------------------------ fleet composition strip

function Segment({
  value,
  total,
  active,
  className,
  label,
  onClick,
}: {
  value: number
  total: number
  active: boolean
  className: string
  label: string
  onClick: () => void
}) {
  if (value === 0) return null
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-pressed={active}
            aria-label={`${label}: ${value}`}
            onClick={onClick}
            className={cn(
              'h-full min-w-1.5 outline-none transition-[opacity,filter] first:rounded-l-full last:rounded-r-full hover:brightness-110 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card',
              className,
            )}
            style={{ flexGrow: value, flexBasis: 0 }}
          />
        }
      />
      <TooltipContent>
        {label} · {formatNumber(value)} ({Math.round((value / Math.max(1, total)) * 100)}%)
      </TooltipContent>
    </Tooltip>
  )
}

function StripCell({ title, value, children, legend }: { title: string; value: ReactNode; children: ReactNode; legend: ReactNode }) {
  return (
    <div className="grid min-w-0 content-start gap-2.5 px-4 py-3.5 first:pl-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="eyebrow">{title}</span>
        <span className="font-display tabular text-lg leading-none font-semibold tracking-tight">{value}</span>
      </div>
      <div className="flex h-2 gap-[3px]">{children}</div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-micro text-muted-foreground">{legend}</div>
    </div>
  )
}

function LegendItem({ className, label, value, active }: { className: string; label: string; value: number; active?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5', active && 'font-medium text-foreground')}>
      <span className={cn('size-2 rounded-[3px]', className)} aria-hidden="true" />
      {label}
      <span className="tabular text-subtle-foreground">{formatNumber(value)}</span>
    </span>
  )
}

const OS_SEGMENT: Record<OsFamily, string> = { windows: 'bg-chart-3', macos: 'bg-foreground/55', linux: 'bg-chart-5' }
const HEALTH_SEGMENT: Record<HealthBand, string> = { good: 'bg-live', fair: 'bg-warning', poor: 'bg-critical', unknown: 'bg-surface-4' }

function FleetStrip({ devices, facets, onChange }: { devices: Device[]; facets: DeviceFacets; onChange: (facets: DeviceFacets) => void }) {
  const counts = facetCounts(devices)
  const total = devices.length
  const scored = devices.filter((device) => device.health_score !== null)
  const average = scored.length ? Math.round(scored.reduce((sum, device) => sum + (device.health_score ?? 0), 0) / scored.length) : null
  const dim = (active: boolean, anyActive: boolean) => (anyActive && !active ? 'opacity-35' : '')

  return (
    <section aria-label="Fleet composition" className="grid divide-y divide-border overflow-hidden rounded-xl bg-card shadow-card md:grid-cols-3 md:divide-x md:divide-y-0">
      <StripCell
        title="Connectivity"
        value={
          <span>
            {total ? Math.round((counts.state.online / total) * 100) : 0}
            <span className="text-sm text-muted-foreground">% online</span>
          </span>
        }
        legend={
          <>
            <LegendItem className="bg-live" label="Online" value={counts.state.online} active={facets.state === 'online'} />
            <LegendItem className="bg-subtle-foreground/50" label="Offline" value={counts.state.offline} active={facets.state === 'offline'} />
          </>
        }
      >
        {(['online', 'offline'] as const).map((state) => (
          <Segment
            key={state}
            value={counts.state[state]}
            total={total}
            label={state === 'online' ? 'Online' : 'Offline'}
            active={facets.state === state}
            className={cn(state === 'online' ? 'bg-live' : 'bg-subtle-foreground/45', dim(facets.state === state, Boolean(facets.state)))}
            onClick={() => onChange({ ...facets, state: facets.state === state ? undefined : state })}
          />
        ))}
      </StripCell>
      <StripCell
        title="Platforms"
        value={formatNumber(total)}
        legend={(['windows', 'macos', 'linux'] as const).map((os) => (
          <LegendItem key={os} className={OS_SEGMENT[os]} label={OS_LABEL[os]} value={counts.os[os]} active={facets.os?.includes(os)} />
        ))}
      >
        {(['windows', 'macos', 'linux'] as const).map((os) => (
          <Segment
            key={os}
            value={counts.os[os]}
            total={total}
            label={OS_LABEL[os]}
            active={Boolean(facets.os?.includes(os))}
            className={cn(OS_SEGMENT[os], dim(Boolean(facets.os?.includes(os)), Boolean(facets.os?.length)))}
            onClick={() => onChange({ ...facets, os: toggleFacet(facets.os, os) })}
          />
        ))}
      </StripCell>
      <StripCell
        title="Health"
        value={
          <span>
            {average ?? '—'}
            <span className="text-sm text-muted-foreground"> avg</span>
          </span>
        }
        legend={(['good', 'fair', 'poor'] as const).map((band) => (
          <LegendItem
            key={band}
            className={HEALTH_SEGMENT[band]}
            label={band === 'good' ? 'Healthy' : band === 'fair' ? 'Fair' : 'Poor'}
            value={counts.health[band]}
            active={facets.health?.includes(band)}
          />
        ))}
      >
        {(['good', 'fair', 'poor', 'unknown'] as const).map((band) => (
          <Segment
            key={band}
            value={counts.health[band]}
            total={total}
            label={HEALTH_BAND_LABEL[band]}
            active={Boolean(facets.health?.includes(band))}
            className={cn(HEALTH_SEGMENT[band], dim(Boolean(facets.health?.includes(band)), Boolean(facets.health?.length)))}
            onClick={() => onChange({ ...facets, health: toggleFacet(facets.health, band) })}
          />
        ))}
      </StripCell>
    </section>
  )
}

// ------------------------------------------------------------------ active filter chips

function FilterChips({ facets, onChange }: { facets: DeviceFacets; onChange: (facets: DeviceFacets) => void }) {
  const chips: { key: string; label: ReactNode; clear: () => void }[] = []
  if (facets.state) chips.push({ key: 'state', label: facets.state === 'online' ? 'Online' : 'Offline', clear: () => onChange({ ...facets, state: undefined }) })
  for (const os of facets.os ?? [])
    chips.push({ key: `os-${os}`, label: <><OsIcon family={os} className="size-3" />{OS_LABEL[os]}</>, clear: () => onChange({ ...facets, os: toggleFacet(facets.os, os) }) })
  for (const type of facets.types ?? [])
    chips.push({ key: `type-${type}`, label: type === 'unknown' ? 'Unknown type' : DEVICE_TYPE_LABEL[type], clear: () => onChange({ ...facets, types: toggleFacet(facets.types, type) }) })
  for (const band of facets.health ?? [])
    chips.push({ key: `health-${band}`, label: HEALTH_BAND_LABEL[band], clear: () => onChange({ ...facets, health: toggleFacet(facets.health, band) }) })
  if (facets.tag) chips.push({ key: 'tag', label: <span className="font-mono">#{facets.tag}</span>, clear: () => onChange({ ...facets, tag: undefined }) })
  if (facets.patch) chips.push({ key: 'patch', label: <>Patches: {PATCH_STATE_LABEL[facets.patch]}</>, clear: () => onChange({ ...facets, patch: undefined }) })
  if (chips.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map((chip) => (
        <span key={chip.key} className="inline-flex h-6 items-center gap-1.5 rounded-full bg-primary/10 pr-0.5 pl-2.5 text-micro font-medium text-foreground ring-1 ring-primary/25">
          {chip.label}
          <button
            type="button"
            aria-label="Remove filter"
            onClick={chip.clear}
            className="flex size-5 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-primary/15 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <Button variant="ghost" size="xs" onClick={() => onChange({ q: facets.q })}>
        Clear all
      </Button>
    </div>
  )
}

// ------------------------------------------------------------------ quick look

function DevicePeek({ device, onClose }: { device: Device | null; onClose: () => void }) {
  return (
    <InspectorDrawer
      open={Boolean(device)}
      onOpenChange={(open) => !open && onClose()}
      title={device ? deviceName(device) : ''}
      description={device ? `${device.client_name} · ${device.site_name}` : undefined}
      icon={
        device && (
          <span className="flex size-11 items-center justify-center rounded-xl bg-surface-2 shadow-raised ring-1 ring-border">
            <OsIcon family={device.os_family} className="size-5" />
          </span>
        )
      }
      actions={
        device && (
          <Button size="sm" render={<Link to="/devices/$deviceId" params={{ deviceId: device.id }} />} nativeButton={false}>
            Open device
            <ArrowUpRight data-icon="inline-end" />
          </Button>
        )
      }
    >
      {device && (
        <div className="grid gap-5">
          <div className="flex items-center gap-4 rounded-xl bg-surface-2/70 p-3">
            <HealthRing score={device.health_score} size={48} />
            <div className="grid flex-1 gap-2">
              {(
                [
                  ['CPU', device.cpu_pct],
                  ['Memory', device.mem_pct],
                  ['Disk', device.disk_pct],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="grid grid-cols-[56px_1fr_40px] items-center gap-2 text-micro">
                  <span className="text-muted-foreground">{label}</span>
                  <UsageBar value={value} height="h-1.5" />
                  <span className="tabular text-right font-medium">{value == null ? '—' : `${Math.round(value)}%`}</span>
                </div>
              ))}
            </div>
          </div>
          <dl>
            <KeyValue label="Status">
              <span className="inline-flex items-center gap-2">
                <DeviceStatusDot device={device} className="size-auto" />
                {deviceStatusLabel(device)}
              </span>
            </KeyValue>
            <KeyValue label="Hostname">
              <Mono>{device.hostname}</Mono>
            </KeyValue>
            <KeyValue label="Operating system">{device.os_name}</KeyValue>
            <KeyValue label="Hardware">{[device.manufacturer, device.model].filter(Boolean).join(' ') || '—'}</KeyValue>
            <KeyValue label="Last user">{device.last_user ?? '—'}</KeyValue>
            <KeyValue label="IP address">{device.last_ip ? <Mono>{device.last_ip}</Mono> : '—'}</KeyValue>
            <KeyValue label="Uptime">{device.uptime_s ? formatDuration(device.uptime_s) : '—'}</KeyValue>
            <KeyValue label="Last seen">
              {device.online ? <span className="text-live">Connected now</span> : <RelativeTime value={device.last_seen_at} />}
            </KeyValue>
            <KeyValue label="Agent">
              <Mono>{device.agent_version}</Mono>
            </KeyValue>
          </dl>
          {device.tags.length > 0 && (
            <div>
              <h3 className="eyebrow mb-2">Tags</h3>
              <TagList tags={device.tags} max={20} className="flex-wrap" />
            </div>
          )}
        </div>
      )}
    </InspectorDrawer>
  )
}

// ------------------------------------------------------------------ helpers

function compareVersions(a: string, b: string) {
  const pa = a.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0)
  const pb = b.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(pa.length, pb.length); index += 1) {
    const diff = (pa[index] ?? 0) - (pb[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function SaveViewButton({ facets }: { facets: DeviceFacets }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setName('')
      }}
    >
      <PopoverTrigger render={<Button variant="ghost" size="sm" />}>
        <Bookmark data-icon="inline-start" />
        Save view
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            const view = saveView(name, searchFromFacets(facets))
            toast.success(`Saved view “${view.name}”`)
            setOpen(false)
          }}
        >
          <label htmlFor="view-name" className="text-dense font-medium">
            Name this view
          </label>
          <Input id="view-name" autoFocus value={name} maxLength={60} placeholder="Offline servers" onChange={(event) => setName(event.target.value)} />
          <p className="text-micro text-muted-foreground">Saved in this browser. It appears under Saved views in the side panel.</p>
          <Button type="submit" size="sm" disabled={!name.trim()}>
            Save view
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  )
}

// ------------------------------------------------------------------ page

export function DevicesPage({ search }: { search: DeviceListSearch }) {
  useTitle('Devices')
  const navigate = useNavigate()
  const me = useMe()
  const { clientId, siteId } = useScope()
  const facets = useMemo(() => facetsFromSearch(search), [search])
  const patchState = hasPermission(me, PERMISSIONS.patchesView) ? facets.patch : undefined
  const { data: devices, isLoading, error, refetch } = useQuery(devicesQuery({ client_id: clientId, site_id: siteId, patch_state: patchState }))
  const { data: summary } = useQuery(fleetQuery(clientId, siteId))
  const { data: deviceFields = [] } = useQuery({ ...customFieldsQuery('device'), meta: { silent: true } })
  const visibility = useColumnVisibility()
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [peek, setPeek] = useState<Device | null>(null)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [bulkDialog, setBulkDialog] = useState<'tag' | 'move' | null>(null)
  const refreshInventory = useRefreshInventory()

  const all = useMemo(() => devices ?? [], [devices])
  const filtered = useMemo(() => filterDevices(all, facets), [all, facets])
  const latestAgent = useMemo(() => all.map((device) => device.agent_version).sort(compareVersions).at(-1), [all])
  const canManage = hasPermission(me, PERMISSIONS.devicesManage)
  const canApprove = hasPermission(me, PERMISSIONS.agentsApprove)
  const canRunScripts = hasPermission(me, PERMISSIONS.scriptsRun)
  const pending = summary?.pending_approval ?? 0

  // Only visible devices count as selected; ids hidden by filters are simply ignored.
  const selectedDevices = useMemo(() => filtered.filter((device) => selected.has(device.id)), [filtered, selected])

  const setFacets = (next: DeviceFacets) =>
    void navigate({
      to: '/devices',
      search: (prev) => ({ client: prev.client, site: prev.site, ...searchFromFacets(next) }),
      replace: true,
    })

  const toggleRow = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  function exportCsv(rows: Device[]) {
    const csv = String.fromCharCode(0xfeff) + toCsv(rows, DEVICE_CSV_COLUMNS)
    saveBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `rustrmm-devices-${new Date().toISOString().slice(0, 10)}.csv`)
    toast.success(`Exported ${rows.length} ${rows.length === 1 ? 'device' : 'devices'}`)
  }

  const columns = useMemo<ColumnDef<Device>[]>(() => {
    const allSelected = filtered.length > 0 && filtered.every((device) => selected.has(device.id))
    const someSelected = !allSelected && filtered.some((device) => selected.has(device.id))
    const defs: (ColumnDef<Device> & { id: string })[] = [
      {
        id: 'select',
        enableSorting: false,
        size: 40,
        meta: { className: 'w-10 pr-0', headerClassName: 'w-10 pr-0' },
        header: () => (
          <Checkbox
            aria-label={allSelected ? 'Clear selection' : 'Select all visible devices'}
            checked={allSelected}
            indeterminate={someSelected}
            onCheckedChange={() => setSelected(allSelected ? new Set() : new Set(filtered.map((device) => device.id)))}
          />
        ),
        cell: ({ row }) => (
          // Stop the row click from opening the device when toggling selection.
          <span className="flex" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
            <Checkbox
              aria-label={`Select ${deviceName(row.original)}`}
              checked={selected.has(row.original.id)}
              onCheckedChange={() => toggleRow(row.original.id)}
            />
          </span>
        ),
      },
      {
        id: 'device',
        accessorFn: (device) => deviceName(device).toLowerCase(),
        header: 'Device',
        cell: ({ row }) => {
          const device = row.original
          return (
            <div className="flex min-w-0 items-center gap-2.5">
              <DeviceStatusDot device={device} />
              <div className="min-w-0 leading-tight">
                <div className="max-w-60 truncate font-medium">{deviceName(device)}</div>
                <div className="flex max-w-60 items-center gap-1 truncate text-[10.5px] text-subtle-foreground">
                  {device.display_name ? (
                    <span className="font-mono">{device.hostname}</span>
                  ) : (
                    <>
                      <DeviceTypeIcon type={device.device_type} className="size-3" />
                      <span className="truncate">{device.model ?? (device.device_type ? DEVICE_TYPE_LABEL[device.device_type] : '—')}</span>
                    </>
                  )}
                </div>
              </div>
            </div>
          )
        },
      },
      {
        id: 'site',
        accessorFn: (device) => `${device.client_name} ${device.site_name}`.toLowerCase(),
        header: 'Client / site',
        cell: ({ row }) => (
          <div className="min-w-0 leading-tight">
            <div className="max-w-48 truncate">{row.original.client_name}</div>
            <div className="max-w-48 truncate text-[10.5px] text-subtle-foreground">{row.original.site_name}</div>
          </div>
        ),
      },
      {
        id: 'os',
        accessorFn: (device) => device.os_name,
        header: 'OS',
        cell: ({ row }) => (
          <span className="inline-flex max-w-52 items-center gap-1.5 truncate" title={`${row.original.os_name} (${row.original.os_version})`}>
            <OsIcon family={row.original.os_family} />
            <span className="truncate">{osShortName(row.original)}</span>
          </span>
        ),
      },
      {
        id: 'user',
        accessorFn: (device) => device.last_user ?? '',
        header: 'Last user',
        cell: ({ row }) =>
          row.original.last_user ? (
            <span className="block max-w-40 truncate text-muted-foreground">{row.original.last_user}</span>
          ) : (
            <span className="text-subtle-foreground">—</span>
          ),
      },
      {
        id: 'ip',
        accessorFn: (device) => device.last_ip ?? '',
        header: 'IP address',
        cell: ({ row }) =>
          row.original.last_ip ? (
            <span className="font-mono text-[11.5px] text-muted-foreground">{row.original.last_ip}</span>
          ) : (
            <span className="text-subtle-foreground">—</span>
          ),
      },
      {
        id: 'resources',
        accessorFn: (device) => Math.max(device.cpu_pct ?? -1, device.mem_pct ?? -1, device.disk_pct ?? -1),
        header: 'CPU · RAM · Disk',
        cell: ({ row }) => <ResourceMeters device={row.original} />,
      },
      {
        id: 'health',
        accessorFn: (device) => device.health_score ?? -1,
        header: 'Health',
        meta: { align: 'center' },
        cell: ({ row }) => <HealthRing score={row.original.health_score} size={26} strokeWidth={3} className="mx-auto [&_span]:text-[9.5px]" />,
      },
      {
        id: 'last_seen',
        accessorFn: (device) => (device.online ? Number.MAX_SAFE_INTEGER : new Date(device.last_seen_at ?? 0).getTime()),
        header: 'Last seen',
        cell: ({ row }) =>
          row.original.online ? (
            <span className="text-live">Now</span>
          ) : (
            <RelativeTime value={row.original.last_seen_at} className="text-muted-foreground" />
          ),
      },
      {
        id: 'agent',
        accessorFn: (device) => device.agent_version,
        sortingFn: (a, b) => compareVersions(a.original.agent_version, b.original.agent_version),
        header: 'Agent',
        cell: ({ row }) => {
          const outdated = latestAgent !== undefined && compareVersions(row.original.agent_version, latestAgent) < 0
          return (
            <span className={cn('font-mono text-[11.5px]', outdated ? 'text-warning' : 'text-muted-foreground')} title={outdated ? `Update available (${latestAgent})` : undefined}>
              {row.original.agent_version}
            </span>
          )
        },
      },
      {
        id: 'tags',
        accessorFn: (device) => device.tags.join(' '),
        header: 'Tags',
        enableSorting: false,
        cell: ({ row }) => <TagList tags={row.original.tags} max={2} />,
      },
      {
        id: 'type',
        accessorFn: (device) => device.device_type ?? '',
        header: 'Type',
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <DeviceTypeIcon type={row.original.device_type} />
            {row.original.device_type ? DEVICE_TYPE_LABEL[row.original.device_type] : '—'}
          </span>
        ),
      },
      {
        id: 'model',
        accessorFn: (device) => `${device.manufacturer ?? ''} ${device.model ?? ''}`.trim(),
        header: 'Model',
        cell: ({ getValue }) => <span className="block max-w-56 truncate text-muted-foreground">{getValue<string>() || '—'}</span>,
      },
    ]
    // Custom field columns are opt-in from the column chooser.
    const custom: ColumnDef<Device>[] = deviceFields
      .filter((field) => visibility[`cf:${field.key}`] === true)
      .map((field) => ({
        id: `cf:${field.key}`,
        accessorFn: (device: Device) => device.custom_fields?.[field.key] ?? null,
        header: field.name,
        sortUndefined: 'last',
        cell: ({ row }: { row: { original: Device } }) => {
          const value = row.original.custom_fields?.[field.key]
          return value === null || value === undefined ? (
            <span className="text-subtle-foreground">—</span>
          ) : (
            <span className={cn('block max-w-48 truncate', field.type === 'number' && 'tabular', field.key.includes('tag') && 'font-mono text-[11.5px]')}>{formatFieldValue(field, value)}</span>
          )
        },
      }))
    return [...defs.filter((column) => column.id === 'select' || column.id === 'device' || visibility[column.id] !== false), ...custom]
  }, [filtered, selected, visibility, latestAgent, deviceFields])

  const active = hasActiveFacets(facets)

  return (
    <div className="flex h-full">
      <DevicesContextPanel />
      <div className="relative min-w-0 flex-1">
        <div className="h-full overflow-y-auto">
        <PageContainer className="flex min-h-full flex-col gap-4 lg:h-full lg:min-h-[680px]">
          <PageHeader
            title="Devices"
            description="Every enrolled endpoint across your clients. Press Space on a row for a quick look; Enter opens the device."
            actions={
              <>
                <Button variant="outline" size="sm" onClick={() => exportCsv(filtered)} disabled={filtered.length === 0}>
                  <Download data-icon="inline-start" />
                  Export CSV
                </Button>
                <Can permission={PERMISSIONS.agentsDeploy}>
                  <Button size="sm" render={<Link to="/devices/deploy" />} nativeButton={false}>
                    <Rocket data-icon="inline-start" />
                    Deploy agents
                  </Button>
                </Can>
              </>
            }
          />

          {pending > 0 && canApprove && (
            <div className="flex flex-wrap items-center gap-3 rounded-xl bg-info/[0.07] px-4 py-3 ring-1 ring-info/25">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-info/15 text-info">
                <Inbox className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-dense font-medium">
                  {pending} {pending === 1 ? 'device is' : 'devices are'} waiting for approval
                </p>
                <p className="text-micro text-muted-foreground">
                  They enrolled with a deploy key that requires approval and won&apos;t receive commands until you approve them.
                </p>
              </div>
              <Button size="sm" variant="outline" render={<Link to="/devices/deploy" search={{ section: 'approvals' }} />} nativeButton={false}>
                Review
                <ArrowUpRight data-icon="inline-end" />
              </Button>
            </div>
          )}

          {all.length > 0 && <FleetStrip devices={all} facets={facets} onChange={setFacets} />}

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-80">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-subtle-foreground" />
              <Input
                data-filter-input
                value={facets.q ?? ''}
                onChange={(event) => setFacets({ ...facets, q: event.target.value || undefined })}
                placeholder="Search hostname, user, IP, serial, tag…"
                aria-label="Search devices"
                className="pl-8"
              />
            </div>
            <Button variant="outline" size="sm" className="md:hidden" onClick={() => setFiltersOpen(true)}>
              <ListFilter data-icon="inline-start" />
              Filters
              {active && <Badge className="ml-0.5 h-4 px-1">on</Badge>}
            </Button>
            <span className="tabular text-dense text-muted-foreground">
              {formatNumber(filtered.length)} of {formatNumber(all.length)}
            </span>
            {active && <SaveViewButton facets={facets} />}
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className="ml-auto" />}>
                <Columns3 data-icon="inline-start" />
                Columns
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Visible columns</DropdownMenuLabel>
                  {DEVICE_COLUMNS.map((column) => (
                    <DropdownMenuCheckboxItem
                      key={column.id}
                      checked={visibility[column.id] !== false}
                      onCheckedChange={(checked) =>
                        columnVisibilityStore.set((prev) => ({ ...prev, [column.id as DeviceColumnId]: Boolean(checked) }))
                      }
                    >
                      {column.label}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuGroup>
                {deviceFields.length > 0 && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>Custom fields</DropdownMenuLabel>
                      {deviceFields.map((field) => (
                        <DropdownMenuCheckboxItem
                          key={field.id}
                          checked={visibility[`cf:${field.key}`] === true}
                          onCheckedChange={(checked) => columnVisibilityStore.set((prev) => ({ ...prev, [`cf:${field.key}`]: Boolean(checked) }))}
                        >
                          {field.name}
                        </DropdownMenuCheckboxItem>
                      ))}
                    </DropdownMenuGroup>
                  </>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => columnVisibilityStore.set({ type: false, model: false })}>Reset to default</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <FilterChips facets={facets} onChange={setFacets} />

          {error ? (
            <ErrorState error={error} onRetry={() => void refetch()} />
          ) : !isLoading && all.length === 0 ? (
            <EmptyState
              illustration="devices"
              title={clientId ? 'No devices in this scope yet' : 'Deploy your first agent'}
              description="Create a deploy key for a site, then install the agent with a one-line script, the MSI, or silently through Group Policy."
              actions={
                <Can permission={PERMISSIONS.agentsDeploy}>
                  <Button render={<Link to="/devices/deploy" />} nativeButton={false}>
                    <Rocket data-icon="inline-start" />
                    Deploy agents
                  </Button>
                </Can>
              }
            />
          ) : (
            <div className="h-[560px] min-h-0 lg:h-auto lg:flex-1">
              <DataTable
                data={filtered}
                columns={columns}
                loading={isLoading}
                getRowId={(device) => device.id}
                onRowClick={(device) => void navigate({ to: '/devices/$deviceId', params: { deviceId: device.id } })}
                onRowPeek={setPeek}
                activeRowId={peek?.id}
                rowClassName={(device) => selected.has(device.id) && 'bg-primary/[0.05]'}
                initialSorting={[{ id: 'device', desc: false }]}
                virtualHeight="100%"
                caption="Devices"
                empty={
                  <div className="p-6">
                    <EmptyState
                      compact
                      illustration="search"
                      title="No devices match"
                      description="Try removing a filter or searching for something else."
                      actions={
                        <Button variant="outline" size="sm" onClick={() => setFacets({})}>
                          Clear filters
                        </Button>
                      }
                    />
                  </div>
                }
              />
            </div>
          )}
        </PageContainer>
        </div>

        {selectedDevices.length > 0 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-4">
            <div
              role="toolbar"
              aria-label="Bulk actions"
              className="pointer-events-auto flex max-w-full items-center gap-1 overflow-x-auto rounded-xl bg-popover p-1.5 pl-3 shadow-popover ring-1 ring-border-strong"
            >
              <span className="tabular shrink-0 pr-2 text-dense font-medium">
                {selectedDevices.length} selected
              </span>
              <span className="mx-1 h-5 w-px shrink-0 bg-border-strong" />
              {canRunScripts && (
                <Button variant="ghost" size="sm" onClick={() => openRunDialog({ target: { type: 'devices', ids: selectedDevices.map((device) => device.id) } })}>
                  <FileCode data-icon="inline-start" />
                  Run script
                </Button>
              )}
              {canManage && (
                <>
                  <Button variant="ghost" size="sm" disabled={refreshInventory.isPending} onClick={() => refreshInventory.mutate(selectedDevices)}>
                    <RefreshCw data-icon="inline-start" className={cn(refreshInventory.isPending && 'animate-spin')} />
                    Refresh inventory
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setBulkDialog('tag')}>
                    <Tag data-icon="inline-start" />
                    Add tag
                  </Button>
                  <MoveButton devices={selectedDevices} onClick={() => setBulkDialog('move')} />
                </>
              )}
              <Button variant="ghost" size="sm" onClick={() => exportCsv(selectedDevices)}>
                <Download data-icon="inline-start" />
                Export
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label="Clear selection" onClick={() => setSelected(new Set())}>
                <X />
              </Button>
            </div>
          </div>
        )}
      </div>

      <Sheet open={filtersOpen} onOpenChange={setFiltersOpen}>
        <SheetContent side="left" className="w-[300px] gap-0 p-0">
          <SheetHeader className="border-b border-border px-4 py-3">
            <SheetTitle>Filter devices</SheetTitle>
          </SheetHeader>
          <div className="overflow-y-auto px-2 py-2">
            <DeviceFacetSections facets={facets} counts={facetCounts(all)} onChange={setFacets} />
          </div>
        </SheetContent>
      </Sheet>

      <DevicePeek device={peek} onClose={() => setPeek(null)} />
      <BulkTagDialog devices={selectedDevices} open={bulkDialog === 'tag'} onOpenChange={(open) => !open && setBulkDialog(null)} />
      <MoveSiteDialog
        devices={selectedDevices}
        open={bulkDialog === 'move'}
        onOpenChange={(open) => !open && setBulkDialog(null)}
        onDone={() => setSelected(new Set())}
      />
    </div>
  )
}

function MoveButton({ devices, onClick }: { devices: Device[]; onClick: () => void }) {
  const sameClient = devices.every((device) => device.client_id === devices[0]?.client_id)
  if (sameClient) {
    return (
      <Button variant="ghost" size="sm" onClick={onClick}>
        <MapPin data-icon="inline-start" />
        Move to site
      </Button>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" tabIndex={0} />}>
        <Button variant="ghost" size="sm" disabled>
          <MapPin data-icon="inline-start" />
          Move to site
        </Button>
      </TooltipTrigger>
      <TooltipContent>Select devices from a single client to move them between its sites</TooltipContent>
    </Tooltip>
  )
}

