/* Notification rule editor model: defaults, validation and readable summaries for the rule list. */
import type { NotificationEvent, NotificationLogEntry, NotificationRule, NotificationRuleInput } from '@/lib/api/types'
import { formatMinutes, NOTIFICATION_EVENT_LABEL } from '@/lib/monitoring/labels'
import { defaultQuietHours, validateQuietHours } from '@/lib/monitoring/quiet-hours'

export const DEFAULT_EVENTS: NotificationEvent[] = ['opened', 'resolved']
export const ESCALATION_MAX_MINUTES = 10_080
/** One delivery is tried up to four times (the first attempt plus three retries). */
export const MAX_DELIVERY_ATTEMPTS = 4

/** Server-side check types usable in rule filters, next to the agent check catalog. */
export const SERVER_CHECK_TYPES: { type: string; label: string }[] = [
  { type: 'offline', label: 'Offline' },
  { type: 'agent_outdated', label: 'Agent version' },
  { type: 'disk_forecast', label: 'Disk forecast' },
  { type: 'security', label: 'Security changes' },
  { type: 'patching', label: 'Patch installs' },
]

export function emptyRuleInput(timezone = 'UTC'): NotificationRuleInput {
  return {
    name: '',
    enabled: true,
    filters: { client_ids: [], site_ids: [], severities: [], sources: [], check_types: [], check_ids: [] },
    events: [...DEFAULT_EVENTS],
    channel_ids: [],
    quiet_hours: defaultQuietHours(timezone),
    escalation: { enabled: false, after_minutes: 30, channel_ids: [] },
  }
}

export function ruleInput(rule: NotificationRule): NotificationRuleInput {
  return {
    name: rule.name,
    enabled: rule.enabled,
    filters: {
      client_ids: [...rule.filters.client_ids],
      site_ids: [...rule.filters.site_ids],
      severities: [...rule.filters.severities],
      sources: [...rule.filters.sources],
      check_types: [...rule.filters.check_types],
      check_ids: [...rule.filters.check_ids],
    },
    events: [...rule.events],
    channel_ids: [...rule.channel_ids],
    quiet_hours: { ...rule.quiet_hours, days: [...rule.quiet_hours.days] },
    escalation: { ...rule.escalation, channel_ids: [...rule.escalation.channel_ids] },
  }
}

/** The events a rule actually fires on: an empty list means opened and resolved. */
export function effectiveEvents(events: readonly NotificationEvent[]): NotificationEvent[] {
  return events.length ? [...events] : [...DEFAULT_EVENTS]
}

export type RuleField = 'name' | 'channel_ids' | 'quiet_start' | 'quiet_end' | 'quiet_timezone' | 'escalation_minutes' | 'escalation_channels'
export type RuleErrors = Partial<Record<RuleField, string>>

export function validateRuleInput(input: NotificationRuleInput): RuleErrors {
  const errors: RuleErrors = {}
  if (!input.name.trim()) errors.name = 'Enter a name'
  else if (input.name.trim().length > 80) errors.name = 'Use 80 characters or fewer'
  if (input.channel_ids.length === 0) errors.channel_ids = 'Choose at least one channel'
  for (const issue of validateQuietHours(input.quiet_hours)) {
    if (issue.field === 'start') errors.quiet_start = issue.message
    if (issue.field === 'end') errors.quiet_end = issue.message
    if (issue.field === 'timezone') errors.quiet_timezone = issue.message
  }
  if (input.escalation.enabled) {
    const minutes = input.escalation.after_minutes
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > ESCALATION_MAX_MINUTES)
      errors.escalation_minutes = `Between 1 and ${ESCALATION_MAX_MINUTES} minutes`
    if (input.escalation.channel_ids.length === 0 && !effectiveEvents(input.events).includes('escalated'))
      errors.escalation_channels = 'Choose channels to escalate to, or add the “Escalated” event'
  }
  return errors
}

export function eventsSummary(events: readonly NotificationEvent[]): string {
  return effectiveEvents(events)
    .map((event) => NOTIFICATION_EVENT_LABEL[event])
    .join(', ')
}

/** "Escalates after 30 min to Ops Teams, Service desk email" or null when off. */
export function escalationSummary(rule: Pick<NotificationRule, 'escalation' | 'events' | 'channel_ids'>, channelName: (id: string) => string): string | null {
  if (!rule.escalation.enabled) return null
  const targets = [
    ...rule.escalation.channel_ids,
    ...(effectiveEvents(rule.events).includes('escalated') ? rule.channel_ids : []),
  ]
  const names = [...new Set(targets)].map(channelName)
  return `Escalates after ${formatMinutes(rule.escalation.after_minutes)}${names.length ? ` to ${names.join(', ')}` : ''}`
}

/** "2 of 4" for a delivery attempt. */
export function attemptLabel(entry: Pick<NotificationLogEntry, 'attempt' | 'event'>): string {
  return entry.event === 'test' ? 'Test' : `${entry.attempt} of ${MAX_DELIVERY_ATTEMPTS}`
}
