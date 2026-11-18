/* The pre-connect panel: interactive sessions on the device, view-only and quality, consent notice. */
import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Check, Cloud, Eye, Info, Lock, Monitor, MonitorPlay, Play, RefreshCw, ShieldCheck, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { SimpleSelect } from '@/components/common/simple-select'
import { errorMessage, isApiError } from '@/lib/api/errors'
import type { DesktopConsentMode, DesktopSession, DesktopSessionList, DeviceDetail } from '@/lib/api/types'
import type { DesktopQuality } from '@/lib/desktop/control'
import { deviceName } from '@/lib/devices'
import type { RemoteAccess } from '@/lib/remote'
import { cn } from '@/lib/utils'
import { GatedButton } from '../remote-ui'
import {
  QUALITY_OPTIONS,
  SESSION_STATE_LABEL,
  SESSION_STATE_TONE,
  consentExpectation,
  policyRefusal,
  sessionKey,
  sessionTitle,
  sessionUnsupported,
} from './desktop-access'

const TONE_DOT = { live: 'bg-live', warning: 'bg-warning', neutral: 'bg-subtle-foreground', info: 'bg-info' } as const

function SessionOption({ session, selected, onSelect, disabledReason }: { session: DesktopSession; selected: boolean; onSelect: () => void; disabledReason: string | null }) {
  const Icon = session.kind === 'rdp' ? Cloud : Monitor
  const tone = SESSION_STATE_TONE[session.state]
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={Boolean(disabledReason)}
      onClick={onSelect}
      className={cn(
        'group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left ring-1 transition-[background-color,box-shadow] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-55',
        selected ? 'bg-primary/[0.07] ring-primary/45' : 'bg-surface-2 ring-border hover:bg-surface-3',
      )}
    >
      <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-md ring-1', selected ? 'bg-primary/12 text-primary ring-primary/30' : 'bg-surface-3 text-muted-foreground ring-border')}>
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-dense font-medium">{sessionTitle(session)}</span>
          <span className="shrink-0 rounded bg-surface-3 px-1 font-mono text-[10px] text-subtle-foreground uppercase ring-1 ring-border">
            {session.kind === 'rdp' ? 'RDP' : session.type ? session.type : 'Console'}
          </span>
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-micro text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className={cn('size-1.5 rounded-full', TONE_DOT[tone])} />
            {SESSION_STATE_LABEL[session.state]}
          </span>
          {session.monitors !== null && session.monitors > 0 && (
            <span>
              {session.monitors} {session.monitors === 1 ? 'display' : 'displays'}
            </span>
          )}
          {session.session_id !== null && <span className="font-mono text-[10.5px] text-subtle-foreground">#{session.session_id}</span>}
          {disabledReason && <span className="text-warning">{disabledReason}</span>}
        </span>
      </span>
      <span
        className={cn(
          'flex size-4 shrink-0 items-center justify-center rounded-full ring-1 transition-colors',
          selected ? 'bg-primary text-primary-foreground ring-primary' : 'ring-border-strong',
        )}
        aria-hidden="true"
      >
        {selected && <Check className="size-3" strokeWidth={3} />}
      </span>
    </button>
  )
}

function TccRow({ label, value }: { label: string; value: boolean | null }) {
  return (
    <li className="flex items-center justify-between gap-3 py-1.5 text-dense">
      <span>{label}</span>
      <span className={cn('inline-flex items-center gap-1 text-micro font-medium', value === true ? 'text-live' : value === false ? 'text-warning' : 'text-subtle-foreground')}>
        {value === true ? <Check className="size-3.5" /> : value === false ? <X className="size-3.5" /> : null}
        {value === true ? 'Granted' : value === false ? 'Not granted' : 'Unknown'}
      </span>
    </li>
  )
}

export interface ConnectRequest {
  sessionId: number | null
  viewOnly: boolean
  quality: DesktopQuality
}

interface ConnectPanelProps {
  device: DeviceDetail
  access: RemoteAccess
  sessions: { data: DesktopSessionList | undefined; error: unknown; isLoading: boolean; isFetching: boolean; refetch: () => void }
  selected: string | null
  onSelect: (key: string) => void
  viewOnly: boolean
  onViewOnly: (value: boolean) => void
  forcedViewOnly: boolean
  quality: DesktopQuality
  onQuality: (value: DesktopQuality) => void
  consentMode: DesktopConsentMode
  consentTimeout: number
  canManagePolicies: boolean
  onConnect: (request: ConnectRequest) => void
}

export function ConnectPanel({
  device,
  access,
  sessions,
  selected,
  onSelect,
  viewOnly,
  onViewOnly,
  forcedViewOnly,
  quality,
  onQuality,
  consentMode,
  consentTimeout,
  canManagePolicies,
  onConnect,
}: ConnectPanelProps) {
  const [showAll, setShowAll] = useState(false)
  const items = sessions.data?.items ?? []
  const refusal = policyRefusal(sessions.error)
  const macos = device.os_family === 'macos' || Boolean(sessions.data?.tcc)
  const index = items.findIndex((item, position) => sessionKey(item, position) === selected)
  const chosen = index >= 0 ? items[index] : null
  const expectation = consentExpectation(consentMode, chosen)
  const unsupported = chosen ? sessionUnsupported(chosen) : null
  const visible = showAll ? items : items.slice(0, 4)

  const header = (
    <div className="flex items-start gap-3">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-primary shadow-raised ring-1 ring-border">
        <MonitorPlay className="size-5" />
      </span>
      <div className="min-w-0">
        <h3 className="text-[15px] font-semibold tracking-tight">Remote desktop</h3>
        <p className="truncate text-micro text-muted-foreground">
          {deviceName(device)} · {device.os_name}
        </p>
      </div>
    </div>
  )

  if (refusal) {
    return (
      <div className="grid gap-4">
        {header}
        <div className="flex items-start gap-3 rounded-lg bg-surface-2 px-3 py-3 ring-1 ring-border">
          <Lock className="mt-0.5 size-4 shrink-0 text-warning" />
          <div className="min-w-0 text-dense">
            <p className="font-medium">Turned off by policy</p>
            <p className="mt-0.5 text-muted-foreground">
              {refusal.policyName ? (
                <>
                  The policy{' '}
                  {canManagePolicies && refusal.policyId ? (
                    <Link to="/automation/policies/$policyId" params={{ policyId: refusal.policyId }} className="font-medium text-foreground underline-offset-2 hover:underline">
                      {refusal.policyName}
                    </Link>
                  ) : (
                    <span className="font-medium text-foreground">{refusal.policyName}</span>
                  )}{' '}
                  disables remote desktop and screenshots on this device.
                </>
              ) : (
                'A policy disables remote desktop and screenshots on this device.'
              )}
            </p>
          </div>
        </div>
      </div>
    )
  }

  if (macos) {
    const tcc = sessions.data?.tcc
    return (
      <div className="grid gap-4">
        {header}
        <div className="rounded-lg bg-surface-2 px-3 py-3 ring-1 ring-border">
          <p className="text-dense font-medium">Not available on macOS yet</p>
          <p className="mt-0.5 text-micro text-muted-foreground">
            The agent reports the permissions remote desktop will need. Grant them in System Settings › Privacy &amp; Security.
          </p>
          {sessions.isLoading ? (
            <Skeleton className="mt-3 h-14" />
          ) : (
            <ul className="mt-2 divide-y divide-border">
              <TccRow label="Screen Recording" value={tcc?.screen_recording ?? null} />
              <TccRow label="Accessibility" value={tcc?.accessibility ?? null} />
            </ul>
          )}
        </div>
      </div>
    )
  }

  const agentRefused = isApiError(sessions.error) && sessions.error.code === 'device_error'

  return (
    <div className="grid gap-4">
      {header}

      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="eyebrow">Session</span>
          <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => sessions.refetch()} disabled={sessions.isFetching}>
            <RefreshCw data-icon="inline-start" className={cn(sessions.isFetching && 'animate-spin')} />
            Refresh
          </Button>
        </div>
        {sessions.isLoading ? (
          <div className="grid gap-2">
            <Skeleton className="h-[58px] rounded-lg" />
            <Skeleton className="h-[58px] rounded-lg opacity-60" />
          </div>
        ) : sessions.error ? (
          <div role="alert" className="rounded-lg bg-critical/[0.06] px-3 py-2.5 ring-1 ring-critical/25">
            <p className="text-dense font-medium">{agentRefused ? 'The agent couldn’t list sessions' : 'Couldn’t load sessions'}</p>
            <p className={cn('mt-0.5 text-micro break-words text-muted-foreground', agentRefused && 'font-mono text-[11.5px] text-foreground/85')}>{errorMessage(sessions.error)}</p>
          </div>
        ) : items.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border-strong px-3 py-3 text-dense text-muted-foreground">
            No graphical session is running. {device.os_family === 'linux' ? 'Remote desktop needs an X11 desktop session.' : ''}
          </p>
        ) : (
          <div role="radiogroup" aria-label="Session" className="grid gap-1.5">
            {visible.map((session) => {
              const key = sessionKey(session, items.indexOf(session))
              return <SessionOption key={key} session={session} selected={key === selected} onSelect={() => onSelect(key)} disabledReason={sessionUnsupported(session)} />
            })}
            {items.length > 4 && !showAll && (
              <Button variant="ghost" size="xs" className="justify-self-start text-muted-foreground" onClick={() => setShowAll(true)}>
                Show {items.length - 4} more
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="grid gap-2.5 sm:grid-cols-2">
        <label className={cn('flex items-center justify-between gap-3 rounded-lg bg-surface-2 px-3 py-2 ring-1 ring-border', forcedViewOnly && 'opacity-80')}>
          <span className="flex min-w-0 items-center gap-2 text-dense">
            <Eye className="size-4 shrink-0 text-subtle-foreground" />
            <span className="min-w-0">
              <span className="block leading-tight">View only</span>
              {forcedViewOnly && <span className="block text-micro text-subtle-foreground">Required by policy</span>}
            </span>
          </span>
          <Switch checked={forcedViewOnly || viewOnly} disabled={forcedViewOnly} onCheckedChange={onViewOnly} aria-label="View only" />
        </label>
        <SimpleSelect
          value={quality}
          onValueChange={(value) => onQuality(value as DesktopQuality)}
          options={QUALITY_OPTIONS.map((option) => ({ value: option.value, label: `Quality: ${option.label}`, description: option.description }))}
          ariaLabel="Picture quality"
          className="h-auto min-h-[38px]"
        />
      </div>

      {expectation === 'ask' && !unsupported && (
        <p className="flex items-start gap-2 rounded-lg bg-info/[0.06] px-3 py-2 text-micro text-muted-foreground ring-1 ring-info/20">
          <Info className="mt-px size-3.5 shrink-0 text-info" />
          <span>
            <span className="font-medium text-foreground">{chosen?.user ?? 'The signed-in user'}</span> will be asked to allow the session. No answer within {consentTimeout} s
            counts as a refusal.
          </span>
        </p>
      )}

      <GatedButton
        access={access}
        size="lg"
        className="w-full"
        disabled={sessions.isLoading || Boolean(sessions.error) || (items.length > 0 && !chosen) || Boolean(unsupported)}
        onClick={() => onConnect({ sessionId: chosen?.session_id ?? null, viewOnly: forcedViewOnly || viewOnly, quality })}
      >
        {sessions.isLoading ? <Spinner data-icon="inline-start" /> : <Play data-icon="inline-start" />}
        {forcedViewOnly || viewOnly ? 'Start viewing' : 'Connect'}
      </GatedButton>
      {!access.ok && <p className="-mt-2 text-center text-micro text-muted-foreground">{access.reason}</p>}
      <p className="-mt-1 flex items-center justify-center gap-1.5 text-center text-micro text-subtle-foreground">
        <ShieldCheck className="size-3.5" />
        Needs a recent MFA check · sessions end after 30 minutes without input
      </p>
    </div>
  )
}
