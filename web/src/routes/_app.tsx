import { Outlet, createFileRoute, redirect, retainSearchParams } from '@tanstack/react-router'
import { z } from 'zod'
import { AppShell } from '@/components/shell/app-shell'
import { isApiError } from '@/lib/api/errors'
import { meQuery, setupStatusQuery } from '@/lib/api/queries'
import { storedClientStore } from '@/lib/scope'

const scopeSearch = z.object({
  client: z.string().optional(),
  site: z.string().optional(),
})

export const Route = createFileRoute('/_app')({
  validateSearch: scopeSearch,
  search: { middlewares: [retainSearchParams(['client', 'site'])] },
  beforeLoad: async ({ context, location, search }) => {
    const status = await context.queryClient.ensureQueryData(setupStatusQuery)
    if (status.needs_setup) throw redirect({ to: '/setup' })

    try {
      await context.queryClient.ensureQueryData(meQuery)
    } catch (error) {
      if (isApiError(error) && error.status === 401) {
        throw redirect({ to: '/login', search: { redirect: location.href } })
      }
      throw error
    }

    // Restore the last client scope when the URL doesn't carry one.
    const stored = storedClientStore.get()
    if (search.client === undefined && stored !== 'all') {
      const params = new URLSearchParams(location.searchStr)
      params.set('client', stored)
      throw redirect({ href: `${location.pathname}?${params.toString()}`, replace: true })
    }
  },
  component: AppLayout,
})

function AppLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  )
}
