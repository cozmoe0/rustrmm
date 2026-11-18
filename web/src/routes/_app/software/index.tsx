import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { ExplorerPage } from '@/features/software/explorer-page'

export const Route = createFileRoute('/_app/software/')({
  validateSearch: z.object({
    q: z.string().optional(),
    publisher: z.string().optional(),
    client: z.string().optional(),
    site: z.string().optional(),
  }),
  component: ExplorerRoute,
})

function ExplorerRoute() {
  return <ExplorerPage search={Route.useSearch()} />
}
