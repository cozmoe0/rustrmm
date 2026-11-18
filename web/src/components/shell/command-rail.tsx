import { Link, useLocation } from '@tanstack/react-router'
import { Moon, Sun } from 'lucide-react'
import { BrandMark } from '@/components/brand/branding'
import { useProductName } from '@/lib/branding'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { PRIMARY_NAV, SETTINGS_NAV, isNavActive, visibleNav, type NavItem } from '@/lib/nav'
import { useMe } from '@/lib/permissions'
import { useTheme } from '@/lib/theme'
import { cn } from '@/lib/utils'
import { NotificationsButton } from './notifications'
import { UserMenu } from './user-menu'

function RailLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            to={item.to}
            aria-label={item.label}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'group relative flex size-10 items-center justify-center rounded-lg text-rail-muted outline-none transition-colors duration-150',
              'hover:bg-rail-hover hover:text-rail-foreground focus-visible:ring-2 focus-visible:ring-ring',
              active && 'bg-rail-hover text-rail-foreground',
            )}
          />
        }
      >
        <span
          aria-hidden="true"
          className={cn(
            'absolute top-1/2 -left-2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-primary transition-all duration-200 ease-(--ease-snappy)',
            active ? 'opacity-100' : 'h-0 opacity-0',
          )}
        />
        <Icon className="size-[18px]" strokeWidth={active ? 2 : 1.75} />
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={10}>
        <span className="font-medium">{item.label}</span>
        {item.shortcut && <span className="ml-2 font-mono text-[10px] opacity-60">{item.shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  )
}

function ThemeButton() {
  const { resolved, toggle } = useTheme()
  const Icon = resolved === 'dark' ? Sun : Moon
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={toggle}
            aria-label={resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            className="flex size-10 items-center justify-center rounded-lg text-rail-muted outline-none transition-colors hover:bg-rail-hover hover:text-rail-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        <Icon className="size-[18px]" strokeWidth={1.75} />
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={10}>
        {resolved === 'dark' ? 'Light theme' : 'Dark theme'}
      </TooltipContent>
    </Tooltip>
  )
}

export function CommandRail() {
  const { pathname } = useLocation()
  const me = useMe()
  const productName = useProductName()

  return (
    <nav
      aria-label="Primary"
      className="hidden w-14 shrink-0 flex-col items-center border-r border-rail-border bg-rail py-3 md:flex"
    >
      <Link
        to="/"
        aria-label={`${productName} home`}
        className="mb-4 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <BrandMark surface="dark" className="size-8 max-w-8 rounded-md" />
      </Link>

      <div className="flex flex-1 flex-col items-center gap-1 overflow-y-auto">
        {visibleNav(PRIMARY_NAV, me?.permissions).map((item) => (
          <RailLink key={item.id} item={item} active={isNavActive(item, pathname)} />
        ))}
      </div>

      <div className="mt-3 flex flex-col items-center gap-1 border-t border-rail-border pt-3">
        <RailLink item={SETTINGS_NAV} active={isNavActive(SETTINGS_NAV, pathname)} />
        <NotificationsButton />
        <ThemeButton />
        <UserMenu />
      </div>
    </nav>
  )
}
