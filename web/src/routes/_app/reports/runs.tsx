import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { RunsPage } from '@/features/reports/runs-page'

export const Route = createFileRoute('/_app/reports/runs')({
  validateSearch: z.object({
    schedule: z.string().optional(),
    status: z.enum(['queued', 'running', 'completed', 'failed']).optional(),
  }),
  staticData: { title: 'Run history' },
  component: RunsRoute,
})

function RunsRoute() {
  return <RunsPage search={Route.useSearch()} />
}
