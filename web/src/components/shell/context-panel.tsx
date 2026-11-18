import type { ReactNode } from 'react'
import type { RoutePath } from '@/lib/nav'
import { Link } from '@tanstack/react-router'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useContextPanelCollapsed } from './ui-state'

/** The collapsible 240px secondary navigation column used by sections such as Settings. */
export function ContextPanel({
  section,
  title,
  children,
  footer,
}: {
  section: string
  title: string
  children: ReactNode
  footer?: ReactNode
}) {
  const { collapsed, toggle } = useContextPanelCollapsed(section)

  if (collapsed) {
    return (
      <div className="hidden w-11 shrink-0 flex-col items-center border-r border-border bg-surface-1/50 py-3 md:flex">
        <Tooltip>
          <TooltipTrigger
            render={<Button variant="ghost" size="icon-sm" onClick={toggle} aria-label={`Expand ${title} panel`} />}
          >
            <PanelLeftOpen />
          </TooltipTrigger>
          <TooltipContent side="right">Expand panel</TooltipContent>
        </Tooltip>
      </div>
    )
  }

  return (
    <aside
      aria-label={`${title} navigation`}
      className="hidden w-60 shrink-0 flex-col border-r border-border bg-surface-1/50 md:flex"
    >
      <div className="flex h-11 items-center justify-between px-4">
        <span className="eyebrow">{title}</span>
        <Button variant="ghost" size="icon-xs" onClick={toggle} aria-label={`Collapse ${title} panel`}>
          <PanelLeftClose />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-3">{children}</div>
      {footer && <div className="border-t border-border p-3">{footer}</div>}
    </aside>
  )
}

export function ContextGroup({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="mb-3">
      {label && <div className="px-2 pt-2 pb-1 text-micro font-medium text-subtle-foreground">{label}</div>}
      <ul className="grid gap-px">{children}</ul>
    </div>
  )
}

export function ContextLink({
  to,
  icon,
  children,
  badge,
  search,
  params,
  activeExact = false,
}: {
  to: RoutePath
  params?: Record<string, string>
  icon?: ReactNode
  children: ReactNode
  badge?: ReactNode
  search?: Record<string, unknown>
  activeExact?: boolean
}) {
  return (
    <li>
      <Link
        to={to}
        search={search as never}
        params={params as never}
        activeOptions={{ exact: activeExact, includeSearch: false }}
        className={cn(
          'group flex h-8 items-center gap-2.5 rounded-md px-2 text-dense text-muted-foreground outline-none transition-colors',
          'hover:bg-surface-3 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
          'data-[status=active]:bg-surface-3 data-[status=active]:font-medium data-[status=active]:text-foreground',
          '[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-subtle-foreground data-[status=active]:[&_svg]:text-primary',
        )}
      >
        {icon}
        <span className="truncate">{children}</span>
        {badge && <span className="ml-auto">{badge}</span>}
      </Link>
    </li>
  )
}
