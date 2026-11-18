import type { ReactNode } from 'react'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'

/** Right-side quick-look drawer used from lists (space bar on a focused row). */
export function InspectorDrawer({
  open,
  onOpenChange,
  title,
  description,
  icon,
  actions,
  children,
  className,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  icon?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className={cn('w-full gap-0 p-0 shadow-popover sm:max-w-[440px]', className)}>
        <SheetHeader className="border-b border-border px-5 pt-5 pb-4">
          <div className="flex items-start gap-3 pr-8">
            {icon}
            <div className="min-w-0">
              <SheetTitle className="truncate text-base">{title}</SheetTitle>
              {description && <SheetDescription className="mt-0.5">{description}</SheetDescription>}
            </div>
          </div>
          {actions && <div className="mt-3 flex flex-wrap gap-2">{actions}</div>}
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </SheetContent>
    </Sheet>
  )
}
