import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Ban, CalendarClock, Check, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { SimpleSelect } from '@/components/common/simple-select'
import { patchesApi } from '@/lib/api/endpoints'
import { errorMessage } from '@/lib/api/errors'
import { clientsQuery, keys } from '@/lib/api/queries'
import type { PatchDecision } from '@/lib/api/types'
import { defaultDeferDate, deferUntilIso } from '@/lib/patching/approval'
import { formatDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import { SEGMENTED } from '@/features/automation/styles'

const DECISION_COPY: Record<PatchDecision, { verb: string; done: string; explain: string }> = {
  approved: {
    verb: 'Approve',
    done: 'approved',
    explain: 'Manual approvals install at the next maintenance window, with no ring delay, and override approval rules.',
  },
  declined: { verb: 'Decline', done: 'declined', explain: 'Declined updates are never installed automatically. You can still install them on one device.' },
  deferred: { verb: 'Defer', done: 'deferred', explain: 'Nothing installs before the date; afterwards the next level of decision applies again.' },
  none: {
    verb: 'Reset',
    done: 'reset',
    explain: 'Removes the decision at this scope, including a client’s rule approval. The next level applies (a global decision or nothing).',
  },
}

export interface DecisionTarget {
  ids: string[]
  /** A short description of what is selected, e.g. a title or “12 updates”. */
  label: string
}

/** Approve, decline, defer or reset patches, globally or as a client override. */
export function DecisionDialog({
  target,
  initialDecision,
  defaultClientId,
  open,
  onOpenChange,
  onDone,
}: {
  target: DecisionTarget
  initialDecision: PatchDecision
  defaultClientId?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone?: () => void
}) {
  const queryClient = useQueryClient()
  const { data: clients = [] } = useQuery({ ...clientsQuery(), enabled: open })
  const [decision, setDecision] = useState<PatchDecision>(initialDecision)
  const [scope, setScope] = useState<'global' | 'client'>(defaultClientId ? 'client' : 'global')
  const [clientId, setClientId] = useState<string | null>(defaultClientId ?? null)
  const [date, setDate] = useState(defaultDeferDate)
  const [minDate] = useState(() => defaultDeferDate(Date.now() - 6 * 86_400_000))
  const [attempted, setAttempted] = useState(false)
  const until = decision === 'deferred' ? deferUntilIso(date) : null
  const problems = {
    client: scope === 'client' && !clientId ? 'Choose a client' : null,
    date: decision === 'deferred' && !until ? 'Choose a date in the future' : null,
  }
  const blocking = Boolean(problems.client || problems.date)
  const clientName = clients.find((client) => client.id === clientId)?.name
  const copy = DECISION_COPY[decision]

  const save = useMutation({
    mutationFn: () =>
      patchesApi.decide({
        ids: target.ids,
        client_id: scope === 'client' ? clientId : null,
        decision,
        ...(until ? { until } : {}),
      }),
    meta: { silent: true },
    onSuccess: (result) => {
      const count = result?.updated ?? target.ids.length
      toast.success(`${count} ${count === 1 ? 'update' : 'updates'} ${copy.done}${scope === 'client' && clientName ? ` for ${clientName}` : ''}`)
      void queryClient.invalidateQueries({ queryKey: keys.patches })
      onOpenChange(false)
      onDone?.()
    },
    onError: (failure) => toast.error(errorMessage(failure)),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>
            {copy.verb} {target.ids.length === 1 ? 'update' : `${target.ids.length} updates`}
          </DialogTitle>
          <DialogDescription className="line-clamp-2">{target.label}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-4">
          <Field>
            <FieldLabel>Decision</FieldLabel>
            <ToggleGroup
              value={[decision]}
              onValueChange={(next: string[]) => next[0] && setDecision(next[0] as PatchDecision)}
              variant="outline"
              spacing={0}
              className={cn('w-full', SEGMENTED)}
              aria-label="Decision"
            >
              <ToggleGroupItem value="approved" className="flex-1 gap-1.5 data-[pressed]:text-success">
                <Check />
                Approve
              </ToggleGroupItem>
              <ToggleGroupItem value="declined" className="flex-1 gap-1.5">
                <Ban />
                Decline
              </ToggleGroupItem>
              <ToggleGroupItem value="deferred" className="flex-1 gap-1.5 data-[pressed]:text-info">
                <CalendarClock />
                Defer
              </ToggleGroupItem>
              <ToggleGroupItem value="none" className="flex-1 gap-1.5">
                <RotateCcw />
                Reset
              </ToggleGroupItem>
            </ToggleGroup>
            <FieldDescription>{copy.explain}</FieldDescription>
          </Field>
          {decision === 'deferred' && (
            <Field data-invalid={Boolean(attempted && problems.date) || undefined} className="sm:max-w-xs">
              <FieldLabel htmlFor="defer-until">Defer until</FieldLabel>
              <Input id="defer-until" type="date" value={date} min={minDate} onChange={(event) => setDate(event.target.value)} />
              {until ? <FieldDescription>Through the end of {formatDate(until)}</FieldDescription> : <FieldError>{attempted ? problems.date : null}</FieldError>}
            </Field>
          )}
          <Field>
            <FieldLabel>Applies to</FieldLabel>
            <RadioGroup value={scope} onValueChange={(value) => setScope(value as 'global' | 'client')} className="grid grid-cols-1 gap-2">
              <label className={cn('flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 ring-1 ring-border', scope === 'global' && 'bg-primary/[0.05] ring-primary/30')}>
                <RadioGroupItem value="global" className="mt-0.5" />
                <span className="min-w-0">
                  <span className="block text-dense font-medium">Every client</span>
                  <span className="block text-micro text-muted-foreground">The global decision. A client’s own manual decision still wins for that client.</span>
                </span>
              </label>
              <label className={cn('flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 ring-1 ring-border', scope === 'client' && 'bg-primary/[0.05] ring-primary/30')}>
                <RadioGroupItem value="client" className="mt-0.5" />
                <span className="min-w-0 flex-1">
                  <span className="block text-dense font-medium">One client (override)</span>
                  <span className="block text-micro text-muted-foreground">Overrides the global decision and the client’s rule approvals for its devices.</span>
                </span>
              </label>
            </RadioGroup>
          </Field>
          {scope === 'client' && (
            <Field data-invalid={Boolean(attempted && problems.client) || undefined}>
              <FieldLabel htmlFor="decision-client">Client</FieldLabel>
              <SimpleSelect
                id="decision-client"
                value={clientId}
                onValueChange={setClientId}
                placeholder="Choose a client…"
                options={clients.map((client) => ({ value: client.id, label: client.name }))}
              />
              <FieldError>{attempted ? problems.client : null}</FieldError>
            </Field>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            Cancel
          </Button>
          <Button
            variant={decision === 'declined' ? 'destructive' : 'default'}
            disabled={save.isPending || (attempted && blocking)}
            onClick={() => {
              setAttempted(true)
              if (!blocking) save.mutate()
            }}
          >
            {save.isPending && <Spinner data-icon="inline-start" />}
            {copy.verb}
            {scope === 'client' && clientName ? ` for ${clientName}` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
