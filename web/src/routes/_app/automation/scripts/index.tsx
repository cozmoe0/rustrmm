import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { ScriptsPage } from '@/features/automation/scripts-page'

export const Route = createFileRoute('/_app/automation/scripts/')({
  validateSearch: z.object({
    q: z.string().optional(),
    category: z.string().optional(),
    language: z.string().optional(),
    platform: z.string().optional(),
    source: z.enum(['builtin', 'custom']).optional(),
    approval: z.enum(['approved', 'unapproved']).optional(),
    archived: z.boolean().optional(),
    layout: z.enum(['grid', 'list']).optional(),
    sort: z.enum(['name', 'updated', 'run']).optional(),
  }),
  component: ScriptsRoute,
})

function ScriptsRoute() {
  return <ScriptsPage search={Route.useSearch()} />
}
