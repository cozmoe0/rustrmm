import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { ScansPage } from '@/features/network/scans-page'

export const Route = createFileRoute('/_app/network/scans')({
  validateSearch: z.object({ edit: z.string().optional() }),
  staticData: { title: 'Scans' },
  component: ScansRoute,
})

function ScansRoute() {
  return <ScansPage search={Route.useSearch()} />
}
