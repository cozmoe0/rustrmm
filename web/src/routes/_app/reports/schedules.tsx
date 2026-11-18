import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { SchedulesPage } from '@/features/reports/schedules-page'

export const Route = createFileRoute('/_app/reports/schedules')({
  validateSearch: z.object({ edit: z.string().optional(), type: z.string().optional() }),
  staticData: { title: 'Schedules' },
  component: SchedulesRoute,
})

function SchedulesRoute() {
  return <SchedulesPage search={Route.useSearch()} />
}
