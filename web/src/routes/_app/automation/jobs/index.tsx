import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { JobsPage } from '@/features/automation/jobs-page'

export const Route = createFileRoute('/_app/automation/jobs/')({
  validateSearch: z.object({
    status: z.enum(['pending_approval', 'scheduled', 'running', 'completed', 'cancelled', 'rejected']).optional(),
    q: z.string().optional(),
  }),
  component: JobsRoute,
})

function JobsRoute() {
  return <JobsPage search={Route.useSearch()} />
}
