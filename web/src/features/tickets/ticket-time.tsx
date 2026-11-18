/* Time tracking: the running timer (posts on stop), manual entries, the entry list and the app-wide "Log time" dialog. */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Play, Plus, Search, Square, Timer, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { RelativeTime, UserAvatar } from '@/components/common/misc'
import { ticketsApi, timeEntriesApi } from '@/lib/api/endpoints'
import { errorMessage } from '@/lib/api/errors'
import { ticketKeys } from '@/lib/api/queries'
import type { Ticket, TimeEntry, TimeEntryInput } from '@/lib/api/types'
import { formatClock, formatDateTime } from '@/lib/format'
import { parseTicketJump } from '@/lib/tickets/jump'
import { ticketNumber } from '@/lib/tickets/labels'
import { formatMinutes, parseDuration, timerMinutes } from '@/lib/tickets/sla'
import { useStore } from '@/lib/store'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { cn } from '@/lib/utils'
import { closeLogTime, logTimeStore, timersStore, useTimers } from './ticket-stores'
import { TicketStatusBadge } from './ticket-ui'
import { refreshTickets } from './use-ticket-actions'
import { useNow } from './use-now'

function toLocalInput(ms: number) {
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Minutes, start, billable and note; used for manual entries, stopping the timer and edits. */
export function TimeEntryForm({
  initialMinutes,
  initialStart,
  initialBillable = true,
  initialNote = '',
  submitLabel,
  pending,
  onSubmit,
  onCancel,
  autoFocus = true,
}: {
  initialMinutes?: number
  initialStart?: number
  initialBillable?: boolean
  initialNote?: string
  submitLabel: string
  pending: boolean
  onSubmit: (input: TimeEntryInput) => void
  onCancel?: () => void
  autoFocus?: boolean
}) {
  const [duration, setDuration] = useState(initialMinutes ? formatMinutes(initialMinutes) : '')
  const [start, setStart] = useState(initialStart ? toLocalInput(initialStart) : '')
  const [billable, setBillable] = useState(initialBillable)
  const [note, setNote] = useState(initialNote)
  const minutes = parseDuration(duration)
  const invalid = duration.trim() !== '' && (minutes === null || minutes < 1 || minutes > 1440)
  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (minutes === null || invalid) return
        onSubmit({ minutes, billable, note: note.trim() || undefined, ...(start ? { started_at: new Date(start).toISOString() } : {}) })
      }}
    >
      <div className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-2">
        <label className="grid gap-1 text-micro text-muted-foreground">
          Duration
          <Input autoFocus={autoFocus} value={duration} placeholder="45m, 1h 30m" aria-invalid={invalid || undefined} onChange={(event) => setDuration(event.target.value)} className="tabular" />
        </label>
        <label className="grid gap-1 text-micro text-muted-foreground">
          Started
          <Input type="datetime-local" value={start} onChange={(event) => setStart(event.target.value)} className="tabular" />
        </label>
      </div>
      {invalid && <p className="-mt-1 text-micro text-critical">Enter 1 minute to 24 hours, for example “45m” or “1h 30m”.</p>}
      <Textarea rows={2} value={note} maxLength={2000} placeholder="What did you do? (optional)" aria-label="Note" onChange={(event) => setNote(event.target.value)} className="min-h-14 resize-none" />
      <div className="flex items-center justify-between gap-2">
        <label className="inline-flex items-center gap-2 text-dense">
          <Switch checked={billable} onCheckedChange={setBillable} aria-label="Billable" />
          Billable
        </label>
        <div className="flex gap-2">
          {onCancel && (
            <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button type="submit" size="sm" disabled={pending || minutes === null || invalid}>
            {pending && <Spinner data-icon="inline-start" />}
            {submitLabel}
          </Button>
        </div>
      </div>
    </form>
  )
}

function useLogTime(ticketId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: TimeEntryInput) => ticketsApi.time(ticketId, input),
    onSuccess: (entry) => {
      toast.success(`Logged ${formatMinutes(entry.minutes)} on ${ticketNumber(entry.ticket_number)}`)
      void queryClient.invalidateQueries({ queryKey: ticketKeys.detail(ticketId) })
      void queryClient.invalidateQueries({ queryKey: ticketKeys.time })
      refreshTickets(queryClient)
    },
  })
}

/** Start/stop timer for the header; stopping asks for the details and posts an entry. */
export function TimerControl({ ticket, compact = false }: { ticket: Pick<Ticket, 'id' | 'number'>; compact?: boolean }) {
  const me = useMe()
  const timers = useTimers()
  const startedAt = timers[ticket.id]
  const now = useNow(1000)
  const [stopping, setStopping] = useState<number | null>(null)
  const log = useLogTime(ticket.id)
  if (!hasPermission(me, PERMISSIONS.ticketsTime)) return null
  const running = startedAt !== undefined
  const elapsed = running ? now - startedAt : 0
  const clear = () =>
    timersStore.set((prev) => {
      const next = { ...prev }
      delete next[ticket.id]
      return next
    })

  if (!running) {
    return (
      <Button size="sm" variant="outline" onClick={() => timersStore.set((prev) => ({ ...prev, [ticket.id]: Date.now() }))} title="Start a timer for this ticket">
        <Play data-icon="inline-start" className="text-live" />
        {compact ? <span className="sr-only">Start timer</span> : 'Start timer'}
      </Button>
    )
  }
  return (
    <Popover open={stopping !== null} onOpenChange={(open) => !open && setStopping(null)}>
      <PopoverTrigger
        render={
          <Button
            size="sm"
            variant="outline"
            onClick={() => setStopping(Date.now())}
            className="border-live/40 bg-live/[0.07] text-live hover:bg-live/12"
            title="Stop the timer and log the time"
          />
        }
      >
        <span className="relative flex size-2">
          <span className="absolute inset-0 animate-pulse-ring rounded-full bg-live text-live" />
        </span>
        <span className="tabular font-mono text-[12px]">{formatClock(elapsed / 1000)}</span>
        <Square className="size-3 fill-current" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(22rem,calc(100vw-2rem))]">
        <div className="mb-3">
          <div className="text-dense font-medium">Log timer for {ticketNumber(ticket.number)}</div>
          <div className="text-micro text-muted-foreground">Started {formatDateTime(startedAt)} · rounded up to whole minutes</div>
        </div>
        {stopping !== null && (
          <TimeEntryForm
            key={stopping}
            initialMinutes={Math.min(1440, timerMinutes(stopping - startedAt))}
            initialStart={startedAt}
            submitLabel="Log time"
            pending={log.isPending}
            onSubmit={(input) =>
              log.mutate(input, {
                onSuccess: () => {
                  clear()
                  setStopping(null)
                },
              })
            }
            onCancel={() => setStopping(null)}
          />
        )}
        <Button
          variant="ghost"
          size="xs"
          className="mt-2 text-muted-foreground hover:text-critical"
          onClick={() => {
            clear()
            setStopping(null)
          }}
        >
          <Trash2 data-icon="inline-start" />
          Discard timer
        </Button>
      </PopoverContent>
    </Popover>
  )
}

function EntryRow({ entry, canEdit, onEdit, onDelete }: { entry: TimeEntry; canEdit: boolean; onEdit: () => void; onDelete: () => void }) {
  return (
    <li className="group flex items-start gap-2.5 py-2">
      <UserAvatar name={entry.user.name} size="sm" className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="tabular text-dense font-semibold">{formatMinutes(entry.minutes)}</span>
          <span className="truncate text-micro text-muted-foreground">{entry.user.name}</span>
          <RelativeTime value={entry.started_at} className="text-micro text-subtle-foreground" />
          {!entry.billable && <Badge variant="outline" className="h-4 px-1 text-[10px]">Non-billable</Badge>}
        </div>
        {entry.note && <p className="mt-0.5 text-dense break-words text-secondary-foreground">{entry.note}</p>}
      </div>
      {canEdit && (
        <div className="flex shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 max-md:opacity-100">
          <Button size="icon-xs" variant="ghost" aria-label="Edit time entry" onClick={onEdit}>
            <Pencil />
          </Button>
          <Button size="icon-xs" variant="ghost" aria-label="Delete time entry" className="hover:text-critical" onClick={onDelete}>
            <Trash2 />
          </Button>
        </div>
      )}
    </li>
  )
}

/** The time section of a ticket: totals, timer, manual entry and the list. */
export function TicketTimePanel({ ticket, entries }: { ticket: Ticket; entries: TimeEntry[] }) {
  const me = useMe()
  const queryClient = useQueryClient()
  const canTime = hasPermission(me, PERMISSIONS.ticketsTime)
  const canOthers = hasPermission(me, PERMISSIONS.ticketsSettings)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<TimeEntry | null>(null)
  const [deleting, setDeleting] = useState<TimeEntry | null>(null)
  const log = useLogTime(ticket.id)
  const done = () => {
    void queryClient.invalidateQueries({ queryKey: ticketKeys.detail(ticket.id) })
    void queryClient.invalidateQueries({ queryKey: ticketKeys.time })
    refreshTickets(queryClient)
  }
  const edit = useMutation({
    mutationFn: ({ id, input }: { id: string; input: TimeEntryInput }) => timeEntriesApi.update(id, input),
    meta: { successMessage: 'Time entry updated' },
    onSuccess: () => {
      setEditing(null)
      done()
    },
  })
  const remove = useMutation({
    mutationFn: (id: string) => timeEntriesApi.remove(id),
    meta: { successMessage: 'Time entry deleted' },
    onSuccess: () => {
      setDeleting(null)
      done()
    },
  })
  const total = entries.reduce((sum, entry) => sum + entry.minutes, 0)
  const billable = entries.filter((entry) => entry.billable).reduce((sum, entry) => sum + entry.minutes, 0)

  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg bg-surface-2 px-3 py-2 ring-1 ring-border">
          <div className="text-micro text-subtle-foreground">Time spent</div>
          <div className="tabular font-display text-lg leading-tight font-semibold">{formatMinutes(total)}</div>
        </div>
        <div className="rounded-lg bg-surface-2 px-3 py-2 ring-1 ring-border">
          <div className="text-micro text-subtle-foreground">Billable</div>
          <div className="tabular font-display text-lg leading-tight font-semibold text-live">{formatMinutes(billable)}</div>
        </div>
      </div>
      {canTime && (
        <div className="flex flex-wrap items-center gap-2">
          <TimerControl ticket={ticket} />
          <Button size="sm" variant="ghost" onClick={() => setAdding((value) => !value)} aria-expanded={adding}>
            <Plus data-icon="inline-start" />
            Add time manually
          </Button>
        </div>
      )}
      {adding && (
        <div className="rounded-lg bg-surface-2/60 p-3 ring-1 ring-border">
          <TimeEntryForm submitLabel="Log time" pending={log.isPending} onSubmit={(input) => log.mutate(input, { onSuccess: () => setAdding(false) })} onCancel={() => setAdding(false)} />
        </div>
      )}
      {entries.length === 0 ? (
        <p className="flex items-center gap-2 text-dense text-subtle-foreground">
          <Timer className="size-3.5" />
          No time logged yet.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {entries.map((entry) => (
            <EntryRow
              key={entry.id}
              entry={entry}
              canEdit={canTime && (entry.user.id === me?.user.id || canOthers)}
              onEdit={() => setEditing(entry)}
              onDelete={() => setDeleting(entry)}
            />
          ))}
        </ul>
      )}
      <Dialog open={Boolean(editing)} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Edit time entry</DialogTitle>
            <DialogDescription>{editing ? `${editing.user.name} · ${formatDateTime(editing.started_at)}` : null}</DialogDescription>
          </DialogHeader>
          {editing && (
            <TimeEntryForm
              initialMinutes={editing.minutes}
              initialStart={new Date(editing.started_at).getTime()}
              initialBillable={editing.billable}
              initialNote={editing.note}
              submitLabel="Save"
              pending={edit.isPending}
              onSubmit={(input) => edit.mutate({ id: editing.id, input: { ...input, note: input.note ?? '' } })}
              onCancel={() => setEditing(null)}
            />
          )}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this time entry?"
        description={deleting ? `${formatMinutes(deleting.minutes)} logged by ${deleting.user.name}. The ticket’s activity records the deletion.` : undefined}
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </div>
  )
}

function TicketSearch({ onPick }: { onPick: (ticket: Ticket) => void }) {
  const [query, setQuery] = useState('')
  const jump = parseTicketJump(query)
  const q = jump ? String(jump) : query.trim()
  const { data, isFetching } = useQuery({
    queryKey: [...ticketKeys.lists, { purpose: 'log-time', q }],
    queryFn: () => ticketsApi.list({ q: q || undefined, assignee: q ? undefined : 'me', limit: 8 }),
    staleTime: 10_000,
  })
  return (
    <div className="grid gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle-foreground" />
        <Input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="#1042 or search subject, client…" aria-label="Find a ticket" className="pl-8" />
        {isFetching && <Spinner className="absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-subtle-foreground" />}
      </div>
      <div className="eyebrow mt-1">{q ? 'Matching tickets' : 'Your open tickets'}</div>
      <ul className="max-h-64 overflow-y-auto rounded-lg ring-1 ring-border">
        {(data?.items ?? []).length === 0 ? (
          <li className="px-3 py-4 text-center text-dense text-muted-foreground">{isFetching ? 'Searching…' : 'No tickets found.'}</li>
        ) : (
          data!.items.map((ticket) => (
            <li key={ticket.id} className="border-b border-border last:border-0">
              <button type="button" onClick={() => onPick(ticket)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left outline-none hover:bg-surface-3 focus-visible:bg-surface-3">
                <span className="tabular font-mono text-micro text-muted-foreground">{ticketNumber(ticket.number)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-dense font-medium">{ticket.subject}</span>
                  <span className="block truncate text-micro text-muted-foreground">{ticket.client_name}</span>
                </span>
                <TicketStatusBadge status={ticket.status} />
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  )
}

function LogTimeBody({ ticketId, onDone }: { ticketId?: string; onDone: () => void }) {
  const [picked, setPicked] = useState<Pick<Ticket, 'id' | 'number' | 'subject' | 'client_name'> | null>(null)
  const { data } = useQuery({ queryKey: ticketKeys.detail(ticketId ?? 'none'), queryFn: () => ticketsApi.get(ticketId!), enabled: Boolean(ticketId) && !picked })
  const target = picked ?? (data ? data.ticket : null)
  const log = useMutation({
    mutationFn: (input: TimeEntryInput) => ticketsApi.time(target!.id, input),
    meta: { silent: true },
  })
  const queryClient = useQueryClient()
  if (!target) {
    return ticketId && !data ? (
      <div className="flex justify-center p-6">
        <Spinner />
      </div>
    ) : (
      <TicketSearch onPick={setPicked} />
    )
  }
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 ring-1 ring-border">
        <span className="tabular font-mono text-micro text-muted-foreground">{ticketNumber(target.number)}</span>
        <span className="min-w-0 flex-1 truncate text-dense font-medium">{target.subject}</span>
        <Button size="xs" variant="ghost" onClick={() => setPicked(null)} className={cn(ticketId && !picked && 'hidden')}>
          Change
        </Button>
      </div>
      <TimeEntryForm
        submitLabel="Log time"
        pending={log.isPending}
        onSubmit={(input) =>
          log.mutate(input, {
            onSuccess: (entry) => {
              toast.success(`Logged ${formatMinutes(entry.minutes)} on ${ticketNumber(entry.ticket_number)}`)
              void queryClient.invalidateQueries({ queryKey: ticketKeys.detail(target.id) })
              void queryClient.invalidateQueries({ queryKey: ticketKeys.time })
              refreshTickets(queryClient)
              onDone()
            },
            onError: (error) => toast.error(errorMessage(error)),
          })
        }
        onCancel={onDone}
      />
    </div>
  )
}

/** Mounted once in the app shell; opened from the palette ("Log time…"). */
export function LogTimeDialogHost() {
  const request = useStore(logTimeStore)
  if (!request) return null
  return (
    <Dialog open={request.open} onOpenChange={(open) => !open && closeLogTime()}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Timer className="size-4 text-primary" />
            Log time
          </DialogTitle>
          <DialogDescription>Record work against a ticket. Billable time shows in the time report.</DialogDescription>
        </DialogHeader>
        <LogTimeBody key={request.nonce} ticketId={request.value.ticketId} onDone={closeLogTime} />
      </DialogContent>
    </Dialog>
  )
}
