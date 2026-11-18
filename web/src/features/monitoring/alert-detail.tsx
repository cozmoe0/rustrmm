/* The inbox's detail pane: summary, actions, the current check result and the event timeline. */
import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { LucideIcon } from 'lucide-react'
import {
  ArrowLeft,
  BellOff,
  Building,
  ChevronDown,
  CircleCheck,
  CircleX,
  Copy,
  Ellipsis,
  ExternalLink,
  Moon,
  MonitorSmartphone,
  Network,
  OctagonAlert,
  Repeat,
  RotateCcw,
  ScrollText,
  Send,
  StickyNote,
  TicketPlus,
  TrendingUp,
  UserCheck,
  UserRound,
  UserRoundX,
  Wrench,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { ErrorState, Mono, UserAvatar } from '@/components/common/misc'
import { isApiError } from '@/lib/api/errors'
import { alertDetailQuery, checkTypesQuery } from '@/lib/api/queries'
import type { Alert, AlertEvent, AlertEventKind } from '@/lib/api/types'
import { copyText } from '@/lib/clipboard'
import { formatDateTime, formatSpan } from '@/lib/format'
import { isSnoozed, openSeconds } from '@/lib/monitoring/alerts'
import { alertCheckLabel, EVENT_LABEL, formatInterval, SOURCE_LABEL } from '@/lib/monitoring/labels'
import { useMe } from '@/lib/permissions'
import { cn } from '@/lib/utils'
import { AssignMenu, SnoozeMenu } from './alert-action-controls'
import { CheckTrend } from './check-trend'
import {
  AlertStatusBadge,
  CheckStateChip,
  MaintenanceBadge,
  RemediationBadge,
  SeverityTile,
  SnoozedBadge,
  When,
} from './monitoring-ui'
import { useAddNote, useAlertActions } from './use-alert-actions'
import { AlertTicketButton } from './alert-ticket'
import { SEVERITY_STYLE } from './monitoring-styles'

type Actions = ReturnType<typeof useAlertActions>

const EVENT_ICON: Record<AlertEventKind, { icon: LucideIcon; tone: string }> = {
  opened: { icon: OctagonAlert, tone: 'bg-critical/12 text-critical ring-critical/25' },
  occurred: { icon: Repeat, tone: 'bg-surface-3 text-muted-foreground ring-border' },
  severity_changed: { icon: TrendingUp, tone: 'bg-warning/14 text-warning ring-warning/30' },
  acknowledged: { icon: UserCheck, tone: 'bg-surface-3 text-foreground ring-border-strong' },
  unacknowledged: { icon: UserRoundX, tone: 'bg-surface-3 text-muted-foreground ring-border' },
  snoozed: { icon: Moon, tone: 'bg-info/12 text-info ring-info/25' },
  assigned: { icon: UserRound, tone: 'bg-surface-3 text-foreground ring-border-strong' },
  note: { icon: StickyNote, tone: 'bg-primary/10 text-primary ring-primary/25' },
  notified: { icon: Send, tone: 'bg-live/10 text-live ring-live/25' },
  notification_failed: { icon: BellOff, tone: 'bg-critical/12 text-critical ring-critical/25' },
  remediation_started: { icon: Wrench, tone: 'bg-live/10 text-live ring-live/25' },
  remediation_finished: { icon: Wrench, tone: 'bg-live/10 text-live ring-live/25' },
  resolved: { icon: CircleCheck, tone: 'bg-success/12 text-success ring-success/25' },
  reopened: { icon: RotateCcw, tone: 'bg-warning/14 text-warning ring-warning/30' },
  maintenance: { icon: Wrench, tone: 'bg-info/12 text-info ring-info/25' },
  ticket_created: { icon: TicketPlus, tone: 'bg-primary/10 text-primary ring-primary/25' },
}

function eventStyle(event: AlertEvent) {
  if (event.kind === 'notified' && event.details?.suppressed) return { icon: Moon, tone: 'bg-surface-3 text-muted-foreground ring-border' }
  if (event.kind === 'remediation_finished' && event.details?.ok === false)
    return { icon: CircleX, tone: 'bg-critical/12 text-critical ring-critical/25' }
  return EVENT_ICON[event.kind] ?? EVENT_ICON.occurred
}

function eventTitle(event: AlertEvent) {
  if (event.kind === 'notified' && event.details?.suppressed) return 'Held by quiet hours'
  if (event.kind === 'notified' && event.details?.event === 'escalated') return 'Escalated'
  return EVENT_LABEL[event.kind] ?? event.kind
}

function TimelineItem({ event, last }: { event: AlertEvent; last: boolean }) {
  const style = eventStyle(event)
  const Icon = style.icon
  const jobId = typeof event.details?.job_id === 'string' ? event.details.job_id : null
  const channels = Array.isArray(event.details?.channels) ? (event.details.channels as string[]) : []
  if (event.kind === 'note') {
    return (
      <li className="relative flex gap-3 pb-5">
        {!last && <span className="absolute top-8 bottom-0 left-[13px] w-px bg-border" aria-hidden="true" />}
        <UserAvatar name={event.actor_name ?? 'Someone'} size="sm" className="mt-0.5 size-7" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 text-micro">
            <span className="text-dense font-medium text-foreground">{event.actor_name ?? 'Someone'}</span>
            <span className="text-subtle-foreground">added a note</span>
            <When value={event.at} className="text-subtle-foreground" />
          </div>
          <p className="mt-1.5 rounded-lg rounded-tl-sm bg-surface-2 px-3 py-2 text-dense break-words whitespace-pre-wrap ring-1 ring-border">
            {event.message}
          </p>
        </div>
      </li>
    )
  }
  return (
    <li className="relative flex gap-3 pb-5">
      {!last && <span className="absolute top-8 bottom-0 left-[13px] w-px bg-border" aria-hidden="true" />}
      <span className={cn('relative mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full ring-1 [&_svg]:size-3.5', style.tone)}>
        <Icon aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-dense font-medium">{eventTitle(event)}</span>
          {event.actor_name && <span className="text-micro text-muted-foreground">by {event.actor_name}</span>}
          <When value={event.at} className="text-micro text-subtle-foreground" />
        </div>
        {event.message && <p className="mt-0.5 text-dense break-words text-muted-foreground">{event.message}</p>}
        {(channels.length > 0 || jobId) && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {channels.map((channel) => (
              <span key={channel} className="inline-flex h-5 items-center rounded-[5px] bg-surface-3 px-1.5 text-[10.5px] text-secondary-foreground ring-1 ring-border">
                {channel}
              </span>
            ))}
            {jobId && (
              <Link
                to="/automation/jobs/$jobId"
                params={{ jobId }}
                className="inline-flex h-5 items-center gap-1 rounded-[5px] bg-primary/8 px-1.5 text-[10.5px] font-medium text-primary ring-1 ring-primary/20 hover:bg-primary/12"
              >
                View job
                <ExternalLink className="size-3" />
              </Link>
            )}
          </div>
        )}
      </div>
    </li>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-micro text-subtle-foreground">{label}</dt>
      <dd className="mt-0.5 min-w-0 truncate text-dense">{children}</dd>
    </div>
  )
}

function NoteComposer({ alertId, disabled }: { alertId: string; disabled: boolean }) {
  const [text, setText] = useState('')
  const add = useAddNote(alertId)
  const submit = () => {
    if (!text.trim()) return
    add.mutate(text.trim(), { onSuccess: () => setText('') })
  }
  return (
    <form
      className="flex items-end gap-2 border-t border-border bg-surface-1/80 p-3 backdrop-blur"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <Textarea
        rows={1}
        value={text}
        disabled={disabled}
        maxLength={4000}
        aria-label="Add a note"
        placeholder={disabled ? 'You need the “Triage alerts” permission to add notes' : 'Add a note for the team…'}
        className="max-h-32 min-h-(--control-h) resize-none py-1.5"
        data-alert-note
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            submit()
          }
          if (event.key === 'Escape') (event.target as HTMLTextAreaElement).blur()
        }}
      />
      <Button type="submit" size="sm" disabled={disabled || !text.trim() || add.isPending} className="shrink-0">
        {add.isPending ? <Spinner data-icon="inline-start" /> : <StickyNote data-icon="inline-start" />}
        Post
      </Button>
    </form>
  )
}

export function AlertDetailPane({
  alertId,
  actions,
  onBack,
  onResolve,
}: {
  alertId: string
  actions: Actions
  onBack: () => void
  onResolve: (alert: Alert) => void
}) {
  const me = useMe()
  const { data, isLoading, error, refetch } = useQuery({ ...alertDetailQuery(alertId), refetchInterval: 30_000 })
  const { data: catalog } = useQuery({ ...checkTypesQuery, meta: { silent: true } })
  const [eventsOpen, setEventsOpen] = useState(false)

  if (error) {
    return (
      <div className="p-4 sm:p-6">
        <Button variant="ghost" size="sm" className="mb-3 lg:hidden" onClick={onBack}>
          <ArrowLeft data-icon="inline-start" />
          Alerts
        </Button>
        <ErrorState
          error={error}
          title={isApiError(error) && error.status === 404 ? 'This alert no longer exists' : 'Could not load this alert'}
          onRetry={() => void refetch()}
        />
      </div>
    )
  }
  if (isLoading || !data) {
    return (
      <div className="grid gap-4 p-4 sm:p-6">
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-9 w-72 rounded-lg" />
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    )
  }

  const { alert, events, check } = data
  const canManage = actions.canManage
  const resolved = alert.status === 'resolved'
  const snoozed = isSnoozed(alert)
  const stripe = SEVERITY_STYLE[alert.severity]
  const visibleEvents = eventsOpen || events.length <= 12 ? events : [events[0], ...events.slice(-10)]
  const hiddenCount = events.length - visibleEvents.length
  const ordered = [...visibleEvents].reverse()

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <header className="relative border-b border-border">
          <div
            className="pointer-events-none absolute inset-0 opacity-70"
            style={{ background: `linear-gradient(180deg, color-mix(in oklch, var(--${alert.severity === 'info' ? 'info' : alert.severity}) 7%, transparent) 0%, transparent 100%)` }}
            aria-hidden="true"
          />
          <span className={cn('absolute inset-y-0 left-0 w-[3px]', stripe.stripe, resolved && 'opacity-40')} aria-hidden="true" />
          <div className="relative grid gap-3 px-4 pt-4 pb-4 sm:px-6 sm:pt-5">
            <button
              type="button"
              onClick={onBack}
              className="inline-flex w-fit items-center gap-1 text-dense text-muted-foreground hover:text-foreground lg:hidden"
            >
              <ArrowLeft className="size-3.5" />
              Alerts
            </button>
            <div className="flex min-w-0 items-start gap-3">
              <SeverityTile severity={alert.severity} size="lg" className={cn(resolved && 'opacity-60')} />
              <div className="min-w-0 flex-1">
                <h2 className="font-display text-[19px] leading-snug font-semibold tracking-tight break-words">{alert.title}</h2>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <AlertStatusBadge alert={alert} />
                  {snoozed && alert.snoozed_until && <SnoozedBadge until={alert.snoozed_until} />}
                  {alert.in_maintenance && <MaintenanceBadge label="In maintenance" />}
                  {alert.remediation && <RemediationBadge remediation={alert.remediation} />}
                  {alert.occurrences > 1 && (
                    <Badge variant="outline" className="tabular">
                      <Repeat />×{alert.occurrences}
                    </Badge>
                  )}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-dense">
              {alert.device_id && alert.hostname && (
                <Link
                  to="/devices/$deviceId"
                  params={{ deviceId: alert.device_id }}
                  search={{ tab: 'monitoring' }}
                  className="inline-flex min-w-0 items-center gap-1.5 font-medium hover:underline"
                >
                  <MonitorSmartphone className="size-3.5 shrink-0 text-subtle-foreground" />
                  <span className="truncate">{alert.hostname}</span>
                </Link>
              )}
              {alert.snmp_device_id && (
                <Link
                  to="/network/snmp/$snmpDeviceId"
                  params={{ snmpDeviceId: alert.snmp_device_id }}
                  className="inline-flex min-w-0 items-center gap-1.5 font-medium hover:underline"
                >
                  <Network className="size-3.5 shrink-0 text-subtle-foreground" />
                  <span className="truncate">{alert.snmp_device_name ?? alert.hostname ?? 'SNMP device'}</span>
                </Link>
              )}
              <Link
                to="/clients/$clientId"
                params={{ clientId: alert.client_id }}
                className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground hover:text-foreground hover:underline"
              >
                <Building className="size-3.5 shrink-0 text-subtle-foreground" />
                <span className="truncate">{alert.client_name}</span>
              </Link>
              <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground">
                <ScrollText className="size-3.5 shrink-0 text-subtle-foreground" />
                <span className="truncate">
                  {alertCheckLabel(alert, catalog)} · {SOURCE_LABEL[alert.source]}
                </span>
                <Mono className="hidden sm:inline">{alert.check_id}</Mono>
              </span>
            </div>
          </div>
        </header>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 sm:px-6">
          {alert.status === 'open' && (
            <Button size="sm" disabled={!canManage} onClick={() => actions.act(alert, { action: 'acknowledge' })}>
              <UserCheck data-icon="inline-start" />
              Acknowledge
            </Button>
          )}
          {alert.status === 'acknowledged' && (
            <Button size="sm" variant="outline" disabled={!canManage} onClick={() => actions.act(alert, { action: 'unacknowledge' })}>
              <UserRoundX data-icon="inline-start" />
              Unacknowledge
            </Button>
          )}
          {!resolved && (
            <Button size="sm" variant="outline" disabled={!canManage} onClick={() => onResolve(alert)}>
              <CircleCheck data-icon="inline-start" />
              Resolve
            </Button>
          )}
          {!resolved && canManage && (
            <SnoozeMenu
              onSnooze={(choice) => actions.act(alert, { action: 'snooze', ...choice })}
              trigger={
                <Button size="sm" variant="outline">
                  <Moon data-icon="inline-start" />
                  Snooze
                  <ChevronDown data-icon="inline-end" className="text-muted-foreground" />
                </Button>
              }
            />
          )}
          {!resolved && canManage && (
            <AssignMenu
              users={actions.users}
              meId={me?.user.id}
              currentId={alert.assigned_to?.id}
              onAssign={(userId) => actions.act(alert, { action: 'assign', user_id: userId })}
              trigger={
                <Button size="sm" variant="outline">
                  {alert.assigned_to ? <UserAvatar name={alert.assigned_to.name} size="xs" /> : <UserRound data-icon="inline-start" />}
                  {alert.assigned_to ? <span className="max-w-28 truncate">{alert.assigned_to.name}</span> : 'Assign'}
                  <ChevronDown data-icon="inline-end" className="text-muted-foreground" />
                </Button>
              }
            />
          )}
          <AlertTicketButton alert={alert} />
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="More alert actions" />}>
              <Ellipsis />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem
                onClick={async () => {
                  if (await copyText(`${window.location.origin}/alerts/${alert.id}`)) toast.success('Link copied')
                }}
              >
                <Copy />
                Copy link to alert
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={async () => {
                  if (await copyText(alert.id)) toast.success('Alert ID copied')
                }}
              >
                <Copy />
                Copy alert ID
              </DropdownMenuItem>
              {alert.device_id && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    render={<Link to="/devices/$deviceId" params={{ deviceId: alert.device_id }} search={{ tab: 'monitoring' }} />}
                  >
                    <MonitorSmartphone />
                    Open device monitoring
                  </DropdownMenuItem>
                </>
              )}
              {alert.snmp_device_id && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem render={<Link to="/network/snmp/$snmpDeviceId" params={{ snmpDeviceId: alert.snmp_device_id }} />}>
                    <Network />
                    Open SNMP device
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="grid gap-4 px-4 py-4 sm:px-6 sm:py-5">
          {alert.message && alert.message !== alert.title && (
            <p className="rounded-lg bg-surface-2 px-3 py-2.5 font-mono text-[12px] leading-relaxed break-words text-secondary-foreground ring-1 ring-border">
              {alert.message}
            </p>
          )}

          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl bg-card p-4 shadow-card sm:grid-cols-3">
            <Fact label="Opened">
              <When value={alert.opened_at} />
            </Fact>
            <Fact label="Last occurrence">
              <When value={alert.last_occurrence_at} />
            </Fact>
            <Fact label={resolved ? 'Was open for' : 'Open for'}>
              <span className="tabular">
                {formatSpan(openSeconds(alert))}
              </span>
            </Fact>
            <Fact label="Assigned to">
              {alert.assigned_to ? (
                <span className="inline-flex items-center gap-1.5">
                  <UserAvatar name={alert.assigned_to.name} size="xs" />
                  {alert.assigned_to.id === me?.user.id ? 'You' : alert.assigned_to.name}
                </span>
              ) : (
                <span className="text-subtle-foreground">Nobody</span>
              )}
            </Fact>
            <Fact label="Acknowledged">
              {alert.acknowledged_by_name ? (
                <span title={alert.acknowledged_at ? formatDateTime(alert.acknowledged_at) : undefined}>{alert.acknowledged_by_name}</span>
              ) : (
                <span className="text-subtle-foreground">Not yet</span>
              )}
            </Fact>
            <Fact label={resolved ? 'Resolved' : 'Remediation'}>
              {resolved ? (
                <span>
                  {alert.resolution === 'auto' ? 'Automatically' : (alert.resolved_by_name ?? 'Manually')} · <When value={alert.resolved_at} />
                </span>
              ) : alert.remediation ? (
                alert.remediation.job_id ? (
                  <Link to="/automation/jobs/$jobId" params={{ jobId: alert.remediation.job_id }} className="text-primary hover:underline">
                    {alert.remediation.status === 'running' ? 'Running' : alert.remediation.status === 'succeeded' ? 'Succeeded' : 'Failed'} · attempt{' '}
                    {alert.remediation.attempts}
                  </Link>
                ) : (
                  <span className="capitalize">{alert.remediation.status}</span>
                )
              ) : (
                <span className="text-subtle-foreground">None configured</span>
              )}
            </Fact>
          </dl>

          {check && alert.device_id && (
            <section className="rounded-xl bg-card shadow-card">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
                <h3 className="text-sm font-semibold">Current check result</h3>
                {check.policy_id && (
                  <Link
                    to="/automation/policies/$policyId"
                    params={{ policyId: check.policy_id }}
                    search={{ tab: 'monitoring' }}
                    className="inline-flex h-6 max-w-full items-center gap-1 rounded-md bg-primary/8 px-2 text-micro font-medium text-primary ring-1 ring-primary/20 hover:bg-primary/12"
                  >
                    <ScrollText className="size-3 shrink-0" />
                    <span className="truncate">{check.policy_name}</span>
                  </Link>
                )}
              </div>
              <div className="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <CheckStateChip state={check.state} />
                    <span className="truncate text-dense font-medium">{check.name}</span>
                  </div>
                  <p className="mt-1 text-dense break-words text-muted-foreground">{check.message || 'Waiting for the first result'}</p>
                  <p className="mt-1 text-micro text-subtle-foreground">
                    Every {formatInterval(check.interval_secs)} · last run <When value={check.last_at} />
                    {check.since && (
                      <>
                        {' '}
                        · in this state since <When value={check.since} />
                      </>
                    )}
                  </p>
                </div>
                {check.value !== null && <CheckTrend deviceId={alert.device_id} check={check} width={120} height={30} />}
              </div>
            </section>
          )}

          <section aria-label="Timeline">
            <h3 className="mb-3 text-sm font-semibold">Timeline</h3>
            <ol>
              {ordered.map((event, index) => (
                <TimelineItem key={event.id} event={event} last={index === ordered.length - 1} />
              ))}
            </ol>
            {hiddenCount > 0 && (
              <Button variant="ghost" size="sm" className="-mt-2 ml-8 text-muted-foreground" onClick={() => setEventsOpen(true)}>
                Show {hiddenCount} earlier {hiddenCount === 1 ? 'event' : 'events'}
              </Button>
            )}
          </section>
        </div>
      </div>
      <NoteComposer alertId={alert.id} disabled={!canManage} />
    </div>
  )
}
