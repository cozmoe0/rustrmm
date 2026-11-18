/* SLA policies: client assignment, business hours (zone, days, hours, holidays), targets, pauses and a due-time preview. */
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock, Clock, Lock, Pause, Pencil, Plus, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { EntityAvatar, ErrorState } from '@/components/common/misc'
import { SectionTitle } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/simple-select'
import { TimezonePicker } from '@/components/common/timezone-picker'
import { TokenInput } from '@/components/common/token-input'
import { EditorSection, MultiCombobox } from '@/features/notifications/notification-ui'
import { slaPoliciesApi } from '@/lib/api/endpoints'
import { errorMessage, isApiError } from '@/lib/api/errors'
import { clientsQuery, slaPoliciesQuery, ticketKeys } from '@/lib/api/queries'
import type { BusinessHours, SlaPauseStatus, SlaPolicy, SlaPolicyInput, TicketPriority } from '@/lib/api/types'
import { formatInZone, localTimeZone } from '@/lib/cron'
import { describeBusinessHours, dueTimes, parseClock, previousLocal, WEEKDAYS } from '@/lib/tickets/business-time'
import { PRIORITY_LABEL, PRIORITY_ORDER } from '@/lib/tickets/labels'
import { formatBusinessMinutes, parseDuration } from '@/lib/tickets/sla'
import { cn } from '@/lib/utils'
import { PriorityGlyph } from '../ticket-ui'

const DEFAULT_HOURS: BusinessHours = { timezone: localTimeZone(), days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00', holidays: [] }

interface Draft {
  name: string
  client_ids: string[]
  coverage: '24x7' | 'business'
  hours: BusinessHours
  targets: Record<TicketPriority, { first: string; resolution: string }>
  pause_on: SlaPauseStatus[]
}

function toDraft(policy: SlaPolicy | null): Draft {
  const targets = policy?.targets ?? {
    urgent: { first_response_minutes: 30, resolution_minutes: 240 },
    high: { first_response_minutes: 60, resolution_minutes: 480 },
    normal: { first_response_minutes: 240, resolution_minutes: 1440 },
    low: { first_response_minutes: 480, resolution_minutes: 4320 },
  }
  return {
    name: policy?.name ?? '',
    client_ids: policy?.client_ids ?? [],
    coverage: policy?.business_hours ? 'business' : '24x7',
    hours: policy?.business_hours ?? DEFAULT_HOURS,
    targets: Object.fromEntries(
      PRIORITY_ORDER.map((priority) => [priority, { first: formatBusinessMinutes(targets[priority].first_response_minutes), resolution: formatBusinessMinutes(targets[priority].resolution_minutes) }]),
    ) as Draft['targets'],
    pause_on: policy?.pause_on ?? ['pending', 'on_hold'],
  }
}

function toInput(draft: Draft): { input: SlaPolicyInput | null; errors: Record<string, string> } {
  const errors: Record<string, string> = {}
  if (!draft.name.trim()) errors.name = 'Enter a name'
  const targets = {} as SlaPolicyInput['targets']
  for (const priority of PRIORITY_ORDER) {
    const first = parseDuration(draft.targets[priority].first)
    const resolution = parseDuration(draft.targets[priority].resolution)
    const valid = (value: number | null) => value !== null && value >= 1 && value <= 525_600
    if (!valid(first) || !valid(resolution)) errors[`target-${priority}`] = 'Use durations like 30m, 4h or 2d (up to 365 days)'
    else if (resolution! < first!) errors[`target-${priority}`] = 'Resolution should not be shorter than the first response'
    targets[priority] = { first_response_minutes: first ?? 0, resolution_minutes: resolution ?? 0 }
  }
  if (draft.coverage === 'business') {
    if (!draft.hours.days.length) errors.days = 'Choose at least one business day'
    if (parseClock(draft.hours.start) === null || parseClock(draft.hours.end) === null || draft.hours.start === '24:00') errors.hours = 'Use HH:MM times'
  }
  if (Object.keys(errors).length) return { input: null, errors }
  return {
    errors,
    input: {
      name: draft.name.trim(),
      client_ids: draft.client_ids,
      business_hours: draft.coverage === 'business' ? { ...draft.hours, holidays: [...draft.hours.holidays].sort() } : null,
      targets,
      pause_on: draft.pause_on,
    },
  }
}

/** "An urgent ticket opened Friday 17:30 is due …" for each priority. */
function DuePreview({ input, zone }: { input: Pick<SlaPolicyInput, 'business_hours' | 'targets'>; zone: string }) {
  const [weekday, setWeekday] = useState(5)
  const [time, setTime] = useState('17:30')
  const opened = useMemo(() => previousLocal(weekday, time, zone), [weekday, time, zone])
  return (
    <div className="grid gap-3 rounded-xl bg-surface-2/70 p-3 ring-1 ring-border">
      <div className="flex flex-wrap items-center gap-2 text-dense">
        <CalendarClock className="size-4 text-primary" />
        <span>A ticket opened</span>
        <SimpleSelect size="sm" ariaLabel="Weekday" className="w-32" value={String(weekday)} onValueChange={(value) => setWeekday(Number(value))} options={WEEKDAYS.map((day) => ({ value: String(day.iso), label: day.long }))} />
        <span>at</span>
        <Input type="time" aria-label="Time" value={time} onChange={(event) => event.target.value && setTime(event.target.value)} className="h-7 w-28 tabular" />
        <span className="text-muted-foreground">({zone})</span>
      </div>
      <ul className="grid gap-1.5">
        {PRIORITY_ORDER.map((priority) => {
          const due = dueTimes(input, priority, opened)
          return (
            <li key={priority} className="grid grid-cols-[6rem_minmax(0,1fr)] items-baseline gap-2 text-dense sm:grid-cols-[6.5rem_minmax(0,1fr)_minmax(0,1fr)]">
              <span className="inline-flex items-center gap-1.5 font-medium">
                <PriorityGlyph priority={priority} />
                {PRIORITY_LABEL[priority]}
              </span>
              <span className="text-muted-foreground">
                reply by <span className="tabular font-medium text-foreground">{formatInZone(new Date(due.first_response_due), zone)}</span>
              </span>
              <span className="text-muted-foreground max-sm:col-start-2">
                fixed by <span className="tabular font-medium text-foreground">{formatInZone(new Date(due.resolution_due), zone)}</span>
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function PolicyEditor({ policy, onDone }: { policy: SlaPolicy | null; onDone: () => void }) {
  const queryClient = useQueryClient()
  const { data: clients = [] } = useQuery(clientsQuery())
  const { data: policies = [] } = useQuery(slaPoliciesQuery)
  const [draft, setDraft] = useState<Draft>(() => toDraft(policy))
  const [attempted, setAttempted] = useState(false)
  const { input, errors } = toInput(draft)
  const builtin = policy?.builtin ?? false
  const taken = new Map(policies.filter((item) => item.id !== policy?.id).flatMap((item) => item.client_ids.map((id) => [id, item.name] as const)))
  const save = useMutation({
    mutationFn: () => (policy ? slaPoliciesApi.update(policy.id, input!) : slaPoliciesApi.create(input!)),
    meta: { silent: true, successMessage: 'SLA policy saved; due times of active tickets are recomputed' },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ticketKeys.slaPolicies })
      void queryClient.invalidateQueries({ queryKey: ticketKeys.all })
      onDone()
    },
  })
  const serverError = save.error ? (isApiError(save.error) && save.error.status === 422 ? save.error.message : errorMessage(save.error)) : null
  const setHours = (patch: Partial<BusinessHours>) => setDraft((prev) => ({ ...prev, hours: { ...prev.hours, ...patch } }))
  const previewInput = input ?? {
    business_hours: draft.coverage === 'business' ? draft.hours : null,
    targets: Object.fromEntries(PRIORITY_ORDER.map((priority) => [priority, { first_response_minutes: parseDuration(draft.targets[priority].first) ?? 60, resolution_minutes: parseDuration(draft.targets[priority].resolution) ?? 480 }])) as SlaPolicyInput['targets'],
  }
  const zone = draft.coverage === 'business' ? draft.hours.timezone : localTimeZone()
  return (
    <form
      className="grid min-h-0 gap-0"
      onSubmit={(event) => {
        event.preventDefault()
        setAttempted(true)
        if (input) save.mutate()
      }}
    >
      <div className="grid max-h-[min(70vh,720px)] gap-5 overflow-y-auto px-4 pb-4 sm:px-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field data-invalid={Boolean(attempted && errors.name) || undefined}>
            <FieldLabel htmlFor="sla-name">Name</FieldLabel>
            <Input id="sla-name" autoFocus value={draft.name} maxLength={120} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            <FieldError>{attempted ? errors.name : null}</FieldError>
          </Field>
          <Field>
            <FieldLabel htmlFor="sla-clients">Clients</FieldLabel>
            {builtin ? (
              <p className="flex h-(--control-h) items-center gap-1.5 rounded-lg bg-surface-2 px-3 text-dense text-muted-foreground ring-1 ring-border">
                <Lock className="size-3.5" />
                Every client without its own policy
              </p>
            ) : (
              <MultiCombobox
                id="sla-clients"
                value={draft.client_ids}
                onChange={(client_ids) => setDraft({ ...draft, client_ids })}
                placeholder="Choose clients"
                anyLabel="No clients (acts as a default)"
                options={clients.map((client) => ({ value: client.id, label: client.name, hint: taken.get(client.id) ? `Also in ${taken.get(client.id)}` : undefined }))}
              />
            )}
          </Field>
        </div>

        <EditorSection title="Coverage" description="Due times count business minutes only. A window that starts on a holiday does not count.">
          <div role="radiogroup" aria-label="Coverage" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {(['24x7', 'business'] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={draft.coverage === value}
                onClick={() => setDraft({ ...draft, coverage: value })}
                className={cn(
                  'flex items-start gap-2.5 rounded-lg p-3 text-left ring-1 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  draft.coverage === value ? 'bg-primary/[0.06] ring-primary/40' : 'ring-border hover:bg-surface-2',
                )}
              >
                {value === '24x7' ? <Clock className="mt-0.5 size-4 text-primary" /> : <CalendarClock className="mt-0.5 size-4 text-primary" />}
                <span>
                  <span className="block text-dense font-medium">{value === '24x7' ? '24x7' : 'Business hours'}</span>
                  <span className="block text-micro text-muted-foreground">{value === '24x7' ? 'Clocks run around the clock.' : 'Clocks run only inside the hours you set.'}</span>
                </span>
              </button>
            ))}
          </div>
          {draft.coverage === 'business' && (
            <div className="grid gap-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_8rem_8rem]">
                <Field>
                  <FieldLabel htmlFor="sla-zone">Time zone</FieldLabel>
                  <TimezonePicker id="sla-zone" value={draft.hours.timezone} onChange={(timezone) => setHours({ timezone })} />
                </Field>
                <Field data-invalid={Boolean(attempted && errors.hours) || undefined}>
                  <FieldLabel htmlFor="sla-start">Opens</FieldLabel>
                  <Input id="sla-start" type="time" value={draft.hours.start} onChange={(event) => setHours({ start: event.target.value })} className="tabular" />
                </Field>
                <Field data-invalid={Boolean(attempted && errors.hours) || undefined}>
                  <FieldLabel htmlFor="sla-end">Closes</FieldLabel>
                  <Input id="sla-end" value={draft.hours.end} placeholder="18:00 or 24:00" onChange={(event) => setHours({ end: event.target.value })} className="tabular" />
                </Field>
              </div>
              {(parseClock(draft.hours.end) ?? 0) <= (parseClock(draft.hours.start) ?? 0) && <p className="-mt-1 text-micro text-muted-foreground">Closing at or before opening means an overnight window that ends the next day.</p>}
              {attempted && errors.hours && <p className="-mt-1 text-micro text-critical">{errors.hours}</p>}
              <div className="grid gap-1.5">
                <span className="text-micro font-medium text-muted-foreground">Business days</span>
                <div className="flex flex-wrap gap-1" role="group" aria-label="Business days">
                  {WEEKDAYS.map((day) => {
                    const on = draft.hours.days.includes(day.iso)
                    return (
                      <button
                        key={day.iso}
                        type="button"
                        aria-pressed={on}
                        aria-label={day.long}
                        onClick={() => setHours({ days: on ? draft.hours.days.filter((item) => item !== day.iso) : [...draft.hours.days, day.iso].sort((a, b) => a - b) })}
                        className={cn(
                          'h-8 w-11 rounded-md text-dense ring-1 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                          on ? 'bg-primary text-primary-foreground ring-primary' : 'text-muted-foreground ring-border-strong hover:bg-surface-3 hover:text-foreground',
                        )}
                      >
                        {day.short}
                      </button>
                    )
                  })}
                </div>
                {attempted && errors.days && <p className="text-micro text-critical">{errors.days}</p>}
              </div>
              <Field>
                <FieldLabel htmlFor="sla-holidays">Holidays</FieldLabel>
                <TokenInput
                  id="sla-holidays"
                  value={draft.hours.holidays}
                  onChange={(holidays) => setHours({ holidays })}
                  max={400}
                  mono
                  placeholder="2026-12-25, 2027-01-01"
                  validate={(value) => (/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime()) ? null : 'Use YYYY-MM-DD dates')}
                />
              </Field>
            </div>
          )}
        </EditorSection>

        <EditorSection title="Targets" description="Business time to the first public reply and to resolution, per priority.">
          <div className="grid gap-2">
            <div className="grid grid-cols-[6.5rem_minmax(0,1fr)_minmax(0,1fr)] gap-2 text-micro text-subtle-foreground">
              <span />
              <span>First response</span>
              <span>Resolution</span>
            </div>
            {PRIORITY_ORDER.map((priority) => (
              <div key={priority} className="grid gap-1">
                <div className="grid grid-cols-[6.5rem_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 text-dense font-medium">
                    <PriorityGlyph priority={priority} />
                    {PRIORITY_LABEL[priority]}
                  </span>
                  {(['first', 'resolution'] as const).map((key) => (
                    <Input
                      key={key}
                      aria-label={`${PRIORITY_LABEL[priority]} ${key === 'first' ? 'first response' : 'resolution'} target`}
                      value={draft.targets[priority][key]}
                      aria-invalid={Boolean(attempted && errors[`target-${priority}`]) || undefined}
                      onChange={(event) => setDraft({ ...draft, targets: { ...draft.targets, [priority]: { ...draft.targets[priority], [key]: event.target.value } } })}
                      className="tabular"
                    />
                  ))}
                </div>
                {attempted && errors[`target-${priority}`] && <p className="pl-[6.5rem] text-micro text-critical">{errors[`target-${priority}`]}</p>}
              </div>
            ))}
          </div>
        </EditorSection>

        <EditorSection title="Pause the clock" description="While a ticket is in these statuses its due times are frozen; resuming moves them by the pause.">
          <div className="flex flex-wrap gap-4">
            {(['pending', 'on_hold'] as const).map((status) => (
              <label key={status} className="inline-flex items-center gap-2 text-dense">
                <Checkbox
                  checked={draft.pause_on.includes(status)}
                  onCheckedChange={(checked) => setDraft({ ...draft, pause_on: checked ? [...new Set([...draft.pause_on, status])] : draft.pause_on.filter((item) => item !== status) })}
                />
                {status === 'pending' ? 'Pending (waiting on the customer)' : 'On hold'}
              </label>
            ))}
          </div>
        </EditorSection>

        <EditorSection title="Preview" description="Due times this policy would set.">
          <DuePreview input={previewInput} zone={zone} />
        </EditorSection>
        {serverError && <p className="text-dense text-critical">{serverError}</p>}
      </div>
      <DialogFooter className="m-0 rounded-b-xl border-t border-border bg-surface-2/60 px-4 py-3 sm:px-5">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending && <Spinner data-icon="inline-start" />}
          {policy ? 'Save policy' : 'Create policy'}
        </Button>
      </DialogFooter>
    </form>
  )
}

export function SlaTab() {
  const queryClient = useQueryClient()
  const { data: policies, isLoading, error, refetch } = useQuery(slaPoliciesQuery)
  const { data: clients = [] } = useQuery(clientsQuery())
  const [editing, setEditing] = useState<SlaPolicy | null | 'new'>(null)
  const [deleting, setDeleting] = useState<SlaPolicy | null>(null)
  const remove = useMutation({
    mutationFn: (id: string) => slaPoliciesApi.remove(id),
    meta: { successMessage: 'SLA policy deleted' },
    onSuccess: () => {
      setDeleting(null)
      void queryClient.invalidateQueries({ queryKey: ticketKeys.slaPolicies })
      void queryClient.invalidateQueries({ queryKey: ticketKeys.all })
    },
  })
  const ordered = [...(policies ?? [])].sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.created_at.localeCompare(b.created_at))
  return (
    <div className="grid gap-4">
      <SectionTitle
        description="A ticket uses the oldest policy listing its client, otherwise the default. Changes recompute every active ticket."
        actions={
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus data-icon="inline-start" />
            New policy
          </Button>
        }
      >
        SLA policies
      </SectionTitle>
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isLoading ? (
        <Skeleton className="h-48 rounded-xl" />
      ) : (
        <ul className="grid gap-3 xl:grid-cols-2">
          {ordered.map((policy) => (
            <li key={policy.id} className="grid gap-3 rounded-xl bg-card p-4 shadow-card">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{policy.name}</span>
                    {policy.builtin && (
                      <Badge variant="secondary">
                        <Lock />
                        Default
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 flex items-center gap-1.5 text-micro text-muted-foreground">
                    {policy.business_hours ? <CalendarClock className="size-3" /> : <Clock className="size-3" />}
                    {describeBusinessHours(policy.business_hours)}
                    {policy.business_hours && policy.business_hours.holidays.length > 0 && <> · {policy.business_hours.holidays.length} holidays</>}
                  </p>
                </div>
                <div className="flex shrink-0">
                  <Button size="icon-xs" variant="ghost" aria-label={`Edit ${policy.name}`} onClick={() => setEditing(policy)}>
                    <Pencil />
                  </Button>
                  {!policy.builtin && (
                    <Button size="icon-xs" variant="ghost" aria-label={`Delete ${policy.name}`} className="hover:text-critical" onClick={() => setDeleting(policy)}>
                      <Trash2 />
                    </Button>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {policy.client_ids.length === 0 ? (
                  <span className="text-micro text-subtle-foreground">{policy.builtin ? 'Applies to every client without its own policy' : 'No clients'}</span>
                ) : (
                  policy.client_ids.map((id) => {
                    const client = clients.find((item) => item.id === id)
                    return (
                      <span key={id} className="inline-flex h-6 items-center gap-1.5 rounded-md bg-surface-3 pr-2 pl-1 text-micro ring-1 ring-border">
                        <EntityAvatar name={client?.name ?? '?'} seed={id} accent={client?.accent_color} size="xs" className="size-4 text-[8px]" />
                        {client?.name ?? 'Unknown client'}
                      </span>
                    )
                  })
                )}
              </div>
              <table className="w-full text-dense">
                <thead>
                  <tr className="text-left text-micro text-subtle-foreground">
                    <th className="pb-1 font-normal">Priority</th>
                    <th className="pb-1 font-normal">First response</th>
                    <th className="pb-1 font-normal">Resolution</th>
                  </tr>
                </thead>
                <tbody>
                  {PRIORITY_ORDER.map((priority) => (
                    <tr key={priority} className="border-t border-border">
                      <td className="py-1">
                        <span className="inline-flex items-center gap-1.5">
                          <PriorityGlyph priority={priority} />
                          {PRIORITY_LABEL[priority]}
                        </span>
                      </td>
                      <td className="tabular py-1">{formatBusinessMinutes(policy.targets[priority].first_response_minutes)}</td>
                      <td className="tabular py-1">{formatBusinessMinutes(policy.targets[priority].resolution_minutes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="flex items-center gap-1.5 text-micro text-muted-foreground">
                <Pause className="size-3" />
                {policy.pause_on.length ? `Pauses while ${policy.pause_on.map((status) => (status === 'on_hold' ? 'on hold' : status)).join(' or ')}` : 'Never pauses'}
              </p>
            </li>
          ))}
        </ul>
      )}
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="gap-0 p-0 sm:max-w-[720px]">
          <DialogHeader className="px-4 pt-4 pb-3 sm:px-5">
            <DialogTitle>{editing && editing !== 'new' ? `Edit ${editing.name}` : 'New SLA policy'}</DialogTitle>
            <DialogDescription>Durations accept “30m”, “4h”, “1h 30m” or “2d” (24-hour days of business time).</DialogDescription>
          </DialogHeader>
          {editing !== null && <PolicyEditor policy={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? 'policy'}?`}
        description="Its clients fall back to the default policy, and active tickets get new due times."
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </div>
  )
}
