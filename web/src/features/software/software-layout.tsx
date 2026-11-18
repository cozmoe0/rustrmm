import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, Outlet } from '@tanstack/react-router'
import { Compass, Library, Rocket } from 'lucide-react'
import { ContextGroup, ContextLink, ContextPanel } from '@/components/shell/context-panel'
import { EmptyState } from '@/components/common/empty-state'
import { PageContainer } from '@/components/common/page-header'
import { deploymentsQuery } from '@/lib/api/queries'
import type { RoutePath } from '@/lib/nav'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'

const NAV: { to: RoutePath; label: string; icon: ReactNode; exact?: boolean }[] = [
  { to: '/software', label: 'Explorer', icon: <Compass />, exact: true },
  { to: '/software/library', label: 'Library', icon: <Library /> },
  { to: '/software/deployments', label: 'Deployments', icon: <Rocket /> },
]

export function SoftwareLayout() {
  const me = useMe()
  const canView = hasPermission(me, PERMISSIONS.softwareView)
  const { data: deployments } = useQuery({ ...deploymentsQuery(100), enabled: canView, meta: { silent: true } })
  const running = deployments?.filter((deployment) => deployment.status === 'running').length ?? 0
  const badge = running ? (
    <span className="tabular inline-flex h-[18px] items-center gap-1 rounded-full bg-live/12 px-1.5 text-[10.5px] font-semibold text-live ring-1 ring-live/25" title={`${running} running`}>
      <span className="size-1.5 animate-pulse-ring rounded-full bg-live text-live" />
      {running}
    </span>
  ) : null

  return (
    <div className="flex h-full">
      <ContextPanel section="software" title="Software">
        <ContextGroup label="Software">
          {NAV.map((item) => (
            <ContextLink key={item.to} to={item.to} icon={item.icon} activeExact={item.exact} badge={item.to === '/software/deployments' ? badge : undefined}>
              {item.label}
            </ContextLink>
          ))}
        </ContextGroup>
      </ContextPanel>
      <div className="flex min-w-0 flex-1 flex-col">
        <nav aria-label="Software sections" className="flex shrink-0 [scrollbar-width:none] gap-1 overflow-x-auto border-b border-border bg-surface-1/60 px-3 py-2 md:hidden">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ exact: Boolean(item.exact), includeSearch: false }}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-dense text-muted-foreground outline-none hover:bg-surface-3 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[status=active]:bg-surface-3 data-[status=active]:font-medium data-[status=active]:text-foreground [&_svg]:size-3.5"
            >
              {item.icon}
              {item.label}
              {item.to === '/software/deployments' && badge}
            </Link>
          ))}
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {canView ? (
            <Outlet />
          ) : (
            <PageContainer>
              <EmptyState illustration="software" title="You can’t see software" description="The explorer, library and deployments need the “View software” permission. Ask an administrator for access." />
            </PageContainer>
          )}
        </div>
      </div>
    </div>
  )
}
