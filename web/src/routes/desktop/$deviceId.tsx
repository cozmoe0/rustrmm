/* Pop-out remote desktop window: the viewer filling the whole browser window, without the app shell. */
import { lazy, Suspense } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute, redirect } from '@tanstack/react-router'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { ErrorState } from '@/components/common/misc'
import { isApiError } from '@/lib/api/errors'
import { deviceQuery, meQuery, setupStatusQuery } from '@/lib/api/queries'
import { deviceName } from '@/lib/devices'
import { useMe } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { remoteToolAccess } from '@/features/devices/remote-access'
import { ToolUnavailable } from '@/features/devices/remote-ui'

const DesktopViewer = lazy(() => import('@/features/devices/desktop/desktop-viewer'))

export const Route = createFileRoute('/desktop/$deviceId')({
  validateSearch: z.object({
    session: z.number().int().optional().catch(undefined),
    quality: z.enum(['auto', 'low', 'medium', 'high']).optional().catch(undefined),
    view_only: z.boolean().optional().catch(undefined),
    connect: z.boolean().optional().catch(undefined),
  }),
  beforeLoad: async ({ context, location }) => {
    const status = await context.queryClient.ensureQueryData(setupStatusQuery)
    if (status.needs_setup) throw redirect({ to: '/setup' })
    try {
      await context.queryClient.ensureQueryData(meQuery)
    } catch (error) {
      if (isApiError(error) && error.status === 401) throw redirect({ to: '/login', search: { redirect: location.href } })
      throw error
    }
  },
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(deviceQuery(params.deviceId))
  },
  component: DesktopWindow,
})

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-dvh items-center justify-center bg-background p-4">{children}</div>
}

function DesktopWindow() {
  const { deviceId } = Route.useParams()
  const search = Route.useSearch()
  const me = useMe()
  const { data: device, error, isLoading, refetch } = useQuery(deviceQuery(deviceId))
  useTitle(device ? `${deviceName(device)} · Remote desktop` : 'Remote desktop')

  if (error) {
    return (
      <Centered>
        <div className="w-full max-w-md">
          <ErrorState error={error} title={isApiError(error) && error.status === 404 ? 'Device not found' : 'Could not load this device'} onRetry={() => void refetch()} />
        </div>
      </Centered>
    )
  }
  if (isLoading || !device) {
    return (
      <Centered>
        <Spinner className="size-5 text-muted-foreground" />
      </Centered>
    )
  }
  const access = remoteToolAccess(device, me, 'desktop')
  if (!access.ok) {
    return (
      <Centered>
        <div className="grid w-full max-w-lg gap-3">
          <ToolUnavailable access={access} tool="Remote desktop" lastSeen={device.last_seen_at} />
          <Button variant="ghost" size="sm" className="justify-self-center" render={<Link to="/devices/$deviceId" params={{ deviceId }} />} nativeButton={false}>
            Open the device
          </Button>
        </div>
      </Centered>
    )
  }
  return (
    <div className="h-dvh bg-background">
      <Suspense
        fallback={
          <Centered>
            <Spinner className="size-5 text-muted-foreground" />
          </Centered>
        }
      >
        <DesktopViewer
          device={device}
          active
          variant="window"
          initial={{ sessionId: search.session ?? null, quality: search.quality, viewOnly: search.view_only, connect: search.connect }}
        />
      </Suspense>
    </div>
  )
}
