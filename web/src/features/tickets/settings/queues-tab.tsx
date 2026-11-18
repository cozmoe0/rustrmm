/* Ticket queues: routing addresses, default priority and assignee. */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Layers, Lock, Mail, Pencil, Plus, Trash2, UserRound } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { ErrorState } from '@/components/common/misc'
import { SectionTitle } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/simple-select'
import { ticketQueuesApi } from '@/lib/api/endpoints'
import { errorMessage, isApiError } from '@/lib/api/errors'
import { ticketKeys, ticketQueuesQuery, usersQuery } from '@/lib/api/queries'
import type { TicketPriority, TicketQueue, TicketQueueInput } from '@/lib/api/types'
import { isEmail } from '@/lib/tickets/csv'
import { PRIORITY_LABEL, PRIORITY_ORDER } from '@/lib/tickets/labels'
import { PriorityGlyph } from '../ticket-ui'

function QueueForm({ queue, onDone }: { queue: TicketQueue | null; onDone: () => void }) {
  const queryClient = useQueryClient()
  const { data: users = [] } = useQuery({ ...usersQuery, meta: { silent: true } })
  const [draft, setDraft] = useState<TicketQueueInput>({
    name: queue?.name ?? '',
    description: queue?.description ?? '',
    default_priority: queue?.default_priority ?? 'normal',
    default_assignee_id: queue?.default_assignee_id ?? null,
    email_address: queue?.email_address ?? '',
  })
  const [attempted, setAttempted] = useState(false)
  const errors = {
    name: !draft.name.trim() ? 'Enter a name' : draft.name.length > 80 ? 'At most 80 characters' : null,
    email: draft.email_address && !isEmail(draft.email_address) ? 'Enter a valid email address' : null,
  }
  const save = useMutation({
    mutationFn: () => {
      const body = { ...draft, name: draft.name.trim(), email_address: draft.email_address?.trim() || null }
      return queue ? ticketQueuesApi.update(queue.id, body) : ticketQueuesApi.create(body)
    },
    meta: { silent: true, successMessage: queue ? 'Queue saved' : 'Queue created' },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ticketKeys.queues })
      onDone()
    },
  })
  const serverError = save.error ? (isApiError(save.error) && save.error.status === 422 ? save.error.message : errorMessage(save.error)) : null
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        setAttempted(true)
        if (errors.name || errors.email) return
        save.mutate()
      }}
    >
      <Field data-invalid={Boolean(attempted && errors.name) || undefined}>
        <FieldLabel htmlFor="q-name">Name</FieldLabel>
        <Input id="q-name" autoFocus value={draft.name} maxLength={80} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        <FieldError>{attempted ? errors.name : null}</FieldError>
      </Field>
      <Field>
        <FieldLabel htmlFor="q-description">Description</FieldLabel>
        <Textarea id="q-description" rows={2} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} className="min-h-14" />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="q-priority">Default priority</FieldLabel>
          <SimpleSelect
            id="q-priority"
            value={draft.default_priority}
            onValueChange={(value) => setDraft({ ...draft, default_priority: value as TicketPriority })}
            options={PRIORITY_ORDER.map((value) => ({ value, label: PRIORITY_LABEL[value], icon: <PriorityGlyph priority={value} /> }))}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="q-assignee">Default assignee</FieldLabel>
          <SimpleSelect
            id="q-assignee"
            value={draft.default_assignee_id ?? ''}
            onValueChange={(value) => setDraft({ ...draft, default_assignee_id: value || null })}
            options={[{ value: '', label: 'Nobody (unassigned)' }, ...users.filter((user) => user.status === 'active').map((user) => ({ value: user.id, label: user.name }))]}
          />
        </Field>
      </div>
      <Field data-invalid={Boolean(attempted && errors.email) || undefined}>
        <FieldLabel htmlFor="q-email">Routing address</FieldLabel>
        <Input id="q-email" type="email" value={draft.email_address ?? ''} placeholder="network@yourmsp.com" onChange={(event) => setDraft({ ...draft, email_address: event.target.value })} />
        <FieldDescription>New email sent to this address opens tickets in this queue.</FieldDescription>
        <FieldError>{attempted ? errors.email : null}</FieldError>
      </Field>
      {serverError && <p className="text-dense text-critical">{serverError}</p>}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending && <Spinner data-icon="inline-start" />}
          {queue ? 'Save queue' : 'Create queue'}
        </Button>
      </DialogFooter>
    </form>
  )
}

export function QueuesTab() {
  const queryClient = useQueryClient()
  const { data: queues, isLoading, error, refetch } = useQuery(ticketQueuesQuery)
  const { data: users = [] } = useQuery({ ...usersQuery, meta: { silent: true } })
  const [editing, setEditing] = useState<TicketQueue | null | 'new'>(null)
  const [deleting, setDeleting] = useState<TicketQueue | null>(null)
  const remove = useMutation({
    mutationFn: (id: string) => ticketQueuesApi.remove(id),
    meta: { successMessage: 'Queue deleted; its tickets moved to Support' },
    onSuccess: () => {
      setDeleting(null)
      void queryClient.invalidateQueries({ queryKey: ticketKeys.all })
      void queryClient.invalidateQueries({ queryKey: ticketKeys.queues })
    },
  })
  return (
    <div className="grid gap-4">
      <SectionTitle
        description="Queues group tickets by team or kind of work. The Support queue is built in and catches everything else."
        actions={
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus data-icon="inline-start" />
            New queue
          </Button>
        }
      >
        Queues
      </SectionTitle>
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isLoading || !queues ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {queues.map((queue) => (
            <li key={queue.id} className="flex flex-col gap-3 rounded-xl bg-card p-4 shadow-card">
              <div className="flex items-start gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-muted-foreground ring-1 ring-border">
                  <Layers className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate font-medium">{queue.name}</span>
                    {queue.builtin && (
                      <Badge variant="secondary">
                        <Lock />
                        Built in
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-micro text-muted-foreground">{queue.description || 'No description'}</p>
                </div>
                <div className="flex shrink-0">
                  <Button size="icon-xs" variant="ghost" aria-label={`Edit ${queue.name}`} onClick={() => setEditing(queue)}>
                    <Pencil />
                  </Button>
                  {!queue.builtin && (
                    <Button size="icon-xs" variant="ghost" aria-label={`Delete ${queue.name}`} className="hover:text-critical" onClick={() => setDeleting(queue)}>
                      <Trash2 />
                    </Button>
                  )}
                </div>
              </div>
              <dl className="mt-auto grid grid-cols-2 gap-2 border-t border-border pt-3 text-micro">
                <div>
                  <dt className="text-subtle-foreground">Open tickets</dt>
                  <dd className="tabular mt-0.5 text-dense font-semibold">{queue.open_tickets}</dd>
                </div>
                <div>
                  <dt className="text-subtle-foreground">Default priority</dt>
                  <dd className="mt-0.5 flex items-center gap-1.5 text-dense">
                    <PriorityGlyph priority={queue.default_priority} />
                    {PRIORITY_LABEL[queue.default_priority]}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-subtle-foreground">Assignee</dt>
                  <dd className="mt-0.5 flex min-w-0 items-center gap-1.5 text-dense">
                    <UserRound className="size-3 shrink-0 text-subtle-foreground" />
                    <span className="truncate">{users.find((user) => user.id === queue.default_assignee_id)?.name ?? 'Unassigned'}</span>
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-subtle-foreground">Routing address</dt>
                  <dd className="mt-0.5 flex min-w-0 items-center gap-1.5 text-dense">
                    <Mail className="size-3 shrink-0 text-subtle-foreground" />
                    <span className="truncate">{queue.email_address || '—'}</span>
                  </dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      )}
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>{editing && editing !== 'new' ? `Edit ${editing.name}` : 'New queue'}</DialogTitle>
            <DialogDescription>Defaults apply to new tickets that don’t set their own priority or assignee.</DialogDescription>
          </DialogHeader>
          {editing !== null && <QueueForm queue={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete the ${deleting?.name ?? ''} queue?`}
        description={`Its ${deleting?.open_tickets ?? 0} open tickets (and all others) move to Support. Rules that used this queue switch to Support too.`}
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </div>
  )
}
