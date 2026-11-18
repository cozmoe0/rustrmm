import { describe, expect, it } from 'vitest'
import type { CheckTypeDefinition } from '@/lib/api/types'
import { compactPolicy, mergePolicies, policyHighlights, validatePolicyDocument } from '@/lib/automation/policy'
import { effectiveMonitoring, newCheck, validateMonitoring } from './policy-monitoring'

const CATALOG: CheckTypeDefinition[] = [
  {
    type: 'disk',
    label: 'Disk space',
    description: '',
    graded: true,
    platforms: ['windows', 'linux', 'macos'],
    config_schema: [
      { key: 'volume', label: 'Volume', type: 'text', required: true, default: '*' },
      { key: 'warn_free_pct', label: 'Warning below', type: 'number', required: false, default: 15, min: 1, max: 99, unit: '%' },
      { key: 'crit_free_pct', label: 'Critical below', type: 'number', required: false, default: 5, min: 1, max: 99, unit: '%' },
    ],
  },
]

describe('monitoring policy section', () => {
  const disk = { ...newCheck(CATALOG[0], []), id: 'disk-c' }

  it('creates checks with defaults from the catalog', () => {
    expect(disk).toEqual({
      id: 'disk-c',
      type: 'disk',
      name: 'Disk space',
      enabled: true,
      interval_secs: 300,
      severity: 'warning',
      config: { volume: '*', warn_free_pct: 15, crit_free_pct: 5 },
    })
    expect(newCheck(CATALOG[0], ['disk-space']).id).toBe('disk-space-2')
  })

  it('validates full checks, overrides and the server block', () => {
    expect(validatePolicyDocument({ monitoring: { checks: [disk], server: { offline_minutes: 15 } } }, { checkTypes: CATALOG })).toEqual([])
    expect(validateMonitoring({ checks: [{ id: 'disk-c', enabled: false }] })).toEqual([])
    // Defaults make name, interval and severity optional; platforms limit where a check runs.
    expect(validateMonitoring({ checks: [{ id: 'Disk_C', type: 'disk', platforms: ['windows'] }] }, CATALOG)).toEqual([])
    expect(validateMonitoring({ checks: [{ id: 'x', type: 'disk', platforms: ['beos'] }] }, CATALOG)[0].path).toBe(
      'monitoring.checks[0].platforms',
    )
    expect(validateMonitoring({ checks: [{ id: 'x', type: 'disk', config: { volume: 'C:', warn_free_pct: null, crit_free_pct: null } }] }, CATALOG)).toEqual([
      { path: 'monitoring.checks[0].config.warn_free_pct', message: 'Set at least one threshold' },
    ])
    const issues = validateMonitoring(
      {
        checks: [
          { ...disk, interval_secs: 10, config: { volume: '*', warn_free_pct: 120 } },
          { id: 'disk-c', type: 'nope', name: '', severity: 'urgent', interval_secs: 60, remediation: { script_id: '', max_attempts: 0 } },
        ],
        server: { offline_minutes: -1, agent_outdated: 'yes', bogus: 1 },
        extra: true,
      },
      CATALOG,
    )
    expect(issues.map((issue) => issue.path)).toEqual([
      'monitoring.extra',
      'monitoring.checks[0].interval_secs',
      'monitoring.checks[0].config.warn_free_pct',
      'monitoring.checks[1].id',
      'monitoring.checks[1].type',
      'monitoring.checks[1].name',
      'monitoring.checks[1].severity',
      'monitoring.checks[1].remediation.script_id',
      'monitoring.checks[1].remediation.max_attempts',
      'monitoring.server.offline_minutes',
      'monitoring.server.agent_outdated',
      'monitoring.server.bogus',
    ])
  })

  it('redefines a check when a later layer sets a different type', () => {
    const { document } = mergePolicies([
      { policyId: 'a', document: { monitoring: { checks: [disk] } } },
      { policyId: 'b', document: { monitoring: { checks: [{ id: 'disk-c', type: 'cpu', config: { warn_pct: 80 } }] } } },
    ])
    expect(document.monitoring?.checks?.[0]).toEqual({ id: 'disk-c', type: 'cpu', config: { warn_pct: 80 } })
  })

  it('merges checks by id field by field and records origins', () => {
    const { document, origins } = mergePolicies([
      { policyId: 'base', document: { monitoring: { checks: [disk], server: { offline_minutes: 15, security_changes: true } } } },
      {
        policyId: 'servers',
        document: { monitoring: { checks: [{ id: 'disk-c', severity: 'critical', config: { warn_free_pct: 20 } }], server: { offline_minutes: 5 } } },
      },
    ])
    expect(document.monitoring?.checks?.[0]).toMatchObject({
      type: 'disk',
      severity: 'critical',
      config: { volume: '*', warn_free_pct: 20, crit_free_pct: 5 },
    })
    expect(document.monitoring?.server).toEqual({ offline_minutes: 5, security_changes: true })
    // The origin is the last policy that touched the check.
    expect(origins['monitoring.checks.disk-c']).toBe('servers')
    expect(origins['monitoring.server.offline_minutes']).toBe('servers')
    expect(origins['monitoring.server.security_changes']).toBe('base')

    const rows = effectiveMonitoring(
      {
        document,
        origins,
        sources: [
          { policy_id: 'base', policy_name: 'Baseline monitoring', version: 1, target_type: 'global', target_name: null, priority: 0 },
          { policy_id: 'servers', policy_name: 'Servers', version: 1, target_type: 'group', target_name: 'Servers', priority: 10 },
        ],
      },
      CATALOG,
    )
    expect(rows.checks[0]).toMatchObject({
      name: 'Disk space',
      origin: { id: 'servers', name: 'Servers' },
      graded: true,
      summary: 'Every fixed volume · Warning below 20% · Critical below 5%',
    })
    expect(rows.server.find((row) => row.key === 'offline_minutes')).toMatchObject({
      value: 'After 5 min',
      origin: { name: 'Servers' },
    })
    expect(rows.server.find((row) => row.key === 'disk_forecast_days')).toMatchObject({ value: 'Within 14 days', origin: null })
  })

  it('compacts the section and adds highlights', () => {
    expect(compactPolicy({ monitoring: { checks: [], server: {} } })).toEqual({})
    expect(compactPolicy({ monitoring: { checks: [{ ...disk, config: { volume: 'C:', warn_free_pct: undefined as never } }] } }, CATALOG)).toEqual({
      monitoring: { checks: [{ ...disk, config: { volume: 'C:' } }] },
    })
    expect(policyHighlights({ monitoring: { checks: [disk, { id: 'x', enabled: false }], server: { offline_minutes: 30 } } })).toEqual([
      '1 check',
      '1 check override',
      'Offline alert 30 min',
    ])
  })
})
