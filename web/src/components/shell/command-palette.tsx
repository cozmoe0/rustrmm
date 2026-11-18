import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useLocation, useNavigate } from '@tanstack/react-router'
import {
  BellRing,
  CircleCheck,
  Moon,
  OctagonAlert,
  Settings2,
  UserCheck,
  UserRound,
  Wrench,
  Building,
  FileCode,
  Inbox,
  ListChecks,
  Play,
  ScrollText,
  Keyboard,
  KeyRound,
  Layers,
  LogOut,
  MessageSquareText,
  MonitorPlay,
  Plus,
  Power,
  Rocket,
  Rows2,
  SquareTerminal,
  Sun,
  Gauge,
  History,
  Library,
  ListChecks as UpdatesIcon,
  Package,
  Radar,
  ShieldCheck,
  BookUser,
  Hash,
  LifeBuoy,
  Ticket,
  TicketPlus,
  Timer,
  Activity,
  Boxes,
  RadioTower,
  RotateCcwKey,
  Satellite,
  ScanSearch,
  Vault,
  Waypoints,
  BookOpenText,
  CalendarClock,
  ChartColumn,
  FileBadge2,
  LayoutDashboard,
  Palette,
  Webhook,
} from 'lucide-react'
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command'
import { EntityAvatar } from '@/components/common/misc'
import { OsIcon } from '@/components/common/os-icon'
import { StatusDot } from '@/components/common/status-dot'
import { alertsApi, patchesApi, ticketsApi } from '@/lib/api/endpoints'
import { parseTicketJump } from '@/lib/tickets/jump'
import { ticketNumber } from '@/lib/tickets/labels'
import { openLogTime, openNewTicket, selectedTicketStore } from '@/features/tickets/ticket-stores'
import { TicketStatusBadge } from '@/features/tickets/ticket-ui'
import { isApiError } from '@/lib/api/errors'
import { errorMessage } from '@/lib/api/errors'
import { clientsQuery, devicesQuery, keys } from '@/lib/api/queries'
import type { Alert } from '@/lib/api/types'
import { useStore } from '@/lib/store'
import { selectedAlertStore } from '@/features/monitoring/alert-stores'
import { SeverityIcon } from '@/features/monitoring/monitoring-ui'
import { deviceName } from '@/lib/devices'
import { PRIMARY_NAV, SETTINGS_NAV, SETTINGS_PAGES, visibleNav, type RoutePath } from '@/lib/nav'
import { PERMISSIONS, useMe, hasPermission } from '@/lib/permissions'
import { useScope } from '@/lib/scope'
import { useDensity, useTheme } from '@/lib/theme'
import { COCKPIT_TAB_LABEL, REMOTE_TOOL, remoteTabsFor, type RemoteTab } from '@/features/devices/cockpit-tabs'
import { remoteToolAccess } from '@/features/devices/remote-access'
import { requestRemoteIntent, type RemoteIntentAction } from '@/features/devices/remote-state'
import { remoteAccess } from '@/lib/remote'
import { openRunDialog } from '@/features/automation/run-dialog-store'
import { openDeployDialog } from '@/features/software/deploy-dialog-store'
import { paletteStore, shortcutsStore, usePaletteOpen } from './ui-state'
import { useSignOut } from '@/lib/use-sign-out'

const DEVICE_PATH = /^\/devices\/([^/]+)$/
/** Searches that ask for a shell list "Open terminal on…" for every online device. */
const TERMINAL_SEARCH = /term|shell|ssh|console|power|bash|cmd|zsh/i
/** Searches that ask for a screen list "Remote desktop to…" for every online device that supports it. */
const DESKTOP_SEARCH = /desk|rdp|remote|screen|vnc|control|support|view/i
/** Searches that ask to run something list "Run script on…" for every active device. */
const RUN_SEARCH = /run|script|exec/i
/** Searches that ask to deploy list "Deploy software to…" for every active device. */
const DEPLOY_SEARCH = /deploy|install|software|package/i
/** Searches that ask for a patch scan list "Scan for updates on…" for every online device. */
const SCAN_SEARCH = /scan|patch|update/i
/** Searches that ask to triage list "Acknowledge…" for the newest open alerts. */
const ACK_SEARCH = /ack|alert|triage/i

export function CommandPalette() {
  const open = usePaletteOpen()
  const navigate = useNavigate()
  const me = useMe()
  const signOut = useSignOut()
  const { clientId: scopeClient, setClient } = useScope()
  const { resolved, toggle: toggleTheme } = useTheme()
  const { density, toggle: toggleDensity } = useDensity()
  const { data: clients = [] } = useQuery({ ...clientsQuery(), enabled: open })
  const canDevices = hasPermission(me, PERMISSIONS.devicesView)
  const { data: devices = [] } = useQuery({ ...devicesQuery(), enabled: open && canDevices })
  const { pathname } = useLocation()
  const [search, setSearch] = useState('')
  const currentId = DEVICE_PATH.exec(pathname)?.[1]
  const current = currentId && currentId !== 'deploy' ? devices.find((device) => device.id === currentId) : undefined
  const canPower = hasPermission(me, PERMISSIONS.remotePower)
  const terminalTargets =
    search.trim().length >= 2 && TERMINAL_SEARCH.test(search) && hasPermission(me, PERMISSIONS.remoteShell)
      ? devices.filter((device) => device.status === 'active' && device.online)
      : []

  const desktopTargets =
    search.trim().length >= 2 && DESKTOP_SEARCH.test(search) && hasPermission(me, PERMISSIONS.remoteDesktop)
      ? devices.filter((device) => device.status === 'active' && device.online && device.os_family !== 'macos')
      : []

  const canRunScripts = hasPermission(me, PERMISSIONS.scriptsRun)
  const canScripts = hasPermission(me, PERMISSIONS.scriptsView)
  const runTargets = search.trim().length >= 2 && RUN_SEARCH.test(search) && canRunScripts ? devices.filter((device) => device.status === 'active') : []

  const canDeploy = hasPermission(me, PERMISSIONS.softwareDeploy)
  const canSecrets = hasPermission(me, PERMISSIONS.secretsReveal) || hasPermission(me, PERMISSIONS.secretsManage)
  const canNetwork = hasPermission(me, PERMISSIONS.networkView)
  const canReports = hasPermission(me, PERMISSIONS.reportsView)
  const canManageReports = hasPermission(me, PERMISSIONS.reportsManage)
  const canManageNetwork = hasPermission(me, PERMISSIONS.networkManage)
  const canPatches = hasPermission(me, PERMISSIONS.patchesView)
  const canSoftware = hasPermission(me, PERMISSIONS.softwareView)
  const typed = search.trim().length >= 2
  const deployTargets = typed && DEPLOY_SEARCH.test(search) && canDeploy ? devices.filter((device) => device.status === 'active') : []
  const scanTargets = typed && SCAN_SEARCH.test(search) && canPatches ? devices.filter((device) => device.status === 'active' && device.online) : []

  const queryClient = useQueryClient()
  const selectedAlert = useStore(selectedAlertStore)
  const canAlerts = hasPermission(me, PERMISSIONS.alertsView)
  const canTriage = hasPermission(me, PERMISSIONS.alertsManage)
  const wantsAck = open && canTriage && search.trim().length >= 3 && ACK_SEARCH.test(search)
  const { data: ackList } = useQuery({
    queryKey: ['alerts', 'palette'],
    queryFn: () => alertsApi.list({ status: 'open', limit: 8 }),
    enabled: wantsAck,
    staleTime: 10_000,
    meta: { silent: true },
  })
  const ackTargets = wantsAck ? (ackList?.items ?? []).filter((alert) => alert.id !== selectedAlert?.id) : []

  // Helpdesk (Phase 9): "#1042" jumps to that ticket.
  const canTickets = hasPermission(me, PERMISSIONS.ticketsView)
  const canWorkTickets = hasPermission(me, PERMISSIONS.ticketsManage)
  const canLogTime = hasPermission(me, PERMISSIONS.ticketsTime)
  const selectedTicket = useStore(selectedTicketStore)
  const jumpNumber = canTickets ? parseTicketJump(search) : null
  const { data: jumpList, isFetching: jumpLoading } = useQuery({
    queryKey: ['tickets', 'list', { purpose: 'palette-jump', number: jumpNumber }],
    queryFn: () => ticketsApi.list({ q: String(jumpNumber), status: 'all', limit: 5 }),
    enabled: open && jumpNumber !== null,
    staleTime: 10_000,
    meta: { silent: true },
  })
  const jumpTarget = jumpNumber !== null ? (jumpList?.items ?? []).find((ticket) => ticket.number === jumpNumber) : undefined

  function ticketAction(id: string, number: number, patch: { assignee_id?: string | null; status?: 'resolved' }, done: string) {
    run(() => {
      ticketsApi
        .update(id, patch)
        .then(() => {
          toast.success(`${ticketNumber(number)} ${done}`)
          void queryClient.invalidateQueries({ queryKey: ['tickets'] })
        })
        .catch((failure: unknown) => toast.error(errorMessage(failure)))
    })
  }

  function triage(alert: Alert, action: 'acknowledge' | 'unacknowledge' | 'resolve' | 'snooze' | 'assign') {
    run(() => {
      const request =
        action === 'acknowledge'
          ? alertsApi.acknowledge(alert.id)
          : action === 'unacknowledge'
            ? alertsApi.unacknowledge(alert.id)
            : action === 'resolve'
              ? alertsApi.resolve(alert.id)
              : action === 'snooze'
                ? alertsApi.snooze(alert.id, { minutes: 60 })
                : alertsApi.assign(alert.id, me?.user.id ?? null)
      const done = { acknowledge: 'Acknowledged', unacknowledge: 'Acknowledgement removed', resolve: 'Resolved', snooze: 'Snoozed for 1 hour', assign: 'Assigned to you' }[action]
      request
        .then(() => {
          toast.success(done, { description: alert.title })
          void queryClient.invalidateQueries({ queryKey: keys.alerts })
          void queryClient.invalidateQueries({ queryKey: ['fleet'] })
        })
        .catch((failure: unknown) => toast.error(errorMessage(failure)))
    })
  }

  function run(action: () => void) {
    paletteStore.set(false)
    setSearch('')
    action()
  }

  function scan(deviceId: string, hostname: string) {
    run(() => {
      patchesApi
        .scan(deviceId)
        .then(() => {
          toast.success(`Scan requested on ${hostname}`, { description: 'The Patches tab updates when the agent reports back.' })
          void queryClient.invalidateQueries({ queryKey: keys.devicePatches(deviceId) })
        })
        .catch((failure: unknown) => toast.error(isApiError(failure) && failure.code === 'device_offline' ? `${hostname} is offline` : errorMessage(failure)))
    })
  }

  function openTool(deviceId: string, tab: RemoteTab, intent?: RemoteIntentAction) {
    run(() => {
      if (intent) requestRemoteIntent(deviceId, intent)
      void navigate({ to: '/devices/$deviceId', params: { deviceId }, search: { tab } })
    })
  }

  function go(to: RoutePath, search?: Record<string, unknown>) {
    run(() => void navigate({ to, search: search as never }))
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        paletteStore.set(next)
        if (!next) setSearch('')
      }}
      title="Command palette"
      description="Search pages, clients, devices and actions"
      className="sm:max-w-[620px]"
    >
      <Command loop>
        <CommandInput placeholder="Search pages, clients, devices, actions…" value={search} onValueChange={setSearch} />
        <CommandList className="max-h-[min(60vh,440px)]">
          <CommandEmpty>Nothing matches that search.</CommandEmpty>

          {current && (
            <>
              <CommandGroup heading={`On ${deviceName(current)}`}>
                {remoteTabsFor(current.os_family)
                  .filter((tab) => remoteToolAccess(current, me, tab).ok)
                  .map((tab) => {
                    const Icon = REMOTE_TOOL[tab].icon
                    return (
                      <CommandItem
                        key={tab}
                        value={`remote ${COCKPIT_TAB_LABEL[tab]} ${REMOTE_TOOL[tab].description} ${current.hostname}`}
                        onSelect={() => openTool(current.id, tab, tab === 'terminal' ? 'connect-terminal' : tab === 'desktop' ? 'connect-desktop' : undefined)}
                      >
                        <Icon />
                        <span>{tab === 'terminal' ? 'Open terminal' : tab === 'desktop' ? 'Remote desktop' : COCKPIT_TAB_LABEL[tab]}</span>
                        <span className="truncate text-micro text-subtle-foreground">{REMOTE_TOOL[tab].description}</span>
                      </CommandItem>
                    )
                  })}
                {canRunScripts && current.status === 'active' && (
                  <CommandItem value={`run script automation ${current.hostname}`} onSelect={() => run(() => openRunDialog({ target: { type: 'devices', ids: [current.id] } }))}>
                    <Play />
                    Run script on this device…
                  </CommandItem>
                )}
                {canPatches && current.status === 'active' && current.online && (
                  <CommandItem value={`scan for updates patches ${current.hostname}`} onSelect={() => scan(current.id, current.hostname)}>
                    <Radar />
                    Scan for updates
                  </CommandItem>
                )}
                {canPatches && current.status === 'active' && (
                  <CommandItem value={`patches install updates ${current.hostname}`} onSelect={() => run(() => void navigate({ to: '/devices/$deviceId', params: { deviceId: current.id }, search: { tab: 'patches' } }))}>
                    <ShieldCheck />
                    Show patches on this device
                  </CommandItem>
                )}
                {canDeploy && current.status === 'active' && (
                  <CommandItem value={`deploy software install package ${current.hostname}`} onSelect={() => run(() => openDeployDialog({ target: { type: 'devices', ids: [current.id] } }))}>
                    <Package />
                    Deploy software to this device…
                  </CommandItem>
                )}
                {canSecrets && (
                  <CommandItem value={`secrets bitlocker recovery key laps local admin password ${current.hostname}`} onSelect={() => run(() => void navigate({ to: '/devices/$deviceId', params: { deviceId: current.id }, search: { tab: 'secrets' } }))}>
                    <RotateCcwKey />
                    Secrets on this device
                    <span className="truncate text-micro text-subtle-foreground">BitLocker keys, local admin password</span>
                  </CommandItem>
                )}
                {canPower && remoteAccess(current, true).ok && (
                  <>
                    <CommandItem value={`restart reboot shut down power ${current.hostname}`} onSelect={() => run(() => requestRemoteIntent(current.id, 'power'))}>
                      <Power />
                      Restart or shut down…
                    </CommandItem>
                    <CommandItem value={`message user notify ${current.hostname}`} onSelect={() => run(() => requestRemoteIntent(current.id, 'message'))}>
                      <MessageSquareText />
                      Message the user…
                    </CommandItem>
                  </>
                )}
              </CommandGroup>
              <CommandSeparator />
            </>
          )}

          {jumpNumber !== null && (
            <>
              <CommandGroup heading="Jump to ticket">
                {jumpTarget ? (
                  <CommandItem
                    value={`#${jumpNumber} ticket ${jumpTarget.subject}`}
                    onSelect={() => run(() => void navigate({ to: '/tickets/$ticketId', params: { ticketId: jumpTarget.id } }))}
                  >
                    <Hash />
                    <span className="tabular font-mono text-[12px]">{ticketNumber(jumpTarget.number)}</span>
                    <span className="truncate">{jumpTarget.subject}</span>
                    <span className="ml-auto flex shrink-0 items-center gap-2">
                      <span className="hidden truncate text-micro text-subtle-foreground sm:inline">{jumpTarget.client_name}</span>
                      <TicketStatusBadge status={jumpTarget.status} />
                    </span>
                  </CommandItem>
                ) : (
                  <CommandItem value={`#${jumpNumber} ticket lookup`} disabled>
                    <Hash />
                    {jumpLoading ? `Looking up ${ticketNumber(jumpNumber)}…` : `No ticket ${ticketNumber(jumpNumber)}`}
                  </CommandItem>
                )}
              </CommandGroup>
              <CommandSeparator />
            </>
          )}

          {selectedTicket && canWorkTickets && !selectedTicket.merged_into && (
            <>
              <CommandGroup heading={`On ${ticketNumber(selectedTicket.number)}`}>
                {selectedTicket.assignee?.id !== me?.user.id && (
                  <CommandItem
                    value={`assign ticket to me take ${selectedTicket.subject}`}
                    onSelect={() => ticketAction(selectedTicket.id, selectedTicket.number, { assignee_id: me?.user.id ?? null }, 'assigned to you')}
                  >
                    <UserRound />
                    Assign ticket to me
                    <CommandShortcut>a</CommandShortcut>
                  </CommandItem>
                )}
                {selectedTicket.status !== 'resolved' && selectedTicket.status !== 'closed' && (
                  <CommandItem
                    value={`resolve ticket done ${selectedTicket.subject}`}
                    onSelect={() => ticketAction(selectedTicket.id, selectedTicket.number, { status: 'resolved' }, 'resolved')}
                  >
                    <CircleCheck />
                    Mark ticket resolved
                    <CommandShortcut>e</CommandShortcut>
                  </CommandItem>
                )}
                {canLogTime && (
                  <CommandItem value={`log time on this ticket ${selectedTicket.subject}`} onSelect={() => run(() => openLogTime(selectedTicket.id))}>
                    <Timer />
                    Log time on this ticket…
                  </CommandItem>
                )}
              </CommandGroup>
              <CommandSeparator />
            </>
          )}

          {selectedAlert && canTriage && selectedAlert.status !== 'resolved' && (
            <>
              <CommandGroup heading="On this alert">
                {selectedAlert.status === 'open' ? (
                  <CommandItem value={`acknowledge alert ack ${selectedAlert.title}`} onSelect={() => triage(selectedAlert, 'acknowledge')}>
                    <UserCheck />
                    <span>Acknowledge alert</span>
                    <span className="truncate text-micro text-subtle-foreground">{selectedAlert.title}</span>
                    <CommandShortcut>a</CommandShortcut>
                  </CommandItem>
                ) : (
                  <CommandItem value={`unacknowledge alert ${selectedAlert.title}`} onSelect={() => triage(selectedAlert, 'unacknowledge')}>
                    <UserRound />
                    <span>Remove acknowledgement</span>
                    <span className="truncate text-micro text-subtle-foreground">{selectedAlert.title}</span>
                  </CommandItem>
                )}
                <CommandItem value={`resolve alert close ${selectedAlert.title}`} onSelect={() => triage(selectedAlert, 'resolve')}>
                  <CircleCheck />
                  Resolve alert
                  <CommandShortcut>r</CommandShortcut>
                </CommandItem>
                <CommandItem value={`snooze alert 1 hour ${selectedAlert.title}`} onSelect={() => triage(selectedAlert, 'snooze')}>
                  <Moon />
                  Snooze for 1 hour
                  <CommandShortcut>s</CommandShortcut>
                </CommandItem>
                {selectedAlert.assigned_to?.id !== me?.user.id && (
                  <CommandItem value={`assign alert to me take ${selectedAlert.title}`} onSelect={() => triage(selectedAlert, 'assign')}>
                    <UserRound />
                    Assign to me
                  </CommandItem>
                )}
              </CommandGroup>
              <CommandSeparator />
            </>
          )}

          {ackTargets.length > 0 && (
            <>
              <CommandGroup heading="Acknowledge alert…">
                {ackTargets.map((alert) => (
                  <CommandItem
                    key={alert.id}
                    value={`acknowledge ack alert triage ${alert.title} ${alert.hostname ?? ''} ${alert.client_name}`}
                    onSelect={() => triage(alert, 'acknowledge')}
                  >
                    <SeverityIcon severity={alert.severity} />
                    <span className="truncate">{alert.title}</span>
                    <span className="truncate text-micro text-subtle-foreground">
                      {alert.hostname ?? alert.client_name}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandSeparator />
            </>
          )}

          {desktopTargets.length > 0 && (
            <>
              <CommandGroup heading="Remote desktop to…">
                {desktopTargets.map((device) => (
                  <CommandItem
                    key={device.id}
                    value={`remote desktop screen control rdp vnc support ${device.hostname} ${device.display_name ?? ''} ${device.client_name}`}
                    onSelect={() => openTool(device.id, 'desktop', 'connect-desktop')}
                  >
                    <MonitorPlay />
                    <span>{deviceName(device)}</span>
                    <span className="truncate text-micro text-subtle-foreground">
                      {device.last_user ? `${device.last_user} · ` : ''}
                      {device.client_name}
                    </span>
                    <OsIcon family={device.os_family} className="ml-auto" />
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandSeparator />
            </>
          )}

          {terminalTargets.length > 0 && (
            <>
              <CommandGroup heading="Open terminal on…">
                {terminalTargets.map((device) => (
                  <CommandItem
                    key={device.id}
                    value={`terminal shell console ${device.hostname} ${device.display_name ?? ''} ${device.client_name}`}
                    onSelect={() => openTool(device.id, 'terminal', 'connect-terminal')}
                  >
                    <SquareTerminal />
                    <span>{deviceName(device)}</span>
                    <span className="truncate text-micro text-subtle-foreground">
                      {device.client_name} · {device.site_name}
                    </span>
                    <OsIcon family={device.os_family} className="ml-auto" />
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandSeparator />
            </>
          )}

          {scanTargets.length > 0 && (
            <>
              <CommandGroup heading="Scan for updates on…">
                {scanTargets.map((device) => (
                  <CommandItem
                    key={device.id}
                    value={`scan patch updates ${device.hostname} ${device.display_name ?? ''} ${device.client_name}`}
                    onSelect={() => scan(device.id, device.hostname)}
                  >
                    <Radar />
                    <span>{deviceName(device)}</span>
                    <span className="truncate text-micro text-subtle-foreground">
                      {device.client_name} · {device.site_name}
                    </span>
                    <OsIcon family={device.os_family} className="ml-auto" />
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandSeparator />
            </>
          )}

          {deployTargets.length > 0 && (
            <>
              <CommandGroup heading="Deploy software to…">
                {deployTargets.map((device) => (
                  <CommandItem
                    key={device.id}
                    value={`deploy install software package ${device.hostname} ${device.display_name ?? ''} ${device.client_name}`}
                    onSelect={() => run(() => openDeployDialog({ target: { type: 'devices', ids: [device.id] } }))}
                  >
                    <Package />
                    <span>{deviceName(device)}</span>
                    <span className="truncate text-micro text-subtle-foreground">
                      {device.client_name} · {device.site_name}
                    </span>
                    <StatusDot tone={device.online ? 'live' : 'offline'} className="ml-auto" label={device.online ? 'Online' : 'Offline'} />
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandSeparator />
            </>
          )}

          {runTargets.length > 0 && (
            <>
              <CommandGroup heading="Run script on…">
                {runTargets.map((device) => (
                  <CommandItem
                    key={device.id}
                    value={`run script exec ${device.hostname} ${device.display_name ?? ''} ${device.client_name}`}
                    onSelect={() => run(() => openRunDialog({ target: { type: 'devices', ids: [device.id] } }))}
                  >
                    <Play />
                    <span>{deviceName(device)}</span>
                    <span className="truncate text-micro text-subtle-foreground">
                      {device.client_name} · {device.site_name}
                    </span>
                    <StatusDot tone={device.online ? 'live' : 'offline'} className="ml-auto" label={device.online ? 'Online' : 'Offline'} />
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandSeparator />
            </>
          )}

          <CommandGroup heading="Navigate">
            {[...visibleNav(PRIMARY_NAV, me?.permissions), SETTINGS_NAV].map((item) => {
              const Icon = item.icon
              return (
                <CommandItem key={item.id} value={`go ${item.label} ${item.description}`} onSelect={() => go(item.to)}>
                  <Icon />
                  <span>{item.label}</span>
                  <span className="truncate text-micro text-subtle-foreground">{item.description}</span>
                  {item.shortcut && <CommandShortcut>{item.shortcut}</CommandShortcut>}
                </CommandItem>
              )
            })}
            {SETTINGS_PAGES.filter((page) => !page.permission || hasPermission(me, page.permission)).map((page) => (
              <CommandItem key={page.to} value={`settings ${page.label}`} onSelect={() => go(page.to)}>
                <SETTINGS_NAV.icon />
                <span>
                  Settings <span className="text-subtle-foreground">›</span> {page.label}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>

          {clients.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Clients">
                <CommandItem value="scope all clients" onSelect={() => run(() => setClient(null))}>
                  <Layers />
                  Switch to all clients
                </CommandItem>
                {clients.map((client) => (
                  <CommandItem
                    key={client.id}
                    value={`client ${client.name} ${client.slug}`}
                    onSelect={() =>
                      run(() =>
                        void navigate({
                          to: '/clients/$clientId',
                          params: { clientId: client.id },
                        }),
                      )
                    }
                  >
                    <EntityAvatar name={client.name} seed={client.id} accent={client.accent_color} size="xs" />
                    <span>{client.name}</span>
                    <span className="text-micro text-subtle-foreground">
                      {client.site_count} sites · {client.device_count} devices
                    </span>
                    <button
                      type="button"
                      className="ml-auto rounded-sm px-1.5 py-0.5 text-micro text-muted-foreground hover:bg-surface-4 hover:text-foreground"
                      onClick={(event) => {
                        event.stopPropagation()
                        run(() => setClient(client.id))
                      }}
                    >
                      Set scope
                    </button>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}

          {devices.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Devices">
                {devices.map((device) => (
                  <CommandItem
                    key={device.id}
                    value={`device ${device.hostname} ${device.display_name ?? ''} ${device.last_user ?? ''} ${device.last_ip ?? ''} ${device.client_name}`}
                    onSelect={() => run(() => void navigate({ to: '/devices/$deviceId', params: { deviceId: device.id } }))}
                  >
                    <OsIcon family={device.os_family} />
                    <span>{deviceName(device)}</span>
                    <span className="truncate text-micro text-subtle-foreground">
                      {device.client_name} · {device.site_name}
                    </span>
                    <StatusDot tone={device.online ? 'live' : 'offline'} className="ml-auto" label={device.online ? 'Online' : 'Offline'} />
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}

          <CommandSeparator />
          <CommandGroup heading="Actions">
            {canReports && (
              <>
                <CommandItem value="go to reports library executive summary export" onSelect={() => go('/reports')}>
                  <ChartColumn />
                  Go to Reports
                  <CommandShortcut>g r</CommandShortcut>
                </CommandItem>
                <CommandItem value="run a report pdf csv export" onSelect={() => go('/reports', { run: 'executive_summary' })}>
                  <Play />
                  Run a report…
                </CommandItem>
                <CommandItem value="executive summary report last 30 days client review qbr" onSelect={() => go('/reports/view', { type: 'executive_summary', client: scopeClient })}>
                  <ChartColumn />
                  Executive summary
                  <span className="truncate text-micro text-subtle-foreground">last 30 days</span>
                </CommandItem>
                <CommandItem value="report run history downloads" onSelect={() => go('/reports/runs')}>
                  <History />
                  Report run history
                </CommandItem>
              </>
            )}
            {canManageReports && (
              <CommandItem value="report schedules email scheduled reports" onSelect={() => go('/reports/schedules')}>
                <CalendarClock />
                Report schedules
              </CommandItem>
            )}
            <CommandItem value="edit home dashboard customize widgets" onSelect={() => go('/', { edit: true })}>
              <LayoutDashboard />
              Customize Home dashboard
            </CommandItem>
            <CommandItem value="api tokens personal access token" onSelect={() => go('/settings/api-tokens')}>
              <KeyRound />
              API tokens
            </CommandItem>
            <CommandItem value="new api token create personal access token" onSelect={() => go('/settings/api-tokens', { new: true })}>
              <Plus />
              New API token
            </CommandItem>
            <CommandItem value="api documentation docs openapi swagger reference" onSelect={() => run(() => void window.open('/api/docs', '_blank', 'noopener'))}>
              <BookOpenText />
              API documentation
              <span className="truncate text-micro text-subtle-foreground">/api/docs</span>
            </CommandItem>
            {hasPermission(me, PERMISSIONS.apiManage) && (
              <CommandItem value="webhooks outbound events integrations deliveries" onSelect={() => go('/settings/webhooks')}>
                <Webhook />
                Webhooks
              </CommandItem>
            )}
            {hasPermission(me, PERMISSIONS.settingsManage) && Boolean(me?.scopes.global) && (
              <CommandItem value="single sign-on sso oidc entra okta google identity provider" onSelect={() => go('/settings/sso')}>
                <Waypoints />
                Single sign-on
              </CommandItem>
            )}
            {hasPermission(me, PERMISSIONS.settingsView) && (
              <CommandItem value="branding white label logo accent colour product name" onSelect={() => go('/settings/branding')}>
                <Palette />
                Branding
              </CommandItem>
            )}
            {hasPermission(me, PERMISSIONS.settingsManage) && Boolean(me?.scopes.global) && (
              <CommandItem value="code signing authenticode certificate agent bundle" onSelect={() => go('/settings/signing')}>
                <FileBadge2 />
                Code signing status
              </CommandItem>
            )}
            {canWorkTickets && (
              <CommandItem value="new ticket create helpdesk" onSelect={() => run(() => openNewTicket({ client_id: scopeClient }))}>
                <TicketPlus />
                New ticket
              </CommandItem>
            )}
            {canTickets && (
              <>
                <CommandItem value="go to ticket queue tickets helpdesk inbox" onSelect={() => go('/tickets')}>
                  <Ticket />
                  Go to the ticket queue
                  <CommandShortcut>g t</CommandShortcut>
                </CommandItem>
                <CommandItem value="my tickets assigned to me helpdesk" onSelect={() => go('/tickets', { assignee: 'me' })}>
                  <UserRound />
                  My tickets
                </CommandItem>
                <CommandItem value="tickets breaching sla overdue" onSelect={() => go('/tickets', { sla: 'breached' })}>
                  <OctagonAlert />
                  Tickets breaching SLA
                </CommandItem>
                <CommandItem value="jump to ticket by number hash" onSelect={() => setSearch('#')}>
                  <Hash />
                  Jump to ticket…
                  <span className="text-micro text-subtle-foreground">type #1042</span>
                </CommandItem>
                <CommandItem value="contacts client people helpdesk" onSelect={() => go('/tickets/contacts')}>
                  <BookUser />
                  Contacts
                </CommandItem>
              </>
            )}
            {canLogTime && (
              <>
                <CommandItem value="log time timesheet billable" onSelect={() => run(() => openLogTime(selectedTicket?.id))}>
                  <Timer />
                  Log time…
                </CommandItem>
                <CommandItem value="time report billable hours export" onSelect={() => go('/tickets/time')}>
                  <Timer />
                  Time report
                </CommandItem>
              </>
            )}
            {hasPermission(me, PERMISSIONS.ticketsSettings) && (
              <CommandItem value="helpdesk settings queues sla policies canned responses email imap alert rules" onSelect={() => go('/settings/tickets')}>
                <LifeBuoy />
                Helpdesk settings
              </CommandItem>
            )}
            {canSecrets && (
              <>
                <CommandItem value="secrets escrow vault reveal" onSelect={() => go('/secrets')}>
                  <Vault />
                  Go to Secrets
                  <CommandShortcut>g k</CommandShortcut>
                </CommandItem>
                <CommandItem value="bitlocker recovery keys escrow reveal" onSelect={() => go('/secrets', { kind: 'bitlocker' })}>
                  <Vault />
                  BitLocker recovery keys
                </CommandItem>
                <CommandItem value="laps local admin passwords rotation reveal" onSelect={() => go('/secrets', { kind: 'laps' })}>
                  <RotateCcwKey />
                  Local admin passwords (LAPS)
                </CommandItem>
              </>
            )}
            {canNetwork && (
              <>
                <CommandItem value="network overview discovery snmp" onSelect={() => go('/network')}>
                  <Waypoints />
                  Go to Network
                  <CommandShortcut>g n</CommandShortcut>
                </CommandItem>
                <CommandItem value="discovered assets network devices printers switches" onSelect={() => go('/network/assets')}>
                  <Boxes />
                  Discovered assets
                </CommandItem>
                <CommandItem value="unmanaged devices network no agent rogue" onSelect={() => go('/network/assets', { managed: 'unmanaged' })}>
                  <Boxes />
                  Unmanaged devices on the network
                </CommandItem>
                <CommandItem value="snmp devices monitoring switches printers ups" onSelect={() => go('/network/snmp')}>
                  <Activity />
                  SNMP devices
                </CommandItem>
                <CommandItem value="unreachable snmp devices down offline" onSelect={() => go('/network/snmp', { status: 'unreachable' })}>
                  <Activity />
                  Unreachable SNMP devices
                </CommandItem>
                <CommandItem value="snmp traps received trap rules" onSelect={() => go('/network/traps')}>
                  <RadioTower />
                  SNMP traps
                </CommandItem>
                <CommandItem value="network scans discovery sweep" onSelect={() => go('/network/scans')}>
                  <ScanSearch />
                  Network scans
                </CommandItem>
                <CommandItem value="network topology map lldp" onSelect={() => go('/network/topology')}>
                  <Waypoints />
                  Network topology
                </CommandItem>
                <CommandItem value="network probes site probe agent" onSelect={() => go('/network/probes')}>
                  <Satellite />
                  Network probes
                </CommandItem>
              </>
            )}
            {canManageNetwork && (
              <CommandItem value="new network scan discovery create" onSelect={() => go('/network/scans', { edit: 'new' })}>
                <Plus />
                New network scan
              </CommandItem>
            )}
            {canRunScripts && (
              <CommandItem value="run a script automation job" onSelect={() => run(() => openRunDialog())}>
                <Play />
                Run a script…
              </CommandItem>
            )}
            {hasPermission(me, PERMISSIONS.scriptsManage) && (
              <CommandItem value="new script create automation" onSelect={() => go('/automation/scripts/new')}>
                <FileCode />
                New script
              </CommandItem>
            )}
            {canScripts && (
              <>
                <CommandItem value="go to jobs automation runs scheduled" onSelect={() => go('/automation/jobs')}>
                  <ListChecks />
                  Go to Jobs
                </CommandItem>
                <CommandItem value="go to approvals four eyes automation" onSelect={() => go('/automation/approvals')}>
                  <Inbox />
                  Go to Approvals
                </CommandItem>
              </>
            )}
            {canAlerts && (
              <>
                <CommandItem value="go to alerts inbox triage monitoring" onSelect={() => go('/alerts')}>
                  <OctagonAlert />
                  Go to Alerts
                  <CommandShortcut>g a</CommandShortcut>
                </CommandItem>
                <CommandItem value="critical alerts severity" onSelect={() => go('/alerts', { severity: 'critical' })}>
                  <OctagonAlert />
                  Show critical alerts
                </CommandItem>
                <CommandItem value="alerts assigned to me mine" onSelect={() => go('/alerts', { assigned: 'me' })}>
                  <UserRound />
                  Alerts assigned to me
                </CommandItem>
                <CommandItem value="maintenance windows patch night suppress" onSelect={() => go('/alerts/maintenance')}>
                  <Wrench />
                  Maintenance windows
                </CommandItem>
              </>
            )}
            {hasPermission(me, PERMISSIONS.monitorsManage) && (
              <CommandItem value="new maintenance window schedule" onSelect={() => go('/alerts/maintenance', { edit: 'new' })}>
                <Plus />
                New maintenance window
              </CommandItem>
            )}
            {hasPermission(me, PERMISSIONS.notificationsManage) && (
              <>
                <CommandItem value="notifications channels slack teams email ntfy webhook" onSelect={() => go('/settings/notifications')}>
                  <BellRing />
                  Notification channels
                </CommandItem>
                <CommandItem value="notification rules quiet hours escalation" onSelect={() => go('/settings/notifications', { tab: 'rules' })}>
                  <BellRing />
                  Notification rules
                </CommandItem>
                <CommandItem value="notification delivery log history" onSelect={() => go('/settings/notifications', { tab: 'log' })}>
                  <BellRing />
                  Notification delivery log
                </CommandItem>
              </>
            )}
            {hasPermission(me, PERMISSIONS.settingsView) && (
              <CommandItem value="monitoring settings offline threshold retention allowlist" onSelect={() => go('/settings/monitoring')}>
                <Settings2 />
                Monitoring settings
              </CommandItem>
            )}
            {canPatches && (
              <>
                <CommandItem value="go to patching overview compliance dashboard" onSelect={() => go('/patching')}>
                  <Gauge />
                  Go to Patching overview
                  <CommandShortcut>g p</CommandShortcut>
                </CommandItem>
                <CommandItem value="go to updates patches catalog approve kb" onSelect={() => go('/patching/updates')}>
                  <UpdatesIcon />
                  Go to Updates
                </CommandItem>
                <CommandItem value="critical updates missing patches" onSelect={() => go('/patching/updates', { severity: 'Critical' })}>
                  <ShieldCheck />
                  Missing critical updates
                </CommandItem>
                <CommandItem value="patch runs maintenance window results" onSelect={() => go('/patching/runs')}>
                  <History />
                  Go to Patch runs
                </CommandItem>
                <CommandItem value="scan for updates on device patch scan" onSelect={() => setSearch('scan ')}>
                  <Radar />
                  Scan for updates on…
                </CommandItem>
              </>
            )}
            {canSoftware && (
              <>
                <CommandItem value="go to software library packages" onSelect={() => go('/software/library')}>
                  <Library />
                  Go to Software library
                </CommandItem>
                <CommandItem value="software explorer installed applications inventory" onSelect={() => go('/software')}>
                  <Package />
                  Software explorer
                  <CommandShortcut>g w</CommandShortcut>
                </CommandItem>
                <CommandItem value="software deployments" onSelect={() => go('/software/deployments')}>
                  <Rocket />
                  Software deployments
                </CommandItem>
              </>
            )}
            {canDeploy && (
              <CommandItem value="deploy software to install package" onSelect={() => run(() => openDeployDialog())}>
                <Package />
                Deploy software to…
              </CommandItem>
            )}
            <CommandItem value="go to policies automation agent settings" onSelect={() => go('/automation/policies')}>
              <ScrollText />
              Go to Policies
            </CommandItem>
            {hasPermission(me, PERMISSIONS.agentsDeploy) && (
              <>
                <CommandItem value="deploy agents install agent" onSelect={() => go('/devices/deploy')}>
                  <Rocket />
                  Deploy agents
                </CommandItem>
                <CommandItem value="new deploy key enrollment token" onSelect={() => go('/devices/deploy', { new: true })}>
                  <KeyRound />
                  New deploy key
                </CommandItem>
              </>
            )}
            {hasPermission(me, PERMISSIONS.agentsApprove) && (
              <CommandItem value="pending approvals enrollment approve devices" onSelect={() => go('/devices/deploy', { section: 'approvals' })}>
                <Inbox />
                Review pending approvals
              </CommandItem>
            )}
            {hasPermission(me, PERMISSIONS.clientsManage) && (
              <CommandItem value="new client create" onSelect={() => go('/clients', { new: true })}>
                <Plus />
                New client
              </CommandItem>
            )}
            <CommandItem value="toggle theme dark light" onSelect={() => run(toggleTheme)}>
              {resolved === 'dark' ? <Sun /> : <Moon />}
              Switch to {resolved === 'dark' ? 'light' : 'dark'} theme
            </CommandItem>
            <CommandItem value="toggle density compact comfortable" onSelect={() => run(toggleDensity)}>
              <Rows2 />
              Use {density === 'compact' ? 'comfortable' : 'compact'} density
            </CommandItem>
            <CommandItem value="keyboard shortcuts help" onSelect={() => run(() => shortcutsStore.set(true))}>
              <Keyboard />
              Keyboard shortcuts
              <CommandShortcut>?</CommandShortcut>
            </CommandItem>
            <CommandItem value="clients directory" onSelect={() => go('/clients')}>
              <Building />
              Browse clients
            </CommandItem>
            <CommandItem value="sign out log out" onSelect={() => run(() => void signOut())}>
              <LogOut />
              Sign out
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
