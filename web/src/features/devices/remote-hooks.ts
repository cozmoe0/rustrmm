import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { errorMessage, isApiError } from '@/lib/api/errors'
import { keys } from '@/lib/api/queries'
import { isDeviceGoneError } from '@/lib/remote'

/** Re-renders every `interval` ms while enabled; returns the current time. */
export function useNow(interval = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    const timer = window.setInterval(() => setNow(Date.now()), interval)
    return () => window.clearInterval(timer)
  }, [interval, enabled])
  return now
}

/**
 * Toasts a failed remote action. Agent refusals (`device_error`) carry the agent's own reason, which
 * is shown verbatim. A cancelled MFA prompt is not an error.
 */
export function toastRemoteError(error: unknown, title: string) {
  if (isApiError(error) && error.code === 'step_up_required') {
    toast.message('Action cancelled', { description: 'This action needs a recent MFA check.' })
    return
  }
  toast.error(title, { description: errorMessage(error) })
}

/** Refreshes the device when a remote call reports it went offline or inactive. */
export function useDeviceGoneHandler(deviceId: string) {
  const queryClient = useQueryClient()
  return (error: unknown) => {
    if (isDeviceGoneError(error)) void queryClient.invalidateQueries({ queryKey: keys.device(deviceId) })
  }
}
