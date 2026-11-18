import { createFileRoute } from '@tanstack/react-router'
import { RunsPage } from '@/features/patching/runs-page'

export const Route = createFileRoute('/_app/patching/runs/')({
  component: RunsPage,
})
