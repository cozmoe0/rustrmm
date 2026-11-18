/* Add or edit an SNMP device (site, address, credential, templates, poll interval) and test it through the probe. */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleCheck, CircleX, PlugZap } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { SimpleSelect } from '@/components/common/simple-select'
import { snmpApi } from '@/lib/api/endpoints'
import { isApiError } from '@/lib/api/errors'
import { networkKeys, networkSettingsQuery, probesQuery, snmpCredentialsQuery, snmpTemplatesQuery } from '@/lib/api/queries'
import type { SnmpDevice, SnmpDeviceInput, SnmpTestResult } from '@/lib/api/types'
import { formatDuration, formatSpan } from '@/lib/format'
import { isPrivateAddress, parseIPv4 } from '@/lib/network/cidr'
import { POLL_INTERVALS, POLL_MAX, POLL_MIN } from '@/lib/network/snmp'
import { BUILTIN_TEMPLATE } from '@/lib/network/assets'
import { cn } from '@/lib/utils'
import { ProbeBadge, SiteSelect } from './network-ui'
import { networkErrorMessage, useScopedSites } from './use-network'

export function TestResultCard({ result, className }: { result: SnmpTestResult; className?: string }) {
  return (
    <div className={cn('flex items-start gap-2.5 rounded-lg px-3 py-2.5 ring-1', result.ok ? 'bg-success/[0.06] ring-success/25' : 'bg-critical/[0.05] ring-critical/25', className)} role="status">
      {result.ok ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" /> : <CircleX className="mt-0.5 size-4 shrink-0 text-critical" />}
      <div className="min-w-0 text-dense">
        <p className="font-medium">{result.ok ? 'The device answered' : 'No answer'}</p>
        {result.ok ? (
          <p className="text-micro break-words text-muted-foreground">
            {result.sys_name && <span className="font-medium text-foreground">{result.sys_name} · </span>}
            {result.sys_descr ?? 'No sysDescr'}
            {result.uptime_secs != null && <> · up {formatDuration(result.uptime_secs)}</>}
          </p>
        ) : (
          <p className="text-micro break-words text-critical">{result.error ?? 'The probe got no response.'}</p>
        )}
      </div>
    </div>
  )
}

export function SnmpDeviceEditor({ device, open, onOpenChange }: { device: SnmpDevice | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="gap-0 p-0 shadow-popover data-[side=right]:w-full data-[side=right]:sm:max-w-[560px]">
        {open && <DeviceForm key={device?.id ?? 'new'} device={device} onDone={() => onOpenChange(false)} />}
      </SheetContent>
    </Sheet>
  )
}

function DeviceForm({ device, onDone }: { device: SnmpDevice | null; onDone: () => void }) {
  const queryClient = useQueryClient()
  const { sites } = useScopedSites()
  const credentials = useQuery(snmpCredentialsQuery)
  const templates = useQuery(snmpTemplatesQuery)
  const probes = useQuery(probesQuery)
  const settings = useQuery(networkSettingsQuery)
  const [siteId, setSiteId] = useState(device?.site_id ?? '')
  const [name, setName] = useState(device?.name ?? '')
  const [ip, setIp] = useState(device?.ip ?? '')
  const [port, setPort] = useState(String(device?.port ?? 161))
  const [credentialId, setCredentialId] = useState(device?.credential_id ?? '')
  const [templateIds, setTemplateIds] = useState<string[]>(device?.template_ids ?? [BUILTIN_TEMPLATE.generic])
  const [interval, setIntervalSecs] = useState(String(device?.poll_interval_secs ?? 300))
  const [enabled, setEnabled] = useState(device?.enabled ?? true)
  const [attempted, setAttempted] = useState(false)
  const [test, setTest] = useState<SnmpTestResult | null>(null)
  const [serverError, setServerError] = useState<{ path: string; message: string } | null>(null)
  const allowPublic = settings.data?.allow_public_ranges ?? false
  const probe = probes.data?.find((item) => item.site_id === siteId)
  const credential = credentialId || credentials.data?.[0]?.id || ''
  const portValue = Number(port)
  const intervalValue = Number(interval)
  const errors = {
    site: !siteId ? 'Choose a site' : null,
    name: !name.trim() ? 'Enter a name' : null,
    ip: parseIPv4(ip) === null ? 'Enter an IPv4 address' : !allowPublic && !isPrivateAddress(ip) ? 'Use a private address (public ranges are off in network settings)' : null,
    port: !Number.isInteger(portValue) || portValue < 1 || portValue > 65_535 ? 'Port 1–65535' : null,
    credential: !credential ? 'Add a credential first' : null,
    interval: !Number.isInteger(intervalValue) || intervalValue < POLL_MIN || intervalValue > POLL_MAX ? `${POLL_MIN}–${POLL_MAX} seconds` : null,
  }
  const invalid = Object.values(errors).some(Boolean)
  const show = (key: keyof typeof errors) => (attempted ? errors[key] : null) ?? (serverError?.path.startsWith(key === 'credential' ? 'credential_id' : key === 'interval' ? 'poll_interval_secs' : key === 'site' ? 'site_id' : key) ? serverError.message : null)

  const body = (): SnmpDeviceInput => ({ site_id: siteId, name: name.trim(), ip: ip.trim(), port: portValue, credential_id: credential, template_ids: templateIds, poll_interval_secs: intervalValue, enabled, asset_id: device?.asset_id ?? undefined })
  const save = useMutation({
    mutationFn: () => (device ? snmpApi.updateDevice(device.id, body()) : snmpApi.createDevice(body())),
    meta: { silent: true },
    onSuccess: (result) => {
      toast.success(device ? `Saved ${result.name}` : `Added ${result.name}`, { description: device ? undefined : 'The first poll runs through the site’s probe in a moment.' })
      void queryClient.invalidateQueries({ queryKey: networkKeys.devices })
      onDone()
    },
    onError: (failure) => {
      if (isApiError(failure) && failure.status === 422) setServerError({ path: String((failure.details as { path?: string } | undefined)?.path ?? ''), message: failure.message })
      else toast.error(networkErrorMessage(failure))
    },
  })
  const runTest = useMutation({
    mutationFn: () => snmpApi.test(device!.id),
    meta: { silent: true },
    onSuccess: setTest,
    onError: (failure) => setTest({ ok: false, error: networkErrorMessage(failure) }),
  })

  return (
    <form
      className="flex h-full flex-col"
      onSubmit={(event) => {
        event.preventDefault()
        setAttempted(true)
        setServerError(null)
        if (!invalid) save.mutate()
      }}
    >
      <SheetHeader className="border-b border-border px-5 pt-5 pb-4">
        <SheetTitle>{device ? `Edit ${device.name}` : 'Add SNMP device'}</SheetTitle>
        <SheetDescription>The site’s probe polls the device with the credential and templates below. Thresholds in the templates raise alerts.</SheetDescription>
      </SheetHeader>
      <div className="grid flex-1 content-start gap-4 overflow-y-auto px-5 py-4">
        <Field data-invalid={Boolean(show('site')) || undefined}>
          <FieldLabel htmlFor="snmp-site">Site</FieldLabel>
          <SiteSelect id="snmp-site" value={siteId} any={null} className="sm:w-full" disabled={Boolean(device)} sites={sites} onChange={setSiteId} />
          {show('site') ? (
            <FieldError>{show('site')}</FieldError>
          ) : siteId ? (
            <FieldDescription className="flex items-center gap-1.5">
              Probe: <ProbeBadge probe={probe} className="text-micro" />
            </FieldDescription>
          ) : null}
        </Field>
        <Field data-invalid={Boolean(show('name')) || undefined}>
          <FieldLabel htmlFor="snmp-name">Name</FieldLabel>
          <Input id="snmp-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Front desk printer" />
          {show('name') && <FieldError>{show('name')}</FieldError>}
        </Field>
        <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
          <Field data-invalid={Boolean(show('ip')) || undefined}>
            <FieldLabel htmlFor="snmp-ip">IP address</FieldLabel>
            <Input id="snmp-ip" value={ip} onChange={(event) => setIp(event.target.value)} className="font-mono text-[12.5px]" placeholder="10.0.0.20" spellCheck={false} />
            {show('ip') && <FieldError>{show('ip')}</FieldError>}
          </Field>
          <Field data-invalid={Boolean(show('port')) || undefined}>
            <FieldLabel htmlFor="snmp-port">Port</FieldLabel>
            <Input id="snmp-port" type="number" value={port} onChange={(event) => setPort(event.target.value)} className="tabular" />
            {show('port') && <FieldError>{show('port')}</FieldError>}
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field data-invalid={Boolean(show('credential')) || undefined}>
            <FieldLabel htmlFor="snmp-credential">Credential</FieldLabel>
            <SimpleSelect id="snmp-credential" value={credential} onValueChange={setCredentialId} placeholder="No credentials" options={(credentials.data ?? []).map((item) => ({ value: item.id, label: `${item.name} (${item.version})` }))} />
            {show('credential') && <FieldError>{show('credential')}</FieldError>}
          </Field>
          <Field data-invalid={Boolean(show('interval')) || undefined}>
            <FieldLabel htmlFor="snmp-interval">Poll every</FieldLabel>
            <SimpleSelect
              id="snmp-interval"
              value={interval}
              onValueChange={setIntervalSecs}
              options={[...new Set([...POLL_INTERVALS, intervalValue])].filter(Number.isFinite).sort((a, b) => a - b).map((value) => ({ value: String(value), label: formatSpan(value) }))}
            />
            {show('interval') && <FieldError>{show('interval')}</FieldError>}
          </Field>
        </div>
        <Field>
          <FieldLabel>Templates</FieldLabel>
          <div className="grid gap-1 rounded-lg ring-1 ring-border">
            {(templates.data ?? []).map((template) => (
              <label key={template.id} className="flex cursor-pointer items-center gap-2.5 border-b border-border px-3 py-2 text-dense last:border-b-0 hover:bg-surface-3">
                <Checkbox checked={templateIds.includes(template.id)} onCheckedChange={(checked) => setTemplateIds(checked ? [...templateIds, template.id] : templateIds.filter((id) => id !== template.id))} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{template.name}</span>
                  <span className="block truncate text-micro text-subtle-foreground">{template.metrics.map((metric) => metric.label || metric.key).join(' · ')}</span>
                </span>
                {!template.builtin && <Badge variant="default">Custom</Badge>}
              </label>
            ))}
          </div>
          <FieldDescription>No template selected means Generic (uptime and description).</FieldDescription>
        </Field>
        <div className="flex items-center gap-3">
          <Switch id="snmp-enabled" checked={enabled} onCheckedChange={setEnabled} />
          <label htmlFor="snmp-enabled" className="text-dense">
            Poll this device
          </label>
        </div>
        {device && (
          <div className="grid gap-2">
            <Button type="button" variant="outline" size="sm" className="w-fit" disabled={runTest.isPending} onClick={() => runTest.mutate()}>
              {runTest.isPending ? <Spinner data-icon="inline-start" /> : <PlugZap data-icon="inline-start" />}
              Test saved settings
            </Button>
            {test && <TestResultCard result={test} />}
          </div>
        )}
      </div>
      <SheetFooter className="flex-row justify-end border-t border-border px-5 py-3">
        <Button type="button" variant="ghost" onClick={onDone} disabled={save.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending && <Spinner data-icon="inline-start" />}
          {device ? 'Save device' : 'Add device'}
        </Button>
      </SheetFooter>
    </form>
  )
}
