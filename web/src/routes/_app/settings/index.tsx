import { createFileRoute, redirect } from '@tanstack/react-router'
import { meQuery } from '@/lib/api/queries'

export const Route = createFileRoute('/_app/settings/')({
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.ensureQueryData(meQuery)
    throw redirect({ to: me.permissions.includes('users.view') ? '/settings/users' : '/settings/security', replace: true })
  },
})
