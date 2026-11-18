import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, Outlet } from '@tanstack/react-router'
import { Activity, Boxes, FileSliders, Gauge, KeyRound, RadioTower, Satellite, ScanSearch, Waypoints } from 'lucide-react'
import { ContextGroup, ContextLink, ContextPanel } from '@/components/shell/context-panel'
import { EmptyState } from '@/components/common/empty-state'
import { PageContainer } from '@/components/common/page-header'
import { scansQuery, snmpDevicesQuery } from '@/lib/api/queries'
import type { RoutePath } from '@/lib/nav'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useScope } from '@/lib/scope'
import { useScopedSites } from './use-network'

interface NavItem {
  to: RoutePath
  label: string
  icon: ReactNode
  exact?: boolean
}

const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: 'Discovery',
    items: [
      { to: '/network', label: 'Overview', icon: <Gauge />, exact: true },
      { to: '/network/assets', label: 'Discovered assets', icon: <Boxes /> },
      { to: '/network/scans', label: 'Scans', icon: <ScanSearch /> },
      { to: '/network/topology', label: 'Topology', icon: <Waypoints /> },
    ],
  },
  {
    group: 'SNMP',
    items: [
      { to: '/network/snmp', label: 'Devices', icon: <Activity /> },
      { to: '/network/traps', label: 'Traps', icon: <RadioTower /> },
    ],
  },
  {
    group: 'Configure',
    items: [
      { to: '/network/probes', label: 'Probes', icon: <Satellite /> },
      { to: '/network/credentials', label: 'Credentials', icon: <KeyRound /> },
      { to: '/network/templates', label: 'Templates', icon: <FileSliders /> },
    ],
  },
]

function CountPill({ value, tone }: { value: number; tone: 'critical' | 'live' }) {
  if (!value) return null
  return (
    <span
      className={
        tone === 'critical'
          ? 'tabular inline-flex h-[18px] items-center rounded-full bg-critical/12 px-1.5 text-[10.5px] font-semibold text-critical ring-1 ring-critical/25'
          : 'tabular inline-flex h-[18px] items-center gap-1 rounded-full bg-live/12 px-1.5 text-[10.5px] font-semibold text-live ring-1 ring-live/25'
      }
    >
      {tone === 'live' && <span className="size-1.5 animate-pulse-ring rounded-full bg-live text-live" />}
      {value}
    </span>
  )
}

export function NetworkLayout() {
  const me = useMe()
  const { clientId } = useScope()
  const canView = hasPermission(me, PERMISSIONS.networkView)
  const { data: devices } = useQuery({ ...snmpDevicesQuery(), enabled: canView, meta: { silent: true } })
  const { data: scans } = useQuery({ ...scansQuery, enabled: canView, meta: { silent: true } })
  const { byId } = useScopedSites()
  const inScope = (devices ?? []).filter((device) => !clientId || byId.has(device.site_id))
  const troubled = inScope.filter((device) => device.enabled && (device.status === 'unreachable' || device.status === 'alerting')).length
  const running = (scans ?? []).filter((scan) => scan.last_run?.status === 'running').length
  const badges: Partial<Record<string, ReactNode>> = {
    '/network/snmp': <CountPill value={troubled} tone="critical" />,
    '/network/scans': <CountPill value={running} tone="live" />,
  }
  const items = NAV.flatMap((section) => section.items)

  return (
    <div className="flex h-full">
      <ContextPanel section="network" title="Network">
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
          aria-label="Network sections"
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
                illustration="network"
                title="You can’t see the network"
                description="Discovered assets, SNMP devices and traps need the “View network” permission. Ask an administrator for access."
              />
            </PageContainer>
          )}
        </div>
      </div>
    </div>
  )
}
