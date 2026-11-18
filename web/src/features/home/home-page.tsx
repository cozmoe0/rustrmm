/* Home-page sections around the dashboard: onboarding, the client grid, recent activity and the server card. */
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowUpRight, Check, Clock, DatabaseBackup, HardDrive, MonitorSmartphone, Plus, Rocket, ScrollText, ShieldCheck, TriangleExclamationPoint, Users } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { ClientLogo } from '@/components/brand/client-logo'
import { Can } from '@/components/common/can'
import { EmptyState } from '@/components/common/empty-state'
import { HealthRing } from '@/components/common/health-ring'
import { RelativeTime } from '@/components/common/misc'
import { StatusDot } from '@/components/common/status-dot'
import { auditApi } from '@/lib/api/endpoints'
import {
  backupSettingsQuery,
  backupsQuery,
  clientsQuery,
  complianceQuery,
  devicesQuery,
  fleetQuery,
  healthQuery,
  notificationChannelsQuery,
  usersQuery,
} from '@/lib/api/queries'
import { useClientAlertCounts } from '@/features/monitoring/use-alert-counts'
import { ClientTicketCount } from '@/features/tickets/client-ticket-count'
import { formatBytes, formatDuration, formatNumber } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useScope } from '@/lib/scope'
import { cn } from '@/lib/utils'

/** The setup checklist. `compact` renders a horizontal strip that disappears once everything is done. */
export function OnboardingChecklist({ compact = false, onHide }: { compact?: boolean; onHide?: () => void } = {}) {
  const me = useMe()
  const canUsers = hasPermission(me, PERMISSIONS.usersView)
  const canBackups = hasPermission(me, PERMISSIONS.backupsView)
  const canNotify = hasPermission(me, PERMISSIONS.notificationsManage)
  const { data: channels } = useQuery({ ...notificationChannelsQuery, enabled: canNotify, meta: { silent: true } })
  const { data: users } = useQuery({ ...usersQuery, enabled: canUsers })
  const { data: settings } = useQuery({ ...backupSettingsQuery, enabled: canBackups })
  const { data: backups } = useQuery({ ...backupsQuery, enabled: canBackups })
  const { clientId, siteId } = useScope()
  const { data: fleet } = useQuery(fleetQuery(clientId, siteId))

  const items: { id: string; title: string; description: string; done: boolean; to: string; soon?: string; icon: ReactNode }[] = [
    {
      id: 'agent',
      title: 'Deploy your first agent',
      description: 'Installers, GPO bundles and deploy keys.',
      done: (fleet?.devices_total ?? 0) > 0,
      to: '/devices/deploy',
      icon: <Rocket />,
    },
    {
      id: 'alerts',
      title: 'Configure alert notifications',
      description: 'Email, Slack, Teams, ntfy and webhooks.',
      done: (channels?.length ?? 0) > 0,
      to: canNotify ? '/settings/notifications' : '/alerts',
      icon: <TriangleExclamationPoint />,
    },
    {
      id: 'team',
      title: 'Invite your team',
      description: 'Add technicians and scope them to clients.',
      done: (users?.length ?? 0) > 1,
      to: '/settings/users',
      icon: <Users />,
    },
    {
      id: 'backups',
      title: 'Configure backups',
      description: 'Schedule encrypted, off-host database backups.',
      done: Boolean(settings?.enabled && backups?.some((backup) => backup.status === 'ok')),
      to: '/settings/backups',
      icon: <DatabaseBackup />,
    },
  ]
  const completed = items.filter((item) => item.done).length
  const loaded = fleet !== undefined

  if (compact) {
    if (!loaded || completed === items.length) return null
    return (
      <section aria-label="Get set up" className="overflow-hidden rounded-xl bg-card shadow-card">
        <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2.5">
          <h2 className="text-sm font-semibold">Get set up</h2>
          <Progress value={(completed / items.length) * 100} className="w-32" aria-label="Setup progress" />
          <span className="tabular text-micro text-muted-foreground">
            {completed} of {items.length} done
          </span>
          {onHide && (
            <Button variant="ghost" size="xs" className="ml-auto" onClick={onHide}>
              Hide
            </Button>
          )}
        </header>
        <ul className="grid divide-y divide-border sm:grid-cols-2 sm:divide-y-0 xl:grid-cols-4">
          {items.map((item) => (
            <li key={item.id} className="min-w-0 sm:border-r sm:border-border sm:last:border-r-0">
              <Link to={item.to} className="flex min-w-0 items-center gap-3 px-4 py-3 outline-none transition-colors hover:bg-surface-2 focus-visible:bg-surface-2">
                <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg ring-1 [&_svg]:size-4', item.done ? 'bg-success/12 text-success ring-success/25' : 'bg-surface-3 text-muted-foreground ring-border')}>{item.done ? <Check /> : item.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className={cn('block truncate text-dense font-medium', item.done && 'text-muted-foreground line-through')}>{item.title}</span>
                  <span className="block truncate text-micro text-muted-foreground">{item.description}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    )
  }

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b border-border py-4">
        <CardTitle className="flex items-center justify-between">
          <span>Get set up</span>
          <span className="text-micro font-normal text-muted-foreground tabular">
            {completed} of {items.length} done
          </span>
        </CardTitle>
        <Progress value={(completed / items.length) * 100} className="mt-2" aria-label="Setup progress" />
      </CardHeader>
      <ul className="divide-y divide-border">
        {items.map((item) => {
          const body = (
            <>
              <span
                className={cn(
                  'flex size-8 shrink-0 items-center justify-center rounded-lg ring-1 [&_svg]:size-4',
                  item.done ? 'bg-success/12 text-success ring-success/25' : 'bg-surface-3 text-muted-foreground ring-border',
                )}
              >
                {item.done ? <Check /> : item.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn('block text-dense font-medium', item.done && 'text-muted-foreground line-through')}>
                  {item.title}
                </span>
                <span className="block truncate text-micro text-muted-foreground">{item.description}</span>
              </span>
              {item.soon ? (
                <Badge variant="outline" className="shrink-0">{item.soon}</Badge>
              ) : (
                !item.done && <ArrowUpRight className="size-4 text-subtle-foreground" />
              )}
            </>
          )
          return (
            <li key={item.id}>
              {item.to && !item.soon ? (
                <Link
                  to={item.to}
                  className="flex items-center gap-3 px-4 py-3 outline-none transition-colors hover:bg-surface-2 focus-visible:bg-surface-2"
                >
                  {body}
                </Link>
              ) : (
                <div className="flex items-center gap-3 px-4 py-3 opacity-80" aria-disabled="true">
                  {body}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

export function ClientGrid() {
  const me = useMe()
  const { data: clients, isLoading } = useQuery(clientsQuery())
  const alertsByClient = useClientAlertCounts()
  const { data: devices } = useQuery({ ...devicesQuery(), enabled: hasPermission(me, PERMISSIONS.devicesView) })
  const { data: compliance } = useQuery({ ...complianceQuery('client'), enabled: hasPermission(me, PERMISSIONS.patchesView), meta: { silent: true } })
  const patchedByClient = new Map((compliance?.rows ?? []).map((row) => [row.key, row.compliance_pct]))
  const healthByClient = new Map<string, number>()
  if (devices) {
    const sums = new Map<string, { total: number; count: number }>()
    for (const device of devices) {
      if (device.health_score === null) continue
      const entry = sums.get(device.client_id) ?? { total: 0, count: 0 }
      sums.set(device.client_id, { total: entry.total + device.health_score, count: entry.count + 1 })
    }
    for (const [id, { total, count }] of sums) healthByClient.set(id, Math.round(total / count))
  }

  if (isLoading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-[124px] rounded-xl" />
        ))}
      </div>
    )
  }

  if (!clients || clients.length === 0) {
    return (
      <EmptyState
        illustration="clients"
        title="No clients yet"
        description="Clients are the companies you manage. Add one to start organizing devices into sites."
        actions={
          <Can permission={PERMISSIONS.clientsManage}>
            <Link to="/clients" search={{ new: true }} className={buttonVariants({ size: 'sm' })}>
              <Plus data-icon="inline-start" />
              Add client
            </Link>
          </Can>
        }
      />
    )
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {clients.slice(0, 9).map((client) => (
        <Link
          key={client.id}
          to="/clients/$clientId"
          params={{ clientId: client.id }}
          className="group flex flex-col gap-4 rounded-xl bg-card p-4 shadow-card outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="flex items-start gap-3">
            <ClientLogo client={client} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{client.name}</div>
              <div className="text-micro text-muted-foreground">
                {client.site_count} {client.site_count === 1 ? 'site' : 'sites'} · {formatNumber(client.device_count)}{' '}
                devices
              </div>
            </div>
            <HealthRing score={healthByClient.get(client.id) ?? null} size={38} strokeWidth={3.5} />
          </div>
          <div className="grid grid-cols-3 gap-2 border-t border-border pt-3 text-micro">
            <div>
              <div className="text-subtle-foreground">Alerts</div>
              <AlertCount counts={alertsByClient.get(client.id)} />
            </div>
            <div>
              <div className="text-subtle-foreground">Tickets</div>
              <ClientTicketCount clientId={client.id} />
            </div>
            <div>
              <div className="text-subtle-foreground">Patched</div>
              <PatchedPct pct={patchedByClient.get(client.id)} />
            </div>
          </div>
        </Link>
      ))}
    </div>
  )
}

function PatchedPct({ pct }: { pct: number | undefined }) {
  if (pct === undefined) return <div className="tabular mt-0.5 text-dense font-medium text-subtle-foreground">—</div>
  return <div className={cn('tabular mt-0.5 text-dense font-medium', pct >= 90 ? 'text-live' : pct >= 75 ? 'text-warning' : 'text-critical')}>{Math.round(pct)}%</div>
}

function AlertCount({ counts }: { counts: { critical: number; warning: number } | undefined }) {
  const total = (counts?.critical ?? 0) + (counts?.warning ?? 0)
  return (
    <div
      className={cn(
        'tabular mt-0.5 flex items-center gap-1.5 text-dense font-medium',
        counts?.critical ? 'text-critical' : total ? 'text-warning' : undefined,
      )}
    >
      {total > 0 && <span className={cn('size-1.5 rounded-full', counts?.critical ? 'bg-critical' : 'bg-warning')} />}
      {formatNumber(total)}
    </div>
  )
}

export function RecentActivity() {
  const { data, isLoading } = useQuery({
    queryKey: ['audit', 'recent'],
    queryFn: async () => (await auditApi.list({}, null, 8)).items,
    refetchInterval: 60_000,
  })

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="flex flex-row items-center justify-between border-b border-border py-3.5">
        <CardTitle className="text-sm">Recent activity</CardTitle>
        <Link to="/settings/audit" className="text-micro text-muted-foreground hover:text-foreground">
          View audit log
        </Link>
      </CardHeader>
      <CardContent className="px-0">
        {isLoading ? (
          <div className="grid gap-3 p-4">
            {Array.from({ length: 5 }, (_, index) => (
              <Skeleton key={index} className="h-8" />
            ))}
          </div>
        ) : (
          <ol className="divide-y divide-border">
            {(data ?? []).map((event) => (
              <li key={event.id} className="flex items-center gap-3 px-4 py-2.5">
                <ScrollText className="size-3.5 shrink-0 text-subtle-foreground" />
                <div className="min-w-0 flex-1 text-dense">
                  <span className="font-medium">{event.actor.name ?? event.actor.type}</span>{' '}
                  <span className="font-mono text-[11.5px] text-muted-foreground">{event.action}</span>
                  {event.target?.name && <span className="text-muted-foreground"> · {event.target.name}</span>}
                </div>
                <RelativeTime value={event.at} className="text-micro text-subtle-foreground" />
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  )
}

export function SystemCard() {
  const { data } = useQuery(healthQuery)
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <StatusDot tone={data?.status === 'ok' ? 'live' : 'warning'} pulse={data?.status === 'ok'} />
          Server
        </CardTitle>
        <CardDescription>RustRMM {data?.version ?? '…'}</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-3 text-dense">
          <div>
            <dt className="flex items-center gap-1.5 text-micro text-subtle-foreground">
              <Clock className="size-3" />
              Uptime
            </dt>
            <dd className="tabular mt-0.5 font-medium">{data ? formatDuration(data.uptime_s) : '—'}</dd>
          </div>
          <div>
            <dt className="flex items-center gap-1.5 text-micro text-subtle-foreground">
              <HardDrive className="size-3" />
              Database
            </dt>
            <dd className="tabular mt-0.5 font-medium">{data ? formatBytes(data.db.size_bytes) : '—'}</dd>
          </div>
          <div>
            <dt className="flex items-center gap-1.5 text-micro text-subtle-foreground">
              <MonitorSmartphone className="size-3" />
              Agents connected
            </dt>
            <dd className="tabular mt-0.5 font-medium">{data ? formatNumber(data.agents_connected) : '—'}</dd>
          </div>
          <div>
            <dt className="flex items-center gap-1.5 text-micro text-subtle-foreground">
              <ShieldCheck className="size-3" />
              TLS mode
            </dt>
            <dd className="mt-0.5 font-medium capitalize">{data?.tls_mode ?? '—'}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  )
}

