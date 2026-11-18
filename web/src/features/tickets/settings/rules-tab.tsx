/* Alert-to-ticket rules: which alerts open tickets, after how long, and how the ticket is routed. */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Pencil, Plus, Timer, Trash2, Zap } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/misc'
import { SectionTitle } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/simple-select'
import { SeverityIcon } from '@/features/monitoring/monitoring-ui'
import { ChipToggle, EditorSection, MultiCombobox } from '@/features/notifications/notification-ui'
import { alertTicketRulesApi } from '@/lib/api/endpoints'
import { errorMessage, isApiError } from '@/lib/api/errors'
import { alertTicketRulesQuery, checkTypesQuery, clientsQuery, ticketKeys, ticketQueuesQuery, usersQuery } from '@/lib/api/queries'
import type { AlertSeverity, AlertSource, AlertTicketRule, AlertTicketRuleInput, TicketPriority } from '@/lib/api/types'
import { checkTypeLabel, SERVER_CHECK_LABEL, SEVERITY_LABEL, SOURCE_LABEL as ALERT_SOURCE_LABEL } from '@/lib/monitoring/labels'
import { PRIORITY_LABEL, PRIORITY_ORDER } from '@/lib/tickets/labels'
import { formatMinutes } from '@/lib/tickets/sla'
import { PriorityGlyph } from '../ticket-ui'

const SEVERITIES: AlertSeverity[] = ['critical', 'warning', 'info']
const SOURCES: AlertSource[] = ['check', 'server', 'snmp']

function RuleForm({ rule, onDone }: { rule: AlertTicketRule | null; onDone: () => void }) {
  const queryClient = useQueryClient()
  const { data: clients = [] } = useQuery(clientsQuery())
  const { data: queues = [] } = useQuery(ticketQueuesQuery)
  const { data: users = [] } = useQuery({ ...usersQuery, meta: { silent: true } })
  const { data: catalog = [] } = useQuery({ ...checkTypesQuery, meta: { silent: true } })
  const [draft, setDraft] = useState<AlertTicketRuleInput>(
    rule ?? {
      name: '',
      enabled: true,
      filters: { client_ids: [], severities: ['critical'], check_types: [], sources: [] },
      after_minutes: 10,
      ticket: { queue_id: 'builtin-support-queue', priority: 'high', assignee_id: null },
      close_ticket_on_resolve: true,
    },
  )
  const [after, setAfter] = useState(String(rule?.after_minutes ?? 10))
  const [attempted, setAttempted] = useState(false)
  const minutes = Number(after)
  const errors = {
    name: draft.name.trim() ? null : 'Enter a name',
    after: Number.isInteger(minutes) && minutes >= 0 && minutes <= 10_080 ? null : 'Enter 0 to 10,080 minutes (one week)',
  }
  const setFilters = (patch: Partial<AlertTicketRuleInput['filters']>) => setDraft((prev) => ({ ...prev, filters: { ...prev.filters, ...patch } }))
  const toggle = <T extends string>(list: T[], value: T) => (list.includes(value) ? list.filter((item) => item !== value) : [...list, value])
  const save = useMutation({
    mutationFn: () => {
      const body = { ...draft, name: draft.name.trim(), after_minutes: minutes }
      return rule ? alertTicketRulesApi.update(rule.id, body) : alertTicketRulesApi.create(body)
    },
    meta: { silent: true, successMessage: 'Rule saved' },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ticketKeys.alertRules })
      onDone()
    },
  })
  const serverError = save.error ? (isApiError(save.error) && save.error.status === 422 ? save.error.message : errorMessage(save.error)) : null
  const checkOptions = [
    ...catalog.map((type) => ({ value: type.type, label: type.label, group: 'Agent checks' })),
    ...['offline', 'agent_outdated', 'disk_forecast', 'security', 'patching'].map((type) => ({ value: type, label: SERVER_CHECK_LABEL[type] ?? checkTypeLabel(type), group: 'Server checks' })),
  ]
  return (
    <form
      className="grid min-h-0 gap-0"
      onSubmit={(event) => {
        event.preventDefault()
        setAttempted(true)
        if (errors.name || errors.after) return
        save.mutate()
      }}
    >
      <div className="grid max-h-[min(70vh,680px)] gap-5 overflow-y-auto px-4 pb-4 sm:px-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <Field data-invalid={Boolean(attempted && errors.name) || undefined}>
            <FieldLabel htmlFor="rule-name">Name</FieldLabel>
            <Input id="rule-name" autoFocus value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Critical alerts → NOC queue" />
            <FieldError>{attempted ? errors.name : null}</FieldError>
          </Field>
          <label className="flex h-(--control-h) items-center gap-2 text-dense">
            <Switch checked={draft.enabled} onCheckedChange={(enabled) => setDraft({ ...draft, enabled })} />
            Enabled
          </label>
        </div>
        <EditorSection title="When an alert matches" description="Every list you fill must contain the alert’s value; empty lists match anything.">
          <div className="grid gap-3">
            <div className="flex flex-wrap gap-1.5">
              {SEVERITIES.map((severity) => (
                <ChipToggle key={severity} pressed={draft.filters.severities.includes(severity)} onPressedChange={() => setFilters({ severities: toggle(draft.filters.severities, severity) })}>
                  <SeverityIcon severity={severity} className="size-3.5" />
                  {SEVERITY_LABEL[severity]}
                </ChipToggle>
              ))}
              <span className="mx-1 h-7 w-px bg-border" aria-hidden="true" />
              {SOURCES.map((source) => (
                <ChipToggle key={source} pressed={draft.filters.sources.includes(source)} onPressedChange={() => setFilters({ sources: toggle(draft.filters.sources, source) })}>
                  {ALERT_SOURCE_LABEL[source]}
                </ChipToggle>
              ))}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="rule-clients">Clients</FieldLabel>
                <MultiCombobox id="rule-clients" value={draft.filters.client_ids} onChange={(client_ids) => setFilters({ client_ids })} placeholder="Any client" anyLabel="Any client" options={clients.map((client) => ({ value: client.id, label: client.name }))} />
              </Field>
              <Field>
                <FieldLabel htmlFor="rule-checks">Check types</FieldLabel>
                <MultiCombobox id="rule-checks" value={draft.filters.check_types} onChange={(check_types) => setFilters({ check_types })} placeholder="Any check" anyLabel="Any check" options={checkOptions} />
              </Field>
            </div>
            <Field data-invalid={Boolean(attempted && errors.after) || undefined}>
              <FieldLabel htmlFor="rule-after">Still open and unacknowledged after</FieldLabel>
              <div className="flex items-center gap-2">
                <Input id="rule-after" type="number" min={0} max={10_080} value={after} onChange={(event) => setAfter(event.target.value)} className="w-28 tabular" />
                <span className="text-dense text-muted-foreground">minutes{minutes === 0 ? ' (immediately when the alert opens)' : ''}</span>
              </div>
              <FieldDescription>Delayed rules only consider alerts opened after the rule was created. Alerts in maintenance never open tickets.</FieldDescription>
              <FieldError>{attempted ? errors.after : null}</FieldError>
            </Field>
          </div>
        </EditorSection>
        <EditorSection title="Open a ticket" description="Subject “alert title (hostname)”; the device and the alert are linked; created by System.">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field>
              <FieldLabel htmlFor="rule-queue">Queue</FieldLabel>
              <SimpleSelect id="rule-queue" value={draft.ticket.queue_id} onValueChange={(queue_id) => setDraft({ ...draft, ticket: { ...draft.ticket, queue_id } })} options={queues.map((queue) => ({ value: queue.id, label: queue.name }))} />
            </Field>
            <Field>
              <FieldLabel htmlFor="rule-priority">Priority</FieldLabel>
              <SimpleSelect
                id="rule-priority"
                value={draft.ticket.priority}
                onValueChange={(value) => setDraft({ ...draft, ticket: { ...draft.ticket, priority: value as TicketPriority } })}
                options={PRIORITY_ORDER.map((value) => ({ value, label: PRIORITY_LABEL[value], icon: <PriorityGlyph priority={value} /> }))}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="rule-assignee">Assignee</FieldLabel>
              <SimpleSelect
                id="rule-assignee"
                value={draft.ticket.assignee_id ?? ''}
                onValueChange={(value) => setDraft({ ...draft, ticket: { ...draft.ticket, assignee_id: value || null } })}
                options={[{ value: '', label: 'Queue default' }, ...users.filter((user) => user.status === 'active').map((user) => ({ value: user.id, label: user.name }))]}
              />
            </Field>
          </div>
          <label className="flex items-center justify-between gap-3 rounded-lg bg-surface-2 p-3 text-dense ring-1 ring-border">
            <span>
              <span className="font-medium">Resolve the ticket when the alert resolves</span>
              <span className="block text-micro text-muted-foreground">Adds an internal note and sets the status to Resolved if the ticket is still active.</span>
            </span>
            <Switch checked={draft.close_ticket_on_resolve} onCheckedChange={(close_ticket_on_resolve) => setDraft({ ...draft, close_ticket_on_resolve })} />
          </label>
        </EditorSection>
        {serverError && <p className="text-dense text-critical">{serverError}</p>}
      </div>
      <DialogFooter className="m-0 rounded-b-xl border-t border-border bg-surface-2/60 px-4 py-3 sm:px-5">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending && <Spinner data-icon="inline-start" />}
          {rule ? 'Save rule' : 'Create rule'}
        </Button>
      </DialogFooter>
    </form>
  )
}

export function RulesTab() {
  const queryClient = useQueryClient()
  const { data: rules, isLoading, error, refetch } = useQuery(alertTicketRulesQuery)
  const { data: queues = [] } = useQuery(ticketQueuesQuery)
  const { data: clients = [] } = useQuery(clientsQuery())
  const { data: users = [] } = useQuery({ ...usersQuery, meta: { silent: true } })
  const [editing, setEditing] = useState<AlertTicketRule | null | 'new'>(null)
  const [deleting, setDeleting] = useState<AlertTicketRule | null>(null)
  const toggle = useMutation({
    mutationFn: (rule: AlertTicketRule) => alertTicketRulesApi.update(rule.id, { ...rule, enabled: !rule.enabled }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ticketKeys.alertRules }),
  })
  const remove = useMutation({
    mutationFn: (id: string) => alertTicketRulesApi.remove(id),
    meta: { successMessage: 'Rule deleted' },
    onSuccess: () => {
      setDeleting(null)
      void queryClient.invalidateQueries({ queryKey: ticketKeys.alertRules })
    },
  })
  const ordered = [...(rules ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at))
  return (
    <div className="grid gap-4">
      <SectionTitle
        description="The oldest matching enabled rule wins, and an alert never gets more than one ticket. Technicians can also use “Create ticket” on any alert."
        actions={
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus data-icon="inline-start" />
            New rule
          </Button>
        }
      >
        Alert-to-ticket rules
      </SectionTitle>
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isLoading ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : ordered.length === 0 ? (
        <EmptyState compact illustration="alerts" title="No rules yet" description="Open tickets automatically for alerts nobody picked up." />
      ) : (
        <ol className="grid gap-3">
          {ordered.map((rule, index) => {
            const queue = queues.find((item) => item.id === rule.ticket.queue_id)
            const filters = [
              rule.filters.severities.length ? rule.filters.severities.map((severity) => SEVERITY_LABEL[severity]).join(' or ') : 'Any severity',
              rule.filters.sources.length ? rule.filters.sources.map((source) => ALERT_SOURCE_LABEL[source]).join(' or ') : null,
              rule.filters.check_types.length ? rule.filters.check_types.map((type) => SERVER_CHECK_LABEL[type] ?? checkTypeLabel(type)).join(', ') : null,
              rule.filters.client_ids.length ? rule.filters.client_ids.map((id) => clients.find((client) => client.id === id)?.name ?? 'Unknown').join(', ') : 'any client',
            ].filter(Boolean)
            return (
              <li key={rule.id} className="flex flex-col gap-3 rounded-xl bg-card p-4 shadow-card md:flex-row md:items-center">
                <span className="tabular flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-3 text-micro font-semibold text-muted-foreground ring-1 ring-border">{index + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{rule.name}</span>
                    {!rule.enabled && <Badge variant="outline">Disabled</Badge>}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-micro text-muted-foreground">
                    <Zap className="size-3 text-warning" />
                    <span>{filters.join(' · ')}</span>
                    <span className="inline-flex items-center gap-1">
                      <Timer className="size-3" />
                      {rule.after_minutes === 0 ? 'immediately' : `after ${formatMinutes(rule.after_minutes)}`}
                    </span>
                    <ArrowRight className="size-3" />
                    <span className="inline-flex items-center gap-1">
                      <PriorityGlyph priority={rule.ticket.priority} />
                      {PRIORITY_LABEL[rule.ticket.priority]} in {queue?.name ?? 'Support'}
                      {rule.ticket.assignee_id ? ` for ${users.find((user) => user.id === rule.ticket.assignee_id)?.name ?? 'someone'}` : ''}
                    </span>
                    {rule.close_ticket_on_resolve && <Badge variant="secondary">Auto-resolves</Badge>}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Switch checked={rule.enabled} onCheckedChange={() => toggle.mutate(rule)} aria-label={rule.enabled ? `Disable ${rule.name}` : `Enable ${rule.name}`} />
                  <Button size="icon-xs" variant="ghost" aria-label={`Edit ${rule.name}`} onClick={() => setEditing(rule)}>
                    <Pencil />
                  </Button>
                  <Button size="icon-xs" variant="ghost" aria-label={`Delete ${rule.name}`} className="hover:text-critical" onClick={() => setDeleting(rule)}>
                    <Trash2 />
                  </Button>
                </div>
              </li>
            )
          })}
        </ol>
      )}
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="gap-0 p-0 sm:max-w-[680px]">
          <DialogHeader className="px-4 pt-4 pb-3 sm:px-5">
            <DialogTitle>{editing && editing !== 'new' ? `Edit ${editing.name}` : 'New alert-to-ticket rule'}</DialogTitle>
            <DialogDescription>Turn alerts nobody acknowledged into tickets with an owner and an SLA.</DialogDescription>
          </DialogHeader>
          {editing !== null && <RuleForm rule={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete “${deleting?.name ?? ''}”?`}
        description="Tickets it already created stay."
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </div>
  )
}
