import { useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  Ban,
  Check,
  CircleX,
  Copy,
  Ellipsis,
  FileCode,
  FolderOpen,
  Inbox,
  Lock,
  LogOut,
  MessageSquareText,
  MonitorPlay,
  Pencil,
  Power,
  RefreshCw,
  RotateCw,
  SquareTerminal,
  Trash,
  X,
  Zap,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { HealthRing } from '@/components/common/health-ring'
import { ErrorState, Mono, RelativeTime } from '@/components/common/misc'
import { PageContainer } from '@/components/common/page-header'
import { copyText } from '@/lib/clipboard'
import { devicesApi } from '@/lib/api/endpoints'
import { isApiError } from '@/lib/api/errors'
import { deviceQuery, inventoryQuery, keys } from '@/lib/api/queries'
import type { DeviceDetail } from '@/lib/api/types'
import { deviceName, healthBand } from '@/lib/devices'
import { formatDuration, formatNumber } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { remoteAccess, supportsSessionPower, type RemoteAccess } from '@/lib/remote'
import { useStore } from '@/lib/store'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { closeWorkspaceTab, openWorkspaceTab } from '@/lib/workspace'
import { HardwareTab, NetworkTab, SecurityTab, StorageTab, UsersTab } from './cockpit-inventory'
import { NotesTab } from './cockpit-notes'
import { OverviewTab } from './cockpit-overview'
import { PerformanceTab } from './cockpit-performance'
import { MessageDialog, RestartDialog, SessionPowerDialogs } from './cockpit-power'
import { usePowerAction } from './use-power-action'
import { DesktopPanel, RemoteNav, RemoteToolPanel, TerminalPanel } from './cockpit-remote'
import { COCKPIT_TAB_LABEL, DEVICE_TABS, isRemoteTab, remoteTabsFor, type CockpitTab } from './cockpit-tabs'
import { TimelineTab } from './cockpit-timeline'
import { EditDeviceDialog } from './device-dialogs'
import { ConnectionPill, OsTile } from './device-ui'
import { DevicesContextPanel } from './devices-context'
import { defaultRemoteTab, remoteToolAccess } from './remote-access'
import { consumeRemoteIntent, lastRemoteTabStore, requestRemoteIntent, useLiveDesktop, useLiveShell, useRemoteIntent } from './remote-state'
import { ToolUnavailable } from './remote-ui'
import { useDeviceLive } from './use-device-live'
import { useRefreshInventory } from './use-refresh-inventory'
import { DevicePolicyTab, DeviceScriptsTab } from '@/features/automation/device-automation'
import { openRunDialog } from '@/features/automation/run-dialog-store'
import { DeviceMonitoringTab, MonitoringTabCount } from '@/features/monitoring/device-monitoring'
import { DevicePatchesTab } from '@/features/patching/device-patches'
import { DeviceSoftwareTab } from '@/features/software/device-software'
import { DeviceTicketCount, DeviceTicketsTab } from '@/features/tickets/entity-tickets'
import { DeviceSecretsTab } from '@/features/secrets/device-secrets'

const HEADER_TINT = { good: 'var(--live)', fair: 'var(--warning)', poor: 'var(--critical)', unknown: 'var(--info)' }

function HeaderStat({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="min-w-20">
      <div className="text-micro text-subtle-foreground">{label}</div>
      <div className="tabular mt-0.5 text-base font-semibold tracking-tight">{children}</div>
      {hint && <div className="text-micro text-subtle-foreground">{hint}</div>}
    </div>
  )
}

function RemoteButton({ icon, label, access, onClick }: { icon: ReactNode; label: string; access: RemoteAccess; onClick: () => void }) {
  if (!access.ok) {
    return (
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" tabIndex={0} aria-label={`${label} — ${access.reason}`} />}>
          <Button variant="outline" size="icon-sm" disabled aria-hidden="true" tabIndex={-1}>
            {icon}
          </Button>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">
          {label} · {access.reason}
        </TooltipContent>
      </Tooltip>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="outline" size="icon-sm" aria-label={label} onClick={onClick} />}>{icon}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function HealthPopover({ device, onTab }: { device: DeviceDetail; onTab: (tab: string) => void }) {
  const score = device.status === 'active' ? device.health.score : null
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Health score details"
            className="rounded-full outline-none transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        <HealthRing score={score} size={52} strokeWidth={4.5} className="[&_span]:text-[13px]" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <div className="flex items-center gap-3">
          <HealthRing score={score} size={44} />
          <div>
            <p className="font-medium">Health score</p>
            <p className="text-micro text-muted-foreground">Starts at 100; each issue below subtracts points.</p>
          </div>
        </div>
        {device.status !== 'active' ? (
          <p className="mt-3 text-dense text-muted-foreground">Devices are scored once they are approved and active.</p>
        ) : device.health.reasons.length === 0 ? (
          <p className="mt-3 flex items-center gap-2 text-dense text-live">
            <Check className="size-4" /> No issues detected
          </p>
        ) : (
          <ul className="mt-3 grid gap-1.5">
            {device.health.reasons.map((reason) => (
              <li key={reason.label} className="flex items-center justify-between gap-3 rounded-md bg-surface-2 px-2.5 py-1.5 text-dense">
                <span>{reason.label}</span>
                <span className="tabular font-mono text-[11px] text-critical">−{reason.penalty}</span>
              </li>
            ))}
          </ul>
        )}
        {device.status === 'active' && (
          <Button variant="ghost" size="sm" className="mt-2 w-full justify-center text-muted-foreground" onClick={() => onTab('monitoring')}>
            See checks and alerts
          </Button>
        )}
      </PopoverContent>
    </Popover>
  )
}

type Pending = 'revoke' | 'delete' | 'reject' | null

export function DeviceCockpit({ deviceId, tab }: { deviceId: string; tab: CockpitTab }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const me = useMe()
  const { data: device, isLoading, error, refetch } = useQuery(deviceQuery(deviceId))
  const inventory = useQuery({ ...inventoryQuery(deviceId), enabled: Boolean(device) })
  const live = useDeviceLive(device)
  const refreshInventory = useRefreshInventory()
  const [editing, setEditing] = useState(false)
  const [confirm, setConfirm] = useState<Pending>(null)
  const [restart, setRestart] = useState<'reboot' | 'shutdown' | null>(null)
  const [sessionPower, setSessionPower] = useState<'logoff' | 'lock' | null>(null)
  const [messageOpen, setMessageOpen] = useState(false)
  // The terminal stays mounted (and its shell connected) while you visit other tabs of this device.
  const [terminalFor, setTerminalFor] = useState<string | null>(null)
  // Likewise the remote desktop, so a session survives a look at another tab.
  const [desktopFor, setDesktopFor] = useState<string | null>(null)
  const lastRemoteTab = useStore(lastRemoteTabStore)
  const liveShell = useLiveShell(deviceId)
  const liveDesktop = useLiveDesktop(deviceId)
  const messageIntent = useRemoteIntent(deviceId, 'message')
  const powerIntent = useRemoteIntent(deviceId, 'power')
  useTitle(device ? deviceName(device) : undefined)

  const canManage = hasPermission(me, PERMISSIONS.devicesManage)
  const canDelete = hasPermission(me, PERMISSIONS.devicesDelete)
  const canApprove = hasPermission(me, PERMISSIONS.agentsApprove)
  const canSecrets = hasPermission(me, PERMISSIONS.secretsReveal) || hasPermission(me, PERMISSIONS.secretsManage)
  const remoteTab = isRemoteTab(tab) ? tab : null
  const terminalAccess = device ? remoteToolAccess(device, me, 'terminal') : null
  if (tab === 'terminal' && terminalAccess?.ok && terminalFor !== deviceId) setTerminalFor(deviceId)
  const terminalMounted = terminalFor === deviceId && Boolean(device)
  const desktopAccess = device ? remoteToolAccess(device, me, 'desktop') : null
  if (tab === 'desktop' && desktopAccess?.ok && desktopFor !== deviceId) setDesktopFor(deviceId)
  const desktopMounted = desktopFor === deviceId && Boolean(device)

  useEffect(() => {
    if (device) {
      openWorkspaceTab({
        id: `device:${device.id}`,
        kind: 'device',
        title: deviceName(device),
        to: '/devices/$deviceId',
        params: { deviceId: device.id },
        meta: { os: device.os_family },
      })
    }
  }, [device])

  const setTab = (requested: string) => {
    let next = requested as CockpitTab
    if (requested === 'remote') {
      next = device ? defaultRemoteTab(device, me, remoteTabsFor(device.os_family), lastRemoteTab) : 'sessions'
    }
    if (isRemoteTab(next)) lastRemoteTabStore.set(next)
    void navigate({
      from: '/devices/$deviceId',
      to: '/devices/$deviceId',
      params: { deviceId },
      search: (prev) => ({ ...prev, tab: next === 'overview' ? undefined : next }),
      replace: true,
    })
  }

  const openTerminal = (connect: boolean) => {
    if (connect && !liveShell) requestRemoteIntent(deviceId, 'connect-terminal')
    setTab('terminal')
  }

  const openDesktop = () => setTab('desktop')

  const afterRemoval = () => {
    closeWorkspaceTab(`device:${deviceId}`)
    queryClient.removeQueries({ queryKey: keys.device(deviceId) })
    void queryClient.invalidateQueries({ queryKey: keys.devices })
    void queryClient.invalidateQueries({ queryKey: ['fleet'] })
    void navigate({ to: '/devices' })
  }

  const lifecycle = useMutation({
    mutationFn: async (action: 'approve' | 'reject' | 'revoke' | 'delete') => {
      if (action === 'approve') await devicesApi.approve(deviceId)
      else if (action === 'reject') await devicesApi.reject(deviceId)
      else if (action === 'revoke') await devicesApi.revoke(deviceId)
      else await devicesApi.remove(deviceId)
      return action
    },
    onSuccess: (action) => {
      setConfirm(null)
      const name = device ? deviceName(device) : 'Device'
      if (action === 'reject' || action === 'delete') {
        toast.success(action === 'reject' ? `Rejected ${name}` : `Deleted ${name}`)
        afterRemoval()
        return
      }
      toast.success(action === 'approve' ? `Approved ${name}` : `Revoked ${name}`)
      void queryClient.invalidateQueries({ queryKey: keys.device(deviceId) })
      void queryClient.invalidateQueries({ queryKey: keys.devices })
      void queryClient.invalidateQueries({ queryKey: ['fleet'] })
    },
  })

  if (error) {
    return (
      <div className="flex h-full">
        <DevicesContextPanel />
        <div className="min-w-0 flex-1 overflow-y-auto">
          <PageContainer>
            <ErrorState
              error={error}
              title={isApiError(error) && error.status === 404 ? 'Device not found' : 'Could not load this device'}
              onRetry={() => void refetch()}
            />
          </PageContainer>
        </div>
      </div>
    )
  }

  const band = device ? (device.status === 'active' ? healthBand(device.health.score) : 'unknown') : 'unknown'
  const softwareCount = inventory.data?.sections.software?.data.items?.length
  const cpu = live.latest?.cpu ?? device?.cpu_pct ?? null
  const mem = live.latest?.mem ?? device?.mem_pct ?? null
  const tabProps = { inventory: inventory.data, loading: inventory.isLoading }
  const powerAccess = device
    ? remoteAccess(device, hasPermission(me, PERMISSIONS.remotePower), { permissionLabel: 'Power and messages' })
    : null
  const filesAccess = device ? remoteToolAccess(device, me, 'files') : null
  const runScriptAccess: RemoteAccess = !hasPermission(me, PERMISSIONS.scriptsRun)
    ? { ok: false, block: 'permission', reason: 'You need the “Run scripts” permission' }
    : device?.status !== 'active'
      ? { ok: false, block: 'inactive', reason: 'Scripts run on active devices only' }
      : { ok: true, block: null, reason: '' }

  return (
    <div className="flex h-full">
      <DevicesContextPanel />
      <div className="min-w-0 flex-1 overflow-y-auto">
        {isLoading || !device ? (
          <PageContainer className="grid gap-4">
            <Skeleton className="h-32 rounded-xl" />
            <div className="grid gap-4 lg:grid-cols-3">
              <Skeleton className="h-64 rounded-xl lg:col-span-2" />
              <Skeleton className="h-64 rounded-xl" />
            </div>
          </PageContainer>
        ) : (
          <Tabs value={remoteTab ? 'remote' : tab} onValueChange={(value) => setTab(String(value))} className="gap-0">
            <div
              className="relative border-b border-border"
              style={{ background: `linear-gradient(180deg, color-mix(in oklch, ${HEADER_TINT[band]} 8%, transparent) 0%, transparent 100%)` }}
            >
              <div className="bg-grid pointer-events-none absolute inset-0 opacity-40 [mask-image:linear-gradient(180deg,#000_0%,transparent_75%)]" aria-hidden="true" />
              <PageContainer className="relative grid gap-5 pb-0 sm:pb-0">
                <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                  <div className="flex min-w-0 items-start gap-4">
                    <OsTile family={device.os_family} size="lg" />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <h1 className="font-display truncate text-2xl font-semibold tracking-tight">{deviceName(device)}</h1>
                        <ConnectionPill device={device} />
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-dense text-muted-foreground">
                        <Link to="/clients/$clientId" params={{ clientId: device.client_id }} className="font-medium text-foreground/90 hover:text-foreground hover:underline">
                          {device.client_name}
                        </Link>
                        <span className="text-subtle-foreground">/</span>
                        <span>{device.site_name}</span>
                        <span className="text-subtle-foreground">·</span>
                        {device.display_name && (
                          <>
                            <Mono>{device.hostname}</Mono>
                            <span className="text-subtle-foreground">·</span>
                          </>
                        )}
                        <span>{device.os_name}</span>
                        {device.model && (
                          <>
                            <span className="text-subtle-foreground">·</span>
                            <span className="truncate">{device.model}</span>
                          </>
                        )}
                      </div>
                      {device.tags.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {device.tags.map((tagName) => (
                            <Link
                              key={tagName}
                              to="/devices"
                              search={{ tag: tagName }}
                              className="inline-flex h-5 items-center rounded-[5px] bg-surface-3 px-1.5 font-mono text-[10.5px] text-secondary-foreground ring-1 ring-border hover:bg-surface-4"
                            >
                              {tagName}
                            </Link>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {canManage && device.status === 'active' && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={refreshInventory.isPending}
                        onClick={() => refreshInventory.mutate([device])}
                      >
                        <RefreshCw data-icon="inline-start" className={cn(refreshInventory.isPending && 'animate-spin')} />
                        Refresh inventory
                      </Button>
                    )}
                    <div className="flex items-center gap-1 rounded-lg bg-surface-2/70 p-0.5 ring-1 ring-border" role="group" aria-label="Remote tools">
                      <RemoteButton icon={<SquareTerminal />} label={liveShell ? 'Back to terminal' : 'Open terminal'} access={terminalAccess!} onClick={() => openTerminal(true)} />
                      <RemoteButton icon={<FolderOpen />} label="Browse files" access={filesAccess!} onClick={() => setTab('files')} />
                      <RemoteButton icon={<MonitorPlay />} label={liveDesktop ? 'Back to remote desktop' : 'Remote desktop'} access={desktopAccess!} onClick={openDesktop} />
                      <RemoteButton icon={<FileCode />} label="Run script" access={runScriptAccess} onClick={() => openRunDialog({ target: { type: 'devices', ids: [device.id] } })} />
                    </div>
                    {canManage && (
                      <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                        <Pencil data-icon="inline-start" />
                        Edit
                      </Button>
                    )}
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="outline" size="icon-sm" aria-label="More actions" />}>
                        <Ellipsis />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-56">
                        <DropdownMenuGroup>
                          <DropdownMenuLabel>{device.hostname}</DropdownMenuLabel>
                          <DropdownMenuItem
                            onClick={async () => {
                              if (await copyText(device.hostname)) toast.success('Hostname copied')
                            }}
                          >
                            <Copy />
                            Copy hostname
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={async () => {
                              if (await copyText(device.id)) toast.success('Device ID copied')
                            }}
                          >
                            <Copy />
                            Copy device ID
                          </DropdownMenuItem>
                        </DropdownMenuGroup>
                        {device.status === 'active' && powerAccess && (
                          <RemoteMenuItems
                            device={device}
                            powerAccess={powerAccess}
                            terminalAccess={terminalAccess!}
                            desktopAccess={desktopAccess!}
                            onTerminal={() => openTerminal(true)}
                            onDesktop={openDesktop}
                            onRestart={setRestart}
                            onSessionPower={setSessionPower}
                            onMessage={() => setMessageOpen(true)}
                          />
                        )}
                        {device.status === 'pending' && canApprove && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => lifecycle.mutate('approve')}>
                              <Check />
                              Approve enrollment
                            </DropdownMenuItem>
                            <DropdownMenuItem variant="destructive" onClick={() => setConfirm('reject')}>
                              <X />
                              Reject enrollment
                            </DropdownMenuItem>
                          </>
                        )}
                        {device.status !== 'pending' && device.status !== 'revoked' && canManage && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="destructive" onClick={() => setConfirm('revoke')}>
                              <Ban />
                              Revoke agent…
                            </DropdownMenuItem>
                          </>
                        )}
                        {device.status === 'revoked' && canDelete && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="destructive" onClick={() => setConfirm('delete')}>
                              <Trash />
                              Delete device…
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>

                <div className="flex flex-wrap items-end gap-x-7 gap-y-3">
                  <HealthPopover device={device} onTab={setTab} />
                  <HeaderStat label="CPU" hint={live.live ? <span className="text-live">live</span> : undefined}>
                    {cpu == null ? '—' : `${Math.round(cpu)}%`}
                  </HeaderStat>
                  <HeaderStat label="Memory">{mem == null ? '—' : `${Math.round(mem)}%`}</HeaderStat>
                  <HeaderStat label="Disk">{device.disk_pct == null ? '—' : `${Math.round(device.disk_pct)}%`}</HeaderStat>
                  <HeaderStat label="Uptime">{device.uptime_s ? formatDuration(device.uptime_s) : '—'}</HeaderStat>
                  <HeaderStat label="IP address">
                    <span className="font-mono text-[13px]">{device.last_ip ?? '—'}</span>
                  </HeaderStat>
                  <HeaderStat label="Last user">
                    <span className="block max-w-44 truncate text-[13px]">{device.last_user ?? '—'}</span>
                  </HeaderStat>
                  <HeaderStat label="Agent">
                    <span className="font-mono text-[13px]">{device.agent_version}</span>
                  </HeaderStat>
                  <HeaderStat label="Last seen">
                    {device.online ? <span className="text-[13px] text-live">Connected</span> : <RelativeTime value={device.last_seen_at} className="text-[13px]" />}
                  </HeaderStat>
                </div>

                <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] sm:-mx-6 sm:px-6">
                  <TabsList variant="line" className="-mb-px h-10 w-max gap-4">
                    {DEVICE_TABS.filter((value) => value !== 'secrets' || canSecrets).map((value) => (
                      <TabsTrigger key={value} value={value} className="flex-none px-0">
                        {COCKPIT_TAB_LABEL[value]}
                        {value === 'monitoring' && <MonitoringTabCount deviceId={device.id} />}
                        {value === 'tickets' && <DeviceTicketCount deviceId={device.id} />}
                        {value === 'software' && softwareCount !== undefined && (
                          <span className="tabular text-micro text-subtle-foreground">{formatNumber(softwareCount)}</span>
                        )}
                      </TabsTrigger>
                    ))}
                    <span className="h-4 w-px self-center bg-border-strong" aria-hidden="true" />
                    <TabsTrigger value="remote" className="flex-none gap-1.5 px-0">
                      <Zap className={cn('size-3.5', device.online && device.status === 'active' ? 'text-live' : 'text-subtle-foreground')} />
                      Remote
                      {liveDesktop && (
                        <span className="inline-flex h-4 items-center gap-1 rounded-full bg-live/12 px-1.5 text-[9.5px] font-semibold tracking-wide text-live uppercase ring-1 ring-live/25">
                          <span className="inline-flex size-1.5 animate-pulse-ring rounded-full bg-live" />
                          Live
                        </span>
                      )}
                      {liveShell && (
                        <span className="inline-flex h-4 items-center gap-1 rounded-full bg-critical/12 px-1.5 text-[9.5px] font-semibold tracking-wide text-critical uppercase ring-1 ring-critical/25">
                          <span className="inline-flex size-1.5 animate-pulse-ring rounded-full bg-critical" />
                          Rec
                        </span>
                      )}
                    </TabsTrigger>
                  </TabsList>
                </div>
              </PageContainer>
            </div>

            <PageContainer className="grid gap-4 [&>*]:min-w-0">
              {device.status === 'pending' && (
                <LifecycleBanner
                  tone="info"
                  icon={<Inbox className="size-4" />}
                  title={device.replaces_device_id ? 'Re-enrollment waiting for approval' : 'Waiting for approval'}
                  description={
                    device.replaces_device_id ? (
                      <>
                        This agent identifies as an existing device. Approving retires the{' '}
                        <Link to="/devices/$deviceId" params={{ deviceId: device.replaces_device_id }} className="font-medium text-foreground underline-offset-2 hover:underline">
                          previous enrollment
                        </Link>{' '}
                        and carries on with this one.
                      </>
                    ) : (
                      'It enrolled with a deploy key that requires approval. Until then it receives no commands and reports only basic inventory.'
                    )
                  }
                  actions={
                    canApprove && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => setConfirm('reject')}>
                          Reject
                        </Button>
                        <Button size="sm" disabled={lifecycle.isPending} onClick={() => lifecycle.mutate('approve')}>
                          {lifecycle.isPending && lifecycle.variables === 'approve' ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" />}
                          Approve
                        </Button>
                      </>
                    )
                  }
                />
              )}
              {device.status === 'revoked' && (
                <LifecycleBanner
                  tone="neutral"
                  icon={<Ban className="size-4" />}
                  title="Agent revoked"
                  description="This device can no longer connect or receive commands. Its history stays available until you delete it."
                  actions={
                    canDelete && (
                      <Button size="sm" variant="destructive-soft" onClick={() => setConfirm('delete')}>
                        <Trash data-icon="inline-start" />
                        Delete device
                      </Button>
                    )
                  }
                />
              )}

              <TabsContent value="overview">
                <OverviewTab device={device} inventory={inventory.data} inventoryLoading={inventory.isLoading} live={live} onTab={setTab} />
              </TabsContent>
              <TabsContent value="monitoring">
                <DeviceMonitoringTab device={device} />
              </TabsContent>
              <TabsContent value="performance">
                <PerformanceTab device={device} />
              </TabsContent>
              <TabsContent value="hardware">
                <HardwareTab device={device} {...tabProps} />
              </TabsContent>
              <TabsContent value="software">
                <DeviceSoftwareTab device={device} {...tabProps} />
              </TabsContent>
              <TabsContent value="storage">
                <StorageTab device={device} {...tabProps} />
              </TabsContent>
              <TabsContent value="network">
                <NetworkTab device={device} {...tabProps} />
              </TabsContent>
              <TabsContent value="security">
                <SecurityTab device={device} {...tabProps} />
              </TabsContent>
              <TabsContent value="users">
                <UsersTab device={device} {...tabProps} />
              </TabsContent>
              <TabsContent value="patches">
                <DevicePatchesTab device={device} {...tabProps} />
              </TabsContent>
              <TabsContent value="scripts">
                <DeviceScriptsTab device={device} />
              </TabsContent>
              <TabsContent value="policy">
                <DevicePolicyTab device={device} />
              </TabsContent>
              <TabsContent value="secrets">
                <DeviceSecretsTab device={device} />
              </TabsContent>
              <TabsContent value="tickets">
                <DeviceTicketsTab device={device} />
              </TabsContent>
              <TabsContent value="timeline">
                <TimelineTab deviceId={device.id} />
              </TabsContent>
              <TabsContent value="notes">
                <NotesTab device={device} />
              </TabsContent>
              <TabsContent value="remote" className="grid gap-4 [&>*]:min-w-0">
                {remoteTab && (
                  <>
                    <RemoteNav device={device} tab={remoteTab} onTab={setTab} />
                    <RemoteToolPanel device={device} tab={remoteTab} inventory={inventory.data} inventoryLoading={inventory.isLoading} />
                    {remoteTab === 'terminal' && !terminalMounted && terminalAccess && !terminalAccess.ok && (
                      <ToolUnavailable access={terminalAccess} tool="The terminal" lastSeen={device.last_seen_at} />
                    )}
                    {remoteTab === 'desktop' && !desktopMounted && desktopAccess && !desktopAccess.ok && (
                      <ToolUnavailable access={desktopAccess} tool="Remote desktop" lastSeen={device.last_seen_at} />
                    )}
                  </>
                )}
              </TabsContent>
              {terminalMounted && (
                <div hidden={tab !== 'terminal'} className="min-w-0">
                  <TerminalPanel device={device} active={tab === 'terminal'} />
                </div>
              )}
              {desktopMounted && (
                <div hidden={tab !== 'desktop'} className="min-w-0">
                  <DesktopPanel device={device} active={tab === 'desktop'} />
                </div>
              )}
            </PageContainer>
          </Tabs>
        )}
      </div>

      {device && (
        <>
          <EditDeviceDialog device={device} open={editing} onOpenChange={setEditing} />
          <ConfirmDialog
            open={confirm === 'revoke'}
            onOpenChange={(open) => !open && setConfirm(null)}
            title={`Revoke ${deviceName(device)}?`}
            description="The agent's identity is invalidated immediately: it disconnects and can't reconnect or receive commands. To manage this machine again you'll need to reinstall the agent with a deploy key."
            confirmLabel="Revoke agent"
            confirmText={device.hostname}
            pending={lifecycle.isPending}
            onConfirm={() => lifecycle.mutate('revoke')}
          />
          <ConfirmDialog
            open={confirm === 'delete'}
            onOpenChange={(open) => !open && setConfirm(null)}
            title={`Delete ${deviceName(device)}?`}
            description="This permanently removes the device with its inventory, metrics, timeline and notes. This can't be undone."
            confirmLabel="Delete device"
            confirmText={device.hostname}
            pending={lifecycle.isPending}
            onConfirm={() => lifecycle.mutate('delete')}
          />
          <ConfirmDialog
            open={confirm === 'reject'}
            onOpenChange={(open) => !open && setConfirm(null)}
            title={`Reject ${device.hostname}?`}
            description="The enrollment request is discarded and the agent is told to stop. It can enroll again with a valid deploy key."
            confirmLabel="Reject enrollment"
            pending={lifecycle.isPending}
            onConfirm={() => lifecycle.mutate('reject')}
          />
          <RestartDialog
            device={device}
            open={restart !== null || Boolean(powerIntent)}
            initialAction={restart ?? 'reboot'}
            onOpenChange={(open) => {
              if (open) return
              setRestart(null)
              if (powerIntent) consumeRemoteIntent(powerIntent.nonce)
            }}
          />
          <SessionPowerDialogs device={device} kind={sessionPower} onOpenChange={(open) => !open && setSessionPower(null)} />
          <MessageDialog
            device={device}
            open={messageOpen || Boolean(messageIntent)}
            onOpenChange={(open) => {
              if (open) return
              setMessageOpen(false)
              if (messageIntent) consumeRemoteIntent(messageIntent.nonce)
            }}
          />
        </>
      )}
    </div>
  )
}

/** Remote section of the cockpit's actions menu: terminal, power and messaging. */
function RemoteMenuItems({
  device,
  powerAccess,
  terminalAccess,
  desktopAccess,
  onTerminal,
  onDesktop,
  onRestart,
  onSessionPower,
  onMessage,
}: {
  device: DeviceDetail
  powerAccess: RemoteAccess
  terminalAccess: RemoteAccess
  desktopAccess: RemoteAccess
  onTerminal: () => void
  onDesktop: () => void
  onRestart: (action: 'reboot' | 'shutdown') => void
  onSessionPower: (action: 'logoff' | 'lock') => void
  onMessage: () => void
}) {
  const power = usePowerAction(device)
  const sessionPower = supportsSessionPower(device.os_family)
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuLabel className="flex items-center justify-between gap-2">
          Remote
          {!powerAccess.ok && powerAccess.block === 'offline' && <span className="font-normal text-subtle-foreground">Device offline</span>}
        </DropdownMenuLabel>
        <DropdownMenuItem disabled={!desktopAccess.ok} onClick={onDesktop}>
          <MonitorPlay />
          Remote desktop
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!terminalAccess.ok} onClick={onTerminal}>
          <SquareTerminal />
          Open terminal
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={!powerAccess.ok}>
            <Power />
            Power
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-56">
            <DropdownMenuItem onClick={() => onRestart('reboot')}>
              <RotateCw />
              Restart…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onRestart('shutdown')}>
              <Power />
              Shut down…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => power.mutate({ action: 'cancel' })}>
              <CircleX />
              Cancel pending restart
            </DropdownMenuItem>
            {sessionPower && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onSessionPower('lock')}>
                  <Lock />
                  Lock workstation
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={() => onSessionPower('logoff')}>
                  <LogOut />
                  Sign out user…
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem disabled={!powerAccess.ok} onClick={onMessage}>
          <MessageSquareText />
          Message user…
        </DropdownMenuItem>
        {!powerAccess.ok && powerAccess.block === 'permission' && (
          <p className="px-1.5 pt-0.5 pb-1 text-micro text-subtle-foreground">{powerAccess.reason}</p>
        )}
      </DropdownMenuGroup>
    </>
  )
}

function LifecycleBanner({
  tone,
  icon,
  title,
  description,
  actions,
}: {
  tone: 'info' | 'neutral'
  icon: ReactNode
  title: string
  description: ReactNode
  actions?: ReactNode
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-3 rounded-xl px-4 py-3 ring-1',
        tone === 'info' ? 'bg-info/[0.07] ring-info/25' : 'bg-surface-2 ring-border-strong',
      )}
    >
      <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', tone === 'info' ? 'bg-info/15 text-info' : 'bg-surface-3 text-muted-foreground')}>
        {icon}
      </span>
      <div className="min-w-0 flex-1 basis-64">
        <p className="text-dense font-medium">{title}</p>
        <p className="text-micro text-muted-foreground">{description}</p>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

