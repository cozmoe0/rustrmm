import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { DashboardPage } from '@/features/dashboards/dashboard-page'

export const Route = createFileRoute('/_app/dashboards/$dashboardId')({
  validateSearch: z.object({ edit: z.boolean().optional() }),
  staticData: { title: 'Dashboard' },
  component: DashboardRoute,
})

function DashboardRoute() {
  const { dashboardId } = Route.useParams()
  const { edit } = Route.useSearch()
  return <DashboardPage dashboardId={dashboardId} editing={Boolean(edit)} />
}
