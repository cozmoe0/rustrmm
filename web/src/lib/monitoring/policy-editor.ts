/*
 * Editing helpers for the policy editor's Monitoring tab: immutable updates of the `monitoring` section,
 * issue routing to individual checks and fields, id derivation, interval presets and platform limits.
 */
import type {
  CheckTypeDefinition,
  MonitoringCheck,
  MonitoringServerSection,
  OsFamily,
  PolicyDocument,
  PolicyMonitoringSection,
} from '@/lib/api/types'
import { INTERVAL_PRESETS } from './labels'
import { checkIdFromName, compactMonitoring, type ServerKey } from './policy-monitoring'

export interface EditorIssue {
  path: string
  message: string
}

export const PLATFORM_ORDER: OsFamily[] = ['windows', 'macos', 'linux']

function withMonitoring(doc: PolicyDocument, monitoring: PolicyMonitoringSection): PolicyDocument {
  const next: PolicyDocument = { ...doc, monitoring }
  if (!monitoring.checks?.length && !Object.keys(monitoring.server ?? {}).length) delete next.monitoring
  return next
}

export function setChecks(doc: PolicyDocument, checks: MonitoringCheck[]): PolicyDocument {
  const monitoring: PolicyMonitoringSection = { ...doc.monitoring, checks }
  if (!checks.length) delete monitoring.checks
  return withMonitoring(doc, monitoring)
}

export function updateCheck(doc: PolicyDocument, index: number, check: MonitoringCheck): PolicyDocument {
  return setChecks(
    doc,
    (doc.monitoring?.checks ?? []).map((item, position) => (position === index ? check : item)),
  )
}

export function removeCheck(doc: PolicyDocument, index: number): PolicyDocument {
  return setChecks(
    doc,
    (doc.monitoring?.checks ?? []).filter((_, position) => position !== index),
  )
}

/** Sets (or, with `undefined`, removes so it is inherited) one `monitoring.server` key. */
export function setServerKey<K extends ServerKey>(
  doc: PolicyDocument,
  key: K,
  value: MonitoringServerSection[K] | undefined,
): PolicyDocument {
  const server: MonitoringServerSection = { ...doc.monitoring?.server }
  if (value === undefined) delete server[key]
  else server[key] = value
  const monitoring: PolicyMonitoringSection = { ...doc.monitoring, server }
  if (!Object.keys(server).length) delete monitoring.server
  return withMonitoring(doc, monitoring)
}

/**
 * Issues that belong to check `index` (path `monitoring.checks[i].…`, or the server's
 * `monitoring.checks.<id>…` form), with that prefix removed so `config.warn_pct` or `name` remain.
 */
export function checkIssues(issues: readonly EditorIssue[], index: number, id: string): EditorIssue[] {
  const positional = `monitoring.checks[${index}]`
  const byId = `monitoring.checks.${id}`
  const out: EditorIssue[] = []
  for (const issue of issues) {
    for (const prefix of [positional, byId]) {
      if (issue.path === prefix) out.push({ path: '', message: issue.message })
      else if (issue.path.startsWith(`${prefix}.`)) out.push({ path: issue.path.slice(prefix.length + 1), message: issue.message })
      else continue
      break
    }
  }
  return out
}

/** The first message for each `config.<key>` path. */
export function configErrors(issues: readonly EditorIssue[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const issue of issues) {
    if (!issue.path.startsWith('config.')) continue
    const key = issue.path.slice('config.'.length).split('.')[0]
    out[key] ??= issue.message
  }
  return out
}

export function firstIssue(issues: readonly EditorIssue[], path: string): string | undefined {
  return issues.find((issue) => issue.path === path || issue.path.startsWith(`${path}.`))?.message
}

/**
 * Renames a check and keeps its id derived from the name while the id was still the derived one,
 * like policy tasks.
 */
export function renameCheck(check: MonitoringCheck, name: string, taken: readonly string[]): MonitoringCheck {
  const derived = check.id === checkIdFromName(check.name ?? '', taken)
  return { ...check, name, ...(derived ? { id: checkIdFromName(name, taken) } : {}) }
}

/** The interval select's value: a preset in seconds, or `custom`. */
export function intervalChoice(seconds: number | undefined): string {
  return seconds !== undefined && INTERVAL_PRESETS.includes(seconds) ? String(seconds) : 'custom'
}

/** Platforms a check type supports, in display order. */
export function typePlatforms(definition: Pick<CheckTypeDefinition, 'platforms'> | undefined): OsFamily[] {
  return PLATFORM_ORDER.filter((os) => !definition || definition.platforms.includes(os))
}

/**
 * Toggles a platform in a check's `platforms` limit. An empty selection, or one that covers every
 * platform the type supports, is stored as "no limit" (undefined).
 */
export function togglePlatform(
  current: readonly OsFamily[] | undefined,
  os: OsFamily,
  available: readonly OsFamily[],
): OsFamily[] | undefined {
  const base = current?.length ? current.filter((item) => available.includes(item)) : [...available]
  const next = base.includes(os) ? base.filter((item) => item !== os) : [...base, os]
  if (next.length === 0 || available.every((item) => next.includes(item))) return undefined
  return PLATFORM_ORDER.filter((item) => next.includes(item))
}

/** Whether the compacted monitoring section differs between two documents (saving it needs `monitors.manage`). */
export function monitoringChanged(
  before: PolicyDocument,
  after: PolicyDocument,
  catalog?: readonly CheckTypeDefinition[] | null,
): boolean {
  return JSON.stringify(compactMonitoring(before.monitoring, catalog) ?? null) !== JSON.stringify(compactMonitoring(after.monitoring, catalog) ?? null)
}
