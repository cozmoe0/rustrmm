import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { devicesApi } from '@/lib/api/endpoints'
import { keys } from '@/lib/api/queries'
import { useStreamEvent } from '@/lib/api/stream'
import type { Device, DeviceMetricsEvent, LiveSample } from '@/lib/api/types'

const KEEPALIVE_MS = 60_000
const MAX_SAMPLES = 120
const STALE_AFTER_S = 12

/**
 * Live mode for an open cockpit: asks the server to stream ~2s samples for this device
 * (`POST /devices/:id/live`, renewed every minute) and keeps a rolling buffer of
 * `device.metrics` events. Inventory refresh events invalidate the cached inventory.
 */
export function useDeviceLive(device: Pick<Device, 'id' | 'online' | 'status'> | undefined) {
  const queryClient = useQueryClient()
  const id = device?.id
  const enabled = Boolean(device && device.online && device.status === 'active')
  const [state, setState] = useState<{ id: string | undefined; samples: LiveSample[] }>({ id, samples: [] })
  const [now, setNow] = useState(() => Date.now())

  // Reset the buffer when navigating to another device.
  const samples = state.id === id ? state.samples : []

  useEffect(() => {
    if (!id || !enabled) return
    let cancelled = false
    const ping = () => {
      devicesApi.live(id).catch(() => {
        // Live mode is best effort; the cockpit falls back to periodic refetches.
      })
    }
    ping()
    const timer = window.setInterval(() => !cancelled && ping(), KEEPALIVE_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [id, enabled])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 4000)
    return () => window.clearInterval(timer)
  }, [])

  useStreamEvent<DeviceMetricsEvent>('device.metrics', (event) => {
    if (!event || event.device_id !== id) return
    setState((prev) => {
      const base = prev.id === id ? prev.samples : []
      const next = [...base, event.sample]
      return { id, samples: next.length > MAX_SAMPLES ? next.slice(next.length - MAX_SAMPLES) : next }
    })
  })

  useStreamEvent<{ device_id: string; section: string }>('device.inventory', (event) => {
    if (event?.device_id === id && id) void queryClient.invalidateQueries({ queryKey: keys.inventory(id) })
  })

  const latest = samples.at(-1) ?? null
  const live = Boolean(latest && now / 1000 - latest.ts < STALE_AFTER_S)
  return { samples, latest, live }
}
