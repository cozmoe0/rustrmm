import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { DeployPage } from '@/features/devices/deploy-page'

export const Route = createFileRoute('/_app/devices/deploy')({
  validateSearch: z.object({
    section: z.enum(['keys', 'install', 'gpo', 'approvals']).optional(),
    new: z.boolean().optional(),
  }),
  staticData: { title: 'Deploy agents' },
  component: DeployRoute,
})

function DeployRoute() {
  const search = Route.useSearch()
  return <DeployPage search={search} />
}
