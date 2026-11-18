/*
 * Quiet hours for notification rules: whether a moment falls inside them (on the rule's own wall clock,
 * including windows that run past midnight), the upcoming quiet periods and a readable description.
 */
import type { AlertSeverity, QuietHours } from '@/lib/api/types'
import { formatInZone, instantFromWall, isValidTimeZone, wallClock } from '@/lib/cron'
import { WEEKDAY_SHORT } from './labels'

const DAY_MS = 86_400_000
const HM = /^([01]\d|2[0-3]):([0-5]\d)$/

export function parseHm(value: string): number | null {
  const match = HM.exec(value.trim())
  return match ? Number(match[1]) * 60 + Number(match[2]) : null
}

export function isValidHm(value: string): boolean {
  return parseHm(value) !== null
}

export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]

export function defaultQuietHours(timezone = 'UTC'): QuietHours {
  return { enabled: false, start: '22:00', end: '07:00', timezone, days: [...ALL_DAYS], except_critical: true }
}

/** Length of one quiet period in minutes; equal start and end mean the whole day. */
function spanMinutes(start: number, end: number) {
  return end > start ? end - start : end === start ? 1440 : 1440 - start + end
}

/** The days a rule is quiet on; an empty list means every day. */
export function quietDays(quiet: Pick<QuietHours, 'days'>): number[] {
  return quiet.days.length ? quiet.days : ALL_DAYS
}

/**
 * Whether `at` falls inside the quiet hours. A period belongs to the day it starts on, so with
 * 22:00–07:00 on Fridays only, Saturday 03:00 is quiet but Friday 03:00 is not.
 */
export function isQuietAt(quiet: QuietHours, at: Date | number): boolean {
  if (!quiet.enabled || !isValidTimeZone(quiet.timezone || 'UTC')) return false
  const start = parseHm(quiet.start)
  const end = parseHm(quiet.end)
  if (start === null || end === null) return false
  const days = quietDays(quiet)
  const wall = new Date(wallClock(typeof at === 'number' ? at : at.getTime(), quiet.timezone || 'UTC'))
  const minutes = wall.getUTCHours() * 60 + wall.getUTCMinutes()
  const today = wall.getUTCDay()
  const yesterday = (today + 6) % 7
  const span = spanMinutes(start, end)
  // Minutes since the period that started today (or yesterday, for one that runs past midnight).
  if (days.includes(today) && minutes >= start && minutes - start < span) return true
  if (days.includes(yesterday) && start + span > 1440 && minutes < start + span - 1440) return true
  return false
}

/** Whether a notification for an alert of `severity` would be held back at `at`. */
export function suppressesAt(quiet: QuietHours, severity: AlertSeverity, at: Date | number): boolean {
  if (quiet.except_critical && severity === 'critical') return false
  return isQuietAt(quiet, at)
}

export interface QuietPeriod {
  start: Date
  end: Date
}

/** The current and next quiet periods, in order, ending after `from`. */
export function quietPeriods(quiet: QuietHours, { from = new Date(), count = 3 }: { from?: Date; count?: number } = {}): QuietPeriod[] {
  const zone = quiet.timezone || 'UTC'
  if (!quiet.enabled || !isValidTimeZone(zone)) return []
  const start = parseHm(quiet.start)
  const end = parseHm(quiet.end)
  if (start === null || end === null) return []
  const days = quietDays(quiet)
  const span = spanMinutes(start, end)
  const wallNow = wallClock(from.getTime(), zone)
  const midnight = Math.floor(wallNow / DAY_MS) * DAY_MS
  const periods: QuietPeriod[] = []
  const toInstant = (wall: number) => {
    // A wall time skipped by a DST change starts an hour later.
    return instantFromWall(wall, zone) ?? instantFromWall(wall + 3_600_000, zone) ?? wall
  }
  for (let offset = -1; offset <= 14 && periods.length < count; offset += 1) {
    const day = midnight + offset * DAY_MS
    if (!days.includes(new Date(day).getUTCDay())) continue
    const startWall = day + start * 60_000
    const endWall = startWall + span * 60_000
    const period = { start: new Date(toInstant(startWall)), end: new Date(toInstant(endWall)) }
    if (period.end.getTime() <= from.getTime()) continue
    // Back-to-back periods (every day, 00:00–00:00) merge into one.
    const last = periods.at(-1)
    if (last && last.end.getTime() >= period.start.getTime()) last.end = period.end
    else periods.push(period)
  }
  return periods
}

function describeDays(days: number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b)
  if (sorted.length === 7 || sorted.length === 0) return 'every day'
  if (sorted.join() === '1,2,3,4,5') return 'on weekdays'
  if (sorted.join() === '0,6') return 'at weekends'
  return `on ${sorted.map((day) => WEEKDAY_SHORT[day]).join(', ')}`
}

/** "22:00–07:00 (next day) every day, Europe/London · critical alerts still notify". */
export function describeQuietHours(quiet: QuietHours): string {
  if (!quiet.enabled) return 'Off — notifications are sent at any time'
  const start = parseHm(quiet.start)
  const end = parseHm(quiet.end)
  if (start === null || end === null) return 'Enter start and end times as HH:MM'
  const range =
    start === end ? 'All day' : `${quiet.start}–${quiet.end}${end < start ? ' (next day)' : ''}`
  const zone = (quiet.timezone || 'UTC').replace(/_/g, ' ')
  const critical = quiet.except_critical ? ' · critical alerts still notify' : ' · all severities are held'
  return `${range} ${describeDays(quiet.days)}, ${zone}${critical}`
}

/** "Quiet now until Tue 07:00" or "Next quiet period Mon 22:00" for the rule list. */
export function quietStatus(quiet: QuietHours, from = new Date()): { quiet: boolean; label: string } | null {
  const [first] = quietPeriods(quiet, { from, count: 1 })
  if (!first) return null
  const active = first.start.getTime() <= from.getTime()
  return active
    ? { quiet: true, label: `Quiet now until ${formatInZone(first.end, quiet.timezone || 'UTC')}` }
    : { quiet: false, label: `Next quiet period ${formatInZone(first.start, quiet.timezone || 'UTC')}` }
}

export interface QuietHoursIssue {
  field: 'start' | 'end' | 'timezone'
  message: string
}

/** No days selected is valid: the server treats an empty list as every day. */
export function validateQuietHours(quiet: QuietHours): QuietHoursIssue[] {
  if (!quiet.enabled) return []
  const issues: QuietHoursIssue[] = []
  if (!isValidHm(quiet.start)) issues.push({ field: 'start', message: 'Use HH:MM (24-hour)' })
  if (!isValidHm(quiet.end)) issues.push({ field: 'end', message: 'Use HH:MM (24-hour)' })
  if (!isValidTimeZone(quiet.timezone || 'UTC')) issues.push({ field: 'timezone', message: 'Choose a valid time zone' })
  return issues
}
