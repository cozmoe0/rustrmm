import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { ReportViewPage } from '@/features/reports/report-view-page'

export const Route = createFileRoute('/_app/reports/view')({
  validateSearch: z.object({
    type: z.string().catch('executive_summary'),
    client: z.string().optional(),
    site: z.string().optional(),
    period: z.enum(['last_7', 'last_30', 'last_90', 'this_month', 'last_month', 'this_quarter', 'last_quarter', 'custom']).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    products: z.string().optional(),
    severity: z.string().optional(),
    action: z.string().optional(),
    actor: z.string().optional(),
    /** A finished async JSON run to show instead of running the report again. */
    run: z.string().optional(),
  }),
  staticData: { title: 'Report' },
  component: ReportViewRoute,
})

function ReportViewRoute() {
  return <ReportViewPage search={Route.useSearch()} />
}
