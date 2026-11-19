import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { AGENT_UPDATE_VIEWS } from '@/features/devices/agent-updates'
import { AgentUpdatesPage } from '@/features/devices/agent-updates-page'

export const Route = createFileRoute('/_app/devices/updates')({
  validateSearch: z.object({
    show: z.enum(AGENT_UPDATE_VIEWS).optional(),
  }),
  staticData: { title: 'Agent updates' },
  component: AgentUpdatesRoute,
})

function AgentUpdatesRoute() {
  const search = Route.useSearch()
  return <AgentUpdatesPage search={search} />
}
