import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { TopologyPage } from '@/features/network/topology-page'

export const Route = createFileRoute('/_app/network/topology')({
  validateSearch: z.object({ site_id: z.string().optional() }),
  staticData: { title: 'Topology' },
  component: TopologyRoute,
})

function TopologyRoute() {
  return <TopologyPage siteId={Route.useSearch().site_id} />
}
