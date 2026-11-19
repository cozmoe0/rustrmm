import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useLocation, useNavigate, useSearch } from '@tanstack/react-router'
import {
  Bookmark,
  CircleDashed,
  CircleFadingArrowUp,
  Inbox,
  Layers,
  Rocket,
  Server,
  TriangleExclamationPoint,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react'
import { ContextGroup, ContextLink, ContextPanel } from '@/components/shell/context-panel'
import { StatusDot } from '@/components/common/status-dot'
import { agentUpdatesQuery, devicesQuery, fleetQuery } from '@/lib/api/queries'
import type { DeviceType, OsFamily } from '@/lib/api/types'
import {
  DEVICE_TYPE_LABEL,
  HEALTH_BAND_LABEL,
  OS_LABEL,
  PATCH_STATE_LABEL,
  PATCH_STATE_ORDER,
  deleteView,
  facetCounts,
  facetsFromSearch,
  searchFromFacets,
  toggleFacet,
  useSavedViews,
  type DeviceFacets,
  type FacetCounts,
  type HealthBand,
} from '@/lib/devices'
import { formatNumber } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useScope } from '@/lib/scope'
import { cn } from '@/lib/utils'
import { useWorkspaceTabs } from '@/lib/workspace'
import { OsIcon } from './device-ui'
import { useApplyFacets, useCurrentFacets } from './use-facets'

const OS_ORDER: OsFamily[] = ['windows', 'macos', 'linux']
const TYPE_ORDER: (DeviceType | 'unknown')[] = ['workstation', 'laptop', 'server', 'virtual']
const HEALTH_ORDER: HealthBand[] = ['good', 'fair', 'poor', 'unknown']
const HEALTH_DOT = { good: 'live', fair: 'warning', poor: 'critical', unknown: 'neutral' } as const
const PATCH_DOT = { compliant: 'live', non_compliant: 'warning', missing_critical: 'critical', failed: 'critical', pending_reboot: 'info', not_scanned: 'neutral' } as const

function FacetRow({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean
  onClick: () => void
  icon?: ReactNode
  label: ReactNode
  count?: number
}) {
  return (
    <li>
      <button
        type="button"
        aria-pressed={active}
        onClick={onClick}
        className={cn(
          'group flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-dense text-muted-foreground outline-none transition-colors',
          'hover:bg-surface-3 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
          active && 'bg-surface-3 font-medium text-foreground',
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border transition-colors',
            active ? 'border-primary bg-primary' : 'border-border-strong group-hover:border-subtle-foreground',
          )}
        >
          {active && <span className="size-1.5 rounded-[1px] bg-primary-foreground" />}
        </span>
        {icon}
        <span className="truncate">{label}</span>
        {count !== undefined && (
          <span className={cn('tabular ml-auto text-micro', count === 0 ? 'text-subtle-foreground/60' : 'text-subtle-foreground')}>
            {formatNumber(count)}
          </span>
        )}
      </button>
    </li>
  )
}

/** Facet checklists shared by the context panel and the mobile filter sheet. */
export function DeviceFacetSections({
  facets,
  counts,
  onChange,
}: {
  facets: DeviceFacets
  counts: FacetCounts
  onChange: (facets: DeviceFacets) => void
}) {
  const canPatches = hasPermission(useMe(), PERMISSIONS.patchesView)
  return (
    <>
      <ContextGroup label="Connection">
        <FacetRow
          active={facets.state === 'online'}
          onClick={() => onChange({ ...facets, state: facets.state === 'online' ? undefined : 'online' })}
          icon={<StatusDot tone="live" />}
          label="Online"
          count={counts.state.online}
        />
        <FacetRow
          active={facets.state === 'offline'}
          onClick={() => onChange({ ...facets, state: facets.state === 'offline' ? undefined : 'offline' })}
          icon={<StatusDot tone="offline" />}
          label="Offline"
          count={counts.state.offline}
        />
      </ContextGroup>
      <ContextGroup label="Operating system">
        {OS_ORDER.map((os) => (
          <FacetRow
            key={os}
            active={Boolean(facets.os?.includes(os))}
            onClick={() => onChange({ ...facets, os: toggleFacet(facets.os, os) })}
            icon={<OsIcon family={os} />}
            label={OS_LABEL[os]}
            count={counts.os[os]}
          />
        ))}
      </ContextGroup>
      <ContextGroup label="Device type">
        {TYPE_ORDER.filter((type) => type !== 'unknown' || counts.types.unknown > 0).map((type) => (
          <FacetRow
            key={type}
            active={Boolean(facets.types?.includes(type))}
            onClick={() => onChange({ ...facets, types: toggleFacet(facets.types, type) })}
            label={type === 'unknown' ? 'Unknown' : DEVICE_TYPE_LABEL[type]}
            count={counts.types[type]}
          />
        ))}
      </ContextGroup>
      <ContextGroup label="Health">
        {HEALTH_ORDER.map((band) => (
          <FacetRow
            key={band}
            active={Boolean(facets.health?.includes(band))}
            onClick={() => onChange({ ...facets, health: toggleFacet(facets.health, band) })}
            icon={<StatusDot tone={HEALTH_DOT[band]} />}
            label={HEALTH_BAND_LABEL[band]}
            count={counts.health[band]}
          />
        ))}
      </ContextGroup>
      {canPatches && (
        <ContextGroup label="Patch state">
          {PATCH_STATE_ORDER.map((state) => (
            <FacetRow key={state} active={facets.patch === state} onClick={() => onChange({ ...facets, patch: facets.patch === state ? undefined : state })} icon={<StatusDot tone={PATCH_DOT[state]} />} label={PATCH_STATE_LABEL[state]} />
          ))}
        </ContextGroup>
      )}
      {counts.tags.length > 0 && (
        <ContextGroup label="Tags">
          {counts.tags.slice(0, 8).map(([tag, count]) => (
            <FacetRow
              key={tag}
              active={facets.tag === tag}
              onClick={() => onChange({ ...facets, tag: facets.tag === tag ? undefined : tag })}
              label={<span className="font-mono text-[11.5px]">{tag}</span>}
              count={count}
            />
          ))}
        </ContextGroup>
      )}
    </>
  )
}

function ViewLink({
  active,
  onClick,
  icon,
  children,
  count,
}: {
  active: boolean
  onClick: () => void
  icon: ReactNode
  children: ReactNode
  count?: ReactNode
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'group flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-dense text-muted-foreground outline-none transition-colors',
          'hover:bg-surface-3 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
          '[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-subtle-foreground',
          active && 'bg-surface-3 font-medium text-foreground [&_svg]:text-primary',
        )}
      >
        {icon}
        <span className="truncate">{children}</span>
        {count !== undefined && <span className="tabular ml-auto text-micro text-subtle-foreground">{count}</span>}
      </button>
    </li>
  )
}

const QUICK_VIEWS: { id: string; label: string; icon: ReactNode; facets: DeviceFacets }[] = [
  { id: 'all', label: 'All devices', icon: <Layers />, facets: {} },
  { id: 'online', label: 'Online', icon: <Wifi />, facets: { state: 'online' } },
  { id: 'offline', label: 'Offline', icon: <WifiOff />, facets: { state: 'offline' } },
  { id: 'attention', label: 'Needs attention', icon: <TriangleExclamationPoint />, facets: { health: ['poor'] } },
  { id: 'servers', label: 'Servers & VMs', icon: <Server />, facets: { types: ['server', 'virtual'] } },
]

function sameFacets(a: DeviceFacets, b: DeviceFacets) {
  return JSON.stringify(searchFromFacets(a)) === JSON.stringify(searchFromFacets(b))
}

export function DevicesContextPanel() {
  const me = useMe()
  const { clientId, siteId } = useScope()
  const { data: devices = [] } = useQuery(devicesQuery({ client_id: clientId, site_id: siteId }))
  const { data: summary } = useQuery(fleetQuery(clientId, siteId))
  const { facets, onList } = useCurrentFacets()
  const applyFacets = useApplyFacets()
  const views = useSavedViews()
  const tabs = useWorkspaceTabs().filter((tab) => tab.kind === 'device')
  const counts = facetCounts(devices)
  const canDeploy = hasPermission(me, PERMISSIONS.agentsDeploy) || hasPermission(me, PERMISSIONS.agentsApprove)
  const pending = summary?.pending_approval ?? 0
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const deploySearch = useSearch({ strict: false }) as { section?: string }
  // Which deployment entry is current: null when another page is showing.
  const deploySection = pathname === '/devices/deploy' ? (deploySearch.section ?? 'keys') : null
  const onUpdates = pathname === '/devices/updates'
  const updates = useQuery({ ...agentUpdatesQuery({ client_id: clientId, site_id: siteId }), staleTime: 60_000 })
  const needUpdate = updates.data ? updates.data.summary.outdated + updates.data.summary.failed : 0
  const online = counts.state.online
  const total = devices.length

  const quickCount = (view: (typeof QUICK_VIEWS)[number]) =>
    view.id === 'all'
      ? total
      : view.id === 'online'
        ? counts.state.online
        : view.id === 'offline'
          ? counts.state.offline
          : view.id === 'attention'
            ? counts.health.poor
            : counts.types.server + counts.types.virtual

  return (
    <ContextPanel
      section="devices"
      title="Devices"
      footer={
        <div className="grid gap-2">
          <div className="flex items-baseline justify-between text-micro">
            <span className="text-subtle-foreground">Online</span>
            <span className="tabular font-medium">
              {formatNumber(online)} <span className="text-subtle-foreground">/ {formatNumber(total)}</span>
            </span>
          </div>
          <div className="flex h-1.5 overflow-hidden rounded-full bg-surface-4" aria-hidden="true">
            <span className="bg-live transition-[width] duration-700" style={{ width: total ? `${(online / total) * 100}%` : '0%' }} />
          </div>
        </div>
      }
    >
      <ContextGroup label="Views">
        {QUICK_VIEWS.map((view) => (
          <ViewLink
            key={view.id}
            active={onList && sameFacets(facets, view.facets)}
            onClick={() => applyFacets(view.facets)}
            icon={view.icon}
            count={formatNumber(quickCount(view))}
          >
            {view.label}
          </ViewLink>
        ))}
      </ContextGroup>

      <ContextGroup label="Agents">
        <ViewLink
          active={onUpdates}
          onClick={() => void navigate({ to: '/devices/updates', search: (prev) => ({ client: prev.client, site: prev.site }) })}
          icon={<CircleFadingArrowUp />}
          count={
            needUpdate > 0 ? (
              <span className="tabular rounded-full bg-warning/15 px-1.5 text-micro font-semibold text-warning">{formatNumber(needUpdate)}</span>
            ) : (
              '0'
            )
          }
        >
          Agent updates
        </ViewLink>
      </ContextGroup>

      {canDeploy && (
        <ContextGroup label="Deployment">
          <ViewLink
            active={deploySection !== null && deploySection !== 'approvals'}
            onClick={() => void navigate({ to: '/devices/deploy', search: (prev) => ({ client: prev.client, site: prev.site }) })}
            icon={<Rocket />}
          >
            Deploy agents
          </ViewLink>
          <ViewLink
            active={deploySection === 'approvals'}
            onClick={() =>
              void navigate({ to: '/devices/deploy', search: (prev) => ({ client: prev.client, site: prev.site, section: 'approvals' as const }) })
            }
            icon={pending > 0 ? <Inbox /> : <CircleDashed />}
            count={
              pending > 0 ? (
                <span className="tabular rounded-full bg-info/15 px-1.5 text-micro font-semibold text-info">{pending}</span>
              ) : (
                '0'
              )
            }
          >
            Awaiting approval
          </ViewLink>
        </ContextGroup>
      )}

      {views.length > 0 && (
        <ContextGroup label="Saved views">
          {views.map((view) => {
            const viewFacets = facetsFromSearch(view.search)
            return (
              <li key={view.id} className="group/view relative">
                <button
                  type="button"
                  onClick={() => applyFacets(viewFacets)}
                  className={cn(
                    'flex h-8 w-full items-center gap-2.5 rounded-md px-2 pr-8 text-left text-dense text-muted-foreground outline-none transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
                    onList && sameFacets(facets, viewFacets) && 'bg-surface-3 font-medium text-foreground',
                  )}
                >
                  <Bookmark className="size-4 shrink-0 text-subtle-foreground" />
                  <span className="truncate">{view.name}</span>
                </button>
                <button
                  type="button"
                  aria-label={`Delete saved view ${view.name}`}
                  onClick={() => deleteView(view.id)}
                  className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-subtle-foreground opacity-0 outline-none group-hover/view:opacity-100 hover:bg-surface-4 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="size-3" />
                </button>
              </li>
            )
          })}
        </ContextGroup>
      )}

      <DeviceFacetSections facets={facets} counts={counts} onChange={applyFacets} />

      {tabs.length > 0 && (
        <ContextGroup label="Open in workspace">
          {tabs.map((tab) => (
            <ContextLink key={tab.id} to="/devices/$deviceId" params={tab.params} icon={<OsIconForTab family={tab.meta?.os} />}>
              {tab.title}
            </ContextLink>
          ))}
        </ContextGroup>
      )}
    </ContextPanel>
  )
}

function OsIconForTab({ family }: { family: string | null | undefined }) {
  if (family === 'windows' || family === 'macos' || family === 'linux') return <OsIcon family={family} />
  return <Server />
}
