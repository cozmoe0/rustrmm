/* Event logs: Windows channels, the systemd journal or the macOS unified log. */
import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, CircleExclamationPoint, Info, OctagonExclamationPoint, RefreshCw, TriangleExclamationPoint } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { CopyButton } from '@/components/common/copy-button'
import { EmptyState } from '@/components/common/empty-state'
import { SimpleSelect } from '@/components/common/simple-select'
import { remoteApi } from '@/lib/api/endpoints'
import { keys } from '@/lib/api/queries'
import type { DeviceDetail, EventLogEntry, EventLogQuery } from '@/lib/api/types'
import { formatDateTime, formatNumber, formatRelative } from '@/lib/format'
import { EVENT_LEVEL_FILTERS, EVENT_WINDOWS, WINDOWS_EVENT_LOGS, eventLevel, type EventTone } from '@/lib/remote'
import { cn } from '@/lib/utils'
import { useDeviceGoneHandler } from './remote-hooks'
import { QueryError, SearchField, UpdatedAgo } from './remote-ui'

const CUSTOM = '__custom__'
const LIMITS = [100, 200, 500, 1000]

const TONE_STYLE: Record<EventTone, { icon: typeof Info; text: string; bar: string }> = {
  critical: { icon: OctagonExclamationPoint, text: 'text-critical', bar: 'bg-critical' },
  error: { icon: CircleExclamationPoint, text: 'text-critical', bar: 'bg-critical/70' },
  warning: { icon: TriangleExclamationPoint, text: 'text-warning', bar: 'bg-warning' },
  info: { icon: Info, text: 'text-info', bar: 'bg-transparent' },
  verbose: { icon: Info, text: 'text-subtle-foreground', bar: 'bg-transparent' },
}

function EventRow({ entry, expanded, onToggle, windows }: { entry: EventLogEntry; expanded: boolean; onToggle: () => void; windows: boolean }) {
  const level = eventLevel(entry.level)
  const tone = TONE_STYLE[level.tone]
  const Icon = tone.icon
  const firstLine = entry.message.split(/\r?\n/).find((line) => line.trim()) ?? ''
  return (
    <li className="relative [content-visibility:auto] [contain-intrinsic-size:auto_44px]">
      <span className={cn('absolute inset-y-0 left-0 w-0.5', tone.bar)} aria-hidden="true" />
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="grid w-full grid-cols-[auto_1fr] items-start gap-x-3 px-4 py-2 text-left outline-none hover:bg-surface-3/50 focus-visible:bg-surface-3/70 sm:grid-cols-[auto_9.5rem_minmax(8rem,13rem)_1fr]"
      >
        <span className="flex items-center gap-1.5 pt-0.5">
          <ChevronRight className={cn('size-3.5 text-subtle-foreground transition-transform', expanded && 'rotate-90')} />
          <Icon className={cn('size-4', tone.text)} aria-label={level.label} />
        </span>
        <span className="tabular hidden pt-0.5 text-dense text-muted-foreground sm:block" title={formatRelative(entry.time)}>
          {formatDateTime(entry.time)}
        </span>
        <span className="hidden min-w-0 pt-0.5 sm:block">
          <span className="block truncate text-dense font-medium">{entry.source ?? '—'}</span>
          {windows && entry.id !== null && <span className="font-mono text-[10.5px] text-subtle-foreground">Event {entry.id}</span>}
        </span>
        <span className="min-w-0">
          <span className="flex flex-wrap items-baseline gap-x-2 text-micro text-muted-foreground sm:hidden">
            <span className="font-medium text-foreground">{entry.source ?? '—'}</span>
            <span className="tabular">{formatRelative(entry.time)}</span>
            {windows && entry.id !== null && <span className="font-mono">#{entry.id}</span>}
          </span>
          <span className={cn('block truncate text-dense', expanded && 'font-medium')}>{firstLine}</span>
        </span>
      </button>
      {expanded && (
        <div className="relative mx-4 mb-3 ml-11 rounded-lg bg-surface-2 ring-1 ring-border sm:ml-[3.25rem]">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-3 py-2 text-micro text-muted-foreground">
            <span>
              <span className="text-subtle-foreground">Level</span> <span className={cn('font-medium', tone.text)}>{level.label}</span>
            </span>
            <span>
              <span className="text-subtle-foreground">Logged</span> <span className="tabular text-foreground">{formatDateTime(entry.time)}</span>
            </span>
            {entry.source && (
              <span>
                <span className="text-subtle-foreground">Source</span> <span className="text-foreground">{entry.source}</span>
              </span>
            )}
            {entry.id !== null && (
              <span>
                <span className="text-subtle-foreground">Event ID</span> <span className="font-mono text-foreground">{entry.id}</span>
              </span>
            )}
            <span className="ml-auto">
              <CopyButton value={entry.message} label="Copy message" />
            </span>
          </div>
          <pre className="max-h-80 overflow-auto px-3 py-2.5 font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap text-foreground/90">{entry.message}</pre>
        </div>
      )}
    </li>
  )
}

export function EventLogsTool({ device }: { device: DeviceDetail }) {
  const onDeviceGone = useDeviceGoneHandler(device.id)
  const os = device.os_family
  const windows = os === 'windows'
  const [preset, setPreset] = useState<string>(windows ? 'System' : 'system')
  const [custom, setCustom] = useState('')
  const [appliedCustom, setAppliedCustom] = useState('')
  const [level, setLevel] = useState(windows ? 3 : 0)
  const [hours, setHours] = useState(24)
  const [limit, setLimit] = useState(200)
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  const log = preset === CUSTOM ? appliedCustom.trim() : preset === 'system' ? '' : preset
  const params: EventLogQuery = { log, level, limit, hours }
  const waitingForCustom = preset === CUSTOM && !appliedCustom.trim()

  const events = useQuery({
    queryKey: keys.eventLogs(device.id, params),
    queryFn: () => remoteApi.eventLogs(device.id, params),
    enabled: !waitingForCustom,
    staleTime: 30_000,
    meta: { silent: true },
  })

  useEffect(() => {
    if (events.error) onDeviceGone(events.error)
  }, [events.error, onDeviceGone])

  const items = useMemo(() => events.data?.items ?? [], [events.data])
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const keyed = items.map((entry, index) => ({ entry, key: `${entry.time}#${index}` }))
    if (!needle) return keyed
    return keyed.filter(({ entry }) => `${entry.source ?? ''} ${entry.message} ${entry.id ?? ''}`.toLowerCase().includes(needle))
  }, [items, search])

  const counts = useMemo(() => {
    const result = { critical: 0, error: 0, warning: 0 }
    for (const item of items) {
      const tone = eventLevel(item.level).tone
      if (tone === 'critical') result.critical += 1
      else if (tone === 'error') result.error += 1
      else if (tone === 'warning') result.warning += 1
    }
    return result
  }, [items])

  const logOptions = windows
    ? [
        ...WINDOWS_EVENT_LOGS.map((name) => ({ value: name, label: name, group: 'Windows logs' })),
        { value: CUSTOM, label: 'Custom channel…', group: 'Applications and services' },
      ]
    : os === 'linux'
      ? [
          { value: 'system', label: 'All (journal)' },
          { value: CUSTOM, label: 'Unit…' },
        ]
      : [{ value: 'system', label: 'Unified log' }]

  const resetExpanded = () => setExpanded(new Set())
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  return (
    <div className="grid gap-3 [&>*]:min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <SimpleSelect
          value={preset}
          onValueChange={(value) => {
            setPreset(value)
            resetExpanded()
          }}
          options={logOptions}
          size="sm"
          className="w-[170px]"
          ariaLabel={windows ? 'Event log' : 'Log source'}
          disabled={os === 'macos'}
        />
        {preset === CUSTOM && (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault()
              setAppliedCustom(custom.trim())
              resetExpanded()
            }}
          >
            <Input
              autoFocus
              value={custom}
              onChange={(event) => setCustom(event.target.value)}
              placeholder={windows ? 'Microsoft-Windows-PowerShell/Operational' : 'nginx.service'}
              aria-label={windows ? 'Channel name' : 'Unit name'}
              spellCheck={false}
              className="h-7 w-[min(72vw,20rem)] font-mono text-[12px]"
            />
            <Button type="submit" size="sm" variant="outline" disabled={!custom.trim()}>
              Open
            </Button>
          </form>
        )}
        <SimpleSelect
          value={String(level)}
          onValueChange={(value) => {
            setLevel(Number(value))
            resetExpanded()
          }}
          options={EVENT_LEVEL_FILTERS.map((option) => ({ value: String(option.value), label: option.label }))}
          size="sm"
          className="w-[180px]"
          ariaLabel="Minimum level"
        />
        <ToggleGroup
          value={[String(hours)]}
          onValueChange={(value: string[]) => {
            if (!value[0]) return
            setHours(Number(value[0]))
            resetExpanded()
          }}
          aria-label="Time window"
          variant="outline"
          spacing={0}
          size="sm"
        >
          {EVENT_WINDOWS.map((option) => (
            <ToggleGroupItem key={option.value} value={String(option.value)} size="sm" className="px-2.5 tabular">
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <SimpleSelect
          value={String(limit)}
          onValueChange={(value) => setLimit(Number(value))}
          options={LIMITS.map((value) => ({ value: String(value), label: `${value} events` }))}
          size="sm"
          className="w-[124px]"
          ariaLabel="Maximum events"
        />
        <div className="ml-auto flex items-center gap-2">
          {events.dataUpdatedAt > 0 && <UpdatedAgo at={events.dataUpdatedAt} className="hidden md:inline" />}
          <Tooltip>
            <TooltipTrigger render={<Button variant="outline" size="icon-sm" aria-label="Refresh" disabled={events.isFetching || waitingForCustom} onClick={() => void events.refetch()} />}>
              <RefreshCw className={cn(events.isFetching && 'animate-spin')} />
            </TooltipTrigger>
            <TooltipContent>Query again</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl bg-card shadow-card">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2.5">
          <div className="min-w-0">
            <p className="text-dense font-medium">
              {os === 'macos' ? 'Unified log' : windows ? (log || 'System') : log ? `Unit ${log}` : 'System journal'}
            </p>
            <p className="tabular text-micro text-muted-foreground">
              {events.isLoading
                ? 'Querying the device…'
                : events.data
                  ? `${formatNumber(items.length)} ${items.length === 1 ? 'event' : 'events'} in the last ${hours === 168 ? '7 days' : hours === 1 ? 'hour' : `${hours} hours`}${items.length >= limit ? ` · limited to ${limit}` : ''}`
                  : waitingForCustom
                    ? `Enter a ${windows ? 'channel' : 'unit'} name to query it.`
                    : ''}
            </p>
          </div>
          {items.length > 0 && (
            <div className="flex items-center gap-3 text-micro">
              {counts.critical > 0 && (
                <span className="flex items-center gap-1 text-critical">
                  <OctagonExclamationPoint className="size-3.5" />
                  <span className="tabular font-medium">{counts.critical}</span> critical
                </span>
              )}
              <span className={cn('flex items-center gap-1', counts.error > 0 ? 'text-critical' : 'text-subtle-foreground')}>
                <CircleExclamationPoint className="size-3.5" />
                <span className="tabular font-medium">{counts.error}</span> {counts.error === 1 ? 'error' : 'errors'}
              </span>
              <span className={cn('flex items-center gap-1', counts.warning > 0 ? 'text-warning' : 'text-subtle-foreground')}>
                <TriangleExclamationPoint className="size-3.5" />
                <span className="tabular font-medium">{counts.warning}</span> {counts.warning === 1 ? 'warning' : 'warnings'}
              </span>
            </div>
          )}
          <SearchField value={search} onChange={setSearch} label="Search events" placeholder="Search messages…" className="sm:ml-auto sm:w-60" />
        </div>

        {events.error ? (
          <div className="p-4">
            <QueryError error={events.error} what="this log" onRetry={() => void events.refetch()} />
          </div>
        ) : events.isLoading ? (
          <div className="divide-y divide-border">
            {Array.from({ length: 8 }, (_, index) => (
              <div key={index} className="flex items-center gap-4 px-4 py-3">
                <Skeleton className="size-4 rounded-full" />
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-3.5 w-28" />
                <Skeleton className="h-3.5 flex-1" />
              </div>
            ))}
          </div>
        ) : waitingForCustom ? null : filtered.length === 0 ? (
          <EmptyState
            compact
            className="m-4 border-border"
            illustration="search"
            title={search ? `No events match “${search}”` : 'No events in this window'}
            description={search ? 'Try another search term.' : 'Widen the time window or lower the minimum level.'}
          />
        ) : (
          <ul className="max-h-[min(66vh,720px)] divide-y divide-border overflow-y-auto">
            {filtered.map(({ entry, key }) => (
              <EventRow key={key} entry={entry} windows={windows} expanded={expanded.has(key)} onToggle={() => toggle(key)} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
