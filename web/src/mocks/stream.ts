import type { StreamSocket } from '@/lib/api/stream'
import { db, persist, rescoreDevice } from './db'
import { liveSample, liveUntil } from './devices'

type Emit = (topic: string, data: unknown) => void

/** Sockets currently open, so handlers can push events (inventory refreshed, device approved…). */
const emitters = new Set<Emit>()

export function emitMockEvent(topic: string, data: unknown) {
  emitters.forEach((emit) => emit(topic, data))
}

/** Devices that drift on- and offline to make the console feel alive. */
const FLAPPY = ['NWD-OP2', 'CRV-MOBILE-LT', 'ATLAS-RMT-LT04']

/**
 * A fake `/api/v1/stream` socket. Like the real server it pushes `fleet.summary` with `null` data
 * (meaning "refetch"), `devices.changed` when a device connects or disconnects, and live
 * `device.metrics` samples for devices a cockpit asked to watch via `POST /devices/:id/live`.
 */
export function createMockStreamSocket(): StreamSocket {
  const timers: number[] = []
  const emit: Emit = (topic, data) => {
    if (socket.readyState !== 1) return
    socket.onmessage?.({ data: JSON.stringify({ type: 'event', topic, data }) })
  }
  const socket: StreamSocket & { readyState: number } = {
    readyState: 0,
    onopen: null,
    onmessage: null,
    onclose: null,
    send() {
      // Subscriptions are accepted silently; the mock pushes the same topics regardless.
    },
    close() {
      timers.forEach((timer) => window.clearInterval(timer))
      emitters.delete(emit)
      socket.readyState = 3
      socket.onclose?.()
    },
  }

  window.setTimeout(() => {
    if (!db.session) {
      socket.close()
      return
    }
    socket.readyState = 1
    socket.onopen?.()
    emitters.add(emit)

    // Live metrics for watched devices.
    timers.push(
      window.setInterval(() => {
        const now = Date.now()
        for (const [id, until] of liveUntil) {
          if (until < now) {
            liveUntil.delete(id)
            continue
          }
          const device = db.devices.find((item) => item.id === id)
          if (!device || !device.online) continue
          const sample = liveSample(device)
          device.cpu_pct = sample.cpu
          device.mem_pct = sample.mem
          device.last_seen_at = new Date(now).toISOString()
          emit('device.metrics', { device_id: id, live: true, sample })
        }
      }, 2000),
    )

    // Occasional connect / disconnect.
    timers.push(
      window.setInterval(() => {
        const candidates = db.devices.filter((device) => device.status === 'active' && FLAPPY.includes(device.hostname))
        if (candidates.length === 0) return
        const device = candidates[Math.floor(Math.random() * candidates.length)]
        device.online = !device.online
        device.last_seen_at = new Date().toISOString()
        device.uptime_s = device.online ? 60 : null
        rescoreDevice(device)
        persist()
        emit('devices.changed', { id: device.id, online: device.online })
        emit('fleet.summary', null)
      }, 45_000),
    )

    // Periodic summary nudge (patch compliance drifts a little).
    timers.push(window.setInterval(() => emit('fleet.summary', null), 20_000))
  }, 400)

  return socket
}
