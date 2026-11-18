/* "Run window now": opens a manual patch run for the devices whose maintenance window comes from a policy. */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { CirclePlay, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { SimpleSelect } from '@/components/common/simple-select'
import { patchesApi } from '@/lib/api/endpoints'
import { errorMessage, isApiError } from '@/lib/api/errors'
import { clientsQuery, keys, sitesQuery } from '@/lib/api/queries'
import { formatDateTime } from '@/lib/format'

export const RUN_DURATION_MIN = 15
export const RUN_DURATION_MAX = 1440

export function RunWindowButton({ policyId, policyName, defaultDuration, disabled }: { policyId: string; policyName: string; defaultDuration: number; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => setOpen(true)}>
        <CirclePlay data-icon="inline-start" />
        Run window now
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[500px]">{open && <RunWindowForm policyId={policyId} policyName={policyName} defaultDuration={defaultDuration} onDone={() => setOpen(false)} />}</DialogContent>
      </Dialog>
    </>
  )
}

function RunWindowForm({ policyId, policyName, defaultDuration, onDone }: { policyId: string; policyName: string; defaultDuration: number; onDone: () => void }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: clients = [] } = useQuery(clientsQuery())
  const [duration, setDuration] = useState(String(defaultDuration))
  const [clientId, setClientId] = useState<string | null>(null)
  const [siteId, setSiteId] = useState<string | null>(null)
  const { data: sites = [] } = useQuery({ ...sitesQuery(clientId ?? undefined), enabled: Boolean(clientId) })
  const [noDevices, setNoDevices] = useState<string | null>(null)
  const minutes = Number(duration)
  const durationError = !Number.isInteger(minutes) || minutes < RUN_DURATION_MIN || minutes > RUN_DURATION_MAX ? `Use ${RUN_DURATION_MIN}–${RUN_DURATION_MAX} minutes` : null

  const run = useMutation({
    mutationFn: () => patchesApi.runPolicyNow(policyId, { duration_minutes: minutes, client_id: clientId ?? undefined, site_id: siteId ?? undefined }),
    meta: { silent: true },
    onSuccess: (result) => {
      toast.success(`Patch window opened for ${result.devices} ${result.devices === 1 ? 'device' : 'devices'}`, {
        description: `${result.online} online install now; the others wait until ${formatDateTime(result.window_end)}.`,
        action: { label: 'View run', onClick: () => void navigate({ to: '/patching/runs/$runId', params: { runId: result.run_id } }) },
      })
      void queryClient.invalidateQueries({ queryKey: keys.patchRuns })
      onDone()
    },
    onError: (failure) => {
      if (isApiError(failure) && failure.code === 'no_devices') setNoDevices(failure.message || 'No device in scope takes its maintenance window from this policy.')
      else if (isApiError(failure) && failure.code === 'step_up_required') toast.error('Re-authentication is required to start a patch run.')
      else toast.error(errorMessage(failure))
    },
  })

  return (
    <form
      className="grid grid-cols-1 gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        setNoDevices(null)
        if (!durationError) run.mutate()
      }}
    >
      <DialogHeader>
        <DialogTitle>Run “{policyName}” window now</DialogTitle>
        <DialogDescription>Online devices that take their window from this policy install their effective-approved updates at once; offline devices install if they connect before the window closes. You’ll be asked to re-authenticate.</DialogDescription>
      </DialogHeader>
      <Field data-invalid={Boolean(durationError) || undefined}>
        <FieldLabel htmlFor="run-window-duration">Window length (minutes)</FieldLabel>
        <Input id="run-window-duration" type="number" inputMode="numeric" min={RUN_DURATION_MIN} max={RUN_DURATION_MAX} value={duration} onChange={(event) => setDuration(event.target.value)} className="max-w-40" />
        {durationError ? <FieldError>{durationError}</FieldError> : <FieldDescription>Defaults to the policy window’s duration. Pending restarts follow the policy’s reboot settings.</FieldDescription>}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="run-window-client">Client</FieldLabel>
          <SimpleSelect id="run-window-client" value={clientId ?? ''} onValueChange={(value) => {
              setClientId(value || null)
              setSiteId(null)
            }} options={[{ value: '', label: 'Every client in scope' }, ...clients.map((client) => ({ value: client.id, label: client.name }))]} />
        </Field>
        <Field>
          <FieldLabel htmlFor="run-window-site">Site</FieldLabel>
          <SimpleSelect id="run-window-site" value={siteId ?? ''} disabled={!clientId} onValueChange={(value) => setSiteId(value || null)} options={[{ value: '', label: clientId ? 'All sites' : 'Choose a client first' }, ...sites.map((site) => ({ value: site.id, label: site.name }))]} />
        </Field>
      </div>
      {noDevices && (
        <p role="alert" className="flex items-start gap-2 rounded-lg bg-warning/[0.07] px-3 py-2 text-dense ring-1 ring-warning/30">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>
            {noDevices} Assign the policy to the devices first, or check that no closer policy layer sets its own window.
          </span>
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={run.isPending}>
          {run.isPending ? <Spinner data-icon="inline-start" /> : <CirclePlay data-icon="inline-start" />}
          Open the window
        </Button>
      </DialogFooter>
    </form>
  )
}
