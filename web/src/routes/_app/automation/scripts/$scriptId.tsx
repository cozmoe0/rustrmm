import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { ScriptPage } from '@/features/automation/script-page'
import { scriptQuery } from '@/lib/api/queries'

export const Route = createFileRoute('/_app/automation/scripts/$scriptId')({
  validateSearch: z.object({
    tab: z.enum(['script', 'parameters', 'versions', 'runs']).optional(),
  }),
  staticData: { title: 'Script', dynamicTitle: 'script' },
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(scriptQuery(params.scriptId))
  },
  component: ScriptRoute,
})

function ScriptRoute() {
  const { scriptId } = Route.useParams()
  const { tab } = Route.useSearch()
  return <ScriptPage scriptId={scriptId} tab={tab ?? 'script'} />
}
