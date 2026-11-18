/* Small building blocks shared by the notification settings screens. */
import { useState, type ReactNode } from 'react'
import { ChevronsUpDown, KeyRound, Trash2, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SECRET_MASK } from '@/lib/automation/params'
import { WEEKDAY_LONG, WEEKDAY_SHORT } from '@/lib/monitoring/labels'
import type { SecretDraft } from '@/lib/notifications/channels'
import { cn } from '@/lib/utils'

/**
 * A write-only field. A stored value shows as a masked, read-only box with Replace (and Remove for
 * optional fields); replacing swaps in an empty password input.
 */
export function SecretInput({
  id,
  secret,
  onChange,
  optional = false,
  placeholder,
  invalid,
  disabled,
}: {
  id: string
  secret: SecretDraft
  onChange: (secret: SecretDraft) => void
  optional?: boolean
  placeholder?: string
  invalid?: boolean
  disabled?: boolean
}) {
  if (secret.stored && secret.mode !== 'replace') {
    const removing = secret.mode === 'remove'
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div
          id={id}
          className={cn(
            'flex h-(--control-h) min-w-0 flex-1 basis-48 items-center gap-2 rounded-lg border border-input bg-surface-2 px-3 font-mono text-dense text-muted-foreground',
            removing && 'border-dashed text-subtle-foreground line-through',
          )}
        >
          <KeyRound className="size-3.5 shrink-0" />
          <span className="truncate">{removing ? 'Will be removed' : `${SECRET_MASK} stored`}</span>
        </div>
        {removing ? (
          <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => onChange({ ...secret, mode: 'keep' })}>
            <Undo2 data-icon="inline-start" />
            Keep
          </Button>
        ) : (
          <>
            <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onChange({ ...secret, mode: 'replace', value: '' })}>
              Replace
            </Button>
            {optional && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={disabled}
                aria-label="Remove the stored value"
                className="hover:text-critical"
                onClick={() => onChange({ ...secret, mode: 'remove' })}
              >
                <Trash2 />
              </Button>
            )}
          </>
        )}
      </div>
    )
  }
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Input
        id={id}
        type="password"
        autoComplete="new-password"
        spellCheck={false}
        className="min-w-0 flex-1 font-mono text-[12.5px]"
        value={secret.value}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        autoFocus={secret.stored}
        onChange={(event) => onChange({ ...secret, value: event.target.value })}
      />
      {secret.stored && (
        <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => onChange({ ...secret, mode: 'keep', value: '' })}>
          Keep stored
        </Button>
      )}
    </div>
  )
}

export interface MultiOption {
  value: string
  label: string
  hint?: string
  icon?: ReactNode
  group?: string
}

/** A searchable multi-select; the trigger shows the first choices and a count. */
export function MultiCombobox({
  id,
  options,
  value,
  onChange,
  placeholder,
  anyLabel,
  invalid,
  disabled,
}: {
  id?: string
  options: MultiOption[]
  value: string[]
  onChange: (value: string[]) => void
  placeholder: string
  /** Shown when nothing is selected and that means "any". */
  anyLabel?: string
  invalid?: boolean
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const selected = value.map((item) => options.find((option) => option.value === item) ?? { value: item, label: item })
  const groups = new Map<string, MultiOption[]>()
  for (const option of options) groups.set(option.group ?? '', [...(groups.get(option.group ?? '') ?? []), option])
  const toggle = (item: string) => onChange(value.includes(item) ? value.filter((entry) => entry !== item) : [...value, item])
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-invalid={invalid || undefined}
            disabled={disabled}
            className="h-auto min-h-(--control-h) w-full justify-between py-1 font-normal"
          />
        }
      >
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {selected.length === 0 ? (
            <span className="truncate text-muted-foreground">{anyLabel ?? placeholder}</span>
          ) : (
            <>
              {selected.slice(0, 3).map((option) => (
                <span
                  key={option.value}
                  className="inline-flex h-6 max-w-44 items-center gap-1.5 rounded-md bg-surface-3 px-1.5 text-dense ring-1 ring-border [&_svg]:size-3.5"
                >
                  {option.icon}
                  <span className="truncate">{option.label}</span>
                </span>
              ))}
              {selected.length > 3 && <span className="tabular text-micro text-muted-foreground">+{selected.length - 3}</span>}
            </>
          )}
        </span>
        <ChevronsUpDown className="text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent className="w-(--anchor-width) min-w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search…" />
          <CommandList className="max-h-72">
            <CommandEmpty>Nothing matches.</CommandEmpty>
            {[...groups.entries()].map(([group, items]) => (
              <CommandGroup key={group || 'all'} heading={group || undefined}>
                {items.map((option) => (
                  <CommandItem
                    key={option.value}
                    value={`${option.label} ${option.hint ?? ''} ${option.value}`}
                    data-checked={value.includes(option.value)}
                    onSelect={() => toggle(option.value)}
                  >
                    {option.icon}
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {option.hint && <span className="max-w-[40%] truncate text-micro text-subtle-foreground">{option.hint}</span>}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
          {value.length > 0 && (
            <div className="border-t border-border p-1">
              <Button type="button" variant="ghost" size="sm" className="w-full" onClick={() => onChange([])}>
                Clear selection
              </Button>
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** A pill that toggles on and off (filters, severities, events). */
export function ChipToggle({
  pressed,
  onPressedChange,
  children,
  className,
  disabled,
}: {
  pressed: boolean
  onPressedChange: (pressed: boolean) => void
  children: ReactNode
  className?: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={() => onPressedChange(!pressed)}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-dense ring-1 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 [&_svg]:size-3.5',
        pressed
          ? 'bg-primary/12 font-medium text-foreground ring-primary/35'
          : 'bg-transparent text-muted-foreground ring-border-strong hover:bg-surface-3 hover:text-foreground',
        className,
      )}
    >
      {children}
    </button>
  )
}

/** Sunday-first day toggles; an empty selection means every day. */
export function DayPicker({ value, onChange, disabled }: { value: number[]; onChange: (days: number[]) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label="Days">
      {WEEKDAY_SHORT.map((label, day) => {
        const on = value.includes(day)
        return (
          <button
            key={label}
            type="button"
            aria-pressed={on}
            aria-label={WEEKDAY_LONG[day]}
            disabled={disabled}
            onClick={() => onChange(on ? value.filter((item) => item !== day) : [...value, day].sort((a, b) => a - b))}
            className={cn(
              'h-8 w-11 rounded-md text-dense ring-1 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
              on
                ? 'bg-primary text-primary-foreground ring-primary'
                : 'text-muted-foreground ring-border-strong hover:bg-surface-3 hover:text-foreground',
            )}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}

/** A titled block inside an editor (rule editor sections). */
export function EditorSection({
  title,
  description,
  action,
  children,
}: {
  title: string
  description?: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="grid grid-cols-1 gap-3 border-t border-border pt-4 first:border-t-0 first:pt-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{title}</h3>
          {description && <p className="mt-0.5 text-micro text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}
