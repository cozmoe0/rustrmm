/* Ticket and contact panels for the device cockpit and the client page. */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { BookUser, FileSpreadsheet, Plus, Star, TicketPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, UserAvatar } from '@/components/common/misc'
import { SectionTitle } from '@/components/common/page-header'
import { ticketsApi } from '@/lib/api/endpoints'
import { contactsQuery, deviceTicketsQuery, ticketKeys } from '@/lib/api/queries'
import type { Client, Device } from '@/lib/api/types'
import { isActiveStatus } from '@/lib/tickets/labels'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { ContactDialog, ContactImportDialog } from './contact-dialogs'
import { openNewTicket } from './ticket-stores'
import { TicketTable } from './ticket-table'

function NoAccess() {
  return <EmptyState compact illustration="tickets" title="You can’t view tickets" description="Ask an administrator for the “View tickets” permission." />
}

/** Active-ticket count beside the cockpit's Tickets tab label. */
export function DeviceTicketCount({ deviceId }: { deviceId: string }) {
  const me = useMe()
  const { data } = useQuery({ ...deviceTicketsQuery(deviceId), enabled: hasPermission(me, PERMISSIONS.ticketsView), meta: { silent: true } })
  const active = (data?.items ?? []).filter((ticket) => isActiveStatus(ticket.status)).length
  if (!active) return null
  return <span className="tabular text-micro text-subtle-foreground">{active}</span>
}

/** The device cockpit's Tickets tab (`GET /devices/{id}/tickets`, every status). */
export function DeviceTicketsTab({ device }: { device: Pick<Device, 'id' | 'hostname' | 'client_id' | 'site_id'> }) {
  const me = useMe()
  const canView = hasPermission(me, PERMISSIONS.ticketsView)
  const [showClosed, setShowClosed] = useState(false)
  const { data, isLoading, error, refetch } = useQuery({ ...deviceTicketsQuery(device.id), enabled: canView })
  if (!canView) return <NoAccess />
  const items = (data?.items ?? []).filter((ticket) => showClosed || isActiveStatus(ticket.status))
  const closedCount = (data?.items ?? []).filter((ticket) => !isActiveStatus(ticket.status)).length
  return (
    <div className="grid gap-4">
      <SectionTitle
        description={`Tickets that link ${device.hostname}.`}
        actions={
          <>
            <label className="inline-flex items-center gap-2 text-micro text-muted-foreground">
              <Switch checked={showClosed} onCheckedChange={setShowClosed} aria-label="Show resolved and closed tickets" />
              Resolved ({closedCount})
            </label>
            {hasPermission(me, PERMISSIONS.ticketsManage) && (
              <Button size="sm" onClick={() => openNewTicket({ client_id: device.client_id, site_id: device.site_id, device_ids: [device.id] })}>
                <TicketPlus data-icon="inline-start" />
                New ticket
              </Button>
            )}
          </>
        }
      >
        Tickets
      </SectionTitle>
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isLoading ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : items.length === 0 ? (
        <EmptyState compact illustration="tickets" title={showClosed ? 'No tickets for this device' : 'No open tickets for this device'} description="Tickets that link this device, from email, alerts or the agent’s Request support, show here." />
      ) : (
        <TicketTable tickets={items} hideClient />
      )}
    </div>
  )
}

/** The client page's Tickets tab. */
export function ClientTicketsTab({ client }: { client: Pick<Client, 'id' | 'name'> }) {
  const me = useMe()
  const canView = hasPermission(me, PERMISSIONS.ticketsView)
  const [showClosed, setShowClosed] = useState(false)
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: [...ticketKeys.lists, { purpose: 'client', client_id: client.id, closed: showClosed }],
    queryFn: () => ticketsApi.list({ client_id: client.id, status: showClosed ? 'all' : undefined, limit: 200 }),
    enabled: canView,
  })
  if (!canView) return <NoAccess />
  const counts = data?.counts
  return (
    <div className="grid gap-4">
      <SectionTitle
        description={counts ? `${counts.new + counts.open + counts.pending + counts.on_hold} active · ${counts.breached} breaching SLA · ${counts.unassigned} unassigned` : undefined}
        actions={
          <>
            <label className="inline-flex items-center gap-2 text-micro text-muted-foreground">
              <Switch checked={showClosed} onCheckedChange={setShowClosed} aria-label="Include resolved and closed tickets" />
              Include resolved
            </label>
            <Button size="sm" variant="outline" render={<Link to="/tickets" search={{ client: client.id }} />} nativeButton={false}>
              Open in queue
            </Button>
            {hasPermission(me, PERMISSIONS.ticketsManage) && (
              <Button size="sm" onClick={() => openNewTicket({ client_id: client.id })}>
                <TicketPlus data-icon="inline-start" />
                New ticket
              </Button>
            )}
          </>
        }
      >
        Tickets
      </SectionTitle>
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isLoading ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : (data?.items ?? []).length === 0 ? (
        <EmptyState compact illustration="tickets" title="No tickets" description={`${client.name} has no ${showClosed ? '' : 'open '}tickets.`} />
      ) : (
        <TicketTable tickets={data!.items} hideClient />
      )}
    </div>
  )
}

/** The client page's Contacts tab. */
export function ClientContactsTab({ client }: { client: Pick<Client, 'id' | 'name'> }) {
  const me = useMe()
  const canView = hasPermission(me, PERMISSIONS.ticketsView)
  const canManage = hasPermission(me, PERMISSIONS.ticketsManage)
  const { data: contacts = [], isLoading, error, refetch } = useQuery({ ...contactsQuery(client.id), enabled: canView })
  const [creating, setCreating] = useState(false)
  const [importing, setImporting] = useState(false)
  if (!canView) return <NoAccess />
  return (
    <div className="grid gap-4">
      <SectionTitle
        description="People who raise tickets for this client."
        actions={
          <>
            {hasPermission(me, PERMISSIONS.ticketsSettings) && (
              <Button size="sm" variant="outline" onClick={() => setImporting(true)}>
                <FileSpreadsheet data-icon="inline-start" />
                Import CSV
              </Button>
            )}
            {canManage && (
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus data-icon="inline-start" />
                New contact
              </Button>
            )}
          </>
        }
      >
        Contacts
      </SectionTitle>
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isLoading ? (
        <Skeleton className="h-32 rounded-xl" />
      ) : contacts.length === 0 ? (
        <EmptyState compact illustration="users" title="No contacts yet" description="Add the people who email you, or import them from a CSV." />
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {contacts.map((contact) => (
            <li key={contact.id}>
              <Link
                to="/tickets/contacts/$contactId"
                params={{ contactId: contact.id }}
                className="flex items-center gap-3 rounded-xl bg-card p-3 shadow-card outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <UserAvatar name={contact.name} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 truncate text-dense font-medium">
                    {contact.name}
                    {contact.is_primary && <Star className="size-3 shrink-0 fill-primary text-primary" aria-label="Primary contact" />}
                  </span>
                  <span className="block truncate text-micro text-muted-foreground">{[contact.title, contact.email].filter(Boolean).join(' · ') || 'No details'}</span>
                </span>
                <BookUser className="size-3.5 shrink-0 text-subtle-foreground" />
              </Link>
            </li>
          ))}
        </ul>
      )}
      <ContactDialog open={creating} onOpenChange={setCreating} contact={null} defaultClientId={client.id} />
      <ContactImportDialog open={importing} onOpenChange={setImporting} defaultClientId={client.id} />
    </div>
  )
}
