import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { VariablesPage } from '@/features/automation/variables-page'

export const Route = createFileRoute('/_app/automation/variables')({
  validateSearch: z.object({ scope: z.enum(['global', 'client', 'site']).optional() }),
  staticData: { title: 'Variables' },
  component: VariablesRoute,
})

function VariablesRoute() {
  const { scope } = Route.useSearch()
  return <VariablesPage scope={scope ?? 'global'} />
}
