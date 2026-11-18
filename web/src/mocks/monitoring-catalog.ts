/* The check-type catalog served by `GET /monitoring/check-types` in mock mode (mirrors the contract table). */
import type { CheckFieldSchema, CheckTypeDefinition } from '@/lib/api/types'

const ALL = ['windows', 'linux', 'macos'] as CheckTypeDefinition['platforms']

const num = (
  key: string,
  label: string,
  defaultValue: number | null,
  extra: Partial<CheckFieldSchema> = {},
): CheckFieldSchema => ({ key, label, type: 'number', required: defaultValue !== null, default: defaultValue, ...extra })

const text = (key: string, label: string, defaultValue: string | null, extra: Partial<CheckFieldSchema> = {}): CheckFieldSchema => ({
  key,
  label,
  type: 'text',
  required: true,
  default: defaultValue,
  ...extra,
})

const bool = (key: string, label: string, defaultValue: boolean): CheckFieldSchema => ({
  key,
  label,
  type: 'boolean',
  required: false,
  default: defaultValue,
})

const select = (key: string, label: string, options: string[], defaultValue: string): CheckFieldSchema => ({
  key,
  label,
  type: 'select',
  required: true,
  default: defaultValue,
  options,
})

export const CHECK_TYPES: CheckTypeDefinition[] = [
  {
    type: 'cpu',
    graded: true,
    label: 'CPU usage',
    description: 'Average processor load over a rolling window.',
    platforms: ALL,
    config_schema: [
      num('warn_pct', 'Warning at', 85, { min: 1, max: 100, unit: '%' }),
      num('crit_pct', 'Critical at', 95, { min: 1, max: 100, unit: '%' }),
      num('window_minutes', 'Averaged over', 5, { min: 1, max: 60, unit: 'min' }),
    ],
  },
  {
    type: 'memory',
    graded: true,
    label: 'Memory usage',
    description: 'Average memory in use over a rolling window.',
    platforms: ALL,
    config_schema: [
      num('warn_pct', 'Warning at', 85, { min: 1, max: 100, unit: '%' }),
      num('crit_pct', 'Critical at', 95, { min: 1, max: 100, unit: '%' }),
      num('window_minutes', 'Averaged over', 5, { min: 1, max: 60, unit: 'min' }),
    ],
  },
  {
    type: 'disk',
    graded: true,
    label: 'Disk space',
    description: 'Free space on a volume. “*” covers every fixed volume and the worst one wins.',
    platforms: ALL,
    config_schema: [
      text('volume', 'Volume', '*', { required: true }),
      num('warn_free_pct', 'Warning below', 15, { required: false, min: 1, max: 99, unit: '%' }),
      num('crit_free_pct', 'Critical below', 5, { required: false, min: 1, max: 99, unit: '%' }),
      num('warn_free_gb', 'Warning below', null, { required: false, min: 1, max: 100_000, unit: 'GB' }),
      num('crit_free_gb', 'Critical below', null, { required: false, min: 1, max: 100_000, unit: 'GB' }),
    ],
  },
  {
    type: 'service',
    graded: false,
    label: 'Service',
    description: 'A Windows service, systemd unit or launchd job is in the expected state.',
    platforms: ALL,
    config_schema: [
      text('name', 'Service name', null),
      select('expected', 'Expected state', ['running', 'stopped'], 'running'),
      bool('auto_restart', 'Try to restart it before alerting', false),
      num('restart_attempts', 'Restart attempts', 2, { min: 1, max: 5 }),
    ],
  },
  {
    type: 'process',
    graded: false,
    label: 'Process',
    description: 'A process is running (or not), optionally within CPU and memory limits.',
    platforms: ALL,
    config_schema: [
      text('name', 'Process name', null),
      select('expected', 'Expected state', ['running', 'not_running'], 'running'),
      num('max_cpu_pct', 'CPU limit', null, { required: false, min: 1, max: 100, unit: '%' }),
      num('max_memory_mb', 'Memory limit', null, { required: false, min: 1, max: 1_048_576, unit: 'MB' }),
    ],
  },
  {
    type: 'event_log',
    graded: false,
    label: 'Event log',
    description: 'Matching Windows event log entries, or systemd journal entries for a unit on Linux.',
    platforms: ['windows', 'linux'],
    config_schema: [
      text('log', 'Log or unit', 'System'),
      text('source', 'Source', null, { required: false }),
      { key: 'event_ids', label: 'Event IDs', type: 'number_list', required: false, default: null, min: 0, max: 65_535 },
      num('min_level', 'Minimum level', 2, { min: 1, max: 4 }),
      num('window_minutes', 'Look back', 15, { min: 1, max: 1440, unit: 'min' }),
      num('threshold', 'Alert at', 1, { min: 1, max: 10_000, unit: 'entries' }),
    ],
  },
  {
    type: 'script',
    graded: true,
    label: 'Script',
    description: 'Runs a script: exit 0 is OK, 1 warning, 2 or anything else critical. The last line of output becomes the message.',
    platforms: ALL,
    config_schema: [
      { key: 'script_id', label: 'Script', type: 'script', required: true, default: null },
      num('timeout_secs', 'Timeout', 60, { min: 5, max: 3600, unit: 's' }),
    ],
  },
  {
    type: 'ping',
    graded: false,
    label: 'Ping',
    description: 'ICMP reachability of a host, measured from the device.',
    platforms: ALL,
    config_schema: [
      text('target', 'Host', null),
      num('count', 'Packets', 3, { min: 1, max: 20 }),
      num('max_loss_pct', 'Maximum loss', 50, { min: 0, max: 100, unit: '%' }),
      num('max_rtt_ms', 'Maximum round trip', null, { required: false, min: 1, max: 10_000, unit: 'ms' }),
    ],
  },
  {
    type: 'tcp_port',
    graded: false,
    label: 'TCP port',
    description: 'A TCP port accepts connections.',
    platforms: ALL,
    config_schema: [
      text('host', 'Host', null),
      num('port', 'Port', null, { required: true, min: 1, max: 65_535 }),
      num('timeout_ms', 'Timeout', 3000, { min: 100, max: 60_000, unit: 'ms' }),
    ],
  },
  {
    type: 'http',
    graded: true,
    label: 'HTTP(S)',
    description: 'An http(s) URL answers with the expected status, keyword, latency and certificate.',
    platforms: ALL,
    config_schema: [
      text('url', 'URL', null),
      select('method', 'Method', ['GET', 'HEAD', 'POST'], 'GET'),
      num('expect_status', 'Expected status', 200, { min: 100, max: 599 }),
      text('keyword', 'Keyword in body', null, { required: false }),
      num('max_latency_ms', 'Maximum latency', null, { required: false, min: 1, max: 60_000, unit: 'ms' }),
      num('cert_warn_days', 'Certificate warning', 14, { required: false, min: 1, max: 365, unit: 'days' }),
      bool('verify_tls', 'Verify the TLS certificate', true),
    ],
  },
  {
    type: 'certificate',
    graded: true,
    label: 'Certificate expiry',
    description: 'Local certificates that are about to expire. The certificate store is Windows only; files work everywhere.',
    platforms: ['windows', 'linux', 'macos'],
    config_schema: [
      select('source', 'Source', ['store', 'file'], 'store'),
      text('store', 'Store', 'LocalMachine\\My', { required: false }),
      text('path', 'File path', null, { required: false }),
      num('warn_days', 'Warning within', 30, { min: 1, max: 365, unit: 'days' }),
      num('crit_days', 'Critical within', 7, { min: 1, max: 365, unit: 'days' }),
    ],
  },
  {
    type: 'pending_reboot',
    graded: false,
    label: 'Pending reboot',
    description: 'A restart has been pending for too long.',
    platforms: ALL,
    config_schema: [num('warn_after_hours', 'Warn after', 72, { min: 1, max: 2160, unit: 'h' })],
  },
  {
    type: 'antivirus',
    graded: true,
    label: 'Antivirus',
    description: 'Real-time protection is on and signatures are recent. Critical when protection is off.',
    platforms: ['windows'],
    config_schema: [num('max_signature_age_hours', 'Maximum signature age', 72, { min: 1, max: 720, unit: 'h' })],
  },
  {
    type: 'firewall',
    graded: true,
    label: 'Firewall',
    description: 'Critical when any firewall profile is disabled.',
    platforms: ALL,
    config_schema: [],
  },
  {
    type: 'uptime',
    graded: true,
    label: 'Uptime',
    description: 'Time since the last restart.',
    platforms: ALL,
    config_schema: [
      num('warn_days', 'Warning after', 30, { min: 1, max: 3650, unit: 'days' }),
      num('crit_days', 'Critical after', 60, { min: 1, max: 3650, unit: 'days' }),
    ],
  },
  {
    type: 'file',
    graded: false,
    label: 'File',
    description: 'A file exists, is missing, is older or larger than a limit.',
    platforms: ALL,
    config_schema: [
      text('path', 'Path', null),
      select('condition', 'Alert when the file', ['exists', 'missing', 'older_than', 'larger_than'], 'missing'),
      num('minutes', 'Age', null, { required: false, min: 1, max: 525_600, unit: 'min' }),
      num('size_mb', 'Size', null, { required: false, min: 1, max: 1_048_576, unit: 'MB' }),
    ],
  },
  {
    type: 'windows_update',
    graded: false,
    label: 'Windows Update',
    description: 'Days since updates were last installed, and failed installs.',
    platforms: ['windows'],
    config_schema: [
      num('warn_days_since_install', 'Warning after', 35, { min: 1, max: 365, unit: 'days' }),
      bool('alert_on_failures', 'Alert on failed installs', true),
    ],
  },
  {
    type: 'battery',
    graded: false,
    label: 'Battery health',
    description: 'Battery capacity compared with its design capacity. Devices with a battery only.',
    platforms: ['windows', 'macos', 'linux'],
    config_schema: [num('min_health_pct', 'Minimum health', 60, { min: 1, max: 100, unit: '%' })],
  },
]

export function checkTypeDefinition(type: string | undefined): CheckTypeDefinition | undefined {
  return CHECK_TYPES.find((item) => item.type === type)
}
