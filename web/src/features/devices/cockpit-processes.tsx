/* Live process list with search, auto-refresh and End process. */
import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { CircleStop, Copy, Ellipsis, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { DataTable } from '@/components/common/data-table'
import { copyText } from '@/lib/clipboard'
import { remoteApi } from '@/lib/api/endpoints'
import { keys } from '@/lib/api/queries'
import type { DeviceDetail, ProcessList, RemoteProcess } from '@/lib/api/types'
import { deviceName } from '@/lib/devices'
import { formatBytes, formatDateTime, formatNumber, formatRelative } from '@/lib/format'
import { createStore, useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { toastRemoteError, useDeviceGoneHandler } from './remote-hooks'
import { QueryError, SearchField, UpdatedAgo } from './remote-ui'

const AUTO_REFRESH_MS = 5000
const autoRefreshStore = createStore(true, { key: 'rustrmm.processes.auto' })

function CpuCell({ value }: { value: number }) {
  const tone = value >= 50 ? 'bg-critical' : value >= 20 ? 'bg-warning' : 'bg-live'
  return (
    <span className="flex items-center justify-end gap-2">
      <span className="relative hidden h-1 w-12 overflow-hidden rounded-full bg-surface-4 sm:block" aria-hidden="true">
        <span className={cn('absolute inset-y-0 left-0 rounded-full transition-[width] duration-500', tone)} style={{ width: `${Math.min(100, Math.max(value > 0 ? 3 : 0, value))}%` }} />
      </span>
      <span className={cn('tabular w-12 text-right', value >= 20 ? 'font-medium text-foreground' : 'text-muted-foreground')}>{value.toFixed(1)}</span>
    </span>
  )
}

function descendants(items: RemoteProcess[], pid: number): number {
  const children = new Map<number, number[]>()
  for (const item of items) {
    if (item.parent === null || item.parent === item.pid) continue
    children.set(item.parent, [...(children.get(item.parent) ?? []), item.pid])
  }
  let count = 0
  const stack = [...(children.get(pid) ?? [])]
  const seen = new Set<number>()
  while (stack.length > 0) {
    const next = stack.pop()!
    if (seen.has(next)) continue
    seen.add(next)
    count += 1
    stack.push(...(children.get(next) ?? []))
  }
  return count
}

export function ProcessesTool({ device, active }: { device: DeviceDetail; active: boolean }) {
  const queryClient = useQueryClient()
  const onDeviceGone = useDeviceGoneHandler(device.id)
  const auto = useStore(autoRefreshStore)
  const [query, setQuery] = useState('')
  const [target, setTarget] = useState<RemoteProcess | null>(null)
  const [tree, setTree] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)

  const processes = useQuery({
    queryKey: keys.processes(device.id),
    queryFn: () => remoteApi.processes(device.id),
    refetchInterval: auto && active ? AUTO_REFRESH_MS : false,
    refetchIntervalInBackground: false,
    staleTime: 2000,
    meta: { silent: true },
  })

  useEffect(() => {
    if (processes.error) onDeviceGone(processes.error)
  }, [processes.error, onDeviceGone])

  const items = useMemo(() => processes.data?.items ?? [], [processes.data])
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return items
    return items.filter((item) => `${item.name} ${item.pid} ${item.user ?? ''} ${item.exe ?? ''}`.toLowerCase().includes(needle))
  }, [items, query])

  const totalCpu = items.reduce((sum, item) => sum + item.cpu, 0)
  const totalMemory = items.reduce((sum, item) => sum + item.memory, 0)
  const childCount = target ? descendants(items, target.pid) : 0

  const kill = useMutation({
    mutationFn: ({ process, includeTree }: { process: RemoteProcess; includeTree: boolean }) => remoteApi.killProcess(device.id, process.pid, includeTree),
    meta: { silent: true },
    onSuccess: (result, { process }) => {
      const terminated = result?.data?.terminated ?? 1
      toast.success(`Ended ${result?.data?.name ?? process.name}`, {
        description: terminated > 1 ? `${terminated} processes terminated, including child processes.` : `PID ${process.pid}`,
      })
      setTarget(null)
      queryClient.setQueryData<ProcessList>(keys.processes(device.id), (prev) =>
        prev ? { ...prev, items: prev.items.filter((item) => item.pid !== process.pid), count: Math.max(0, prev.count - 1) } : prev,
      )
      void queryClient.invalidateQueries({ queryKey: keys.processes(device.id) })
    },
    onError: (error, { process }) => {
      onDeviceGone(error)
      toastRemoteError(error, `Couldn’t end ${process.name}`)
    },
  })

  function confirmKill(process: RemoteProcess) {
    setTree(false)
    setTarget(process)
  }

  const columns = useMemo<ColumnDef<RemoteProcess>[]>(
    () => [
      {
        id: 'name',
        accessorFn: (item) => item.name.toLowerCase(),
        header: 'Name',
        cell: ({ row }) => (
          <div className="min-w-0 leading-tight">
            <div className="max-w-[min(40vw,22rem)] truncate font-medium" title={row.original.exe ?? row.original.name}>
              {row.original.name}
            </div>
            {row.original.exe && <div className="hidden max-w-[22rem] truncate font-mono text-[10.5px] text-subtle-foreground lg:block">{row.original.exe}</div>}
          </div>
        ),
      },
      {
        id: 'pid',
        accessorFn: (item) => item.pid,
        header: 'PID',
        meta: { align: 'right' },
        cell: ({ getValue }) => <span className="tabular font-mono text-[11.5px] text-muted-foreground">{getValue<number>()}</span>,
      },
      {
        id: 'user',
        accessorFn: (item) => (item.user ?? '').toLowerCase(),
        header: 'User',
        meta: { className: 'hidden md:table-cell', headerClassName: 'hidden md:table-cell' },
        cell: ({ row }) => <span className="block max-w-44 truncate text-muted-foreground">{row.original.user ?? '—'}</span>,
      },
      {
        id: 'cpu',
        accessorFn: (item) => item.cpu,
        header: 'CPU %',
        sortDescFirst: true,
        meta: { align: 'right' },
        cell: ({ getValue }) => <CpuCell value={getValue<number>()} />,
      },
      {
        id: 'memory',
        accessorFn: (item) => item.memory,
        header: 'Memory',
        sortDescFirst: true,
        meta: { align: 'right' },
        cell: ({ getValue }) => <span className="tabular text-muted-foreground">{formatBytes(getValue<number>())}</span>,
      },
      {
        id: 'started',
        accessorFn: (item) => item.started_at ?? 0,
        header: 'Started',
        sortDescFirst: true,
        meta: { className: 'hidden lg:table-cell', headerClassName: 'hidden lg:table-cell' },
        cell: ({ row }) =>
          row.original.started_at ? (
            <Tooltip>
              <TooltipTrigger render={<span className="tabular text-muted-foreground" />}>{formatRelative(row.original.started_at * 1000)}</TooltipTrigger>
              <TooltipContent>{formatDateTime(row.original.started_at * 1000)}</TooltipContent>
            </Tooltip>
          ) : (
            <span className="text-subtle-foreground">—</span>
          ),
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        size: 44,
        meta: { align: 'right' },
        cell: ({ row }) => (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Actions for ${row.original.name}`}
                  className="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
                  onClick={(event) => event.stopPropagation()}
                />
              }
            >
              <Ellipsis />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuGroup>
                <DropdownMenuLabel className="truncate">
                  {row.original.name} · {row.original.pid}
                </DropdownMenuLabel>
                {row.original.exe && (
                  <DropdownMenuItem
                    onClick={async () => {
                      if (await copyText(row.original.exe ?? '')) toast.success('Path copied')
                    }}
                  >
                    <Copy />
                    Copy executable path
                  </DropdownMenuItem>
                )}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => confirmKill(row.original)}>
                <CircleStop />
                End process…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ],
    [],
  )

  const selectedProcess = filtered.find((item) => String(item.pid) === selected) ?? null

  return (
    <div className="grid gap-3 [&>*]:min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <SearchField value={query} onChange={setQuery} label="Search processes" placeholder="Search name, PID, user…" />
        <span className="tabular text-dense text-muted-foreground">
          {query ? `${formatNumber(filtered.length)} of ${formatNumber(items.length)}` : formatNumber(processes.data?.count ?? items.length)} processes
          {items.length > 0 && (
            <span className="hidden sm:inline">
              {' '}
              · CPU {Math.min(100, totalCpu).toFixed(0)}% · {formatBytes(totalMemory)} in use
            </span>
          )}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {processes.dataUpdatedAt > 0 && <UpdatedAgo at={processes.dataUpdatedAt} className="hidden sm:inline" />}
          <Label className="flex h-8 items-center gap-2 px-1 text-dense font-normal text-muted-foreground">
            <Switch size="sm" checked={auto} onCheckedChange={(checked) => autoRefreshStore.set(checked)} />
            Auto-refresh <span className="text-subtle-foreground">5s</span>
          </Label>
          <Tooltip>
            <TooltipTrigger
              render={<Button variant="outline" size="icon-sm" aria-label="Refresh now" disabled={processes.isFetching} onClick={() => void processes.refetch()} />}
            >
              <RefreshCw className={cn(processes.isFetching && 'animate-spin')} />
            </TooltipTrigger>
            <TooltipContent>Refresh now</TooltipContent>
          </Tooltip>
          <Button
            variant="destructive-soft"
            size="sm"
            disabled={!selectedProcess}
            onClick={() => selectedProcess && confirmKill(selectedProcess)}
          >
            <CircleStop data-icon="inline-start" />
            End process
          </Button>
        </div>
      </div>

      {processes.error && !processes.data ? (
        <QueryError error={processes.error} what="processes" onRetry={() => void processes.refetch()} />
      ) : (
        <>
          {processes.error && <QueryError error={processes.error} what="the latest process list" onRetry={() => void processes.refetch()} />}
          <DataTable
            data={filtered}
            columns={columns}
            getRowId={(item) => String(item.pid)}
            loading={processes.isLoading}
            initialSorting={[{ id: 'cpu', desc: true }]}
            virtualHeight="min(66vh, 700px)"
            activeRowId={selected}
            onRowClick={(item) => setSelected(String(item.pid))}
            caption="Running processes"
            empty={<div className="px-4 py-10 text-center text-dense text-muted-foreground">No processes match “{query}”.</div>}
          />
        </>
      )}

      <ConfirmDialog
        open={Boolean(target)}
        onOpenChange={(next) => !next && setTarget(null)}
        title={`End ${target?.name ?? 'process'}?`}
        description={
          <>
            Terminates PID <span className="font-mono text-foreground">{target?.pid}</span> on {deviceName(device)} immediately. Unsaved work in the
            process is lost.
          </>
        }
        confirmLabel={tree && childCount > 0 ? `End ${childCount + 1} processes` : 'End process'}
        pending={kill.isPending}
        onConfirm={() => target && kill.mutate({ process: target, includeTree: tree })}
      >
        <Label className="flex items-start gap-2.5 rounded-lg bg-surface-2 px-3 py-2.5 text-dense font-normal ring-1 ring-border">
          <Checkbox className="mt-0.5" checked={tree} onCheckedChange={(checked) => setTree(checked === true)} />
          <span>
            <span className="font-medium">Also end child processes</span>
            <span className="block text-micro text-muted-foreground">
              {childCount > 0 ? `${childCount} child ${childCount === 1 ? 'process' : 'processes'} in the current list.` : 'No child processes in the current list.'}
            </span>
          </span>
        </Label>
      </ConfirmDialog>
    </div>
  )
}
