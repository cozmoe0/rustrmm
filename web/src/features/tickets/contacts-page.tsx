/* Contacts per client: search, edit, import from CSV. */
import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { BellOff, BookUser, FileSpreadsheet, Pencil, Plus, Search, Star, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { DataTable } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { EntityAvatar, ErrorState, UserAvatar } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/simple-select'
import { contactsApi } from '@/lib/api/endpoints'
import { clientsQuery, contactsQuery, ticketKeys } from '@/lib/api/queries'
import type { Contact } from '@/lib/api/types'
import { formatNumber } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useScope } from '@/lib/scope'
import { useTitle } from '@/lib/use-title'
import { ContactDialog, ContactImportDialog } from './contact-dialogs'

export function ContactsPage({ search }: { search: { q?: string; import?: boolean } }) {
  useTitle('Contacts')
  const me = useMe()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { clientId, setClient } = useScope()
  const canView = hasPermission(me, PERMISSIONS.ticketsView)
  const canManage = hasPermission(me, PERMISSIONS.ticketsManage)
  const canImport = hasPermission(me, PERMISSIONS.ticketsSettings)
  const [draft, setDraft] = useState(search.q ?? '')
  const [q, setQ] = useState(search.q ?? '')
  const [editing, setEditing] = useState<Contact | null | 'new'>(null)
  const [deleting, setDeleting] = useState<Contact | null>(null)
  const [importing, setImporting] = useState(Boolean(search.import))
  const { data: clients = [] } = useQuery(clientsQuery())
  const { data: contacts = [], isLoading, error, refetch } = useQuery({ ...contactsQuery(clientId, q), enabled: canView })

  useEffect(() => {
    const timer = window.setTimeout(() => setQ(draft.trim()), 200)
    return () => window.clearTimeout(timer)
  }, [draft])

  const remove = useMutation({
    mutationFn: (id: string) => contactsApi.remove(id),
    meta: { successMessage: 'Contact deleted' },
    onSuccess: () => {
      setDeleting(null)
      void queryClient.invalidateQueries({ queryKey: ticketKeys.contacts })
    },
  })

  const columns = useMemo<ColumnDef<Contact>[]>(
    () => [
      {
        id: 'name',
        accessorKey: 'name',
        header: 'Name',
        cell: ({ row }) => (
          <span className="flex min-w-0 items-center gap-2.5">
            <UserAvatar name={row.original.name} size="sm" />
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 truncate font-medium">
                {row.original.name}
                {row.original.is_primary && <Star className="size-3 shrink-0 fill-primary text-primary" aria-label="Primary contact" />}
                {!row.original.notify && <BellOff className="size-3 shrink-0 text-subtle-foreground" aria-label="Notifications off" />}
              </span>
              <span className="block truncate text-micro text-muted-foreground">{row.original.title || '—'}</span>
            </span>
          </span>
        ),
      },
      { id: 'email', accessorKey: 'email', header: 'Email', cell: ({ row }) => <span className="truncate">{row.original.email || '—'}</span> },
      { id: 'phone', accessorKey: 'phone', header: 'Phone', cell: ({ row }) => <span className="tabular whitespace-nowrap">{row.original.phone || '—'}</span> },
      ...(clientId
        ? []
        : [
            {
              id: 'client',
              accessorKey: 'client_name',
              header: 'Client',
              cell: ({ row }: { row: { original: Contact } }) => (
                <span className="flex min-w-0 items-center gap-2">
                  <EntityAvatar name={row.original.client_name} seed={row.original.client_id} size="xs" />
                  <span className="truncate">{row.original.client_name}</span>
                </span>
              ),
            } as ColumnDef<Contact>,
          ]),
      { id: 'site', accessorKey: 'site_name', header: 'Site', cell: ({ row }) => <span className="truncate text-muted-foreground">{row.original.site_name ?? '—'}</span> },
      {
        id: 'actions',
        header: '',
        enableSorting: false,
        cell: ({ row }) =>
          canManage && (
            <span className="flex justify-end gap-0.5" onClick={(event) => event.stopPropagation()}>
              <Button size="icon-xs" variant="ghost" aria-label={`Edit ${row.original.name}`} onClick={() => setEditing(row.original)}>
                <Pencil />
              </Button>
              <Button size="icon-xs" variant="ghost" aria-label={`Delete ${row.original.name}`} className="hover:text-critical" onClick={() => setDeleting(row.original)}>
                <Trash2 />
              </Button>
            </span>
          ),
      },
    ],
    [clientId, canManage],
  )

  if (!canView) {
    return (
      <div className="h-full overflow-y-auto p-6">
        <EmptyState illustration="users" title="You can’t view contacts" description="Ask an administrator for the “View tickets” permission." />
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <PageContainer className="grid gap-5">
        <PageHeader
          icon={<BookUser />}
          title="Contacts"
          description="The people tickets are for. Inbound email from a known contact opens a ticket for their client."
          actions={
            <>
              {canImport && (
                <Button variant="outline" size="sm" onClick={() => setImporting(true)}>
                  <FileSpreadsheet data-icon="inline-start" />
                  Import CSV
                </Button>
              )}
              {canManage && (
                <Button size="sm" onClick={() => setEditing('new')}>
                  <Plus data-icon="inline-start" />
                  New contact
                </Button>
              )}
            </>
          }
        />
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <SimpleSelect
            ariaLabel="Client"
            className="sm:w-64"
            value={clientId ?? ''}
            onValueChange={(value) => setClient(value || null)}
            options={[{ value: '', label: 'All clients' }, ...clients.map((client) => ({ value: client.id, label: client.name }))]}
          />
          <div className="relative min-w-0 flex-1 sm:max-w-sm">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle-foreground" />
            <Input data-filter-input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Search name, email or phone…" aria-label="Search contacts" className="pl-8" />
          </div>
          <span className="text-micro text-subtle-foreground tabular sm:ml-auto">{formatNumber(contacts.length)} contacts</span>
        </div>
        {error ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : !isLoading && contacts.length === 0 ? (
          <EmptyState
            illustration={q ? 'search' : 'users'}
            title={q ? 'No contacts match' : 'No contacts yet'}
            description={q ? `Nothing matches “${q}”.` : 'Add contacts one by one or import a CSV from your PSA or address book.'}
            actions={
              !q &&
              canManage && (
                <Button size="sm" onClick={() => setEditing('new')}>
                  <Plus data-icon="inline-start" />
                  New contact
                </Button>
              )
            }
          />
        ) : (
          <DataTable
            data={contacts}
            columns={columns}
            loading={isLoading}
            getRowId={(row) => row.id}
            onRowClick={(row) => void navigate({ to: '/tickets/contacts/$contactId', params: { contactId: row.id } })}
            initialSorting={[{ id: 'name', desc: false }]}
          />
        )}
      </PageContainer>
      <ContactDialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)} contact={editing === 'new' ? null : editing} defaultClientId={clientId} />
      <ContactImportDialog
        open={importing}
        onOpenChange={(open) => {
          setImporting(open)
          if (!open && search.import) void navigate({ to: '/tickets/contacts', search: (prev) => ({ ...prev, import: undefined }), replace: true })
        }}
        defaultClientId={clientId}
      />
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? 'contact'}?`}
        description="Their tickets stay, without a contact. Email from their address will no longer match this client."
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </div>
  )
}
