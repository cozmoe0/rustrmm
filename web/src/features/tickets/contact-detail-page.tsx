/* A contact and their tickets. */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowLeft, BellOff, Building, Mail, MapPin, Pencil, Phone, Star, TicketPlus, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, UserAvatar } from '@/components/common/misc'
import { PageContainer, SectionTitle } from '@/components/common/page-header'
import { contactsApi, ticketsApi } from '@/lib/api/endpoints'
import { isApiError } from '@/lib/api/errors'
import { contactQuery, ticketKeys } from '@/lib/api/queries'
import type { Contact } from '@/lib/api/types'
import { isActiveStatus } from '@/lib/tickets/labels'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { ContactDialog } from './contact-dialogs'
import { openNewTicket } from './ticket-stores'
import { TicketTable } from './ticket-table'

/** Every ticket of this contact, in any status (`GET /tickets?contact_id=`). */
function useContactTickets(contact: Contact | undefined) {
  return useQuery({
    queryKey: [...ticketKeys.lists, { purpose: 'contact', contact: contact?.id }],
    queryFn: async () => (await ticketsApi.list({ contact_id: contact!.id, client_id: contact!.client_id, status: 'all', limit: 200 })).items,
    enabled: Boolean(contact),
  })
}

export function ContactDetailPage({ contactId }: { contactId: string }) {
  const me = useMe()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const canManage = hasPermission(me, PERMISSIONS.ticketsManage)
  const { data: contact, isLoading, error, refetch } = useQuery(contactQuery(contactId))
  const tickets = useContactTickets(contact)
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  useTitle(contact?.name ?? 'Contact')
  const remove = useMutation({
    mutationFn: () => contactsApi.remove(contactId),
    meta: { successMessage: 'Contact deleted' },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ticketKeys.contacts })
      void navigate({ to: '/tickets/contacts' })
    },
  })

  if (error) {
    return (
      <PageContainer>
        <ErrorState error={error} title={isApiError(error) && error.status === 404 ? 'Contact not found' : 'Could not load this contact'} onRetry={() => void refetch()} />
      </PageContainer>
    )
  }
  if (isLoading || !contact) {
    return (
      <PageContainer className="grid gap-4">
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </PageContainer>
    )
  }
  const items = tickets.data ?? []
  const open = items.filter((ticket) => isActiveStatus(ticket.status))
  const closed = items.filter((ticket) => !isActiveStatus(ticket.status))

  return (
    <div className="h-full overflow-y-auto">
      <PageContainer className="grid gap-6">
        <Link to="/tickets/contacts" className="inline-flex w-fit items-center gap-1 text-dense text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" />
          Contacts
        </Link>
        <header className="flex flex-col gap-4 rounded-2xl bg-card p-5 shadow-card sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <UserAvatar name={contact.name} className="size-14 text-base" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="font-display truncate text-2xl font-semibold tracking-tight">{contact.name}</h1>
                {contact.is_primary && (
                  <Badge variant="default">
                    <Star className="fill-current" />
                    Primary
                  </Badge>
                )}
                {!contact.notify && (
                  <Badge variant="outline">
                    <BellOff />
                    No emails
                  </Badge>
                )}
              </div>
              {contact.title && <p className="mt-0.5 text-dense text-muted-foreground">{contact.title}</p>}
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-dense">
                <Link to="/clients/$clientId" params={{ clientId: contact.client_id }} className="inline-flex items-center gap-1.5 hover:underline">
                  <Building className="size-3.5 text-subtle-foreground" />
                  {contact.client_name}
                </Link>
                {contact.site_name && (
                  <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                    <MapPin className="size-3.5 text-subtle-foreground" />
                    {contact.site_name}
                  </span>
                )}
                {contact.email && (
                  <a href={`mailto:${contact.email}`} className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground hover:text-foreground">
                    <Mail className="size-3.5 shrink-0 text-subtle-foreground" />
                    <span className="truncate">{contact.email}</span>
                  </a>
                )}
                {contact.phone && (
                  <a href={`tel:${contact.phone.replace(/\s+/g, '')}`} className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground">
                    <Phone className="size-3.5 text-subtle-foreground" />
                    {contact.phone}
                  </a>
                )}
              </div>
              {contact.notes && <p className="mt-3 max-w-2xl text-dense whitespace-pre-wrap text-secondary-foreground">{contact.notes}</p>}
            </div>
          </div>
          {canManage && (
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button size="sm" onClick={() => openNewTicket({ client_id: contact.client_id, site_id: contact.site_id, contact_id: contact.id })}>
                <TicketPlus data-icon="inline-start" />
                New ticket
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                <Pencil data-icon="inline-start" />
                Edit
              </Button>
              <Button size="icon-sm" variant="ghost" aria-label="Delete contact" className="hover:text-critical" onClick={() => setDeleting(true)}>
                <Trash2 />
              </Button>
            </div>
          )}
        </header>

        <section className="grid gap-3">
          <SectionTitle description="Tickets where this person is the contact.">Open tickets · {open.length}</SectionTitle>
          {tickets.isLoading ? (
            <Skeleton className="h-32 rounded-xl" />
          ) : open.length === 0 ? (
            <EmptyState compact illustration="tickets" title="No open tickets" description={`${contact.name.split(' ')[0]} has nothing waiting right now.`} />
          ) : (
            <TicketTable tickets={open} hideClient />
          )}
        </section>
        {closed.length > 0 && (
          <section className="grid gap-3">
            <SectionTitle>History · {closed.length}</SectionTitle>
            <TicketTable tickets={closed} hideClient />
          </section>
        )}
      </PageContainer>
      <ContactDialog open={editing} onOpenChange={setEditing} contact={contact} />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${contact.name}?`}
        description="Their tickets stay, without a contact."
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  )
}
