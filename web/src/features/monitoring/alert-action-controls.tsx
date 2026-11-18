/* Snooze, assign and resolve controls shared by the detail pane and the bulk bar. */
import { useState, type ReactElement } from 'react'
import { CalendarClock, Check, CircleCheck, Moon, UserRound, UserRoundX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
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
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { UserAvatar } from '@/components/common/misc'
import type { User } from '@/lib/api/types'
import { formatDateTime } from '@/lib/format'
import { SNOOZE_MAX_MINUTES, SNOOZE_MIN_MINUTES, SNOOZE_PRESETS } from '@/lib/monitoring/labels'

export type SnoozeChoice = { minutes: number } | { until: string }

/** Tomorrow at 09:00 in the browser's zone, as an ISO string (within the 7-day limit). */
function tomorrowMorning(): string {
  const date = new Date()
  date.setDate(date.getDate() + 1)
  date.setHours(9, 0, 0, 0)
  return date.toISOString()
}

/** Validation and bounds for a custom snooze time, relative to now. */
function snoozeCheck(value: string) {
  const at = new Date(value)
  const minutes = (at.getTime() - Date.now()) / 60_000
  const problem = Number.isNaN(at.getTime())
    ? 'Choose a date and time'
    : minutes < SNOOZE_MIN_MINUTES
      ? 'Snooze for at least 15 minutes'
      : minutes > SNOOZE_MAX_MINUTES
        ? 'Snoozing is limited to the next 7 days'
        : null
  return {
    at,
    problem,
    min: toLocalInput(new Date(Date.now() + SNOOZE_MIN_MINUTES * 60_000)),
    max: toLocalInput(new Date(Date.now() + SNOOZE_MAX_MINUTES * 60_000)),
  }
}

function defaultSnoozeValue() {
  return toLocalInput(new Date(Date.now() + 3 * 3_600_000))
}

function toLocalInput(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function SnoozeDialog({
  open,
  onOpenChange,
  onConfirm,
  count = 1,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (choice: SnoozeChoice) => void
  count?: number
}) {
  const [value, setValue] = useState(defaultSnoozeValue)
  const { at, problem, min, max } = snoozeCheck(value)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Snooze {count > 1 ? `${count} alerts` : 'until…'}</DialogTitle>
          <DialogDescription>
            Notifications and escalation pause until then. The alert still resolves on its own when the check passes.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid grid-cols-1 gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (problem) return
            onConfirm({ until: at.toISOString() })
            onOpenChange(false)
          }}
        >
          <Field data-invalid={Boolean(problem) || undefined}>
            <FieldLabel htmlFor="snooze-until">Until</FieldLabel>
            <Input
              id="snooze-until"
              type="datetime-local"
              value={value}
              min={min}
              max={max}
              onChange={(event) => setValue(event.target.value)}
              autoFocus
            />
            {problem ? <FieldError>{problem}</FieldError> : <FieldDescription>{formatDateTime(at)} · your time</FieldDescription>}
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={Boolean(problem)}>
              <Moon data-icon="inline-start" />
              Snooze
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Snooze presets in a menu, with "Custom…" opening the date picker dialog. */
export function SnoozeMenu({
  trigger,
  onSnooze,
  count = 1,
  open,
  onOpenChange,
}: {
  trigger: ReactElement
  onSnooze: (choice: SnoozeChoice) => void
  count?: number
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const [custom, setCustom] = useState(false)
  return (
    <>
      <DropdownMenu open={open} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger render={trigger} />
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Snooze notifications for</DropdownMenuLabel>
            {SNOOZE_PRESETS.map((preset, index) => (
              <DropdownMenuItem key={preset.minutes} onClick={() => onSnooze({ minutes: preset.minutes })}>
                <Moon />
                {preset.label}
                {index < 6 && <DropdownMenuShortcut>{index + 1}</DropdownMenuShortcut>}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => onSnooze({ until: tomorrowMorning() })}>
            <CalendarClock />
            Tomorrow at 09:00
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setCustom(true)}>
            <CalendarClock />
            Pick a date and time…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {custom && <SnoozeDialog open onOpenChange={setCustom} onConfirm={onSnooze} count={count} />}
    </>
  )
}

export function AssignMenu({
  trigger,
  users,
  meId,
  currentId,
  onAssign,
}: {
  trigger: ReactElement
  users: Pick<User, 'id' | 'name' | 'email'>[]
  meId: string | undefined
  currentId: string | null | undefined
  onAssign: (userId: string | null) => void
}) {
  const others = users.filter((user) => user.id !== meId)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Assign to</DropdownMenuLabel>
          {meId && (
            <DropdownMenuItem onClick={() => onAssign(meId)}>
              <UserRound />
              Me
              {currentId === meId && <Check className="ml-auto" />}
            </DropdownMenuItem>
          )}
          {others.map((user) => (
            <DropdownMenuItem key={user.id} onClick={() => onAssign(user.id)}>
              <UserAvatar name={user.name} size="xs" />
              <span className="truncate">{user.name}</span>
              {currentId === user.id && <Check className="ml-auto" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        {currentId && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onAssign(null)}>
              <UserRoundX />
              Unassign
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ResolveDialog({
  open,
  onOpenChange,
  onConfirm,
  title,
  count = 1,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (note: string) => void
  title?: string
  count?: number
}) {
  const [note, setNote] = useState('')
  const submit = () => {
    onConfirm(note.trim())
    setNote('')
    onOpenChange(false)
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setNote('')
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{count > 1 ? `Resolve ${count} alerts?` : 'Resolve alert'}</DialogTitle>
          <DialogDescription>
            {count > 1 ? 'Each one closes now.' : title ? `“${title}” closes now.` : 'The alert closes now.'} It reopens if the check is
            still failing at its next run.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid grid-cols-1 gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <Field>
            <FieldLabel htmlFor="resolve-note">Resolution note (optional)</FieldLabel>
            <Textarea
              id="resolve-note"
              rows={3}
              maxLength={2000}
              autoFocus
              value={note}
              placeholder="What fixed it? Shown on the timeline."
              onChange={(event) => setNote(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  submit()
                }
              }}
            />
            <FieldDescription>Press Ctrl+Enter to resolve.</FieldDescription>
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">
              <CircleCheck data-icon="inline-start" />
              Resolve
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
