import type { ReactNode } from 'react'
import { TriangleExclamationPoint } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { formatNumber } from '@/lib/format'

/**
 * The mass-action guard's confirmation step (`409 confirmation_required`): the user types the device
 * count before the action is sent again with `confirm_count`. Shared by jobs and software deployments.
 */
export function MassActionConfirm({
  count,
  description,
  typed,
  onTypedChange,
  pending,
  error,
  note,
  confirmLabel,
  destructive = false,
  onBack,
  onConfirm,
}: {
  count: number
  description: ReactNode
  typed: string
  onTypedChange: (value: string) => void
  pending: boolean
  error?: string | null
  note?: ReactNode
  confirmLabel: string
  destructive?: boolean
  onBack: () => void
  onConfirm: () => void
}) {
  const locked = typed.trim() !== String(count)
  return (
    <div className="grid grid-cols-1 gap-5 px-6 py-7">
      <div className="flex items-start gap-4">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-warning/12 text-warning ring-1 ring-warning/30">
          <TriangleExclamationPoint className="size-5" />
        </span>
        <div>
          <DialogTitle className="font-display text-lg font-semibold">Confirm a mass action</DialogTitle>
          <DialogDescription className="mt-1 text-dense">{description}</DialogDescription>
        </div>
      </div>
      <div className="flex items-center justify-center rounded-xl bg-surface-2 py-6 ring-1 ring-border">
        <div className="text-center">
          <div className="font-display tabular text-5xl font-semibold tracking-tight">{formatNumber(count)}</div>
          <div className="mt-1 text-micro text-muted-foreground">devices targeted</div>
        </div>
      </div>
      <Field>
        <FieldLabel htmlFor="confirm-count" className="text-dense text-muted-foreground">
          Type <span className="tabular font-mono font-semibold text-foreground">{count}</span> to confirm
        </FieldLabel>
        <Input
          id="confirm-count"
          inputMode="numeric"
          autoComplete="off"
          autoFocus
          className="tabular font-mono text-base"
          value={typed}
          onChange={(event) => onTypedChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !locked && !pending) onConfirm()
          }}
        />
        {note && <FieldDescription>{note}</FieldDescription>}
      </Field>
      {error && <FieldError>{error}</FieldError>}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={onBack} disabled={pending}>
          Back
        </Button>
        <Button variant={destructive ? 'destructive' : 'default'} disabled={locked || pending} onClick={onConfirm}>
          {pending && <Spinner data-icon="inline-start" />}
          {confirmLabel}
        </Button>
      </div>
    </div>
  )
}
