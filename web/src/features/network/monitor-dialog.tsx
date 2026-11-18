/* "Monitor via SNMP": turns a discovered asset into an SNMP device with a credential and templates for its type. */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Activity } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { SimpleSelect } from '@/components/common/simple-select'
import { assetsApi } from '@/lib/api/endpoints'
import { networkKeys, snmpCredentialsQuery, snmpTemplatesQuery } from '@/lib/api/queries'
import type { NetworkAsset } from '@/lib/api/types'
import { ASSET_TYPE_LABEL, assetName, defaultTemplatesFor } from '@/lib/network/assets'
import { POLL_INTERVALS } from '@/lib/network/snmp'
import { formatSpan } from '@/lib/format'
import { networkErrorMessage } from './use-network'

export function MonitorDialog({ asset, onClose }: { asset: NetworkAsset | null; onClose: () => void }) {
  return (
    <Dialog open={Boolean(asset)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[520px]">{asset && <MonitorForm key={asset.id} asset={asset} onDone={onClose} />}</DialogContent>
    </Dialog>
  )
}

function MonitorForm({ asset, onDone }: { asset: NetworkAsset; onDone: () => void }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const credentials = useQuery(snmpCredentialsQuery)
  const templates = useQuery(snmpTemplatesQuery)
  const [name, setName] = useState(asset.snmp_sys_name || asset.hostname || '')
  const [credentialId, setCredentialId] = useState<string>('')
  const [templateIds, setTemplateIds] = useState<string[]>(defaultTemplatesFor(asset.type_guess))
  const [interval, setIntervalSecs] = useState('300')
  const [attempted, setAttempted] = useState(false)
  const credential = credentialId || credentials.data?.[0]?.id || ''

  const monitor = useMutation({
    mutationFn: () => assetsApi.monitor(asset.id, { credential_id: credential, template_ids: templateIds, name: name.trim() || undefined, poll_interval_secs: Number(interval) }),
    meta: { silent: true },
    onSuccess: (device) => {
      toast.success(`Monitoring ${device.name} over SNMP`, {
        description: 'The first poll runs through the site’s probe in a moment.',
        action: { label: 'Open', onClick: () => void navigate({ to: '/network/snmp/$snmpDeviceId', params: { snmpDeviceId: device.id } }) },
      })
      void queryClient.invalidateQueries({ queryKey: networkKeys.devices })
      void queryClient.invalidateQueries({ queryKey: networkKeys.assets })
      onDone()
    },
    onError: (failure) => toast.error(networkErrorMessage(failure)),
  })

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        setAttempted(true)
        if (credential && templateIds.length) monitor.mutate()
      }}
    >
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Activity className="size-4 text-primary" />
          Monitor {assetName(asset)} via SNMP
        </DialogTitle>
        <DialogDescription>
          {asset.ip} · {ASSET_TYPE_LABEL[asset.type_guess]}
          {asset.vendor ? ` · ${asset.vendor}` : ''}. The site’s probe polls it and raises alerts on thresholds and outages.
        </DialogDescription>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor="monitor-name">Name</FieldLabel>
        <Input id="monitor-name" value={name} onChange={(event) => setName(event.target.value)} placeholder={assetName(asset)} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field data-invalid={(attempted && !credential) || undefined}>
          <FieldLabel htmlFor="monitor-credential">Credential</FieldLabel>
          <SimpleSelect
            id="monitor-credential"
            value={credential}
            onValueChange={setCredentialId}
            placeholder={credentials.isLoading ? 'Loading…' : 'No credentials'}
            options={(credentials.data ?? []).map((item) => ({ value: item.id, label: `${item.name} (${item.version})` }))}
          />
          {attempted && !credential && <FieldError>Add a credential under Network › Credentials first</FieldError>}
        </Field>
        <Field>
          <FieldLabel htmlFor="monitor-interval">Poll every</FieldLabel>
          <SimpleSelect id="monitor-interval" value={interval} onValueChange={setIntervalSecs} options={POLL_INTERVALS.map((value) => ({ value: String(value), label: formatSpan(value) }))} />
        </Field>
      </div>
      <Field data-invalid={(attempted && templateIds.length === 0) || undefined}>
        <FieldLabel>Templates</FieldLabel>
        <div className="grid max-h-56 gap-1 overflow-y-auto">
          {(templates.data ?? []).map((template) => (
            <label key={template.id} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-dense hover:bg-surface-3">
              <Checkbox checked={templateIds.includes(template.id)} onCheckedChange={(checked) => setTemplateIds(checked ? [...templateIds, template.id] : templateIds.filter((id) => id !== template.id))} />
              <span className="min-w-0 flex-1 truncate">{template.name}</span>
              {!template.builtin && <Badge variant="default">Custom</Badge>}
              <span className="tabular text-micro text-subtle-foreground">{template.metrics.length}</span>
            </label>
          ))}
        </div>
        {attempted && templateIds.length === 0 ? <FieldError>Pick at least one template</FieldError> : <FieldDescription>Suggested for a {ASSET_TYPE_LABEL[asset.type_guess].toLowerCase()}.</FieldDescription>}
      </Field>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone} disabled={monitor.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={monitor.isPending}>
          {monitor.isPending && <Spinner data-icon="inline-start" />}
          Start monitoring
        </Button>
      </DialogFooter>
    </form>
  )
}
