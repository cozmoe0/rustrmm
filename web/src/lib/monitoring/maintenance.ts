/*
 * Maintenance window schedules: occurrences (one-off or cron plus duration on the window's wall clock),
 * whether a window is active, its next start, a readable description and validation.
 */
import type { MaintenanceSchedule, MaintenanceWindowInput } from '@/lib/api/types'
import { describeCron, formatInZone, isValidCron, isValidTimeZone, nextCronRuns } from '@/lib/cron'
import { formatMinutes } from './labels'

export const MAX_DURATION_MINUTES = 7 * 1440

export interface Occurrence {
  start: Date
  end: Date
}

/** Occurrences that end after `from` (so the current one comes first), in order. */
export function occurrences(
  schedule: MaintenanceSchedule,
  { from = new Date(), count = 5 }: { from?: Date; count?: number } = {},
): Occurrence[] {
  if (schedule.type === 'once') {
    const start = new Date(schedule.start)
    const end = new Date(schedule.end)
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return []
    return end.getTime() > from.getTime() ? [{ start, end }] : []
  }
  const duration = schedule.duration_minutes * 60_000
  if (!(duration > 0) || !isValidCron(schedule.cron) || !isValidTimeZone(schedule.timezone)) return []
  // Starting the search one duration back finds an occurrence that is already running.
  return nextCronRuns(schedule.cron, { timeZone: schedule.timezone, count, from: new Date(from.getTime() - duration) })
    .map((start) => ({ start, end: new Date(start.getTime() + duration) }))
    .filter((occurrence) => occurrence.end.getTime() > from.getTime())
    .slice(0, count)
}

/** The occurrence running at `at`, if any. */
export function currentOccurrence(schedule: MaintenanceSchedule, at = new Date()): Occurrence | null {
  const [first] = occurrences(schedule, { from: at, count: 1 })
  return first && first.start.getTime() <= at.getTime() ? first : null
}

export function isActiveAt(schedule: MaintenanceSchedule, at = new Date()): boolean {
  return currentOccurrence(schedule, at) !== null
}

/** The first start strictly after `at`. */
export function nextStart(schedule: MaintenanceSchedule, at = new Date()): Date | null {
  return occurrences(schedule, { from: at, count: 3 }).find((item) => item.start.getTime() > at.getTime())?.start ?? null
}

export type WindowPhase = 'active' | 'scheduled' | 'ended' | 'disabled'

export function windowPhase(window: { enabled: boolean; schedule: MaintenanceSchedule }, at = new Date()): WindowPhase {
  if (!window.enabled) return 'disabled'
  if (isActiveAt(window.schedule, at)) return 'active'
  return nextStart(window.schedule, at) ? 'scheduled' : 'ended'
}

function localZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/**
 * "Once · Wed 19 Nov, 22:00 → Thu 20 Nov, 01:00 (3 h)" or
 * "Weekly on Wednesday at 22:00 for 3 h · UTC".
 */
export function describeSchedule(schedule: MaintenanceSchedule, zone = localZone()): string {
  if (schedule.type === 'once') {
    const start = new Date(schedule.start)
    const end = new Date(schedule.end)
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 'Choose a start and an end'
    if (end <= start) return 'The end must be after the start'
    return `Once · ${formatInZone(start, zone)} → ${formatInZone(end, zone)} (${formatMinutes((end.getTime() - start.getTime()) / 60_000)})`
  }
  if (!isValidCron(schedule.cron)) return 'Enter a valid cron expression'
  const base = describeCron(schedule.cron)
  const readable = base.startsWith('Custom schedule') ? `On “${schedule.cron}”` : base
  return `${readable} for ${formatMinutes(schedule.duration_minutes)} · ${schedule.timezone.replace(/_/g, ' ')}`
}

/** "in 3 h", "in 2 d", "now" for next-start badges. */
export function startsIn(next: Date | string | null, now = Date.now()): string | null {
  if (!next) return null
  const ms = new Date(next).getTime() - now
  if (ms <= 0) return 'now'
  return `in ${formatMinutes(Math.max(1, Math.round(ms / 60_000)))}`
}

/** "Ends in 1 h 20 min" for an active window. */
export function endsIn(end: Date, now = Date.now()): string {
  const ms = end.getTime() - now
  return ms <= 0 ? 'Ending now' : `Ends in ${formatMinutes(Math.max(1, Math.round(ms / 60_000)))}`
}

export interface MaintenanceIssue {
  field: 'name' | 'targets' | 'start' | 'end' | 'cron' | 'duration' | 'timezone'
  message: string
}

export function validateMaintenance(input: MaintenanceWindowInput): MaintenanceIssue[] {
  const issues: MaintenanceIssue[] = []
  if (!input.name.trim()) issues.push({ field: 'name', message: 'Enter a name' })
  if (input.targets.length === 0) issues.push({ field: 'targets', message: 'Choose at least one target' })
  if (input.targets.some((target) => target.type !== 'global' && !target.id))
    issues.push({ field: 'targets', message: 'Every target needs a selection' })
  const schedule = input.schedule
  if (schedule.type === 'once') {
    const start = new Date(schedule.start)
    const end = new Date(schedule.end)
    if (Number.isNaN(start.getTime())) issues.push({ field: 'start', message: 'Choose a start' })
    if (Number.isNaN(end.getTime())) issues.push({ field: 'end', message: 'Choose an end' })
    else if (!Number.isNaN(start.getTime()) && end <= start)
      issues.push({ field: 'end', message: 'The end must be after the start' })
  } else {
    if (!isValidCron(schedule.cron)) issues.push({ field: 'cron', message: 'Enter a valid 5-field cron expression' })
    if (
      !Number.isInteger(schedule.duration_minutes) ||
      schedule.duration_minutes < 1 ||
      schedule.duration_minutes > MAX_DURATION_MINUTES
    )
      issues.push({ field: 'duration', message: `Between 1 minute and ${MAX_DURATION_MINUTES / 1440} days` })
    if (!isValidTimeZone(schedule.timezone)) issues.push({ field: 'timezone', message: 'Choose a valid time zone' })
  }
  return issues
}
