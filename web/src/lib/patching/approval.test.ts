import { describe, expect, it } from 'vitest'
import type { AutoApproveRule, Patch } from '@/lib/api/types'
import {
  deferUntilIso,
  describeApproval,
  effectiveApproval,
  formatDelay,
  formatRingDelays,
  matchingRule,
  ringSchedule,
  ruleMatches,
} from './approval'

const DAY = 86_400_000
const now = Date.UTC(2026, 10, 18, 12)
const release = new Date(now - 5 * DAY).toISOString()

function patch(overrides: Partial<Patch> = {}): Patch {
  return {
    id: 'p1',
    platform: 'windows',
    key: 'abc',
    kb: 'KB5070001',
    title: '2026-11 Cumulative Update',
    classification: 'SecurityUpdates',
    severity: 'Critical',
    size_bytes: 1,
    reboot_required: true,
    release_date: release,
    first_seen_at: release,
    description: '',
    support_url: null,
    cves: [],
    approval: { status: 'approved', source: 'rule', approved_at: release, at: release, by_name: 'Rule', client_id: 'c1' },
    devices: { missing: 1, installed: 0, failed: 0, pending_reboot: 0 },
    ...overrides,
  }
}

const rules: AutoApproveRule[] = [
  { platform: 'windows', classifications: ['Definitions'], delay_days: { pilot: 0, broad: 0, late: 0 } },
  { platform: 'windows', classifications: ['SecurityUpdates', 'CriticalUpdates'], severities: [], delay_days: { pilot: 0, broad: 3, late: 10 } },
  { platform: 'linux', classifications: ['security'] },
]

describe('rule matching', () => {
  it('matches platform, classification and severity like the server', () => {
    expect(ruleMatches(rules[1], patch())).toBe(true)
    expect(ruleMatches(rules[1], patch({ classification: 'Drivers' }))).toBe(false)
    expect(ruleMatches(rules[1], patch({ platform: 'linux' }))).toBe(false)
    expect(ruleMatches({ platform: 'windows', classifications: ['securityupdates'] }, patch())).toBe(true)
  })

  it('treats empty lists as wildcards and a missing severity only as matching no-severity rules', () => {
    expect(ruleMatches({ platform: 'windows' }, patch({ classification: 'Tools' }))).toBe(true)
    expect(ruleMatches({ platform: 'windows', severities: ['Critical'] }, patch({ severity: null }))).toBe(false)
    expect(ruleMatches({ platform: 'windows', severities: [] }, patch({ severity: null }))).toBe(true)
  })

  it('uses the first matching rule in list order', () => {
    expect(matchingRule(rules, patch())).toBe(rules[1])
    expect(matchingRule(rules, patch({ classification: 'Definitions' }))).toBe(rules[0])
    expect(matchingRule(rules, patch({ classification: 'Upgrades' }))).toBeUndefined()
  })
})

describe('ring delays', () => {
  it('schedules each ring from the release date', () => {
    const schedule = ringSchedule(patch(), { pilot: 0, broad: 3, late: 10 }, now)
    expect(schedule.map((ring) => [ring.ring, ring.available, ring.daysLeft])).toEqual([
      ['pilot', true, 0],
      ['broad', true, 0],
      ['late', false, 5],
    ])
  })

  it('counts from first sighting when there is no release date, and treats unset delays as 0', () => {
    const seen = new Date(now - DAY).toISOString()
    const schedule = ringSchedule(patch({ release_date: null, first_seen_at: seen }), { broad: 2 }, now)
    expect(schedule[0]).toMatchObject({ ring: 'pilot', delay: 0, available: true })
    expect(schedule[1]).toMatchObject({ ring: 'broad', delay: 2, available: false, daysLeft: 1 })
  })

  it('formats delays for badges', () => {
    expect(formatDelay(0)).toBe('same day')
    expect(formatDelay(1)).toBe('1 day')
    expect(formatRingDelays({ pilot: 0, broad: 7 })).toBe('Pilot 0d · Broad 7d · Late 0d')
  })
})

describe('effective approval', () => {
  it('applies the ring delay to rule approvals', () => {
    expect(effectiveApproval(patch(), { ring: 'broad', rules }, now).approved).toBe(true)
    const late = effectiveApproval(patch(), { ring: 'late', delays: { late: 10 } }, now)
    expect(late.approved).toBe(false)
    expect(late.pendingUntil?.getTime()).toBe(now + 5 * DAY)
  })

  it('takes manual approvals immediately, whatever the ring', () => {
    const manual = patch({ approval: { status: 'approved', source: 'manual', approved_at: new Date(now - DAY).toISOString(), by_name: 'Avery', client_id: null } })
    const result = effectiveApproval(manual, { ring: 'late', delays: { late: 30 } }, now)
    expect(result.approved).toBe(true)
    expect(result.reason).toBe('Approved manually')
  })

  it('never approves declined, pending or actively deferred patches', () => {
    expect(effectiveApproval(patch({ approval: { status: 'declined' } }), { ring: 'pilot' }, now).approved).toBe(false)
    expect(effectiveApproval(patch({ approval: { status: 'none' } }), { ring: 'pilot' }, now).reason).toBe('Waiting for approval')
    const deferred = effectiveApproval(patch({ approval: { status: 'deferred', until: new Date(now + DAY).toISOString() } }), { ring: 'pilot' }, now)
    expect(deferred.approved).toBe(false)
    expect(deferred.reason).toMatch(/^Deferred until/)
  })
})

describe('approval display', () => {
  it('distinguishes rule approvals, manual approvals and client overrides', () => {
    expect(describeApproval(patch().approval, now)).toMatchObject({ label: 'Approved · rule', source: 'rule', override: false })
    const manual = describeApproval({ status: 'approved', source: 'manual', approved_at: release, by_name: 'Avery Chen', client_id: null }, now)
    expect(manual).toMatchObject({ label: 'Approved', source: 'manual', override: false })
    expect(manual.detail).toContain('Avery Chen')
    expect(describeApproval({ status: 'declined', source: 'manual', by_name: 'Sam', client_id: 'c1' }, now).override).toBe(true)
  })

  it('shows deferrals with their date and flags expired ones', () => {
    expect(describeApproval({ status: 'deferred', until: new Date(now + 3 * DAY).toISOString() }, now).label).toMatch(/^Deferred · /)
    expect(describeApproval({ status: 'deferred', until: new Date(now - DAY).toISOString() }, now).label).toBe('Deferral expired')
  })

  it('turns a picked defer date into a future end-of-day instant', () => {
    expect(deferUntilIso('2026-11-25', now)).toBe(new Date(2026, 10, 25, 23, 59).toISOString())
    expect(deferUntilIso('2026-11-01', now)).toBeNull()
    expect(deferUntilIso('next week', now)).toBeNull()
  })
})
