import { cn } from '@/lib/utils'

export type StatusTone = 'live' | 'offline' | 'success' | 'warning' | 'critical' | 'info' | 'neutral'

const TONES: Record<StatusTone, string> = {
  live: 'text-live bg-live',
  offline: 'text-subtle-foreground bg-subtle-foreground/70',
  success: 'text-success bg-success',
  warning: 'text-warning bg-warning',
  critical: 'text-critical bg-critical',
  info: 'text-info bg-info',
  neutral: 'text-muted-foreground bg-muted-foreground',
}

export function StatusDot({
  tone,
  pulse = false,
  className,
  label,
}: {
  tone: StatusTone
  pulse?: boolean
  className?: string
  /** Accessible text; the dot alone is decorative. */
  label?: string
}) {
  return (
    <span className={cn('relative inline-flex size-2 shrink-0 rounded-full', TONES[tone], pulse && 'animate-pulse-ring', className)}>
      {label && <span className="sr-only">{label}</span>}
    </span>
  )
}
