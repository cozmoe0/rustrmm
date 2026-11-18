/* Canned responses: shared (helpdesk settings) or private, with placeholders previewed on sample data. */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Braces, Lock, Mail, Pencil, Plus, Search, Trash2, Users } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/misc'
import { SectionTitle } from '@/components/common/page-header'
import { cannedResponsesApi } from '@/lib/api/endpoints'
import { errorMessage } from '@/lib/api/errors'
import { cannedResponsesQuery, ticketKeys, usersQuery } from '@/lib/api/queries'
import type { CannedResponse, CannedResponseInput } from '@/lib/api/types'
import { markdownExcerpt } from '@/lib/tickets/markdown'
import { PLACEHOLDERS, renderPlaceholders, SAMPLE_CONTEXT, usedPlaceholders } from '@/lib/tickets/placeholders'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { cn } from '@/lib/utils'
import { MarkdownEditor } from '../markdown'

function CannedForm({ item, onDone }: { item: CannedResponse | null; onDone: () => void }) {
  const me = useMe()
  const queryClient = useQueryClient()
  const canShare = hasPermission(me, PERMISSIONS.ticketsSettings) && Boolean(me?.scopes.global)
  const [draft, setDraft] = useState<CannedResponseInput>({ name: item?.name ?? '', body: item?.body ?? '', visibility: item?.visibility ?? 'public', shared: item?.shared ?? canShare })
  const [attempted, setAttempted] = useState(false)
  const errors = { name: draft.name.trim() ? null : 'Enter a name', body: draft.body.trim() ? null : 'Write the response' }
  const save = useMutation({
    mutationFn: () => (item ? cannedResponsesApi.update(item.id, { ...draft, name: draft.name.trim() }) : cannedResponsesApi.create({ ...draft, name: draft.name.trim() })),
    meta: { silent: true, successMessage: 'Canned response saved' },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ticketKeys.canned })
      onDone()
    },
  })
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        setAttempted(true)
        if (errors.name || errors.body) return
        save.mutate()
      }}
    >
      <Field data-invalid={Boolean(attempted && errors.name) || undefined}>
        <FieldLabel htmlFor="cr-name">Name</FieldLabel>
        <Input id="cr-name" autoFocus value={draft.name} maxLength={120} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Acknowledge — looking into it" />
        <FieldError>{attempted ? errors.name : null}</FieldError>
      </Field>
      <Field data-invalid={Boolean(attempted && errors.body) || undefined}>
        <FieldLabel htmlFor="cr-body">Response</FieldLabel>
        <MarkdownEditor
          id="cr-body"
          value={draft.body}
          onChange={(body) => setDraft({ ...draft, body })}
          maxLength={20_000}
          tone={draft.visibility === 'internal' ? 'internal' : 'default'}
          previewTransform={(value) => renderPlaceholders(value, SAMPLE_CONTEXT)}
          textareaClassName="min-h-40"
          toolbar={
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button type="button" size="xs" variant="ghost" aria-label="Insert a placeholder" />}>
                <Braces data-icon="inline-start" />
                <span className="max-sm:sr-only">Placeholder</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Insert placeholder</DropdownMenuLabel>
                  {PLACEHOLDERS.map((placeholder) => (
                    <DropdownMenuItem key={placeholder.key} onClick={() => setDraft((prev) => ({ ...prev, body: `${prev.body}{{${placeholder.key}}}` }))}>
                      <span className="min-w-0 flex-1 truncate">{placeholder.label}</span>
                      <code className="font-mono text-[10.5px] text-subtle-foreground">{placeholder.key}</code>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          }
        />
        <FieldDescription>Placeholders fill in when the response is inserted into a ticket; the preview uses sample values.</FieldDescription>
        <FieldError>{attempted ? errors.body : null}</FieldError>
      </Field>
      <div className="grid gap-2 rounded-lg bg-surface-2 p-3 ring-1 ring-border">
        <label className="flex items-center justify-between gap-3 text-dense">
          <span>
            <span className="font-medium">Internal note</span>
            <span className="block text-micro text-muted-foreground">Inserting it switches the composer to an internal note.</span>
          </span>
          <Switch checked={draft.visibility === 'internal'} onCheckedChange={(value) => setDraft({ ...draft, visibility: value ? 'internal' : 'public' })} />
        </label>
        <label className={cn('flex items-center justify-between gap-3 text-dense', !canShare && 'opacity-60')}>
          <span>
            <span className="font-medium">Shared with the team</span>
            <span className="block text-micro text-muted-foreground">{canShare ? 'Everyone who works tickets can use it.' : 'Sharing needs the global “Helpdesk settings” permission.'}</span>
          </span>
          <Switch checked={draft.shared} disabled={!canShare} onCheckedChange={(value) => setDraft({ ...draft, shared: value })} />
        </label>
      </div>
      {save.error && <p className="text-dense text-critical">{errorMessage(save.error)}</p>}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending && <Spinner data-icon="inline-start" />}
          {item ? 'Save response' : 'Create response'}
        </Button>
      </DialogFooter>
    </form>
  )
}

export function CannedTab() {
  const me = useMe()
  const queryClient = useQueryClient()
  const canShare = hasPermission(me, PERMISSIONS.ticketsSettings) && Boolean(me?.scopes.global)
  const { data: canned, isLoading, error, refetch } = useQuery(cannedResponsesQuery)
  const { data: users = [] } = useQuery({ ...usersQuery, enabled: hasPermission(me, PERMISSIONS.usersView), meta: { silent: true } })
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<CannedResponse | null | 'new'>(null)
  const [deleting, setDeleting] = useState<CannedResponse | null>(null)
  const remove = useMutation({
    mutationFn: (id: string) => cannedResponsesApi.remove(id),
    meta: { successMessage: 'Canned response deleted' },
    onSuccess: () => {
      setDeleting(null)
      void queryClient.invalidateQueries({ queryKey: ticketKeys.canned })
    },
  })
  const needle = query.trim().toLowerCase()
  const visible = (canned ?? []).filter((item) => !needle || item.name.toLowerCase().includes(needle) || item.body.toLowerCase().includes(needle))
  const editable = (item: CannedResponse) => (item.shared ? canShare : item.owner_id === me?.user.id)
  return (
    <div className="grid gap-4">
      <SectionTitle
        description="Reusable replies and notes. Shared responses are for everyone; private ones are yours alone."
        actions={
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus data-icon="inline-start" />
            New response
          </Button>
        }
      >
        Canned responses
      </SectionTitle>
      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle-foreground" />
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search responses…" aria-label="Search canned responses" className="pl-8" />
      </div>
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isLoading ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : visible.length === 0 ? (
        <EmptyState compact illustration="tickets" title={needle ? 'No responses match' : 'No canned responses yet'} description="Save the replies you type most often." />
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {visible.map((item) => (
            <li key={item.id} className="flex flex-col gap-2 rounded-xl bg-card p-4 shadow-card">
              <div className="flex items-start gap-2">
                <span className={cn('mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg ring-1', item.visibility === 'internal' ? 'bg-warning/12 text-warning ring-warning/30' : 'bg-surface-3 text-muted-foreground ring-border')}>
                  {item.visibility === 'internal' ? <Lock className="size-3.5" /> : <Mail className="size-3.5" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{item.name}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                    {item.shared ? (
                      <Badge variant="secondary">
                        <Users />
                        Shared
                      </Badge>
                    ) : (
                      <Badge variant="outline">Private</Badge>
                    )}
                    {item.visibility === 'internal' && <Badge variant="warning">Internal</Badge>}
                    {!item.shared && item.owner_id !== me?.user.id && <span className="text-micro text-subtle-foreground">by {users.find((user) => user.id === item.owner_id)?.name ?? 'someone'}</span>}
                  </div>
                </div>
                {editable(item) && (
                  <div className="flex shrink-0">
                    <Button size="icon-xs" variant="ghost" aria-label={`Edit ${item.name}`} onClick={() => setEditing(item)}>
                      <Pencil />
                    </Button>
                    <Button size="icon-xs" variant="ghost" aria-label={`Delete ${item.name}`} className="hover:text-critical" onClick={() => setDeleting(item)}>
                      <Trash2 />
                    </Button>
                  </div>
                )}
              </div>
              <p className="line-clamp-3 text-dense text-muted-foreground">{markdownExcerpt(item.body, 240)}</p>
              {usedPlaceholders(item.body).length > 0 && (
                <div className="mt-auto flex flex-wrap gap-1">
                  {usedPlaceholders(item.body).map((key) => (
                    <code key={key} className="rounded-sm bg-surface-3 px-1.5 py-px font-mono text-[10.5px] text-secondary-foreground">{`{{${key}}}`}</code>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="sm:max-w-[680px]">
          <DialogHeader>
            <DialogTitle>{editing && editing !== 'new' ? `Edit ${editing.name}` : 'New canned response'}</DialogTitle>
            <DialogDescription>Markdown with placeholders such as {'{{contact.first_name}}'} and {'{{ticket.number}}'}.</DialogDescription>
          </DialogHeader>
          {editing !== null && <CannedForm item={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete “${deleting?.name ?? ''}”?`}
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </div>
  )
}
