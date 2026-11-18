import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { PolicyPage } from '@/features/automation/policy-page'
import { policyQuery } from '@/lib/api/queries'

export const Route = createFileRoute('/_app/automation/policies/$policyId')({
  validateSearch: z.object({
    tab: z.enum(['agent', 'remote', 'tasks', 'monitoring', 'patching', 'escrow', 'json', 'assignments']).optional(),
  }),
  staticData: { title: 'Policy', dynamicTitle: 'policy' },
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(policyQuery(params.policyId))
  },
  component: PolicyRoute,
})

function PolicyRoute() {
  const { policyId } = Route.useParams()
  const { tab } = Route.useSearch()
  return <PolicyPage policyId={policyId} tab={tab ?? 'agent'} />
}
