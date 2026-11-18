import { describe, expect, it } from 'vitest'
import type { BusinessHours } from '@/lib/api/types'
import {
  addBusinessMinutes,
  businessMinutesBetween,
  describeBusinessHours,
  dueTimes,
  isBusinessTime,
  parseClock,
  previousLocal,
} from './business-time'

const at = (iso: string) => new Date(iso).getTime()
const iso = (ms: number) => new Date(ms).toISOString()

const OFFICE: BusinessHours = { timezone: 'UTC', days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00', holidays: [] }

describe('parseClock', () => {
  it('reads HH:MM including 24:00', () => {
    expect(parseClock('08:30')).toBe(510)
    expect(parseClock('24:00')).toBe(1440)
    expect(parseClock('24:01')).toBeNull()
    expect(parseClock('8:30')).toBeNull()
    expect(parseClock('12:60')).toBeNull()
  })
})

describe('addBusinessMinutes', () => {
  it('adds wall-clock minutes for 24x7 policies', () => {
    expect(iso(addBusinessMinutes(at('2026-11-20T17:30:00Z'), 240, null))).toBe('2026-11-20T21:30:00.000Z')
  })

  it('fits inside the current window', () => {
    expect(iso(addBusinessMinutes(at('2026-11-20T17:30:00Z'), 30, OFFICE))).toBe('2026-11-20T18:00:00.000Z')
  })

  it('carries the remainder over the weekend (Friday 17:30 + 1h is Monday 08:30)', () => {
    expect(iso(addBusinessMinutes(at('2026-11-20T17:30:00Z'), 60, OFFICE))).toBe('2026-11-23T08:30:00.000Z')
  })

  it('starts the clock at the next window when opened out of hours', () => {
    expect(iso(addBusinessMinutes(at('2026-11-21T10:00:00Z'), 60, OFFICE))).toBe('2026-11-23T09:00:00.000Z')
  })

  it('skips holidays', () => {
    const hours = { ...OFFICE, holidays: ['2026-12-25'] }
    // Thursday 24 Dec 17:00 + 2h: one hour on Thursday, Friday is a holiday, one hour on Monday.
    expect(iso(addBusinessMinutes(at('2026-12-24T17:00:00Z'), 120, hours))).toBe('2026-12-28T09:00:00.000Z')
  })

  it('handles overnight windows that end the next day', () => {
    const nights: BusinessHours = { timezone: 'UTC', days: [1, 2, 3, 4, 5], start: '22:00', end: '06:00', holidays: [] }
    expect(iso(addBusinessMinutes(at('2026-11-16T23:00:00Z'), 120, nights))).toBe('2026-11-17T01:00:00.000Z')
    // Friday 05:00 is inside Thursday's window; one hour remains there, then Friday night's window.
    expect(iso(addBusinessMinutes(at('2026-11-20T05:00:00Z'), 120, nights))).toBe('2026-11-20T23:00:00.000Z')
  })

  it('treats 00:00–24:00 every day like 24x7', () => {
    const always: BusinessHours = { timezone: 'UTC', days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '24:00', holidays: [] }
    expect(iso(addBusinessMinutes(at('2026-11-21T23:30:00Z'), 90, always))).toBe('2026-11-22T01:00:00.000Z')
  })

  it('works on the policy zone wall clock', () => {
    const london: BusinessHours = { ...OFFICE, timezone: 'Europe/London' }
    // Summer time: 08:00 BST is 07:00 UTC.
    expect(iso(addBusinessMinutes(at('2026-07-03T16:30:00Z'), 60, london))).toBe('2026-07-06T07:30:00.000Z')
  })
})

describe('businessMinutesBetween', () => {
  it('counts only business time', () => {
    expect(businessMinutesBetween(at('2026-11-20T17:00:00Z'), at('2026-11-23T09:00:00Z'), OFFICE)).toBe(120)
    expect(businessMinutesBetween(at('2026-11-21T00:00:00Z'), at('2026-11-22T23:59:00Z'), OFFICE)).toBe(0)
    expect(businessMinutesBetween(at('2026-11-20T10:00:00Z'), at('2026-11-20T09:00:00Z'), OFFICE)).toBe(0)
  })

  it('counts the real length of a window across a DST change', () => {
    const sunday: BusinessHours = { timezone: 'America/New_York', days: [7], start: '01:00', end: '05:00', holidays: [] }
    // 8 March 2026: clocks jump from 02:00 to 03:00, so 01:00–05:00 lasts three hours.
    expect(businessMinutesBetween(at('2026-03-08T00:00:00Z'), at('2026-03-09T00:00:00Z'), sunday)).toBe(180)
  })
})

describe('policy helpers', () => {
  it('computes both due times for a priority', () => {
    const policy = {
      business_hours: OFFICE,
      targets: {
        urgent: { first_response_minutes: 30, resolution_minutes: 240 },
        high: { first_response_minutes: 60, resolution_minutes: 480 },
        normal: { first_response_minutes: 240, resolution_minutes: 1440 },
        low: { first_response_minutes: 480, resolution_minutes: 4320 },
      },
    }
    const due = dueTimes(policy, 'urgent', at('2026-11-20T17:30:00Z'))
    expect(iso(due.first_response_due)).toBe('2026-11-20T18:00:00.000Z')
    expect(iso(due.resolution_due)).toBe('2026-11-23T11:30:00.000Z')
  })

  it('knows when it is business time', () => {
    expect(isBusinessTime(at('2026-11-18T12:00:00Z'), OFFICE)).toBe(true)
    expect(isBusinessTime(at('2026-11-18T19:00:00Z'), OFFICE)).toBe(false)
    expect(isBusinessTime(at('2026-11-22T12:00:00Z'), null)).toBe(true)
  })

  it('finds the previous local weekday and time for previews', () => {
    expect(iso(previousLocal(5, '17:30', 'UTC', at('2026-11-18T12:00:00Z')))).toBe('2026-11-13T17:30:00.000Z')
  })

  it('describes business hours', () => {
    expect(describeBusinessHours(null)).toBe('24x7')
    expect(describeBusinessHours(OFFICE)).toBe('Mon–Fri 08:00–18:00 (UTC)')
    expect(describeBusinessHours({ ...OFFICE, days: [1, 3, 5] })).toBe('Mon, Wed, Fri 08:00–18:00 (UTC)')
  })
})
