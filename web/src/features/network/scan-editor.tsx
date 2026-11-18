/* Create or edit a discovery scan: ranges (CIDR, at most /20, private unless allowed), methods, ports, credentials and schedule. */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleAlert, Plus, TriangleAlert, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { scansApi } from '@/lib/api/endpoints'
import { isApiError } from '@/lib/api/errors'
import { networkKeys, networkSettingsQuery, probesQuery, snmpCredentialsQuery } from '@/lib/api/queries'
import type { NetworkScan, NetworkScanInput, ScanMethods } from '@/lib/api/types'
import { isValidCron } from '@/lib/cron'
import { formatNumber } from '@/lib/format'
import { checkRanges, MAX_RANGES, MAX_SCAN_CREDENTIALS, parsePorts } from '@/lib/network/cidr'
import { cn } from '@/lib/utils'
import { CronField } from '@/features/automation/schedule-editor'
import { ProbeBadge, SiteSelect } from './network-ui'
import { networkErrorMessage, useScopedSites } from './use-network'

const DEFAULT_PORTS = [22, 80, 443, 445, 3389, 9100, 161]
const PORT_PRESETS: { label: string; ports: number[] }[] = [
  { label: 'Standard', ports: DEFAULT_PORTS },
  { label: '+ cameras, NAS, phones', ports: [...DEFAULT_PORTS, 554, 5000, 5001, 5060, 8080] },
  { label: 'Web only', ports: [80, 443, 8080, 8443] },
]

const METHODS: { key: keyof Omit<ScanMethods, 'tcp_ports'>; label: string; hint: string }[] = [
  { key: 'icmp', label: 'ICMP sweep', hint: 'Ping every address (400/s)' },
  { key: 'arp', label: 'ARP table', hint: 'Liveness and MAC on the local segment' },
  { key: 'snmp', label: 'SNMP', hint: 'sysDescr, sysName and sysObjectID' },
  { key: 'mdns', label: 'mDNS', hint: 'Names announced by printers, Macs, phones' },
  { key: 'netbios', label: 'NetBIOS', hint: 'Windows names' },
]

export function ScanEditor({ scan, open, onOpenChange }: { scan: NetworkScan | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="gap-0 p-0 shadow-popover data-[side=right]:w-full data-[side=right]:sm:max-w-[600px]">
        {open && <ScanForm key={scan?.id ?? 'new'} scan={scan} onDone={() => onOpenChange(false)} />}
      </SheetContent>
    </Sheet>
  )
}

function ScanForm({ scan, onDone }: { scan: NetworkScan | null; onDone: () => void }) {
  const queryClient = useQueryClient()
  const { sites, byId } = useScopedSites()
  const settings = useQuery(networkSettingsQuery)
  const probes = useQuery(probesQuery)
  const credentials = useQuery(snmpCredentialsQuery)
  const allowPublic = settings.data?.allow_public_ranges ?? false
  const [name, setName] = useState(scan?.name ?? '')
  const [siteId, setSiteId] = useState(scan?.site_id ?? '')
  const [ranges, setRanges] = useState<string[]>(scan?.ranges.length ? scan.ranges : [''])
  const [methods, setMethods] = useState<ScanMethods>(scan?.methods ?? { icmp: true, arp: true, tcp_ports: DEFAULT_PORTS, snmp: true, mdns: true, netbios: true })
  const [portsText, setPortsText] = useState((scan?.methods.tcp_ports ?? DEFAULT_PORTS).join(', '))
  const [credentialIds, setCredentialIds] = useState<string[]>(scan?.snmp_credential_ids ?? [])
  const site = byId.get(siteId)
  const [scheduled, setScheduled] = useState(Boolean(scan?.schedule))
  const [cron, setCron] = useState(scan?.schedule?.cron ?? '0 */6 * * *')
  const [timezone, setTimezone] = useState(scan?.schedule?.timezone ?? site?.timezone ?? 'UTC')
  const [attempted, setAttempted] = useState(false)
  const [serverError, setServerError] = useState<{ path: string; message: string } | null>(null)

  const rangeCheck = checkRanges(ranges, allowPublic)
  const ports = parsePorts(portsText)
  const probe = probes.data?.find((item) => item.site_id === siteId)
  const errors = {
    name: !name.trim() ? 'Enter a name' : null,
    site: !siteId ? 'Choose a site' : null,
    ranges: rangeCheck.listError ?? (rangeCheck.checks.some((check) => check.error) ? 'Fix the ranges above' : null),
    ports: ports.error,
    credentials: credentialIds.length > MAX_SCAN_CREDENTIALS ? `At most ${MAX_SCAN_CREDENTIALS} credentials` : null,
    cron: scheduled && !isValidCron(cron) ? 'Enter a valid 5-field cron expression' : null,
  }
  const invalid = Object.values(errors).some(Boolean)

  const save = useMutation({
    mutationFn: () => {
      const body: NetworkScanInput = {
        site_id: siteId,
        name: name.trim(),
        ranges: ranges.map((range) => range.trim()).filter(Boolean),
        methods: { ...methods, tcp_ports: ports.ports },
        schedule: scheduled ? { cron, timezone } : null,
        snmp_credential_ids: methods.snmp ? credentialIds : [],
      }
      return scan ? scansApi.update(scan.id, body) : scansApi.create(body)
    },
    meta: { silent: true },
    onSuccess: (result) => {
      toast.success(scan ? `Saved “${result.name}”` : `Created “${result.name}”`, { description: probe?.device_id ? undefined : 'Assign a probe to this site before it can run.' })
      void queryClient.invalidateQueries({ queryKey: networkKeys.scans })
      onDone()
    },
    onError: (failure) => {
      if (isApiError(failure) && failure.status === 422) setServerError({ path: String((failure.details as { path?: string } | undefined)?.path ?? ''), message: failure.message })
      else toast.error(networkErrorMessage(failure))
    },
  })

  const serverAt = (prefix: string) => (serverError && serverError.path.startsWith(prefix) ? serverError.message : null)
  const setRange = (index: number, value: string) => {
    setRanges(ranges.map((range, position) => (position === index ? value : range)))
    setServerError(null)
  }

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
        <SheetTitle>{scan ? 'Edit scan' : 'New discovery scan'}</SheetTitle>
        <SheetDescription>The site’s probe sweeps these ranges and reports every host it finds. Found devices are matched to enrolled agents by MAC and name.</SheetDescription>
      </SheetHeader>
      <div className="grid flex-1 content-start gap-5 overflow-y-auto px-5 py-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field data-invalid={(attempted && Boolean(errors.name)) || Boolean(serverAt('name')) || undefined}>
            <FieldLabel htmlFor="scan-name">Name</FieldLabel>
            <Input id="scan-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Office LAN" />
            {((attempted && errors.name) || serverAt('name')) && <FieldError>{errors.name ?? serverAt('name')}</FieldError>}
          </Field>
          <Field data-invalid={(attempted && Boolean(errors.site)) || undefined}>
            <FieldLabel htmlFor="scan-site">Site</FieldLabel>
            <SiteSelect
              id="scan-site"
              value={siteId}
              any={null}
              className="sm:w-full"
              disabled={Boolean(scan)}
              sites={sites}
              onChange={(value) => {
                setSiteId(value)
                if (!scan?.schedule) setTimezone(byId.get(value)?.timezone ?? timezone)
              }}
            />
            {attempted && errors.site ? (
              <FieldError>{errors.site}</FieldError>
            ) : siteId ? (
              <FieldDescription className="flex items-center gap-1.5">
                Probe: <ProbeBadge probe={probe} className="text-micro" />
              </FieldDescription>
            ) : scan ? (
              <FieldDescription>A scan can’t move to another site.</FieldDescription>
            ) : null}
          </Field>
        </div>

        <Field data-invalid={(attempted && Boolean(errors.ranges)) || undefined}>
          <FieldLabel>Ranges</FieldLabel>
          <div className="grid gap-2">
            {ranges.map((range, index) => {
              const check = rangeCheck.checks[index]
              const error = (attempted || range.trim().length >= 7) && check?.error ? check.error : serverAt(`ranges[${index}]`)
              return (
                <div key={index} className="grid gap-1">
                  <div className="flex items-center gap-2">
                    <Input
                      value={range}
                      onChange={(event) => setRange(index, event.target.value)}
                      placeholder="192.168.1.0/24"
                      className="font-mono text-[12.5px]"
                      aria-label={`Range ${index + 1}`}
                      aria-invalid={Boolean(error) || undefined}
                      spellCheck={false}
                    />
                    <span className="tabular w-24 shrink-0 text-right text-micro text-subtle-foreground">{check?.range && !check.error ? `${formatNumber(check.range.size)} ${check.range.size === 1 ? 'address' : 'addresses'}` : ''}</span>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove range ${index + 1}`} disabled={ranges.length === 1} onClick={() => setRanges(ranges.filter((_, position) => position !== index))}>
                      <X />
                    </Button>
                  </div>
                  {error ? (
                    <p className="flex items-start gap-1.5 text-micro text-critical">
                      <CircleAlert className="mt-px size-3 shrink-0" />
                      {error}
                    </p>
                  ) : check?.warning ? (
                    <p className="flex items-start gap-1.5 text-micro text-warning">
                      <TriangleAlert className="mt-px size-3 shrink-0" />
                      {check.warning}
                    </p>
                  ) : null}
                </div>
              )
            })}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" size="xs" disabled={ranges.length >= MAX_RANGES} onClick={() => setRanges([...ranges, ''])}>
              <Plus data-icon="inline-start" />
              Add range
            </Button>
            <span className="text-micro text-subtle-foreground">
              {formatNumber(rangeCheck.total)} addresses · CIDR or single addresses, each at most a /20 · {allowPublic ? 'public ranges allowed by network settings' : 'private ranges only'}
            </span>
          </div>
          {attempted && rangeCheck.listError && <FieldError>{rangeCheck.listError}</FieldError>}
        </Field>

        <Field>
          <FieldLabel>Methods</FieldLabel>
          <div className="grid gap-2 sm:grid-cols-2">
            {METHODS.map((method) => (
              <label key={method.key} className="flex cursor-pointer items-start gap-2.5 rounded-lg bg-surface-2 px-3 py-2 ring-1 ring-border has-[[data-checked]]:ring-primary/30">
                <Checkbox checked={methods[method.key]} onCheckedChange={(checked) => setMethods({ ...methods, [method.key]: Boolean(checked) })} className="mt-0.5" />
                <span className="min-w-0">
                  <span className="block text-dense font-medium">{method.label}</span>
                  <span className="block text-micro text-muted-foreground">{method.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </Field>

        <Field data-invalid={Boolean(ports.error) || undefined}>
          <FieldLabel htmlFor="scan-ports">TCP ports</FieldLabel>
          <Input id="scan-ports" value={portsText} onChange={(event) => setPortsText(event.target.value)} className="font-mono text-[12.5px]" placeholder="22, 80, 443, 9100" spellCheck={false} />
          {ports.error ? (
            <FieldError>{ports.error}</FieldError>
          ) : (
            <FieldDescription className="flex flex-wrap items-center gap-1.5">
              <span>{ports.ports.length ? `${ports.ports.length} ports probed with TCP connects.` : 'No TCP probing.'}</span>
              {PORT_PRESETS.map((preset) => (
                <button key={preset.label} type="button" className="rounded-sm px-1 text-primary underline-offset-2 hover:underline" onClick={() => setPortsText(preset.ports.join(', '))}>
                  {preset.label}
                </button>
              ))}
            </FieldDescription>
          )}
        </Field>

        <Field data-invalid={Boolean(errors.credentials) || undefined}>
          <FieldLabel>SNMP credentials to try</FieldLabel>
          {!methods.snmp ? (
            <FieldDescription>Turn on the SNMP method to read sysDescr during the scan.</FieldDescription>
          ) : (credentials.data ?? []).length === 0 ? (
            <FieldDescription>No credentials yet. Add one under Network › Credentials.</FieldDescription>
          ) : (
            <div className="grid gap-1.5">
              {(credentials.data ?? []).map((credential) => {
                const checked = credentialIds.includes(credential.id)
                return (
                  <label key={credential.id} className={cn('flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-dense hover:bg-surface-3')}>
                    <Checkbox checked={checked} onCheckedChange={(next) => setCredentialIds(next ? [...credentialIds, credential.id] : credentialIds.filter((id) => id !== credential.id))} />
                    <span className="min-w-0 flex-1 truncate">{credential.name}</span>
                    <span className="text-micro text-subtle-foreground">{credential.version}</span>
                  </label>
                )
              })}
            </div>
          )}
          {errors.credentials && <FieldError>{errors.credentials}</FieldError>}
        </Field>

        <div className="grid gap-3 rounded-lg bg-surface-2 p-3 ring-1 ring-border">
          <div className="flex items-start gap-3">
            <Switch id="scan-scheduled" checked={scheduled} onCheckedChange={setScheduled} className="mt-0.5" />
            <div>
              <label htmlFor="scan-scheduled" className="text-dense font-medium">
                Run on a schedule
              </label>
              <p className="text-micro text-muted-foreground">Scheduled runs are skipped quietly while the probe is offline.</p>
            </div>
          </div>
          {scheduled && <CronField cron={cron} timezone={timezone} onCronChange={setCron} onTimezoneChange={setTimezone} idPrefix="scan-cron" error={attempted ? (errors.cron ?? undefined) : undefined} />}
        </div>
      </div>
      <SheetFooter className="flex-row justify-end border-t border-border px-5 py-3">
        <Button type="button" variant="ghost" onClick={onDone} disabled={save.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending && <Spinner data-icon="inline-start" />}
          {scan ? 'Save scan' : 'Create scan'}
        </Button>
      </SheetFooter>
    </form>
  )
}
