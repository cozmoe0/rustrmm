import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { UpdatesPage } from '@/features/patching/updates-page'

export const Route = createFileRoute('/_app/patching/updates')({
  validateSearch: z.object({
    q: z.string().optional(),
    platform: z.enum(['windows', 'linux', 'macos', 'winget']).optional(),
    classification: z.string().optional(),
    severity: z.enum(['Critical', 'Important', 'Moderate', 'Low', 'none']).optional(),
    approval: z.enum(['approved', 'declined', 'deferred', 'none']).optional(),
    status: z.enum(['any']).optional(),
    health: z.enum(['failed', 'restart']).optional(),
    patch: z.string().optional(),
    client: z.string().optional(),
    site: z.string().optional(),
  }),
  staticData: { title: 'Updates' },
  component: UpdatesRoute,
})

function UpdatesRoute() {
  return <UpdatesPage search={Route.useSearch()} />
}
