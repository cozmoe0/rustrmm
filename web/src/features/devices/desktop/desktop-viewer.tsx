/* Remote desktop viewer: connect panel, toolbar, the live screen and its overlays. Lazy-loaded. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Camera,
  Ellipsis,
  Eye,
  EyeOff,
  Gauge,
  Hourglass,
  Keyboard,
  Maximize2,
  Minimize2,
  MonitorPlay,
  Proportions,
  RefreshCw,
  ShieldCheck,
  SquareArrowOutUpRight,
  Unplug,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Spinner } from '@/components/ui/spinner'
import { saveBlob } from '@/lib/api/client'
import { desktopApi } from '@/lib/api/endpoints'
import { effectivePolicyQuery, keys } from '@/lib/api/queries'
import type { DeviceDetail } from '@/lib/api/types'
import { DESKTOP_POLICY_DEFAULTS } from '@/lib/automation/policy'
import { copyText } from '@/lib/clipboard'
import type { DesktopQuality } from '@/lib/desktop/control'
import { SPECIAL_KEYS, type SpecialKey } from '@/lib/desktop/input'
import { formatResolution } from '@/lib/desktop/viewport'
import { deviceName } from '@/lib/devices'
import { formatBytes, formatClock } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { useNow } from '../remote-hooks'
import { remoteToolAccess } from '../remote-access'
import { consumeRemoteIntent, setLiveDesktop, useRemoteIntent } from '../remote-state'
import { ClipboardPanel } from './desktop-clipboard'
import { ConnectPanel, type ConnectRequest } from './desktop-connect'
import {
  ConnectingCard,
  ConsentCard,
  EndedCard,
  FullscreenHint,
  IdleWarning,
  ReconnectCountdown,
  SecureDesktopChip,
  StageCard,
  StatsOverlay,
  SwitchingChip,
  type StatsView,
} from './desktop-overlays'
import { DesktopStage, type DesktopStageHandle } from './desktop-stage'
import { KeysMenu, MonitorPicker, QualityMenu, ToolbarButton, ToolbarDivider } from './desktop-toolbar'
import { QUALITY_OPTIONS, desktopPrefsStore, policyRefusal, preferredSession, screenshotFileName, sessionKey, sessionTitle, setDesktopPref } from './desktop-access'
import { isDesktopBusy, useDesktopSession, type DesktopSnapshot } from './use-desktop-session'
import type { ScreenshotData } from './desktop-screenshot-card'

/** Delays before automatic reconnect attempts after a dropped connection. */
const RECONNECT_DELAYS = [1500, 4000, 9000]

type KeyboardApi = { lock?: (codes?: string[]) => Promise<void>; unlock?: () => void }
const keyboardApi = () => (navigator as Navigator & { keyboard?: KeyboardApi }).keyboard

export interface DesktopViewerProps {
  device: DeviceDetail
  /** Whether the viewer is on screen (the cockpit keeps it mounted on other tabs). */
  active: boolean
  variant?: 'embedded' | 'window'
  /** Connect straight away (pop-out window). */
  initial?: { sessionId?: number | null; viewOnly?: boolean; quality?: DesktopQuality; connect?: boolean }
}

function StatePill({ state, elapsed }: { state: DesktopSnapshot; elapsed: number }) {
  const { phase } = state
  const waiting = phase === 'connecting' && state.consent === 'waiting'
  const tone =
    phase === 'ready'
      ? 'bg-live/12 text-live ring-live/25'
      : waiting
        ? 'bg-warning/12 text-warning ring-warning/25'
        : phase === 'starting' || phase === 'connecting'
          ? 'bg-info/12 text-info ring-info/25'
          : phase === 'ended' && (state.end === 'failed' || state.end === 'error')
            ? 'bg-critical/12 text-critical ring-critical/25'
            : 'bg-surface-3 text-muted-foreground ring-border-strong'
  const label =
    phase === 'ready'
      ? state.viewOnly
        ? 'Viewing'
        : 'Live'
      : waiting
        ? 'Waiting for user'
        : phase === 'starting' || phase === 'connecting'
          ? 'Connecting'
          : phase === 'ended'
            ? state.end === 'denied'
              ? 'Denied'
              : state.end === 'timeout'
                ? 'No answer'
                : state.end === 'failed' || state.end === 'error'
                  ? 'Failed'
                  : state.end === 'dropped'
                    ? 'Disconnected'
                    : 'Ended'
            : 'Not connected'
  return (
    <span className={cn('inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-micro font-semibold ring-1', tone)}>
      {phase === 'ready' ? (
        <span className="relative inline-flex size-2 animate-pulse-ring rounded-full bg-current" aria-hidden="true" />
      ) : waiting ? (
        <Hourglass className="size-3" />
      ) : phase === 'starting' || phase === 'connecting' ? (
        <Spinner className="size-3" />
      ) : (
        <span className="inline-flex size-2 rounded-full bg-current opacity-70" aria-hidden="true" />
      )}
      {label}
      {state.readyAt && (phase === 'ready' || phase === 'ended') && <span className="tabular font-mono text-[10.5px] font-medium opacity-80">{formatClock(elapsed)}</span>}
    </span>
  )
}

export default function DesktopViewer({ device, active, variant = 'embedded', initial }: DesktopViewerProps) {
  const me = useMe()
  const prefs = useStore(desktopPrefsStore)
  const access = remoteToolAccess(device, me, 'desktop')
  const canManagePolicies = hasPermission(me, PERMISSIONS.policiesManage)
  const [coarse] = useState(() => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches)

  const sessions = useQuery({
    queryKey: keys.desktopSessions(device.id),
    queryFn: () => desktopApi.sessions(device.id),
    enabled: access.ok,
    staleTime: 20_000,
    refetchOnWindowFocus: false,
    meta: { silent: true },
  })
  const policy = useQuery({ ...effectivePolicyQuery(device.id), staleTime: 30_000, meta: { silent: true } })
  const cachedShot = useQuery<ScreenshotData>({ queryKey: keys.desktopScreenshot(device.id), queryFn: () => Promise.reject(new Error('not cached')), enabled: false })
  const remotePolicy = policy.data?.document.remote_access
  const forcedViewOnly = remotePolicy?.desktop_view_only === true
  const consentMode = remotePolicy?.desktop_consent ?? DESKTOP_POLICY_DEFAULTS.desktop_consent
  const consentTimeout = remotePolicy?.consent_timeout_secs ?? DESKTOP_POLICY_DEFAULTS.consent_timeout_secs
  const banner = remotePolicy?.desktop_banner !== false

  const items = sessions.data?.items ?? []
  const [picked, setPicked] = useState<string | null>(null)
  const preferred = preferredSession(items)
  const selectedKey =
    picked && items.some((item, index) => sessionKey(item, index) === picked) ? picked : preferred ? sessionKey(preferred, items.indexOf(preferred)) : null
  const [viewOnlyChoice, setViewOnlyChoice] = useState(initial?.viewOnly ?? false)
  // A pop-out window starts with the quality it was opened with; otherwise the saved preference.
  const [qualityChoice, setQualityChoice] = useState<DesktopQuality | null>(initial?.quality ?? null)
  const quality = qualityChoice ?? prefs.quality

  const stageRef = useRef<DesktopStageHandle>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [clipboardUnread, setClipboardUnread] = useState(false)
  const [clipboardOpen, setClipboardOpen] = useState(false)
  const [focused, setFocused] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [keyboardLocked, setKeyboardLocked] = useState(false)
  const [hintKey, setHintKey] = useState(0)
  const [reconnectCancelled, setReconnectCancelled] = useState(false)
  const [stats, setStats] = useState<StatsView | null>(null)

  const session = useDesktopSession(device.id, {
    cursorShape: (message) => stageRef.current?.cursorShape(message),
    cursorPosition: (message) => stageRef.current?.cursorPosition(message),
    clipboard: (text) => {
      if (prefs.autoClipboard) {
        void copyText(text).then((ok) => {
          if (!ok) setClipboardUnread(true)
        })
      } else if (!clipboardOpen) setClipboardUnread(true)
    },
    agentError: (message) => toast.error('The agent reported a problem', { description: message }),
  })
  const { state, start: startSession, getMeter, getTraffic } = session
  const busy = isDesktopBusy(state.phase)
  const ready = state.phase === 'ready'
  const interactive = ready && !state.viewOnly
  const now = useNow(1000, busy)
  const elapsed = state.readyAt ? Math.max(0, ((state.endedAt ?? now) - state.readyAt) / 1000) : 0
  const label = deviceName(device)
  const windows = device.os_family === 'windows'

  /** Starts a session without touching local state (safe to call from effects). */
  const launch = useCallback(
    (request: ConnectRequest, reconnect = false) => {
      void startSession({ sessionId: request.sessionId, viewOnly: request.viewOnly, quality: request.quality, reconnect })
      window.requestAnimationFrame(() => stageRef.current?.focus())
    },
    [startSession],
  )

  const connect = useCallback(
    (request: ConnectRequest, reconnect = false) => {
      if (!reconnect) setReconnectCancelled(false)
      launch(request, reconnect)
    },
    [launch],
  )

  const reconnectRequest = useCallback(
    (): ConnectRequest => ({ sessionId: state.request.session_id ?? null, viewOnly: forcedViewOnly || state.viewOnly, quality: state.quality }),
    [forcedViewOnly, state.request.session_id, state.viewOnly, state.quality],
  )

  // Automatic reconnect after a dropped connection (not after the server ended the session).
  const autoReconnectAt =
    state.phase === 'ended' && state.end === 'dropped' && !reconnectCancelled && state.reconnectAttempt < RECONNECT_DELAYS.length && state.endedAt
      ? state.endedAt + RECONNECT_DELAYS[state.reconnectAttempt]
      : null
  useEffect(() => {
    if (autoReconnectAt === null || !access.ok) return
    const timer = window.setTimeout(() => launch(reconnectRequest(), true), Math.max(0, autoReconnectAt - Date.now()))
    return () => window.clearTimeout(timer)
  }, [autoReconnectAt, access.ok, launch, reconnectRequest])

  // "Remote desktop to…" from the palette or the header connects straight away.
  const intent = useRemoteIntent(device.id, 'connect-desktop')
  useEffect(() => {
    if (!intent || sessions.isLoading) return
    consumeRemoteIntent(intent.nonce)
    if (access.ok && !busy && !sessions.error) launch({ sessionId: preferred?.session_id ?? null, viewOnly: forcedViewOnly, quality })
  }, [intent, sessions.isLoading, sessions.error, access.ok, busy, launch, preferred, forcedViewOnly, quality])

  // A pop-out window connects once with the options it was opened with.
  const autoStarted = useRef(false)
  useEffect(() => {
    if (!initial?.connect || autoStarted.current || !access.ok || policy.isLoading) return
    autoStarted.current = true
    launch({ sessionId: initial.sessionId ?? null, viewOnly: forcedViewOnly || Boolean(initial.viewOnly), quality: initial.quality ?? quality })
  }, [initial, access.ok, policy.isLoading, forcedViewOnly, quality, launch])

  useEffect(() => {
    setLiveDesktop(device.id, ready)
    return () => setLiveDesktop(device.id, false)
  }, [device.id, ready])

  // Warn before closing the browser tab while connected.
  useEffect(() => {
    if (!busy) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [busy])

  // Viewer statistics for the overlay and the status bar.
  useEffect(() => {
    if (!busy) return
    const tick = () => setStats({ meter: getMeter(), traffic: getTraffic() })
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [busy, getMeter, getTraffic])

  useEffect(() => {
    if (active && ready) stageRef.current?.focus()
  }, [active, ready])

  // ------------------------------------------------------------------ full screen

  const exitFullscreen = useCallback(() => {
    setExpanded(false)
    setKeyboardLocked(false)
    keyboardApi()?.unlock?.()
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
  }, [])

  const enterFullscreen = useCallback(async () => {
    setExpanded(true)
    try {
      if (document.fullscreenEnabled && !document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' })
    } catch {
      // Not allowed here (iOS, iframes): the viewer still fills the window.
    }
    let locked = false
    try {
      const keyboard = keyboardApi()
      if (document.fullscreenElement && keyboard?.lock) {
        await keyboard.lock()
        locked = true
      }
    } catch {
      locked = false
    }
    setKeyboardLocked(locked)
    setHintKey((value) => value + 1)
    stageRef.current?.focus()
  }, [])

  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) {
        setExpanded(false)
        setKeyboardLocked(false)
        keyboardApi()?.unlock?.()
        stageRef.current?.releaseInput()
      }
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  useEffect(
    () => () => {
      keyboardApi()?.unlock?.()
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
    },
    [],
  )

  // ------------------------------------------------------------------ actions

  const popOut = () => {
    const params = new URLSearchParams()
    const sessionId = state.request.session_id ?? (selectedKey ? items.find((item, index) => sessionKey(item, index) === selectedKey)?.session_id : null)
    if (sessionId !== null && sessionId !== undefined) params.set('session', String(sessionId))
    params.set('quality', busy ? state.quality : quality)
    if (busy ? state.viewOnly : viewOnlyChoice) params.set('view_only', 'true')
    params.set('connect', 'true')
    const win = window.open(`/desktop/${device.id}?${params.toString()}`, `rustrmm-desktop-${device.id}`, 'popup=yes,width=1440,height=900')
    if (!win) {
      toast.error('Pop-up blocked', { description: 'Allow pop-ups for this site to open the desktop in its own window.' })
      return
    }
    if (busy) session.disconnect()
    if (expanded) exitFullscreen()
  }

  const saveScreenshot = async () => {
    const blob = await session.snapshot()
    if (!blob) {
      toast.error('Nothing to save yet')
      return
    }
    const name = screenshotFileName(device.hostname)
    saveBlob(blob, name)
    toast.success('Screenshot saved', { description: name })
  }

  /** Toolbar menus hand focus back to the screen while controlling, so keystrokes keep going to the device. */
  const returnFocus = () => (interactive ? (stageRef.current?.element() ?? null) : null)

  const sendCad = () => {
    if (session.sendInput({ type: 'cad' })) toast.message('Ctrl+Alt+Del sent')
    stageRef.current?.focus()
  }

  const sendSpecial = (key: SpecialKey) => {
    session.sendCombo(SPECIAL_KEYS[key].combo)
    stageRef.current?.focus()
  }

  const setQuality = (value: DesktopQuality) => {
    setDesktopPref('quality', value)
    if (busy) session.setQuality(value)
  }

  const toggleViewOnly = () => {
    if (forcedViewOnly) return
    stageRef.current?.releaseInput()
    session.setViewOnly(!state.viewOnly)
  }

  const backToPicker = () => {
    session.reset()
    setReconnectCancelled(false)
    void sessions.refetch()
  }

  // ------------------------------------------------------------------ derived labels

  const currentSession = items.find((item) => item.session_id !== null && item.session_id === state.request.session_id) ?? (state.request.session_id === undefined ? preferred : null)
  const currentMonitor = state.monitors.find((monitor) => monitor.id === state.monitor)
  const switchingMonitor = state.switching !== null ? state.monitors.find((monitor) => monitor.id === state.switching) : null
  const clipboardDisabledReason = !ready ? 'Connect first' : state.viewOnly ? 'Not available in view-only sessions' : undefined
  const consentUser = currentSession?.user ?? null

  return (
    <div
      ref={rootRef}
      className={cn(
        'flex min-w-0 flex-col overflow-hidden bg-card',
        expanded ? 'fixed inset-0 z-50' : variant === 'window' ? 'h-dvh' : 'h-[72dvh] min-h-[440px] rounded-xl shadow-card sm:h-[min(82dvh,920px)] sm:min-h-[500px]',
      )}
      role="region"
      aria-label={`Remote desktop on ${label}`}
    >
      {/* Toolbar */}
      <div className="flex min-h-11 items-center gap-1.5 border-b border-border px-2 py-1.5 sm:gap-2 sm:px-3">
        {(expanded || variant === 'window') && (
          <span className="mr-1 hidden min-w-0 items-center gap-2 text-dense font-medium sm:flex">
            <MonitorPlay className="size-4 shrink-0 text-subtle-foreground" />
            <span className="max-w-48 truncate">{label}</span>
          </span>
        )}
        <StatePill state={state} elapsed={elapsed} />
        {busy && currentSession && <span className="hidden max-w-56 truncate text-micro text-muted-foreground lg:inline">{sessionTitle(currentSession)}</span>}
        {state.phase === 'connecting' && state.status && state.consent !== 'waiting' && (
          <span className="hidden truncate text-micro text-muted-foreground xl:inline">{state.status}</span>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {busy && (
            <>
              <span className="hidden sm:contents">
                <MonitorPicker monitors={state.monitors} active={state.monitor} pending={state.switching} onPick={session.setMonitor} disabled={!ready} returnFocus={returnFocus} />
                <QualityMenu value={state.quality} onChange={setQuality} returnFocus={returnFocus} />
              </span>
              <span className="hidden sm:contents">
                <ToolbarButton
                  label={forcedViewOnly ? 'View-only is required by policy' : state.viewOnly ? 'View only — click to take control' : 'Switch to view only'}
                  onClick={toggleViewOnly}
                  disabled={!ready || forcedViewOnly}
                  pressed={state.viewOnly}
                >
                  {state.viewOnly ? <EyeOff /> : <Eye />}
                </ToolbarButton>
              </span>
              <KeysMenu
                disabled={!interactive}
                onCad={sendCad}
                onSpecial={sendSpecial}
                mapMetaToCtrl={prefs.mapMetaToCtrl}
                onMapMetaToCtrl={(value) => setDesktopPref('mapMetaToCtrl', value)}
                windows={windows}
                returnFocus={returnFocus}
              />
              <ClipboardPanel
                disabled={!interactive}
                disabledReason={clipboardDisabledReason}
                received={state.clipboard}
                unread={clipboardUnread}
                autoCopy={prefs.autoClipboard}
                onOpenChange={(open) => {
                  setClipboardOpen(open)
                  if (open) setClipboardUnread(false)
                }}
                onSend={(text) => session.sendClipboard(text).ok}
                onType={(text) => session.sendText(text)}
                returnFocus={returnFocus}
              />
              {coarse && (
                <ToolbarButton label="On-screen keyboard" onClick={() => stageRef.current?.openKeyboard()} disabled={!interactive}>
                  <Keyboard />
                </ToolbarButton>
              )}
              <ToolbarDivider className="hidden sm:block" />
              <span className="hidden sm:contents">
                <ToolbarButton label={prefs.scale === 'fit' ? 'Actual size (1:1)' : 'Scale to fit'} onClick={() => setDesktopPref('scale', prefs.scale === 'fit' ? 'actual' : 'fit')} pressed={prefs.scale === 'actual'}>
                  <Proportions />
                </ToolbarButton>
                <ToolbarButton label="Save a screenshot" onClick={() => void saveScreenshot()} disabled={!state.screen}>
                  <Camera />
                </ToolbarButton>
                <ToolbarButton label={prefs.stats ? 'Hide stats' : 'Show stats'} onClick={() => setDesktopPref('stats', !prefs.stats)} pressed={prefs.stats}>
                  <Gauge />
                </ToolbarButton>
              </span>
            </>
          )}
          {variant === 'embedded' && (
            <span className="hidden sm:contents">
              <ToolbarButton label="Open in a new window" onClick={popOut} disabled={!access.ok || Boolean(policyRefusal(sessions.error))}>
                <SquareArrowOutUpRight />
              </ToolbarButton>
            </span>
          )}
          <ToolbarButton label={expanded ? 'Exit full screen' : 'Full screen'} onClick={() => (expanded ? exitFullscreen() : void enterFullscreen())}>
            {expanded ? <Minimize2 /> : <Maximize2 />}
          </ToolbarButton>
          {busy && (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="More options" className="sm:hidden" />}>
                <Ellipsis />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60" finalFocus={() => returnFocus() ?? true}>
                {state.monitors.length > 1 && (
                  <>
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>Monitor</DropdownMenuLabel>
                      <DropdownMenuRadioGroup value={String(state.switching ?? state.monitor ?? '')} onValueChange={(value) => session.setMonitor(Number(value))}>
                        {state.monitors.map((monitor) => (
                          <DropdownMenuRadioItem key={monitor.id} value={String(monitor.id)}>
                            {monitor.id + 1}. {monitor.name}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuGroup>
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Quality</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={state.quality} onValueChange={(value) => setQuality(value as DesktopQuality)}>
                    {QUALITY_OPTIONS.map((option) => (
                      <DropdownMenuRadioItem key={option.value} value={option.value}>
                        {option.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuCheckboxItem checked={state.viewOnly} disabled={!ready || forcedViewOnly} onCheckedChange={toggleViewOnly}>
                    View only
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem checked={prefs.scale === 'actual'} onCheckedChange={(value) => setDesktopPref('scale', value ? 'actual' : 'fit')}>
                    Actual size (1:1)
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem checked={prefs.stats} onCheckedChange={(value) => setDesktopPref('stats', Boolean(value))}>
                    Show stats
                  </DropdownMenuCheckboxItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={!state.screen} onClick={() => void saveScreenshot()}>
                  <Camera />
                  Save a screenshot
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!ready} onClick={session.refresh}>
                  <RefreshCw />
                  Refresh the picture
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <ToolbarDivider />
          {busy ? (
            <Button variant="destructive-soft" size="sm" onClick={session.disconnect} aria-label="Disconnect" className="max-sm:w-7 max-sm:px-0">
              <Unplug data-icon="inline-start" />
              <span className="hidden sm:inline">Disconnect</span>
            </Button>
          ) : state.phase === 'ended' ? (
            <Button size="sm" variant="outline" onClick={() => connect(reconnectRequest())} disabled={!access.ok} aria-label="Reconnect" className="max-sm:w-7 max-sm:px-0">
              <RefreshCw data-icon="inline-start" />
              <span className="hidden sm:inline">Reconnect</span>
            </Button>
          ) : null}
        </div>
      </div>

      {/* Audit notice */}
      <div className="flex items-center gap-2 border-b border-border bg-info/[0.045] px-3 py-1.5 text-micro text-muted-foreground">
        <ShieldCheck className="size-3.5 shrink-0 text-info" />
        <span className="shrink-0 font-semibold text-foreground/90">This session is audited.</span>
        <span className="min-w-0 truncate">
          Start, end, consent, view-only changes, Ctrl+Alt+Del and clipboard use are logged
          {banner ? ', and the user sees a “Remote session in progress” banner' : ''}. The screen isn’t recorded.
        </span>
      </div>

      {/* Screen */}
      <div className="relative flex min-h-0 flex-1 flex-col bg-[#0e1014] bg-[radial-gradient(rgb(255_255_255/0.045)_1px,transparent_1px)] bg-[length:18px_18px]">
        {state.phase === 'idle' && cachedShot.data && (
          <img src={cachedShot.data.url} alt="" aria-hidden="true" className="pointer-events-none absolute inset-0 size-full scale-105 object-cover opacity-30 blur-xl" />
        )}
        <DesktopStage
          ref={stageRef}
          session={session}
          screen={state.screen}
          mode={prefs.scale}
          interactive={interactive}
          mapMetaToCtrl={prefs.mapMetaToCtrl}
          onFocusChange={setFocused}
          dimmed={state.phase === 'ended'}
        >
          {ready && <SecureDesktopChip desktop={state.desktop} />}
          {ready && switchingMonitor && <SwitchingChip label={switchingMonitor.name} />}
          {prefs.stats && ready && <StatsOverlay state={state} stats={stats} onClose={() => setDesktopPref('stats', false)} />}
          {ready && expanded && hintKey > 0 && <FullscreenHint key={hintKey} locked={keyboardLocked} />}
          {ready && <IdleWarning lastInputAt={session.getLastInputAt()} viewOnly={state.viewOnly} onStay={() => stageRef.current?.nudge()} />}

          {state.phase === 'idle' && (
            <StageCard>
              <ConnectPanel
                device={device}
                access={access}
                sessions={{ data: sessions.data, error: sessions.error, isLoading: access.ok && sessions.isLoading, isFetching: sessions.isFetching, refetch: () => void sessions.refetch() }}
                selected={selectedKey}
                onSelect={setPicked}
                viewOnly={viewOnlyChoice}
                onViewOnly={setViewOnlyChoice}
                forcedViewOnly={forcedViewOnly}
                quality={quality}
                onQuality={(value) => {
                  setQualityChoice(value)
                  setDesktopPref('quality', value)
                }}
                consentMode={consentMode}
                consentTimeout={consentTimeout}
                canManagePolicies={canManagePolicies}
                onConnect={(request) => connect(request)}
              />
            </StageCard>
          )}
          {(state.phase === 'starting' || state.phase === 'connecting') && state.consent !== 'waiting' && (
            <ConnectingCard deviceLabel={label} status={state.status} onCancel={session.disconnect} />
          )}
          {state.phase === 'connecting' && state.consent === 'waiting' && (
            <ConsentCard user={consentUser} since={state.consentAt ?? state.startedAt ?? 0} timeoutSecs={consentTimeout} onCancel={session.disconnect} />
          )}
          {state.phase === 'ended' &&
            (autoReconnectAt !== null && access.ok ? (
              <ReconnectCountdown
                attempt={state.reconnectAttempt + 1}
                max={RECONNECT_DELAYS.length}
                at={autoReconnectAt}
                onNow={() => connect(reconnectRequest(), true)}
                onCancel={() => setReconnectCancelled(true)}
              />
            ) : (
              <EndedCard state={state} elapsed={elapsed} canReconnect={access.ok} reconnectReason={access.ok ? undefined : access.reason} onReconnect={() => connect(reconnectRequest())} onBack={backToPicker} />
            ))}
        </DesktopStage>
      </div>

      {/* Status bar */}
      <div className="flex min-h-6 items-center gap-3 border-t border-border bg-surface-2/60 px-3 py-1 font-mono text-[10.5px] text-subtle-foreground">
        <span className="truncate">
          {currentMonitor ? `${currentMonitor.name} · ` : ''}
          {formatResolution(state.screen)}
        </span>
        {state.sessionId && <span className="hidden truncate sm:inline">session {state.sessionId.slice(0, 8)}</span>}
        {busy && stats && <span className="tabular hidden sm:inline">↓ {formatBytes(stats.traffic.bytesIn)}</span>}
        {busy && state.viewOnly && <span className="text-warning">view only{forcedViewOnly ? ' (policy)' : ''}</span>}
        <span className="ml-auto hidden truncate font-sans md:inline">
          {interactive
            ? focused
              ? keyboardLocked
                ? 'Keyboard captured · hold Esc to exit full screen'
                : 'Keyboard and mouse go to the device · Ctrl+V pastes your clipboard'
              : 'Click the screen to type'
            : ready
              ? 'Viewing only — input is not sent'
              : 'Ctrl+Alt+Del and special keys are in the keyboard menu'}
        </span>
      </div>
    </div>
  )
}
