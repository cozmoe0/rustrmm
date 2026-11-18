/* Remote terminal: xterm.js over the recorded remote-session WebSocket. Lazy-loaded with xterm. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import {
  CircleExclamationPoint,
  ClipboardPaste,
  Copy,
  Eraser,
  Maximize2,
  Minimize2,
  Play,
  RefreshCw,
  RotateCcwClock,
  SquareTerminal,
  Unplug,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SimpleSelect } from '@/components/common/simple-select'
import { copyText } from '@/lib/clipboard'
import type { DeviceDetail } from '@/lib/api/types'
import { deviceName } from '@/lib/devices'
import { formatBytes, formatClock } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { remoteAccess, shellLabel, shellOptions } from '@/lib/remote'
import { useTheme } from '@/lib/theme'
import { cn } from '@/lib/utils'
import { REMOTE_TOOL } from './cockpit-tabs'
import { useNow } from './remote-hooks'
import { consumeRemoteIntent, requestPlayback, setLiveShell, useRemoteIntent } from './remote-state'
import { GatedButton } from './remote-ui'
import { TERMINAL_FONT, TERMINAL_THEMES, loadTerminalFont } from './terminal-theme'
import { isShellBusy, isShellEnded, useShellSession, type ShellSnapshot } from './use-shell-session'

const MOBILE_KEYS: { label: string; data: string; aria: string }[] = [
  { label: 'Esc', data: '\x1b', aria: 'Escape' },
  { label: 'Tab', data: '\t', aria: 'Tab' },
  { label: '^C', data: '\x03', aria: 'Control C' },
  { label: '^D', data: '\x04', aria: 'Control D' },
  { label: '↑', data: '\x1b[A', aria: 'Up arrow' },
  { label: '↓', data: '\x1b[B', aria: 'Down arrow' },
  { label: '←', data: '\x1b[D', aria: 'Left arrow' },
  { label: '→', data: '\x1b[C', aria: 'Right arrow' },
]

function dim(text: string) {
  return `\r\n\x1b[0m\x1b[90m${text}\x1b[0m\r\n`
}

function StatePill({ state, elapsed }: { state: ShellSnapshot; elapsed: number }) {
  const { phase } = state
  const tone =
    phase === 'ready'
      ? 'bg-live/12 text-live ring-live/25'
      : phase === 'starting' || phase === 'connecting'
        ? 'bg-info/12 text-info ring-info/25'
        : phase === 'error'
          ? 'bg-critical/12 text-critical ring-critical/25'
          : 'bg-surface-3 text-muted-foreground ring-border-strong'
  const label =
    phase === 'ready'
      ? 'Connected'
      : phase === 'starting' || phase === 'connecting'
        ? 'Connecting'
        : phase === 'exited'
          ? `Exited${state.exitCode !== null ? ` · code ${state.exitCode}` : ''}`
          : phase === 'closed'
            ? 'Closed'
            : phase === 'error'
              ? 'Error'
              : 'Not connected'
  return (
    <span className={cn('inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-micro font-semibold ring-1', tone)}>
      {phase === 'ready' ? (
        <span className="relative inline-flex size-2 rounded-full bg-current animate-pulse-ring" aria-hidden="true" />
      ) : phase === 'starting' || phase === 'connecting' ? (
        <Spinner className="size-3" />
      ) : (
        <span className="inline-flex size-2 rounded-full bg-current opacity-70" aria-hidden="true" />
      )}
      {label}
      {(phase === 'ready' || isShellEnded(phase)) && state.readyAt && (
        <span className="tabular font-mono text-[10.5px] font-medium opacity-80">{formatClock(elapsed)}</span>
      )}
    </span>
  )
}

function IconAction({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={label} disabled={disabled} onClick={onClick} />}>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export default function TerminalTool({ device, active }: { device: DeviceDetail; active: boolean }) {
  const me = useMe()
  const navigate = useNavigate()
  const { resolved } = useTheme()
  const access = remoteAccess(device, hasPermission(me, PERMISSIONS.remoteShell), { permissionLabel: REMOTE_TOOL.terminal.permissionLabel })
  const options = shellOptions(device.os_family)
  const [shell, setShell] = useState(options[0].value)
  const [expanded, setExpanded] = useState(false)
  const [size, setSize] = useState({ cols: 0, rows: 0 })
  const [ready, setReady] = useState(false)
  const [coarse] = useState(() => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches)

  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const hadSession = useRef(false)

  const session = useShellSession({
    deviceId: device.id,
    onOutput: (bytes) => termRef.current?.write(bytes),
    getSize: () => ({ cols: termRef.current?.cols ?? 120, rows: termRef.current?.rows ?? 32 }),
  })
  const { state, start: startShell, send: sendInput, disconnect, getStats } = session
  const sessionRef = useRef(session)
  useEffect(() => {
    sessionRef.current = session
  })

  const busy = isShellBusy(state.phase)
  const ended = isShellEnded(state.phase)
  const now = useNow(1000, busy)
  const elapsed = state.readyAt ? ((state.endedAt ?? now) - state.readyAt) / 1000 : 0
  const stats = getStats()

  const fitNow = useCallback(() => {
    const host = hostRef.current
    const fit = fitRef.current
    if (!host || !fit || host.clientWidth === 0 || host.clientHeight === 0) return
    try {
      fit.fit()
    } catch {
      // The renderer may not be measured yet; the next resize retries.
    }
  }, [])

  const copySelection = useCallback(async () => {
    const text = termRef.current?.getSelection() ?? ''
    if (!text) {
      toast.message('Nothing selected', { description: 'Select text in the terminal first.' })
      return
    }
    if (await copyText(text)) toast.success('Copied to clipboard')
  }, [])

  const pasteClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text) termRef.current?.paste(text)
      termRef.current?.focus()
    } catch {
      toast.message('Clipboard access blocked', { description: 'Press Ctrl+V (⌘V on macOS) inside the terminal to paste.' })
    }
  }, [])

  // Create xterm once; the session survives tab switches because the cockpit keeps this mounted.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    let frame = 0
    const fontSize = window.matchMedia('(max-width: 639px)').matches ? 12 : 13
    const term = new Terminal({
      fontFamily: TERMINAL_FONT,
      fontSize,
      fontWeight: '400',
      fontWeightBold: '600',
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'outline',
      scrollback: 5000,
      macOptionIsMeta: true,
      theme: TERMINAL_THEMES[document.documentElement.classList.contains('dark') ? 'dark' : 'light'],
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    termRef.current = term
    fitRef.current = fit

    term.onData((data) => sessionRef.current.send(data))
    term.onResize(({ cols, rows }) => {
      setSize({ cols, rows })
      sessionRef.current.resize(cols, rows)
    })
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      const mod = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      if (mod && event.shiftKey && key === 'c') {
        void copySelection()
        return false
      }
      if (event.ctrlKey && !event.shiftKey && key === 'c' && term.hasSelection()) {
        // Windows Terminal style: Ctrl+C copies when there is a selection, otherwise sends ^C.
        void copyText(term.getSelection()).then((ok) => ok && toast.success('Copied to clipboard'))
        term.clearSelection()
        return false
      }
      // Let the browser raise a paste event, which xterm turns into (bracketed) input.
      if (mod && key === 'v') return false
      return true
    })

    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(fitNow)
    })

    void loadTerminalFont(fontSize).then(() => {
      if (disposed) return
      term.open(host)
      fitNow()
      setSize({ cols: term.cols, rows: term.rows })
      observer.observe(host)
      setReady(true)
    })

    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [fitNow, copySelection])

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = TERMINAL_THEMES[resolved]
  }, [resolved])

  // Refit and focus when the panel becomes visible or changes size mode.
  useEffect(() => {
    if (!active || !ready) return
    const frame = requestAnimationFrame(() => {
      fitNow()
      if (sessionRef.current.state.phase === 'ready') termRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [active, expanded, ready, fitNow])

  // Terminal notices and the "live shell" indicator follow the session phase.
  useEffect(() => {
    const term = termRef.current
    if (state.phase === 'ready') {
      term?.focus()
    } else if (state.phase === 'exited') {
      term?.write(dim(`[Process exited${state.exitCode !== null ? ` with code ${state.exitCode}` : ''}]`))
    } else if (state.phase === 'closed' && state.wasReady) {
      term?.write(dim(`[Session closed${state.reason ? `: ${state.reason}` : ''}]`))
    } else if (state.phase === 'error' && state.wasReady) {
      term?.write(dim(`[Connection error: ${state.error ?? 'unknown error'}]`))
    }
    // `state` fields are read at the moment the phase changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase])

  useEffect(() => {
    setLiveShell(device.id, state.phase === 'ready')
    return () => setLiveShell(device.id, false)
  }, [device.id, state.phase])

  // Warn before closing the browser tab while a shell is open.
  useEffect(() => {
    if (state.phase !== 'ready') return
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [state.phase])

  const startSession = useCallback(() => {
    const term = termRef.current
    if (!term) return
    if (hadSession.current) term.write(dim(`── New ${shellLabel(shell)} session ──`))
    hadSession.current = true
    fitNow()
    void startShell(shell)
  }, [fitNow, startShell, shell])

  // "Open terminal" from the palette or the header connects straight away.
  const intent = useRemoteIntent(device.id, 'connect-terminal')
  useEffect(() => {
    if (!intent || !ready) return
    consumeRemoteIntent(intent.nonce)
    if (access.ok && !busy) startSession()
  }, [intent, ready, access.ok, busy, startSession])

  const theme = TERMINAL_THEMES[resolved]
  const failedToStart = state.phase === 'error' && !state.wasReady

  return (
    <div
      className={cn(
        'flex min-w-0 flex-col overflow-hidden bg-card',
        expanded ? 'fixed inset-0 z-50' : 'h-[72dvh] min-h-[380px] rounded-xl shadow-card sm:h-[min(80dvh,880px)] sm:min-h-[440px]',
      )}
      role="region"
      aria-label={`Terminal on ${deviceName(device)}`}
    >
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        {expanded && (
          <span className="mr-1 flex items-center gap-2 text-dense font-medium">
            <SquareTerminal className="size-4 text-subtle-foreground" />
            {deviceName(device)}
          </span>
        )}
        <SimpleSelect
          value={shell}
          onValueChange={setShell}
          options={options.map((option) => ({ value: option.value, label: option.label, description: option.description }))}
          size="sm"
          className="w-[150px] sm:w-[190px]"
          ariaLabel="Shell"
          disabled={busy}
        />
        <StatePill state={state} elapsed={elapsed} />
        {busy && state.status && <span className="hidden truncate text-micro text-muted-foreground md:inline">{state.status}</span>}
        <div className="ml-auto flex items-center gap-0.5">
          <IconAction label="Copy selection (Ctrl+Shift+C)" onClick={() => void copySelection()} disabled={!ready}>
            <Copy />
          </IconAction>
          <IconAction label="Paste" onClick={() => void pasteClipboard()} disabled={state.phase !== 'ready'}>
            <ClipboardPaste />
          </IconAction>
          <IconAction label="Clear scrollback" onClick={() => termRef.current?.clear()} disabled={!ready}>
            <Eraser />
          </IconAction>
          <IconAction label={expanded ? 'Exit full screen' : 'Full screen'} onClick={() => setExpanded((value) => !value)}>
            {expanded ? <Minimize2 /> : <Maximize2 />}
          </IconAction>
          <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
          {busy ? (
            <Button variant="destructive-soft" size="sm" onClick={disconnect}>
              <Unplug data-icon="inline-start" />
              Disconnect
            </Button>
          ) : (
            <GatedButton access={access} size="sm" variant={ended ? 'outline' : 'default'} onClick={startSession} disabled={!ready}>
              {ended ? <RefreshCw data-icon="inline-start" /> : <Play data-icon="inline-start" />}
              {ended ? 'Reconnect' : 'Start session'}
            </GatedButton>
          )}
        </div>
      </div>

      {/* Recording notice */}
      <div className="flex items-center gap-2 border-b border-border bg-critical/[0.045] px-3 py-1.5 text-micro text-muted-foreground">
        <span className={cn('relative inline-flex size-2 shrink-0 rounded-full bg-critical', state.phase === 'ready' && 'animate-pulse-ring text-critical')} aria-hidden="true" />
        <span className="font-semibold tracking-wide text-critical uppercase">{state.phase === 'ready' ? 'Recording' : 'Recorded'}</span>
        <span className="min-w-0 truncate">
          Everything typed and shown here is recorded to the session history and can be replayed by administrators.
        </span>
      </div>

      {/* Terminal */}
      <div className="relative min-h-0 flex-1" style={{ background: theme.background }}>
        <div className="absolute inset-0 p-2 sm:p-3">
          <div ref={hostRef} className="rustrmm-terminal h-full w-full overflow-hidden" />
        </div>

        {state.phase === 'idle' && (
          <div className="absolute inset-0 flex items-center justify-center p-4" style={{ background: `color-mix(in oklch, ${theme.background} 86%, transparent)` }}>
            <div className="w-full max-w-sm rounded-xl bg-card/95 p-5 text-center shadow-popover backdrop-blur">
              <span className="mx-auto flex size-11 items-center justify-center rounded-xl bg-surface-2 text-muted-foreground shadow-raised ring-1 ring-border">
                <SquareTerminal className="size-5" />
              </span>
              <h3 className="mt-3 text-[15px] font-semibold tracking-tight">Open a shell on {deviceName(device)}</h3>
              <p className="mt-1 text-dense text-muted-foreground">
                Starts {shellLabel(shell)} as the agent’s service account. Sessions end after 30 minutes without input and are recorded.
              </p>
              <GatedButton access={access} className="mt-4 w-full" onClick={startSession} disabled={!ready}>
                {ready ? <Play data-icon="inline-start" /> : <Spinner data-icon="inline-start" />}
                Start {shellLabel(shell)}
              </GatedButton>
              {!access.ok && <p className="mt-2 text-micro text-muted-foreground">{access.reason}</p>}
            </div>
          </div>
        )}

        {(state.phase === 'starting' || state.phase === 'connecting') && (
          <div className="pointer-events-none absolute inset-x-0 top-1/3 flex justify-center p-4">
            <div className="flex items-center gap-3 rounded-xl bg-card/95 px-4 py-3 shadow-popover backdrop-blur">
              <Spinner className="size-4 text-info" />
              <div>
                <p className="text-dense font-medium">Connecting to {deviceName(device)}</p>
                <p className="text-micro text-muted-foreground" aria-live="polite">
                  {state.status ?? 'Waiting for the agent…'}
                </p>
              </div>
            </div>
          </div>
        )}

        {failedToStart && (
          <div className="absolute inset-0 flex items-center justify-center p-4" style={{ background: `color-mix(in oklch, ${theme.background} 86%, transparent)` }}>
            <div role="alert" className="w-full max-w-md rounded-xl bg-card/95 p-5 shadow-popover backdrop-blur">
              <div className="flex items-start gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-critical/12 text-critical">
                  <CircleExclamationPoint className="size-4" />
                </span>
                <div className="min-w-0">
                  <p className="font-medium">
                    {state.errorCode === 'device_error'
                      ? 'The agent refused the shell'
                      : state.errorCode === 'tunnel_failed'
                        ? 'Couldn’t open a tunnel'
                        : state.errorCode === 'step_up_required'
                          ? 'MFA check needed'
                          : 'Couldn’t start the shell'}
                  </p>
                  <p className={cn('mt-1 text-dense break-words text-muted-foreground', state.errorCode === 'device_error' && 'font-mono text-[12px] text-foreground/85')}>
                    {state.error}
                  </p>
                </div>
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <GatedButton access={access} size="sm" onClick={startSession}>
                  <RefreshCw data-icon="inline-start" />
                  Try again
                </GatedButton>
              </div>
            </div>
          </div>
        )}

        {ended && !failedToStart && (
          <div className="absolute inset-x-0 bottom-0 flex justify-center p-3">
            <div className="flex max-w-full flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-card/95 px-3 py-2 shadow-popover backdrop-blur">
              <p className="min-w-0 text-dense">
                <span className="font-medium">Session ended</span>
                <span className="text-muted-foreground">
                  {' · '}
                  {state.phase === 'exited' ? `exited with code ${state.exitCode ?? '?'}` : (state.reason ?? state.error ?? 'closed')}
                  {state.readyAt ? ` · ${formatClock(elapsed)}` : ''}
                </span>
              </p>
              <div className="flex items-center gap-1.5">
                {state.sessionId && hasPermission(me, PERMISSIONS.remoteRecordings) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      requestPlayback(state.sessionId!)
                      setExpanded(false)
                      void navigate({ from: '/devices/$deviceId', to: '/devices/$deviceId', params: { deviceId: device.id }, search: (prev) => ({ ...prev, tab: 'sessions' }), replace: true })
                    }}
                  >
                    <RotateCcwClock data-icon="inline-start" />
                    Replay
                  </Button>
                )}
                <GatedButton access={access} size="sm" onClick={startSession}>
                  <RefreshCw data-icon="inline-start" />
                  Reconnect
                </GatedButton>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Touch keys */}
      {coarse && state.phase === 'ready' && (
        <div className="flex gap-1 overflow-x-auto border-t border-border px-2 py-1.5 [scrollbar-width:none]" role="toolbar" aria-label="Special keys">
          {MOBILE_KEYS.map((key) => (
            <Button
              key={key.label}
              variant="outline"
              size="xs"
              className="min-w-9 font-mono"
              aria-label={key.aria}
              onClick={() => {
                sendInput(key.data)
                termRef.current?.focus()
              }}
            >
              {key.label}
            </Button>
          ))}
        </div>
      )}

      {/* Status bar */}
      <div className="flex items-center gap-3 border-t border-border bg-surface-2/60 px-3 py-1 font-mono text-[10.5px] text-subtle-foreground">
        <span className="truncate">{shellLabel(state.shell || shell)}</span>
        {size.cols > 0 && <span className="tabular">{size.cols}×{size.rows}</span>}
        {state.sessionId && <span className="hidden truncate sm:inline">session {state.sessionId.slice(0, 8)}</span>}
        {(busy || ended) && state.wasReady && (
          <span className="tabular hidden sm:inline">
            ↑ {formatBytes(stats.bytesOut)} ↓ {formatBytes(stats.bytesIn)}
          </span>
        )}
        <span className="ml-auto hidden font-sans lg:inline">Ctrl+Shift+C copy · Ctrl+V paste</span>
      </div>
    </div>
  )
}
