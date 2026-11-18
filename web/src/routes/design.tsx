import { createFileRoute } from '@tanstack/react-router'
import { DesignPage } from '@/features/design/design-page'

export const Route = createFileRoute('/design')({
  component: DesignPage,
})
