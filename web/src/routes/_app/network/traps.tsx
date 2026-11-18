import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { TrapsPage } from '@/features/network/traps-page'

export const Route = createFileRoute('/_app/network/traps')({
  validateSearch: z.object({ site_id: z.string().optional(), tab: z.enum(['traps', 'rules']).optional(), q: z.string().optional() }),
  staticData: { title: 'Traps' },
  component: TrapsRoute,
})

function TrapsRoute() {
  return <TrapsPage search={Route.useSearch()} />
}
