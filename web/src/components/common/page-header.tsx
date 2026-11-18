import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  icon,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  eyebrow?: ReactNode
  actions?: ReactNode
  icon?: ReactNode
  className?: string
}) {
  return (
    <header className={cn('flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between', className)}>
      <div className="flex min-w-0 items-start gap-3.5">
        {icon && (
          <div className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted-foreground shadow-raised [&_svg]:size-5">
            {icon}
          </div>
        )}
        <div className="min-w-0">
          {eyebrow && <div className="eyebrow mb-1">{eyebrow}</div>}
          <h1 className="font-display truncate text-[22px] leading-tight font-semibold text-foreground">{title}</h1>
          {description && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}

/** Standard page body width and padding. */
export function PageContainer({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mx-auto w-full max-w-[1440px] px-4 py-5 sm:px-6 sm:py-6', className)}>{children}</div>
}

export function SectionTitle({
  children,
  description,
  actions,
  className,
}: {
  children: ReactNode
  description?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex items-end justify-between gap-4', className)}>
      <div>
        <h2 className="text-[15px] font-semibold tracking-tight">{children}</h2>
        {description && <p className="mt-0.5 text-dense text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}
