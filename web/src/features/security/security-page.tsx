import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Laptop, LifeBuoy, Plus, ShieldCheck, Smartphone, Trash } from 'lucide-react'
import { toast } from 'sonner'
import { RecoveryCodes } from '@/components/auth/recovery-codes'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Mono, RelativeTime } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { PasswordMeter } from '@/components/common/password-meter'
import { meApi } from '@/lib/api/endpoints'
import { errorMessage } from '@/lib/api/errors'
import { keys, passkeysQuery, sessionsQuery } from '@/lib/api/queries'
import type { Passkey, SessionInfo } from '@/lib/api/types'
import { describeUserAgent } from '@/lib/format'
import { MIN_PASSWORD_LENGTH, passwordStrength } from '@/lib/password'
import { useMe } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { createCredential, isWebauthnSupported, webauthnErrorMessage } from '@/lib/webauthn'

function SessionsCard() {
  const queryClient = useQueryClient()
  const { data: sessions, isLoading } = useQuery(sessionsQuery)
  const [revoking, setRevoking] = useState<SessionInfo | null>(null)
  const revoke = useMutation({
    mutationFn: (session: SessionInfo) => meApi.revokeSession(session.id),
    meta: { successMessage: 'Session signed out' },
    onSuccess: () => {
      setRevoking(null)
      void queryClient.invalidateQueries({ queryKey: keys.sessions })
    },
  })

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b border-border py-4">
        <CardTitle>Active sessions</CardTitle>
        <CardDescription>Browsers signed in to your account. Sign out any you don&apos;t recognise.</CardDescription>
      </CardHeader>
      <ul className="divide-y divide-border">
        {isLoading && Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="m-4 h-10" />)}
        {sessions?.map((session) => {
          const mobile = /iPhone|Android|iPad/.test(session.user_agent ?? '')
          const Icon = mobile ? Smartphone : Laptop
          return (
            <li key={session.id} className="flex items-center gap-3 px-4 py-3">
              <span className="flex size-9 items-center justify-center rounded-lg bg-surface-3 text-muted-foreground">
                <Icon className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-dense font-medium">
                  {describeUserAgent(session.user_agent)}
                  {session.current && <Badge variant="live">This browser</Badge>}
                </div>
                <div className="flex flex-wrap items-center gap-x-2 text-micro text-muted-foreground">
                  {session.ip && <Mono className="text-[10.5px]">{session.ip}</Mono>}
                  <span>
                    Signed in <RelativeTime value={session.created_at} />
                  </span>
                  <span>
                    · Active <RelativeTime value={session.last_seen_at} />
                  </span>
                </div>
              </div>
              {!session.current && (
                <Button variant="outline" size="sm" onClick={() => setRevoking(session)}>
                  Sign out
                </Button>
              )}
            </li>
          )
        })}
      </ul>
      <ConfirmDialog
        open={Boolean(revoking)}
        onOpenChange={(open) => !open && setRevoking(null)}
        title="Sign out this session?"
        description={`${describeUserAgent(revoking?.user_agent ?? null)} will be signed out immediately.`}
        confirmLabel="Sign out session"
        pending={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking)}
      />
    </Card>
  )
}

function PasskeysCard() {
  const queryClient = useQueryClient()
  const { data: passkeys, isLoading } = useQuery(passkeysQuery)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [registering, setRegistering] = useState(false)
  const [removing, setRemoving] = useState<Passkey | null>(null)
  const supported = isWebauthnSupported()

  async function register() {
    setRegistering(true)
    try {
      const { options } = await meApi.passkeyRegisterStart()
      const credential = await createCredential(options)
      await meApi.passkeyRegisterFinish(name.trim() || 'Passkey', credential)
      toast.success('Passkey added')
      setNaming(false)
      setName('')
      void queryClient.invalidateQueries({ queryKey: keys.passkeys })
      void queryClient.invalidateQueries({ queryKey: keys.me })
    } catch (error) {
      toast.error(error instanceof DOMException ? webauthnErrorMessage(error) : errorMessage(error))
    } finally {
      setRegistering(false)
    }
  }

  const remove = useMutation({
    mutationFn: (passkey: Passkey) => meApi.deletePasskey(passkey.id),
    meta: { successMessage: 'Passkey removed' },
    onSuccess: () => {
      setRemoving(null)
      void queryClient.invalidateQueries({ queryKey: keys.passkeys })
      void queryClient.invalidateQueries({ queryKey: keys.me })
    },
  })

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="flex flex-row items-start justify-between gap-4 border-b border-border py-4">
        <div>
          <CardTitle>Passkeys</CardTitle>
          <CardDescription>Phishing-resistant sign-in with a security key, Windows Hello or Touch ID.</CardDescription>
        </div>
        <Button size="sm" variant="outline" disabled={!supported} onClick={() => setNaming(true)}>
          <Plus data-icon="inline-start" />
          Add passkey
        </Button>
      </CardHeader>
      <ul className="divide-y divide-border">
        {isLoading && <Skeleton className="m-4 h-10" />}
        {passkeys?.length === 0 && (
          <li className="px-4 py-6 text-center text-dense text-muted-foreground">
            No passkeys yet. {supported ? 'Add one for faster, phishing-resistant sign-in.' : 'This browser does not support passkeys.'}
          </li>
        )}
        {passkeys?.map((passkey) => (
          <li key={passkey.id} className="flex items-center gap-3 px-4 py-3">
            <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
              <KeyRound className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-dense font-medium">{passkey.name}</div>
              <div className="text-micro text-muted-foreground">
                Added <RelativeTime value={passkey.created_at} /> · Last used <RelativeTime value={passkey.last_used_at} />
              </div>
            </div>
            <Button variant="ghost" size="icon-sm" aria-label={`Remove ${passkey.name}`} onClick={() => setRemoving(passkey)}>
              <Trash />
            </Button>
          </li>
        ))}
      </ul>
      <Dialog open={naming} onOpenChange={setNaming}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Name this passkey</DialogTitle>
            <DialogDescription>So you can recognise it later, e.g. “YubiKey 5C” or “Work laptop”.</DialogDescription>
          </DialogHeader>
          <Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Work laptop" aria-label="Passkey name" />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setNaming(false)}>
              Cancel
            </Button>
            <Button onClick={() => void register()} disabled={registering}>
              {registering && <Spinner data-icon="inline-start" />}
              Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove ${removing?.name}?`}
        description="You will no longer be able to sign in with it."
        confirmLabel="Remove passkey"
        pending={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
      />
    </Card>
  )
}

function RecoveryCard() {
  const [codes, setCodes] = useState<string[] | null>(null)
  const regenerate = useMutation({
    mutationFn: meApi.regenerateRecoveryCodes,
    onSuccess: (result) => setCodes(result.recovery_codes),
  })
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LifeBuoy className="size-4 text-muted-foreground" />
          Recovery codes
        </CardTitle>
        <CardDescription>
          One-time codes for when your authenticator is unavailable. Generating new codes invalidates the old ones.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="outline" onClick={() => regenerate.mutate()} disabled={regenerate.isPending}>
          {regenerate.isPending && <Spinner data-icon="inline-start" />}
          Generate new codes
        </Button>
      </CardContent>
      <Dialog open={Boolean(codes)} onOpenChange={(open) => !open && setCodes(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Your new recovery codes</DialogTitle>
            <DialogDescription>Save them now — they won&apos;t be shown again. Your previous codes no longer work.</DialogDescription>
          </DialogHeader>
          {codes && <RecoveryCodes codes={codes} />}
          <DialogFooter>
            <Button onClick={() => setCodes(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

const passwordSchema = z
  .object({
    current: z.string().min(1, 'Enter your current password'),
    next: z
      .string()
      .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters`)
      .refine((value) => passwordStrength(value).score >= 2, 'Choose a stronger password'),
    confirm: z.string(),
  })
  .refine((values) => values.next === values.confirm, { path: ['confirm'], message: 'Passwords do not match' })

function PasswordCard() {
  const form = useForm<z.infer<typeof passwordSchema>>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { current: '', next: '', confirm: '' },
  })
  const change = useMutation({
    mutationFn: (values: z.infer<typeof passwordSchema>) => meApi.changePassword(values.current, values.next),
    meta: { successMessage: 'Password changed' },
    onSuccess: () => form.reset(),
  })
  const errors = form.formState.errors

  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <CardDescription>Changing your password signs out your other sessions.</CardDescription>
      </CardHeader>
      <CardContent>
        <form noValidate onSubmit={form.handleSubmit((values) => change.mutate(values))}>
          <FieldGroup className="gap-4">
            <Field data-invalid={Boolean(errors.current) || undefined}>
              <FieldLabel htmlFor="pw-current">Current password</FieldLabel>
              <Input id="pw-current" type="password" autoComplete="current-password" {...form.register('current')} />
              <FieldError errors={[errors.current]} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={Boolean(errors.next) || undefined}>
                <FieldLabel htmlFor="pw-next">New password</FieldLabel>
                <Input id="pw-next" type="password" autoComplete="new-password" {...form.register('next')} />
                <PasswordMeter password={form.watch('next')} />
                <FieldError errors={[errors.next]} />
              </Field>
              <Field data-invalid={Boolean(errors.confirm) || undefined}>
                <FieldLabel htmlFor="pw-confirm">Confirm new password</FieldLabel>
                <Input id="pw-confirm" type="password" autoComplete="new-password" {...form.register('confirm')} />
                <FieldError errors={[errors.confirm]} />
              </Field>
            </div>
            <div>
              <Button type="submit" disabled={change.isPending}>
                {change.isPending && <Spinner data-icon="inline-start" />}
                Change password
              </Button>
            </div>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  )
}

export function SecurityPage() {
  useTitle('My security')
  const me = useMe()
  return (
    <PageContainer className="grid max-w-5xl gap-5">
      <PageHeader
        eyebrow="Settings"
        title="My security"
        description="Your sign-in methods and sessions. Two-factor authentication is required for every RustRMM account."
      />
      <Card size="sm" className="flex-row items-center gap-3 px-4">
        <span className="flex size-9 items-center justify-center rounded-lg bg-success/12 text-success ring-1 ring-success/25">
          <ShieldCheck className="size-4" />
        </span>
        <div className="flex-1 text-dense">
          <div className="font-medium">Two-factor authentication is on</div>
          <div className="text-micro text-muted-foreground">
            Authenticator app{me?.user.mfa.totp ? ' enrolled' : ' pending'} · {me?.user.mfa.passkeys ?? 0} passkey
            {me?.user.mfa.passkeys === 1 ? '' : 's'}
          </div>
        </div>
      </Card>
      <div className="grid gap-5 lg:grid-cols-2">
        <PasskeysCard />
        <RecoveryCard />
      </div>
      <SessionsCard />
      <PasswordCard />
    </PageContainer>
  )
}
