import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { ApiTokensPage } from '@/features/platform/api-tokens-page'

export const Route = createFileRoute('/_app/settings/api-tokens')({
  validateSearch: z.object({ tokens: z.enum(['mine', 'all']).optional(), new: z.boolean().optional() }),
  staticData: { title: 'API tokens' },
  component: ApiTokensRoute,
})

function ApiTokensRoute() {
  const search = Route.useSearch()
  return <ApiTokensPage view={search.tokens ?? 'mine'} create={Boolean(search.new)} />
}
