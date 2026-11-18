import type { Device, Me } from '@/lib/api/types'
import { OS_LABEL } from '@/lib/devices'
import { hasPermission } from '@/lib/permissions'
import { remoteAccess, type RemoteAccess } from '@/lib/remote'
import { REMOTE_TOOL, type RemoteTab } from './cockpit-tabs'

/** Whether the signed-in user can open a remote tool on this device right now. */
export function remoteToolAccess(device: Pick<Device, 'status' | 'online' | 'os_family'>, me: Pick<Me, 'permissions'> | undefined, tab: RemoteTab): RemoteAccess {
  const tool = REMOTE_TOOL[tab]
  if (tool.os && !tool.os.includes(device.os_family)) {
    return { ok: false, block: 'unsupported', reason: `${tab === 'registry' ? 'The registry' : 'This tool'} is only available on ${tool.os.map((os) => OS_LABEL[os]).join(', ')}.` }
  }
  const permitted = tool.permission ? hasPermission(me, tool.permission) : true
  return remoteAccess(device, permitted, { permissionLabel: tool.permissionLabel, requiresOnline: tool.live })
}

/** The tab "Remote" opens: the last tool used if still available, else the first usable one. */
export function defaultRemoteTab(
  device: Pick<Device, 'status' | 'online' | 'os_family'>,
  me: Pick<Me, 'permissions'> | undefined,
  tabs: RemoteTab[],
  last: RemoteTab | null,
): RemoteTab {
  if (last && tabs.includes(last) && remoteToolAccess(device, me, last).ok) return last
  return tabs.find((tab) => remoteToolAccess(device, me, tab).ok) ?? 'sessions'
}
