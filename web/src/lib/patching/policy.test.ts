import { describe, expect, it } from 'vitest'
import type { PolicyDocument } from '@/lib/api/types'
import { compactPolicy, mergePolicies, parsePolicyJson, policyHighlights, validatePolicyDocument } from '@/lib/automation/policy'
import {
  changeRulePlatform,
  compactPatching,
  effectivePatching,
  newRule,
  patchingChanged,
  rebootPreview,
  ruleIssues,
  setPatchingField,
  setPatchingKey,
  setPatchingSection,
  validatePatching,
  windowOccurrences,
} from './policy'

const full: PolicyDocument = {
  patching: {
    enabled: true,
    scan_interval_hours: 12,
    window: { cron: '0 2 * * 3', duration_minutes: 180, timezone: 'UTC' },
    ring: 'broad',
    auto_approve: [
      { platform: 'windows', classifications: ['SecurityUpdates', 'CriticalUpdates'], severities: [], delay_days: { pilot: 0, broad: 7, late: 21 } },
      { platform: 'linux', classifications: ['security'], delay_days: { pilot: 0, broad: 3, late: 10 } },
    ],
    windows: { include_drivers: false, include_feature_updates: false, include_preview: false },
    linux: { mode: 'security' },
    macos: { install: false },
    reboot: { mode: 'prompt', prompt_deferrals: 3, force_at_window_end: true, message: 'Your IT team installed updates. Please restart to finish.' },
    third_party: { winget: false },
  },
}

describe('patching section validation', () => {
  it('accepts the contract example and an empty section', () => {
    expect(validatePolicyDocument(full)).toEqual([])
    expect(validatePatching({})).toEqual([])
  })

  it('points at the offending path like the server', () => {
    const paths = (value: unknown) => validatePatching(value).map((issue) => issue.path)
    expect(paths({ ring: 'early' })).toEqual(['patching.ring'])
    expect(paths({ scan_interval_hours: 0 })).toEqual(['patching.scan_interval_hours'])
    expect(paths({ window: { duration_minutes: 180 } })).toEqual(['patching.window.cron'])
    expect(paths({ window: { cron: '0 2 * * 3', duration_minutes: 10 } })).toEqual(['patching.window.duration_minutes'])
    expect(paths({ auto_approve: [{ platform: 'android' }] })).toEqual(['patching.auto_approve[0].platform'])
    expect(paths({ auto_approve: [{ platform: 'linux', classifications: ['SecurityUpdates'] }] })).toEqual(['patching.auto_approve[0].classifications[0]'])
    expect(paths({ auto_approve: [{ platform: 'winget', classifications: ['app'], delay_days: { broad: 400 } }] })).toEqual(['patching.auto_approve[0].delay_days.broad'])
    expect(paths({ reboot: { mode: 'later', prompt_deferrals: 11, message: 'x'.repeat(501) } })).toEqual([
      'patching.reboot.mode',
      'patching.reboot.prompt_deferrals',
      'patching.reboot.message',
    ])
    expect(paths({ linux: { mode: 'everything' }, extra: 1 })).toEqual(['patching.extra', 'patching.linux.mode'])
    expect(paths({ auto_approve: Array.from({ length: 51 }, () => ({ platform: 'windows' })) })).toEqual(['patching.auto_approve'])
  })

  it('routes rule issues to their card', () => {
    const issues = validatePatching({ auto_approve: [{ platform: 'windows' }, { platform: 'linux', severities: ['Urgent'] }] })
    expect(ruleIssues(issues, 1)).toEqual([{ path: 'severities[0]', message: 'Must be Critical, Important, Moderate or Low' }])
    expect(ruleIssues(issues, 0)).toEqual([])
  })
})

describe('form and JSON stay in sync', () => {
  it('edits through the form produce the document the JSON tab shows, and parse back unchanged', () => {
    let doc: PolicyDocument = { agent: { heartbeat_secs: 30 } }
    doc = setPatchingKey(doc, 'enabled', true)
    doc = setPatchingSection(doc, 'window', { cron: '0 22 * * 6', duration_minutes: 240, timezone: 'America/Chicago' })
    doc = setPatchingKey(doc, 'ring', 'late')
    doc = setPatchingField(doc, 'reboot', 'mode', 'force')
    doc = setPatchingKey(doc, 'auto_approve', [newRule('windows')])
    const text = JSON.stringify(doc, null, 2)
    const parsed = parsePolicyJson(text)
    expect(parsed.issues).toEqual([])
    expect(parsed.document).toEqual(doc)
    expect(doc.patching).toEqual({
      enabled: true,
      window: { cron: '0 22 * * 6', duration_minutes: 240, timezone: 'America/Chicago' },
      ring: 'late',
      reboot: { mode: 'force' },
      auto_approve: [newRule('windows')],
    })
  })

  it('removes keys set back to inherit, and the section once it is empty', () => {
    let doc = setPatchingField({}, 'reboot', 'prompt_deferrals', 5)
    expect(doc.patching).toEqual({ reboot: { prompt_deferrals: 5 } })
    doc = setPatchingField(doc, 'reboot', 'prompt_deferrals', undefined)
    expect(doc).toEqual({})
    expect(setPatchingKey({ patching: { ring: 'pilot' } }, 'ring', undefined)).toEqual({})
  })

  it('compacts empty sub-objects before saving and detects patching changes', () => {
    expect(compactPatching({ windows: {}, reboot: { mode: undefined }, ring: 'pilot' })).toEqual({ ring: 'pilot' })
    expect(compactPatching({ windows: {} })).toBeUndefined()
    expect(compactPolicy({ agent: {}, patching: { auto_approve: [] } })).toEqual({ patching: { auto_approve: [] } })
    expect(patchingChanged({ patching: { windows: {} } }, {})).toBe(false)
    expect(patchingChanged({}, { patching: { enabled: true } })).toBe(true)
  })

  it('keeps classifications the new platform allows when a rule changes platform', () => {
    expect(changeRulePlatform({ platform: 'macos', classifications: ['security', 'os'] }, 'linux').classifications).toEqual(['security'])
    expect(changeRulePlatform({ platform: 'windows', classifications: ['SecurityUpdates'] }, 'winget').classifications).toEqual([])
  })
})

describe('merge and effective view', () => {
  it('deep-merges objects, replaces rule lists whole and records leaf origins', () => {
    const merged = mergePolicies([
      { policyId: 'base', document: full },
      { policyId: 'servers', document: { patching: { ring: 'late', reboot: { mode: 'force' }, auto_approve: [{ platform: 'windows', classifications: ['Definitions'] }] } } },
    ])
    expect(merged.document.patching?.ring).toBe('late')
    expect(merged.document.patching?.reboot).toMatchObject({ mode: 'force', prompt_deferrals: 3, force_at_window_end: true })
    expect(merged.document.patching?.auto_approve).toEqual([{ platform: 'windows', classifications: ['Definitions'] }])
    expect(merged.origins).toMatchObject({
      'patching.ring': 'servers',
      'patching.reboot.mode': 'servers',
      'patching.reboot.prompt_deferrals': 'base',
      'patching.window.cron': 'base',
      'patching.auto_approve': 'servers',
    })
  })

  it('shows defaults with no origin and set values with their policy', () => {
    const view = effectivePatching({
      document: { patching: { enabled: true, ring: 'pilot' } },
      origins: { 'patching.enabled': 'p1', 'patching.ring': 'p1' },
      sources: [{ policy_id: 'p1', policy_name: 'Pilot ring', version: 1, target_type: 'group', target_name: 'IT', priority: 0 }],
    })
    expect(view.enabled).toBe(true)
    const byPath = Object.fromEntries(view.rows.map((row) => [row.path, row]))
    expect(byPath['patching.ring']).toMatchObject({ value: 'Pilot', origin: { id: 'p1', name: 'Pilot ring' }, inherited: false })
    expect(byPath['patching.scan_interval_hours']).toMatchObject({ value: 'Every 12 hours', origin: null, inherited: true })
    expect(byPath['patching.window.cron'].value).toMatch(/^No window/)
  })

  it('previews the window, the restart prompt and the policy chips', () => {
    const runs = windowOccurrences({ cron: '0 2 * * 3', timezone: 'UTC' }, 3, new Date(Date.UTC(2026, 10, 18, 3)))
    expect(runs.map((run) => run.toISOString())).toEqual(['2026-11-25T02:00:00.000Z', '2026-12-02T02:00:00.000Z', '2026-12-09T02:00:00.000Z'])
    expect(rebootPreview({ mode: 'prompt', prompt_deferrals: 2, message: 'Restart soon' })).toMatchObject({ actions: ['Yes', 'No'], body: 'Restart soon\n\nRestart now?' })
    expect(rebootPreview({ mode: 'never' }).actions).toEqual([])
    expect(policyHighlights(full)).toEqual(expect.arrayContaining(['Patching on', 'Broad ring', '2 approval rules', 'Ask the user']))
  })
})
