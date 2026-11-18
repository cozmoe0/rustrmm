import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { TimePage } from '@/features/tickets/time-page'

export const Route = createFileRoute('/_app/tickets/time')({
  validateSearch: z.object({
    user: z.string().optional(),
    /** Inclusive `YYYY-MM-DD` days. */
    from: z.string().optional(),
    to: z.string().optional(),
    billable: z.enum(['yes', 'no']).optional(),
  }),
  staticData: { title: 'Time report' },
  component: TimeRoute,
})

function TimeRoute() {
  const search = Route.useSearch()
  return <TimePage search={search} />
}
