import { useQueries, useQuery } from '@tanstack/react-query'
import { devicesQuery, groupMembersQuery } from '@/lib/api/queries'
import type { Device, JobTargetInput } from '@/lib/api/types'

/** Devices a target resolves to right now (the server resolves again when the job runs). */
export function useResolvedTarget(target: JobTargetInput | null): { devices: Device[]; loading: boolean } {
  const { data: all = [], isLoading } = useQuery({ ...devicesQuery(), enabled: Boolean(target) })
  const groupIds = target?.type === 'group' ? target.ids : []
  const members = useQueries({ queries: groupIds.map((id) => groupMembersQuery(id)) })
  const membersLoading = members.some((query) => query.isLoading)
  return {
    devices: resolveDevices(
      target,
      all,
      members.map((query) => query.data),
    ),
    loading: isLoading || membersLoading,
  }
}

function resolveDevices(
  target: JobTargetInput | null,
  all: Device[],
  groupMembers: (Device[] | undefined)[],
): Device[] {
  if (!target) return []
  const managed = all.filter((device) => device.status === 'active' || device.status === 'quarantined')
  if (target.type === 'devices') return managed.filter((device) => target.ids.includes(device.id))
  if (target.type === 'client') return managed.filter((device) => target.ids.includes(device.client_id))
  if (target.type === 'site') return managed.filter((device) => target.ids.includes(device.site_id))
  const seen = new Map<string, Device>()
  for (const list of groupMembers) for (const device of list ?? []) seen.set(device.id, device)
  return [...seen.values()]
}
