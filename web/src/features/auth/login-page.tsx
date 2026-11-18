import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ArrowLeft, ArrowRight, CircleAlert, Eye, EyeOff, KeyRound, LifeBuoy, LockKeyhole, Smartphone, Waypoints } from 'lucide-react'
import { AuthLayout } from '@/components/auth/auth-layout'
import { RecoveryCodes } from '@/components/auth/recovery-codes'
import { TotpInput } from '@/components/auth/totp-input'
import { CopyButton } from '@/components/common/copy-button'
import { Button } from '@/components/ui/button'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { setCsrfToken } from '@/lib/api/client'
import { authApi, ssoApi } from '@/lib/api/endpoints'
import { errorMessage, isApiError } from '@/lib/api/errors'
import { keys, loginProvidersQuery } from '@/lib/api/queries'
import { parseSsoHash, rememberReturnTo, safeReturnTo, ssoErrorMessage, takeReturnTo, type SsoHash } from '@/lib/sso'
import { useProductName } from '@/lib/branding'
import type { Me, MfaMethod, TotpSetupStart } from '@/lib/api/types'
import { useTitle } from '@/lib/use-title'
import { getAssertion, isWebauthnSupported, webauthnErrorMessage } from '@/lib/webauthn'
import { cn } from '@/lib/utils'

const credentialsSchema = z.object({
  email: z.email('Enter your email address'),
  password: z.string().min(1, 'Enter your password'),
})

type Stage =
  | { kind: 'credentials' }
  | { kind: 'mfa'; challenge: string; methods: MfaMethod[]; method: 'totp' | 'recovery' }
  | { kind: 'setup'; challenge: string; enrollment: TotpSetupStart | null }
  | { kind: 'codes'; codes: string[]; me: Me }

function Heading({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-7">
      <h1 className="font-display text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1.5 text-sm text-muted-foreground">{description}</p>
    </div>
  )
}

function InlineError({ message }: { message: string | null }) {
  return (
    <p role="alert" aria-live="assertive" className={cn('min-h-5 text-dense text-critical', !message && 'invisible')}>
      {message ?? '·'}
    </p>
  )
}

/** The SSO callback hash, read once when the page opens. */
function readSsoHash(): SsoHash | null {
  return typeof window === 'undefined' ? null : parseSsoHash(window.location.hash)
}

function stageFromHash(hash: SsoHash | null): Stage {
  if (hash?.kind !== 'challenge') return { kind: 'credentials' }
  if (hash.mfa === 'setup') return { kind: 'setup', challenge: hash.token, enrollment: null }
  return { kind: 'mfa', challenge: hash.token, methods: hash.methods, method: 'totp' }
}

export function LoginPage({ redirectTo }: { redirectTo?: string }) {
  useTitle('Sign in')
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const productName = useProductName()
  const [ssoHash] = useState(readSsoHash)
  const [stage, setStage] = useState<Stage>(() => stageFromHash(ssoHash))
  const [viaSso] = useState(ssoHash?.kind === 'challenge')
  const [ssoError, setSsoError] = useState<string | null>(ssoHash?.kind === 'error' ? ssoErrorMessage(ssoHash.code) : null)
  const [usePassword, setUsePassword] = useState(false)
  const { data: providers } = useQuery(loginProvidersQuery)
  const providerList = providers?.items ?? []
  const enforced = Boolean(providers?.enforced && providerList.length > 0)
  const returnTo = safeReturnTo(redirectTo)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [code, setCode] = useState('')
  const [recovery, setRecovery] = useState('')
  const [showPassword, setShowPassword] = useState(false)

  const form = useForm<z.infer<typeof credentialsSchema>>({
    resolver: zodResolver(credentialsSchema),
    defaultValues: { email: '', password: '' },
  })

  // Drop the SSO hash from the address bar (the challenge lives in state now) and fetch the
  // authenticator enrollment when the provider sent an account without a second factor.
  useEffect(() => {
    if (!ssoHash) return
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
    if (ssoHash.kind === 'challenge' && ssoHash.mfa === 'setup') {
      authApi
        .totpSetupStart(ssoHash.token)
        .then((enrollment) => setStage({ kind: 'setup', challenge: ssoHash.token, enrollment }))
        .catch((failure: unknown) => {
          setStage({ kind: 'credentials' })
          setSsoError(errorMessage(failure, 'The sign-in expired. Start again.'))
        })
    }
  }, [ssoHash])

  function complete(me: Me) {
    setCsrfToken(me.csrf_token)
    queryClient.setQueryData(keys.me, me)
    const target = returnTo ?? takeReturnTo() ?? '/'
    void navigate({ href: target, replace: true })
  }

  async function run(action: () => Promise<void>) {
    setPending(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(err instanceof DOMException ? webauthnErrorMessage(err) : errorMessage(err))
    } finally {
      setPending(false)
    }
  }

  const submitCredentials = form.handleSubmit((values) =>
    run(async () => {
      setSsoError(null)
      let result
      try {
        result = await authApi.login(values.email.trim(), values.password)
      } catch (failure) {
        if (isApiError(failure) && failure.code === 'sso_required') {
          setUsePassword(false)
          throw new Error('Your organisation requires single sign-on. Use a sign-in button above; password sign-in is reserved for owners.', { cause: failure })
        }
        throw failure
      }
      if (result.status === 'ok') complete(result.me)
      else if (result.status === 'mfa_required') {
        setCode('')
        setStage({ kind: 'mfa', challenge: result.challenge_token, methods: result.methods, method: 'totp' })
      } else {
        const enrollment = await authApi.totpSetupStart(result.challenge_token)
        setStage({ kind: 'setup', challenge: result.challenge_token, enrollment })
      }
    }),
  )

  function verifyTotp(challenge: string, value: string) {
    if (value.length !== 6) return
    void run(async () => {
      try {
        const result = await authApi.totp(challenge, value)
        complete(result.me)
      } catch (err) {
        setCode('')
        throw err
      }
    })
  }

  function verifyRecovery(challenge: string) {
    void run(async () => {
      const result = await authApi.recovery(challenge, recovery.trim())
      complete(result.me)
    })
  }

  function signInWithPasskey(challenge: string) {
    void run(async () => {
      const { options } = await authApi.webauthnStart(challenge)
      const credential = await getAssertion(options)
      const result = await authApi.webauthnFinish(challenge, credential)
      complete(result.me)
    })
  }

  function finishEnrollment(challenge: string, value: string) {
    if (value.length !== 6) return
    void run(async () => {
      try {
        const result = await authApi.totpSetupFinish(challenge, value)
        setStage({ kind: 'codes', codes: result.recovery_codes, me: result.me })
      } catch (err) {
        setCode('')
        throw err
      }
    })
  }

  function backToCredentials() {
    setStage({ kind: 'credentials' })
    setError(null)
    setCode('')
    setRecovery('')
  }

  return (
    <AuthLayout>
      {stage.kind === 'credentials' && (
        <>
          <Heading title="Sign in" description={enforced ? `Sign in to ${productName} with your organisation’s identity provider.` : `Welcome back. Use your ${productName} account to continue.`} />
          {ssoError && (
            <div role="alert" className="mb-5 flex items-start gap-2.5 rounded-lg bg-critical/[0.07] px-3 py-2.5 text-dense ring-1 ring-critical/25">
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-critical" />
              <span>
                <span className="block font-medium">Single sign-on didn’t complete</span>
                <span className="text-muted-foreground">{ssoError}</span>
              </span>
            </div>
          )}
          {providerList.length > 0 && (
            <div className={cn('grid gap-2', !enforced && 'mb-1')}>
              {providerList.map((provider) => (
                <Button
                  key={provider.id}
                  variant={enforced ? 'default' : 'outline'}
                  size="lg"
                  render={<a href={ssoApi.startUrl(provider.id, returnTo ?? undefined)} />}
                  nativeButton={false}
                  onClick={() => rememberReturnTo(returnTo)}
                >
                  <Waypoints data-icon="inline-start" />
                  {provider.button_label}
                </Button>
              ))}
              {(!enforced || usePassword) && (
                <div className="relative my-3 text-center text-micro text-subtle-foreground">
                  <span className="absolute inset-x-0 top-1/2 h-px bg-border" />
                  <span className="relative bg-background px-2">{enforced ? 'owner break-glass sign-in' : 'or with your password'}</span>
                </div>
              )}
            </div>
          )}
          {enforced && !usePassword ? (
            <div className="mt-6 grid gap-3">
              <InlineError message={error} />
              <p className="flex items-start gap-2 text-micro text-subtle-foreground">
                <LockKeyhole className="mt-0.5 size-3.5 shrink-0" />
                Password sign-in is turned off for this organisation. Owners can still use it as a break-glass account.
              </p>
              <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => setUsePassword(true)}>
                <KeyRound data-icon="inline-start" />
                Use password
              </Button>
            </div>
          ) : (
          <form noValidate onSubmit={(event) => void submitCredentials(event)}>
            <FieldGroup className="gap-4">
              <Field data-invalid={Boolean(form.formState.errors.email) || undefined}>
                <FieldLabel htmlFor="email">Email</FieldLabel>
                <Input
                  id="email"
                  type="email"
                  autoFocus
                  autoComplete="username webauthn"
                  className="h-10"
                  aria-invalid={Boolean(form.formState.errors.email) || undefined}
                  {...form.register('email')}
                />
                <FieldError errors={[form.formState.errors.email]} />
              </Field>
              <Field data-invalid={Boolean(form.formState.errors.password) || undefined}>
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    className="h-10 pr-10"
                    aria-invalid={Boolean(form.formState.errors.password) || undefined}
                    {...form.register('password')}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="absolute top-1/2 right-1.5 -translate-y-1/2"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    onClick={() => setShowPassword((value) => !value)}
                  >
                    {showPassword ? <EyeOff /> : <Eye />}
                  </Button>
                </div>
                <FieldError errors={[form.formState.errors.password]} />
              </Field>
              <InlineError message={error} />
              <Button type="submit" size="lg" disabled={pending}>
                {pending && <Spinner data-icon="inline-start" />}
                Continue
                {!pending && <ArrowRight data-icon="inline-end" />}
              </Button>
            </FieldGroup>
          </form>
          )}
          <p className="mt-8 text-center text-micro text-subtle-foreground">
            Lost access? Another administrator can reset your two-factor authentication.
          </p>
        </>
      )}

      {stage.kind === 'mfa' && stage.method === 'totp' && (
        <>
          <Heading
            title="Two-factor authentication"
            description={viaSso ? 'Your identity provider signed you in. Confirm it’s you with the 6-digit code from your authenticator app.' : 'Enter the 6-digit code from your authenticator app.'}
          />
          <div className="grid gap-4">
            <TotpInput
              value={code}
              onChange={setCode}
              onComplete={(value) => verifyTotp(stage.challenge, value)}
              disabled={pending}
              invalid={Boolean(error)}
            />
            <InlineError message={error} />
            <Button size="lg" disabled={pending || code.length !== 6} onClick={() => verifyTotp(stage.challenge, code)}>
              {pending && <Spinner data-icon="inline-start" />}
              Verify
            </Button>
            <div className="relative my-1 text-center text-micro text-subtle-foreground">
              <span className="absolute inset-x-0 top-1/2 h-px bg-border" />
              <span className="relative bg-background px-2">or</span>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {stage.methods.includes('webauthn') && isWebauthnSupported() && (
                <Button variant="outline" disabled={pending} onClick={() => signInWithPasskey(stage.challenge)}>
                  <KeyRound data-icon="inline-start" />
                  Use a passkey
                </Button>
              )}
              {stage.methods.includes('recovery_code') && (
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() => {
                    setError(null)
                    setStage({ ...stage, method: 'recovery' })
                  }}
                  className={cn(!(stage.methods.includes('webauthn') && isWebauthnSupported()) && 'sm:col-span-2')}
                >
                  <LifeBuoy data-icon="inline-start" />
                  Use a recovery code
                </Button>
              )}
            </div>
            <Button variant="ghost" size="sm" className="justify-self-center" onClick={backToCredentials}>
              <ArrowLeft data-icon="inline-start" />
              Use a different account
            </Button>
          </div>
        </>
      )}

      {stage.kind === 'mfa' && stage.method === 'recovery' && (
        <>
          <Heading
            title="Use a recovery code"
            description="Each recovery code works once. Generate new ones from Security settings afterwards."
          />
          <form
            noValidate
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              verifyRecovery(stage.challenge)
            }}
          >
            <Field>
              <FieldLabel htmlFor="recovery">Recovery code</FieldLabel>
              <Input
                id="recovery"
                autoFocus
                autoComplete="one-time-code"
                spellCheck={false}
                className="h-10 font-mono tracking-wider"
                placeholder="xxxx-xxxx-xxxx"
                value={recovery}
                onChange={(event) => setRecovery(event.target.value)}
              />
            </Field>
            <InlineError message={error} />
            <Button type="submit" size="lg" disabled={pending || recovery.trim().length < 6}>
              {pending && <Spinner data-icon="inline-start" />}
              Sign in
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="justify-self-center"
              onClick={() => {
                setError(null)
                setStage({ ...stage, method: 'totp' })
              }}
            >
              <ArrowLeft data-icon="inline-start" />
              Back to authenticator code
            </Button>
          </form>
        </>
      )}

      {stage.kind === 'setup' && (
        <>
          <Heading
            title="Set up two-factor authentication"
            description={`${productName} requires a second factor for every account. Scan the QR code with an authenticator app (1Password, Authy, Microsoft or Google Authenticator).`}
          />
          <div className="grid gap-5">
            <div className="flex flex-col items-center gap-4 rounded-xl bg-surface-1 p-5 shadow-card sm:flex-row sm:items-start">
              <div
                className="size-36 shrink-0 rounded-lg bg-white p-2 [&_svg]:size-full"
                // The QR code is an SVG string produced by our own server.
                dangerouslySetInnerHTML={stage.enrollment ? { __html: stage.enrollment.qr_svg } : undefined}
                aria-label="QR code for your authenticator app"
                role="img"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-dense font-medium">
                  <Smartphone className="size-4 text-primary" />
                  Can&apos;t scan?
                </div>
                <p className="mt-1 text-micro text-muted-foreground">Enter this key manually in your app:</p>
                {stage.enrollment && (
                  <div className="mt-2 flex items-center gap-1 rounded-md bg-surface-3 py-1 pr-1 pl-2.5">
                    <code className="min-w-0 flex-1 truncate font-mono text-[12px] tracking-wider">
                      {stage.enrollment.secret.replace(/(.{4})/g, '$1 ').trim()}
                    </code>
                    <CopyButton value={stage.enrollment.secret} label="Copy key" />
                  </div>
                )}
              </div>
            </div>
            <div className="grid gap-2">
              <span className="text-dense font-medium">Enter the 6-digit code to confirm</span>
              <TotpInput
                value={code}
                onChange={setCode}
                onComplete={(value) => finishEnrollment(stage.challenge, value)}
                disabled={pending}
                invalid={Boolean(error)}
                className="justify-start"
              />
            </div>
            <InlineError message={error} />
            <Button size="lg" disabled={pending || code.length !== 6} onClick={() => finishEnrollment(stage.challenge, code)}>
              {pending && <Spinner data-icon="inline-start" />}
              Enable two-factor authentication
            </Button>
            <Button variant="ghost" size="sm" className="justify-self-center" onClick={backToCredentials}>
              <ArrowLeft data-icon="inline-start" />
              Cancel
            </Button>
          </div>
        </>
      )}

      {stage.kind === 'codes' && (
        <CodesStage codes={stage.codes} onContinue={() => complete(stage.me)} />
      )}
    </AuthLayout>
  )
}

function CodesStage({ codes, onContinue }: { codes: string[]; onContinue: () => void }) {
  const [saved, setSaved] = useState(false)
  const productName = useProductName()
  return (
    <>
      <Heading
        title="Save your recovery codes"
        description="If you lose your authenticator, each of these codes signs you in once. They won't be shown again."
      />
      <div className="grid gap-5">
        <RecoveryCodes codes={codes} onSaved={() => setSaved(true)} />
        <Button size="lg" disabled={!saved} onClick={onContinue}>
          {saved ? `Continue to ${productName}` : 'Copy or download the codes to continue'}
          {saved && <ArrowRight data-icon="inline-end" />}
        </Button>
      </div>
    </>
  )
}
