import { describe, expect, it } from 'vitest'
import type { EffectivePolicySource, PolicyTask } from '@/lib/api/types'
import {
  compactPolicy,
  effectiveRows,
  formatAgentValue,
  mergePolicies,
  parsePolicyJson,
  policyHighlights,
  sortSources,
  taskIdFromName,
  validatePolicyDocument,
} from './policy'

const task = (id: string, overrides: Partial<PolicyTask> = {}): PolicyTask => ({
  id,
  name: id,
  script_id: 's1',
  parameters: {},
  cron: '0 3 * * 0',
  timezone: 'UTC',
  enabled: true,
  ...overrides,
})

describe('policy validation', () => {
  it('accepts a complete Phase 5 document', () => {
    expect(
      validatePolicyDocument({
        agent: { heartbeat_secs: 30 },
        remote_access: { shell: false },
        tasks: [task('weekly')],
      }),
    ).toEqual([])
    expect(validatePolicyDocument({})).toEqual([])
  })

  it('refuses unknown sections and keys', () => {
    expect(validatePolicyDocument({ tickets: {} })).toEqual([
      { path: 'tickets', message: 'Unknown section “tickets”' },
    ])
    expect(validatePolicyDocument({ agent: { poll_secs: 5 } })[0].path).toBe('agent.poll_secs')
    expect(validatePolicyDocument({ remote_access: { shell: 'yes' } })[0].message).toBe('Must be true or false')
    expect(validatePolicyDocument([])).toEqual([{ path: '', message: 'The policy must be a JSON object' }])
  })

  it('applies the agent interval ranges', () => {
    expect(validatePolicyDocument({ agent: { heartbeat_secs: 9 } })[0].message).toBe(
      'Must be between 10 and 300 seconds',
    )
    expect(validatePolicyDocument({ agent: { metrics_secs: 601 } })[0].path).toBe('agent.metrics_secs')
    expect(validatePolicyDocument({ agent: { inventory_minutes: 1440 } })).toEqual([])
    expect(validatePolicyDocument({ agent: { inventory_minutes: 30.5 } })[0].message).toBe('Must be a whole number')
  })

  it('checks tasks', () => {
    const issues = validatePolicyDocument({
      tasks: [task('a'), task('a'), task('Bad ID'), task('c', { cron: 'nope', timezone: 'Mars/Base', script_id: '' })],
    })
    expect(issues.map((issue) => issue.path)).toEqual([
      'tasks[1].id',
      'tasks[2].id',
      'tasks[3].script_id',
      'tasks[3].cron',
      'tasks[3].timezone',
    ])
  })

  it('reports JSON syntax errors with a line when possible', () => {
    const result = parsePolicyJson('{\n  "agent": {\n    "heartbeat_secs": 30,\n  }\n}')
    expect(result.document).toBeNull()
    expect(result.issues[0].message).toMatch(/JSON syntax error/)
    expect(parsePolicyJson('{"agent":{"heartbeat_secs":30}}').document).toEqual({ agent: { heartbeat_secs: 30 } })
    expect(parsePolicyJson('{"agent":{"heartbeat_secs":3}}').document).toBeNull()
  })

  it('drops empty sections', () => {
    expect(compactPolicy({ agent: {}, remote_access: { shell: true }, tasks: [] })).toEqual({
      remote_access: { shell: true },
    })
  })
})

describe('policy merge', () => {
  it('deep-merges objects in layer order and records origins per leaf', () => {
    const { document, origins } = mergePolicies([
      {
        policyId: 'global',
        document: { agent: { heartbeat_secs: 30, metrics_secs: 60 }, remote_access: { shell: true, files: true } },
      },
      { policyId: 'client', document: { agent: { heartbeat_secs: 20 }, remote_access: { files: false } } },
      { policyId: 'device', document: { remote_access: { shell: false } } },
    ])
    expect(document).toEqual({
      agent: { heartbeat_secs: 20, metrics_secs: 60 },
      remote_access: { shell: false, files: false },
    })
    expect(origins).toEqual({
      'agent.heartbeat_secs': 'client',
      'agent.metrics_secs': 'global',
      'remote_access.shell': 'device',
      'remote_access.files': 'client',
    })
  })

  it('concatenates tasks and de-duplicates by id, later layers winning in place', () => {
    const { document, origins } = mergePolicies([
      { policyId: 'global', document: { tasks: [task('cleanup'), task('defender')] } },
      { policyId: 'group', document: { tasks: [task('cleanup', { cron: '0 1 * * *' }), task('patch')] } },
    ])
    expect(document.tasks?.map((item) => [item.id, item.cron])).toEqual([
      ['cleanup', '0 1 * * *'],
      ['defender', '0 3 * * 0'],
      ['patch', '0 3 * * 0'],
    ])
    expect(origins['tasks.cleanup']).toBe('group')
    expect(origins['tasks.defender']).toBe('global')
  })

  it('orders sources global → client → site → groups by priority → device', () => {
    const sources = sortSources([
      { target_type: 'device', priority: 0 },
      { target_type: 'group', priority: 20 },
      { target_type: 'global', priority: 0 },
      { target_type: 'group', priority: 10 },
      { target_type: 'site', priority: 0 },
      { target_type: 'client', priority: 0 },
    ] as Pick<EffectivePolicySource, 'target_type' | 'priority'>[])
    expect(
      sources.map((source) => `${source.target_type}${source.target_type === 'group' ? source.priority : ''}`),
    ).toEqual(['global', 'client', 'site', 'group10', 'group20', 'device'])
  })
})

describe('effective policy display', () => {
  const effective = {
    document: {
      agent: { heartbeat_secs: 20 },
      remote_access: { files: false },
      tasks: [task('weekly', { name: 'Weekly cleanup' })],
    },
    origins: { 'agent.heartbeat_secs': 'p2', 'remote_access.files': 'p2', 'tasks.weekly': 'p1' },
    sources: [
      {
        policy_id: 'p1',
        policy_name: 'MSP baseline',
        version: 3,
        target_type: 'global' as const,
        target_name: null,
        priority: 0,
      },
      {
        policy_id: 'p2',
        policy_name: 'Meridian compliance',
        version: 1,
        target_type: 'client' as const,
        target_name: 'Meridian',
        priority: 0,
      },
    ],
  }

  it('shows every known key with its value, defaults and origin', () => {
    const rows = effectiveRows(effective)
    const byPath = Object.fromEntries(rows.map((row) => [row.path, row]))
    expect(byPath['agent.heartbeat_secs']).toMatchObject({
      value: '20 s',
      origin: { id: 'p2', name: 'Meridian compliance' },
    })
    expect(byPath['agent.metrics_secs']).toMatchObject({ value: '1 min', origin: null, raw: undefined })
    expect(byPath['remote_access.files']).toMatchObject({ value: 'Blocked by policy', tone: 'blocked' })
    expect(byPath['remote_access.shell']).toMatchObject({ tone: 'allowed', origin: null })
    expect(byPath['tasks.weekly']).toMatchObject({ label: 'Weekly cleanup', origin: { name: 'MSP baseline' } })
    // 3 agent settings, 5 remote switches (incl. desktop), 4 desktop session rules, 1 task.
    expect(rows).toHaveLength(3 + 5 + 4 + 1)
    expect(byPath['remote_access.desktop_view_only']).toMatchObject({ value: 'Off', origin: null })
  })

  it('formats values and highlights', () => {
    expect(formatAgentValue('heartbeat_secs', 45)).toBe('45 s')
    expect(formatAgentValue('metrics_secs', 120)).toBe('2 min')
    expect(formatAgentValue('inventory_minutes', 240)).toBe('4 h')
    expect(formatAgentValue('inventory_minutes', 90)).toBe('90 min')
    expect(policyHighlights(effective.document)).toEqual(['Heartbeat 20 s', 'File browser blocked', '1 scheduled task'])
  })

  it('derives unique task ids from names', () => {
    expect(taskIdFromName('Weekly temp cleanup!')).toBe('weekly-temp-cleanup')
    expect(taskIdFromName('Weekly', ['weekly', 'weekly-2'])).toBe('weekly-3')
    expect(taskIdFromName('!!!')).toBe('task')
  })
})
