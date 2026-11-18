import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { devicesApi } from '@/lib/api/endpoints'
import { keys } from '@/lib/api/queries'
import type { Device } from '@/lib/api/types'

/** Asks online agents to resend their full inventory; offline devices are skipped. */
export function useRefreshInventory() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (devices: Device[]) => {
      const online = devices.filter((device) => device.online && device.status === 'active')
      const results = await Promise.allSettled(online.map((device) => devicesApi.refreshInventory(device.id)))
      const accepted = results.filter((result) => result.status === 'fulfilled' && result.value.ok).length
      return { accepted, skipped: devices.length - accepted }
    },
    meta: { silent: true },
    onSuccess: ({ accepted, skipped }, devices) => {
      if (accepted === 0) {
        toast.error(devices.length === 1 ? 'The device is offline. Inventory refreshes when it reconnects.' : 'None of the selected devices are online.')
        return
      }
      toast.success(
        `Inventory requested from ${accepted} ${accepted === 1 ? 'device' : 'devices'}${skipped ? ` · ${skipped} offline skipped` : ''}`,
      )
      window.setTimeout(() => {
        for (const device of devices) void queryClient.invalidateQueries({ queryKey: keys.inventory(device.id) })
      }, 3000)
    },
    onError: () => toast.error('Could not request an inventory refresh.'),
  })
}
