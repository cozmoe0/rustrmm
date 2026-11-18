/* Settings → Single sign-on: OIDC providers (with role mappings) and enforcement. Reads and writes need step-up. */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Ellipsis, KeyRound, LockKeyhole, Pencil, Plus, ShieldAlert, Trash, TriangleAlert, Users, Waypoints, X } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/simple-select'
import { TokenInput } from '@/components/common/token-input'
import { SecretInput } from '@/features/notifications/notification-ui'
import { ssoApi } from '@/lib/api/endpoints'
import { errorMessage, isApiError } from '@/lib/api/errors'
import { clientsQuery, platformKeys, rolesQuery, ssoProvidersQuery, ssoSettingsQuery } from '@/lib/api/queries'
import type { SsoProvider, SsoProviderInput, SsoRoleMapping } from '@/lib/api/types'
import type { SecretDraft } from '@/lib/notifications/channels'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { CopyField, SettingsCard, StepUpGate, ToggleRow } from './platform-ui'

function issuerError(value: string): string | null {
  if (!value.trim()) return 'Enter the issuer URL'
  try {
    const url = new URL(value.trim())
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    if (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) return null
    return 'Use https (plain http only for a loopback test issuer)'
  } catch {
    return 'Enter a full URL, such as https://login.microsoftonline.com/<tenant>/v2.0'
  }
}

export function SsoPage({ edit }: { edit?: string }) {
  useTitle('Single sign-on')
  const me = useMe()
  const navigate = useNavigate({ from: '/settings/sso' })
  const queryClient = useQueryClient()
  const canManage = hasPermission(me, PERMISSIONS.settingsManage) && Boolean(me?.scopes.global)
  const providers = useQuery({ ...ssoProvidersQuery, enabled: canManage })
  const settings = useQuery({ ...ssoSettingsQuery, enabled: hasPermission(me, PERMISSIONS.settingsView) })
  const [deleting, setDeleting] = useState<SsoProvider | null>(null)
  const [confirmEnforce, setConfirmEnforce] = useState(false)
  const list = providers.data ?? []
  const enabledCount = list.filter((provider) => provider.enabled).length
  const editing = edit && edit !== 'new' ? (list.find((provider) => provider.id === edit) ?? null) : null
  const editorOpen = edit === 'new' || Boolean(editing)
  const setEdit = (value: string | undefined) => void navigate({ search: { edit: value }, replace: true })
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: platformKeys.ssoProviders })
    void queryClient.invalidateQueries({ queryKey: platformKeys.ssoSettings })
    void queryClient.invalidateQueries({ queryKey: platformKeys.loginProviders })
  }

  const enforce = useMutation({
    mutationFn: (value: boolean) => ssoApi.updateSettings({ enforce: value }),
    meta: { silent: true },
    onSuccess: (result) => {
      toast.success(result.enforce ? 'Single sign-on is now required' : 'Password sign-in is allowed again')
      setConfirmEnforce(false)
      refresh()
    },
    onError: (failure) => toast.error(errorMessage(failure)),
  })
  const toggle = useMutation({
    mutationFn: (provider: SsoProvider) => ssoApi.update(provider.id, { ...toInput(provider), enabled: !provider.enabled }),
    meta: { silent: true },
    onSuccess: (saved) => {
      toast.success(saved.enabled ? `${saved.name} enabled` : `${saved.name} disabled`)
      refresh()
    },
    onError: (failure) => toast.error(errorMessage(failure)),
  })
  const remove = useMutation({
    mutationFn: (provider: SsoProvider) => ssoApi.remove(provider.id),
    meta: { silent: true },
    onSuccess: (_result, provider) => {
      toast.success(`Removed ${provider.name}`, { description: 'Its linked identities and managed role assignments were removed too.' })
      setDeleting(null)
      refresh()
    },
    onError: (failure) => toast.error(errorMessage(failure)),
  })

  if (!canManage) {
    return (
      <PageContainer>
        <EmptyState illustration="security" title="Single sign-on needs “Manage settings”" description="Providers and enforcement are installation-wide, so the Manage settings permission must be held globally." />
      </PageContainer>
    )
  }

  const enforced = settings.data?.enforce ?? false

  return (
    <PageContainer className="grid max-w-5xl grid-cols-1 gap-5">
      <PageHeader
        title="Single sign-on"
        description="Let your team sign in with Microsoft Entra ID, Google, Okta, Keycloak or any OpenID Connect provider. Role mappings keep their access in sync at every sign-in."
        actions={
          <Button size="sm" onClick={() => setEdit('new')}>
            <Plus data-icon="inline-start" />
            Add provider
          </Button>
        }
      />

      <SettingsCard
        icon={<LockKeyhole />}
        title="Require single sign-on"
        description="When on, password sign-in is refused for everyone except global owners, who keep password + MFA as a break-glass account."
        actions={
          <Switch
            checked={enforced}
            disabled={settings.isLoading || enforce.isPending || (!enforced && (!providers.data || enabledCount === 0))}
            onCheckedChange={(value) => (value ? setConfirmEnforce(true) : enforce.mutate(false))}
            aria-label="Require single sign-on"
          />
        }
      >
        <div className={cn('flex items-start gap-2.5 px-4 py-3 text-dense', enforced ? 'bg-warning/[0.06] text-foreground' : 'text-muted-foreground')}>
          {enforced ? <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" /> : <TriangleAlert className="mt-0.5 size-4 shrink-0 text-subtle-foreground" />}
          <span>
            {enforced
              ? 'Enforced. Only owners can still sign in with a password. Make sure at least one owner can reach their authenticator.'
              : providers.data && enabledCount === 0
                ? 'Enable a provider before requiring single sign-on.'
                : 'Not enforced: people can use either a provider or their password.'}
          </span>
        </div>
      </SettingsCard>

      {providers.error && isApiError(providers.error) && providers.error.code === 'step_up_required' ? (
        <StepUpGate error={providers.error} what="identity providers" onRetry={() => void providers.refetch()} />
      ) : providers.error ? (
        <ErrorState error={providers.error} onRetry={() => void providers.refetch()} />
      ) : providers.isLoading ? (
        <div className="grid gap-3">
          {Array.from({ length: 2 }, (_, index) => (
            <Skeleton key={index} className="h-40 rounded-xl" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          illustration="security"
          title="No identity provider yet"
          description="Register RustRMM as a web application at your identity provider, then add its issuer, client ID and secret here."
          actions={
            <Button size="sm" onClick={() => setEdit('new')}>
              Add provider
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3">
          {list.map((provider) => (
            <ProviderCard key={provider.id} provider={provider} onEdit={() => setEdit(provider.id)} onToggle={() => toggle.mutate(provider)} toggling={toggle.isPending && toggle.variables?.id === provider.id} onDelete={() => setDeleting(provider)} />
          ))}
        </div>
      )}

      <ProviderEditor provider={editing} open={editorOpen} onOpenChange={(open) => !open && setEdit(undefined)} onSaved={refresh} />
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Remove ${deleting?.name}?`}
        description="People who sign in through it lose that option, its linked identities are deleted and the role assignments it manages are removed. You'll be asked to re-authenticate."
        confirmLabel="Remove provider"
        confirmText={deleting?.name}
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
      <ConfirmDialog
        open={confirmEnforce}
        onOpenChange={setConfirmEnforce}
        title="Require single sign-on for everyone?"
        description="Password sign-in will be refused for every user who is not a global owner, including administrators. Owners keep password + MFA as a break-glass path. Make sure the enabled provider works first."
        confirmLabel="Require single sign-on"
        destructive
        pending={enforce.isPending}
        onConfirm={() => enforce.mutate(true)}
      />
    </PageContainer>
  )
}

function toInput(provider: SsoProvider): SsoProviderInput {
  return {
    name: provider.name,
    issuer_url: provider.issuer_url,
    client_id: provider.client_id,
    scopes: provider.scopes,
    group_claim: provider.group_claim,
    role_mappings: provider.role_mappings,
    auto_provision: provider.auto_provision,
    require_local_mfa: provider.require_local_mfa,
    trust_unverified_email: provider.trust_unverified_email,
    enabled: provider.enabled,
    button_label: provider.button_label,
  }
}

function ProviderCard({ provider, onEdit, onToggle, toggling, onDelete }: { provider: SsoProvider; onEdit: () => void; onToggle: () => void; toggling: boolean; onDelete: () => void }) {
  const { data: roles = [] } = useQuery(rolesQuery)
  const { data: clients = [] } = useQuery(clientsQuery())
  const host = (() => {
    try {
      return new URL(provider.issuer_url).host
    } catch {
      return provider.issuer_url
    }
  })()
  return (
    <article className={cn('grid min-w-0 gap-4 rounded-xl bg-card p-4 shadow-card', !provider.enabled && 'opacity-80')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary ring-1 ring-primary/25">
            <Waypoints className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <h3 className="truncate text-sm font-semibold">{provider.name}</h3>
              {provider.enabled ? <Badge variant="success">Enabled</Badge> : <Badge variant="outline">Disabled</Badge>}
              {!provider.has_client_secret && <Badge variant="warning">No client secret</Badge>}
            </div>
            <p className="truncate font-mono text-[11.5px] text-muted-foreground">{host}</p>
            <p className="mt-0.5 truncate text-micro text-subtle-foreground">
              Client ID <span className="font-mono">{provider.client_id}</span> · scopes {provider.scopes.join(' ')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Switch checked={provider.enabled} disabled={toggling} onCheckedChange={onToggle} aria-label={provider.enabled ? `Disable ${provider.name}` : `Enable ${provider.name}`} />
          <Button variant="outline" size="sm" onClick={onEdit}>
            <Pencil data-icon="inline-start" />
            Edit
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`More for ${provider.name}`} />}>
              <Ellipsis />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={onEdit}>
                <Pencil />
                Edit provider
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trash />
                Remove provider
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div className="grid min-w-0 gap-3 lg:grid-cols-2">
        <div className="grid min-w-0 content-start gap-1.5">
          <span className="text-micro font-medium text-muted-foreground">Redirect URI — register this at the provider</span>
          <CopyField value={provider.redirect_uri} label="Copy redirect URI" />
          <div className="mt-1 flex flex-wrap gap-1">
            <Badge variant={provider.auto_provision ? 'info' : 'outline'}>{provider.auto_provision ? 'Creates new users' : 'Existing users only'}</Badge>
            <Badge variant={provider.require_local_mfa ? 'default' : 'outline'}>{provider.require_local_mfa ? 'Local MFA always' : 'Trusts provider MFA'}</Badge>
            {provider.trust_unverified_email && <Badge variant="warning">Accepts unverified e-mail</Badge>}
          </div>
        </div>
        <div className="grid min-w-0 content-start gap-1.5">
          <span className="flex items-center gap-1.5 text-micro font-medium text-muted-foreground">
            <Users className="size-3.5" />
            Role mappings from the <span className="font-mono">{provider.group_claim || 'groups'}</span> claim
          </span>
          {provider.role_mappings.length === 0 ? (
            <p className="text-dense text-muted-foreground">No mappings: users keep the roles assigned in the console.</p>
          ) : (
            <ul className="grid gap-1">
              {provider.role_mappings.map((mapping, index) => (
                <li key={index} className="flex min-w-0 items-center gap-1.5 text-dense">
                  <span className="max-w-40 truncate rounded-[5px] bg-surface-3 px-1.5 font-mono text-[11.5px] ring-1 ring-border">{mapping.group}</span>
                  <span className="text-subtle-foreground">→</span>
                  <span className="truncate font-medium">{roles.find((role) => role.id === mapping.role_id)?.name ?? 'Unknown role'}</span>
                  <span className="truncate text-muted-foreground">{mapping.scope_type === 'global' ? 'everywhere' : `at ${clients.find((client) => client.id === mapping.scope_id)?.name ?? 'a client'}`}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </article>
  )
}

function ProviderEditor({ provider, open, onOpenChange, onSaved }: { provider: SsoProvider | null; open: boolean; onOpenChange: (open: boolean) => void; onSaved: () => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="gap-0 p-0 shadow-popover data-[side=right]:w-full data-[side=right]:sm:max-w-[640px]">
        {open && <ProviderForm key={provider?.id ?? 'new'} provider={provider} onDone={() => onOpenChange(false)} onSaved={onSaved} />}
      </SheetContent>
    </Sheet>
  )
}

function ProviderForm({ provider, onDone, onSaved }: { provider: SsoProvider | null; onDone: () => void; onSaved: () => void }) {
  const { data: roles = [] } = useQuery(rolesQuery)
  const { data: clients = [] } = useQuery(clientsQuery())
  const [name, setName] = useState(provider?.name ?? '')
  const [issuer, setIssuer] = useState(provider?.issuer_url ?? '')
  const [clientId, setClientId] = useState(provider?.client_id ?? '')
  const [secret, setSecret] = useState<SecretDraft>(provider?.has_client_secret ? { stored: true, mode: 'keep', value: '' } : { stored: false, mode: 'replace', value: '' })
  const [scopes, setScopes] = useState<string[]>((provider?.scopes ?? ['openid', 'email', 'profile']).filter((scope) => scope !== 'openid'))
  const [groupClaim, setGroupClaim] = useState(provider?.group_claim ?? 'groups')
  const [mappings, setMappings] = useState<SsoRoleMapping[]>(provider?.role_mappings ?? [])
  const [autoProvision, setAutoProvision] = useState(provider?.auto_provision ?? false)
  const [localMfa, setLocalMfa] = useState(provider?.require_local_mfa ?? false)
  const [trustUnverified, setTrustUnverified] = useState(provider?.trust_unverified_email ?? false)
  const [enabled, setEnabled] = useState(provider?.enabled ?? true)
  const [buttonLabel, setButtonLabel] = useState(provider?.button_label ?? '')
  const [attempted, setAttempted] = useState(false)
  const [serverError, setServerError] = useState<{ path: string; message: string } | null>(null)
  const mappable = roles.filter((role) => role.name !== 'Owner')

  const errors = {
    name: name.trim() ? null : 'Enter a name',
    issuer: issuerError(issuer),
    clientId: clientId.trim() ? null : 'Enter the client ID',
    mappings: mappings.some((mapping) => !mapping.group.trim() || !mapping.role_id || (mapping.scope_type === 'client' && !mapping.scope_id)) ? 'Every mapping needs a group, a role and (for client scope) a client' : null,
  }
  const invalid = Object.values(errors).some(Boolean)
  const show = (key: keyof typeof errors, path: string) => (attempted ? errors[key] : null) ?? (serverError?.path.startsWith(path) ? serverError.message : null)

  const save = useMutation({
    mutationFn: () => {
      const body: SsoProviderInput = {
        name: name.trim(),
        issuer_url: issuer.trim(),
        client_id: clientId.trim(),
        scopes: ['openid', ...scopes.filter((scope) => scope !== 'openid')],
        group_claim: groupClaim.trim(),
        role_mappings: mappings.map((mapping) => ({ ...mapping, group: mapping.group.trim(), scope_id: mapping.scope_type === 'client' ? mapping.scope_id : null })),
        auto_provision: autoProvision,
        require_local_mfa: localMfa,
        trust_unverified_email: trustUnverified,
        enabled,
        button_label: buttonLabel.trim() || `Sign in with ${name.trim()}`,
        ...(secret.mode === 'remove' ? { client_secret: '' } : secret.mode === 'replace' && secret.value ? { client_secret: secret.value } : {}),
      }
      return provider ? ssoApi.update(provider.id, body) : ssoApi.create(body)
    },
    meta: { silent: true },
    onSuccess: (saved) => {
      toast.success(provider ? `Saved ${saved.name}` : `Added ${saved.name}`, { description: provider ? undefined : 'Register the redirect URI shown on its card at the identity provider.' })
      onSaved()
      onDone()
    },
    onError: (failure) => {
      if (isApiError(failure) && failure.status === 422) setServerError({ path: String((failure.details as { path?: string } | undefined)?.path ?? ''), message: failure.message })
      else toast.error(errorMessage(failure))
    },
  })

  return (
    <form
      className="flex h-full min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault()
        setAttempted(true)
        setServerError(null)
        if (!invalid) save.mutate()
      }}
    >
      <SheetHeader className="border-b border-border px-5 pt-5 pb-4">
        <SheetTitle>{provider ? `Edit ${provider.name}` : 'Add an identity provider'}</SheetTitle>
        <SheetDescription>OpenID Connect with the authorization code flow and PKCE. Saving asks you to re-authenticate.</SheetDescription>
      </SheetHeader>
      <div className="grid min-h-0 flex-1 grid-cols-1 content-start gap-5 overflow-y-auto px-5 py-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field data-invalid={Boolean(show('name', 'name')) || undefined}>
            <FieldLabel htmlFor="sso-name">Name</FieldLabel>
            <Input id="sso-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Microsoft Entra ID" />
            {show('name', 'name') && <FieldError>{show('name', 'name')}</FieldError>}
          </Field>
          <Field>
            <FieldLabel htmlFor="sso-button">Button label</FieldLabel>
            <Input id="sso-button" value={buttonLabel} onChange={(event) => setButtonLabel(event.target.value)} placeholder={`Sign in with ${name.trim() || 'your provider'}`} />
            <FieldDescription>Shown on the sign-in page.</FieldDescription>
          </Field>
        </div>
        <Field data-invalid={Boolean(show('issuer', 'issuer_url')) || undefined}>
          <FieldLabel htmlFor="sso-issuer">Issuer URL</FieldLabel>
          <Input id="sso-issuer" className="font-mono text-[12.5px]" value={issuer} onChange={(event) => setIssuer(event.target.value)} placeholder="https://login.microsoftonline.com/<tenant-id>/v2.0" spellCheck={false} />
          {show('issuer', 'issuer_url') ? <FieldError>{show('issuer', 'issuer_url')}</FieldError> : <FieldDescription>Discovery is read from <span className="font-mono">/.well-known/openid-configuration</span> under this URL.</FieldDescription>}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field data-invalid={Boolean(show('clientId', 'client_id')) || undefined}>
            <FieldLabel htmlFor="sso-client-id">Client ID</FieldLabel>
            <Input id="sso-client-id" className="font-mono text-[12.5px]" value={clientId} onChange={(event) => setClientId(event.target.value)} spellCheck={false} />
            {show('clientId', 'client_id') && <FieldError>{show('clientId', 'client_id')}</FieldError>}
          </Field>
          <Field>
            <FieldLabel htmlFor="sso-secret" className="flex items-center gap-1.5">
              <KeyRound className="size-3.5 text-subtle-foreground" />
              Client secret
            </FieldLabel>
            <SecretInput id="sso-secret" secret={secret} onChange={setSecret} optional placeholder="Write-only" />
            <FieldDescription>Encrypted on the server and never shown again.</FieldDescription>
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="sso-scopes">Scopes</FieldLabel>
            <div className="flex min-w-0 items-start gap-1.5">
              <span className="mt-1 inline-flex h-6 shrink-0 items-center rounded-md bg-primary/10 px-2 font-mono text-[11.5px] text-primary ring-1 ring-primary/20" title="Always requested">
                openid
              </span>
              <TokenInput id="sso-scopes" value={scopes} onChange={(next) => setScopes(next.filter((scope) => scope !== 'openid'))} placeholder="email profile" mono className="min-w-0 flex-1" />
            </div>
          </Field>
          <Field>
            <FieldLabel htmlFor="sso-groups">Group claim</FieldLabel>
            <Input id="sso-groups" className="font-mono text-[12.5px]" value={groupClaim} onChange={(event) => setGroupClaim(event.target.value)} placeholder="groups" spellCheck={false} />
            <FieldDescription>A top-level claim or a dotted path, such as realm_access.roles.</FieldDescription>
          </Field>
        </div>

        <fieldset className="grid min-w-0 gap-2">
          <legend className="mb-1 flex w-full items-center justify-between gap-2">
            <span className="text-dense font-medium">Role mappings</span>
            <Button type="button" variant="outline" size="xs" onClick={() => setMappings((prev) => [...prev, { group: '', role_id: mappable[0]?.id ?? '', scope_type: 'global', scope_id: null }])}>
              <Plus data-icon="inline-start" />
              Add mapping
            </Button>
          </legend>
          <p className="text-micro text-muted-foreground">Re-applied at every sign-in: assignments a provider manages are replaced; roles assigned in the console are untouched. Owners can’t be mapped — they are managed locally.</p>
          {mappings.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border-strong px-3 py-3 text-dense text-muted-foreground">No mappings. Users signing in keep whatever roles you assign them in Users.</p>
          ) : (
            <div className="grid gap-2">
              <div className="hidden grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 px-1 text-micro text-subtle-foreground sm:grid">
                <span>Group value</span>
                <span>Role</span>
                <span>Scope</span>
                <span className="w-7" />
              </div>
              {mappings.map((mapping, index) => {
                const update = (patch: Partial<SsoRoleMapping>) => setMappings((prev) => prev.map((item, position) => (position === index ? { ...item, ...patch } : item)))
                return (
                  <div key={index} className="grid gap-2 rounded-lg p-2 ring-1 ring-border sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:p-0 sm:ring-0">
                    <Input aria-label="Group value" className="font-mono text-[12.5px]" value={mapping.group} onChange={(event) => update({ group: event.target.value })} placeholder="RMM-Technicians" />
                    <SimpleSelect ariaLabel="Role" value={mapping.role_id || null} onValueChange={(role_id) => update({ role_id })} options={mappable.map((role) => ({ value: role.id, label: role.name }))} placeholder="Role…" />
                    <SimpleSelect
                      ariaLabel="Scope"
                      value={mapping.scope_type === 'global' ? 'global' : (mapping.scope_id ?? '')}
                      onValueChange={(value) => update(value === 'global' ? { scope_type: 'global', scope_id: null } : { scope_type: 'client', scope_id: value })}
                      options={[{ value: 'global', label: 'Everywhere' }, ...clients.map((client) => ({ value: client.id, label: client.name, group: 'One client' }))]}
                    />
                    <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove mapping" className="justify-self-end hover:text-critical" onClick={() => setMappings((prev) => prev.filter((_, position) => position !== index))}>
                      <X />
                    </Button>
                  </div>
                )
              })}
              {show('mappings', 'role_mappings') && <p className="text-dense text-critical">{show('mappings', 'role_mappings')}</p>}
            </div>
          )}
        </fieldset>

        <div className="grid gap-2">
          <ToggleRow title="Enabled" description="Disabled providers keep their settings but are hidden from the sign-in page." control={<Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enabled" />} />
          <ToggleRow title="Create accounts on first sign-in" description="Without it, only people who already have a RustRMM user (matched by e-mail) can sign in." control={<Switch checked={autoProvision} onCheckedChange={setAutoProvision} aria-label="Create accounts on first sign-in" />} />
          <ToggleRow title="Always require local MFA" description="Otherwise RustRMM skips its own second factor when the provider asserts MFA (amr/acr). Step-up still uses a local factor." control={<Switch checked={localMfa} onCheckedChange={setLocalMfa} aria-label="Always require local MFA" />} />
          <ToggleRow
            tone={trustUnverified ? 'warning' : undefined}
            title="Trust unverified e-mail addresses"
            description="Needed for providers that never send email_verified (such as Entra ID). Only turn it on if the provider controls which addresses users can claim."
            control={<Switch checked={trustUnverified} onCheckedChange={setTrustUnverified} aria-label="Trust unverified e-mail addresses" />}
          />
        </div>

        <Field>
          <FieldLabel>Redirect URI</FieldLabel>
          {provider ? <CopyField value={provider.redirect_uri} label="Copy redirect URI" /> : <p className="rounded-md bg-surface-2 px-3 py-2 text-dense text-muted-foreground ring-1 ring-border">Shown after you save. Register it at the provider as a web redirect URI.</p>}
        </Field>
        {serverError && !['name', 'issuer_url', 'client_id', 'role_mappings'].some((path) => serverError.path.startsWith(path)) && (
          <p role="alert" className="text-dense text-critical">
            {serverError.message}
          </p>
        )}
      </div>
      <SheetFooter className="flex-row justify-end border-t border-border px-5 py-3">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending && <Spinner data-icon="inline-start" />}
          {provider ? 'Save provider' : 'Add provider'}
        </Button>
      </SheetFooter>
    </form>
  )
}
