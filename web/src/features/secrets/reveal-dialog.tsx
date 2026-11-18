/*
 * The reveal flow: a typed reason, the API client's step-up prompt, then the secret for 60 seconds.
 * The secret goes from the response straight into this dialog's state — never into TanStack Query's caches
 * (the mutation returns nothing), storage or the URL — and is dropped on close or when the countdown ends.
 */
import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ClipboardCheck, Copy, EyeOff, KeyRound, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { Mono, RelativeTime } from '@/components/common/misc'
import { escrowApi } from '@/lib/api/endpoints'
import { errorMessage, isApiError } from '@/lib/api/errors'
import { escrowKeys } from '@/lib/api/queries'
import type { EscrowItem, EscrowReveal } from '@/lib/api/types'
import {
  canonicalSecret,
  copySecret,
  countdown,
  itemSubject,
  KIND_LABEL,
  REVEAL_REASON_MAX,
  REVEAL_REASON_MIN,
  REVEAL_SECONDS,
  shortIdentifier,
  validateRevealReason,
} from '@/lib/escrow/secret'
import { cn } from '@/lib/utils'
import { useNow } from '@/features/tickets/use-now'
import { CountdownRing, KindTile, SecretDisplay } from './escrow-ui'

interface Revealed extends EscrowReveal {
  expiresAt: number
}

export function RevealDialog({ item, open, onOpenChange }: { item: EscrowItem | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [revealed, setRevealed] = useState<Revealed | null>(null)
  const close = () => {
    setRevealed(null)
    onOpenChange(false)
  }
  return (
    <Dialog
      open={open && Boolean(item)}
      onOpenChange={(next) => {
        if (!next) close()
      }}
    >
      <DialogContent className="sm:max-w-[560px]">
        {item &&
          (revealed ? (
            <SecretView item={item} revealed={revealed} onClose={close} />
          ) : (
            <ReasonForm item={item} onRevealed={(result) => setRevealed({ ...result, expiresAt: Date.now() + (result.expires_in || REVEAL_SECONDS) * 1000 })} onCancel={close} />
          ))}
      </DialogContent>
    </Dialog>
  )
}

function ItemSummary({ item }: { item: EscrowItem }) {
  return (
    <div className="flex items-start gap-3 rounded-lg bg-surface-2 px-3 py-2.5 ring-1 ring-border">
      <KindTile kind={item.kind} />
      <div className="min-w-0 flex-1 text-dense">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-medium">{item.hostname}</span>
          <span className="text-muted-foreground">{itemSubject(item)}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-micro text-subtle-foreground">
          <span>{item.client_name}</span>
          <span>·</span>
          <Mono className="text-[10.5px]">{shortIdentifier(item.identifier)}</Mono>
          <span>·</span>
          <span>
            captured <RelativeTime value={item.captured_at} />
          </span>
        </div>
      </div>
    </div>
  )
}

function ReasonForm({ item, onRevealed, onCancel }: { item: EscrowItem; onRevealed: (result: EscrowReveal) => void; onCancel: () => void }) {
  const queryClient = useQueryClient()
  const [reason, setReason] = useState('')
  const [attempted, setAttempted] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const problem = validateRevealReason(reason)
  const length = [...reason.trim()].length

  const reveal = useMutation({
    // The secret is handed to component state here and the mutation resolves with nothing, so it never
    // sits in the mutation cache; `gcTime: 0` drops the (empty) mutation as soon as it settles.
    mutationFn: async (text: string) => {
      onRevealed(await escrowApi.reveal(item.id, text))
      return null
    },
    gcTime: 0,
    meta: { silent: true },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: escrowKeys.all }),
    onError: (failure) => {
      if (isApiError(failure) && failure.code === 'step_up_required') setServerError('Re-authentication is required to reveal secrets. Try again and confirm your identity.')
      else if (isApiError(failure) && failure.status === 429) setServerError('You revealed many secrets in the last 10 minutes. Wait a few minutes and try again.')
      else if (isApiError(failure) && failure.status === 403) setServerError('You need the “Reveal secrets” permission for this device.')
      else setServerError(errorMessage(failure))
    },
  })

  const submit = () => {
    setAttempted(true)
    setServerError(null)
    if (problem) return
    reveal.mutate(reason.trim())
  }

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <ShieldAlert className="size-4 text-warning" />
          Reveal {KIND_LABEL[item.kind].toLowerCase()}
        </DialogTitle>
        <DialogDescription>
          Reveals are audited with your reason and may notify the client’s owners. You’ll be asked to confirm your identity.
          {item.kind === 'laps' && ' If the device’s policy rotates after a reveal, this password will be replaced soon.'}
        </DialogDescription>
      </DialogHeader>
      <ItemSummary item={item} />
      {item.superseded_at && (
        <p className="rounded-lg bg-warning/[0.08] px-3 py-2 text-micro text-warning ring-1 ring-warning/25">
          This item was superseded <RelativeTime value={item.superseded_at} />. It is only useful for backups or images taken before then.
        </p>
      )}
      <Field data-invalid={(attempted && Boolean(problem)) || Boolean(serverError) || undefined}>
        <FieldLabel htmlFor="reveal-reason">Reason</FieldLabel>
        <Textarea
          id="reveal-reason"
          autoFocus
          rows={3}
          maxLength={REVEAL_REASON_MAX + 20}
          placeholder="e.g. BitLocker recovery after a BIOS update, ticket #1042"
          value={reason}
          aria-invalid={(attempted && Boolean(problem)) || undefined}
          onChange={(event) => {
            setReason(event.target.value)
            setServerError(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit()
          }}
        />
        <div className="flex items-start justify-between gap-3">
          {serverError ? (
            <FieldError>{serverError}</FieldError>
          ) : attempted && problem ? (
            <FieldError>{problem}</FieldError>
          ) : (
            <FieldDescription>Name the ticket or the situation. It is stored with the audit entry.</FieldDescription>
          )}
          <span className={cn('tabular shrink-0 text-micro', length >= REVEAL_REASON_MIN ? 'text-success' : 'text-subtle-foreground')}>
            {length >= REVEAL_REASON_MIN ? `${length} characters` : `${length}/${REVEAL_REASON_MIN}`}
          </span>
        </div>
      </Field>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={reveal.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={reveal.isPending}>
          {reveal.isPending ? <Spinner data-icon="inline-start" /> : <KeyRound data-icon="inline-start" />}
          Reveal
        </Button>
      </DialogFooter>
    </form>
  )
}

function SecretView({ item, revealed, onClose }: { item: EscrowItem; revealed: Revealed; onClose: () => void }) {
  const now = useNow(250)
  const clock = countdown(revealed.expiresAt, now, revealed.expires_in || REVEAL_SECONDS)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!clock.expired) return
    toast.info('The secret was hidden after 60 seconds.')
    onClose()
  }, [clock.expired, onClose])

  const copy = async () => {
    const ok = await copySecret(canonicalSecret(revealed.kind, revealed.secret), (outcome) => {
      if (outcome === 'cleared') toast.message('Clipboard cleared', { description: `The ${KIND_LABEL[revealed.kind].toLowerCase()} was removed from the clipboard.` })
    })
    if (!ok) {
      toast.error('Clipboard access was blocked by the browser. Select the value and copy it by hand.')
      return
    }
    setCopied(true)
    toast.success('Copied', { description: 'The clipboard is cleared in 60 seconds (while this tab stays open).' })
  }

  return (
    <div className="grid gap-4">
      <DialogHeader className="pr-8">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <DialogTitle>{KIND_LABEL[revealed.kind]}</DialogTitle>
            <DialogDescription className="mt-1">
              {item.hostname} · {itemSubject(item)} · <Mono className="text-[10.5px]">{shortIdentifier(revealed.identifier)}</Mono>
            </DialogDescription>
          </div>
          <CountdownRing seconds={clock.seconds} fraction={clock.fraction} />
        </div>
      </DialogHeader>
      <SecretDisplay kind={revealed.kind} secret={revealed.secret} />
      {revealed.kind === 'bitlocker' && item.metadata.key_protector_id && (
        <p className="text-micro text-muted-foreground">
          Match the key ID on the recovery screen: <Mono className="text-[10.5px]">{`${item.metadata.key_protector_id.slice(0, 9)}…`}</Mono>
        </p>
      )}
      <p className="text-micro text-subtle-foreground">Shown once and never stored in the browser. This reveal is recorded in the audit log with your reason.</p>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          <EyeOff data-icon="inline-start" />
          Hide now
        </Button>
        <Button type="button" onClick={() => void copy()}>
          {copied ? <ClipboardCheck data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </DialogFooter>
    </div>
  )
}
