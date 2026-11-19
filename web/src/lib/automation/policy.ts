/*
 * Policy documents: section metadata, validation (the same rules the server applies), the layered
 * merge that produces a device's effective policy with per-leaf origins, and display helpers.
 */
import type {
  CheckTypeDefinition,
  DesktopConsentMode,
  EffectivePolicy,
  EffectivePolicySource,
  PolicyAgentSection,
  PolicyDocument,
  PolicyRemoteAccessSection,
  PolicyTargetType,
  PolicyTask,
} from '@/lib/api/types'
import { isValidCron, isValidTimeZone } from '@/lib/cron'
import {
  compactMonitoring,
  mergeMonitoringLayers,
  monitoringHighlights,
  validateMonitoring,
} from '@/lib/monitoring/policy-monitoring'
import { compactPatching, mergePatchingLayers, patchingHighlights, validatePatching } from '@/lib/patching/policy'
import { compactEscrow, escrowHighlights, mergeEscrowLayers, validateEscrow } from '@/lib/escrow/policy'

export const POLICY_SECTIONS = ['agent', 'remote_access', 'tasks', 'monitoring', 'patching', 'escrow'] as const
export type PolicySection = (typeof POLICY_SECTIONS)[number]

export const SECTION_LABEL: Record<PolicySection, string> = {
  agent: 'Agent intervals',
  remote_access: 'Remote access',
  tasks: 'Scheduled tasks',
  monitoring: 'Monitoring',
  patching: 'Patching',
  escrow: 'Secrets escrow',
}

export type AgentKey = keyof PolicyAgentSection
/** The allow/block switches of `remote_access`. */
export type RemoteKey = 'shell' | 'files' | 'system' | 'power' | 'desktop'
/** Phase 8: how remote desktop sessions run (consent, banner, view-only). */
export type DesktopPolicyKey = 'desktop_consent' | 'consent_timeout_secs' | 'desktop_banner' | 'desktop_view_only'

export const AGENT_SETTINGS: Record<
  AgentKey,
  { label: string; description: string; min: number; max: number; fallback: number; unit: 'seconds' | 'minutes' }
> = {
  heartbeat_secs: {
    label: 'Heartbeat',
    description: 'How often the agent checks in. Lower values detect outages sooner.',
    min: 10,
    max: 300,
    fallback: 30,
    unit: 'seconds',
  },
  metrics_secs: {
    label: 'Metrics sampling',
    description: 'How often CPU, memory, disk and network samples are reported.',
    min: 10,
    max: 600,
    fallback: 60,
    unit: 'seconds',
  },
  inventory_minutes: {
    label: 'Inventory refresh',
    description: 'How often hardware, software and security inventory is collected.',
    min: 15,
    max: 1440,
    fallback: 240,
    unit: 'minutes',
  },
}

export const AGENT_KEYS = Object.keys(AGENT_SETTINGS) as AgentKey[]

export const REMOTE_SETTINGS: Record<RemoteKey, { label: string; description: string }> = {
  shell: { label: 'Remote shell', description: 'Interactive, recorded terminals on the device.' },
  files: { label: 'File browser', description: 'Browsing, uploading and downloading files.' },
  system: { label: 'System tools', description: 'Processes, services, event logs, registry and diagnostics.' },
  power: { label: 'Power and messages', description: 'Restart, shut down, lock, sign out and message users.' },
  desktop: { label: 'Remote desktop', description: 'Viewing and controlling the screen, and screenshots.' },
}

export const REMOTE_KEYS = Object.keys(REMOTE_SETTINGS) as RemoteKey[]

export const DESKTOP_CONSENT_LABEL: Record<DesktopConsentMode, string> = {
  never: 'Never ask',
  always: 'Always ask',
  when_user_present: 'Ask when a user is present',
}

export const CONSENT_TIMEOUT_RANGE = { min: 5, max: 300 } as const

/** Values that apply when no policy sets a key (docs/api-desktop.md). */
export const DESKTOP_POLICY_DEFAULTS = {
  desktop_consent: 'never' as DesktopConsentMode,
  consent_timeout_secs: 30,
  desktop_banner: true,
  desktop_view_only: false,
}

export const DESKTOP_POLICY_SETTINGS: Record<DesktopPolicyKey, { label: string; description: string }> = {
  desktop_consent: {
    label: 'Ask the user first',
    description: 'Whether the signed-in user must allow a remote desktop session or screenshot. Nobody is asked on the sign-in screen.',
  },
  consent_timeout_secs: { label: 'Consent timeout', description: 'How long the user has to answer; no answer means denied.' },
  desktop_banner: { label: 'On-screen banner', description: 'Shows “Remote session in progress” with the technician’s name on the device.' },
  desktop_view_only: { label: 'Force view-only', description: 'Technicians can watch the screen but never send input.' },
}

export const DESKTOP_POLICY_KEYS = Object.keys(DESKTOP_POLICY_SETTINGS) as DesktopPolicyKey[]

/** Validates one desktop policy value with the server's rules; returns an error message or null. */
export function validateDesktopPolicyValue(key: DesktopPolicyKey, raw: unknown): string | null {
  switch (key) {
    case 'desktop_consent':
      return raw === 'never' || raw === 'always' || raw === 'when_user_present' ? null : 'Must be never, always or when_user_present'
    case 'consent_timeout_secs':
      if (typeof raw !== 'number' || !Number.isInteger(raw)) return 'Must be a whole number'
      return raw < CONSENT_TIMEOUT_RANGE.min || raw > CONSENT_TIMEOUT_RANGE.max
        ? `Must be between ${CONSENT_TIMEOUT_RANGE.min} and ${CONSENT_TIMEOUT_RANGE.max} seconds`
        : null
    case 'desktop_banner':
    case 'desktop_view_only':
      return typeof raw === 'boolean' ? null : 'Must be true or false'
  }
}

export function formatDesktopPolicyValue(key: DesktopPolicyKey, value: unknown): string {
  switch (key) {
    case 'desktop_consent':
      return DESKTOP_CONSENT_LABEL[value as DesktopConsentMode] ?? String(value)
    case 'consent_timeout_secs':
      return `${String(value)} s`
    case 'desktop_banner':
      return value ? 'Shown' : 'Hidden'
    case 'desktop_view_only':
      return value ? 'Forced' : 'Off'
  }
}

const isRemoteKey = (key: string): key is RemoteKey => key in REMOTE_SETTINGS
const isDesktopPolicyKey = (key: string): key is DesktopPolicyKey => key in DESKTOP_POLICY_SETTINGS

export const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

export const TARGET_TYPE_LABEL: Record<PolicyTargetType, string> = {
  global: 'Everywhere',
  client: 'Client',
  site: 'Site',
  group: 'Group',
  device: 'Device',
}

/** Layer order: later layers win. */
export const TARGET_ORDER: PolicyTargetType[] = ['global', 'client', 'site', 'group', 'device']

// ------------------------------------------------------------------ validation

export interface PolicyIssue {
  /** Dotted path such as `agent.heartbeat_secs` or `tasks[1].cron`; empty for the whole document. */
  path: string
  message: string
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export interface PolicyValidationOptions {
  /** The check-type catalog; when given, check configs are validated against their schema. */
  checkTypes?: readonly CheckTypeDefinition[] | null
}

export function validatePolicyDocument(value: unknown, options: PolicyValidationOptions = {}): PolicyIssue[] {
  const issues: PolicyIssue[] = []
  if (!isObject(value)) return [{ path: '', message: 'The policy must be a JSON object' }]

  for (const key of Object.keys(value)) {
    if (!(POLICY_SECTIONS as readonly string[]).includes(key))
      issues.push({ path: key, message: `Unknown section “${key}”` })
  }

  if (value.agent !== undefined) {
    if (!isObject(value.agent)) issues.push({ path: 'agent', message: 'Must be an object' })
    else {
      for (const [key, raw] of Object.entries(value.agent)) {
        const meta = AGENT_SETTINGS[key as AgentKey]
        const path = `agent.${key}`
        if (!meta) issues.push({ path, message: `Unknown setting “${key}”` })
        else if (typeof raw !== 'number' || !Number.isInteger(raw))
          issues.push({ path, message: 'Must be a whole number' })
        else if (raw < meta.min || raw > meta.max)
          issues.push({ path, message: `Must be between ${meta.min} and ${meta.max} ${meta.unit}` })
      }
    }
  }

  if (value.remote_access !== undefined) {
    if (!isObject(value.remote_access)) issues.push({ path: 'remote_access', message: 'Must be an object' })
    else {
      for (const [key, raw] of Object.entries(value.remote_access)) {
        const path = `remote_access.${key}`
        if (isRemoteKey(key)) {
          if (typeof raw !== 'boolean') issues.push({ path, message: 'Must be true or false' })
        } else if (isDesktopPolicyKey(key)) {
          const message = validateDesktopPolicyValue(key, raw)
          if (message) issues.push({ path, message })
        } else issues.push({ path, message: `Unknown setting “${key}”` })
      }
    }
  }

  if (value.tasks !== undefined) {
    if (!Array.isArray(value.tasks)) issues.push({ path: 'tasks', message: 'Must be a list' })
    else {
      const ids = new Set<string>()
      value.tasks.forEach((task: unknown, index) => {
        const base = `tasks[${index}]`
        if (!isObject(task)) {
          issues.push({ path: base, message: 'Must be an object' })
          return
        }
        if (typeof task.id !== 'string' || !TASK_ID_PATTERN.test(task.id)) {
          issues.push({ path: `${base}.id`, message: 'Use lower-case letters, digits and dashes (max 64)' })
        } else if (ids.has(task.id)) issues.push({ path: `${base}.id`, message: `Duplicate task id “${task.id}”` })
        else ids.add(task.id)
        if (typeof task.name !== 'string' || !task.name.trim())
          issues.push({ path: `${base}.name`, message: 'Enter a name' })
        if (typeof task.script_id !== 'string' || !task.script_id)
          issues.push({ path: `${base}.script_id`, message: 'Choose a script' })
        if (task.parameters !== undefined && !isObject(task.parameters))
          issues.push({ path: `${base}.parameters`, message: 'Must be an object' })
        if (typeof task.cron !== 'string' || !isValidCron(task.cron))
          issues.push({ path: `${base}.cron`, message: 'Enter a valid 5-field cron expression' })
        if (typeof task.timezone !== 'string' || !isValidTimeZone(task.timezone))
          issues.push({ path: `${base}.timezone`, message: 'Choose a valid time zone' })
        if (typeof task.enabled !== 'boolean')
          issues.push({ path: `${base}.enabled`, message: 'Must be true or false' })
        if (task.offline_wait_minutes !== undefined) {
          const wait = task.offline_wait_minutes
          if (typeof wait !== 'number' || !Number.isInteger(wait) || wait < 0 || wait > 10_080) {
            issues.push({ path: `${base}.offline_wait_minutes`, message: 'Must be 0–10080 minutes' })
          }
        }
        for (const key of Object.keys(task)) {
          if (
            !['id', 'name', 'script_id', 'parameters', 'cron', 'timezone', 'enabled', 'offline_wait_minutes'].includes(
              key,
            )
          ) {
            issues.push({ path: `${base}.${key}`, message: `Unknown task setting “${key}”` })
          }
        }
      })
    }
  }

  if (value.monitoring !== undefined) issues.push(...validateMonitoring(value.monitoring, options.checkTypes))
  if (value.patching !== undefined) issues.push(...validatePatching(value.patching))
  if (value.escrow !== undefined) issues.push(...validateEscrow(value.escrow))
  return issues
}

/** Parses the Advanced editor's text: JSON syntax errors carry a line number when the engine reports a position. */
export function parsePolicyJson(
  text: string,
  options: PolicyValidationOptions = {},
): { document: PolicyDocument | null; issues: PolicyIssue[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid JSON'
    const position = /position (\d+)/i.exec(message)
    const line = position ? text.slice(0, Number(position[1])).split('\n').length : null
    return {
      document: null,
      issues: [{ path: '', message: line ? `JSON syntax error on line ${line}` : 'JSON syntax error' }],
    }
  }
  const issues = validatePolicyDocument(parsed, options)
  return { document: issues.length === 0 ? (parsed as PolicyDocument) : null, issues }
}

/** Drops empty sections so the stored document only carries what the policy actually sets. */
export function compactPolicy(doc: PolicyDocument, checkTypes?: readonly CheckTypeDefinition[] | null): PolicyDocument {
  const out: PolicyDocument = {}
  const agent = Object.fromEntries(
    Object.entries(doc.agent ?? {}).filter(([, value]) => value !== undefined && value !== null),
  )
  if (Object.keys(agent).length) out.agent = agent as PolicyAgentSection
  const remote = Object.fromEntries(
    Object.entries(doc.remote_access ?? {}).filter(([key, value]) =>
      isRemoteKey(key) ? typeof value === 'boolean' : isDesktopPolicyKey(key) && validateDesktopPolicyValue(key, value) === null,
    ),
  )
  if (Object.keys(remote).length) out.remote_access = remote as PolicyRemoteAccessSection
  if (doc.tasks?.length) out.tasks = doc.tasks
  const monitoring = compactMonitoring(doc.monitoring, checkTypes)
  if (monitoring) out.monitoring = monitoring
  const patching = compactPatching(doc.patching)
  if (patching) out.patching = patching
  const escrow = compactEscrow(doc.escrow)
  if (escrow) out.escrow = escrow
  return out
}

// ------------------------------------------------------------------ merge

export interface PolicyLayer {
  policyId: string
  document: PolicyDocument
}

/**
 * Applies layers in order (later wins): objects deep-merge key by key, tasks concatenate and
 * de-duplicate by id (a later task with the same id replaces the earlier one in place), and monitoring
 * checks merge by id field by field.
 */
export function mergePolicies(layers: PolicyLayer[]): Pick<EffectivePolicy, 'document' | 'origins'> {
  const document: PolicyDocument = {}
  const origins: Record<string, string> = {}
  for (const { policyId, document: layer } of layers) {
    if (layer.agent) {
      for (const key of AGENT_KEYS) {
        const value = layer.agent[key]
        if (value === undefined) continue
        document.agent = { ...document.agent, [key]: value }
        origins[`agent.${key}`] = policyId
      }
    }
    if (layer.remote_access) {
      for (const key of [...REMOTE_KEYS, ...DESKTOP_POLICY_KEYS]) {
        const value = layer.remote_access[key]
        if (value === undefined) continue
        document.remote_access = { ...document.remote_access, [key]: value }
        origins[`remote_access.${key}`] = policyId
      }
    }
    if (layer.tasks?.length) {
      const tasks = [...(document.tasks ?? [])]
      for (const task of layer.tasks) {
        const existing = tasks.findIndex((item) => item.id === task.id)
        if (existing >= 0) tasks[existing] = task
        else tasks.push(task)
        origins[`tasks.${task.id}`] = policyId
      }
      document.tasks = tasks
    }
  }
  const merged = mergeMonitoringLayers(layers.map((layer) => ({ policyId: layer.policyId, monitoring: layer.document.monitoring })))
  if (merged.monitoring) document.monitoring = merged.monitoring
  Object.assign(origins, merged.origins)
  const patching = mergePatchingLayers(layers.map((layer) => ({ policyId: layer.policyId, patching: layer.document.patching })))
  if (patching.patching) document.patching = patching.patching
  Object.assign(origins, patching.origins)
  const escrow = mergeEscrowLayers(layers.map((layer) => ({ policyId: layer.policyId, escrow: layer.document.escrow })))
  if (escrow.escrow) document.escrow = escrow.escrow
  Object.assign(origins, escrow.origins)
  return { document, origins }
}

/** Sorts sources into layer order: global, client, site, groups by ascending priority, device. */
export function sortSources<T extends Pick<EffectivePolicySource, 'target_type' | 'priority'>>(sources: T[]): T[] {
  return [...sources].sort(
    (a, b) => TARGET_ORDER.indexOf(a.target_type) - TARGET_ORDER.indexOf(b.target_type) || a.priority - b.priority,
  )
}

// ------------------------------------------------------------------ display

export function formatAgentValue(key: AgentKey, value: number): string {
  const unit = AGENT_SETTINGS[key].unit
  if (unit === 'seconds') return value >= 60 && value % 60 === 0 ? `${value / 60} min` : `${value} s`
  return value >= 60 && value % 60 === 0 ? `${value / 60} h` : `${value} min`
}

export interface EffectiveRow {
  section: PolicySection
  path: string
  label: string
  description: string
  /** The displayed value; for unset keys the platform default. */
  value: string
  /** The raw value, or undefined when no policy sets it. */
  raw: unknown
  origin: { id: string; name: string } | null
  tone?: 'allowed' | 'blocked'
}

/** Rows for the device page's “Effective policy” view, including defaults for unset keys. */
export function effectiveRows(effective: Pick<EffectivePolicy, 'document' | 'origins' | 'sources'>): EffectiveRow[] {
  const names = new Map(effective.sources.map((source) => [source.policy_id, source.policy_name]))
  const origin = (path: string) => {
    const id = effective.origins[path]
    return id ? { id, name: names.get(id) ?? 'Unknown policy' } : null
  }
  const rows: EffectiveRow[] = []
  for (const key of AGENT_KEYS) {
    const meta = AGENT_SETTINGS[key]
    const raw = effective.document.agent?.[key]
    rows.push({
      section: 'agent',
      path: `agent.${key}`,
      label: meta.label,
      description: meta.description,
      value: formatAgentValue(key, raw ?? meta.fallback),
      raw,
      origin: origin(`agent.${key}`),
    })
  }
  for (const key of REMOTE_KEYS) {
    const raw = effective.document.remote_access?.[key]
    const allowed = raw !== false
    rows.push({
      section: 'remote_access',
      path: `remote_access.${key}`,
      label: REMOTE_SETTINGS[key].label,
      description: REMOTE_SETTINGS[key].description,
      value: allowed ? 'Allowed' : 'Blocked by policy',
      raw,
      origin: origin(`remote_access.${key}`),
      tone: allowed ? 'allowed' : 'blocked',
    })
  }
  for (const key of DESKTOP_POLICY_KEYS) {
    const raw = effective.document.remote_access?.[key]
    rows.push({
      section: 'remote_access',
      path: `remote_access.${key}`,
      label: DESKTOP_POLICY_SETTINGS[key].label,
      description: DESKTOP_POLICY_SETTINGS[key].description,
      value: formatDesktopPolicyValue(key, raw ?? DESKTOP_POLICY_DEFAULTS[key]),
      raw,
      origin: origin(`remote_access.${key}`),
    })
  }
  for (const task of effective.document.tasks ?? []) {
    rows.push({
      section: 'tasks',
      path: `tasks.${task.id}`,
      label: task.name,
      description: task.id,
      value: task.enabled ? task.cron : 'Disabled',
      raw: task,
      origin: origin(`tasks.${task.id}`),
    })
  }
  return rows
}

/** Short chips describing what a policy sets, e.g. “Heartbeat 30 s”, “Shell blocked”, “2 tasks”. */
export function policyHighlights(doc: PolicyDocument): string[] {
  const out: string[] = []
  for (const key of AGENT_KEYS) {
    const value = doc.agent?.[key]
    if (value !== undefined) out.push(`${AGENT_SETTINGS[key].label} ${formatAgentValue(key, value)}`)
  }
  for (const key of REMOTE_KEYS) {
    const value = doc.remote_access?.[key]
    if (value !== undefined) out.push(`${REMOTE_SETTINGS[key].label} ${value ? 'allowed' : 'blocked'}`)
  }
  for (const key of DESKTOP_POLICY_KEYS) {
    const value = doc.remote_access?.[key]
    if (value !== undefined) out.push(`${DESKTOP_POLICY_SETTINGS[key].label}: ${formatDesktopPolicyValue(key, value).toLowerCase()}`)
  }
  const tasks = doc.tasks?.length ?? 0
  if (tasks) out.push(`${tasks} scheduled ${tasks === 1 ? 'task' : 'tasks'}`)
  out.push(...monitoringHighlights(doc.monitoring))
  out.push(...patchingHighlights(doc.patching))
  out.push(...escrowHighlights(doc.escrow))
  return out
}

/** A task id derived from its name: “Weekly cleanup” → “weekly-cleanup”, unique among `taken`. */
export function taskIdFromName(name: string, taken: string[] = []): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 56) || 'task'
  let id = base
  let suffix = 2
  while (taken.includes(id)) {
    id = `${base}-${suffix}`
    suffix += 1
  }
  return id
}

export function newTask(taken: string[], timezone = 'UTC'): PolicyTask {
  return {
    id: taskIdFromName('New task', taken),
    name: 'New task',
    script_id: '',
    parameters: {},
    cron: '0 3 * * 0',
    timezone,
    enabled: true,
    offline_wait_minutes: 720,
  }
}
