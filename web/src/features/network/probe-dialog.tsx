/* Assigning a site's probe agent: online agents only, Windows or Linux preferred, plus the optional trap receiver. */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Satellite } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { OsIcon } from '@/components/common/os-icon'
import { RelativeTime } from '@/components/common/misc'
import { StatusDot } from '@/components/common/status-dot'
import { probesApi } from '@/lib/api/endpoints'
import { devicesQuery, networkKeys } from '@/lib/api/queries'
import type { Device, SiteProbe } from '@/lib/api/types'
import { deviceName, osShortName } from '@/lib/devices'
import { cn } from '@/lib/utils'
import { networkErrorMessage } from './use-network'

const rank = (device: Device) => (device.online ? 0 : 10) + (device.os_family === 'macos' ? 3 : 0) + (device.device_type === 'server' || device.device_type === 'virtual' ? 0 : 1)

export function ProbeDialog({
  site,
  probe,
  open,
  onOpenChange,
}: {
  site: { id: string; name: string; client_name?: string } | null
  probe: SiteProbe | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open && Boolean(site)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">{site && <ProbeForm key={site.id} site={site} probe={probe} onDone={() => onOpenChange(false)} />}</DialogContent>
    </Dialog>
  )
}

function ProbeForm({ site, probe, onDone }: { site: { id: string; name: string; client_name?: string }; probe: SiteProbe | undefined; onDone: () => void }) {
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery(devicesQuery({ site_id: site.id }))
  const [deviceId, setDeviceId] = useState<string | null>(probe?.device_id ?? null)
  const [traps, setTraps] = useState(probe?.trap_receiver ?? false)
  const [port, setPort] = useState(String(probe?.trap_port ?? 162))
  const portValue = Number(port)
  const portError = traps && (!Number.isInteger(portValue) || portValue < 1 || portValue > 65_535) ? 'Use a port from 1 to 65535' : null
  const devices = [...(data ?? []).filter((device) => device.status === 'active')].sort((a, b) => rank(a) - rank(b) || a.hostname.localeCompare(b.hostname))

  const save = useMutation({
    mutationFn: (body: { device_id: string | null }) => probesApi.set(site.id, { ...body, trap_receiver: traps, trap_port: portValue }),
    meta: { silent: true },
    onSuccess: (result) => {
      toast.success(result.device_id ? `${result.hostname} is now the probe for ${site.name}` : `Removed the probe from ${site.name}`)
      void queryClient.invalidateQueries({ queryKey: networkKeys.probes })
      void queryClient.invalidateQueries({ queryKey: networkKeys.all })
      onDone()
    },
    onError: (failure) => toast.error(networkErrorMessage(failure)),
  })

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Satellite className="size-4 text-primary" />
          Network probe for {site.name}
        </DialogTitle>
        <DialogDescription>
          One agent per site runs discovery scans, polls SNMP devices and can receive traps. Pick an always-on Windows or Linux machine on the site’s network.
        </DialogDescription>
      </DialogHeader>
      <div className="grid max-h-[46vh] gap-1 overflow-y-auto rounded-lg ring-1 ring-border" role="radiogroup" aria-label="Probe agent">
        {isLoading ? (
          <div className="grid gap-1 p-2">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : devices.length === 0 ? (
          <p className="px-4 py-6 text-center text-dense text-muted-foreground">No active agents at this site yet.</p>
        ) : (
          devices.map((device) => {
            const current = probe?.device_id === device.id
            const selectable = device.online || current
            const preferred = device.os_family !== 'macos'
            const selected = deviceId === device.id
            return (
              <button
                key={device.id}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={!selectable}
                onClick={() => setDeviceId(device.id)}
                className={cn(
                  'flex items-center gap-3 border-b border-border px-3 py-2 text-left last:border-b-0 outline-none transition-colors hover:bg-surface-3 focus-visible:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-50',
                  selected && 'bg-primary/[0.07] hover:bg-primary/10',
                )}
              >
                <span className={cn('flex size-4 shrink-0 items-center justify-center rounded-full ring-1', selected ? 'bg-primary text-primary-foreground ring-primary' : 'ring-border-strong')}>
                  {selected && <Check className="size-3" />}
                </span>
                <OsIcon family={device.os_family} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-dense font-medium">{deviceName(device)}</span>
                  <span className="block truncate text-micro text-subtle-foreground">
                    {osShortName(device)}
                    {device.last_ip ? ` · ${device.last_ip}` : ''}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {current && <Badge variant="default">Current</Badge>}
                  {preferred && device.online && !current && device.device_type !== 'laptop' && <Badge variant="secondary">Good fit</Badge>}
                  {device.online ? (
                    <StatusDot tone="live" label="Online" />
                  ) : (
                    <span className="text-micro text-subtle-foreground">
                      offline · <RelativeTime value={device.last_seen_at} />
                    </span>
                  )}
                </span>
              </button>
            )
          })
        )}
      </div>
      <p className="text-micro text-subtle-foreground">Only online agents can become probes. macOS works, but Windows or Linux machines are preferred; laptops leave with their users.</p>
      <div className="grid gap-3 rounded-lg bg-surface-2 px-3 py-3 ring-1 ring-border sm:grid-cols-[1fr_8rem] sm:items-start">
        <div className="flex items-start gap-3">
          <Switch id="trap-receiver" checked={traps} onCheckedChange={setTraps} className="mt-0.5" />
          <div>
            <label htmlFor="trap-receiver" className="text-dense font-medium">
              Receive SNMP traps
            </label>
            <p className="text-micro text-muted-foreground">The probe listens for traps (v1/v2c) and forwards them; trap rules turn them into alerts.</p>
          </div>
        </div>
        <Field data-invalid={Boolean(portError) || undefined}>
          <FieldLabel htmlFor="trap-port" className="sr-only">
            Trap port
          </FieldLabel>
          <Input id="trap-port" type="number" min={1} max={65535} className="tabular" disabled={!traps} value={port} onChange={(event) => setPort(event.target.value)} aria-label="Trap port (UDP)" />
          {portError ? <FieldError>{portError}</FieldError> : <FieldDescription>UDP port</FieldDescription>}
        </Field>
      </div>
      <DialogFooter>
        {probe?.device_id && (
          <Button variant="ghost" className="mr-auto hover:text-critical" disabled={save.isPending} onClick={() => save.mutate({ device_id: null })}>
            Remove probe
          </Button>
        )}
        <Button variant="ghost" onClick={onDone} disabled={save.isPending}>
          Cancel
        </Button>
        <Button disabled={!deviceId || Boolean(portError) || save.isPending} onClick={() => save.mutate({ device_id: deviceId })}>
          {save.isPending && <Spinner data-icon="inline-start" />}
          Save probe
        </Button>
      </DialogFooter>
    </>
  )
}
