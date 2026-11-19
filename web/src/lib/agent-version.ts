/*
 * Agent versions. Image builds stamp the version with the UTC build time
 * (`0.1.0+20261118220341`, see crates/common/build.rs) so every rebuild is a distinct, newer
 * release. These helpers split the stamp off for display and compare versions the way the server
 * does (numeric parts; the stamp orders builds of one version).
 */
import type { AgentUpdateState } from '@/lib/api/types'

export interface AgentVersionParts {
  /** The workspace version, e.g. `0.1.0`. */
  base: string
  /** The build stamp as a date, when the version carries a valid `+YYYYMMDDHHMMSS` stamp. */
  built: Date | null
  /** The raw stamp (`20261118220341`), when present. */
  stamp: string | null
}

export function parseAgentVersion(version: string): AgentVersionParts {
  const [base, stamp] = version.split('+', 2)
  if (!stamp) return { base: version, built: null, stamp: null }
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(stamp)
  if (!match) return { base, built: null, stamp }
  const [, y, mo, d, h, mi, s] = match.map(Number)
  const built = new Date(Date.UTC(y, mo - 1, d, h, mi, s))
  return { base, built: Number.isNaN(built.getTime()) ? null : built, stamp }
}

const BUILT_FORMAT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** `0.1.0 · build Nov 18, 22:03` (local time); plain versions are returned unchanged. */
export function formatAgentVersion(version: string | null | undefined): string {
  if (!version) return '—'
  const { base, built, stamp } = parseAgentVersion(version)
  if (built) return `${base} · build ${BUILT_FORMAT.format(built)}`
  return stamp ? `${base} · build ${stamp}` : base
}

/** Numeric comparison matching the server's `version_cmp` (first four parts). */
export function compareAgentVersions(a: string, b: string): number {
  const parse = (value: string) =>
    value
      .split(/[.+-]/)
      .slice(0, 4)
      .map((part) => {
        const n = Number(part)
        return Number.isFinite(n) ? n : 0
      })
  const left = parse(a)
  const right = parse(b)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const x = left[index] ?? 0
    const y = right[index] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

export const UPDATE_STATE_LABEL: Record<AgentUpdateState, string> = {
  current: 'Up to date',
  outdated: 'Update available',
  queued: 'Queued',
  updating: 'Updating',
  failed: 'Update failed',
  unsupported: 'No build for platform',
  unknown: 'No release yet',
}

export const UPDATE_STATE_BADGE: Record<AgentUpdateState, 'success' | 'warning' | 'info' | 'critical' | 'secondary' | 'outline'> = {
  current: 'success',
  outdated: 'warning',
  queued: 'info',
  updating: 'info',
  failed: 'critical',
  unsupported: 'outline',
  unknown: 'outline',
}

/** States in which "Update now" makes sense. */
export function canUpdateNow(state: AgentUpdateState): boolean {
  return state === 'outdated' || state === 'failed' || state === 'queued'
}
