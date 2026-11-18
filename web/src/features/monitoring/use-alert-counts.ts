import { useQuery } from '@tanstack/react-query'
import { alertsSummaryQuery, fleetQuery } from '@/lib/api/queries'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useScope } from '@/lib/scope'

export interface AlertCountsView {
  critical: number
  warning: number
  loading: boolean
}

/**
 * Open critical and warning counts for the current client/site scope. Uses `GET /alerts/summary`
 * (totals, or the client's entry in `by_client`) and falls back to the `alerts` field of the fleet
 * summary, which also honours a site scope.
 */
export function useAlertCounts(): AlertCountsView {
  const me = useMe()
  const { clientId, siteId } = useScope()
  const canView = hasPermission(me, PERMISSIONS.alertsView)
  const summary = useQuery({ ...alertsSummaryQuery, enabled: canView, meta: { silent: true } })
  const fleet = useQuery(fleetQuery(clientId, siteId))
  const fromFleet = fleet.data
    ? (fleet.data.alerts ?? { critical: fleet.data.critical_alerts, warning: fleet.data.warning_alerts })
    : null

  if (summary.data && !siteId) {
    if (!clientId) return { critical: summary.data.critical, warning: summary.data.warning, loading: false }
    const entry = summary.data.by_client.find((item) => item.client_id === clientId)
    return { critical: entry?.critical ?? 0, warning: entry?.warning ?? 0, loading: false }
  }
  if (fromFleet) return { ...fromFleet, loading: false }
  return { critical: 0, warning: 0, loading: summary.isLoading || fleet.isLoading }
}

/** Open alert counts per client from the summary, for client cards. */
export function useClientAlertCounts(): Map<string, { critical: number; warning: number }> {
  const me = useMe()
  const { data } = useQuery({ ...alertsSummaryQuery, enabled: hasPermission(me, PERMISSIONS.alertsView), meta: { silent: true } })
  return new Map((data?.by_client ?? []).map((entry) => [entry.client_id, { critical: entry.critical, warning: entry.warning }]))
}
