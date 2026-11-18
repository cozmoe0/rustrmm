import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { SnmpDevicesPage } from '@/features/network/snmp-devices-page'

export const Route = createFileRoute('/_app/network/snmp/')({
  validateSearch: z.object({
    site_id: z.string().optional(),
    status: z.enum(['ok', 'alerting', 'unreachable', 'pending', 'paused']).optional(),
    q: z.string().optional(),
    edit: z.string().optional(),
  }),
  component: SnmpDevicesRoute,
})

function SnmpDevicesRoute() {
  return <SnmpDevicesPage search={Route.useSearch()} />
}
