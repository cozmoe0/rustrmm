/*
 * Business-time arithmetic for SLA policies, mirroring the server's rules (docs/api-tickets.md):
 * windows on ISO weekdays between local `start` and `end` in the policy's zone, `end` may be `24:00`,
 * an `end` at or before `start` runs overnight into the next day, a window that starts on a holiday does
 * not count, and local times skipped by a DST change start at the next valid instant. `null` hours mean
 * 24x7. The mock server computes due times with these helpers and the SLA editor previews them.
 */
import type { BusinessHours, SlaPolicyInput, TicketPriority } from '@/lib/api/types'
import { instantFromWall, isValidTimeZone, wallClock } from '@/lib/cron'

const MINUTE = 60_000
const DAY = 86_400_000
/** Give up looking for business time after this many days (a policy with no usable days). */
const SEARCH_DAYS = 800

const HM = /^(\d{2}):(\d{2})$/

/** Minutes after midnight for `HH:MM` (`24:00` allowed), or null. */
export function parseClock(value: string): number | null {
  const match = HM.exec(value.trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (minutes > 59) return null
  if (hours === 24 && minutes === 0) return 1440
  if (hours > 23) return null
  return hours * 60 + minutes
}

/** ISO weekday (1 = Monday … 7 = Sunday) of a wall clock encoded in UTC fields. */
function isoWeekday(wall: number) {
  const day = new Date(wall).getUTCDay()
  return day === 0 ? 7 : day
}

function localDate(wall: number) {
  return new Date(wall).toISOString().slice(0, 10)
}

/** The instant a local wall time maps to; skipped (DST gap) times move to the next valid minute. */
function instantAt(wall: number, zone: string): number {
  for (let shift = 0; shift <= 180; shift += 1) {
    const instant = instantFromWall(wall + shift * MINUTE, zone)
    if (instant !== null) return instant
  }
  return wall
}

export interface BusinessWindow {
  start: number
  end: number
}

/** Ordered business windows that overlap `[from, to)`. */
export function businessWindows(hours: BusinessHours, from: number, to: number): BusinessWindow[] {
  const start = parseClock(hours.start)
  const end = parseClock(hours.end)
  const zone = isValidTimeZone(hours.timezone) ? hours.timezone : 'UTC'
  if (start === null || end === null || start === 1440) return []
  const days = new Set(hours.days)
  const holidays = new Set(hours.holidays)
  const windows: BusinessWindow[] = []
  // Start a day early so an overnight window that began yesterday is included.
  const firstWall = wallClock(from, zone)
  let day = Date.UTC(new Date(firstWall).getUTCFullYear(), new Date(firstWall).getUTCMonth(), new Date(firstWall).getUTCDate()) - DAY
  const lastWall = wallClock(to, zone) + DAY
  while (day <= lastWall) {
    if (days.has(isoWeekday(day)) && !holidays.has(localDate(day))) {
      const length = end > start ? end - start : 1440 - start + end
      const windowStart = instantAt(day + start * MINUTE, zone)
      const windowEnd = instantAt(day + (start + length) * MINUTE, zone)
      if (windowEnd > from && windowStart < to && windowEnd > windowStart) {
        windows.push({ start: Math.max(windowStart, windows.at(-1)?.end ?? windowStart), end: windowEnd })
      }
    }
    day += DAY
  }
  return windows.filter((window) => window.end > window.start)
}

/** The instant `minutes` business minutes after `start` (`null` hours mean 24x7). */
export function addBusinessMinutes(start: number, minutes: number, hours: BusinessHours | null): number {
  if (minutes <= 0) return start
  if (!hours || hours.days.length === 0) return start + minutes * MINUTE
  let remaining = minutes * MINUTE
  let cursor = start
  // Search in month-sized chunks so long targets stay cheap.
  for (let chunk = 0; chunk * 31 < SEARCH_DAYS; chunk += 1) {
    const to = cursor + 31 * DAY
    for (const window of businessWindows(hours, cursor, to)) {
      const from = Math.max(window.start, cursor)
      if (window.end <= from) continue
      const available = window.end - from
      if (remaining <= available) return from + remaining
      remaining -= available
      cursor = window.end
    }
    cursor = Math.max(cursor, to)
  }
  return start + minutes * MINUTE
}

/** Business minutes between two instants (fractional; 0 when `to` is not after `from`). */
export function businessMinutesBetween(from: number, to: number, hours: BusinessHours | null): number {
  if (to <= from) return 0
  if (!hours) return (to - from) / MINUTE
  let total = 0
  for (const window of businessWindows(hours, from, to)) {
    total += Math.max(0, Math.min(window.end, to) - Math.max(window.start, from))
  }
  return total / MINUTE
}

/** Whether `at` falls inside business hours (always true for 24x7). */
export function isBusinessTime(at: number, hours: BusinessHours | null): boolean {
  if (!hours) return true
  return businessWindows(hours, at - MINUTE, at + MINUTE).some((window) => window.start <= at && at < window.end)
}

export interface DueTimes {
  first_response_due: number
  resolution_due: number
}

/** Due times for a ticket of `priority` opened at `created` under `policy` (before any pause). */
export function dueTimes(
  policy: Pick<SlaPolicyInput, 'business_hours' | 'targets'>,
  priority: TicketPriority,
  created: number,
): DueTimes {
  const target = policy.targets[priority]
  return {
    first_response_due: addBusinessMinutes(created, target.first_response_minutes, policy.business_hours),
    resolution_due: addBusinessMinutes(created, target.resolution_minutes, policy.business_hours),
  }
}

/** The most recent `weekday` (ISO) at `hm` local time in `zone`, strictly before `now` (for previews). */
export function previousLocal(weekday: number, hm: string, zone: string, now = Date.now()): number {
  const minutes = parseClock(hm) ?? 0
  const today = wallClock(now, zone)
  const midnight = Date.UTC(new Date(today).getUTCFullYear(), new Date(today).getUTCMonth(), new Date(today).getUTCDate())
  for (let back = 0; back <= 7; back += 1) {
    const day = midnight - back * DAY
    if (isoWeekday(day) !== weekday) continue
    const instant = instantAt(day + minutes * MINUTE, zone)
    if (instant < now) return instant
  }
  return instantAt(midnight - 7 * DAY + minutes * MINUTE, zone)
}

export const WEEKDAYS: { iso: number; short: string; long: string }[] = [
  { iso: 1, short: 'Mon', long: 'Monday' },
  { iso: 2, short: 'Tue', long: 'Tuesday' },
  { iso: 3, short: 'Wed', long: 'Wednesday' },
  { iso: 4, short: 'Thu', long: 'Thursday' },
  { iso: 5, short: 'Fri', long: 'Friday' },
  { iso: 6, short: 'Sat', long: 'Saturday' },
  { iso: 7, short: 'Sun', long: 'Sunday' },
]

/** "Mon–Fri 08:00–18:00 (Europe/London)", "24x7". */
export function describeBusinessHours(hours: BusinessHours | null): string {
  if (!hours) return '24x7'
  const days = [...hours.days].sort((a, b) => a - b)
  const names = WEEKDAYS.filter((day) => days.includes(day.iso)).map((day) => day.short)
  const contiguous = days.length > 2 && days.every((day, index) => index === 0 || day === days[index - 1] + 1)
  const dayText = days.length === 7 ? 'Every day' : contiguous ? `${names[0]}–${names.at(-1)}` : names.join(', ') || 'No days'
  return `${dayText} ${hours.start}–${hours.end} (${hours.timezone})`
}
