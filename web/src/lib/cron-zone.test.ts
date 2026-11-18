import { describe, expect, it } from 'vitest'
import { describeCron, instantFromWall, isValidTimeZone, nextCronRuns, wallClock } from './cron'

describe('time-zone-aware cron preview', () => {
  it('validates IANA zones', () => {
    expect(isValidTimeZone('Europe/London')).toBe(true)
    expect(isValidTimeZone('UTC')).toBe(true)
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false)
    expect(isValidTimeZone('')).toBe(false)
  })

  it('round-trips wall-clock times', () => {
    const instant = Date.UTC(2026, 10, 17, 15, 30)
    const wall = wallClock(instant, 'America/New_York')
    expect(new Date(wall).toISOString()).toBe('2026-11-17T10:30:00.000Z')
    expect(instantFromWall(wall, 'America/New_York')).toBe(instant)
  })

  it('computes the next runs in UTC', () => {
    const runs = nextCronRuns('0 3 * * 0', { timeZone: 'UTC', count: 3, from: new Date('2026-11-17T12:00:00Z') })
    expect(runs.map((run) => run.toISOString())).toEqual([
      '2026-11-22T03:00:00.000Z',
      '2026-11-29T03:00:00.000Z',
      '2026-12-06T03:00:00.000Z',
    ])
  })

  it('evaluates the expression on the zone’s wall clock across a DST change', () => {
    // US daylight saving ends on Sunday 1 November 2026: 09:00 is 13:00Z before and 14:00Z after.
    const runs = nextCronRuns('0 9 * * *', {
      timeZone: 'America/New_York',
      count: 3,
      from: new Date('2026-10-30T20:00:00Z'),
    })
    expect(runs.map((run) => run.toISOString())).toEqual([
      '2026-10-31T13:00:00.000Z',
      '2026-11-01T14:00:00.000Z',
      '2026-11-02T14:00:00.000Z',
    ])
  })

  it('skips wall times that do not exist in a spring-forward gap', () => {
    // 2027-03-14 02:30 doesn't exist in New York.
    const runs = nextCronRuns('30 2 * * *', {
      timeZone: 'America/New_York',
      count: 2,
      from: new Date('2027-03-13T12:00:00Z'),
    })
    expect(runs.map((run) => run.toISOString())).toEqual(['2027-03-15T06:30:00.000Z', '2027-03-16T06:30:00.000Z'])
  })

  it('handles step and weekday expressions', () => {
    const runs = nextCronRuns('*/15 9-10 * * 1-5', {
      timeZone: 'Europe/London',
      count: 3,
      from: new Date('2026-11-20T10:50:00Z'),
    })
    // Friday 20 November 10:50 in London is past the last 10:45 slot, so the next run is Monday 09:00.
    expect(runs.map((run) => run.toISOString())).toEqual([
      '2026-11-23T09:00:00.000Z',
      '2026-11-23T09:15:00.000Z',
      '2026-11-23T09:30:00.000Z',
    ])
  })

  it('returns nothing for invalid input', () => {
    expect(nextCronRuns('nope', { timeZone: 'UTC' })).toEqual([])
    expect(nextCronRuns('0 3 * * *', { timeZone: 'Nowhere/City' })).toEqual([])
  })

  it('describes more schedule shapes', () => {
    expect(describeCron('*/15 * * * *')).toBe('Every 15 minutes')
    expect(describeCron('0 8 * * 1-5')).toBe('Weekdays at 08:00')
    expect(describeCron('30 22 * * 0,6')).toBe('Weekends at 22:30')
    expect(describeCron('0 7 * * 1,3,5')).toBe('Mon, Wed, Fri at 07:00')
  })
})
