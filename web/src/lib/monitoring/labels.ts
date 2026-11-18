/* Display metadata for alerts, checks, channels and maintenance (Phase 6). */
import type {
  AlertEventKind,
  AlertSeverity,
  AlertSource,
  AlertStatus,
  CheckState,
  CheckTypeDefinition,
  NotificationChannelKind,
  NotificationDeliveryStatus,
  NotificationEvent,
  RemediationStatus,
} from '@/lib/api/types'

export type Tone = 'live' | 'success' | 'warning' | 'critical' | 'info' | 'neutral'

export const SEVERITY_ORDER: AlertSeverity[] = ['critical', 'warning', 'info']
export const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 }
export const SEVERITY_LABEL: Record<AlertSeverity, string> = { critical: 'Critical', warning: 'Warning', info: 'Info' }

export const STATUS_ORDER: AlertStatus[] = ['open', 'acknowledged', 'resolved']
export const STATUS_LABEL: Record<AlertStatus, string> = {
  open: 'Open',
  acknowledged: 'Acknowledged',
  resolved: 'Resolved',
}

export const SOURCE_LABEL: Record<AlertSource, string> = { check: 'Agent check', server: 'Server check', snmp: 'SNMP' }

/** SNMP alert kinds (`check_type` on `source: "snmp"` alerts, Phase 10). */
export const SNMP_CHECK_LABEL: Record<string, string> = {
  threshold: 'SNMP threshold',
  unreachable: 'SNMP device unreachable',
  trap: 'SNMP trap',
}

export const CHECK_STATE_ORDER: CheckState[] = ['critical', 'warning', 'unknown', 'ok']
export const CHECK_STATE_LABEL: Record<CheckState, string> = {
  ok: 'OK',
  warning: 'Warning',
  critical: 'Critical',
  unknown: 'Unknown',
}
export const CHECK_STATE_TONE: Record<CheckState, Tone> = {
  ok: 'success',
  warning: 'warning',
  critical: 'critical',
  unknown: 'neutral',
}

export const REMEDIATION_LABEL: Record<RemediationStatus, string> = {
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
}
export const REMEDIATION_TONE: Record<RemediationStatus, Tone> = {
  running: 'live',
  succeeded: 'success',
  failed: 'critical',
}

export const EVENT_LABEL: Record<AlertEventKind, string> = {
  opened: 'Opened',
  occurred: 'Occurred again',
  severity_changed: 'Severity changed',
  acknowledged: 'Acknowledged',
  unacknowledged: 'Acknowledgement removed',
  snoozed: 'Snoozed',
  assigned: 'Assigned',
  note: 'Note',
  notified: 'Notification sent',
  notification_failed: 'Notification failed',
  remediation_started: 'Remediation started',
  remediation_finished: 'Remediation finished',
  resolved: 'Resolved',
  reopened: 'Reopened',
  maintenance: 'Maintenance',
  ticket_created: 'Ticket created',
}

/** Agent check types in the contract's catalog order; the catalog endpoint is the source of truth. */
export const AGENT_CHECK_TYPES = [
  'cpu',
  'memory',
  'disk',
  'service',
  'process',
  'event_log',
  'script',
  'ping',
  'tcp_port',
  'http',
  'certificate',
  'pending_reboot',
  'antivirus',
  'firewall',
  'uptime',
  'file',
  'windows_update',
  'battery',
] as const

const TYPE_LABEL: Record<string, string> = {
  patching: 'Patching',
  cpu: 'CPU',
  memory: 'Memory',
  disk: 'Disk space',
  service: 'Service',
  process: 'Process',
  event_log: 'Event log',
  script: 'Script',
  ping: 'Ping',
  tcp_port: 'TCP port',
  http: 'HTTP(S)',
  certificate: 'Certificate',
  pending_reboot: 'Pending reboot',
  antivirus: 'Antivirus',
  firewall: 'Firewall',
  uptime: 'Uptime',
  file: 'File',
  windows_update: 'Windows Update',
  battery: 'Battery',
  // Server-side checks.
  offline: 'Offline',
  agent_outdated: 'Agent version',
  disk_forecast: 'Disk forecast',
  security: 'Security change',
}

/** Server check keys used as `check_id` on `source: "server"` alerts. */
export const SERVER_CHECK_LABEL: Record<string, string> = {
  offline: 'Device offline',
  agent_outdated: 'Agent outdated',
  disk_forecast: 'Disk fill forecast',
  'security.local_admin_added': 'New local administrator',
  'security.antivirus_off': 'Antivirus turned off',
  'security.firewall_off': 'Firewall turned off',
  'security.encryption_off': 'Disk encryption turned off',
  'patching.install_failed': 'Patch install failed',
}

/** Server-side check keys, for rule filters (`check_ids`). */
export const SERVER_CHECK_IDS = Object.keys(SERVER_CHECK_LABEL)

export function checkTypeLabel(type: string, catalog?: readonly CheckTypeDefinition[] | null): string {
  const fromCatalog = catalog?.find((item) => item.type === type)?.label
  if (fromCatalog) return fromCatalog
  if (TYPE_LABEL[type]) return TYPE_LABEL[type]
  if (type.startsWith('security')) return TYPE_LABEL.security
  return type.replace(/[_.]+/g, ' ').replace(/^\w/, (letter) => letter.toUpperCase())
}

/** What an alert is about: the server check's name, or the agent check type's label. */
export function alertCheckLabel(
  alert: { source: AlertSource; check_id: string; check_type: string },
  catalog?: readonly CheckTypeDefinition[] | null,
): string {
  if (alert.source === 'server') return SERVER_CHECK_LABEL[alert.check_id] ?? checkTypeLabel(alert.check_type)
  if (alert.source === 'snmp') return SNMP_CHECK_LABEL[alert.check_type] ?? `SNMP ${alert.check_type}`
  return checkTypeLabel(alert.check_type, catalog)
}

/** Units for a check's numeric `value`, by check type. */
const VALUE_FORMAT: Record<string, (value: number) => string> = {
  cpu: (value) => `${round(value)}%`,
  memory: (value) => `${round(value)}%`,
  disk: (value) => `${round(value)}% free`,
  process: (value) => `${round(value)}%`,
  ping: (value) => `${round(value)} ms`,
  tcp_port: (value) => `${round(value)} ms`,
  http: (value) => `${round(value)} ms`,
  certificate: (value) => `${round(value)} days`,
  uptime: (value) => `${round(value)} days`,
  pending_reboot: (value) => `${round(value)} h`,
  antivirus: (value) => `${round(value)} h`,
  windows_update: (value) => `${round(value)} days`,
  battery: (value) => `${round(value)}%`,
  event_log: (value) => `${round(value)} ${round(value) === 1 ? 'event' : 'events'}`,
  file: (value) => `${round(value)}`,
}

function round(value: number) {
  return Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10
}

export function formatCheckValue(type: string, value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return (VALUE_FORMAT[type] ?? ((raw: number) => String(round(raw))))(value)
}

export const CHANNEL_KIND_ORDER: NotificationChannelKind[] = ['email', 'slack', 'teams', 'discord', 'ntfy', 'webhook']
export const CHANNEL_KIND_LABEL: Record<NotificationChannelKind, string> = {
  email: 'Email',
  slack: 'Slack',
  teams: 'Microsoft Teams',
  discord: 'Discord',
  ntfy: 'ntfy',
  webhook: 'Webhook',
}
export const CHANNEL_KIND_DESCRIPTION: Record<NotificationChannelKind, string> = {
  email: 'HTML and plain-text email through the SMTP server.',
  slack: 'A Block Kit message through an incoming webhook.',
  teams: 'An Adaptive Card through a Power Automate “Workflows” webhook.',
  discord: 'An embed through a channel webhook.',
  ntfy: 'Push notifications with the priority mapped from severity.',
  webhook: 'A signed JSON body to your own endpoint.',
}

export const NOTIFICATION_EVENTS: NotificationEvent[] = ['opened', 'severity_changed', 'escalated', 'resolved', 'secret.revealed']
export const NOTIFICATION_EVENT_LABEL: Record<NotificationEvent, string> = {
  opened: 'Opened',
  severity_changed: 'Severity changed',
  escalated: 'Escalated',
  resolved: 'Resolved',
  'secret.revealed': 'Secret revealed',
}

export const DELIVERY_STATUS_LABEL: Record<NotificationDeliveryStatus, string> = {
  pending: 'Retry scheduled',
  sent: 'Sent',
  failed: 'Failed',
  suppressed: 'Quiet hours',
}
export const DELIVERY_STATUS_TONE: Record<NotificationDeliveryStatus, Tone> = {
  pending: 'warning',
  sent: 'success',
  failed: 'critical',
  suppressed: 'neutral',
}

/** Snooze presets offered in menus; the API accepts 15–10080 minutes. */
export const SNOOZE_PRESETS: { minutes: number; label: string; short: string }[] = [
  { minutes: 15, label: '15 minutes', short: '15m' },
  { minutes: 60, label: '1 hour', short: '1h' },
  { minutes: 240, label: '4 hours', short: '4h' },
  { minutes: 1440, label: '1 day', short: '1d' },
  { minutes: 4320, label: '3 days', short: '3d' },
  { minutes: 10_080, label: '1 week', short: '1w' },
]
export const SNOOZE_MIN_MINUTES = 15
export const SNOOZE_MAX_MINUTES = 10_080

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** "45 min", "3 h", "1 h 30 min", "2 d", "1 d 6 h". */
export function formatMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '0 min'
  const total = Math.round(minutes)
  const days = Math.floor(total / 1440)
  const hours = Math.floor((total % 1440) / 60)
  const mins = total % 60
  if (days > 0) return hours ? `${days} d ${hours} h` : `${days} d`
  if (hours > 0) return mins ? `${hours} h ${mins} min` : `${hours} h`
  return `${mins} min`
}

/** "30 s", "5 min", "1 h", "1 d" for check intervals. */
export function formatInterval(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  if (seconds < 60) return `${seconds} s`
  if (seconds % 86_400 === 0) return `${seconds / 86_400} d`
  if (seconds % 3600 === 0) return `${seconds / 3600} h`
  if (seconds % 60 === 0) return `${seconds / 60} min`
  return `${Math.round(seconds / 60)} min`
}

export const INTERVAL_PRESETS = [30, 60, 120, 300, 600, 900, 1800, 3600, 21_600, 86_400]
