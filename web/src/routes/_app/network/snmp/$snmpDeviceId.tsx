import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { SnmpDevicePage } from '@/features/network/snmp-device-page'

export const Route = createFileRoute('/_app/network/snmp/$snmpDeviceId')({
  validateSearch: z.object({ range: z.enum(['1h', '24h', '7d', '30d']).optional() }),
  staticData: { title: 'SNMP device' },
  component: SnmpDeviceRoute,
})

function SnmpDeviceRoute() {
  const { snmpDeviceId } = Route.useParams()
  return <SnmpDevicePage deviceId={snmpDeviceId} range={Route.useSearch().range ?? '24h'} />
}
