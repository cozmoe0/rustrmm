import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { SimpleSelect } from '@/components/common/simple-select'
import { TokenInput } from '@/components/common/token-input'
import { devicesApi } from '@/lib/api/endpoints'
import { keys, sitesQuery } from '@/lib/api/queries'
import type { Device, DeviceDetail } from '@/lib/api/types'
import { normalizeTags } from '@/lib/devices'

const normalizeTag = (tag: string) => tag.trim().toLowerCase().slice(0, 40)
const validateTag = (tag: string) => (/^[a-z0-9][a-z0-9 ._:/-]*$/.test(tag) ? null : 'Tags use letters, numbers, spaces and . _ : / -')

/** Runs a mutation against many devices and reports how many succeeded. */
async function forEachDevice(devices: Device[], run: (device: Device) => Promise<unknown>) {
  const results = await Promise.allSettled(devices.map(run))
  const failed = results.filter((result) => result.status === 'rejected').length
  return { ok: results.length - failed, failed }
}

// Each dialog keeps its form state in an inner component that mounts when the dialog opens,
// so every open starts from fresh values without effects.

export function EditDeviceDialog({
  device,
  open,
  onOpenChange,
}: {
  device: DeviceDetail
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit device</DialogTitle>
          <DialogDescription>
            Friendly name and tags for <span className="font-mono text-foreground">{device.hostname}</span>. The hostname
            itself always comes from the agent.
          </DialogDescription>
        </DialogHeader>
        {open && <EditDeviceForm device={device} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function EditDeviceForm({ device, onDone }: { device: DeviceDetail; onDone: () => void }) {
  const queryClient = useQueryClient()
  const [displayName, setDisplayName] = useState(device.display_name ?? '')
  const [tags, setTags] = useState<string[]>(device.tags)

  const mutation = useMutation({
    mutationFn: () => devicesApi.update(device.id, { display_name: displayName.trim() || null, tags: normalizeTags(tags) }),
    meta: { successMessage: 'Device updated' },
    onSuccess: (updated) => {
      queryClient.setQueryData(keys.device(device.id), updated)
      void queryClient.invalidateQueries({ queryKey: [...keys.devices, 'list'] })
      onDone()
    },
  })

  return (
    <>
      <form
        id="edit-device"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          mutation.mutate()
        }}
      >
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel htmlFor="device-display-name">Display name</FieldLabel>
            <Input
              id="device-display-name"
              autoFocus
              maxLength={120}
              value={displayName}
              placeholder={device.hostname}
              onChange={(event) => setDisplayName(event.target.value)}
            />
            <FieldDescription>Shown instead of the hostname across the console. Leave empty to use the hostname.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="device-tags">Tags</FieldLabel>
            <TokenInput
              id="device-tags"
              value={tags}
              onChange={setTags}
              normalize={normalizeTag}
              validate={validateTag}
              max={30}
              mono
              placeholder="front-desk, vip…"
            />
            <FieldDescription>Press Enter or comma to add. Tags power filters and saved views.</FieldDescription>
          </Field>
        </FieldGroup>
      </form>
      <DialogFooter>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" form="edit-device" disabled={mutation.isPending}>
          {mutation.isPending && <Spinner data-icon="inline-start" />}
          Save changes
        </Button>
      </DialogFooter>
    </>
  )
}

export function BulkTagDialog({
  devices,
  open,
  onOpenChange,
  onDone,
}: {
  devices: Device[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone?: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add tags</DialogTitle>
          <DialogDescription>
            Adds to the existing tags of {devices.length} selected {devices.length === 1 ? 'device' : 'devices'}.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <BulkTagForm
            devices={devices}
            onClose={() => onOpenChange(false)}
            onDone={() => {
              onOpenChange(false)
              onDone?.()
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function BulkTagForm({ devices, onClose, onDone }: { devices: Device[]; onClose: () => void; onDone: () => void }) {
  const queryClient = useQueryClient()
  const [tags, setTags] = useState<string[]>([])
  const mutation = useMutation({
    mutationFn: () => forEachDevice(devices, (device) => devicesApi.update(device.id, { tags: normalizeTags([...device.tags, ...tags]) })),
    meta: { silent: true },
    onSuccess: ({ ok, failed }) => {
      void queryClient.invalidateQueries({ queryKey: keys.devices })
      if (failed) toast.warning(`Tagged ${ok} devices; ${failed} could not be updated.`)
      else toast.success(`Added ${tags.length === 1 ? `“${tags[0]}”` : `${tags.length} tags`} to ${ok} ${ok === 1 ? 'device' : 'devices'}`)
      onDone()
    },
  })

  return (
    <>
      <Field>
        <FieldLabel htmlFor="bulk-tags">Tags</FieldLabel>
        <TokenInput
          id="bulk-tags"
          value={tags}
          onChange={setTags}
          normalize={normalizeTag}
          validate={validateTag}
          max={10}
          mono
          placeholder="Type a tag and press Enter"
        />
      </Field>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={tags.length === 0 || mutation.isPending} onClick={() => mutation.mutate()}>
          {mutation.isPending && <Spinner data-icon="inline-start" />}
          Add tags
        </Button>
      </DialogFooter>
    </>
  )
}

export function MoveSiteDialog({
  devices,
  open,
  onOpenChange,
  onDone,
}: {
  devices: Device[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone?: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Move to site</DialogTitle>
          <DialogDescription>
            Moves {devices.length} {devices.length === 1 ? 'device' : 'devices'} within{' '}
            <span className="font-medium text-foreground">{devices[0]?.client_name}</span>. Site policies and maintenance
            windows follow the device.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <MoveSiteForm
            devices={devices}
            onClose={() => onOpenChange(false)}
            onDone={() => {
              onOpenChange(false)
              onDone?.()
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function MoveSiteForm({ devices, onClose, onDone }: { devices: Device[]; onClose: () => void; onDone: () => void }) {
  const queryClient = useQueryClient()
  const clientId = devices[0]?.client_id
  const { data: sites = [] } = useQuery({ ...sitesQuery(clientId), enabled: Boolean(clientId) })
  const [siteId, setSiteId] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: (target: string) =>
      forEachDevice(
        devices.filter((device) => device.site_id !== target),
        (device) => devicesApi.update(device.id, { site_id: target }),
      ),
    meta: { silent: true },
    onSuccess: ({ ok, failed }) => {
      void queryClient.invalidateQueries({ queryKey: keys.devices })
      void queryClient.invalidateQueries({ queryKey: ['sites'] })
      void queryClient.invalidateQueries({ queryKey: keys.clients })
      const name = sites.find((site) => site.id === siteId)?.name ?? 'the new site'
      if (failed) toast.warning(`Moved ${ok} devices; ${failed} could not be moved.`)
      else toast.success(`Moved ${ok} ${ok === 1 ? 'device' : 'devices'} to ${name}`)
      onDone()
    },
  })

  return (
    <>
      <Field>
        <FieldLabel htmlFor="move-site">Destination site</FieldLabel>
        <SimpleSelect
          id="move-site"
          value={siteId}
          onValueChange={setSiteId}
          placeholder="Choose a site…"
          options={sites.map((site) => ({ value: site.id, label: site.name }))}
        />
      </Field>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={!siteId || mutation.isPending} onClick={() => siteId && mutation.mutate(siteId)}>
          {mutation.isPending && <Spinner data-icon="inline-start" />}
          Move devices
        </Button>
      </DialogFooter>
    </>
  )
}
