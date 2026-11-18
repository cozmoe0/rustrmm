import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { DevicesPage } from '@/features/devices/devices-page'

export const Route = createFileRoute('/_app/devices/')({
  validateSearch: z.object({
    q: z.string().optional(),
    os: z.string().optional(),
    state: z.string().optional(),
    type: z.string().optional(),
    health: z.string().optional(),
    tag: z.string().optional(),
    patch: z.string().optional(),
    /** Legacy Fleet Pulse links (`online` / `offline`). */
    status: z.string().optional(),
  }),
  component: DevicesRoute,
})

function DevicesRoute() {
  const search = Route.useSearch()
  return <DevicesPage search={search} />
}
