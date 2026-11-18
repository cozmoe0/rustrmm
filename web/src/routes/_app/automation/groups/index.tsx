import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { GroupsPage } from '@/features/automation/groups-page'

export const Route = createFileRoute('/_app/automation/groups/')({
  validateSearch: z.object({ new: z.boolean().optional() }),
  component: GroupsRoute,
})

function GroupsRoute() {
  return <GroupsPage createRequested={Boolean(Route.useSearch().new)} />
}
