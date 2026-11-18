import { createFileRoute, redirect } from '@tanstack/react-router'
import { SetupWizard } from '@/features/setup/setup-wizard'
import { setupStatusQuery } from '@/lib/api/queries'

export const Route = createFileRoute('/setup')({
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.fetchQuery(setupStatusQuery)
    if (!status.needs_setup) throw redirect({ to: '/login' })
  },
  component: SetupWizard,
})
