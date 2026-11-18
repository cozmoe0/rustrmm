/* In-memory UI state shared between the inbox, the live stream hook and the command palette. */
import type { Alert } from '@/lib/api/types'
import { createStore, useStore } from '@/lib/store'

/** The alert open in the inbox's detail pane, for palette actions such as "Acknowledge alert". */
export const selectedAlertStore = createStore<Alert | null>(null)

/** Alerts that arrived over the stream recently (id → arrival time), so rows can flash once. */
export const freshAlertsStore = createStore<Record<string, number>>({})

export const FRESH_MS = 6_000

export function markFresh(id: string) {
  const now = Date.now()
  freshAlertsStore.set((prev) => {
    const next: Record<string, number> = {}
    for (const [key, at] of Object.entries(prev)) if (now - at < FRESH_MS) next[key] = at
    next[id] = now
    return next
  })
}

export function useFreshAlerts() {
  return useStore(freshAlertsStore)
}

/**
 * Values seen for numeric checks during this session (device:check → recent values), used to draw
 * sparklines for check types that have no metric history on the server.
 */
const history = new Map<string, { at: number; value: number }[]>()
const HISTORY_POINTS = 40

export function recordCheckValue(deviceId: string, checkId: string, value: number | null, at: string | null) {
  if (value === null || !Number.isFinite(value)) return
  const key = `${deviceId}:${checkId}`
  const series = history.get(key) ?? []
  const time = at ? new Date(at).getTime() : Date.now()
  const last = series.at(-1)
  if (last && (last.at === time || (last.value === value && time - last.at < 30_000))) return
  series.push({ at: time, value })
  if (series.length > HISTORY_POINTS) series.splice(0, series.length - HISTORY_POINTS)
  history.set(key, series)
}

export function checkHistory(deviceId: string, checkId: string): number[] {
  return (history.get(`${deviceId}:${checkId}`) ?? []).map((point) => point.value)
}
