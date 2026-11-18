import { describe, expect, it } from 'vitest'
import { validatePolicyDocument } from '@/lib/automation/policy'
import { db } from './db'
import { CHECK_TYPES } from './monitoring-catalog'
import { alertsSummary, deviceChecks, publicWindow, sweep, type MonitoringWorld } from './monitoring-model'

const world = (): MonitoringWorld => ({
  automation: db.automation,
  devices: db.devices,
  clients: db.clients,
  sites: db.sites,
  monitoring: db.monitoring,
})

describe('mock monitoring seed', () => {
  it('ships a valid baseline policy and catalog', () => {
    expect(CHECK_TYPES).toHaveLength(18)
    const baseline = db.automation.policies.find((policy) => policy.name === 'Baseline monitoring')!
    expect(baseline.assignments[0].target_type).toBe('global')
    for (const policy of db.automation.policies)
      expect(validatePolicyDocument(policy.document, { checkTypes: CHECK_TYPES })).toEqual([])
  })

  it('has about forty alerts across severities and states, with timelines', () => {
    const alerts = db.monitoring.alerts
    expect(alerts.length).toBeGreaterThanOrEqual(35)
    expect(alerts.length).toBeLessThanOrEqual(50)
    for (const severity of ['critical', 'warning', 'info'] as const) expect(alerts.some((alert) => alert.severity === severity)).toBe(true)
    for (const status of ['open', 'acknowledged', 'resolved'] as const) expect(alerts.some((alert) => alert.status === status)).toBe(true)
    expect(alerts.some((alert) => alert.in_maintenance)).toBe(true)
    expect(alerts.some((alert) => alert.snoozed_until)).toBe(true)
    expect(alerts.some((alert) => alert.assigned_to)).toBe(true)
    expect(alerts.every((alert) => alert.events[0]?.kind === 'opened')).toBe(true)
    expect(alerts.some((alert) => alert.events.some((event) => event.details?.suppressed))).toBe(true)
    expect(alerts.some((alert) => alert.events.some((event) => event.details?.event === 'escalated'))).toBe(true)
    const summary = alertsSummary(db.monitoring)
    expect(summary.critical + summary.warning + summary.info).toBe(summary.open + summary.acknowledged)
  })

  it('logs deliveries, including quiet-hours holds and failures', () => {
    const statuses = new Set(db.monitoring.log.map((entry) => entry.status))
    expect(statuses).toEqual(new Set(['sent', 'suppressed', 'failed']))
    // A failing channel retries three times (four attempts) and the delivery ends failed.
    const failed = db.monitoring.log.find((entry) => entry.status === 'failed' && entry.event !== 'test')!
    const attempts = db.monitoring.log.filter((entry) => entry.delivery_id === failed.delivery_id)
    expect(attempts.map((entry) => entry.attempt).sort()).toEqual([1, 2, 3, 4])
    expect(attempts.find((entry) => entry.attempt === 4)?.finished_at).toBeTruthy()
  })

  it('has one maintenance window active now and device checks with policy sources', () => {
    expect(db.monitoring.windows.map((window) => publicWindow(window)).filter((window) => window.active_now)).toHaveLength(1)
    const fs01 = db.devices.find((device) => device.hostname === 'NWD-FS01')!
    const checks = deviceChecks(world(), fs01)
    expect(checks.find((check) => check.check_id === 'disk-space-windows')).toMatchObject({ state: 'warning', policy_name: 'Baseline monitoring' })
    expect(checks.find((check) => check.check_id === 'svc-windows-time')?.policy_name).toMatch(/^Servers/)
  })

  it('keeps alerts consistent with check states on the next sweep', () => {
    const before = db.monitoring.alerts.filter((alert) => alert.status !== 'resolved').length
    const result = sweep(world(), Date.now())
    const after = db.monitoring.alerts.filter((alert) => alert.status !== 'resolved').length
    // A sweep right after seeding must not churn: nothing new opens and at most a flapping metric resolves.
    expect(result.opened).toHaveLength(0)
    expect(before - after).toBeLessThanOrEqual(2)
  })
})
