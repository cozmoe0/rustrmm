/* Dropdown pickers shared by the ticket header, the bulk bar and the queue rows. */
import { useState, type ReactElement } from 'react'
import { Check, Layers, Tag, UserRound, UserRoundX, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { UserAvatar } from '@/components/common/misc'
import type { TicketPriority, TicketQueue, TicketStatus, TicketType } from '@/lib/api/types'
import { normalizeTag } from '@/lib/tickets/bulk'
import { PRIORITY_LABEL, PRIORITY_ORDER, STATUS_HINT, STATUS_LABEL, STATUS_ORDER, TYPE_LABEL, TYPE_ORDER } from '@/lib/tickets/labels'
import { cn } from '@/lib/utils'
import { PriorityGlyph } from './ticket-ui'
import { STATUS_STYLE, TYPE_ICON } from './ticket-styles'

export function StatusMenu({
  trigger,
  value,
  onChange,
  align = 'start',
  exclude = [],
}: {
  trigger: ReactElement
  value?: TicketStatus
  onChange: (status: TicketStatus) => void
  align?: 'start' | 'end'
  exclude?: TicketStatus[]
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent align={align} className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Status</DropdownMenuLabel>
          {STATUS_ORDER.filter((status) => !exclude.includes(status)).map((status, index) => (
            <DropdownMenuItem key={status} onClick={() => onChange(status)} className="items-start">
              <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', STATUS_STYLE[status].dot)} />
              <span className="min-w-0 flex-1">
                <span className="block">{STATUS_LABEL[status]}</span>
                <span className="block truncate text-micro text-muted-foreground">{STATUS_HINT[status]}</span>
              </span>
              {value === status ? <Check className="mt-0.5" /> : <DropdownMenuShortcut>{index + 1}</DropdownMenuShortcut>}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function PriorityMenu({ trigger, value, onChange, align = 'start' }: { trigger: ReactElement; value?: TicketPriority; onChange: (priority: TicketPriority) => void; align?: 'start' | 'end' }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent align={align} className="w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Priority</DropdownMenuLabel>
          {PRIORITY_ORDER.map((priority) => (
            <DropdownMenuItem key={priority} onClick={() => onChange(priority)}>
              <PriorityGlyph priority={priority} />
              {PRIORITY_LABEL[priority]}
              {value === priority && <Check className="ml-auto" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function TypeMenu({ trigger, value, onChange, align = 'start' }: { trigger: ReactElement; value?: TicketType; onChange: (type: TicketType) => void; align?: 'start' | 'end' }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent align={align} className="w-52">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Type</DropdownMenuLabel>
          {TYPE_ORDER.map((type) => {
            const Icon = TYPE_ICON[type]
            return (
              <DropdownMenuItem key={type} onClick={() => onChange(type)}>
                <Icon />
                {TYPE_LABEL[type]}
                {value === type && <Check className="ml-auto" />}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function QueueMenu({ trigger, queues, value, onChange, align = 'start' }: { trigger: ReactElement; queues: TicketQueue[]; value?: string; onChange: (queueId: string) => void; align?: 'start' | 'end' }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent align={align} className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Queue</DropdownMenuLabel>
          {queues.map((queue) => (
            <DropdownMenuItem key={queue.id} onClick={() => onChange(queue.id)}>
              <Layers />
              <span className="truncate">{queue.name}</span>
              {value === queue.id ? <Check className="ml-auto" /> : <span className="tabular ml-auto text-micro text-subtle-foreground">{queue.open_tickets}</span>}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function AssigneeMenu({
  trigger,
  users,
  meId,
  value,
  onChange,
  align = 'start',
}: {
  trigger: ReactElement
  users: { id: string; name: string }[]
  meId: string | undefined
  value: string | null | undefined
  onChange: (userId: string | null) => void
  align?: 'start' | 'end'
}) {
  const [query, setQuery] = useState('')
  const others = users.filter((user) => user.id !== meId && user.name.toLowerCase().includes(query.trim().toLowerCase()))
  return (
    <DropdownMenu onOpenChange={(open) => !open && setQuery('')}>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent align={align} className="w-64">
        {users.length > 6 && (
          <div className="p-1 pb-1.5">
            <Input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => event.stopPropagation()}
              placeholder="Find a teammate…"
              aria-label="Find a teammate"
              className="h-7 text-dense"
            />
          </div>
        )}
        <DropdownMenuGroup>
          <DropdownMenuLabel>Assign to</DropdownMenuLabel>
          {meId && !query && (
            <DropdownMenuItem onClick={() => onChange(meId)}>
              <UserRound />
              Me
              {value === meId && <Check className="ml-auto" />}
            </DropdownMenuItem>
          )}
          {others.map((user) => (
            <DropdownMenuItem key={user.id} onClick={() => onChange(user.id)}>
              <UserAvatar name={user.name} size="xs" />
              <span className="truncate">{user.name}</span>
              {value === user.id && <Check className="ml-auto" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        {value !== null && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onChange(null)}>
              <UserRoundX />
              Unassign
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Add or remove a tag on several tickets (`-tag` removes). */
export function TagPopover({ trigger, suggestions, onApply }: { trigger: ReactElement; suggestions: string[]; onApply: (value: string) => void }) {
  const [open, setOpen] = useState(false)
  const [tag, setTag] = useState('')
  const normalized = normalizeTag(tag)
  const apply = (value: string) => {
    onApply(value)
    setOpen(false)
    setTag('')
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger} />
      <PopoverContent align="end" className="grid w-72 gap-3">
        <div className="grid gap-1.5">
          <span className="eyebrow">Tag</span>
          <Input
            autoFocus
            value={tag}
            maxLength={40}
            placeholder="printers"
            aria-label="Tag"
            onChange={(event) => setTag(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && normalized) {
                event.preventDefault()
                apply(normalized)
              }
            }}
          />
        </div>
        {suggestions.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {suggestions.slice(0, 10).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setTag(item)}
                className="inline-flex h-6 items-center gap-1 rounded-md bg-surface-3 px-2 text-micro ring-1 ring-border hover:bg-surface-4"
              >
                <Tag className="size-3 text-subtle-foreground" />
                {item}
              </button>
            ))}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" disabled={!normalized} onClick={() => apply(`-${normalized}`)}>
            <X data-icon="inline-start" />
            Remove
          </Button>
          <Button size="sm" disabled={!normalized} onClick={() => apply(normalized)}>
            <Tag data-icon="inline-start" />
            Add tag
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
