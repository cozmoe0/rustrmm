import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { remoteApi } from '@/lib/api/endpoints'
import type { DeviceDetail, PowerAction } from '@/lib/api/types'
import { deviceName } from '@/lib/devices'
import { toastRemoteError, useDeviceGoneHandler } from './remote-hooks'

const VERB: Record<PowerAction, string> = { reboot: 'restart', shutdown: 'shut down', logoff: 'sign out', lock: 'lock', cancel: 'cancel' }

export function delayLabel(seconds: number) {
  if (seconds === 0) return 'now'
  if (seconds < 3600) return `in ${Math.round(seconds / 60)} minute${seconds === 60 ? '' : 's'}`
  return 'in 1 hour'
}

/** Sends a power action and reports the result; `cancel` aborts a pending restart or shutdown. */
export function usePowerAction(device: DeviceDetail, onDone?: () => void) {
  const onDeviceGone = useDeviceGoneHandler(device.id)
  return useMutation({
    mutationFn: (body: { action: PowerAction; delay_secs?: number; message?: string }) =>
      remoteApi.power(device.id, { action: body.action, delay_secs: body.delay_secs ?? 0, message: body.message ?? '' }),
    meta: { silent: true },
    onSuccess: (_result, body) => {
      const name = deviceName(device)
      const delay = body.delay_secs ?? 0
      if (body.action === 'cancel') toast.success(`Cancelled the pending restart or shutdown on ${name}`)
      else if (body.action === 'lock') toast.success(`Locked ${name}`)
      else if (body.action === 'logoff') toast.success(`Signing out the user on ${name}`)
      else {
        const verb = body.action === 'reboot' ? 'Restart' : 'Shutdown'
        toast.success(delay > 0 ? `${verb} of ${name} scheduled ${delayLabel(delay)}` : `${verb} sent to ${name}`, {
          description: delay > 0 ? 'Signed-in users are warned. You can cancel it from the actions menu.' : 'The device will go offline shortly.',
        })
      }
      onDone?.()
    },
    onError: (error, body) => {
      onDeviceGone(error)
      toastRemoteError(error, `Couldn’t ${VERB[body.action]} ${deviceName(device)}`)
    },
  })
}

