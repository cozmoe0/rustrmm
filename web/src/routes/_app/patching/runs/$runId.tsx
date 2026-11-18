import { createFileRoute } from '@tanstack/react-router'
import { RunPage } from '@/features/patching/run-page'
import { patchRunQuery } from '@/lib/api/queries'

export const Route = createFileRoute('/_app/patching/runs/$runId')({
  staticData: { title: 'Run' },
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(patchRunQuery(params.runId))
  },
  component: RunRoute,
})

function RunRoute() {
  return <RunPage runId={Route.useParams().runId} />
}
