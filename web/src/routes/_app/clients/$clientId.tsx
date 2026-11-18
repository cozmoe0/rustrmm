import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { ClientDetailPage } from '@/features/clients/client-detail-page'
import { clientQuery } from '@/lib/api/queries'

export const Route = createFileRoute('/_app/clients/$clientId')({
  validateSearch: z.object({
    tab: z.enum(['overview', 'sites', 'tickets', 'contacts', 'settings']).optional(),
    new: z.boolean().optional(),
  }),
  staticData: { title: 'Client', dynamicTitle: 'client' },
  loader: ({ context, params }) => {
    // Warm the cache; the page handles loading and 404 states itself.
    void context.queryClient.prefetchQuery(clientQuery(params.clientId))
  },
  component: ClientDetailRoute,
})

function ClientDetailRoute() {
  const { clientId } = Route.useParams()
  const search = Route.useSearch()
  return <ClientDetailPage clientId={clientId} search={search} />
}
