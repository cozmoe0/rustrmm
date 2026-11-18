/* Ticket email: outbound notifications, inbound IMAP (write-only password, step-up on save, connection test) and the signature. */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleAlert, CircleCheck, Inbox, Lock, Mail, PlugZap, Save, Send, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { ErrorState, RelativeTime } from '@/components/common/misc'
import { SimpleSelect } from '@/components/common/simple-select'
import { SecretInput } from '@/features/notifications/notification-ui'
import { ticketEmailApi } from '@/lib/api/endpoints'
import { errorMessage, isApiError } from '@/lib/api/errors'
import { ticketEmailQuery, ticketKeys } from '@/lib/api/queries'
import type { ImapSecurity, ImapTestResult, TicketEmailSettings, TicketEmailSettingsInput } from '@/lib/api/types'
import { isMasked, type SecretDraft } from '@/lib/notifications/channels'
import { isEmail } from '@/lib/tickets/csv'
import { renderPlaceholders, SAMPLE_CONTEXT } from '@/lib/tickets/placeholders'
import { cn } from '@/lib/utils'
import { MarkdownEditor } from '../markdown'

const SECURITY_LABEL: Record<ImapSecurity, string> = {
  tls: 'TLS (IMAPS, port 993)',
  starttls: 'STARTTLS (port 143)',
  none: 'None (mail server on this host only)',
}
const DEFAULT_PORT: Record<ImapSecurity, number> = { tls: 993, starttls: 143, none: 143 }
const LOOPBACK = ['localhost', '127.0.0.1', '::1']

const OUTBOUND_TOGGLES: { key: keyof Omit<TicketEmailSettings['outbound'], 'enabled' | 'reply_address'>; label: string; hint: string }[] = [
  { key: 'notify_contact_on_create', label: 'Ticket created', hint: '“We received your request” with the ticket number, to the contact.' },
  { key: 'notify_on_public_comment', label: 'Public reply added', hint: 'Each public reply, to the contact and CCs.' },
  { key: 'notify_on_resolve', label: 'Ticket resolved', hint: 'Tells the contact that replying reopens the ticket.' },
  { key: 'notify_technician_on_assign', label: 'Assignment', hint: 'Tells a technician a ticket was assigned to them.' },
]

function EmailForm({ settings }: { settings: TicketEmailSettings }) {
  const queryClient = useQueryClient()
  const initialSecret = (): SecretDraft => (isMasked(settings.inbound.password) ? { stored: true, mode: 'keep', value: '' } : { stored: false, mode: 'replace', value: '' })
  const [outbound, setOutbound] = useState(settings.outbound)
  const [inbound, setInbound] = useState(() => ({ ...settings.inbound, port: String(settings.inbound.port) }))
  const [password, setPassword] = useState<SecretDraft>(initialSecret)
  const [signature, setSignature] = useState(settings.signature)
  const [attempted, setAttempted] = useState(false)
  const [test, setTest] = useState<ImapTestResult | null>(null)
  const port = inbound.port.trim() === '' ? DEFAULT_PORT[inbound.security] : Number(inbound.port)
  const passwordValue = password.mode === 'remove' ? null : password.mode === 'replace' && password.value ? password.value : undefined
  const remote = inbound.host.trim() !== '' && !LOOPBACK.includes(inbound.host.trim())
  const errors = {
    reply: outbound.reply_address && (!isEmail(outbound.reply_address) || outbound.reply_address.split('@')[0].includes('+')) ? 'Use a plain address without “+” (the server adds the reply tag)' : null,
    host: inbound.enabled && !inbound.host.trim() ? 'Polling needs a host' : null,
    username: inbound.enabled && !inbound.username.trim() ? 'Polling needs a username' : null,
    port: Number.isInteger(port) && port >= 1 && port <= 65_535 ? null : 'Enter a port from 1 to 65535',
    security: inbound.security === 'none' && remote ? 'Unencrypted IMAP is only allowed for a mail server on this host' : null,
    folder: /^[\x20-\x7e]+$/.test(inbound.folder) && !inbound.folder.includes('"') ? null : 'Folder names are ASCII without quotes',
    processed: /^[\x20-\x7e]+$/.test(inbound.processed_folder) && !inbound.processed_folder.includes('"') ? null : 'Folder names are ASCII without quotes',
  }
  const invalid = Object.values(errors).some(Boolean)
  const inboundBody: TicketEmailSettingsInput['inbound'] = {
    enabled: inbound.enabled,
    host: inbound.host.trim(),
    port,
    security: inbound.security,
    username: inbound.username.trim(),
    folder: inbound.folder.trim() || 'INBOX',
    processed_folder: inbound.processed_folder.trim() || 'Processed',
    unknown_sender: inbound.unknown_sender,
    ...(passwordValue !== undefined ? { password: passwordValue } : {}),
  }
  const body: TicketEmailSettingsInput = { outbound: { ...outbound, reply_address: outbound.reply_address.trim() }, inbound: inboundBody, signature }
  const dirty =
    JSON.stringify(outbound) !== JSON.stringify(settings.outbound) ||
    JSON.stringify({ ...inbound, port }) !== JSON.stringify({ ...settings.inbound, port: settings.inbound.port }) ||
    passwordValue !== undefined ||
    signature !== settings.signature

  const reset = () => {
    setOutbound(settings.outbound)
    setInbound({ ...settings.inbound, port: String(settings.inbound.port) })
    setPassword(initialSecret())
    setSignature(settings.signature)
    setAttempted(false)
  }
  const save = useMutation({
    mutationFn: () => ticketEmailApi.update(body),
    meta: { successMessage: 'Email settings saved' },
    onSuccess: (updated) => {
      queryClient.setQueryData(ticketKeys.email, updated)
      setPassword(isMasked(updated.inbound.password) ? { stored: true, mode: 'keep', value: '' } : { stored: false, mode: 'replace', value: '' })
    },
  })
  const runTest = useMutation({
    mutationFn: () => ticketEmailApi.testImap(inboundBody),
    meta: { silent: true },
    onSuccess: setTest,
    onError: (error) => setTest({ ok: false, error: isApiError(error) && error.code === 'imap_not_configured' ? 'Enter the IMAP host and username first.' : errorMessage(error) }),
  })
  const serverError = save.error && isApiError(save.error) && save.error.status === 422 ? save.error.message : null
  const status = settings.inbound_status

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        setAttempted(true)
        if (!invalid) save.mutate()
      }}
    >
      {serverError && (
        <p role="alert" className="flex items-start gap-2 rounded-lg bg-critical/[0.06] px-3 py-2 text-dense text-critical ring-1 ring-critical/25">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          {serverError}
        </p>
      )}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Send className="size-4 text-primary" />
              Outbound notifications
            </CardTitle>
            <CardDescription>Sent through the SMTP server from Settings › Notifications. Subjects carry [#1042] and replies thread back to the ticket.</CardDescription>
          </div>
          <Switch checked={outbound.enabled} onCheckedChange={(enabled) => setOutbound({ ...outbound, enabled })} aria-label="Send ticket email" />
        </CardHeader>
        <CardContent className={cn('grid gap-4', !outbound.enabled && 'pointer-events-none opacity-50')}>
          <ul className="grid gap-2 sm:grid-cols-2">
            {OUTBOUND_TOGGLES.map((toggle) => (
              <li key={toggle.key}>
                <label className="flex h-full items-start justify-between gap-3 rounded-lg bg-surface-2 p-3 ring-1 ring-border">
                  <span>
                    <span className="block text-dense font-medium">{toggle.label}</span>
                    <span className="block text-micro text-muted-foreground">{toggle.hint}</span>
                  </span>
                  <Switch checked={outbound[toggle.key]} onCheckedChange={(value) => setOutbound({ ...outbound, [toggle.key]: value })} aria-label={toggle.label} />
                </label>
              </li>
            ))}
          </ul>
          <Field data-invalid={Boolean(attempted && errors.reply) || undefined}>
            <FieldLabel htmlFor="mail-reply">Reply-to address</FieldLabel>
            <Input id="mail-reply" type="email" value={outbound.reply_address} placeholder="support@yourmsp.com" onChange={(event) => setOutbound({ ...outbound, reply_address: event.target.value })} />
            <FieldDescription>Replies go to support+t1042.&lt;tag&gt;@… so they thread to the right ticket. Empty uses the SMTP sender.</FieldDescription>
            <FieldError>{attempted ? errors.reply : null}</FieldError>
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Inbox className="size-4 text-primary" />
              Email to ticket (IMAP)
            </CardTitle>
            <CardDescription>Polls every 60 seconds. Replies become public comments; new mail from known contacts opens tickets.</CardDescription>
          </div>
          <Switch checked={inbound.enabled} onCheckedChange={(enabled) => setInbound({ ...inbound, enabled })} aria-label="Poll the mailbox" />
        </CardHeader>
        <CardContent className="grid gap-4">
          {status && (status.last_poll_at || status.last_error) && (
            <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-3 py-2 text-micro ring-1', status.last_error ? 'bg-critical/[0.05] text-critical ring-critical/25' : 'bg-surface-2 text-muted-foreground ring-border')}>
              {status.last_error ? <CircleAlert className="size-3.5" /> : <CircleCheck className="size-3.5 text-live" />}
              <span>
                Last poll <RelativeTime value={status.last_poll_at} />
              </span>
              {status.last_processed !== null && <span>· {status.last_processed} messages handled</span>}
              {status.last_error && <span className="basis-full">{status.last_error}</span>}
            </div>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
            <Field data-invalid={Boolean(attempted && errors.host) || undefined}>
              <FieldLabel htmlFor="imap-host">Host</FieldLabel>
              <Input id="imap-host" value={inbound.host} placeholder="imap.example.com" spellCheck={false} onChange={(event) => setInbound({ ...inbound, host: event.target.value })} />
              <FieldError>{attempted ? errors.host : null}</FieldError>
            </Field>
            <Field data-invalid={Boolean(attempted && errors.port) || undefined}>
              <FieldLabel htmlFor="imap-port">Port</FieldLabel>
              <Input id="imap-port" type="number" min={1} max={65_535} className="tabular" value={inbound.port} placeholder={String(DEFAULT_PORT[inbound.security])} onChange={(event) => setInbound({ ...inbound, port: event.target.value })} />
              <FieldError>{attempted ? errors.port : null}</FieldError>
            </Field>
          </div>
          <Field data-invalid={Boolean(errors.security) || undefined}>
            <FieldLabel htmlFor="imap-security">Security</FieldLabel>
            <SimpleSelect
              id="imap-security"
              value={inbound.security}
              onValueChange={(value) => {
                const next = value as ImapSecurity
                const current = Number(inbound.port)
                setInbound({ ...inbound, security: next, port: inbound.port.trim() === '' || current === DEFAULT_PORT[inbound.security] ? String(DEFAULT_PORT[next]) : inbound.port })
              }}
              options={(['tls', 'starttls', 'none'] as const).map((value) => ({ value, label: SECURITY_LABEL[value] }))}
            />
            <FieldError>{errors.security}</FieldError>
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field data-invalid={Boolean(attempted && errors.username) || undefined}>
              <FieldLabel htmlFor="imap-user">Username</FieldLabel>
              <Input id="imap-user" value={inbound.username} autoComplete="off" spellCheck={false} onChange={(event) => setInbound({ ...inbound, username: event.target.value })} />
              <FieldError>{attempted ? errors.username : null}</FieldError>
            </Field>
            <Field>
              <FieldLabel htmlFor="imap-password">Password</FieldLabel>
              <SecretInput id="imap-password" secret={password} optional onChange={setPassword} />
              {password.stored && password.mode === 'keep' && <FieldDescription>Stored encrypted and never shown. Kept unless you replace or remove it.</FieldDescription>}
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field data-invalid={Boolean(errors.folder) || undefined}>
              <FieldLabel htmlFor="imap-folder">Folder to read</FieldLabel>
              <Input id="imap-folder" value={inbound.folder} onChange={(event) => setInbound({ ...inbound, folder: event.target.value })} />
              <FieldError>{errors.folder}</FieldError>
            </Field>
            <Field data-invalid={Boolean(errors.processed) || undefined}>
              <FieldLabel htmlFor="imap-processed">Move handled mail to</FieldLabel>
              <Input id="imap-processed" value={inbound.processed_folder} onChange={(event) => setInbound({ ...inbound, processed_folder: event.target.value })} />
              <FieldError>{errors.processed}</FieldError>
            </Field>
          </div>
          <Field>
            <FieldLabel>Mail from unknown senders</FieldLabel>
            <div role="radiogroup" className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  ['holding_queue', 'Hold for review', 'Opens a ticket for the client “Unassigned e-mail”; move it to the right client.'],
                  ['drop', 'Drop it', 'Ignores mail from addresses that are not contacts.'],
                ] as const
              ).map(([value, label, hint]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={inbound.unknown_sender === value}
                  onClick={() => setInbound({ ...inbound, unknown_sender: value })}
                  className={cn('rounded-lg p-3 text-left ring-1 outline-none focus-visible:ring-2 focus-visible:ring-ring', inbound.unknown_sender === value ? 'bg-primary/[0.06] ring-primary/40' : 'ring-border hover:bg-surface-2')}
                >
                  <span className="block text-dense font-medium">{label}</span>
                  <span className="block text-micro text-muted-foreground">{hint}</span>
                </button>
              ))}
            </div>
          </Field>
          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
            <Button type="button" variant="outline" size="sm" disabled={runTest.isPending || !inbound.host.trim() || !inbound.username.trim()} onClick={() => runTest.mutate()}>
              {runTest.isPending ? <Spinner data-icon="inline-start" /> : <PlugZap data-icon="inline-start" />}
              Test IMAP connection
            </Button>
            {test && (
              <span className={cn('inline-flex items-center gap-1.5 text-dense', test.ok ? 'text-live' : 'text-critical')}>
                {test.ok ? <CircleCheck className="size-4" /> : <CircleAlert className="size-4" />}
                {test.ok ? 'Signed in and opened the folder' : (test.error ?? 'The connection failed')}
              </span>
            )}
            <span className="text-micro text-muted-foreground sm:ml-auto">Tests use the values above, even unsaved ones.</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="size-4 text-primary" />
            Signature
          </CardTitle>
          <CardDescription>Added under every customer email. Supports the canned-response placeholders; the preview uses sample values.</CardDescription>
        </CardHeader>
        <CardContent>
          <MarkdownEditor value={signature} onChange={setSignature} previewTransform={(value) => renderPlaceholders(value, SAMPLE_CONTEXT)} ariaLabel="Signature" textareaClassName="min-h-28" />
        </CardContent>
      </Card>

      <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center justify-end gap-3 rounded-xl bg-background/90 px-1 py-3 backdrop-blur">
        <span className="mr-auto inline-flex items-center gap-1.5 text-micro text-muted-foreground">
          <Lock className="size-3.5" />
          Saving asks you to confirm it’s you.
        </span>
        {dirty && (
          <Button type="button" variant="ghost" onClick={reset} disabled={save.isPending}>
            <Undo2 data-icon="inline-start" />
            Discard
          </Button>
        )}
        <Button type="submit" disabled={!dirty || save.isPending}>
          {save.isPending ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}
          Save email settings
        </Button>
      </div>
    </form>
  )
}

export function EmailTab() {
  const { data, isLoading, error, refetch } = useQuery(ticketEmailQuery)
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />
  if (isLoading || !data) return <Skeleton className="h-96 rounded-xl" />
  return <EmailForm key={JSON.stringify(data)} settings={data} />
}
