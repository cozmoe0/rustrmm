import { useEffect, useRef } from 'react'
import { useQueryClient, type InfiniteData, type QueryKey } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { keys } from '@/lib/api/queries'
import { useStreamEvent } from '@/lib/api/stream'
import type { Alert, AlertDetail, AlertListResponse, AlertStreamEvent, AlertsSummaryEvent, DeviceChecksEvent } from '@/lib/api/types'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { markFresh } from './alert-stores'

/** Replaces an alert wherever it appears in cached inbox pages and device alert lists. */
function patchLists(queryClient: ReturnType<typeof useQueryClient>, alert: Alert) {
  queryClient.setQueriesData<InfiniteData<AlertListResponse>>({ queryKey: [...keys.alerts, 'list'] }, (data) =>
    data?.pages
      ? {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.map((item) => (item.id === alert.id ? alert : item)),
          })),
        }
      : data,
  )
  queryClient.setQueriesData<AlertListResponse>({ queryKey: [...keys.alerts, 'device'] }, (data) =>
    data ? { ...data, items: data.items.map((item) => (item.id === alert.id ? alert : item)) } : data,
  )
  queryClient.setQueryData<AlertDetail>(keys.alert(alert.id), (detail) => (detail ? { ...detail, alert } : detail))
}

/**
 * Keeps alert data fresh from the live stream (mounted once in the app shell): patches cached alerts
 * at once, then coalesces refetches so a burst of events costs one request per list. `alerts.summary`
 * is per client, so it only signals a refetch of the totals.
 */
export function useMonitoringLive() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const me = useMe()
  const enabled = hasPermission(me, PERMISSIONS.alertsView)
  const timers = useRef(new Map<string, number>())
  const lastToast = useRef(0)

  useEffect(() => {
    const pending = timers.current
    return () => {
      pending.forEach((timer) => window.clearTimeout(timer))
      pending.clear()
    }
  }, [])

  const later = (queryKey: QueryKey, delay = 400) => {
    const id = JSON.stringify(queryKey)
    if (timers.current.has(id)) return
    timers.current.set(
      id,
      window.setTimeout(() => {
        timers.current.delete(id)
        void queryClient.invalidateQueries({ queryKey })
      }, delay),
    )
  }

  useStreamEvent<AlertStreamEvent>('alert.opened', (event) => {
    if (!enabled || !event?.alert) return
    markFresh(event.alert.id)
    later([...keys.alerts, 'list'])
    if (event.alert.device_id) later([...keys.alerts, 'device', event.alert.device_id])
    later(keys.alertsSummary, 800)
    later([...keys.alerts, 'counts'], 900)
    const alert = event.alert
    const now = Date.now()
    if (alert.severity === 'critical' && !alert.in_maintenance && now - lastToast.current > 10_000) {
      lastToast.current = now
      toast.error(alert.title, {
        description: `${alert.hostname ?? alert.client_name} · ${alert.client_name}`,
        action: {
          label: 'View',
          onClick: () => void navigate({ to: '/alerts', search: { alert: alert.id, status: 'all' } }),
        },
      })
    }
  })

  useStreamEvent<AlertStreamEvent>('alert.updated', (event) => {
    if (!enabled || !event?.alert) return
    patchLists(queryClient, event.alert)
    later([...keys.alerts, 'list'], 700)
    later(keys.alert(event.alert.id), 500)
    if (event.alert.device_id) later([...keys.alerts, 'device', event.alert.device_id], 700)
    later(keys.alertsSummary, 800)
    later([...keys.alerts, 'counts'], 900)
  })

  useStreamEvent<AlertsSummaryEvent>('alerts.summary', () => {
    if (enabled) later(keys.alertsSummary, 600)
  })

  useStreamEvent<DeviceChecksEvent>('device.checks', (event) => {
    if (enabled && event?.device_id) later(keys.deviceChecks(event.device_id), 300)
  })
}
