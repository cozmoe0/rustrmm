/* The ticket's side panel: SLA timers, properties, contact and CCs, tags, and linked devices, alerts and tickets. */
import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  Building,
  ExternalLink,
  FolderOpen,
  Link2,
  Mail,
  MapPin,
  MonitorPlay,
  Pause,
  Phone,
  Plus,
  Search,
  Settings2,
  SquareTerminal,
  TriangleExclamationPoint,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { RelativeTime } from '@/components/common/misc'
import { SimpleSelect } from '@/components/common/simple-select'
import { StatusDot } from '@/components/common/status-dot'
import { TokenInput } from '@/components/common/token-input'
import { DevicePicker } from '@/features/automation/device-picker'
import { REMOTE_TOOL, type RemoteTab } from '@/features/devices/cockpit-tabs'
import { remoteToolAccess } from '@/features/devices/remote-access'
import { AlertStatusBadge } from '@/features/monitoring/monitoring-ui'
import { alertsApi, ticketsApi } from '@/lib/api/endpoints'
import { errorMessage } from '@/lib/api/errors'
import { clientsQuery, contactQuery, deviceQuery, devicesQuery, sitesQuery, ticketKeys } from '@/lib/api/queries'
import type { Ticket, TicketLinks } from '@/lib/api/types'
import { formatDateTime } from '@/lib/format'
import { MAX_TAGS, normalizeTag } from '@/lib/tickets/bulk'
import { isEmail } from '@/lib/tickets/csv'
import { parseTicketJump } from '@/lib/tickets/jump'
import { SOURCE_LABEL, ticketNumber } from '@/lib/tickets/labels'
import { formatCountdown, SLA_KIND_LABEL, type SlaClock } from '@/lib/tickets/sla'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { cn } from '@/lib/utils'
import { ContactPicker } from './contact-picker'
import { SlaClockChip, TicketStatusBadge } from './ticket-ui'
import { patchTicketCaches, refreshTickets, type TicketActions } from './use-ticket-actions'
import { useSlaClocks } from './use-now'

export function SideSection({ title, action, children, className }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('grid min-w-0 gap-2 [&>*]:min-w-0', className)}>
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h3 className="eyebrow">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

// ------------------------------------------------------------------ SLA

function SlaRow({ clock, created, now }: { clock: SlaClock; created: string; now: number }) {
  const start = new Date(created).getTime()
  const due = new Date(clock.due).getTime()
  const end = clock.met_at ? new Date(clock.met_at).getTime() : now
  const fraction = due > start ? Math.min(1, Math.max(0, (end - start) / (due - start))) : 1
  const bar =
    clock.tone === 'breached' || clock.tone === 'met_late' ? 'bg-critical' : clock.tone === 'due_soon' ? 'bg-warning' : clock.tone === 'paused' ? 'bg-subtle-foreground/50' : clock.tone === 'met' ? 'bg-success/70' : 'bg-success'
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-dense font-medium">{SLA_KIND_LABEL[clock.kind]}</span>
        <SlaClockChip clock={clock} />
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-4" role="presentation">
        <div className={cn('h-full rounded-full transition-[width] duration-700', bar)} style={{ width: `${Math.max(3, fraction * 100)}%` }} />
      </div>
      <div className="flex justify-between gap-2 text-[10.5px] text-subtle-foreground">
        <span className="tabular">{clock.met_at ? `Met ${formatDateTime(clock.met_at)}` : `Due ${formatDateTime(clock.due)}`}</span>
        {clock.remaining_ms !== null && clock.tone !== 'paused' && (
          <span className={cn('tabular', clock.remaining_ms < 0 && 'text-critical')}>{clock.remaining_ms < 0 ? `${formatCountdown(-clock.remaining_ms)} overdue` : `${formatCountdown(clock.remaining_ms)} left`}</span>
        )}
      </div>
    </div>
  )
}

export function SlaPanel({ ticket }: { ticket: Ticket }) {
  const me = useMe()
  const clocks = useSlaClocks(ticket.sla, 5_000)
  if (!ticket.sla || !clocks) {
    return (
      <SideSection title="SLA">
        <p className="text-dense text-subtle-foreground">No SLA policy applies.</p>
      </SideSection>
    )
  }
  return (
    <SideSection
      title="SLA"
      action={
        hasPermission(me, PERMISSIONS.ticketsSettings) ? (
          <Link to="/settings/tickets" search={{ tab: 'sla' }} className="inline-flex max-w-44 items-center gap-1 truncate text-[10.5px] text-muted-foreground hover:text-foreground">
            <Settings2 className="size-3 shrink-0" />
            <span className="truncate">{ticket.sla.policy_name}</span>
          </Link>
        ) : (
          <span className="max-w-44 truncate text-[10.5px] text-muted-foreground">{ticket.sla.policy_name}</span>
        )
      }
    >
      <div className="grid gap-3 rounded-xl bg-card p-3 shadow-card">
        {ticket.sla.paused && (
          <p className="flex items-center gap-1.5 rounded-md bg-surface-3 px-2 py-1 text-micro text-muted-foreground">
            <Pause className="size-3" />
            Clock paused while {ticket.status === 'on_hold' ? 'on hold' : 'pending'}; due times move when it resumes.
          </p>
        )}
        <SlaRow clock={clocks.first} created={ticket.created_at} now={clocks.now} />
        <SlaRow clock={clocks.resolution} created={ticket.created_at} now={clocks.now} />
      </div>
    </SideSection>
  )
}

// ------------------------------------------------------------------ links

function useLinks(ticket: Ticket) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ add, links }: { add: boolean; links: TicketLinks }) => (add ? ticketsApi.link(ticket.id, links) : ticketsApi.unlink(ticket.id, links)),
    meta: { silent: true },
    onSuccess: (updated, { links }) => {
      patchTicketCaches(queryClient, new Set([ticket.id]), () => updated)
      refreshTickets(queryClient, [ticket.id, ...(links.ticket_ids ?? [])])
      if (links.alert_ids?.length) void queryClient.invalidateQueries({ queryKey: ['alerts'] })
    },
    onError: (error) => toast.error(errorMessage(error)),
  })
}

const QUICK_TOOLS: RemoteTab[] = ['desktop', 'terminal', 'files']
const QUICK_ICON = { desktop: MonitorPlay, terminal: SquareTerminal, files: FolderOpen } as Record<RemoteTab, typeof MonitorPlay>

function DeviceRow({ id, hostname, canEdit, onUnlink }: { id: string; hostname: string; canEdit: boolean; onUnlink: () => void }) {
  const me = useMe()
  const navigate = useNavigate()
  const { data: device } = useQuery({ ...deviceQuery(id), refetchInterval: false, meta: { silent: true } })
  return (
    <li className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-2">
      <StatusDot tone={device ? (device.online ? 'live' : 'offline') : 'neutral'} label={device?.online ? 'Online' : 'Offline'} />
      <Link to="/devices/$deviceId" params={{ deviceId: id }} className="min-w-0 flex-1 truncate text-dense font-medium hover:underline">
        {hostname}
        {device?.last_user && <span className="ml-1.5 text-micro font-normal text-subtle-foreground">{device.last_user}</span>}
      </Link>
      <span className="flex shrink-0 items-center">
        {device &&
          QUICK_TOOLS.map((tab) => {
            const access = remoteToolAccess(device, me, tab)
            const Icon = QUICK_ICON[tab]
            return (
              <Tooltip key={tab}>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`${REMOTE_TOOL[tab].description} on ${hostname}`}
                      disabled={!access.ok}
                      onClick={() => void navigate({ to: '/devices/$deviceId', params: { deviceId: id }, search: { tab } })}
                    />
                  }
                >
                  <Icon />
                </TooltipTrigger>
                <TooltipContent>{access.ok ? REMOTE_TOOL[tab].description : access.reason}</TooltipContent>
              </Tooltip>
            )
          })}
        {canEdit && (
          <Button size="icon-xs" variant="ghost" aria-label={`Unlink ${hostname}`} onClick={onUnlink} className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100">
            <X />
          </Button>
        )}
      </span>
    </li>
  )
}

export function LinkedDevices({ ticket, canEdit }: { ticket: Ticket; canEdit: boolean }) {
  const me = useMe()
  const links = useLinks(ticket)
  const canDevices = hasPermission(me, PERMISSIONS.devicesView)
  const [open, setOpen] = useState(false)
  const { data: devices = [], isLoading } = useQuery({ ...devicesQuery({ client_id: ticket.client_id }), enabled: open && canDevices })
  const linked = ticket.devices.map((device) => device.id)
  return (
    <SideSection
      title={`Devices · ${ticket.devices.length}`}
      action={
        canEdit &&
        canDevices && (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger render={<Button size="xs" variant="ghost" aria-label="Link devices" />}>
              <Plus data-icon="inline-start" />
              Link
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[min(26rem,calc(100vw-2rem))]">
              <DevicePicker
                devices={devices}
                selected={linked}
                loading={isLoading}
                autoFocus
                height={260}
                onChange={(ids) => {
                  const added = ids.filter((id) => !linked.includes(id))
                  const removed = linked.filter((id) => !ids.includes(id))
                  if (added.length) links.mutate({ add: true, links: { device_ids: added } })
                  if (removed.length) links.mutate({ add: false, links: { device_ids: removed } })
                }}
              />
            </PopoverContent>
          </Popover>
        )
      }
    >
      {ticket.devices.length === 0 ? (
        <p className="text-dense text-subtle-foreground">No devices linked.</p>
      ) : (
        <ul className="-mx-2 grid">
          {ticket.devices.map((device) => (
            <DeviceRow key={device.id} id={device.id} hostname={device.hostname} canEdit={canEdit} onUnlink={() => links.mutate({ add: false, links: { device_ids: [device.id] } })} />
          ))}
        </ul>
      )}
    </SideSection>
  )
}

export function LinkedAlerts({ ticket, canEdit }: { ticket: Ticket; canEdit: boolean }) {
  const me = useMe()
  const links = useLinks(ticket)
  const canAlerts = hasPermission(me, PERMISSIONS.alertsView)
  const [open, setOpen] = useState(false)
  const { data } = useQuery({
    queryKey: ['alerts', 'list', { client_id: ticket.client_id, status: 'open,acknowledged', limit: 100, purpose: 'ticket-link' }],
    queryFn: () => alertsApi.list({ client_id: ticket.client_id, status: 'open,acknowledged', limit: 100 }),
    enabled: open && canAlerts,
  })
  const linked = new Set(ticket.alerts.map((alert) => alert.id))
  return (
    <SideSection
      title={`Alerts · ${ticket.alerts.length}`}
      action={
        canEdit &&
        canAlerts && (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger render={<Button size="xs" variant="ghost" aria-label="Link alerts" />}>
              <Plus data-icon="inline-start" />
              Link
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[min(24rem,calc(100vw-2rem))] p-1">
              {!data ? (
                <div className="flex justify-center p-4">
                  <Spinner />
                </div>
              ) : data.items.length === 0 ? (
                <p className="px-3 py-4 text-center text-dense text-muted-foreground">No open alerts for {ticket.client_name}.</p>
              ) : (
                <ul className="max-h-64 overflow-y-auto">
                  {data.items.map((alert) => (
                    <li key={alert.id}>
                      <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-3">
                        <Checkbox checked={linked.has(alert.id)} onCheckedChange={(checked) => links.mutate({ add: Boolean(checked), links: { alert_ids: [alert.id] } })} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-dense">{alert.title}</span>
                          <span className="block truncate text-micro text-muted-foreground">{alert.hostname ?? alert.client_name}</span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </PopoverContent>
          </Popover>
        )
      }
    >
      {ticket.alerts.length === 0 ? (
        <p className="text-dense text-subtle-foreground">No alerts linked.</p>
      ) : (
        <ul className="-mx-2 grid">
          {ticket.alerts.map((alert) => (
            <li key={alert.id} className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-2">
              <TriangleExclamationPoint className="size-3.5 shrink-0 text-subtle-foreground" />
              <Link to="/alerts" search={{ alert: alert.id, status: 'all' }} className="min-w-0 flex-1 truncate text-dense hover:underline">
                {alert.title}
              </Link>
              <AlertStatusBadge alert={{ status: alert.status, resolution: null, acknowledged_by_name: null, resolved_by_name: null }} />
              {canEdit && (
                <Button size="icon-xs" variant="ghost" aria-label={`Unlink ${alert.title}`} onClick={() => links.mutate({ add: false, links: { alert_ids: [alert.id] } })} className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100">
                  <X />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </SideSection>
  )
}

/** Search for a ticket by number or text (used for links and merges). */
export function TicketFinder({ onPick, exclude, clientId, autoFocus = true }: { onPick: (ticket: Ticket) => void; exclude: string[]; clientId?: string; autoFocus?: boolean }) {
  const [query, setQuery] = useState('')
  const jump = parseTicketJump(query)
  const q = jump ? String(jump) : query.trim()
  const { data, isFetching } = useQuery({
    queryKey: [...ticketKeys.lists, { purpose: 'finder', q, clientId }],
    queryFn: () => ticketsApi.list({ q: q || undefined, client_id: clientId, status: q ? 'all' : undefined, limit: 10 }),
    staleTime: 10_000,
  })
  const items = (data?.items ?? []).filter((ticket) => !exclude.includes(ticket.id) && !ticket.merged_into)
  return (
    <div className="grid gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle-foreground" />
        <Input autoFocus={autoFocus} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="#1042 or search…" aria-label="Find a ticket" className="h-8 pl-8" />
        {isFetching && <Spinner className="absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-subtle-foreground" />}
      </div>
      <ul className="max-h-60 overflow-y-auto">
        {items.length === 0 ? (
          <li className="px-3 py-4 text-center text-dense text-muted-foreground">{isFetching ? 'Searching…' : 'No tickets found.'}</li>
        ) : (
          items.map((ticket) => (
            <li key={ticket.id}>
              <button type="button" onClick={() => onPick(ticket)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-surface-3 focus-visible:bg-surface-3">
                <span className="tabular shrink-0 font-mono text-micro text-muted-foreground">{ticketNumber(ticket.number)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-dense">{ticket.subject}</span>
                  <span className="block truncate text-micro text-subtle-foreground">{ticket.client_name}</span>
                </span>
                <TicketStatusBadge status={ticket.status} />
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  )
}

export function LinkedTickets({ ticket, canEdit }: { ticket: Ticket; canEdit: boolean }) {
  const links = useLinks(ticket)
  const [open, setOpen] = useState(false)
  return (
    <SideSection
      title={`Linked tickets · ${ticket.tickets.length}`}
      action={
        canEdit && (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger render={<Button size="xs" variant="ghost" aria-label="Link a ticket" />}>
              <Link2 data-icon="inline-start" />
              Link
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[min(24rem,calc(100vw-2rem))]">
              <TicketFinder
                exclude={[ticket.id, ...ticket.tickets.map((item) => item.id)]}
                onPick={(target) => {
                  links.mutate({ add: true, links: { ticket_ids: [target.id] } })
                  setOpen(false)
                }}
              />
            </PopoverContent>
          </Popover>
        )
      }
    >
      {ticket.tickets.length === 0 ? (
        <p className="text-dense text-subtle-foreground">No linked tickets.</p>
      ) : (
        <ul className="-mx-2 grid">
          {ticket.tickets.map((item) => (
            <li key={item.id} className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-2">
              <span className="tabular shrink-0 font-mono text-micro text-muted-foreground">{ticketNumber(item.number)}</span>
              <Link to="/tickets/$ticketId" params={{ ticketId: item.id }} className="min-w-0 flex-1 truncate text-dense hover:underline">
                {item.subject}
              </Link>
              <TicketStatusBadge status={item.status} />
              {canEdit && (
                <Button size="icon-xs" variant="ghost" aria-label={`Unlink ${ticketNumber(item.number)}`} onClick={() => links.mutate({ add: false, links: { ticket_ids: [item.id] } })} className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100">
                  <X />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </SideSection>
  )
}

// ------------------------------------------------------------------ properties

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-2 py-1 text-dense">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

export function TicketProperties({ ticket, actions }: { ticket: Ticket; actions: TicketActions }) {
  const canEdit = actions.canManage && !ticket.merged_into
  const { data: clients = [] } = useQuery({ ...clientsQuery(), enabled: canEdit })
  const { data: sites = [] } = useQuery({ ...sitesQuery(ticket.client_id), enabled: canEdit })
  const [moveTo, setMoveTo] = useState<string | null>(null)
  return (
    <SideSection title="Details">
      <dl className="grid">
        <Prop label="Client">
          {canEdit ? (
            <SimpleSelect
              size="sm"
              ariaLabel="Client"
              value={ticket.client_id}
              onValueChange={(value) => value !== ticket.client_id && setMoveTo(value)}
              options={clients.length ? clients.map((client) => ({ value: client.id, label: client.name })) : [{ value: ticket.client_id, label: ticket.client_name }]}
            />
          ) : (
            <Link to="/clients/$clientId" params={{ clientId: ticket.client_id }} className="inline-flex items-center gap-1.5 hover:underline">
              <Building className="size-3.5 text-subtle-foreground" />
              {ticket.client_name}
            </Link>
          )}
        </Prop>
        <Prop label="Site">
          {canEdit ? (
            <SimpleSelect
              size="sm"
              ariaLabel="Site"
              value={ticket.site_id ?? ''}
              onValueChange={(value) => actions.update(ticket, { site_id: value || null })}
              options={[{ value: '', label: 'No specific site' }, ...sites.map((site) => ({ value: site.id, label: site.name }))]}
            />
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <MapPin className="size-3.5 text-subtle-foreground" />
              {ticket.site_name ?? '—'}
            </span>
          )}
        </Prop>
        <Prop label="Source">{SOURCE_LABEL[ticket.source]}</Prop>
        <Prop label="Opened by">
          <span className="truncate">{ticket.created_by_name}</span>
        </Prop>
        <Prop label="Created">
          <RelativeTime value={ticket.created_at} />
        </Prop>
        <Prop label="Updated">
          <RelativeTime value={ticket.updated_at} />
        </Prop>
        {ticket.closed_at && (
          <Prop label="Closed">
            <RelativeTime value={ticket.closed_at} />
          </Prop>
        )}
        {ticket.merged_into && (
          <Prop label="Merged into">
            <Link to="/tickets/$ticketId" params={{ ticketId: ticket.merged_into.id }} className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
              {ticketNumber(ticket.merged_into.number)}
              <ExternalLink className="size-3" />
            </Link>
          </Prop>
        )}
      </dl>
      <ConfirmDialog
        open={moveTo !== null}
        onOpenChange={(open) => !open && setMoveTo(null)}
        destructive={false}
        title={`Move ${ticketNumber(ticket.number)} to ${clients.find((client) => client.id === moveTo)?.name ?? 'another client'}?`}
        description="The site and contact of the current client are cleared, and the SLA due times are recomputed for the new client."
        confirmLabel="Move ticket"
        onConfirm={() => {
          if (moveTo) actions.update(ticket, { client_id: moveTo })
          setMoveTo(null)
        }}
      />
    </SideSection>
  )
}

export function ContactSection({ ticket, actions }: { ticket: Ticket; actions: TicketActions }) {
  const canEdit = actions.canManage && !ticket.merged_into
  const { data: contact } = useQuery({ ...contactQuery(ticket.contact?.id ?? ''), enabled: Boolean(ticket.contact?.id), meta: { silent: true } })
  return (
    <SideSection title="Contact">
      {canEdit ? (
        <ContactPicker clientId={ticket.client_id} siteId={ticket.site_id} value={ticket.contact} onChange={(next) => actions.update(ticket, { contact_id: next?.id ?? null })} className="h-9" align="end" />
      ) : ticket.contact ? (
        <span className="text-dense font-medium">{ticket.contact.name}</span>
      ) : (
        <span className="text-dense text-subtle-foreground">No contact</span>
      )}
      {ticket.contact && (
        <div className="grid gap-1 px-0.5 text-micro text-muted-foreground">
          {ticket.contact.email && (
            <a href={`mailto:${ticket.contact.email}`} className="inline-flex min-w-0 items-center gap-1.5 hover:text-foreground">
              <Mail className="size-3 shrink-0" />
              <span className="truncate">{ticket.contact.email}</span>
            </a>
          )}
          {contact?.phone && (
            <a href={`tel:${contact.phone.replace(/\s+/g, '')}`} className="inline-flex items-center gap-1.5 hover:text-foreground">
              <Phone className="size-3" />
              {contact.phone}
            </a>
          )}
          {contact?.title && <span>{contact.title}</span>}
          <Link to="/tickets/contacts/$contactId" params={{ contactId: ticket.contact.id }} className="font-medium text-primary hover:underline">
            Contact’s tickets
          </Link>
        </div>
      )}
      <div className="grid gap-1.5 pt-1">
        <span className="text-micro text-muted-foreground">CC on public replies</span>
        {canEdit ? (
          <TokenInput
            value={ticket.cc}
            ariaLabel="CC addresses"
            placeholder="name@example.com"
            max={20}
            normalize={(value) => value.trim().toLowerCase()}
            validate={(value) => (isEmail(value) ? null : `“${value}” is not an email address`)}
            onChange={(cc) => actions.update(ticket, { cc })}
          />
        ) : (
          <span className="text-dense">{ticket.cc.join(', ') || '—'}</span>
        )}
      </div>
    </SideSection>
  )
}

export function TagsSection({ ticket, actions }: { ticket: Ticket; actions: TicketActions }) {
  const canEdit = actions.canManage && !ticket.merged_into
  return (
    <SideSection title="Tags">
      {canEdit ? (
        <TokenInput
          value={ticket.tags}
          ariaLabel="Tags"
          placeholder="Add a tag…"
          max={MAX_TAGS}
          normalize={normalizeTag}
          validate={(value) => (value.length > 40 ? 'Tags are at most 40 characters' : null)}
          onChange={(tags) => actions.update(ticket, { tags })}
        />
      ) : ticket.tags.length ? (
        <span className="text-dense">{ticket.tags.join(', ')}</span>
      ) : (
        <span className="text-dense text-subtle-foreground">No tags</span>
      )}
    </SideSection>
  )
}

