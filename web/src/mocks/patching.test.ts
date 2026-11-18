import { describe, expect, it } from 'vitest'
import { validatePolicyDocument } from '@/lib/automation/policy'
import { db } from './db'
import { CHECK_TYPES } from './monitoring-catalog'
import { complianceFacts, configCache, decisionFor, devicePatchItems, type PatchingWorld } from './patching-model'
import { explorerItems, normalizeName, productDetail } from './software-model'

const world = (): PatchingWorld => ({ automation: db.automation, devices: db.devices, clients: db.clients, sites: db.sites, patching: db.patching })

describe('mock patching seed', () => {
  it('adds valid patching sections to the policies', () => {
    const withPatching = db.automation.policies.filter((policy) => policy.document.patching)
    expect(withPatching.length).toBeGreaterThanOrEqual(5)
    for (const policy of db.automation.policies) expect(validatePolicyDocument(policy.document, { checkTypes: CHECK_TYPES })).toEqual([])
  })

  it('has a mixed catalog with client-scoped rule approvals, manual decisions and overrides', () => {
    const platforms = new Set(db.patching.catalog.map((patch) => patch.platform))
    expect(platforms).toEqual(new Set(['windows', 'linux', 'macos', 'winget']))
    expect(db.patching.catalog.some((patch) => patch.classification === 'Drivers')).toBe(false)
    const rules = db.patching.decisions.filter((decision) => decision.source === 'rule')
    expect(rules.length).toBeGreaterThan(20)
    expect(rules.every((decision) => decision.client_id !== null)).toBe(true)
    expect(db.patching.decisions.some((decision) => decision.source === 'manual' && decision.client_id !== null)).toBe(true)
    expect(new Set(db.patching.decisions.map((decision) => decision.decision))).toEqual(new Set(['approved', 'declined', 'deferred']))
  })

  it('applies precedence: a client manual decision wins over its rule approval', () => {
    const meridian = db.clients.find((client) => client.name.startsWith('Meridian'))!
    const lcu = db.patching.catalog.find((patch) => patch.kb === 'KB5072033')!
    expect(decisionFor(db.patching, lcu.id, meridian.id)?.decision).toBe('deferred')
    expect(decisionFor(db.patching, lcu.id, null)).toBeNull()
  })

  it('gives devices states, effective approvals and scan status', () => {
    const state = world()
    const config = configCache(state)
    const device = db.devices.find((item) => item.hostname === 'NWD-FRONT-01')!
    const items = devicePatchItems(state, device, config(device))
    expect(items.length).toBeGreaterThan(4)
    expect(items.some((item) => item.effective_approved)).toBe(true)
    expect(db.patching.status[device.id]?.source).toBe('windows_update')
    const facts = complianceFacts(state, device, config(device), { key: 'k', label: 'K' })
    expect(facts?.patches.length).toBe(items.length)
  })

  it('has runs, a running immediate install, packages and deployments', () => {
    expect(db.patching.runs.some((run) => run.trigger === 'window' && run.status === 'completed')).toBe(true)
    expect(db.patching.runs.some((run) => run.trigger === 'manual')).toBe(true)
    expect(db.patching.packages.length).toBeGreaterThanOrEqual(15)
    expect(db.patching.packages.filter((pkg) => pkg.source.type === 'file').length).toBeGreaterThanOrEqual(2)
    expect(new Set(db.patching.deployments.map((deployment) => deployment.status))).toEqual(new Set(['completed', 'running', 'scheduled']))
  })

  it('builds the explorer from the inventory with normalised names', () => {
    expect(normalizeName('7-Zip 25.01 (x64)')).toBe('7-Zip')
    expect(normalizeName('Mozilla Firefox (x64 en-US)')).toBe('Mozilla Firefox')
    expect(normalizeName('Microsoft Visual C++ 2015-2022 Redistributable (x64) - 14.44.35211')).toBe('Microsoft Visual C++ 2015-2022 Redistributable')
    const items = explorerItems(world(), {})
    expect(items.find((item) => item.name === '7-Zip')?.devices).toBeGreaterThan(5)
    const chrome = productDetail(world(), 'Google Chrome', 'Google LLC')
    expect(chrome?.versions[0].version).toBe('142.0.7444.176')
  })
})
