/* The Reports section frame: library, run history and schedules. */
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, Outlet } from '@tanstack/react-router'
import { CalendarClock, History, LibraryBig } from 'lucide-react'
import { ContextGroup, ContextLink, ContextPanel } from '@/components/shell/context-panel'
import { EmptyState } from '@/components/common/empty-state'
import { PageContainer } from '@/components/common/page-header'
import { reportRunsQuery, reportSchedulesQuery } from '@/lib/api/queries'
import type { RoutePath } from '@/lib/nav'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { cn } from '@/lib/utils'

function CountPill({ value, tone }: { value: number; tone: 'critical' | 'live' }) {
  if (!value) return null
  return (
    <span
      className={cn(
        'tabular inline-flex h-[18px] items-center gap-1 rounded-full px-1.5 text-[10.5px] font-semibold ring-1',
        tone === 'critical' ? 'bg-critical/12 text-critical ring-critical/25' : 'bg-live/12 text-live ring-live/25',
      )}
    >
      {tone === 'live' && <span className="size-1.5 animate-pulse-ring rounded-full bg-live text-live" />}
      {value}
    </span>
  )
}

export function ReportsLayout() {
  const me = useMe()
  const canView = hasPermission(me, PERMISSIONS.reportsView)
  const canManage = hasPermission(me, PERMISSIONS.reportsManage)
  const { data: runs } = useQuery({ ...reportRunsQuery(100), enabled: canView, meta: { silent: true } })
  const { data: schedules } = useQuery({ ...reportSchedulesQuery, enabled: canManage, meta: { silent: true } })
  const active = (runs ?? []).filter((run) => run.status === 'queued' || run.status === 'running').length
  const failing = (schedules ?? []).filter((schedule) => schedule.enabled && schedule.last_status === 'failed').length
  const items: { to: RoutePath; label: string; icon: ReactNode; exact?: boolean; badge?: ReactNode }[] = [
    { to: '/reports', label: 'Library', icon: <LibraryBig />, exact: true },
    { to: '/reports/runs', label: 'Run history', icon: <History />, badge: <CountPill value={active} tone="live" /> },
    ...(canManage ? [{ to: '/reports/schedules' as const, label: 'Schedules', icon: <CalendarClock />, badge: <CountPill value={failing} tone="critical" /> }] : []),
  ]

  return (
    <div className="flex h-full">
      <ContextPanel section="reports" title="Reports">
        <ContextGroup label="Reports">
          {items.map((item) => (
            <ContextLink key={item.to} to={item.to} icon={item.icon} activeExact={item.exact} badge={item.badge}>
              {item.label}
            </ContextLink>
          ))}
        </ContextGroup>
      </ContextPanel>
      <div className="flex min-w-0 flex-1 flex-col">
        <nav aria-label="Reports sections" className="flex shrink-0 [scrollbar-width:none] gap-1 overflow-x-auto border-b border-border bg-surface-1/60 px-3 py-2 md:hidden">
          {items.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ exact: Boolean(item.exact), includeSearch: false }}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-dense text-muted-foreground outline-none hover:bg-surface-3 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[status=active]:bg-surface-3 data-[status=active]:font-medium data-[status=active]:text-foreground [&_svg]:size-3.5"
            >
              {item.icon}
              {item.label}
              {item.badge}
            </Link>
          ))}
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {canView ? (
            <Outlet />
          ) : (
            <PageContainer>
              <EmptyState illustration="reports" title="You can’t run reports" description="Reports need the “View reports” permission, plus the view permission of each report’s data. Ask an administrator for access." />
            </PageContainer>
          )}
        </div>
      </div>
    </div>
  )
}
