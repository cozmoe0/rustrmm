/*
 * Hand-written types for the RustRMM v1 API contract (Phase 1).
 * They will be replaced by types generated from the server's OpenAPI document.
 * Field names are snake_case, timestamps RFC 3339 UTC strings, IDs UUID strings.
 */

import type { DesktopQuality } from '@/lib/desktop/control'

export type { DesktopQuality }

export type Uuid = string
export type Timestamp = string

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown }
}

export interface ListResponse<T> {
  items: T[]
}

export interface PagedResponse<T> {
  items: T[]
  next_cursor: string | null
}

// ---------------------------------------------------------------- setup

export interface SetupStatus {
  needs_setup: boolean
  product: string
  version: string
}

export interface SetupCompleteRequest {
  setup_token: string
  organization_name: string
  owner: { name: string; email: string; password: string }
  first_client: { name: string }
  first_site: { name: string; timezone: string }
}

export interface RecoveryKit {
  master_key: string
  backup_identity: string
  backup_recipient: string
  generated_at: Timestamp
}

export interface SetupCompleteResponse {
  recovery_kit: RecoveryKit
}

// ---------------------------------------------------------------- auth

export type MfaMethod = 'totp' | 'webauthn' | 'recovery_code'

export interface Me {
  user: {
    id: Uuid
    name: string
    email: string
    mfa: { totp: boolean; passkeys: number }
    created_at: Timestamp
  }
  csrf_token: string
  permissions: string[]
  scopes: { global: boolean; client_ids: Uuid[]; site_ids: Uuid[] }
  organization: { name: string }
  session: {
    id: Uuid
    expires_at: Timestamp
    idle_expires_at: Timestamp
    stepped_up_until: Timestamp | null
  }
}

export type LoginResponse =
  | { status: 'mfa_required'; challenge_token: string; methods: MfaMethod[] }
  | { status: 'mfa_setup_required'; challenge_token: string }
  | { status: 'ok'; me: Me }

export interface AuthOk {
  status: 'ok'
  me: Me
}

export interface TotpSetupStart {
  secret: string
  otpauth_url: string
  qr_svg: string
}

export interface TotpSetupFinish extends AuthOk {
  recovery_codes: string[]
}

/** webauthn-rs challenge JSON (`{ publicKey: {...} }` with base64url binary fields). */
export interface WebauthnOptions {
  options: { publicKey: Record<string, unknown>; mediation?: string }
}

export interface StepUpResponse {
  stepped_up_until: Timestamp
}

export interface SessionInfo {
  id: Uuid
  created_at: Timestamp
  last_seen_at: Timestamp
  ip: string | null
  user_agent: string | null
  current: boolean
}

export interface Passkey {
  id: Uuid
  name: string
  created_at: Timestamp
  last_used_at: Timestamp | null
}

// ---------------------------------------------------------------- tenancy

export interface Client {
  id: Uuid
  name: string
  slug: string
  notes: string
  accent_color: string | null
  /** The client's branding logo (`/api/v1/branding/files/{id}`), used on its report PDFs. */
  logo_url: string | null
  site_count: number
  device_count: number
  created_at: Timestamp
  updated_at: Timestamp
}

export interface Site {
  id: Uuid
  client_id: Uuid
  name: string
  timezone: string
  address: string
  notes: string
  device_count: number
  created_at: Timestamp
  updated_at: Timestamp
}

export type ClientDetail = Client & { sites: Site[] }

export interface ClientInput {
  name: string
  notes?: string
}

export interface ClientPatch {
  name?: string
  notes?: string
  accent_color?: string | null
}

export interface SiteInput {
  name: string
  timezone?: string
  address?: string
  notes?: string
}

// ---------------------------------------------------------------- users & roles

export type ScopeType = 'global' | 'client' | 'site'

export interface Assignment {
  id: Uuid
  role_id: Uuid
  role_name: string
  scope: { type: ScopeType; id: Uuid | null; name: string | null }
}

export interface AssignmentInput {
  role_id: Uuid
  scope_type: ScopeType
  scope_id: Uuid | null
}

export type UserStatus = 'active' | 'disabled'

export interface User {
  id: Uuid
  name: string
  email: string
  status: UserStatus
  mfa_enabled: boolean
  last_login_at: Timestamp | null
  created_at: Timestamp
  assignments: Assignment[]
}

export interface UserCreate {
  name: string
  email: string
  password: string
  assignments: AssignmentInput[]
}

export interface UserPatch {
  name?: string
  status?: UserStatus
  assignments?: AssignmentInput[]
}

export interface Role {
  id: Uuid
  name: string
  description: string
  builtin: boolean
  permissions: string[]
  user_count: number
}

export interface RoleInput {
  name: string
  description: string
  permissions: string[]
}

export type Risk = 'low' | 'medium' | 'high'

export interface Permission {
  key: string
  group: string
  label: string
  description: string
  risk: Risk
}

// ---------------------------------------------------------------- audit

export type ActorType = 'user' | 'system' | 'agent' | 'api_token'

export interface AuditEvent {
  id: number
  at: Timestamp
  actor: { type: ActorType; id: string | null; name: string | null }
  action: string
  target: { type: string; id: string | null; name: string | null } | null
  client_id: Uuid | null
  site_id: Uuid | null
  ip: string | null
  user_agent: string | null
  details: Record<string, unknown>
  hash: string
}

export interface AuditFilters {
  action?: string
  actor_id?: string
  client_id?: string
  from?: string
  to?: string
  q?: string
}

export interface AuditVerifyResult {
  ok: boolean
  checked: number
  broken_at: number | null
}

// ---------------------------------------------------------------- backups

export interface BackupRetention {
  hourly: number
  daily: number
  weekly: number
  monthly: number
}

export interface BackupSettings {
  enabled: boolean
  schedule_cron: string
  retention: BackupRetention
  include_files: boolean
  recipient: string
  destinations: {
    local: { enabled: boolean; path: string }
    s3: {
      enabled: boolean
      endpoint: string
      region: string
      bucket: string
      prefix: string
      access_key_id: string
      has_secret: boolean
      object_lock_days: number | null
    }
  }
}

/** PUT body: `has_secret` is ignored by the server; `secret_access_key` is write-only. */
export type BackupSettingsUpdate = Omit<BackupSettings, 'destinations'> & {
  destinations: {
    local: BackupSettings['destinations']['local']
    s3: BackupSettings['destinations']['s3'] & { secret_access_key?: string }
  }
}

export type BackupStatus = 'running' | 'ok' | 'failed'
export type BackupTrigger = 'schedule' | 'manual' | 'pre_migration'

export interface BackupDestinationResult {
  kind: 'local' | 's3'
  status: 'ok' | 'failed' | 'skipped'
  location: string | null
  error: string | null
}

export interface Backup {
  id: Uuid
  started_at: Timestamp
  finished_at: Timestamp | null
  status: BackupStatus
  trigger: BackupTrigger
  size_bytes: number | null
  sha256: string | null
  destinations: BackupDestinationResult[]
  error: string | null
}

export interface TestS3Result {
  ok: boolean
  error: string | null
}

// ---------------------------------------------------------------- system & live

export interface SystemHealth {
  status: string
  version: string
  uptime_s: number
  db: { size_bytes: number; wal_bytes: number }
  agents_connected: number
  tls_mode: string
}

export interface FleetSummary {
  devices_total: number
  online: number
  offline: number
  /** Devices waiting for an administrator to approve their enrollment (Phase 2). */
  pending_approval?: number
  critical_alerts: number
  warning_alerts: number
  patch_compliance_pct: number | null
  open_tickets: number
  /** Mean health score of managed devices, or null when none report one yet. */
  average_health?: number | null
  /** Open alert counts (Phase 6). Older servers only send `critical_alerts` / `warning_alerts`. */
  alerts?: { critical: number; warning: number }
}

export interface StreamTicket {
  ticket: string
  expires_at: Timestamp
}

export interface StreamEvent<T = unknown> {
  type: 'event'
  topic: string
  data: T
}

// ---------------------------------------------------------------- devices (Phase 2)

export type OsFamily = 'windows' | 'macos' | 'linux'
export type DeviceStatus = 'pending' | 'active' | 'quarantined' | 'revoked'
export type DeviceType = 'workstation' | 'laptop' | 'server' | 'virtual'

export interface Device {
  id: Uuid
  hostname: string
  display_name: string | null
  status: DeviceStatus
  online: boolean
  os_family: OsFamily
  os_name: string
  os_version: string
  arch: string
  device_type: DeviceType | null
  manufacturer: string | null
  model: string | null
  serial: string | null
  domain: string | null
  client_id: Uuid
  client_name: string
  site_id: Uuid
  site_name: string
  last_seen_at: Timestamp | null
  last_user: string | null
  last_ip: string | null
  cpu_pct: number | null
  mem_pct: number | null
  disk_pct: number | null
  uptime_s: number | null
  health_score: number | null
  agent_version: string
  enrolled_at: Timestamp
  tags: string[]
  replaces_device_id: Uuid | null
  /** Device-scope custom field values keyed by field key (Phase 5). */
  custom_fields?: Record<string, CustomFieldValue>
}

export interface HealthReason {
  label: string
  penalty: number
}

export interface DeviceDetail extends Device {
  health: { score: number; reasons: HealthReason[] }
  notes: string
  connected: boolean
}

export interface DevicePatch {
  display_name?: string | null
  notes?: string
  tags?: string[]
  site_id?: Uuid
}

export interface DeviceListFilters {
  client_id?: string
  site_id?: string
  /** Omit for managed devices; `pending` lists approvals; `all` returns everything. */
  status?: DeviceStatus | 'all'
  os?: OsFamily
  online?: boolean
  q?: string
  /** Devices that belong to a device group (Phase 5). */
  group_id?: string
  /** Server-side patch state filter (needs `patches.view`). */
  patch_state?: DevicePatchStateFilter
}

/** `GET /devices?patch_state=`: `not_scanned` lists devices without a successful scan yet. */
export type DevicePatchStateFilter = 'compliant' | 'non_compliant' | 'pending_reboot' | 'failed' | 'missing_critical' | 'not_scanned'

export type InventorySectionName =
  | 'system'
  | 'hardware'
  | 'storage'
  | 'network'
  | 'software'
  | 'security'
  | 'users'
  | 'services'
  | 'updates'

export interface InventoryEnvelope<T> {
  data: T
  collected_at: Timestamp
}

/** Inventory documents are open-ended JSON; these shapes cover the fields the console renders. */
export interface SystemInventory {
  hostname?: string
  os?: {
    family?: OsFamily
    name?: string
    version?: string
    build?: string | null
    display_version?: string | null
    edition?: string | null
    kernel?: string
    install_date?: string | null
    distribution?: string
    id?: string | null
  }
  arch?: string
  boot_time?: string | null
  last_boot?: string | null
  utc_offset_minutes?: number
  agent_version?: string
  device_type?: DeviceType | null
  domain?: string | null
  workgroup?: string | null
  entra_joined?: boolean
  domain_controller?: boolean
  virtualization?: string | null
  pending_reboot?: boolean
  pending_reboot_reasons?: string[]
}

export interface HardwareInventory {
  manufacturer?: string | null
  model?: string | null
  family?: string | null
  model_identifier?: string | null
  chip?: string | null
  serial?: string | null
  uuid?: string | null
  bios?: { vendor?: string | null; version?: string | null; date?: string | null }
  baseboard?: { manufacturer?: string | null; product?: string | null }
  cpu?: { model?: string; vendor?: string; cores?: number | null; threads?: number | null; mhz?: number | null }
  memory?: {
    total_bytes?: number
    modules?: {
      slot?: string | null
      size_bytes?: number | null
      speed_mhz?: number | null
      manufacturer?: string | null
      part_number?: string | null
    }[]
  }
  gpus?: { name?: string | null; driver?: string | null; memory_bytes?: number | null; cores?: number | string | null }[]
  monitors?: { manufacturer?: string | null; model?: string | null; serial?: string | null; year?: number | null }[]
  batteries?: {
    name?: string | null
    charge_pct?: number | string | null
    status?: number | string | null
    design_capacity?: number | string | null
    full_charge_capacity?: number | string | null
    cycles?: number | string | null
    condition?: string | null
  }[]
  secure_boot?: boolean | null
  tpm?: { present?: boolean; enabled?: boolean | null; activated?: boolean | null; spec_version?: string | null } | null
  printers?: {
    name?: string | null
    driver?: string | null
    port?: string | null
    default?: boolean | null
    network?: boolean | null
  }[]
}

export interface StorageInventory {
  volumes?: {
    mount?: string
    name?: string
    filesystem?: string
    total_bytes?: number
    free_bytes?: number
    kind?: string
    removable?: boolean
    read_only?: boolean
  }[]
  disks?: {
    index?: number | null
    name?: string | null
    model?: string | null
    serial?: string | null
    size_bytes?: number | null
    media?: string | null
    bus?: string | null
    health?: string | null
  }[]
  physical_disks?: { name?: string | null; media?: string | null; health?: string | null; size_bytes?: number | null }[]
  bitlocker?: { drive?: string | null; protected?: boolean; os_volume?: boolean; conversion_status?: number | null }[]
  system_volume_encrypted?: boolean | null
}

export interface NetworkInventory {
  interfaces?: {
    name?: string
    mac?: string
    ipv4?: string[]
    ipv6?: string[]
    mtu?: number | null
    speed_mbps?: number | null
  }[]
  adapters?: {
    name?: string | null
    description?: string | null
    mac?: string | null
    addresses?: string[] | null
    subnets?: string[] | null
    gateways?: string[] | null
    dns_servers?: string[] | null
    dhcp?: boolean | null
    dhcp_server?: string | null
    dns_domain?: string | null
    speed_mbps?: number | null
  }[]
  wifi?: { ssid?: string | null; signal?: string | null; radio?: string | null } | null
  gateways?: string[]
  dns_servers?: string[]
}

export interface SoftwareItem {
  name: string
  version?: string
  publisher?: string | null
  install_date?: string | null
  size_bytes?: number | null
  source?: string
}

export interface SoftwareInventory {
  items?: SoftwareItem[]
}

export interface SecurityInventory {
  antivirus?: { name?: string | null; enabled?: boolean; up_to_date?: boolean | null; source?: string }[]
  defender?: {
    real_time_protection?: boolean | null
    signature_age_days?: number | null
    signatures_updated?: string | null
    last_quick_scan?: string | null
    last_full_scan?: string | null
    tamper_protection?: boolean | null
  }
  firewall?: { enabled?: boolean | null; profiles?: { name?: string | null; enabled?: boolean }[] }
  encryption?: {
    method?: 'bitlocker' | 'luks' | 'filevault'
    system_volume_encrypted?: boolean | null
    volumes?: { drive?: string | null; protected?: boolean }[]
  }
  uac_enabled?: boolean | null
  rdp_enabled?: boolean | null
  smb1_enabled?: boolean | null
  autologon_enabled?: boolean | null
  secure_boot?: boolean | null
  selinux?: string | null
  apparmor?: boolean | null
  ssh_root_login?: boolean | null
  gatekeeper?: boolean | null
  sip?: boolean | null
  local_admins?: string[]
}

export interface UsersInventory {
  local?: {
    name?: string | null
    full_name?: string | null
    enabled?: boolean | null
    admin?: boolean
    locked?: boolean | null
    builtin_administrator?: boolean
    uid?: number
  }[]
  last_user?: string | null
  sessions?: { user?: string | null; kind?: string | null; from?: string | null }[]
  profiles?: { path?: string | null; last_used?: string | null }[]
}

export interface ServiceItem {
  name: string
  display_name?: string | null
  state?: string | null
  start_mode?: string | null
  account?: string | null
  active?: string | null
}

export interface ServicesInventory {
  items?: ServiceItem[]
}

export interface UpdatesInventory {
  installed?: { id?: string | null; description?: string | null; installed_on?: string | null }[]
  pending?: { label?: string }[]
  pending_reboot?: boolean
  wsus_server?: string | null
  package_manager?: string | null
}

export interface InventorySections {
  system?: InventoryEnvelope<SystemInventory>
  hardware?: InventoryEnvelope<HardwareInventory>
  storage?: InventoryEnvelope<StorageInventory>
  network?: InventoryEnvelope<NetworkInventory>
  software?: InventoryEnvelope<SoftwareInventory>
  security?: InventoryEnvelope<SecurityInventory>
  users?: InventoryEnvelope<UsersInventory>
  services?: InventoryEnvelope<ServicesInventory>
  updates?: InventoryEnvelope<UpdatesInventory>
}

export interface InventoryResponse {
  sections: InventorySections
}

export type MetricsRange = '1h' | '24h' | '7d' | '30d'

export interface MetricPoint {
  /** Unix seconds. */
  ts: number
  cpu: number | null
  mem: number | null
  disk: number | null
  /** Bits per second. */
  net_rx: number | null
  net_tx: number | null
}

export interface MetricsResponse {
  range: MetricsRange
  resolution: 'raw' | '15m' | '1h'
  points: MetricPoint[]
}

export interface LiveSample {
  ts: number
  cpu: number
  mem: number
  disk: number
  net_rx_bps: number
  net_tx_bps: number
  disk_read_bps: number
  disk_write_bps: number
}

export interface DeviceMetricsEvent {
  device_id: Uuid
  live: boolean
  sample: LiveSample
}

export interface DevicesChangedEvent {
  id: Uuid
  online?: boolean
  deleted?: boolean
  enrolled?: boolean
  status?: DeviceStatus
}

export type TimelineSeverity = 'info' | 'notice' | 'warning' | 'critical'

export interface TimelineEntry {
  id: number
  at: Timestamp
  kind: string
  severity: TimelineSeverity
  summary: string
  details: Record<string, unknown> | null
}

export interface TimelinePage {
  items: TimelineEntry[]
  next_cursor: number | null
}

// ---------------------------------------------------------------- deployment (Phase 2)

export type TokenStatus = 'active' | 'revoked' | 'expired' | 'exhausted'

export interface EnrollmentToken {
  id: Uuid
  site_id: Uuid
  site_name: string
  client_id: Uuid
  client_name: string
  name: string
  expires_at: Timestamp | null
  max_uses: number | null
  uses: number
  require_approval: boolean
  allowed_domains: string[]
  allowed_cidrs: string[]
  status: TokenStatus
  created_at: Timestamp
  last_used_at: Timestamp | null
}

export interface AgentArtifact {
  platform: string
  file: string
  label: string
  size_bytes: number
  sha256: string
}

export interface EnrollmentTokenList {
  items: EnrollmentToken[]
  artifacts: AgentArtifact[]
}

// ---------------------------------------------------------------- agent updates

/** Where a device stands against the latest agent release. */
export type AgentUpdateState = 'current' | 'outdated' | 'queued' | 'updating' | 'failed' | 'unsupported' | 'unknown'

/** `GET /devices/{id}/agent-update` (also the status part of each overview row). */
export interface DeviceAgentUpdate {
  state: AgentUpdateState
  latest_version: string | null
  /** The release of the open or last attempt. */
  target_version: string | null
  last_error: string | null
  attempt_at: Timestamp | null
  attempt_kind: 'manual' | 'auto' | null
  auto_update: boolean
  /** Policy that set `agent_updates.auto_update`; null when the default (on) applies. */
  auto_update_policy: string | null
}

export interface AgentUpdateDevice extends DeviceAgentUpdate {
  id: Uuid
  hostname: string
  display_name: string | null
  os_family: OsFamily
  os_name: string
  arch: string
  agent_version: string
  online: boolean
  last_seen_at: Timestamp | null
  site_id: Uuid
  site_name: string
  client_id: Uuid
  client_name: string
}

export interface AgentUpdatesSummary {
  total: number
  current: number
  outdated: number
  queued: number
  updating: number
  failed: number
  unsupported: number
  /** Devices whose policy allows automatic updates. */
  auto_update: number
}

export interface AgentLatestRelease {
  id: Uuid
  version: string
  imported_at: Timestamp
  platforms: string[]
}

/** `GET /agent-updates` */
export interface AgentUpdatesResponse {
  server_version: string
  latest: AgentLatestRelease | null
  summary: AgentUpdatesSummary
  items: AgentUpdateDevice[]
}

/** `POST /agent-updates/update` */
export interface AgentUpdateRequest {
  device_ids?: Uuid[]
  all_outdated?: boolean
  client_id?: Uuid
  site_id?: Uuid
}

export interface AgentUpdateResult {
  rollout_id: Uuid | null
  version: string
  targeted: number
}

export type RolloutStatus = 'active' | 'paused' | 'completed' | 'cancelled'
export type RolloutTargetStatus = 'pending' | 'sent' | 'succeeded' | 'failed' | 'skipped'

/** `GET /rollouts` */
export interface AgentRollout {
  id: Uuid
  version: string
  kind: 'manual' | 'auto'
  scope: { type: 'all' | 'client' | 'site' | 'devices'; id?: string; ids?: string[] } | null
  percent: number
  status: RolloutStatus
  created_by: string | null
  created_at: Timestamp
  updated_at: Timestamp
  counts: Partial<Record<RolloutTargetStatus, number>>
}

/** `GET /agent-releases` */
export interface AgentRelease {
  id: Uuid
  version: string
  imported_at: Timestamp
  /** Set when the release's files were removed to save space. */
  pruned_at: Timestamp | null
  files: { platform: string; file: string; size_bytes: number; sha256: string }[]
  devices: number
}

export interface AgentReleaseList {
  items: AgentRelease[]
  versions: { version: string; devices: number }[]
}

export interface EnrollmentTokenCreate {
  name: string
  expires_in_days?: number
  max_uses?: number
  require_approval: boolean
  allowed_domains: string[]
  allowed_cidrs: string[]
}

export interface EnrollmentTokenCreated {
  id: Uuid
  deploy_key: string
}

export type InstallerKind = 'powershell' | 'linux' | 'macos' | 'gpo' | 'deploy-key'

// ---------------------------------------------------------------- remote tools (Phase 4)

export interface RemoteProcess {
  pid: number
  parent: number | null
  name: string
  exe: string | null
  user: string | null
  /** Percentage of the whole machine, 0–100. */
  cpu: number
  /** Resident memory in bytes. */
  memory: number
  /** Unix seconds. */
  started_at: number | null
  status: string | null
}

export interface ProcessList {
  count: number
  items: RemoteProcess[]
}

/** Generic `{ ok, message, data }` envelope returned by agent actions. */
export interface AgentActionResult<T = Record<string, unknown>> {
  ok: boolean
  message?: string
  data?: T
}

export type KillResult = AgentActionResult<{ pid: number; name: string; terminated: number }>

/** Fields vary by platform: Windows (start_mode, account), Linux (active, load), macOS (last_exit). */
export interface RemoteService {
  name: string
  display_name?: string | null
  state: string
  start_mode?: string | null
  account?: string | null
  active?: string | null
  load?: string | null
  last_exit?: number | string | null
}

export type ServiceAction = 'start' | 'stop' | 'restart'

export type ServiceActionResult = AgentActionResult<{ name: string; action: ServiceAction; state: string }>

export interface EventLogQuery {
  log: string
  /** 0 = all; 1 = critical; 2 = error and above; 3 = warning and above; 4 = information and above. */
  level: number
  limit: number
  hours: number
}

export interface EventLogEntry {
  time: Timestamp
  level: number
  /** Event ID on Windows, null elsewhere. */
  id: number | null
  source: string | null
  message: string
}

export interface EventLogResponse {
  log: string
  hours: number
  items: EventLogEntry[]
}

export interface RegistryKey {
  name: string
  path: string
}

export interface RegistryValue {
  name: string
  type: string
  data: string
}

export interface RegistryListing {
  path: string
  keys: RegistryKey[]
  values: RegistryValue[]
}

export type PowerAction = 'reboot' | 'shutdown' | 'cancel' | 'lock' | 'logoff'

export interface PowerRequest {
  action: PowerAction
  delay_secs: number
  message: string
}

export interface MessageRequest {
  title: string
  body: string
  timeout_secs: number
}

export type DiagnosticKind = 'ping' | 'traceroute' | 'dns' | 'port'

export interface DiagnosticRequest {
  kind: DiagnosticKind
  target: string
  port?: number
}

export interface CommandDiagnostic {
  command: string
  exit_code: number | null
  timed_out: boolean
  duration_ms: number
  output: string
}

export interface DnsDiagnostic {
  resolved: boolean
  addresses: string[]
  duration_ms: number
  error?: string | null
}

export interface PortDiagnostic {
  open: boolean
  address?: string | null
  latency_ms?: number | null
  error?: string | null
}

export type DiagnosticResult = CommandDiagnostic | DnsDiagnostic | PortDiagnostic

export interface FileEntry {
  name: string
  path: string
  is_dir: boolean
  is_link: boolean
  size: number | null
  /** Unix milliseconds. */
  modified: number | null
  readonly: boolean
  hidden: boolean
  /** Set on Windows drive roots in the roots listing. */
  drive?: boolean
}

export interface FileListing {
  path: string
  parent: string | null
  separator: string
  truncated: boolean
  entries: FileEntry[]
}

export type FileOperation =
  | { op: 'mkdir'; path: string }
  | { op: 'rename'; from: string; to: string }
  | { op: 'delete'; path: string; recursive: boolean }

export interface UploadResult {
  ok: boolean
  bytes: number
  path: string
}

export interface ShellCreateRequest {
  /** Empty for the platform default. */
  shell: string
  cols: number
  rows: number
}

export interface ShellTicket {
  session_id: Uuid
  ticket: string
  expires_in: number
}

export type ShellServerMessage =
  | { type: 'status'; message: string }
  | { type: 'ready' }
  | { type: 'exit'; code: number | null }
  | { type: 'error'; message: string }
  | { type: 'closed'; reason: string }

export type RemoteSessionKind = 'shell' | 'download' | 'upload' | 'desktop'

export interface RemoteSession {
  id: Uuid
  device_id: Uuid
  hostname: string
  user_name: string | null
  kind: RemoteSessionKind
  detail: RemoteSessionDetail | null
  started_at: Timestamp
  connected_at: Timestamp | null
  ended_at: Timestamp | null
  end_reason: string | null
  bytes_to_device: number
  bytes_from_device: number
  has_recording: boolean
  recording_bytes: number | null
  live: boolean
}

/** Shell: `shell`, `cols`, `rows`; transfers: `path`; desktop (Phase 8): `session_id`, `view_only`, `quality`, `consent`. */
export interface RemoteSessionDetail {
  shell?: string
  cols?: number
  rows?: number
  path?: string
  session_id?: number | null
  view_only?: boolean
  quality?: DesktopQuality
  /** `null` until the outcome is known. */
  consent?: DesktopConsentOutcome | null
}

export interface RemoteSessionEvent {
  session_id: Uuid
  device_id: Uuid
  status: 'active' | 'ended'
  kind: RemoteSessionKind
}

// ---------------------------------------------------------------- remote desktop (Phase 8)

export type DesktopSessionKind = 'console' | 'rdp'
export type DesktopSessionState = 'active' | 'disconnected' | 'locked' | 'login_screen'
export type DesktopConsentOutcome = 'not_required' | 'granted' | 'denied' | 'timeout'

/** One interactive session on the device (`GET /devices/{id}/desktop/sessions`). */
export interface DesktopSession {
  /** Windows session id or Linux logind id; null when unknown. */
  session_id: number | null
  kind: DesktopSessionKind
  /** `CORP\alex`, or null on the sign-in screen. */
  user: string | null
  state: DesktopSessionState
  monitors: number | null
  /** Linux only. Wayland sessions are not supported yet. */
  type?: 'x11' | 'wayland'
}

export interface DesktopSessionList {
  items: DesktopSession[]
  /** macOS only: the TCC permissions remote desktop will need (null when unreadable). */
  tcc?: { screen_recording: boolean | null; accessibility: boolean | null }
}

export interface DesktopCreateRequest {
  session_id?: number
  view_only?: boolean
  quality?: DesktopQuality
}

export type DesktopTicket = ShellTicket

/** `details` of a `403 disabled_by_policy` refusal. */
export interface PolicyRefusalDetails {
  feature: string
  policy_id: Uuid
  policy_name: string
}

// ---------------------------------------------------------------- automation (Phase 5)

export type ScriptLanguage = 'powershell' | 'pwsh' | 'cmd' | 'bash' | 'sh' | 'zsh' | 'python'
export type ScriptRisk = 'normal' | 'high'
export type ParameterType = 'string' | 'number' | 'boolean' | 'select' | 'secret'
export type ParameterValue = string | number | boolean | null

export interface ScriptParameter {
  /** `[A-Za-z_][A-Za-z0-9_]{0,63}`, not a reserved environment name. */
  name: string
  label: string
  description: string
  type: ParameterType
  required: boolean
  default: ParameterValue
  /** Select parameters only. */
  options?: string[]
}

export interface ScriptVersionSummary {
  version: number
  notes: string
  content_sha256: string
  created_by_name: string
  created_at: Timestamp
  approved_by_name: string | null
  approved_at: Timestamp | null
}

export interface ScriptVersionDetail extends ScriptVersionSummary {
  content: string
  parameters: ScriptParameter[]
}

export interface ScriptLastRun {
  job_id: Uuid
  run_id: Uuid
  at: Timestamp
  succeeded: number
  failed: number
}

/** A Script without `content`, `parameters` and `versions`. */
export interface ScriptSummary {
  id: Uuid
  name: string
  description: string
  category: string
  language: ScriptLanguage
  platforms: OsFamily[]
  timeout_secs: number
  risk: ScriptRisk
  builtin: boolean
  current_version: number
  approved_version: number | null
  content_sha256: string
  created_by_name: string
  created_at: Timestamp
  updated_at: Timestamp
  last_run: ScriptLastRun | null
  /**
   * Not part of the contract's Script shape. Read when present so `include_archived=true` lists
   * can mark archived scripts; treated as false when missing.
   */
  archived?: boolean
}

export interface Script extends ScriptSummary {
  content: string
  parameters: ScriptParameter[]
  versions: ScriptVersionSummary[]
}

export interface ScriptInput {
  name: string
  description: string
  category: string
  language: ScriptLanguage
  platforms: OsFamily[]
  timeout_secs: number
  risk: ScriptRisk
  content: string
  parameters: ScriptParameter[]
  notes?: string
}

export interface ScriptFilters {
  search?: string
  category?: string
  language?: ScriptLanguage
  platform?: OsFamily
  include_archived?: boolean
}

export interface ScriptCategory {
  name: string
  count: number
}

export type VariableScope = 'global' | 'client' | 'site'

export interface Variable {
  id: Uuid
  scope: VariableScope
  scope_id: Uuid | null
  scope_name: string | null
  name: string
  /** Always null for secrets: they are write-only. */
  value: string | null
  secret: boolean
  description: string
  updated_at: Timestamp
  updated_by_name: string
}

export interface VariableInput {
  scope: VariableScope
  scope_id?: Uuid | null
  name: string
  /** Leave out on update to keep a secret unchanged. */
  value?: string
  secret: boolean
  description: string
}

export type JobTargetType = 'devices' | 'group' | 'site' | 'client'

export interface JobTargetInput {
  type: JobTargetType
  ids: Uuid[]
}

export interface JobTarget extends JobTargetInput {
  label: string
}

export type JobSchedule =
  | { type: 'now' }
  | { type: 'once'; at: Timestamp }
  | { type: 'cron'; cron: string; timezone: string }

export type JobStatus = 'pending_approval' | 'scheduled' | 'running' | 'completed' | 'cancelled' | 'rejected'
export type JobRunStatus = 'running' | 'completed' | 'cancelled'
export type JobTrigger = 'manual' | 'schedule' | 'policy' | 'rerun'
export type JobResultStatus =
  | 'pending'
  | 'waiting_offline'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'skipped'
  | 'cancelled'

export interface JobCreate {
  name?: string
  script_id: Uuid
  parameters: Record<string, ParameterValue>
  target: JobTargetInput
  schedule: JobSchedule
  offline_wait_minutes: number
  concurrency: number
  timeout_secs: number | null
  /** Required by the mass-action guard: must equal the resolved target count. */
  confirm_count?: number
}

export interface JobRunCounts {
  total: number
  pending: number
  waiting_offline: number
  running: number
  succeeded: number
  failed: number
}

export interface JobRun extends JobRunCounts {
  id: Uuid
  job_id: Uuid
  status: JobRunStatus
  trigger: JobTrigger
  started_at: Timestamp
  finished_at: Timestamp | null
}

export interface JobScriptRef {
  id: Uuid
  name: string
  language: ScriptLanguage
  risk: ScriptRisk
}

interface JobBase {
  id: Uuid
  name: string
  script: JobScriptRef
  script_version: number
  content_sha256: string
  /** Secret parameter values are replaced by "••••••". */
  parameters: Record<string, ParameterValue>
  target: JobTarget
  schedule: JobSchedule
  next_run_at: Timestamp | null
  status: JobStatus
  offline_wait_minutes: number
  concurrency: number
  timeout_secs: number
  created_by_name: string
  created_at: Timestamp
  approved_by_name: string | null
}

export interface Job extends JobBase {
  /** The latest 20 runs, newest first. */
  runs: JobRun[]
}

export interface JobSummary extends JobBase {
  last_run: JobRun | null
}

export interface JobFilters {
  status?: JobStatus
  script_id?: string
  device_id?: string
  limit?: number
}

export interface JobResult {
  device_id: Uuid
  hostname: string
  os_family: OsFamily
  client_name: string
  status: JobResultStatus
  exit_code: number | null
  started_at: Timestamp | null
  finished_at: Timestamp | null
  duration_ms: number | null
  /** Agent or transport error ("device offline beyond wait window", local policy refusal, …). */
  error: string | null
  stdout_preview: string
}

export interface JobRunDetail {
  run: JobRun
  job: JobSummary
  results: JobResult[]
}

export interface ResultDirective {
  field: string
  value: string
  applied: boolean
}

export interface JobResultDetail extends JobResult {
  stdout: string
  stderr: string
  truncated: boolean
  directives: ResultDirective[]
}

export interface DeviceScriptRun extends JobResult {
  job_id: Uuid
  job_name: string
  run_id: Uuid
  script_name: string
}

export interface QuickRunResponse {
  job_id: Uuid
  run_id: Uuid
}

export interface JobUpdatedEvent {
  job_id: Uuid
  run_id: Uuid
  status: JobRunStatus
  counts: JobRunCounts
}

export interface JobResultEvent {
  job_id: Uuid
  run_id: Uuid
  device_id: Uuid
  status: JobResultStatus
}

export interface AutomationSettings {
  /** Devices; above this a job needs confirmation and step-up. */
  mass_action_threshold: number
  four_eyes_jobs: boolean
  require_script_approval: boolean
  allow_self_approval: boolean
  max_output_kb: number
  default_offline_wait_minutes: number
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired'

export interface Approval {
  id: Uuid
  kind: 'job'
  subject: JobSummary
  requested_by_name: string
  requested_at: Timestamp
  status: ApprovalStatus
  decided_by_name: string | null
  decided_at: Timestamp | null
  comment: string | null
}

export type CustomFieldType = 'text' | 'number' | 'boolean' | 'date' | 'select'
export type CustomFieldScope = 'device' | 'client' | 'site'
export type CustomFieldValue = string | number | boolean | null

export interface CustomField {
  id: Uuid
  /** `[a-z][a-z0-9_]{0,47}`, unique. */
  key: string
  name: string
  description: string
  type: CustomFieldType
  options: string[]
  scope: CustomFieldScope
  script_writable: boolean
  created_at: Timestamp
}

export interface CustomFieldInput {
  key: string
  name: string
  description: string
  type: CustomFieldType
  options: string[]
  scope: CustomFieldScope
  script_writable: boolean
}

export interface CustomFieldValueEntry {
  field: CustomField
  value: CustomFieldValue
  updated_at: Timestamp | null
  /** A user name, or "script" when written by a directive. */
  updated_by: string | null
}

export type RuleMatch = 'all' | 'any'
export type RuleOperator =
  | 'eq'
  | 'neq'
  | 'in'
  | 'not_in'
  | 'exists'
  | 'not_exists'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'matches'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
export type RuleScalar = string | number | boolean
export type RuleValue = RuleScalar | RuleScalar[] | null

export interface RuleCondition {
  field: string
  op: RuleOperator
  value: RuleValue
}

export interface RuleDocument {
  match: RuleMatch
  conditions: RuleNode[]
}

export type RuleNode = RuleCondition | RuleDocument

export type GroupKind = 'static' | 'dynamic'

export interface DeviceGroup {
  id: Uuid
  name: string
  description: string
  kind: GroupKind
  /** null = installation-wide. */
  client_id: Uuid | null
  client_name: string | null
  rules: RuleDocument | null
  member_count: number
  created_by_name: string
  updated_at: Timestamp
}

export interface GroupInput {
  name: string
  description: string
  kind: GroupKind
  client_id?: Uuid | null
  rules?: RuleDocument | null
}

export interface GroupPreview {
  count: number
  /** The first 25 matching devices. */
  items: Device[]
}

export interface PolicyAgentSection {
  heartbeat_secs?: number
  metrics_secs?: number
  inventory_minutes?: number
}

/** How new agent releases reach devices (`agent_updates`). */
export interface PolicyAgentUpdatesSection {
  /** Install new releases automatically (default true). */
  auto_update?: boolean
}

export type DesktopConsentMode = 'never' | 'always' | 'when_user_present'

export interface PolicyRemoteAccessSection {
  shell?: boolean
  files?: boolean
  system?: boolean
  power?: boolean
  /** Phase 8: remote desktop and screenshots. */
  desktop?: boolean
  desktop_consent?: DesktopConsentMode
  /** 5–300; no answer means denied. */
  consent_timeout_secs?: number
  /** On-screen "Remote session in progress" banner on the device. */
  desktop_banner?: boolean
  /** Forces view-only for everyone. */
  desktop_view_only?: boolean
}

export interface PolicyTask {
  id: string
  name: string
  script_id: Uuid
  parameters: Record<string, ParameterValue>
  cron: string
  timezone: string
  enabled: boolean
  offline_wait_minutes?: number
}

export interface PolicyDocument {
  agent?: PolicyAgentSection
  agent_updates?: PolicyAgentUpdatesSection
  remote_access?: PolicyRemoteAccessSection
  tasks?: PolicyTask[]
  /** Phase 6: agent checks and server-side checks. */
  monitoring?: PolicyMonitoringSection
  /** Phase 7: scans, approvals, maintenance-window installs and reboots. */
  patching?: PolicyPatchingSection
  /** Phase 10: LAPS-style local administrator rotation and FileVault escrow. */
  escrow?: PolicyEscrowSection
}

export type PolicyTargetType = 'global' | 'client' | 'site' | 'group' | 'device'

export interface PolicyAssignment {
  id: Uuid
  target_type: PolicyTargetType
  target_id: Uuid | null
  target_name: string | null
  priority: number
}

export interface Policy {
  id: Uuid
  name: string
  description: string
  version: number
  document: PolicyDocument
  assignments: PolicyAssignment[]
  updated_at: Timestamp
  updated_by_name: string
}

export interface PolicyInput {
  name: string
  description: string
  document: PolicyDocument
}

export interface PolicyAssignmentInput {
  target_type: PolicyTargetType
  target_id?: Uuid | null
  priority?: number
}

export interface EffectivePolicySource {
  policy_id: Uuid
  policy_name: string
  version: number
  target_type: PolicyTargetType
  target_name: string | null
  priority: number
}

export interface EffectivePolicy {
  document: PolicyDocument
  sources: EffectivePolicySource[]
  /** Leaf path (e.g. `agent.heartbeat_secs`, `tasks.<id>`) → id of the policy that set it. */
  origins: Record<string, Uuid>
}

// ---------------------------------------------------------------- monitoring & alerts (Phase 6)

export type AlertSeverity = 'info' | 'warning' | 'critical'
export type AlertStatus = 'open' | 'acknowledged' | 'resolved'
/** `snmp` (Phase 10): SNMP thresholds, unreachability and trap rules; such alerts name an SNMP device, not an agent. */
export type AlertSource = 'check' | 'server' | 'snmp'
export type AlertResolution = 'auto' | 'manual'
/** The state a check reports; `unknown` means it could not run. */
export type CheckState = 'ok' | 'warning' | 'critical' | 'unknown'

export type RemediationStatus = 'running' | 'succeeded' | 'failed'

export interface AlertRemediation {
  status: RemediationStatus
  job_id: Uuid | null
  attempts: number
}

export interface Alert {
  id: Uuid
  /** Null for SNMP alerts (Phase 10), which carry `snmp_device_id` instead. */
  device_id: Uuid | null
  /** The agent's host name, or the SNMP device's name for SNMP alerts. */
  hostname: string | null
  /** Phase 10: the SNMP device an `snmp` alert is about. */
  snmp_device_id?: Uuid | null
  snmp_device_name?: string | null
  client_id: Uuid
  client_name: string
  site_id: Uuid | null
  source: AlertSource
  /** A policy check id, or a server check key (`offline`, `agent_outdated`, `disk_forecast`, `security.*`). */
  check_id: string
  check_type: string
  severity: AlertSeverity
  title: string
  message: string
  status: AlertStatus
  opened_at: Timestamp
  last_occurrence_at: Timestamp
  occurrences: number
  acknowledged_at: Timestamp | null
  acknowledged_by_name: string | null
  resolved_at: Timestamp | null
  resolved_by_name: string | null
  resolution: AlertResolution | null
  snoozed_until: Timestamp | null
  assigned_to: { id: Uuid; name: string } | null
  in_maintenance: boolean
  ticket_id: Uuid | null
  remediation: AlertRemediation | null
}

export type AlertEventKind =
  | 'opened'
  | 'occurred'
  | 'severity_changed'
  | 'acknowledged'
  | 'unacknowledged'
  | 'snoozed'
  | 'assigned'
  | 'note'
  | 'notified'
  | 'notification_failed'
  | 'remediation_started'
  | 'remediation_finished'
  | 'resolved'
  | 'reopened'
  | 'maintenance'
  | 'ticket_created'

export interface AlertEvent {
  id: Uuid
  at: Timestamp
  kind: AlertEventKind
  actor_name: string | null
  message: string
  details: Record<string, unknown> | null
}

/**
 * One check's current state on a device (`GET /devices/{id}/checks`). Every configured check is listed;
 * `state` is null (and `message`, `since`, `last_at` empty) until the agent reports it.
 */
export interface DeviceCheck {
  check_id: string
  type: string
  name: string
  state: CheckState | null
  message: string
  value: number | null
  since: Timestamp | null
  last_at: Timestamp | null
  interval_secs: number
  policy_id: Uuid | null
  policy_name: string | null
}

export interface AlertCounts {
  open: number
  acknowledged: number
  critical: number
  warning: number
  info: number
}

export interface AlertListResponse {
  items: Alert[]
  next_cursor: string | null
  counts: AlertCounts
}

export interface AlertsSummary extends AlertCounts {
  by_client: { client_id: Uuid; client_name: string; critical: number; warning: number }[]
}

export interface AlertDetail {
  alert: Alert
  events: AlertEvent[]
  check: DeviceCheck | null
}

/** `GET /alerts` query. List values are comma-separated on the wire; `status=all` lists every status. */
export interface AlertFilters {
  status?: string
  severity?: string
  client_id?: string
  site_id?: string
  device_id?: string
  source?: AlertSource
  check_type?: string
  /** `me`, `none` or a user id. */
  assigned?: string
  q?: string
  limit?: number
}

export type AlertBulkActionKind = 'acknowledge' | 'resolve' | 'snooze' | 'assign'

export interface AlertBulkRequest {
  ids: Uuid[]
  action: AlertBulkActionKind
  minutes?: number
  until?: Timestamp
  user_id?: Uuid | null
  note?: string
}

/** Alerts outside the caller's scope or in the wrong status are skipped. */
export interface AlertBulkResponse {
  updated: number
  skipped: number
  updated_ids: Uuid[]
  skipped_ids: Uuid[]
}

/** Single-alert actions return the updated alert (`409 invalid_status` when the action does not apply). */
export interface AlertActionResponse {
  alert: Alert
}

export type CheckFieldType = 'number' | 'text' | 'boolean' | 'select' | 'string_list' | 'number_list' | 'script'
export type CheckConfigValue = string | number | boolean | string[] | number[] | Record<string, ParameterValue> | null

export interface CheckFieldSchema {
  key: string
  label: string
  type: CheckFieldType
  required: boolean
  default: CheckConfigValue
  min?: number
  max?: number
  options?: string[]
  unit?: string
}

export interface CheckTypeDefinition {
  type: string
  label: string
  description: string
  platforms: OsFamily[]
  /** Graded types let the agent choose warning or critical and the alert severity follows the state. */
  graded: boolean
  config_schema: CheckFieldSchema[]
}

export interface CheckRemediation {
  script_id: Uuid
  parameters: Record<string, ParameterValue>
  max_attempts: number
}

/**
 * A check in the policy's `monitoring.checks`. Checks merge by `id` across layers; a later layer may
 * carry only `id` plus the fields it overrides (for example `{ id, enabled: false }`).
 */
export interface MonitoringCheck {
  id: string
  type?: string
  /** Defaults to the type's label. */
  name?: string
  /** Defaults to true. */
  enabled?: boolean
  /** 30–86400, default 300. */
  interval_secs?: number
  /** Default `warning`; used for non-graded types. */
  severity?: AlertSeverity
  config?: Record<string, CheckConfigValue>
  remediation?: Partial<CheckRemediation> | null
  /** Limits the check to these platforms; omitted = every platform the type supports. */
  platforms?: OsFamily[]
}

export interface MonitoringServerSection {
  /** 0 disables the offline alert. */
  offline_minutes?: number
  offline_severity?: AlertSeverity
  agent_outdated?: boolean
  /** 0 disables the forecast. */
  disk_forecast_days?: number
  security_changes?: boolean
}

export interface PolicyMonitoringSection {
  checks?: MonitoringCheck[]
  server?: MonitoringServerSection
}

// ---------------------------------------------------------------- notifications (Phase 6)

export type NotificationChannelKind = 'email' | 'slack' | 'teams' | 'discord' | 'ntfy' | 'webhook'

/**
 * Per kind: email `{ to, cc? }`, slack/teams/discord `{ webhook_url }`, ntfy `{ server_url, topic, token? }`,
 * webhook `{ url, secret?, headers? }`. Secret fields (webhook URLs, tokens, the webhook secret) come back
 * as "••••••".
 */
export interface NotificationChannel {
  id: Uuid
  name: string
  kind: NotificationChannelKind
  enabled: boolean
  config: Record<string, unknown>
  last_used_at: Timestamp | null
  last_error: string | null
  created_at?: Timestamp
  updated_at?: Timestamp
}

/**
 * Leave secret fields out of `config` on update to keep them unchanged (send a header value as "••••••"
 * to keep it; leave `headers` out to keep them all). `kind` cannot change after creation.
 */
export interface NotificationChannelInput {
  name: string
  kind: NotificationChannelKind
  enabled: boolean
  config: Record<string, unknown>
}

export interface ChannelTestResult {
  ok: boolean
  status?: number | null
  error?: string | null
}

/** `secret.revealed` (Phase 10): someone revealed an escrowed secret; only client and site filters apply. */
export type NotificationEvent = 'opened' | 'severity_changed' | 'resolved' | 'escalated' | 'secret.revealed'

export interface NotificationRuleFilters {
  client_ids: Uuid[]
  site_ids: Uuid[]
  severities: AlertSeverity[]
  sources: AlertSource[]
  check_types: string[]
  check_ids: string[]
}

export interface QuietHours {
  enabled: boolean
  /** "HH:MM", 24-hour clock. */
  start: string
  end: string
  timezone: string
  /** 0 = Sunday … 6 = Saturday. */
  days: number[]
  except_critical: boolean
}

export interface Escalation {
  enabled: boolean
  after_minutes: number
  channel_ids: Uuid[]
}

export interface NotificationRule {
  id: Uuid
  name: string
  enabled: boolean
  filters: NotificationRuleFilters
  /** Defaults to `["opened", "resolved"]` when empty. */
  events: NotificationEvent[]
  channel_ids: Uuid[]
  quiet_hours: QuietHours
  escalation: Escalation
  created_at?: Timestamp
  updated_at?: Timestamp
}

export type NotificationRuleInput = Omit<NotificationRule, 'id' | 'created_at' | 'updated_at'>

/** `pending` is a scheduled retry; `suppressed` was held back by quiet hours. */
export type NotificationDeliveryStatus = 'pending' | 'sent' | 'failed' | 'suppressed'

/** One delivery attempt from `GET /notification-log` (newest first). */
export interface NotificationLogEntry {
  id: Uuid
  /** Groups the attempts of one delivery. */
  delivery_id: Uuid
  at: Timestamp
  alert_id: Uuid | null
  channel_id: Uuid | null
  channel_name: string | null
  channel_kind: NotificationChannelKind | null
  rule_id: Uuid | null
  event: NotificationEvent | 'test'
  attempt: number
  status: NotificationDeliveryStatus
  http_status: number | null
  error: string | null
  next_attempt_at: Timestamp | null
  finished_at: Timestamp | null
}

export type SmtpSecurity = 'starttls' | 'tls' | 'none'

export interface SmtpSettings {
  host: string
  port: number
  security: SmtpSecurity
  username: string
  /** "••••••" when one is stored, otherwise null. Write-only. */
  password: string | null
  from_address: string
  from_name: string
}

/** Omit `password` (or send "••••••") to keep it; `null` or "" clears it. `port` and `security` are optional. */
export type SmtpSettingsInput = Omit<SmtpSettings, 'password' | 'port' | 'security'> & {
  port?: number
  security?: SmtpSecurity
  password?: string | null
}

export interface SmtpTestResult {
  ok: boolean
  error?: string | null
}

// ---------------------------------------------------------------- maintenance windows (Phase 6)

export type MaintenanceTargetType = 'global' | 'client' | 'site' | 'group' | 'device'

export interface MaintenanceTarget {
  type: MaintenanceTargetType
  id?: Uuid
  /** Present in responses. */
  name?: string | null
}

export type MaintenanceSchedule =
  | { type: 'once'; start: Timestamp; end: Timestamp }
  | { type: 'recurring'; cron: string; duration_minutes: number; timezone: string }

export type MaintenanceSuppress = 'notifications' | 'alerts'

export interface MaintenanceWindow {
  id: Uuid
  name: string
  enabled: boolean
  targets: MaintenanceTarget[]
  schedule: MaintenanceSchedule
  suppress: MaintenanceSuppress
  created_by_name: string
  active_now: boolean
  next_start: Timestamp | null
  created_at?: Timestamp
  updated_at?: Timestamp
}

export interface MaintenanceWindowInput {
  name: string
  enabled: boolean
  targets: MaintenanceTarget[]
  schedule: MaintenanceSchedule
  suppress: MaintenanceSuppress
}

export interface DeviceMaintenance {
  active: MaintenanceWindow[]
  upcoming: MaintenanceWindow[]
}

export interface MonitoringSettings {
  /** Used when no policy sets `monitoring.server.offline_minutes`. */
  default_offline_minutes: number
  unknown_threshold: number
  /** Resolved alerts and events older than this are purged. */
  retention_days: number
  webhook_allowlist: string[]
}

// ---------------------------------------------------------------- live events (Phase 6)

export interface AlertStreamEvent {
  alert: Alert
}

/** Published per client; a signal to refetch `GET /alerts/summary`, not a global total. */
export interface AlertsSummaryEvent {
  client_id: Uuid
  open: number
  critical: number
  warning: number
}

export interface DeviceChecksEvent {
  device_id: Uuid
}

// ---------------------------------------------------------------- patching (Phase 7)

/** `winget` is a third-party source offered as patches on Windows when `third_party.winget` is on. */
export type PatchPlatform = 'windows' | 'linux' | 'macos' | 'winget'
export type PatchRing = 'pilot' | 'broad' | 'late'
/** MSRC severities; Linux security advisories map onto the same scale. */
export type PatchSeverity = 'Critical' | 'Important' | 'Moderate' | 'Low'
export type WindowsClassification =
  | 'SecurityUpdates'
  | 'CriticalUpdates'
  | 'UpdateRollups'
  | 'Updates'
  | 'Definitions'
  | 'Drivers'
  | 'FeaturePacks'
  | 'Upgrades'
  | 'ServicePacks'
  | 'Tools'
export type LinuxClassification = 'security' | 'bugfix' | 'enhancement' | 'other'
export type MacClassification = 'os' | 'security' | 'app'
export type PatchClassification = WindowsClassification | LinuxClassification | MacClassification
export type RebootMode = 'never' | 'prompt' | 'force'
export type LinuxPatchMode = 'security' | 'all'

export interface PatchRingDelays {
  pilot?: number
  broad?: number
  late?: number
}

/** An auto-approval rule; empty lists match anything. */
export interface AutoApproveRule {
  platform: PatchPlatform
  classifications?: string[]
  severities?: PatchSeverity[]
  /** Days after the release date (or first sighting) before devices in each ring install it. */
  delay_days?: PatchRingDelays
}

/** Installs only happen inside the window. `cron` is required whenever a layer sets `window`. */
export interface PatchWindow {
  cron: string
  /** 15–1440, default 180. */
  duration_minutes?: number
  /** IANA zone, default `UTC`. */
  timezone?: string
}

export interface PatchRebootSettings {
  mode?: RebootMode
  /** 0–10; each deferral postpones the prompt by 60 minutes. */
  prompt_deferrals?: number
  force_at_window_end?: boolean
  /** At most 500 characters. */
  message?: string
}

/** The `patching` policy section. Objects deep-merge across layers; `auto_approve` is replaced whole. */
export interface PolicyPatchingSection {
  enabled?: boolean
  /** 1–168. */
  scan_interval_hours?: number
  window?: PatchWindow
  ring?: PatchRing
  auto_approve?: AutoApproveRule[]
  windows?: { include_drivers?: boolean; include_feature_updates?: boolean; include_preview?: boolean }
  linux?: { mode?: LinuxPatchMode }
  macos?: { install?: boolean }
  reboot?: PatchRebootSettings
  third_party?: { winget?: boolean }
}

export type PatchApprovalStatus = 'approved' | 'declined' | 'deferred' | 'none'
export type PatchApprovalSource = 'rule' | 'manual'

/**
 * The decision that applies: in `GET /patches` the one for `client_id` when given (otherwise the
 * global one), in device views the one for the device's client. Precedence for a client: its manual
 * decision, then a manual global decision, then its rule approval. `status: none` has no other fields.
 */
export interface PatchApproval {
  status: PatchApprovalStatus
  source?: PatchApprovalSource
  /** When the decision was taken. */
  at?: Timestamp
  by_name?: string | null
  /** `null` for a global decision; set for client-scoped ones (rule approvals always are). */
  client_id?: Uuid | null
  /** Approvals only. */
  approved_at?: Timestamp
  /** Deferrals only. */
  until?: Timestamp | null
  /**
   * All-clients view only: a patch without a global decision but with client rule approvals shows
   * `status: approved, source: rule, scope: clients` with the number of clients.
   */
  scope?: 'clients'
  clients?: number
}

export interface PatchDeviceCounts {
  missing: number
  installed: number
  failed: number
  pending_reboot: number
}

export interface Patch {
  id: Uuid
  platform: PatchPlatform
  /** WUA UpdateID, `<manager>:<package>:<version>`, a softwareupdate label or `winget:<id>:<version>`. */
  key: string
  kb: string | null
  title: string
  classification: PatchClassification
  severity: PatchSeverity | null
  size_bytes: number | null
  reboot_required: boolean
  release_date: Timestamp | null
  first_seen_at: Timestamp
  description: string
  support_url: string | null
  cves: string[]
  approval: PatchApproval
  devices: PatchDeviceCounts
  /** Visible clients with an active rule approval of this patch. */
  rule_approved_clients?: number
}

export type DevicePatchState =
  | 'missing'
  | 'downloaded'
  | 'installing'
  | 'installed'
  | 'failed'
  | 'pending_reboot'
  | 'superseded'

export interface PatchFilters {
  platform?: PatchPlatform
  classification?: string
  /** `none` selects patches without a severity. */
  severity?: PatchSeverity | 'none'
  approval?: PatchApprovalStatus
  /** Defaults to `missing` (missing or failed on at least one visible device). */
  status?: 'missing' | 'any'
  client_id?: string
  q?: string
  limit?: number
}

export interface PatchDeviceRow {
  device_id: Uuid
  hostname: string
  client_name: string
  state: DevicePatchState
  detected_at: Timestamp | null
  installed_at: Timestamp | null
  last_error: string | null
}

export interface PatchDetail {
  patch: Patch
  devices: PatchDeviceRow[]
}

export type PatchDecision = 'approved' | 'declined' | 'deferred' | 'none'

export interface PatchApproveRequest {
  ids: Uuid[]
  /** A client-level decision overrides the global one for that client's devices. */
  client_id?: Uuid | null
  decision: PatchDecision
  /** Required for `deferred`. */
  until?: Timestamp
}

/** One rule from `GET /patch-approval-rules`, with the policy it comes from. */
export interface PatchApprovalRuleRow extends AutoApproveRule {
  policy_id: Uuid
  policy_name: string
  /** Position of the rule in the policy's `auto_approve` list. */
  index?: number
}

export type PatchScanSource =
  | 'wsus'
  | 'windows_update'
  | 'apt'
  | 'dnf'
  | 'zypper'
  | 'pacman'
  | 'apk'
  | 'softwareupdate'

export interface DevicePatchItem {
  patch: Patch
  state: DevicePatchState
  detected_at: Timestamp | null
  installed_at: Timestamp | null
  last_error: string | null
  /** Approved, and the device's ring delay has passed. */
  effective_approved: boolean
}

export interface DevicePatches {
  scanned_at: Timestamp | null
  source: PatchScanSource | null
  pending_reboot: boolean
  reboot_reasons: string[]
  items: DevicePatchItem[]
}

export interface PatchInstallRequest {
  patch_ids: Uuid[] | 'approved'
  reboot: { mode: RebootMode; deferrals: number; message: string }
}

/** The install response; `run_id` is read when the server returns the run it created. */
export interface PatchInstallResponse {
  cmd_id?: Uuid
  run_id?: Uuid
  count?: number
}

export type PatchRunStatus = 'running' | 'completed' | 'cancelled'
export type PatchRunResultStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'pending_reboot'
  | 'skipped'
  | 'cancelled'

export interface PatchRunCounts {
  total: number
  succeeded: number
  failed: number
  pending_reboot: number
  pending: number
  skipped?: number
}

export interface PatchRun extends PatchRunCounts {
  id: Uuid
  policy_id: Uuid | null
  policy_name: string
  window_start: Timestamp
  window_end: Timestamp | null
  status: PatchRunStatus
  /** `window` for maintenance-window runs, `manual` for "Install now". */
  trigger?: 'window' | 'manual'
}

export interface PatchRunResult {
  device_id: Uuid
  hostname: string
  status: PatchRunResultStatus
  installed: number
  failed: number
  rebooted: boolean
  error: string | null
}

export interface PatchRunDetail {
  run: PatchRun
  results: PatchRunResult[]
}

export type ComplianceGroupBy = 'client' | 'site' | 'os'

export interface ComplianceTotals {
  devices: number
  compliant: number
  non_compliant: number
  missing_critical: number
  missing_important: number
  pending_reboot: number
  failed: number
}

export type ComplianceSeverityKey = PatchSeverity | 'Unspecified'

export interface ComplianceRow {
  key: string
  label: string
  devices: number
  compliant: number
  compliance_pct: number
  missing_by_severity: Partial<Record<ComplianceSeverityKey, number>>
  oldest_missing_days: number | null
}

export interface ComplianceReport {
  totals: ComplianceTotals
  rows: ComplianceRow[]
}

export interface PatchesChangedEvent {
  device_id?: Uuid
}

export interface PatchRunUpdatedEvent {
  run_id: Uuid
  counts: PatchRunCounts
}

// ---------------------------------------------------------------- software (Phase 7)

export interface SoftwareProductSummary {
  name: string
  publisher: string | null
  versions: number
  devices: number
  latest_version: string | null
}

export interface SoftwareFilters {
  q?: string
  publisher?: string
  client_id?: string
  limit?: number
}

export interface SoftwareProduct {
  name: string
  publisher: string | null
  versions: { version: string; devices: number }[]
  devices: { device_id: Uuid; hostname: string; client_name: string; version: string; install_date: string | null }[]
}

export type PackageManagerType = 'winget' | 'choco' | 'brew' | 'apt' | 'dnf' | 'zypper' | 'pacman' | 'apk'
export type PackageSourceType = PackageManagerType | 'file'
export type InstallerType = 'msi' | 'exe' | 'pkg' | 'deb' | 'rpm' | 'sh'

export type PackageSource =
  | { type: 'winget'; id: string }
  | { type: 'choco'; id: string }
  | { type: 'brew'; id: string; cask?: boolean }
  | { type: 'apt' | 'dnf' | 'zypper' | 'pacman' | 'apk'; id: string }
  | {
      type: 'file'
      file_id: Uuid
      file_name: string
      sha256: string
      size_bytes: number
      installer: InstallerType
      install_args: string
      uninstall_args: string
    }

export type DetectionRule =
  | { type: 'software_name'; pattern: string; min_version?: string }
  | { type: 'file'; path: string; min_version?: string }
  | { type: 'registry'; key: string; value?: string; equals?: string }
  | { type: 'none' }

export interface SoftwarePackage {
  id: Uuid
  name: string
  publisher: string
  description: string
  platforms: OsFamily[]
  source: PackageSource
  detection: DetectionRule
  created_by_name: string
  created_at?: Timestamp
  updated_at: Timestamp
  installed_on: number
}

export type SoftwarePackageInput = Omit<
  SoftwarePackage,
  'id' | 'created_by_name' | 'created_at' | 'updated_at' | 'installed_on'
>

export interface SoftwareFileUpload {
  file_id: Uuid
  sha256: string
  size_bytes: number
  file_name: string
}

export type DeploymentAction = 'install' | 'uninstall'
export type DeploymentSchedule = { type: 'now' } | { type: 'once'; at: Timestamp } | { type: 'window' }
export type DeploymentStatus = 'scheduled' | 'running' | 'completed' | 'cancelled'
export type DeploymentResultStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled'

export interface DeploymentCreate {
  package_id: Uuid
  action: DeploymentAction
  target: JobTargetInput
  schedule: DeploymentSchedule
  /** Required by the mass-action guard: must equal the resolved target count. */
  confirm_count?: number
}

export interface DeploymentSummary {
  id: Uuid
  package: { id: Uuid | null; name: string }
  action: DeploymentAction
  target_label: string
  status: DeploymentStatus
  total: number
  succeeded: number
  failed: number
  pending: number
  skipped?: number
  cancelled?: number
  created_by_name: string
  created_at: Timestamp
  /** Read when the detail carries them. */
  target?: JobTargetInput
  schedule?: DeploymentSchedule
  finished_at?: Timestamp | null
}

export interface DeploymentResult {
  device_id: Uuid
  hostname: string
  status: DeploymentResultStatus
  exit_code: number | null
  /** Detection after the action: true when the package is now detected. */
  detected_after: boolean | null
  error: string | null
  output_preview: string | null
}

export interface DeploymentDetail {
  deployment: DeploymentSummary
  results: DeploymentResult[]
}

export interface DeploymentCounts {
  total: number
  succeeded: number
  failed: number
  /** Includes running. */
  pending: number
  skipped: number
  cancelled: number
}

export interface SoftwareDeploymentUpdatedEvent {
  deployment_id: Uuid
  status: DeploymentStatus
  counts: DeploymentCounts
}

/** One deployment as seen from a device (`GET /devices/{id}/software-deployments`). */
export interface DeviceDeployment {
  deployment_id: Uuid
  package: { id: Uuid | null; name: string }
  action: DeploymentAction
  status: DeploymentResultStatus
  exit_code: number | null
  detected_after: boolean | null
  error: string | null
  created_at: Timestamp
  finished_at: Timestamp | null
}

// ---------------------------------------------------------------- tickets & helpdesk (Phase 9, docs/api-tickets.md)

export type TicketStatus = 'new' | 'open' | 'pending' | 'on_hold' | 'resolved' | 'closed'
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent'
export type TicketType = 'incident' | 'request' | 'problem' | 'change' | 'alert'
export type TicketSource = 'console' | 'email' | 'agent' | 'alert' | 'api'

export interface TicketRef {
  id: Uuid
  name: string
}

export interface TicketSla {
  policy_id: Uuid
  policy_name: string
  first_response_due: Timestamp
  first_response_at: Timestamp | null
  first_response_breached: boolean
  resolution_due: Timestamp
  resolved_at: Timestamp | null
  resolution_breached: boolean
  /** True while the status is in the policy's `pause_on` list: due times are frozen. */
  paused: boolean
}

export interface Ticket {
  id: Uuid
  /** Per-installation sequence starting at 1001, shown as `#1042`. */
  number: number
  subject: string
  /** Markdown. */
  description: string
  client_id: Uuid
  client_name: string
  site_id: Uuid | null
  site_name: string | null
  contact: { id: Uuid; name: string; email: string } | null
  status: TicketStatus
  priority: TicketPriority
  type: TicketType
  queue: TicketRef
  assignee: TicketRef | null
  tags: string[]
  /** Extra recipients of public comments. */
  cc: string[]
  devices: { id: Uuid; hostname: string }[]
  alerts: { id: Uuid; title: string; status: AlertStatus }[]
  /** Linked tickets (mutual). */
  tickets: { id: Uuid; number: number; subject: string; status: TicketStatus }[]
  source: TicketSource
  sla: TicketSla | null
  time_spent_minutes: number
  billable_minutes: number
  created_by_name: string
  created_at: Timestamp
  updated_at: Timestamp
  last_activity_at: Timestamp
  closed_at: Timestamp | null
  merged_into: { id: Uuid; number: number } | null
}

export interface TicketAttachment {
  id: Uuid
  file_name: string
  size_bytes: number
  content_type: string
}

export type CommentVisibility = 'public' | 'internal'

export interface TicketComment {
  id: Uuid
  ticket_id: Uuid
  /** A contact whose address is not a known contact has `id: null` and `name` "Name <address>". */
  author: { type: 'user' | 'contact' | 'system'; id: Uuid | null; name: string }
  visibility: CommentVisibility
  /** Markdown. */
  body: string
  source: 'console' | 'email' | 'agent' | 'system'
  attachments: TicketAttachment[]
  created_at: Timestamp
  edited_at: Timestamp | null
}

export type TicketActivityKind =
  | 'created'
  | 'subject'
  | 'description'
  | 'status'
  | 'priority'
  | 'type'
  | 'queue'
  | 'assignee'
  | 'contact'
  | 'site'
  | 'client'
  | 'tags'
  | 'cc'
  | 'linked'
  | 'unlinked'
  | 'merged'
  | 'sla_breached'
  | 'time_logged'
  | 'time_deleted'
  | 'email_failed'

export interface TicketActivity {
  at: Timestamp
  actor_name: string
  kind: TicketActivityKind
  from: string | null
  to: string | null
}

export interface TimeEntry {
  id: Uuid
  ticket_id: Uuid
  ticket_number: number
  ticket_subject: string
  client_id: Uuid
  client_name: string
  user: TicketRef
  started_at: Timestamp
  minutes: number
  billable: boolean
  note: string
  created_at: Timestamp
}

export interface TicketCounts {
  new: number
  open: number
  pending: number
  on_hold: number
  mine: number
  unassigned: number
  breached: number
  /** Tickets in status `resolved`. */
  resolved?: number
  /** Active tickets with a running SLA clock due within 60 minutes. */
  due_soon?: number
}

export interface TicketListResponse {
  items: Ticket[]
  next_cursor: string | null
  counts: TicketCounts
}

export interface TicketDetail {
  ticket: Ticket
  comments: TicketComment[]
  activity: TicketActivity[]
  time_entries: TimeEntry[]
}

export type TicketSort = 'last_activity' | 'created' | 'oldest' | 'updated' | 'number' | 'priority' | 'due'

/** `GET /tickets` query. List values are comma-separated; `status=all` lists every status. */
export interface TicketFilters {
  status?: string
  priority?: string
  queue_id?: string
  /** `me`, `none` or a user id. */
  assignee?: string
  client_id?: string
  site_id?: string
  device_id?: string
  /** Comma-separated contact ids. */
  contact_id?: string
  type?: string
  source?: string
  tag?: string
  q?: string
  sla?: 'breached' | 'due_soon'
  sort?: TicketSort
  limit?: number
}

export interface TicketCreate {
  subject: string
  description: string
  client_id: Uuid
  site_id?: Uuid | null
  contact_id?: Uuid | null
  priority?: TicketPriority
  type?: TicketType
  queue_id?: Uuid
  assignee_id?: Uuid | null
  tags?: string[]
  cc?: string[]
  device_ids?: Uuid[]
  alert_ids?: Uuid[]
}

export interface TicketPatch {
  subject?: string
  description?: string
  status?: TicketStatus
  priority?: TicketPriority
  type?: TicketType
  queue_id?: Uuid
  assignee_id?: Uuid | null
  contact_id?: Uuid | null
  site_id?: Uuid | null
  client_id?: Uuid
  tags?: string[]
  cc?: string[]
}

export interface TicketLinks {
  device_ids?: Uuid[]
  alert_ids?: Uuid[]
  ticket_ids?: Uuid[]
}

export type TicketBulkAction = 'assign' | 'status' | 'priority' | 'queue' | 'tag'

export interface TicketBulkRequest {
  ids: Uuid[]
  action: TicketBulkAction
  /** A user id (`null` or `""` unassigns), a status, a priority, a queue id, or a tag (`-tag` removes). */
  value: string | null
}

export interface TicketBulkResponse {
  updated: number
  skipped: number
  updated_ids: Uuid[]
  skipped_ids: Uuid[]
}

export interface TicketStats {
  from: string
  to: string
  opened: number
  resolved: number
  avg_first_response_minutes: number | null
  avg_resolution_minutes: number | null
  sla_met_pct: number | null
  by_priority: { priority: TicketPriority; opened: number; resolved: number }[]
  by_queue: { queue_id: Uuid; queue_name: string; opened: number; resolved: number }[]
  backlog_trend: { date: string; open: number }[]
}

export interface TicketQueueInput {
  name: string
  description: string
  default_assignee_id?: Uuid | null
  default_priority: TicketPriority
  email_address?: string | null
}

export interface TicketQueue extends TicketQueueInput {
  id: Uuid
  builtin: boolean
  open_tickets: number
  created_at: Timestamp
  updated_at: Timestamp
}

export interface SlaTarget {
  first_response_minutes: number
  resolution_minutes: number
}

export interface BusinessHours {
  timezone: string
  /** ISO weekdays, 1 = Monday … 7 = Sunday. */
  days: number[]
  /** Local `HH:MM`; `end` may be `24:00`, and an `end` at or before `start` runs overnight. */
  start: string
  end: string
  /** Local dates (`YYYY-MM-DD`); a window starting on a holiday does not count. */
  holidays: string[]
}

export type SlaPauseStatus = 'pending' | 'on_hold'

export interface SlaPolicyInput {
  name: string
  /** Empty = the default policy. */
  client_ids: Uuid[]
  /** `null` = 24x7. */
  business_hours: BusinessHours | null
  targets: Record<TicketPriority, SlaTarget>
  pause_on: SlaPauseStatus[]
}

export interface SlaPolicy extends SlaPolicyInput {
  id: Uuid
  builtin: boolean
  created_at: Timestamp
  updated_at: Timestamp
}

export interface CannedResponseInput {
  name: string
  body: string
  visibility: CommentVisibility
  shared: boolean
}

export interface CannedResponse extends CannedResponseInput {
  id: Uuid
  owner_id: Uuid
  created_at: Timestamp
  updated_at: Timestamp
}

export interface CannedRender {
  body: string
  visibility: CommentVisibility
}

export interface ContactInput {
  client_id: Uuid
  site_id: Uuid | null
  name: string
  email: string
  phone: string
  title: string
  is_primary: boolean
  notify: boolean
  notes: string
}

export interface Contact extends ContactInput {
  id: Uuid
  client_name: string
  site_name: string | null
  created_at: Timestamp
  updated_at: Timestamp
}

export interface ContactImportResult {
  created: number
  updated: number
  errors: { row: number; message: string }[]
}

export interface TimeEntryInput {
  minutes: number
  started_at?: Timestamp
  billable?: boolean
  note?: string
}

export interface TimeTotals {
  minutes: number
  billable_minutes: number
  by_client: { client_id: Uuid; client_name: string; minutes: number; billable_minutes: number }[]
  by_user: { user_id: Uuid; user_name: string; minutes: number; billable_minutes: number }[]
}

export interface TimeEntryListResponse {
  items: TimeEntry[]
  totals: TimeTotals
}

export interface TimeEntryFilters {
  client_id?: string
  user_id?: string
  ticket_id?: string
  from?: string
  to?: string
  billable?: boolean
}

export interface TicketEmailOutbound {
  enabled: boolean
  notify_contact_on_create: boolean
  notify_on_public_comment: boolean
  notify_on_resolve: boolean
  notify_technician_on_assign: boolean
  reply_address: string
}

export type ImapSecurity = 'tls' | 'starttls' | 'none'

export interface TicketEmailInbound {
  enabled: boolean
  host: string
  port: number
  security: ImapSecurity
  username: string
  /** Write-only: reads as `••••••` when stored; omit or send the mask to keep, `null`/`""` clears. */
  password: string | null
  folder: string
  processed_folder: string
  unknown_sender: 'holding_queue' | 'drop'
}

export interface TicketEmailSettings {
  outbound: TicketEmailOutbound
  inbound: TicketEmailInbound
  /** Markdown with the canned-response placeholders. */
  signature: string
  inbound_status?: { last_poll_at: Timestamp | null; last_error: string | null; last_processed: number | null }
}

export interface TicketEmailSettingsInput {
  outbound: TicketEmailOutbound
  inbound: Omit<TicketEmailInbound, 'password'> & { password?: string | null }
  signature: string
}

export interface ImapTestResult {
  ok: boolean
  error?: string
}

export interface AlertTicketRuleInput {
  name: string
  enabled: boolean
  filters: { client_ids: Uuid[]; severities: AlertSeverity[]; check_types: string[]; sources: AlertSource[] }
  /** Only when the alert is still open and unacknowledged after N minutes (0 = immediately). */
  after_minutes: number
  ticket: { queue_id: Uuid; priority: TicketPriority; assignee_id?: Uuid | null }
  close_ticket_on_resolve: boolean
}

export interface AlertTicketRule extends AlertTicketRuleInput {
  id: Uuid
  created_at: Timestamp
  updated_at: Timestamp
}

export interface AlertTicketCreate {
  subject?: string
  description?: string
  priority?: TicketPriority
  queue_id?: Uuid
  assignee_id?: Uuid | null
}

export interface TicketCreatedEvent {
  ticket: Ticket
}

export interface TicketUpdatedEvent {
  ticket_id: Uuid
  changes: Record<string, unknown>
}

export interface TicketCommentEvent {
  ticket_id: Uuid
  comment_id: Uuid
  visibility: CommentVisibility
}

export interface TicketsCountsEvent {
  client_id: Uuid
  new: number
  open: number
  pending: number
  on_hold: number
  unassigned: number
  breached: number
  total: number
}

// ---------------------------------------------------------------- secrets escrow (Phase 10, docs/api-escrow-network.md)

export type EscrowKind = 'bitlocker' | 'laps' | 'filevault' | 'luks'

/** Non-secret context captured with an item (volume, mount point, protector id or account). */
export interface EscrowItemMetadata {
  volume?: string
  mount_point?: string
  key_protector_id?: string
  account?: string
  [key: string]: unknown
}

/** An escrowed secret in list form: metadata only, never the secret. */
export interface EscrowItem {
  id: Uuid
  device_id: Uuid | null
  hostname: string
  client_id?: Uuid
  client_name: string
  site_id?: Uuid | null
  kind: EscrowKind
  /** BitLocker protector id, local account name, and so on. */
  identifier: string
  label: string
  metadata: EscrowItemMetadata
  captured_at: Timestamp
  /** Set when a newer item replaced this one (a rotated password, a new protector). */
  superseded_at: Timestamp | null
  last_revealed_at: Timestamp | null
  reveal_count: number
  /** SHA-256 the server de-duplicates on (never the secret); optional in list responses. */
  source_hash?: string
}

export interface EscrowFilters {
  client_id?: string
  device_id?: string
  kind?: EscrowKind
  q?: string
  include_superseded?: boolean
}

/** `POST /escrow/{id}/reveal`. Served with `Cache-Control: no-store`; shown once, never cached. */
export interface EscrowReveal {
  secret: string
  kind: EscrowKind
  identifier: string
  /** Seconds the console may show the secret (60). */
  expires_in: number
}

export interface EscrowStatsDevice {
  id: Uuid
  hostname: string
  client_id?: Uuid
  client_name: string
}

export interface EscrowStats {
  bitlocker: { encrypted_devices: number; escrowed: number; missing: EscrowStatsDevice[] }
  laps: { enabled_devices: number; rotated_within_policy: number; overdue: EscrowStatsDevice[] }
}

/** A signed agent command was queued; its outcome arrives later. */
export interface CommandAccepted {
  cmd_id: Uuid
}

export type LapsComplexity = 'full' | 'alphanumeric'

export interface PolicyEscrowLaps {
  enabled?: boolean
  /** 1 to 20 letters, digits, dash, underscore or dot; default rmm-admin. */
  account?: string
  create_if_missing?: boolean
  /** 14 to 64 characters. */
  length?: number
  complexity?: LapsComplexity
  /** 1 to 365 days. */
  rotate_days?: number
  /** 0 to 720 hours; 0 turns rotation after a reveal off. */
  rotate_after_reveal_hours?: number
}

export interface PolicyEscrowSection {
  laps?: PolicyEscrowLaps
  filevault?: { escrow?: boolean }
}

/** Live event: an item was captured, revealed, superseded or deleted. */
export interface EscrowChangedEvent {
  device_id: Uuid | null
  kind: EscrowKind
}

// ---------------------------------------------------------------- network discovery (Phase 10)

/** A site's probe agent (`GET /network/probes`, `PUT /sites/{id}/probe`). */
export interface SiteProbe {
  site_id: Uuid
  site_name?: string
  device_id: Uuid | null
  hostname: string | null
  os_family?: OsFamily | null
  online: boolean
  trap_receiver: boolean
  trap_port: number
  assigned_at: Timestamp | null
}

export interface SiteProbeInput {
  device_id: Uuid | null
  trap_receiver?: boolean
  trap_port?: number
}

export interface ScanMethods {
  icmp: boolean
  arp: boolean
  tcp_ports: number[]
  snmp: boolean
  mdns: boolean
  netbios: boolean
}

export interface ScanSchedule {
  cron: string
  timezone?: string
}

export type ScanRunStatus = 'running' | 'succeeded' | 'failed'

export interface ScanLastRun {
  at: Timestamp
  hosts_found: number
  duration_ms: number | null
  status: ScanRunStatus
  error?: string | null
}

export interface NetworkScan {
  id: Uuid
  site_id: Uuid
  site_name?: string
  name: string
  /** CIDR ranges, each at most a /20 (4096 hosts). */
  ranges: string[]
  methods: ScanMethods
  schedule: ScanSchedule | null
  snmp_credential_ids: Uuid[]
  last_run: ScanLastRun | null
  next_run_at?: Timestamp | null
  created_at?: Timestamp
  updated_at?: Timestamp
}

export interface NetworkScanInput {
  site_id: Uuid
  name: string
  ranges: string[]
  methods: ScanMethods
  schedule: ScanSchedule | null
  snmp_credential_ids: Uuid[]
}

export type AssetType =
  | 'printer'
  | 'switch'
  | 'router'
  | 'ap'
  | 'nas'
  | 'camera'
  | 'phone'
  | 'windows'
  | 'linux'
  | 'mac'
  | 'ups'
  | 'unknown'

export interface NetworkAsset {
  id: Uuid
  site_id: Uuid
  site_name?: string
  ip: string
  mac: string | null
  /** OUI vendor. */
  vendor: string | null
  hostname: string | null
  /** The type guess, or the type set by hand (`type_source: "manual"`). */
  type_guess: AssetType
  type_source?: 'guess' | 'manual'
  /** Matched by MAC or host name to an enrolled agent. */
  managed_device_id: Uuid | null
  managed_hostname?: string | null
  first_seen_at: Timestamp
  last_seen_at: Timestamp
  open_ports: number[]
  snmp_sys_descr: string | null
  snmp_sys_name?: string | null
  snmp_sys_object_id?: string | null
  mdns?: string[]
  netbios_name?: string | null
  rtt_ms?: number | null
  notes: string
  ignored: boolean
  /** The SNMP device monitoring this asset, if any. */
  snmp_device_id?: Uuid | null
}

export interface AssetFilters {
  site_id?: string
  type?: AssetType
  managed?: boolean
  q?: string
}

export interface AssetPatch {
  notes?: string
  ignored?: boolean
  /** A manual type; `null` goes back to the guess. */
  type?: AssetType | null
}

export interface NetworkScanEvent {
  scan_id: Uuid
  run_id: Uuid
  status: ScanRunStatus
  hosts_found: number
}

export interface NetworkAssetsEvent {
  site_id: Uuid
  scan_id: Uuid
}

// ---------------------------------------------------------------- SNMP monitoring (Phase 10)

export type SnmpVersion = 'v2c' | 'v3'
export type SnmpAuth = 'none' | 'sha' | 'sha256'
export type SnmpPrivacy = 'none' | 'aes128'

/** Secret fields are write-only and come back masked (`SECRET_MASK`). */
export interface SnmpCredential {
  id: Uuid
  name: string
  version: SnmpVersion
  community?: string | null
  v3?: {
    username: string
    auth: SnmpAuth
    auth_password?: string | null
    privacy: SnmpPrivacy
    privacy_password?: string | null
  } | null
  created_at?: Timestamp
  updated_at?: Timestamp
}

/** Omitted (or masked) secret fields keep the stored value. */
export interface SnmpCredentialInput {
  name: string
  version: SnmpVersion
  community?: string
  v3?: {
    username: string
    auth: SnmpAuth
    auth_password?: string
    privacy: SnmpPrivacy
    privacy_password?: string
  }
}

export type SnmpMetricKind = 'gauge' | 'counter' | 'text'

export interface SnmpThresholds {
  warn?: number | null
  crit?: number | null
  direction: 'above' | 'below'
}

export interface SnmpMetricDef {
  key: string
  label: string
  oid: string
  /** Walk the table under `oid`; each row becomes its own series. */
  table?: boolean
  /** Column whose value names each row (for example `ifDescr`). */
  index_label_oid?: string | null
  /** Report the value as a percentage of this column (same row). */
  max_oid?: string | null
  unit: string
  kind: SnmpMetricKind
  thresholds?: SnmpThresholds | null
}

export interface SnmpTemplate {
  id: Uuid
  name: string
  builtin: boolean
  metrics: SnmpMetricDef[]
  created_at?: Timestamp
  updated_at?: Timestamp
}

export interface SnmpTemplateInput {
  name: string
  metrics: SnmpMetricDef[]
}

export type SnmpDeviceStatus = 'pending' | 'ok' | 'unreachable' | 'alerting'

export interface SnmpDevice {
  id: Uuid
  site_id: Uuid
  site_name?: string
  asset_id: Uuid | null
  name: string
  ip: string
  port: number
  credential_id: Uuid
  template_ids: Uuid[]
  poll_interval_secs: number
  enabled: boolean
  status: SnmpDeviceStatus
  last_poll_at: Timestamp | null
  sys_descr: string | null
  uptime_secs: number | null
  last_error?: string | null
  created_at?: Timestamp
  updated_at?: Timestamp
}

export interface SnmpDeviceInput {
  site_id: Uuid
  asset_id?: Uuid | null
  name: string
  ip: string
  port: number
  credential_id: Uuid
  template_ids: Uuid[]
  poll_interval_secs: number
  enabled: boolean
}

export interface SnmpTestResult {
  ok: boolean
  sys_descr?: string | null
  sys_name?: string | null
  sys_object_id?: string | null
  uptime_secs?: number | null
  error?: string | null
}

export type SnmpValueState = 'ok' | 'warning' | 'critical'

/** One metric row over time; `points` are `[unix seconds, value]`. */
export interface SnmpSeries {
  key: string
  index?: string | null
  /** `Label` or `Label (row label)`. */
  label: string
  unit: string
  points: [number, number][]
}

export interface SnmpCurrentValue {
  key: string
  index?: string | null
  label: string
  unit: string
  value: number | null
  text?: string | null
  state?: SnmpValueState
}

export interface SnmpMetricsResponse {
  range?: MetricsRange
  series: SnmpSeries[]
  /** The latest value of every row, including text values (optional). */
  current?: SnmpCurrentValue[]
}

export interface SnmpVarbind {
  oid: string
  type?: string
  value: unknown
}

export interface SnmpTrap {
  id: Uuid
  site_id: Uuid
  snmp_device_id?: Uuid | null
  snmp_device_name?: string | null
  from_ip: string
  at: Timestamp
  version: string
  oid: string
  varbinds: SnmpVarbind[]
  rule_id?: Uuid | null
  alert_id?: Uuid | null
}

export type TopologyNodeKind = 'probe' | 'asset' | 'snmp' | 'neighbour'

export interface TopologyNode {
  id: string
  kind: TopologyNodeKind
  label: string
  /** An asset type, or the probe's OS family. */
  type?: string | null
  ip?: string | null
  mac?: string | null
  device_id?: Uuid | null
  asset_id?: Uuid | null
  snmp_device_id?: Uuid | null
}

export interface TopologyEdge {
  from: string
  to: string
  kind: string
  local_port?: string | null
}

export interface NetworkTopology {
  nodes: TopologyNode[]
  edges: TopologyEdge[]
}

/** `GET`/`PUT /settings/network` (PUT: global `network.manage` + step-up). */
export interface NetworkSettings {
  allow_public_ranges: boolean
}

/** Raises an alert for traps whose OID starts with `oid_prefix` (most specific enabled rule wins). */
export interface TrapRule {
  id: Uuid
  name: string
  enabled: boolean
  oid_prefix: string
  severity: AlertSeverity
  /** Empty means every site. */
  site_ids: Uuid[]
  title: string
  created_at?: Timestamp
  updated_at?: Timestamp
}

export interface TrapRuleInput {
  name: string
  enabled: boolean
  oid_prefix: string
  severity: AlertSeverity
  site_ids: Uuid[]
  title: string
}

export interface SnmpDeviceEvent {
  id: Uuid
  site_id: Uuid
  status: SnmpDeviceStatus
}

export interface SnmpTrapEvent {
  id: Uuid
  site_id: Uuid
  oid: string
  from_ip: string
}

// ---------------------------------------------------------------- reports (Phase 11)

export type ReportTypeId =
  | 'executive_summary'
  | 'hardware_inventory'
  | 'software_inventory'
  | 'patch_compliance'
  | 'alert_history'
  | 'security_posture'
  | 'agent_status'
  | 'tickets_time'
  | 'audit'

export interface ReportParamSchema {
  name: string
  type: 'string' | 'datetime' | 'array'
  required: boolean
  description: string
}

export interface ReportTypeInfo {
  type: string
  name: string
  description: string
  /** The view permission the report's data needs (besides `reports.view`). */
  permission: string
  parameters: ReportParamSchema[]
}

/** Every type takes the first four; the rest are type-specific. */
export interface ReportParameters {
  /** A client id, or `"all"`/omitted for every client you can see. */
  client_id?: string | null
  site_id?: string | null
  from?: Timestamp | null
  to?: Timestamp | null
  /** `software_inventory`: products to count licences for. */
  products?: string[]
  /** `alert_history`: `critical` | `warning` | `info`. */
  severity?: string | null
  /** `audit`: action prefix. */
  action?: string | null
  /** `audit`: actor id or part of the name. */
  actor?: string | null
}

export type ReportFormat = 'json' | 'csv' | 'pdf'
export type KpiTone = 'good' | 'warn' | 'bad' | 'neutral'
export type ReportColumnFormat = 'text' | 'number' | 'percent' | 'date' | 'datetime' | 'bytes' | 'duration'
export type ReportCell = string | number | boolean | null

export interface ReportKpi {
  label: string
  value: number | string | null
  unit?: string | null
  tone?: KpiTone | null
}

export interface ReportColumn {
  key: string
  label: string
  align?: 'left' | 'right' | null
  format?: ReportColumnFormat | null
}

export interface ReportSeries {
  name: string
  values: number[]
}

export type ReportSection =
  | { kind: 'kpis'; title: string; items: ReportKpi[] }
  | { kind: 'table'; title: string; columns: ReportColumn[]; rows: ReportCell[][]; total_rows?: number | null }
  | { kind: 'chart'; title: string; chart: 'bar' | 'line' | 'donut'; labels: string[]; series: ReportSeries[]; unit?: string | null }
  | { kind: 'text'; title: string; body: string }
  | { kind: 'list'; title: string; items: string[] }

export interface Report {
  type: string
  title: string
  subtitle: string | null
  generated_at: Timestamp
  period: { from: Timestamp; to: Timestamp }
  client: { id: Uuid; name: string } | null
  sections: ReportSection[]
}

export interface ReportRunRequest {
  type: string
  parameters: ReportParameters
  format: ReportFormat
  async?: boolean
}

export type ReportRunStatus = 'queued' | 'running' | 'completed' | 'failed'

export interface ReportRun {
  id: Uuid
  type: string
  title: string
  format: ReportFormat
  status: ReportRunStatus
  trigger: 'manual' | 'schedule'
  schedule_id: Uuid | null
  client_id: Uuid | null
  user_id: Uuid | null
  user_name: string
  file_name: string | null
  size_bytes: number | null
  error: string | null
  emailed_to: string[]
  created_at: Timestamp
  started_at: Timestamp | null
  finished_at: Timestamp | null
  downloadable: boolean
  parameters: ReportParameters
}

/** What `POST /reports/run` produced: a JSON report, a downloaded file, or a queued run (`202`). */
export type ReportRunOutcome =
  | { kind: 'report'; run_id: string; report: Report }
  | { kind: 'file'; run_id: string | null; blob: Blob; file_name: string }
  | { kind: 'queued'; run_id: string }

export interface ReportSchedule {
  id: Uuid
  name: string
  type: string
  parameters: ReportParameters
  format: 'pdf' | 'csv'
  cron: string
  timezone: string
  recipients: string[]
  per_client: boolean
  enabled: boolean
  next_run_at: Timestamp | null
  last_run_at: Timestamp | null
  last_status: 'ok' | 'failed' | null
  last_error: string | null
  /** The creator's user id. */
  created_by: Uuid | null
  created_at: Timestamp
  updated_at: Timestamp
}

export interface ReportScheduleInput {
  name: string
  type: string
  /** `from`/`to` are refused: a scheduled run covers the 30 days before it runs. */
  parameters: Omit<ReportParameters, 'from' | 'to'>
  format: 'pdf' | 'csv'
  cron: string
  timezone: string
  recipients: string[]
  per_client: boolean
  enabled: boolean
}

// ---------------------------------------------------------------- dashboards (Phase 11)

export type WidgetName =
  | 'fleet_health'
  | 'alerts_by_severity'
  | 'alerts_list'
  | 'patch_compliance'
  | 'tickets_open'
  | 'sla_breaches'
  | 'devices_offline'
  | 'os_mix'
  | 'agent_versions'
  | 'top_disk_usage'
  | 'recent_jobs'
  | 'custom_field_breakdown'

export interface WidgetConfig {
  client_id?: string | null
  site_id?: string | null
  /** 1–100, default 10. */
  limit?: number | null
  /** Custom field key (`custom_field_breakdown`). */
  field?: string | null
  /** 1–90 (`recent_jobs`). */
  days?: number | null
  /** A display title chosen in the editor (ignored by the server aggregation). */
  title?: string | null
}

export interface WidgetPlacement {
  widget: WidgetName
  x: number
  y: number
  w: number
  h: number
  config: WidgetConfig
}

export interface Dashboard {
  id: string
  name: string
  /** `null` for the built-in Home layout. */
  owner_id: Uuid | null
  owner_name: string | null
  shared: boolean
  layout: WidgetPlacement[]
  is_default: boolean
  editable: boolean
  created_at: Timestamp
  updated_at: Timestamp
}

export interface DashboardInput {
  name: string
  shared?: boolean
  layout: WidgetPlacement[]
  is_default?: boolean
}

export interface DashboardList {
  items: Dashboard[]
  widgets: WidgetName[]
}

export interface FleetHealthData {
  devices: number
  online: number
  offline: number
  avg_health: number | null
  buckets: { healthy: number; warning: number; critical: number }
}

export interface AlertsBySeverityData {
  total: number
  open: { critical: number; warning: number; info: number }
  acknowledged: number
}

export interface AlertsListData {
  total: number
  items: Alert[]
}

export interface PatchComplianceData {
  devices: number
  compliant: number
  non_compliant: number
  compliance_pct: number | null
  missing_critical: number
  missing_important: number
  pending_reboot: number
  failed: number
}

export interface TicketsOpenData {
  total: number
  by_status: Record<string, number>
  by_priority: Record<string, number>
}

export interface SlaBreachesData {
  total: number
  items: {
    id: Uuid
    number: number
    subject: string
    client_id: Uuid
    status: string
    priority: string
    first_response_breached: boolean
    resolution_breached: boolean
    resolution_due: Timestamp | null
  }[]
}

export interface DevicesOfflineData {
  total: number
  items: { device_id: Uuid; hostname: string; client_id: Uuid; client_name: string; last_seen_at: Timestamp | null }[]
}

export interface OsMixData {
  items: { os: string; family: string; count: number }[]
}

export interface AgentVersionsData {
  latest: string | null
  outdated: number
  items: { version: string; count: number }[]
}

export interface TopDiskUsageData {
  items: { device_id: Uuid; hostname: string; client_name: string; disk_pct: number }[]
}

export interface RecentJobsData {
  items: {
    run_id: Uuid
    job_id: Uuid
    name: string
    status: string
    started_at: Timestamp | null
    finished_at: Timestamp | null
    counts: Record<string, number>
  }[]
}

export interface CustomFieldBreakdownData {
  field: string
  field_name: string
  items: { value: string; count: number }[]
}

export interface WidgetDataMap {
  fleet_health: FleetHealthData
  alerts_by_severity: AlertsBySeverityData
  alerts_list: AlertsListData
  patch_compliance: PatchComplianceData
  tickets_open: TicketsOpenData
  sla_breaches: SlaBreachesData
  devices_offline: DevicesOfflineData
  os_mix: OsMixData
  agent_versions: AgentVersionsData
  top_disk_usage: TopDiskUsageData
  recent_jobs: RecentJobsData
  custom_field_breakdown: CustomFieldBreakdownData
}

export interface WidgetResponse<W extends WidgetName = WidgetName> {
  widget: W
  generated_at: Timestamp
  data: WidgetDataMap[W]
}

// ---------------------------------------------------------------- single sign-on (Phase 11)

export interface SsoRoleMapping {
  group: string
  role_id: Uuid
  scope_type: 'global' | 'client'
  scope_id?: Uuid | null
}

export interface SsoProvider {
  id: Uuid
  name: string
  issuer_url: string
  client_id: string
  has_client_secret: boolean
  scopes: string[]
  /** A top-level claim or a dotted path such as `realm_access.roles`. */
  group_claim: string
  role_mappings: SsoRoleMapping[]
  auto_provision: boolean
  require_local_mfa: boolean
  trust_unverified_email: boolean
  enabled: boolean
  button_label: string
  /** Register this at the identity provider. */
  redirect_uri: string
  created_at: Timestamp
  updated_at: Timestamp
}

export interface SsoProviderInput {
  name: string
  issuer_url: string
  client_id: string
  /** Omit to keep the stored secret, `""` to clear it. */
  client_secret?: string
  scopes: string[]
  group_claim: string
  role_mappings: SsoRoleMapping[]
  auto_provision: boolean
  require_local_mfa: boolean
  trust_unverified_email: boolean
  enabled: boolean
  button_label: string
}

export interface SsoSettings {
  enforce: boolean
}

export interface AuthProviders {
  items: { id: Uuid; button_label: string }[]
  enforced: boolean
}

// ---------------------------------------------------------------- API tokens (Phase 11)

export interface ApiToken {
  id: Uuid
  name: string
  /** `rrmm_pat_Ab3d…` */
  prefix: string
  permissions: string[]
  /** `null` = the creator's full scope. */
  client_ids: Uuid[] | null
  expires_at: Timestamp
  expired: boolean
  /** `null` = any address. */
  allowed_cidrs: string[] | null
  last_used_at: Timestamp | null
  last_used_ip: string | null
  created_at: Timestamp
  /** Only in `?all=true` listings. */
  user?: { id: Uuid; name: string; email: string }
}

export interface ApiTokenCreate {
  name: string
  permissions: string[]
  client_ids?: Uuid[] | null
  expires_at?: Timestamp
  allowed_cidrs?: string[] | null
}

export interface ApiTokenCreated {
  /** The full token, shown once. */
  token: string
  item: ApiToken
}

// ---------------------------------------------------------------- webhooks (Phase 11)

export type WebhookEvent =
  | 'device.enrolled'
  | 'device.offline'
  | 'alert.opened'
  | 'alert.resolved'
  | 'job.completed'
  | 'ticket.created'
  | 'ticket.updated'
  | 'patch_run.completed'
  | 'secret.revealed'

export interface Webhook {
  id: Uuid
  name: string
  url: string
  has_secret: boolean
  events: WebhookEvent[]
  /** `null` = every client (needs `api.manage` installation-wide). */
  client_ids: Uuid[] | null
  enabled: boolean
  last_delivery: { at: Timestamp; status: 'delivered' | 'failed' | 'retrying'; error: string | null } | null
  created_at: Timestamp
  updated_at: Timestamp
  /** Only in the create response, when the server generated the secret. */
  secret?: string
}

export interface WebhookInput {
  name: string
  url: string
  /** Omit to keep (or, on create, to have one generated). 16–256 characters. */
  secret?: string
  events: WebhookEvent[]
  client_ids: Uuid[] | null
  enabled: boolean
}

export interface WebhookList {
  items: Webhook[]
  events: WebhookEvent[]
}

export type WebhookDeliveryStatus = 'pending' | 'sending' | 'delivered' | 'failed'

export interface WebhookDelivery {
  id: Uuid
  webhook_id: Uuid
  event_id: string
  event: string
  status: WebhookDeliveryStatus
  attempts: number
  next_attempt_at: Timestamp | null
  last_attempt_at: Timestamp | null
  response_status: number | null
  error: string | null
  redelivery_of: Uuid | null
  created_at: Timestamp
  delivered_at: Timestamp | null
  /** The exact signed JSON body. */
  payload: unknown
}

// ---------------------------------------------------------------- branding (Phase 11)

export interface BrandingSettings {
  product_name: string
  logo_light_file_id: string | null
  logo_dark_file_id: string | null
  accent_color: string | null
}

export interface PublicBranding {
  product_name: string
  accent_color: string | null
  logo_light_url: string | null
  /** Falls back to the light logo. */
  logo_dark_url: string | null
}

export interface BrandingFile {
  id: string
  content_type: 'image/svg+xml' | 'image/png'
  size_bytes: number
  width: number | null
  height: number | null
  url: string
  /** Whether the SVG sanitiser removed anything. */
  sanitized: boolean
  created_at: Timestamp
}

// ---------------------------------------------------------------- code signing status (Phase 11)

export type SigningSource = 'release' | 'distribution' | 'none'
export type SigningPlatformStatus = 'signed' | 'partially_signed' | 'unsigned' | 'invalid' | 'unknown'
export type SigningFileStatus = 'signed' | 'unsigned' | 'invalid' | 'unknown'
export type SigningFileFormat = 'pe' | 'msi' | 'macho' | 'elf' | 'other'
export type SigningMethod = 'authenticode' | 'apple' | 'adhoc' | 'minisign'

export interface SigningSigner {
  /** Certificate subject (`CN=…, O=…`), or `minisign key <ID>`. */
  subject: string
  issuer: string | null
  /** Certificate serial number (hex). */
  serial: string | null
  /** SHA-1 of the signer certificate (upper-case hex), as Windows shows it. */
  thumbprint_sha1: string | null
  not_before: Timestamp | null
  not_after: Timestamp | null
}

export interface SigningFile {
  file: string
  format: SigningFileFormat
  status: SigningFileStatus
  /** Set when a signature was found (`adhoc` comes with `status: unsigned`). */
  method: SigningMethod | null
  /** Null when unsigned or when the certificate is not embedded. */
  signer: SigningSigner | null
  /** Authenticode/Apple: a countersignature or RFC 3161 timestamp is present. */
  timestamped: boolean | null
  /** PE only: the Authenticode digest matches the file (`false` = modified after signing). */
  digest_valid: boolean | null
  detail: string | null
}

export interface SigningPlatform {
  /** The bundle directory, e.g. `windows-x86_64`, `linux-aarch64`, `macos-universal`. */
  platform: string
  status: SigningPlatformStatus
  files: SigningFile[]
}

/** `GET /settings/signing-status` (`settings.manage` installation-wide). */
export interface SigningStatus {
  /** `release` (newest imported release), `distribution` (no release imported yet) or `none`. */
  source: SigningSource
  version: string | null
  imported_at: Timestamp | null
  platforms: SigningPlatform[]
}

/** Webhook and live-stream `device.offline` data (debounced: once per offline period). */
export interface DeviceOfflineEvent {
  device_id: Uuid
  hostname: string
  client_id: Uuid
  site_id: Uuid
  last_seen_at: Timestamp | null
  /** How the last connection ended. */
  reason: 'disconnected' | 'connection_lost'
  /** The offline threshold that applied. */
  offline_minutes: number
}
