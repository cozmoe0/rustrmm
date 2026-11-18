import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { SsoPage } from '@/features/platform/sso-page'

export const Route = createFileRoute('/_app/settings/sso')({
  validateSearch: z.object({ edit: z.string().optional() }),
  staticData: { title: 'Single sign-on' },
  component: SsoRoute,
})

function SsoRoute() {
  return <SsoPage edit={Route.useSearch().edit} />
}
