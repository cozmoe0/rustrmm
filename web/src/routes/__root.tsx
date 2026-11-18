import type { QueryClient } from '@tanstack/react-query'
import { Link, Outlet, createRootRouteWithContext, type ErrorComponentProps } from '@tanstack/react-router'
import { Toaster } from '@/components/ui/sonner'
import { Button } from '@/components/ui/button'
import { StepUpProvider } from '@/components/auth/step-up'
import { BrandingEffect } from '@/components/brand/branding'
import { Illustration } from '@/components/common/illustrations'
import { errorMessage } from '@/lib/api/errors'

export interface RouterContext {
  queryClient: QueryClient
}

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    /** Breadcrumb label. */
    title?: string
    /** Resolve the breadcrumb label from cached data instead (e.g. the client's name). */
    dynamicTitle?: 'client' | 'device' | 'script' | 'job' | 'group' | 'policy'
  }
}

function RootComponent() {
  return (
    <>
      <BrandingEffect />
      <Outlet />
      <StepUpProvider />
      <Toaster />
    </>
  )
}

function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <Illustration name="search" />
      <div>
        <h1 className="font-display text-xl font-semibold">This page doesn&apos;t exist</h1>
        <p className="mt-1 text-sm text-muted-foreground">The link may be outdated, or the item was removed.</p>
      </div>
      <Button render={<Link to="/" />} nativeButton={false} variant="outline">
        Back to home
      </Button>
    </div>
  )
}

function RootError({ error, reset }: ErrorComponentProps) {
  return (
    <div role="alert" className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <Illustration name="alerts" />
      <div>
        <h1 className="font-display text-xl font-semibold">Something went wrong</h1>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">{errorMessage(error)}</p>
      </div>
      <Button variant="outline" onClick={reset}>
        Try again
      </Button>
    </div>
  )
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
  notFoundComponent: NotFound,
  errorComponent: RootError,
})
