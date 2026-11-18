/* The time report: entries filtered by client, user, date range and billable, with totals and CSV export. */
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { Download, Timer, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { DataTable } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { EntityAvatar, ErrorState, UserAvatar } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/simple-select'
import { timeEntriesApi } from '@/lib/api/endpoints'
import { errorMessage } from '@/lib/api/errors'
import { clientsQuery, ticketKeys, timeEntriesQuery, usersQuery } from '@/lib/api/queries'
import type { TimeEntry, TimeEntryFilters } from '@/lib/api/types'
import { formatDate, formatNumber } from '@/lib/format'
import { ticketNumber } from '@/lib/tickets/labels'
import { formatMinutes } from '@/lib/tickets/sla'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useScope } from '@/lib/scope'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'

export interface TimeSearch {
  user?: string
  from?: string
  to?: string
  billable?: 'yes' | 'no'
}

const pad = (value: number) => String(value).padStart(2, '0')
const day = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

function presets(now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const monday = new Date(today)
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7))
  const lastMonday = new Date(monday)
  lastMonday.setDate(monday.getDate() - 7)
  const lastSunday = new Date(monday)
  lastSunday.setDate(monday.getDate() - 1)
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1)
  const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1)
  const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0)
  const thirty = new Date(today)
  thirty.setDate(today.getDate() - 29)
  return [
    { id: 'week', label: 'This week', from: day(monday), to: day(today) },
    { id: 'last-week', label: 'Last week', from: day(lastMonday), to: day(lastSunday) },
    { id: 'month', label: 'This month', from: day(monthStart), to: day(today) },
    { id: 'last-month', label: 'Last month', from: day(lastMonthStart), to: day(lastMonthEnd) },
    { id: '30', label: 'Last 30 days', from: day(thirty), to: day(today) },
  ]
}

function Breakdown({ title, rows, total }: { title: string; rows: { id: string; name: string; minutes: number; billable: number; avatar: 'client' | 'user' }[]; total: number }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-dense text-subtle-foreground">No time in this range.</p>
        ) : (
          <ul className="grid gap-2.5">
            {rows.map((row) => (
              <li key={row.id} className="grid gap-1">
                <div className="flex items-center gap-2 text-dense">
                  {row.avatar === 'client' ? <EntityAvatar name={row.name} seed={row.id} size="xs" /> : <UserAvatar name={row.name} size="xs" />}
                  <span className="min-w-0 flex-1 truncate font-medium">{row.name}</span>
                  <span className="tabular text-muted-foreground">{formatMinutes(row.billable)} billable</span>
                  <span className="tabular w-16 text-right font-semibold">{formatMinutes(row.minutes)}</span>
                </div>
                <div className="relative h-1.5 overflow-hidden rounded-full bg-surface-4" aria-hidden="true">
                  <div className="absolute inset-y-0 left-0 rounded-full bg-chart-1/35" style={{ width: `${total ? (row.minutes / total) * 100 : 0}%` }} />
                  <div className="absolute inset-y-0 left-0 rounded-full bg-chart-2" style={{ width: `${total ? (row.billable / total) * 100 : 0}%` }} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

export function TimePage({ search }: { search: TimeSearch }) {
  useTitle('Time report')
  const me = useMe()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { clientId, setClient } = useScope()
  const canTime = hasPermission(me, PERMISSIONS.ticketsTime)
  const canOthers = hasPermission(me, PERMISSIONS.ticketsSettings)
  const meId = me?.user.id
  const ranges = presets()
  const defaultRange = ranges.find((range) => range.id === 'month')!
  const from = search.from ?? defaultRange.from
  const to = search.to ?? defaultRange.to
  const filters: TimeEntryFilters = {
    client_id: clientId,
    user_id: search.user,
    from,
    to,
    billable: search.billable === 'yes' ? true : search.billable === 'no' ? false : undefined,
  }
  const { data, isLoading, error, refetch } = useQuery({ ...timeEntriesQuery(filters), enabled: canTime })
  const { data: clients = [] } = useQuery(clientsQuery())
  const { data: users = [] } = useQuery({ ...usersQuery, enabled: hasPermission(me, PERMISSIONS.usersView), meta: { silent: true } })
  const [deleting, setDeleting] = useState<TimeEntry | null>(null)
  const [exporting, setExporting] = useState(false)
  const setSearch = (patch: Partial<TimeSearch>) => void navigate({ from: '/tickets/time', to: '/tickets/time', search: (prev) => ({ ...prev, ...patch }), replace: true })
  const remove = useMutation({
    mutationFn: (id: string) => timeEntriesApi.remove(id),
    meta: { successMessage: 'Time entry deleted' },
    onSuccess: () => {
      setDeleting(null)
      void queryClient.invalidateQueries({ queryKey: ticketKeys.time })
      void queryClient.invalidateQueries({ queryKey: ticketKeys.all })
    },
  })
  const activePreset = ranges.find((range) => range.from === from && range.to === to)?.id ?? ''

  const columns = useMemo<ColumnDef<TimeEntry>[]>(
    () => [
      { id: 'started_at', accessorKey: 'started_at', header: 'Date', cell: ({ row }) => <span className="tabular whitespace-nowrap">{formatDate(row.original.started_at)}</span> },
      {
        id: 'ticket',
        accessorKey: 'ticket_number',
        header: 'Ticket',
        cell: ({ row }) => (
          <Link to="/tickets/$ticketId" params={{ ticketId: row.original.ticket_id }} className="flex min-w-0 items-center gap-2 hover:underline" onClick={(event) => event.stopPropagation()}>
            <span className="tabular shrink-0 font-mono text-[11.5px] text-muted-foreground">{ticketNumber(row.original.ticket_number)}</span>
            <span className="max-w-[22rem] truncate">{row.original.ticket_subject}</span>
          </Link>
        ),
      },
      { id: 'client', accessorKey: 'client_name', header: 'Client', cell: ({ row }) => <span className="truncate text-muted-foreground">{row.original.client_name}</span> },
      {
        id: 'user',
        accessorFn: (entry) => entry.user.name,
        header: 'Technician',
        cell: ({ row }) => (
          <span className="flex items-center gap-1.5 whitespace-nowrap">
            <UserAvatar name={row.original.user.name} size="xs" />
            {row.original.user.name}
          </span>
        ),
      },
      {
        id: 'minutes',
        accessorKey: 'minutes',
        header: 'Time',
        cell: ({ row }) => (
          <span className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="tabular font-semibold">{formatMinutes(row.original.minutes)}</span>
            {!row.original.billable && <Badge variant="outline">Non-billable</Badge>}
          </span>
        ),
      },
      { id: 'note', accessorKey: 'note', header: 'Note', enableSorting: false, cell: ({ row }) => <span className="block max-w-[18rem] truncate text-muted-foreground">{row.original.note || '—'}</span> },
      {
        id: 'actions',
        header: '',
        enableSorting: false,
        cell: ({ row }) =>
          (row.original.user.id === meId || canOthers) && (
            <Button size="icon-xs" variant="ghost" aria-label="Delete time entry" className="hover:text-critical" onClick={() => setDeleting(row.original)}>
              <Trash2 />
            </Button>
          ),
      },
    ],
    [meId, canOthers, setDeleting],
  )

  if (!canTime) {
    return (
      <div className="h-full overflow-y-auto p-6">
        <EmptyState illustration="reports" title="You can’t view time reports" description="Ask an administrator for the “Log time” permission." />
      </div>
    )
  }

  const totals = data?.totals
  const billablePct = totals && totals.minutes ? Math.round((totals.billable_minutes / totals.minutes) * 100) : null

  return (
    <div className="h-full overflow-y-auto">
      <PageContainer className="grid gap-5">
        <PageHeader
          icon={<Timer />}
          title="Time report"
          description="Logged time by client and technician. Exports use the same filters."
          actions={
            <Button
              variant="outline"
              size="sm"
              disabled={exporting || !data?.items.length}
              onClick={async () => {
                setExporting(true)
                try {
                  await timeEntriesApi.exportCsv(filters)
                } catch (failure) {
                  toast.error(errorMessage(failure))
                } finally {
                  setExporting(false)
                }
              }}
            >
              {exporting ? <Spinner data-icon="inline-start" /> : <Download data-icon="inline-start" />}
              Export CSV
            </Button>
          }
        />
        <div className="grid gap-3 rounded-xl bg-card p-3 shadow-card">
          <div className="flex flex-wrap gap-1.5">
            {ranges.map((range) => (
              <button
                key={range.id}
                type="button"
                aria-pressed={activePreset === range.id}
                onClick={() => setSearch({ from: range.id === 'month' ? undefined : range.from, to: range.id === 'month' ? undefined : range.to })}
                className={cn(
                  'inline-flex h-7 items-center rounded-md px-2.5 text-dense ring-1 transition-colors',
                  activePreset === range.id ? 'bg-surface-4 font-medium text-foreground ring-border-strong' : 'text-muted-foreground ring-border hover:bg-surface-3 hover:text-foreground',
                )}
              >
                {range.label}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-[repeat(3,minmax(0,1fr))_repeat(2,minmax(0,10rem))]">
            <SimpleSelect ariaLabel="Client" value={clientId ?? ''} onValueChange={(value) => setClient(value || null)} options={[{ value: '', label: 'All clients' }, ...clients.map((client) => ({ value: client.id, label: client.name }))]} />
            <SimpleSelect
              ariaLabel="Technician"
              value={search.user ?? ''}
              onValueChange={(value) => setSearch({ user: value || undefined })}
              options={[{ value: '', label: 'Everyone' }, ...(me ? [{ value: me.user.id, label: 'Me' }] : []), ...users.filter((user) => user.id !== me?.user.id).map((user) => ({ value: user.id, label: user.name }))]}
            />
            <SimpleSelect
              ariaLabel="Billable"
              value={search.billable ?? ''}
              onValueChange={(value) => setSearch({ billable: (value || undefined) as TimeSearch['billable'] })}
              options={[
                { value: '', label: 'Billable and not' },
                { value: 'yes', label: 'Billable only' },
                { value: 'no', label: 'Non-billable only' },
              ]}
            />
            <Input type="date" aria-label="From" value={from} max={to} onChange={(event) => event.target.value && setSearch({ from: event.target.value })} className="tabular" />
            <Input type="date" aria-label="To" value={to} min={from} onChange={(event) => event.target.value && setSearch({ to: event.target.value })} className="tabular" />
          </div>
        </div>

        {error ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {[
                ['Total time', totals ? formatMinutes(totals.minutes) : '—', null],
                ['Billable', totals ? formatMinutes(totals.billable_minutes) : '—', 'text-live'],
                ['Billable share', billablePct === null ? '—' : `${billablePct}%`, null],
                ['Entries', data ? formatNumber(data.items.length) : '—', null],
              ].map(([label, value, tone]) => (
                <div key={label} className="rounded-xl bg-card p-4 shadow-card">
                  <div className="text-dense text-muted-foreground">{label}</div>
                  <div className={cn('font-display tabular mt-2 text-[26px] leading-none font-semibold tracking-tight', tone)}>{value}</div>
                </div>
              ))}
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              <Breakdown
                title="By client"
                total={totals?.minutes ?? 0}
                rows={(totals?.by_client ?? []).map((row) => ({ id: row.client_id, name: row.client_name, minutes: row.minutes, billable: row.billable_minutes, avatar: 'client' }))}
              />
              <Breakdown
                title="By technician"
                total={totals?.minutes ?? 0}
                rows={(totals?.by_user ?? []).map((row) => ({ id: row.user_id, name: row.user_name, minutes: row.minutes, billable: row.billable_minutes, avatar: 'user' }))}
              />
            </div>
            {!isLoading && data?.items.length === 0 ? (
              <EmptyState compact illustration="reports" title="No time logged in this range" description="Start a timer on a ticket or log time from the command palette (Log time…)." />
            ) : (
              <DataTable data={data?.items ?? []} columns={columns} loading={isLoading} getRowId={(row) => row.id} initialSorting={[{ id: 'started_at', desc: true }]} />
            )}
          </>
        )}
      </PageContainer>
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this time entry?"
        description={deleting ? `${formatMinutes(deleting.minutes)} on ${ticketNumber(deleting.ticket_number)} by ${deleting.user.name}.` : undefined}
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </div>
  )
}
