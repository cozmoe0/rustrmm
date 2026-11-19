import {
  api,
  buildUrl,
  buildWsUrl,
  dispositionFileName,
  download,
  request,
  requestBlob,
  requestResponse,
  requestText,
  uploadWithProgress,
  type QueryValue,
  type UploadOptions,
} from './client'
import type {
  AgentReleaseList,
  AgentRollout,
  AgentUpdateRequest,
  AgentUpdateResult,
  AgentUpdatesResponse,
  DeviceAgentUpdate,
  AlertActionResponse,
  AlertBulkRequest,
  AlertBulkResponse,
  AlertDetail,
  AlertFilters,
  AlertListResponse,
  AlertsSummary,
  ChannelTestResult,
  CheckTypeDefinition,
  DeviceCheck,
  DeviceMaintenance,
  MaintenanceWindow,
  MaintenanceWindowInput,
  MonitoringSettings,
  NotificationChannel,
  NotificationChannelInput,
  NotificationLogEntry,
  NotificationRule,
  NotificationRuleInput,
  SmtpSettings,
  SmtpSettingsInput,
  SmtpTestResult,
  AgentActionResult,
  Approval,
  ApprovalStatus,
  AutomationSettings,
  CustomField,
  CustomFieldInput,
  CustomFieldScope,
  CustomFieldValue,
  CustomFieldValueEntry,
  DeviceGroup,
  DeviceScriptRun,
  EffectivePolicy,
  GroupInput,
  GroupPreview,
  Job,
  JobCreate,
  JobFilters,
  JobResultDetail,
  JobRunDetail,
  JobSummary,
  ParameterValue,
  Policy,
  PolicyAssignment,
  PolicyAssignmentInput,
  PolicyInput,
  QuickRunResponse,
  RuleDocument,
  Script,
  ScriptCategory,
  ScriptFilters,
  ScriptInput,
  ScriptLanguage,
  ScriptSummary,
  ScriptVersionDetail,
  Variable,
  VariableInput,
  VariableScope,
  AuditEvent,
  AuditFilters,
  AuditVerifyResult,
  AuthOk,
  Backup,
  BackupSettings,
  BackupSettingsUpdate,
  Client,
  ClientDetail,
  ClientInput,
  ClientPatch,
  Device,
  DeviceDetail,
  DeviceListFilters,
  DesktopCreateRequest,
  DesktopSessionList,
  DesktopTicket,
  DevicePatch,
  DiagnosticRequest,
  DiagnosticResult,
  EnrollmentTokenCreate,
  EnrollmentTokenCreated,
  EnrollmentTokenList,
  EventLogQuery,
  EventLogResponse,
  FileListing,
  FileOperation,
  FleetSummary,
  InstallerKind,
  InventoryResponse,
  KillResult,
  ListResponse,
  LoginResponse,
  Me,
  MessageRequest,
  MetricsRange,
  MetricsResponse,
  PagedResponse,
  Passkey,
  Permission,
  PowerRequest,
  ProcessList,
  RegistryListing,
  RemoteService,
  RemoteSession,
  Role,
  RoleInput,
  ServiceAction,
  ServiceActionResult,
  SessionInfo,
  SetupCompleteRequest,
  SetupCompleteResponse,
  SetupStatus,
  ShellCreateRequest,
  ShellTicket,
  Site,
  SiteInput,
  StepUpResponse,
  StreamTicket,
  SystemHealth,
  TestS3Result,
  TimelinePage,
  TotpSetupFinish,
  TotpSetupStart,
  UploadResult,
  User,
  UserCreate,
  UserPatch,
  WebauthnOptions,
  ComplianceGroupBy,
  ComplianceReport,
  DeploymentCreate,
  DeploymentDetail,
  DeploymentSummary,
  DeviceDeployment,
  DevicePatches,
  DevicePatchState,
  Patch,
  PatchApprovalRuleRow,
  PatchApproveRequest,
  PatchDetail,
  PatchFilters,
  PatchInstallRequest,
  PatchInstallResponse,
  PatchRun,
  PatchRunDetail,
  SoftwareFileUpload,
  SoftwareFilters,
  SoftwarePackage,
  SoftwarePackageInput,
  SoftwareProduct,
  SoftwareProductSummary,
} from './types'
import type {
  AlertTicketCreate,
  AlertTicketRule,
  AlertTicketRuleInput,
  CannedRender,
  CannedResponse,
  CannedResponseInput,
  CommentVisibility,
  Contact,
  ContactImportResult,
  ContactInput,
  ImapTestResult,
  SlaPolicy,
  SlaPolicyInput,
  Ticket,
  TicketBulkRequest,
  TicketBulkResponse,
  TicketComment,
  TicketCreate,
  TicketDetail,
  TicketEmailSettings,
  TicketEmailSettingsInput,
  TicketFilters,
  TicketLinks,
  TicketListResponse,
  TicketPatch,
  TicketQueue,
  TicketQueueInput,
  TicketStats,
  TimeEntry,
  TimeEntryFilters,
  TimeEntryInput,
  TimeEntryListResponse,
} from './types'
import type {
  AssetFilters,
  AssetPatch,
  CommandAccepted,
  EscrowFilters,
  EscrowItem,
  EscrowReveal,
  EscrowStats,
  NetworkAsset,
  NetworkScan,
  NetworkScanInput,
  NetworkSettings,
  NetworkTopology,
  SiteProbe,
  SiteProbeInput,
  SnmpCredential,
  SnmpCredentialInput,
  SnmpDevice,
  SnmpDeviceInput,
  SnmpMetricsResponse,
  SnmpTemplate,
  SnmpTemplateInput,
  SnmpTestResult,
  SnmpTrap,
  TrapRule,
  TrapRuleInput,
} from './types'
import type {
  ApiToken,
  ApiTokenCreate,
  ApiTokenCreated,
  AuthProviders,
  BrandingFile,
  BrandingSettings,
  Dashboard,
  DashboardInput,
  DashboardList,
  PublicBranding,
  Report,
  ReportRun,
  ReportRunOutcome,
  ReportRunRequest,
  ReportSchedule,
  ReportScheduleInput,
  ReportTypeInfo,
  SigningStatus,
  SsoProvider,
  SsoProviderInput,
  SsoSettings,
  Webhook,
  WebhookDelivery,
  WebhookInput,
  WebhookList,
  WidgetConfig,
  WidgetName,
  WidgetResponse,
} from './types'

const open = { authRequired: false } as const

export const setupApi = {
  status: () => api.get<SetupStatus>('/setup/status', open),
  complete: (body: SetupCompleteRequest) =>
    api.post<SetupCompleteResponse>('/setup/complete', body, open),
}

export const authApi = {
  me: () => api.get<Me>('/auth/me', open),
  login: (email: string, password: string) =>
    api.post<LoginResponse>('/auth/login', { email, password }, open),
  logout: () => api.post<void>('/auth/logout', undefined, open),
  totp: (challenge_token: string, code: string) =>
    api.post<AuthOk>('/auth/mfa/totp', { challenge_token, code }, open),
  recovery: (challenge_token: string, code: string) =>
    api.post<AuthOk>('/auth/mfa/recovery', { challenge_token, code }, open),
  webauthnStart: (challenge_token: string) =>
    api.post<WebauthnOptions>('/auth/mfa/webauthn/start', { challenge_token }, open),
  webauthnFinish: (challenge_token: string, credential: unknown) =>
    api.post<AuthOk>('/auth/mfa/webauthn/finish', { challenge_token, credential }, open),
  totpSetupStart: (challenge_token: string) =>
    api.post<TotpSetupStart>('/auth/mfa/setup/totp/start', { challenge_token }, open),
  totpSetupFinish: (challenge_token: string, code: string) =>
    api.post<TotpSetupFinish>('/auth/mfa/setup/totp/finish', { challenge_token, code }, open),
  stepUpTotp: (code: string) =>
    api.post<StepUpResponse>('/auth/step-up', { method: 'totp', code }, { skipStepUp: true }),
  stepUpWebauthnStart: () =>
    api.post<WebauthnOptions>('/auth/step-up/webauthn/start', undefined, { skipStepUp: true }),
  stepUpWebauthnFinish: (credential: unknown) =>
    api.post<StepUpResponse>('/auth/step-up/webauthn/finish', { credential }, { skipStepUp: true }),
}

export const meApi = {
  sessions: () => api.get<ListResponse<SessionInfo>>('/me/sessions'),
  revokeSession: (id: string) => api.del(`/me/sessions/${id}`),
  passkeys: () => api.get<ListResponse<Passkey>>('/me/passkeys'),
  passkeyRegisterStart: () => api.post<WebauthnOptions>('/me/passkeys/register/start'),
  passkeyRegisterFinish: (name: string, credential: unknown) =>
    api.post<Passkey>('/me/passkeys/register/finish', { name, credential }),
  deletePasskey: (id: string) => api.del(`/me/passkeys/${id}`),
  changePassword: (current_password: string, new_password: string) =>
    api.post<void>('/me/password', { current_password, new_password }),
  regenerateRecoveryCodes: () => api.post<{ recovery_codes: string[] }>('/me/recovery-codes'),
}

export const clientsApi = {
  list: (search?: string) => api.get<ListResponse<Client>>('/clients', { query: { search } }),
  get: (id: string) => api.get<ClientDetail>(`/clients/${id}`),
  create: (body: ClientInput) => api.post<Client>('/clients', body),
  update: (id: string, body: ClientPatch) => api.patch<Client>(`/clients/${id}`, body),
  remove: (id: string) => api.del(`/clients/${id}`),
  /** Sets (or with `null` removes) the client's branding logo. */
  setLogo: (id: string, fileId: string | null) => api.put<{ logo_url: string | null }>(`/clients/${id}/logo`, { file_id: fileId }),
}

export const sitesApi = {
  list: (clientId?: string) =>
    api.get<ListResponse<Site>>('/sites', { query: { client_id: clientId } }),
  create: (clientId: string, body: SiteInput) => api.post<Site>(`/clients/${clientId}/sites`, body),
  update: (id: string, body: Partial<SiteInput>) => api.patch<Site>(`/sites/${id}`, body),
  remove: (id: string) => api.del(`/sites/${id}`),
}

export const usersApi = {
  list: () => api.get<ListResponse<User>>('/users'),
  create: (body: UserCreate) => api.post<User>('/users', body),
  update: (id: string, body: UserPatch) => api.patch<User>(`/users/${id}`, body),
  remove: (id: string) => api.del(`/users/${id}`),
  resetMfa: (id: string) => api.post<void>(`/users/${id}/reset-mfa`),
}

export const rolesApi = {
  list: () => api.get<ListResponse<Role>>('/roles'),
  create: (body: RoleInput) => api.post<Role>('/roles', body),
  update: (id: string, body: Partial<RoleInput>) => api.patch<Role>(`/roles/${id}`, body),
  remove: (id: string) => api.del(`/roles/${id}`),
  permissions: () => api.get<ListResponse<Permission>>('/permissions'),
}

function auditQuery(filters: AuditFilters): Record<string, QueryValue> {
  return { ...filters }
}

export const auditApi = {
  list: (filters: AuditFilters, cursor?: string | null, limit = 100) =>
    api.get<PagedResponse<AuditEvent>>('/audit', {
      query: { ...auditQuery(filters), cursor: cursor ?? undefined, limit },
    }),
  verify: () => api.post<AuditVerifyResult>('/audit/verify'),
  export: (format: 'csv' | 'json', filters: AuditFilters) =>
    download('/audit/export', `rustrmm-audit.${format}`, { ...auditQuery(filters), format }),
}

export const backupsApi = {
  settings: () => api.get<BackupSettings>('/settings/backups'),
  updateSettings: (body: BackupSettingsUpdate) => api.put<BackupSettings>('/settings/backups', body),
  list: () => api.get<ListResponse<Backup>>('/backups'),
  run: () => api.post<Backup>('/backups'),
  remove: (id: string) => api.del(`/backups/${id}`),
  download: (id: string) => download(`/backups/${id}/download`, `rustrmm-backup-${id}.tar.zst.age`),
  testS3: () => api.post<TestS3Result>('/backups/test-s3'),
}

export const systemApi = {
  /** Needs `settings.view` installation-wide (403 otherwise); only the Home server card reads it, gated the same way. */
  health: () => api.get<SystemHealth>('/system/health'),
  fleetSummary: (clientId?: string, siteId?: string) =>
    api.get<FleetSummary>('/fleet/summary', { query: { client_id: clientId, site_id: siteId } }),
  streamTicket: () => api.post<StreamTicket>('/stream/ticket'),
}

function deviceQuery(filters: DeviceListFilters): Record<string, QueryValue> {
  return { ...filters }
}

export const devicesApi = {
  list: (filters: DeviceListFilters = {}) =>
    api.get<ListResponse<Device>>('/devices', { query: deviceQuery(filters) }),
  get: (id: string) => api.get<DeviceDetail>(`/devices/${id}`),
  inventory: (id: string) => api.get<InventoryResponse>(`/devices/${id}/inventory`),
  metrics: (id: string, range: MetricsRange) =>
    api.get<MetricsResponse>(`/devices/${id}/metrics`, { query: { range } }),
  timeline: (id: string, cursor?: number | null, limit = 50) =>
    api.get<TimelinePage>(`/devices/${id}/timeline`, { query: { cursor: cursor ?? undefined, limit } }),
  update: (id: string, body: DevicePatch) => api.patch<DeviceDetail>(`/devices/${id}`, body),
  approve: (id: string) => api.post<void>(`/devices/${id}/approve`),
  reject: (id: string) => api.post<void>(`/devices/${id}/reject`),
  revoke: (id: string) => api.post<void>(`/devices/${id}/revoke`),
  remove: (id: string) => api.del(`/devices/${id}`),
  live: (id: string) => api.post<{ ok: boolean }>(`/devices/${id}/live`),
  refreshInventory: (id: string) => api.post<{ ok: boolean }>(`/devices/${id}/inventory/refresh`),
}

export const agentUpdatesApi = {
  list: (filters: { client_id?: string; site_id?: string } = {}) =>
    api.get<AgentUpdatesResponse>('/agent-updates', { query: { ...filters } }),
  device: (id: string) => api.get<DeviceAgentUpdate>(`/devices/${id}/agent-update`),
  update: (body: AgentUpdateRequest) => api.post<AgentUpdateResult>('/agent-updates/update', body),
  updateDevice: (id: string) => api.post<AgentUpdateResult>(`/devices/${id}/update`),
  rollouts: () => api.get<ListResponse<AgentRollout>>('/rollouts'),
  rolloutAction: (id: string, action: 'pause' | 'resume' | 'cancel') => api.post<void>(`/rollouts/${id}/${action}`),
  releases: () => api.get<AgentReleaseList>('/agent-releases'),
  importRelease: () => api.post<{ imported: string | null }>('/agent-releases/import'),
}

export const enrollmentApi = {
  list: (filters: { site_id?: string; client_id?: string } = {}) =>
    api.get<EnrollmentTokenList>('/enrollment-tokens', { query: { ...filters } }),
  create: (siteId: string, body: EnrollmentTokenCreate) =>
    api.post<EnrollmentTokenCreated>(`/sites/${siteId}/enrollment-tokens`, body),
  deployKey: (id: string) => api.get<{ deploy_key: string }>(`/enrollment-tokens/${id}/deploy-key`),
  revoke: (id: string) => api.del(`/enrollment-tokens/${id}`),
  installer: (id: string, kind: InstallerKind) =>
    download(
      `/enrollment-tokens/${id}/installer/${kind}`,
      kind === 'deploy-key' ? 'deploy.key' : kind === 'gpo' ? 'Install-RustRMM.ps1' : `install-rustrmm-${kind}`,
    ),
}

export const remoteApi = {
  processes: (id: string) => api.get<ProcessList>(`/devices/${id}/processes`),
  killProcess: (id: string, pid: number, tree: boolean) =>
    api.post<KillResult>(`/devices/${id}/processes/${pid}/kill`, { tree }),
  services: (id: string) => api.get<ListResponse<RemoteService>>(`/devices/${id}/services`),
  serviceAction: (id: string, name: string, action: ServiceAction) =>
    api.post<ServiceActionResult>(`/devices/${id}/services/${encodeURIComponent(name)}/${action}`),
  eventLogs: (id: string, query: EventLogQuery) =>
    api.get<EventLogResponse>(`/devices/${id}/event-logs`, { query: { ...query } }),
  registry: (id: string, path: string) => api.get<RegistryListing>(`/devices/${id}/registry`, { query: { path } }),
  power: (id: string, body: PowerRequest) => api.post<AgentActionResult>(`/devices/${id}/power`, body),
  message: (id: string, body: MessageRequest) => api.post<AgentActionResult>(`/devices/${id}/message`, body),
  diagnostics: <T extends DiagnosticResult = DiagnosticResult>(id: string, body: DiagnosticRequest) =>
    api.post<T>(`/devices/${id}/diagnostics`, body),
  files: (id: string, path: string) => api.get<FileListing>(`/devices/${id}/files`, { query: { path } }),
  fileOp: (id: string, body: FileOperation) => api.post<AgentActionResult>(`/devices/${id}/files/op`, body),
  downloadUrl: (id: string, path: string) => buildUrl(`/devices/${id}/files/download`, { path }),
  /** Fetches a file through `fetch` (used in mock mode, where the service worker cannot serve navigations). */
  downloadBlob: (id: string, path: string, fallbackName: string) =>
    download(`/devices/${id}/files/download`, fallbackName, { path }),
  upload: (id: string, path: string, file: Blob, options: Omit<UploadOptions, 'query'> & { overwrite: boolean }) =>
    uploadWithProgress<UploadResult>(`/devices/${id}/files/upload`, file, {
      ...options,
      query: { path, overwrite: options.overwrite },
    }),
  createShell: (id: string, body: ShellCreateRequest) => api.post<ShellTicket>(`/devices/${id}/shell`, body),
  shellSocketUrl: (sessionId: string, ticket: string) =>
    buildWsUrl(`/remote-sessions/${sessionId}/ws`, { ticket }),
  sessions: (deviceId?: string, limit = 100) =>
    api.get<ListResponse<RemoteSession>>('/remote-sessions', { query: { device_id: deviceId, limit } }),
  recording: (sessionId: string) => requestText(`/remote-sessions/${sessionId}/recording`),
  endSession: (sessionId: string) => api.post<void>(`/remote-sessions/${sessionId}/end`),
}

// ---------------------------------------------------------------- remote desktop (Phase 8)

export const desktopApi = {
  sessions: (id: string) => api.get<DesktopSessionList>(`/devices/${id}/desktop/sessions`),
  /** Needs a recent step-up (handled by the client). */
  create: (id: string, body: DesktopCreateRequest) => api.post<DesktopTicket>(`/devices/${id}/desktop`, body),
  socketUrl: (sessionId: string, ticket: string) => buildWsUrl(`/remote-sessions/${sessionId}/ws`, { ticket }),
  /** A JPEG of the console session's primary monitor (at most 1280 px wide). Consent rules apply. */
  screenshot: (id: string, signal?: AbortSignal) => requestBlob(`/devices/${id}/screenshot`, { signal }),
}

// ---------------------------------------------------------------- automation (Phase 5)

type CustomFieldValues = Record<string, CustomFieldValue>

export const scriptsApi = {
  list: (filters: ScriptFilters = {}) => api.get<ListResponse<ScriptSummary>>('/scripts', { query: { ...filters } }),
  get: (id: string) => api.get<Script>(`/scripts/${id}`),
  create: (body: ScriptInput) => api.post<Script>('/scripts', body),
  update: (id: string, body: ScriptInput) => api.put<Script>(`/scripts/${id}`, body),
  duplicate: (id: string) => api.post<Script>(`/scripts/${id}/duplicate`),
  archive: (id: string) => api.del(`/scripts/${id}`),
  version: (id: string, version: number) => api.get<ScriptVersionDetail>(`/scripts/${id}/versions/${version}`),
  approve: (id: string, version: number) => api.post<Script>(`/scripts/${id}/versions/${version}/approve`),
  categories: () => api.get<ListResponse<ScriptCategory>>('/script-categories'),
}

export const variablesApi = {
  list: (scope?: VariableScope, scopeId?: string) =>
    api.get<ListResponse<Variable>>('/variables', { query: { scope, scope_id: scopeId } }),
  create: (body: VariableInput) => api.post<Variable>('/variables', body),
  update: (id: string, body: VariableInput) => api.put<Variable>(`/variables/${id}`, body),
  remove: (id: string) => api.del(`/variables/${id}`),
}

export const jobsApi = {
  list: (filters: JobFilters = {}, cursor?: string | null) =>
    api.get<PagedResponse<JobSummary>>('/jobs', { query: { ...filters, cursor: cursor ?? undefined } }),
  get: (id: string) => api.get<Job>(`/jobs/${id}`),
  create: (body: JobCreate) => api.post<Job>('/jobs', body),
  runNow: (id: string) => api.post<Job>(`/jobs/${id}/run-now`),
  cancel: (id: string) => api.post<Job>(`/jobs/${id}/cancel`),
  remove: (id: string) => api.del(`/jobs/${id}`),
  run: (runId: string) => api.get<JobRunDetail>(`/job-runs/${runId}`),
  result: (runId: string, deviceId: string) => api.get<JobResultDetail>(`/job-runs/${runId}/results/${deviceId}`),
  rerun: (runId: string, only: 'failed' | 'all') => api.post<JobRunDetail>(`/job-runs/${runId}/rerun`, { only }),
  cancelRun: (runId: string) => api.post<JobRunDetail>(`/job-runs/${runId}/cancel`),
  deviceRuns: (deviceId: string, limit = 50) =>
    api.get<ListResponse<DeviceScriptRun>>(`/devices/${deviceId}/script-runs`, { query: { limit } }),
  quickRun: (deviceId: string, body: { script_id: string; parameters: Record<string, ParameterValue>; timeout_secs?: number | null }) =>
    api.post<QuickRunResponse>(`/devices/${deviceId}/run-script`, body),
  adhocRun: (deviceId: string, body: { adhoc: { language: ScriptLanguage; content: string }; timeout_secs?: number | null }) =>
    api.post<QuickRunResponse>(`/devices/${deviceId}/run-script`, body),
}

export const approvalsApi = {
  /** Omit `status` for every approval visible to the caller. */
  list: (status?: ApprovalStatus) => api.get<ListResponse<Approval>>('/approvals', { query: { status } }),
  approve: (id: string, comment?: string) => api.post<Approval>(`/approvals/${id}/approve`, comment ? { comment } : {}),
  reject: (id: string, comment: string) => api.post<Approval>(`/approvals/${id}/reject`, { comment }),
}

export const automationSettingsApi = {
  get: () => api.get<AutomationSettings>('/settings/automation'),
  update: (body: AutomationSettings) => api.put<AutomationSettings>('/settings/automation', body),
}

export const customFieldsApi = {
  list: (scope?: CustomFieldScope) => api.get<ListResponse<CustomField>>('/custom-fields', { query: { scope } }),
  create: (body: CustomFieldInput) => api.post<CustomField>('/custom-fields', body),
  update: (id: string, body: CustomFieldInput) => api.put<CustomField>(`/custom-fields/${id}`, body),
  remove: (id: string) => api.del(`/custom-fields/${id}`),
  values: (scope: CustomFieldScope, id: string) =>
    api.get<ListResponse<CustomFieldValueEntry>>(`/${scope === 'device' ? 'devices' : scope === 'client' ? 'clients' : 'sites'}/${id}/custom-fields`),
  setValues: (scope: CustomFieldScope, id: string, values: CustomFieldValues) =>
    api.put<ListResponse<CustomFieldValueEntry>>(
      `/${scope === 'device' ? 'devices' : scope === 'client' ? 'clients' : 'sites'}/${id}/custom-fields`,
      { values },
    ),
}

export const groupsApi = {
  list: (clientId?: string) => api.get<ListResponse<DeviceGroup>>('/groups', { query: { client_id: clientId } }),
  create: (body: GroupInput) => api.post<DeviceGroup>('/groups', body),
  update: (id: string, body: GroupInput) => api.put<DeviceGroup>(`/groups/${id}`, body),
  remove: (id: string) => api.del(`/groups/${id}`),
  members: (id: string) => api.get<ListResponse<Device>>(`/groups/${id}/members`),
  addMembers: (id: string, deviceIds: string[]) => api.post<void>(`/groups/${id}/members`, { device_ids: deviceIds }),
  /** DELETE with a JSON body, as the contract specifies. */
  removeMembers: (id: string, deviceIds: string[]) =>
    request<void>(`/groups/${id}/members`, { method: 'DELETE', body: { device_ids: deviceIds } }),
  preview: (rules: RuleDocument, clientId?: string | null) =>
    api.post<GroupPreview>('/groups/preview', { rules, client_id: clientId ?? undefined }),
  forDevice: (deviceId: string) => api.get<ListResponse<DeviceGroup>>(`/devices/${deviceId}/groups`),
}

export const policiesApi = {
  list: () => api.get<ListResponse<Policy>>('/policies'),
  get: (id: string) => api.get<Policy>(`/policies/${id}`),
  create: (body: PolicyInput) => api.post<Policy>('/policies', body),
  update: (id: string, body: PolicyInput) => api.put<Policy>(`/policies/${id}`, body),
  remove: (id: string) => api.del(`/policies/${id}`),
  assign: (id: string, body: PolicyAssignmentInput) => api.post<PolicyAssignment>(`/policies/${id}/assignments`, body),
  unassign: (assignmentId: string) => api.del(`/policy-assignments/${assignmentId}`),
  effective: (deviceId: string) => api.get<EffectivePolicy>(`/devices/${deviceId}/effective-policy`),
}

// ---------------------------------------------------------------- monitoring & alerts (Phase 6)

export const alertsApi = {
  list: (filters: AlertFilters = {}, cursor?: string | null) =>
    api.get<AlertListResponse>('/alerts', { query: { ...filters, cursor: cursor ?? undefined } }),
  summary: () => api.get<AlertsSummary>('/alerts/summary'),
  get: (id: string) => api.get<AlertDetail>(`/alerts/${id}`),
  acknowledge: (id: string, note?: string) =>
    api.post<AlertActionResponse>(`/alerts/${id}/acknowledge`, note ? { note } : {}),
  unacknowledge: (id: string) => api.post<AlertActionResponse>(`/alerts/${id}/unacknowledge`),
  resolve: (id: string, note?: string) => api.post<AlertActionResponse>(`/alerts/${id}/resolve`, note ? { note } : {}),
  snooze: (id: string, body: { minutes: number } | { until: string }) =>
    api.post<AlertActionResponse>(`/alerts/${id}/snooze`, body),
  assign: (id: string, userId: string | null) =>
    api.post<AlertActionResponse>(`/alerts/${id}/assign`, { user_id: userId }),
  addNote: (id: string, text: string) => api.post<AlertActionResponse>(`/alerts/${id}/notes`, { text }),
  bulk: (body: AlertBulkRequest) => api.post<AlertBulkResponse>('/alerts/bulk', body),
  forDevice: (deviceId: string, status?: string) =>
    api.get<AlertListResponse>(`/devices/${deviceId}/alerts`, { query: { status } }),
}

export const monitoringApi = {
  checkTypes: () => api.get<ListResponse<CheckTypeDefinition>>('/monitoring/check-types'),
  deviceChecks: (deviceId: string) => api.get<ListResponse<DeviceCheck>>(`/devices/${deviceId}/checks`),
  deviceMaintenance: (deviceId: string) => api.get<DeviceMaintenance>(`/devices/${deviceId}/maintenance`),
  settings: () => api.get<MonitoringSettings>('/settings/monitoring'),
  updateSettings: (body: MonitoringSettings) => api.put<MonitoringSettings>('/settings/monitoring', body),
}

export const maintenanceApi = {
  list: () => api.get<ListResponse<MaintenanceWindow>>('/maintenance-windows'),
  create: (body: MaintenanceWindowInput) => api.post<MaintenanceWindow>('/maintenance-windows', body),
  update: (id: string, body: MaintenanceWindowInput) => api.put<MaintenanceWindow>(`/maintenance-windows/${id}`, body),
  remove: (id: string) => api.del(`/maintenance-windows/${id}`),
}

export const notificationsApi = {
  channels: () => api.get<ListResponse<NotificationChannel>>('/notification-channels'),
  createChannel: (body: NotificationChannelInput) => api.post<NotificationChannel>('/notification-channels', body),
  updateChannel: (id: string, body: NotificationChannelInput) =>
    api.put<NotificationChannel>(`/notification-channels/${id}`, body),
  removeChannel: (id: string) => api.del(`/notification-channels/${id}`),
  testChannel: (id: string) => api.post<ChannelTestResult>(`/notification-channels/${id}/test`),
  rules: () => api.get<ListResponse<NotificationRule>>('/notification-rules'),
  createRule: (body: NotificationRuleInput) => api.post<NotificationRule>('/notification-rules', body),
  updateRule: (id: string, body: NotificationRuleInput) => api.put<NotificationRule>(`/notification-rules/${id}`, body),
  removeRule: (id: string) => api.del(`/notification-rules/${id}`),
  log: (filters: NotificationLogFilters = {}) =>
    api.get<ListResponse<NotificationLogEntry>>('/notification-log', { query: { ...filters } }),
  smtp: () => api.get<SmtpSettings>('/settings/smtp'),
  updateSmtp: (body: SmtpSettingsInput) => api.put<SmtpSettings>('/settings/smtp', body),
  testSmtp: (to: string) => api.post<SmtpTestResult>('/settings/smtp/test', { to }),
}

export interface NotificationLogFilters {
  alert_id?: string
  channel_id?: string
  limit?: number
}

// ---------------------------------------------------------------- patching (Phase 7)

export const patchesApi = {
  list: (filters: PatchFilters = {}, cursor?: string | null) =>
    api.get<PagedResponse<Patch>>('/patches', { query: { ...filters, cursor: cursor ?? undefined } }),
  get: (id: string) => api.get<PatchDetail>(`/patches/${id}`),
  decide: (body: PatchApproveRequest) => api.post<{ updated: number }>('/patches/approve', body),
  rules: () => api.get<ListResponse<PatchApprovalRuleRow>>('/patch-approval-rules'),
  forDevice: (deviceId: string, state?: DevicePatchState) =>
    api.get<DevicePatches>(`/devices/${deviceId}/patches`, { query: { state } }),
  scan: (deviceId: string) => api.post<{ cmd_id: string }>(`/devices/${deviceId}/patches/scan`),
  install: (deviceId: string, body: PatchInstallRequest) =>
    api.post<PatchInstallResponse>(`/devices/${deviceId}/patches/install`, body),
  runs: (limit = 100) => api.get<ListResponse<PatchRun>>('/patch-runs', { query: { limit } }),
  run: (id: string) => api.get<PatchRunDetail>(`/patch-runs/${id}`),
  /** `client_id`/`site_id` narrow the devices before grouping; an unknown client answers 404. */
  compliance: (groupBy: ComplianceGroupBy, scope: { client_id?: string; site_id?: string } = {}) =>
    api.get<ComplianceReport>('/patching/compliance', { query: { group_by: groupBy, ...scope } }),
  /** Opens a manual window run of a policy now (`patches.approve` + step-up); `409 no_devices` when none uses it. */
  runPolicyNow: (policyId: string, body: PolicyRunNowRequest) =>
    api.post<PolicyRunNowResponse>(`/patching/policies/${policyId}/run-now`, body),
}

export interface PolicyRunNowRequest {
  duration_minutes?: number
  client_id?: string
  site_id?: string
}

export interface PolicyRunNowResponse {
  run_id: string
  devices: number
  online: number
  window_end: string
}

// ---------------------------------------------------------------- software (Phase 7)

export const softwareApi = {
  list: (filters: SoftwareFilters = {}, cursor?: string | null) =>
    api.get<PagedResponse<SoftwareProductSummary>>('/software', { query: { ...filters, cursor: cursor ?? undefined } }),
  product: (name: string, publisher: string | null) =>
    api.get<SoftwareProduct>('/software/product', { query: { name, publisher: publisher ?? '' } }),
  packages: () => api.get<ListResponse<SoftwarePackage>>('/software/packages'),
  package: (id: string) => api.get<SoftwarePackage>(`/software/packages/${id}`),
  createPackage: (body: SoftwarePackageInput) => api.post<SoftwarePackage>('/software/packages', body),
  updatePackage: (id: string, body: SoftwarePackageInput) => api.put<SoftwarePackage>(`/software/packages/${id}`, body),
  removePackage: (id: string) => api.del(`/software/packages/${id}`),
  /**
   * Streams a file to the content-addressed store. The name travels percent-encoded in `X-File-Name`
   * (header values must be ASCII); the browser sets `Content-Length`.
   */
  upload: (file: File, options: Pick<UploadOptions, 'onProgress' | 'signal'> = {}) =>
    uploadWithProgress<SoftwareFileUpload>('/software/files', file, {
      ...options,
      headers: { 'X-File-Name': encodeURIComponent(file.name) },
    }),
  deploy: (body: DeploymentCreate) => api.post<DeploymentSummary>('/software/deployments', body),
  deployments: (limit = 100) => api.get<ListResponse<DeploymentSummary>>('/software/deployments', { query: { limit } }),
  deployment: (id: string) => api.get<DeploymentDetail>(`/software/deployments/${id}`),
  cancelDeployment: (id: string) => api.post<DeploymentDetail>(`/software/deployments/${id}/cancel`),
  forDevice: (deviceId: string) => api.get<ListResponse<DeviceDeployment>>(`/devices/${deviceId}/software-deployments`),
}

// ---------------------------------------------------------------- tickets & helpdesk (Phase 9)

export interface CommentUpload {
  body: string
  visibility: CommentVisibility
  files: File[]
}

export const ticketsApi = {
  list: (filters: TicketFilters = {}, cursor?: string | null) =>
    api.get<TicketListResponse>('/tickets', { query: { ...filters, cursor: cursor ?? undefined } }),
  get: (id: string) => api.get<TicketDetail>(`/tickets/${id}`),
  create: (body: TicketCreate) => api.post<Ticket>('/tickets', body),
  update: (id: string, body: TicketPatch) => api.patch<Ticket>(`/tickets/${id}`, body),
  remove: (id: string) => api.del(`/tickets/${id}`),
  /** JSON without files; multipart (with upload progress) when files are attached. */
  comment: (id: string, input: CommentUpload, options: Pick<UploadOptions, 'onProgress' | 'signal'> = {}) => {
    if (input.files.length === 0) {
      return api.post<TicketComment>(`/tickets/${id}/comments`, { body: input.body, visibility: input.visibility })
    }
    const form = new FormData()
    form.append('body', input.body)
    form.append('visibility', input.visibility)
    for (const file of input.files) form.append('files', file, file.name)
    return uploadWithProgress<TicketComment>(`/tickets/${id}/comments`, form, options)
  },
  editComment: (id: string, commentId: string, body: string) =>
    api.patch<TicketComment>(`/tickets/${id}/comments/${commentId}`, { body }),
  merge: (id: string, intoTicketId: string) =>
    api.post<{ ticket: Ticket }>(`/tickets/${id}/merge`, { into_ticket_id: intoTicketId }),
  link: (id: string, links: TicketLinks) => api.post<Ticket>(`/tickets/${id}/links`, links),
  /** DELETE with a JSON body, as the contract specifies. */
  unlink: (id: string, links: TicketLinks) => request<Ticket>(`/tickets/${id}/links`, { method: 'DELETE', body: links }),
  bulk: (body: TicketBulkRequest) => api.post<TicketBulkResponse>('/tickets/bulk', body),
  forDevice: (deviceId: string, status?: string) =>
    api.get<TicketListResponse>(`/devices/${deviceId}/tickets`, { query: { status } }),
  stats: (query: { client_id?: string; from?: string; to?: string } = {}) =>
    api.get<TicketStats>('/tickets/stats', { query }),
  attachmentUrl: (id: string) => buildUrl(`/tickets/attachments/${id}`),
  /** Fetches an attachment through `fetch` (used in mock mode, where the service worker cannot serve navigations). */
  downloadAttachment: (id: string, fileName: string) => download(`/tickets/attachments/${id}`, fileName),
  attachmentBlob: (id: string, signal?: AbortSignal) => requestBlob(`/tickets/attachments/${id}`, { signal }),
  time: (id: string, body: TimeEntryInput) => api.post<TimeEntry>(`/tickets/${id}/time`, body),
}

export const ticketQueuesApi = {
  list: () => api.get<ListResponse<TicketQueue>>('/ticket-queues'),
  get: (id: string) => api.get<TicketQueue>(`/ticket-queues/${id}`),
  create: (body: TicketQueueInput) => api.post<TicketQueue>('/ticket-queues', body),
  update: (id: string, body: TicketQueueInput) => api.put<TicketQueue>(`/ticket-queues/${id}`, body),
  remove: (id: string) => api.del(`/ticket-queues/${id}`),
}

export const slaPoliciesApi = {
  list: () => api.get<ListResponse<SlaPolicy>>('/sla-policies'),
  get: (id: string) => api.get<SlaPolicy>(`/sla-policies/${id}`),
  create: (body: SlaPolicyInput) => api.post<SlaPolicy>('/sla-policies', body),
  update: (id: string, body: SlaPolicyInput) => api.put<SlaPolicy>(`/sla-policies/${id}`, body),
  remove: (id: string) => api.del(`/sla-policies/${id}`),
}

export const cannedResponsesApi = {
  list: () => api.get<ListResponse<CannedResponse>>('/canned-responses'),
  create: (body: CannedResponseInput) => api.post<CannedResponse>('/canned-responses', body),
  update: (id: string, body: CannedResponseInput) => api.put<CannedResponse>(`/canned-responses/${id}`, body),
  remove: (id: string) => api.del(`/canned-responses/${id}`),
  render: (id: string, ticketId: string) => api.post<CannedRender>(`/canned-responses/${id}/render`, { ticket_id: ticketId }),
}

export const contactsApi = {
  list: (query: { client_id?: string; q?: string; limit?: number } = {}) =>
    api.get<ListResponse<Contact>>('/contacts', { query }),
  get: (id: string) => api.get<Contact>(`/contacts/${id}`),
  create: (body: ContactInput) => api.post<Contact>('/contacts', body),
  update: (id: string, body: ContactInput) => api.put<Contact>(`/contacts/${id}`, body),
  remove: (id: string) => api.del(`/contacts/${id}`),
  /** Multipart upload with a `file` field; `client_id` travels as a field and in the query. */
  import: (clientId: string, file: File) => {
    const form = new FormData()
    form.append('client_id', clientId)
    form.append('file', file, file.name)
    return uploadWithProgress<ContactImportResult>('/contacts/import', form, { query: { client_id: clientId } })
  },
}

export const timeEntriesApi = {
  list: (filters: TimeEntryFilters = {}) => api.get<TimeEntryListResponse>('/time-entries', { query: { ...filters } }),
  update: (id: string, body: TimeEntryInput) => api.put<TimeEntry>(`/time-entries/${id}`, body),
  remove: (id: string) => api.del(`/time-entries/${id}`),
  exportCsv: (filters: TimeEntryFilters = {}) =>
    download('/time-entries', 'rustrmm-time-entries.csv', { ...filters, format: 'csv' }),
}

export const ticketEmailApi = {
  get: () => api.get<TicketEmailSettings>('/settings/ticket-email'),
  /** Needs a recent step-up (handled by the client). */
  update: (body: TicketEmailSettingsInput) => api.put<TicketEmailSettings>('/settings/ticket-email', body),
  testImap: (inbound?: TicketEmailSettingsInput['inbound']) =>
    api.post<ImapTestResult>('/settings/ticket-email/test-imap', inbound ? { inbound } : undefined),
}

export const alertTicketRulesApi = {
  list: () => api.get<ListResponse<AlertTicketRule>>('/alert-ticket-rules'),
  create: (body: AlertTicketRuleInput) => api.post<AlertTicketRule>('/alert-ticket-rules', body),
  update: (id: string, body: AlertTicketRuleInput) => api.put<AlertTicketRule>(`/alert-ticket-rules/${id}`, body),
  remove: (id: string) => api.del(`/alert-ticket-rules/${id}`),
  /** The manual "Create ticket" action on an alert (`409 ticket_exists` carries `details.ticket_id`). */
  createFromAlert: (alertId: string, body: AlertTicketCreate = {}) => api.post<Ticket>(`/alerts/${alertId}/ticket`, body),
}

// ---------------------------------------------------------------- secrets escrow (Phase 10)

export const escrowApi = {
  /** Metadata only (`secrets.reveal` or `secrets.manage`); secrets never travel in list responses. */
  list: (filters: EscrowFilters = {}) =>
    api.get<ListResponse<EscrowItem>>('/escrow', {
      query: { ...filters, include_superseded: filters.include_superseded || undefined },
    }),
  forDevice: (deviceId: string, includeSuperseded = false) =>
    api.get<ListResponse<EscrowItem>>(`/devices/${deviceId}/escrow`, {
      query: { include_superseded: includeSuperseded || undefined },
    }),
  /**
   * Reveals one secret: needs `secrets.reveal`, a recent step-up (the client prompts on `step_up_required`) and a
   * reason of at least 10 characters. The server answers with `Cache-Control: no-store` and audits the reveal;
   * the request also bypasses the HTTP cache. Callers keep the result in component state only — never in
   * TanStack Query's cache, storage or logs — and drop it when the countdown ends.
   */
  reveal: (id: string, reason: string) =>
    api.post<EscrowReveal>(`/escrow/${id}/reveal`, { reason }, { cache: 'no-store' }),
  /** `secrets.manage` + step-up. The agent sets a new password and escrows it; the result never contains it. */
  rotateLaps: (deviceId: string) => api.post<CommandAccepted>(`/devices/${deviceId}/laps/rotate`),
  /** Asks the agent to re-collect BitLocker protectors (and FileVault status). */
  refresh: (deviceId: string) => api.post<Partial<CommandAccepted> | undefined>(`/devices/${deviceId}/escrow/refresh`),
  /** `secrets.manage` + step-up; audited. */
  remove: (id: string) => api.del(`/escrow/${id}`),
  stats: () => api.get<EscrowStats>('/escrow/stats'),
}

// ---------------------------------------------------------------- network discovery and SNMP (Phase 10)

export const probesApi = {
  list: () => api.get<ListResponse<SiteProbe>>('/network/probes'),
  get: (siteId: string) => api.get<SiteProbe>(`/sites/${siteId}/probe`),
  /** `{ device_id: null }` clears the probe. Only online agents can be probes. */
  set: (siteId: string, body: SiteProbeInput) => api.put<SiteProbe>(`/sites/${siteId}/probe`, body),
}

export const scansApi = {
  list: () => api.get<ListResponse<NetworkScan>>('/network/scans'),
  create: (body: NetworkScanInput) => api.post<NetworkScan>('/network/scans', body),
  update: (id: string, body: NetworkScanInput) => api.put<NetworkScan>(`/network/scans/${id}`, body),
  remove: (id: string) => api.del(`/network/scans/${id}`),
  run: (id: string) => api.post<{ run_id: string; cmd_id?: string }>(`/network/scans/${id}/run`),
}

export const assetsApi = {
  list: (filters: AssetFilters = {}) => api.get<ListResponse<NetworkAsset>>('/network/assets', { query: { ...filters } }),
  update: (id: string, body: AssetPatch) => api.patch<NetworkAsset>(`/network/assets/${id}`, body),
  /** Creates an SNMP device from the asset; templates default by the asset type. */
  monitor: (id: string, body: { credential_id: string; template_ids?: string[]; name?: string; port?: number; poll_interval_secs?: number }) =>
    api.post<SnmpDevice>(`/network/assets/${id}/monitor`, body),
}

export const snmpApi = {
  credentials: () => api.get<ListResponse<SnmpCredential>>('/network/snmp/credentials'),
  createCredential: (body: SnmpCredentialInput) => api.post<SnmpCredential>('/network/snmp/credentials', body),
  updateCredential: (id: string, body: SnmpCredentialInput) => api.put<SnmpCredential>(`/network/snmp/credentials/${id}`, body),
  removeCredential: (id: string) => api.del(`/network/snmp/credentials/${id}`),
  templates: () => api.get<ListResponse<SnmpTemplate>>('/network/snmp/templates'),
  createTemplate: (body: SnmpTemplateInput) => api.post<SnmpTemplate>('/network/snmp/templates', body),
  updateTemplate: (id: string, body: SnmpTemplateInput) => api.put<SnmpTemplate>(`/network/snmp/templates/${id}`, body),
  removeTemplate: (id: string) => api.del(`/network/snmp/templates/${id}`),
  devices: (siteId?: string) => api.get<ListResponse<SnmpDevice>>('/network/snmp/devices', { query: { site_id: siteId } }),
  createDevice: (body: SnmpDeviceInput) => api.post<SnmpDevice>('/network/snmp/devices', body),
  updateDevice: (id: string, body: SnmpDeviceInput) => api.put<SnmpDevice>(`/network/snmp/devices/${id}`, body),
  removeDevice: (id: string) => api.del(`/network/snmp/devices/${id}`),
  /** Polls once through the site's probe. */
  test: (id: string) => api.post<SnmpTestResult>(`/network/snmp/devices/${id}/test`),
  metrics: (id: string, range: MetricsRange) =>
    api.get<SnmpMetricsResponse>(`/network/snmp/devices/${id}/metrics`, { query: { range } }),
  traps: (query: { site_id?: string; limit?: number } = {}) => api.get<ListResponse<SnmpTrap>>('/network/snmp/traps', { query }),
  trapRules: () => api.get<ListResponse<TrapRule>>('/network/snmp/trap-rules'),
  createTrapRule: (body: TrapRuleInput) => api.post<TrapRule>('/network/snmp/trap-rules', body),
  updateTrapRule: (id: string, body: TrapRuleInput) => api.put<TrapRule>(`/network/snmp/trap-rules/${id}`, body),
  removeTrapRule: (id: string) => api.del(`/network/snmp/trap-rules/${id}`),
}

export const networkSettingsApi = {
  get: () => api.get<NetworkSettings>('/settings/network'),
  /** Global `network.manage` + step-up (handled by the client). */
  update: (body: NetworkSettings) => api.put<NetworkSettings>('/settings/network', body),
}

export const topologyApi = {
  /** Best effort: built from ARP and LLDP where available. */
  get: (siteId: string) => api.get<NetworkTopology>('/network/topology', { query: { site_id: siteId } }),
}

// ---------------------------------------------------------------- reports (Phase 11)

/** Reads `POST /reports/run`: JSON → the report, CSV/PDF → the file, `202` → a queued run to poll. */
async function runReport(body: ReportRunRequest): Promise<ReportRunOutcome> {
  const res = await requestResponse('/reports/run', { method: 'POST', body })
  if (res.status === 202) {
    const queued = (await res.json()) as { run_id: string }
    return { kind: 'queued', run_id: queued.run_id }
  }
  if (body.format === 'json') {
    const data = (await res.json()) as { report: Report; run_id: string }
    return { kind: 'report', run_id: data.run_id, report: data.report }
  }
  const blob = await res.blob()
  return {
    kind: 'file',
    run_id: res.headers.get('x-report-run-id'),
    blob,
    file_name: dispositionFileName(res.headers.get('content-disposition')) ?? `${body.type.replace(/_/g, '-')}.${body.format}`,
  }
}

export const reportsApi = {
  types: () => api.get<ListResponse<ReportTypeInfo>>('/reports/types'),
  run: runReport,
  runs: (query: { limit?: number; schedule_id?: string } = {}) => api.get<ListResponse<ReportRun>>('/report-runs', { query }),
  getRun: (id: string) => api.get<ReportRun>(`/report-runs/${id}`),
  /** A finished CSV/PDF run's file (`409 not_ready` while queued or running, `404` once expired). */
  downloadRun: async (id: string, fallbackName: string): Promise<{ blob: Blob; file_name: string }> => {
    const res = await requestResponse(`/report-runs/${id}/download`)
    return { blob: await res.blob(), file_name: dispositionFileName(res.headers.get('content-disposition')) ?? fallbackName }
  },
  /** A finished JSON run's report (an async JSON run downloads as the report itself). */
  runReport: async (id: string): Promise<Report> => {
    const data = await api.get<Report | { report: Report }>(`/report-runs/${id}/download`)
    return 'report' in data ? data.report : data
  },
  schedules: () => api.get<ListResponse<ReportSchedule>>('/report-schedules'),
  schedule: (id: string) => api.get<ReportSchedule>(`/report-schedules/${id}`),
  createSchedule: (body: ReportScheduleInput) => api.post<ReportSchedule>('/report-schedules', body),
  updateSchedule: (id: string, body: ReportScheduleInput) => api.put<ReportSchedule>(`/report-schedules/${id}`, body),
  removeSchedule: (id: string) => api.del(`/report-schedules/${id}`),
  runScheduleNow: (id: string) => api.post<{ run_ids: string[] }>(`/report-schedules/${id}/run-now`),
}

// ---------------------------------------------------------------- dashboards (Phase 11)

/** Drops empty values so equal configs share a cache entry and the 4 KB limit is not wasted. */
export function compactWidgetConfig(config: WidgetConfig): WidgetConfig {
  const out: WidgetConfig = {}
  for (const [key, value] of Object.entries(config) as [keyof WidgetConfig, WidgetConfig[keyof WidgetConfig]][]) {
    if (value === null || value === undefined || value === '') continue
    ;(out as Record<string, unknown>)[key] = value
  }
  return out
}

export const dashboardsApi = {
  list: () => api.get<DashboardList>('/dashboards'),
  home: () => api.get<Dashboard>('/dashboards/default'),
  get: (id: string) => api.get<Dashboard>(`/dashboards/${id}`),
  create: (body: DashboardInput) => api.post<Dashboard>('/dashboards', body),
  update: (id: string, body: DashboardInput) => api.put<Dashboard>(`/dashboards/${id}`, body),
  remove: (id: string) => api.del(`/dashboards/${id}`),
  widget: <W extends WidgetName>(widget: W, config: WidgetConfig) => {
    const { title: _title, ...server } = compactWidgetConfig(config)
    return api.get<WidgetResponse<W>>(`/dashboards/widgets/${widget}`, {
      query: { config: Object.keys(server).length ? JSON.stringify(server) : undefined },
    })
  },
}

// ---------------------------------------------------------------- single sign-on (Phase 11)

export const ssoApi = {
  /** Reads need `settings.manage` installation-wide and step-up, like writes. */
  providers: () => api.get<ListResponse<SsoProvider>>('/settings/sso/providers'),
  provider: (id: string) => api.get<SsoProvider>(`/settings/sso/providers/${id}`),
  create: (body: SsoProviderInput) => api.post<SsoProvider>('/settings/sso/providers', body),
  update: (id: string, body: SsoProviderInput) => api.put<SsoProvider>(`/settings/sso/providers/${id}`, body),
  remove: (id: string) => api.del(`/settings/sso/providers/${id}`),
  settings: () => api.get<SsoSettings>('/settings/sso'),
  updateSettings: (body: SsoSettings) => api.put<SsoSettings>('/settings/sso', body),
  /** Public: the login page's provider buttons and whether password login is restricted. */
  loginProviders: () => api.get<AuthProviders>('/auth/providers', open),
  /** A top-level navigation (the server redirects to the identity provider). */
  startUrl: (providerId: string, returnTo?: string) => buildUrl(`/auth/oidc/${providerId}/start`, { return_to: returnTo }),
}

// ---------------------------------------------------------------- API tokens (Phase 11)

export const apiTokensApi = {
  /** Your active tokens; `all` lists everyone's (`api.manage` installation-wide). */
  list: (all = false) => api.get<ListResponse<ApiToken>>('/api-tokens', { query: { all: all ? 'true' : undefined } }),
  create: (body: ApiTokenCreate) => api.post<ApiTokenCreated>('/api-tokens', body),
  revoke: (id: string) => api.del(`/api-tokens/${id}`),
}

// ---------------------------------------------------------------- webhooks (Phase 11)

export const webhooksApi = {
  list: () => api.get<WebhookList>('/webhooks'),
  get: (id: string) => api.get<Webhook>(`/webhooks/${id}`),
  create: (body: WebhookInput) => api.post<Webhook>('/webhooks', body),
  update: (id: string, body: WebhookInput) => api.put<Webhook>(`/webhooks/${id}`, body),
  remove: (id: string) => api.del(`/webhooks/${id}`),
  deliveries: (id: string, query: { limit?: number; status?: string } = {}) =>
    api.get<ListResponse<WebhookDelivery>>(`/webhooks/${id}/deliveries`, { query }),
  test: (id: string) => api.post<WebhookDelivery>(`/webhooks/${id}/test`),
  redeliver: (deliveryId: string) => api.post<WebhookDelivery>(`/webhook-deliveries/${deliveryId}/redeliver`),
}

// ---------------------------------------------------------------- branding (Phase 11)

export const brandingApi = {
  /** Public: product name, accent and logo URLs for the login page and console chrome. */
  public: () => api.get<PublicBranding>('/branding', open),
  settings: () => api.get<BrandingSettings>('/settings/branding'),
  update: (body: BrandingSettings) => api.put<BrandingSettings>('/settings/branding', body),
  /** PNG (≤ 4096×4096) or SVG, at most 512 KB; SVGs are rebuilt from an allowlist. */
  upload: (file: File, options: Pick<UploadOptions, 'onProgress' | 'signal'> = {}) => {
    const form = new FormData()
    form.append('file', file, file.name)
    return uploadWithProgress<BrandingFile>('/files/branding', form, options)
  },
  fileUrl: (id: string) => buildUrl(`/branding/files/${id}`),
}

// ---------------------------------------------------------------- code signing (Phase 11)

export const signingApi = {
  status: () => api.get<SigningStatus>('/settings/signing-status'),
}
