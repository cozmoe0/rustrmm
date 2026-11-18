import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query'
import { approvalsQuery, keys } from '@/lib/api/queries'
import { useStreamEvent } from '@/lib/api/stream'
import type { JobResultEvent, JobRunDetail, JobUpdatedEvent } from '@/lib/api/types'
import { RESULT_STATUS } from '@/lib/automation/labels'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'

/**
 * Keeps automation data fresh from the live stream: patches the open run immediately on
 * `job.result` / `job.updated`, then coalesces refetches so a burst of results costs one request.
 * Mounted once in the app shell.
 */
export function useAutomationLive() {
  const queryClient = useQueryClient()
  const timers = useRef(new Map<string, number>())

  useEffect(() => {
    const pending = timers.current
    return () => {
      pending.forEach((timer) => window.clearTimeout(timer))
      pending.clear()
    }
  }, [])

  const later = (queryKey: QueryKey, delay: number) => {
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

  useStreamEvent<JobUpdatedEvent>('job.updated', (event) => {
    queryClient.setQueryData<JobRunDetail>(keys.jobRun(event.run_id), (detail) =>
      detail ? { ...detail, run: { ...detail.run, ...event.counts, status: event.status } } : detail,
    )
    later(keys.jobRun(event.run_id), 900)
    later(keys.jobs, 1500)
    if (event.status !== 'running') {
      later(keys.scripts, 2000)
      later(['devices', 'script-runs'], 1200)
    }
  })

  useStreamEvent<JobResultEvent>('job.result', (event) => {
    queryClient.setQueryData<JobRunDetail>(keys.jobRun(event.run_id), (detail) =>
      detail
        ? {
            ...detail,
            results: detail.results.map((result) =>
              result.device_id === event.device_id ? { ...result, status: event.status } : result,
            ),
          }
        : detail,
    )
    later(keys.jobRun(event.run_id), 900)
    if (RESULT_STATUS[event.status].done) {
      later(keys.deviceScriptRuns(event.device_id), 1200)
      later(keys.customFieldValues('device', event.device_id), 1500)
    }
  })

  useStreamEvent<null>('approvals.changed', () => {
    void queryClient.invalidateQueries({ queryKey: keys.approvals })
    later(keys.jobs, 600)
  })
}

/** Pending approvals for the shell badge; only fetched for people who can approve. */
export function usePendingApprovals() {
  const me = useMe()
  const enabled = hasPermission(me, PERMISSIONS.scriptsApprove)
  const query = useQuery({ ...approvalsQuery('pending'), enabled, meta: { silent: true } })
  const myName = me?.user.name
  const items = enabled ? (query.data ?? []) : []
  return { items, count: items.filter((item) => item.requested_by_name !== myName).length, enabled }
}
