import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { ApprovalsPage } from '@/features/automation/approvals-page'

export const Route = createFileRoute('/_app/automation/approvals')({
  validateSearch: z.object({ tab: z.enum(['pending', 'decided']).optional() }),
  staticData: { title: 'Approvals' },
  component: ApprovalsRoute,
})

function ApprovalsRoute() {
  const { tab } = Route.useSearch()
  return <ApprovalsPage tab={tab ?? 'pending'} />
}
