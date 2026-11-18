import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { MaintenancePage } from '@/features/monitoring/maintenance-page'

export const Route = createFileRoute('/_app/alerts/maintenance')({
  validateSearch: z.object({
    /** Opens the editor: a window id, or `new`. */
    edit: z.string().optional(),
  }),
  staticData: { title: 'Maintenance windows' },
  component: MaintenanceRoute,
})

function MaintenanceRoute() {
  const { edit } = Route.useSearch()
  return <MaintenancePage edit={edit} />
}
