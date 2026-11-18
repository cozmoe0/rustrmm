/*
 * The policy document's `patching` section: defaults, validation (the server's rules), compaction,
 * the layered merge with per-leaf origins, immutable editing helpers and the effective view.
 */
import type {
  AutoApproveRule,
  EffectivePolicy,
  PatchPlatform,
  PatchRing,
  PolicyDocument,
  PolicyPatchingSection,
  RebootMode,
} from '@/lib/api/types'
import { describeCron, isValidCron, isValidTimeZone, nextCronRuns } from '@/lib/cron'
import { formatRingDelays } from './approval'
import { CLASSIFICATION_LABEL, PLATFORM_LABEL, REBOOT_MODE_LABEL, RING_LABEL, RING_ORDER, SEVERITY_ORDER, classificationsFor } from './labels'

export interface PatchingIssue {
  path: string
  message: string
}

export const SCAN_MIN = 1
export const SCAN_MAX = 168
export const DURATION_MIN = 15
export const DURATION_MAX = 1440
export const DEFERRALS_MAX = 10
export const MESSAGE_MAX = 500
export const MAX_RULES = 50
export const DELAY_MAX = 365
export const DEFAULT_REBOOT_MESSAGE = 'Your IT team installed updates. Please restart to finish.'
export const RULE_PLATFORMS: PatchPlatform[] = ['windows', 'linux', 'macos', 'winget']

/** The values a device gets for keys no layer sets. */
export const PATCHING_DEFAULTS = {
  enabled: false,
  scan_interval_hours: 12,
  window: { duration_minutes: 180, timezone: 'UTC' },
  ring: 'broad' as PatchRing,
  windows: { include_drivers: false, include_feature_updates: false, include_preview: false },
  linux: { mode: 'security' as const },
  macos: { install: false },
  reboot: { mode: 'prompt' as RebootMode, prompt_deferrals: 3, force_at_window_end: true, message: DEFAULT_REBOOT_MESSAGE },
  third_party: { winget: false },
}

const SECTION_KEYS = ['enabled', 'scan_interval_hours', 'window', 'ring', 'auto_approve', 'windows', 'linux', 'macos', 'reboot', 'third_party']
const WINDOWS_KEYS = ['include_drivers', 'include_feature_updates', 'include_preview']
const REBOOT_KEYS = ['mode', 'prompt_deferrals', 'force_at_window_end', 'message']

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isInt = (value: unknown, min: number, max: number) =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max

// ------------------------------------------------------------------ validation

/** Every problem in a `patching` section, with paths such as `patching.auto_approve[0].platform`. */
export function validatePatching(value: unknown): PatchingIssue[] {
  const issues: PatchingIssue[] = []
  const add = (path: string, message: string) => issues.push({ path, message })
  if (!isObject(value)) return [{ path: 'patching', message: 'Must be an object' }]
  const unknown = (obj: Record<string, unknown>, allowed: string[], base: string) => {
    for (const key of Object.keys(obj)) if (!allowed.includes(key)) add(`${base}.${key}`, `Unknown setting “${key}”`)
  }
  const bool = (obj: Record<string, unknown>, key: string, base: string) => {
    if (obj[key] !== undefined && typeof obj[key] !== 'boolean') add(`${base}.${key}`, 'Must be true or false')
  }
  unknown(value, SECTION_KEYS, 'patching')
  bool(value, 'enabled', 'patching')
  if (value.scan_interval_hours !== undefined && !isInt(value.scan_interval_hours, SCAN_MIN, SCAN_MAX))
    add('patching.scan_interval_hours', `Must be a whole number from ${SCAN_MIN} to ${SCAN_MAX} hours`)

  if (value.window !== undefined) {
    if (!isObject(value.window)) add('patching.window', 'Must be an object')
    else {
      const window = value.window
      unknown(window, ['cron', 'duration_minutes', 'timezone'], 'patching.window')
      if (typeof window.cron !== 'string' || !window.cron.trim()) add('patching.window.cron', 'A cron expression is required')
      else if (!isValidCron(window.cron)) add('patching.window.cron', 'Enter a valid 5-field cron expression')
      if (window.timezone !== undefined && (typeof window.timezone !== 'string' || !isValidTimeZone(window.timezone)))
        add('patching.window.timezone', 'Choose a valid time zone')
      if (window.duration_minutes !== undefined && !isInt(window.duration_minutes, DURATION_MIN, DURATION_MAX))
        add('patching.window.duration_minutes', `Must be ${DURATION_MIN}–${DURATION_MAX} minutes`)
    }
  }

  if (value.ring !== undefined && !(RING_ORDER as unknown[]).includes(value.ring))
    add('patching.ring', 'Must be pilot, broad or late')

  if (value.auto_approve !== undefined) {
    if (!Array.isArray(value.auto_approve)) add('patching.auto_approve', 'Must be a list')
    else {
      if (value.auto_approve.length > MAX_RULES) add('patching.auto_approve', `At most ${MAX_RULES} rules`)
      value.auto_approve.forEach((rule: unknown, index) => {
        const base = `patching.auto_approve[${index}]`
        if (!isObject(rule)) {
          add(base, 'Must be an object')
          return
        }
        unknown(rule, ['platform', 'classifications', 'severities', 'delay_days'], base)
        const platform = rule.platform
        if (typeof platform !== 'string' || !(RULE_PLATFORMS as string[]).includes(platform)) {
          add(`${base}.platform`, 'Must be windows, linux, macos or winget')
        } else if (rule.classifications !== undefined) {
          const allowed = classificationsFor(platform as PatchPlatform)
          if (!Array.isArray(rule.classifications)) add(`${base}.classifications`, 'Must be a list')
          else
            rule.classifications.forEach((item: unknown, position) => {
              if (typeof item !== 'string' || !allowed.includes(item))
                add(`${base}.classifications[${position}]`, `Must be one of ${allowed.join(', ')}`)
            })
        }
        if (rule.severities !== undefined) {
          if (!Array.isArray(rule.severities)) add(`${base}.severities`, 'Must be a list')
          else
            rule.severities.forEach((item: unknown, position) => {
              if (typeof item !== 'string' || !(SEVERITY_ORDER as string[]).includes(item))
                add(`${base}.severities[${position}]`, 'Must be Critical, Important, Moderate or Low')
            })
        }
        if (rule.delay_days !== undefined) {
          if (!isObject(rule.delay_days)) add(`${base}.delay_days`, 'Must be an object')
          else {
            unknown(rule.delay_days, RING_ORDER, `${base}.delay_days`)
            for (const ring of RING_ORDER) {
              const days = rule.delay_days[ring]
              if (days !== undefined && !isInt(days, 0, DELAY_MAX)) add(`${base}.delay_days.${ring}`, `Must be 0–${DELAY_MAX} days`)
            }
          }
        }
      })
    }
  }

  if (value.windows !== undefined) {
    if (!isObject(value.windows)) add('patching.windows', 'Must be an object')
    else {
      unknown(value.windows, WINDOWS_KEYS, 'patching.windows')
      for (const key of WINDOWS_KEYS) bool(value.windows, key, 'patching.windows')
    }
  }
  if (value.linux !== undefined) {
    if (!isObject(value.linux)) add('patching.linux', 'Must be an object')
    else {
      unknown(value.linux, ['mode'], 'patching.linux')
      if (value.linux.mode !== undefined && value.linux.mode !== 'security' && value.linux.mode !== 'all')
        add('patching.linux.mode', 'Must be security or all')
    }
  }
  if (value.macos !== undefined) {
    if (!isObject(value.macos)) add('patching.macos', 'Must be an object')
    else {
      unknown(value.macos, ['install'], 'patching.macos')
      bool(value.macos, 'install', 'patching.macos')
    }
  }
  if (value.reboot !== undefined) {
    if (!isObject(value.reboot)) add('patching.reboot', 'Must be an object')
    else {
      const reboot = value.reboot
      unknown(reboot, REBOOT_KEYS, 'patching.reboot')
      if (reboot.mode !== undefined && !['never', 'prompt', 'force'].includes(reboot.mode as string))
        add('patching.reboot.mode', 'Must be never, prompt or force')
      if (reboot.prompt_deferrals !== undefined && !isInt(reboot.prompt_deferrals, 0, DEFERRALS_MAX))
        add('patching.reboot.prompt_deferrals', `Must be 0–${DEFERRALS_MAX}`)
      bool(reboot, 'force_at_window_end', 'patching.reboot')
      if (reboot.message !== undefined) {
        if (typeof reboot.message !== 'string') add('patching.reboot.message', 'Must be text')
        else if ([...reboot.message].length > MESSAGE_MAX) add('patching.reboot.message', `At most ${MESSAGE_MAX} characters`)
      }
    }
  }
  if (value.third_party !== undefined) {
    if (!isObject(value.third_party)) add('patching.third_party', 'Must be an object')
    else {
      unknown(value.third_party, ['winget'], 'patching.third_party')
      bool(value.third_party, 'winget', 'patching.third_party')
    }
  }
  return issues
}

// ------------------------------------------------------------------ compaction

/** Drops undefined values and empty sub-objects; undefined when the section sets nothing. */
export function compactPatching(section: PolicyPatchingSection | undefined): PolicyPatchingSection | undefined {
  if (!section) return undefined
  const clean = (obj: Record<string, unknown>) => {
    const out = Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined && value !== null))
    return Object.keys(out).length ? out : undefined
  }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(section)) {
    if (value === undefined || value === null) continue
    if (key === 'auto_approve') out[key] = value
    else if (isObject(value)) {
      const inner = clean(value)
      if (inner) out[key] = inner
    } else out[key] = value
  }
  return Object.keys(out).length ? (out as PolicyPatchingSection) : undefined
}

/** Whether the compacted patching section differs (saving it needs `patches.approve`). */
export function patchingChanged(before: PolicyDocument, after: PolicyDocument): boolean {
  return JSON.stringify(compactPatching(before.patching) ?? null) !== JSON.stringify(compactPatching(after.patching) ?? null)
}

// ------------------------------------------------------------------ merge

/**
 * Merges patching sections in layer order. Objects deep-merge key by key and other values replace, so
 * `auto_approve` comes whole from the last layer that sets it. Origins name every leaf
 * (`patching.window.cron`, `patching.reboot.mode`, `patching.auto_approve`, …).
 */
export function mergePatchingLayers(
  layers: { policyId: string; patching: PolicyPatchingSection | undefined }[],
): { patching: PolicyPatchingSection | undefined; origins: Record<string, string> } {
  const origins: Record<string, string> = {}
  let merged: Record<string, unknown> | undefined
  for (const { policyId, patching } of layers) {
    if (!patching) continue
    merged ??= {}
    for (const [key, value] of Object.entries(patching)) {
      if (value === undefined) continue
      if (isObject(value)) {
        const target = isObject(merged[key]) ? { ...(merged[key] as Record<string, unknown>) } : {}
        for (const [inner, innerValue] of Object.entries(value)) {
          if (innerValue === undefined) continue
          target[inner] = innerValue
          origins[`patching.${key}.${inner}`] = policyId
        }
        merged[key] = target
      } else {
        merged[key] = value
        origins[`patching.${key}`] = policyId
      }
    }
  }
  return { patching: merged as PolicyPatchingSection | undefined, origins }
}

// ------------------------------------------------------------------ editing

type Sub = 'window' | 'windows' | 'linux' | 'macos' | 'reboot' | 'third_party'
type Top = Exclude<keyof PolicyPatchingSection, Sub>

function withPatching(doc: PolicyDocument, patching: PolicyPatchingSection): PolicyDocument {
  const next: PolicyDocument = { ...doc, patching }
  if (!Object.keys(patching).length) delete next.patching
  return next
}

/** Sets (or with `undefined` removes, so it is inherited) a top-level patching key. */
export function setPatchingKey<K extends Top>(doc: PolicyDocument, key: K, value: PolicyPatchingSection[K] | undefined): PolicyDocument {
  const patching: PolicyPatchingSection = { ...doc.patching }
  if (value === undefined) delete patching[key]
  else patching[key] = value
  return withPatching(doc, patching)
}

/** Sets (or removes) one key of a nested object such as `reboot.mode`; empty objects are dropped. */
export function setPatchingField<S extends Sub, K extends keyof NonNullable<PolicyPatchingSection[S]>>(
  doc: PolicyDocument,
  section: S,
  key: K,
  value: NonNullable<PolicyPatchingSection[S]>[K] | undefined,
): PolicyDocument {
  const patching: PolicyPatchingSection = { ...doc.patching }
  const inner = { ...(patching[section] as Record<string, unknown> | undefined) }
  if (value === undefined) delete inner[key as string]
  else inner[key as string] = value
  if (Object.keys(inner).length) (patching as Record<string, unknown>)[section] = inner
  else delete patching[section]
  return withPatching(doc, patching)
}

/** Replaces a whole nested object (or removes it). */
export function setPatchingSection<S extends Sub>(doc: PolicyDocument, section: S, value: PolicyPatchingSection[S] | undefined): PolicyDocument {
  const patching: PolicyPatchingSection = { ...doc.patching }
  if (value === undefined) delete patching[section]
  else patching[section] = value
  return withPatching(doc, patching)
}

export function newRule(platform: PatchPlatform = 'windows'): AutoApproveRule {
  if (platform === 'windows')
    return { platform, classifications: ['SecurityUpdates', 'CriticalUpdates'], severities: [], delay_days: { pilot: 0, broad: 7, late: 21 } }
  if (platform === 'linux') return { platform, classifications: ['security'], delay_days: { pilot: 0, broad: 3, late: 10 } }
  return { platform, classifications: [], delay_days: { pilot: 0, broad: 7, late: 14 } }
}

/** Switching a rule's platform keeps only the classifications the new platform allows. */
export function changeRulePlatform(rule: AutoApproveRule, platform: PatchPlatform): AutoApproveRule {
  const allowed = classificationsFor(platform)
  return { ...rule, platform, classifications: (rule.classifications ?? []).filter((item) => allowed.includes(item)) }
}

/** Issues for rule `index`, with the `patching.auto_approve[i]` prefix removed. */
export function ruleIssues(issues: readonly PatchingIssue[], index: number): PatchingIssue[] {
  const prefix = `patching.auto_approve[${index}]`
  return issues
    .filter((issue) => issue.path === prefix || issue.path.startsWith(`${prefix}.`))
    .map((issue) => ({ path: issue.path.slice(prefix.length + 1), message: issue.message }))
}

// ------------------------------------------------------------------ display

/** The next `count` window openings in the window's time zone. */
export function windowOccurrences(window: { cron: string; timezone?: string } | undefined, count = 5, from = new Date()): Date[] {
  if (!window || !isValidCron(window.cron)) return []
  const zone = window.timezone && isValidTimeZone(window.timezone) ? window.timezone : 'UTC'
  return nextCronRuns(window.cron, { timeZone: zone, count, from })
}

/** "Wednesdays at 02:00 · 3 h · UTC". */
export function describeWindow(window: { cron: string; duration_minutes?: number; timezone?: string } | undefined): string {
  if (!window) return 'No window — nothing installs automatically'
  const minutes = window.duration_minutes ?? PATCHING_DEFAULTS.window.duration_minutes
  const span = minutes % 60 === 0 ? `${minutes / 60} h` : minutes > 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`
  return `${isValidCron(window.cron) ? describeCron(window.cron) : window.cron} · ${span} · ${(window.timezone ?? 'UTC').replace(/_/g, ' ')}`
}

export function describeRule(rule: AutoApproveRule): string {
  const classes = rule.classifications?.length
    ? rule.classifications.map((item) => CLASSIFICATION_LABEL[item] ?? item).join(', ')
    : 'every classification'
  const severities = rule.severities?.length ? ` · ${rule.severities.join(', ')}` : ''
  return `${PLATFORM_LABEL[rule.platform]} · ${classes}${severities}`
}

/** Short chips for the policy list, e.g. "Patching on", "Broad ring", "2 approval rules". */
export function patchingHighlights(section: PolicyPatchingSection | undefined): string[] {
  if (!section) return []
  const out: string[] = []
  if (section.enabled !== undefined) out.push(section.enabled ? 'Patching on' : 'Patching off')
  if (section.window) out.push(`Window ${isValidCron(section.window.cron) ? describeCron(section.window.cron) : section.window.cron}`)
  if (section.ring) out.push(`${RING_LABEL[section.ring]} ring`)
  const rules = section.auto_approve?.length ?? 0
  if (section.auto_approve) out.push(rules ? `${rules} approval ${rules === 1 ? 'rule' : 'rules'}` : 'No auto-approval')
  if (section.reboot?.mode) out.push(REBOOT_MODE_LABEL[section.reboot.mode])
  return out
}

export interface RebootPreview {
  title: string
  body: string
  /** Buttons on the Windows prompt. */
  actions: string[]
  footnote: string
}

/** What the signed-in user sees for a reboot mode (the prompt the agent shows on Windows). */
export function rebootPreview(reboot: { mode?: RebootMode; prompt_deferrals?: number; force_at_window_end?: boolean; message?: string }): RebootPreview {
  const mode = reboot.mode ?? PATCHING_DEFAULTS.reboot.mode
  const deferrals = reboot.prompt_deferrals ?? PATCHING_DEFAULTS.reboot.prompt_deferrals
  const message = reboot.message?.trim() || DEFAULT_REBOOT_MESSAGE
  const forceAtEnd = reboot.force_at_window_end ?? PATCHING_DEFAULTS.reboot.force_at_window_end
  if (mode === 'never')
    return {
      title: 'No prompt',
      body: 'Updates install silently. The device reports “restart pending” until someone restarts it.',
      actions: [],
      footnote: 'Devices stay non-compliant for patches that need a restart until they restart.',
    }
  if (mode === 'force')
    return {
      title: 'Restart scheduled',
      body: `${message}\n\nThis computer will restart in 5 minutes.`,
      actions: ['OK'],
      footnote: 'Devices with nobody signed in restart right away.',
    }
  return {
    title: 'Restart required',
    body: `${message}\n\nRestart now?`,
    actions: ['Yes', 'No'],
    footnote:
      deferrals === 0
        ? `No postponing: the restart happens after the first prompt${forceAtEnd ? ' or when the window ends' : ''}.`
        : `“No” postpones by 60 minutes, up to ${deferrals} ${deferrals === 1 ? 'time' : 'times'}; then the restart is forced${forceAtEnd ? ', and at the latest when the window ends' : ''}. Linux and macOS have no interactive prompt and restart with a 5-minute warning.`,
  }
}

export interface EffectivePatchingRow {
  path: string
  label: string
  value: string
  /** True when no policy sets it and the default applies. */
  inherited: boolean
  origin: { id: string; name: string } | null
}

/** The device page's effective patching settings, each with the policy that set it. */
export function effectivePatching(effective: Pick<EffectivePolicy, 'document' | 'origins' | 'sources'>): {
  rows: EffectivePatchingRow[]
  rules: AutoApproveRule[]
  rulesOrigin: { id: string; name: string } | null
  enabled: boolean
} {
  const names = new Map(effective.sources.map((source) => [source.policy_id, source.policy_name]))
  const origin = (path: string) => {
    const id = effective.origins[path]
    return id ? { id, name: names.get(id) ?? 'Unknown policy' } : null
  }
  const section = effective.document.patching ?? {}
  const rows: EffectivePatchingRow[] = []
  const row = (path: string, label: string, raw: unknown, text: string) =>
    rows.push({ path, label, value: text, inherited: raw === undefined, origin: origin(path) })
  const enabled = section.enabled ?? PATCHING_DEFAULTS.enabled
  row('patching.enabled', 'Patching', section.enabled, enabled ? 'Enabled' : 'Off')
  const scan = section.scan_interval_hours ?? PATCHING_DEFAULTS.scan_interval_hours
  row('patching.scan_interval_hours', 'Scan interval', section.scan_interval_hours, `Every ${scan} ${scan === 1 ? 'hour' : 'hours'}`)
  const window = section.window
  rows.push({
    path: 'patching.window.cron',
    label: 'Maintenance window',
    value: describeWindow(window),
    inherited: !window,
    origin: origin('patching.window.cron'),
  })
  const ring = section.ring ?? PATCHING_DEFAULTS.ring
  row('patching.ring', 'Ring', section.ring, RING_LABEL[ring])
  const win = { ...PATCHING_DEFAULTS.windows, ...section.windows }
  const extras = [win.include_drivers && 'drivers', win.include_feature_updates && 'feature updates', win.include_preview && 'previews'].filter(Boolean)
  rows.push({
    path: 'patching.windows',
    label: 'Windows scope',
    value: extras.length ? `Software updates + ${extras.join(', ')}` : 'Software updates only',
    inherited: !section.windows,
    origin: origin('patching.windows.include_drivers') ?? origin('patching.windows.include_feature_updates') ?? origin('patching.windows.include_preview'),
  })
  const linux = section.linux?.mode ?? PATCHING_DEFAULTS.linux.mode
  row('patching.linux.mode', 'Linux', section.linux?.mode, linux === 'security' ? 'Security updates only' : 'All updates')
  const mac = section.macos?.install ?? PATCHING_DEFAULTS.macos.install
  row('patching.macos.install', 'macOS', section.macos?.install, mac ? 'Install' : 'Report only')
  const reboot = { ...PATCHING_DEFAULTS.reboot, ...section.reboot }
  row(
    'patching.reboot.mode',
    'Restarts',
    section.reboot?.mode,
    reboot.mode === 'prompt'
      ? `Ask the user · ${reboot.prompt_deferrals} ${reboot.prompt_deferrals === 1 ? 'deferral' : 'deferrals'}${reboot.force_at_window_end ? ' · forced at window end' : ''}`
      : REBOOT_MODE_LABEL[reboot.mode],
  )
  const winget = section.third_party?.winget ?? PATCHING_DEFAULTS.third_party.winget
  row('patching.third_party.winget', 'winget upgrades', section.third_party?.winget, winget ? 'Offered as patches' : 'Off')
  return { rows, rules: section.auto_approve ?? [], rulesOrigin: origin('patching.auto_approve'), enabled }
}

/** One line per rule for summaries: "Windows · Security updates, Critical updates — Pilot 0d · Broad 7d · Late 21d". */
export function ruleSummary(rule: AutoApproveRule): string {
  return `${describeRule(rule)} — ${formatRingDelays(rule.delay_days)}`
}
