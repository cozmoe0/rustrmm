import { createFileRoute } from '@tanstack/react-router'
import { NetworkOverviewPage } from '@/features/network/overview-page'

export const Route = createFileRoute('/_app/network/')({
  component: NetworkOverviewPage,
})
