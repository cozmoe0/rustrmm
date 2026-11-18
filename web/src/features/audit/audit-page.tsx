import { useCallback, useMemo, useState } from 'react'
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import {
  Bot,
  CircleCheck,
  Download,
  FileBraces,
  FileText,
  KeyRound,
  OctagonExclamationPoint,
  Search,
  ShieldCheck,
  User as UserIcon,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Can } from '@/components/common/can'
import { CopyButton } from '@/components/common/copy-button'
import { DataTable } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, KeyValue, Mono, RelativeTime } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/simple-select'
import { InspectorDrawer } from '@/components/shell/inspector'
import { auditApi } from '@/lib/api/endpoints'
import { errorMessage } from '@/lib/api/errors'
import { clientsQuery, usersQuery } from '@/lib/api/queries'
import type { AuditEvent, AuditFilters, AuditVerifyResult } from '@/lib/api/types'
import { describeUserAgent, formatDateTime, formatNumber } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'

export interface AuditSearch {
  action?: string
  actor_id?: string
  filter_client?: string
  from?: string
  to?: string
  q?: string
}

const ACTION_GROUPS = [
  { value: 'auth', label: 'Authentication' },
  { value: 'setup', label: 'Setup' },
  { value: 'client', label: 'Clients' },
  { value: 'site', label: 'Sites' },
  { value: 'user', label: 'Users' },
  { value: 'role', label: 'Roles' },
  { value: 'session', label: 'Sessions' },
  { value: 'passkey', label: 'Passkeys' },
  { value: 'backup', label: 'Backups' },
  { value: 'settings', label: 'Settings' },
  { value: 'audit', label: 'Audit' },
  { value: 'secret', label: 'Secrets' },
  { value: 'secret.revealed', label: 'Secret reveals' },
  { value: 'laps', label: 'LAPS' },
  { value: 'escrow', label: 'Escrow' },
  { value: 'network', label: 'Network' },
  { value: 'snmp', label: 'SNMP' },
]

function actionTone(action: string): 'critical' | 'warning' | 'live' | 'secondary' {
  if (action.endsWith('failed') || action.endsWith('deleted')) return 'critical'
  if (action.includes('step_up') || action.includes('mfa_reset') || action.endsWith('disabled') || action === 'secret.revealed') return 'warning'
  if (action.endsWith('created') || action.endsWith('completed') || action === 'auth.login') return 'live'
  return 'secondary'
}

function ActorCell({ event }: { event: AuditEvent }) {
  const Icon = event.actor.type === 'system' ? Bot : event.actor.type === 'api_token' ? KeyRound : UserIcon
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-3 text-muted-foreground">
        <Icon className="size-3" />
      </span>
      <span className="truncate">{event.actor.name ?? event.actor.type}</span>
    </span>
  )
}

function toFilters(search: AuditSearch): AuditFilters {
  return {
    action: search.action,
    actor_id: search.actor_id,
    client_id: search.filter_client,
    from: search.from,
    to: search.to,
    q: search.q,
  }
}

export function AuditPage({ search }: { search: AuditSearch }) {
  useTitle('Audit log')
  const me = useMe()
  const navigate = useNavigate()
  const [selected, setSelected] = useState<AuditEvent | null>(null)
  const [verifyResult, setVerifyResult] = useState<AuditVerifyResult | null>(null)
  const [query, setQuery] = useState(search.q ?? '')
  const filters = useMemo(() => toFilters(search), [search])
  const canUsers = hasPermission(me, PERMISSIONS.usersView)
  const { data: users = [] } = useQuery({ ...usersQuery, enabled: canUsers })
  const { data: clients = [] } = useQuery(clientsQuery())

  const setSearch = useCallback(
    (patch: Partial<AuditSearch>) =>
      void navigate({ to: '/settings/audit', search: (prev) => ({ ...prev, ...patch }), replace: true }),
    [navigate],
  )

  const {
    data,
    error,
    refetch,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['audit', 'list', filters],
    queryFn: ({ pageParam }) => auditApi.list(filters, pageParam, 100),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
  })

  const events = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data])

  const verify = useMutation({
    mutationFn: auditApi.verify,
    meta: { silent: true },
    onSuccess: setVerifyResult,
    onError: (err) => toast.error(errorMessage(err, 'Verification failed')),
  })

  const onEndReached = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  async function exportAs(format: 'csv' | 'json') {
    try {
      await auditApi.export(format, filters)
    } catch (err) {
      toast.error(errorMessage(err, 'Export failed'))
    }
  }

  const clientName = useCallback((id: string | null) => clients.find((client) => client.id === id)?.name, [clients])

  const columns = useMemo<ColumnDef<AuditEvent>[]>(
    () => [
      {
        accessorKey: 'at',
        header: 'Time',
        size: 150,
        cell: ({ getValue }) => <RelativeTime value={getValue<string>()} className="text-muted-foreground" />,
      },
      {
        id: 'actor',
        header: 'Actor',
        enableSorting: false,
        cell: ({ row }) => <ActorCell event={row.original} />,
      },
      {
        accessorKey: 'action',
        header: 'Action',
        cell: ({ getValue }) => (
          <Badge variant={actionTone(getValue<string>())} className="font-mono text-[11px] font-normal">
            {getValue<string>()}
          </Badge>
        ),
      },
      {
        id: 'target',
        header: 'Target',
        enableSorting: false,
        cell: ({ row }) =>
          row.original.target ? (
            <span className="truncate">
              <span className="text-subtle-foreground">{row.original.target.type}</span> {row.original.target.name}
            </span>
          ) : (
            <span className="text-subtle-foreground">—</span>
          ),
      },
      {
        id: 'client',
        header: 'Client',
        enableSorting: false,
        cell: ({ row }) => <span className="text-muted-foreground">{clientName(row.original.client_id) ?? '—'}</span>,
      },
      {
        accessorKey: 'ip',
        header: 'IP',
        enableSorting: false,
        cell: ({ getValue }) =>
          getValue<string | null>() ? (
            <span className="font-mono text-[11.5px] text-muted-foreground">{getValue<string>()}</span>
          ) : (
            <span className="text-subtle-foreground">—</span>
          ),
      },
    ],
    [clientName],
  )

  const hasFilters = Boolean(
    search.action || search.actor_id || search.filter_client || search.from || search.to || search.q,
  )

  return (
    <PageContainer className="flex h-full min-h-[640px] flex-col gap-5">
      <PageHeader
        eyebrow="Settings"
        title="Audit log"
        description="An append-only, hash-chained record of every sensitive action. Verify the chain to prove nothing was altered."
        actions={
          <>
            <Button variant="outline" onClick={() => verify.mutate()} disabled={verify.isPending}>
              {verify.isPending ? <Spinner data-icon="inline-start" /> : <ShieldCheck data-icon="inline-start" />}
              Verify integrity
            </Button>
            <Can permission={PERMISSIONS.auditExport}>
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="outline" />}>
                  <Download data-icon="inline-start" />
                  Export
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => void exportAs('csv')}>
                    <FileText />
                    CSV (current filters)
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void exportAs('json')}>
                    <FileBraces />
                    JSON (current filters)
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </Can>
          </>
        }
      />

      {verifyResult && (
        <div
          role="status"
          className={cn(
            'flex items-start gap-3 rounded-xl p-4 ring-1',
            verifyResult.ok ? 'bg-live/[0.07] ring-live/25' : 'bg-critical/[0.07] ring-critical/30',
          )}
        >
          {verifyResult.ok ? (
            <CircleCheck className="mt-0.5 size-5 shrink-0 text-live" />
          ) : (
            <OctagonExclamationPoint className="mt-0.5 size-5 shrink-0 text-critical" />
          )}
          <div className="flex-1 text-dense">
            <div className="font-semibold">
              {verifyResult.ok ? 'Chain verified' : `Chain broken at event #${verifyResult.broken_at}`}
            </div>
            <div className="text-muted-foreground">
              {verifyResult.ok
                ? `All ${formatNumber(verifyResult.checked)} events link correctly — the log has not been modified.`
                : 'An event was altered or removed. Export the log and investigate immediately.'}
            </div>
          </div>
          <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={() => setVerifyResult(null)}>
            <X />
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <form
          className="relative w-full sm:w-64"
          onSubmit={(event) => {
            event.preventDefault()
            setSearch({ q: query.trim() || undefined })
          }}
        >
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-subtle-foreground" />
          <Input
            data-filter-input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onBlur={() => setSearch({ q: query.trim() || undefined })}
            placeholder="Search actor, target, IP…"
            aria-label="Search audit events"
            className="pl-8"
          />
        </form>
        <SimpleSelect
          className="w-44"
          ariaLabel="Action"
          value={search.action ?? '__all__'}
          onValueChange={(value) => setSearch({ action: value === '__all__' ? undefined : value })}
          options={[{ value: '__all__', label: 'All actions' }, ...ACTION_GROUPS]}
        />
        {canUsers && (
          <SimpleSelect
            className="w-44"
            ariaLabel="Actor"
            value={search.actor_id ?? '__all__'}
            onValueChange={(value) => setSearch({ actor_id: value === '__all__' ? undefined : value })}
            options={[{ value: '__all__', label: 'Anyone' }, ...users.map((user) => ({ value: user.id, label: user.name }))]}
          />
        )}
        <SimpleSelect
          className="w-48"
          ariaLabel="Client"
          value={search.filter_client ?? '__all__'}
          onValueChange={(value) => setSearch({ filter_client: value === '__all__' ? undefined : value })}
          options={[{ value: '__all__', label: 'Any client' }, ...clients.map((client) => ({ value: client.id, label: client.name }))]}
        />
        <div className="flex items-center gap-1.5">
          <Input
            type="date"
            aria-label="From date"
            className="w-[150px]"
            value={search.from ?? ''}
            onChange={(event) => setSearch({ from: event.target.value || undefined })}
          />
          <span className="text-subtle-foreground">–</span>
          <Input
            type="date"
            aria-label="To date"
            className="w-[150px]"
            value={search.to ?? ''}
            onChange={(event) => setSearch({ to: event.target.value || undefined })}
          />
        </div>
        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setQuery('')
              void navigate({ to: '/settings/audit', search: {}, replace: true })
            }}
          >
            <X data-icon="inline-start" />
            Clear
          </Button>
        )}
        <span className="tabular ml-auto text-dense text-muted-foreground">
          {formatNumber(events.length)}
          {hasNextPage ? '+' : ''} events
        </span>
      </div>

      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <div className="min-h-0 flex-1">
        <DataTable
          data={events}
          columns={columns}
          loading={isLoading}
          getRowId={(event) => String(event.id)}
          onRowClick={setSelected}
          onRowPeek={setSelected}
          activeRowId={selected ? String(selected.id) : null}
          virtualHeight="100%"
          onEndReached={onEndReached}
          caption="Audit events"
          empty={
            <div className="p-6">
              <EmptyState compact illustration="audit" title="No events match" description="Adjust or clear the filters." />
            </div>
          }
        />
        </div>
      )}
      {isFetchingNextPage && (
        <div className="flex items-center justify-center gap-2 text-dense text-muted-foreground">
          <Spinner /> Loading older events…
        </div>
      )}

      <InspectorDrawer
        open={Boolean(selected)}
        onOpenChange={(open) => !open && setSelected(null)}
        title={selected?.action ?? ''}
        description={selected ? formatDateTime(selected.at) : undefined}
        icon={
          <span className="flex size-10 items-center justify-center rounded-xl bg-surface-3 text-muted-foreground">
            <ShieldCheck className="size-5" />
          </span>
        }
      >
        {selected && (
          <div className="grid gap-5">
            <dl>
              <KeyValue label="Event">
                <Mono>{`#${selected.id}`}</Mono>
              </KeyValue>
              <KeyValue label="Actor">
                {selected.actor.name ?? '—'} <span className="text-subtle-foreground">({selected.actor.type})</span>
              </KeyValue>
              <KeyValue label="Target">
                {selected.target ? `${selected.target.type} · ${selected.target.name ?? selected.target.id}` : '—'}
              </KeyValue>
              <KeyValue label="Client">{clientName(selected.client_id) ?? '—'}</KeyValue>
              <KeyValue label="IP address">{selected.ip ? <Mono>{selected.ip}</Mono> : '—'}</KeyValue>
              <KeyValue label="Device">{describeUserAgent(selected.user_agent)}</KeyValue>
            </dl>
            <div>
              <h3 className="eyebrow mb-2">Details</h3>
              <pre className="max-h-64 overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-[11.5px] leading-relaxed text-secondary-foreground">
                {JSON.stringify(selected.details, null, 2)}
              </pre>
            </div>
            <div>
              <h3 className="eyebrow mb-2">Chain hash</h3>
              <div className="flex items-center gap-1 rounded-lg bg-surface-2 py-1.5 pr-1.5 pl-3">
                <code className="min-w-0 flex-1 font-mono text-[11px] break-all text-muted-foreground">{selected.hash}</code>
                <CopyButton value={selected.hash} label="Copy hash" />
              </div>
              <p className="mt-1.5 text-micro text-subtle-foreground">
                SHA-256 of the previous hash and this event. Any edit breaks every later link.
              </p>
            </div>
          </div>
        )}
      </InspectorDrawer>
    </PageContainer>
  )
}
