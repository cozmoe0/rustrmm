import { useState } from 'react'
import { useForm, type FieldPath } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ArrowLeft, ArrowRight, Check, Download, Eye, EyeOff, KeyRound, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { AuthLayout } from '@/components/auth/auth-layout'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { CopyButton } from '@/components/common/copy-button'
import { PasswordMeter } from '@/components/common/password-meter'
import { TimezonePicker } from '@/components/common/timezone-picker'
import { browserTimezone } from '@/lib/timezone'
import { saveBlob } from '@/lib/api/client'
import { setupApi } from '@/lib/api/endpoints'
import { errorMessage, isApiError } from '@/lib/api/errors'
import { keys } from '@/lib/api/queries'
import type { RecoveryKit } from '@/lib/api/types'
import { MIN_PASSWORD_LENGTH, passwordStrength } from '@/lib/password'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'

const schema = z
  .object({
    setup_token: z.string().trim().min(1, 'Paste the setup token from the server log'),
    organization_name: z.string().trim().min(2, 'Enter your organization name').max(80),
    owner_name: z.string().trim().min(2, 'Enter your name').max(80),
    owner_email: z.email('Enter a valid email address'),
    password: z
      .string()
      .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters`)
      .refine((value) => passwordStrength(value).score >= 2, 'Choose a stronger password'),
    confirm: z.string(),
    client_name: z.string().trim().min(2, 'Enter the first client name').max(80),
    site_name: z.string().trim().min(2, 'Enter the first site name').max(80),
    timezone: z.string().min(1),
  })
  .refine((values) => values.password === values.confirm, {
    path: ['confirm'],
    message: 'Passwords do not match',
  })

type SetupValues = z.infer<typeof schema>

const STEPS: { id: string; title: string; description: string; fields: FieldPath<SetupValues>[] }[] = [
  {
    id: 'token',
    title: 'Verify server access',
    description: 'Prove you control this server.',
    fields: ['setup_token'],
  },
  {
    id: 'organization',
    title: 'Your organization',
    description: 'How RustRMM refers to your MSP.',
    fields: ['organization_name'],
  },
  {
    id: 'owner',
    title: 'Owner account',
    description: 'The break-glass administrator.',
    fields: ['owner_name', 'owner_email', 'password', 'confirm'],
  },
  {
    id: 'tenancy',
    title: 'First client & site',
    description: 'Where your first devices will live.',
    fields: ['client_name', 'site_name', 'timezone'],
  },
  {
    id: 'recovery',
    title: 'Recovery kit',
    description: 'Keys that restore this server.',
    fields: [],
  },
]

function Stepper({ current }: { current: number }) {
  return (
    <ol className="grid gap-1">
      {STEPS.map((step, index) => {
        const done = index < current
        const active = index === current
        return (
          <li key={step.id} className="relative flex gap-3.5 pb-6 last:pb-0">
            {index < STEPS.length - 1 && (
              <span
                aria-hidden="true"
                className={cn(
                  'absolute top-7 bottom-0 left-[13px] w-px',
                  done ? 'bg-primary/60' : 'bg-border-strong',
                )}
              />
            )}
            <span
              className={cn(
                'relative flex size-7 shrink-0 items-center justify-center rounded-full text-micro font-semibold ring-1 transition-colors',
                done && 'bg-primary text-primary-foreground ring-primary',
                active && 'bg-primary/15 text-primary ring-primary/50',
                !done && !active && 'bg-surface-2 text-subtle-foreground ring-border-strong',
              )}
            >
              {done ? <Check className="size-3.5" /> : index + 1}
            </span>
            <div className="pt-0.5">
              <div className={cn('text-sm font-medium', !active && !done && 'text-muted-foreground')}>{step.title}</div>
              <div className="text-dense text-subtle-foreground">{step.description}</div>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function SecretBlock({ label, value, hint }: { label: string; value: string; hint: string }) {
  const [revealed, setRevealed] = useState(false)
  return (
    <div className="rounded-lg bg-surface-2 p-3 shadow-raised">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-dense font-medium">{label}</span>
        <div className="flex items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={revealed ? `Hide ${label}` : `Reveal ${label}`}
            onClick={() => setRevealed((value) => !value)}
          >
            {revealed ? <EyeOff /> : <Eye />}
          </Button>
          <CopyButton value={value} label={`Copy ${label}`} />
        </div>
      </div>
      <code className="block font-mono text-[12px] leading-relaxed break-all text-secondary-foreground">
        {revealed ? value : value.replace(/[A-Za-z0-9]/g, '•')}
      </code>
      <p className="mt-1.5 text-micro text-subtle-foreground">{hint}</p>
    </div>
  )
}

function RecoveryStep({ kit, organization, onFinish }: { kit: RecoveryKit; organization: string; onFinish: () => void }) {
  const [downloaded, setDownloaded] = useState(false)
  const [stored, setStored] = useState(false)

  function download() {
    const body = [
      'RUSTRMM RECOVERY KIT',
      '====================',
      `Organization: ${organization}`,
      `Generated:    ${kit.generated_at}`,
      '',
      'Keep this file offline (password manager, safe, or encrypted USB).',
      'Anyone holding it can decrypt this server\'s backups and secrets.',
      '',
      'MASTER KEY (decrypts secrets stored in the database)',
      kit.master_key,
      '',
      'BACKUP IDENTITY (age private key — decrypts backups; the server only keeps the public half)',
      kit.backup_identity,
      '',
      'BACKUP RECIPIENT (public key backups are encrypted to)',
      kit.backup_recipient,
      '',
      'Restore: rustrmm-server restore <backup-file> --identity <file containing the backup identity>',
      '',
    ].join('\n')
    saveBlob(new Blob([body], { type: 'text/plain' }), 'rustrmm-recovery-kit.txt')
    setDownloaded(true)
  }

  return (
    <div className="grid gap-5">
      <div className="flex gap-3 rounded-lg border border-warning/30 bg-warning/[0.07] p-3.5 text-dense">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-warning" />
        <p>
          <span className="font-medium text-foreground">This is shown only once.</span>{' '}
          <span className="text-muted-foreground">
            The server keeps no copy of the backup identity — backups cannot be restored without this kit.
          </span>
        </p>
      </div>

      <SecretBlock label="Master key" value={kit.master_key} hint="Decrypts credentials and secrets in the database." />
      <SecretBlock
        label="Backup identity"
        value={kit.backup_identity}
        hint="age private key. Backups are encrypted to its public half below."
      />
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-micro text-subtle-foreground">Backup recipient (public)</div>
          <code className="block truncate font-mono text-[12px]">{kit.backup_recipient}</code>
        </div>
        <CopyButton value={kit.backup_recipient} label="Copy recipient" />
      </div>

      <Button type="button" variant={downloaded ? 'outline' : 'default'} onClick={download}>
        {downloaded ? <Check data-icon="inline-start" /> : <Download data-icon="inline-start" />}
        {downloaded ? 'Downloaded — download again' : 'Download recovery kit (.txt)'}
      </Button>

      <label
        className={cn(
          'flex items-start gap-3 rounded-lg border border-border p-3 text-dense transition-colors',
          downloaded ? 'cursor-pointer hover:bg-surface-2' : 'opacity-60',
        )}
      >
        <Checkbox checked={stored} disabled={!downloaded} onCheckedChange={(value) => setStored(value === true)} />
        <span>
          <span className="font-medium">I stored the recovery kit somewhere safe</span>
          <span className="block text-muted-foreground">Offline, and separate from this server.</span>
        </span>
      </label>

      <Button type="button" size="lg" disabled={!downloaded || !stored} onClick={onFinish}>
        Finish setup
        <ArrowRight data-icon="inline-end" />
      </Button>
    </div>
  )
}

export function SetupWizard() {
  useTitle('Set up')
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [step, setStep] = useState(0)
  const [kit, setKit] = useState<RecoveryKit | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [showPassword, setShowPassword] = useState(false)

  const form = useForm<SetupValues>({
    resolver: zodResolver(schema),
    mode: 'onTouched',
    defaultValues: {
      setup_token: '',
      organization_name: '',
      owner_name: '',
      owner_email: '',
      password: '',
      confirm: '',
      client_name: '',
      site_name: 'Main office',
      timezone: browserTimezone(),
    },
  })
  const { register, formState, watch, setValue } = form
  const errors = formState.errors

  async function next() {
    const valid = await form.trigger(STEPS[step].fields)
    if (!valid) return
    if (step === 3) await submit()
    else setStep((value) => value + 1)
  }

  async function submit() {
    const values = form.getValues()
    setSubmitting(true)
    try {
      const result = await setupApi.complete({
        setup_token: values.setup_token.trim(),
        organization_name: values.organization_name.trim(),
        owner: { name: values.owner_name.trim(), email: values.owner_email.trim(), password: values.password },
        first_client: { name: values.client_name.trim() },
        first_site: { name: values.site_name.trim(), timezone: values.timezone },
      })
      setKit(result.recovery_kit)
      setStep(4)
    } catch (error) {
      if (isApiError(error) && (error.code === 'invalid_setup_token' || error.status === 403)) {
        form.setError('setup_token', { message: 'That setup token was not accepted' })
        setStep(0)
      } else {
        toast.error(errorMessage(error, 'Setup failed'))
      }
    } finally {
      setSubmitting(false)
    }
  }

  function finish() {
    queryClient.setQueryData(keys.setupStatus, (prev: object | undefined) => ({ ...prev, needs_setup: false }))
    void queryClient.invalidateQueries({ queryKey: keys.setupStatus })
    toast.success('Setup complete — sign in to enroll two-factor authentication')
    void navigate({ to: '/login' })
  }

  const current = STEPS[step]
  const password = watch('password')

  return (
    <AuthLayout
      wide
      aside={
        <div className="max-w-sm">
          <p className="eyebrow mb-5">First-run setup</p>
          <Stepper current={step} />
        </div>
      }
    >
      <div className="mb-6 flex items-center gap-1.5 lg:hidden" aria-hidden="true">
        {STEPS.map((item, index) => (
          <span
            key={item.id}
            className={cn('h-1 flex-1 rounded-full', index <= step ? 'bg-primary' : 'bg-surface-4')}
          />
        ))}
      </div>

      <div className="mb-6">
        <p className="eyebrow mb-1.5">
          Step {step + 1} of {STEPS.length}
        </p>
        <h1 className="font-display text-2xl font-semibold tracking-tight">{current.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {step === 0 &&
            'A one-time setup token was printed to the server console when it started. It stops anyone else from claiming this installation.'}
          {step === 1 && 'Shown in the console, reports and emails. You can change it later.'}
          {step === 2 &&
            'This account can always sign in, even if single sign-on breaks. You will enroll two-factor authentication at first sign-in.'}
          {step === 3 && 'Clients are the companies you manage; sites are their locations. Add more any time.'}
          {step === 4 && 'Save these keys before continuing. They let you restore this server from a backup.'}
        </p>
      </div>

      {step === 4 && kit ? (
        <RecoveryStep kit={kit} organization={form.getValues('organization_name')} onFinish={finish} />
      ) : (
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            void next()
          }}
        >
          <FieldGroup>
            {step === 0 && (
              <Field data-invalid={Boolean(errors.setup_token) || undefined}>
                <FieldLabel htmlFor="setup_token">Setup token</FieldLabel>
                <div className="relative">
                  <KeyRound className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-subtle-foreground" />
                  <Input
                    id="setup_token"
                    autoFocus
                    autoComplete="off"
                    spellCheck={false}
                    className="pl-8 font-mono"
                    placeholder="PMQF-ZFUD-ETAK-HZRX"
                    aria-invalid={Boolean(errors.setup_token) || undefined}
                    {...register('setup_token')}
                  />
                </div>
                <FieldDescription>
                  Find it with <code className="font-mono text-foreground">docker compose logs rustrmm</code> or in
                  the server console output.
                </FieldDescription>
                <FieldError errors={[errors.setup_token]} />
              </Field>
            )}

            {step === 1 && (
              <Field data-invalid={Boolean(errors.organization_name) || undefined}>
                <FieldLabel htmlFor="organization_name">Organization name</FieldLabel>
                <Input
                  id="organization_name"
                  autoFocus
                  autoComplete="organization"
                  placeholder="Lumen IT Partners"
                  aria-invalid={Boolean(errors.organization_name) || undefined}
                  {...register('organization_name')}
                />
                <FieldError errors={[errors.organization_name]} />
              </Field>
            )}

            {step === 2 && (
              <>
                <div className="grid gap-5 sm:grid-cols-2">
                  <Field data-invalid={Boolean(errors.owner_name) || undefined}>
                    <FieldLabel htmlFor="owner_name">Full name</FieldLabel>
                    <Input id="owner_name" autoFocus autoComplete="name" {...register('owner_name')} />
                    <FieldError errors={[errors.owner_name]} />
                  </Field>
                  <Field data-invalid={Boolean(errors.owner_email) || undefined}>
                    <FieldLabel htmlFor="owner_email">Work email</FieldLabel>
                    <Input id="owner_email" type="email" autoComplete="email" {...register('owner_email')} />
                    <FieldError errors={[errors.owner_email]} />
                  </Field>
                </div>
                <Field data-invalid={Boolean(errors.password) || undefined}>
                  <FieldLabel htmlFor="password">Password</FieldLabel>
                  <div className="relative">
                    <Input
                      id="password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      className="pr-9"
                      {...register('password')}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="absolute top-1/2 right-1.5 -translate-y-1/2"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      onClick={() => setShowPassword((value) => !value)}
                    >
                      {showPassword ? <EyeOff /> : <Eye />}
                    </Button>
                  </div>
                  <PasswordMeter password={password} />
                  <FieldError errors={[errors.password]} />
                </Field>
                <Field data-invalid={Boolean(errors.confirm) || undefined}>
                  <FieldLabel htmlFor="confirm">Confirm password</FieldLabel>
                  <Input
                    id="confirm"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    {...register('confirm')}
                  />
                  <FieldError errors={[errors.confirm]} />
                </Field>
              </>
            )}

            {step === 3 && (
              <>
                <Field data-invalid={Boolean(errors.client_name) || undefined}>
                  <FieldLabel htmlFor="client_name">First client</FieldLabel>
                  <Input id="client_name" autoFocus placeholder="Northwind Dental" {...register('client_name')} />
                  <FieldDescription>Managing your own company? Use its name here.</FieldDescription>
                  <FieldError errors={[errors.client_name]} />
                </Field>
                <div className="grid gap-5 sm:grid-cols-2">
                  <Field data-invalid={Boolean(errors.site_name) || undefined}>
                    <FieldLabel htmlFor="site_name">First site</FieldLabel>
                    <Input id="site_name" {...register('site_name')} />
                    <FieldError errors={[errors.site_name]} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="timezone">Site time zone</FieldLabel>
                    <TimezonePicker
                      id="timezone"
                      value={watch('timezone')}
                      onChange={(zone) => setValue('timezone', zone, { shouldValidate: true })}
                    />
                  </Field>
                </div>
              </>
            )}

            <div className="flex items-center justify-between gap-3 pt-2">
              {step > 0 ? (
                <Button type="button" variant="ghost" onClick={() => setStep((value) => value - 1)} disabled={submitting}>
                  <ArrowLeft data-icon="inline-start" />
                  Back
                </Button>
              ) : (
                <span />
              )}
              <Button type="submit" disabled={submitting} className="min-w-32">
                {submitting && <Spinner data-icon="inline-start" />}
                {step === 3 ? 'Create installation' : 'Continue'}
                {!submitting && <ArrowRight data-icon="inline-end" />}
              </Button>
            </div>
          </FieldGroup>
        </form>
      )}
    </AuthLayout>
  )
}
