/* Shared building blocks for the remote tool screens. */
import type { ComponentProps, ReactNode } from 'react'
import { CircleExclamationPoint, Info, Lock, PlugZap, RefreshCw, Search, TriangleExclamationPoint, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { errorMessage, isApiError } from '@/lib/api/errors'
import { formatRelative } from '@/lib/format'
import type { RemoteAccess, RemoteBlock } from '@/lib/remote'
import { cn } from '@/lib/utils'
import { useNow } from './remote-hooks'

/** A button that explains itself in a tooltip when the remote action is unavailable. */
export function GatedButton({
  access,
  children,
  disabled,
  tooltip,
  ...props
}: ComponentProps<typeof Button> & { access: RemoteAccess; tooltip?: ReactNode }) {
  if (access.ok) {
    if (!tooltip) {
      return (
        <Button disabled={disabled} {...props}>
          {children}
        </Button>
      )
    }
    return (
      <Tooltip>
        <TooltipTrigger render={<Button disabled={disabled} {...props} />}>{children}</TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    )
  }
  const label = typeof props['aria-label'] === 'string' ? props['aria-label'] : undefined
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" tabIndex={0} aria-label={label ? `${label} — ${access.reason}` : access.reason} />}>
        <Button {...props} disabled aria-hidden="true" tabIndex={-1}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{access.reason}</TooltipContent>
    </Tooltip>
  )
}

const BLOCK_COPY: Record<RemoteBlock, { title: string; icon: typeof Lock }> = {
  permission: { title: 'You don’t have access to this tool', icon: Lock },
  pending: { title: 'Waiting for approval', icon: Info },
  revoked: { title: 'Agent revoked', icon: Lock },
  inactive: { title: 'Device not active', icon: Info },
  offline: { title: 'Device offline', icon: PlugZap },
  unsupported: { title: 'Not available on this platform', icon: Info },
}

/** Full-panel state shown when a remote tool can't be used right now. */
export function ToolUnavailable({
  access,
  tool,
  lastSeen,
  className,
}: {
  access: RemoteAccess
  tool: string
  lastSeen?: string | null
  className?: string
}) {
  const copy = BLOCK_COPY[access.block ?? 'inactive']
  const Icon = copy.icon
  return (
    <div
      className={cn(
        'relative flex flex-col items-center justify-center gap-3 overflow-hidden rounded-xl border border-dashed border-border-strong px-6 py-16 text-center',
        className,
      )}
    >
      <div className="bg-grid bg-grid-fade pointer-events-none absolute inset-0 opacity-70" />
      <span className="relative flex size-11 items-center justify-center rounded-xl bg-surface-2 text-muted-foreground shadow-raised ring-1 ring-border">
        <Icon className="size-5" />
      </span>
      <div className="relative max-w-md">
        <h3 className="text-[15px] font-semibold tracking-tight">{copy.title}</h3>
        <p className="mt-1.5 text-dense text-muted-foreground">
          {access.block === 'offline' ? `${tool} needs a live connection to the agent.` : access.reason}
          {access.block === 'offline' && lastSeen && ` Last seen ${formatRelative(lastSeen)}.`}
        </p>
        {access.block === 'offline' && (
          <p className="mt-1 text-micro text-subtle-foreground">This page updates automatically when the device reconnects.</p>
        )}
      </div>
    </div>
  )
}

export function SearchField({
  value,
  onChange,
  placeholder,
  label,
  className,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  label: string
  className?: string
}) {
  return (
    <div className={cn('relative w-full sm:w-64', className)}>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-subtle-foreground" />
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className={cn('pl-8', value && 'pr-8')}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && value) {
            event.stopPropagation()
            onChange('')
          }
        }}
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange('')}
          className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-subtle-foreground hover:bg-surface-3 hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
}

/** Inline banner for agent errors (shown verbatim) and notices. */
export function InlineAlert({
  tone = 'critical',
  title,
  children,
  action,
  className,
}: {
  tone?: 'critical' | 'warning' | 'info'
  title: ReactNode
  children?: ReactNode
  action?: ReactNode
  className?: string
}) {
  const Icon = tone === 'info' ? Info : tone === 'warning' ? TriangleExclamationPoint : CircleExclamationPoint
  const styles = {
    critical: 'bg-critical/[0.06] ring-critical/25 [&_[data-icon]]:text-critical',
    warning: 'bg-warning/[0.07] ring-warning/25 [&_[data-icon]]:text-warning',
    info: 'bg-info/[0.06] ring-info/20 [&_[data-icon]]:text-info',
  }
  return (
    <div role={tone === 'critical' ? 'alert' : 'status'} className={cn('flex flex-wrap items-start gap-3 rounded-xl px-4 py-3 ring-1', styles[tone], className)}>
      <Icon data-icon="" className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 basis-56">
        <p className="text-dense font-medium">{title}</p>
        {children && <div className="mt-0.5 text-dense break-words text-muted-foreground">{children}</div>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  )
}

/** The standard error banner for a failed remote query, with the agent's message verbatim. */
export function QueryError({ error, onRetry, what }: { error: unknown; onRetry?: () => void; what: string }) {
  const agent = isApiError(error) && error.code === 'device_error'
  const timeout = isApiError(error) && error.code === 'device_timeout'
  return (
    <InlineAlert
      title={agent ? `The agent couldn’t load ${what}` : timeout ? 'The agent didn’t answer in time' : `Couldn’t load ${what}`}
      action={
        onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw data-icon="inline-start" />
            Try again
          </Button>
        )
      }
    >
      {agent ? <span className="font-mono text-[12px] text-foreground/85">{errorMessage(error)}</span> : errorMessage(error)}
    </InlineAlert>
  )
}

/** "Updated 4s ago", ticking. */
export function UpdatedAgo({ at, className }: { at: number; className?: string }) {
  const now = useNow(1000, at > 0)
  if (!at) return null
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  return (
    <span className={cn('tabular text-micro text-subtle-foreground', className)}>
      Updated {seconds < 5 ? 'just now' : seconds < 60 ? `${seconds}s ago` : formatRelative(at, now)}
    </span>
  )
}

/** Card frame shared by the tool panels. */
export function ToolFrame({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('overflow-hidden rounded-xl bg-card shadow-card', className)}>{children}</div>
}

export function ToolToolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap items-center gap-2', className)}>{children}</div>
}
