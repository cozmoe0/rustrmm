import { useId, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * A chip input for short tokens (tags, domains, CIDR ranges). Enter, comma, space or Tab commits
 * the draft; pasting splits on commas and whitespace; Backspace on an empty draft removes the last chip.
 */
export function TokenInput({
  value,
  onChange,
  placeholder,
  normalize = (token) => token.trim(),
  validate,
  max = 50,
  id,
  ariaLabel,
  ariaDescribedBy,
  mono = false,
  className,
}: {
  value: string[]
  onChange: (value: string[]) => void
  placeholder?: string
  normalize?: (token: string) => string
  /** Return an error message to reject a token. */
  validate?: (token: string) => string | null
  max?: number
  id?: string
  ariaLabel?: string
  ariaDescribedBy?: string
  mono?: boolean
  className?: string
}) {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const errorId = useId()

  function commit(raw: string): boolean {
    const tokens = raw
      .split(/[\s,;]+/)
      .map(normalize)
      .filter(Boolean)
    if (tokens.length === 0) return true
    const next = [...value]
    for (const token of tokens) {
      const problem = validate?.(token) ?? null
      if (problem) {
        setError(problem)
        setDraft(token)
        if (next.length !== value.length) onChange(next)
        return false
      }
      if (!next.includes(token) && next.length < max) next.push(token)
    }
    setError(null)
    setDraft('')
    onChange(next)
    return true
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' || event.key === ',' || event.key === ' ' || (event.key === 'Tab' && draft.trim())) {
      if (draft.trim()) {
        event.preventDefault()
        commit(draft)
      } else if (event.key !== 'Tab') {
        event.preventDefault()
      }
    } else if (event.key === 'Backspace' && !draft && value.length > 0) {
      onChange(value.slice(0, -1))
    }
  }

  function onPaste(event: ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData('text')
    if (/[\s,;]/.test(text.trim())) {
      event.preventDefault()
      commit(text)
    }
  }

  return (
    <div className={cn('grid gap-1.5', className)}>
      <div
        className={cn(
          'flex min-h-[var(--control-h,2rem)] flex-wrap items-center gap-1 rounded-lg border border-input bg-transparent px-1.5 py-1 transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30',
          error && 'border-destructive ring-3 ring-destructive/20',
        )}
      >
        {value.map((token) => (
          <span
            key={token}
            className={cn(
              'inline-flex h-6 items-center gap-1 rounded-md bg-surface-3 pr-0.5 pl-2 text-dense ring-1 ring-border',
              mono && 'font-mono text-[11.5px]',
            )}
          >
            {token}
            <button
              type="button"
              aria-label={`Remove ${token}`}
              onClick={() => onChange(value.filter((item) => item !== token))}
              className="flex size-5 items-center justify-center rounded-sm text-subtle-foreground outline-none hover:bg-surface-4 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          id={id}
          value={draft}
          aria-label={ariaLabel}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={[error ? errorId : null, ariaDescribedBy].filter(Boolean).join(' ') || undefined}
          placeholder={value.length === 0 ? placeholder : undefined}
          onChange={(event) => {
            setDraft(event.target.value)
            if (error) setError(null)
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => draft.trim() && commit(draft)}
          className={cn(
            'h-6 min-w-24 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground',
            mono && 'font-mono text-[12.5px]',
          )}
        />
      </div>
      {error && (
        <p id={errorId} role="alert" className="text-dense text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
