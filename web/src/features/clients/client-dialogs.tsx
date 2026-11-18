import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { TimezonePicker } from '@/components/common/timezone-picker'
import { browserTimezone } from '@/lib/timezone'
import { clientsApi, sitesApi } from '@/lib/api/endpoints'
import { keys } from '@/lib/api/queries'
import type { Client, Site } from '@/lib/api/types'

const clientSchema = z.object({
  name: z.string().trim().min(2, 'Use at least 2 characters').max(80, 'Keep it under 80 characters'),
  notes: z.string().max(2000).optional(),
})

export function CreateClientDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (client: Client) => void
}) {
  const queryClient = useQueryClient()
  const form = useForm<z.infer<typeof clientSchema>>({
    resolver: zodResolver(clientSchema),
    defaultValues: { name: '', notes: '' },
  })

  useEffect(() => {
    if (open) form.reset({ name: '', notes: '' })
  }, [open, form])

  const mutation = useMutation({
    mutationFn: clientsApi.create,
    meta: { successMessage: 'Client created' },
    onSuccess: (client) => {
      void queryClient.invalidateQueries({ queryKey: keys.clients })
      onOpenChange(false)
      onCreated?.(client)
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New client</DialogTitle>
          <DialogDescription>A company you manage. You can add sites and branding next.</DialogDescription>
        </DialogHeader>
        <form
          id="create-client"
          noValidate
          onSubmit={form.handleSubmit((values) => mutation.mutate({ name: values.name, notes: values.notes || undefined }))}
        >
          <FieldGroup className="gap-4">
            <Field data-invalid={Boolean(form.formState.errors.name) || undefined}>
              <FieldLabel htmlFor="client-name">Name</FieldLabel>
              <Input id="client-name" autoFocus placeholder="Northwind Dental" {...form.register('name')} />
              <FieldError errors={[form.formState.errors.name]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="client-notes">Notes</FieldLabel>
              <Textarea id="client-notes" rows={3} placeholder="Contacts, contract details, escalation rules…" {...form.register('notes')} />
              <FieldDescription>Visible to everyone who can see this client.</FieldDescription>
            </Field>
          </FieldGroup>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="create-client" disabled={mutation.isPending}>
            {mutation.isPending && <Spinner data-icon="inline-start" />}
            Create client
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const siteSchema = z.object({
  name: z.string().trim().min(2, 'Use at least 2 characters').max(80),
  timezone: z.string().min(1),
  address: z.string().max(200).optional(),
  notes: z.string().max(2000).optional(),
})

type SiteValues = z.infer<typeof siteSchema>

export function SiteDialog({
  open,
  onOpenChange,
  clientId,
  site,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  clientId: string
  site?: Site | null
}) {
  const queryClient = useQueryClient()
  const editing = Boolean(site)
  const form = useForm<SiteValues>({
    resolver: zodResolver(siteSchema),
    defaultValues: { name: '', timezone: browserTimezone(), address: '', notes: '' },
  })

  useEffect(() => {
    if (open) {
      form.reset({
        name: site?.name ?? '',
        timezone: site?.timezone ?? browserTimezone(),
        address: site?.address ?? '',
        notes: site?.notes ?? '',
      })
    }
  }, [open, site, form])

  const mutation = useMutation({
    mutationFn: (values: SiteValues) =>
      site ? sitesApi.update(site.id, values) : sitesApi.create(clientId, values),
    meta: { successMessage: editing ? 'Site updated' : 'Site created' },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.client(clientId) })
      void queryClient.invalidateQueries({ queryKey: keys.clients })
      void queryClient.invalidateQueries({ queryKey: ['sites'] })
      onOpenChange(false)
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${site?.name}` : 'New site'}</DialogTitle>
          <DialogDescription>Sites are physical or logical locations. Devices and policies attach to them.</DialogDescription>
        </DialogHeader>
        <form id="site-form" noValidate onSubmit={form.handleSubmit((values) => mutation.mutate(values))}>
          <FieldGroup className="gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={Boolean(form.formState.errors.name) || undefined}>
                <FieldLabel htmlFor="site-name">Name</FieldLabel>
                <Input id="site-name" autoFocus placeholder="Main office" {...form.register('name')} />
                <FieldError errors={[form.formState.errors.name]} />
              </Field>
              <Field>
                <FieldLabel htmlFor="site-timezone">Time zone</FieldLabel>
                <TimezonePicker
                  id="site-timezone"
                  value={form.watch('timezone')}
                  onChange={(zone) => form.setValue('timezone', zone, { shouldDirty: true })}
                />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="site-address">Address</FieldLabel>
              <Input id="site-address" placeholder="Street, city" {...form.register('address')} />
            </Field>
            <Field>
              <FieldLabel htmlFor="site-notes">Notes</FieldLabel>
              <Textarea id="site-notes" rows={3} {...form.register('notes')} />
            </Field>
          </FieldGroup>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="site-form" disabled={mutation.isPending}>
            {mutation.isPending && <Spinner data-icon="inline-start" />}
            {editing ? 'Save changes' : 'Create site'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
