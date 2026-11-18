/* The "Remote" area of the device cockpit: tool switcher, gating and the tool panels. */
import { lazy, Suspense } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { DeviceDetail, InventoryResponse } from '@/lib/api/types'
import { formatRelative } from '@/lib/format'
import { useMe } from '@/lib/permissions'
import { cn } from '@/lib/utils'
import { DiagnosticsTool } from './cockpit-diagnostics'
import { EventLogsTool } from './cockpit-event-logs'
import { FilesTool } from './cockpit-files'
import { ProcessesTool } from './cockpit-processes'
import { RegistryTool } from './cockpit-registry'
import { ServicesTool } from './cockpit-services'
import { SessionsTool } from './cockpit-sessions'
import { COCKPIT_TAB_LABEL, REMOTE_TOOL, remoteTabsFor, type RemoteTab } from './cockpit-tabs'
import { remoteToolAccess } from './remote-access'
import { useLiveDesktop, useLiveShell } from './remote-state'
import { ToolUnavailable } from './remote-ui'

const TerminalTool = lazy(() => import('./cockpit-terminal'))
const DesktopTool = lazy(() => import('./desktop/desktop-viewer'))

export function RemoteNav({ device, tab, onTab }: { device: DeviceDetail; tab: RemoteTab; onTab: (tab: RemoteTab) => void }) {
  const me = useMe()
  const liveShell = useLiveShell(device.id)
  const liveDesktop = useLiveDesktop(device.id)
  const tabs = remoteTabsFor(device.os_family)
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <nav aria-label="Remote tools" className="-mx-4 min-w-0 flex-1 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0">
        <ul className="flex w-max items-center gap-0.5 rounded-xl bg-surface-2/70 p-1 ring-1 ring-border">
          {tabs.map((value) => {
            const meta = REMOTE_TOOL[value]
            const Icon = meta.icon
            const access = remoteToolAccess(device, me, value)
            const active = value === tab
            const button = (
              <button
                type="button"
                aria-current={active ? 'page' : undefined}
                disabled={!access.ok}
                onClick={() => onTab(value)}
                className={cn(
                  'relative flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-dense font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active ? 'bg-card text-foreground shadow-raised' : 'text-muted-foreground hover:bg-surface-3 hover:text-foreground',
                  !access.ok && 'pointer-events-none opacity-45',
                )}
              >
                <Icon className={cn('size-4', active ? 'text-primary' : 'text-subtle-foreground')} />
                {COCKPIT_TAB_LABEL[value]}
                {value === 'terminal' && liveShell && (
                  <span className="relative ml-0.5 inline-flex size-1.5 animate-pulse-ring rounded-full bg-critical text-critical" aria-label="Recording" />
                )}
                {value === 'desktop' && liveDesktop && (
                  <span className="relative ml-0.5 inline-flex size-1.5 animate-pulse-ring rounded-full bg-live text-live" aria-label="Connected" />
                )}
              </button>
            )
            return (
              <li key={value}>
                {access.ok ? (
                  <Tooltip>
                    <TooltipTrigger render={button} />
                    <TooltipContent>{meta.description}</TooltipContent>
                  </Tooltip>
                ) : (
                  <Tooltip>
                    <TooltipTrigger render={<span className="inline-flex" tabIndex={0} aria-label={`${COCKPIT_TAB_LABEL[value]} — ${access.reason}`} />}>{button}</TooltipTrigger>
                    <TooltipContent className="max-w-64">{access.reason}</TooltipContent>
                  </Tooltip>
                )}
              </li>
            )
          })}
        </ul>
      </nav>
      <span className="hidden items-center gap-1.5 text-micro text-muted-foreground md:flex">
        <span className={cn('inline-flex size-1.5 rounded-full', device.online && device.status === 'active' ? 'bg-live' : 'bg-subtle-foreground/70')} />
        {device.status !== 'active'
          ? 'Remote tools unavailable'
          : device.online
            ? `Agent ${device.agent_version} connected`
            : `Offline${device.last_seen_at ? ` · last seen ${formatRelative(device.last_seen_at)}` : ''}`}
      </span>
    </div>
  )
}

/** Renders the selected tool, or why it can't be used. The terminal and desktop are mounted by the cockpit itself. */
export function RemoteToolPanel({
  device,
  tab,
  inventory,
  inventoryLoading,
}: {
  device: DeviceDetail
  tab: RemoteTab
  inventory: InventoryResponse | undefined
  inventoryLoading: boolean
}) {
  const me = useMe()
  if (tab === 'terminal' || tab === 'desktop') return null
  const access = remoteToolAccess(device, me, tab)
  if (!access.ok) return <ToolUnavailable access={access} tool={COCKPIT_TAB_LABEL[tab]} lastSeen={device.last_seen_at} />
  switch (tab) {
    case 'files':
      return <FilesTool key={device.id} device={device} />
    case 'processes':
      return <ProcessesTool key={device.id} device={device} active />
    case 'services':
      return <ServicesTool key={device.id} device={device} inventory={inventory} inventoryLoading={inventoryLoading} />
    case 'event-logs':
      return <EventLogsTool key={device.id} device={device} />
    case 'registry':
      return device.os_family === 'windows' ? <RegistryTool key={device.id} device={device} /> : null
    case 'diagnostics':
      return <DiagnosticsTool key={device.id} device={device} />
    case 'sessions':
      return <SessionsTool key={device.id} device={device} />
  }
}

export function TerminalPanel({ device, active }: { device: DeviceDetail; active: boolean }) {
  return (
    <Suspense
      fallback={
        <div className="grid h-[72dvh] min-h-[380px] gap-0 overflow-hidden rounded-xl bg-card shadow-card sm:h-[min(80dvh,880px)]">
          <Skeleton className="m-3 h-7 w-64" />
          <Skeleton className="mx-3 mb-3 rounded-lg" />
        </div>
      }
    >
      <TerminalTool key={device.id} device={device} active={active} />
    </Suspense>
  )
}

export function DesktopPanel({ device, active }: { device: DeviceDetail; active: boolean }) {
  return (
    <Suspense
      fallback={
        <div className="grid h-[72dvh] min-h-[440px] grid-rows-[auto_1fr] gap-0 overflow-hidden rounded-xl bg-card shadow-card sm:h-[min(82dvh,920px)]">
          <Skeleton className="m-3 h-7 w-72" />
          <div className="m-3 mt-0 rounded-lg bg-[#0e1014]" />
        </div>
      }
    >
      <DesktopTool key={device.id} device={device} active={active} />
    </Suspense>
  )
}
