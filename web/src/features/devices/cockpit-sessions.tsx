/* Remote session history for a device: desktops, shells and file transfers, live sessions and recordings. */
import { lazy, Suspense, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { CirclePlay, Download, MonitorPlay, RefreshCw, SquareTerminal, Unplug, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { DataTable } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { RelativeTime } from '@/components/common/misc'
import { remoteApi } from '@/lib/api/endpoints'
import { keys } from '@/lib/api/queries'
import { useStreamEvent } from '@/lib/api/stream'
import type { DeviceDetail, RemoteSession, RemoteSessionEvent } from '@/lib/api/types'
import { deviceName } from '@/lib/devices'
import { formatBytes, formatClock, formatNumber, formatSpan } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { shellLabel } from '@/lib/remote'
import { cn } from '@/lib/utils'
import { useNow, toastRemoteError } from './remote-hooks'
import { playbackRequestStore, usePlaybackRequest } from './remote-state'
import { QueryError, SearchField } from './remote-ui'

const RecordingPlayer = lazy(() => import('./cockpit-recording-player'))

type KindFilter = 'all' | 'desktop' | 'shell' | 'transfer'

const KIND_META = {
  desktop: { icon: MonitorPlay, label: 'Remote desktop' },
  shell: { icon: SquareTerminal, label: 'Shell' },
  download: { icon: Download, label: 'Download' },
  upload: { icon: Upload, label: 'Upload' },
} as const

const CONSENT_LABEL = { not_required: 'no consent needed', granted: 'consent granted', denied: 'consent denied', timeout: 'consent timed out' } as const

function sessionDetail(session: RemoteSession): string {
  if (session.kind === 'shell') return shellLabel(session.detail?.shell)
  if (session.kind === 'desktop') {
    const detail = session.detail ?? {}
    const parts = [detail.view_only ? 'View only' : 'Control', detail.quality ? `${detail.quality} quality` : null, detail.consent ? CONSENT_LABEL[detail.consent] : null]
    return parts.filter(Boolean).join(' · ')
  }
  return fileName(session.detail?.path)
}

function sessionDuration(session: RemoteSession, now: number): number | null {
  const start = session.connected_at ?? session.started_at
  if (!start) return null
  const end = session.ended_at ? new Date(session.ended_at).getTime() : session.live ? now : null
  return end === null ? null : Math.max(0, (end - new Date(start).getTime()) / 1000)
}

function fileName(path: string | undefined) {
  if (!path) return ''
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function LiveDuration({ session }: { session: RemoteSession }) {
  const now = useNow(1000)
  const seconds = sessionDuration(session, now) ?? 0
  return <span className="tabular font-mono text-[12px] text-live">{formatClock(seconds)}</span>
}

export function SessionsTool({ device }: { device: DeviceDetail }) {
  const me = useMe()
  const queryClient = useQueryClient()
  const canPlay = hasPermission(me, PERMISSIONS.remoteRecordings)
  const canEndShell = hasPermission(me, PERMISSIONS.remoteShell)
  const canEndDesktop = hasPermission(me, PERMISSIONS.remoteDesktop)
  const [filter, setFilter] = useState<KindFilter>('all')
  const [query, setQuery] = useState('')
  const [playing, setPlaying] = useState<string | null>(null)
  const [ending, setEnding] = useState<RemoteSession | null>(null)
  const requested = usePlaybackRequest()

  const sessions = useQuery({
    queryKey: keys.remoteSessions(device.id),
    queryFn: () => remoteApi.sessions(device.id, 100),
    staleTime: 10_000,
    refetchInterval: (query) => (query.state.data?.items.some((item) => item.live) ? 15_000 : false),
    meta: { silent: true },
  })

  useStreamEvent<RemoteSessionEvent>('remote.session', (event) => {
    if (event?.device_id === device.id) void queryClient.invalidateQueries({ queryKey: keys.remoteSessions(device.id) })
  })

  const items = useMemo(() => sessions.data?.items ?? [], [sessions.data])
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return items.filter((item) => {
      if (filter === 'shell' && item.kind !== 'shell') return false
      if (filter === 'desktop' && item.kind !== 'desktop') return false
      if (filter === 'transfer' && item.kind !== 'download' && item.kind !== 'upload') return false
      return !needle || `${item.user_name ?? ''} ${item.detail?.path ?? ''} ${item.detail?.shell ?? ''} ${item.end_reason ?? ''}`.toLowerCase().includes(needle)
    })
  }, [items, filter, query])
  const liveCount = items.filter((item) => item.live).length

  // A "Replay" request from the terminal opens once the session shows up in the list.
  const requestedSession = requested ? items.find((item) => item.id === requested && item.has_recording) : undefined
  const playerId = playing ?? requestedSession?.id ?? null
  const playerSession = items.find((item) => item.id === playerId) ?? null

  const end = useMutation({
    mutationFn: (session: RemoteSession) => remoteApi.endSession(session.id),
    meta: { silent: true },
    onSuccess: (_data, session) => {
      toast.success('Session ended', { description: `${session.user_name ?? 'The operator'}’s ${KIND_META[session.kind].label.toLowerCase()} session was closed.` })
      setEnding(null)
      void queryClient.invalidateQueries({ queryKey: keys.remoteSessions(device.id) })
    },
    onError: (error) => toastRemoteError(error, 'Couldn’t end the session'),
  })

  const columns = useMemo<ColumnDef<RemoteSession>[]>(
    () => [
      {
        id: 'kind',
        accessorFn: (item) => item.kind,
        header: 'Session',
        cell: ({ row }) => {
          const session = row.original
          const meta = KIND_META[session.kind]
          const Icon = meta.icon
          const detail = sessionDetail(session)
          return (
            <span className="flex min-w-0 items-center gap-2.5">
              <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-md ring-1', session.live ? 'bg-live/12 text-live ring-live/25' : 'bg-surface-3 text-muted-foreground ring-border')}>
                <Icon className="size-3.5" />
              </span>
              <span className="min-w-0 leading-tight">
                <span className="block font-medium">{meta.label}</span>
                <span className="block max-w-[min(40vw,16rem)] truncate font-mono text-[10.5px] text-subtle-foreground" title={session.detail?.path ?? undefined}>
                  {detail}
                  {session.kind === 'shell' && session.detail?.cols ? ` · ${session.detail.cols}×${session.detail.rows}` : ''}
                </span>
              </span>
            </span>
          )
        },
      },
      {
        id: 'user',
        accessorFn: (item) => (item.user_name ?? '').toLowerCase(),
        header: 'User',
        cell: ({ row }) => <span className="block max-w-40 truncate">{row.original.user_name ?? <span className="text-subtle-foreground">—</span>}</span>,
      },
      {
        id: 'started',
        accessorFn: (item) => item.started_at,
        header: 'Started',
        sortDescFirst: true,
        cell: ({ row }) => <RelativeTime value={row.original.started_at} className="text-muted-foreground" />,
      },
      {
        id: 'duration',
        accessorFn: (item) => sessionDuration(item, Date.parse(item.started_at)) ?? 0,
        header: 'Duration',
        meta: { align: 'right' },
        cell: ({ row }) =>
          row.original.live ? (
            <LiveDuration session={row.original} />
          ) : (
            <span className="tabular text-muted-foreground">{formatSpan(sessionDuration(row.original, 0))}</span>
          ),
      },
      {
        id: 'bytes',
        accessorFn: (item) => item.bytes_to_device + item.bytes_from_device,
        header: 'Data',
        meta: { align: 'right', className: 'hidden md:table-cell', headerClassName: 'hidden md:table-cell' },
        cell: ({ row }) => (
          <Tooltip>
            <TooltipTrigger render={<span className="tabular inline-flex gap-2 font-mono text-[11px] text-muted-foreground" />}>
              <span>↑ {formatBytes(row.original.bytes_to_device)}</span>
              <span>↓ {formatBytes(row.original.bytes_from_device)}</span>
            </TooltipTrigger>
            <TooltipContent>
              {formatBytes(row.original.bytes_to_device)} sent to the device · {formatBytes(row.original.bytes_from_device)} received
            </TooltipContent>
          </Tooltip>
        ),
      },
      {
        id: 'end',
        accessorFn: (item) => (item.live ? '' : (item.end_reason ?? '')),
        header: 'Status',
        cell: ({ row }) =>
          row.original.live ? (
            <Badge variant="live" className="gap-1.5">
              <span className="relative inline-flex size-1.5 animate-pulse-ring rounded-full bg-current" />
              Live
            </Badge>
          ) : (
            <span className="block max-w-52 truncate text-muted-foreground" title={row.original.end_reason ?? undefined}>
              {row.original.end_reason ?? 'Ended'}
            </span>
          ),
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        meta: { align: 'right' },
        cell: ({ row }) => {
          const session = row.original
          return (
            <span className="inline-flex items-center gap-1">
              {session.live && (session.kind === 'desktop' ? canEndDesktop : canEndShell) && (
                <Button variant="destructive-soft" size="xs" onClick={() => setEnding(session)}>
                  <Unplug data-icon="inline-start" />
                  End session
                </Button>
              )}
              {session.has_recording &&
                (canPlay ? (
                  <Button variant="outline" size="xs" onClick={() => setPlaying(session.id)} disabled={session.live}>
                    <CirclePlay data-icon="inline-start" />
                    Play
                  </Button>
                ) : (
                  <Tooltip>
                    <TooltipTrigger render={<span className="inline-flex" tabIndex={0} />}>
                      <Button variant="outline" size="xs" disabled aria-hidden="true" tabIndex={-1}>
                        <CirclePlay data-icon="inline-start" />
                        Play
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Your role doesn’t include the Shell recordings permission.</TooltipContent>
                  </Tooltip>
                ))}
            </span>
          )
        },
      },
    ],
    [canEndShell, canEndDesktop, canPlay],
  )

  return (
    <div className="grid gap-3 [&>*]:min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup value={[filter]} onValueChange={(value: string[]) => value[0] && setFilter(value[0] as KindFilter)} aria-label="Session type">
          <ToggleGroupItem value="all" size="sm">
            All <span className="tabular text-subtle-foreground">{formatNumber(items.length)}</span>
          </ToggleGroupItem>
          <ToggleGroupItem value="desktop" size="sm">
            Desktops
          </ToggleGroupItem>
          <ToggleGroupItem value="shell" size="sm">
            Shells
          </ToggleGroupItem>
          <ToggleGroupItem value="transfer" size="sm">
            File transfers
          </ToggleGroupItem>
        </ToggleGroup>
        <SearchField value={query} onChange={setQuery} label="Search sessions" placeholder="Search user, path, reason…" />
        <div className="ml-auto flex items-center gap-2">
          {liveCount > 0 && (
            <Badge variant="live" className="gap-1.5">
              <span className="relative inline-flex size-1.5 animate-pulse-ring rounded-full bg-current" />
              {liveCount} live
            </Badge>
          )}
          <Tooltip>
            <TooltipTrigger render={<Button variant="outline" size="icon-sm" aria-label="Refresh" disabled={sessions.isFetching} onClick={() => void sessions.refetch()} />}>
              <RefreshCw className={cn(sessions.isFetching && 'animate-spin')} />
            </TooltipTrigger>
            <TooltipContent>Refresh</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {sessions.error ? (
        <QueryError error={sessions.error} what="session history" onRetry={() => void sessions.refetch()} />
      ) : !sessions.isLoading && items.length === 0 ? (
        <EmptyState
          illustration="audit"
          title="No remote sessions yet"
          description={`Shells, uploads and downloads on ${deviceName(device)} are listed here with who ran them and for how long. Shell sessions are recorded for replay.`}
        />
      ) : (
        <DataTable
          data={filtered}
          columns={columns}
          getRowId={(item) => item.id}
          loading={sessions.isLoading}
          initialSorting={[{ id: 'started', desc: true }]}
          caption="Remote sessions"
          empty={<div className="px-4 py-10 text-center text-dense text-muted-foreground">No sessions match.</div>}
        />
      )}
      <p className="text-micro text-subtle-foreground">Shell sessions end after 30 minutes without input or 8 hours in total. Every session is also in the audit log.</p>

      <Dialog
        open={Boolean(playerSession)}
        onOpenChange={(open) => {
          if (open) return
          setPlaying(null)
          playbackRequestStore.set(null)
        }}
      >
        <DialogContent className="sm:max-w-5xl">
          {playerSession && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <SquareTerminal className="size-4 text-subtle-foreground" />
                  {shellLabel(playerSession.detail?.shell)} on {playerSession.hostname}
                </DialogTitle>
                <DialogDescription>
                  {playerSession.user_name ?? 'Unknown user'} · <RelativeTime value={playerSession.started_at} /> · {formatSpan(sessionDuration(playerSession, 0))}
                  {playerSession.end_reason && ` · ${playerSession.end_reason}`}
                </DialogDescription>
              </DialogHeader>
              <Suspense fallback={<Skeleton className="aspect-[16/8] w-full rounded-lg" />}>
                <RecordingPlayer key={playerSession.id} sessionId={playerSession.id} />
              </Suspense>
            </>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(ending)}
        onOpenChange={(open) => !open && setEnding(null)}
        title="End this session?"
        description={
          ending && (
            <>
              Disconnects {ending.user_name ?? 'the operator'}’s {KIND_META[ending.kind].label.toLowerCase()} session on {ending.hostname} immediately. They’ll see that an
              administrator ended it.
            </>
          )
        }
        confirmLabel="End session"
        pending={end.isPending}
        onConfirm={() => ending && end.mutate(ending)}
      />
    </div>
  )
}
