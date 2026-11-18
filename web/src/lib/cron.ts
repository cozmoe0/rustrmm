/*
 * Helpers for the backup schedule: presets, validation, human descriptions and
 * next-run calculation for standard 5-field cron expressions (minute hour dom month dow).
 */

export type CronPreset = 'hourly' | 'every-6-hours' | 'daily' | 'weekly' | 'custom'

export const CRON_PRESETS: { value: Exclude<CronPreset, 'custom'>; label: string; cron: string }[] = [
  { value: 'hourly', label: 'Every hour', cron: '0 * * * *' },
  { value: 'every-6-hours', label: 'Every 6 hours', cron: '0 */6 * * *' },
  { value: 'daily', label: 'Daily at 02:00', cron: '0 2 * * *' },
  { value: 'weekly', label: 'Weekly, Sunday at 03:00', cron: '0 3 * * 0' },
]

export function normalizeCron(expression: string): string {
  return expression.trim().split(/\s+/).join(' ')
}

export function presetFromCron(expression: string): CronPreset {
  const normalized = normalizeCron(expression)
  return CRON_PRESETS.find((preset) => preset.cron === normalized)?.value ?? 'custom'
}

export function cronFromPreset(preset: CronPreset, current = ''): string {
  if (preset === 'custom') return current
  return CRON_PRESETS.find((item) => item.value === preset)!.cron
}

const FIELD_RANGES: [number, number][] = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (0 and 7 are Sunday)
]

/** Expands one cron field into the set of matching values, or null when invalid. */
export function parseField(field: string, [min, max]: [number, number]): Set<number> | null {
  const values = new Set<number>()
  for (const part of field.split(',')) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part)
    if (!match) return null
    const [, range, stepRaw] = match
    const step = stepRaw ? Number(stepRaw) : 1
    if (step < 1) return null
    let start = min
    let end = max
    if (range !== '*') {
      const [a, b] = range.split('-').map(Number)
      start = a
      end = b ?? (stepRaw ? max : a)
    }
    if (start < min || end > max || start > end) return null
    for (let value = start; value <= end; value += step) values.add(value)
  }
  return values
}

interface ParsedCron {
  minutes: Set<number>
  hours: Set<number>
  days: Set<number>
  months: Set<number>
  weekdays: Set<number>
  domRestricted: boolean
  dowRestricted: boolean
}

export function parseCron(expression: string): ParsedCron | null {
  const fields = normalizeCron(expression).split(' ')
  if (fields.length !== 5) return null
  const sets = fields.map((field, index) => parseField(field, FIELD_RANGES[index]))
  if (sets.some((set) => set === null)) return null
  const [minutes, hours, days, months, weekdaysRaw] = sets as Set<number>[]
  const weekdays = new Set([...weekdaysRaw].map((day) => (day === 7 ? 0 : day)))
  return {
    minutes,
    hours,
    days,
    months,
    weekdays,
    domRestricted: fields[2] !== '*',
    dowRestricted: fields[4] !== '*',
  }
}

export function isValidCron(expression: string): boolean {
  return parseCron(expression) !== null
}

function dayMatches(cron: ParsedCron, date: Date): boolean {
  const dom = cron.days.has(date.getDate())
  const dow = cron.weekdays.has(date.getDay())
  // Standard cron: when both fields are restricted, either may match.
  if (cron.domRestricted && cron.dowRestricted) return dom || dow
  if (cron.domRestricted) return dom
  if (cron.dowRestricted) return dow
  return true
}

/** Next run strictly after `from`, in the browser's local time. Searches up to ~2 years ahead. */
export function nextCronRun(expression: string, from: Date = new Date()): Date | null {
  const cron = parseCron(expression)
  if (!cron) return null
  const date = new Date(from.getTime())
  date.setSeconds(0, 0)
  date.setMinutes(date.getMinutes() + 1)

  const limit = from.getTime() + 2 * 366 * 24 * 60 * 60 * 1000
  while (date.getTime() <= limit) {
    if (!cron.months.has(date.getMonth() + 1)) {
      date.setMonth(date.getMonth() + 1, 1)
      date.setHours(0, 0, 0, 0)
      continue
    }
    if (!dayMatches(cron, date)) {
      date.setDate(date.getDate() + 1)
      date.setHours(0, 0, 0, 0)
      continue
    }
    if (!cron.hours.has(date.getHours())) {
      date.setHours(date.getHours() + 1, 0, 0, 0)
      continue
    }
    if (!cron.minutes.has(date.getMinutes())) {
      date.setMinutes(date.getMinutes() + 1, 0, 0)
      continue
    }
    return date
  }
  return null
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function pad(value: string) {
  return value.padStart(2, '0')
}

/** A readable description for common shapes; falls back to the raw expression. */
export function describeCron(expression: string): string {
  const normalized = normalizeCron(expression)
  if (!isValidCron(normalized)) return 'Invalid schedule'
  const [minute, hour, dom, month, dow] = normalized.split(' ')
  const simple = (value: string) => /^\d+$/.test(value)

  if (minute === '*' && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return 'Every minute'
  }
  const everyMinutes = /^\*\/(\d+)$/.exec(minute)
  if (everyMinutes && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return `Every ${everyMinutes[1]} minutes`
  }
  if (simple(minute) && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return minute === '0' ? 'Every hour' : `Every hour at :${pad(minute)}`
  }
  const everyHours = /^\*\/(\d+)$/.exec(hour)
  if (simple(minute) && everyHours && dom === '*' && month === '*' && dow === '*') {
    return `Every ${everyHours[1]} hours at :${pad(minute)}`
  }
  if (simple(minute) && simple(hour) && month === '*') {
    const time = `${pad(hour)}:${pad(minute)}`
    if (dom === '*' && dow === '*') return `Daily at ${time}`
    if (dom === '*' && simple(dow)) return `Weekly on ${WEEKDAYS[Number(dow) % 7]} at ${time}`
    if (dom === '*' && dow === '1-5') return `Weekdays at ${time}`
    if (dom === '*' && (dow === '0,6' || dow === '6,0')) return `Weekends at ${time}`
    if (dom === '*' && /^\d(,\d)+$/.test(dow)) {
      const days = dow.split(',').map((day) => WEEKDAYS[Number(day) % 7].slice(0, 3))
      return `${days.join(', ')} at ${time}`
    }
    if (simple(dom) && dow === '*') return `Monthly on day ${dom} at ${time}`
  }
  return `Custom schedule (${normalized})`
}

// ------------------------------------------------------------------ time zones

export function isValidTimeZone(zone: string): boolean {
  if (!zone) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>()

function zoneFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = zoneFormatters.get(zone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    zoneFormatters.set(zone, formatter)
  }
  return formatter
}

/** The wall-clock time in `zone` at `instant`, encoded as UTC milliseconds (so UTC getters read the wall clock). */
export function wallClock(instant: number, zone: string): number {
  const parts: Record<string, number> = {}
  for (const part of zoneFormatter(zone).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value)
  }
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second)
}

/** The instant at which `zone`'s wall clock shows `wall`, or null when that time is skipped (DST gap). */
export function instantFromWall(wall: number, zone: string): number | null {
  let guess = wall - (wallClock(wall, zone) - wall)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const offset = wallClock(guess, zone) - guess
    guess = wall - offset
  }
  return wallClock(guess, zone) === wall ? guess : null
}

/** Same search as `nextCronRun`, over a wall clock encoded in UTC fields. */
function nextWallMatch(cron: ParsedCron, fromWall: number, limitWall: number): number | null {
  const date = new Date(fromWall)
  date.setUTCSeconds(0, 0)
  date.setUTCMinutes(date.getUTCMinutes() + 1)
  const matchesDay = () => {
    const dom = cron.days.has(date.getUTCDate())
    const dow = cron.weekdays.has(date.getUTCDay())
    if (cron.domRestricted && cron.dowRestricted) return dom || dow
    if (cron.domRestricted) return dom
    if (cron.dowRestricted) return dow
    return true
  }
  while (date.getTime() <= limitWall) {
    if (!cron.months.has(date.getUTCMonth() + 1)) {
      date.setUTCMonth(date.getUTCMonth() + 1, 1)
      date.setUTCHours(0, 0, 0, 0)
      continue
    }
    if (!matchesDay()) {
      date.setUTCDate(date.getUTCDate() + 1)
      date.setUTCHours(0, 0, 0, 0)
      continue
    }
    if (!cron.hours.has(date.getUTCHours())) {
      date.setUTCHours(date.getUTCHours() + 1, 0, 0, 0)
      continue
    }
    if (!cron.minutes.has(date.getUTCMinutes())) {
      date.setUTCMinutes(date.getUTCMinutes() + 1, 0, 0)
      continue
    }
    return date.getTime()
  }
  return null
}

/**
 * The next `count` runs strictly after `from`, evaluating the expression on `timeZone`'s wall clock
 * (as the server does for cron jobs). Wall times skipped by a DST change are left out.
 */
export function nextCronRuns(
  expression: string,
  { timeZone = 'UTC', count = 5, from = new Date() }: { timeZone?: string; count?: number; from?: Date } = {},
): Date[] {
  const cron = parseCron(expression)
  if (!cron || !isValidTimeZone(timeZone)) return []
  const runs: Date[] = []
  let cursor = wallClock(from.getTime(), timeZone)
  const limit = cursor + 2 * 366 * 24 * 60 * 60 * 1000
  while (runs.length < count) {
    const wall = nextWallMatch(cron, cursor, limit)
    if (wall === null) break
    cursor = wall
    const instant = instantFromWall(wall, timeZone)
    if (instant === null || instant <= from.getTime()) continue
    if (runs.length && instant <= runs[runs.length - 1].getTime()) continue
    runs.push(new Date(instant))
  }
  return runs
}

/** “Mon 23 Nov, 03:00” on the given zone's wall clock. */
export function formatInZone(date: Date, timeZone: string, withZone = false): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(withZone ? { timeZoneName: 'short' as const } : {}),
  }).format(date)
}

/** The browser's IANA zone, falling back to UTC. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}
