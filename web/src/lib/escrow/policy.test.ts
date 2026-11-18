import { describe, expect, it } from 'vitest'
import { compactPolicy, mergePolicies, policyHighlights, validatePolicyDocument } from '@/lib/automation/policy'
import { compactEscrow, effectiveLaps, escrowChanged, isValidAccountName, mergeEscrowLayers, setLapsKey, validateEscrow } from './policy'

describe('escrow policy section', () => {
  it('validates like the server', () => {
    expect(validateEscrow({ laps: { enabled: true, account: 'rmm-admin', length: 20, complexity: 'full', rotate_days: 30, rotate_after_reveal_hours: 0 }, filevault: { escrow: false } })).toEqual([])
    const issues = validateEscrow({ laps: { length: 8, rotate_days: 0, rotate_after_reveal_hours: 721, account: '-bad', complexity: 'simple', disable_other_admins: true }, filevault: { escrow: 'yes' }, extra: {} })
    expect(issues.map((issue) => issue.path).sort()).toEqual(
      ['escrow.extra', 'escrow.filevault.escrow', 'escrow.laps.account', 'escrow.laps.complexity', 'escrow.laps.disable_other_admins', 'escrow.laps.length', 'escrow.laps.rotate_after_reveal_hours', 'escrow.laps.rotate_days'].sort(),
    )
    expect(isValidAccountName('it-admin')).toBe(true)
    expect(isValidAccountName('.hidden')).toBe(false)
    expect(isValidAccountName('a'.repeat(21))).toBe(false)
  })

  it('is a known section of the policy document', () => {
    expect(validatePolicyDocument({ escrow: { laps: { enabled: true } } })).toEqual([])
    expect(validatePolicyDocument({ escrow: { laps: { length: 99 } } })[0]?.path).toBe('escrow.laps.length')
  })

  it('compacts unset keys away', () => {
    expect(compactEscrow({ laps: { enabled: true, length: Number.NaN } })).toEqual({ laps: { enabled: true } })
    expect(compactEscrow({ laps: {}, filevault: {} })).toBeUndefined()
    expect(compactPolicy({ escrow: { laps: {} } })).toEqual({})
    expect(setLapsKey(undefined, 'rotate_days', 14)).toEqual({ laps: { rotate_days: 14 } })
    expect(setLapsKey({ laps: { rotate_days: 14 } }, 'rotate_days', undefined)).toEqual({ laps: {} })
  })

  it('deep-merges layers and records each leaf’s origin', () => {
    const merged = mergeEscrowLayers([
      { policyId: 'global', escrow: { laps: { enabled: true, rotate_days: 30 }, filevault: { escrow: false } } },
      { policyId: 'client', escrow: { laps: { rotate_days: 14 } } },
    ])
    expect(merged.escrow).toEqual({ laps: { enabled: true, rotate_days: 14 }, filevault: { escrow: false } })
    expect(merged.origins).toEqual({ 'escrow.laps.enabled': 'global', 'escrow.laps.rotate_days': 'client', 'escrow.filevault.escrow': 'global' })
    const document = mergePolicies([
      { policyId: 'a', document: { escrow: { laps: { account: 'it-admin' } } } },
      { policyId: 'b', document: { escrow: { laps: { enabled: true } } } },
    ]).document
    expect(effectiveLaps(document.escrow)).toMatchObject({ enabled: true, account: 'it-admin', rotate_days: 30, length: 20 })
  })

  it('summarises and detects changes', () => {
    expect(policyHighlights({ escrow: { laps: { enabled: true, account: 'it-admin', rotate_days: 14, rotate_after_reveal_hours: 24 } } })).toEqual(
      expect.arrayContaining(['LAPS on · it-admin', 'Rotate every 14 days', 'Rotate 1 day after a reveal']),
    )
    expect(escrowChanged({ laps: { enabled: true, rotate_days: 30 } }, { laps: { rotate_days: 30, enabled: true } })).toBe(false)
    expect(escrowChanged({ laps: { enabled: true } }, { laps: { enabled: false } })).toBe(true)
    expect(escrowChanged(undefined, { laps: {} })).toBe(false)
  })
})
