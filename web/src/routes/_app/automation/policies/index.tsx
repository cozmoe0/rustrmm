import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { PoliciesPage } from '@/features/automation/policies-page'

export const Route = createFileRoute('/_app/automation/policies/')({
  validateSearch: z.object({ new: z.boolean().optional() }),
  component: PoliciesRoute,
})

function PoliciesRoute() {
  return <PoliciesPage createRequested={Boolean(Route.useSearch().new)} />
}
