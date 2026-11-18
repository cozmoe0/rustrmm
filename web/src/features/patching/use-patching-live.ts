import { useEffect, useRef } from 'react'
import { useQueryClient, type QueryKey } from '@tanstack/react-query'
import { keys } from '@/lib/api/queries'
import { useStreamEvent } from '@/lib/api/stream'
import type { PatchesChangedEvent, PatchRunUpdatedEvent, SoftwareDeploymentUpdatedEvent } from '@/lib/api/types'

/**
 * Keeps patching and software data fresh from the live stream. Events are published per client, so a
 * burst (one run touching many clients) is coalesced into one refetch per query. Mounted in the app shell.
 */
export function usePatchingLive() {
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

  useStreamEvent<PatchesChangedEvent>('patches.changed', (event) => {
    if (event?.device_id) later(keys.devicePatches(event.device_id), 400)
    else later(['patches', 'device'], 800)
    later(['patches', 'list'], 1200)
    later(['patches', 'detail'], 1200)
    later(['patches', 'compliance'], 1500)
  })

  useStreamEvent<PatchRunUpdatedEvent>('patch_run.updated', (event) => {
    // Counts arrive per client, so the run itself is refetched rather than patched in place.
    later(keys.patchRun(event.run_id), 500)
    later(keys.patchRuns, 1000)
  })

  useStreamEvent<SoftwareDeploymentUpdatedEvent>('software_deployment.updated', (event) => {
    later(keys.deployment(event.deployment_id), 400)
    later(['deployments', 'list'], 900)
    later(['deployments', 'device'], 900)
    if (event.status !== 'running' && event.status !== 'scheduled') later(keys.packages, 1500)
  })
}
