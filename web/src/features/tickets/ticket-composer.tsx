/* The reply composer: public reply or internal note, Markdown, canned responses, placeholders and attachments. */
import { useRef, useState, type DragEvent, type Ref } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Braces, ChevronDown, FileText, Lock, Mail, MessageSquareText, Paperclip, Search, Send, StickyNote, TriangleExclamationPoint, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Progress } from '@/components/ui/progress'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cannedResponsesApi, ticketsApi } from '@/lib/api/endpoints'
import { errorMessage } from '@/lib/api/errors'
import { cannedResponsesQuery, ticketKeys } from '@/lib/api/queries'
import type { CannedResponse, CommentVisibility, Ticket, TicketStatus } from '@/lib/api/types'
import { formatBytes } from '@/lib/format'
import { assignRef } from '@/lib/assign-ref'
import { modKeyLabel } from '@/lib/hotkeys'
import { ACCEPT, checkAttachments, MAX_ATTACHMENTS } from '@/lib/tickets/attachments'
import { STATUS_LABEL } from '@/lib/tickets/labels'
import { markdownExcerpt } from '@/lib/tickets/markdown'
import { PLACEHOLDERS, renderPlaceholders, type PlaceholderContext } from '@/lib/tickets/placeholders'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { cn } from '@/lib/utils'
import { MarkdownEditor } from './markdown'
import { STATUS_STYLE } from './ticket-styles'
import { refreshTickets, useTicketActions } from './use-ticket-actions'

function CannedPicker({ canned, onPick, disabled }: { canned: CannedResponse[]; onPick: (item: CannedResponse) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const visible = canned.filter((item) => !needle || item.name.toLowerCase().includes(needle) || item.body.toLowerCase().includes(needle))
  return (
    <Popover open={open} onOpenChange={(next) => (setOpen(next), next || setQuery(''))}>
      <Tooltip>
        <TooltipTrigger render={<PopoverTrigger render={<Button type="button" size="xs" variant="ghost" disabled={disabled} aria-label="Insert a canned response" />} />}>
          <MessageSquareText data-icon="inline-start" />
          <span className="max-md:sr-only">Canned</span>
        </TooltipTrigger>
        <TooltipContent>Insert a canned response</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-[min(24rem,calc(100vw-2rem))] gap-0 p-0">
        <div className="relative border-b border-border p-2">
          <Search className="pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-subtle-foreground" />
          <Input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search canned responses…" aria-label="Search canned responses" className="h-8 pl-8" />
        </div>
        <ul className="max-h-72 overflow-y-auto p-1">
          {visible.length === 0 ? (
            <li className="px-3 py-5 text-center text-dense text-muted-foreground">{canned.length ? 'No response matches.' : 'No canned responses yet. Create them in Settings › Helpdesk.'}</li>
          ) : (
            visible.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => {
                    onPick(item)
                    setOpen(false)
                  }}
                  className="grid w-full gap-0.5 rounded-md px-2.5 py-2 text-left outline-none hover:bg-surface-3 focus-visible:bg-surface-3"
                >
                  <span className="flex items-center gap-1.5 text-dense font-medium">
                    {item.visibility === 'internal' ? <Lock className="size-3 text-warning" /> : <Mail className="size-3 text-subtle-foreground" />}
                    <span className="truncate">{item.name}</span>
                    {!item.shared && <span className="ml-auto text-[10px] font-normal text-subtle-foreground">Private</span>}
                  </span>
                  <span className="line-clamp-2 text-micro text-muted-foreground">{markdownExcerpt(item.body, 140)}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

const AFTER_STATUSES: TicketStatus[] = ['pending', 'on_hold', 'resolved']

export function TicketComposer({ ticket, textareaRef }: { ticket: Ticket; textareaRef?: Ref<HTMLTextAreaElement> }) {
  const me = useMe()
  const queryClient = useQueryClient()
  const actions = useTicketActions()
  const canManage = hasPermission(me, PERMISSIONS.ticketsManage)
  const { data: canned = [] } = useQuery({ ...cannedResponsesQuery, enabled: canManage, meta: { silent: true } })
  const hasRecipient = Boolean(ticket.contact || ticket.cc.length)
  const [visibility, setVisibility] = useState<CommentVisibility>(hasRecipient ? 'public' : 'internal')
  const [body, setBody] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [rejected, setRejected] = useState<{ name: string; reason: string }[]>([])
  const [dragging, setDragging] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [inserting, setInserting] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const local = useRef<HTMLTextAreaElement | null>(null)
  const context: PlaceholderContext = {
    contact: ticket.contact,
    ticket,
    technician: me ? { name: me.user.name } : null,
    client: { name: ticket.client_name },
  }

  const addFiles = (incoming: File[]) => {
    const result = checkAttachments(files, incoming)
    setFiles((current) => [...current, ...result.accepted])
    setRejected(result.rejected)
  }

  const insert = (text: string) => {
    const area = local.current
    const start = area?.selectionStart ?? body.length
    const end = area?.selectionEnd ?? body.length
    const before = body.slice(0, start)
    const glue = before && !before.endsWith('\n') && text.includes('\n') ? '\n\n' : ''
    const next = before + glue + text + body.slice(end)
    setBody(next)
    requestAnimationFrame(() => {
      area?.focus()
      const caret = (before + glue + text).length
      area?.setSelectionRange(caret, caret)
    })
  }

  const pickCanned = async (item: CannedResponse) => {
    setInserting(true)
    try {
      const rendered = await cannedResponsesApi.render(item.id, ticket.id)
      insert(rendered.body)
      setVisibility(rendered.visibility)
    } catch {
      // Fall back to filling the placeholders locally if the server cannot render it.
      insert(renderPlaceholders(item.body, context))
      setVisibility(item.visibility)
    } finally {
      setInserting(false)
    }
  }

  const post = useMutation({
    mutationFn: async (after: TicketStatus | null) => {
      // What the preview shows is what is sent: known placeholders are filled before posting.
      const text = renderPlaceholders(body, context)
      const comment = await ticketsApi.comment(ticket.id, { body: text, visibility, files }, { onProgress: (loaded, total) => setProgress(total ? loaded / total : null) })
      if (after && after !== ticket.status) await actions.updateAsync(ticket, { status: after })
      return comment
    },
    meta: { silent: true },
    onSuccess: (_comment, after) => {
      setBody('')
      setFiles([])
      setRejected([])
      void queryClient.invalidateQueries({ queryKey: ticketKeys.detail(ticket.id) })
      refreshTickets(queryClient, [ticket.id])
      toast.success(visibility === 'public' ? 'Reply sent' : 'Note added', after ? { description: `Status set to ${STATUS_LABEL[after]}` } : undefined)
    },
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: () => setProgress(null),
  })

  const ready = (body.trim().length > 0 || files.length > 0) && !post.isPending
  const send = (after: TicketStatus | null = null) => {
    if (ready) post.mutate(after)
  }
  const onDrag = (event: DragEvent) => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    setDragging(event.type === 'dragover' || event.type === 'dragenter')
  }

  if (!canManage) {
    return <p className="rounded-xl border border-dashed border-border-strong px-4 py-3 text-dense text-muted-foreground">Replying needs the “Work tickets” permission.</p>
  }

  const internal = visibility === 'internal'
  return (
    <div
      className="relative"
      onDragEnter={onDrag}
      onDragOver={onDrag}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return
        event.preventDefault()
        setDragging(false)
        addFiles([...event.dataTransfer.files])
      }}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="Reply type" className="flex items-center rounded-lg bg-surface-3 p-0.5 ring-1 ring-border">
          {(['public', 'internal'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={visibility === value}
              onClick={() => setVisibility(value)}
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-dense font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5',
                visibility === value && value === 'public' && 'bg-surface-1 text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.08)] dark:bg-surface-4',
                visibility === value && value === 'internal' && 'bg-warning/15 text-warning ring-1 ring-warning/30',
              )}
            >
              {value === 'public' ? <Mail /> : <Lock />}
              {value === 'public' ? 'Reply' : 'Internal note'}
            </button>
          ))}
        </div>
        <span className="min-w-0 flex-1 truncate text-micro text-muted-foreground">
          {internal ? (
            'Only technicians see internal notes; they are never emailed.'
          ) : ticket.contact ? (
            <>
              To <span className="font-medium text-secondary-foreground">{ticket.contact.name}</span> &lt;{ticket.contact.email}&gt;
              {ticket.cc.length > 0 && <> · CC {ticket.cc.join(', ')}</>}
            </>
          ) : ticket.cc.length ? (
            <>CC {ticket.cc.join(', ')}</>
          ) : (
            <span className="inline-flex items-center gap-1 text-warning">
              <TriangleExclamationPoint className="size-3" />
              No contact on this ticket; the reply is recorded but not emailed.
            </span>
          )}
        </span>
      </div>
      <MarkdownEditor
        value={body}
        onChange={setBody}
        tone={internal ? 'internal' : 'default'}
        ariaLabel={internal ? 'Internal note' : 'Reply'}
        placeholder={internal ? 'Add a note for the team… (Markdown)' : `Reply to ${ticket.contact?.name ?? 'the customer'}… (Markdown)`}
        textareaRef={(node) => {
          local.current = node
          assignRef(textareaRef, node)
        }}
        previewTransform={(value) => renderPlaceholders(value, context)}
        onSubmit={() => send()}
        onPasteFiles={addFiles}
        maxLength={100_000}
        textareaClassName="min-h-24"
        toolbar={
          <>
            <CannedPicker canned={canned} onPick={(item) => void pickCanned(item)} disabled={inserting} />
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger render={<DropdownMenuTrigger render={<Button type="button" size="icon-xs" variant="ghost" aria-label="Insert a placeholder" />} />}>
                  <Braces />
                </TooltipTrigger>
                <TooltipContent>Insert a placeholder (filled in the preview and when sent)</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Placeholders</DropdownMenuLabel>
                  {PLACEHOLDERS.map((item) => (
                    <DropdownMenuItem key={item.key} onClick={() => insert(`{{${item.key}}}`)}>
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      <span className="max-w-24 truncate text-micro text-subtle-foreground">{renderPlaceholders(`{{${item.key}}}`, context) || '—'}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <Tooltip>
              <TooltipTrigger render={<Button type="button" size="icon-xs" variant="ghost" aria-label="Attach files" onClick={() => fileInput.current?.click()} disabled={files.length >= MAX_ATTACHMENTS} />}>
                <Paperclip />
              </TooltipTrigger>
              <TooltipContent>Attach files (or drop them here) · up to 10, 25 MB each</TooltipContent>
            </Tooltip>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept={ACCEPT}
              className="hidden"
              onChange={(event) => {
                addFiles([...(event.target.files ?? [])])
                event.target.value = ''
              }}
            />
          </>
        }
        footer={
          (files.length > 0 || rejected.length > 0 || progress !== null) && (
            <div className="grid gap-2 border-t border-border px-3 py-2">
              {files.length > 0 && (
                <ul className="flex flex-wrap gap-1.5">
                  {files.map((file, index) => (
                    <li key={`${file.name}-${index}`} className="inline-flex h-7 max-w-64 items-center gap-1.5 rounded-md bg-surface-3 pr-0.5 pl-2 text-micro ring-1 ring-border">
                      <FileText className="size-3.5 shrink-0 text-subtle-foreground" />
                      <span className="truncate">{file.name}</span>
                      <span className="tabular shrink-0 text-subtle-foreground">{formatBytes(file.size)}</span>
                      <button
                        type="button"
                        aria-label={`Remove ${file.name}`}
                        disabled={post.isPending}
                        onClick={() => setFiles((current) => current.filter((_, position) => position !== index))}
                        className="flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-surface-4 hover:text-foreground"
                      >
                        <X className="size-3" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {rejected.map((item) => (
                <p key={item.name} className="flex items-center gap-1.5 text-micro text-critical">
                  <TriangleExclamationPoint className="size-3 shrink-0" />
                  <span className="truncate">
                    {item.name}: {item.reason}
                  </span>
                </p>
              ))}
              {progress !== null && <Progress value={Math.round(progress * 100)} aria-label="Upload progress" />}
            </div>
          )
        }
      />
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary/60 bg-primary/[0.06] text-dense font-medium text-primary backdrop-blur-[1px]">
          <Upload className="size-5" />
          Drop files to attach
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto hidden text-micro text-subtle-foreground sm:inline">
          {modKeyLabel}+Enter to {internal ? 'add the note' : 'send'}
        </span>
        <div className="flex">
          <Button size="sm" disabled={!ready} onClick={() => send()} className={cn('rounded-r-none', internal && 'bg-warning text-[oklch(0.25_0.05_70)] hover:bg-[color-mix(in_oklch,var(--warning),white_10%)]')}>
            {post.isPending ? <Spinner data-icon="inline-start" /> : internal ? <StickyNote data-icon="inline-start" /> : <Send data-icon="inline-start" />}
            {internal ? 'Add note' : 'Send reply'}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  size="sm"
                  disabled={!ready}
                  aria-label="Send and change status"
                  className={cn('rounded-l-none border-l border-black/15 px-1.5', internal && 'bg-warning text-[oklch(0.25_0.05_70)] hover:bg-[color-mix(in_oklch,var(--warning),white_10%)]')}
                />
              }
            >
              <ChevronDown />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuGroup>
                <DropdownMenuLabel>{internal ? 'Add note and set status' : 'Send and set status'}</DropdownMenuLabel>
                {AFTER_STATUSES.filter((status) => status !== ticket.status).map((status) => (
                  <DropdownMenuItem key={status} onClick={() => send(status)}>
                    <span className={cn('size-2 rounded-full', STATUS_STYLE[status].dot)} />
                    {STATUS_LABEL[status]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  )
}
