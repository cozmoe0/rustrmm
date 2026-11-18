/* The notification rule editor: filters, events, channels, quiet hours and escalation. */
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock, CircleAlert, Moon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { TimezonePicker } from '@/components/common/timezone-picker'
import { ListInput } from '@/features/automation/list-input'
import { ChannelKindTile, CheckTypeIcon, SeverityIcon } from '@/features/monitoring/monitoring-ui'
import { notificationsApi } from '@/lib/api/endpoints'
import { errorMessage, isApiError } from '@/lib/api/errors'
import { checkTypesQuery, clientsQuery, keys, notificationChannelsQuery, sitesQuery } from '@/lib/api/queries'
import type { AlertSeverity, AlertSource, NotificationEvent, NotificationRule, NotificationRuleInput } from '@/lib/api/types'
import { formatInZone, localTimeZone } from '@/lib/cron'
import {
  NOTIFICATION_EVENT_LABEL,
  NOTIFICATION_EVENTS,
  SERVER_CHECK_IDS,
  SERVER_CHECK_LABEL,
  SEVERITY_LABEL,
  SEVERITY_ORDER,
  SOURCE_LABEL,
} from '@/lib/monitoring/labels'
import { describeQuietHours, quietPeriods, quietStatus } from '@/lib/monitoring/quiet-hours'
import { emptyRuleInput, ESCALATION_MAX_MINUTES, ruleInput, SERVER_CHECK_TYPES, validateRuleInput, type RuleErrors } from '@/lib/notifications/rules'
import { ChipToggle, DayPicker, EditorSection, MultiCombobox, type MultiOption } from './notification-ui'

const EVENT_HELP: Record<NotificationEvent, string> = {
  opened: 'An alert opens or reopens.',
  severity_changed: 'An open alert gets more severe.',
  escalated: 'Still open and unacknowledged after the escalation delay.',
  resolved: 'The alert resolves, automatically or by hand.',
  'secret.revealed': 'Someone revealed a BitLocker key or admin password (only the client and site filters apply).',
}

const toggle = <T,>(list: T[], item: T) => (list.includes(item) ? list.filter((entry) => entry !== item) : [...list, item])

function QuietPreview({ input }: { input: NotificationRuleInput }) {
  const quiet = input.quiet_hours
  const periods = useMemo(() => quietPeriods(quiet, { count: 3 }), [quiet])
  const status = quietStatus(quiet)
  const local = localTimeZone()
  return (
    <div className="grid grid-cols-1 gap-2 rounded-lg bg-surface-2 p-3 ring-1 ring-border">
      <p className="flex items-start gap-2 text-dense">
        <Moon className="mt-0.5 size-3.5 shrink-0 text-info" />
        <span className="min-w-0">
          <span className="font-medium">{describeQuietHours(quiet)}</span>
          {status && <span className="block text-micro text-muted-foreground">{status.label}</span>}
        </span>
      </p>
      {periods.length > 0 && (
        <ol className="grid grid-cols-1 gap-1 border-t border-border pt-2">
          {periods.map((period) => (
            <li key={period.start.toISOString()} className="flex flex-wrap items-baseline justify-between gap-x-3 text-micro">
              <span className="tabular text-foreground/90">
                {formatInZone(period.start, quiet.timezone || 'UTC')} → {formatInZone(period.end, quiet.timezone || 'UTC')}
              </span>
              {local !== (quiet.timezone || 'UTC') && (
                <span className="tabular text-subtle-foreground">
                  {formatInZone(period.start, local)} your time
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      <p className="text-micro text-subtle-foreground">
        Held notifications are logged as “Quiet hours” and are not sent later.
      </p>
    </div>
  )
}

export function RuleEditor({
  open,
  onOpenChange,
  rule,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  rule: NotificationRule | null
}) {
  const queryClient = useQueryClient()
  const { data: channels = [] } = useQuery(notificationChannelsQuery)
  const { data: clients = [] } = useQuery(clientsQuery())
  const { data: sites = [] } = useQuery(sitesQuery())
  const { data: catalog = [] } = useQuery({ ...checkTypesQuery, meta: { silent: true } })
  const [input, setInput] = useState<NotificationRuleInput>(() => (rule ? ruleInput(rule) : emptyRuleInput(localTimeZone())))
  const [attempted, setAttempted] = useState(false)
  const errors = validateRuleInput(input)
  const shown: RuleErrors = attempted ? errors : {}
  const set = (patch: Partial<NotificationRuleInput>) => setInput((prev) => ({ ...prev, ...patch }))
  const setFilters = (patch: Partial<NotificationRuleInput['filters']>) => set({ filters: { ...input.filters, ...patch } })
  const setQuiet = (patch: Partial<NotificationRuleInput['quiet_hours']>) => set({ quiet_hours: { ...input.quiet_hours, ...patch } })
  const setEscalation = (patch: Partial<NotificationRuleInput['escalation']>) => set({ escalation: { ...input.escalation, ...patch } })

  const channelOptions: MultiOption[] = channels.map((channel) => ({
    value: channel.id,
    label: channel.name,
    hint: channel.enabled ? undefined : 'Paused',
    icon: <ChannelKindTile kind={channel.kind} size="sm" className="size-5 rounded-[5px] [&_svg]:size-3" />,
  }))
  const clientOptions: MultiOption[] = clients.map((client) => ({ value: client.id, label: client.name }))
  const siteOptions: MultiOption[] = sites.map((site) => ({
    value: site.id,
    label: site.name,
    group: clients.find((client) => client.id === site.client_id)?.name ?? 'Other',
  }))
  const typeOptions: MultiOption[] = [
    ...catalog.map((definition) => ({
      value: definition.type,
      label: definition.label,
      icon: <CheckTypeIcon type={definition.type} className="size-3.5 text-muted-foreground" />,
      group: 'Agent checks',
    })),
    ...SERVER_CHECK_TYPES.map((item) => ({
      value: item.type,
      label: item.label,
      icon: <CheckTypeIcon type={item.type} className="size-3.5 text-muted-foreground" />,
      group: 'Server checks',
    })),
  ]

  const save = useMutation({
    mutationFn: () => {
      const body = { ...input, name: input.name.trim() }
      return rule ? notificationsApi.updateRule(rule.id, body) : notificationsApi.createRule(body)
    },
    meta: { silent: true },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: keys.notificationRules })
      toast.success(rule ? `Saved “${saved.name}”` : `Created “${saved.name}”`)
      onOpenChange(false)
    },
    onError: (failure) => {
      if (!(isApiError(failure) && failure.status === 422)) toast.error(errorMessage(failure))
    },
  })
  const serverError = save.error && isApiError(save.error) && save.error.status === 422 ? save.error.message : null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-[640px]">
        <SheetHeader className="border-b border-border px-5 pt-5 pb-4">
          <SheetTitle className="pr-8 text-base">{rule ? `Edit “${rule.name}”` : 'New notification rule'}</SheetTitle>
          <SheetDescription>A rule fires when it lists the event and every filter you set matches. Empty filters match any alert.</SheetDescription>
        </SheetHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault()
            setAttempted(true)
            if (Object.keys(errors).length) return
            save.mutate()
          }}
        >
          <div className="grid min-h-0 flex-1 grid-cols-1 content-start gap-5 overflow-y-auto px-5 py-4">
            {serverError && (
              <p role="alert" className="flex items-start gap-2 rounded-lg bg-critical/[0.06] px-3 py-2 text-dense text-critical ring-1 ring-critical/25">
                <CircleAlert className="mt-0.5 size-4 shrink-0" />
                {serverError}
              </p>
            )}
            <EditorSection title="Rule">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                <Field data-invalid={Boolean(shown.name) || undefined}>
                  <FieldLabel htmlFor="rule-name">Name</FieldLabel>
                  <Input
                    id="rule-name"
                    value={input.name}
                    maxLength={80}
                    placeholder="Critical to on-call"
                    autoFocus={!rule}
                    onChange={(event) => set({ name: event.target.value })}
                  />
                  <FieldError>{shown.name}</FieldError>
                </Field>
                <label className="flex h-(--control-h) items-center gap-2 text-dense">
                  <Switch checked={input.enabled} onCheckedChange={(enabled) => set({ enabled })} />
                  Enabled
                </label>
              </div>
            </EditorSection>

            <EditorSection title="Which alerts" description="Leave a filter empty to match any value.">
              <Field>
                <FieldLabel>Severity</FieldLabel>
                <div className="flex flex-wrap gap-1.5">
                  {SEVERITY_ORDER.map((severity: AlertSeverity) => (
                    <ChipToggle
                      key={severity}
                      pressed={input.filters.severities.includes(severity)}
                      onPressedChange={() => setFilters({ severities: toggle(input.filters.severities, severity) })}
                    >
                      <SeverityIcon severity={severity} />
                      {SEVERITY_LABEL[severity]}
                    </ChipToggle>
                  ))}
                  <span className="self-center px-1 text-micro text-subtle-foreground">
                    {input.filters.severities.length ? '' : 'Any severity'}
                  </span>
                </div>
              </Field>
              <Field>
                <FieldLabel>Source</FieldLabel>
                <div className="flex flex-wrap gap-1.5">
                  {(['check', 'server', 'snmp'] as AlertSource[]).map((source) => (
                    <ChipToggle
                      key={source}
                      pressed={input.filters.sources.includes(source)}
                      onPressedChange={() => setFilters({ sources: toggle(input.filters.sources, source) })}
                    >
                      {SOURCE_LABEL[source]}
                    </ChipToggle>
                  ))}
                </div>
              </Field>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="rule-clients">Clients</FieldLabel>
                  <MultiCombobox
                    id="rule-clients"
                    options={clientOptions}
                    value={input.filters.client_ids}
                    onChange={(client_ids) => setFilters({ client_ids })}
                    placeholder="Choose clients"
                    anyLabel="Any client"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="rule-sites">Sites</FieldLabel>
                  <MultiCombobox
                    id="rule-sites"
                    options={siteOptions}
                    value={input.filters.site_ids}
                    onChange={(site_ids) => setFilters({ site_ids })}
                    placeholder="Choose sites"
                    anyLabel="Any site"
                  />
                  {input.filters.site_ids.length > 0 && (
                    <FieldDescription>Alerts without a site (some server checks) never match a site filter.</FieldDescription>
                  )}
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="rule-types">Check types</FieldLabel>
                <MultiCombobox
                  id="rule-types"
                  options={typeOptions}
                  value={input.filters.check_types}
                  onChange={(check_types) => setFilters({ check_types })}
                  placeholder="Choose check types"
                  anyLabel="Any check type"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="rule-check-ids">Check ids</FieldLabel>
                <ListInput
                  id="rule-check-ids"
                  mono
                  value={input.filters.check_ids}
                  onChange={(check_ids) => setFilters({ check_ids })}
                  placeholder="disk-space, offline, security.local_admin_added…"
                />
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-micro text-subtle-foreground">Server checks:</span>
                  {SERVER_CHECK_IDS.filter((id) => !input.filters.check_ids.includes(id)).map((id) => (
                    <button
                      key={id}
                      type="button"
                      title={SERVER_CHECK_LABEL[id]}
                      onClick={() => setFilters({ check_ids: [...input.filters.check_ids, id] })}
                      className="inline-flex h-5 items-center rounded-[5px] bg-surface-3 px-1.5 font-mono text-[10.5px] text-secondary-foreground ring-1 ring-border hover:bg-surface-4"
                    >
                      + {id}
                    </button>
                  ))}
                </div>
              </Field>
            </EditorSection>

            <EditorSection title="When" description="With no event ticked, the rule fires on Opened and Resolved.">
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {NOTIFICATION_EVENTS.map((event) => (
                  <li key={event}>
                    <label className="flex h-full items-start gap-2.5 rounded-lg px-3 py-2.5 ring-1 ring-border hover:bg-surface-2 has-data-checked:bg-primary/[0.05] has-data-checked:ring-primary/30">
                      <Checkbox
                        className="mt-0.5"
                        checked={input.events.includes(event)}
                        onCheckedChange={() => set({ events: toggle(input.events, event) })}
                      />
                      <span className="min-w-0 text-dense">
                        <span className="block font-medium">{NOTIFICATION_EVENT_LABEL[event]}</span>
                        <span className="block text-micro text-muted-foreground">{EVENT_HELP[event]}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </EditorSection>

            <EditorSection title="Send to" description="Each channel is notified once per alert event, even when several rules pick it.">
              <Field data-invalid={Boolean(shown.channel_ids) || undefined}>
                <MultiCombobox
                  id="rule-channels"
                  options={channelOptions}
                  value={input.channel_ids}
                  onChange={(channel_ids) => set({ channel_ids })}
                  placeholder="Choose channels"
                  invalid={Boolean(shown.channel_ids)}
                />
                {shown.channel_ids ? (
                  <FieldError>{shown.channel_ids}</FieldError>
                ) : channels.length === 0 ? (
                  <FieldDescription>Add a channel on the Channels tab first.</FieldDescription>
                ) : null}
              </Field>
            </EditorSection>

            <EditorSection
              title="Quiet hours"
              description="Hold notifications overnight or at weekends, on the rule's own clock."
              action={
                <Switch
                  checked={input.quiet_hours.enabled}
                  aria-label="Quiet hours"
                  onCheckedChange={(enabled) => setQuiet({ enabled })}
                />
              }
            >
              {input.quiet_hours.enabled && (
                <div className="grid grid-cols-1 gap-3">
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-[8rem_8rem_minmax(0,1fr)]">
                    <Field data-invalid={Boolean(shown.quiet_start) || undefined}>
                      <FieldLabel htmlFor="quiet-start">From</FieldLabel>
                      <Input
                        id="quiet-start"
                        type="time"
                        step={60}
                        className="tabular"
                        value={input.quiet_hours.start}
                        onChange={(event) => setQuiet({ start: event.target.value })}
                      />
                      <FieldError>{shown.quiet_start}</FieldError>
                    </Field>
                    <Field data-invalid={Boolean(shown.quiet_end) || undefined}>
                      <FieldLabel htmlFor="quiet-end">Until</FieldLabel>
                      <Input
                        id="quiet-end"
                        type="time"
                        step={60}
                        className="tabular"
                        value={input.quiet_hours.end}
                        onChange={(event) => setQuiet({ end: event.target.value })}
                      />
                      <FieldError>{shown.quiet_end}</FieldError>
                    </Field>
                    <Field className="col-span-2 sm:col-span-1" data-invalid={Boolean(shown.quiet_timezone) || undefined}>
                      <FieldLabel htmlFor="quiet-zone">Time zone</FieldLabel>
                      <TimezonePicker id="quiet-zone" value={input.quiet_hours.timezone} onChange={(timezone) => setQuiet({ timezone })} />
                      <FieldError>{shown.quiet_timezone}</FieldError>
                    </Field>
                  </div>
                  <Field>
                    <FieldLabel>Days</FieldLabel>
                    <DayPicker value={input.quiet_hours.days} onChange={(days) => setQuiet({ days })} />
                    <FieldDescription>
                      {input.quiet_hours.days.length === 0
                        ? 'No day picked means every day.'
                        : 'A period that crosses midnight belongs to the day it starts on.'}
                    </FieldDescription>
                  </Field>
                  <label className="flex items-start justify-between gap-3 rounded-lg px-3 py-2.5 ring-1 ring-border">
                    <span className="text-dense">
                      <span className="block font-medium">Critical alerts still notify</span>
                      <span className="block text-micro text-muted-foreground">Let critical alerts through during quiet hours.</span>
                    </span>
                    <Switch checked={input.quiet_hours.except_critical} onCheckedChange={(except_critical) => setQuiet({ except_critical })} />
                  </label>
                  <QuietPreview input={input} />
                </div>
              )}
            </EditorSection>

            <EditorSection
              title="Escalation"
              description="Once per alert: notify more channels when it is still open and unacknowledged."
              action={
                <Switch
                  checked={input.escalation.enabled}
                  aria-label="Escalation"
                  onCheckedChange={(enabled) => setEscalation({ enabled })}
                />
              }
            >
              {input.escalation.enabled && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
                  <Field data-invalid={Boolean(shown.escalation_minutes) || undefined}>
                    <FieldLabel htmlFor="escalate-after">After</FieldLabel>
                    <div className="relative">
                      <Input
                        id="escalate-after"
                        type="number"
                        min={1}
                        max={ESCALATION_MAX_MINUTES}
                        className="tabular pr-12"
                        value={Number.isNaN(input.escalation.after_minutes) ? '' : input.escalation.after_minutes}
                        onChange={(event) =>
                          setEscalation({ after_minutes: event.target.value === '' ? Number.NaN : Number(event.target.value) })
                        }
                      />
                      <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-micro text-subtle-foreground">min</span>
                    </div>
                    <FieldError>{shown.escalation_minutes}</FieldError>
                  </Field>
                  <Field data-invalid={Boolean(shown.escalation_channels) || undefined}>
                    <FieldLabel htmlFor="escalate-channels">Escalate to</FieldLabel>
                    <MultiCombobox
                      id="escalate-channels"
                      options={channelOptions}
                      value={input.escalation.channel_ids}
                      onChange={(channel_ids) => setEscalation({ channel_ids })}
                      placeholder="Choose channels"
                      invalid={Boolean(shown.escalation_channels)}
                    />
                    <FieldError>{shown.escalation_channels}</FieldError>
                  </Field>
                  <p className="flex items-start gap-2 text-micro text-muted-foreground sm:col-span-2">
                    <CalendarClock className="mt-0.5 size-3.5 shrink-0" />
                    {input.events.includes('escalated')
                      ? 'Because the rule lists “Escalated”, its own channels are notified as well. Quiet hours apply.'
                      : 'Tick the “Escalated” event to also notify the rule’s own channels. Snoozed alerts and devices in maintenance do not escalate.'}
                  </p>
                </div>
              )}
            </EditorSection>
          </div>
          <div className="flex flex-col-reverse gap-2 border-t border-border bg-popover px-5 py-3 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending && <Spinner data-icon="inline-start" />}
              {rule ? 'Save rule' : 'Create rule'}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}
