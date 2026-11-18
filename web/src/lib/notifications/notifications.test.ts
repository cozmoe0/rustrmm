import { describe, expect, it } from 'vitest'
import type { NotificationChannel, NotificationRule } from '@/lib/api/types'
import { SECRET_MASK } from '@/lib/automation/params'
import {
  channelInput,
  channelTarget,
  draftFromChannel,
  emptyDraft,
  newHeader,
  toggleInput,
  urlError,
  validateChannelDraft,
} from './channels'
import { attemptLabel, emptyRuleInput, escalationSummary, eventsSummary, validateRuleInput } from './rules'

const channel = (overrides: Partial<NotificationChannel>): NotificationChannel => ({
  id: 'c1',
  name: 'Ops',
  kind: 'slack',
  enabled: true,
  config: {},
  last_used_at: null,
  last_error: null,
  ...overrides,
})

describe('channel drafts', () => {
  it('keeps stored secrets out of the request until they are replaced', () => {
    const slack = draftFromChannel(channel({ config: { webhook_url: SECRET_MASK } }))
    expect(slack.webhook_url).toEqual({ stored: true, mode: 'keep', value: '' })
    expect(channelInput(slack)).toEqual({ name: 'Ops', kind: 'slack', enabled: true, config: {} })
    const replaced = { ...slack, webhook_url: { ...slack.webhook_url, mode: 'replace' as const, value: 'https://hooks.slack.com/x' } }
    expect(channelInput(replaced).config).toEqual({ webhook_url: 'https://hooks.slack.com/x' })
    expect(validateChannelDraft({ ...slack, webhook_url: { ...slack.webhook_url, mode: 'replace' } }).webhook_url).toBe(
      'Enter the webhook URL',
    )
  })

  it('removes optional secrets with null and keeps header values with the mask', () => {
    const hook = draftFromChannel(
      channel({ kind: 'webhook', config: { url: 'https://siem.example/ingest', secret: SECRET_MASK, headers: { 'X-Tenant': SECRET_MASK } } }),
    )
    expect(channelInput(hook).config).toEqual({ url: 'https://siem.example/ingest' })
    const edited = {
      ...hook,
      secret: { ...hook.secret, mode: 'remove' as const },
      headers: [...hook.headers, newHeader('X-Env', 'prod')],
      headersTouched: true,
    }
    expect(channelInput(edited).config).toEqual({
      url: 'https://siem.example/ingest',
      secret: null,
      headers: { 'X-Tenant': SECRET_MASK, 'X-Env': 'prod' },
    })
    // Toggling enabled sends neither secrets nor headers, so both are kept.
    expect(toggleInput(channel({ kind: 'webhook', config: { url: 'https://a.example', secret: SECRET_MASK, headers: { A: SECRET_MASK } } }), false)).toEqual({
      name: 'Ops',
      kind: 'webhook',
      enabled: false,
      config: { url: 'https://a.example' },
    })
  })

  it('validates each kind', () => {
    const email = { ...emptyDraft('email'), name: 'Desk', to: ['ops@example.com', 'nope'] }
    expect(validateChannelDraft(email)).toEqual({ to: '“nope” is not an email address' })
    expect(validateChannelDraft({ ...emptyDraft('ntfy'), name: 'Push', topic: 'bad topic!' })).toEqual({
      topic: 'Use 1–64 letters, digits, dashes or underscores',
    })
    const hook = { ...emptyDraft('webhook'), name: 'Hook', url: 'https://example.com', headers: [newHeader('Content-Type', 'x')] }
    expect(validateChannelDraft(hook).headers).toMatch(/cannot be configured/)
    expect(validateChannelDraft({ ...hook, headers: [newHeader('X-A', 'b'), newHeader('x-a', 'c')] }).headers).toBe('x-a is listed twice')
    expect(validateChannelDraft({ ...emptyDraft('email'), to: ['a@b.co'] }).name).toBe('Enter a name')
  })

  it('checks URLs like the SSRF guard', () => {
    expect(urlError('https://hooks.slack.com/x', 'URL')).toBeNull()
    expect(urlError('http://intranet.local/hook', 'URL')).toMatch(/allowlist/)
    expect(urlError('http://intranet.local/hook', 'URL', ['intranet.local'])).toBeNull()
    expect(urlError('https://user:pw@example.com', 'URL')).toBe('URLs with credentials are refused')
    expect(urlError('ftp://example.com', 'URL')).toBe('Only https URLs are allowed')
    expect(urlError('example.com', 'URL')).toMatch(/full URL/)
  })

  it('describes targets without secrets', () => {
    expect(channelTarget({ kind: 'email', config: { to: ['a@x.io', 'b@x.io'], cc: ['c@x.io'] } })).toBe('a@x.io +1 · cc 1')
    expect(channelTarget({ kind: 'teams', config: { webhook_url: SECRET_MASK } })).toBe('Webhook URL stored (write-only)')
    expect(channelTarget({ kind: 'ntfy', config: { server_url: 'https://ntfy.sh', topic: 'oncall', token: SECRET_MASK } })).toBe(
      'ntfy.sh/oncall · token',
    )
    expect(channelTarget({ kind: 'webhook', config: { url: 'https://siem.example/ingest', secret: SECRET_MASK, headers: { A: SECRET_MASK } } })).toBe(
      'siem.example/ingest · signed · 1 header',
    )
  })
})

describe('rule editor model', () => {
  it('validates names, channels, quiet hours and escalation', () => {
    const input = emptyRuleInput('Europe/London')
    expect(validateRuleInput(input)).toEqual({ name: 'Enter a name', channel_ids: 'Choose at least one channel' })
    const ok = { ...input, name: 'Critical', channel_ids: ['c1'] }
    expect(validateRuleInput(ok)).toEqual({})
    expect(
      validateRuleInput({
        ...ok,
        quiet_hours: { ...ok.quiet_hours, enabled: true, start: '7am', timezone: 'Mars/Base' },
        escalation: { enabled: true, after_minutes: 0, channel_ids: [] },
      }),
    ).toEqual({
      quiet_start: 'Use HH:MM (24-hour)',
      quiet_timezone: 'Choose a valid time zone',
      escalation_minutes: 'Between 1 and 10080 minutes',
      escalation_channels: 'Choose channels to escalate to, or add the “Escalated” event',
    })
    // The rule's own channels are escalation targets when it lists "escalated".
    expect(validateRuleInput({ ...ok, events: ['opened', 'escalated'], escalation: { enabled: true, after_minutes: 30, channel_ids: [] } })).toEqual({})
  })

  it('summarises events, escalation and attempts', () => {
    expect(eventsSummary([])).toBe('Opened, Resolved')
    const rule = { escalation: { enabled: true, after_minutes: 90, channel_ids: ['t'] }, events: ['opened', 'escalated'], channel_ids: ['s', 't'] } as Pick<
      NotificationRule,
      'escalation' | 'events' | 'channel_ids'
    >
    expect(escalationSummary(rule, (id) => id.toUpperCase())).toBe('Escalates after 1 h 30 min to T, S')
    expect(escalationSummary({ ...rule, escalation: { ...rule.escalation, enabled: false } }, String)).toBeNull()
    expect(attemptLabel({ attempt: 2, event: 'opened' })).toBe('2 of 4')
    expect(attemptLabel({ attempt: 1, event: 'test' })).toBe('Test')
  })
})
