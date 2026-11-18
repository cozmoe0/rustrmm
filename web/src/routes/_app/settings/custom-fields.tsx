import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { CustomFieldsPage } from '@/features/automation/custom-fields-page'

export const Route = createFileRoute('/_app/settings/custom-fields')({
  validateSearch: z.object({ scope: z.enum(['device', 'client', 'site']).optional() }),
  staticData: { title: 'Custom fields' },
  component: CustomFieldsRoute,
})

function CustomFieldsRoute() {
  const { scope } = Route.useSearch()
  return <CustomFieldsPage scope={scope ?? 'device'} />
}
