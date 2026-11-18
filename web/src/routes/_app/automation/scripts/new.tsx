import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { ScriptPage } from '@/features/automation/script-page'

export const Route = createFileRoute('/_app/automation/scripts/new')({
  validateSearch: z.object({
    tab: z.enum(['script', 'parameters', 'versions', 'runs']).optional(),
  }),
  staticData: { title: 'New script' },
  component: NewScriptRoute,
})

function NewScriptRoute() {
  const { tab } = Route.useSearch()
  return <ScriptPage scriptId={null} tab={tab ?? 'script'} />
}
