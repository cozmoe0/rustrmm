/*
 * Patch compliance: the aggregation the server performs (also used by the mock API) and the display
 * helpers of the compliance dashboard.
 */
import type {
  ComplianceReport,
  ComplianceRow,
  ComplianceSeverityKey,
  ComplianceTotals,
  DevicePatchState,
  PatchSeverity,
} from '@/lib/api/types'
import { isMissingState, type Tone } from './labels'

/** Grace period before an effective-approved missing patch makes a device non-compliant. */
export const GRACE_DAYS = 7
const DAY = 86_400_000

export const COMPLIANCE_SEVERITIES: ComplianceSeverityKey[] = ['Critical', 'Important', 'Moderate', 'Low', 'Unspecified']

/** One patch on one device, as compliance sees it. Instants are epoch milliseconds. */
export interface CompliancePatchFact {
  severity: PatchSeverity | null
  state: DevicePatchState
  detected_at: number
  /** When the patch became effective-approved for the device; null when it isn't. */
  effective_since: number | null
}

export interface ComplianceDeviceFacts {
  group_key: string
  group_label: string
  pending_reboot: boolean
  patches: CompliancePatchFact[]
}

/**
 * Compliant: no failed install still missing, and no effective-approved patch missing for more than
 * the grace period, measured from the later of its detection and its approval taking effect.
 */
export function deviceCompliant(patches: readonly CompliancePatchFact[], now: number): boolean {
  return !patches.some(
    (patch) =>
      patch.state === 'failed' ||
      (isMissingState(patch.state) &&
        patch.effective_since !== null &&
        now - Math.max(patch.effective_since, patch.detected_at) > GRACE_DAYS * DAY),
  )
}

/**
 * Totals and per-group rows. `missing_critical`/`missing_important` count missing (device, patch)
 * pairs; `pending_reboot` and `failed` count devices. Rows are sorted by label and
 * `compliance_pct` has one decimal (100 for a group without devices).
 */
export function summarizeCompliance(devices: readonly ComplianceDeviceFacts[], now: number): ComplianceReport {
  const totals: ComplianceTotals = {
    devices: 0,
    compliant: 0,
    non_compliant: 0,
    missing_critical: 0,
    missing_important: 0,
    pending_reboot: 0,
    failed: 0,
  }
  const groups = new Map<string, { label: string; devices: number; compliant: number; severity: Record<string, number>; oldest: number | null }>()
  for (const device of devices) {
    const compliant = deviceCompliant(device.patches, now)
    totals.devices += 1
    if (compliant) totals.compliant += 1
    else totals.non_compliant += 1
    if (device.pending_reboot || device.patches.some((patch) => patch.state === 'pending_reboot')) totals.pending_reboot += 1
    if (device.patches.some((patch) => patch.state === 'failed')) totals.failed += 1
    let group = groups.get(device.group_key)
    if (!group) {
      group = { label: device.group_label, devices: 0, compliant: 0, severity: {}, oldest: null }
      groups.set(device.group_key, group)
    }
    group.devices += 1
    if (compliant) group.compliant += 1
    for (const patch of device.patches) {
      if (!isMissingState(patch.state)) continue
      const severity: ComplianceSeverityKey = patch.severity ?? 'Unspecified'
      if (severity === 'Critical') totals.missing_critical += 1
      if (severity === 'Important') totals.missing_important += 1
      group.severity[severity] = (group.severity[severity] ?? 0) + 1
      const days = Math.max(0, Math.floor((now - patch.detected_at) / DAY))
      group.oldest = group.oldest === null ? days : Math.max(group.oldest, days)
    }
  }
  const rows: ComplianceRow[] = [...groups.entries()]
    .map(([key, group]) => ({
      key,
      label: group.label,
      devices: group.devices,
      compliant: group.compliant,
      compliance_pct: group.devices === 0 ? 100 : Math.round((group.compliant * 1000) / group.devices) / 10,
      missing_by_severity: Object.fromEntries(COMPLIANCE_SEVERITIES.map((severity) => [severity, group.severity[severity] ?? 0])),
      oldest_missing_days: group.oldest,
    }))
    .sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()))
  return { totals, rows }
}

/** Overall percentage with one decimal; null when no device has scanned yet. */
export function compliancePct(totals: Pick<ComplianceTotals, 'devices' | 'compliant'>): number | null {
  if (totals.devices === 0) return null
  return Math.round((totals.compliant * 1000) / totals.devices) / 10
}

/** Green at 95 % and above, amber from 80 %, red below. */
export function complianceTone(pct: number | null): Tone {
  if (pct === null) return 'neutral'
  if (pct >= 95) return 'live'
  if (pct >= 80) return 'warning'
  return 'critical'
}

export function missingTotal(row: Pick<ComplianceRow, 'missing_by_severity'>): number {
  return COMPLIANCE_SEVERITIES.reduce((sum, severity) => sum + (row.missing_by_severity[severity] ?? 0), 0)
}

export interface SeveritySegment {
  severity: ComplianceSeverityKey
  count: number
  /** Share of the row's missing pairs, 0–100. */
  pct: number
}

/** Non-empty severity segments of a row, most severe first. */
export function severitySegments(row: Pick<ComplianceRow, 'missing_by_severity'>): SeveritySegment[] {
  const total = missingTotal(row)
  if (total === 0) return []
  return COMPLIANCE_SEVERITIES.filter((severity) => (row.missing_by_severity[severity] ?? 0) > 0).map((severity) => {
    const count = row.missing_by_severity[severity] ?? 0
    return { severity, count, pct: (count / total) * 100 }
  })
}

export type ComplianceSort = 'label' | 'compliance' | 'devices' | 'missing' | 'oldest'

/** Sorts rows for the breakdown table; worst first for the numeric keys. */
export function sortComplianceRows(rows: readonly ComplianceRow[], sort: ComplianceSort): ComplianceRow[] {
  const byLabel = (a: ComplianceRow, b: ComplianceRow) => a.label.toLowerCase().localeCompare(b.label.toLowerCase())
  const out = [...rows]
  switch (sort) {
    case 'label':
      return out.sort(byLabel)
    case 'compliance':
      return out.sort((a, b) => a.compliance_pct - b.compliance_pct || byLabel(a, b))
    case 'devices':
      return out.sort((a, b) => b.devices - a.devices || byLabel(a, b))
    case 'missing':
      return out.sort((a, b) => missingTotal(b) - missingTotal(a) || byLabel(a, b))
    case 'oldest':
      return out.sort((a, b) => (b.oldest_missing_days ?? -1) - (a.oldest_missing_days ?? -1) || byLabel(a, b))
  }
}

/** "3 days", "5 weeks"; "—" for null. */
export function formatAge(days: number | null): string {
  if (days === null) return '—'
  if (days < 14) return `${days} ${days === 1 ? 'day' : 'days'}`
  if (days < 70) return `${Math.round(days / 7)} weeks`
  return `${Math.round(days / 30)} months`
}
