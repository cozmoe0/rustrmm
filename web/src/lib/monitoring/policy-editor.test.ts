import { describe, expect, it } from 'vitest'
import type { MonitoringCheck, MaintenanceWindow } from '@/lib/api/types'
import {
  addTarget,
  defaultOnce,
  emptyWindow,
  extraMaintenanceIssues,
  fromLocalInput,
  phaseCounts,
  phaseOf,
  sortWindows,
  switchSchedule,
  toLocalInput,
  windowToInput,
} from './maintenance-editor'
import {
  checkIssues,
  configErrors,
  intervalChoice,
  monitoringChanged,
  removeCheck,
  renameCheck,
  setChecks,
  setServerKey,
  togglePlatform,
  typePlatforms,
  updateCheck,
} from './policy-editor'

const disk: MonitoringCheck = { id: 'disk-space', type: 'disk', name: 'Disk space', interval_secs: 300, config: { volume: '*' } }

describe('policy monitoring editor helpers', () => {
  it('updates checks and server keys immutably, dropping empty sections', () => {
    const doc = setChecks({ agent: { heartbeat_secs: 30 } }, [disk])
    expect(doc.monitoring?.checks).toEqual([disk])
    const renamed = updateCheck(doc, 0, { ...disk, name: 'Disks' })
    expect(renamed.monitoring?.checks?.[0].name).toBe('Disks')
    expect(doc.monitoring?.checks?.[0].name).toBe('Disk space')
    expect(removeCheck(doc, 0)).toEqual({ agent: { heartbeat_secs: 30 } })
    const server = setServerKey(doc, 'offline_minutes', 5)
    expect(server.monitoring?.server).toEqual({ offline_minutes: 5 })
    expect(setServerKey(server, 'offline_minutes', undefined).monitoring).toEqual({ checks: [disk] })
    expect(setServerKey({}, 'agent_outdated', undefined)).toEqual({})
  })

  it('routes issues to a check by position or by id', () => {
    const issues = [
      { path: 'monitoring.checks[1].config.warn_pct', message: 'Too high' },
      { path: 'monitoring.checks[1].name', message: 'Enter a name' },
      { path: 'monitoring.checks.cpu-high', message: 'Script missing' },
      { path: 'monitoring.checks[0].id', message: 'Duplicate' },
    ]
    const mine = checkIssues(issues, 1, 'cpu-high')
    expect(mine).toEqual([
      { path: 'config.warn_pct', message: 'Too high' },
      { path: 'name', message: 'Enter a name' },
      { path: '', message: 'Script missing' },
    ])
    expect(configErrors(mine)).toEqual({ warn_pct: 'Too high' })
  })

  it('keeps a derived id in step with the name', () => {
    expect(renameCheck(disk, 'Low disk', []).id).toBe('low-disk')
    expect(renameCheck({ ...disk, id: 'custom' }, 'Low disk', []).id).toBe('custom')
    expect(renameCheck(disk, 'Low disk', ['low-disk']).id).toBe('low-disk-2')
  })

  it('maps intervals and platform limits', () => {
    expect(intervalChoice(300)).toBe('300')
    expect(intervalChoice(45)).toBe('custom')
    const all = typePlatforms({ platforms: ['linux', 'windows', 'macos'] })
    expect(all).toEqual(['windows', 'macos', 'linux'])
    expect(togglePlatform(undefined, 'linux', all)).toEqual(['windows', 'macos'])
    expect(togglePlatform(['windows'], 'windows', all)).toBeUndefined()
    expect(togglePlatform(['windows', 'macos'], 'linux', all)).toBeUndefined()
  })

  it('detects monitoring changes after compaction', () => {
    expect(monitoringChanged({}, { monitoring: { checks: [], server: {} } })).toBe(false)
    expect(monitoringChanged({}, setChecks({}, [disk]))).toBe(true)
  })
})

describe('maintenance editor helpers', () => {
  it('converts datetime-local values on the browser clock', () => {
    const iso = fromLocalInput('2026-11-20T22:30')!
    expect(toLocalInput(iso)).toBe('2026-11-20T22:30')
    expect(fromLocalInput('nope')).toBeNull()
    expect(toLocalInput('garbage')).toBe('')
  })

  it('drafts a one-off window starting on the next hour', () => {
    const { start, end } = defaultOnce(new Date('2026-11-18T10:20:00'))
    expect(new Date(start).getMinutes()).toBe(0)
    expect(new Date(end).getTime() - new Date(start).getTime()).toBe(2 * 3_600_000)
    expect(emptyWindow().suppress).toBe('notifications')
  })

  it('switches schedule types, carrying the duration over', () => {
    const once = { type: 'once' as const, start: '2026-11-20T10:00:00Z', end: '2026-11-20T11:30:00Z' }
    expect(switchSchedule(once, 'recurring', 'UTC')).toEqual({ type: 'recurring', cron: '0 22 * * 3', duration_minutes: 90, timezone: 'UTC' })
    expect(switchSchedule(once, 'once', 'UTC')).toBe(once)
  })

  it('treats a global target as exclusive', () => {
    expect(addTarget([{ type: 'client', id: 'c1' }], { type: 'global' })).toEqual([{ type: 'global' }])
    expect(addTarget([{ type: 'global' }], { type: 'site', id: 's1' })).toEqual([{ type: 'site', id: 's1' }])
    expect(addTarget([{ type: 'site', id: 's1' }], { type: 'site', id: 's1' })).toHaveLength(1)
    expect(
      extraMaintenanceIssues({
        name: 'x',
        enabled: true,
        targets: [{ type: 'global' }, { type: 'site', id: 's' }],
        schedule: { type: 'once', start: '2026-01-01T00:00:00Z', end: '2026-03-01T00:00:00Z' },
        suppress: 'alerts',
      }).map((issue) => issue.field),
    ).toEqual(['end', 'targets'])
  })

  it('orders and counts windows by phase', () => {
    const base: Omit<MaintenanceWindow, 'id' | 'name'> = {
      enabled: true,
      targets: [{ type: 'global', name: null }],
      schedule: { type: 'once', start: '2026-01-01T00:00:00Z', end: '2026-01-01T01:00:00Z' },
      suppress: 'notifications',
      created_by_name: 'Sam',
      active_now: false,
      next_start: null,
    }
    const windows: MaintenanceWindow[] = [
      { ...base, id: '1', name: 'Ended' },
      { ...base, id: '2', name: 'Later', next_start: '2026-12-02T00:00:00Z' },
      { ...base, id: '3', name: 'Now', active_now: true },
      { ...base, id: '4', name: 'Off', enabled: false },
      { ...base, id: '5', name: 'Soon', next_start: '2026-12-01T00:00:00Z' },
    ]
    const now = new Date('2026-11-18T00:00:00Z')
    expect(sortWindows(windows, now).map((window) => window.name)).toEqual(['Now', 'Soon', 'Later', 'Off', 'Ended'])
    expect(phaseCounts(windows, now)).toEqual({ all: 5, active: 1, scheduled: 2, disabled: 1, ended: 1 })
    expect(phaseOf(windows[0], now)).toBe('ended')
    expect(windowToInput({ ...windows[2], targets: [{ type: 'client', id: 'c', name: 'Acme' }] }).targets).toEqual([
      { type: 'client', id: 'c' },
    ])
  })
})
