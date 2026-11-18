/* Services: live list with start/stop/restart when the agent is reachable, inventory snapshot otherwise. */
import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { Play, RefreshCw, RotateCw, Square } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { DataTable } from '@/components/common/data-table'
import { remoteApi } from '@/lib/api/endpoints'
import { keys } from '@/lib/api/queries'
import type { DeviceDetail, InventoryResponse, ListResponse, RemoteService, ServiceAction } from '@/lib/api/types'
import { deviceName } from '@/lib/devices'
import { formatNumber } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { remoteAccess } from '@/lib/remote'
import { cn } from '@/lib/utils'
import { ServicesTab } from './cockpit-inventory'
import { toastRemoteError, useDeviceGoneHandler } from './remote-hooks'
import { InlineAlert, QueryError, SearchField, UpdatedAgo } from './remote-ui'

type StateFilter = 'all' | 'running' | 'stopped' | 'failed'

const PENDING_LABEL: Record<ServiceAction, string> = { start: 'Starting…', stop: 'Stopping…', restart: 'Restarting…' }
const DONE_LABEL: Record<ServiceAction, string> = { start: 'started', stop: 'stopped', restart: 'restarted' }

function isRunning(service: RemoteService) {
  return /^(running|active)$/i.test(service.state)
}

function isFailed(service: RemoteService) {
  return /fail/i.test(service.state) || /fail/i.test(service.active ?? '')
}

/** The agent's own service can't be stopped from the console (the agent refuses). */
function isAgentService(service: RemoteService) {
  return /rustrmm/i.test(service.name)
}

function stateVariant(state: string) {
  if (/^(running|active)$/i.test(state)) return 'live' as const
  if (/fail/i.test(state)) return 'critical' as const
  if (/pending|reloading|activating|deactivating/i.test(state)) return 'info' as const
  if (/exited/i.test(state)) return 'secondary' as const
  return 'outline' as const
}

function serviceLabel(service: RemoteService) {
  return service.display_name && service.display_name !== service.name ? service.display_name : service.name
}

const START_MODE: Record<string, string> = { auto: 'Automatic', manual: 'Manual', disabled: 'Disabled', boot: 'Boot', system: 'System' }

function ActionButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            disabled={disabled}
            onClick={(event) => {
              event.stopPropagation()
              onClick()
            }}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export function ServicesTool({ device, inventory, inventoryLoading }: { device: DeviceDetail; inventory: InventoryResponse | undefined; inventoryLoading: boolean }) {
  const me = useMe()
  const access = remoteAccess(device, hasPermission(me, PERMISSIONS.remoteSystem), { permissionLabel: 'System tools' })
  if (!access.ok) {
    return (
      <ServicesTab
        device={device}
        inventory={inventory}
        loading={inventoryLoading}
        notice={
          <InlineAlert tone="info" title="Showing the last inventory snapshot">
            {access.block === 'permission' ? `Live status and controls: ${access.reason}` : `Live status and start/stop controls return when the device is reachable. ${access.reason}`}
          </InlineAlert>
        }
      />
    )
  }
  return <LiveServices device={device} />
}

function LiveServices({ device }: { device: DeviceDetail }) {
  const queryClient = useQueryClient()
  const onDeviceGone = useDeviceGoneHandler(device.id)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<StateFilter>('all')
  const [pending, setPending] = useState<Record<string, ServiceAction>>({})
  const [confirm, setConfirm] = useState<{ service: RemoteService; action: ServiceAction } | null>(null)
  const os = device.os_family

  const services = useQuery({
    queryKey: keys.remoteServices(device.id),
    queryFn: () => remoteApi.services(device.id),
    staleTime: 15_000,
    meta: { silent: true },
  })

  useEffect(() => {
    if (services.error) onDeviceGone(services.error)
  }, [services.error, onDeviceGone])

  const items = useMemo(() => services.data?.items ?? [], [services.data])
  const counts = useMemo(
    () => ({
      all: items.length,
      running: items.filter(isRunning).length,
      stopped: items.filter((item) => !isRunning(item)).length,
      failed: items.filter(isFailed).length,
    }),
    [items],
  )
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return items.filter((item) => {
      if (filter === 'running' && !isRunning(item)) return false
      if (filter === 'stopped' && isRunning(item)) return false
      if (filter === 'failed' && !isFailed(item)) return false
      return !needle || `${item.name} ${item.display_name ?? ''}`.toLowerCase().includes(needle)
    })
  }, [items, query, filter])

  const action = useMutation({
    mutationFn: ({ service, action: verb }: { service: RemoteService; action: ServiceAction }) => remoteApi.serviceAction(device.id, service.name, verb),
    meta: { silent: true },
    onMutate: ({ service, action: verb }) => setPending((prev) => ({ ...prev, [service.name]: verb })),
    onSuccess: (result, { service, action: verb }) => {
      const state = result?.data?.state
      toast.success(`${serviceLabel(service)} ${DONE_LABEL[verb]}`, { description: state ? `State: ${state}` : undefined })
      if (state) {
        queryClient.setQueryData<ListResponse<RemoteService>>(keys.remoteServices(device.id), (prev) =>
          prev ? { ...prev, items: prev.items.map((item) => (item.name === service.name ? { ...item, state } : item)) } : prev,
        )
      }
      void queryClient.invalidateQueries({ queryKey: keys.remoteServices(device.id) })
    },
    onError: (error, { service, action: verb }) => {
      onDeviceGone(error)
      toastRemoteError(error, `Couldn’t ${verb} ${serviceLabel(service)}`)
    },
    onSettled: (_data, _error, { service }) =>
      setPending((prev) => {
        const next = { ...prev }
        delete next[service.name]
        return next
      }),
  })

  function run(service: RemoteService, verb: ServiceAction) {
    if (verb === 'start') action.mutate({ service, action: verb })
    else setConfirm({ service, action: verb })
  }

  const columns = useMemo<ColumnDef<RemoteService>[]>(() => {
    const name: ColumnDef<RemoteService> = {
      id: 'name',
      accessorFn: (item) => serviceLabel(item).toLowerCase(),
      header: os === 'linux' ? 'Unit' : os === 'macos' ? 'Label' : 'Service',
      cell: ({ row }) => {
        const service = row.original
        const label = serviceLabel(service)
        return (
          <div className="min-w-0 leading-tight">
            <div className={cn('max-w-[min(48vw,26rem)] truncate font-medium', os === 'macos' && 'font-mono text-[12px]')}>{label}</div>
            {label !== service.name && <div className="max-w-[26rem] truncate font-mono text-[10.5px] text-subtle-foreground">{service.name}</div>}
          </div>
        )
      },
    }
    const state: ColumnDef<RemoteService> = {
      id: 'state',
      accessorFn: (item) => item.state,
      header: 'State',
      cell: ({ row }) => {
        const verb = pending[row.original.name]
        if (verb) {
          return (
            <Badge variant="info">
              <Spinner className="size-3" />
              {PENDING_LABEL[verb]}
            </Badge>
          )
        }
        return (
          <Badge variant={stateVariant(row.original.state)} className="capitalize">
            {row.original.state.replace(/_/g, ' ')}
          </Badge>
        )
      },
    }
    const actions: ColumnDef<RemoteService> = {
      id: 'actions',
      header: () => <span className="sr-only">Actions</span>,
      enableSorting: false,
      meta: { align: 'right' },
      cell: ({ row }) => {
        const service = row.original
        const busy = Boolean(pending[service.name])
        const running = isRunning(service)
        const agent = isAgentService(service)
        return (
          <span className="inline-flex items-center gap-0.5 opacity-70 group-hover/row:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
            {!running && (
              <ActionButton label={`Start ${serviceLabel(service)}`} disabled={busy || service.start_mode === 'disabled'} onClick={() => run(service, 'start')}>
                <Play />
              </ActionButton>
            )}
            {running && (
              <ActionButton label={agent ? 'The agent can’t stop its own service' : `Stop ${serviceLabel(service)}`} disabled={busy || agent} onClick={() => run(service, 'stop')}>
                <Square />
              </ActionButton>
            )}
            <ActionButton label={`Restart ${serviceLabel(service)}`} disabled={busy || !running} onClick={() => run(service, 'restart')}>
              <RotateCw />
            </ActionButton>
          </span>
        )
      },
    }
    if (os === 'windows') {
      return [
        name,
        state,
        {
          id: 'start_mode',
          accessorFn: (item) => item.start_mode ?? '',
          header: 'Startup',
          meta: { className: 'hidden sm:table-cell', headerClassName: 'hidden sm:table-cell' },
          cell: ({ getValue }) => {
            const value = getValue<string>()
            return <span className={cn('text-muted-foreground', value === 'disabled' && 'text-subtle-foreground')}>{START_MODE[value] ?? (value || '—')}</span>
          },
        },
        {
          id: 'account',
          accessorFn: (item) => item.account ?? '',
          header: 'Log on as',
          meta: { className: 'hidden lg:table-cell', headerClassName: 'hidden lg:table-cell' },
          cell: ({ getValue }) => <span className="font-mono text-[11.5px] text-muted-foreground">{getValue<string>() || '—'}</span>,
        },
        actions,
      ]
    }
    if (os === 'linux') {
      return [
        name,
        state,
        {
          id: 'active',
          accessorFn: (item) => item.active ?? '',
          header: 'Active',
          meta: { className: 'hidden sm:table-cell', headerClassName: 'hidden sm:table-cell' },
          cell: ({ getValue }) => {
            const value = getValue<string>()
            return <span className={cn('font-mono text-[11.5px]', value === 'active' ? 'text-live' : value === 'failed' ? 'text-critical' : 'text-muted-foreground')}>{value || '—'}</span>
          },
        },
        {
          id: 'load',
          accessorFn: (item) => item.load ?? '',
          header: 'Load',
          meta: { className: 'hidden lg:table-cell', headerClassName: 'hidden lg:table-cell' },
          cell: ({ getValue }) => <span className="font-mono text-[11.5px] text-muted-foreground">{getValue<string>() || '—'}</span>,
        },
        actions,
      ]
    }
    return [
      name,
      state,
      {
        id: 'last_exit',
        accessorFn: (item) => String(item.last_exit ?? ''),
        header: 'Last exit',
        meta: { className: 'hidden sm:table-cell', headerClassName: 'hidden sm:table-cell' },
        cell: ({ row }) => {
          const value = row.original.last_exit
          if (value === null || value === undefined || value === '') return <span className="text-subtle-foreground">—</span>
          const failed = String(value) !== '0'
          return <span className={cn('tabular font-mono text-[11.5px]', failed ? 'text-warning' : 'text-muted-foreground')}>{String(value)}</span>
        },
      },
      actions,
    ]
    // `run` only closes over setters and the stable mutation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [os, pending])

  const confirmService = confirm?.service
  return (
    <div className="grid gap-3 [&>*]:min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <SearchField value={query} onChange={setQuery} label="Search services" placeholder="Search services…" />
        <ToggleGroup value={[filter]} onValueChange={(value: string[]) => value[0] && setFilter(value[0] as StateFilter)} aria-label="Filter by state">
          <ToggleGroupItem value="all" size="sm">
            All <span className="tabular text-subtle-foreground">{formatNumber(counts.all)}</span>
          </ToggleGroupItem>
          <ToggleGroupItem value="running" size="sm">
            Running <span className="tabular text-subtle-foreground">{formatNumber(counts.running)}</span>
          </ToggleGroupItem>
          <ToggleGroupItem value="stopped" size="sm">
            Stopped <span className="tabular text-subtle-foreground">{formatNumber(counts.stopped)}</span>
          </ToggleGroupItem>
          {counts.failed > 0 && (
            <ToggleGroupItem value="failed" size="sm" className="text-critical">
              Failed <span className="tabular">{formatNumber(counts.failed)}</span>
            </ToggleGroupItem>
          )}
        </ToggleGroup>
        <div className="ml-auto flex items-center gap-2">
          {services.dataUpdatedAt > 0 && <UpdatedAgo at={services.dataUpdatedAt} className="hidden sm:inline" />}
          <Badge variant="live" className="hidden sm:inline-flex">
            Live
          </Badge>
          <Tooltip>
            <TooltipTrigger render={<Button variant="outline" size="icon-sm" aria-label="Refresh" disabled={services.isFetching} onClick={() => void services.refetch()} />}>
              <RefreshCw className={cn(services.isFetching && 'animate-spin')} />
            </TooltipTrigger>
            <TooltipContent>Refresh</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {services.error && !services.data ? (
        <QueryError error={services.error} what="services" onRetry={() => void services.refetch()} />
      ) : (
        <DataTable
          data={filtered}
          columns={columns}
          getRowId={(item) => item.name}
          loading={services.isLoading}
          initialSorting={[{ id: 'name', desc: false }]}
          virtualHeight={filtered.length > 120 ? 'min(66vh, 700px)' : undefined}
          caption="Services"
          empty={<div className="px-4 py-10 text-center text-dense text-muted-foreground">No services match.</div>}
        />
      )}

      <ConfirmDialog
        open={Boolean(confirm)}
        onOpenChange={(next) => !next && setConfirm(null)}
        title={confirm ? `${confirm.action === 'stop' ? 'Stop' : 'Restart'} ${serviceLabel(confirm.service)}?` : ''}
        description={
          confirmService && (
            <>
              {confirm.action === 'stop' ? 'Stops' : 'Restarts'} <span className="font-mono text-foreground">{confirmService.name}</span> on {deviceName(device)}.
              {confirm.action === 'stop'
                ? ' Anything that depends on it stops working until it is started again.'
                : ' Connections to it drop briefly while it restarts.'}
            </>
          )
        }
        confirmLabel={confirm?.action === 'stop' ? 'Stop service' : 'Restart service'}
        destructive={confirm?.action === 'stop'}
        onConfirm={() => {
          if (confirm) action.mutate(confirm)
          setConfirm(null)
        }}
      />
    </div>
  )
}
