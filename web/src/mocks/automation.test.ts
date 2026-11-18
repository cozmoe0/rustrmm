import { describe, expect, it } from 'vitest'
import { validateParameterDefinitions } from '@/lib/automation/params'
import { validatePolicyDocument } from '@/lib/automation/policy'
import { ruleFieldCatalog, validateRules } from '@/lib/automation/rules'
import {
  effectivePolicyFor,
  groupMembers,
  parseDirectives,
  publicJobSummary,
  renderOutput,
  resolveTarget,
  syntheticResults,
  type World,
} from './automation-model'
import { db } from './db'
import { LIBRARY } from './script-library'

const world = (): World => ({ automation: db.automation, devices: db.devices, clients: db.clients, sites: db.sites })

describe('mock automation seed', () => {
  it('ships about forty valid built-in scripts', () => {
    const builtins = db.automation.scripts.filter((script) => script.builtin)
    expect(builtins.length).toBeGreaterThanOrEqual(40)
    expect(new Set(builtins.map((script) => script.name)).size).toBe(builtins.length)
    for (const script of db.automation.scripts) {
      const current = script.versions[script.versions.length - 1]
      expect(current.content_sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(validateParameterDefinitions(current.parameters).every((issues) => Object.keys(issues).length === 0)).toBe(
        true,
      )
    }
    expect(new Set(LIBRARY.map((entry) => entry.key)).size).toBe(LIBRARY.length)
  })

  it('has custom scripts with history and pending approval', () => {
    const custom = db.automation.scripts.filter((script) => !script.builtin)
    expect(
      custom.some((script) => script.versions.length >= 3 && script.approved_version !== script.versions.length),
    ).toBe(true)
  })

  it('resolves dynamic and static groups against the fleet', () => {
    const state = world()
    const fields = ruleFieldCatalog(db.automation.customFields)
    for (const group of db.automation.groups) {
      if (group.rules) expect(validateRules(group.rules, fields)).toEqual([])
      expect(groupMembers(state, group).length).toBeGreaterThan(0)
    }
    const servers = db.automation.groups.find((group) => group.name === 'Windows servers')!
    expect(groupMembers(state, servers).every((device) => device.os_family === 'windows')).toBe(true)
  })

  it('merges policies into an effective policy with origins', () => {
    const state = world()
    for (const policy of db.automation.policies) expect(validatePolicyDocument(policy.document)).toEqual([])
    const server = db.devices.find((device) => device.hostname === 'HPL-DC01')!
    const effective = effectivePolicyFor(state, server)
    expect(effective.sources[0].target_type).toBe('global')
    expect(effective.document.remote_access?.power).toBe(false)
    const servers = db.automation.policies.find((policy) => policy.name.startsWith('Servers'))!
    expect(effective.origins['remote_access.power']).toBe(servers.id)
    expect(effective.document.tasks?.map((task) => task.id)).toContain('nightly-defender-update')
  })

  it('regenerates historical results deterministically and parses directives', () => {
    const state = world()
    const run = db.automation.runs.find((item) => item.synthetic && item.counts.total > 3)!
    const first = syntheticResults(state, run)
    expect(syntheticResults(state, run)).toEqual(first)
    expect(first.length).toBe(run.counts.total)
    const asset = db.automation.scripts.find((script) => script.key === 'win-asset-tag')!
    const job = db.automation.jobs.find((item) => item.script_id === asset.id)!
    const device = resolveTarget(state, job.target).find((item) => item.os_family === 'windows')!
    const output = renderOutput(asset, job, device, 42, true)
    expect(parseDirectives(state, output.stdout)).toEqual([
      expect.objectContaining({ field: 'asset_tag', applied: true }),
    ])
  })

  it('exposes pending approvals and a live run', () => {
    expect(db.automation.approvals.filter((approval) => approval.status === 'pending').length).toBeGreaterThanOrEqual(2)
    const live = db.automation.runs.find((run) => !run.synthetic && run.status === 'running')
    expect(live?.results?.length).toBeGreaterThan(0)
    const job = db.automation.jobs.find((item) => item.id === live!.job_id)!
    expect(publicJobSummary(world(), job).last_run?.id).toBe(live!.id)
  })
})
