import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, Outlet, useLocation, useSearch } from '@tanstack/react-router'
import { BellRing, CircleCheck, Inbox, Layers, OctagonAlert, Settings2, UserRound, UserRoundX, Wrench } from 'lucide-react'
import { ContextGroup, ContextLink, ContextPanel } from '@/components/shell/context-panel'
import { alertsApi } from '@/lib/api/endpoints'
import { maintenanceWindowsQuery } from '@/lib/api/queries'
import { formatNumber } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useScope } from '@/lib/scope'
import { cn } from '@/lib/utils'
import type { AlertsSearch } from './alerts-page'

interface InboxView {
  id: string
  label: string
  icon: ReactNode
  search: AlertsSearch
}

const VIEWS: InboxView[] = [
  { id: 'open', label: 'Open', icon: <Inbox />, search: {} },
  { id: 'mine', label: 'Assigned to me', icon: <UserRound />, search: { assigned: 'me' } },
  { id: 'unassigned', label: 'Unassigned', icon: <UserRoundX />, search: { assigned: 'none' } },
  { id: 'critical', label: 'Critical', icon: <OctagonAlert />, search: { severity: 'critical' } },
  { id: 'resolved', label: 'Resolved', icon: <CircleCheck />, search: { status: 'resolved' } },
  { id: 'all', label: 'Everything', icon: <Layers />, search: { status: 'all' } },
]

/** A view is active when the inbox's view-defining filters equal its own. */
function viewMatches(view: InboxView, search: AlertsSearch) {
  const keys = ['status', 'severity', 'assigned', 'source', 'check_type'] as const
  return keys.every((key) => (search[key] ?? undefined) === (view.search[key] ?? undefined))
}

function Count({ value, tone }: { value: number | undefined; tone?: 'critical' | 'neutral' }) {
  if (!value) return null
  return (
    <span
      className={cn(
        'tabular inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[10.5px] font-semibold',
        tone === 'critical' ? 'bg-critical/15 text-critical ring-1 ring-critical/30' : 'bg-surface-4 text-muted-foreground',
      )}
    >
      {formatNumber(value)}
    </span>
  )
}

function ViewLink({ view, active, badge }: { view: InboxView; active: boolean; badge?: ReactNode }) {
  return (
    <li>
      <Link
        to="/alerts"
        search={(prev) => ({ client: (prev as { client?: string }).client, site: (prev as { site?: string }).site, ...view.search })}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'group flex h-8 items-center gap-2.5 rounded-md px-2 text-dense text-muted-foreground outline-none transition-colors',
          'hover:bg-surface-3 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
          '[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-subtle-foreground',
          active && 'bg-surface-3 font-medium text-foreground [&_svg]:text-primary',
        )}
      >
        {view.icon}
        <span className="truncate">{view.label}</span>
        {badge && <span className="ml-auto">{badge}</span>}
      </Link>
    </li>
  )
}

/** Counts for a view in the current scope: `counts` ignore status and severity, so one row is enough. */
function useViewCounts(assigned: 'me' | 'none' | undefined, clientId: string | undefined, siteId: string | undefined, enabled: boolean) {
  const { data } = useQuery({
    queryKey: ['alerts', 'counts', assigned ?? 'any', clientId ?? 'all', siteId ?? 'all'],
    queryFn: () => alertsApi.list({ assigned, client_id: clientId, site_id: siteId, limit: 1 }),
    enabled,
    refetchInterval: 60_000,
    meta: { silent: true },
  })
  return data?.counts
}

export function AlertsLayout() {
  const me = useMe()
  const { pathname } = useLocation()
  const search = useSearch({ strict: false }) as AlertsSearch
  const { clientId, siteId } = useScope()
  const canView = hasPermission(me, PERMISSIONS.alertsView)
  const { data: windows } = useQuery({ ...maintenanceWindowsQuery, enabled: canView, meta: { silent: true } })
  const all = useViewCounts(undefined, clientId, siteId, canView)
  const mine = useViewCounts('me', clientId, siteId, canView)
  const unassigned = useViewCounts('none', clientId, siteId, canView)
  const live = (counts: typeof all) => (counts ? counts.open + counts.acknowledged : undefined)
  const onInbox = pathname === '/alerts' || pathname === '/alerts/'
  const activeWindows = windows?.filter((window) => window.active_now).length ?? 0
  const badges: Record<string, ReactNode> = {
    open: <Count value={live(all)} />,
    mine: <Count value={live(mine)} />,
    unassigned: <Count value={live(unassigned)} />,
    critical: <Count value={all?.critical} tone="critical" />,
  }

  return (
    <div className="flex h-full">
      <ContextPanel section="alerts" title="Alerts">
        <ContextGroup label="Inbox">
          {VIEWS.map((view) => (
            <ViewLink key={view.id} view={view} active={onInbox && viewMatches(view, search)} badge={badges[view.id]} />
          ))}
        </ContextGroup>
        <ContextGroup label="Configure">
          <ContextLink
            to="/alerts/maintenance"
            icon={<Wrench />}
            badge={
              activeWindows > 0 && (
                <span
                  className="tabular inline-flex h-[18px] items-center gap-1 rounded-full bg-live/12 px-1.5 text-[10.5px] font-semibold whitespace-nowrap text-live ring-1 ring-live/25"
                  title={`${activeWindows} active now`}
                >
                  <span className="size-1.5 animate-pulse-ring rounded-full bg-live text-live" />
                  {activeWindows}
                </span>
              )
            }
          >
            Maintenance
          </ContextLink>
          {hasPermission(me, PERMISSIONS.notificationsManage) && (
            <ContextLink to="/settings/notifications" icon={<BellRing />}>
              Notifications
            </ContextLink>
          )}
          {hasPermission(me, PERMISSIONS.settingsView) && (
            <ContextLink to="/settings/monitoring" icon={<Settings2 />}>
              Monitoring settings
            </ContextLink>
          )}
        </ContextGroup>
      </ContextPanel>
      <div className="flex min-w-0 flex-1 flex-col">
        <nav
          aria-label="Alerts sections"
          className="flex shrink-0 [scrollbar-width:none] gap-1 overflow-x-auto border-b border-border bg-surface-1/60 px-3 py-2 md:hidden"
        >
          {[
            { to: '/alerts' as const, label: 'Inbox', icon: <Inbox />, active: onInbox },
            { to: '/alerts/maintenance' as const, label: 'Maintenance', icon: <Wrench />, active: pathname.startsWith('/alerts/maintenance') },
          ].map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={cn(
                'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-dense text-muted-foreground outline-none hover:bg-surface-3 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5',
                item.active && 'bg-surface-3 font-medium text-foreground',
              )}
            >
              {item.icon}
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
