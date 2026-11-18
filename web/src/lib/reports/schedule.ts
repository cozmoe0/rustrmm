/*
 * Report schedules: delivery presets, a readable description of the cron expression (evaluated in
 * the schedule's time zone) and the checks the server applies before saving.
 */
import type { ReportScheduleInput } from '@/lib/api/types'
import { describeCron, isValidCron, isValidTimeZone, normalizeCron } from '@/lib/cron'

export const REPORT_CRON_PRESETS: { value: string; label: string; cron: string }[] = [
  { value: 'weekly', label: 'Weekly, Monday at 07:00', cron: '0 7 * * 1' },
  { value: 'monthly', label: 'Monthly, 1st at 07:00', cron: '0 7 1 * *' },
  { value: 'quarterly', label: 'Quarterly, 1st at 07:00', cron: '0 7 1 1,4,7,10 *' },
  { value: 'weekdays', label: 'Weekdays at 07:00', cron: '0 7 * * 1-5' },
  { value: 'daily', label: 'Daily at 06:00', cron: '0 6 * * *' },
]

export const MAX_RECIPIENTS = 50
export const SCHEDULE_NAME_MAX = 120

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function reportPresetFor(cron: string): string {
  const normalized = normalizeCron(cron)
  return REPORT_CRON_PRESETS.find((preset) => preset.cron === normalized)?.value ?? 'custom'
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

const pad = (value: string) => value.padStart(2, '0')

/**
 * A readable description of a schedule's cron. Builds on the shared `describeCron` and adds the
 * shapes reports use: month lists ("quarterly"), the first weekday of a month, and day ranges.
 */
export function describeReportCron(expression: string): string {
  const normalized = normalizeCron(expression)
  if (!isValidCron(normalized)) return 'Invalid schedule'
  const [minute, hour, dom, month, dow] = normalized.split(' ')
  const simple = (value: string) => /^\d+$/.test(value)
  if (simple(minute) && simple(hour)) {
    const time = `${pad(hour)}:${pad(minute)}`
    if (month !== '*' && /^\d+(,\d+)*$/.test(month) && simple(dom) && dow === '*') {
      const months = month.split(',').map((value) => MONTHS[Number(value) - 1]).filter(Boolean)
      if (month === '1,4,7,10') return `Quarterly on day ${dom} (Jan, Apr, Jul, Oct) at ${time}`
      return `On day ${dom} of ${joinList(months)} at ${time}`
    }
    if (month === '*' && dom === '1-7' && simple(dow)) return `First ${WEEKDAYS[Number(dow) % 7]} of every month at ${time}`
    if (month === '*' && /^\d+-\d+$/.test(dow) && dom === '*') {
      const [start, end] = dow.split('-').map(Number)
      if (!(start === 1 && end === 5)) return `${WEEKDAYS[start % 7]} to ${WEEKDAYS[end % 7]} at ${time}`
    }
    if (month === '*' && /^\d+(,\d+)+$/.test(dom) && dow === '*') return `Monthly on days ${joinList(dom.split(','))} at ${time}`
  }
  return describeCron(normalized)
}

/** "Monthly on day 1 at 07:00 · Europe London" */
export function scheduleSummary(schedule: Pick<ReportScheduleInput, 'cron' | 'timezone'>): string {
  return `${describeReportCron(schedule.cron)} · ${schedule.timezone.replace(/_/g, ' ')}`
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function recipientError(value: string): string | null {
  return EMAIL.test(value.trim()) ? null : `“${value}” is not an e-mail address`
}

export type ScheduleIssues = Partial<Record<'name' | 'type' | 'cron' | 'timezone' | 'recipients', string>>

/** The server's rules: valid cron and zone, lower-cased recipients (≤ 50), required unless per client. */
export function scheduleIssues(input: ReportScheduleInput): ScheduleIssues {
  const issues: ScheduleIssues = {}
  const name = input.name.trim()
  if (!name) issues.name = 'Enter a name'
  else if (name.length > SCHEDULE_NAME_MAX) issues.name = `At most ${SCHEDULE_NAME_MAX} characters`
  if (!input.type) issues.type = 'Choose a report'
  if (!isValidCron(input.cron)) issues.cron = 'Enter five cron fields: minute hour day month weekday'
  if (!isValidTimeZone(input.timezone)) issues.timezone = 'Choose a time zone'
  const bad = input.recipients.find((recipient) => recipientError(recipient))
  if (bad) issues.recipients = recipientError(bad) ?? undefined
  else if (input.recipients.length > MAX_RECIPIENTS) issues.recipients = `At most ${MAX_RECIPIENTS} recipients`
  else if (!input.per_client && input.recipients.length === 0) issues.recipients = 'Add a recipient, or send each client its own report'
  return issues
}

/** Lower-cased, trimmed and de-duplicated, as the server stores them. */
export function normalizeRecipients(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))]
}
