/* Read-only Windows registry browser: key tree, breadcrumb path bar and values table. */
import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { ArrowUp, ChevronRight, Folder, FolderOpen, Hash, Lock, Pencil, RefreshCw, Type } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { CopyButton } from '@/components/common/copy-button'
import { DataTable } from '@/components/common/data-table'
import { remoteApi } from '@/lib/api/endpoints'
import { keys } from '@/lib/api/queries'
import type { DeviceDetail, RegistryValue } from '@/lib/api/types'
import { formatNumber } from '@/lib/format'
import { formatRegistryValue, normalizeRegistryPath, registryParent, registrySegments } from '@/lib/remote'
import { cn } from '@/lib/utils'
import { useDeviceGoneHandler } from './remote-hooks'
import { QueryError, SearchField } from './remote-ui'

const HIVE_NAMES: Record<string, string> = {
  HKLM: 'HKEY_LOCAL_MACHINE',
  HKU: 'HKEY_USERS',
  HKCR: 'HKEY_CLASSES_ROOT',
  HKCC: 'HKEY_CURRENT_CONFIG',
  HKCU: 'HKEY_CURRENT_USER',
}

function useRegistry(deviceId: string, path: string, enabled = true) {
  return useQuery({
    queryKey: keys.registry(deviceId, path),
    queryFn: () => remoteApi.registry(deviceId, path),
    staleTime: 60_000,
    enabled,
    meta: { silent: true },
  })
}

function ancestors(path: string): string[] {
  return registrySegments(path).map((segment) => segment.path)
}

function TreeNode({
  deviceId,
  name,
  path,
  depth,
  selected,
  expanded,
  onSelect,
  onToggle,
}: {
  deviceId: string
  name: string
  path: string
  depth: number
  selected: string
  expanded: Set<string>
  onSelect: (path: string) => void
  onToggle: (path: string) => void
}) {
  const open = expanded.has(path)
  const children = useRegistry(deviceId, path, open)
  const active = selected === path
  return (
    <li role="treeitem" aria-expanded={open} aria-selected={active}>
      <div
        className={cn(
          'group/node flex h-7 items-center gap-1 rounded-md pr-2 text-dense',
          active ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-surface-3 hover:text-foreground',
        )}
        style={{ paddingLeft: depth * 14 + 4 }}
      >
        <button type="button" aria-label={open ? `Collapse ${name}` : `Expand ${name}`} onClick={() => onToggle(path)} className="flex size-5 shrink-0 items-center justify-center rounded-sm hover:bg-surface-4">
          {open && children.isFetching && !children.data ? <Spinner className="size-3" /> : <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />}
        </button>
        <button type="button" onClick={() => onSelect(path)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          {open ? <FolderOpen className="size-3.5 shrink-0 text-primary/80" /> : <Folder className="size-3.5 shrink-0 fill-primary/10 text-primary/70" />}
          <span className={cn('truncate', depth === 0 && 'font-mono text-[12px] font-medium')}>{name}</span>
        </button>
      </div>
      {open && children.error && (
        <p className="flex items-center gap-1.5 py-1 text-micro text-subtle-foreground" style={{ paddingLeft: (depth + 1) * 14 + 26 }}>
          <Lock className="size-3" /> Not readable
        </p>
      )}
      {open && children.data && children.data.keys.length > 0 && (
        <ul role="group">
          {children.data.keys.map((key) => (
            <TreeNode
              key={key.path}
              deviceId={deviceId}
              name={key.name}
              path={key.path}
              depth={depth + 1}
              selected={selected}
              expanded={expanded}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

function ValueTypeIcon({ type }: { type: string }) {
  const numeric = /DWORD|QWORD|BINARY|NONE|RESOURCE/i.test(type)
  return numeric ? <Hash className="size-3.5 shrink-0 text-info" /> : <Type className="size-3.5 shrink-0 text-primary/80" />
}

export function RegistryTool({ device }: { device: DeviceDetail }) {
  const queryClient = useQueryClient()
  const onDeviceGone = useDeviceGoneHandler(device.id)
  const [path, setPath] = useState('HKLM\\SOFTWARE')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['HKLM', 'HKLM\\SOFTWARE']))
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [filter, setFilter] = useState('')
  const [selectedValue, setSelectedValue] = useState<string | null>(null)

  const hives = useRegistry(device.id, '')
  const current = useRegistry(device.id, path)

  useEffect(() => {
    const error = hives.error ?? current.error
    if (error) onDeviceGone(error)
  }, [hives.error, current.error, onDeviceGone])

  function navigate(next: string) {
    setPath(next)
    setFilter('')
    setSelectedValue(null)
    setEditing(false)
    setExpanded((prev) => {
      const merged = new Set(prev)
      for (const ancestor of ancestors(next).slice(0, -1)) merged.add(ancestor)
      return merged
    })
  }

  function toggle(target: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(target)) next.delete(target)
      else next.add(target)
      return next
    })
  }

  const values = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const list = current.data?.values ?? []
    return needle ? list.filter((value) => `${value.name} ${value.data}`.toLowerCase().includes(needle)) : list
  }, [current.data, filter])
  const subkeys = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const list = current.data?.keys ?? []
    return needle ? list.filter((key) => key.name.toLowerCase().includes(needle)) : list
  }, [current.data, filter])

  const detail = values.find((value) => value.name === selectedValue) ?? null
  const segments = registrySegments(path)
  const parent = registryParent(path)

  const columns = useMemo<ColumnDef<RegistryValue>[]>(
    () => [
      {
        id: 'name',
        accessorFn: (value) => (value.name === '(Default)' ? '' : value.name.toLowerCase()),
        header: 'Name',
        cell: ({ row }) => (
          <span className="flex min-w-0 items-center gap-2">
            <ValueTypeIcon type={row.original.type} />
            <span className={cn('max-w-[min(40vw,18rem)] truncate', row.original.name === '(Default)' && 'text-muted-foreground italic')}>{row.original.name}</span>
          </span>
        ),
      },
      {
        id: 'type',
        accessorFn: (value) => value.type,
        header: 'Type',
        meta: { className: 'hidden sm:table-cell', headerClassName: 'hidden sm:table-cell' },
        cell: ({ getValue }) => <span className="font-mono text-[11px] text-muted-foreground">{getValue<string>()}</span>,
      },
      {
        id: 'data',
        accessorFn: (value) => value.data,
        header: 'Data',
        enableSorting: false,
        cell: ({ row }) => {
          const display = formatRegistryValue(row.original.type, row.original.data)
          return (
            <span className={cn('block max-w-[min(52vw,40rem)] truncate font-mono text-[11.5px]', row.original.data === '' ? 'text-subtle-foreground' : 'text-foreground/85')} title={display.summary}>
              {display.summary}
            </span>
          )
        },
      },
    ],
    [],
  )

  return (
    <div className="grid gap-3 [&>*]:min-w-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline" size="icon-sm" aria-label="Parent key" disabled={!parent} onClick={() => parent && navigate(parent)} />}>
            <ArrowUp />
          </TooltipTrigger>
          <TooltipContent>Parent key</TooltipContent>
        </Tooltip>
        {editing ? (
          <form
            className="min-w-0 flex-1"
            onSubmit={(event) => {
              event.preventDefault()
              navigate(normalizeRegistryPath(draft))
            }}
          >
            <Input
              autoFocus
              value={draft}
              spellCheck={false}
              aria-label="Registry path"
              placeholder="HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion"
              className="h-8 font-mono text-[12.5px]"
              onChange={(event) => setDraft(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
              onBlur={() => setEditing(false)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation()
                  setEditing(false)
                }
              }}
            />
          </form>
        ) : (
          <div
            className="group/path flex h-8 min-w-0 flex-1 cursor-text items-center rounded-lg border border-input bg-surface-1 px-1 dark:bg-black/25"
            onClick={(event) => {
              if (!(event.target as HTMLElement).closest('button')) {
                setDraft(path)
                setEditing(true)
              }
            }}
          >
            <nav aria-label="Current key" className="flex min-w-0 flex-1 items-center overflow-x-auto [scrollbar-width:none]">
              <ol className="flex min-w-max items-center">
                <li className="flex items-center">
                  <button type="button" onClick={() => navigate('')} className="h-6 rounded-md px-1.5 text-dense text-muted-foreground hover:bg-surface-3">
                    Computer
                  </button>
                  {segments.length > 0 && <ChevronRight className="size-3.5 text-subtle-foreground" />}
                </li>
                {segments.map((segment, index) => (
                  <li key={segment.path} className="flex items-center">
                    <button
                      type="button"
                      onClick={() => navigate(segment.path)}
                      className={cn('h-6 max-w-56 truncate rounded-md px-1.5 font-mono text-[12px] hover:bg-surface-3', index === segments.length - 1 ? 'font-medium text-foreground' : 'text-muted-foreground')}
                    >
                      {segment.label}
                    </button>
                    {index < segments.length - 1 && <ChevronRight className="size-3.5 text-subtle-foreground" />}
                  </li>
                ))}
              </ol>
            </nav>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Edit path"
              className="opacity-60 group-hover/path:opacity-100"
              onClick={() => {
                setDraft(path)
                setEditing(true)
              }}
            >
              <Pencil />
            </Button>
          </div>
        )}
        <CopyButton value={path} label="Copy key path" />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Refresh"
                disabled={current.isFetching}
                onClick={() => void queryClient.invalidateQueries({ queryKey: keys.registry(device.id, path) })}
              />
            }
          >
            <RefreshCw className={cn(current.isFetching && 'animate-spin')} />
          </TooltipTrigger>
          <TooltipContent>Refresh</TooltipContent>
        </Tooltip>
      </div>

      <div className="grid overflow-hidden rounded-xl bg-card shadow-card lg:grid-cols-[18rem_1fr]">
        {/* Tree */}
        <div className="hidden max-h-[min(70vh,760px)] overflow-auto border-r border-border p-2 lg:block">
          {hives.isLoading ? (
            <div className="grid gap-1.5 p-1">
              {Array.from({ length: 4 }, (_, index) => (
                <Skeleton key={index} className="h-6" />
              ))}
            </div>
          ) : hives.error ? (
            <p className="p-2 text-micro text-muted-foreground">Couldn’t list the hives.</p>
          ) : (
            <ul role="tree" aria-label="Registry keys">
              {(hives.data?.keys ?? []).map((hive) => (
                <TreeNode
                  key={hive.path}
                  deviceId={device.id}
                  name={hive.name}
                  path={hive.path}
                  depth={0}
                  selected={path}
                  expanded={expanded}
                  onSelect={navigate}
                  onToggle={toggle}
                />
              ))}
            </ul>
          )}
        </div>

        {/* Key contents */}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-dense font-medium">{segments.at(-1)?.label ?? 'Computer'}</p>
              <p className="truncate font-mono text-[11px] text-subtle-foreground">
                {path ? path.replace(/^[^\\]+/, (hive) => HIVE_NAMES[hive] ?? hive) : 'Registry hives'}
              </p>
            </div>
            {current.data && (
              <span className="tabular text-micro text-muted-foreground">
                {formatNumber(current.data.keys.length)} {current.data.keys.length === 1 ? 'key' : 'keys'} · {formatNumber(current.data.values.length)}{' '}
                {current.data.values.length === 1 ? 'value' : 'values'}
              </span>
            )}
            <SearchField value={filter} onChange={setFilter} label="Filter keys and values" placeholder="Filter…" className="sm:w-48" />
          </div>

          {current.error ? (
            <div className="p-4">
              <QueryError error={current.error} what="this key" onRetry={() => void current.refetch()} />
              {parent !== null && (
                <Button variant="ghost" size="sm" className="mt-3" onClick={() => navigate(parent)}>
                  <ArrowUp data-icon="inline-start" />
                  Back to parent key
                </Button>
              )}
            </div>
          ) : (
            <>
              {(current.isLoading || subkeys.length > 0) && (
                <div className="border-b border-border px-3 py-2.5">
                  <div className="eyebrow mb-1.5 px-1">Keys</div>
                  {current.isLoading ? (
                    <div className="flex gap-2 px-1">
                      <Skeleton className="h-7 w-28" />
                      <Skeleton className="h-7 w-36" />
                      <Skeleton className="h-7 w-24" />
                    </div>
                  ) : (
                    <ul className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
                      {subkeys.map((key) => (
                        <li key={key.path}>
                          <button
                            type="button"
                            onClick={() => navigate(key.path)}
                            className="inline-flex h-7 max-w-64 items-center gap-1.5 rounded-md bg-surface-2 px-2 text-dense ring-1 ring-border transition-colors hover:bg-surface-3"
                          >
                            <Folder className="size-3.5 shrink-0 fill-primary/10 text-primary/70" />
                            <span className="truncate">{key.name}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {path !== '' && (
                <DataTable
                  data={values}
                  columns={columns}
                  getRowId={(value) => value.name}
                  loading={current.isLoading}
                  activeRowId={selectedValue}
                  onRowClick={(value) => setSelectedValue((prev) => (prev === value.name ? null : value.name))}
                  initialSorting={[{ id: 'name', desc: false }]}
                  caption="Registry values"
                  className="rounded-none shadow-none"
                  empty={<div className="px-4 py-8 text-center text-dense text-muted-foreground">{filter ? 'No values match.' : 'This key has no values.'}</div>}
                />
              )}
              {detail && (
                <div className="border-t border-border bg-surface-2/60 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <ValueTypeIcon type={detail.type} />
                    <span className="min-w-0 truncate text-dense font-medium">{detail.name}</span>
                    <span className="font-mono text-[11px] text-subtle-foreground">{detail.type}</span>
                    <span className="ml-auto">
                      <CopyButton value={detail.data} label="Copy data" />
                    </span>
                  </div>
                  <pre className="mt-2 max-h-56 overflow-auto rounded-lg bg-card px-3 py-2 font-mono text-[12px] leading-relaxed break-all whitespace-pre-wrap ring-1 ring-border">
                    {formatRegistryValue(detail.type, detail.data).full || ' '}
                  </pre>
                  {/BINARY/i.test(detail.type) && detail.data.replace(/[^0-9a-f]/gi, '').length >= 512 && (
                    <p className="mt-1.5 text-micro text-subtle-foreground">Binary data is truncated after 256 bytes.</p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      <p className="text-micro text-subtle-foreground">The registry is read-only from the console.</p>
    </div>
  )
}
