import { createFileRoute } from '@tanstack/react-router'
import { ProbesPage } from '@/features/network/probes-page'

export const Route = createFileRoute('/_app/network/probes')({
  staticData: { title: 'Probes' },
  component: ProbesPage,
})
