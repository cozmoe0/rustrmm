import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { NotebookPen, Tag } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { TokenInput } from '@/components/common/token-input'
import { devicesApi } from '@/lib/api/endpoints'
import { keys } from '@/lib/api/queries'
import type { DeviceDetail, DevicePatch } from '@/lib/api/types'
import { normalizeTags } from '@/lib/devices'
import { PERMISSIONS, usePermission } from '@/lib/permissions'
import { TagList } from './device-ui'

const MAX_NOTES = 20_000

export function NotesTab({ device }: { device: DeviceDetail }) {
  const queryClient = useQueryClient()
  const canManage = usePermission(PERMISSIONS.devicesManage)
  const [notes, setNotes] = useState(device.notes)
  const [tags, setTags] = useState(device.tags)

  // Pick up changes saved elsewhere (another tab, the edit dialog): adjust state during render.
  const [synced, setSynced] = useState({ notes: device.notes, tags: device.tags })
  if (synced.notes !== device.notes || synced.tags !== device.tags) {
    setSynced({ notes: device.notes, tags: device.tags })
    if (synced.notes !== device.notes) setNotes(device.notes)
    if (synced.tags !== device.tags) setTags(device.tags)
  }

  const mutation = useMutation({
    mutationFn: (patch: DevicePatch) => devicesApi.update(device.id, patch),
    onSuccess: (updated) => {
      queryClient.setQueryData(keys.device(device.id), updated)
      void queryClient.invalidateQueries({ queryKey: [...keys.devices, 'list'] })
    },
    meta: { successMessage: 'Saved' },
  })

  const notesDirty = notes !== device.notes
  const tagsDirty = JSON.stringify(normalizeTags(tags)) !== JSON.stringify(device.tags)

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <Card size="sm" className="gap-3">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm [&_svg]:size-4 [&_svg]:text-subtle-foreground">
            <NotebookPen />
            Notes
          </CardTitle>
          <CardDescription>Context for the next technician: quirks, contacts, warranty, what not to touch.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {canManage ? (
            <>
              <Textarea
                aria-label="Device notes"
                value={notes}
                maxLength={MAX_NOTES}
                onChange={(event) => setNotes(event.target.value)}
                rows={14}
                placeholder="e.g. Reception PC — label printer on USB hub. Don't reboot before 6pm."
                className="min-h-64 font-mono text-[12.5px] leading-relaxed"
              />
              <div className="flex items-center justify-between gap-3">
                <span className="tabular text-micro text-subtle-foreground">
                  {notes.length.toLocaleString()} / {MAX_NOTES.toLocaleString()}
                </span>
                <div className="flex gap-2">
                  {notesDirty && (
                    <Button variant="ghost" size="sm" onClick={() => setNotes(device.notes)}>
                      Discard
                    </Button>
                  )}
                  <Button size="sm" disabled={!notesDirty || mutation.isPending} onClick={() => mutation.mutate({ notes })}>
                    {mutation.isPending && mutation.variables?.notes !== undefined && <Spinner data-icon="inline-start" />}
                    Save notes
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <p className="text-dense whitespace-pre-wrap text-muted-foreground">{device.notes || 'No notes yet.'}</p>
          )}
        </CardContent>
      </Card>

      <Card size="sm" className="content-start gap-3">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm [&_svg]:size-4 [&_svg]:text-subtle-foreground">
            <Tag />
            Tags
          </CardTitle>
          <CardDescription>Group devices for filters and saved views.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {canManage ? (
            <>
              <TokenInput
                ariaLabel="Device tags"
                value={tags}
                onChange={setTags}
                normalize={(tag) => tag.trim().toLowerCase().slice(0, 40)}
                validate={(tag) => (/^[a-z0-9][a-z0-9 ._:/-]*$/.test(tag) ? null : 'Tags use letters, numbers, spaces and . _ : / -')}
                max={30}
                mono
                placeholder="Add a tag…"
              />
              <Button
                size="sm"
                variant="outline"
                className="justify-self-end"
                disabled={!tagsDirty || mutation.isPending}
                onClick={() => mutation.mutate({ tags: normalizeTags(tags) })}
              >
                Save tags
              </Button>
            </>
          ) : (
            <TagList tags={device.tags} max={30} className="flex-wrap" />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
