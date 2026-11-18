import { createFileRoute } from '@tanstack/react-router'
import { PatchingLayout } from '@/features/patching/patching-layout'

export const Route = createFileRoute('/_app/patching')({
  staticData: { title: 'Patching' },
  component: PatchingLayout,
})
