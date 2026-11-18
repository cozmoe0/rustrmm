import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  ArrowUpRight,
  CalendarClock,
  ChevronsUpDown,
  CircleExclamationPoint,
  Hourglass,
  Play,
  ShieldExclamationPoint,
  SlidersHorizontal,
  Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Mono } from '@/components/common/misc'
import { SimpleSelect } from '@/components/common/simple-select'
import { jobsApi } from '@/lib/api/endpoints'
import { errorMessage, isApiError } from '@/lib/api/errors'
import { automationSettingsQuery, keys, scriptQuery, scriptsQuery } from '@/lib/api/queries'
import type { Job, JobCreate, JobTargetInput, ParameterValue, Script } from '@/lib/api/types'
import { LANGUAGES, MAX_CONCURRENCY, OFFLINE_WAIT_OPTIONS, formatTimeout } from '@/lib/automation/labels'
import { defaultParameterValues, toApiParameters, validateParameterValues } from '@/lib/automation/params'
import { formatInZone, isValidCron, isValidTimeZone, localTimeZone } from '@/lib/cron'
import { OS_LABEL } from '@/lib/devices'
import { formatDateTime, formatNumber, truncateMiddle } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { cn } from '@/lib/utils'
import { useNow } from '@/features/devices/remote-hooks'
import { ApprovalBadge, LanguageMark, PlatformIcons, RiskBadge } from './automation-ui'
import { ParameterForm } from './parameter-form'
import { MassActionConfirm } from './mass-action-confirm'
import { closeRunDialog, useRunRequest, type RunRequest } from './run-dialog-store'
import { CronField } from './schedule-editor'
import { TargetPicker } from './target-picker'
import { useResolvedTarget } from './use-resolved-target'
import { SEGMENTED } from './styles'

type ScheduleKind = 'now' | 'once' | 'cron'
type Phase = { kind: 'form' } | { kind: 'confirm'; count: number } | { kind: 'done'; job: Job }

function defaultOnce() {
  const date = new Date(Date.now() + 60 * 60_000)
  date.setMinutes(0, 0, 0)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:00`
}

export function Step({
  n,
  title,
  description,
  aside,
  children,
}: {
  n: number
  title: string
  description?: ReactNode
  aside?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="grid grid-cols-1 gap-3 border-b border-border px-4 py-4 last:border-b-0 sm:px-5">
      <header className="flex items-start gap-3">
        <span className="tabular flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-3 text-[11px] font-semibold text-muted-foreground ring-1 ring-border">
          {n}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm leading-6 font-semibold">{title}</h3>
          {description && <p className="text-micro text-muted-foreground">{description}</p>}
        </div>
        {aside}
      </header>
      <div className="min-w-0 sm:pl-9">{children}</div>
    </section>
  )
}

export function ScriptPicker({ value, onChange }: { value: string | null; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const { data: scripts = [] } = useQuery(scriptsQuery())
  const current = scripts.find((script) => script.id === value)
  const categories = [...new Set(scripts.map((script) => script.category))].sort()
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="h-auto min-h-10 w-full justify-between py-1.5 font-normal"
          />
        }
      >
        {current ? (
          <span className="flex min-w-0 items-center gap-2.5">
            <LanguageMark language={current.language} size="sm" />
            <span className="truncate font-medium">{current.name}</span>
            <PlatformIcons platforms={current.platforms} />
          </span>
        ) : (
          <span className="text-muted-foreground">Choose a script…</span>
        )}
        <ChevronsUpDown className="text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent className="w-(--anchor-width) min-w-80 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search scripts…" />
          <CommandList className="max-h-80">
            <CommandEmpty>No script matches.</CommandEmpty>
            {categories.map((category) => (
              <CommandGroup key={category} heading={category}>
                {scripts
                  .filter((script) => script.category === category)
                  .map((script) => (
                    <CommandItem
                      key={script.id}
                      value={`${script.name} ${script.category} ${script.language}`}
                      data-checked={script.id === value}
                      onSelect={() => {
                        onChange(script.id)
                        setOpen(false)
                      }}
                    >
                      <LanguageMark language={script.language} size="sm" />
                      <span className="min-w-0 flex-1 truncate">{script.name}</span>
                      {script.risk === 'high' && <ShieldExclamationPoint className="size-3.5 text-critical" />}
                      <PlatformIcons platforms={script.platforms} />
                    </CommandItem>
                  ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export function ResolvedSummary({
  total,
  online,
  skipped,
  loading,
}: {
  total: number
  online: number
  skipped: number
  loading: boolean
}) {
  if (loading) return <Skeleton className="h-6 w-28 rounded-full" />
  return (
    <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
      <span
        className={cn(
          'tabular inline-flex h-6 items-center rounded-full px-2.5 text-dense font-semibold ring-1',
          total ? 'bg-primary/10 text-foreground ring-primary/25' : 'bg-surface-3 text-muted-foreground ring-border',
        )}
      >
        {formatNumber(total)} {total === 1 ? 'device' : 'devices'}
      </span>
      {total > 0 && (
        <span className="tabular text-[10.5px] text-subtle-foreground">
          {formatNumber(online)} online · {formatNumber(total - online)} offline
          {skipped ? ` · ${formatNumber(skipped)} skipped` : ''}
        </span>
      )}
    </div>
  )
}

export function Notice({
  tone,
  icon,
  children,
}: {
  tone: 'warning' | 'info' | 'critical'
  icon: ReactNode
  children: ReactNode
}) {
  const styles = {
    warning: 'bg-warning/[0.07] ring-warning/25 [&>svg]:text-warning',
    info: 'bg-info/[0.06] ring-info/20 [&>svg]:text-info',
    critical: 'bg-critical/[0.06] ring-critical/25 [&>svg]:text-critical',
  }
  return (
    <div
      className={cn(
        'flex items-start gap-2.5 rounded-lg px-3 py-2.5 text-dense ring-1 [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0',
        styles[tone],
      )}
    >
      {icon}
      <div className="min-w-0">{children}</div>
    </div>
  )
}

function RunForm({ request, onDone }: { request: RunRequest; onDone: () => void }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const me = useMe()
  const canSettings = hasPermission(me, PERMISSIONS.settingsView)
  const { data: settings } = useQuery({ ...automationSettingsQuery, enabled: canSettings, meta: { silent: true } })
  const [scriptId, setScriptId] = useState<string | null>(request.scriptId ?? null)
  const { data: script, isLoading: scriptLoading } = useQuery({
    ...scriptQuery(scriptId ?? ''),
    enabled: Boolean(scriptId),
  })
  const [target, setTarget] = useState<JobTargetInput>(request.target ?? { type: 'devices', ids: [] })
  const [values, setValues] = useState<Record<string, ParameterValue>>({})
  const [valuesFor, setValuesFor] = useState<string | null>(null)
  const [schedule, setSchedule] = useState<ScheduleKind>('now')
  const [onceAt, setOnceAt] = useState(defaultOnce)
  const [cron, setCron] = useState('0 3 * * 0')
  const [timezone, setTimezone] = useState(localTimeZone)
  const [offlineWait, setOfflineWait] = useState<number | null>(null)
  const [concurrency, setConcurrency] = useState('25')
  const [timeout, setTimeoutValue] = useState('')
  const [name, setName] = useState('')
  const [attempted, setAttempted] = useState(false)
  const [phase, setPhase] = useState<Phase>({ kind: 'form' })
  const [typed, setTyped] = useState('')
  const [serverError, setServerError] = useState<string | null>(null)

  if (script && valuesFor !== script.id) {
    setValuesFor(script.id)
    setValues(defaultParameterValues(script.parameters))
  }

  const resolved = useResolvedTarget(target)
  const now = useNow(30_000)
  const wait = offlineWait ?? settings?.default_offline_wait_minutes ?? 60
  const skipped = script ? resolved.devices.filter((device) => !script.platforms.includes(device.os_family)).length : 0
  const runnable = resolved.devices.length - skipped
  const online = resolved.devices.filter((device) => device.online).length
  const versionToRun = script
    ? settings?.require_script_approval
      ? script.approved_version
      : script.current_version
    : null
  const guarded = Boolean(
    script && settings && (resolved.devices.length > settings.mass_action_threshold || script.risk === 'high'),
  )
  const needsApproval = guarded && Boolean(settings?.four_eyes_jobs)

  const paramErrors = script ? validateParameterValues(script.parameters, values) : {}
  const onceDate = new Date(onceAt)
  const errors = {
    script: !scriptId ? 'Choose a script' : null,
    target:
      target.ids.length === 0
        ? 'Choose at least one target'
        : !resolved.loading && resolved.devices.length === 0
          ? 'This target has no devices'
          : null,
    version:
      script && versionToRun === null
        ? 'Only approved versions may run and this script has none yet. Ask an approver to review it.'
        : null,
    once:
      schedule === 'once' && (Number.isNaN(onceDate.getTime()) || onceDate.getTime() < now)
        ? 'Choose a time in the future'
        : null,
    cron: schedule === 'cron' && (!isValidCron(cron) || !isValidTimeZone(timezone)) ? 'Enter a valid schedule' : null,
    concurrency:
      !/^\d+$/.test(concurrency) || Number(concurrency) < 1 || Number(concurrency) > MAX_CONCURRENCY
        ? `1–${MAX_CONCURRENCY}`
        : null,
    timeout:
      timeout !== '' && (!/^\d+$/.test(timeout) || Number(timeout) < 10 || Number(timeout) > 86_400)
        ? '10–86400 seconds'
        : null,
  }
  const blocking = Object.values(errors).some(Boolean) || Object.keys(paramErrors).length > 0

  const payload = (): JobCreate => ({
    name: name.trim() || undefined,
    script_id: scriptId!,
    parameters: toApiParameters(script?.parameters ?? [], values),
    target,
    schedule:
      schedule === 'now'
        ? { type: 'now' }
        : schedule === 'once'
          ? { type: 'once', at: onceDate.toISOString() }
          : { type: 'cron', cron: cron.trim(), timezone },
    offline_wait_minutes: wait,
    concurrency: Number(concurrency),
    timeout_secs: timeout === '' ? null : Number(timeout),
  })

  const create = useMutation({
    mutationFn: (confirmCount?: number) => jobsApi.create({ ...payload(), confirm_count: confirmCount }),
    meta: { silent: true },
    onSuccess: (job) => {
      setPhase({ kind: 'done', job })
      void queryClient.invalidateQueries({ queryKey: keys.jobs })
      void queryClient.invalidateQueries({ queryKey: keys.approvals })
      void queryClient.invalidateQueries({ queryKey: keys.scripts })
      for (const id of target.type === 'devices' ? target.ids : [])
        void queryClient.invalidateQueries({ queryKey: keys.deviceScriptRuns(id) })
    },
    onError: (error) => {
      if (isApiError(error) && error.code === 'confirmation_required') {
        const count = (error.details as { count?: number } | undefined)?.count ?? resolved.devices.length
        setTyped('')
        setPhase({ kind: 'confirm', count })
        return
      }
      if (isApiError(error) && error.code === 'step_up_required') {
        setServerError('Re-authentication was cancelled, so the job was not created.')
        return
      }
      setServerError(errorMessage(error))
    },
  })

  const submit = () => {
    setAttempted(true)
    setServerError(null)
    if (blocking) return
    create.mutate(undefined)
  }

  if (phase.kind === 'done') {
    const job = phase.job
    const pending = job.status === 'pending_approval'
    const scheduled = job.status === 'scheduled'
    return (
      <div className="grid grid-cols-1 gap-5 px-6 py-8 text-center">
        <span
          className={cn(
            'mx-auto flex size-12 items-center justify-center rounded-2xl ring-1',
            pending
              ? 'bg-warning/12 text-warning ring-warning/30'
              : scheduled
                ? 'bg-info/12 text-info ring-info/25'
                : 'bg-live/12 text-live ring-live/25',
          )}
        >
          {pending ? (
            <Hourglass className="size-6" />
          ) : scheduled ? (
            <CalendarClock className="size-6" />
          ) : (
            <Zap className="size-6" />
          )}
        </span>
        <div>
          <DialogTitle className="font-display text-lg font-semibold">
            {pending ? 'Sent for approval' : scheduled ? 'Job scheduled' : 'Job started'}
          </DialogTitle>
          <DialogDescription className="mx-auto mt-1.5 max-w-md text-dense">
            {pending
              ? 'Four-eyes approval is on for jobs like this one. Nothing runs until another person with approval rights approves it — they’ll see it in their Approvals inbox.'
              : scheduled
                ? `“${job.name}” runs next ${job.next_run_at ? formatDateTime(job.next_run_at) : 'on schedule'}.`
                : `“${job.name}” is running on ${job.target.label}. Results stream in as each device reports back.`}
          </DialogDescription>
        </div>
        <div className="flex flex-col-reverse justify-center gap-2 sm:flex-row">
          <Button variant="outline" onClick={onDone}>
            Done
          </Button>
          <Button
            onClick={() => {
              onDone()
              void navigate({ to: '/automation/jobs/$jobId', params: { jobId: job.id } })
            }}
          >
            {pending ? 'View request' : 'Open live view'}
            <ArrowUpRight data-icon="inline-end" />
          </Button>
        </div>
      </div>
    )
  }

  if (phase.kind === 'confirm') {
    return (
      <MassActionConfirm
        count={phase.count}
        description={
          <>
            {script?.risk === 'high' ? 'This is a high-risk script. ' : ''}
            <span className="font-medium text-foreground">{script?.name}</span> will run on{' '}
            <span className="tabular font-semibold text-foreground">{formatNumber(phase.count)} devices</span>
            {settings ? `, above the mass-action threshold of ${settings.mass_action_threshold}` : ''}. Check the target
            before you continue.
          </>
        }
        typed={typed}
        onTypedChange={setTyped}
        pending={create.isPending}
        error={serverError}
        note={
          needsApproval
            ? 'Four-eyes approval is on: after you confirm, the job waits for a second person to approve it.'
            : undefined
        }
        confirmLabel={needsApproval ? 'Request approval' : `Run on ${formatNumber(phase.count)} devices`}
        destructive={script?.risk === 'high'}
        onBack={() => setPhase({ kind: 'form' })}
        onConfirm={() => create.mutate(phase.count)}
      />
    )
  }

  const show = (message: string | null) => (attempted ? message : null)

  return (
    <>
      <div className="flex items-start gap-3 border-b border-border px-4 py-3.5 pr-12 sm:px-5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary ring-1 ring-primary/25">
          <Play className="size-4" />
        </span>
        <div className="min-w-0">
          <DialogTitle className="font-display text-base font-semibold">
            {script && request.scriptId ? `Run “${script.name}”` : 'Run a script'}
          </DialogTitle>
          <DialogDescription className="text-micro">
            Pick targets, fill in parameters, and run now or on a schedule.
          </DialogDescription>
        </div>
      </div>

      <div className="min-h-0 overflow-y-auto">
        <Step
          n={1}
          title="Script"
          description={request.scriptId ? undefined : 'Built-in and custom scripts you can run.'}
        >
          <div className="grid grid-cols-1 gap-2.5">
            {!request.scriptId && <ScriptPicker value={scriptId} onChange={setScriptId} />}
            {scriptId && scriptLoading && <Skeleton className="h-14 rounded-lg" />}
            {script && (
              <ScriptSummaryRow
                script={script}
                versionToRun={versionToRun}
                requireApproval={Boolean(settings?.require_script_approval)}
              />
            )}
            {show(errors.script) && <FieldError>{errors.script}</FieldError>}
            {errors.version && (
              <Notice tone="critical" icon={<CircleExclamationPoint />}>
                {errors.version}
              </Notice>
            )}
          </div>
        </Step>

        <Step
          n={2}
          title="Targets"
          description="Devices are resolved again when the job runs."
          aside={
            target.ids.length > 0 && (
              <ResolvedSummary
                total={resolved.devices.length}
                online={online}
                skipped={skipped}
                loading={resolved.loading}
              />
            )
          }
        >
          <div className="grid grid-cols-1 gap-2.5">
            <TargetPicker value={target} onChange={setTarget} />
            {show(errors.target) && <FieldError>{errors.target}</FieldError>}
            {script && skipped > 0 && (
              <Notice tone="info" icon={<SlidersHorizontal />}>
                {formatNumber(skipped)} {skipped === 1 ? 'device runs' : 'devices run'} an OS this script doesn’t
                support ({script.platforms.map((os) => OS_LABEL[os]).join(', ')} only) and will be skipped.
                {runnable === 0 && ' Nothing would run.'}
              </Notice>
            )}
            {guarded && settings && (
              <Notice tone="warning" icon={<ShieldExclamationPoint />}>
                {script?.risk === 'high' ? 'High-risk script.' : `More than ${settings.mass_action_threshold} devices.`}{' '}
                You’ll re-authenticate and confirm the device count
                {needsApproval ? ', then a second person must approve before anything runs.' : '.'}
              </Notice>
            )}
          </div>
        </Step>

        <Step
          n={3}
          title="Parameters"
          description={script?.parameters.length ? 'Values reach the script as environment variables.' : undefined}
        >
          {script ? (
            <ParameterForm
              parameters={script.parameters}
              values={values}
              onChange={(key, value) => setValues((prev) => ({ ...prev, [key]: value }))}
              errors={attempted ? paramErrors : {}}
              idPrefix="run-param"
            />
          ) : (
            <p className="text-dense text-muted-foreground">Choose a script to see its parameters.</p>
          )}
        </Step>

        <Step n={4} title="Schedule">
          <div className="grid grid-cols-1 gap-3">
            <ToggleGroup
              value={[schedule]}
              onValueChange={(next: string[]) => next[0] && setSchedule(next[0] as ScheduleKind)}
              variant="outline"
              spacing={0}
              className={cn('w-full sm:w-auto', SEGMENTED)}
              aria-label="When to run"
            >
              <ToggleGroupItem value="now" className="flex-1 sm:flex-none sm:px-4">
                Now
              </ToggleGroupItem>
              <ToggleGroupItem value="once" className="flex-1 sm:flex-none sm:px-4">
                Once at…
              </ToggleGroupItem>
              <ToggleGroupItem value="cron" className="flex-1 sm:flex-none sm:px-4">
                Recurring
              </ToggleGroupItem>
            </ToggleGroup>
            {schedule === 'once' && (
              <Field data-invalid={Boolean(show(errors.once)) || undefined} className="sm:max-w-xs">
                <FieldLabel htmlFor="run-once">Date and time</FieldLabel>
                <Input
                  id="run-once"
                  type="datetime-local"
                  value={onceAt}
                  onChange={(event) => setOnceAt(event.target.value)}
                />
                <FieldDescription>
                  Your local time ({localTimeZone().replace(/_/g, ' ')})
                  {!Number.isNaN(onceDate.getTime()) ? ` · ${formatInZone(onceDate, 'UTC', true)}` : ''}
                </FieldDescription>
                <FieldError>{show(errors.once)}</FieldError>
              </Field>
            )}
            {schedule === 'cron' && (
              <CronField
                cron={cron}
                timezone={timezone}
                onCronChange={setCron}
                onTimezoneChange={setTimezone}
                idPrefix="run-cron"
              />
            )}
          </div>
        </Step>

        <Collapsible>
          <section className="border-b border-border px-4 py-3 sm:px-5">
            <CollapsibleTrigger className="group flex w-full items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <span className="tabular flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-3 text-[11px] font-semibold text-muted-foreground ring-1 ring-border">
                5
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">Execution options</span>
                <span className="block truncate text-micro text-muted-foreground">
                  {wait === 0
                    ? 'Online devices only'
                    : `Offline devices wait up to ${OFFLINE_WAIT_OPTIONS.find((option) => option.value === wait)?.label ?? `${wait} min`}`}{' '}
                  · {concurrency} at a time ·{' '}
                  {timeout
                    ? `${formatTimeout(Number(timeout) || 0)} timeout`
                    : script
                      ? `${formatTimeout(script.timeout_secs)} timeout`
                      : 'script timeout'}
                </span>
              </span>
              <ChevronsUpDown className="size-4 text-muted-foreground" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="grid grid-cols-1 gap-3.5 pt-4 sm:grid-cols-2 sm:pl-9">
                <Field>
                  <FieldLabel htmlFor="run-wait">Offline devices</FieldLabel>
                  <SimpleSelect
                    id="run-wait"
                    value={String(wait)}
                    onValueChange={(value) => setOfflineWait(Number(value))}
                    options={OFFLINE_WAIT_OPTIONS.map((option) => ({
                      value: String(option.value),
                      label: option.value === 0 ? option.label : `Wait up to ${option.label}`,
                    }))}
                  />
                  <FieldDescription>Offline devices run when they reconnect within this window.</FieldDescription>
                </Field>
                <Field data-invalid={Boolean(errors.concurrency) || undefined}>
                  <FieldLabel htmlFor="run-concurrency">Concurrency</FieldLabel>
                  <Input
                    id="run-concurrency"
                    type="number"
                    min={1}
                    max={MAX_CONCURRENCY}
                    className="tabular"
                    value={concurrency}
                    onChange={(event) => setConcurrency(event.target.value)}
                  />
                  <FieldDescription>Devices running the script at the same time.</FieldDescription>
                  <FieldError>{errors.concurrency}</FieldError>
                </Field>
                <Field data-invalid={Boolean(errors.timeout) || undefined}>
                  <FieldLabel htmlFor="run-timeout">Timeout (seconds)</FieldLabel>
                  <Input
                    id="run-timeout"
                    type="number"
                    min={10}
                    max={86400}
                    className="tabular"
                    placeholder={script ? `${script.timeout_secs} (script default)` : 'Script default'}
                    value={timeout}
                    onChange={(event) => setTimeoutValue(event.target.value)}
                  />
                  <FieldError>{errors.timeout}</FieldError>
                </Field>
                <Field>
                  <FieldLabel htmlFor="run-name">Job name</FieldLabel>
                  <Input
                    id="run-name"
                    placeholder={script?.name ?? 'Defaults to the script name'}
                    value={name}
                    maxLength={120}
                    onChange={(event) => setName(event.target.value)}
                  />
                </Field>
              </div>
            </CollapsibleContent>
          </section>
        </Collapsible>
      </div>

      <div className="flex flex-col gap-3 border-t border-border bg-surface-2/60 px-4 py-3 sm:flex-row sm:items-center sm:px-5">
        <div className="min-w-0 flex-1 text-micro text-muted-foreground">
          {serverError ? (
            <span role="alert" className="text-dense text-critical">
              {serverError}
            </span>
          ) : script && target.ids.length ? (
            <span>
              Runs <span className="font-medium text-foreground">v{versionToRun ?? '—'}</span> on{' '}
              <span className="tabular font-medium text-foreground">{formatNumber(runnable)}</span>{' '}
              {runnable === 1 ? 'device' : 'devices'}{' '}
              {schedule === 'now'
                ? 'now'
                : schedule === 'once'
                  ? `at ${Number.isNaN(onceDate.getTime()) ? '—' : formatDateTime(onceDate)}`
                  : 'on a schedule'}
            </span>
          ) : (
            'Choose a script and targets to continue.'
          )}
        </div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={create.isPending || (attempted && blocking)}>
            {create.isPending ? (
              <Spinner data-icon="inline-start" />
            ) : needsApproval ? (
              <Hourglass data-icon="inline-start" />
            ) : (
              <Play data-icon="inline-start" />
            )}
            {needsApproval ? 'Request approval' : schedule === 'now' ? 'Run now' : 'Schedule job'}
          </Button>
        </div>
      </div>
    </>
  )
}

function ScriptSummaryRow({
  script,
  versionToRun,
  requireApproval,
}: {
  script: Script
  versionToRun: number | null
  requireApproval: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-surface-2/70 px-3 py-2.5 ring-1 ring-border">
      <LanguageMark language={script.language} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-dense font-medium">{script.name}</div>
        <div className="flex flex-wrap items-center gap-x-2 text-micro text-subtle-foreground">
          <span>{LANGUAGES[script.language].label}</span>
          <span>·</span>
          <PlatformIcons platforms={script.platforms} />
          <span>·</span>
          <span>
            v{versionToRun ?? script.current_version}{' '}
            <Mono className="text-[10.5px]">{truncateMiddle(script.content_sha256, 6)}</Mono>
          </span>
          {requireApproval && versionToRun !== null && versionToRun !== script.current_version && (
            <span className="text-warning">· newer v{script.current_version} isn’t approved yet</span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <RiskBadge risk={script.risk} />
        {!script.builtin && <ApprovalBadge script={script} compact />}
      </div>
    </div>
  )
}

/** The app-wide run dialog, opened through `openRunDialog`. */
export function RunDialogHost() {
  const request = useRunRequest()
  return (
    <Dialog open={Boolean(request?.open)} onOpenChange={(open) => !open && closeRunDialog()}>
      <DialogContent className="flex max-h-[min(92dvh,920px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[820px]">
        {request && <RunForm key={request.nonce} request={request} onDone={closeRunDialog} />}
      </DialogContent>
    </Dialog>
  )
}
