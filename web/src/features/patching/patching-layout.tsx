import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, Outlet } from '@tanstack/react-router'
import { Gauge, History, ListChecks, ScrollText, Sparkles } from 'lucide-react'
import { ContextGroup, ContextLink, ContextPanel } from '@/components/shell/context-panel'
import { EmptyState } from '@/components/common/empty-state'
import { PageContainer } from '@/components/common/page-header'
import { patchRunsQuery } from '@/lib/api/queries'
import type { RoutePath } from '@/lib/nav'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'

interface NavItem {
  to: RoutePath
  label: string
  icon: ReactNode
  exact?: boolean
}

const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: 'Patching',
    items: [
      { to: '/patching', label: 'Overview', icon: <Gauge />, exact: true },
      { to: '/patching/updates', label: 'Updates', icon: <ListChecks /> },
      { to: '/patching/runs', label: 'Patch runs', icon: <History /> },
    ],
  },
  {
    group: 'Configure',
    items: [
      { to: '/patching/rules', label: 'Approval rules', icon: <Sparkles /> },
      { to: '/automation/policies', label: 'Patch policies', icon: <ScrollText /> },
    ],
  },
]

function LiveCount({ value }: { value: number }) {
  if (!value) return null
  return (
    <span className="tabular inline-flex h-[18px] items-center gap-1 rounded-full bg-live/12 px-1.5 text-[10.5px] font-semibold whitespace-nowrap text-live ring-1 ring-live/25" title={`${value} running`}>
      <span className="size-1.5 animate-pulse-ring rounded-full bg-live text-live" />
      {value}
    </span>
  )
}

export function PatchingLayout() {
  const me = useMe()
  const canView = hasPermission(me, PERMISSIONS.patchesView)
  const { data: runs } = useQuery({ ...patchRunsQuery(50), enabled: canView, meta: { silent: true } })
  const running = runs?.filter((run) => run.status === 'running').length ?? 0
  const badges: Partial<Record<string, ReactNode>> = { '/patching/runs': <LiveCount value={running} /> }
  const items = NAV.flatMap((section) => section.items)

  return (
    <div className="flex h-full">
      <ContextPanel section="patching" title="Patching">
        {NAV.map((section) => (
          <ContextGroup key={section.group} label={section.group}>
            {section.items.map((item) => (
              <ContextLink key={item.to} to={item.to} icon={item.icon} badge={badges[item.to]} activeExact={item.exact}>
                {item.label}
              </ContextLink>
            ))}
          </ContextGroup>
        ))}
      </ContextPanel>
      <div className="flex min-w-0 flex-1 flex-col">
        <nav
          aria-label="Patching sections"
          className="flex shrink-0 [scrollbar-width:none] gap-1 overflow-x-auto border-b border-border bg-surface-1/60 px-3 py-2 md:hidden"
        >
          {items.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ exact: Boolean(item.exact), includeSearch: false }}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-dense text-muted-foreground outline-none hover:bg-surface-3 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[status=active]:bg-surface-3 data-[status=active]:font-medium data-[status=active]:text-foreground [&_svg]:size-3.5"
            >
              {item.icon}
              {item.label}
              {badges[item.to]}
            </Link>
          ))}
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {canView ? (
            <Outlet />
          ) : (
            <PageContainer>
              <EmptyState
                illustration="patching"
                title="You can’t see patching"
                description="Patch status, the update catalog and compliance need the “View patches” permission. Ask an administrator for access."
              />
            </PageContainer>
          )}
        </div>
      </div>
    </div>
  )
}
