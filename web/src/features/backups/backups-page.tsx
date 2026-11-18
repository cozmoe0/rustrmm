import { useEffect, useMemo, useState } from 'react'
import { useForm, type UseFormReturn } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import {
  CalendarClock,
  CircleCheck,
  CircleX,
  Cloud,
  DatabaseBackup,
  Download,
  Ellipsis,
  HardDrive,
  LoaderCircle,
  LockKeyhole,
  Play,
  ShieldExclamationPoint,
  Trash,
  Wifi,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { CopyButton } from '@/components/common/copy-button'
import { DataTable } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, RelativeTime } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/simple-select'
import { backupsApi } from '@/lib/api/endpoints'
import { errorMessage } from '@/lib/api/errors'
import { backupSettingsQuery, backupsQuery, keys } from '@/lib/api/queries'
import type { Backup, BackupSettings, BackupSettingsUpdate } from '@/lib/api/types'
import { CRON_PRESETS, cronFromPreset, describeCron, isValidCron, nextCronRun, presetFromCron, type CronPreset } from '@/lib/cron'
import { formatBytes, formatDateTime, truncateMiddle } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'

const count = z.coerce.number().int().min(0, 'Must be 0 or more').max(1000)

const schema = z
  .object({
    enabled: z.boolean(),
    preset: z.enum(['hourly', 'every-6-hours', 'daily', 'weekly', 'custom']),
    schedule_cron: z.string().refine(isValidCron, 'Enter a valid 5-field cron expression'),
    retention: z.object({ hourly: count, daily: count, weekly: count, monthly: count }),
    include_files: z.boolean(),
    local_enabled: z.boolean(),
    local_path: z.string().trim().min(1, 'Enter a path'),
    s3_enabled: z.boolean(),
    s3_endpoint: z.string().trim(),
    s3_region: z.string().trim(),
    s3_bucket: z.string().trim(),
    s3_prefix: z.string().trim(),
    s3_access_key_id: z.string().trim(),
    s3_secret: z.string(),
    s3_object_lock_days: z.union([z.coerce.number().int().min(1).max(3650), z.literal('')]),
  })
  .superRefine((values, ctx) => {
    if (!values.s3_enabled) return
    if (!/^https?:\/\//.test(values.s3_endpoint)) ctx.addIssue({ code: 'custom', path: ['s3_endpoint'], message: 'Enter an https:// endpoint' })
    if (!values.s3_bucket) ctx.addIssue({ code: 'custom', path: ['s3_bucket'], message: 'Enter a bucket' })
    if (!values.s3_access_key_id) ctx.addIssue({ code: 'custom', path: ['s3_access_key_id'], message: 'Enter an access key ID' })
  })

type FormValues = z.input<typeof schema>
type ParsedValues = z.output<typeof schema>

function toForm(settings: BackupSettings): FormValues {
  const s3 = settings.destinations.s3
  return {
    enabled: settings.enabled,
    preset: presetFromCron(settings.schedule_cron),
    schedule_cron: settings.schedule_cron,
    retention: { ...settings.retention },
    include_files: settings.include_files,
    local_enabled: settings.destinations.local.enabled,
    local_path: settings.destinations.local.path,
    s3_enabled: s3.enabled,
    s3_endpoint: s3.endpoint,
    s3_region: s3.region,
    s3_bucket: s3.bucket,
    s3_prefix: s3.prefix,
    s3_access_key_id: s3.access_key_id,
    s3_secret: '',
    s3_object_lock_days: s3.object_lock_days ?? '',
  }
}

function toUpdate(values: ParsedValues, settings: BackupSettings): BackupSettingsUpdate {
  return {
    enabled: values.enabled,
    schedule_cron: values.schedule_cron.trim(),
    retention: values.retention,
    include_files: values.include_files,
    recipient: settings.recipient,
    destinations: {
      local: { enabled: values.local_enabled, path: values.local_path },
      s3: {
        enabled: values.s3_enabled,
        endpoint: values.s3_endpoint,
        region: values.s3_region,
        bucket: values.s3_bucket,
        prefix: values.s3_prefix,
        access_key_id: values.s3_access_key_id,
        has_secret: settings.destinations.s3.has_secret,
        object_lock_days: values.s3_object_lock_days === '' ? null : values.s3_object_lock_days,
        ...(values.s3_secret ? { secret_access_key: values.s3_secret } : {}),
      },
    },
  }
}

function StatusBadge({ backup }: { backup: Backup }) {
  if (backup.status === 'running')
    return (
      <Badge variant="info">
        <LoaderCircle className="animate-spin" />
        Running
      </Badge>
    )
  if (backup.status === 'ok')
    return (
      <Badge variant="live">
        <CircleCheck />
        Succeeded
      </Badge>
    )
  return (
    <Tooltip>
      <TooltipTrigger render={<span />}>
        <Badge variant="critical">
          <CircleX />
          Failed
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">{backup.error ?? 'Unknown error'}</TooltipContent>
    </Tooltip>
  )
}

function DestinationIcons({ backup }: { backup: Backup }) {
  return (
    <span className="flex items-center gap-1.5">
      {backup.destinations.map((destination) => {
        const Icon = destination.kind === 'local' ? HardDrive : Cloud
        const tone =
          destination.status === 'ok' ? 'text-live' : destination.status === 'failed' ? 'text-critical' : 'text-subtle-foreground'
        return (
          <Tooltip key={destination.kind}>
            <TooltipTrigger
              render={
                <span
                  className={cn('flex size-6 items-center justify-center rounded-md bg-surface-3', tone)}
                  aria-label={`${destination.kind}: ${destination.status}`}
                />
              }
            >
              <Icon className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent className="max-w-sm">
              <span className="font-medium">{destination.kind === 'local' ? 'Local volume' : 'S3'}</span> ·{' '}
              {destination.status}
              {destination.location && <div className="font-mono text-[10.5px] opacity-80">{destination.location}</div>}
              {destination.error && <div>{destination.error}</div>}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </span>
  )
}

function SummaryCards({ backups, settings }: { backups: Backup[]; settings: BackupSettings }) {
  const lastOk = backups.find((backup) => backup.status === 'ok')
  const lastFailed = backups[0]?.status === 'failed'
  const next = settings.enabled ? nextCronRun(settings.schedule_cron) : null
  const offHost = settings.destinations.s3.enabled
  const okCount = backups.filter((backup) => backup.status === 'ok').length

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Card size="sm" className="gap-2">
        <CardHeader>
          <CardDescription className="flex items-center gap-1.5">
            <CircleCheck className="size-3.5 text-live" />
            Last successful backup
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-lg font-semibold tracking-tight">
            {lastOk ? <RelativeTime value={lastOk.finished_at ?? lastOk.started_at} /> : 'Never'}
          </div>
          <div className="text-micro text-subtle-foreground">{lastOk ? formatBytes(lastOk.size_bytes) : 'Run one now'}</div>
        </CardContent>
      </Card>
      <Card size="sm" className="gap-2">
        <CardHeader>
          <CardDescription className="flex items-center gap-1.5">
            <CalendarClock className="size-3.5" />
            Next scheduled run
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-lg font-semibold tracking-tight">{next ? formatDateTime(next) : 'Paused'}</div>
          <div className="text-micro text-subtle-foreground">{describeCron(settings.schedule_cron)} · server time</div>
        </CardContent>
      </Card>
      <Card size="sm" className="gap-2">
        <CardHeader>
          <CardDescription className="flex items-center gap-1.5">
            <DatabaseBackup className="size-3.5" />
            Retained backups
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="tabular text-lg font-semibold tracking-tight">{okCount}</div>
          <div className="text-micro text-subtle-foreground">
            {settings.retention.hourly}h · {settings.retention.daily}d · {settings.retention.weekly}w ·{' '}
            {settings.retention.monthly}m (GFS)
          </div>
        </CardContent>
      </Card>
      <Card size="sm" className={cn('gap-2', (!offHost || lastFailed) && 'ring-1 ring-warning/30')}>
        <CardHeader>
          <CardDescription className="flex items-center gap-1.5">
            {offHost && !lastFailed ? <Cloud className="size-3.5 text-live" /> : <ShieldExclamationPoint className="size-3.5 text-warning" />}
            Off-host copy
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-lg font-semibold tracking-tight">{offHost ? (lastFailed ? 'Last run failed' : 'Enabled') : 'Not configured'}</div>
          <div className="text-micro text-subtle-foreground">
            {offHost ? settings.destinations.s3.bucket : 'A copy on this host alone is not a backup'}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function SettingsForm({ settings, canManage }: { settings: BackupSettings; canManage: boolean }) {
  const queryClient = useQueryClient()
  const form = useForm<FormValues, unknown, ParsedValues>({
    resolver: zodResolver(schema),
    defaultValues: toForm(settings),
  })
  const { register, watch, setValue, formState } = form
  const errors = formState.errors

  useEffect(() => {
    form.reset(toForm(settings))
  }, [settings, form])

  const save = useMutation({
    mutationFn: (values: ParsedValues) => backupsApi.updateSettings(toUpdate(values, settings)),
    meta: { successMessage: 'Backup settings saved' },
    onSuccess: (updated) => {
      queryClient.setQueryData(keys.backupSettings, updated)
      form.reset(toForm(updated))
    },
  })

  const testS3 = useMutation({
    mutationFn: backupsApi.testS3,
    meta: { silent: true },
    onSuccess: (result) =>
      result.ok ? toast.success('Connected to the S3 bucket') : toast.error(result.error ?? 'Connection failed'),
    onError: (error) => toast.error(errorMessage(error)),
  })

  const preset = watch('preset') as CronPreset
  const cron = watch('schedule_cron')
  const s3Enabled = watch('s3_enabled')

  return (
    <form noValidate onSubmit={form.handleSubmit((values) => save.mutate(values))}>
      <fieldset disabled={!canManage} className="grid gap-4">
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div>
              <CardTitle>Schedule</CardTitle>
              <CardDescription>When automatic backups run. A backup also runs before every upgrade.</CardDescription>
            </div>
            <label className="flex items-center gap-2 text-dense">
              <Switch checked={watch('enabled')} onCheckedChange={(value) => setValue('enabled', value, { shouldDirty: true })} />
              {watch('enabled') ? 'Enabled' : 'Paused'}
            </label>
          </CardHeader>
          <CardContent>
            <FieldGroup className="gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="backup-preset">Frequency</FieldLabel>
                  <SimpleSelect
                    id="backup-preset"
                    value={preset}
                    onValueChange={(value) => {
                      setValue('preset', value as CronPreset, { shouldDirty: true })
                      setValue('schedule_cron', cronFromPreset(value as CronPreset, cron), { shouldDirty: true, shouldValidate: true })
                    }}
                    options={[...CRON_PRESETS.map((item) => ({ value: item.value, label: item.label })), { value: 'custom', label: 'Custom (cron)' }]}
                  />
                </Field>
                <Field data-invalid={Boolean(errors.schedule_cron) || undefined}>
                  <FieldLabel htmlFor="backup-cron">Cron expression</FieldLabel>
                  <Input
                    id="backup-cron"
                    className="font-mono"
                    readOnly={preset !== 'custom'}
                    {...register('schedule_cron', {
                      onChange: (event: { target: { value: string } }) =>
                        setValue('preset', presetFromCron(event.target.value), { shouldDirty: true }),
                    })}
                  />
                  <FieldDescription>{isValidCron(cron) ? describeCron(cron) : 'minute hour day month weekday'}</FieldDescription>
                  <FieldError errors={[errors.schedule_cron]} />
                </Field>
              </div>
              <div>
                <div className="mb-2 text-dense font-medium">Retention (grandfather-father-son)</div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {(['hourly', 'daily', 'weekly', 'monthly'] as const).map((bucket) => (
                    <Field key={bucket} data-invalid={Boolean(errors.retention?.[bucket]) || undefined}>
                      <FieldLabel htmlFor={`retention-${bucket}`} className="text-micro text-muted-foreground capitalize">
                        {bucket}
                      </FieldLabel>
                      <Input id={`retention-${bucket}`} type="number" min={0} className="tabular" {...register(`retention.${bucket}`)} />
                    </Field>
                  ))}
                </div>
                <p className="mt-1.5 text-micro text-subtle-foreground">
                  Keep the newest backup from each of the last N hours, days, weeks and months. Older backups are pruned.
                </p>
              </div>
              <label className="flex items-start gap-3 text-dense">
                <Switch
                  className="mt-0.5"
                  checked={watch('include_files')}
                  onCheckedChange={(value) => setValue('include_files', value, { shouldDirty: true })}
                />
                <span>
                  <span className="font-medium">Include uploaded files</span>
                  <span className="block text-micro text-muted-foreground">
                    Software packages, attachments and session recordings. Larger backups.
                  </span>
                </span>
              </label>
            </FieldGroup>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Destinations</CardTitle>
            <CardDescription>Keep at least one copy off this host — ideally with object lock.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <DestinationLocal form={form} />
            <div className="rounded-lg ring-1 ring-border">
              <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2.5">
                <div className="flex items-center gap-2.5">
                  <span className="flex size-8 items-center justify-center rounded-lg bg-surface-3 text-muted-foreground">
                    <Cloud className="size-4" />
                  </span>
                  <div>
                    <div className="text-dense font-medium">S3-compatible storage</div>
                    <div className="text-micro text-muted-foreground">AWS, Backblaze B2, Wasabi, MinIO…</div>
                  </div>
                </div>
                <Switch checked={s3Enabled} onCheckedChange={(value) => setValue('s3_enabled', value, { shouldDirty: true })} aria-label="Enable S3 destination" />
              </div>
              {s3Enabled && (
                <div className="grid gap-4 p-3 sm:grid-cols-2">
                  <Field data-invalid={Boolean(errors.s3_endpoint) || undefined} className="sm:col-span-2">
                    <FieldLabel htmlFor="s3-endpoint">Endpoint</FieldLabel>
                    <Input id="s3-endpoint" placeholder="https://s3.us-west-002.backblazeb2.com" {...register('s3_endpoint')} />
                    <FieldError errors={[errors.s3_endpoint]} />
                  </Field>
                  <Field data-invalid={Boolean(errors.s3_bucket) || undefined}>
                    <FieldLabel htmlFor="s3-bucket">Bucket</FieldLabel>
                    <Input id="s3-bucket" {...register('s3_bucket')} />
                    <FieldError errors={[errors.s3_bucket]} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="s3-region">Region</FieldLabel>
                    <Input id="s3-region" placeholder="us-east-1" {...register('s3_region')} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="s3-prefix">Key prefix</FieldLabel>
                    <Input id="s3-prefix" placeholder="rustrmm/" className="font-mono" {...register('s3_prefix')} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="s3-lock">Object lock (days)</FieldLabel>
                    <Input id="s3-lock" type="number" min={1} placeholder="Off" {...register('s3_object_lock_days')} />
                  </Field>
                  <Field data-invalid={Boolean(errors.s3_access_key_id) || undefined}>
                    <FieldLabel htmlFor="s3-key">Access key ID</FieldLabel>
                    <Input id="s3-key" className="font-mono" autoComplete="off" {...register('s3_access_key_id')} />
                    <FieldError errors={[errors.s3_access_key_id]} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="s3-secret">Secret access key</FieldLabel>
                    <Input
                      id="s3-secret"
                      type="password"
                      autoComplete="new-password"
                      placeholder={settings.destinations.s3.has_secret ? '•••••••• stored — leave blank to keep' : 'Required'}
                      {...register('s3_secret')}
                    />
                    <FieldDescription>Write-only. Stored encrypted with the server master key.</FieldDescription>
                  </Field>
                  <div className="flex items-center gap-2 sm:col-span-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={testS3.isPending || formState.isDirty}
                      onClick={() => testS3.mutate()}
                    >
                      {testS3.isPending ? <Spinner data-icon="inline-start" /> : <Wifi data-icon="inline-start" />}
                      Test connection
                    </Button>
                    {formState.isDirty && <span className="text-micro text-subtle-foreground">Save changes before testing.</span>}
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <LockKeyhole className="size-4 text-primary" />
              Encryption
            </CardTitle>
            <CardDescription>
              Backups are encrypted with <span className="font-medium text-foreground">age</span> to this public
              recipient. The matching private key lives only in your recovery kit — this server can write backups but
              cannot read them.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-1 rounded-lg bg-surface-2 py-1.5 pr-1.5 pl-3">
              <code className="min-w-0 flex-1 truncate font-mono text-[12px]">{settings.recipient}</code>
              <CopyButton value={settings.recipient} label="Copy recipient" />
            </div>
          </CardContent>
        </Card>

        {canManage && (
          <div className="sticky bottom-0 z-10 -mx-1 flex items-center justify-end gap-2 rounded-xl bg-background/90 px-1 py-3 backdrop-blur">
            <span className="mr-auto text-micro text-subtle-foreground">Saving asks you to confirm it&apos;s you.</span>
            <Button type="button" variant="ghost" disabled={!formState.isDirty} onClick={() => form.reset(toForm(settings))}>
              Discard
            </Button>
            <Button type="submit" disabled={!formState.isDirty || save.isPending}>
              {save.isPending && <Spinner data-icon="inline-start" />}
              Save settings
            </Button>
          </div>
        )}
      </fieldset>
    </form>
  )
}

function DestinationLocal({ form }: { form: UseFormReturn<FormValues, unknown, ParsedValues> }) {
  const enabled = form.watch('local_enabled')
  return (
    <div className="rounded-lg ring-1 ring-border">
      <div className="flex items-center justify-between gap-3 px-3 py-2.5">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-surface-3 text-muted-foreground">
            <HardDrive className="size-4" />
          </span>
          <div>
            <div className="text-dense font-medium">Local volume</div>
            <div className="text-micro text-muted-foreground">Bind-mounted to the Docker host for easy access.</div>
          </div>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(value) => form.setValue('local_enabled', value, { shouldDirty: true })}
          aria-label="Enable local destination"
        />
      </div>
      {enabled && (
        <div className="border-t border-border p-3">
          <Field data-invalid={Boolean(form.formState.errors.local_path) || undefined}>
            <FieldLabel htmlFor="local-path">Path inside the container</FieldLabel>
            <Input id="local-path" className="font-mono" {...form.register('local_path')} />
            <FieldError errors={[form.formState.errors.local_path]} />
          </Field>
        </div>
      )}
    </div>
  )
}

function History({ backups, isLoading, canManage }: { backups: Backup[]; isLoading: boolean; canManage: boolean }) {
  const queryClient = useQueryClient()
  const [deleting, setDeleting] = useState<Backup | null>(null)

  const remove = useMutation({
    mutationFn: (backup: Backup) => backupsApi.remove(backup.id),
    meta: { successMessage: 'Backup deleted' },
    onSuccess: () => {
      setDeleting(null)
      void queryClient.invalidateQueries({ queryKey: keys.backups })
    },
  })

  async function download(backup: Backup) {
    try {
      await backupsApi.download(backup.id)
    } catch (error) {
      toast.error(errorMessage(error, 'Download failed'))
    }
  }

  const columns = useMemo<ColumnDef<Backup>[]>(
    () => [
      {
        accessorKey: 'started_at',
        header: 'Started',
        cell: ({ getValue }) => (
          <div>
            <div className="font-medium">{formatDateTime(getValue<string>())}</div>
            <RelativeTime value={getValue<string>()} className="text-micro text-subtle-foreground" />
          </div>
        ),
      },
      {
        accessorKey: 'trigger',
        header: 'Trigger',
        cell: ({ getValue }) => (
          <Badge variant="outline" className="capitalize">
            {getValue<string>().replace('_', '-')}
          </Badge>
        ),
      },
      { accessorKey: 'status', header: 'Status', cell: ({ row }) => <StatusBadge backup={row.original} /> },
      {
        accessorKey: 'size_bytes',
        header: 'Size',
        meta: { align: 'right' },
        cell: ({ getValue }) => <span className="tabular">{formatBytes(getValue<number | null>())}</span>,
      },
      {
        accessorKey: 'sha256',
        header: 'SHA-256',
        enableSorting: false,
        cell: ({ getValue }) => {
          const hash = getValue<string | null>()
          return hash ? (
            <span className="flex items-center gap-0.5">
              <code className="font-mono text-[11px] text-muted-foreground">{truncateMiddle(hash, 6)}</code>
              <CopyButton value={hash} label="Copy SHA-256" />
            </span>
          ) : (
            <span className="text-subtle-foreground">—</span>
          )
        },
      },
      { id: 'destinations', header: 'Copies', enableSorting: false, cell: ({ row }) => <DestinationIcons backup={row.original} /> },
      {
        id: 'actions',
        header: '',
        enableSorting: false,
        meta: { align: 'right', className: 'w-12' },
        cell: ({ row }) =>
          canManage && row.original.status !== 'running' ? (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Backup actions" />}>
                <Ellipsis />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={row.original.status !== 'ok'} onClick={() => void download(row.original)}>
                  <Download />
                  Download encrypted file
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => setDeleting(row.original)}>
                  <Trash />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null,
      },
    ],
    [canManage],
  )

  return (
    <>
      <DataTable
        data={backups}
        columns={columns}
        loading={isLoading}
        getRowId={(backup) => backup.id}
        caption="Backup history"
        empty={
          <div className="p-6">
            <EmptyState compact illustration="backups" title="No backups yet" description="Run the first backup to verify your setup." />
          </div>
        }
      />
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this backup?"
        description={`The ${deleting ? formatDateTime(deleting.started_at) : ''} backup is removed from every destination. Object-locked copies stay until their lock expires.`}
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </>
  )
}

export function BackupsPage() {
  useTitle('Backups')
  const me = useMe()
  const queryClient = useQueryClient()
  const canManage = hasPermission(me, PERMISSIONS.backupsManage)
  const settingsQuery = useQuery(backupSettingsQuery)
  const historyQuery = useQuery(backupsQuery)
  const backups = historyQuery.data ?? []
  const running = backups.some((backup) => backup.status === 'running')

  const run = useMutation({
    mutationFn: backupsApi.run,
    meta: { successMessage: 'Backup started' },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.backups }),
  })

  return (
    <PageContainer className="grid gap-5">
      <PageHeader
        eyebrow="Settings"
        title="Backups"
        description="Encrypted SQLite snapshots with keys and configuration, kept on a GFS schedule across local and off-host destinations."
        actions={
          canManage && (
            <Button onClick={() => run.mutate()} disabled={run.isPending || running}>
              {run.isPending || running ? <Spinner data-icon="inline-start" /> : <Play data-icon="inline-start" />}
              {running ? 'Backup running…' : 'Run backup now'}
            </Button>
          )
        }
      />

      {settingsQuery.error ? (
        <ErrorState error={settingsQuery.error} onRetry={() => void settingsQuery.refetch()} />
      ) : !settingsQuery.data ? (
        <div className="grid gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-24 rounded-xl" />
          ))}
        </div>
      ) : (
        <>
          <SummaryCards backups={backups} settings={settingsQuery.data} />
          <div className="grid gap-5 2xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
            <section className="grid content-start gap-3">
              <h2 className="text-[15px] font-semibold tracking-tight">History</h2>
              <History backups={backups} isLoading={historyQuery.isLoading} canManage={canManage} />
            </section>
            <section className="grid content-start gap-3">
              <h2 className="text-[15px] font-semibold tracking-tight">Configuration</h2>
              <SettingsForm settings={settingsQuery.data} canManage={canManage} />
            </section>
          </div>
        </>
      )}
    </PageContainer>
  )
}
