/* The effective monitoring configuration of one device, with the policy each value comes from. */
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Activity, Gauge, RefreshCw, ScrollText, ServerCog } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { checkTypesQuery, monitoringSettingsQuery } from '@/lib/api/queries'
import type { DeviceDetail, EffectivePolicy } from '@/lib/api/types'
import { checkRunsOn, effectiveMonitoring, type EffectiveCheckRow } from '@/lib/monitoring/policy-monitoring'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { cn } from '@/lib/utils'
import { PlatformIcons } from '@/features/automation/automation-ui'
import { CheckTypeTile, SeverityBadge } from './monitoring-ui'

function Origin({ origin }: { origin: { id: string; name: string } | null }) {
  if (!origin) return <span className="text-micro text-subtle-foreground">Default</span>
  return (
    <Link
      to="/automation/policies/$policyId"
      params={{ policyId: origin.id }}
      search={{ tab: 'monitoring' }}
      className="inline-flex h-6 max-w-full items-center gap-1 rounded-md bg-primary/8 px-2 text-micro font-medium text-primary ring-1 ring-primary/20 hover:bg-primary/12"
    >
      <ScrollText className="size-3 shrink-0" />
      <span className="truncate">{origin.name}</span>
    </Link>
  )
}

function CheckRow({ row, runs }: { row: EffectiveCheckRow; runs: boolean }) {
  const muted = !row.enabled || !runs
  return (
    <li className="grid grid-cols-1 gap-x-4 gap-y-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,11rem)] sm:items-center">
      <div className={cn('flex min-w-0 items-start gap-3', muted && 'opacity-60')}>
        <CheckTypeTile type={row.type ?? 'check'} />
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-dense font-medium">{row.name}</span>
            {!row.enabled && <Badge variant="outline">Disabled</Badge>}
            {row.enabled && !runs && <Badge variant="outline">Not for this platform</Badge>}
            {row.hasRemediation && (
              <Badge variant="default">
                <RefreshCw />
                Auto-fix
              </Badge>
            )}
          </div>
          <div className="truncate text-micro text-muted-foreground">
            {row.typeLabel}
            {row.summary ? ` · ${row.summary}` : ''}
          </div>
        </div>
      </div>
      <div className={cn('flex flex-wrap items-center gap-2 sm:justify-end', muted && 'opacity-60')}>
        {row.platforms?.length ? <PlatformIcons platforms={row.platforms} className="text-muted-foreground" /> : null}
        <span className="tabular text-micro text-muted-foreground">every {row.interval}</span>
        {row.graded ? (
          <Badge variant="secondary">
            <Gauge />
            Follows state
          </Badge>
        ) : (
          <SeverityBadge severity={row.severity} />
        )}
      </div>
      <div className="min-w-0 sm:text-right">
        <Origin origin={row.origin} />
      </div>
    </li>
  )
}

export function DevicePolicyMonitoring({ device, effective }: { device: DeviceDetail; effective: EffectivePolicy }) {
  const me = useMe()
  const { data: catalog, isLoading } = useQuery(checkTypesQuery)
  const { data: settings } = useQuery({
    ...monitoringSettingsQuery,
    enabled: hasPermission(me, PERMISSIONS.settingsView),
    meta: { silent: true },
  })
  const { checks, server } = effectiveMonitoring(effective, catalog, settings?.default_offline_minutes ?? 15)
  const definition = (type: string | undefined) => catalog?.find((item) => item.type === type)
  const running = checks.filter((row) => row.enabled && checkRunsOn(row, definition(row.type), device.os_family)).length
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
      <section className="overflow-hidden rounded-xl bg-card shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Activity className="size-4 text-subtle-foreground" />
            Monitoring checks
          </h3>
          <span className="text-micro text-muted-foreground">
            {running} of {checks.length} run on this device · origin is the last policy that changed each check
          </span>
        </div>
        {isLoading ? (
          <div className="grid gap-2 p-4">
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton key={index} className="h-10 rounded-lg" />
            ))}
          </div>
        ) : checks.length === 0 ? (
          <p className="px-4 py-5 text-dense text-muted-foreground">
            No monitoring checks reach this device. Add checks to a policy assigned to it, such as the baseline policy.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {checks.map((row) => (
              <CheckRow key={row.id} row={row} runs={checkRunsOn(row, definition(row.type), device.os_family)} />
            ))}
          </ul>
        )}
      </section>
      <section className="self-start overflow-hidden rounded-xl bg-card shadow-card">
        <h3 className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-sm font-semibold">
          <ServerCog className="size-4 text-subtle-foreground" />
          Server-side checks
        </h3>
        <ul className="divide-y divide-border">
          {server.map((row) => (
            <li key={row.key} className="flex items-start justify-between gap-3 px-4 py-2.5">
              <div className="min-w-0">
                <div className="text-dense font-medium">{row.label}</div>
                <div className={cn('tabular text-micro', row.value === 'Off' ? 'text-subtle-foreground' : 'text-muted-foreground')}>
                  {row.value}
                </div>
              </div>
              <div className="min-w-0 shrink-0 pt-0.5">
                <Origin origin={row.origin} />
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
