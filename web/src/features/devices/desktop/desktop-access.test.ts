import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api/errors'
import type { DesktopSession } from '@/lib/api/types'
import { validatePolicyDocument, mergePolicies, effectiveRows } from '@/lib/automation/policy'
import { consentExpectation, policyRefusal, preferredSession, screenshotFileName, secureDesktopLabel, sessionUnsupported } from './desktop-access'

const console1: DesktopSession = { session_id: 1, kind: 'console', user: null, state: 'login_screen', monitors: 1 }
const rdpActive: DesktopSession = { session_id: 2, kind: 'rdp', user: 'CORP\\administrator', state: 'active', monitors: 1 }
const rdpGone: DesktopSession = { session_id: 3, kind: 'rdp', user: 'CORP\\svc', state: 'disconnected', monitors: 1 }

describe('desktop access helpers', () => {
  it('reads a policy refusal', () => {
    const error = new ApiError(403, 'disabled_by_policy', 'Remote desktop is disabled', { feature: 'desktop', policy_id: 'p1', policy_name: 'Kiosk lockdown' })
    expect(policyRefusal(error)).toEqual({ policyName: 'Kiosk lockdown', policyId: 'p1' })
    expect(policyRefusal(new ApiError(403, 'forbidden', 'No'))).toBeNull()
    expect(policyRefusal(new Error('x'))).toBeNull()
  })

  it('prefers the active console, then any active session', () => {
    const activeConsole = { ...console1, user: 'CORP\\alex', state: 'active' as const }
    expect(preferredSession([rdpActive, activeConsole])).toBe(activeConsole)
    expect(preferredSession([console1, rdpGone, rdpActive])).toBe(rdpActive)
    expect(preferredSession([console1, rdpGone])).toBe(console1)
    expect(preferredSession([])).toBeNull()
    const wayland: DesktopSession = { session_id: 2, kind: 'console', user: 'ana', state: 'active', monitors: null, type: 'wayland' }
    expect(sessionUnsupported(wayland)).toMatch(/Wayland/)
    expect(preferredSession([wayland])).toBeNull()
  })

  it('predicts the consent prompt like the agent', () => {
    expect(consentExpectation('when_user_present', rdpActive)).toBe('ask')
    expect(consentExpectation('when_user_present', { ...rdpActive, state: 'locked' })).toBe('none')
    expect(consentExpectation('always', { ...rdpActive, state: 'locked' })).toBe('ask')
    expect(consentExpectation('always', console1)).toBe('none')
    expect(consentExpectation('never', rdpActive)).toBe('none')
  })

  it('labels secure desktops', () => {
    expect(secureDesktopLabel('winlogon')).toBe('UAC / sign-in screen')
    expect(secureDesktopLabel('screensaver')).toBe('Screen saver')
    expect(secureDesktopLabel('default')).toBeNull()
  })

  it('names screenshots after the device and time', () => {
    expect(screenshotFileName('NWD-FRONT-01', new Date(2026, 10, 18, 9, 5, 7))).toBe('NWD-FRONT-01 2026-11-18 09.05.07.png')
  })
})

describe('desktop policy keys', () => {
  it('validates the Phase 8 remote_access keys', () => {
    expect(validatePolicyDocument({ remote_access: { desktop: false, desktop_consent: 'always', consent_timeout_secs: 60, desktop_banner: false, desktop_view_only: true } })).toEqual([])
    expect(validatePolicyDocument({ remote_access: { desktop_consent: 'sometimes' } })[0]).toMatchObject({ path: 'remote_access.desktop_consent' })
    expect(validatePolicyDocument({ remote_access: { consent_timeout_secs: 4 } })[0]).toMatchObject({ path: 'remote_access.consent_timeout_secs', message: 'Must be between 5 and 300 seconds' })
    expect(validatePolicyDocument({ remote_access: { consent_timeout_secs: 30.5 } })[0].message).toBe('Must be a whole number')
    expect(validatePolicyDocument({ remote_access: { desktop_banner: 'yes' } })[0].message).toBe('Must be true or false')
    expect(validatePolicyDocument({ remote_access: { desktop_mode: true } })[0].message).toBe('Unknown setting “desktop_mode”')
  })

  it('merges desktop keys by layer and shows defaults', () => {
    const merged = mergePolicies([
      { policyId: 'global', document: { remote_access: { desktop: true, consent_timeout_secs: 45 } } },
      { policyId: 'client', document: { remote_access: { desktop_view_only: true } } },
    ])
    expect(merged.document.remote_access).toEqual({ desktop: true, consent_timeout_secs: 45, desktop_view_only: true })
    expect(merged.origins['remote_access.desktop_view_only']).toBe('client')
    const rows = effectiveRows({ ...merged, sources: [] })
    expect(rows.find((row) => row.path === 'remote_access.desktop_consent')?.value).toBe('Never ask')
    expect(rows.find((row) => row.path === 'remote_access.consent_timeout_secs')?.value).toBe('45 s')
    expect(rows.find((row) => row.path === 'remote_access.desktop')?.tone).toBe('allowed')
  })
})
