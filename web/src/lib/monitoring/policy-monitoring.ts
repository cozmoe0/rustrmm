/*
 * The policy document's `monitoring` section: validation (the rules the server applies), the layered
 * merge (checks merge by id; `config` and `remediation` deep-merge; a different `type` redefines the
 * check), compaction, the device page's effective rows and helpers for the editor.
 */
import type {
  AlertSeverity,
  CheckState,
  CheckTypeDefinition,
  EffectivePolicy,
  MonitoringCheck,
  MonitoringServerSection,
  OsFamily,
  PolicyMonitoringSection,
} from '@/lib/api/types'
import { cleanConfig, defaultConfig, describeConfig, validateCheckConfig, type CheckConfig } from './check-schema'
import { AGENT_CHECK_TYPES, checkTypeLabel, formatInterval, formatMinutes, SEVERITY_LABEL } from './labels'

/** Same shape as a policy issue: a dotted path and a message. */
export interface MonitoringIssue {
  path: string
  message: string
}

export const CHECK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
export const INTERVAL_MIN = 30
export const INTERVAL_MAX = 86_400
export const DEFAULT_INTERVAL_SECS = 300
export const DEFAULT_SEVERITY: AlertSeverity = 'warning'
export const MAX_CHECKS = 100
export const MAX_ATTEMPTS_MAX = 10
export const SEVERITIES: AlertSeverity[] = ['info', 'warning', 'critical']
export const PLATFORMS: OsFamily[] = ['windows', 'linux', 'macos']

const CHECK_KEYS = ['id', 'type', 'name', 'enabled', 'interval_secs', 'severity', 'config', 'remediation', 'platforms']

export type ServerKey = keyof MonitoringServerSection

export const SERVER_SETTINGS: Record<
  ServerKey,
  {
    label: string
    description: string
    kind: 'minutes' | 'days' | 'severity' | 'boolean'
    /** The server's default for an unset key (offline minutes come from the monitoring settings). */
    fallback: number | boolean | AlertSeverity
    max?: number
  }
> = {
  offline_minutes: {
    label: 'Offline alert',
    description: 'Alert when a device has not been seen for this long. 0 turns the offline alert off.',
    kind: 'minutes',
    fallback: 15,
    max: 10_080,
  },
  offline_severity: {
    label: 'Offline severity',
    description: 'Severity of the offline alert.',
    kind: 'severity',
    fallback: 'critical',
  },
  agent_outdated: {
    label: 'Outdated agent',
    description: 'Alert when two or more imported releases are newer than the agent.',
    kind: 'boolean',
    fallback: true,
  },
  disk_forecast_days: {
    label: 'Disk fill forecast',
    description: 'Alert when 7 days of metrics predict a full volume within this many days. 0 turns it off.',
    kind: 'days',
    fallback: 14,
    max: 365,
  },
  security_changes: {
    label: 'Security changes',
    description: 'Alert on new local administrators, and on antivirus, firewall or disk encryption being turned off.',
    kind: 'boolean',
    fallback: true,
  },
}

export const SERVER_KEYS = Object.keys(SERVER_SETTINGS) as ServerKey[]

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A check without `type` is a partial override of a check that an earlier layer defined. */
export function isOverride(check: Pick<MonitoringCheck, 'type'>): boolean {
  return !check.type
}

/**
 * Alert severity for a failing state: graded types follow the state, the others take the check's
 * configured severity, and `unknown` maps to info.
 */
export function severityFor(
  check: Pick<MonitoringCheck, 'severity'>,
  state: CheckState,
  graded: boolean,
): AlertSeverity {
  if (state === 'unknown') return 'info'
  if (graded) return state === 'critical' ? 'critical' : 'warning'
  return check.severity ?? DEFAULT_SEVERITY
}

/** Whether a check type supports a platform, honouring the check's own `platforms` limit. */
export function checkRunsOn(
  check: Pick<MonitoringCheck, 'platforms'>,
  definition: Pick<CheckTypeDefinition, 'platforms'> | undefined,
  os: OsFamily,
): boolean {
  if (definition && !definition.platforms.includes(os)) return false
  return !check.platforms?.length || check.platforms.includes(os)
}

// ------------------------------------------------------------------ validation

export function validateMonitoring(value: unknown, catalog?: readonly CheckTypeDefinition[] | null): MonitoringIssue[] {
  const issues: MonitoringIssue[] = []
  if (!isObject(value)) return [{ path: 'monitoring', message: 'Must be an object' }]
  for (const key of Object.keys(value)) {
    if (key !== 'checks' && key !== 'server') issues.push({ path: `monitoring.${key}`, message: `Unknown setting “${key}”` })
  }
  const knownTypes = catalog?.length ? catalog.map((item) => item.type) : [...AGENT_CHECK_TYPES]

  if (value.checks !== undefined) {
    if (!Array.isArray(value.checks)) issues.push({ path: 'monitoring.checks', message: 'Must be a list' })
    else {
      if (value.checks.length > MAX_CHECKS)
        issues.push({ path: 'monitoring.checks', message: `At most ${MAX_CHECKS} checks per policy` })
      const ids = new Set<string>()
      value.checks.forEach((check: unknown, index) => {
        const base = `monitoring.checks[${index}]`
        if (!isObject(check)) {
          issues.push({ path: base, message: 'Must be an object' })
          return
        }
        if (typeof check.id !== 'string' || !CHECK_ID_PATTERN.test(check.id))
          issues.push({ path: `${base}.id`, message: 'Use 1–64 letters, digits, dashes or underscores' })
        else if (ids.has(check.id)) issues.push({ path: `${base}.id`, message: `Duplicate check id “${check.id}”` })
        else ids.add(check.id)
        for (const key of Object.keys(check)) {
          if (!CHECK_KEYS.includes(key)) issues.push({ path: `${base}.${key}`, message: `Unknown check setting “${key}”` })
        }
        const override = check.type === undefined
        if (!override && (typeof check.type !== 'string' || !knownTypes.includes(check.type)))
          issues.push({ path: `${base}.type`, message: `Unknown check type “${String(check.type)}”` })
        if (check.name !== undefined && (typeof check.name !== 'string' || !check.name.trim() || check.name.length > 120))
          issues.push({ path: `${base}.name`, message: 'Enter a name (up to 120 characters)' })
        if (check.enabled !== undefined && typeof check.enabled !== 'boolean')
          issues.push({ path: `${base}.enabled`, message: 'Must be true or false' })
        if (check.interval_secs !== undefined) {
          const interval = check.interval_secs
          if (typeof interval !== 'number' || !Number.isInteger(interval) || interval < INTERVAL_MIN || interval > INTERVAL_MAX)
            issues.push({ path: `${base}.interval_secs`, message: `Must be ${INTERVAL_MIN}–${INTERVAL_MAX} seconds` })
        }
        if (check.severity !== undefined && !SEVERITIES.includes(check.severity as AlertSeverity))
          issues.push({ path: `${base}.severity`, message: 'Must be info, warning or critical' })
        if (check.platforms !== undefined) {
          if (
            !Array.isArray(check.platforms) ||
            check.platforms.some((item) => !PLATFORMS.includes(item as OsFamily)) ||
            new Set(check.platforms).size !== check.platforms.length
          )
            issues.push({ path: `${base}.platforms`, message: 'Choose from windows, linux and macos' })
        }
        if (check.config !== undefined) {
          if (!isObject(check.config)) issues.push({ path: `${base}.config`, message: 'Must be an object' })
          else if (!override && typeof check.type === 'string') {
            const definition = catalog?.find((item) => item.type === check.type)
            if (definition) {
              for (const [key, message] of Object.entries(validateCheckConfig(definition, check.config as CheckConfig)))
                issues.push({ path: `${base}.config.${key}`, message })
            }
          }
        }
        if (check.remediation !== undefined && check.remediation !== null) {
          const remediation = check.remediation
          if (!isObject(remediation)) issues.push({ path: `${base}.remediation`, message: 'Must be an object' })
          else {
            if (!override || remediation.script_id !== undefined) {
              if (typeof remediation.script_id !== 'string' || !remediation.script_id)
                issues.push({ path: `${base}.remediation.script_id`, message: 'Choose a script' })
            }
            if (remediation.parameters !== undefined && !isObject(remediation.parameters))
              issues.push({ path: `${base}.remediation.parameters`, message: 'Must be an object' })
            const attempts = remediation.max_attempts
            if (
              attempts !== undefined &&
              (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 1 || attempts > MAX_ATTEMPTS_MAX)
            )
              issues.push({ path: `${base}.remediation.max_attempts`, message: `Must be 1–${MAX_ATTEMPTS_MAX}` })
          }
        }
      })
    }
  }

  if (value.server !== undefined) {
    if (!isObject(value.server)) issues.push({ path: 'monitoring.server', message: 'Must be an object' })
    else {
      for (const [key, raw] of Object.entries(value.server)) {
        const path = `monitoring.server.${key}`
        const meta = SERVER_SETTINGS[key as ServerKey]
        if (!meta) issues.push({ path, message: `Unknown setting “${key}”` })
        else if (meta.kind === 'boolean') {
          if (typeof raw !== 'boolean') issues.push({ path, message: 'Must be true or false' })
        } else if (meta.kind === 'severity') {
          if (!SEVERITIES.includes(raw as AlertSeverity)) issues.push({ path, message: 'Must be info, warning or critical' })
        } else if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > (meta.max ?? Infinity)) {
          issues.push({ path, message: `Must be a whole number from 0 to ${meta.max}` })
        }
      }
    }
  }
  return issues
}

// ------------------------------------------------------------------ compaction & merge

/** Drops an empty server block and blank optional config values; returns undefined when nothing is set. */
export function compactMonitoring(
  section: PolicyMonitoringSection | undefined,
  catalog?: readonly CheckTypeDefinition[] | null,
): PolicyMonitoringSection | undefined {
  if (!section) return undefined
  const out: PolicyMonitoringSection = {}
  if (section.checks?.length) {
    out.checks = section.checks.map((check) => {
      const definition = check.type ? catalog?.find((item) => item.type === check.type) : undefined
      const next: MonitoringCheck = { ...check }
      if (next.config && definition) next.config = cleanConfig(definition.config_schema, next.config)
      if (next.remediation === undefined) delete next.remediation
      if (next.platforms && next.platforms.length === 0) delete next.platforms
      return next
    })
  }
  const server = Object.fromEntries(
    Object.entries(section.server ?? {}).filter(([, value]) => value !== undefined && value !== null),
  ) as MonitoringServerSection
  if (Object.keys(server).length) out.server = server
  return out.checks || out.server ? out : undefined
}

/**
 * Merges monitoring sections in layer order (later wins). A check with a new id, or with a different
 * `type` than the merged one, (re)defines the check; otherwise its fields replace the earlier ones and
 * `config` and `remediation` deep-merge key by key. Origins: `monitoring.checks.<id>` is the last policy
 * that touched the check, `monitoring.server.<key>` the policy that set each server setting.
 */
export function mergeMonitoringLayers(
  layers: { policyId: string; monitoring: PolicyMonitoringSection | undefined }[],
): { monitoring: PolicyMonitoringSection | undefined; origins: Record<string, string> } {
  const origins: Record<string, string> = {}
  const checks: MonitoringCheck[] = []
  let server: MonitoringServerSection | undefined
  for (const { policyId, monitoring } of layers) {
    if (!monitoring) continue
    for (const check of monitoring.checks ?? []) {
      const index = checks.findIndex((item) => item.id === check.id)
      origins[`monitoring.checks.${check.id}`] = policyId
      if (index < 0 || (check.type && check.type !== checks[index].type)) {
        const fresh: MonitoringCheck = {
          ...check,
          ...(check.config ? { config: { ...check.config } } : {}),
          ...(check.remediation ? { remediation: { ...check.remediation } } : {}),
        }
        if (index < 0) checks.push(fresh)
        else checks[index] = fresh
        continue
      }
      const current = checks[index]
      const merged: MonitoringCheck = { ...current }
      for (const [key, value] of Object.entries(check) as [keyof MonitoringCheck, unknown][]) {
        if (key === 'id' || value === undefined) continue
        if (key === 'config' && isObject(value)) merged.config = { ...current.config, ...(value as CheckConfig) }
        else if (key === 'remediation' && isObject(value) && current.remediation)
          merged.remediation = { ...current.remediation, ...(value as MonitoringCheck['remediation']) }
        else (merged as unknown as Record<string, unknown>)[key] = value
      }
      checks[index] = merged
    }
    for (const [key, value] of Object.entries(monitoring.server ?? {})) {
      if (value === undefined) continue
      server = { ...server, [key]: value }
      origins[`monitoring.server.${key}`] = policyId
    }
  }
  if (!checks.length && !server) return { monitoring: undefined, origins }
  return { monitoring: { ...(checks.length ? { checks } : {}), ...(server ? { server } : {}) }, origins }
}

// ------------------------------------------------------------------ editor helpers

export function checkIdFromName(name: string, taken: readonly string[] = []): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 56) || 'check'
  let id = base
  let suffix = 2
  while (taken.includes(id)) {
    id = `${base}-${suffix}`
    suffix += 1
  }
  return id
}

const TYPE_INTERVAL: Record<string, number> = {
  cpu: 60,
  memory: 60,
  disk: 300,
  service: 60,
  process: 60,
  event_log: 300,
  script: 900,
  ping: 60,
  tcp_port: 60,
  http: 120,
  certificate: 21_600,
  pending_reboot: 3600,
  antivirus: 1800,
  firewall: 600,
  uptime: 3600,
  file: 600,
  windows_update: 21_600,
  battery: 21_600,
}

const TYPE_SEVERITY: Record<string, AlertSeverity> = {
  service: 'critical',
  process: 'warning',
  ping: 'critical',
  tcp_port: 'critical',
  pending_reboot: 'info',
  battery: 'info',
}

/** A new, enabled check of the given type with the schema defaults. */
export function newCheck(definition: CheckTypeDefinition, taken: readonly string[]): MonitoringCheck {
  return {
    id: checkIdFromName(definition.label, taken),
    type: definition.type,
    name: definition.label,
    enabled: true,
    interval_secs: TYPE_INTERVAL[definition.type] ?? DEFAULT_INTERVAL_SECS,
    severity: TYPE_SEVERITY[definition.type] ?? DEFAULT_SEVERITY,
    config: defaultConfig(definition.config_schema),
  }
}

/** Short chips for the policy list, e.g. "6 checks", "Offline alert 15 min". */
export function monitoringHighlights(section: PolicyMonitoringSection | undefined): string[] {
  if (!section) return []
  const out: string[] = []
  const checks = section.checks ?? []
  const full = checks.filter((check) => !isOverride(check)).length
  const overrides = checks.length - full
  if (full) out.push(`${full} ${full === 1 ? 'check' : 'checks'}`)
  if (overrides) out.push(`${overrides} check ${overrides === 1 ? 'override' : 'overrides'}`)
  const offline = section.server?.offline_minutes
  if (offline !== undefined) out.push(offline === 0 ? 'Offline alert off' : `Offline alert ${formatMinutes(offline)}`)
  return out
}

// ------------------------------------------------------------------ effective view

export interface EffectiveCheckRow {
  id: string
  name: string
  type: string | undefined
  typeLabel: string
  enabled: boolean
  /** The configured severity; for graded types the alert follows the state instead. */
  severity: AlertSeverity
  graded: boolean
  interval: string
  platforms: OsFamily[] | undefined
  summary: string
  hasRemediation: boolean
  /** The last policy that touched the check. */
  origin: { id: string; name: string } | null
}

export interface EffectiveServerRow {
  key: ServerKey
  label: string
  description: string
  value: string
  raw: unknown
  origin: { id: string; name: string } | null
}

export function effectiveMonitoring(
  effective: Pick<EffectivePolicy, 'document' | 'origins' | 'sources'>,
  catalog?: readonly CheckTypeDefinition[] | null,
  settingsOfflineMinutes = 15,
): { checks: EffectiveCheckRow[]; server: EffectiveServerRow[] } {
  const names = new Map(effective.sources.map((source) => [source.policy_id, source.policy_name]))
  const policy = (id: string | undefined) => (id ? { id, name: names.get(id) ?? 'Unknown policy' } : null)
  const section = effective.document.monitoring
  const checks = (section?.checks ?? []).map((check): EffectiveCheckRow => {
    const definition = check.type ? catalog?.find((item) => item.type === check.type) : undefined
    return {
      id: check.id,
      name: check.name ?? definition?.label ?? (check.type ? checkTypeLabel(check.type) : check.id),
      type: check.type,
      typeLabel: check.type ? checkTypeLabel(check.type, catalog ?? undefined) : 'Override',
      enabled: check.enabled !== false,
      severity: check.severity ?? DEFAULT_SEVERITY,
      graded: Boolean(definition?.graded),
      interval: formatInterval(check.interval_secs ?? DEFAULT_INTERVAL_SECS),
      platforms: check.platforms,
      summary: describeConfig(definition, check.config ?? {}),
      hasRemediation: Boolean(check.remediation?.script_id),
      origin: policy(effective.origins[`monitoring.checks.${check.id}`]),
    }
  })
  const server = SERVER_KEYS.map((key): EffectiveServerRow => {
    const meta = SERVER_SETTINGS[key]
    const raw = section?.server?.[key]
    const fallback = key === 'offline_minutes' ? settingsOfflineMinutes : meta.fallback
    const value = raw ?? fallback
    let text: string
    if (meta.kind === 'boolean') text = value ? 'On' : 'Off'
    else if (meta.kind === 'severity') text = SEVERITY_LABEL[value as AlertSeverity]
    else if (meta.kind === 'minutes') text = value === 0 ? 'Off' : `After ${formatMinutes(value as number)}`
    else text = value === 0 ? 'Off' : `Within ${value} days`
    return {
      key,
      label: meta.label,
      description: meta.description,
      value: text,
      raw,
      origin: policy(effective.origins[`monitoring.server.${key}`]),
    }
  })
  return { checks, server }
}
