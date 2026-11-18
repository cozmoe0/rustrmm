import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { keys, fleetQuery, snmpDevicesQuery } from '@/lib/api/queries'
import { useStreamEvent, useStreamStatus } from '@/lib/api/stream'
import type { DevicesChangedEvent, FleetSummary } from '@/lib/api/types'
import { formatNumber } from '@/lib/format'
import { useScope } from '@/lib/scope'
import { cn } from '@/lib/utils'
import { StatusDot } from '@/components/common/status-dot'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAlertCounts } from '@/features/monitoring/use-alert-counts'
import { useScopedTicketCounts } from '@/features/tickets/use-ticket-counts'
import { useNetworkLive } from '@/features/network/use-network-live'
import { useEscrowLive } from '@/features/secrets/use-escrow-live'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useScopedSites } from '@/features/network/use-network'

/** A number that replays a short tick animation whenever its value changes. */
function TickNumber({ value, className }: { value: string; className?: string }) {
  return (
    <span className={cn('tabular inline-block overflow-hidden align-bottom', className)}>
      <span key={value} className="inline-block animate-tick">
        {value}
      </span>
    </span>
  )
}

function PulseItem({
  to,
  search,
  label,
  value,
  indicator,
  tone,
  children,
}: {
  to: string
  search?: Record<string, string>
  label: string
  value: string
  indicator?: ReactNode
  tone?: string
  children?: ReactNode
}) {
  return (
    <Link
      to={to}
      search={search}
      className="group flex h-full shrink-0 items-center gap-2 rounded-md px-2.5 text-dense outline-none transition-colors hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-ring"
    >
      {indicator}
      <TickNumber value={value} className={cn('font-semibold text-foreground', tone)} />
      <span className="text-muted-foreground group-hover:text-foreground">{label}</span>
      {children}
    </Link>
  )
}

function LiveIndicator() {
  const status = useStreamStatus()
  const live = status === 'open'
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="flex shrink-0 items-center gap-1.5 px-2 text-micro font-medium tracking-wide text-subtle-foreground uppercase" />
        }
      >
        <StatusDot tone={live ? 'live' : 'offline'} pulse={live} />
        {live ? 'Live' : status === 'idle' ? 'Paused' : status === 'connecting' ? 'Connecting' : 'Reconnecting'}
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {live ? 'Receiving real-time updates' : 'Real-time updates are reconnecting; data refreshes every 30s'}
      </TooltipContent>
    </Tooltip>
  )
}

export function FleetPulse() {
  const { clientId, siteId } = useScope()
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery(fleetQuery(clientId, siteId))

  useStreamEvent<(FleetSummary & { client_id?: string | null; site_id?: string | null }) | null>('fleet.summary', (event) => {
    // `null` means "something changed, refetch". Full payloads are applied only when they match the scope.
    if (event && (event.client_id ?? undefined) === clientId && (event.site_id ?? undefined) === siteId) {
      queryClient.setQueryData(keys.fleet(clientId, siteId), event)
    } else {
      void queryClient.invalidateQueries({ queryKey: ['fleet'] })
    }
  })

  // The shell is always mounted, so it keeps device lists and summaries fresh for every page.
  useStreamEvent<DevicesChangedEvent>('devices.changed', (event) => {
    void queryClient.invalidateQueries({ queryKey: ['fleet'] })
    void queryClient.invalidateQueries({ queryKey: [...keys.devices, 'list'] })
    if (event?.id) void queryClient.invalidateQueries({ queryKey: keys.device(event.id) })
  })

  // Phase 10: escrow and network live updates; unreachable SNMP devices get a pulse item.
  const me = useMe()
  const canNetwork = hasPermission(me, PERMISSIONS.networkView)
  useNetworkLive(canNetwork)
  useEscrowLive(hasPermission(me, PERMISSIONS.secretsReveal) || hasPermission(me, PERMISSIONS.secretsManage))
  const { data: snmpDevices } = useQuery({ ...snmpDevicesQuery(), enabled: canNetwork, meta: { silent: true } })
  const { byId: scopedSites } = useScopedSites()
  const snmpDown = (snmpDevices ?? []).filter((device) => device.enabled && device.status === 'unreachable' && scopedSites.has(device.site_id)).length

  const patched = data?.patch_compliance_pct ?? null
  const alerts = useAlertCounts()
  const tickets = useScopedTicketCounts()

  return (
    <div
      role="region"
      aria-label="Fleet pulse"
      className="flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border bg-background px-2 [scrollbar-width:none] sm:px-3"
    >
      {isLoading || !data ? (
        <div className="flex items-center gap-4 px-2">
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className="h-3.5 w-24" />
          ))}
        </div>
      ) : (
        <>
          <PulseItem
            to="/devices"
            search={{ state: 'online' }}
            label="online"
            value={formatNumber(data.online)}
            indicator={<StatusDot tone="live" pulse={data.online > 0} />}
          />
          <PulseItem
            to="/devices"
            search={{ state: 'offline' }}
            label="offline"
            value={formatNumber(data.offline)}
            indicator={<StatusDot tone="offline" />}
          />
          {(data.pending_approval ?? 0) > 0 && (
            <PulseItem
              to="/devices/deploy"
              search={{ section: 'approvals' }}
              label="awaiting approval"
              value={formatNumber(data.pending_approval ?? 0)}
              tone="text-info"
              indicator={<StatusDot tone="info" pulse />}
            />
          )}
          <span className="mx-1 h-4 w-px shrink-0 bg-border-strong" />
          <PulseItem
            to="/alerts"
            search={{ severity: 'critical' }}
            label="critical"
            value={formatNumber(alerts.critical)}
            tone={alerts.critical > 0 ? 'text-critical' : undefined}
            indicator={<StatusDot tone={alerts.critical > 0 ? 'critical' : 'neutral'} pulse={alerts.critical > 0} />}
          />
          <PulseItem
            to="/alerts"
            search={{ severity: 'warning' }}
            label="warnings"
            value={formatNumber(alerts.warning)}
            tone={alerts.warning > 0 ? 'text-warning' : undefined}
            indicator={<StatusDot tone={alerts.warning > 0 ? 'warning' : 'neutral'} />}
          />
          {snmpDown > 0 && (
            <PulseItem
              to="/network/snmp"
              search={{ status: 'unreachable' }}
              label="SNMP down"
              value={formatNumber(snmpDown)}
              tone="text-critical"
              indicator={<StatusDot tone="critical" />}
            />
          )}
          <span className="mx-1 h-4 w-px shrink-0 bg-border-strong" />
          <PulseItem
            to="/patching"
            label="patched"
            value={patched === null ? '—' : `${patched.toFixed(Number.isInteger(patched) ? 0 : 1)}%`}
          >
            <span className="relative h-1 w-12 overflow-hidden rounded-full bg-surface-4" aria-hidden="true">
              <span
                className="absolute inset-y-0 left-0 rounded-full bg-live transition-[width] duration-700 ease-(--ease-snappy)"
                style={{ width: `${patched ?? 0}%` }}
              />
            </span>
          </PulseItem>
          <span className="mx-1 h-4 w-px shrink-0 bg-border-strong" />
          <PulseItem to="/tickets" label="open tickets" value={formatNumber(data.open_tickets)} />
          {(tickets.counts?.breached ?? 0) > 0 && (
            <PulseItem
              to="/tickets"
              search={{ sla: 'breached' }}
              label="breached"
              value={formatNumber(tickets.counts?.breached ?? 0)}
              tone="text-critical"
              indicator={<StatusDot tone="critical" pulse />}
            />
          )}
          <Link
            to="/devices"
            className="ml-auto shrink-0 rounded-sm pl-2 text-micro text-subtle-foreground tabular outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {formatNumber(data.devices_total)} devices
            {data.average_health != null && <> · health {Math.round(data.average_health)}</>}
          </Link>
        </>
      )}
      <LiveIndicator />
    </div>
  )
}
