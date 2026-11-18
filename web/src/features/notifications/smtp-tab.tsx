/* The SMTP server used by email channels, with a write-only password and a test send. */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleAlert, CircleCheck, Lock, Mail, Save, Send, TriangleAlert, Undo2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { ErrorState } from '@/components/common/misc'
import { SimpleSelect } from '@/components/common/simple-select'
import { notificationsApi } from '@/lib/api/endpoints'
import { errorMessage, isApiError } from '@/lib/api/errors'
import { keys, smtpSettingsQuery } from '@/lib/api/queries'
import type { SmtpSecurity, SmtpSettings, SmtpSettingsInput, SmtpTestResult } from '@/lib/api/types'
import { emailError, isMasked, type SecretDraft } from '@/lib/notifications/channels'
import { cn } from '@/lib/utils'
import { SecretInput } from './notification-ui'

const SECURITY_LABEL: Record<SmtpSecurity, string> = {
  starttls: 'STARTTLS (port 587)',
  tls: 'TLS from the start (port 465)',
  none: 'None (no encryption)',
}
const DEFAULT_PORT: Record<SmtpSecurity, number> = { starttls: 587, tls: 465, none: 25 }

function SmtpForm({ settings }: { settings: SmtpSettings }) {
  const queryClient = useQueryClient()
  const [host, setHost] = useState(settings.host)
  const [port, setPort] = useState(settings.host ? String(settings.port) : '')
  const [security, setSecurity] = useState<SmtpSecurity>(settings.security)
  const [username, setUsername] = useState(settings.username)
  const [password, setPassword] = useState<SecretDraft>(
    isMasked(settings.password) ? { stored: true, mode: 'keep', value: '' } : { stored: false, mode: 'replace', value: '' },
  )
  const [fromAddress, setFromAddress] = useState(settings.from_address)
  const [fromName, setFromName] = useState(settings.from_name)
  const [attempted, setAttempted] = useState(false)

  const portNumber = port.trim() === '' ? DEFAULT_PORT[security] : Number(port)
  const errors = {
    host: host.trim() ? null : 'Enter the SMTP host',
    port: Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65_535 ? null : 'Enter a port from 1 to 65535',
    from: emailError(fromAddress) ? 'Enter the sender address' : null,
  }
  const sendsPassword = password.mode === 'replace' ? Boolean(password.value) : password.mode === 'keep' && password.stored
  const insecure = security === 'none' && Boolean(username.trim()) && sendsPassword
  const passwordValue = password.mode === 'remove' ? null : password.mode === 'replace' && password.value ? password.value : undefined
  const body: SmtpSettingsInput = {
    host: host.trim(),
    port: portNumber,
    security,
    username: username.trim(),
    from_address: fromAddress.trim(),
    from_name: fromName.trim(),
    ...(passwordValue !== undefined ? { password: passwordValue } : {}),
  }
  const dirty =
    host.trim() !== settings.host ||
    portNumber !== settings.port ||
    security !== settings.security ||
    username.trim() !== settings.username ||
    fromAddress.trim() !== settings.from_address ||
    fromName.trim() !== settings.from_name ||
    passwordValue !== undefined

  const reset = () => {
    setHost(settings.host)
    setPort(settings.host ? String(settings.port) : '')
    setSecurity(settings.security)
    setUsername(settings.username)
    setPassword(isMasked(settings.password) ? { stored: true, mode: 'keep', value: '' } : { stored: false, mode: 'replace', value: '' })
    setFromAddress(settings.from_address)
    setFromName(settings.from_name)
    setAttempted(false)
  }

  const save = useMutation({
    mutationFn: () => notificationsApi.updateSmtp(body),
    meta: { successMessage: 'Email server saved' },
    onSuccess: (updated) => {
      queryClient.setQueryData(keys.smtpSettings, updated)
    },
  })
  const serverError = save.error && isApiError(save.error) && save.error.status === 422 ? save.error.message : null

  return (
    <Card>
      <CardHeader>
        <CardTitle>SMTP server</CardTitle>
        <CardDescription>Email channels send multipart HTML and text through this server.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid grid-cols-1 gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            setAttempted(true)
            if (errors.host || errors.port || errors.from || insecure) return
            save.mutate()
          }}
        >
          {serverError && (
            <p role="alert" className="flex items-start gap-2 rounded-lg bg-critical/[0.06] px-3 py-2 text-dense text-critical ring-1 ring-critical/25">
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              {serverError}
            </p>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
            <Field data-invalid={Boolean(attempted && errors.host) || undefined}>
              <FieldLabel htmlFor="smtp-host">Host</FieldLabel>
              <Input id="smtp-host" value={host} placeholder="smtp.example.com" spellCheck={false} onChange={(event) => setHost(event.target.value)} />
              <FieldError>{attempted ? errors.host : null}</FieldError>
            </Field>
            <Field data-invalid={Boolean(attempted && errors.port) || undefined}>
              <FieldLabel htmlFor="smtp-port">Port</FieldLabel>
              <Input
                id="smtp-port"
                type="number"
                min={1}
                max={65_535}
                className="tabular"
                value={port}
                placeholder={String(DEFAULT_PORT[security])}
                onChange={(event) => setPort(event.target.value)}
              />
              <FieldError>{attempted ? errors.port : null}</FieldError>
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="smtp-security">Security</FieldLabel>
            <SimpleSelect
              id="smtp-security"
              value={security}
              onValueChange={(value) => {
                const next = value as SmtpSecurity
                // Follow the protocol's usual port unless someone typed their own.
                if (port.trim() === '' || Number(port) === DEFAULT_PORT[security]) setPort(String(DEFAULT_PORT[next]))
                setSecurity(next)
              }}
              options={(['starttls', 'tls', 'none'] as const).map((value) => ({ value, label: SECURITY_LABEL[value] }))}
            />
            {security === 'none' && (
              <p className="flex items-start gap-2 text-micro text-warning">
                <TriangleAlert className="mt-px size-3.5 shrink-0" />
                Without TLS, RustRMM refuses to send a username and password. Use this only for an internal relay that needs no login.
              </p>
            )}
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="smtp-user">Username</FieldLabel>
              <Input id="smtp-user" value={username} autoComplete="off" spellCheck={false} onChange={(event) => setUsername(event.target.value)} />
            </Field>
            <Field data-invalid={insecure || undefined}>
              <FieldLabel htmlFor="smtp-password">Password</FieldLabel>
              <SecretInput id="smtp-password" secret={password} optional onChange={setPassword} invalid={insecure} />
              {insecure ? (
                <FieldError>Choose STARTTLS or TLS to send credentials.</FieldError>
              ) : password.stored && password.mode === 'keep' ? (
                <FieldDescription>Stored encrypted. Kept unless you replace or remove it.</FieldDescription>
              ) : null}
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field data-invalid={Boolean(attempted && errors.from) || undefined}>
              <FieldLabel htmlFor="smtp-from">From address</FieldLabel>
              <Input id="smtp-from" type="email" value={fromAddress} placeholder="alerts@example.com" onChange={(event) => setFromAddress(event.target.value)} />
              <FieldError>{attempted ? errors.from : null}</FieldError>
            </Field>
            <Field>
              <FieldLabel htmlFor="smtp-from-name">From name</FieldLabel>
              <Input id="smtp-from-name" value={fromName} placeholder="RustRMM" onChange={(event) => setFromName(event.target.value)} />
            </Field>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border pt-4">
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
              Save email server
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function TestEmail({ configured }: { configured: boolean }) {
  const [to, setTo] = useState('')
  const [result, setResult] = useState<(SmtpTestResult & { to: string }) | null>(null)
  const invalid = to.trim() !== '' && Boolean(emailError(to))
  const test = useMutation({
    mutationFn: () => notificationsApi.testSmtp(to.trim()),
    meta: { silent: true },
    onSuccess: (outcome) => {
      setResult({ ...outcome, to: to.trim() })
      if (outcome.ok) toast.success(`Test email sent to ${to.trim()}`)
      else toast.error(outcome.error ?? 'The test email failed')
    },
    onError: (failure) => {
      const message =
        isApiError(failure) && failure.code === 'smtp_not_configured'
          ? 'Save a host and a sender address first.'
          : errorMessage(failure)
      setResult({ ok: false, error: message, to: to.trim() })
      toast.error(message)
    },
  })
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="size-4 text-subtle-foreground" />
          Send a test email
        </CardTitle>
        <CardDescription>Uses the saved settings, not unsaved changes above.</CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-3">
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault()
            if (!to.trim() || invalid) return
            test.mutate()
          }}
        >
          <Input
            type="email"
            aria-label="Recipient"
            placeholder="you@example.com"
            value={to}
            aria-invalid={invalid || undefined}
            onChange={(event) => setTo(event.target.value)}
            className="sm:max-w-sm"
          />
          <Button type="submit" variant="outline" disabled={!to.trim() || invalid || test.isPending || !configured}>
            {test.isPending ? <Spinner data-icon="inline-start" /> : <Send data-icon="inline-start" />}
            Send test
          </Button>
        </form>
        {!configured && <p className="text-micro text-muted-foreground">Save a host and a sender address to send a test.</p>}
        {result && (
          <p
            role="status"
            className={cn(
              'flex items-start gap-2 rounded-lg px-3 py-2 text-dense ring-1',
              result.ok ? 'bg-success/[0.07] text-success ring-success/25' : 'bg-critical/[0.06] text-critical ring-critical/25',
            )}
          >
            {result.ok ? <CircleCheck className="mt-0.5 size-4 shrink-0" /> : <CircleAlert className="mt-0.5 size-4 shrink-0" />}
            <span className="min-w-0 break-words">
              {result.ok ? `Sent to ${result.to}. Check the inbox (and spam folder).` : (result.error ?? 'The test email failed')}
            </span>
          </p>
        )}
      </CardContent>
    </Card>
  )
}

export function SmtpTab() {
  const { data, isLoading, error, refetch } = useQuery(smtpSettingsQuery)
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />
  if (isLoading || !data)
    return (
      <div className="grid grid-cols-1 gap-4">
        <Skeleton className="h-96 rounded-xl" />
        <Skeleton className="h-32 rounded-xl" />
      </div>
    )
  return (
    <div className="grid max-w-3xl grid-cols-1 gap-4">
      <SmtpForm key={JSON.stringify(data)} settings={data} />
      <TestEmail configured={Boolean(data.host && data.from_address)} />
    </div>
  )
}
