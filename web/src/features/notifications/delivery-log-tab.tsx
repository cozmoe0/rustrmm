/* The delivery log: every notification attempt, including retries and quiet-hours holds. */
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { Moon, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DataTable } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/misc'
import { SimpleSelect } from '@/components/common/simple-select'
import { ChannelKindTile, DeliveryStatusBadge, When } from '@/features/monitoring/monitoring-ui'
import { alertsApi } from '@/lib/api/endpoints'
import { notificationChannelsQuery, notificationLogQuery, notificationRulesQuery } from '@/lib/api/queries'
import type { NotificationDeliveryStatus, NotificationLogEntry } from '@/lib/api/types'
import { formatNumber } from '@/lib/format'
import { DELIVERY_STATUS_LABEL, NOTIFICATION_EVENT_LABEL } from '@/lib/monitoring/labels'
import { attemptLabel } from '@/lib/notifications/rules'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { cn } from '@/lib/utils'
import { ChipToggle } from './notification-ui'

const STATUSES: NotificationDeliveryStatus[] = ['sent', 'failed', 'pending', 'suppressed']

export function DeliveryLogTab() {
  const me = useMe()
  const { data, isLoading, isFetching, error, refetch } = useQuery(notificationLogQuery({ limit: 300 }))
  const { data: channels = [] } = useQuery(notificationChannelsQuery)
  const { data: rules = [] } = useQuery(notificationRulesQuery)
  // Log rows carry only alert ids; recent alerts give them a readable title.
  const { data: alerts } = useQuery({
    queryKey: ['alerts', 'lookup', 'notification-log'],
    queryFn: () => alertsApi.list({ status: 'all', limit: 200 }),
    enabled: hasPermission(me, PERMISSIONS.alertsView),
    staleTime: 60_000,
    meta: { silent: true },
  })
  const [channelId, setChannelId] = useState('all')
  const [statuses, setStatuses] = useState<NotificationDeliveryStatus[]>([])
  const rows = useMemo(() => data ?? [], [data])
  const filtered = rows.filter(
    (row) => (channelId === 'all' || row.channel_id === channelId) && (statuses.length === 0 || statuses.includes(row.status)),
  )
  const counts = Object.fromEntries(STATUSES.map((status) => [status, rows.filter((row) => row.status === status).length])) as Record<
    NotificationDeliveryStatus,
    number
  >

  const columns = useMemo<ColumnDef<NotificationLogEntry>[]>(() => {
    const alertTitle = (id: string) => alerts?.items.find((alert) => alert.id === id)
    const ruleName = (id: string | null) => (id ? (rules.find((rule) => rule.id === id)?.name ?? 'Deleted rule') : null)
    return [
      {
        id: 'at',
        accessorKey: 'at',
        header: 'When',
        cell: ({ row }) => <When value={row.original.at} className="text-muted-foreground" />,
      },
      {
        id: 'status',
        accessorKey: 'status',
        header: 'Status',
        cell: ({ row }) => <DeliveryStatusBadge status={row.original.status} />,
      },
      {
        id: 'channel',
        accessorFn: (row) => row.channel_name ?? '',
        header: 'Channel',
        cell: ({ row }) => (
          <span className="flex min-w-0 items-center gap-2">
            {row.original.channel_kind && (
              <ChannelKindTile kind={row.original.channel_kind} size="sm" className="size-5 rounded-[5px] [&_svg]:size-3" />
            )}
            <span className="max-w-44 truncate">{row.original.channel_name ?? 'Deleted channel'}</span>
          </span>
        ),
      },
      {
        id: 'event',
        accessorKey: 'event',
        header: 'Event',
        cell: ({ row }) => (
          <span className={cn(row.original.event === 'test' && 'text-muted-foreground')}>
            {row.original.event === 'test' ? 'Test' : NOTIFICATION_EVENT_LABEL[row.original.event]}
          </span>
        ),
      },
      {
        id: 'alert',
        accessorFn: (row) => row.alert_id ?? '',
        header: 'Alert',
        enableSorting: false,
        cell: ({ row }) => {
          const id = row.original.alert_id
          if (!id) return <span className="text-subtle-foreground">—</span>
          const alert = alertTitle(id)
          return (
            <Link
              to="/alerts"
              search={{ alert: id, status: 'all' }}
              onClick={(event) => event.stopPropagation()}
              className="block max-w-64 leading-tight hover:underline"
            >
              <span className="block truncate">{alert?.title ?? 'Alert'}</span>
              {alert?.hostname && <span className="block truncate text-[10.5px] text-subtle-foreground">{alert.hostname}</span>}
            </Link>
          )
        },
      },
      {
        id: 'rule',
        accessorFn: (row) => ruleName(row.rule_id) ?? '',
        header: 'Rule',
        cell: ({ row }) => {
          const name = ruleName(row.original.rule_id)
          return name ? <span className="block max-w-44 truncate">{name}</span> : <span className="text-subtle-foreground">—</span>
        },
      },
      {
        id: 'attempt',
        accessorKey: 'attempt',
        header: 'Attempt',
        meta: { align: 'right' },
        cell: ({ row }) => <span className="tabular text-muted-foreground">{attemptLabel(row.original)}</span>,
      },
      {
        id: 'result',
        accessorFn: (row) => row.error ?? '',
        header: 'Result',
        enableSorting: false,
        cell: ({ row }) => {
          const entry = row.original
          if (entry.status === 'suppressed')
            return (
              <span className="flex max-w-[22rem] items-center gap-1.5 text-muted-foreground" title={entry.error ?? undefined}>
                <Moon className="size-3.5 shrink-0 text-info" />
                <span className="truncate">Held back by quiet hours — not sent later</span>
              </span>
            )
          if (entry.status === 'pending')
            return <span className="text-warning">Retry scheduled</span>
          return (
            <span className="block max-w-[22rem] truncate" title={entry.error ?? undefined}>
              {entry.http_status ? <span className="tabular font-mono text-[11.5px] text-muted-foreground">HTTP {entry.http_status}</span> : null}
              {entry.error ? (
                <span className={cn('text-critical/90', entry.http_status && 'ml-2')}>{entry.error}</span>
              ) : entry.status === 'sent' ? (
                <span className={cn('text-muted-foreground', entry.http_status && 'ml-2')}>Delivered</span>
              ) : null}
              {entry.next_attempt_at && (
                <span className="ml-2 text-micro text-subtle-foreground">
                  next try <When value={entry.next_attempt_at} />
                </span>
              )}
            </span>
          )
        },
      },
    ]
  }, [alerts, rules])

  return (
    <div className="grid grid-cols-1 gap-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {STATUSES.map((status) => (
            <ChipToggle
              key={status}
              pressed={statuses.includes(status)}
              onPressedChange={(on) => setStatuses((prev) => (on ? [...prev, status] : prev.filter((item) => item !== status)))}
            >
              {DELIVERY_STATUS_LABEL[status]}
              <span className="tabular text-micro text-subtle-foreground">{formatNumber(counts[status])}</span>
            </ChipToggle>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <SimpleSelect
            className="sm:w-56"
            ariaLabel="Channel"
            value={channelId}
            onValueChange={setChannelId}
            options={[
              { value: 'all', label: 'All channels' },
              ...channels.map((channel) => ({ value: channel.id, label: channel.name })),
            ]}
          />
          <Button variant="outline" size="icon" aria-label="Refresh" onClick={() => void refetch()} disabled={isFetching}>
            <RefreshCw className={cn(isFetching && 'animate-spin')} />
          </Button>
        </div>
      </div>
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <DataTable
          data={filtered}
          columns={columns}
          loading={isLoading}
          getRowId={(row) => row.id}
          initialSorting={[{ id: 'at', desc: true }]}
          caption="Notification delivery log"
          virtualHeight={filtered.length > 40 ? 'clamp(360px, calc(100dvh - 330px), 900px)' : undefined}
          empty={
            <div className="p-6">
              <EmptyState
                compact
                illustration="alerts"
                title={rows.length ? 'No deliveries match these filters' : 'Nothing delivered yet'}
                description={
                  rows.length
                    ? 'Clear a filter to see more.'
                    : 'Every attempt — sent, failed, retried or held by quiet hours — shows up here.'
                }
              />
            </div>
          }
        />
      )}
      <p className="text-micro text-subtle-foreground">
        Failed deliveries retry three times (after 10 s, 1 min and 5 min). The newest 300 attempts are shown; retention follows the monitoring settings.
      </p>
    </div>
  )
}
