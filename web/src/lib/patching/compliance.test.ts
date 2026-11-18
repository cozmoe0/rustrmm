import { describe, expect, it } from 'vitest'
import {
  complianceTone,
  compliancePct,
  deviceCompliant,
  formatAge,
  severitySegments,
  sortComplianceRows,
  summarizeCompliance,
  type ComplianceDeviceFacts,
  type CompliancePatchFact,
} from './compliance'

const DAY = 86_400_000
const now = Date.UTC(2026, 10, 18)

const fact = (state: CompliancePatchFact['state'], severity: CompliancePatchFact['severity'], detectedDaysAgo: number, approvedDaysAgo: number | null): CompliancePatchFact => ({
  state,
  severity,
  detected_at: now - detectedDaysAgo * DAY,
  effective_since: approvedDaysAgo === null ? null : now - approvedDaysAgo * DAY,
})

describe('device compliance', () => {
  it('allows a 7-day grace period from the later of detection and approval', () => {
    expect(deviceCompliant([fact('missing', 'Critical', 30, 6)], now)).toBe(true)
    expect(deviceCompliant([fact('missing', 'Critical', 30, 8)], now)).toBe(false)
    expect(deviceCompliant([fact('missing', 'Critical', 2, 30)], now)).toBe(true)
  })

  it('ignores unapproved patches but always counts failed installs', () => {
    expect(deviceCompliant([fact('missing', 'Critical', 90, null)], now)).toBe(true)
    expect(deviceCompliant([fact('failed', 'Low', 1, null)], now)).toBe(false)
    expect(deviceCompliant([fact('installed', 'Critical', 90, 90), fact('superseded', null, 60, 60)], now)).toBe(true)
  })
})

describe('compliance aggregation', () => {
  const devices: ComplianceDeviceFacts[] = [
    { group_key: 'b', group_label: 'Bluebird', pending_reboot: false, patches: [fact('missing', 'Critical', 10, 9), fact('missing', 'Important', 4, null)] },
    { group_key: 'b', group_label: 'Bluebird', pending_reboot: true, patches: [fact('installed', 'Critical', 10, 9)] },
    { group_key: 'a', group_label: 'Atlas', pending_reboot: false, patches: [fact('failed', 'Critical', 3, 3), fact('pending_reboot', 'Moderate', 2, 2)] },
    { group_key: 'a', group_label: 'Atlas', pending_reboot: false, patches: [fact('downloaded', null, 1, null)] },
  ]

  it('counts missing pairs by severity and devices for restarts and failures', () => {
    const { totals } = summarizeCompliance(devices, now)
    expect(totals).toEqual({
      devices: 4,
      compliant: 2,
      non_compliant: 2,
      missing_critical: 2,
      missing_important: 1,
      pending_reboot: 2,
      failed: 1,
    })
  })

  it('builds rows sorted by label with severities, one-decimal percentages and the oldest age', () => {
    const { rows } = summarizeCompliance(devices, now)
    expect(rows.map((row) => row.label)).toEqual(['Atlas', 'Bluebird'])
    expect(rows[0]).toMatchObject({ devices: 2, compliant: 1, compliance_pct: 50, oldest_missing_days: 3 })
    expect(rows[0].missing_by_severity).toEqual({ Critical: 1, Important: 0, Moderate: 0, Low: 0, Unspecified: 1 })
    expect(rows[1]).toMatchObject({ compliant: 1, oldest_missing_days: 10 })
    const three = summarizeCompliance([...devices.slice(0, 2), { ...devices[1] }], now).rows[0]
    expect(three.compliance_pct).toBe(66.7)
  })

  it('reports null ages and no segments for fully patched groups', () => {
    const { rows } = summarizeCompliance([devices[1]], now)
    expect(rows[0].oldest_missing_days).toBeNull()
    expect(severitySegments(rows[0])).toEqual([])
  })

  it('splits the bar by severity and sorts worst first', () => {
    const { rows } = summarizeCompliance(devices, now)
    expect(severitySegments(rows[1]).map((segment) => [segment.severity, segment.pct])).toEqual([
      ['Critical', 50],
      ['Important', 50],
    ])
    expect(sortComplianceRows(rows, 'oldest')[0].label).toBe('Bluebird')
    expect(sortComplianceRows(rows, 'compliance').map((row) => row.label)).toEqual(['Atlas', 'Bluebird'])
  })

  it('derives the headline percentage and tone', () => {
    expect(compliancePct({ devices: 3, compliant: 2 })).toBe(66.7)
    expect(compliancePct({ devices: 0, compliant: 0 })).toBeNull()
    expect(complianceTone(97)).toBe('live')
    expect(complianceTone(85)).toBe('warning')
    expect(complianceTone(40)).toBe('critical')
    expect(formatAge(null)).toBe('—')
    expect(formatAge(1)).toBe('1 day')
    expect(formatAge(35)).toBe('5 weeks')
  })
})
