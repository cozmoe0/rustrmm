import { useQuery } from '@tanstack/react-query'
import { ticketsApi } from '@/lib/api/endpoints'
import { ticketKeys } from '@/lib/api/queries'
import type { TicketCounts, TicketFilters } from '@/lib/api/types'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useScope } from '@/lib/scope'

/**
 * Active-ticket counts (`counts` of `GET /tickets`, which ignore the status filter) for a scope.
 * `tickets.counts` events invalidate these queries; the interval is a safety net.
 */
export function useTicketCounts(filters: TicketFilters = {}, enabled = true): { counts: TicketCounts | undefined; open: number | undefined } {
  const me = useMe()
  const canView = hasPermission(me, PERMISSIONS.ticketsView)
  const query: TicketFilters = { ...filters, limit: 1 }
  const { data } = useQuery({
    queryKey: ticketKeys.counts(query),
    queryFn: () => ticketsApi.list(query),
    enabled: canView && enabled,
    refetchInterval: 60_000,
    staleTime: 10_000,
    meta: { silent: true },
  })
  const counts = data?.counts
  return { counts, open: counts ? counts.new + counts.open + counts.pending + counts.on_hold : undefined }
}

/** Counts for the console's current client/site scope. */
export function useScopedTicketCounts() {
  const { clientId, siteId } = useScope()
  return useTicketCounts({ client_id: clientId, site_id: siteId })
}
