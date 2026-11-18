import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { WebhooksPage } from '@/features/platform/webhooks-page'

export const Route = createFileRoute('/_app/settings/webhooks')({
  validateSearch: z.object({ webhook: z.string().optional(), edit: z.string().optional() }),
  staticData: { title: 'Webhooks' },
  component: WebhooksRoute,
})

function WebhooksRoute() {
  return <WebhooksPage search={Route.useSearch()} />
}
