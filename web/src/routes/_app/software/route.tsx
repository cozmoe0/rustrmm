import { createFileRoute } from '@tanstack/react-router'
import { SoftwareLayout } from '@/features/software/software-layout'

export const Route = createFileRoute('/_app/software')({
  staticData: { title: 'Software' },
  component: SoftwareLayout,
})
