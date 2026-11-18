import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ArrowUpRight, CalendarClock, ChevronsUpDown, Package, Rocket, ShieldExclamationPoint, SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { softwareApi } from '@/lib/api/endpoints'
import { errorMessage, isApiError } from '@/lib/api/errors'
import { automationSettingsQuery, keys, packagesQuery } from '@/lib/api/queries'
import type { DeploymentAction, DeploymentCreate, DeploymentSchedule, DeploymentSummary, JobTargetInput, SoftwarePackage } from '@/lib/api/types'
import { formatInZone, localTimeZone } from '@/lib/cron'
import { OS_LABEL } from '@/lib/devices'
import { formatDateTime, formatNumber } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { canUninstall, SOURCE_META } from '@/lib/software/labels'
import { cn } from '@/lib/utils'
import { useNow } from '@/features/devices/remote-hooks'
import { PlatformIcons } from '@/features/automation/automation-ui'
import { MassActionConfirm } from '@/features/automation/mass-action-confirm'
import { Notice, ResolvedSummary, Step } from '@/features/automation/run-dialog'
import { SEGMENTED } from '@/features/automation/styles'
import { TargetPicker } from '@/features/automation/target-picker'
import { useResolvedTarget } from '@/features/automation/use-resolved-target'
import { closeDeployDialog, useDeployRequest, type DeployRequest } from './deploy-dialog-store'
import { SourceText, SourceTile } from './software-ui'

type ScheduleKind = DeploymentSchedule['type']
type Phase = { kind: 'form' } | { kind: 'confirm'; count: number } | { kind: 'done'; deployment: DeploymentSummary }

function defaultOnce() {
  const date = new Date(Date.now() + 60 * 60_000)
  date.setMinutes(0, 0, 0)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:00`
}

export function PackagePicker({ packages, value, onChange }: { packages: SoftwarePackage[]; value: string | null; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const current = packages.find((pkg) => pkg.id === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button type="button" variant="outline" role="combobox" aria-expanded={open} className="h-auto min-h-10 w-full justify-between py-1.5 font-normal" />}>
        {current ? (
          <span className="flex min-w-0 items-center gap-2.5">
            <SourceTile type={current.source.type} size="sm" />
            <span className="truncate font-medium">{current.name}</span>
            <PlatformIcons platforms={current.platforms} />
          </span>
        ) : (
          <span className="text-muted-foreground">Choose a package…</span>
        )}
        <ChevronsUpDown className="text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent className="w-(--anchor-width) min-w-80 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search the library…" />
          <CommandList className="max-h-80">
            <CommandEmpty>No package matches.</CommandEmpty>
            <CommandGroup>
              {packages.map((pkg) => (
                <CommandItem
                  key={pkg.id}
                  value={`${pkg.name} ${pkg.publisher} ${pkg.source.type === 'file' ? pkg.source.file_name : pkg.source.id}`}
                  data-checked={pkg.id === value}
                  onSelect={() => {
                    onChange(pkg.id)
                    setOpen(false)
                  }}
                >
                  <SourceTile type={pkg.source.type} size="sm" />
                  <span className="min-w-0 flex-1 truncate">{pkg.name}</span>
                  <span className="hidden max-w-[40%] truncate text-micro text-subtle-foreground sm:inline">{SOURCE_META[pkg.source.type].label}</span>
                  <PlatformIcons platforms={pkg.platforms} />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function DeployForm({ request, onDone }: { request: DeployRequest; onDone: () => void }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const me = useMe()
  const { data: packages = [] } = useQuery(packagesQuery)
  const { data: settings } = useQuery({ ...automationSettingsQuery, enabled: hasPermission(me, PERMISSIONS.settingsView), meta: { silent: true } })
  const [packageId, setPackageId] = useState<string | null>(request.packageId ?? null)
  const [action, setAction] = useState<DeploymentAction>(request.action ?? 'install')
  const [target, setTarget] = useState<JobTargetInput>(request.target ?? { type: 'devices', ids: [] })
  const [schedule, setSchedule] = useState<ScheduleKind>('now')
  const [onceAt, setOnceAt] = useState(defaultOnce)
  const [attempted, setAttempted] = useState(false)
  const [phase, setPhase] = useState<Phase>({ kind: 'form' })
  const [typed, setTyped] = useState('')
  const [serverError, setServerError] = useState<string | null>(null)
  const pkg = packages.find((item) => item.id === packageId)
  const resolved = useResolvedTarget(target)
  const now = useNow(30_000)
  const skipped = pkg ? resolved.devices.filter((device) => !pkg.platforms.includes(device.os_family)).length : 0
  const runnable = resolved.devices.length - skipped
  const online = resolved.devices.filter((device) => device.online).length
  const threshold = settings?.mass_action_threshold
  const guarded = threshold !== undefined && resolved.devices.length > threshold
  const uninstallable = pkg ? canUninstall(pkg.source) : true
  const onceDate = new Date(onceAt)
  const errors = {
    package: !packageId ? 'Choose a package' : null,
    action: pkg && action === 'uninstall' && !uninstallable ? 'This installer cannot uninstall: it needs an MSI, or uninstall arguments for an EXE or script.' : null,
    target: target.ids.length === 0 ? 'Choose at least one target' : !resolved.loading && resolved.devices.length === 0 ? 'This target has no devices' : null,
    once: schedule === 'once' && (Number.isNaN(onceDate.getTime()) || onceDate.getTime() < now) ? 'Choose a time in the future' : null,
  }
  const blocking = Object.values(errors).some(Boolean)

  const payload = (): DeploymentCreate => ({
    package_id: packageId!,
    action,
    target,
    schedule: schedule === 'once' ? { type: 'once', at: onceDate.toISOString() } : { type: schedule } as DeploymentSchedule,
  })

  const create = useMutation({
    mutationFn: (confirmCount?: number) => softwareApi.deploy({ ...payload(), confirm_count: confirmCount }),
    meta: { silent: true },
    onSuccess: (deployment) => {
      setPhase({ kind: 'done', deployment })
      void queryClient.invalidateQueries({ queryKey: keys.deployments })
      void queryClient.invalidateQueries({ queryKey: keys.packages })
    },
    onError: (error) => {
      if (isApiError(error) && error.code === 'confirmation_required') {
        const count = (error.details as { count?: number } | undefined)?.count ?? resolved.devices.length
        setTyped('')
        setPhase({ kind: 'confirm', count })
        return
      }
      if (isApiError(error) && error.code === 'step_up_required') {
        setServerError('Re-authentication was cancelled, so nothing was deployed.')
        return
      }
      setServerError(errorMessage(error))
    },
  })

  const submit = () => {
    setAttempted(true)
    setServerError(null)
    if (!blocking) create.mutate(undefined)
  }
  const show = (message: string | null) => (attempted ? message : null)

  if (phase.kind === 'done') {
    const deployment = phase.deployment
    const scheduled = deployment.status === 'scheduled'
    return (
      <div className="grid grid-cols-1 gap-5 px-6 py-8 text-center">
        <span className={cn('mx-auto flex size-12 items-center justify-center rounded-2xl ring-1', scheduled ? 'bg-info/12 text-info ring-info/25' : 'bg-live/12 text-live ring-live/25')}>
          {scheduled ? <CalendarClock className="size-6" /> : <Rocket className="size-6" />}
        </span>
        <div>
          <DialogTitle className="font-display text-lg font-semibold">{scheduled ? 'Deployment scheduled' : 'Deployment started'}</DialogTitle>
          <DialogDescription className="mx-auto mt-1.5 max-w-md text-dense">
            {scheduled && deployment.schedule?.type === 'once'
              ? `“${deployment.package.name}” starts ${formatDateTime(deployment.schedule.at)} on ${deployment.target_label}.`
              : schedule === 'window'
                ? `Each device in ${deployment.target_label} runs it in its next maintenance window.`
                : `“${deployment.package.name}” is ${deployment.action === 'install' ? 'installing' : 'uninstalling'} on ${deployment.target_label}. Results stream in as devices report back.`}
          </DialogDescription>
        </div>
        <div className="flex flex-col-reverse justify-center gap-2 sm:flex-row">
          <Button variant="outline" onClick={onDone}>
            Done
          </Button>
          <Button
            onClick={() => {
              onDone()
              void navigate({ to: '/software/deployments/$deploymentId', params: { deploymentId: deployment.id } })
            }}
          >
            Open live view
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
            <span className="font-medium text-foreground">{pkg?.name}</span> will be {action === 'install' ? 'installed' : 'uninstalled'} on{' '}
            <span className="tabular font-semibold text-foreground">{formatNumber(phase.count)} devices</span>
            {threshold !== undefined ? `, above the mass-action threshold of ${threshold}` : ''}. Check the target before you continue.
          </>
        }
        typed={typed}
        onTypedChange={setTyped}
        pending={create.isPending}
        error={serverError}
        confirmLabel={`${action === 'install' ? 'Install' : 'Uninstall'} on ${formatNumber(phase.count)} devices`}
        destructive={action === 'uninstall'}
        onBack={() => setPhase({ kind: 'form' })}
        onConfirm={() => create.mutate(phase.count)}
      />
    )
  }

  return (
    <>
      <div className="flex items-start gap-3 border-b border-border px-4 py-3.5 pr-12 sm:px-5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary ring-1 ring-primary/25">
          <Package className="size-4" />
        </span>
        <div className="min-w-0">
          <DialogTitle className="font-display text-base font-semibold">{pkg && request.packageId ? `${action === 'install' ? 'Deploy' : 'Uninstall'} “${pkg.name}”` : 'Deploy software'}</DialogTitle>
          <DialogDescription className="text-micro">Install or remove a library package on devices, now, at a time, or in each device’s maintenance window.</DialogDescription>
        </div>
      </div>

      <div className="min-h-0 overflow-y-auto">
        <Step n={1} title="Package">
          <div className="grid grid-cols-1 gap-3">
            <PackagePicker packages={packages} value={packageId} onChange={setPackageId} />
            {pkg && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-surface-2/70 px-3 py-2 text-micro text-muted-foreground ring-1 ring-border">
                <SourceText source={pkg.source} />
                <span>·</span>
                <span>{pkg.platforms.map((os) => OS_LABEL[os]).join(', ')}</span>
                <span>·</span>
                <span>installed on {formatNumber(pkg.installed_on)}</span>
              </div>
            )}
            {show(errors.package) && <FieldError>{errors.package}</FieldError>}
            <ToggleGroup value={[action]} onValueChange={(next: string[]) => next[0] && setAction(next[0] as DeploymentAction)} variant="outline" spacing={0} className={cn('w-full sm:w-auto', SEGMENTED)} aria-label="Action">
              <ToggleGroupItem value="install" className="flex-1 sm:flex-none sm:px-5">
                Install
              </ToggleGroupItem>
              <ToggleGroupItem value="uninstall" className="flex-1 sm:flex-none sm:px-5" disabled={!uninstallable}>
                Uninstall
              </ToggleGroupItem>
            </ToggleGroup>
            {errors.action && <FieldError>{errors.action}</FieldError>}
            {pkg && !uninstallable && action === 'install' && <p className="text-micro text-subtle-foreground">This installer has no uninstall arguments, so it can only install.</p>}
          </div>
        </Step>

        <Step
          n={2}
          title="Targets"
          description="Devices are resolved when the deployment is created; detection skips devices already in the desired state."
          aside={target.ids.length > 0 && <ResolvedSummary total={resolved.devices.length} online={online} skipped={skipped} loading={resolved.loading} />}
        >
          <div className="grid grid-cols-1 gap-2.5">
            <TargetPicker value={target} onChange={setTarget} />
            {show(errors.target) && <FieldError>{errors.target}</FieldError>}
            {pkg && skipped > 0 && (
              <Notice tone="info" icon={<SlidersHorizontal />}>
                {formatNumber(skipped)} {skipped === 1 ? 'device runs' : 'devices run'} an OS this package doesn’t support ({pkg.platforms.map((os) => OS_LABEL[os]).join(', ')} only) and will be skipped.
                {runnable === 0 && ' Nothing would run.'}
              </Notice>
            )}
            {guarded && (
              <Notice tone="warning" icon={<ShieldExclamationPoint />}>
                More than {threshold} devices. You’ll re-authenticate and confirm the device count.
              </Notice>
            )}
          </div>
        </Step>

        <Step n={3} title="Schedule">
          <div className="grid grid-cols-1 gap-3">
            <ToggleGroup value={[schedule]} onValueChange={(next: string[]) => next[0] && setSchedule(next[0] as ScheduleKind)} variant="outline" spacing={0} className={cn('w-full sm:w-auto', SEGMENTED)} aria-label="When to deploy">
              <ToggleGroupItem value="now" className="flex-1 sm:flex-none sm:px-4">
                Now
              </ToggleGroupItem>
              <ToggleGroupItem value="once" className="flex-1 sm:flex-none sm:px-4">
                Once at…
              </ToggleGroupItem>
              <ToggleGroupItem value="window" className="flex-1 sm:flex-none sm:px-4">
                Maintenance window
              </ToggleGroupItem>
            </ToggleGroup>
            {schedule === 'now' && <p className="text-micro text-muted-foreground">Starts right away; offline devices run when they reconnect within 24 hours.</p>}
            {schedule === 'window' && (
              <p className="text-micro text-muted-foreground">
                Each device runs it inside its own effective patch window. Devices without a window are skipped; offline devices are waited for up to 14 days.
              </p>
            )}
            {schedule === 'once' && (
              <Field data-invalid={Boolean(show(errors.once)) || undefined} className="sm:max-w-xs">
                <FieldLabel htmlFor="deploy-once">Date and time</FieldLabel>
                <Input id="deploy-once" type="datetime-local" value={onceAt} onChange={(event) => setOnceAt(event.target.value)} />
                <FieldDescription>
                  Your local time ({localTimeZone().replace(/_/g, ' ')}){!Number.isNaN(onceDate.getTime()) ? ` · ${formatInZone(onceDate, 'UTC', true)}` : ''}
                </FieldDescription>
                <FieldError>{show(errors.once)}</FieldError>
              </Field>
            )}
          </div>
        </Step>
      </div>

      <div className="flex flex-col gap-3 border-t border-border bg-surface-2/60 px-4 py-3 sm:flex-row sm:items-center sm:px-5">
        <div className="min-w-0 flex-1 text-micro text-muted-foreground">
          {serverError ? (
            <span role="alert" className="text-dense text-critical">
              {serverError}
            </span>
          ) : pkg && target.ids.length ? (
            <span>
              {action === 'install' ? 'Installs' : 'Removes'} <span className="font-medium text-foreground">{pkg.name}</span> on{' '}
              <span className="tabular font-medium text-foreground">{formatNumber(runnable)}</span> {runnable === 1 ? 'device' : 'devices'}{' '}
              {schedule === 'now' ? 'now' : schedule === 'once' ? `at ${Number.isNaN(onceDate.getTime()) ? '—' : formatDateTime(onceDate)}` : 'in their maintenance windows'}
            </span>
          ) : (
            'Choose a package and targets to continue.'
          )}
        </div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button variant={action === 'uninstall' ? 'destructive' : 'default'} onClick={submit} disabled={create.isPending || (attempted && blocking)}>
            {create.isPending ? <Spinner data-icon="inline-start" /> : <Rocket data-icon="inline-start" />}
            {schedule === 'once' ? 'Schedule' : action === 'install' ? 'Deploy' : 'Uninstall'}
          </Button>
        </div>
      </div>
    </>
  )
}

/** The app-wide deploy dialog, opened through `openDeployDialog`. */
export function DeployDialogHost() {
  const request = useDeployRequest()
  return (
    <Dialog open={Boolean(request?.open)} onOpenChange={(open) => !open && closeDeployDialog()}>
      <DialogContent className="flex max-h-[min(92dvh,920px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[820px]">
        {request && <DeployForm key={request.nonce} request={request} onDone={closeDeployDialog} />}
      </DialogContent>
    </Dialog>
  )
}
