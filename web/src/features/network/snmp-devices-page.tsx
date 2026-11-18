import { useCallback, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { Activity, Ellipsis, Pencil, PlugZap, Plus, Trash } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Spinner } from '@/components/ui/spinner'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { DataTable } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, RelativeTime } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { snmpApi } from '@/lib/api/endpoints'
import { networkKeys, snmpDevicesQuery, snmpTemplatesQuery } from '@/lib/api/queries'
import type { SnmpDevice, SnmpTestResult } from '@/lib/api/types'
import { formatDuration, formatSpan } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { SearchField } from '@/features/devices/remote-ui'
import { FilterPill } from '@/features/patching/patching-ui'
import { SiteSelect, SnmpStatusBadge, SnmpStatusDot } from './network-ui'
import { SnmpDeviceEditor, TestResultCard } from './snmp-device-editor'
import { networkErrorMessage, siteLabel, useScopedSites } from './use-network'

type StatusFilter = 'ok' | 'alerting' | 'unreachable' | 'pending' | 'paused'

export interface SnmpDevicesSearch {
  site_id?: string
  status?: StatusFilter
  q?: string
  edit?: string
}

const STATUS_FILTERS: { key: StatusFilter; label: string; match: (device: SnmpDevice) => boolean }[] = [
  { key: 'alerting', label: 'Alerting', match: (device) => device.enabled && device.status === 'alerting' },
  { key: 'unreachable', label: 'Unreachable', match: (device) => device.enabled && device.status === 'unreachable' },
  { key: 'ok', label: 'OK', match: (device) => device.enabled && device.status === 'ok' },
  { key: 'pending', label: 'Pending', match: (device) => device.enabled && device.status === 'pending' },
  { key: 'paused', label: 'Paused', match: (device) => !device.enabled },
]

const STATUS_RANK: Record<SnmpDevice['status'], number> = { unreachable: 0, alerting: 1, pending: 2, ok: 3 }

export function SnmpDevicesPage({ search }: { search: SnmpDevicesSearch }) {
  useTitle('SNMP devices')
  const me = useMe()
  const navigate = useNavigate({ from: '/network/snmp/' })
  const queryClient = useQueryClient()
  const canManage = hasPermission(me, PERMISSIONS.networkManage)
  const { sites, byId } = useScopedSites()
  const { data, isLoading, error, refetch } = useQuery(snmpDevicesQuery())
  const templates = useQuery(snmpTemplatesQuery)
  const [query, setQuery] = useState(search.q ?? '')
  const [deleting, setDeleting] = useState<SnmpDevice | null>(null)
  const [testing, setTesting] = useState<{ device: SnmpDevice; result: SnmpTestResult | null } | null>(null)
  const setSearch = useCallback((patch: Partial<SnmpDevicesSearch>) => void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true }), [navigate])

  const all = useMemo(() => (data ?? []).filter((device) => byId.has(device.site_id) && (!search.site_id || device.site_id === search.site_id)), [data, byId, search.site_id])
  const needle = query.trim().toLowerCase()
  const searched = all.filter((device) => !needle || [device.name, device.ip, device.sys_descr ?? ''].some((value) => value.toLowerCase().includes(needle)))
  const visible = searched.filter((device) => !search.status || STATUS_FILTERS.find((item) => item.key === search.status)!.match(device))
  const editing = search.edit && search.edit !== 'new' ? (data ?? []).find((device) => device.id === search.edit) ?? null : null
  const templateName = useCallback((id: string) => templates.data?.find((template) => template.id === id)?.name.replace(/ \(.*\)$/, '') ?? 'Template', [templates.data])

  const test = useMutation({
    mutationFn: (device: SnmpDevice) => snmpApi.test(device.id),
    meta: { silent: true },
    onMutate: (device) => setTesting({ device, result: null }),
    onSuccess: (result, device) => setTesting({ device, result }),
    onError: (failure, device) => setTesting({ device, result: { ok: false, error: networkErrorMessage(failure) } }),
  })
  const remove = useMutation({
    mutationFn: (device: SnmpDevice) => snmpApi.removeDevice(device.id),
    meta: { silent: true },
    onSuccess: (_result, device) => {
      toast.success(`Stopped monitoring ${device.name}`)
      setDeleting(null)
      void queryClient.invalidateQueries({ queryKey: networkKeys.devices })
      void queryClient.invalidateQueries({ queryKey: ['alerts'] })
    },
    onError: (failure) => toast.error(networkErrorMessage(failure)),
  })

  const columns = useMemo<ColumnDef<SnmpDevice>[]>(
    () => [
      {
        id: 'name',
        accessorFn: (device) => device.name.toLowerCase(),
        header: 'Device',
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-2.5">
            <SnmpStatusDot status={row.original.status} enabled={row.original.enabled} />
            <div className="min-w-0 leading-tight">
              <span className="block max-w-60 truncate font-medium">{row.original.name}</span>
              <span className="block max-w-60 truncate font-mono text-[10.5px] text-subtle-foreground">
                {row.original.ip}
                {row.original.port !== 161 ? `:${row.original.port}` : ''}
              </span>
            </div>
          </div>
        ),
      },
      { id: 'status', accessorFn: (device) => (device.enabled ? STATUS_RANK[device.status] : 9), header: 'Status', cell: ({ row }) => <SnmpStatusBadge status={row.original.status} enabled={row.original.enabled} /> },
      { id: 'site', accessorFn: (device) => siteLabel(byId.get(device.site_id), device.site_name), header: 'Site', cell: ({ getValue }) => <span className="block max-w-52 truncate text-muted-foreground">{getValue<string>()}</span> },
      {
        id: 'templates',
        accessorFn: (device) => device.template_ids.length,
        header: 'Templates',
        cell: ({ row }) => <span className="block max-w-52 truncate text-muted-foreground">{row.original.template_ids.map(templateName).join(', ')}</span>,
      },
      {
        id: 'last_poll',
        accessorFn: (device) => device.last_poll_at ?? '',
        header: 'Last poll',
        cell: ({ row }) => <RelativeTime value={row.original.last_poll_at} className="text-muted-foreground" />,
      },
      { id: 'uptime', accessorFn: (device) => device.uptime_secs ?? -1, header: 'Uptime', cell: ({ row }) => <span className="tabular text-muted-foreground">{row.original.uptime_secs != null ? formatDuration(row.original.uptime_secs) : '—'}</span> },
      { id: 'interval', accessorFn: (device) => device.poll_interval_secs, header: 'Every', meta: { align: 'right' }, cell: ({ row }) => <span className="tabular text-muted-foreground">{formatSpan(row.original.poll_interval_secs)}</span> },
      {
        id: 'actions',
        header: '',
        enableSorting: false,
        meta: { align: 'right', className: 'w-12' },
        cell: ({ row }) =>
          canManage ? (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${row.original.name}`} onClick={(event) => event.stopPropagation()} />}>
                <Ellipsis />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onClick={() => test.mutate(row.original)}>
                  <PlugZap />
                  Test now
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setSearch({ edit: row.original.id })}>
                  <Pencil />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => setDeleting(row.original)}>
                  <Trash />
                  Stop monitoring…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null,
      },
    ],
    [byId, canManage, setSearch, templateName, test],
  )

  return (
    <PageContainer className="grid grid-cols-1 gap-4">
      <PageHeader
        icon={<Activity />}
        title="SNMP devices"
        description="Switches, printers, UPSes and other gear polled by each site’s probe. Thresholds and outages raise alerts in the inbox."
        actions={
          canManage && (
            <Button size="sm" onClick={() => setSearch({ edit: 'new' })}>
              <Plus data-icon="inline-start" />
              Add device
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          <FilterPill active={!search.status} onClick={() => setSearch({ status: undefined })} count={searched.length}>
            All
          </FilterPill>
          {STATUS_FILTERS.map((item) => {
            const count = searched.filter(item.match).length
            if (!count && search.status !== item.key && (item.key === 'pending' || item.key === 'paused')) return null
            return (
              <FilterPill key={item.key} active={search.status === item.key} onClick={() => setSearch({ status: search.status === item.key ? undefined : item.key })} count={count}>
                {item.label}
              </FilterPill>
            )
          })}
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto">
          <SiteSelect value={search.site_id ?? ''} onChange={(value) => setSearch({ site_id: value || undefined })} sites={sites} />
          <SearchField
            value={query}
            onChange={(value) => {
              setQuery(value)
              setSearch({ q: value.trim() || undefined })
            }}
            placeholder="Name, address, description…"
            label="Search SNMP devices"
            className="sm:w-60"
          />
        </div>
      </div>
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : !isLoading && all.length === 0 ? (
        <EmptyState
          illustration="network"
          title="No SNMP devices yet"
          description="Monitor a discovered asset (Discovered assets › Monitor via SNMP) or add a device by address."
          actions={canManage && <Button size="sm" onClick={() => setSearch({ edit: 'new' })}>Add device</Button>}
        />
      ) : (
        <DataTable
          data={visible}
          columns={columns}
          loading={isLoading}
          getRowId={(device) => device.id}
          onRowClick={(device) => void navigate({ to: '/network/snmp/$snmpDeviceId', params: { snmpDeviceId: device.id } })}
          initialSorting={[{ id: 'status', desc: false }]}
          caption="SNMP devices"
          empty={<div className="px-4 py-10 text-center text-dense text-muted-foreground">No devices match.</div>}
        />
      )}
      <SnmpDeviceEditor device={editing} open={canManage && (search.edit === 'new' || Boolean(editing))} onOpenChange={(open) => !open && setSearch({ edit: undefined })} />
      <Dialog open={Boolean(testing)} onOpenChange={(open) => !open && setTesting(null)}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Test {testing?.device.name}</DialogTitle>
            <DialogDescription>
              One poll of {testing?.device.ip} through the site’s probe.
            </DialogDescription>
          </DialogHeader>
          {testing?.result ? (
            <TestResultCard result={testing.result} />
          ) : (
            <p className="flex items-center gap-2 text-dense text-muted-foreground">
              <Spinner /> Asking the probe…
            </p>
          )}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Stop monitoring ${deleting?.name}?`}
        description="The device, its metric history and its SNMP alerts are removed. The discovered asset stays."
        confirmLabel="Stop monitoring"
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </PageContainer>
  )
}
