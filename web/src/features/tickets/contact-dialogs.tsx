/* Contact editor and the CSV import with a per-row preview. */
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleCheck, CircleX, Download, FileSpreadsheet, RefreshCw, TriangleExclamationPoint, Upload } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { SimpleSelect } from '@/components/common/simple-select'
import { saveBlob } from '@/lib/api/client'
import { contactsApi } from '@/lib/api/endpoints'
import { errorMessage, isApiError } from '@/lib/api/errors'
import { clientsQuery, contactsQuery, sitesQuery, ticketKeys } from '@/lib/api/queries'
import type { Contact, ContactImportResult, ContactInput } from '@/lib/api/types'
import { formatNumber } from '@/lib/format'
import { CONTACT_CSV_TEMPLATE, isEmail, MAX_IMPORT_BYTES, previewContactsCsv, type ContactCsvPreview } from '@/lib/tickets/csv'
import { cn } from '@/lib/utils'

export function ContactDialog({
  open,
  onOpenChange,
  contact,
  defaultClientId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  contact: Contact | null
  defaultClientId?: string
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{contact ? `Edit ${contact.name}` : 'New contact'}</DialogTitle>
          <DialogDescription>Contacts receive ticket emails when notifications are on. An address is unique per client.</DialogDescription>
        </DialogHeader>
        {open && <ContactForm key={contact?.id ?? 'new'} contact={contact} defaultClientId={defaultClientId} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function ContactForm({ contact, defaultClientId, onDone }: { contact: Contact | null; defaultClientId?: string; onDone: () => void }) {
  const queryClient = useQueryClient()
  const { data: clients = [] } = useQuery(clientsQuery())
  const [draft, setDraft] = useState<ContactInput>(
    contact
      ? { client_id: contact.client_id, site_id: contact.site_id, name: contact.name, email: contact.email, phone: contact.phone, title: contact.title, is_primary: contact.is_primary, notify: contact.notify, notes: contact.notes }
      : { client_id: defaultClientId ?? '', site_id: null, name: '', email: '', phone: '', title: '', is_primary: false, notify: true, notes: '' },
  )
  const [attempted, setAttempted] = useState(false)
  const { data: sites = [] } = useQuery({ ...sitesQuery(draft.client_id || undefined), enabled: Boolean(draft.client_id) })
  const set = <K extends keyof ContactInput>(key: K, value: ContactInput[K]) => setDraft((prev) => ({ ...prev, [key]: value }))
  const errors = {
    client: draft.client_id ? null : 'Choose a client',
    name: draft.name.trim() ? null : 'Enter a name',
    email: draft.email.trim() && !isEmail(draft.email) ? 'Enter a valid email address' : null,
  }
  const save = useMutation({
    mutationFn: () => {
      const body = { ...draft, name: draft.name.trim(), email: draft.email.trim() }
      return contact ? contactsApi.update(contact.id, body) : contactsApi.create(body)
    },
    meta: { silent: true },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ticketKeys.contacts })
      queryClient.setQueryData(ticketKeys.contact(saved.id), saved)
      onDone()
    },
  })
  const duplicate = save.error && isApiError(save.error) && save.error.code === 'contact_exists'
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        setAttempted(true)
        if (errors.client || errors.name || errors.email) return
        save.mutate()
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field data-invalid={Boolean(attempted && errors.client) || undefined}>
          <FieldLabel htmlFor="ct-client">Client</FieldLabel>
          <SimpleSelect
            id="ct-client"
            value={draft.client_id || null}
            disabled={Boolean(contact)}
            placeholder="Choose a client"
            onValueChange={(value) => setDraft((prev) => ({ ...prev, client_id: value, site_id: null }))}
            options={clients.map((client) => ({ value: client.id, label: client.name }))}
          />
          {contact ? <FieldDescription>A contact stays with its client.</FieldDescription> : <FieldError>{attempted ? errors.client : null}</FieldError>}
        </Field>
        <Field>
          <FieldLabel htmlFor="ct-site">Site</FieldLabel>
          <SimpleSelect
            id="ct-site"
            value={draft.site_id ?? ''}
            disabled={!draft.client_id}
            onValueChange={(value) => set('site_id', value || null)}
            options={[{ value: '', label: 'No specific site' }, ...sites.map((site) => ({ value: site.id, label: site.name }))]}
          />
        </Field>
        <Field data-invalid={Boolean(attempted && errors.name) || undefined}>
          <FieldLabel htmlFor="ct-name">Name</FieldLabel>
          <Input id="ct-name" autoFocus value={draft.name} maxLength={200} onChange={(event) => set('name', event.target.value)} />
          <FieldError>{attempted ? errors.name : null}</FieldError>
        </Field>
        <Field data-invalid={Boolean((attempted && errors.email) || duplicate) || undefined}>
          <FieldLabel htmlFor="ct-email">Email</FieldLabel>
          <Input id="ct-email" type="email" value={draft.email} onChange={(event) => set('email', event.target.value)} />
          <FieldError>{duplicate ? 'Another contact of this client uses this address.' : attempted ? errors.email : null}</FieldError>
        </Field>
        <Field>
          <FieldLabel htmlFor="ct-phone">Phone</FieldLabel>
          <Input id="ct-phone" type="tel" value={draft.phone} onChange={(event) => set('phone', event.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="ct-title">Title</FieldLabel>
          <Input id="ct-title" value={draft.title} onChange={(event) => set('title', event.target.value)} placeholder="Office manager" />
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="ct-notes">Notes</FieldLabel>
        <Textarea id="ct-notes" rows={2} value={draft.notes} onChange={(event) => set('notes', event.target.value)} className="min-h-14" />
      </Field>
      <div className="grid gap-2 rounded-lg bg-surface-2 p-3 ring-1 ring-border">
        <label className="flex items-center justify-between gap-3 text-dense">
          <span>
            <span className="font-medium">Primary contact</span>
            <span className="block text-micro text-muted-foreground">Replaces the client’s current primary contact.</span>
          </span>
          <Switch checked={draft.is_primary} onCheckedChange={(value) => set('is_primary', value)} />
        </label>
        <label className="flex items-center justify-between gap-3 text-dense">
          <span>
            <span className="font-medium">Email notifications</span>
            <span className="block text-micro text-muted-foreground">Receives “we got your request”, replies and resolution emails.</span>
          </span>
          <Switch checked={draft.notify} onCheckedChange={(value) => set('notify', value)} />
        </label>
      </div>
      {save.error && !duplicate && <p className="text-dense text-critical">{errorMessage(save.error)}</p>}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending && <Spinner data-icon="inline-start" />}
          {contact ? 'Save contact' : 'Create contact'}
        </Button>
      </DialogFooter>
    </form>
  )
}

// ------------------------------------------------------------------ import

const ACTION_STYLE = {
  create: { label: 'New', variant: 'live' as const },
  update: { label: 'Update', variant: 'info' as const },
  invalid: { label: 'Error', variant: 'critical' as const },
}

export function ContactImportDialog({ open, onOpenChange, defaultClientId }: { open: boolean; onOpenChange: (open: boolean) => void; defaultClientId?: string }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[820px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="size-4 text-primary" />
            Import contacts from CSV
          </DialogTitle>
          <DialogDescription>
            Header row <code className="font-mono text-[11.5px]">name,email,phone,title,site</code> in any order. Rows update the contact with the same email, otherwise create one.
          </DialogDescription>
        </DialogHeader>
        {open && <ImportBody defaultClientId={defaultClientId} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function ImportBody({ defaultClientId, onDone }: { defaultClientId?: string; onDone: () => void }) {
  const queryClient = useQueryClient()
  const { data: clients = [] } = useQuery(clientsQuery())
  const [clientId, setClientId] = useState(defaultClientId ?? '')
  const [file, setFile] = useState<File | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [result, setResult] = useState<ContactImportResult | null>(null)
  const { data: sites = [] } = useQuery({ ...sitesQuery(clientId || undefined), enabled: Boolean(clientId) })
  const { data: existing = [] } = useQuery({ ...contactsQuery(clientId || undefined), enabled: Boolean(clientId) })
  const preview: ContactCsvPreview | null = useMemo(
    () => (text !== null && clientId ? previewContactsCsv(text, { sites, existingEmails: existing.map((contact) => contact.email).filter(Boolean) }) : null),
    [text, clientId, sites, existing],
  )
  const accept = async (next: File | undefined) => {
    setResult(null)
    if (!next) return
    if (!/\.csv$/i.test(next.name) && next.type !== 'text/csv') {
      setFileError('Choose a .csv file')
      return
    }
    if (next.size > MAX_IMPORT_BYTES) {
      setFileError('The file is larger than 5 MB')
      return
    }
    setFileError(null)
    setFile(next)
    setText(await next.text())
  }
  const run = useMutation({
    mutationFn: () => contactsApi.import(clientId, file!),
    meta: { silent: true },
    onSuccess: (outcome) => {
      setResult(outcome)
      void queryClient.invalidateQueries({ queryKey: ticketKeys.contacts })
    },
  })
  const importable = preview ? preview.creates + preview.updates : 0

  if (result) {
    return (
      <div className="grid gap-4">
        <div className="grid grid-cols-3 gap-2">
          {[
            ['Created', result.created, 'text-live'],
            ['Updated', result.updated, 'text-info'],
            ['Errors', result.errors.length, result.errors.length ? 'text-critical' : 'text-subtle-foreground'],
          ].map(([label, value, tone]) => (
            <div key={label as string} className="rounded-xl bg-card p-3 shadow-card">
              <div className={cn('tabular font-display text-2xl font-semibold', tone as string)}>{formatNumber(value as number)}</div>
              <div className="text-micro text-muted-foreground">{label}</div>
            </div>
          ))}
        </div>
        {result.errors.length > 0 && (
          <ul className="max-h-56 overflow-y-auto rounded-lg ring-1 ring-border">
            {result.errors.map((error) => (
              <li key={error.row} className="flex gap-3 border-b border-border px-3 py-1.5 text-dense last:border-0">
                <span className="tabular w-14 shrink-0 text-muted-foreground">Row {error.row}</span>
                <span className="text-critical">{error.message}</span>
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              setResult(null)
              setFile(null)
              setText(null)
            }}
          >
            <RefreshCw data-icon="inline-start" />
            Import another file
          </Button>
          <Button onClick={onDone}>Done</Button>
        </DialogFooter>
      </div>
    )
  }

  return (
    <div className="grid min-w-0 gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <Field>
          <FieldLabel htmlFor="import-client">Client</FieldLabel>
          <SimpleSelect id="import-client" value={clientId || null} placeholder="Choose the client to import into" onValueChange={setClientId} options={clients.map((client) => ({ value: client.id, label: client.name }))} />
        </Field>
        <Button variant="outline" size="sm" onClick={() => saveBlob(new Blob([CONTACT_CSV_TEMPLATE], { type: 'text/csv' }), 'contacts-template.csv')}>
          <Download data-icon="inline-start" />
          Template
        </Button>
      </div>
      <label
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          void accept(event.dataTransfer.files[0])
        }}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors',
          dragging ? 'border-primary/60 bg-primary/[0.05]' : 'border-border-strong hover:bg-surface-2',
        )}
      >
        <Upload className="size-5 text-subtle-foreground" />
        <span className="text-dense font-medium">{file ? file.name : 'Drop a CSV here or click to choose'}</span>
        <span className="text-micro text-muted-foreground">UTF-8, up to 5 MB and 10,000 rows</span>
        <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(event) => void accept(event.target.files?.[0])} />
      </label>
      {fileError && <p className="text-dense text-critical">{fileError}</p>}
      {preview && (
        <div className="grid min-w-0 gap-2">
          {preview.fileError ? (
            <p className="flex items-start gap-2 rounded-lg bg-critical/[0.06] px-3 py-2 text-dense text-critical ring-1 ring-critical/25">
              <TriangleExclamationPoint className="mt-0.5 size-4 shrink-0" />
              {preview.fileError}
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 text-dense">
                <Badge variant="live">{preview.creates} new</Badge>
                <Badge variant="info">{preview.updates} updates</Badge>
                {preview.invalid > 0 && <Badge variant="critical">{preview.invalid} with errors (skipped)</Badge>}
                {preview.ignoredColumns.length > 0 && <span className="text-micro text-muted-foreground">Ignored columns: {preview.ignoredColumns.join(', ')}</span>}
              </div>
              <div className="max-h-72 min-w-0 overflow-auto rounded-lg ring-1 ring-border">
                <table className="w-full min-w-[560px] text-dense">
                  <thead className="sticky top-0 bg-surface-2 text-left text-micro text-muted-foreground">
                    <tr>
                      <th className="px-3 py-1.5 font-medium">Row</th>
                      <th className="px-3 py-1.5 font-medium">Result</th>
                      <th className="px-3 py-1.5 font-medium">Name</th>
                      <th className="px-3 py-1.5 font-medium">Email</th>
                      <th className="px-3 py-1.5 font-medium">Site</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row) => (
                      <tr key={row.row} className={cn('border-t border-border align-top', row.action === 'invalid' && 'bg-critical/[0.035]')}>
                        <td className="tabular px-3 py-1.5 text-muted-foreground">{row.row}</td>
                        <td className="px-3 py-1.5">
                          <Badge variant={ACTION_STYLE[row.action].variant}>
                            {row.action === 'invalid' ? <CircleX /> : <CircleCheck />}
                            {ACTION_STYLE[row.action].label}
                          </Badge>
                        </td>
                        <td className="px-3 py-1.5">
                          {row.name || <span className="text-subtle-foreground">—</span>}
                          {row.errors.map((error) => (
                            <span key={error} className="block text-micro text-critical">
                              {error}
                            </span>
                          ))}
                        </td>
                        <td className="px-3 py-1.5">{row.email || <span className="text-subtle-foreground">—</span>}</td>
                        <td className="px-3 py-1.5 text-muted-foreground">{row.site || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
      {run.error && <p className="text-dense text-critical">{errorMessage(run.error)}</p>}
      <DialogFooter>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button disabled={!file || !clientId || !preview || Boolean(preview.fileError) || importable === 0 || run.isPending} onClick={() => run.mutate()}>
          {run.isPending ? <Spinner data-icon="inline-start" /> : <Upload data-icon="inline-start" />}
          Import {importable ? formatNumber(importable) : ''} {importable === 1 ? 'contact' : 'contacts'}
        </Button>
      </DialogFooter>
    </div>
  )
}
