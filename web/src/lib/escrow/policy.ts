/*
 * The policy section `escrow` (Phase 10): LAPS-style local administrator rotation and FileVault escrow.
 * Validation mirrors the server; objects deep-merge key by key like every other section.
 */
import type { LapsComplexity, PolicyEscrowLaps, PolicyEscrowSection } from '@/lib/api/types'

export interface EscrowIssue {
  path: string
  message: string
}

export type LapsKey = keyof PolicyEscrowLaps

export const LAPS_DEFAULTS: Required<PolicyEscrowLaps> = {
  enabled: false,
  account: 'rmm-admin',
  create_if_missing: true,
  length: 20,
  complexity: 'full',
  rotate_days: 30,
  rotate_after_reveal_hours: 24,
}

export const FILEVAULT_DEFAULTS = { escrow: false }

export const LAPS_KEYS: LapsKey[] = ['enabled', 'account', 'create_if_missing', 'length', 'complexity', 'rotate_days', 'rotate_after_reveal_hours']

export const LAPS_LIMITS = {
  length: [14, 64],
  rotate_days: [1, 365],
  rotate_after_reveal_hours: [0, 720],
} as const satisfies Partial<Record<LapsKey, readonly [number, number]>>

export const COMPLEXITY_LABEL: Record<LapsComplexity, string> = {
  full: 'Letters, digits and symbols',
  alphanumeric: 'Letters and digits only',
}

const ACCOUNT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,19}$/

/** 1–20 letters, digits, `-`, `_` or `.`, not starting with `-` or `.` (the agent's rule). */
export function isValidAccountName(name: string): boolean {
  return ACCOUNT.test(name)
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const whole = (value: unknown, [min, max]: readonly [number, number]) =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max

export function validateEscrow(value: unknown): EscrowIssue[] {
  if (!isObject(value)) return [{ path: 'escrow', message: 'Must be an object' }]
  const issues: EscrowIssue[] = []
  for (const [key, section] of Object.entries(value)) {
    if (key === 'laps') {
      if (!isObject(section)) {
        issues.push({ path: 'escrow.laps', message: 'Must be an object' })
        continue
      }
      for (const [field, raw] of Object.entries(section)) {
        const path = `escrow.laps.${field}`
        switch (field) {
          case 'enabled':
          case 'create_if_missing':
            if (typeof raw !== 'boolean') issues.push({ path, message: 'Must be true or false' })
            break
          case 'account':
            if (typeof raw !== 'string' || !isValidAccountName(raw))
              issues.push({ path, message: 'Use 1–20 letters, digits, -, _ or . (not starting with - or .)' })
            break
          case 'complexity':
            if (raw !== 'full' && raw !== 'alphanumeric') issues.push({ path, message: 'Must be full or alphanumeric' })
            break
          case 'length':
          case 'rotate_days':
          case 'rotate_after_reveal_hours': {
            const limits = LAPS_LIMITS[field]
            if (!whole(raw, limits)) issues.push({ path, message: `Must be a whole number from ${limits[0]} to ${limits[1]}` })
            break
          }
          default:
            issues.push({ path, message: `Unknown setting “${field}”` })
        }
      }
    } else if (key === 'filevault') {
      if (!isObject(section)) {
        issues.push({ path: 'escrow.filevault', message: 'Must be an object' })
        continue
      }
      for (const [field, raw] of Object.entries(section)) {
        const path = `escrow.filevault.${field}`
        if (field !== 'escrow') issues.push({ path, message: `Unknown setting “${field}”` })
        else if (typeof raw !== 'boolean') issues.push({ path, message: 'Must be true or false' })
      }
    } else {
      issues.push({ path: `escrow.${key}`, message: `Unknown setting “${key}”` })
    }
  }
  return issues
}

/** Drops unset keys and empty objects; returns undefined when nothing is set. */
export function compactEscrow(section: PolicyEscrowSection | undefined): PolicyEscrowSection | undefined {
  if (!section) return undefined
  const out: PolicyEscrowSection = {}
  const laps = Object.fromEntries(
    Object.entries(section.laps ?? {}).filter(([, value]) => value !== undefined && value !== null && !(typeof value === 'number' && Number.isNaN(value))),
  ) as PolicyEscrowLaps
  if (Object.keys(laps).length) out.laps = laps
  if (typeof section.filevault?.escrow === 'boolean') out.filevault = { escrow: section.filevault.escrow }
  return Object.keys(out).length ? out : undefined
}

/** Sets or clears one LAPS key in a document's escrow section. */
export function setLapsKey<K extends LapsKey>(section: PolicyEscrowSection | undefined, key: K, value: PolicyEscrowLaps[K] | undefined): PolicyEscrowSection {
  const laps: PolicyEscrowLaps = { ...section?.laps }
  if (value === undefined) delete laps[key]
  else laps[key] = value
  return { ...section, laps }
}

export function setFilevaultEscrow(section: PolicyEscrowSection | undefined, value: boolean | undefined): PolicyEscrowSection {
  const next: PolicyEscrowSection = { ...section }
  if (value === undefined) delete next.filevault
  else next.filevault = { escrow: value }
  return next
}

/** Applies layers in order (later wins, key by key) and records the policy that set each leaf. */
export function mergeEscrowLayers(layers: { policyId: string; escrow?: PolicyEscrowSection }[]): {
  escrow?: PolicyEscrowSection
  origins: Record<string, string>
} {
  let escrow: PolicyEscrowSection | undefined
  const origins: Record<string, string> = {}
  for (const { policyId, escrow: layer } of layers) {
    if (!layer) continue
    for (const key of LAPS_KEYS) {
      const value = layer.laps?.[key]
      if (value === undefined) continue
      escrow = { ...escrow, laps: { ...escrow?.laps, [key]: value } }
      origins[`escrow.laps.${key}`] = policyId
    }
    if (typeof layer.filevault?.escrow === 'boolean') {
      escrow = { ...escrow, filevault: { escrow: layer.filevault.escrow } }
      origins['escrow.filevault.escrow'] = policyId
    }
  }
  return { escrow, origins }
}

/** The effective LAPS settings (defaults for anything unset). */
export function effectiveLaps(section: PolicyEscrowSection | undefined): Required<PolicyEscrowLaps> {
  return { ...LAPS_DEFAULTS, ...compactEscrow(section)?.laps }
}

export function formatHours(hours: number): string {
  if (hours === 0) return 'never'
  if (hours % 24 === 0) return `${hours / 24} ${hours === 24 ? 'day' : 'days'}`
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`
}

/** Short chips for policy lists: “LAPS on · rmm-admin”, “Rotate every 30 days”, “FileVault escrow on”. */
export function escrowHighlights(section: PolicyEscrowSection | undefined): string[] {
  const out: string[] = []
  const laps = section?.laps
  if (laps?.enabled !== undefined) out.push(laps.enabled ? `LAPS on${laps.account ? ` · ${laps.account}` : ''}` : 'LAPS off')
  else if (laps?.account) out.push(`LAPS account ${laps.account}`)
  if (laps?.rotate_days !== undefined) out.push(`Rotate every ${laps.rotate_days} ${laps.rotate_days === 1 ? 'day' : 'days'}`)
  if (laps?.rotate_after_reveal_hours !== undefined)
    out.push(laps.rotate_after_reveal_hours === 0 ? 'No rotation after reveal' : `Rotate ${formatHours(laps.rotate_after_reveal_hours)} after a reveal`)
  if (section?.filevault?.escrow !== undefined) out.push(`FileVault escrow ${section.filevault.escrow ? 'on' : 'off'}`)
  return out
}

/** Whether the escrow section differs (saving such a change also needs `secrets.manage`). */
export function escrowChanged(before: PolicyEscrowSection | undefined, after: PolicyEscrowSection | undefined): boolean {
  return JSON.stringify(normalize(compactEscrow(before))) !== JSON.stringify(normalize(compactEscrow(after)))
}

function normalize(section: PolicyEscrowSection | undefined) {
  if (!section) return null
  return {
    laps: section.laps ? Object.fromEntries(LAPS_KEYS.filter((key) => section.laps?.[key] !== undefined).map((key) => [key, section.laps![key]])) : null,
    filevault: section.filevault?.escrow ?? null,
  }
}
