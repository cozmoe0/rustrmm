import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { AuditPage } from '@/features/audit/audit-page'

export const Route = createFileRoute('/_app/settings/audit')({
  validateSearch: z.object({
    action: z.string().optional(),
    actor_id: z.string().optional(),
    filter_client: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    q: z.string().optional(),
  }),
  staticData: { title: 'Audit log' },
  component: AuditRoute,
})

function AuditRoute() {
  const search = Route.useSearch()
  return <AuditPage search={search} />
}
