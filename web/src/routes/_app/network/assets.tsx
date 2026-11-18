import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { AssetsPage } from '@/features/network/assets-page'

export const Route = createFileRoute('/_app/network/assets')({
  validateSearch: z.object({
    site_id: z.string().optional(),
    type: z.enum(['printer', 'switch', 'router', 'ap', 'nas', 'camera', 'phone', 'windows', 'linux', 'mac', 'ups', 'unknown']).optional(),
    managed: z.enum(['managed', 'unmanaged']).optional(),
    q: z.string().optional(),
    ignored: z.boolean().optional(),
    asset: z.string().optional(),
  }),
  staticData: { title: 'Discovered assets' },
  component: AssetsRoute,
})

function AssetsRoute() {
  return <AssetsPage search={Route.useSearch()} />
}
