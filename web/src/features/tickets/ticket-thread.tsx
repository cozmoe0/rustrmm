/* The conversation thread: the description, public replies and internal notes (with attachments and edits), and activity. */
import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { LucideIcon } from 'lucide-react'
import {
  AlarmClock,
  ArrowRightLeft,
  Bot,
  Building,
  CircleDot,
  Clock,
  Download,
  FileText,
  GitMerge,
  Layers,
  Link2,
  Lock,
  Mail,
  MailWarning,
  MapPin,
  Pencil,
  Tag,
  Timer,
  Type,
  Unlink,
  UserRound,
  Users,
  Zap,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button, buttonVariants } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { RelativeTime, UserAvatar } from '@/components/common/misc'
import { ticketsApi } from '@/lib/api/endpoints'
import { errorMessage, isApiError } from '@/lib/api/errors'
import { ticketKeys } from '@/lib/api/queries'
import type { Ticket, TicketActivity, TicketActivityKind, TicketAttachment, TicketComment, TicketDetail } from '@/lib/api/types'
import { formatBytes, formatDateTime } from '@/lib/format'
import { extensionOf, PREVIEWABLE } from '@/lib/tickets/attachments'
import { ACTIVITY_LABEL, PRIORITY_LABEL, SOURCE_LABEL, STATUS_LABEL, TYPE_LABEL } from '@/lib/tickets/labels'
import { cn } from '@/lib/utils'
import { Markdown, MarkdownEditor } from './markdown'
import { useNow } from './use-now'

const EDIT_WINDOW_MS = 15 * 60_000
const isMock = import.meta.env.VITE_MOCK === '1'

// ------------------------------------------------------------------ attachments

function downloadAttachment(attachment: TicketAttachment) {
  ticketsApi.downloadAttachment(attachment.id, attachment.file_name).catch((error: unknown) => toast.error(errorMessage(error)))
}

/** Opens the attachment through its download URL (the server forces a download; mock mode fetches it). */
function DownloadLink({ attachment, className, children }: { attachment: TicketAttachment; className?: string; children: ReactNode }) {
  return (
    <a
      href={ticketsApi.attachmentUrl(attachment.id)}
      download={attachment.file_name}
      rel="noopener"
      className={className}
      onClick={(event) => {
        if (!isMock) return
        event.preventDefault()
        downloadAttachment(attachment)
      }}
    >
      {children}
    </a>
  )
}

/**
 * Object URLs for fetched attachments, one per blob for the session. They are not revoked on unmount:
 * StrictMode and quick remounts would otherwise leave an <img> pointing at a revoked URL.
 */
const objectUrls = new WeakMap<Blob, string>()

function objectUrl(blob: Blob) {
  let url = objectUrls.get(blob)
  if (!url) {
    url = URL.createObjectURL(blob)
    objectUrls.set(blob, url)
  }
  return url
}

function useBlobUrl(attachment: TicketAttachment, enabled: boolean) {
  const { data: blob, isLoading, error } = useQuery({
    queryKey: ['ticket-attachment', attachment.id],
    queryFn: ({ signal }) => ticketsApi.attachmentBlob(attachment.id, signal),
    enabled,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    meta: { silent: true },
  })
  const url = blob ? objectUrl(blob) : null
  return { url, isLoading, error }
}

function ImageAttachment({ attachment }: { attachment: TicketAttachment }) {
  const { url, isLoading, error } = useBlobUrl(attachment, true)
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group relative block h-28 w-44 overflow-hidden rounded-lg bg-surface-3 ring-1 ring-border outline-none hover:ring-border-strong focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Preview ${attachment.file_name}`}
      >
        {url ? (
          <img src={url} alt={attachment.file_name} className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
        ) : (
          <span className="flex size-full items-center justify-center text-subtle-foreground">{isLoading ? <Spinner /> : error ? 'Preview unavailable' : null}</span>
        )}
        <span className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-gradient-to-t from-black/70 to-transparent px-2 pt-4 pb-1.5 text-[10.5px] text-white">
          <span className="truncate">{attachment.file_name}</span>
          <span className="tabular shrink-0 opacity-80">{formatBytes(attachment.size_bytes)}</span>
        </span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92dvh] gap-3 sm:max-w-[min(1100px,calc(100vw-2rem))]">
          <DialogHeader>
            <DialogTitle className="truncate pr-8">{attachment.file_name}</DialogTitle>
            <DialogDescription>{formatBytes(attachment.size_bytes)} · {attachment.content_type}</DialogDescription>
          </DialogHeader>
          <div className="flex min-h-0 justify-center overflow-auto rounded-lg bg-surface-3 ring-1 ring-border">
            {url ? <img src={url} alt={attachment.file_name} className="max-h-[70dvh] w-auto object-contain" /> : <Spinner className="m-10" />}
          </div>
          <div className="flex justify-end">
            <DownloadLink attachment={attachment} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              <Download data-icon="inline-start" />
              Download
            </DownloadLink>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function FileAttachment({ attachment }: { attachment: TicketAttachment }) {
  return (
    <DownloadLink
      attachment={attachment}
      className="group inline-flex h-10 max-w-64 items-center gap-2.5 rounded-lg bg-surface-2 pr-3 pl-2 ring-1 ring-border outline-none hover:bg-surface-3 hover:ring-border-strong focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-3 text-[9px] font-semibold tracking-wide text-muted-foreground uppercase ring-1 ring-border">
        {extensionOf(attachment.file_name).slice(0, 4) || <FileText className="size-3.5" />}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-dense font-medium">{attachment.file_name}</span>
        <span className="tabular block text-[10.5px] text-subtle-foreground">{formatBytes(attachment.size_bytes)}</span>
      </span>
      <Download className="size-3.5 shrink-0 text-subtle-foreground group-hover:text-foreground" />
    </DownloadLink>
  )
}

export function AttachmentList({ attachments }: { attachments: TicketAttachment[] }) {
  if (!attachments.length) return null
  return (
    <div className="mt-2.5 flex flex-wrap gap-2">
      {attachments.map((attachment) =>
        PREVIEWABLE.has(extensionOf(attachment.file_name)) ? <ImageAttachment key={attachment.id} attachment={attachment} /> : <FileAttachment key={attachment.id} attachment={attachment} />,
      )}
    </div>
  )
}

// ------------------------------------------------------------------ comments

function AuthorAvatar({ author }: { author: TicketComment['author'] }) {
  if (author.type === 'system') {
    return (
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-3 text-muted-foreground ring-1 ring-border">
        <Zap className="size-3.5" />
      </span>
    )
  }
  if (author.type === 'contact') {
    return <UserAvatar name={author.name.replace(/\s*<.*>$/, '')} className="bg-info/12 text-info ring-info/30" />
  }
  return <UserAvatar name={author.name} className="bg-primary/12 text-primary ring-primary/30" />
}

function CommentEditor({ ticketId, comment, onDone }: { ticketId: string; comment: TicketComment; onDone: () => void }) {
  const queryClient = useQueryClient()
  const [body, setBody] = useState(comment.body)
  const save = useMutation({
    mutationFn: () => ticketsApi.editComment(ticketId, comment.id, body),
    meta: { silent: true },
    onSuccess: (updated) => {
      queryClient.setQueryData<TicketDetail>(ticketKeys.detail(ticketId), (detail) =>
        detail ? { ...detail, comments: detail.comments.map((item) => (item.id === updated.id ? updated : item)) } : detail,
      )
      onDone()
    },
    onError: (error) => {
      toast.error(isApiError(error) && error.code === 'edit_window_closed' ? 'The 15-minute edit window has closed.' : errorMessage(error))
      if (isApiError(error) && error.code === 'edit_window_closed') onDone()
    },
  })
  return (
    <div className="mt-2 grid gap-2">
      <MarkdownEditor value={body} onChange={setBody} onSubmit={() => save.mutate()} tone={comment.visibility === 'internal' ? 'internal' : 'default'} ariaLabel="Edit comment" />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button size="sm" disabled={save.isPending || (!body.trim() && comment.attachments.length === 0)} onClick={() => save.mutate()}>
          {save.isPending && <Spinner data-icon="inline-start" />}
          Save
        </Button>
      </div>
    </div>
  )
}

function CommentItem({ ticket, comment, meId }: { ticket: Ticket; comment: TicketComment; meId: string | undefined }) {
  const now = useNow(15_000)
  const [editing, setEditing] = useState(false)
  const internal = comment.visibility === 'internal'
  const contact = comment.author.type === 'contact'
  const system = comment.author.type === 'system'
  const left = EDIT_WINDOW_MS - (now - new Date(comment.created_at).getTime())
  const editable = comment.author.type === 'user' && comment.author.id === meId && left > 0
  const role = contact ? 'Contact' : system ? 'System' : 'Technician'
  return (
    <li className="relative flex gap-3" id={`comment-${comment.id}`}>
      <AuthorAvatar author={comment.author} />
      <div
        className={cn(
          'min-w-0 flex-1 rounded-xl px-3.5 py-3 ring-1',
          internal ? 'bg-warning/[0.06] ring-warning/30 [background-image:repeating-linear-gradient(135deg,transparent_0_10px,color-mix(in_oklch,var(--warning)_4%,transparent)_10px_11px)]' : contact ? 'bg-card ring-border shadow-card' : system ? 'bg-surface-2/70 ring-border' : 'bg-primary/[0.035] ring-primary/15',
        )}
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-dense font-semibold">{comment.author.name}</span>
          <span
            className={cn(
              'inline-flex h-[18px] items-center rounded-[5px] px-1.5 text-[10px] font-medium ring-1',
              contact ? 'bg-info/10 text-info ring-info/25' : system ? 'bg-surface-3 text-muted-foreground ring-border' : 'bg-surface-3 text-secondary-foreground ring-border',
            )}
          >
            {role}
          </span>
          {internal ? (
            <span className="inline-flex h-[18px] items-center gap-1 rounded-[5px] bg-warning/14 px-1.5 text-[10px] font-semibold text-warning ring-1 ring-warning/30">
              <Lock className="size-2.5" />
              Internal note
            </span>
          ) : (
            !contact &&
            !system && (
              <Tooltip>
                <TooltipTrigger render={<span className="inline-flex items-center gap-1 text-[10.5px] text-subtle-foreground" />}>
                  <Mail className="size-3" />
                  Public reply
                </TooltipTrigger>
                <TooltipContent>Emailed to {ticket.contact?.email ?? 'the contact'}{ticket.cc.length ? ` and ${ticket.cc.length} CC` : ''} when notifications are on</TooltipContent>
              </Tooltip>
            )
          )}
          {comment.source === 'email' && contact && (
            <span className="inline-flex items-center gap-1 text-[10.5px] text-subtle-foreground">
              <Mail className="size-3" />
              via email
            </span>
          )}
          {comment.source === 'agent' && (
            <span className="inline-flex items-center gap-1 text-[10.5px] text-subtle-foreground">
              <Bot className="size-3" />
              via Request support
            </span>
          )}
          <RelativeTime value={comment.created_at} className="text-[10.5px] text-subtle-foreground" />
          {comment.edited_at && (
            <span className="text-[10.5px] text-subtle-foreground" title={`Edited ${formatDateTime(comment.edited_at)}`}>
              · edited
            </span>
          )}
          {editable && !editing && (
            <Button size="xs" variant="ghost" className="ml-auto h-5 px-1.5 text-[10.5px] text-muted-foreground" onClick={() => setEditing(true)}>
              <Pencil data-icon="inline-start" />
              Edit · {Math.max(1, Math.ceil(left / 60_000))}m left
            </Button>
          )}
        </div>
        {editing ? (
          <CommentEditor ticketId={ticket.id} comment={comment} onDone={() => setEditing(false)} />
        ) : (
          <>
            {comment.body.trim() && <Markdown source={comment.body} className="mt-1.5" />}
            <AttachmentList attachments={comment.attachments} />
          </>
        )}
      </div>
    </li>
  )
}

// ------------------------------------------------------------------ activity

const ACTIVITY_ICON: Record<TicketActivityKind, LucideIcon> = {
  created: CircleDot,
  subject: Type,
  description: FileText,
  status: CircleDot,
  priority: AlarmClock,
  type: Layers,
  queue: Layers,
  assignee: UserRound,
  contact: Users,
  site: MapPin,
  client: Building,
  tags: Tag,
  cc: Mail,
  linked: Link2,
  unlinked: Unlink,
  merged: GitMerge,
  sla_breached: AlarmClock,
  time_logged: Timer,
  time_deleted: Timer,
  email_failed: MailWarning,
}

function label(kind: TicketActivityKind, value: string | null): string {
  if (value === null) return 'nothing'
  if (kind === 'status') return STATUS_LABEL[value as keyof typeof STATUS_LABEL] ?? value
  if (kind === 'priority') return PRIORITY_LABEL[value as keyof typeof PRIORITY_LABEL] ?? value
  if (kind === 'type') return TYPE_LABEL[value as keyof typeof TYPE_LABEL] ?? value
  return value
}

function activityText(item: TicketActivity): ReactNode {
  const strong = (text: string) => <span className="font-medium text-foreground">{text}</span>
  switch (item.kind) {
    case 'created':
      return <>created the ticket{item.to ? <> via {strong(SOURCE_LABEL[item.to as keyof typeof SOURCE_LABEL] ?? item.to)}</> : null}</>
    case 'description':
      return 'edited the description'
    case 'linked':
      return <>linked {strong(item.to ?? '')}</>
    case 'unlinked':
      return <>unlinked {strong(item.to ?? '')}</>
    case 'merged':
      return item.from ? <>merged {strong(item.from)} into this ticket</> : <>merged this ticket into {strong(item.to ?? '')}</>
    case 'sla_breached':
      return <>SLA breached: {strong(item.to === 'both' ? 'first response and resolution' : item.to === 'first_response' ? 'first response' : 'resolution')}</>
    case 'time_logged':
      return <>logged {strong(item.to ?? '')}</>
    case 'time_deleted':
      return <>deleted a time entry of {strong(item.from ?? '')}</>
    case 'email_failed':
      return <>could not deliver an email{item.to ? <>: {item.to}</> : null}</>
    default: {
      const what = ACTIVITY_LABEL[item.kind].replace(/ changed$/, '').toLowerCase()
      if (item.from === null) return <>set {what} to {strong(label(item.kind, item.to))}</>
      if (item.to === null) return <>cleared {what} ({label(item.kind, item.from)})</>
      return (
        <>
          changed {what} from {label(item.kind, item.from)} <ArrowRightLeft className="inline size-3 align-[-2px] text-subtle-foreground" /> {strong(label(item.kind, item.to))}
        </>
      )
    }
  }
}

export function ActivityLine({ item, dense = false }: { item: TicketActivity; dense?: boolean }) {
  const Icon = ACTIVITY_ICON[item.kind] ?? Clock
  const alarming = item.kind === 'sla_breached' || item.kind === 'email_failed'
  return (
    <li className={cn('relative flex items-start gap-3', dense ? 'py-1' : 'py-1.5')}>
      <span
        className={cn(
          'relative z-[1] mt-px flex size-8 shrink-0 items-center justify-center',
          '[&_svg]:size-3.5',
          alarming ? 'text-critical' : 'text-subtle-foreground',
        )}
      >
        <span className={cn('flex size-6 items-center justify-center rounded-full ring-1', alarming ? 'bg-critical/10 ring-critical/25' : 'bg-surface-2 ring-border')}>
          <Icon />
        </span>
      </span>
      <p className="min-w-0 flex-1 pt-1.5 text-micro leading-relaxed text-muted-foreground">
        <span className="font-medium text-secondary-foreground">{item.actor_name}</span> {activityText(item)} · <RelativeTime value={item.at} className="text-subtle-foreground" />
      </p>
    </li>
  )
}

/** Merge of comments and activity in time order (activity optional). */
export function ConversationThread({
  ticket,
  comments,
  activity,
  showActivity,
  meId,
}: {
  ticket: Ticket
  comments: TicketComment[]
  activity: TicketActivity[]
  showActivity: boolean
  meId: string | undefined
}) {
  type Entry = { at: string; kind: 'comment'; comment: TicketComment } | { at: string; kind: 'activity'; item: TicketActivity }
  const entries: Entry[] = comments.map((comment) => ({ at: comment.created_at, kind: 'comment' as const, comment }))
  if (showActivity) {
    for (const item of activity) if (item.kind !== 'created' && item.kind !== 'time_logged') entries.push({ at: item.at, kind: 'activity', item })
  }
  entries.sort((a, b) => a.at.localeCompare(b.at))
  const descriptionAuthor = ticket.source === 'alert' || ticket.created_by_name === 'System' ? 'system' : ticket.source === 'email' || ticket.source === 'agent' ? 'contact' : 'user'

  return (
    <ol className="relative grid gap-3">
      <span className="absolute top-4 bottom-4 left-4 w-px bg-border" aria-hidden="true" />
      <li className="relative flex gap-3">
        <AuthorAvatar author={{ type: descriptionAuthor, id: null, name: ticket.created_by_name }} />
        <div className={cn('min-w-0 flex-1 rounded-xl px-3.5 py-3 ring-1', descriptionAuthor === 'contact' ? 'bg-card shadow-card ring-border' : 'bg-surface-2/70 ring-border')}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-dense font-semibold">{ticket.created_by_name}</span>
            <span className="inline-flex h-[18px] items-center rounded-[5px] bg-surface-3 px-1.5 text-[10px] font-medium text-secondary-foreground ring-1 ring-border">Opened the ticket</span>
            <span className="inline-flex items-center gap-1 text-[10.5px] text-subtle-foreground">via {SOURCE_LABEL[ticket.source].toLowerCase()}</span>
            <RelativeTime value={ticket.created_at} className="text-[10.5px] text-subtle-foreground" />
          </div>
          <Markdown source={ticket.description} className="mt-1.5" empty="No description." />
        </div>
      </li>
      {entries.map((entry) =>
        entry.kind === 'comment' ? (
          <CommentItem key={entry.comment.id} ticket={ticket} comment={entry.comment} meId={meId} />
        ) : (
          <ActivityLine key={`${entry.item.at}-${entry.item.kind}-${entry.item.to}`} item={entry.item} dense />
        ),
      )}
    </ol>
  )
}
