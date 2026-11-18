import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import 'sonner/dist/styles.css'
import './index.css'
import './lib/theme'
import { TooltipProvider } from '@/components/ui/tooltip'
import { setUnauthorizedHandler } from '@/lib/api/client'
import { keys } from '@/lib/api/queries'
import { createQueryClient } from '@/lib/query-client'
import { routeTree } from './routeTree.gen'
import { PagePending } from './components/common/page-pending'

const queryClient = createQueryClient()

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
  defaultPendingComponent: PagePending,
  defaultPendingMs: 250,
  scrollRestoration: true,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

// A 401 on an authenticated request means the session ended: return to sign-in.
setUnauthorizedHandler(() => {
  queryClient.removeQueries({ queryKey: keys.me })
  if (router.state.location.pathname !== '/login') {
    void router.navigate({ to: '/login', search: { redirect: router.state.location.href } })
  }
})

async function enableMocking() {
  if (import.meta.env.VITE_MOCK !== '1') return
  const { startMocking } = await import('./mocks/browser')
  await startMocking()
}

void enableMocking().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delay={250}>
          <RouterProvider router={router} />
        </TooltipProvider>
      </QueryClientProvider>
    </StrictMode>,
  )
})
