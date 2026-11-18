import { useState, type KeyboardEvent } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Chips for short lists whose items may contain spaces (select options, rule values).
 * Enter or comma commits; Backspace on an empty draft removes the last item.
 */
export function ListInput({
  value,
  onChange,
  placeholder,
  id,
  ariaLabel,
  invalid,
  mono = false,
  max = 50,
  disabled = false,
  className,
}: {
  value: string[]
  onChange: (value: string[]) => void
  placeholder?: string
  id?: string
  ariaLabel?: string
  invalid?: boolean
  mono?: boolean
  max?: number
  disabled?: boolean
  className?: string
}) {
  const [draft, setDraft] = useState('')

  const commit = () => {
    const items = draft
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    if (items.length === 0) return
    onChange([...value, ...items.filter((item) => !value.includes(item))].slice(0, max))
    setDraft('')
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault()
      commit()
    } else if (event.key === 'Backspace' && draft === '' && value.length > 0) {
      onChange(value.slice(0, -1))
    }
  }

  return (
    <div
      className={cn(
        'flex min-h-(--control-h) w-full flex-wrap items-center gap-1 rounded-lg border border-input bg-transparent px-1.5 py-1 text-sm transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30 dark:bg-input/30',
        invalid && 'border-destructive ring-2 ring-destructive/25',
        disabled && 'opacity-50',
        className,
      )}
    >
      {value.map((item) => (
        <span
          key={item}
          className={cn(
            'inline-flex h-6 max-w-full items-center gap-1 rounded-md bg-surface-3 pr-0.5 pl-2 text-dense ring-1 ring-border',
            mono && 'font-mono text-[11.5px]',
          )}
        >
          <span className="truncate">{item}</span>
          {!disabled && (
            <button
              type="button"
              aria-label={`Remove ${item}`}
              onClick={() => onChange(value.filter((entry) => entry !== item))}
              className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-surface-4 hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          )}
        </span>
      ))}
      <input
        id={id}
        aria-label={ariaLabel}
        disabled={disabled}
        value={draft}
        placeholder={value.length === 0 ? placeholder : undefined}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={commit}
        className={cn(
          'h-6 min-w-24 flex-1 bg-transparent px-1 outline-none placeholder:text-muted-foreground',
          mono && 'font-mono text-[12px]',
        )}
      />
    </div>
  )
}
