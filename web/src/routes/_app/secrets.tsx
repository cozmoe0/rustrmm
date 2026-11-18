import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { SecretsPage } from '@/features/secrets/secrets-page'

export const Route = createFileRoute('/_app/secrets')({
  validateSearch: z.object({
    kind: z.enum(['bitlocker', 'laps', 'filevault', 'luks']).optional(),
    q: z.string().optional(),
    superseded: z.boolean().optional(),
    item: z.string().optional(),
  }),
  staticData: { title: 'Secrets' },
  component: SecretsRoute,
})

function SecretsRoute() {
  return <SecretsPage search={Route.useSearch()} />
}
