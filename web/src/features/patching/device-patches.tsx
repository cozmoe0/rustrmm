/* The device page's Patches tab: scan status, restart state, the device's updates and "Install now". */
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { ArrowUpRight, CalendarClock, Download, Radar, RotateCw, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DataTable } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, RelativeTime } from '@/components/common/misc'
import { patchesApi } from '@/lib/api/endpoints'
import { errorMessage, isApiError } from '@/lib/api/errors'
import { devicePatchesQuery, effectivePolicyQuery, keys } from '@/lib/api/queries'
import type { AutoApproveRule, DeviceDetail, DevicePatchItem, InventoryResponse, PatchRing, RebootMode } from '@/lib/api/types'
import { effectiveApproval } from '@/lib/patching/approval'
import { REBOOT_MODE_DESCRIPTION, RING_LABEL, SOURCE_LABEL, STATE_ORDER, isMissingState } from '@/lib/patching/labels'
import { DEFERRALS_MAX, MESSAGE_MAX, PATCHING_DEFAULTS, describeWindow, windowOccurrences } from '@/lib/patching/policy'
import { formatDate, formatDateTime, formatNumber, formatRelative } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { cn } from '@/lib/utils'
import { SearchField } from '@/features/devices/remote-ui'
import { UpdatesTab } from '@/features/devices/cockpit-inventory'
import { Step } from '@/features/automation/run-dialog'
import { SEGMENTED } from '@/features/automation/styles'
import { ApprovalBadge, ClassificationLabel, FilterPill, PatchStateBadge, SeverityPill } from './patching-ui'

type Filter = 'missing' | 'failed' | 'restart' | 'installed' | 'all'

const MATCH: Record<Filter, (item: DevicePatchItem) => boolean> = {
  missing: (item) => isMissingState(item.state) && item.state !== 'failed',
  failed: (item) => item.state === 'failed',
  restart: (item) => item.state === 'pending_reboot',
  installed: (item) => item.state === 'installed' || item.state === 'superseded',
  all: () => true,
}

interface DeviceContext {
  ring: PatchRing
  rules: AutoApproveRule[]
  macInstall: boolean
  winget: boolean
  linuxMode: 'security' | 'all'
}

/** Why a missing update will (or won't) install at the next window on this device. */
function EffectiveNote({ item, context }: { item: DevicePatchItem; context: DeviceContext }) {
  if (!isMissingState(item.state)) return null
  if (item.effective_approved)
    return (
      <span className="inline-flex items-center gap-1 text-micro text-success">
        <CalendarClock className="size-3" />
        Next window
      </span>
    )
  const approval = item.patch.approval
  if (approval.status === 'approved') {
    if (item.patch.platform === 'macos' && !context.macInstall) return <span className="text-micro text-subtle-foreground">Report only (macOS)</span>
    if (item.patch.platform === 'winget' && !context.winget) return <span className="text-micro text-subtle-foreground">winget off in policy</span>
    if (item.patch.platform === 'linux' && context.linuxMode === 'security' && approval.source === 'rule' && item.patch.classification !== 'security')
      return <span className="text-micro text-subtle-foreground">Security-only mode</span>
    const effective = effectiveApproval(item.patch, { ring: context.ring, rules: context.rules })
    if (effective.pendingUntil)
      return (
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex items-center gap-1 text-micro text-info" />}>
            <CalendarClock className="size-3" />
            {RING_LABEL[context.ring]} ring · {formatDate(effective.pendingUntil)}
          </TooltipTrigger>
          <TooltipContent className="max-w-64">{effective.reason}. The delay comes from the approval rule that matched for this client.</TooltipContent>
        </Tooltip>
      )
    return <span className="text-micro text-info">Ring delay</span>
  }
  if (approval.status === 'none') return <span className="text-micro text-warning">Needs approval</span>
  return null
}

function InstallDialog({
  device,
  items,
  defaults,
  open,
  onOpenChange,
}: {
  device: DeviceDetail
  items: DevicePatchItem[]
  defaults: typeof PATCHING_DEFAULTS.reboot
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const installable = items.filter((item) => isMissingState(item.state) && item.state !== 'installing')
  const approved = installable.filter((item) => item.effective_approved)
  const [mode, setMode] = useState<'approved' | 'pick'>(approved.length ? 'approved' : 'pick')
  const [picked, setPicked] = useState<Set<string>>(() => new Set(approved.map((item) => item.patch.id)))
  const [reboot, setReboot] = useState<RebootMode>(defaults.mode)
  const [deferrals, setDeferrals] = useState(String(defaults.prompt_deferrals))
  const [message, setMessage] = useState(defaults.message)
  const [serverError, setServerError] = useState<string | null>(null)
  const count = mode === 'approved' ? approved.length : picked.size
  const restartNeeded = (mode === 'approved' ? approved : installable.filter((item) => picked.has(item.patch.id))).some((item) => item.patch.reboot_required)
  const deferralError = reboot === 'prompt' && (!/^\d+$/.test(deferrals) || Number(deferrals) > DEFERRALS_MAX) ? `0–${DEFERRALS_MAX}` : null
  const messageError = [...message].length > MESSAGE_MAX ? `At most ${MESSAGE_MAX} characters` : null

  const install = useMutation({
    mutationFn: () =>
      patchesApi.install(device.id, {
        patch_ids: mode === 'approved' ? 'approved' : [...picked],
        reboot: { mode: reboot, deferrals: Number(deferrals) || 0, message: message.trim() || defaults.message },
      }),
    meta: { silent: true },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: keys.devicePatches(device.id) })
      void queryClient.invalidateQueries({ queryKey: keys.patchRuns })
      onOpenChange(false)
      toast.success(`Installing ${result?.count ?? count} ${(result?.count ?? count) === 1 ? 'update' : 'updates'} on ${device.hostname}`, {
        action: result?.run_id ? { label: 'View run', onClick: () => void navigate({ to: '/patching/runs/$runId', params: { runId: result.run_id! } }) } : undefined,
      })
    },
    onError: (failure) => {
      if (isApiError(failure) && failure.code === 'step_up_required') setServerError('Re-authentication was cancelled, so nothing was installed.')
      else if (isApiError(failure) && failure.code === 'nothing_to_install') setServerError('Nothing qualifies: no effective-approved update is missing on this device any more.')
      else if (isApiError(failure) && failure.code === 'device_offline') setServerError(`${device.hostname} went offline. Try again when it reconnects.`)
      else setServerError(errorMessage(failure))
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(92dvh,860px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[720px]">
        <div className="flex items-start gap-3 border-b border-border px-4 py-3.5 pr-12 sm:px-5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary ring-1 ring-primary/25">
            <Download className="size-4" />
          </span>
          <div className="min-w-0">
            <DialogTitle className="font-display text-base font-semibold">Install updates on {device.hostname}</DialogTitle>
            <DialogDescription className="text-micro">Runs now, outside the maintenance window. You’ll be asked to confirm it’s you.</DialogDescription>
          </div>
        </div>
        <div className="min-h-0 overflow-y-auto">
          <Step n={1} title="Updates">
            <div className="grid grid-cols-1 gap-3">
              <ToggleGroup value={[mode]} onValueChange={(next: string[]) => next[0] && setMode(next[0] as 'approved' | 'pick')} variant="outline" spacing={0} className={cn('w-full sm:w-auto', SEGMENTED)} aria-label="Which updates">
                <ToggleGroupItem value="approved" className="flex-1 sm:flex-none sm:px-4" disabled={approved.length === 0}>
                  All approved ({approved.length})
                </ToggleGroupItem>
                <ToggleGroupItem value="pick" className="flex-1 sm:flex-none sm:px-4">
                  Choose updates
                </ToggleGroupItem>
              </ToggleGroup>
              {mode === 'approved' ? (
                <p className="text-dense text-muted-foreground">
                  Every effective-approved update that is missing on the device. The retry limit for failed updates does not apply.
                </p>
              ) : installable.length === 0 ? (
                <p className="text-dense text-muted-foreground">Nothing is missing on this device.</p>
              ) : (
                <div className="max-h-64 overflow-y-auto overscroll-contain rounded-lg ring-1 ring-border">
                  {installable.map((item) => {
                    const checked = picked.has(item.patch.id)
                    return (
                      <label key={item.patch.id} className={cn('flex cursor-pointer items-center gap-3 border-b border-border px-3 py-2 text-dense last:border-b-0 hover:bg-surface-3/60', checked && 'bg-primary/[0.06]')}>
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() =>
                            setPicked((prev) => {
                              const next = new Set(prev)
                              if (next.has(item.patch.id)) next.delete(item.patch.id)
                              else next.add(item.patch.id)
                              return next
                            })
                          }
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{item.patch.title}</span>
                          <span className="flex flex-wrap items-center gap-x-2 text-micro text-subtle-foreground">
                            <SeverityPill severity={item.patch.severity} className="text-micro" />
                            {item.patch.reboot_required && <span>restart</span>}
                            {item.state === 'failed' && <span className="text-critical">failed before</span>}
                          </span>
                        </span>
                        <ApprovalBadge approval={item.patch.approval} compact />
                      </label>
                    )
                  })}
                </div>
              )}
            </div>
          </Step>
          <Step n={2} title="Restart" description={restartNeeded ? 'At least one of these updates needs a restart.' : 'None of these updates needs a restart, so this rarely matters.'}>
            <div className="grid grid-cols-1 gap-3">
              <ToggleGroup value={[reboot]} onValueChange={(next: string[]) => next[0] && setReboot(next[0] as RebootMode)} variant="outline" spacing={0} className={cn('w-full sm:w-auto', SEGMENTED)} aria-label="Restart behaviour">
                <ToggleGroupItem value="never" className="flex-1 sm:flex-none sm:px-4">
                  Never
                </ToggleGroupItem>
                <ToggleGroupItem value="prompt" className="flex-1 sm:flex-none sm:px-4">
                  Ask the user
                </ToggleGroupItem>
                <ToggleGroupItem value="force" className="flex-1 sm:flex-none sm:px-4 data-[pressed]:text-warning">
                  Force
                </ToggleGroupItem>
              </ToggleGroup>
              <p className="text-micro text-muted-foreground">{REBOOT_MODE_DESCRIPTION[reboot]} Defaults come from the device’s policy.</p>
              {reboot === 'prompt' && (
                <Field data-invalid={Boolean(deferralError) || undefined} className="sm:max-w-xs">
                  <FieldLabel htmlFor="install-deferrals">Postponements</FieldLabel>
                  <Input id="install-deferrals" type="number" min={0} max={DEFERRALS_MAX} className="tabular" value={deferrals} onChange={(event) => setDeferrals(event.target.value)} />
                  <FieldDescription>60 minutes each. There is no window-end deadline for immediate installs.</FieldDescription>
                  <FieldError>{deferralError}</FieldError>
                </Field>
              )}
              {reboot !== 'never' && (
                <Field data-invalid={Boolean(messageError) || undefined}>
                  <FieldLabel htmlFor="install-message">Message to the user</FieldLabel>
                  <Textarea id="install-message" rows={2} value={message} onChange={(event) => setMessage(event.target.value)} />
                  <FieldError>{messageError}</FieldError>
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
            ) : (
              <span>
                Installs <span className="tabular font-medium text-foreground">{formatNumber(count)}</span> {count === 1 ? 'update' : 'updates'} now · restart:{' '}
                <span className="font-medium text-foreground">{reboot === 'prompt' ? 'ask the user' : reboot}</span>
              </span>
            )}
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              disabled={install.isPending || count === 0 || Boolean(deferralError) || Boolean(messageError)}
              onClick={() => {
                setServerError(null)
                install.mutate()
              }}
            >
              {install.isPending ? <Spinner data-icon="inline-start" /> : <Download data-icon="inline-start" />}
              Install {count ? formatNumber(count) : ''} now
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function DevicePatchesTab({ device, inventory, loading }: { device: DeviceDetail; inventory: InventoryResponse | undefined; loading: boolean }) {
  const me = useMe()
  const queryClient = useQueryClient()
  const canView = hasPermission(me, PERMISSIONS.patchesView)
  const canApprove = hasPermission(me, PERMISSIONS.patchesApprove)
  const { data, isLoading, error, refetch } = useQuery({ ...devicePatchesQuery(device.id), enabled: canView })
  const { data: effective } = useQuery({ ...effectivePolicyQuery(device.id), enabled: canView })
  const [chosen, setFilter] = useState<Filter | null>(null)
  const [query, setQuery] = useState('')
  const [installing, setInstalling] = useState(false)
  const [scanRequested, setScanRequested] = useState<number | null>(null)
  const items = useMemo(() => data?.items ?? [], [data])
  const section = effective?.document.patching
  const context: DeviceContext = {
    ring: section?.ring ?? PATCHING_DEFAULTS.ring,
    rules: section?.auto_approve ?? [],
    macInstall: section?.macos?.install ?? false,
    winget: section?.third_party?.winget ?? false,
    linuxMode: section?.linux?.mode ?? 'security',
  }
  const reboot = { ...PATCHING_DEFAULTS.reboot, ...section?.reboot }
  const nextWindow = section?.window ? windowOccurrences(section.window, 1)[0] : undefined
  const scanning = scanRequested !== null && !(data?.scanned_at && new Date(data.scanned_at).getTime() >= scanRequested)
  const counts = useMemo(() => {
    const out = { missing: 0, failed: 0, restart: 0, installed: 0, all: items.length } as Record<Filter, number>
    for (const item of items) for (const key of ['missing', 'failed', 'restart', 'installed'] as Filter[]) if (MATCH[key](item)) out[key] += 1
    return out
  }, [items])
  // Start on what needs attention; fully patched devices open on the full list.
  const filter: Filter = chosen ?? (counts.missing ? 'missing' : counts.failed ? 'failed' : 'all')
  const ready = items.filter((item) => isMissingState(item.state) && item.effective_approved).length
  const needle = query.trim().toLowerCase()
  const visible = items.filter(MATCH[filter]).filter((item) => !needle || `${item.patch.title} ${item.patch.kb ?? ''} ${item.patch.key}`.toLowerCase().includes(needle))

  const scan = useMutation({
    mutationFn: () => patchesApi.scan(device.id),
    meta: { silent: true },
    onMutate: () => setScanRequested(Date.now()),
    onSuccess: () => toast.success(`Scan requested on ${device.hostname}`, { description: 'Results appear here when the agent reports back.' }),
    onError: (failure) => {
      setScanRequested(null)
      toast.error(isApiError(failure) && failure.code === 'device_offline' ? `${device.hostname} is offline` : errorMessage(failure))
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: keys.devicePatches(device.id) }),
  })

  const columns = useMemo<ColumnDef<DevicePatchItem>[]>(
    () => [
      {
        id: 'title',
        accessorFn: (item) => item.patch.title.toLowerCase(),
        header: 'Update',
        cell: ({ row }) => (
          <div className="min-w-0 leading-tight">
            <div className="max-w-[24rem] truncate font-medium" title={row.original.patch.title}>
              {row.original.patch.title}
            </div>
            <div className="flex max-w-[24rem] items-center gap-1.5 truncate text-[10.5px] text-subtle-foreground">
              {row.original.patch.kb && <span className="font-mono">{row.original.patch.kb}</span>}
              <ClassificationLabel platform={row.original.patch.platform} classification={row.original.patch.classification} />
              {row.original.patch.reboot_required && <RotateCw className="size-2.5" aria-label="Restart required" />}
            </div>
          </div>
        ),
      },
      { id: 'severity', accessorFn: (item) => item.patch.severity ?? 'Z', header: 'Severity', cell: ({ row }) => <SeverityPill severity={row.original.patch.severity} /> },
      {
        id: 'approval',
        accessorFn: (item) => (item.effective_approved ? 0 : item.patch.approval.status === 'approved' ? 1 : 2),
        header: 'Approval',
        cell: ({ row }) => (
          <div className="flex min-w-0 flex-col items-start gap-0.5">
            <ApprovalBadge approval={row.original.patch.approval} />
            <EffectiveNote item={row.original} context={context} />
          </div>
        ),
      },
      { id: 'state', accessorFn: (item) => STATE_ORDER.indexOf(item.state), header: 'State', cell: ({ row }) => <PatchStateBadge state={row.original.state} /> },
      {
        id: 'when',
        accessorFn: (item) => item.installed_at ?? item.detected_at ?? '',
        header: 'When',
        cell: ({ row }) => (
          <span className="tabular text-muted-foreground">
            {row.original.installed_at ? `Installed ${formatDate(row.original.installed_at)}` : row.original.detected_at ? `Found ${formatDate(row.original.detected_at)}` : '—'}
          </span>
        ),
      },
      {
        id: 'error',
        accessorFn: (item) => item.last_error ?? '',
        header: 'Last error',
        enableSorting: false,
        cell: ({ row }) =>
          row.original.last_error ? (
            <span className="block max-w-72 truncate font-mono text-[11.5px] text-critical/90" title={row.original.last_error}>
              {row.original.last_error}
            </span>
          ) : (
            <span className="text-subtle-foreground">—</span>
          ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [context.ring, context.rules, context.macInstall, context.winget, context.linuxMode],
  )

  if (!canView) return <UpdatesTab device={device} inventory={inventory} loading={loading} />
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />
  if (isLoading || !data)
    return (
      <div className="grid gap-4">
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-80 rounded-xl" />
      </div>
    )

  const active = device.status === 'active'
  return (
    <div className="grid grid-cols-1 gap-4 [&>*]:min-w-0">
      <section className="grid grid-cols-1 gap-4 rounded-xl bg-card p-4 shadow-card xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center">
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
          <div className="min-w-0">
            <div className="text-micro text-subtle-foreground">Last scan</div>
            <div className="mt-0.5 text-dense font-medium">{data.scanned_at ? <RelativeTime value={data.scanned_at} /> : 'Never'}</div>
            <div className="truncate text-micro text-muted-foreground">{data.source ? `via ${SOURCE_LABEL[data.source]}` : 'No scan reported'}</div>
          </div>
          <div className="min-w-0">
            <div className="text-micro text-subtle-foreground">Restart</div>
            <div className={cn('mt-0.5 flex items-center gap-1.5 text-dense font-medium', data.pending_reboot ? 'text-info' : 'text-success')}>
              <RotateCw className="size-3.5" />
              {data.pending_reboot ? 'Pending' : 'Not needed'}
            </div>
            {data.reboot_reasons.length > 0 && <div className="truncate text-micro text-muted-foreground" title={data.reboot_reasons.join(', ')}>{data.reboot_reasons.join(' · ')}</div>}
          </div>
          <div className="min-w-0">
            <div className="text-micro text-subtle-foreground">Ring · next window</div>
            <div className="mt-0.5 text-dense font-medium">
              {RING_LABEL[context.ring]}
              {section?.enabled === false || !section?.enabled ? <Badge variant="outline" className="ml-1.5">Patching off</Badge> : null}
            </div>
            <div className="truncate text-micro text-muted-foreground" title={describeWindow(section?.window)}>
              {nextWindow ? `${formatDateTime(nextWindow)} · ${formatRelative(nextWindow)}` : 'No maintenance window'}
            </div>
          </div>
          <div className="min-w-0">
            <div className="text-micro text-subtle-foreground">Ready to install</div>
            <div className="font-display tabular mt-0.5 text-lg leading-tight font-semibold">{formatNumber(ready)}</div>
            <div className="text-micro text-muted-foreground">
              of {formatNumber(counts.missing + counts.failed)} missing
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 xl:justify-end">
          <Button variant="outline" size="sm" disabled={!device.online || !active || scanning || scan.isPending} onClick={() => scan.mutate()} title={!device.online ? 'The device is offline' : undefined}>
            {scanning || scan.isPending ? <Spinner data-icon="inline-start" /> : <Radar data-icon="inline-start" />}
            {scanning ? 'Scanning…' : 'Scan now'}
          </Button>
          {canApprove && (
            <Button size="sm" disabled={!device.online || !active || counts.missing + counts.failed === 0} onClick={() => setInstalling(true)} title={!device.online ? 'The device is offline' : undefined}>
              <Download data-icon="inline-start" />
              Install now…
            </Button>
          )}
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {(['missing', 'failed', 'restart', 'installed', 'all'] as Filter[]).map((key) => (
            <FilterPill key={key} active={filter === key} onClick={() => setFilter(key)} count={counts[key]} disabled={key !== 'all' && key !== filter && counts[key] === 0}>
              {{ missing: 'Missing', failed: 'Failed', restart: 'Restart pending', installed: 'Installed', all: 'All' }[key]}
            </FilterPill>
          ))}
        </div>
        <SearchField value={query} onChange={setQuery} placeholder="Search updates…" label="Search updates" className="sm:ml-auto sm:w-64" />
      </div>

      {items.length === 0 ? (
        <EmptyState
          compact
          illustration="patching"
          title={data.scanned_at ? 'Fully patched' : 'No scan yet'}
          description={data.scanned_at ? 'The last scan found nothing missing.' : 'The device reports its updates after the first scan. Use Scan now to request one.'}
        />
      ) : (
        <DataTable
          data={visible}
          columns={columns}
          getRowId={(item) => item.patch.id}
          initialSorting={[{ id: 'severity', desc: false }]}
          virtualHeight={visible.length > 14 ? '540px' : undefined}
          caption="Updates on this device"
          empty={<div className="px-4 py-10 text-center text-dense text-muted-foreground">No updates match.</div>}
        />
      )}
      <p className="flex items-center gap-1.5 px-1 text-micro text-subtle-foreground">
        <ShieldCheck className="size-3.5" />
        Approvals shown are the ones that apply to {device.client_name}.
        <Link to="/patching/updates" search={{ client: device.client_id } as never} className="inline-flex items-center gap-0.5 text-primary hover:underline">
          Open the catalog <ArrowUpRight className="size-3" />
        </Link>
      </p>
      {installing && <InstallDialog device={device} items={items} defaults={reboot} open onOpenChange={setInstalling} />}
    </div>
  )
}
