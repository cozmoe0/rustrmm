import { useQuery } from '@tanstack/react-query'
import { meQuery } from './api/queries'
import type { Me } from './api/types'

/** Permission keys used for UI gating. The catalog endpoint is the source of truth; later phases add more. */
export const PERMISSIONS = {
  clientsView: 'clients.view',
  clientsManage: 'clients.manage',
  sitesManage: 'sites.manage',
  usersView: 'users.view',
  usersManage: 'users.manage',
  rolesManage: 'roles.manage',
  auditView: 'audit.view',
  auditExport: 'audit.export',
  backupsView: 'backups.view',
  backupsManage: 'backups.manage',
  settingsView: 'settings.view',
  settingsManage: 'settings.manage',
  devicesView: 'devices.view',
  devicesManage: 'devices.manage',
  devicesDelete: 'devices.delete',
  agentsDeploy: 'agents.deploy',
  agentsApprove: 'agents.approve',
  remoteSystem: 'remote.system',
  remoteFiles: 'remote.files',
  remotePower: 'remote.power',
  remoteShell: 'remote.shell',
  remoteRecordings: 'remote.recordings',
  remoteDesktop: 'remote.desktop',
  scriptsView: 'scripts.view',
  scriptsManage: 'scripts.manage',
  scriptsRun: 'scripts.run',
  scriptsApprove: 'scripts.approve',
  policiesManage: 'policies.manage',
  alertsView: 'alerts.view',
  alertsManage: 'alerts.manage',
  monitorsManage: 'monitors.manage',
  notificationsManage: 'notifications.manage',
  patchesView: 'patches.view',
  patchesApprove: 'patches.approve',
  softwareView: 'software.view',
  softwareLibrary: 'software.library',
  softwareDeploy: 'software.deploy',
  ticketsView: 'tickets.view',
  ticketsManage: 'tickets.manage',
  ticketsTime: 'tickets.time',
  ticketsSettings: 'tickets.settings',
  secretsReveal: 'secrets.reveal',
  secretsManage: 'secrets.manage',
  networkView: 'network.view',
  networkManage: 'network.manage',
  reportsView: 'reports.view',
  reportsManage: 'reports.manage',
  apiManage: 'api.manage',
} as const

export function hasPermission(me: Pick<Me, 'permissions'> | null | undefined, permission: string) {
  return Boolean(me?.permissions.includes(permission))
}

export function hasAnyPermission(
  me: Pick<Me, 'permissions'> | null | undefined,
  permissions: readonly string[],
) {
  return permissions.some((permission) => hasPermission(me, permission))
}

/**
 * Installation-wide settings (SNMP credentials, templates, trap rules, network settings) need the permission
 * held globally. The session only says whether the user has any global assignment, so this is an
 * approximation for UI gating; the server decides.
 */
export function hasGlobalPermission(me: Pick<Me, 'permissions' | 'scopes'> | null | undefined, permission: string) {
  return Boolean(me && me.scopes.global && hasPermission(me, permission))
}

/** Reads the cached session; UI gating only — the server enforces every permission. */
export function usePermission(permission: string): boolean {
  const { data } = useQuery(meQuery)
  return hasPermission(data, permission)
}

export function useMe(): Me | undefined {
  return useQuery(meQuery).data
}
