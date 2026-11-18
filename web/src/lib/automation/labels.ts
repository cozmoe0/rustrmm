/* Labels, tones and small helpers shared by the automation screens. */
import type {
  JobResultStatus,
  JobRunCounts,
  JobSchedule,
  JobStatus,
  JobTargetType,
  JobTrigger,
  OsFamily,
  ScriptLanguage,
} from '@/lib/api/types'
import { describeCron } from '@/lib/cron'

export type Tone = 'live' | 'success' | 'warning' | 'critical' | 'info' | 'neutral' | 'primary'

export interface LanguageMeta {
  label: string
  short: string
  extension: string
  platforms: OsFamily[]
  template: string
}

export const LANGUAGES: Record<ScriptLanguage, LanguageMeta> = {
  powershell: {
    label: 'Windows PowerShell',
    short: 'PS',
    extension: '.ps1',
    platforms: ['windows'],
    template:
      '# Runs as SYSTEM with Windows PowerShell 5.1.\n# Parameters and variables arrive as environment variables, e.g. $env:ServiceName.\n\n$ErrorActionPreference = \'Stop\'\n\nWrite-Output "Hello from $env:COMPUTERNAME"\n',
  },
  pwsh: {
    label: 'PowerShell 7',
    short: 'PS7',
    extension: '.ps1',
    platforms: ['windows', 'linux', 'macos'],
    template:
      '# PowerShell 7 (pwsh) must be installed on the device.\n$ErrorActionPreference = \'Stop\'\n\nWrite-Output "Hello from $([System.Net.Dns]::GetHostName())"\n',
  },
  cmd: {
    label: 'Command Prompt',
    short: 'CMD',
    extension: '.cmd',
    platforms: ['windows'],
    template:
      '@echo off\nREM Parameters arrive as environment variables, e.g. %ServiceName%.\n\necho Hello from %COMPUTERNAME%\n',
  },
  bash: {
    label: 'Bash',
    short: 'BASH',
    extension: '.sh',
    platforms: ['linux', 'macos'],
    template:
      '#!/usr/bin/env bash\n# Runs as root. Parameters arrive as environment variables, e.g. "$ServiceName".\nset -euo pipefail\n\necho "Hello from $(hostname)"\n',
  },
  sh: {
    label: 'POSIX sh',
    short: 'SH',
    extension: '.sh',
    platforms: ['linux', 'macos'],
    template: '#!/bin/sh\nset -eu\n\necho "Hello from $(hostname)"\n',
  },
  zsh: {
    label: 'Zsh',
    short: 'ZSH',
    extension: '.sh',
    platforms: ['macos'],
    template: '#!/bin/zsh\nset -euo pipefail\n\necho "Hello from $(scutil --get ComputerName)"\n',
  },
  python: {
    label: 'Python 3',
    short: 'PY',
    extension: '.py',
    platforms: ['windows', 'linux', 'macos'],
    template:
      '#!/usr/bin/env python3\n"""Parameters arrive as environment variables, e.g. os.environ["ServiceName"]."""\nimport os\nimport socket\n\nprint(f"Hello from {socket.gethostname()}")\n',
  },
}

export const LANGUAGE_ORDER: ScriptLanguage[] = ['powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh', 'python']

export const PLATFORM_ORDER: OsFamily[] = ['windows', 'macos', 'linux']

export const JOB_STATUS: Record<JobStatus, { label: string; tone: Tone }> = {
  pending_approval: { label: 'Awaiting approval', tone: 'warning' },
  scheduled: { label: 'Scheduled', tone: 'info' },
  running: { label: 'Running', tone: 'live' },
  completed: { label: 'Completed', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  rejected: { label: 'Rejected', tone: 'critical' },
}

export const RESULT_STATUS: Record<JobResultStatus, { label: string; tone: Tone; done: boolean }> = {
  pending: { label: 'Queued', tone: 'neutral', done: false },
  waiting_offline: { label: 'Waiting for device', tone: 'warning', done: false },
  running: { label: 'Running', tone: 'live', done: false },
  succeeded: { label: 'Succeeded', tone: 'success', done: true },
  failed: { label: 'Failed', tone: 'critical', done: true },
  timed_out: { label: 'Timed out', tone: 'critical', done: true },
  skipped: { label: 'Skipped', tone: 'neutral', done: true },
  cancelled: { label: 'Cancelled', tone: 'neutral', done: true },
}

export const RESULT_ORDER: JobResultStatus[] = [
  'running',
  'pending',
  'waiting_offline',
  'failed',
  'timed_out',
  'succeeded',
  'skipped',
  'cancelled',
]

export const TRIGGER_LABEL: Record<JobTrigger, string> = {
  manual: 'Manual',
  schedule: 'Schedule',
  policy: 'Policy',
  rerun: 'Re-run',
}

export const TARGET_LABEL: Record<JobTargetType, string> = {
  devices: 'Devices',
  group: 'Group',
  site: 'Site',
  client: 'Client',
}

export const OFFLINE_WAIT_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: 'Online devices only' },
  { value: 15, label: '15 minutes' },
  { value: 60, label: '1 hour' },
  { value: 240, label: '4 hours' },
  { value: 720, label: '12 hours' },
  { value: 1440, label: '1 day' },
  { value: 4320, label: '3 days' },
  { value: 10080, label: '7 days' },
]

export function offlineWaitLabel(minutes: number): string {
  const preset = OFFLINE_WAIT_OPTIONS.find((option) => option.value === minutes)
  if (preset) return minutes === 0 ? 'Online only' : `Wait ${preset.label}`
  if (minutes % 1440 === 0) return `Wait ${minutes / 1440} days`
  if (minutes % 60 === 0) return `Wait ${minutes / 60} h`
  return `Wait ${minutes} min`
}

export function describeSchedule(schedule: JobSchedule): string {
  if (schedule.type === 'now') return 'Run once, immediately'
  if (schedule.type === 'once') return 'Run once at a set time'
  return `${describeCron(schedule.cron)} · ${schedule.timezone.replace(/_/g, ' ')}`
}

/** Results that finished, in any outcome. */
export function completedCount(counts: JobRunCounts): number {
  return counts.total - counts.pending - counts.waiting_offline - counts.running
}

/** Skipped, cancelled and timed-out results are folded into `total` but have no counter of their own. */
export function otherCount(counts: JobRunCounts): number {
  return Math.max(
    0,
    counts.total - counts.pending - counts.waiting_offline - counts.running - counts.succeeded - counts.failed,
  )
}

export function progressPct(counts: JobRunCounts): number {
  return counts.total === 0 ? 0 : Math.round((completedCount(counts) / counts.total) * 100)
}

export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  if (ms < 1000) return `${ms} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${Math.round(seconds % 60)}s`
}

export function formatTimeout(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} h`
  if (seconds % 60 === 0) return `${seconds / 60} min`
  return `${seconds} s`
}

export const MAX_CONCURRENCY = 500
