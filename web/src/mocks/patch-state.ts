/* Per-device patch state for the Phase 11 additions: `GET /devices?patch_state=`, the patch widget and reports. */
import type { DevicePatchStateFilter } from '@/lib/api/types'
import { deviceCompliant } from '@/lib/patching/compliance'
import { isMissingState } from '@/lib/patching/labels'
import { db } from './db'
import type { MockDevice } from './devices'
import { complianceFacts, configCache } from './patching-model'

const DAY = 86_400_000

export interface DevicePatchFacts {
  scanned: boolean
  compliant: boolean
  pending_reboot: boolean
  failed: boolean
  missing_critical: number
  missing_important: number
  oldest_missing_days: number | null
}

/** Patch facts for each device (one config cache per call, as the compliance route does). */
export function patchFactsFor(devices: readonly MockDevice[], now = Date.now()): Map<string, DevicePatchFacts> {
  const world = { automation: db.automation, devices: db.devices, clients: db.clients, sites: db.sites, patching: db.patching }
  const config = configCache(world)
  const out = new Map<string, DevicePatchFacts>()
  for (const device of devices) {
    const facts = complianceFacts(world, device, config(device), { key: '', label: '' }, now)
    if (!facts) {
      out.set(device.id, { scanned: false, compliant: false, pending_reboot: false, failed: false, missing_critical: 0, missing_important: 0, oldest_missing_days: null })
      continue
    }
    const missing = facts.patches.filter((patch) => isMissingState(patch.state))
    const oldest = missing.reduce<number | null>((min, patch) => (min === null || patch.detected_at < min ? patch.detected_at : min), null)
    out.set(device.id, {
      scanned: true,
      compliant: deviceCompliant(facts.patches, now),
      pending_reboot: facts.pending_reboot,
      failed: facts.patches.some((patch) => patch.state === 'failed'),
      missing_critical: missing.filter((patch) => patch.severity === 'Critical').length,
      missing_important: missing.filter((patch) => patch.severity === 'Important').length,
      oldest_missing_days: oldest === null ? null : Math.floor((now - oldest) / DAY),
    })
  }
  return out
}

export function matchesPatchState(facts: DevicePatchFacts | undefined, state: DevicePatchStateFilter): boolean {
  if (!facts) return false
  switch (state) {
    case 'not_scanned':
      return !facts.scanned
    case 'compliant':
      return facts.scanned && facts.compliant
    case 'non_compliant':
      return facts.scanned && !facts.compliant
    case 'pending_reboot':
      return facts.pending_reboot
    case 'failed':
      return facts.failed
    case 'missing_critical':
      return facts.missing_critical > 0
  }
}

export const PATCH_STATES: DevicePatchStateFilter[] = ['compliant', 'non_compliant', 'pending_reboot', 'failed', 'missing_critical', 'not_scanned']
