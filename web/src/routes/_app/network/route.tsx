import { createFileRoute } from '@tanstack/react-router'
import { NetworkLayout } from '@/features/network/network-layout'

export const Route = createFileRoute('/_app/network')({
  staticData: { title: 'Network' },
  component: NetworkLayout,
})
