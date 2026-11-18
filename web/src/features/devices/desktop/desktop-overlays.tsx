/* Overlays on the remote screen: connection progress, consent, end states, indicators and stats. */
import { useEffect, useState, type ReactNode } from 'react'
import { CircleExclamationPoint, Hourglass, Lock, MousePointerClick, RefreshCw, ShieldAlert, Timer, UserRoundX, WifiOff, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { formatBytes, formatClock } from '@/lib/format'
import { IDLE_TIMEOUT_MS } from '@/lib/desktop/control'
import type { FrameMeterSnapshot } from '@/lib/desktop/pipeline'
import { formatResolution } from '@/lib/desktop/viewport'
import { cn } from '@/lib/utils'
import { useNow } from '../remote-hooks'
import type { PolicyRefusalDetails } from '@/lib/api/types'
import { secureDesktopLabel } from './desktop-access'
import type { DesktopSnapshot } from './use-desktop-session'

/** Centered card on the stage. */
export function StageCard({ children, className, wide }: { children: ReactNode; className?: string; wide?: boolean }) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center overflow-y-auto bg-[oklch(0.12_0.006_250/0.55)] p-3 backdrop-blur-[2px] sm:p-6">
      <div
        className={cn(
          'my-auto w-full rounded-xl bg-card/97 p-4 text-card-foreground shadow-popover ring-1 ring-border backdrop-blur sm:p-5',
          wide ? 'max-w-lg' : 'max-w-md',
          className,
        )}
      >
        {children}
      </div>
    </div>
  )
}

function CardIcon({ tone, children }: { tone: 'critical' | 'warning' | 'info' | 'neutral'; children: ReactNode }) {
  const styles = {
    critical: 'bg-critical/12 text-critical',
    warning: 'bg-warning/14 text-warning',
    info: 'bg-info/12 text-info',
    neutral: 'bg-surface-3 text-muted-foreground',
  }
  return <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg [&_svg]:size-4', styles[tone])}>{children}</span>
}

export function ConnectingCard({ deviceLabel, status, onCancel }: { deviceLabel: string; status: string | null; onCancel: () => void }) {
  return (
    <StageCard>
      <div className="flex items-center gap-3">
        <Spinner className="size-5 text-info" />
        <div className="min-w-0 flex-1">
          <p className="text-dense font-medium">Connecting to {deviceLabel}</p>
          <p className="truncate text-micro text-muted-foreground" aria-live="polite">
            {status ?? 'Waiting for the agent…'}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </StageCard>
  )
}

/** Waiting for the device's user, with a countdown to the policy's consent timeout. */
export function ConsentCard({ user, since, timeoutSecs, onCancel }: { user: string | null; since: number; timeoutSecs: number; onCancel: () => void }) {
  const now = useNow(250)
  const total = Math.max(1, timeoutSecs) * 1000
  const remaining = Math.max(0, total - (now - since))
  const fraction = remaining / total
  const radius = 26
  const circumference = 2 * Math.PI * radius
  return (
    <StageCard>
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="relative size-[68px]" role="timer" aria-label={`${Math.ceil(remaining / 1000)} seconds left to answer`}>
          <svg viewBox="0 0 64 64" className="size-full -rotate-90">
            <circle cx="32" cy="32" r={radius} fill="none" strokeWidth="4" className="stroke-surface-4" />
            <circle
              cx="32"
              cy="32"
              r={radius}
              fill="none"
              strokeWidth="4"
              strokeLinecap="round"
              className="stroke-info transition-[stroke-dashoffset] duration-300 ease-linear"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - fraction)}
            />
          </svg>
          <span className="tabular absolute inset-0 flex items-center justify-center font-mono text-[15px] font-semibold">{Math.ceil(remaining / 1000)}</span>
        </div>
        <div>
          <p className="text-[15px] font-semibold tracking-tight">Waiting for {user ?? 'the user'} to allow the session</p>
          <p className="mt-1 text-dense text-muted-foreground">
            A prompt is showing on the device. If nobody answers in time, the session is refused.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onCancel}>
          Cancel request
        </Button>
      </div>
    </StageCard>
  )
}

export function ReconnectCountdown({ attempt, max, at, onNow, onCancel }: { attempt: number; max: number; at: number; onNow: () => void; onCancel: () => void }) {
  const now = useNow(250)
  const seconds = Math.max(0, Math.ceil((at - now) / 1000))
  return (
    <StageCard>
      <div className="flex items-start gap-3">
        <CardIcon tone="warning">
          <WifiOff />
        </CardIcon>
        <div className="min-w-0 flex-1">
          <p className="font-medium">Connection lost</p>
          <p className="mt-0.5 text-dense text-muted-foreground" aria-live="polite">
            Reconnecting in {seconds}s · attempt {attempt} of {max}
          </p>
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={onNow}>
          <RefreshCw data-icon="inline-start" />
          Reconnect now
        </Button>
      </div>
    </StageCard>
  )
}

/** Why the session ended or failed, with the agent's message verbatim. */
export function EndedCard({
  state,
  elapsed,
  onReconnect,
  onBack,
  canReconnect,
  reconnectReason,
}: {
  state: DesktopSnapshot
  elapsed: number
  onReconnect: () => void
  onBack: () => void
  canReconnect: boolean
  reconnectReason?: string
}) {
  const policyName = state.errorCode === 'disabled_by_policy' ? ((state.errorDetails as Partial<PolicyRefusalDetails> | null)?.policy_name ?? null) : null
  let tone: 'critical' | 'warning' | 'info' | 'neutral' = 'neutral'
  let icon: ReactNode = <X />
  let title = 'Session ended'
  let body: ReactNode = state.reason
  let mono = false

  if (state.end === 'denied') {
    tone = 'warning'
    icon = <UserRoundX />
    title = 'The user denied the session'
    body = 'They declined the prompt on the device. You can ask them to accept, then try again.'
  } else if (state.end === 'timeout') {
    tone = 'warning'
    icon = <Hourglass />
    title = 'Nobody answered the prompt'
    body = 'The consent prompt timed out. The user may be away, or the session is locked.'
  } else if (state.end === 'failed' || state.end === 'error') {
    tone = 'critical'
    icon = <CircleExclamationPoint />
    mono = state.errorCode === 'device_error'
    title =
      state.errorCode === 'disabled_by_policy' || state.errorCode === 'forbidden'
        ? 'Remote desktop isn’t allowed'
        : state.errorCode === 'device_error'
          ? 'The agent refused the session'
          : state.errorCode === 'device_offline'
            ? 'The device went offline'
            : state.errorCode === 'tunnel_failed'
              ? 'Couldn’t open a tunnel'
              : state.errorCode === 'step_up_required'
                ? 'MFA check needed'
                : 'Couldn’t start the remote desktop'
    body = state.errorCode === 'step_up_required' ? 'Starting a remote desktop needs a recent MFA check. Try again and confirm the prompt.' : (state.error ?? state.reason)
    if (state.errorCode === 'disabled_by_policy') {
      icon = <Lock />
      tone = 'warning'
      body = policyName ? `The policy “${policyName}” disables remote desktop on this device.` : (state.error ?? 'A policy disables remote desktop on this device.')
    }
  } else if (state.end === 'dropped') {
    tone = 'warning'
    icon = <WifiOff />
    title = 'Connection lost'
  }

  return (
    <StageCard>
      <div role={tone === 'critical' ? 'alert' : 'status'} className="flex items-start gap-3">
        <CardIcon tone={tone}>{icon}</CardIcon>
        <div className="min-w-0 flex-1">
          <p className="font-medium">{title}</p>
          {body && <p className={cn('mt-1 text-dense break-words text-muted-foreground', mono && 'font-mono text-[12px] text-foreground/85')}>{body}</p>}
          {state.readyAt && <p className="tabular mt-1.5 text-micro text-subtle-foreground">Connected for {formatClock(elapsed)}</p>}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          Choose session
        </Button>
        {canReconnect && state.errorCode !== 'disabled_by_policy' && (
          <Button size="sm" onClick={onReconnect} title={reconnectReason}>
            <RefreshCw data-icon="inline-start" />
            {state.end === 'denied' || state.end === 'timeout' || state.end === 'failed' || state.end === 'error' ? 'Try again' : 'Reconnect'}
          </Button>
        )}
      </div>
    </StageCard>
  )
}

/** "Secure desktop": UAC prompts, the lock screen and the sign-in screen run on `winlogon`. */
export function SecureDesktopChip({ desktop }: { desktop: string }) {
  const label = secureDesktopLabel(desktop)
  if (!label) return null
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2.5 z-[5] flex justify-center px-3">
      <span className="inline-flex items-center gap-1.5 rounded-full bg-[oklch(0.2_0.02_250/0.86)] py-1 pr-3 pl-2 text-micro font-medium text-white shadow-lg ring-1 ring-white/12 backdrop-blur animate-in fade-in-0 slide-in-from-top-2">
        <ShieldAlert className="size-3.5 text-[oklch(0.82_0.13_80)]" />
        Secure desktop
        <span className="text-white/60">· {label}</span>
      </span>
    </div>
  )
}

export function SwitchingChip({ label }: { label: string }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-[5] flex justify-center px-3">
      <span className="inline-flex items-center gap-2 rounded-full bg-[oklch(0.2_0.02_250/0.86)] px-3 py-1 text-micro font-medium text-white shadow-lg ring-1 ring-white/12 backdrop-blur">
        <Spinner className="size-3" />
        Switching to {label}…
      </span>
    </div>
  )
}

/** A short hint after entering full screen with the keyboard captured. */
export function FullscreenHint({ locked }: { locked: boolean }) {
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(false), 3500)
    return () => window.clearTimeout(timer)
  }, [])
  if (!visible) return null
  return (
    <div className="pointer-events-none absolute inset-x-0 top-12 z-[6] flex justify-center px-3">
      <span className="rounded-lg bg-[oklch(0.2_0.02_250/0.9)] px-3 py-1.5 text-micro text-white shadow-lg ring-1 ring-white/12 backdrop-blur animate-in fade-in-0">
        {locked ? 'Keyboard captured — hold Esc to exit full screen' : 'Press Esc to exit full screen'}
      </span>
    </div>
  )
}

/** Shown once the session has been idle for 25 minutes; the server ends it at 30. */
export function IdleWarning({ lastInputAt, onStay, viewOnly }: { lastInputAt: number; onStay: () => void; viewOnly: boolean }) {
  const now = useNow(1000)
  const remaining = IDLE_TIMEOUT_MS - (now - lastInputAt)
  if (remaining > 5 * 60_000 || remaining <= 0) return null
  return (
    <div className="absolute inset-x-0 bottom-3 z-[7] flex justify-center px-3">
      <div className="flex max-w-full items-center gap-3 rounded-xl bg-card/97 py-2 pr-2 pl-3 shadow-popover ring-1 ring-border backdrop-blur" role="status">
        <Timer className="size-4 shrink-0 text-warning" />
        <p className="min-w-0 text-dense">
          <span className="font-medium">Idle session</span>
          <span className="text-muted-foreground"> · ends in </span>
          <span className="tabular font-mono text-[12px]">{formatClock(Math.ceil(remaining / 1000))}</span>
          <span className="text-muted-foreground">{viewOnly ? ' (view-only sessions also count)' : ' without input'}</span>
        </p>
        {!viewOnly && (
          <Button size="xs" variant="outline" onClick={onStay}>
            <MousePointerClick data-icon="inline-start" />
            Stay connected
          </Button>
        )}
      </div>
    </div>
  )
}

export interface StatsView {
  meter: FrameMeterSnapshot
  traffic: { bytesIn: number; bytesOut: number; frames: number }
}

function StatRow({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-white/55">{label}</span>
      <span className="tabular text-right font-medium text-white">
        {value}
        {hint && <span className="ml-1 font-normal text-white/45">{hint}</span>}
      </span>
    </div>
  )
}

export function StatsOverlay({ state, stats, onClose }: { state: DesktopSnapshot; stats: StatsView | null; onClose: () => void }) {
  const agent = state.agentStats
  return (
    <div className="absolute top-2.5 right-2.5 z-[6] w-[min(15.5rem,calc(100%-1.25rem))] rounded-lg bg-[oklch(0.16_0.01_250/0.88)] p-2.5 font-mono text-[10.5px] leading-[1.55] shadow-lg ring-1 ring-white/10 backdrop-blur">
      <div className="mb-1 flex items-center justify-between font-sans text-[10px] font-semibold tracking-[0.08em] text-white/50 uppercase">
        Stats
        <button type="button" aria-label="Hide stats" onClick={onClose} className="pointer-events-auto rounded p-0.5 text-white/50 hover:bg-white/10 hover:text-white">
          <X className="size-3" />
        </button>
      </div>
      <div className="grid gap-px">
        <div className="mt-0.5 mb-0.5 font-sans text-[9.5px] font-semibold tracking-[0.08em] text-white/40 uppercase">Agent</div>
        <StatRow label="Frame rate" value={agent ? agent.fps.toFixed(agent.fps < 10 ? 1 : 0) : '—'} hint="fps" />
        <StatRow label="Bitrate" value={agent ? agent.kbps.toLocaleString() : '—'} hint="kbps" />
        <StatRow label="Encode" value={agent ? agent.encode_ms.toFixed(1) : '—'} hint="ms" />
        <StatRow label="Capture" value={agent?.capture ? agent.capture.toUpperCase() : '—'} />
        <div className="mt-1.5 mb-0.5 font-sans text-[9.5px] font-semibold tracking-[0.08em] text-white/40 uppercase">Viewer</div>
        <StatRow label="Presented" value={stats ? stats.meter.fps : '—'} hint="fps" />
        <StatRow label="Received" value={stats ? stats.meter.kbps.toLocaleString() : '—'} hint="kbps" />
        <StatRow label="Decode" value={stats ? stats.meter.decodeMs.toFixed(1) : '—'} hint="ms" />
        <StatRow label="Frame latency" value={stats ? stats.meter.latencyMs.toFixed(1) : '—'} hint="ms" />
        <StatRow label="Frames" value={stats ? stats.meter.presented.toLocaleString() : '—'} hint={stats && stats.meter.damaged ? `${stats.meter.damaged} resynced` : undefined} />
        <StatRow label="Total in" value={stats ? formatBytes(stats.traffic.bytesIn) : '—'} />
        <StatRow label="Resolution" value={formatResolution(state.screen)} />
        <StatRow label="Renderer" value={state.renderer === 'worker' ? 'Worker' : state.renderer === 'inline' ? 'Main thread' : '—'} />
      </div>
    </div>
  )
}
