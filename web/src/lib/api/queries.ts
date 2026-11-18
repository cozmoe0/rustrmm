import { queryOptions } from '@tanstack/react-query'
import { setCsrfToken } from './client'
import {
  alertsApi,
  maintenanceApi,
  monitoringApi,
  notificationsApi,
  type NotificationLogFilters,
  approvalsApi,
  authApi,
  automationSettingsApi,
  backupsApi,
  clientsApi,
  customFieldsApi,
  devicesApi,
  enrollmentApi,
  groupsApi,
  jobsApi,
  meApi,
  policiesApi,
  rolesApi,
  scriptsApi,
  setupApi,
  sitesApi,
  systemApi,
  usersApi,
  variablesApi,
  patchesApi,
  softwareApi,
  alertTicketRulesApi,
  cannedResponsesApi,
  contactsApi,
  slaPoliciesApi,
  ticketEmailApi,
  ticketQueuesApi,
  ticketsApi,
  timeEntriesApi,
  assetsApi,
  escrowApi,
  probesApi,
  scansApi,
  snmpApi,
  topologyApi,
  networkSettingsApi,
  apiTokensApi,
  brandingApi,
  dashboardsApi,
  reportsApi,
  signingApi,
  ssoApi,
  webhooksApi,
} from './endpoints'
import type {
  AlertFilters,
  ApprovalStatus,
  AuditFilters,
  CustomFieldScope,
  DeviceListFilters,
  EventLogQuery,
  JobFilters,
  MetricsRange,
  VariableScope,
  ComplianceGroupBy,
  Patch,
  PatchFilters,
  SoftwareFilters,
  SoftwareProductSummary,
  TicketFilters,
  TimeEntryFilters,
  AssetFilters,
  EscrowFilters,
  WidgetConfig,
  WidgetName,
} from './types'

export const keys = {
  setupStatus: ['setup-status'] as const,
  me: ['me'] as const,
  sessions: ['me', 'sessions'] as const,
  passkeys: ['me', 'passkeys'] as const,
  clients: ['clients'] as const,
  clientList: (search?: string) => ['clients', 'list', search ?? ''] as const,
  client: (id: string) => ['clients', 'detail', id] as const,
  sites: (clientId?: string) => ['sites', clientId ?? 'all'] as const,
  users: ['users'] as const,
  roles: ['roles'] as const,
  permissions: ['permissions'] as const,
  audit: (filters: AuditFilters) => ['audit', filters] as const,
  backups: ['backups'] as const,
  backupSettings: ['backups', 'settings'] as const,
  health: ['system', 'health'] as const,
  fleet: (clientId?: string, siteId?: string) => ['fleet', clientId ?? 'all', siteId ?? 'all'] as const,
  devices: ['devices'] as const,
  deviceList: (filters: DeviceListFilters) => ['devices', 'list', filters] as const,
  device: (id: string) => ['devices', 'detail', id] as const,
  inventory: (id: string) => ['devices', 'inventory', id] as const,
  metrics: (id: string, range: MetricsRange) => ['devices', 'metrics', id, range] as const,
  timeline: (id: string) => ['devices', 'timeline', id] as const,
  enrollment: ['enrollment'] as const,
  enrollmentList: (filters: { site_id?: string; client_id?: string }) => ['enrollment', 'list', filters] as const,
  remote: (id: string) => ['remote', id] as const,
  processes: (id: string) => ['remote', id, 'processes'] as const,
  remoteServices: (id: string) => ['remote', id, 'services'] as const,
  eventLogs: (id: string, query: EventLogQuery) => ['remote', id, 'event-logs', query] as const,
  registry: (id: string, path: string) => ['remote', id, 'registry', path] as const,
  files: (id: string, path: string) => ['remote', id, 'files', path] as const,
  remoteSessions: (deviceId?: string) => ['remote-sessions', deviceId ?? 'all'] as const,
  desktopSessions: (deviceId: string) => ['desktop', 'sessions', deviceId] as const,
  desktopScreenshot: (deviceId: string) => ['desktop', 'screenshot', deviceId] as const,
  recording: (sessionId: string) => ['remote-sessions', 'recording', sessionId] as const,
  // Automation (Phase 5)
  scripts: ['scripts'] as const,
  scriptList: (includeArchived: boolean) => ['scripts', 'list', includeArchived] as const,
  script: (id: string) => ['scripts', 'detail', id] as const,
  scriptVersion: (id: string, version: number) => ['scripts', 'version', id, version] as const,
  scriptCategories: ['scripts', 'categories'] as const,
  variables: ['variables'] as const,
  variableList: (scope?: VariableScope, scopeId?: string) => ['variables', scope ?? 'all', scopeId ?? 'all'] as const,
  jobs: ['jobs'] as const,
  jobList: (filters: JobFilters) => ['jobs', 'list', filters] as const,
  job: (id: string) => ['jobs', 'detail', id] as const,
  jobRun: (runId: string) => ['job-runs', runId] as const,
  jobResult: (runId: string, deviceId: string) => ['job-runs', runId, 'result', deviceId] as const,
  deviceScriptRuns: (deviceId: string) => ['devices', 'script-runs', deviceId] as const,
  approvals: ['approvals'] as const,
  approvalList: (status?: ApprovalStatus) => ['approvals', status ?? 'all'] as const,
  automationSettings: ['settings', 'automation'] as const,
  customFields: ['custom-fields'] as const,
  customFieldList: (scope?: CustomFieldScope) => ['custom-fields', 'list', scope ?? 'all'] as const,
  customFieldValues: (scope: CustomFieldScope, id: string) => ['custom-fields', 'values', scope, id] as const,
  groups: ['groups'] as const,
  groupList: (clientId?: string) => ['groups', 'list', clientId ?? 'all'] as const,
  groupMembers: (id: string) => ['groups', 'members', id] as const,
  deviceGroups: (deviceId: string) => ['groups', 'device', deviceId] as const,
  policies: ['policies'] as const,
  policy: (id: string) => ['policies', 'detail', id] as const,
  effectivePolicy: (deviceId: string) => ['policies', 'effective', deviceId] as const,
  // Monitoring (Phase 6)
  alerts: ['alerts'] as const,
  alertList: (filters: AlertFilters) => ['alerts', 'list', filters] as const,
  alertsSummary: ['alerts', 'summary'] as const,
  alert: (id: string) => ['alerts', 'detail', id] as const,
  deviceAlerts: (deviceId: string, status?: string) => ['alerts', 'device', deviceId, status ?? 'all'] as const,
  checkTypes: ['monitoring', 'check-types'] as const,
  deviceChecks: (deviceId: string) => ['monitoring', 'checks', deviceId] as const,
  maintenance: ['maintenance'] as const,
  maintenanceList: ['maintenance', 'list'] as const,
  deviceMaintenance: (deviceId: string) => ['maintenance', 'device', deviceId] as const,
  monitoringSettings: ['settings', 'monitoring'] as const,
  notifications: ['notifications'] as const,
  notificationChannels: ['notifications', 'channels'] as const,
  notificationRules: ['notifications', 'rules'] as const,
  notificationLog: (filters: NotificationLogFilters) => ['notifications', 'log', filters] as const,
  smtpSettings: ['settings', 'smtp'] as const,
  // Patching (Phase 7)
  patches: ['patches'] as const,
  patchList: (filters: PatchFilters) => ['patches', 'list', filters] as const,
  patch: (id: string) => ['patches', 'detail', id] as const,
  patchRules: ['patches', 'rules'] as const,
  devicePatches: (deviceId: string) => ['patches', 'device', deviceId] as const,
  compliance: (groupBy: ComplianceGroupBy, clientId?: string, siteId?: string) =>
    ['patches', 'compliance', groupBy, clientId ?? 'all', siteId ?? 'all'] as const,
  patchRuns: ['patch-runs'] as const,
  patchRunList: (limit: number) => ['patch-runs', 'list', limit] as const,
  patchRun: (id: string) => ['patch-runs', 'detail', id] as const,
  // Software (Phase 7)
  software: ['software'] as const,
  softwareList: (filters: SoftwareFilters) => ['software', 'list', filters] as const,
  softwareProduct: (name: string, publisher: string | null) => ['software', 'product', name, publisher ?? ''] as const,
  packages: ['software', 'packages'] as const,
  deployments: ['deployments'] as const,
  deploymentList: (limit: number) => ['deployments', 'list', limit] as const,
  deployment: (id: string) => ['deployments', 'detail', id] as const,
  deviceDeployments: (deviceId: string) => ['deployments', 'device', deviceId] as const,
}

export const setupStatusQuery = queryOptions({
  queryKey: keys.setupStatus,
  queryFn: setupApi.status,
  staleTime: 60_000,
})

export const meQuery = queryOptions({
  queryKey: keys.me,
  queryFn: async () => {
    const me = await authApi.me()
    setCsrfToken(me.csrf_token)
    return me
  },
  staleTime: 5 * 60_000,
  retry: false,
})

export const clientsQuery = (search?: string) =>
  queryOptions({
    queryKey: keys.clientList(search),
    queryFn: async () => (await clientsApi.list(search)).items,
    staleTime: 30_000,
  })

export const clientQuery = (id: string) =>
  queryOptions({
    queryKey: keys.client(id),
    queryFn: () => clientsApi.get(id),
  })

export const sitesQuery = (clientId?: string) =>
  queryOptions({
    queryKey: keys.sites(clientId),
    queryFn: async () => (await sitesApi.list(clientId)).items,
    staleTime: 30_000,
  })

export const usersQuery = queryOptions({
  queryKey: keys.users,
  queryFn: async () => (await usersApi.list()).items,
})

export const rolesQuery = queryOptions({
  queryKey: keys.roles,
  queryFn: async () => (await rolesApi.list()).items,
})

export const permissionsQuery = queryOptions({
  queryKey: keys.permissions,
  queryFn: async () => (await rolesApi.permissions()).items,
  staleTime: Infinity,
})

export const backupsQuery = queryOptions({
  queryKey: keys.backups,
  queryFn: async () => (await backupsApi.list()).items,
  refetchInterval: (query) =>
    query.state.data?.some((backup) => backup.status === 'running') ? 2_000 : 30_000,
})

export const backupSettingsQuery = queryOptions({
  queryKey: keys.backupSettings,
  queryFn: backupsApi.settings,
})

export const sessionsQuery = queryOptions({
  queryKey: keys.sessions,
  queryFn: async () => (await meApi.sessions()).items,
})

export const passkeysQuery = queryOptions({
  queryKey: keys.passkeys,
  queryFn: async () => (await meApi.passkeys()).items,
})

export const healthQuery = queryOptions({
  queryKey: keys.health,
  queryFn: systemApi.health,
  refetchInterval: 60_000,
})

export const fleetQuery = (clientId?: string, siteId?: string) =>
  queryOptions({
    queryKey: keys.fleet(clientId, siteId),
    queryFn: () => systemApi.fleetSummary(clientId, siteId),
    refetchInterval: 30_000,
  })

export const devicesQuery = (filters: DeviceListFilters = {}) =>
  queryOptions({
    queryKey: keys.deviceList(filters),
    queryFn: async () => (await devicesApi.list(filters)).items,
    staleTime: 15_000,
    refetchInterval: 60_000,
  })

export const deviceQuery = (id: string) =>
  queryOptions({
    queryKey: keys.device(id),
    queryFn: () => devicesApi.get(id),
    refetchInterval: 30_000,
  })

export const inventoryQuery = (id: string) =>
  queryOptions({
    queryKey: keys.inventory(id),
    queryFn: () => devicesApi.inventory(id),
    staleTime: 60_000,
  })

export const metricsQuery = (id: string, range: MetricsRange) =>
  queryOptions({
    queryKey: keys.metrics(id, range),
    queryFn: () => devicesApi.metrics(id, range),
    staleTime: range === '1h' ? 30_000 : 120_000,
    refetchInterval: range === '1h' ? 60_000 : false,
  })

export const enrollmentQuery = (filters: { site_id?: string; client_id?: string } = {}) =>
  queryOptions({
    queryKey: keys.enrollmentList(filters),
    queryFn: () => enrollmentApi.list(filters),
    staleTime: 15_000,
  })

// ---------------------------------------------------------------- automation (Phase 5)

export const scriptsQuery = (includeArchived = false) =>
  queryOptions({
    queryKey: keys.scriptList(includeArchived),
    queryFn: async () => (await scriptsApi.list({ include_archived: includeArchived || undefined })).items,
    staleTime: 30_000,
  })

export const scriptQuery = (id: string) =>
  queryOptions({
    queryKey: keys.script(id),
    queryFn: () => scriptsApi.get(id),
  })

export const scriptVersionQuery = (id: string, version: number) =>
  queryOptions({
    queryKey: keys.scriptVersion(id, version),
    queryFn: () => scriptsApi.version(id, version),
    staleTime: Infinity,
  })

export const scriptCategoriesQuery = queryOptions({
  queryKey: keys.scriptCategories,
  queryFn: async () => (await scriptsApi.categories()).items,
  staleTime: 60_000,
})

export const variablesQuery = (scope?: VariableScope, scopeId?: string) =>
  queryOptions({
    queryKey: keys.variableList(scope, scopeId),
    queryFn: async () => (await variablesApi.list(scope, scopeId)).items,
  })

export const jobQuery = (id: string) =>
  queryOptions({
    queryKey: keys.job(id),
    queryFn: () => jobsApi.get(id),
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 10_000 : 30_000),
  })

export const jobRunQuery = (runId: string) =>
  queryOptions({
    queryKey: keys.jobRun(runId),
    queryFn: () => jobsApi.run(runId),
    // Live events drive updates; the interval is a safety net if the stream drops.
    refetchInterval: (query) => (query.state.data?.run.status === 'running' ? 8_000 : false),
  })

export const jobResultQuery = (runId: string, deviceId: string) =>
  queryOptions({
    queryKey: keys.jobResult(runId, deviceId),
    queryFn: () => jobsApi.result(runId, deviceId),
  })

export const deviceScriptRunsQuery = (deviceId: string) =>
  queryOptions({
    queryKey: keys.deviceScriptRuns(deviceId),
    queryFn: async () => (await jobsApi.deviceRuns(deviceId)).items,
  })

export const approvalsQuery = (status?: ApprovalStatus) =>
  queryOptions({
    queryKey: keys.approvalList(status),
    queryFn: async () => (await approvalsApi.list(status)).items,
    refetchInterval: 60_000,
  })

export const automationSettingsQuery = queryOptions({
  queryKey: keys.automationSettings,
  queryFn: automationSettingsApi.get,
  staleTime: 60_000,
})

export const customFieldsQuery = (scope?: CustomFieldScope) =>
  queryOptions({
    queryKey: keys.customFieldList(scope),
    queryFn: async () => (await customFieldsApi.list(scope)).items,
    staleTime: 60_000,
  })

export const customFieldValuesQuery = (scope: CustomFieldScope, id: string) =>
  queryOptions({
    queryKey: keys.customFieldValues(scope, id),
    queryFn: async () => (await customFieldsApi.values(scope, id)).items,
  })

export const groupsQuery = (clientId?: string) =>
  queryOptions({
    queryKey: keys.groupList(clientId),
    queryFn: async () => (await groupsApi.list(clientId)).items,
    staleTime: 30_000,
  })

export const groupMembersQuery = (id: string) =>
  queryOptions({
    queryKey: keys.groupMembers(id),
    queryFn: async () => (await groupsApi.members(id)).items,
  })

export const deviceGroupsQuery = (deviceId: string) =>
  queryOptions({
    queryKey: keys.deviceGroups(deviceId),
    queryFn: async () => (await groupsApi.forDevice(deviceId)).items,
  })

export const policiesQuery = queryOptions({
  queryKey: keys.policies,
  queryFn: async () => (await policiesApi.list()).items,
  staleTime: 30_000,
})

export const policyQuery = (id: string) =>
  queryOptions({
    queryKey: keys.policy(id),
    queryFn: () => policiesApi.get(id),
  })

export const effectivePolicyQuery = (deviceId: string) =>
  queryOptions({
    queryKey: keys.effectivePolicy(deviceId),
    queryFn: () => policiesApi.effective(deviceId),
  })

// ---------------------------------------------------------------- monitoring (Phase 6)

export const alertsSummaryQuery = queryOptions({
  queryKey: keys.alertsSummary,
  queryFn: alertsApi.summary,
  // Live `alerts.summary` events patch this; the interval is a safety net.
  refetchInterval: 60_000,
})

export const alertDetailQuery = (id: string) =>
  queryOptions({
    queryKey: keys.alert(id),
    queryFn: () => alertsApi.get(id),
  })

export const deviceAlertsQuery = (deviceId: string, status?: string) =>
  queryOptions({
    queryKey: keys.deviceAlerts(deviceId, status),
    queryFn: () => alertsApi.forDevice(deviceId, status),
  })

export const checkTypesQuery = queryOptions({
  queryKey: keys.checkTypes,
  queryFn: async () => (await monitoringApi.checkTypes()).items,
  staleTime: Infinity,
})

export const deviceChecksQuery = (deviceId: string) =>
  queryOptions({
    queryKey: keys.deviceChecks(deviceId),
    queryFn: async () => (await monitoringApi.deviceChecks(deviceId)).items,
    refetchInterval: 60_000,
  })

export const deviceMaintenanceQuery = (deviceId: string) =>
  queryOptions({
    queryKey: keys.deviceMaintenance(deviceId),
    queryFn: () => monitoringApi.deviceMaintenance(deviceId),
    refetchInterval: 60_000,
  })

export const maintenanceWindowsQuery = queryOptions({
  queryKey: keys.maintenanceList,
  queryFn: async () => (await maintenanceApi.list()).items,
  // `active_now` and `next_start` are computed by the server; keep them current.
  refetchInterval: 60_000,
})

export const monitoringSettingsQuery = queryOptions({
  queryKey: keys.monitoringSettings,
  queryFn: monitoringApi.settings,
  staleTime: 60_000,
})

export const notificationChannelsQuery = queryOptions({
  queryKey: keys.notificationChannels,
  queryFn: async () => (await notificationsApi.channels()).items,
})

export const notificationRulesQuery = queryOptions({
  queryKey: keys.notificationRules,
  queryFn: async () => (await notificationsApi.rules()).items,
})

export const notificationLogQuery = (filters: NotificationLogFilters = {}) =>
  queryOptions({
    queryKey: keys.notificationLog(filters),
    queryFn: async () => (await notificationsApi.log(filters)).items,
    refetchInterval: 30_000,
  })

export const smtpSettingsQuery = queryOptions({
  queryKey: keys.smtpSettings,
  queryFn: notificationsApi.smtp,
})

// ---------------------------------------------------------------- patching (Phase 7)

/** The whole catalog for the current filters (the mock and small fleets fit in a few pages). */
export const patchesQuery = (filters: PatchFilters) =>
  queryOptions({
    queryKey: keys.patchList(filters),
    queryFn: async () => {
      const items: Patch[] = []
      let cursor: string | null = null
      do {
        const page = await patchesApi.list({ limit: 500, ...filters }, cursor)
        items.push(...page.items)
        cursor = page.next_cursor
      } while (cursor && items.length < 5000)
      return items
    },
    staleTime: 15_000,
  })

export const patchQuery = (id: string) =>
  queryOptions({
    queryKey: keys.patch(id),
    queryFn: () => patchesApi.get(id),
  })

export const patchRulesQuery = queryOptions({
  queryKey: keys.patchRules,
  queryFn: async () => (await patchesApi.rules()).items,
  staleTime: 30_000,
})

export const devicePatchesQuery = (deviceId: string) =>
  queryOptions({
    queryKey: keys.devicePatches(deviceId),
    queryFn: () => patchesApi.forDevice(deviceId),
  })

export const complianceQuery = (groupBy: ComplianceGroupBy, clientId?: string, siteId?: string) =>
  queryOptions({
    queryKey: keys.compliance(groupBy, clientId, siteId),
    queryFn: () => patchesApi.compliance(groupBy, { client_id: clientId, site_id: clientId ? siteId : undefined }),
    refetchInterval: 60_000,
  })

export const patchRunsQuery = (limit = 100) =>
  queryOptions({
    queryKey: keys.patchRunList(limit),
    queryFn: async () => (await patchesApi.runs(limit)).items,
    // `patch_run.updated` drives updates; the interval is a safety net.
    refetchInterval: (query) => (query.state.data?.some((run) => run.status === 'running') ? 10_000 : 60_000),
  })

export const patchRunQuery = (id: string) =>
  queryOptions({
    queryKey: keys.patchRun(id),
    queryFn: () => patchesApi.run(id),
    refetchInterval: (query) => (query.state.data?.run.status === 'running' ? 8_000 : false),
  })

// ---------------------------------------------------------------- software (Phase 7)

export const softwareQuery = (filters: SoftwareFilters) =>
  queryOptions({
    queryKey: keys.softwareList(filters),
    queryFn: async () => {
      const items: SoftwareProductSummary[] = []
      let cursor: string | null = null
      do {
        const page = await softwareApi.list({ limit: 500, ...filters }, cursor)
        items.push(...page.items)
        cursor = page.next_cursor
      } while (cursor && items.length < 5000)
      return items
    },
    staleTime: 60_000,
  })

export const softwareProductQuery = (name: string, publisher: string | null) =>
  queryOptions({
    queryKey: keys.softwareProduct(name, publisher),
    queryFn: () => softwareApi.product(name, publisher),
    staleTime: 60_000,
  })

export const packagesQuery = queryOptions({
  queryKey: keys.packages,
  queryFn: async () => (await softwareApi.packages()).items,
  staleTime: 30_000,
})

/** `software_deployment.updated` drives updates; the intervals are a safety net if the stream drops. */
export const deploymentsQuery = (limit = 100) =>
  queryOptions({
    queryKey: keys.deploymentList(limit),
    queryFn: async () => (await softwareApi.deployments(limit)).items,
    refetchInterval: (query) =>
      query.state.data?.some((item) => item.status === 'running') ? 10_000 : 60_000,
  })

export const deploymentQuery = (id: string) =>
  queryOptions({
    queryKey: keys.deployment(id),
    queryFn: () => softwareApi.deployment(id),
    refetchInterval: (query) =>
      query.state.data?.deployment.status === 'running' || query.state.data?.deployment.status === 'scheduled'
        ? 8_000
        : false,
  })

export const deviceDeploymentsQuery = (deviceId: string) =>
  queryOptions({
    queryKey: keys.deviceDeployments(deviceId),
    queryFn: async () => (await softwareApi.forDevice(deviceId)).items,
    refetchInterval: (query) =>
      query.state.data?.some((item) => item.status === 'pending' || item.status === 'running') ? 8_000 : false,
  })

// ---------------------------------------------------------------- tickets (Phase 9)

export const ticketKeys = {
  all: ['tickets'] as const,
  lists: ['tickets', 'list'] as const,
  list: (filters: TicketFilters) => ['tickets', 'list', filters] as const,
  counts: (filters: TicketFilters) => ['tickets', 'counts', filters] as const,
  detail: (id: string) => ['tickets', 'detail', id] as const,
  device: (deviceId: string) => ['tickets', 'device', deviceId] as const,
  stats: (clientId?: string) => ['tickets', 'stats', clientId ?? 'all'] as const,
  queues: ['ticket-queues'] as const,
  slaPolicies: ['sla-policies'] as const,
  canned: ['canned-responses'] as const,
  contacts: ['contacts'] as const,
  contactList: (clientId?: string, q?: string) => ['contacts', 'list', clientId ?? 'all', q ?? ''] as const,
  contact: (id: string) => ['contacts', 'detail', id] as const,
  time: ['time-entries'] as const,
  timeList: (filters: TimeEntryFilters) => ['time-entries', 'list', filters] as const,
  email: ['settings', 'ticket-email'] as const,
  alertRules: ['alert-ticket-rules'] as const,
}

export const ticketDetailQuery = (id: string) =>
  queryOptions({
    queryKey: ticketKeys.detail(id),
    queryFn: () => ticketsApi.get(id),
    // Live `ticket.*` events drive updates; the interval keeps SLA states honest if the stream drops.
    refetchInterval: 60_000,
  })

export const ticketQueuesQuery = queryOptions({
  queryKey: ticketKeys.queues,
  queryFn: async () => (await ticketQueuesApi.list()).items,
  staleTime: 60_000,
})

export const slaPoliciesQuery = queryOptions({
  queryKey: ticketKeys.slaPolicies,
  queryFn: async () => (await slaPoliciesApi.list()).items,
  staleTime: 60_000,
})

export const cannedResponsesQuery = queryOptions({
  queryKey: ticketKeys.canned,
  queryFn: async () => (await cannedResponsesApi.list()).items,
  staleTime: 60_000,
})

export const contactsQuery = (clientId?: string, q?: string) =>
  queryOptions({
    queryKey: ticketKeys.contactList(clientId, q),
    queryFn: async () => (await contactsApi.list({ client_id: clientId, q: q || undefined })).items,
    staleTime: 30_000,
  })

export const contactQuery = (id: string) =>
  queryOptions({
    queryKey: ticketKeys.contact(id),
    queryFn: () => contactsApi.get(id),
  })

export const timeEntriesQuery = (filters: TimeEntryFilters) =>
  queryOptions({
    queryKey: ticketKeys.timeList(filters),
    queryFn: () => timeEntriesApi.list(filters),
  })

export const ticketEmailQuery = queryOptions({
  queryKey: ticketKeys.email,
  queryFn: ticketEmailApi.get,
})

export const alertTicketRulesQuery = queryOptions({
  queryKey: ticketKeys.alertRules,
  queryFn: async () => (await alertTicketRulesApi.list()).items,
})

export const deviceTicketsQuery = (deviceId: string) =>
  queryOptions({
    queryKey: ticketKeys.device(deviceId),
    queryFn: () => ticketsApi.forDevice(deviceId),
  })

// ---------------------------------------------------------------- secrets escrow (Phase 10)

/** Escrow metadata only. Revealed secrets never enter the query cache (see `escrowApi.reveal`). */
export const escrowKeys = {
  all: ['escrow'] as const,
  list: (filters: EscrowFilters) => ['escrow', 'list', filters] as const,
  device: (deviceId: string, includeSuperseded: boolean) => ['escrow', 'device', deviceId, includeSuperseded] as const,
  stats: ['escrow', 'stats'] as const,
}

export const escrowItemsQuery = (filters: EscrowFilters) =>
  queryOptions({
    queryKey: escrowKeys.list(filters),
    queryFn: async () => (await escrowApi.list(filters)).items,
    // `escrow.changed` drives updates; the interval is a safety net.
    refetchInterval: 60_000,
  })

export const deviceEscrowQuery = (deviceId: string, includeSuperseded = false) =>
  queryOptions({
    queryKey: escrowKeys.device(deviceId, includeSuperseded),
    queryFn: async () => (await escrowApi.forDevice(deviceId, includeSuperseded)).items,
  })

export const escrowStatsQuery = queryOptions({
  queryKey: escrowKeys.stats,
  queryFn: escrowApi.stats,
  refetchInterval: 120_000,
})

// ---------------------------------------------------------------- network discovery and SNMP (Phase 10)

export const networkKeys = {
  all: ['network'] as const,
  probes: ['network', 'probes'] as const,
  scans: ['network', 'scans'] as const,
  assets: ['network', 'assets'] as const,
  assetList: (filters: AssetFilters) => ['network', 'assets', filters] as const,
  credentials: ['network', 'snmp', 'credentials'] as const,
  templates: ['network', 'snmp', 'templates'] as const,
  devices: ['network', 'snmp', 'devices'] as const,
  deviceList: (siteId?: string) => ['network', 'snmp', 'devices', siteId ?? 'all'] as const,
  metrics: (id: string, range: MetricsRange) => ['network', 'snmp', 'metrics', id, range] as const,
  traps: ['network', 'snmp', 'traps'] as const,
  trapList: (siteId?: string, limit = 200) => ['network', 'snmp', 'traps', siteId ?? 'all', limit] as const,
  topology: (siteId: string) => ['network', 'topology', siteId] as const,
  trapRules: ['network', 'snmp', 'trap-rules'] as const,
  settings: ['settings', 'network'] as const,
}

export const trapRulesQuery = queryOptions({
  queryKey: networkKeys.trapRules,
  queryFn: async () => (await snmpApi.trapRules()).items,
  staleTime: 60_000,
})

export const networkSettingsQuery = queryOptions({
  queryKey: networkKeys.settings,
  queryFn: networkSettingsApi.get,
  staleTime: 60_000,
})

export const probesQuery = queryOptions({
  queryKey: networkKeys.probes,
  queryFn: async () => (await probesApi.list()).items,
  staleTime: 30_000,
  refetchInterval: 60_000,
})

export const scansQuery = queryOptions({
  queryKey: networkKeys.scans,
  queryFn: async () => (await scansApi.list()).items,
  // `network.scan` events drive progress; poll faster while a run is active in case the stream drops.
  refetchInterval: (query) => (query.state.data?.some((scan) => scan.last_run?.status === 'running') ? 5_000 : 60_000),
})

export const assetsQuery = (filters: AssetFilters = {}) =>
  queryOptions({
    queryKey: networkKeys.assetList(filters),
    queryFn: async () => (await assetsApi.list(filters)).items,
    staleTime: 15_000,
  })

export const snmpCredentialsQuery = queryOptions({
  queryKey: networkKeys.credentials,
  queryFn: async () => (await snmpApi.credentials()).items,
  staleTime: 60_000,
})

export const snmpTemplatesQuery = queryOptions({
  queryKey: networkKeys.templates,
  queryFn: async () => (await snmpApi.templates()).items,
  staleTime: 60_000,
})

export const snmpDevicesQuery = (siteId?: string) =>
  queryOptions({
    queryKey: networkKeys.deviceList(siteId),
    queryFn: async () => (await snmpApi.devices(siteId)).items,
    // `snmp.device` events drive status changes; the interval is a safety net.
    refetchInterval: 60_000,
  })

export const snmpMetricsQuery = (id: string, range: MetricsRange) =>
  queryOptions({
    queryKey: networkKeys.metrics(id, range),
    queryFn: () => snmpApi.metrics(id, range),
    staleTime: range === '1h' ? 30_000 : 120_000,
    refetchInterval: range === '1h' || range === '24h' ? 60_000 : false,
  })

export const snmpTrapsQuery = (siteId?: string, limit = 200) =>
  queryOptions({
    queryKey: networkKeys.trapList(siteId, limit),
    queryFn: async () => (await snmpApi.traps({ site_id: siteId, limit })).items,
    refetchInterval: 60_000,
  })

export const topologyQuery = (siteId: string) =>
  queryOptions({
    queryKey: networkKeys.topology(siteId),
    queryFn: () => topologyApi.get(siteId),
    staleTime: 60_000,
  })

// ---------------------------------------------------------------- reports, dashboards, SSO, API tokens, webhooks, branding (Phase 11)

export const platformKeys = {
  reportTypes: ['reports', 'types'] as const,
  reportRuns: ['report-runs'] as const,
  reportRunList: (limit: number, scheduleId?: string) => ['report-runs', 'list', limit, scheduleId ?? 'all'] as const,
  reportRun: (id: string) => ['report-runs', 'detail', id] as const,
  reportSchedules: ['report-schedules'] as const,
  dashboards: ['dashboards'] as const,
  dashboardList: ['dashboards', 'list'] as const,
  home: ['dashboards', 'home'] as const,
  dashboard: (id: string) => ['dashboards', 'detail', id] as const,
  widget: (widget: WidgetName, config: WidgetConfig) => ['dashboards', 'widget', widget, config] as const,
  ssoProviders: ['settings', 'sso', 'providers'] as const,
  ssoSettings: ['settings', 'sso'] as const,
  loginProviders: ['auth', 'providers'] as const,
  apiTokens: ['api-tokens'] as const,
  apiTokenList: (all: boolean) => ['api-tokens', all ? 'all' : 'mine'] as const,
  webhooks: ['webhooks'] as const,
  webhookDeliveries: (id: string, status?: string) => ['webhooks', 'deliveries', id, status ?? 'all'] as const,
  branding: ['branding'] as const,
  brandingSettings: ['settings', 'branding'] as const,
  signing: ['settings', 'signing-status'] as const,
}

export const reportTypesQuery = queryOptions({
  queryKey: platformKeys.reportTypes,
  queryFn: async () => (await reportsApi.types()).items,
  staleTime: 5 * 60_000,
})

export const reportRunsQuery = (limit = 100, scheduleId?: string) =>
  queryOptions({
    queryKey: platformKeys.reportRunList(limit, scheduleId),
    queryFn: async () => (await reportsApi.runs({ limit, schedule_id: scheduleId })).items,
    // No live event covers report runs: poll faster while one is queued or running.
    refetchInterval: (query) => (query.state.data?.some((run) => run.status === 'queued' || run.status === 'running') ? 3_000 : 60_000),
  })

export const reportRunQuery = (id: string) =>
  queryOptions({
    queryKey: platformKeys.reportRun(id),
    queryFn: () => reportsApi.getRun(id),
    refetchInterval: (query) => (query.state.data && (query.state.data.status === 'queued' || query.state.data.status === 'running') ? 2_000 : false),
  })

export const reportSchedulesQuery = queryOptions({
  queryKey: platformKeys.reportSchedules,
  queryFn: async () => (await reportsApi.schedules()).items,
  staleTime: 30_000,
})

export const dashboardsQuery = queryOptions({
  queryKey: platformKeys.dashboardList,
  queryFn: dashboardsApi.list,
  staleTime: 30_000,
})

export const homeDashboardQuery = queryOptions({
  queryKey: platformKeys.home,
  queryFn: dashboardsApi.home,
  staleTime: 60_000,
})

export const dashboardQuery = (id: string) =>
  queryOptions({
    queryKey: platformKeys.dashboard(id),
    queryFn: () => dashboardsApi.get(id),
    staleTime: 30_000,
  })

export const widgetQuery = <W extends WidgetName>(widget: W, config: WidgetConfig) =>
  queryOptions({
    queryKey: platformKeys.widget(widget, config),
    queryFn: () => dashboardsApi.widget(widget, config),
    staleTime: 20_000,
    refetchInterval: 60_000,
  })

export const ssoProvidersQuery = queryOptions({
  queryKey: platformKeys.ssoProviders,
  queryFn: async () => (await ssoApi.providers()).items,
  staleTime: 60_000,
  retry: false,
})

export const ssoSettingsQuery = queryOptions({
  queryKey: platformKeys.ssoSettings,
  queryFn: ssoApi.settings,
  staleTime: 60_000,
})

export const loginProvidersQuery = queryOptions({
  queryKey: platformKeys.loginProviders,
  queryFn: ssoApi.loginProviders,
  staleTime: 60_000,
  retry: false,
})

export const apiTokensQuery = (all = false) =>
  queryOptions({
    queryKey: platformKeys.apiTokenList(all),
    queryFn: async () => (await apiTokensApi.list(all)).items,
    staleTime: 30_000,
  })

export const webhooksQuery = queryOptions({
  queryKey: platformKeys.webhooks,
  queryFn: webhooksApi.list,
  staleTime: 30_000,
  refetchInterval: 60_000,
})

export const webhookDeliveriesQuery = (id: string, status?: string) =>
  queryOptions({
    queryKey: platformKeys.webhookDeliveries(id, status),
    queryFn: async () => (await webhooksApi.deliveries(id, { limit: 100, status })).items,
    refetchInterval: (query) => (query.state.data?.some((delivery) => delivery.status === 'pending' || delivery.status === 'sending') ? 4_000 : 30_000),
  })

export const brandingQuery = queryOptions({
  queryKey: platformKeys.branding,
  queryFn: brandingApi.public,
  staleTime: 5 * 60_000,
  retry: false,
})

export const brandingSettingsQuery = queryOptions({
  queryKey: platformKeys.brandingSettings,
  queryFn: brandingApi.settings,
})

export const signingStatusQuery = queryOptions({
  queryKey: platformKeys.signing,
  queryFn: signingApi.status,
  staleTime: 5 * 60_000,
  retry: false,
})
