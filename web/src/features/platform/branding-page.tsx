/* Settings → Branding: product name, light/dark logos and the accent colour with a live, AA-checked preview. */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, CircleAlert, CircleCheck, Palette, RotateCcw, Type } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { LogoMark } from '@/components/brand/logo'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { UnsavedChangesGuard } from '@/features/automation/unsaved-guard'
import { brandingApi } from '@/lib/api/endpoints'
import { errorMessage } from '@/lib/api/errors'
import { brandingSettingsQuery, platformKeys } from '@/lib/api/queries'
import type { BrandingSettings } from '@/lib/api/types'
import { DEFAULT_PRODUCT_NAME } from '@/lib/branding'
import { AA_TEXT, THEME_SURFACES, accentPlan, formatRatio, normalizeHex, type AccentCheck, type ThemeName } from '@/lib/color'
import { PERMISSIONS, hasGlobalPermission, hasPermission, useMe } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { LogoUpload } from './logo-upload'
import { SettingsCard } from './platform-ui'

/** The copper accent of each theme (approximate sRGB of the oklch tokens), for the preview's fallback. */
const COPPER: Record<ThemeName, { accent: string; foreground: string }> = {
  light: { accent: '#b4562b', foreground: '#ffffff' },
  dark: { accent: '#ea8550', foreground: '#2b170c' },
}
const SWATCHES = ['#2563eb', '#0f766e', '#7c3aed', '#be123c', '#15803d', '#c2410c', '#0369a1', '#4338ca']
const PREVIEW_TEXT: Record<ThemeName, { text: string; muted: string; border: string }> = {
  light: { text: '#16181c', muted: '#5b616c', border: 'rgba(22,24,28,0.12)' },
  dark: { text: '#e7e9ec', muted: '#8f96a0', border: 'rgba(255,255,255,0.1)' },
}

function Ratio({ label, value }: { label: string; value: number }) {
  const ok = value >= AA_TEXT
  return (
    <div className="flex items-center justify-between gap-2 text-micro">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn('tabular inline-flex items-center gap-1 font-medium', ok ? 'text-success' : 'text-critical')}>
        {ok ? <CircleCheck className="size-3" /> : <CircleAlert className="size-3" />}
        {formatRatio(value)}
      </span>
    </div>
  )
}

function ThemePreview({ theme, accent, check, productName, logoUrl }: { theme: ThemeName; accent: string | null; check: AccentCheck | null; productName: string; logoUrl: string | null }) {
  const applies = Boolean(accent && check?.passes)
  const color = applies && accent ? accent : COPPER[theme].accent
  const foreground = applies && check ? check.foreground : COPPER[theme].foreground
  const surfaces = THEME_SURFACES[theme]
  const text = PREVIEW_TEXT[theme]
  return (
    <figure className="grid min-w-0 gap-2">
      <figcaption className="flex items-center justify-between gap-2 text-micro">
        <span className="font-medium capitalize">{theme} theme</span>
        {check ? applies ? <Badge variant="success">Accent applied</Badge> : <Badge variant="warning">Copper kept</Badge> : <Badge variant="secondary">Default copper</Badge>}
      </figcaption>
      <div className="overflow-hidden rounded-xl ring-1 ring-border" style={{ background: surfaces.background, color: text.text }}>
        <div className="flex items-center gap-2 px-3 py-2" style={{ background: theme === 'dark' ? '#08090b' : '#15181d' }}>
          {logoUrl ? <img src={logoUrl} alt="" className="h-5 max-w-24 object-contain" /> : <LogoMark className="size-5" />}
          <span className="truncate text-[12px] font-semibold text-white">{productName || DEFAULT_PRODUCT_NAME}</span>
          <span className="ml-auto size-1.5 rounded-full" style={{ background: color }} />
        </div>
        <div className="grid gap-2.5 p-3">
          <div className="rounded-lg p-3" style={{ background: surfaces.card, boxShadow: `0 0 0 1px ${text.border}` }}>
            <div className="text-[12px] font-semibold">Patch compliance</div>
            <div className="mt-0.5 text-[11px]" style={{ color: text.muted }}>
              94% of scanned devices · <span style={{ color, fontWeight: 600 }}>Review updates</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full" style={{ background: text.border }}>
              <div className="h-full w-[94%] rounded-full" style={{ background: color }} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex h-7 items-center rounded-md px-2.5 text-[12px] font-medium" style={{ background: color, color: foreground }}>
              Run report
            </span>
            <span className="inline-flex h-7 items-center rounded-md px-2.5 text-[12px] font-medium" style={{ boxShadow: `0 0 0 2px ${color}`, color: text.text }}>
              Focused
            </span>
            <span className="inline-flex h-5 items-center rounded-md px-1.5 text-[11px] font-medium" style={{ color, background: `color-mix(in oklch, ${color} 14%, transparent)` }}>
              Live
            </span>
          </div>
        </div>
      </div>
      {check && (
        <div className="grid gap-0.5 rounded-lg bg-surface-2 px-2.5 py-1.5 ring-1 ring-border">
          <Ratio label="Text on accent buttons" value={check.onAccent} />
          <Ratio label="Accent on the page and cards" value={check.onSurface} />
        </div>
      )}
    </figure>
  )
}

export function BrandingPage() {
  useTitle('Branding')
  const me = useMe()
  const canView = hasPermission(me, PERMISSIONS.settingsView)
  const canManage = hasGlobalPermission(me, PERMISSIONS.settingsManage)
  const { data, isLoading, error, refetch } = useQuery({ ...brandingSettingsQuery, enabled: canView })

  if (!canView) {
    return (
      <PageContainer>
        <EmptyState illustration="security" title="Branding needs “View settings”" description="Ask an administrator for access to the branding settings." />
      </PageContainer>
    )
  }
  if (error) {
    return (
      <PageContainer>
        <ErrorState error={error} onRetry={() => void refetch()} />
      </PageContainer>
    )
  }
  if (isLoading || !data) {
    return (
      <PageContainer className="grid max-w-5xl gap-4">
        <Skeleton className="h-10 w-64 rounded-lg" />
        <Skeleton className="h-32 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </PageContainer>
    )
  }
  return <BrandingEditor key={JSON.stringify(data)} data={data} canManage={canManage} />
}

function BrandingEditor({ data, canManage }: { data: BrandingSettings; canManage: boolean }) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<BrandingSettings>(data)
  const [hex, setHex] = useState(data.accent_color ?? '')
  const [lightUrl, setLightUrl] = useState<string | null>(data.logo_light_file_id ? brandingApi.fileUrl(data.logo_light_file_id) : null)
  const [darkUrl, setDarkUrl] = useState<string | null>(data.logo_dark_file_id ? brandingApi.fileUrl(data.logo_dark_file_id) : null)

  const save = useMutation({
    mutationFn: (body: BrandingSettings) => brandingApi.update(body),
    meta: { silent: true },
    onSuccess: (saved) => {
      toast.success('Branding saved', { description: 'The console, sign-in page, report PDFs and e-mails now use it.' })
      queryClient.setQueryData(platformKeys.brandingSettings, saved)
      void queryClient.invalidateQueries({ queryKey: platformKeys.branding })
    },
    onError: (failure) => toast.error(errorMessage(failure)),
  })

  const typedAccent = hex.trim() ? normalizeHex(hex.trim().startsWith('#') ? hex.trim() : `#${hex.trim()}`) : null
  const hexError = hex.trim() && !typedAccent ? 'Use a six-digit hex colour such as #2563eb' : null
  const plan = accentPlan(typedAccent)
  const nameError = !draft.product_name.trim() ? 'Enter a product name' : draft.product_name.trim().length > 60 ? 'At most 60 characters' : null
  const next: BrandingSettings = { ...draft, product_name: draft.product_name.trim(), accent_color: typedAccent }
  const dirty = JSON.stringify(next) !== JSON.stringify({ ...data, product_name: data.product_name.trim() })
  const status = !plan ? null : plan.light.passes && plan.dark.passes ? 'both' : plan.light.passes ? 'light' : plan.dark.passes ? 'dark' : 'none'

  return (
    <PageContainer className="grid max-w-5xl grid-cols-1 gap-5">
      <UnsavedChangesGuard when={dirty && canManage} what="branding changes" />
      <PageHeader
        title="Branding"
        description="White-label the console, sign-in page, report PDFs and e-mails with your MSP’s name, logo and colour."
        actions={
          canManage && (
            <Button size="sm" disabled={!dirty || Boolean(nameError) || Boolean(hexError) || save.isPending} onClick={() => save.mutate(next)}>
              {save.isPending ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" />}
              Save branding
            </Button>
          )
        }
      />
        <fieldset disabled={!canManage} className="grid min-w-0 gap-5">
          <SettingsCard icon={<Type />} title="Name and logos" description="The dark logo is used on dark surfaces (the navigation rail, dark theme); it falls back to the light logo.">
            <div className="grid gap-5 p-4">
              <Field data-invalid={Boolean(nameError) || undefined} className="max-w-md">
                <FieldLabel htmlFor="brand-name">Product name</FieldLabel>
                <Input id="brand-name" value={draft.product_name} maxLength={60} onChange={(event) => setDraft({ ...draft, product_name: event.target.value })} />
                {nameError ? <FieldError>{nameError}</FieldError> : <FieldDescription>Shown in tab titles, the sign-in page and report footers.</FieldDescription>}
              </Field>
              <div className="grid gap-4 md:grid-cols-2">
                <LogoUpload
                  label="Light logo"
                  hint="On light backgrounds"
                  url={lightUrl}
                  disabled={!canManage}
                  onUploaded={(file) => {
                    setDraft({ ...draft, logo_light_file_id: file.id })
                    setLightUrl(file.url)
                  }}
                  onRemove={() => {
                    setDraft({ ...draft, logo_light_file_id: null })
                    setLightUrl(null)
                  }}
                />
                <LogoUpload
                  label="Dark logo"
                  hint="Optional"
                  surface="dark"
                  url={darkUrl ?? lightUrl}
                  disabled={!canManage}
                  onUploaded={(file) => {
                    setDraft({ ...draft, logo_dark_file_id: file.id })
                    setDarkUrl(file.url)
                  }}
                  onRemove={
                    draft.logo_dark_file_id
                      ? () => {
                          setDraft({ ...draft, logo_dark_file_id: null })
                          setDarkUrl(null)
                        }
                      : undefined
                  }
                />
              </div>
              <p className="text-micro text-muted-foreground">Report PDFs embed PNG logos only; SVG logos are used in the console and e-mail.</p>
            </div>
          </SettingsCard>

          <SettingsCard icon={<Palette />} title="Accent colour" description="Replaces the copper accent on buttons, links and focus rings — only in a theme where it meets WCAG AA (4.5:1) both as text and behind button text.">
            <div className="grid gap-5 p-4 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
              <div className="grid content-start gap-3">
                <Field data-invalid={Boolean(hexError) || undefined}>
                  <FieldLabel htmlFor="brand-accent">Colour</FieldLabel>
                  <div className="flex items-center gap-2">
                    <input type="color" aria-label="Pick a colour" value={typedAccent ?? '#b4562b'} onChange={(event) => setHex(event.target.value)} className="size-8 shrink-0 cursor-pointer rounded-md border border-input bg-transparent p-0.5" />
                    <Input id="brand-accent" className="font-mono" value={hex} placeholder="Default copper" onChange={(event) => setHex(event.target.value)} spellCheck={false} />
                  </div>
                  {hexError && <FieldError>{hexError}</FieldError>}
                </Field>
                <div className="flex flex-wrap gap-1.5">
                  {SWATCHES.map((swatch) => (
                    <button key={swatch} type="button" aria-label={`Use ${swatch}`} aria-pressed={typedAccent === swatch} onClick={() => setHex(swatch)} className="flex size-7 items-center justify-center rounded-md ring-1 ring-black/10 outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring" style={{ background: swatch }}>
                      {typedAccent === swatch && <Check className="size-3.5 text-white" />}
                    </button>
                  ))}
                </div>
                <Button type="button" variant="ghost" size="sm" className="w-fit" onClick={() => setHex('')} disabled={!hex}>
                  <RotateCcw data-icon="inline-start" />
                  Use the default copper
                </Button>
                {status && (
                  <p className={cn('flex items-start gap-2 rounded-lg px-3 py-2 text-dense ring-1', status === 'both' ? 'bg-success/[0.06] ring-success/25' : status === 'none' ? 'bg-critical/[0.06] ring-critical/25' : 'bg-warning/[0.06] ring-warning/25')}>
                    {status === 'both' ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" /> : <CircleAlert className={cn('mt-0.5 size-4 shrink-0', status === 'none' ? 'text-critical' : 'text-warning')} />}
                    <span>
                      {status === 'both' && 'Passes AA in both themes; it will replace copper everywhere.'}
                      {status === 'light' && 'Passes AA in the light theme only. The dark theme keeps copper.'}
                      {status === 'dark' && 'Passes AA in the dark theme only. The light theme keeps copper.'}
                      {status === 'none' && 'Fails AA in both themes, so the console keeps copper. PDFs and e-mails still use it for their header band.'}
                    </span>
                  </p>
                )}
              </div>
              <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                <ThemePreview theme="light" accent={plan?.accent ?? null} check={plan?.light ?? null} productName={draft.product_name} logoUrl={lightUrl} />
                <ThemePreview theme="dark" accent={plan?.accent ?? null} check={plan?.dark ?? null} productName={draft.product_name} logoUrl={darkUrl ?? lightUrl} />
              </div>
            </div>
          </SettingsCard>
        </fieldset>
    </PageContainer>
  )
}
