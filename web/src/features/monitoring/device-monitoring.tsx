/* The device page's Monitoring tab: check states with trends, the device's alerts, maintenance and health. */
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowUpRight, CalendarClock, Check, HeartPulse, ScrollText, ShieldCheck, Wrench } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { EmptyState } from '@/components/common/empty-state'
import { HealthRing } from '@/components/common/health-ring'
import { ErrorState } from '@/components/common/misc'
import { SectionTitle } from '@/components/common/page-header'
import { checkTypesQuery, deviceAlertsQuery, deviceChecksQuery, deviceMaintenanceQuery } from '@/lib/api/queries'
import type { Alert, DeviceCheck, DeviceDetail, MaintenanceWindow } from '@/lib/api/types'
import { countCheckStates, relatedCheckTypes, sortChecks } from '@/lib/monitoring/health'
import { checkTypeLabel, formatInterval } from '@/lib/monitoring/labels'
import { currentOccurrence, describeSchedule, endsIn, startsIn } from '@/lib/monitoring/maintenance'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { cn } from '@/lib/utils'
import { CheckTrend } from './check-trend'
import { CheckStateChip, CheckTypeTile, MaintenanceBadge, SeverityIcon, When } from './monitoring-ui'

function StateBar({ checks }: { checks: DeviceCheck[] }) {
  const counts = countCheckStates(checks)
  const total = checks.length || 1
  const segments = [
    { key: 'critical', value: counts.critical, className: 'bg-critical', label: 'critical' },
    { key: 'warning', value: counts.warning, className: 'bg-warning', label: 'warning' },
    { key: 'unknown', value: counts.unknown, className: 'bg-subtle-foreground/60', label: 'unknown' },
    { key: 'ok', value: counts.ok, className: 'bg-success', label: 'OK' },
    { key: 'pending', value: counts.pending, className: 'bg-surface-4', label: 'waiting' },
  ].filter((segment) => segment.value > 0)
  return (
    <div className="grid gap-2">
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-surface-3" aria-hidden="true">
        {segments.map((segment) => (
          <span key={segment.key} className={cn('h-full', segment.className)} style={{ width: `${(segment.value / total) * 100}%` }} />
        ))}
      </div>
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-micro text-muted-foreground">
        {segments.map((segment) => (
          <span key={segment.key} className="inline-flex items-center gap-1.5">
            <span className={cn('size-1.5 rounded-full', segment.className)} />
            <span className="tabular font-medium text-foreground">{segment.value}</span> {segment.label}
          </span>
        ))}
      </p>
    </div>
  )
}

function CheckRow({ deviceId, check, catalog }: { deviceId: string; check: DeviceCheck; catalog: Parameters<typeof checkTypeLabel>[1] }) {
  return (
    <li
      className={cn(
        'grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 px-4 py-3 md:grid-cols-[auto_minmax(0,1fr)_minmax(9rem,auto)_8.5rem] md:items-center',
        check.state === 'critical' && 'bg-critical/[0.03]',
      )}
    >
      <CheckTypeTile type={check.type} className="row-span-2 md:row-span-1" />
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-dense font-medium">{check.name}</span>
          <CheckStateChip state={check.state} />
        </div>
        <p className="mt-0.5 truncate text-micro text-muted-foreground" title={check.message}>
          {check.message || 'Waiting for the agent to report this check'}
        </p>
      </div>
      <div className="col-start-2 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 md:col-start-auto md:justify-end">
        <CheckTrend deviceId={deviceId} check={check} />
      </div>
      <div className="col-start-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-micro text-subtle-foreground md:col-start-auto md:flex-col md:items-end md:gap-0.5">
        <span>
          {check.last_at ? <When value={check.last_at} /> : 'Not run yet'} · every {formatInterval(check.interval_secs)}
        </span>
        {check.policy_id ? (
          <Link
            to="/automation/policies/$policyId"
            params={{ policyId: check.policy_id }}
            search={{ tab: 'monitoring' }}
            className="inline-flex max-w-full items-center gap-1 truncate text-primary hover:underline"
            title={`${checkTypeLabel(check.type, catalog)} · from ${check.policy_name}`}
          >
            <ScrollText className="size-3 shrink-0" />
            <span className="truncate">{check.policy_name}</span>
          </Link>
        ) : (
          <span>{checkTypeLabel(check.type, catalog)}</span>
        )}
      </div>
    </li>
  )
}

function AlertLine({ alert }: { alert: Alert }) {
  const resolved = alert.status === 'resolved'
  return (
    <li>
      <Link
        to="/alerts"
        search={{ alert: alert.id, status: 'all' }}
        className="flex items-start gap-2.5 rounded-lg px-2 py-2 outline-none transition-colors hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <SeverityIcon severity={alert.severity} className={cn('mt-0.5 size-3.5', resolved && 'opacity-50')} />
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate text-dense font-medium', resolved && 'font-normal text-muted-foreground')}>{alert.title}</span>
          <span className="block truncate text-micro text-subtle-foreground">
            {resolved ? (
              <>
                {alert.resolution === 'auto' ? 'Auto-resolved' : 'Resolved'} <When value={alert.resolved_at} />
              </>
            ) : (
              <>
                {alert.status === 'acknowledged' ? `Acknowledged by ${alert.acknowledged_by_name ?? 'someone'}` : 'Open'} · since{' '}
                <When value={alert.opened_at} />
              </>
            )}
          </span>
        </span>
        {alert.in_maintenance && !resolved && <Wrench className="mt-0.5 size-3.5 shrink-0 text-info" aria-label="In maintenance" />}
      </Link>
    </li>
  )
}

function MaintenanceBanner({ window }: { window: MaintenanceWindow }) {
  const occurrence = currentOccurrence(window.schedule)
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl bg-info/[0.07] px-4 py-3 ring-1 ring-info/25">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-info/15 text-info">
        <Wrench className="size-4" />
      </span>
      <div className="min-w-0 flex-1 basis-64">
        <p className="text-dense font-medium">
          In maintenance: {window.name}
          {occurrence && <span className="font-normal text-muted-foreground"> · {endsIn(occurrence.end)}</span>}
        </p>
        <p className="text-micro text-muted-foreground">
          {window.suppress === 'alerts'
            ? 'No new alerts open on this device until the window ends.'
            : 'Alerts are still recorded, but notifications and remediation are held back.'}
        </p>
      </div>
      <Link to="/alerts/maintenance" className="text-dense font-medium text-info hover:underline">
        Maintenance windows
      </Link>
    </div>
  )
}

function HealthImpact({ device, checks, alerts }: { device: DeviceDetail; checks: DeviceCheck[]; alerts: Alert[] }) {
  const reasons = device.health.reasons
  return (
    <Card size="sm" className="gap-3">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-sm [&_svg]:size-4 [&_svg]:text-subtle-foreground">
          <HeartPulse />
          Health impact
        </CardTitle>
        <HealthRing score={device.status === 'active' ? device.health.score : null} size={30} strokeWidth={3} className="[&_span]:text-[10px]" />
      </CardHeader>
      <CardContent>
        {reasons.length === 0 ? (
          <p className="flex items-center gap-2 text-dense text-live">
            <Check className="size-4" /> Nothing is lowering this device’s score.
          </p>
        ) : (
          <ul className="grid gap-1.5">
            {reasons.map((reason) => {
              const types = relatedCheckTypes(reason.label)
              const check = checks.find((item) => types.includes(item.type))
              const alert = alerts.find((item) => item.status !== 'resolved' && types.includes(item.check_type))
              return (
                <li key={reason.label} className="rounded-md bg-surface-2 px-2.5 py-1.5 ring-1 ring-border">
                  <div className="flex items-center justify-between gap-3 text-dense">
                    <span className="min-w-0 truncate">{reason.label}</span>
                    <span className="tabular shrink-0 font-mono text-[11px] text-critical">−{reason.penalty}</span>
                  </div>
                  {(check || alert) && (
                    <div className="mt-1 flex min-w-0 items-center gap-1.5 text-micro text-muted-foreground">
                      {check ? (
                        <>
                          <CheckStateChip state={check.state} className="h-4 text-[10px]" />
                          <span className="truncate">{check.name}</span>
                        </>
                      ) : (
                        alert && (
                          <Link to="/alerts" search={{ alert: alert.id, status: 'all' }} className="inline-flex min-w-0 items-center gap-1 hover:text-foreground">
                            <SeverityIcon severity={alert.severity} className="size-3" />
                            <span className="truncate">{alert.title}</span>
                          </Link>
                        )
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

export function DeviceMonitoringTab({ device }: { device: DeviceDetail }) {
  const me = useMe()
  const canView = hasPermission(me, PERMISSIONS.alertsView)
  const checks = useQuery({ ...deviceChecksQuery(device.id), enabled: canView })
  const alerts = useQuery({ ...deviceAlertsQuery(device.id, 'all'), enabled: canView })
  const maintenance = useQuery({ ...deviceMaintenanceQuery(device.id), enabled: canView })
  const { data: catalog } = useQuery({ ...checkTypesQuery, enabled: canView, meta: { silent: true } })

  if (!canView)
    return (
      <EmptyState
        illustration="alerts"
        title="You can’t view monitoring"
        description="Ask an administrator for the “View alerts” permission."
      />
    )
  if (device.status !== 'active')
    return (
      <EmptyState
        illustration="alerts"
        title="Monitoring starts once the device is active"
        description="Approved, connected agents receive their checks from the effective policy."
      />
    )

  const list = sortChecks(checks.data ?? [])
  const allAlerts = alerts.data?.items ?? []
  const open = allAlerts.filter((alert) => alert.status !== 'resolved')
  const recent = allAlerts.filter((alert) => alert.status === 'resolved').slice(0, 5)
  const failing = list.filter((check) => check.state === 'critical' || check.state === 'warning').length

  return (
    <div className="grid grid-cols-1 gap-4">
      {maintenance.data?.active.map((window) => <MaintenanceBanner key={window.id} window={window} />)}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <section className="grid min-w-0 content-start gap-3">
          <SectionTitle
            description={
              checks.data
                ? failing
                  ? `${failing} of ${list.length} checks need attention.`
                  : `All ${list.length} checks are passing.`
                : 'Checks come from the device’s effective policy.'
            }
            actions={
              <Link to="/devices/$deviceId" params={{ deviceId: device.id }} search={{ tab: 'policy' }} className="text-dense text-muted-foreground hover:text-foreground">
                Effective policy
              </Link>
            }
          >
            Checks
          </SectionTitle>
          {checks.error ? (
            <ErrorState error={checks.error} onRetry={() => void checks.refetch()} />
          ) : checks.isLoading ? (
            <Skeleton className="h-72 rounded-xl" />
          ) : list.length === 0 ? (
            <EmptyState
              compact
              illustration="alerts"
              title="No checks apply to this device"
              description="Add checks to a policy’s Monitoring tab and assign it globally, to this client, site, a group or the device."
            />
          ) : (
            <div className="overflow-hidden rounded-xl bg-card shadow-card">
              <div className="border-b border-border px-4 py-3">
                <StateBar checks={list} />
              </div>
              <ul className="divide-y divide-border">
                {list.map((check) => (
                  <CheckRow key={check.check_id} deviceId={device.id} check={check} catalog={catalog} />
                ))}
              </ul>
            </div>
          )}
        </section>

        <aside className="grid min-w-0 content-start gap-4">
          <Card size="sm" className="gap-2">
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                Alerts
                {open.length > 0 && <Badge variant={open.some((alert) => alert.severity === 'critical') ? 'critical' : 'warning'}>{open.length} open</Badge>}
              </CardTitle>
              <Link
                to="/alerts"
                search={{ q: device.hostname, status: 'all' }}
                className="inline-flex items-center gap-0.5 text-micro text-muted-foreground hover:text-foreground"
              >
                Inbox
                <ArrowUpRight className="size-3" />
              </Link>
            </CardHeader>
            <CardContent className="px-2">
              {alerts.isLoading ? (
                <div className="grid gap-2 px-2">
                  <Skeleton className="h-9" />
                  <Skeleton className="h-9" />
                </div>
              ) : allAlerts.length === 0 ? (
                <p className="flex items-center gap-2 px-2 py-2 text-dense text-muted-foreground">
                  <ShieldCheck className="size-4 text-live" />
                  No alerts on record for this device.
                </p>
              ) : (
                <>
                  {open.length === 0 && (
                    <p className="flex items-center gap-2 px-2 pb-1 text-dense text-live">
                      <Check className="size-4" /> All clear right now
                    </p>
                  )}
                  <ul className="grid">
                    {[...open, ...recent].map((alert) => (
                      <AlertLine key={alert.id} alert={alert} />
                    ))}
                  </ul>
                </>
              )}
            </CardContent>
          </Card>

          <HealthImpact device={device} checks={list} alerts={allAlerts} />

          <Card size="sm" className="gap-2">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm [&_svg]:size-4 [&_svg]:text-subtle-foreground">
                <CalendarClock />
                Maintenance
              </CardTitle>
            </CardHeader>
            <CardContent>
              {!maintenance.data ? (
                <Skeleton className="h-10" />
              ) : maintenance.data.active.length + maintenance.data.upcoming.length === 0 ? (
                <p className="text-dense text-muted-foreground">No maintenance windows in the next 30 days.</p>
              ) : (
                <ul className="grid gap-2">
                  {[...maintenance.data.active, ...maintenance.data.upcoming].map((window) => (
                    <li key={window.id} className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-dense font-medium">{window.name}</span>
                        {window.active_now ? (
                          <MaintenanceBadge label="Now" />
                        ) : (
                          <Tooltip>
                            <TooltipTrigger render={<span className="tabular shrink-0 text-micro text-muted-foreground" />}>
                              {startsIn(window.next_start)}
                            </TooltipTrigger>
                            <TooltipContent>{window.next_start ? new Date(window.next_start).toLocaleString() : ''}</TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                      <p className="truncate text-micro text-subtle-foreground">{describeSchedule(window.schedule)}</p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  )
}

/** Small count next to the tab label: failing checks, coloured by the worst state. */
export function MonitoringTabCount({ deviceId }: { deviceId: string }) {
  const me = useMe()
  const { data } = useQuery({ ...deviceChecksQuery(deviceId), enabled: hasPermission(me, PERMISSIONS.alertsView), meta: { silent: true } })
  if (!data) return null
  const counts = countCheckStates(data)
  const failing = counts.critical + counts.warning
  if (!failing) return null
  return (
    <span
      className={cn(
        'tabular inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold',
        counts.critical ? 'bg-critical/15 text-critical' : 'bg-warning/15 text-warning',
      )}
    >
      {failing}
    </span>
  )
}
