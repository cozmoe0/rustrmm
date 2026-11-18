/* The ticket view used by the queue's detail pane and the full ticket page. */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  ArrowLeft,
  Building,
  ChevronDown,
  Copy,
  Ellipsis,
  GitMerge,
  History,
  Layers,
  Maximize2,
  MessagesSquare,
  Pencil,
  Timer,
  Trash2,
  UserRound,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { ErrorState, RelativeTime, UserAvatar } from '@/components/common/misc'
import { ticketsApi } from '@/lib/api/endpoints'
import { errorMessage, isApiError } from '@/lib/api/errors'
import { ticketDetailQuery, ticketKeys } from '@/lib/api/queries'
import type { Ticket, TicketActivity, TicketComment } from '@/lib/api/types'
import { copyText } from '@/lib/clipboard'
import { PRIORITY_LABEL, ticketNumber, TYPE_LABEL } from '@/lib/tickets/labels'
import { formatMinutes, headlineClock } from '@/lib/tickets/sla'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { openWorkspaceTab } from '@/lib/workspace'
import { cn } from '@/lib/utils'
import { MarkdownEditor } from './markdown'
import { AssigneeMenu, PriorityMenu, QueueMenu, StatusMenu, TypeMenu } from './ticket-controls'
import { TicketComposer } from './ticket-composer'
import { selectedTicketStore, openLogTime } from './ticket-stores'
import {
  ContactSection,
  LinkedAlerts,
  LinkedDevices,
  LinkedTickets,
  SlaPanel,
  TagsSection,
  TicketFinder,
  TicketProperties,
} from './ticket-sidebar'
import { ActivityLine, ConversationThread } from './ticket-thread'
import { TicketTimePanel, TimerControl } from './ticket-time'
import { PriorityGlyph, SlaClockChip, SourceIcon, TicketStatusBadge } from './ticket-ui'
import { STATUS_STYLE, TYPE_ICON } from './ticket-styles'
import { refreshTickets, useTicketActions, type TicketActions } from './use-ticket-actions'
import { useNow } from './use-now'

function SubjectEditor({ ticket, actions }: { ticket: Ticket; actions: TicketActions }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(ticket.subject)
  const canEdit = actions.canManage && !ticket.merged_into
  const save = () => {
    const next = value.trim().replace(/\s+/g, ' ')
    setEditing(false)
    if (next && next !== ticket.subject && next.length <= 200) actions.update(ticket, { subject: next })
    else setValue(ticket.subject)
  }
  if (editing) {
    return (
      <Input
        autoFocus
        value={value}
        maxLength={200}
        aria-label="Subject"
        onChange={(event) => setValue(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === 'Enter') save()
          if (event.key === 'Escape') {
            setValue(ticket.subject)
            setEditing(false)
          }
        }}
        className="font-display h-auto py-1 text-[19px] font-semibold tracking-tight"
      />
    )
  }
  return (
    <h2 className="font-display group text-[19px] leading-snug font-semibold tracking-tight break-words">
      {canEdit ? (
        <button
          type="button"
          onClick={() => {
            setValue(ticket.subject)
            setEditing(true)
          }}
          className="rounded-md text-left outline-none hover:bg-surface-3/70 focus-visible:ring-2 focus-visible:ring-ring"
          title="Edit subject"
        >
          {ticket.subject}
          <Pencil className="ml-1.5 inline size-3.5 align-baseline text-subtle-foreground opacity-0 group-hover:opacity-100" />
        </button>
      ) : (
        ticket.subject
      )}
    </h2>
  )
}

function ControlButton({ children, label, disabled, ...props }: { children: ReactNode; label: string; disabled?: boolean } & React.ComponentProps<typeof Button>) {
  return (
    <Button size="sm" variant="outline" disabled={disabled} aria-label={label} className="h-7 max-w-full gap-1.5 px-2 font-normal" {...props}>
      {children}
      <ChevronDown data-icon="inline-end" className="text-subtle-foreground" />
    </Button>
  )
}

function TicketControls({ ticket, actions }: { ticket: Ticket; actions: TicketActions }) {
  const disabled = !actions.canManage || Boolean(ticket.merged_into)
  const TypeIcon = TYPE_ICON[ticket.type]
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <StatusMenu
        value={ticket.status}
        onChange={(status) => actions.update(ticket, { status })}
        trigger={
          <ControlButton label="Status" disabled={disabled}>
            <span className={cn('size-2 rounded-full', STATUS_STYLE[ticket.status].dot)} />
            <TicketStatusBadge status={ticket.status} className="h-auto bg-transparent p-0 ring-0" />
          </ControlButton>
        }
      />
      <PriorityMenu
        value={ticket.priority}
        onChange={(priority) => actions.update(ticket, { priority })}
        trigger={
          <ControlButton label="Priority" disabled={disabled}>
            <PriorityGlyph priority={ticket.priority} />
            {PRIORITY_LABEL[ticket.priority]}
          </ControlButton>
        }
      />
      <AssigneeMenu
        users={actions.users}
        meId={actions.meId}
        value={ticket.assignee?.id ?? null}
        onChange={(id) => actions.update(ticket, { assignee_id: id })}
        trigger={
          <ControlButton label="Assignee" disabled={disabled}>
            {ticket.assignee ? <UserAvatar name={ticket.assignee.name} size="xs" className="size-4 text-[8px]" /> : <UserRound className="text-subtle-foreground" />}
            <span className="max-w-32 truncate">{ticket.assignee ? (ticket.assignee.id === actions.meId ? 'Me' : ticket.assignee.name) : 'Unassigned'}</span>
          </ControlButton>
        }
      />
      <QueueMenu
        queues={actions.queues}
        value={ticket.queue.id}
        onChange={(id) => actions.update(ticket, { queue_id: id })}
        trigger={
          <ControlButton label="Queue" disabled={disabled}>
            <Layers className="text-subtle-foreground" />
            <span className="max-w-36 truncate">{ticket.queue.name}</span>
          </ControlButton>
        }
      />
      <TypeMenu
        value={ticket.type}
        onChange={(type) => actions.update(ticket, { type })}
        trigger={
          <ControlButton label="Type" disabled={disabled}>
            <TypeIcon className="text-subtle-foreground" />
            {TYPE_LABEL[ticket.type]}
          </ControlButton>
        }
      />
    </div>
  )
}

function DescriptionDialog({ ticket, open, onOpenChange, actions }: { ticket: Ticket; open: boolean; onOpenChange: (open: boolean) => void; actions: TicketActions }) {
  const [value, setValue] = useState(ticket.description)
  const [saving, setSaving] = useState(false)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle>Edit description</DialogTitle>
          <DialogDescription>Changes are recorded in the ticket’s activity.</DialogDescription>
        </DialogHeader>
        <MarkdownEditor value={value} onChange={setValue} maxLength={100_000} textareaClassName="min-h-56" ariaLabel="Description" />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={saving || value === ticket.description}
            onClick={async () => {
              setSaving(true)
              try {
                await actions.updateAsync(ticket, { description: value })
                onOpenChange(false)
              } finally {
                setSaving(false)
              }
            }}
          >
            {saving && <Spinner data-icon="inline-start" />}
            Save description
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function MergeDialog({ ticket, open, onOpenChange }: { ticket: Ticket; open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [target, setTarget] = useState<Ticket | null>(null)
  const merge = useMutation({
    mutationFn: () => ticketsApi.merge(ticket.id, target!.id),
    meta: { silent: true },
    onSuccess: ({ ticket: survivor }) => {
      refreshTickets(queryClient, [ticket.id, survivor.id])
      void queryClient.invalidateQueries({ queryKey: ticketKeys.time })
      toast.success(`Merged ${ticketNumber(ticket.number)} into ${ticketNumber(survivor.number)}`)
      onOpenChange(false)
      void navigate({ to: '/tickets/$ticketId', params: { ticketId: survivor.id } })
    },
    onError: (error) => toast.error(isApiError(error) && error.code === 'already_merged' ? 'One of these tickets was already merged.' : errorMessage(error)),
  })
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) setTarget(null)
      }}
    >
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitMerge className="size-4 text-primary" />
            Merge {ticketNumber(ticket.number)} into another ticket
          </DialogTitle>
          <DialogDescription>Only tickets of {ticket.client_name} can be targets. Comments, attachments, time entries and links move over, and this ticket is closed.</DialogDescription>
        </DialogHeader>
        {target ? (
          <div className="grid gap-3">
            <div className="grid gap-2 rounded-lg bg-surface-2 p-3 text-dense ring-1 ring-border">
              <div className="flex items-center gap-2">
                <span className="tabular font-mono text-micro text-muted-foreground">{ticketNumber(ticket.number)}</span>
                <span className="min-w-0 flex-1 truncate line-through decoration-subtle-foreground">{ticket.subject}</span>
              </div>
              <GitMerge className="ml-1 size-3.5 rotate-180 text-subtle-foreground" />
              <div className="flex items-center gap-2">
                <span className="tabular font-mono text-micro text-primary">{ticketNumber(target.number)}</span>
                <span className="min-w-0 flex-1 truncate font-medium">{target.subject}</span>
                <TicketStatusBadge status={target.status} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setTarget(null)}>
                Back
              </Button>
              <Button onClick={() => merge.mutate()} disabled={merge.isPending}>
                {merge.isPending ? <Spinner data-icon="inline-start" /> : <GitMerge data-icon="inline-start" />}
                Merge tickets
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <TicketFinder clientId={ticket.client_id} exclude={[ticket.id]} onPick={setTarget} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function DetailSkeleton() {
  return (
    <div className="grid gap-4 p-4 sm:p-6">
      <Skeleton className="h-6 w-40 rounded-md" />
      <Skeleton className="h-8 w-3/4 rounded-lg" />
      <Skeleton className="h-7 w-full max-w-lg rounded-lg" />
      <Skeleton className="h-40 rounded-xl" />
      <Skeleton className="h-28 rounded-xl" />
    </div>
  )
}

function Sidebar({ ticket, actions }: { ticket: Ticket; actions: TicketActions }) {
  const canEdit = actions.canManage && !ticket.merged_into
  return (
    <div className="grid min-w-0 content-start gap-5 [&>*]:min-w-0">
      <SlaPanel ticket={ticket} />
      <ContactSection ticket={ticket} actions={actions} />
      <LinkedDevices ticket={ticket} canEdit={canEdit} />
      <LinkedAlerts ticket={ticket} canEdit={canEdit} />
      <LinkedTickets ticket={ticket} canEdit={canEdit} />
      <TagsSection ticket={ticket} actions={actions} />
      <TicketProperties ticket={ticket} actions={actions} />
    </div>
  )
}

function CompactSummary({ ticket }: { ticket: Ticket }) {
  const now = useNow(15_000)
  const clock = headlineClock(ticket, now)
  return (
    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-micro text-muted-foreground">
      {clock && <SlaClockChip clock={clock} prefix />}
      <span className="truncate">{ticket.contact?.name ?? 'No contact'}</span>
      <span>· {ticket.devices.length} devices</span>
      {ticket.tags.length > 0 && <span className="truncate">· {ticket.tags.join(', ')}</span>}
    </span>
  )
}

export function TicketView({
  ticketId,
  variant,
  onBack,
  composerRef,
}: {
  ticketId: string
  variant: 'pane' | 'page'
  onBack?: () => void
  composerRef?: RefObject<HTMLTextAreaElement | null>
}) {
  const me = useMe()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const actions = useTicketActions()
  const { data, isLoading, error, refetch } = useQuery(ticketDetailQuery(ticketId))
  const [tab, setTab] = useState<'conversation' | 'activity' | 'time'>('conversation')
  const [showActivity, setShowActivity] = useState(true)
  const [editingDescription, setEditingDescription] = useState(false)
  const [merging, setMerging] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const ownComposer = useRef<HTMLTextAreaElement | null>(null)
  const composer = composerRef ?? ownComposer
  const ticket = data?.ticket

  useEffect(() => {
    if (ticket) selectedTicketStore.set(ticket)
  }, [ticket])
  useEffect(() => () => selectedTicketStore.set(null), [])

  useEffect(() => {
    if (variant === 'page' && ticket) {
      openWorkspaceTab({ id: `ticket:${ticket.id}`, kind: 'ticket', title: `${ticketNumber(ticket.number)} ${ticket.subject}`, to: '/tickets/$ticketId', params: { ticketId: ticket.id } })
    }
  }, [variant, ticket])

  // On the full page, "r" jumps to the reply box.
  useEffect(() => {
    if (variant !== 'page') return
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
      if (document.querySelector('[role="dialog"], [role="menu"]')) return
      if (event.key === 'r') {
        event.preventDefault()
        setTab('conversation')
        requestAnimationFrame(() => composer.current?.focus())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [variant, composer])

  const remove = useMutation({
    mutationFn: () => ticketsApi.remove(ticketId),
    meta: { successMessage: 'Ticket deleted' },
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ticketKeys.detail(ticketId) })
      refreshTickets(queryClient)
      setDeleting(false)
      if (variant === 'page') void navigate({ to: '/tickets' })
      else onBack?.()
    },
  })

  if (error) {
    return (
      <div className="p-4 sm:p-6">
        {onBack && (
          <Button variant="ghost" size="sm" className="mb-3 lg:hidden" onClick={onBack}>
            <ArrowLeft data-icon="inline-start" />
            Tickets
          </Button>
        )}
        <ErrorState error={error} title={isApiError(error) && error.status === 404 ? 'This ticket no longer exists' : 'Could not load this ticket'} onRetry={() => void refetch()} />
      </div>
    )
  }
  if (isLoading || !data || !ticket) return <DetailSkeleton />

  const comments: TicketComment[] = data.comments
  const activity: TicketActivity[] = data.activity
  const canSettings = hasPermission(me, PERMISSIONS.ticketsSettings)

  return (
    <div className="@container flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <header className="relative border-b border-border">
          <div className={cn('pointer-events-none absolute inset-y-0 left-0 w-[3px]', ticket.priority === 'urgent' ? 'bg-critical' : ticket.priority === 'high' ? 'bg-warning' : 'bg-transparent')} aria-hidden="true" />
          <div className={cn('grid gap-3 px-4 pt-4 pb-4 sm:px-6', variant === 'page' && 'mx-auto w-full max-w-[1440px] sm:pt-5')}>
            <div className="flex min-w-0 items-center gap-2">
              {onBack && (
                <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-dense text-muted-foreground hover:text-foreground lg:hidden">
                  <ArrowLeft className="size-3.5" />
                  <span className="sr-only">Back to tickets</span>
                </button>
              )}
              {variant === 'page' && (
                <Link to="/tickets" className="inline-flex items-center gap-1 text-dense text-muted-foreground hover:text-foreground">
                  <ArrowLeft className="size-3.5" />
                  Tickets
                </Link>
              )}
              <button
                type="button"
                title="Copy ticket number"
                onClick={async () => {
                  if (await copyText(ticketNumber(ticket.number))) toast.success(`${ticketNumber(ticket.number)} copied`)
                }}
                className="tabular rounded-md bg-surface-3 px-1.5 py-0.5 font-mono text-[11.5px] font-medium text-secondary-foreground ring-1 ring-border hover:bg-surface-4"
              >
                {ticketNumber(ticket.number)}
              </button>
              <SourceIcon source={ticket.source} />
              <span className="hidden truncate text-micro text-subtle-foreground sm:inline">
                Opened <RelativeTime value={ticket.created_at} /> by {ticket.created_by_name}
              </span>
              <div className="ml-auto flex shrink-0 items-center gap-1">
                <TimerControl ticket={ticket} compact />
                {variant === 'pane' && (
                  <Button size="icon-sm" variant="ghost" aria-label="Open the full ticket page" title="Open full page (Enter)" render={<Link to="/tickets/$ticketId" params={{ ticketId: ticket.id }} />} nativeButton={false}>
                    <Maximize2 />
                  </Button>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="More ticket actions" />}>
                    <Ellipsis />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuItem
                      onClick={async () => {
                        if (await copyText(`${window.location.origin}/tickets/${ticket.id}`)) toast.success('Link copied')
                      }}
                    >
                      <Copy />
                      Copy link to ticket
                    </DropdownMenuItem>
                    {hasPermission(me, PERMISSIONS.ticketsTime) && (
                      <DropdownMenuItem onClick={() => openLogTime(ticket.id)}>
                        <Timer />
                        Log time…
                      </DropdownMenuItem>
                    )}
                    {actions.canManage && !ticket.merged_into && (
                      <>
                        <DropdownMenuItem onClick={() => setEditingDescription(true)}>
                          <Pencil />
                          Edit description
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setMerging(true)}>
                          <GitMerge />
                          Merge into another ticket…
                        </DropdownMenuItem>
                      </>
                    )}
                    <DropdownMenuItem render={<Link to="/clients/$clientId" params={{ clientId: ticket.client_id }} />}>
                      <Building />
                      Open {ticket.client_name}
                    </DropdownMenuItem>
                    {canSettings && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}>
                          <Trash2 />
                          Delete ticket…
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            <SubjectEditor key={ticket.subject} ticket={ticket} actions={actions} />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-dense text-muted-foreground">
              <Link to="/clients/$clientId" params={{ clientId: ticket.client_id }} className="inline-flex min-w-0 items-center gap-1.5 font-medium text-secondary-foreground hover:underline">
                <Building className="size-3.5 shrink-0 text-subtle-foreground" />
                <span className="truncate">{ticket.client_name}</span>
              </Link>
              {ticket.site_name && <span className="truncate">{ticket.site_name}</span>}
              {ticket.contact && (
                <Link to="/tickets/contacts/$contactId" params={{ contactId: ticket.contact.id }} className="inline-flex min-w-0 items-center gap-1.5 hover:text-foreground hover:underline">
                  <UserRound className="size-3.5 shrink-0 text-subtle-foreground" />
                  <span className="truncate">{ticket.contact.name}</span>
                </Link>
              )}
            </div>
            <TicketControls ticket={ticket} actions={actions} />
            {ticket.merged_into && (
              <p className="flex items-center gap-2 rounded-lg bg-surface-3 px-3 py-2 text-dense text-muted-foreground ring-1 ring-border">
                <GitMerge className="size-4 shrink-0" />
                Merged into
                <Link to="/tickets/$ticketId" params={{ ticketId: ticket.merged_into.id }} className="font-medium text-primary hover:underline">
                  {ticketNumber(ticket.merged_into.number)}
                </Link>
                ; this ticket is closed.
              </p>
            )}
          </div>
        </header>

        <div className={cn('grid gap-6 px-4 py-4 sm:px-6 sm:py-5 @4xl:grid-cols-[minmax(0,1fr)_minmax(280px,320px)]', variant === 'page' && 'mx-auto w-full max-w-[1440px]')}>
          <div className="min-w-0">
            <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen} className="mb-4 rounded-xl bg-card shadow-card @4xl:hidden">
              <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="eyebrow shrink-0">Details</span>
                <CompactSummary ticket={ticket} />
                <ChevronDown className={cn('size-4 shrink-0 text-subtle-foreground transition-transform', detailsOpen && 'rotate-180')} />
              </CollapsibleTrigger>
              <CollapsibleContent className="border-t border-border p-3">
                <Sidebar ticket={ticket} actions={actions} />
              </CollapsibleContent>
            </Collapsible>

            <Tabs value={tab} onValueChange={(value) => setTab(value as typeof tab)} className="gap-4">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border">
                <TabsList variant="line" className="-mb-px h-9 gap-4">
                  <TabsTrigger value="conversation" className="gap-1.5 px-0">
                    <MessagesSquare className="size-3.5" />
                    Conversation <span className="tabular text-micro text-subtle-foreground">{comments.length + 1}</span>
                  </TabsTrigger>
                  <TabsTrigger value="activity" className="gap-1.5 px-0">
                    <History className="size-3.5" />
                    Activity <span className="tabular text-micro text-subtle-foreground">{activity.length}</span>
                  </TabsTrigger>
                  <TabsTrigger value="time" className="gap-1.5 px-0">
                    <Timer className="size-3.5" />
                    Time <span className="tabular text-micro text-subtle-foreground">{formatMinutes(ticket.time_spent_minutes)}</span>
                  </TabsTrigger>
                </TabsList>
                {tab === 'conversation' && (
                  <label className="mb-1 inline-flex items-center gap-2 text-micro text-muted-foreground">
                    <Switch checked={showActivity} onCheckedChange={setShowActivity} aria-label="Show activity in the conversation" />
                    Show activity
                  </label>
                )}
              </div>
              <TabsContent value="conversation" className="grid gap-5">
                <ConversationThread ticket={ticket} comments={comments} activity={activity} showActivity={showActivity} meId={me?.user.id} />
                {!ticket.merged_into && <TicketComposer key={ticket.id} ticket={ticket} textareaRef={composer} />}
              </TabsContent>
              <TabsContent value="activity">
                <ol className="relative">
                  <span className="absolute top-3 bottom-3 left-4 w-px bg-border" aria-hidden="true" />
                  {[...activity].reverse().map((item, index) => (
                    <ActivityLine key={`${item.at}-${index}`} item={item} />
                  ))}
                </ol>
              </TabsContent>
              <TabsContent value="time">
                <TicketTimePanel ticket={ticket} entries={data.time_entries} />
              </TabsContent>
            </Tabs>
          </div>
          <aside className="hidden min-w-0 @4xl:block" aria-label="Ticket details">
            <div className="sticky top-4">
              <Sidebar ticket={ticket} actions={actions} />
            </div>
          </aside>
        </div>
      </div>
      <DescriptionDialog key={ticket.description} ticket={ticket} open={editingDescription} onOpenChange={setEditingDescription} actions={actions} />
      <MergeDialog ticket={ticket} open={merging} onOpenChange={setMerging} />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${ticketNumber(ticket.number)}?`}
        description="The ticket, its comments, activity, links and time entries are deleted for good. The deletion is audited. Ticket numbers are never reused."
        confirmLabel="Delete ticket"
        confirmText={String(ticket.number)}
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  )
}
