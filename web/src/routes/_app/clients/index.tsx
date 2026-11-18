import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { ClientsPage } from '@/features/clients/clients-page'

export const Route = createFileRoute('/_app/clients/')({
  validateSearch: z.object({
    q: z.string().optional(),
    view: z.enum(['cards', 'table']).optional(),
    new: z.boolean().optional(),
  }),
  component: ClientsRoute,
})

function ClientsRoute() {
  const search = Route.useSearch()
  return <ClientsPage search={search} />
}
