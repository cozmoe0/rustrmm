import type { ReactNode } from 'react'
import { CircleExclamationPoint, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { errorMessage } from '@/lib/api/errors'
import { accentFor } from '@/lib/accent'
import { formatDateTime, formatRelative, initials, truncateMiddle } from '@/lib/format'
import { cn } from '@/lib/utils'

/** Monospace chip for identifiers, hashes, IPs and keys. */
export function Mono({
  children,
  className,
  truncate,
}: {
  children: string
  className?: string
  truncate?: number
}) {
  return (
    <code
      title={truncate ? children : undefined}
      className={cn(
        'rounded-sm bg-surface-3 px-1.5 py-px font-mono text-[11.5px] text-secondary-foreground',
        className,
      )}
    >
      {truncate ? truncateMiddle(children, truncate) : children}
    </code>
  )
}

export function RelativeTime({ value, className }: { value: string | null | undefined; className?: string }) {
  if (!value) return <span className={cn('text-subtle-foreground', className)}>Never</span>
  return (
    <Tooltip>
      <TooltipTrigger render={<time dateTime={value} className={cn('tabular whitespace-nowrap', className)} />}>
        {formatRelative(value)}
      </TooltipTrigger>
      <TooltipContent>{formatDateTime(value)}</TooltipContent>
    </Tooltip>
  )
}

export function EntityAvatar({
  name,
  seed,
  accent,
  size = 'md',
  className,
}: {
  name: string
  seed?: string
  accent?: string | null
  size?: 'xs' | 'sm' | 'md' | 'lg'
  className?: string
}) {
  const color = accentFor(seed ?? name, accent)
  const sizes = {
    xs: 'size-5 rounded-[5px] text-[9px]',
    sm: 'size-6 rounded-md text-[10px]',
    md: 'size-8 rounded-lg text-[11px]',
    lg: 'size-11 rounded-xl text-sm',
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center font-semibold tracking-wide text-white select-none',
        sizes[size],
        className,
      )}
      style={{
        background: `linear-gradient(135deg, color-mix(in oklch, ${color} 92%, white) 0%, color-mix(in oklch, ${color} 82%, black) 100%)`,
        boxShadow: `inset 0 1px 0 rgb(255 255 255 / 0.22), 0 0 0 1px color-mix(in oklch, ${color} 60%, transparent)`,
      }}
    >
      {initials(name)}
    </span>
  )
}

export function UserAvatar({ name, className, size = 'md' }: { name: string; className?: string; size?: 'xs' | 'sm' | 'md' }) {
  const sizes = { xs: 'size-5 text-[9px]', sm: 'size-6 text-[10px]', md: 'size-8 text-[11px]' }
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-surface-4 font-semibold text-secondary-foreground ring-1 ring-border-strong select-none',
        sizes[size],
        className,
      )}
    >
      {initials(name)}
    </span>
  )
}

export function ErrorState({
  error,
  onRetry,
  title = 'Could not load this data',
  className,
}: {
  error: unknown
  onRetry?: () => void
  title?: string
  className?: string
}) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-critical/30 bg-critical/[0.04] px-6 py-10 text-center',
        className,
      )}
    >
      <CircleExclamationPoint className="size-6 text-critical" />
      <div>
        <p className="font-medium">{title}</p>
        <p className="mt-1 text-dense text-muted-foreground">{errorMessage(error)}</p>
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw data-icon="inline-start" />
          Try again
        </Button>
      )}
    </div>
  )
}

/** Label/value rows for detail panels. */
export function KeyValue({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('grid grid-cols-[minmax(7rem,38%)_1fr] items-baseline gap-3 py-1.5 text-dense', className)}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-[4px] border border-border-strong bg-surface-2 px-1 font-sans text-[10.5px] font-medium text-muted-foreground shadow-[inset_0_-1px_0_var(--border-strong)]',
        className,
      )}
    >
      {children}
    </kbd>
  )
}
