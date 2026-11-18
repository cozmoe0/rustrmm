import { describe, expect, it } from 'vitest'
import { cronFromPreset, describeCron, isValidCron, nextCronRun, parseField, presetFromCron } from './cron'

describe('cron helpers', () => {
  it('maps presets both ways', () => {
    expect(cronFromPreset('daily')).toBe('0 2 * * *')
    expect(cronFromPreset('hourly')).toBe('0 * * * *')
    expect(presetFromCron('0  2 * *  *')).toBe('daily')
    expect(presetFromCron('15 4 * * 1')).toBe('custom')
    expect(cronFromPreset('custom', '15 4 * * 1')).toBe('15 4 * * 1')
  })

  it('validates expressions', () => {
    expect(isValidCron('0 2 * * *')).toBe(true)
    expect(isValidCron('*/15 9-17 * * 1-5')).toBe(true)
    expect(isValidCron('0 2 * *')).toBe(false)
    expect(isValidCron('61 2 * * *')).toBe(false)
    expect(isValidCron('0 24 * * *')).toBe(false)
    expect(isValidCron('a b c d e')).toBe(false)
  })

  it('expands fields', () => {
    expect([...parseField('*/20', [0, 59])!]).toEqual([0, 20, 40])
    expect([...parseField('1,3,5-7', [0, 59])!]).toEqual([1, 3, 5, 6, 7])
    expect(parseField('5-2', [0, 59])).toBeNull()
  })

  it('describes common schedules', () => {
    expect(describeCron('0 2 * * *')).toBe('Daily at 02:00')
    expect(describeCron('0 * * * *')).toBe('Every hour')
    expect(describeCron('0 */6 * * *')).toBe('Every 6 hours at :00')
    expect(describeCron('0 3 * * 0')).toBe('Weekly on Sunday at 03:00')
    expect(describeCron('30 1 15 * *')).toBe('Monthly on day 15 at 01:30')
    expect(describeCron('nope')).toBe('Invalid schedule')
  })

  it('computes the next run strictly after the reference time', () => {
    const from = new Date(2026, 10, 17, 1, 30) // 17 Nov 2026 01:30 local
    expect(nextCronRun('0 2 * * *', from)).toEqual(new Date(2026, 10, 17, 2, 0))
    expect(nextCronRun('0 2 * * *', new Date(2026, 10, 17, 2, 0))).toEqual(new Date(2026, 10, 18, 2, 0))
    // Weekly on Sunday 03:00 — 17 Nov 2026 is a Tuesday, so the next Sunday is the 22nd.
    expect(nextCronRun('0 3 * * 0', from)).toEqual(new Date(2026, 10, 22, 3, 0))
    expect(nextCronRun('0 */6 * * *', from)).toEqual(new Date(2026, 10, 17, 6, 0))
  })
})
