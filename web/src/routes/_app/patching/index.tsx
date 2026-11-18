import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { OverviewPage } from '@/features/patching/overview-page'

export const Route = createFileRoute('/_app/patching/')({
  validateSearch: z.object({ group: z.enum(['client', 'site', 'os']).optional() }),
  component: OverviewRoute,
})

function OverviewRoute() {
  return <OverviewPage group={Route.useSearch().group ?? 'client'} />
}
