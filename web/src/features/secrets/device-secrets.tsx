/* The device page's Secrets tab: escrowed items, LAPS policy and rotation, escrow refresh and encryption status. */
import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CircleAlert, CircleCheck, HardDrive, Info, KeyRound, Laptop, Lock, RefreshCw, RotateCcwKey } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, Mono, RelativeTime } from '@/components/common/misc'
import { escrowApi } from '@/lib/api/endpoints'
import { errorMessage, isApiError } from '@/lib/api/errors'
import { deviceEscrowQuery, effectivePolicyQuery, escrowKeys, inventoryQuery } from '@/lib/api/queries'
import type { DeviceDetail, EscrowItem } from '@/lib/api/types'
import { COMPLEXITY_LABEL, effectiveLaps, formatHours } from '@/lib/escrow/policy'
import { PERMISSIONS, hasAnyPermission, hasPermission, useMe } from '@/lib/permissions'
import { cn } from '@/lib/utils'
import { useNow } from '@/features/tickets/use-now'
import { DeleteEscrowDialog, EscrowItemSheet, EscrowTable } from './escrow-table'
import { RevealDialog } from './reveal-dialog'

const ROTATION_TIMEOUT_MS = 120_000

interface Rotation {
  cmdId: string
  requestedAt: number
}

function Step({ state, children }: { state: 'done' | 'active' | 'waiting'; children: ReactNode }) {
  return (
    <li className="flex items-center gap-2 text-dense">
      {state === 'done' ? (
        <CircleCheck className="size-4 shrink-0 text-success" />
      ) : state === 'active' ? (
        <Spinner className="size-4 shrink-0 text-primary" />
      ) : (
        <span className="size-4 shrink-0 rounded-full border border-dashed border-border-strong" />
      )}
      <span className={cn(state === 'waiting' && 'text-subtle-foreground')}>{children}</span>
    </li>
  )
}

function StatusRow({ icon, title, children, tone = 'neutral' }: { icon: ReactNode; title: string; children: ReactNode; tone?: 'neutral' | 'warning' | 'success' }) {
  return (
    <div className={cn('flex items-start gap-3 rounded-xl px-4 py-3 ring-1', tone === 'warning' ? 'bg-warning/[0.06] ring-warning/25' : tone === 'success' ? 'bg-success/[0.05] ring-success/20' : 'bg-card ring-border shadow-card')}>
      <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg ring-1 [&_svg]:size-4', tone === 'warning' ? 'bg-warning/12 text-warning ring-warning/25' : tone === 'success' ? 'bg-success/12 text-success ring-success/25' : 'bg-surface-3 text-muted-foreground ring-border')}>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-dense font-medium">{title}</p>
        <div className="text-micro text-muted-foreground">{children}</div>
      </div>
    </div>
  )
}

export function DeviceSecretsTab({ device }: { device: DeviceDetail }) {
  const me = useMe()
  const queryClient = useQueryClient()
  const canSee = hasAnyPermission(me, [PERMISSIONS.secretsReveal, PERMISSIONS.secretsManage])
  const canManage = hasPermission(me, PERMISSIONS.secretsManage)
  const [superseded, setSuperseded] = useState(false)
  const [rotation, setRotation] = useState<Rotation | null>(null)
  const [confirmRotate, setConfirmRotate] = useState(false)
  const [revealing, setRevealing] = useState<EscrowItem | null>(null)
  const [deleting, setDeleting] = useState<EscrowItem | null>(null)
  const [open, setOpen] = useState<EscrowItem | null>(null)
  const now = useNow(rotation ? 1_000 : 30_000)

  const items = useQuery({
    ...deviceEscrowQuery(device.id, superseded),
    enabled: canSee,
    // While a rotation is pending, poll until the agent's new password arrives (the `escrow.changed` event usually beats this).
    refetchInterval: rotation ? 2_500 : false,
  })
  const policy = useQuery({ ...effectivePolicyQuery(device.id), meta: { silent: true } })
  const inventory = useQuery({ ...inventoryQuery(device.id), meta: { silent: true } })
  const laps = effectiveLaps(policy.data?.document.escrow)
  const list = items.data ?? []
  const currentLaps = list.find((item) => item.kind === 'laps' && !item.superseded_at)
  const rotatedAt = rotation ? list.find((item) => item.kind === 'laps' && new Date(item.captured_at).getTime() >= rotation.requestedAt - 1_000) : undefined
  const rotationDone = Boolean(rotation && rotatedAt)
  const rotationSlow = Boolean(rotation && !rotationDone && now - rotation.requestedAt > ROTATION_TIMEOUT_MS)
  const encryption = inventory.data?.sections.security?.data.encryption
  const bitlockerItems = list.filter((item) => item.kind === 'bitlocker' && !item.superseded_at)
  const online = device.online && device.status === 'active'

  const rotate = useMutation({
    mutationFn: () => escrowApi.rotateLaps(device.id),
    meta: { silent: true },
    onSuccess: (result) => {
      setConfirmRotate(false)
      setRotation({ cmdId: result.cmd_id, requestedAt: Date.now() })
    },
    onError: (failure) => {
      setConfirmRotate(false)
      toast.error(isApiError(failure) && failure.code === 'device_offline' ? `${device.hostname} is offline. Rotation needs a connected agent.` : errorMessage(failure))
    },
  })

  const refresh = useMutation({
    mutationFn: () => escrowApi.refresh(device.id),
    meta: { silent: true },
    onSuccess: () => {
      toast.success(`Asked ${device.hostname} to re-send its recovery keys`, { description: 'New or changed keys appear here when the agent reports back.' })
      window.setTimeout(() => void queryClient.invalidateQueries({ queryKey: escrowKeys.all }), 4_000)
    },
    onError: (failure) => toast.error(isApiError(failure) && failure.code === 'device_offline' ? `${device.hostname} is offline` : errorMessage(failure)),
  })

  if (!canSee) {
    return (
      <EmptyState
        illustration="security"
        title="Secrets are restricted"
        description="This device’s BitLocker keys and local admin passwords need the “Reveal secrets” or “Manage escrow” permission."
      />
    )
  }

  const offlineReason = !online ? 'The device is offline' : null

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 lg:grid-cols-2">
        {device.os_family === 'windows' &&
          (encryption?.system_volume_encrypted === false ? (
            <StatusRow icon={<HardDrive />} title="BitLocker is off on the system volume">
              Nothing to escrow until BitLocker is turned on. The agent escrows the recovery key automatically when it is.
            </StatusRow>
          ) : bitlockerItems.length === 0 && encryption?.system_volume_encrypted ? (
            <StatusRow icon={<CircleAlert />} title="Encrypted, but no recovery key escrowed" tone="warning">
              {canManage ? 'Use Refresh escrow to ask the agent to re-send its BitLocker keys.' : 'Ask someone with “Manage escrow” to refresh escrow from this device.'}
            </StatusRow>
          ) : (
            <StatusRow icon={<HardDrive />} title={`BitLocker key escrowed for ${bitlockerItems.map((item) => item.metadata.volume ?? item.label).join(', ') || 'the system volume'}`} tone="success">
              Keys are collected at start-up, whenever BitLocker changes, and on refresh.
            </StatusRow>
          ))}
        {device.os_family === 'macos' && (
          <StatusRow icon={<Laptop />} title={`FileVault ${encryption?.system_volume_encrypted ? 'is on' : encryption?.system_volume_encrypted === false ? 'is off' : 'status unknown'}`}>
            The agent reports FileVault status. Escrowing a personal recovery key needs an attended flow that this agent version doesn’t support yet.
          </StatusRow>
        )}
        {device.os_family === 'linux' && (
          <StatusRow icon={<Lock />} title={`LUKS ${encryption?.system_volume_encrypted ? 'encrypts the system volume' : encryption?.system_volume_encrypted === false ? 'is not in use on the system volume' : 'status unknown'}`}>
            LUKS is reported by inventory only; keys are not escrowed.
          </StatusRow>
        )}
        <StatusRow icon={<KeyRound />} title={laps.enabled ? `LAPS rotates ${laps.account}` : 'LAPS is not enabled for this device'} tone={laps.enabled ? 'neutral' : 'neutral'}>
          {laps.enabled ? (
            <>
              Every {laps.rotate_days} {laps.rotate_days === 1 ? 'day' : 'days'} · {laps.length} characters, {COMPLEXITY_LABEL[laps.complexity].toLowerCase()} ·{' '}
              {laps.rotate_after_reveal_hours === 0 ? 'no rotation after a reveal' : `${formatHours(laps.rotate_after_reveal_hours)} after a reveal`}
              {currentLaps && (
                <>
                  {' '}
                  · last rotated <RelativeTime value={currentLaps.captured_at} />
                </>
              )}
            </>
          ) : (
            <>
              Turn it on in a policy’s{' '}
              <Link to="/automation/policies" className="underline-offset-2 hover:underline">
                Secrets escrow
              </Link>{' '}
              section. You can still rotate once by hand.
            </>
          )}
        </StatusRow>
      </div>

      {rotation && (
        <div className={cn('grid gap-3 rounded-xl px-4 py-3 ring-1', rotationDone ? 'bg-success/[0.05] ring-success/20' : 'bg-card shadow-card ring-border')} role="status" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2">
            <RotateCcwKey className={cn('size-4', rotationDone ? 'text-success' : 'text-primary')} />
            <span className="text-dense font-medium">{rotationDone ? 'Local admin password rotated' : 'Rotating the local admin password…'}</span>
            <Mono className="text-[10.5px]">{rotation.cmdId.slice(0, 8)}</Mono>
            <Button variant="ghost" size="xs" className="ml-auto" onClick={() => setRotation(null)}>
              Dismiss
            </Button>
          </div>
          <ol className="grid gap-1.5 sm:grid-cols-3">
            <Step state="done">Signed command sent</Step>
            <Step state={rotationDone ? 'done' : 'active'}>Agent sets a new password</Step>
            <Step state={rotationDone ? 'done' : 'waiting'}>New password escrowed{rotatedAt && <> · <RelativeTime value={rotatedAt.captured_at} /></>}</Step>
          </ol>
          {rotationSlow && (
            <p className="text-micro text-warning">
              No answer from the agent yet. The server retries a rotation without a result after 15 minutes; check the device’s connection.
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2">
          <Switch id={`superseded-${device.id}`} checked={superseded} onCheckedChange={setSuperseded} />
          <Label htmlFor={`superseded-${device.id}`} className="text-dense font-normal text-muted-foreground">
            Include superseded
          </Label>
        </div>
        {canManage && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <ActionButton
              disabledReason={offlineReason}
              pending={refresh.isPending}
              icon={<RefreshCw data-icon="inline-start" className={cn(refresh.isPending && 'animate-spin')} />}
              onClick={() => refresh.mutate()}
            >
              Refresh escrow
            </ActionButton>
            <ActionButton
              disabledReason={offlineReason ?? (rotation && !rotationDone && !rotationSlow ? 'A rotation is in progress' : null)}
              pending={rotate.isPending}
              icon={<RotateCcwKey data-icon="inline-start" />}
              onClick={() => setConfirmRotate(true)}
            >
              Rotate local admin now
            </ActionButton>
          </div>
        )}
      </div>

      {items.error ? (
        <ErrorState error={items.error} onRetry={() => void items.refetch()} />
      ) : (
        <EscrowTable
          items={list}
          loading={items.isLoading}
          showDevice={false}
          onOpen={setOpen}
          onReveal={setRevealing}
          onDelete={setDeleting}
          empty={
            <div className="flex flex-col items-center gap-1 px-4 py-10 text-center text-dense text-muted-foreground">
              <Info className="size-4 text-subtle-foreground" />
              Nothing escrowed for this device yet.
            </div>
          }
        />
      )}

      <ConfirmDialog
        open={confirmRotate}
        onOpenChange={setConfirmRotate}
        title={`Rotate the local admin password on ${device.hostname}?`}
        description={`The agent sets a new random ${laps.length}-character password for ${currentLaps?.metadata.account ?? laps.account}${laps.create_if_missing ? ' (creating the account if it is missing)' : ''} and escrows it before applying it. Anyone using the current password is signed out of that account. You’ll be asked to confirm your identity.`}
        confirmLabel="Rotate now"
        destructive={false}
        pending={rotate.isPending}
        onConfirm={() => rotate.mutate()}
      />
      <EscrowItemSheet item={open} onClose={() => setOpen(null)} onReveal={setRevealing} onDelete={setDeleting} />
      <RevealDialog item={revealing} open={Boolean(revealing)} onOpenChange={(next) => !next && setRevealing(null)} />
      <DeleteEscrowDialog
        item={deleting}
        onClose={() => {
          if (deleting?.id === open?.id) setOpen(null)
          setDeleting(null)
        }}
      />
    </div>
  )
}

function ActionButton({ disabledReason, pending, icon, onClick, children }: { disabledReason: string | null; pending: boolean; icon: ReactNode; onClick: () => void; children: ReactNode }) {
  if (disabledReason) {
    return (
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" tabIndex={0} aria-label={`${String(children)} — ${disabledReason}`} />}>
          <Button variant="outline" size="sm" disabled aria-hidden="true" tabIndex={-1}>
            {icon}
            {children}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{disabledReason}</TooltipContent>
      </Tooltip>
    )
  }
  return (
    <Button variant="outline" size="sm" disabled={pending} onClick={onClick}>
      {pending ? <Spinner data-icon="inline-start" /> : icon}
      {children}
    </Button>
  )
}
