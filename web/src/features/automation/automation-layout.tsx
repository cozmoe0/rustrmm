import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, Outlet } from '@tanstack/react-router'
import { Boxes, FileCode, Inbox, ListChecks, ScrollText, Settings2, SlidersHorizontal, Variable } from 'lucide-react'
import { ContextGroup, ContextLink, ContextPanel } from '@/components/shell/context-panel'
import { jobsApi } from '@/lib/api/endpoints'
import type { RoutePath } from '@/lib/nav'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { cn } from '@/lib/utils'
import { usePendingApprovals } from './use-automation-live'

interface AutomationNavItem {
  to: RoutePath
  label: string
  icon: ReactNode
  permission: string | null
}

const AUTOMATION_NAV: { group: string; items: AutomationNavItem[] }[] = [
  {
    group: 'Run',
    items: [
      { to: '/automation/scripts', label: 'Scripts', icon: <FileCode />, permission: PERMISSIONS.scriptsView },
      { to: '/automation/jobs', label: 'Jobs', icon: <ListChecks />, permission: PERMISSIONS.scriptsView },
      { to: '/automation/approvals', label: 'Approvals', icon: <Inbox />, permission: PERMISSIONS.scriptsView },
    ],
  },
  {
    group: 'Configure',
    items: [
      { to: '/automation/variables', label: 'Variables', icon: <Variable />, permission: PERMISSIONS.scriptsView },
      { to: '/automation/groups', label: 'Device groups', icon: <Boxes />, permission: PERMISSIONS.devicesView },
      { to: '/automation/policies', label: 'Policies', icon: <ScrollText />, permission: PERMISSIONS.devicesView },
    ],
  },
  {
    group: 'Administration',
    items: [
      {
        to: '/automation/settings',
        label: 'Automation settings',
        icon: <Settings2 />,
        permission: PERMISSIONS.settingsView,
      },
      { to: '/settings/custom-fields', label: 'Custom fields', icon: <SlidersHorizontal />, permission: null },
    ],
  },
]

function CountBadge({ value, tone = 'neutral' }: { value: number; tone?: 'neutral' | 'warning' | 'live' }) {
  if (!value) return null
  return (
    <span
      className={cn(
        'tabular inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[10.5px] font-semibold',
        tone === 'warning'
          ? 'bg-warning/15 text-warning ring-1 ring-warning/30'
          : tone === 'live'
            ? 'bg-live/12 text-live ring-1 ring-live/25'
            : 'bg-surface-4 text-muted-foreground',
      )}
    >
      {value}
    </span>
  )
}

function useRunningCount(enabled: boolean) {
  const { data } = useQuery({
    queryKey: ['jobs', 'list', { status: 'running', limit: 200 }],
    queryFn: () => jobsApi.list({ status: 'running', limit: 200 }),
    enabled,
    refetchInterval: 30_000,
    meta: { silent: true },
  })
  return data?.items.length ?? 0
}

export function AutomationLayout() {
  const me = useMe()
  const approvals = usePendingApprovals()
  const running = useRunningCount(hasPermission(me, PERMISSIONS.scriptsView))
  const badges: Partial<Record<string, ReactNode>> = {
    '/automation/approvals': <CountBadge value={approvals.count} tone="warning" />,
    '/automation/jobs': <CountBadge value={running} tone="live" />,
  }
  const visible = AUTOMATION_NAV.map((section) => ({
    ...section,
    items: section.items.filter((item) => !item.permission || hasPermission(me, item.permission)),
  })).filter((section) => section.items.length > 0)

  return (
    <div className="flex h-full">
      <ContextPanel section="automation" title="Automation">
        {visible.map((section) => (
          <ContextGroup key={section.group} label={section.group}>
            {section.items.map((item) => (
              <ContextLink key={item.to} to={item.to} icon={item.icon} badge={badges[item.to]}>
                {item.label}
              </ContextLink>
            ))}
          </ContextGroup>
        ))}
      </ContextPanel>
      <div className="flex min-w-0 flex-1 flex-col">
        <nav
          aria-label="Automation sections"
          className="flex shrink-0 [scrollbar-width:none] gap-1 overflow-x-auto border-b border-border bg-surface-1/60 px-3 py-2 md:hidden"
        >
          {visible
            .flatMap((section) => section.items)
            .map((item) => (
              <Link
                key={item.to}
                to={item.to}
                activeOptions={{ exact: false, includeSearch: false }}
                className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-dense text-muted-foreground outline-none hover:bg-surface-3 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[status=active]:bg-surface-3 data-[status=active]:font-medium data-[status=active]:text-foreground [&_svg]:size-3.5"
              >
                {item.icon}
                {item.label}
                {badges[item.to]}
              </Link>
            ))}
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
