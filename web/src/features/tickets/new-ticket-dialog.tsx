/* The app-wide "New ticket" dialog: client, site, contact, subject, Markdown description and routing. */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { MonitorSmartphone, Plus, TicketPlus, TriangleExclamationPoint, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Spinner } from '@/components/ui/spinner'
import { SimpleSelect } from '@/components/common/simple-select'
import { TokenInput } from '@/components/common/token-input'
import { Kbd } from '@/components/common/misc'
import { DevicePicker } from '@/features/automation/device-picker'
import { SeverityIcon } from '@/features/monitoring/monitoring-ui'
import { alertsApi, ticketsApi } from '@/lib/api/endpoints'
import { errorMessage, isApiError } from '@/lib/api/errors'
import { clientsQuery, contactQuery, devicesQuery, sitesQuery } from '@/lib/api/queries'
import type { TicketPriority, TicketType } from '@/lib/api/types'
import { modKeyLabel } from '@/lib/hotkeys'
import { MAX_TAGS, normalizeTag } from '@/lib/tickets/bulk'
import { PRIORITY_LABEL, PRIORITY_ORDER, ticketNumber, TYPE_LABEL, TYPE_ORDER } from '@/lib/tickets/labels'
import { useStore } from '@/lib/store'
import { useScope } from '@/lib/scope'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { ContactPicker, type ContactChoice } from './contact-picker'
import { MarkdownEditor } from './markdown'
import { closeNewTicket, newTicketStore, type NewTicketPrefill } from './ticket-stores'
import { PriorityGlyph } from './ticket-ui'
import { refreshTickets, useTicketActions } from './use-ticket-actions'

function NewTicketForm({ prefill, onDone }: { prefill: NewTicketPrefill; onDone: () => void }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const me = useMe()
  const { clientId: scopeClient } = useScope()
  const actions = useTicketActions()
  const { data: clients = [] } = useQuery(clientsQuery())
  const [clientId, setClientId] = useState(prefill.client_id ?? scopeClient ?? '')
  const [siteId, setSiteId] = useState(prefill.site_id ?? '')
  const [picked, setPicked] = useState<{ value: ContactChoice | null } | null>(null)
  // A prefilled contact (from a contact page) applies until someone picks another.
  const { data: prefilledContact } = useQuery({ ...contactQuery(prefill.contact_id ?? ''), enabled: Boolean(prefill.contact_id) })
  const contact: ContactChoice | null = picked ? picked.value : (prefilledContact ?? null)
  const setContact = (value: ContactChoice | null) => setPicked({ value })
  const [subject, setSubject] = useState(prefill.subject ?? '')
  const [description, setDescription] = useState(prefill.description ?? '')
  const [priority, setPriority] = useState<TicketPriority | ''>(prefill.priority ?? '')
  const [type, setType] = useState<TicketType>('incident')
  const [queueId, setQueueId] = useState('')
  const [assignee, setAssignee] = useState<string>('default')
  const [tags, setTags] = useState<string[]>([])
  const [deviceIds, setDeviceIds] = useState<string[]>(prefill.device_ids ?? [])
  const [alertIds, setAlertIds] = useState<string[]>(prefill.alert_ids ?? [])
  const [attempted, setAttempted] = useState(false)
  const { data: sites = [] } = useQuery({ ...sitesQuery(clientId || undefined), enabled: Boolean(clientId) })
  const canDevices = hasPermission(me, PERMISSIONS.devicesView)
  const { data: devices = [], isLoading: devicesLoading } = useQuery({ ...devicesQuery({ client_id: clientId || undefined }), enabled: Boolean(clientId) && canDevices })
  const canAlerts = hasPermission(me, PERMISSIONS.alertsView)
  const { data: alerts } = useQuery({
    queryKey: ['alerts', 'list', { client_id: clientId, status: 'open,acknowledged', limit: 100, purpose: 'ticket-link' }],
    queryFn: () => alertsApi.list({ client_id: clientId, status: 'open,acknowledged', limit: 100 }),
    enabled: Boolean(clientId) && canAlerts,
    meta: { silent: true },
  })
  const queue = actions.queues.find((item) => item.id === queueId)
  const effectivePriority: TicketPriority = priority || queue?.default_priority || 'normal'
  const errors = {
    client: clientId ? null : 'Choose a client',
    subject: !subject.trim() ? 'Enter a subject' : subject.length > 200 ? 'At most 200 characters' : null,
  }

  const create = useMutation({
    mutationFn: () =>
      ticketsApi.create({
        subject: subject.trim().replace(/\s+/g, ' '),
        description,
        client_id: clientId,
        site_id: siteId || null,
        contact_id: contact?.id ?? null,
        priority: priority || undefined,
        type,
        queue_id: queueId || undefined,
        ...(assignee === 'default' ? {} : { assignee_id: assignee === 'none' ? null : assignee }),
        tags,
        device_ids: deviceIds,
        alert_ids: alertIds,
      }),
    meta: { silent: true },
    onSuccess: (ticket) => {
      refreshTickets(queryClient, [ticket.id])
      void queryClient.invalidateQueries({ queryKey: ['alerts'] })
      toast.success(`Ticket ${ticketNumber(ticket.number)} created`, {
        description: ticket.subject,
        action: { label: 'Open', onClick: () => void navigate({ to: '/tickets/$ticketId', params: { ticketId: ticket.id } }) },
      })
      onDone()
      void navigate({ to: '/tickets', search: { ticket: ticket.id } })
    },
  })
  const serverError = create.error ? (isApiError(create.error) && create.error.status === 422 ? create.error.message : errorMessage(create.error)) : null
  const submit = () => {
    setAttempted(true)
    if (errors.client || errors.subject || create.isPending) return
    create.mutate()
  }
  const selectedDevices = devices.filter((device) => deviceIds.includes(device.id))
  const openAlerts = alerts?.items ?? []

  return (
    <form
      className="grid min-h-0 gap-0"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <div className="grid max-h-[min(70vh,680px)] gap-4 overflow-y-auto px-4 pt-1 pb-4 sm:px-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field data-invalid={Boolean(attempted && errors.client) || undefined}>
            <FieldLabel htmlFor="nt-client">Client</FieldLabel>
            <SimpleSelect
              id="nt-client"
              value={clientId || null}
              placeholder="Choose a client"
              ariaInvalid={Boolean(attempted && errors.client)}
              onValueChange={(value) => {
                setClientId(value)
                setSiteId('')
                setContact(null)
                setDeviceIds([])
                setAlertIds([])
              }}
              options={clients.map((client) => ({ value: client.id, label: client.name }))}
            />
            <FieldError>{attempted ? errors.client : null}</FieldError>
          </Field>
          <Field>
            <FieldLabel htmlFor="nt-site">Site</FieldLabel>
            <SimpleSelect
              id="nt-site"
              value={siteId}
              disabled={!clientId}
              onValueChange={setSiteId}
              options={[{ value: '', label: 'No specific site' }, ...sites.map((site) => ({ value: site.id, label: site.name }))]}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="nt-contact">Contact</FieldLabel>
            <ContactPicker
              id="nt-contact"
              clientId={clientId}
              siteId={siteId || null}
              value={contact}
              onChange={(next) => {
                setContact(next)
                if (next?.site_id && !siteId) setSiteId(next.site_id)
              }}
            />
          </Field>
        </div>

        <Field data-invalid={Boolean(attempted && errors.subject) || undefined}>
          <FieldLabel htmlFor="nt-subject">Subject</FieldLabel>
          <Input
            id="nt-subject"
            autoFocus
            value={subject}
            maxLength={200}
            placeholder="Printer offline in reception"
            aria-invalid={Boolean(attempted && errors.subject) || undefined}
            onChange={(event) => setSubject(event.target.value.replace(/[\r\n]+/g, ' '))}
          />
          <FieldError>{attempted ? errors.subject : null}</FieldError>
        </Field>

        <Field>
          <FieldLabel htmlFor="nt-description">Description</FieldLabel>
          <MarkdownEditor
            id="nt-description"
            value={description}
            onChange={setDescription}
            maxLength={100_000}
            placeholder="What happened, who is affected, and what has been tried. Markdown supported."
            onSubmit={submit}
            textareaClassName="min-h-32"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field>
            <FieldLabel htmlFor="nt-priority">Priority</FieldLabel>
            <SimpleSelect
              id="nt-priority"
              value={priority}
              onValueChange={(value) => setPriority(value as TicketPriority | '')}
              options={[
                { value: '', label: `Queue default (${PRIORITY_LABEL[queue?.default_priority ?? 'normal']})`, icon: <PriorityGlyph priority={queue?.default_priority ?? 'normal'} /> },
                ...PRIORITY_ORDER.map((value) => ({ value, label: PRIORITY_LABEL[value], icon: <PriorityGlyph priority={value} /> })),
              ]}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="nt-type">Type</FieldLabel>
            <SimpleSelect id="nt-type" value={type} onValueChange={(value) => setType(value as TicketType)} options={TYPE_ORDER.map((value) => ({ value, label: TYPE_LABEL[value] }))} />
          </Field>
          <Field>
            <FieldLabel htmlFor="nt-queue">Queue</FieldLabel>
            <SimpleSelect
              id="nt-queue"
              value={queueId}
              onValueChange={setQueueId}
              options={[{ value: '', label: 'Support (default)' }, ...actions.queues.filter((item) => !item.builtin).map((item) => ({ value: item.id, label: item.name }))]}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="nt-assignee">Assignee</FieldLabel>
            <SimpleSelect
              id="nt-assignee"
              value={assignee}
              onValueChange={setAssignee}
              options={[
                { value: 'default', label: 'Queue default' },
                { value: 'none', label: 'Unassigned' },
                ...(actions.meId ? [{ value: actions.meId, label: 'Me' }] : []),
                ...actions.users.filter((user) => user.id !== actions.meId).map((user) => ({ value: user.id, label: user.name, group: 'Team' })),
              ]}
            />
          </Field>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="nt-tags">Tags</FieldLabel>
            <TokenInput id="nt-tags" value={tags} onChange={setTags} max={MAX_TAGS} normalize={normalizeTag} placeholder="printers, vip…" validate={(tag) => (tag.length > 40 ? 'Tags are at most 40 characters' : null)} />
          </Field>
          <Field>
            <FieldLabel>Linked devices and alerts</FieldLabel>
            <div className="flex flex-wrap items-center gap-1.5">
              {selectedDevices.map((device) => (
                <span key={device.id} className="inline-flex h-6 items-center gap-1 rounded-md bg-surface-3 pr-0.5 pl-1.5 text-micro ring-1 ring-border">
                  <MonitorSmartphone className="size-3 text-subtle-foreground" />
                  {device.hostname}
                  <button type="button" aria-label={`Remove ${device.hostname}`} onClick={() => setDeviceIds((ids) => ids.filter((id) => id !== device.id))} className="flex size-5 items-center justify-center rounded-sm hover:bg-surface-4">
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              {openAlerts
                .filter((alert) => alertIds.includes(alert.id))
                .map((alert) => (
                  <span key={alert.id} className="inline-flex h-6 max-w-56 items-center gap-1 rounded-md bg-surface-3 pr-0.5 pl-1.5 text-micro ring-1 ring-border">
                    <SeverityIcon severity={alert.severity} className="size-3" />
                    <span className="truncate">{alert.title}</span>
                    <button type="button" aria-label={`Remove ${alert.title}`} onClick={() => setAlertIds((ids) => ids.filter((id) => id !== alert.id))} className="flex size-5 shrink-0 items-center justify-center rounded-sm hover:bg-surface-4">
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              {canDevices && (
                <Popover>
                  <PopoverTrigger render={<Button type="button" size="xs" variant="outline" disabled={!clientId} />}>
                    <Plus data-icon="inline-start" />
                    Device
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-[min(26rem,calc(100vw-2rem))]">
                    <DevicePicker devices={devices} selected={deviceIds} onChange={(ids) => setDeviceIds(ids.slice(0, 50))} loading={devicesLoading} autoFocus height={260} />
                  </PopoverContent>
                </Popover>
              )}
              {canAlerts && (
                <Popover>
                  <PopoverTrigger render={<Button type="button" size="xs" variant="outline" disabled={!clientId} />}>
                    <Plus data-icon="inline-start" />
                    Alert
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-[min(24rem,calc(100vw-2rem))] p-1">
                    {openAlerts.length === 0 ? (
                      <p className="px-3 py-4 text-center text-dense text-muted-foreground">No open alerts for this client.</p>
                    ) : (
                      <ul className="max-h-64 overflow-y-auto">
                        {openAlerts.map((alert) => (
                          <li key={alert.id}>
                            <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-3">
                              <Checkbox
                                checked={alertIds.includes(alert.id)}
                                disabled={Boolean(alert.ticket_id)}
                                onCheckedChange={(checked) => setAlertIds((ids) => (checked ? [...ids, alert.id] : ids.filter((id) => id !== alert.id)))}
                              />
                              <SeverityIcon severity={alert.severity} />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-dense">{alert.title}</span>
                                <span className="block truncate text-micro text-muted-foreground">
                                  {alert.hostname ?? alert.client_name}
                                  {alert.ticket_id ? ' · already has a ticket' : ''}
                                </span>
                              </span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}
                  </PopoverContent>
                </Popover>
              )}
            </div>
          </Field>
        </div>
        {serverError && (
          <p role="alert" className="flex items-start gap-2 rounded-lg bg-critical/[0.06] px-3 py-2 text-dense text-critical ring-1 ring-critical/25">
            <TriangleExclamationPoint className="mt-0.5 size-4 shrink-0" />
            {serverError}
          </p>
        )}
      </div>
      <DialogFooter className="m-0 items-center rounded-b-xl border-t border-border bg-surface-2/60 px-4 py-3 sm:px-5">
        <span className="mr-auto hidden items-center gap-1.5 text-micro text-muted-foreground sm:inline-flex">
          <PriorityGlyph priority={effectivePriority} />
          {PRIORITY_LABEL[effectivePriority]} · <Kbd>{modKeyLabel}</Kbd>
          <Kbd>Enter</Kbd> to create
        </span>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? <Spinner data-icon="inline-start" /> : <TicketPlus data-icon="inline-start" />}
          Create ticket
        </Button>
      </DialogFooter>
    </form>
  )
}

/** Mounted once in the app shell; opened through `openNewTicket()`. */
export function NewTicketDialogHost() {
  const request = useStore(newTicketStore)
  if (!request) return null
  return (
    <Dialog open={request.open} onOpenChange={(open) => !open && closeNewTicket()}>
      <DialogContent className="gap-0 p-0 sm:max-w-[780px]">
        <DialogHeader className="px-4 pt-4 pb-3 sm:px-5">
          <DialogTitle className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-lg bg-primary/12 text-primary ring-1 ring-primary/25">
              <TicketPlus className="size-4" />
            </span>
            New ticket
          </DialogTitle>
          <DialogDescription>Create a ticket for a client. The contact gets the “we received your request” email if notifications are on.</DialogDescription>
        </DialogHeader>
        <NewTicketForm key={request.nonce} prefill={request.value} onDone={closeNewTicket} />
      </DialogContent>
    </Dialog>
  )
}
