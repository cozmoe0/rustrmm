import { Link, useLocation } from '@tanstack/react-router'
import { BrandMark, ProductWordmark } from '@/components/brand/branding'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { PRIMARY_NAV, SETTINGS_NAV, isNavActive, visibleNav } from '@/lib/nav'
import { useMe } from '@/lib/permissions'
import { cn } from '@/lib/utils'
import { mobileNavStore, useMobileNavOpen } from './ui-state'

export function MobileNav() {
  const open = useMobileNavOpen()
  const { pathname } = useLocation()
  const me = useMe()

  return (
    <Sheet open={open} onOpenChange={(next) => mobileNavStore.set(next)}>
      <SheetContent side="left" className="w-72 gap-0 bg-rail p-0 text-rail-foreground">
        <SheetHeader className="border-b border-rail-border px-4 py-4">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <span className="inline-flex items-center gap-2.5 text-rail-foreground">
            <BrandMark surface="dark" />
            <ProductWordmark className="text-[15px]" />
          </span>
        </SheetHeader>
        <nav aria-label="Primary" className="flex-1 overflow-y-auto p-2">
          <ul className="grid gap-0.5">
            {[...visibleNav(PRIMARY_NAV, me?.permissions), SETTINGS_NAV].map((item) => {
              const Icon = item.icon
              const active = isNavActive(item, pathname)
              return (
                <li key={item.id}>
                  <Link
                    to={item.to}
                    onClick={() => mobileNavStore.set(false)}
                    className={cn(
                      'flex h-10 items-center gap-3 rounded-lg px-3 text-sm text-rail-muted outline-none hover:bg-rail-hover hover:text-rail-foreground focus-visible:ring-2 focus-visible:ring-ring',
                      active && 'bg-rail-hover text-rail-foreground',
                    )}
                  >
                    <Icon className={cn('size-[18px]', active && 'text-primary')} />
                    {item.label}
                    {item.phase && <span className="ml-auto text-micro text-rail-muted/80">Phase {item.phase}</span>}
                  </Link>
                </li>
              )
            })}
          </ul>
        </nav>
      </SheetContent>
    </Sheet>
  )
}
