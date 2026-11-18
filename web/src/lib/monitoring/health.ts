/* Ties the device health score's reasons to the checks and alerts that explain them. */
import type { CheckState, DeviceCheck } from '@/lib/api/types'
import { CHECK_STATE_ORDER } from './labels'

const REASON_TYPES: [RegExp, string[]][] = [
  [/offline/i, ['offline']],
  [/disk/i, ['disk', 'disk_forecast']],
  [/memory/i, ['memory']],
  [/antivirus/i, ['antivirus']],
  [/firewall/i, ['firewall']],
  [/restart|reboot/i, ['pending_reboot']],
  [/encrypt/i, ['security']],
  [/cpu|processor/i, ['cpu']],
  [/update/i, ['windows_update']],
]

/** Check (or server alert) types that relate to a health reason such as "Disk above 90%". */
export function relatedCheckTypes(reason: string): string[] {
  return REASON_TYPES.find(([pattern]) => pattern.test(reason))?.[1] ?? []
}

const STATE_RANK = (state: CheckState | null) => (state ? CHECK_STATE_ORDER.indexOf(state) : CHECK_STATE_ORDER.length)

/** Checks ordered worst first (critical, warning, unknown, ok, not yet reported), then by name. */
export function sortChecks<T extends Pick<DeviceCheck, 'state' | 'name'>>(checks: readonly T[]): T[] {
  return [...checks].sort((a, b) => STATE_RANK(a.state) - STATE_RANK(b.state) || a.name.localeCompare(b.name))
}

export interface CheckStateCounts {
  critical: number
  warning: number
  unknown: number
  ok: number
  pending: number
}

export function countCheckStates(checks: readonly Pick<DeviceCheck, 'state'>[]): CheckStateCounts {
  const counts: CheckStateCounts = { critical: 0, warning: 0, unknown: 0, ok: 0, pending: 0 }
  for (const check of checks) counts[check.state ?? 'pending'] += 1
  return counts
}
