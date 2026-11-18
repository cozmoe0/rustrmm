/*
 * Editing helpers for maintenance windows: drafts, `datetime-local` conversion in the browser's zone,
 * switching between one-off and recurring schedules, list phases and ordering.
 */
import type { MaintenanceSchedule, MaintenanceTarget, MaintenanceWindow, MaintenanceWindowInput } from '@/lib/api/types'
import { windowPhase, type WindowPhase } from './maintenance'

export const DURATION_PRESETS = [30, 60, 120, 180, 240, 480]
export const MAX_ONCE_DAYS = 31

const pad = (value: number) => String(value).padStart(2, '0')

/** An ISO timestamp as a `datetime-local` value (`YYYY-MM-DDTHH:mm`) on the browser's clock. */
export function toLocalInput(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** A `datetime-local` value (browser clock) as an ISO timestamp, or null when blank or invalid. */
export function fromLocalInput(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value)
  if (!match) return null
  const [, year, month, day, hour, minute] = match.map(Number)
  const date = new Date(year, month - 1, day, hour, minute, 0, 0)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** The next full hour, for two hours. */
export function defaultOnce(now = new Date()): { start: string; end: string } {
  const start = new Date(now.getTime())
  start.setMinutes(0, 0, 0)
  start.setHours(start.getHours() + 1)
  return { start: start.toISOString(), end: new Date(start.getTime() + 2 * 3_600_000).toISOString() }
}

export function emptyWindow(now = new Date()): MaintenanceWindowInput {
  return {
    name: '',
    enabled: true,
    targets: [],
    schedule: { type: 'once', ...defaultOnce(now) },
    suppress: 'notifications',
  }
}

/** The editable part of a window (target names dropped). */
export function windowToInput(window: MaintenanceWindow): MaintenanceWindowInput {
  return {
    name: window.name,
    enabled: window.enabled,
    targets: window.targets.map((target) => (target.type === 'global' ? { type: 'global' } : { type: target.type, id: target.id })),
    schedule: window.schedule,
    suppress: window.suppress,
  }
}

/** Switches the schedule type, carrying over what makes sense (the duration of a one-off window). */
export function switchSchedule(schedule: MaintenanceSchedule, type: MaintenanceSchedule['type'], timezone: string, now = new Date()): MaintenanceSchedule {
  if (schedule.type === type) return schedule
  if (type === 'once') return { type: 'once', ...defaultOnce(now) }
  const minutes =
    schedule.type === 'once'
      ? Math.round((new Date(schedule.end).getTime() - new Date(schedule.start).getTime()) / 60_000)
      : 180
  return {
    type: 'recurring',
    cron: '0 22 * * 3',
    duration_minutes: Number.isFinite(minutes) && minutes >= 1 && minutes <= 10_080 ? minutes : 180,
    timezone,
  }
}

export function targetKey(target: Pick<MaintenanceTarget, 'type' | 'id'>): string {
  return target.type === 'global' ? 'global' : `${target.type}:${target.id ?? ''}`
}

/** Adds a target, replacing a global one (a global window has no other targets). */
export function addTarget(targets: readonly MaintenanceTarget[], target: MaintenanceTarget): MaintenanceTarget[] {
  if (target.type === 'global') return [{ type: 'global' }]
  const rest = targets.filter((item) => item.type !== 'global')
  return rest.some((item) => targetKey(item) === targetKey(target)) ? rest : [...rest, target]
}

/** The list phase, preferring the server's `active_now` and `next_start`. */
export function phaseOf(window: MaintenanceWindow, now = new Date()): WindowPhase {
  if (!window.enabled) return 'disabled'
  if (window.active_now) return 'active'
  if (window.next_start) return 'scheduled'
  return windowPhase(window, now) === 'active' ? 'active' : 'ended'
}

const PHASE_ORDER: WindowPhase[] = ['active', 'scheduled', 'disabled', 'ended']

/** Active windows first, then upcoming ones by next start, then disabled and ended windows by name. */
export function sortWindows(windows: readonly MaintenanceWindow[], now = new Date()): MaintenanceWindow[] {
  return [...windows].sort((a, b) => {
    const phase = PHASE_ORDER.indexOf(phaseOf(a, now)) - PHASE_ORDER.indexOf(phaseOf(b, now))
    if (phase) return phase
    if (a.next_start && b.next_start) return a.next_start.localeCompare(b.next_start)
    return a.name.localeCompare(b.name)
  })
}

export function phaseCounts(windows: readonly MaintenanceWindow[], now = new Date()): Record<WindowPhase | 'all', number> {
  const counts = { all: windows.length, active: 0, scheduled: 0, disabled: 0, ended: 0 }
  for (const window of windows) counts[phaseOf(window, now)] += 1
  return counts
}

/** Extra checks the shared validator does not cover: the 31-day limit and a lone global target. */
export function extraMaintenanceIssues(input: MaintenanceWindowInput): { field: 'end' | 'targets'; message: string }[] {
  const issues: { field: 'end' | 'targets'; message: string }[] = []
  if (input.schedule.type === 'once') {
    const span = new Date(input.schedule.end).getTime() - new Date(input.schedule.start).getTime()
    if (span > MAX_ONCE_DAYS * 86_400_000) issues.push({ field: 'end', message: `A one-off window lasts at most ${MAX_ONCE_DAYS} days` })
  }
  if (input.targets.some((target) => target.type === 'global') && input.targets.length > 1)
    issues.push({ field: 'targets', message: 'A global window cannot have other targets' })
  return issues
}
