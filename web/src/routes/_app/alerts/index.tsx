import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { AlertsPage } from '@/features/monitoring/alerts-page'

export const Route = createFileRoute('/_app/alerts/')({
  validateSearch: z.object({
    /** Comma-separated statuses, or `all`. Defaults to open and acknowledged. */
    status: z.string().optional(),
    severity: z.string().optional(),
    source: z.enum(['check', 'server', 'snmp']).optional(),
    check_type: z.string().optional(),
    /** `me`, `none` or a user id. */
    assigned: z.string().optional(),
    q: z.string().optional(),
    group: z.enum(['severity', 'client', 'status', 'none']).optional(),
    /** The alert shown in the detail pane. */
    alert: z.string().optional(),
  }),
  component: AlertsRoute,
})

function AlertsRoute() {
  const search = Route.useSearch()
  return <AlertsPage search={search} />
}
