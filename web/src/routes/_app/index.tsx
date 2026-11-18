import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { DashboardPage } from '@/features/dashboards/dashboard-page'

export const Route = createFileRoute('/_app/')({
  validateSearch: z.object({ edit: z.boolean().optional() }),
  staticData: { title: 'Home' },
  component: HomeRoute,
})

function HomeRoute() {
  return <DashboardPage dashboardId={null} editing={Boolean(Route.useSearch().edit)} />
}
