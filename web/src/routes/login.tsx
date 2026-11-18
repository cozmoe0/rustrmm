import { createFileRoute, redirect } from '@tanstack/react-router'
import { z } from 'zod'
import { LoginPage } from '@/features/auth/login-page'
import { meQuery, setupStatusQuery } from '@/lib/api/queries'

export const Route = createFileRoute('/login')({
  validateSearch: z.object({ redirect: z.string().optional() }),
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.fetchQuery(setupStatusQuery)
    if (status.needs_setup) throw redirect({ to: '/setup' })
    const me = await context.queryClient.fetchQuery(meQuery).catch(() => null)
    if (me) throw redirect({ to: '/' })
  },
  component: LoginRoute,
})

function LoginRoute() {
  const { redirect: redirectTo } = Route.useSearch()
  return <LoginPage redirectTo={redirectTo} />
}
