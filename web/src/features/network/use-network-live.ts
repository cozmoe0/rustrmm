import { useQueryClient } from '@tanstack/react-query'
import { networkKeys } from '@/lib/api/queries'
import { useStreamEvent } from '@/lib/api/stream'
import type { NetworkAssetsEvent, NetworkScan, NetworkScanEvent, SnmpDeviceEvent, SnmpTrapEvent } from '@/lib/api/types'

/**
 * Live network updates (mounted once by the shell): `network.scan` patches the scan's last run in place,
 * `network.assets`, `snmp.device` and `snmp.trap` refresh the affected lists.
 */
export function useNetworkLive(enabled: boolean) {
  const queryClient = useQueryClient()

  useStreamEvent<NetworkScanEvent>('network.scan', (event) => {
    if (!enabled || !event) return
    queryClient.setQueryData<NetworkScan[]>(networkKeys.scans, (scans) =>
      scans?.map((scan) =>
        scan.id === event.scan_id
          ? {
              ...scan,
              last_run: {
                at: event.status === 'running' || !scan.last_run ? new Date().toISOString() : scan.last_run.at,
                hosts_found: event.hosts_found,
                duration_ms: event.status === 'running' ? null : (scan.last_run?.duration_ms ?? null),
                status: event.status,
                error: null,
              },
            }
          : scan,
      ),
    )
    if (event.status !== 'running') void queryClient.invalidateQueries({ queryKey: networkKeys.scans })
  })

  useStreamEvent<NetworkAssetsEvent>('network.assets', (event) => {
    if (!enabled || !event) return
    void queryClient.invalidateQueries({ queryKey: networkKeys.assets })
    void queryClient.invalidateQueries({ queryKey: networkKeys.topology(event.site_id) })
  })

  useStreamEvent<SnmpDeviceEvent>('snmp.device', (event) => {
    if (!enabled || !event) return
    void queryClient.invalidateQueries({ queryKey: networkKeys.devices })
  })

  useStreamEvent<SnmpTrapEvent>('snmp.trap', () => {
    if (!enabled) return
    void queryClient.invalidateQueries({ queryKey: networkKeys.traps })
  })
}
