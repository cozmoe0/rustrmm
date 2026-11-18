import { describe, expect, it } from 'vitest'
import type { QuietHours } from '@/lib/api/types'
import { describeQuietHours, isQuietAt, parseHm, quietPeriods, suppressesAt, validateQuietHours } from './quiet-hours'

const night: QuietHours = {
  enabled: true,
  start: '22:00',
  end: '07:00',
  timezone: 'Europe/London',
  days: [0, 1, 2, 3, 4, 5, 6],
  except_critical: true,
}

describe('quiet hours', () => {
  it('parses HH:MM', () => {
    expect(parseHm('07:30')).toBe(450)
    expect(parseHm('24:00')).toBeNull()
    expect(parseHm('7:30')).toBeNull()
  })

  it('evaluates an overnight window on the rule’s wall clock', () => {
    // 17 Nov 2026: London is on GMT, so wall clock equals UTC.
    expect(isQuietAt(night, new Date('2026-11-17T23:30:00Z'))).toBe(true)
    expect(isQuietAt(night, new Date('2026-11-17T06:59:00Z'))).toBe(true)
    expect(isQuietAt(night, new Date('2026-11-17T07:00:00Z'))).toBe(false)
    expect(isQuietAt(night, new Date('2026-11-17T21:59:00Z'))).toBe(false)
    // In summer London is UTC+1: 21:30Z is 22:30 local.
    expect(isQuietAt(night, new Date('2026-07-01T21:30:00Z'))).toBe(true)
    expect(isQuietAt({ ...night, enabled: false }, new Date('2026-11-17T23:30:00Z'))).toBe(false)
  })

  it('assigns an overnight period to the day it starts on', () => {
    const fridays = { ...night, days: [5] }
    // Friday 20 Nov 2026 23:00 and Saturday 03:00 are quiet; Friday 03:00 (Thursday night) is not.
    expect(isQuietAt(fridays, new Date('2026-11-20T23:00:00Z'))).toBe(true)
    expect(isQuietAt(fridays, new Date('2026-11-21T03:00:00Z'))).toBe(true)
    expect(isQuietAt(fridays, new Date('2026-11-20T03:00:00Z'))).toBe(false)
  })

  it('treats an empty day list as every day', () => {
    expect(isQuietAt({ ...night, days: [] }, new Date('2026-11-17T23:30:00Z'))).toBe(true)
    expect(describeQuietHours({ ...night, days: [] })).toContain('every day')
  })

  it('handles same-day windows and the critical exception', () => {
    const lunch = { ...night, start: '12:00', end: '13:00', timezone: 'UTC', except_critical: false }
    expect(isQuietAt(lunch, new Date('2026-11-17T12:30:00Z'))).toBe(true)
    expect(isQuietAt(lunch, new Date('2026-11-17T13:00:00Z'))).toBe(false)
    const at = new Date('2026-11-17T23:30:00Z')
    expect(suppressesAt(night, 'critical', at)).toBe(false)
    expect(suppressesAt(night, 'warning', at)).toBe(true)
    expect(suppressesAt({ ...night, except_critical: false }, 'critical', at)).toBe(true)
  })

  it('lists the current and upcoming quiet periods', () => {
    const periods = quietPeriods(night, { from: new Date('2026-11-17T23:00:00Z'), count: 2 })
    expect(periods.map((period) => [period.start.toISOString(), period.end.toISOString()])).toEqual([
      ['2026-11-17T22:00:00.000Z', '2026-11-18T07:00:00.000Z'],
      ['2026-11-18T22:00:00.000Z', '2026-11-19T07:00:00.000Z'],
    ])
    const weekdays = { ...night, timezone: 'UTC', days: [1, 2, 3, 4, 5] }
    // From Saturday 21 Nov, the next quiet period starts Monday 22:00.
    expect(quietPeriods(weekdays, { from: new Date('2026-11-21T12:00:00Z'), count: 1 })[0].start.toISOString()).toBe(
      '2026-11-23T22:00:00.000Z',
    )
  })

  it('describes and validates the settings', () => {
    expect(describeQuietHours(night)).toBe('22:00–07:00 (next day) every day, Europe/London · critical alerts still notify')
    expect(describeQuietHours({ ...night, days: [1, 2, 3, 4, 5], except_critical: false })).toBe(
      '22:00–07:00 (next day) on weekdays, Europe/London · all severities are held',
    )
    expect(describeQuietHours({ ...night, enabled: false })).toMatch(/^Off/)
    expect(validateQuietHours({ ...night, start: '25:00', days: [], timezone: 'Mars/Base' }).map((issue) => issue.field)).toEqual([
      'start',
      'timezone',
    ])
  })
})
