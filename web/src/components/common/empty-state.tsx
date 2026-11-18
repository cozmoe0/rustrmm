import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Illustration, type IllustrationName } from './illustrations'

export function EmptyState({
  illustration,
  title,
  description,
  actions,
  children,
  className,
  compact = false,
}: {
  illustration?: IllustrationName
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  className?: string
  compact?: boolean
}) {
  return (
    <div
      className={cn(
        'relative flex flex-col items-center justify-center overflow-hidden rounded-xl border border-dashed border-border-strong text-center',
        compact ? 'gap-3 px-6 py-8' : 'gap-4 px-6 py-14',
        className,
      )}
    >
      <div className="bg-grid bg-grid-fade pointer-events-none absolute inset-0 opacity-70" />
      {illustration && <Illustration name={illustration} className={cn('relative', compact && 'h-20')} />}
      <div className="relative max-w-md">
        <h3 className="text-[15px] font-semibold tracking-tight">{title}</h3>
        {description && <p className="mt-1.5 text-dense text-muted-foreground">{description}</p>}
      </div>
      {children && <div className="relative w-full max-w-lg">{children}</div>}
      {actions && <div className="relative flex flex-wrap items-center justify-center gap-2">{actions}</div>}
    </div>
  )
}
