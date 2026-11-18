import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Lock, Pencil, Plus, Trash } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, RelativeTime } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/simple-select'
import { SecretInput } from '@/features/notifications/notification-ui'
import { SEGMENTED } from '@/features/automation/styles'
import { snmpApi } from '@/lib/api/endpoints'
import { isApiError } from '@/lib/api/errors'
import { networkKeys, scansQuery, snmpCredentialsQuery, snmpDevicesQuery } from '@/lib/api/queries'
import type { SnmpAuth, SnmpCredential, SnmpCredentialInput, SnmpPrivacy, SnmpVersion } from '@/lib/api/types'
import { isMasked, type SecretDraft } from '@/lib/notifications/channels'
import { PERMISSIONS, hasGlobalPermission, useMe } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { networkErrorMessage } from './use-network'

const AUTH_LABEL: Record<SnmpAuth, string> = { none: 'No authentication', sha: 'SHA-1', sha256: 'SHA-256' }
const PRIVACY_LABEL: Record<SnmpPrivacy, string> = { none: 'No privacy', aes128: 'AES-128' }

const draftFor = (value: string | null | undefined): SecretDraft => (isMasked(value) ? { stored: true, mode: 'keep', value: '' } : { stored: false, mode: 'replace', value: '' })
/** Undefined keeps the stored secret (the server also ignores the mask). */
const secretValue = (draft: SecretDraft) => (draft.mode === 'replace' && draft.value ? draft.value : undefined)

function CredentialDialog({ credential, open, onOpenChange }: { credential: SnmpCredential | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">{open && <CredentialForm key={credential?.id ?? 'new'} credential={credential} onDone={() => onOpenChange(false)} />}</DialogContent>
    </Dialog>
  )
}

function CredentialForm({ credential, onDone }: { credential: SnmpCredential | null; onDone: () => void }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(credential?.name ?? '')
  const [version, setVersion] = useState<SnmpVersion>(credential?.version ?? 'v2c')
  const [community, setCommunity] = useState<SecretDraft>(draftFor(credential?.community))
  const [username, setUsername] = useState(credential?.v3?.username ?? '')
  const [auth, setAuth] = useState<SnmpAuth>(credential?.v3?.auth ?? 'sha256')
  const [privacy, setPrivacy] = useState<SnmpPrivacy>(credential?.v3?.privacy ?? 'aes128')
  const [authPassword, setAuthPassword] = useState<SecretDraft>(draftFor(credential?.v3?.auth_password))
  const [privacyPassword, setPrivacyPassword] = useState<SecretDraft>(draftFor(credential?.v3?.privacy_password))
  const [attempted, setAttempted] = useState(false)
  const [serverError, setServerError] = useState<{ path: string; message: string } | null>(null)

  const passwordIssue = (draft: SecretDraft) => {
    if (draft.stored && draft.mode !== 'replace') return null
    if (!draft.value) return 'Required'
    if (draft.value.length < 8 || draft.value.length > 128) return 'Use 8–128 characters'
    return null
  }
  const errors = {
    name: !name.trim() ? 'Enter a name' : null,
    community: version === 'v2c' && !community.stored && !community.value ? 'Enter the community string' : version === 'v2c' && community.value.length > 64 ? 'At most 64 characters' : null,
    username: version === 'v3' && !username.trim() ? 'Enter the v3 user name' : null,
    auth: version === 'v3' && auth !== 'none' ? passwordIssue(authPassword) : null,
    privacy: version === 'v3' && privacy !== 'none' ? (auth === 'none' ? 'Privacy needs authentication' : passwordIssue(privacyPassword)) : null,
  }
  const invalid = Object.values(errors).some(Boolean)
  const show = (key: keyof typeof errors) => (attempted ? errors[key] : null) ?? (serverError && serverError.path.endsWith(key === 'auth' ? 'auth_password' : key === 'privacy' ? 'privacy' : key) ? serverError.message : null)

  const save = useMutation({
    mutationFn: () => {
      const body: SnmpCredentialInput =
        version === 'v2c'
          ? { name: name.trim(), version, community: secretValue(community) }
          : {
              name: name.trim(),
              version,
              v3: { username: username.trim(), auth, privacy: auth === 'none' ? 'none' : privacy, auth_password: auth === 'none' ? undefined : secretValue(authPassword), privacy_password: privacy === 'none' || auth === 'none' ? undefined : secretValue(privacyPassword) },
            }
      return credential ? snmpApi.updateCredential(credential.id, body) : snmpApi.createCredential(body)
    },
    meta: { silent: true },
    onSuccess: (result) => {
      toast.success(credential ? `Saved “${result.name}”` : `Added “${result.name}”`)
      void queryClient.invalidateQueries({ queryKey: networkKeys.credentials })
      onDone()
    },
    onError: (failure) => {
      if (isApiError(failure) && failure.status === 422) setServerError({ path: String((failure.details as { path?: string } | undefined)?.path ?? ''), message: failure.message })
      else toast.error(networkErrorMessage(failure))
    },
  })

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        setAttempted(true)
        setServerError(null)
        if (!invalid) save.mutate()
      }}
    >
      <DialogHeader>
        <DialogTitle>{credential ? 'Edit SNMP credential' : 'New SNMP credential'}</DialogTitle>
        <DialogDescription>Secrets are encrypted on the server and never shown again. They are sent only to probes, inside signed configuration.</DialogDescription>
      </DialogHeader>
      <Field data-invalid={Boolean(show('name')) || undefined}>
        <FieldLabel htmlFor="cred-name">Name</FieldLabel>
        <Input id="cred-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Clinic switches (v3)" />
        {show('name') && <FieldError>{show('name')}</FieldError>}
      </Field>
      <Field>
        <FieldLabel>Version</FieldLabel>
        <ToggleGroup className={SEGMENTED} value={[version]} onValueChange={(next: string[]) => next[0] && setVersion(next[0] as SnmpVersion)} variant="outline" spacing={0} size="sm" aria-label="SNMP version">
          <ToggleGroupItem value="v2c" className="px-3">
            v2c (community)
          </ToggleGroupItem>
          <ToggleGroupItem value="v3" className="px-3">
            v3 (user)
          </ToggleGroupItem>
        </ToggleGroup>
      </Field>
      {version === 'v2c' ? (
        <Field data-invalid={Boolean(show('community')) || undefined}>
          <FieldLabel htmlFor="cred-community">Community</FieldLabel>
          <SecretInput id="cred-community" secret={community} onChange={setCommunity} invalid={Boolean(show('community'))} />
          {show('community') ? <FieldError>{show('community')}</FieldError> : <FieldDescription>v2c sends the community in clear text; prefer v3 where devices support it.</FieldDescription>}
        </Field>
      ) : (
        <>
          <Field data-invalid={Boolean(show('username')) || undefined}>
            <FieldLabel htmlFor="cred-user">User name</FieldLabel>
            <Input id="cred-user" value={username} onChange={(event) => setUsername(event.target.value)} spellCheck={false} className="font-mono text-[12.5px]" />
            {show('username') && <FieldError>{show('username')}</FieldError>}
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="cred-auth">Authentication</FieldLabel>
              <SimpleSelect id="cred-auth" value={auth} onValueChange={(value) => setAuth(value as SnmpAuth)} options={(['sha256', 'sha', 'none'] as SnmpAuth[]).map((value) => ({ value, label: AUTH_LABEL[value] }))} />
            </Field>
            <Field>
              <FieldLabel htmlFor="cred-privacy">Privacy</FieldLabel>
              <SimpleSelect id="cred-privacy" value={auth === 'none' ? 'none' : privacy} disabled={auth === 'none'} onValueChange={(value) => setPrivacy(value as SnmpPrivacy)} options={(['aes128', 'none'] as SnmpPrivacy[]).map((value) => ({ value, label: PRIVACY_LABEL[value] }))} />
            </Field>
          </div>
          {auth !== 'none' && (
            <Field data-invalid={Boolean(show('auth')) || undefined}>
              <FieldLabel htmlFor="cred-auth-password">Authentication password</FieldLabel>
              <SecretInput id="cred-auth-password" secret={authPassword} onChange={setAuthPassword} invalid={Boolean(show('auth'))} />
              {show('auth') ? <FieldError>{show('auth')}</FieldError> : <FieldDescription>8–128 characters.</FieldDescription>}
            </Field>
          )}
          {auth !== 'none' && privacy !== 'none' && (
            <Field data-invalid={Boolean(show('privacy')) || undefined}>
              <FieldLabel htmlFor="cred-privacy-password">Privacy password</FieldLabel>
              <SecretInput id="cred-privacy-password" secret={privacyPassword} onChange={setPrivacyPassword} invalid={Boolean(show('privacy'))} />
              {show('privacy') ? <FieldError>{show('privacy')}</FieldError> : <FieldDescription>8–128 characters.</FieldDescription>}
            </Field>
          )}
          {credential?.v3 && credential.v3.auth !== 'none' && auth === 'none' && <p className="text-micro text-warning">Saving without authentication removes the stored passwords.</p>}
        </>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone} disabled={save.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending && <Spinner data-icon="inline-start" />}
          {credential ? 'Save' : 'Add credential'}
        </Button>
      </DialogFooter>
    </form>
  )
}

export function CredentialsPage() {
  useTitle('SNMP credentials')
  const me = useMe()
  const queryClient = useQueryClient()
  const canEdit = hasGlobalPermission(me, PERMISSIONS.networkManage)
  const { data, isLoading, error, refetch } = useQuery(snmpCredentialsQuery)
  const devices = useQuery(snmpDevicesQuery())
  const scans = useQuery(scansQuery)
  const [editing, setEditing] = useState<SnmpCredential | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<SnmpCredential | null>(null)

  const remove = useMutation({
    mutationFn: (credential: SnmpCredential) => snmpApi.removeCredential(credential.id),
    meta: { silent: true },
    onSuccess: (_result, credential) => {
      toast.success(`Deleted “${credential.name}”`)
      setDeleting(null)
      void queryClient.invalidateQueries({ queryKey: networkKeys.credentials })
      void queryClient.invalidateQueries({ queryKey: networkKeys.scans })
    },
    onError: (failure) => {
      setDeleting(null)
      toast.error(networkErrorMessage(failure))
    },
  })

  return (
    <PageContainer className="grid grid-cols-1 gap-5">
      <PageHeader
        icon={<KeyRound />}
        title="SNMP credentials"
        description="Community strings and v3 users that scans and SNMP devices use. Shared across the installation; secrets are write-only."
        actions={
          canEdit && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus data-icon="inline-start" />
              New credential
            </Button>
          )
        }
      />
      {!canEdit && (
        <p className="flex items-start gap-2 rounded-xl bg-surface-2 px-4 py-3 text-dense text-muted-foreground ring-1 ring-border">
          <Lock className="mt-0.5 size-4 shrink-0" />
          Credentials are installation-wide; changing them needs the “Manage network” permission held globally.
        </p>
      )}
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isLoading ? (
        <div className="grid gap-3 md:grid-cols-2">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-28 rounded-xl" />
          ))}
        </div>
      ) : (data ?? []).length === 0 ? (
        <EmptyState illustration="network" title="No SNMP credentials yet" description="Add a v2c community or a v3 user so scans can read sysDescr and devices can be polled." />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {(data ?? []).map((credential) => {
            const usedBy = devices.data?.filter((device) => device.credential_id === credential.id).length ?? 0
            const scanCount = scans.data?.filter((scan) => scan.snmp_credential_ids.includes(credential.id)).length ?? 0
            return (
              <article key={credential.id} className="grid min-w-0 content-start gap-3 rounded-xl bg-card p-4 shadow-card">
                <div className="flex items-start gap-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-muted-foreground ring-1 ring-border">
                    <KeyRound className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-sm font-semibold">{credential.name}</h3>
                    <p className="text-micro text-subtle-foreground">
                      Updated <RelativeTime value={credential.updated_at ?? null} />
                    </p>
                  </div>
                  <Badge variant={credential.version === 'v3' ? 'success' : 'warning'}>{credential.version}</Badge>
                </div>
                <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-1 text-dense">
                  {credential.version === 'v2c' ? (
                    <>
                      <dt className="text-muted-foreground">Community</dt>
                      <dd className="font-mono text-[12px] text-muted-foreground">{credential.community ?? '—'}</dd>
                    </>
                  ) : (
                    <>
                      <dt className="text-muted-foreground">User</dt>
                      <dd className="truncate font-mono text-[12px]">{credential.v3?.username}</dd>
                      <dt className="text-muted-foreground">Security</dt>
                      <dd>
                        {AUTH_LABEL[credential.v3?.auth ?? 'none']} · {PRIVACY_LABEL[credential.v3?.privacy ?? 'none']}
                      </dd>
                      <dt className="text-muted-foreground">Passwords</dt>
                      <dd className="font-mono text-[12px] text-muted-foreground">
                        {[credential.v3?.auth_password, credential.v3?.privacy_password].filter(Boolean).join(' / ') || '—'}
                      </dd>
                    </>
                  )}
                  <dt className="text-muted-foreground">Used by</dt>
                  <dd>
                    {usedBy} {usedBy === 1 ? 'device' : 'devices'} · {scanCount} {scanCount === 1 ? 'scan' : 'scans'}
                  </dd>
                </dl>
                {canEdit && (
                  <div className="flex gap-1.5">
                    <Button variant="outline" size="xs" onClick={() => setEditing(credential)}>
                      <Pencil data-icon="inline-start" />
                      Edit
                    </Button>
                    <Button variant="ghost" size="xs" className="hover:text-critical" onClick={() => setDeleting(credential)}>
                      <Trash data-icon="inline-start" />
                      Delete
                    </Button>
                  </div>
                )}
              </article>
            )
          })}
        </div>
      )}
      <CredentialDialog credential={editing} open={creating || Boolean(editing)} onOpenChange={(open) => !open && (setCreating(false), setEditing(null))} />
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete “${deleting?.name}”?`}
        description="Scans stop using it. A credential that SNMP devices still use can’t be deleted."
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </PageContainer>
  )
}
