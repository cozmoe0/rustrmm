import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { DeviceCockpit } from '@/features/devices/device-cockpit'
import { COCKPIT_TABS } from '@/features/devices/cockpit-tabs'
import { deviceQuery } from '@/lib/api/queries'

export const Route = createFileRoute('/_app/devices/$deviceId')({
  validateSearch: z.object({
    tab: z.enum(COCKPIT_TABS).optional(),
  }),
  staticData: { title: 'Device', dynamicTitle: 'device' },
  loader: ({ context, params }) => {
    // Warm the cache; the page handles loading and 404 states itself.
    void context.queryClient.prefetchQuery(deviceQuery(params.deviceId))
  },
  component: DeviceRoute,
})

function DeviceRoute() {
  const { deviceId } = Route.useParams()
  const { tab } = Route.useSearch()
  return <DeviceCockpit deviceId={deviceId} tab={tab ?? 'overview'} />
}
