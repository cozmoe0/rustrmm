/* Inventory tabs of the device cockpit: hardware, software, storage, network, security, users, services, updates. */
import { useMemo, useState, type ReactNode } from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import {
  Battery,
  CircuitBoard,
  Cpu,
  Info,
  MemoryStick,
  Monitor,
  Printer,
  RotateCw,
  Search,
  ShieldCheck,
  UserRound,
  Wifi,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { CopyButton } from '@/components/common/copy-button'
import { DataTable } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { KeyValue, Mono, RelativeTime } from '@/components/common/misc'
import type {
  DeviceDetail,
  HardwareInventory,
  InventoryEnvelope,
  InventoryResponse,
  NetworkInventory,
  SecurityInventory,
  ServiceItem,
  SoftwareItem,
  StorageInventory,
  UpdatesInventory,
  UsersInventory,
} from '@/lib/api/types'
import { formatBytes, formatDate, formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import { CheckRow, UsageBar } from './device-ui'
import { securityChecks } from './security-checks'

// ------------------------------------------------------------------ building blocks

export function SectionCard({
  title,
  icon,
  action,
  children,
  className,
}: {
  title: ReactNode
  icon?: ReactNode
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
      <CardContent>{children}</CardContent>
    </Card>
  )
}

function Collected({ at }: { at: string | undefined }) {
  if (!at) return null
  return (
    <p className="text-micro text-subtle-foreground">
      Collected <RelativeTime value={at} />
    </p>
  )
}

function Dash() {
  return <span className="text-subtle-foreground">—</span>
}

function val(value: ReactNode | null | undefined): ReactNode {
  return value === null || value === undefined || value === '' ? <Dash /> : value
}

function YesNo({ value, good = true }: { value: boolean | null | undefined; good?: boolean }) {
  if (value === null || value === undefined) return <Dash />
  const positive = value === good
  return <span className={positive ? 'text-live' : 'text-critical'}>{value ? 'Yes' : 'No'}</span>
}

function TabSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {Array.from({ length: 4 }, (_, index) => (
        <Skeleton key={index} className="h-44 rounded-xl" />
      ))}
    </div>
  )
}

function Missing({ what, pending }: { what: string; pending?: boolean }) {
  return (
    <EmptyState
      compact
      illustration="devices"
      title={pending ? 'Available after approval' : `No ${what} reported yet`}
      description={
        pending
          ? 'Full inventory is collected once the device is approved.'
          : 'The agent sends this section shortly after it connects. Use Refresh inventory to request it now.'
      }
    />
  )
}

type Section<K extends keyof InventoryResponse['sections']> = NonNullable<InventoryResponse['sections'][K]>

interface TabProps {
  device: DeviceDetail
  inventory: InventoryResponse | undefined
  loading: boolean
}

function useSection<K extends keyof InventoryResponse['sections']>(inventory: InventoryResponse | undefined, key: K) {
  return inventory?.sections[key] as Section<K> | undefined
}

function SearchBox({ value, onChange, label, placeholder }: { value: string; onChange: (value: string) => void; label: string; placeholder: string }) {
  return (
    <div className="relative w-full sm:w-72">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-subtle-foreground" />
      <Input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} aria-label={label} className="pl-8" />
    </div>
  )
}

// ------------------------------------------------------------------ hardware

export function HardwareTab({ device, inventory, loading }: TabProps) {
  const section = useSection(inventory, 'hardware') as InventoryEnvelope<HardwareInventory> | undefined
  if (loading) return <TabSkeleton />
  if (!section) return <Missing what="hardware details" pending={device.status === 'pending'} />
  const hw = section.data
  const battery = hw.batteries?.[0]
  const design = Number(battery?.design_capacity) || 0
  const full = Number(battery?.full_charge_capacity) || 0
  const batteryHealth = design > 0 ? Math.round((full / design) * 100) : null

  return (
    <div className="grid gap-4">
      <Collected at={section.collected_at} />
      <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        <SectionCard title="System" icon={<CircuitBoard />}>
          <dl>
            <KeyValue label="Manufacturer">{val(hw.manufacturer)}</KeyValue>
            <KeyValue label="Model">{val(hw.model)}</KeyValue>
            {hw.chip && <KeyValue label="Chip">{hw.chip}</KeyValue>}
            <KeyValue label="Serial number">
              {hw.serial ? (
                <span className="inline-flex items-center gap-1">
                  <Mono>{hw.serial}</Mono>
                  <CopyButton value={hw.serial} label="Copy serial number" />
                </span>
              ) : (
                <Dash />
              )}
            </KeyValue>
            <KeyValue label="Hardware UUID">{hw.uuid ? <Mono truncate={10}>{hw.uuid}</Mono> : <Dash />}</KeyValue>
            <KeyValue label="Firmware">
              {hw.bios ? (
                <span>
                  {[hw.bios.vendor, hw.bios.version].filter(Boolean).join(' ')}
                  {hw.bios.date && <span className="text-muted-foreground"> · {formatDate(hw.bios.date)}</span>}
                </span>
              ) : (
                <Dash />
              )}
            </KeyValue>
            {hw.baseboard && <KeyValue label="Baseboard">{[hw.baseboard.manufacturer, hw.baseboard.product].filter(Boolean).join(' ')}</KeyValue>}
          </dl>
        </SectionCard>

        <SectionCard title="Processor" icon={<Cpu />}>
          <dl>
            <KeyValue label="Model">{val(hw.cpu?.model)}</KeyValue>
            <KeyValue label="Vendor">{val(hw.cpu?.vendor)}</KeyValue>
            <KeyValue label="Cores / threads">
              {hw.cpu?.cores ? (
                <span className="tabular">
                  {hw.cpu.cores} / {hw.cpu.threads ?? hw.cpu.cores}
                </span>
              ) : (
                <Dash />
              )}
            </KeyValue>
            <KeyValue label="Clock">{hw.cpu?.mhz ? <span className="tabular">{(hw.cpu.mhz / 1000).toFixed(2)} GHz</span> : <Dash />}</KeyValue>
          </dl>
          {(hw.gpus?.length ?? 0) > 0 && (
            <div className="mt-3 border-t border-border pt-3">
              <div className="eyebrow mb-1.5">Graphics</div>
              <ul className="grid gap-1.5 text-dense">
                {hw.gpus!.map((gpu, index) => (
                  <li key={index} className="flex items-baseline justify-between gap-3">
                    <span className="truncate">{gpu.name ?? 'Display adapter'}</span>
                    <span className="shrink-0 text-micro text-muted-foreground">
                      {gpu.memory_bytes ? formatBytes(gpu.memory_bytes) : gpu.cores ? `${gpu.cores} cores` : gpu.driver ?? ''}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Memory"
          icon={<MemoryStick />}
          action={hw.memory?.total_bytes ? <span className="tabular text-dense font-semibold">{formatBytes(hw.memory.total_bytes)}</span> : undefined}
        >
          {(hw.memory?.modules?.length ?? 0) > 0 ? (
            <ul className="grid gap-2">
              {hw.memory!.modules!.map((module, index) => (
                <li key={index} className="grid grid-cols-[1fr_auto] gap-x-3 rounded-lg bg-surface-2/70 px-3 py-2 text-dense">
                  <span className="font-medium">{module.slot ?? `Module ${index + 1}`}</span>
                  <span className="tabular font-medium">{module.size_bytes ? formatBytes(module.size_bytes) : '—'}</span>
                  <span className="text-micro text-muted-foreground">
                    {[module.manufacturer, module.part_number].filter(Boolean).join(' · ') || 'Unknown module'}
                  </span>
                  <span className="tabular text-right text-micro text-muted-foreground">{module.speed_mhz ? `${module.speed_mhz} MT/s` : ''}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-dense text-muted-foreground">
              {device.os_family === 'macos' ? 'Unified memory — modules are not reported on Apple silicon.' : 'Module details were not reported.'}
            </p>
          )}
        </SectionCard>

        <SectionCard title="Security hardware" icon={<ShieldCheck />}>
          <ul className="divide-y divide-border">
            <CheckRow ok={hw.secure_boot} label="Secure Boot" detail={hw.secure_boot == null ? 'Not reported' : hw.secure_boot ? 'Enabled' : 'Disabled'} warn />
            <CheckRow
              ok={hw.tpm ? Boolean(hw.tpm.present && hw.tpm.enabled) : device.device_type === 'virtual' ? null : hw.tpm === null ? false : null}
              label="Trusted Platform Module"
              detail={hw.tpm ? `TPM ${hw.tpm.spec_version?.split(',')[0] ?? ''}`.trim() : device.os_family === 'macos' ? 'Secure Enclave' : 'Not present'}
              warn
            />
          </ul>
        </SectionCard>

        {(hw.monitors?.length ?? 0) > 0 && (
          <SectionCard title="Displays" icon={<Monitor />}>
            <ul className="grid gap-1.5 text-dense">
              {hw.monitors!.map((monitor, index) => (
                <li key={index} className="flex items-baseline justify-between gap-3">
                  <span className="truncate">{monitor.model ?? monitor.manufacturer ?? 'Display'}</span>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                    {monitor.serial}
                    {monitor.year ? ` · ${monitor.year}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </SectionCard>
        )}

        {battery && (
          <SectionCard title="Battery" icon={<Battery />}>
            <div className="grid gap-3 [&>*]:min-w-0">
              <div className="flex items-end justify-between">
                <div>
                  <div className="text-micro text-subtle-foreground">Charge</div>
                  <div className="tabular text-xl font-semibold">{battery.charge_pct ?? '—'}%</div>
                </div>
                <div className="text-right">
                  <div className="text-micro text-subtle-foreground">Health</div>
                  <div className={cn('tabular text-xl font-semibold', batteryHealth !== null && batteryHealth < 80 ? 'text-warning' : '')}>
                    {batteryHealth === null ? battery.condition ?? '—' : `${batteryHealth}%`}
                  </div>
                </div>
              </div>
              <UsageBar value={Number(battery.charge_pct) || 0} height="h-1.5" className="[&>span]:bg-live" />
              <dl>
                <KeyValue label="Cycle count">{val(battery.cycles)}</KeyValue>
                {battery.condition && <KeyValue label="Condition">{battery.condition}</KeyValue>}
              </dl>
            </div>
          </SectionCard>
        )}

        {(hw.printers?.length ?? 0) > 0 && (
          <SectionCard title="Printers" icon={<Printer />}>
            <ul className="grid gap-2">
              {hw.printers!.map((printer, index) => (
                <li key={index} className="flex items-center gap-2 text-dense">
                  <span className="min-w-0 flex-1 truncate">{printer.name}</span>
                  {printer.default && <Badge variant="secondary">Default</Badge>}
                  {printer.network && <Badge variant="outline">Network</Badge>}
                </li>
              ))}
            </ul>
          </SectionCard>
        )}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ software

/** Installed software. `actions` adds a trailing column (the Software tab uses it for library actions). */
export function SoftwareTab({ device, inventory, loading, actions }: TabProps & { actions?: (item: SoftwareItem) => ReactNode }) {
  const section = useSection(inventory, 'software')
  const [query, setQuery] = useState('')
  const items = useMemo(() => section?.data.items ?? [], [section])
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return items
    return items.filter((item) => `${item.name} ${item.publisher ?? ''} ${item.version ?? ''}`.toLowerCase().includes(needle))
  }, [items, query])
  const totalSize = items.reduce((sum, item) => sum + (item.size_bytes ?? 0), 0)

  const columns = useMemo<ColumnDef<SoftwareItem>[]>(
    () => [
      {
        id: 'name',
        accessorFn: (item) => item.name.toLowerCase(),
        header: 'Name',
        cell: ({ row }) => <span className="block max-w-[28rem] truncate font-medium">{row.original.name}</span>,
      },
      {
        id: 'version',
        accessorFn: (item) => item.version ?? '',
        header: 'Version',
        cell: ({ getValue }) => <span className="font-mono text-[11.5px] text-muted-foreground">{getValue<string>() || '—'}</span>,
      },
      {
        id: 'publisher',
        accessorFn: (item) => item.publisher ?? '',
        header: 'Publisher',
        cell: ({ getValue }) => <span className="block max-w-56 truncate text-muted-foreground">{getValue<string>() || '—'}</span>,
      },
      {
        id: 'installed',
        accessorFn: (item) => item.install_date ?? '',
        header: 'Installed',
        cell: ({ getValue }) => <span className="tabular text-muted-foreground">{getValue<string>() ? formatDate(getValue<string>()) : '—'}</span>,
      },
      {
        id: 'size',
        accessorFn: (item) => item.size_bytes ?? -1,
        header: 'Size',
        meta: { align: 'right' },
        cell: ({ row }) => <span className="tabular text-muted-foreground">{row.original.size_bytes ? formatBytes(row.original.size_bytes) : '—'}</span>,
      },
      {
        id: 'source',
        accessorFn: (item) => item.source ?? '',
        header: 'Source',
        cell: ({ getValue }) => (getValue<string>() ? <Badge variant="outline" className="font-mono text-[10.5px]">{getValue<string>()}</Badge> : <Dash />),
      },
      ...(actions
        ? [
            {
              id: 'actions',
              enableSorting: false,
              header: 'Library',
              meta: { align: 'right' as const },
              cell: ({ row }: { row: { original: SoftwareItem } }) => actions(row.original),
            },
          ]
        : []),
    ],
    [actions],
  )

  if (loading) return <Skeleton className="h-96 rounded-xl" />
  if (!section) return <Missing what="software inventory" pending={device.status === 'pending'} />

  return (
    <div className="grid gap-3 [&>*]:min-w-0">
      <div className="flex flex-wrap items-center gap-3">
        <SearchBox value={query} onChange={setQuery} label="Search software" placeholder="Search name, publisher, version…" />
        <span className="tabular text-dense text-muted-foreground">
          {formatNumber(filtered.length)} of {formatNumber(items.length)} applications
          {totalSize > 0 && ` · ${formatBytes(totalSize)}`}
        </span>
        <span className="ml-auto">
          <Collected at={section.collected_at} />
        </span>
      </div>
      <DataTable
        data={filtered}
        columns={columns}
        getRowId={(item) => `${item.name}@${item.version ?? ''}@${item.source ?? ''}`}
        initialSorting={[{ id: 'name', desc: false }]}
        virtualHeight="min(62vh, 640px)"
        caption="Installed software"
        empty={<div className="px-4 py-10 text-center text-dense text-muted-foreground">No software matches “{query}”.</div>}
      />
    </div>
  )
}

// ------------------------------------------------------------------ storage

export function StorageTab({ device, inventory, loading }: TabProps) {
  const section = useSection(inventory, 'storage') as InventoryEnvelope<StorageInventory> | undefined
  if (loading) return <TabSkeleton />
  if (!section) return <Missing what="storage details" pending={device.status === 'pending'} />
  const storage = section.data
  const volumes = storage.volumes ?? []
  const disks: { name: string; meta: string; health: string | null }[] = [
    ...(storage.disks ?? []).map((disk) => ({
      name: disk.model ?? disk.name ?? 'Disk',
      meta: [disk.media, disk.bus, disk.size_bytes ? formatBytes(disk.size_bytes) : null].filter(Boolean).join(' · '),
      health: disk.health ?? null,
    })),
    ...(storage.disks ? [] : (storage.physical_disks ?? [])).map((disk) => ({
      name: disk.name ?? 'Disk',
      meta: [disk.media, disk.size_bytes ? formatBytes(disk.size_bytes) : null].filter(Boolean).join(' · '),
      health: disk.health ?? null,
    })),
  ]

  return (
    <div className="grid gap-4">
      <Collected at={section.collected_at} />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {volumes.map((volume, index) => {
          const total = volume.total_bytes ?? 0
          const free = volume.free_bytes ?? 0
          const used = Math.max(0, total - free)
          const pct = total > 0 ? (used / total) * 100 : null
          return (
            <div key={`${volume.mount}-${index}`} className="grid gap-3 rounded-xl bg-card p-4 shadow-card">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-mono text-sm font-semibold">{volume.mount}</div>
                  <div className="truncate text-micro text-muted-foreground">
                    {[volume.name, volume.filesystem, volume.kind && volume.kind !== 'unknown' ? volume.kind.toUpperCase() : null].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <span className={cn('tabular text-xl font-semibold', pct !== null && pct >= 90 ? 'text-critical' : pct !== null && pct >= 75 ? 'text-warning' : '')}>
                  {pct === null ? '—' : `${Math.round(pct)}%`}
                </span>
              </div>
              <UsageBar value={pct} height="h-2" />
              <div className="flex justify-between text-micro text-muted-foreground">
                <span className="tabular">{formatBytes(used)} used</span>
                <span className="tabular">
                  {formatBytes(free)} free of {formatBytes(total)}
                </span>
              </div>
            </div>
          )
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <SectionCard title="Physical disks" icon={<CircuitBoard />}>
          {disks.length === 0 ? (
            <p className="text-dense text-muted-foreground">No physical disk details reported.</p>
          ) : (
            <ul className="grid gap-2">
              {disks.map((disk, index) => (
                <li key={index} className="flex items-center gap-3 rounded-lg bg-surface-2/70 px-3 py-2 text-dense">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{disk.name}</div>
                    <div className="text-micro text-muted-foreground">
                      {disk.meta}
                    </div>
                  </div>
                  {disk.health && <Badge variant={/ok|healthy|good/i.test(disk.health) ? 'success' : 'warning'}>{disk.health}</Badge>}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
        <SectionCard title="Encryption" icon={<ShieldCheck />}>
          {storage.bitlocker && storage.bitlocker.length > 0 ? (
            <ul className="divide-y divide-border">
              {storage.bitlocker.map((volume, index) => (
                <CheckRow
                  key={index}
                  ok={volume.protected}
                  label={
                    <span>
                      BitLocker <span className="font-mono">{volume.drive}</span>
                      {volume.os_volume && <span className="text-muted-foreground"> (system)</span>}
                    </span>
                  }
                  detail={volume.protected ? 'Protected' : 'Not protected'}
                />
              ))}
            </ul>
          ) : (
            <ul className="divide-y divide-border">
              <CheckRow
                ok={storage.system_volume_encrypted ?? null}
                label={device.os_family === 'macos' ? 'FileVault' : device.os_family === 'linux' ? 'LUKS (system volume)' : 'System volume'}
                detail={storage.system_volume_encrypted == null ? 'See Security tab' : storage.system_volume_encrypted ? 'Encrypted' : 'Not encrypted'}
              />
            </ul>
          )}
        </SectionCard>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ network

export function NetworkTab({ device, inventory, loading }: TabProps) {
  const section = useSection(inventory, 'network') as InventoryEnvelope<NetworkInventory> | undefined
  if (loading) return <TabSkeleton />
  if (!section) return <Missing what="network details" pending={device.status === 'pending'} />
  const net = section.data
  const adapters = net.adapters ?? []

  return (
    <div className="grid gap-4">
      <Collected at={section.collected_at} />
      <div className="grid gap-4 lg:grid-cols-2">
        {(net.interfaces ?? []).map((iface, index) => {
          const adapter = adapters.find((item) => item.mac && item.mac === iface.mac)
          return (
            <SectionCard
              key={`${iface.name}-${index}`}
              title={<span className="font-mono">{iface.name}</span>}
              action={
                iface.ipv4?.length ? <Badge variant="live">Connected</Badge> : <Badge variant="outline">No address</Badge>
              }
            >
              {adapter?.description && <p className="mb-2 text-dense text-muted-foreground">{adapter.description}</p>}
              <dl>
                <KeyValue label="IPv4">{iface.ipv4?.length ? <span className="font-mono text-[12px]">{iface.ipv4.join(', ')}</span> : <Dash />}</KeyValue>
                <KeyValue label="IPv6">
                  {iface.ipv6?.length ? <span className="font-mono text-[11.5px] break-all">{iface.ipv6.join(', ')}</span> : <Dash />}
                </KeyValue>
                <KeyValue label="MAC address">{iface.mac ? <Mono>{iface.mac}</Mono> : <Dash />}</KeyValue>
                <KeyValue label="Link speed">{iface.speed_mbps ? <span className="tabular">{iface.speed_mbps >= 1000 ? `${iface.speed_mbps / 1000} Gb/s` : `${iface.speed_mbps} Mb/s`}</span> : <Dash />}</KeyValue>
                {iface.mtu ? <KeyValue label="MTU">{iface.mtu}</KeyValue> : null}
                {adapter && (
                  <>
                    <KeyValue label="Gateway">{adapter.gateways?.length ? <span className="font-mono text-[12px]">{adapter.gateways.join(', ')}</span> : <Dash />}</KeyValue>
                    <KeyValue label="DNS servers">{adapter.dns_servers?.length ? <span className="font-mono text-[12px]">{adapter.dns_servers.join(', ')}</span> : <Dash />}</KeyValue>
                    <KeyValue label="DHCP">
                      {adapter.dhcp ? (
                        <span>
                          Enabled{adapter.dhcp_server && <span className="text-muted-foreground"> · {adapter.dhcp_server}</span>}
                        </span>
                      ) : (
                        'Static'
                      )}
                    </KeyValue>
                    {adapter.dns_domain && <KeyValue label="DNS suffix">{adapter.dns_domain}</KeyValue>}
                  </>
                )}
              </dl>
            </SectionCard>
          )
        })}
        {Boolean(net.gateways?.length || net.dns_servers?.length) && (
          <SectionCard title="Routing & DNS">
            <dl>
              <KeyValue label="Default gateway">{net.gateways?.length ? <span className="font-mono text-[12px]">{net.gateways.join(', ')}</span> : <Dash />}</KeyValue>
              <KeyValue label="DNS servers">{net.dns_servers?.length ? <span className="font-mono text-[12px]">{net.dns_servers.join(', ')}</span> : <Dash />}</KeyValue>
            </dl>
          </SectionCard>
        )}
        {net.wifi && (
          <SectionCard title="Wi-Fi" icon={<Wifi />}>
            <dl>
              <KeyValue label="Network">{val(net.wifi.ssid)}</KeyValue>
              <KeyValue label="Signal">{val(net.wifi.signal)}</KeyValue>
              <KeyValue label="Radio">{val(net.wifi.radio)}</KeyValue>
            </dl>
          </SectionCard>
        )}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ security

export function SecurityTab({ device, inventory, loading }: TabProps) {
  const section = useSection(inventory, 'security') as InventoryEnvelope<SecurityInventory> | undefined
  const system = useSection(inventory, 'system')
  if (loading) return <TabSkeleton />
  if (!section) return <Missing what="security posture" pending={device.status === 'pending'} />
  const security = section.data
  const checks = securityChecks(device, security, system?.data.pending_reboot)
  const passing = checks.filter((check) => check.ok).length

  return (
    <div className="grid gap-4">
      <Collected at={section.collected_at} />
      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        <SectionCard
          title="Posture"
          icon={<ShieldCheck />}
          action={
            <span className="tabular text-dense text-muted-foreground">
              <span className="font-semibold text-foreground">{passing}</span> of {checks.length} passing
            </span>
          }
        >
          <ul className="grid divide-y divide-border sm:grid-cols-2 sm:gap-x-6 sm:divide-y-0">
            {checks.map((check) => (
              <CheckRow key={check.key} ok={check.ok} label={check.label} detail={check.detail} warn={check.warn} />
            ))}
          </ul>
        </SectionCard>
        <SectionCard title="Local administrators" icon={<UserRound />}>
          {(security.local_admins?.length ?? 0) === 0 ? (
            <p className="text-dense text-muted-foreground">None reported.</p>
          ) : (
            <ul className="grid gap-1.5">
              {security.local_admins!.map((admin) => (
                <li key={admin} className="flex items-center gap-2 rounded-md bg-surface-2/70 px-2.5 py-1.5 font-mono text-[12px]">
                  <span className="min-w-0 flex-1 truncate">{admin}</span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {security.defender && (
          <SectionCard title="Microsoft Defender">
            <dl>
              <KeyValue label="Real-time protection">
                <YesNo value={security.defender.real_time_protection} />
              </KeyValue>
              <KeyValue label="Tamper protection">
                <YesNo value={security.defender.tamper_protection} />
              </KeyValue>
              <KeyValue label="Signature age">
                {security.defender.signature_age_days == null ? (
                  <Dash />
                ) : (
                  <span className={cn('tabular', security.defender.signature_age_days > 3 && 'text-warning')}>
                    {security.defender.signature_age_days === 0 ? 'Today' : `${security.defender.signature_age_days} days`}
                  </span>
                )}
              </KeyValue>
              <KeyValue label="Last quick scan">{security.defender.last_quick_scan ? <RelativeTime value={security.defender.last_quick_scan} /> : <Dash />}</KeyValue>
              <KeyValue label="Last full scan">{security.defender.last_full_scan ? <RelativeTime value={security.defender.last_full_scan} /> : <Dash />}</KeyValue>
            </dl>
          </SectionCard>
        )}
        {security.firewall?.profiles && security.firewall.profiles.length > 0 && (
          <SectionCard title="Firewall profiles">
            <ul className="divide-y divide-border">
              {security.firewall.profiles.map((profile) => (
                <CheckRow key={profile.name} ok={profile.enabled} label={profile.name} detail={profile.enabled ? 'On' : 'Off'} />
              ))}
            </ul>
          </SectionCard>
        )}
        {security.rdp_enabled !== undefined && (
          <SectionCard title="Remote access">
            <dl>
              <KeyValue label="Remote Desktop (RDP)">
                {security.rdp_enabled == null ? <Dash /> : security.rdp_enabled ? <span className="text-warning">Enabled</span> : 'Disabled'}
              </KeyValue>
            </dl>
          </SectionCard>
        )}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ users

export function UsersTab({ device, inventory, loading }: TabProps) {
  const section = useSection(inventory, 'users') as InventoryEnvelope<UsersInventory> | undefined
  if (loading) return <TabSkeleton />
  if (!section) return <Missing what="user accounts" pending={device.status === 'pending'} />
  const users = section.data
  return (
    <div className="grid gap-4">
      <Collected at={section.collected_at} />
      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <Card size="sm" className="gap-0 py-0">
          <CardHeader className="border-b border-border py-3">
            <CardTitle className="text-sm">Local accounts</CardTitle>
          </CardHeader>
          <ul className="divide-y divide-border">
            {(users.local ?? []).map((user) => (
              <li key={user.name} className="flex items-center gap-3 px-4 py-2.5">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-3 ring-1 ring-border">
                  <UserRound className="size-3.5 text-subtle-foreground" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className={cn('truncate font-mono text-[12.5px]', user.enabled === false && 'text-subtle-foreground line-through')}>{user.name}</div>
                  {user.full_name && <div className="truncate text-micro text-muted-foreground">{user.full_name}</div>}
                </div>
                {user.admin && <Badge variant="warning">Admin</Badge>}
                {user.enabled === false ? <Badge variant="outline">Disabled</Badge> : <Badge variant="ghost">Enabled</Badge>}
              </li>
            ))}
          </ul>
        </Card>
        <div className="grid content-start gap-4">
          <SectionCard title="Signed in now">
            {(users.sessions?.length ?? 0) === 0 ? (
              <p className="text-dense text-muted-foreground">No interactive sessions.</p>
            ) : (
              <ul className="grid gap-1.5 text-dense">
                {users.sessions!.map((session, index) => (
                  <li key={index} className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-[12px]">{session.user}</span>
                    <Badge variant="live">{session.kind ?? 'session'}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
          <SectionCard title="Last user">
            <p className="font-mono text-[12.5px]">{users.last_user ?? device.last_user ?? '—'}</p>
          </SectionCard>
          {(users.profiles?.length ?? 0) > 0 && (
            <SectionCard title="Profiles">
              <ul className="grid gap-1.5 text-dense">
                {users.profiles!.map((profile) => (
                  <li key={profile.path} className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-[11.5px]">{profile.path}</span>
                    {profile.last_used && <RelativeTime value={profile.last_used} className="shrink-0 text-micro text-muted-foreground" />}
                  </li>
                ))}
              </ul>
            </SectionCard>
          )}
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ services

const RUNNING = /running|active/i

export function ServicesTab({ device, inventory, loading, notice }: TabProps & { notice?: ReactNode }) {
  const section = useSection(inventory, 'services')
  const [query, setQuery] = useState('')
  const [state, setState] = useState<'all' | 'running' | 'stopped'>('all')
  const items = useMemo(() => section?.data.items ?? [], [section])
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return items.filter((item) => {
      const running = RUNNING.test(item.state ?? '')
      if (state === 'running' && !running) return false
      if (state === 'stopped' && running) return false
      return !needle || `${item.name} ${item.display_name ?? ''}`.toLowerCase().includes(needle)
    })
  }, [items, query, state])
  const runningCount = items.filter((item) => RUNNING.test(item.state ?? '')).length

  const columns = useMemo<ColumnDef<ServiceItem>[]>(
    () => [
      {
        id: 'display',
        accessorFn: (item) => (item.display_name ?? item.name).toLowerCase(),
        header: 'Service',
        cell: ({ row }) => (
          <div className="min-w-0 leading-tight">
            <div className="max-w-[26rem] truncate font-medium">{row.original.display_name ?? row.original.name}</div>
            {row.original.display_name && row.original.display_name !== row.original.name && (
              <div className="font-mono text-[10.5px] text-subtle-foreground">{row.original.name}</div>
            )}
          </div>
        ),
      },
      {
        id: 'state',
        accessorFn: (item) => item.state ?? '',
        header: 'State',
        cell: ({ row }) => {
          const value = row.original.state ?? 'unknown'
          return (
            <Badge variant={RUNNING.test(value) ? 'live' : /stop|dead|exited|inactive/i.test(value) ? 'outline' : 'secondary'} className="capitalize">
              {value}
            </Badge>
          )
        },
      },
      {
        id: 'start',
        accessorFn: (item) => item.start_mode ?? item.active ?? '',
        header: device.os_family === 'linux' ? 'Unit' : 'Start mode',
        cell: ({ getValue }) => <span className="text-muted-foreground capitalize">{getValue<string>() || '—'}</span>,
      },
      {
        id: 'account',
        accessorFn: (item) => item.account ?? '',
        header: 'Account',
        cell: ({ getValue }) => <span className="font-mono text-[11.5px] text-muted-foreground">{getValue<string>() || '—'}</span>,
      },
    ],
    [device.os_family],
  )

  if (loading) return <Skeleton className="h-96 rounded-xl" />
  if (!section) {
    return (
      <div className="grid gap-3">
        {notice}
        <Missing what="services" pending={device.status === 'pending'} />
      </div>
    )
  }

  return (
    <div className="grid gap-3 [&>*]:min-w-0">
      {notice}
      <div className="flex flex-wrap items-center gap-3">
        <SearchBox value={query} onChange={setQuery} label="Search services" placeholder="Search services…" />
        <ToggleGroup value={[state]} onValueChange={(value: string[]) => value[0] && setState(value[0] as typeof state)} aria-label="Service state">
          <ToggleGroupItem value="all" size="sm">
            All <span className="tabular text-subtle-foreground">{items.length}</span>
          </ToggleGroupItem>
          <ToggleGroupItem value="running" size="sm">
            Running <span className="tabular text-subtle-foreground">{runningCount}</span>
          </ToggleGroupItem>
          <ToggleGroupItem value="stopped" size="sm">
            Stopped <span className="tabular text-subtle-foreground">{items.length - runningCount}</span>
          </ToggleGroupItem>
        </ToggleGroup>
        <span className="ml-auto">
          <Collected at={section.collected_at} />
        </span>
      </div>
      <DataTable
        data={filtered}
        columns={columns}
        getRowId={(item) => item.name}
        initialSorting={[{ id: 'display', desc: false }]}
        caption="Services"
        empty={<div className="px-4 py-10 text-center text-dense text-muted-foreground">No services match.</div>}
      />
    </div>
  )
}

// ------------------------------------------------------------------ updates

export function UpdatesTab({ device, inventory, loading }: TabProps) {
  const section = useSection(inventory, 'updates') as InventoryEnvelope<UpdatesInventory> | undefined
  if (loading) return <TabSkeleton />
  if (!section) return <Missing what="update status" pending={device.status === 'pending'} />
  const updates = section.data
  return (
    <div className="grid gap-4">
      <div className="flex items-start gap-3 rounded-xl bg-info/[0.07] px-4 py-3 ring-1 ring-info/20">
        <Info className="mt-0.5 size-4 shrink-0 text-info" />
        <p className="text-dense text-muted-foreground">
          This is the inventory’s update summary. Patch details, approvals and installs need the “View patches” permission.
        </p>
      </div>
      <Collected at={section.collected_at} />
      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        <SectionCard title="Status" icon={<RotateCw />}>
          <ul className="divide-y divide-border">
            <CheckRow ok={!updates.pending_reboot} label="No restart pending" detail={updates.pending_reboot ? 'Restart required' : 'Up to date'} warn />
          </ul>
          <dl className="mt-2">
            {updates.wsus_server !== undefined && <KeyValue label="Update source">{updates.wsus_server ?? 'Windows Update'}</KeyValue>}
            {updates.package_manager && (
              <KeyValue label="Package manager">
                <Mono>{updates.package_manager}</Mono>
              </KeyValue>
            )}
            <KeyValue label="Operating system">{device.os_name}</KeyValue>
          </dl>
        </SectionCard>
        <div className="grid content-start gap-4">
          {updates.pending && (
            <SectionCard title="Available updates">
              {updates.pending.length === 0 ? (
                <p className="text-dense text-muted-foreground">No updates available.</p>
              ) : (
                <ul className="grid gap-1.5">
                  {updates.pending.map((item) => (
                    <li key={item.label} className="rounded-md bg-surface-2/70 px-3 py-2 text-dense">
                      {item.label}
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          )}
          {updates.installed && (
            <Card size="sm" className="gap-0 py-0">
              <CardHeader className="border-b border-border py-3">
                <CardTitle className="text-sm">Recently installed updates</CardTitle>
              </CardHeader>
              <ul className="divide-y divide-border">
                {updates.installed.map((item) => (
                  <li key={item.id} className="flex items-center gap-3 px-4 py-2.5 text-dense">
                    <Mono>{item.id ?? '—'}</Mono>
                    <span className="flex-1 truncate text-muted-foreground">{item.description}</span>
                    <span className="tabular text-micro text-subtle-foreground">{item.installed_on}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {!updates.pending && !updates.installed && (
            <SectionCard title="Packages">
              <p className="text-dense text-muted-foreground">
                Package-level update detail is collected by the patching module. The agent currently reports restart state only.
              </p>
            </SectionCard>
          )}
        </div>
      </div>
    </div>
  )
}
