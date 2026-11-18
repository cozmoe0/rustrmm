import { describe, expect, it } from 'vitest'
import type { TicketSla } from '@/lib/api/types'
import {
  formatBusinessMinutes,
  formatCountdown,
  formatMinutes,
  headlineClock,
  isBreached,
  parseDuration,
  slaClock,
  timerMinutes,
} from './sla'

const NOW = new Date('2026-11-18T12:00:00Z').getTime()
const offset = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString()

function sla(overrides: Partial<TicketSla> = {}): TicketSla {
  return {
    policy_id: 'p',
    policy_name: 'Default (24x7)',
    first_response_due: offset(180),
    first_response_at: null,
    first_response_breached: false,
    resolution_due: offset(600),
    resolved_at: null,
    resolution_breached: false,
    paused: false,
    ...overrides,
  }
}

describe('slaClock', () => {
  it('is green with time to spare', () => {
    expect(slaClock(sla(), 'first_response', NOW)).toMatchObject({ tone: 'ok', label: '3h', remaining_ms: 180 * 60_000 })
  })

  it('turns amber within the hour', () => {
    expect(slaClock(sla({ first_response_due: offset(45) }), 'first_response', NOW)).toMatchObject({ tone: 'due_soon', label: '45m' })
  })

  it('turns red once a running clock passes its due time, before the server flags it', () => {
    expect(slaClock(sla({ first_response_due: offset(-12) }), 'first_response', NOW)).toMatchObject({ tone: 'breached', label: '12m over' })
  })

  it('trusts the server breach flag', () => {
    expect(slaClock(sla({ resolution_breached: true, paused: true, resolution_due: offset(-30) }), 'resolution', NOW).tone).toBe('breached')
  })

  it('shows a paused clock without a countdown', () => {
    expect(slaClock(sla({ paused: true }), 'resolution', NOW)).toMatchObject({ tone: 'paused', label: 'Paused' })
  })

  it('reports met and met-late targets', () => {
    expect(slaClock(sla({ first_response_at: offset(-10) }), 'first_response', NOW)).toMatchObject({ tone: 'met', remaining_ms: null })
    expect(slaClock(sla({ first_response_due: offset(-60), first_response_at: offset(-10), first_response_breached: true }), 'first_response', NOW).tone).toBe('met_late')
  })
})

describe('headlineClock', () => {
  it('shows first response until it is met, then resolution', () => {
    expect(headlineClock({ status: 'new', sla: sla() }, NOW)?.kind).toBe('first_response')
    expect(headlineClock({ status: 'open', sla: sla({ first_response_at: offset(-5) }) }, NOW)?.kind).toBe('resolution')
  })

  it('shows the resolution outcome for resolved tickets and nothing without an SLA', () => {
    const resolved = headlineClock({ status: 'resolved', sla: sla({ first_response_at: offset(-50), resolved_at: offset(-5) }) }, NOW)
    expect(resolved).toMatchObject({ kind: 'resolution', tone: 'met' })
    expect(headlineClock({ status: 'open', sla: null }, NOW)).toBeNull()
  })

  it('detects breaches on either target', () => {
    expect(isBreached(sla({ resolution_due: offset(-1) }), NOW)).toBe(true)
    expect(isBreached(sla(), NOW)).toBe(false)
    expect(isBreached(null, NOW)).toBe(false)
  })
})

describe('duration formatting', () => {
  it('formats countdowns with two units at most', () => {
    expect(formatCountdown(45_000)).toBe('45s')
    expect(formatCountdown(12 * 60_000)).toBe('12m')
    expect(formatCountdown((2 * 60 + 14) * 60_000)).toBe('2h 14m')
    expect(formatCountdown(3 * 3_600_000)).toBe('3h')
    expect(formatCountdown((3 * 24 + 4) * 3_600_000 + 59_000)).toBe('3d 4h')
    expect(formatCountdown(-(2 * 24) * 3_600_000)).toBe('2d')
  })

  it('formats business-minute targets', () => {
    expect(formatBusinessMinutes(30)).toBe('30m')
    expect(formatBusinessMinutes(240)).toBe('4h')
    expect(formatBusinessMinutes(90)).toBe('1h 30m')
    expect(formatBusinessMinutes(4320)).toBe('72h')
    expect(formatBusinessMinutes(5760)).toBe('96h')
    expect(formatBusinessMinutes(170 * 60)).toBe('7d 2h')
  })

  it('formats logged minutes', () => {
    expect(formatMinutes(0)).toBe('0m')
    expect(formatMinutes(45)).toBe('45m')
    expect(formatMinutes(90)).toBe('1h 30m')
    expect(formatMinutes(720)).toBe('12h')
  })

  it('parses typed durations', () => {
    expect(parseDuration('90')).toBe(90)
    expect(parseDuration('90m')).toBe(90)
    expect(parseDuration('1h 30m')).toBe(90)
    expect(parseDuration('1.5h')).toBe(90)
    expect(parseDuration('2d')).toBe(2880)
    expect(parseDuration('1d4h')).toBe(1680)
    expect(parseDuration('')).toBeNull()
    expect(parseDuration('soon')).toBeNull()
    expect(parseDuration('1h later')).toBeNull()
  })

  it('rounds a stopped timer up to whole minutes, at least one', () => {
    expect(timerMinutes(5_000)).toBe(1)
    expect(timerMinutes(60_000)).toBe(1)
    expect(timerMinutes(61_000)).toBe(2)
  })
})
