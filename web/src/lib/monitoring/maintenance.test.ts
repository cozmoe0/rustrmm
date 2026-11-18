import { describe, expect, it } from 'vitest'
import type { MaintenanceSchedule } from '@/lib/api/types'
import {
  currentOccurrence,
  describeSchedule,
  isActiveAt,
  nextStart,
  occurrences,
  startsIn,
  validateMaintenance,
  windowPhase,
} from './maintenance'

const patchNight: MaintenanceSchedule = { type: 'recurring', cron: '0 22 * * 3', duration_minutes: 180, timezone: 'UTC' }

describe('maintenance schedules', () => {
  it('expands recurring windows, including one already running', () => {
    // Wednesday 18 Nov 2026, 23:00 UTC: inside the 22:00–01:00 window.
    const at = new Date('2026-11-18T23:00:00Z')
    const list = occurrences(patchNight, { from: at, count: 2 })
    expect(list.map((item) => [item.start.toISOString(), item.end.toISOString()])).toEqual([
      ['2026-11-18T22:00:00.000Z', '2026-11-19T01:00:00.000Z'],
      ['2026-11-25T22:00:00.000Z', '2026-11-26T01:00:00.000Z'],
    ])
    expect(isActiveAt(patchNight, at)).toBe(true)
    expect(currentOccurrence(patchNight, at)?.end.toISOString()).toBe('2026-11-19T01:00:00.000Z')
    expect(nextStart(patchNight, at)?.toISOString()).toBe('2026-11-25T22:00:00.000Z')
    expect(isActiveAt(patchNight, new Date('2026-11-19T01:00:00Z'))).toBe(false)
  })

  it('evaluates recurring windows in their own time zone', () => {
    const london: MaintenanceSchedule = { ...patchNight, timezone: 'Europe/London', cron: '0 22 * * *' }
    // 1 July 2026: London is UTC+1, so 22:00 local is 21:00Z.
    expect(nextStart(london, new Date('2026-07-01T12:00:00Z'))?.toISOString()).toBe('2026-07-01T21:00:00.000Z')
  })

  it('handles one-off windows', () => {
    const once: MaintenanceSchedule = { type: 'once', start: '2026-11-20T10:00:00Z', end: '2026-11-20T12:00:00Z' }
    expect(isActiveAt(once, new Date('2026-11-20T11:00:00Z'))).toBe(true)
    expect(nextStart(once, new Date('2026-11-19T00:00:00Z'))?.toISOString()).toBe('2026-11-20T10:00:00.000Z')
    expect(occurrences(once, { from: new Date('2026-11-21T00:00:00Z') })).toEqual([])
    expect(windowPhase({ enabled: true, schedule: once }, new Date('2026-11-21T00:00:00Z'))).toBe('ended')
    expect(windowPhase({ enabled: false, schedule: once }, new Date('2026-11-20T11:00:00Z'))).toBe('disabled')
    expect(windowPhase({ enabled: true, schedule: patchNight }, new Date('2026-11-18T12:00:00Z'))).toBe('scheduled')
  })

  it('describes schedules for people', () => {
    expect(describeSchedule(patchNight)).toBe('Weekly on Wednesday at 22:00 for 3 h · UTC')
    expect(describeSchedule({ ...patchNight, cron: '30 1 * * 1-5', duration_minutes: 90 })).toBe(
      'Weekdays at 01:30 for 1 h 30 min · UTC',
    )
    expect(describeSchedule({ type: 'once', start: '2026-11-20T10:00:00Z', end: '2026-11-20T12:00:00Z' }, 'UTC')).toMatch(
      /^Once · .+ → .+ \(2 h\)$/,
    )
    expect(describeSchedule({ type: 'once', start: '2026-11-20T12:00:00Z', end: '2026-11-20T10:00:00Z' })).toBe(
      'The end must be after the start',
    )
    expect(startsIn('2026-11-18T13:30:00Z', new Date('2026-11-18T12:00:00Z').getTime())).toBe('in 1 h 30 min')
  })

  it('validates the editor input', () => {
    const issues = validateMaintenance({
      name: ' ',
      enabled: true,
      targets: [{ type: 'client' }],
      schedule: { type: 'recurring', cron: 'nope', duration_minutes: 0, timezone: 'Mars/Base' },
      suppress: 'notifications',
    })
    expect(issues.map((issue) => issue.field)).toEqual(['name', 'targets', 'cron', 'duration', 'timezone'])
    expect(
      validateMaintenance({
        name: 'Patch night',
        enabled: true,
        targets: [{ type: 'global' }],
        schedule: patchNight,
        suppress: 'alerts',
      }),
    ).toEqual([])
  })
})
