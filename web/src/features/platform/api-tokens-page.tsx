/* Settings → API tokens: your personal access tokens, everyone's (api.manage), and the show-once create flow. */
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { BookOpenText, Check, CircleAlert, Copy, KeyRound, Network, Plus, ShieldCheck, SquareArrowOutUpRight, Trash } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { DataTable } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, RelativeTime } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/simple-select'
import { TokenInput } from '@/components/common/token-input'
import { apiTokensApi } from '@/lib/api/endpoints'
import { errorMessage, isApiError } from '@/lib/api/errors'
import { apiTokensQuery, clientsQuery, permissionsQuery, platformKeys } from '@/lib/api/queries'
import type { ApiToken, ApiTokenCreated } from '@/lib/api/types'
import {
  EXPIRY_PRESETS,
  MAX_CIDRS,
  TOKEN_DEFAULT_DAYS,
  TOKEN_NAME_MAX,
  cidrError,
  displayPrefix,
  endOfLocalDay,
  expiryError,
  expiryFromDays,
  grantablePermissions,
  maxExpiry,
  permissionSubset,
  permissionsError,
  readOnlyPreset,
} from '@/lib/api-tokens'
import { copyText } from '@/lib/clipboard'
import { formatDate } from '@/lib/format'
import { PERMISSIONS, hasGlobalPermission, useMe } from '@/lib/permissions'
import { toDateInput } from '@/lib/reports/params'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { ClientScopePicker, SettingsCard } from './platform-ui'

export function ApiTokensPage({ view, create }: { view: 'mine' | 'all'; create: boolean }) {
  useTitle('API tokens')
  const me = useMe()
  const navigate = useNavigate({ from: '/settings/api-tokens' })
  const queryClient = useQueryClient()
  const canAll = hasGlobalPermission(me, PERMISSIONS.apiManage)
  const all = view === 'all' && canAll
  const { data: tokens = [], isLoading, error, refetch } = useQuery(apiTokensQuery(all))
  const { data: clients = [] } = useQuery(clientsQuery())
  const [revoking, setRevoking] = useState<ApiToken | null>(null)
  const setSearch = (patch: { tokens?: 'mine' | 'all'; new?: boolean }) => void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })

  const revoke = useMutation({
    mutationFn: (token: ApiToken) => apiTokensApi.revoke(token.id),
    meta: { silent: true },
    onSuccess: (_result, token) => {
      toast.success(`Revoked “${token.name}”`, { description: 'Requests with it now fail with 401.' })
      setRevoking(null)
      void queryClient.invalidateQueries({ queryKey: platformKeys.apiTokens })
    },
    onError: (failure) => toast.error(errorMessage(failure)),
  })

  const columns = useMemo<ColumnDef<ApiToken>[]>(() => {
    const defs: ColumnDef<ApiToken>[] = [
      {
        id: 'name',
        accessorFn: (token) => token.name.toLowerCase(),
        header: 'Token',
        cell: ({ row }) => (
          <div className="min-w-0 leading-tight">
            <div className="flex items-center gap-1.5">
              <span className="max-w-56 truncate font-medium">{row.original.name}</span>
              {row.original.expired && <Badge variant="critical">Expired</Badge>}
            </div>
            <code className="font-mono text-[10.5px] text-subtle-foreground">{displayPrefix(row.original.prefix)}…</code>
          </div>
        ),
      },
    ]
    if (all) {
      defs.push({
        id: 'user',
        accessorFn: (token) => token.user?.name ?? '',
        header: 'Owner',
        cell: ({ row }) => (
          <div className="min-w-0 leading-tight">
            <div className="max-w-44 truncate">{row.original.user?.name ?? '—'}</div>
            <div className="max-w-44 truncate text-[10.5px] text-subtle-foreground">{row.original.user?.email}</div>
          </div>
        ),
      })
    }
    defs.push(
      {
        id: 'permissions',
        accessorFn: (token) => token.permissions.length,
        header: 'Access',
        cell: ({ row }) => (
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex max-w-60 items-center gap-1.5 truncate text-muted-foreground" />}>
              <ShieldCheck className="size-3.5 shrink-0 text-subtle-foreground" />
              <span className="truncate">
                {row.original.permissions.length} {row.original.permissions.length === 1 ? 'permission' : 'permissions'} · {row.original.client_ids === null ? 'all clients' : `${row.original.client_ids.length} ${row.original.client_ids.length === 1 ? 'client' : 'clients'}`}
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-80">
              <div className="grid gap-1">
                <span className="font-mono text-[11px]">{row.original.permissions.join(', ')}</span>
                {row.original.client_ids && <span>Clients: {row.original.client_ids.map((id) => clients.find((client) => client.id === id)?.name ?? id).join(', ')}</span>}
              </div>
            </TooltipContent>
          </Tooltip>
        ),
      },
      {
        id: 'cidrs',
        accessorFn: (token) => token.allowed_cidrs?.length ?? 0,
        header: 'Source',
        cell: ({ row }) =>
          row.original.allowed_cidrs ? (
            <span className="inline-flex max-w-44 items-center gap-1 truncate font-mono text-[11px] text-muted-foreground" title={row.original.allowed_cidrs.join(', ')}>
              <Network className="size-3 shrink-0 text-subtle-foreground" />
              <span className="truncate">{row.original.allowed_cidrs.join(', ')}</span>
            </span>
          ) : (
            <span className="text-subtle-foreground">Any address</span>
          ),
      },
      {
        id: 'used',
        accessorFn: (token) => token.last_used_at ?? '',
        header: 'Last used',
        cell: ({ row }) => (
          <div className="leading-tight">
            <RelativeTime value={row.original.last_used_at} className="text-muted-foreground" />
            {row.original.last_used_ip && <div className="font-mono text-[10.5px] text-subtle-foreground">{row.original.last_used_ip}</div>}
          </div>
        ),
      },
      {
        id: 'expires',
        accessorFn: (token) => token.expires_at,
        header: 'Expires',
        cell: ({ row }) => {
          const soon = !row.original.expired && new Date(row.original.expires_at).getTime() - Date.now() < 14 * 86_400_000
          return <span className={cn('tabular', row.original.expired ? 'text-critical' : soon ? 'text-warning' : 'text-muted-foreground')}>{formatDate(row.original.expires_at)}</span>
        },
      },
      {
        id: 'actions',
        enableSorting: false,
        header: () => <span className="sr-only">Actions</span>,
        meta: { align: 'right' },
        cell: ({ row }) => (
          <Button variant="ghost" size="xs" className="hover:text-critical" onClick={(event) => {
              event.stopPropagation()
              setRevoking(row.original)
            }}>
            <Trash data-icon="inline-start" />
            Revoke
          </Button>
        ),
      },
    )
    return defs
  }, [all, clients])

  return (
    <PageContainer className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title="API tokens"
        description="Personal access tokens for scripts and integrations (PSA, documentation, BI). A token acts as you, narrowed to the permissions and clients you choose."
        actions={
          <>
            <Button size="sm" variant="outline" render={<a href="/api/docs" target="_blank" rel="noopener" />} nativeButton={false}>
              <BookOpenText data-icon="inline-start" />
              API docs
              <SquareArrowOutUpRight data-icon="inline-end" />
            </Button>
            <Button size="sm" onClick={() => setSearch({ new: true })}>
              <Plus data-icon="inline-start" />
              New token
            </Button>
          </>
        }
      />

      <SettingsCard icon={<KeyRound />} title="Using a token" description="Send it as a bearer token; no CSRF header is needed. The OpenAPI 3.1 document lives at /api/openapi.json.">
        <div className="grid gap-3 px-4 py-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <pre className="overflow-x-auto rounded-lg bg-surface-3 px-3 py-2 font-mono text-[11.5px] leading-relaxed ring-1 ring-border">
            {`curl -H "Authorization: Bearer rrmm_pat_…" \\\n  ${window.location.origin}/api/v1/devices`}
          </pre>
          <ul className="grid content-start gap-1 text-dense text-muted-foreground">
            <li>· Its access is your current access, narrowed to the token; owner status never carries over.</li>
            <li>· Step-up actions, remote shells and desktops, and creating tokens are refused.</li>
            <li>· 600 requests per minute per token. Disabling your account invalidates your tokens.</li>
          </ul>
        </div>
      </SettingsCard>

      {canAll && (
        <Tabs value={view} onValueChange={(value) => setSearch({ tokens: value as 'mine' | 'all' })}>
          <TabsList variant="line" className="h-9 gap-4">
            <TabsTrigger value="mine" className="px-0">
              My tokens
            </TabsTrigger>
            <TabsTrigger value="all" className="px-0">
              Everyone’s tokens
            </TabsTrigger>
          </TabsList>
        </Tabs>
      )}

      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : !isLoading && tokens.length === 0 ? (
        <EmptyState
          illustration="security"
          title={all ? 'Nobody has an API token' : 'You have no API tokens'}
          description="Create a token for an integration; you’ll see it once, so store it in your secret manager."
          actions={
            <Button size="sm" onClick={() => setSearch({ new: true })}>
              New token
            </Button>
          }
        />
      ) : (
        <DataTable data={tokens} columns={columns} loading={isLoading} getRowId={(token) => token.id} initialSorting={[{ id: 'used', desc: true }]} caption="API tokens" rowClassName={(token) => token.expired && 'opacity-70'} />
      )}

      <CreateTokenDialog open={create} onOpenChange={(open) => !open && setSearch({ new: undefined })} />
      <ConfirmDialog
        open={Boolean(revoking)}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={`Revoke “${revoking?.name}”?`}
        description={`Anything using ${revoking ? displayPrefix(revoking.prefix) : 'it'}… stops working immediately. This cannot be undone.`}
        confirmLabel="Revoke token"
        pending={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking)}
      />
    </PageContainer>
  )
}

function CreateTokenDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [created, setCreated] = useState<ApiTokenCreated | null>(null)
  const [confirmClose, setConfirmClose] = useState(false)
  const [copied, setCopied] = useState(false)
  const close = () => {
    setCreated(null)
    setCopied(false)
    setConfirmClose(false)
    onOpenChange(false)
  }
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (next) return
          if (created && !copied) setConfirmClose(true)
          else close()
        }}
      >
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-[640px]" showCloseButton={!created}>
          {open && (created ? <ShowOnce created={created} copied={copied} onCopied={() => setCopied(true)} onDone={close} /> : <CreateForm onCreated={setCreated} onCancel={close} />)}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmClose}
        onOpenChange={setConfirmClose}
        title="Close without copying the token?"
        description="The token is shown only once. If you close now you’ll have to revoke it and create another."
        confirmLabel="Close anyway"
        onConfirm={close}
      />
    </>
  )
}

function CreateForm({ onCreated, onCancel }: { onCreated: (created: ApiTokenCreated) => void; onCancel: () => void }) {
  const me = useMe()
  const queryClient = useQueryClient()
  const { data: catalog = [] } = useQuery(permissionsQuery)
  const held = me?.permissions ?? []
  const grantable = grantablePermissions(catalog, held)
  const groups = [...new Set(grantable.map((permission) => permission.group))]
  const [name, setName] = useState('')
  const [permissions, setPermissions] = useState<string[]>(() => readOnlyPreset(held))
  const [clientIds, setClientIds] = useState<string[] | null>(null)
  const [expiryPreset, setExpiryPreset] = useState(String(TOKEN_DEFAULT_DAYS))
  const [customDate, setCustomDate] = useState(toDateInput(expiryFromDays(TOKEN_DEFAULT_DAYS)))
  const [cidrs, setCidrs] = useState<string[]>([])
  const [dateBounds] = useState(() => ({ min: toDateInput(new Date(Date.now() + 86_400_000)), max: toDateInput(maxExpiry()) }))
  const [attempted, setAttempted] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const expiresAt = expiryPreset === 'custom' ? endOfLocalDay(customDate) : expiryFromDays(Number(expiryPreset))
  const selected = permissionSubset(permissions, held, catalog)
  const errors = {
    name: !name.trim() ? 'Give the token a name' : name.trim().length > TOKEN_NAME_MAX ? `At most ${TOKEN_NAME_MAX} characters` : null,
    permissions: permissionsError(selected, held),
    clients: clientIds !== null && clientIds.length === 0 ? 'Choose at least one client, or allow all of them' : null,
    expiry: expiryError(expiresAt),
  }
  const invalid = Object.values(errors).some(Boolean)
  const show = (key: keyof typeof errors) => (attempted ? errors[key] : null)
  const toggle = (key: string) => setPermissions((prev) => (prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]))

  const create = useMutation({
    mutationFn: () => apiTokensApi.create({ name: name.trim(), permissions: selected, client_ids: clientIds, expires_at: expiresAt!.toISOString(), allowed_cidrs: cidrs.length ? cidrs : null }),
    meta: { silent: true },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: platformKeys.apiTokens })
      onCreated(result)
    },
    onError: (failure) => setServerError(isApiError(failure) && failure.code === 'step_up_required' ? 'Creating a token needs you to re-authenticate.' : errorMessage(failure)),
  })

  return (
    <form
      className="grid grid-cols-1 gap-5"
      onSubmit={(event) => {
        event.preventDefault()
        setAttempted(true)
        setServerError(null)
        if (!invalid) create.mutate()
      }}
    >
      <DialogHeader>
        <DialogTitle>New API token</DialogTitle>
        <DialogDescription>Grant only what the integration needs. You’ll be asked to re-authenticate.</DialogDescription>
      </DialogHeader>
      <Field data-invalid={Boolean(show('name')) || undefined}>
        <FieldLabel htmlFor="token-name">Name</FieldLabel>
        <Input id="token-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. PSA sync (HaloPSA)" maxLength={TOKEN_NAME_MAX} autoFocus />
        {show('name') && <FieldError>{show('name')}</FieldError>}
      </Field>

      <fieldset className="grid min-w-0 gap-2">
        <legend className="mb-1 flex w-full flex-wrap items-center justify-between gap-2">
          <span className="text-dense font-medium">
            Permissions <span className="tabular font-normal text-muted-foreground">· {selected.length} of {grantable.length}</span>
          </span>
          <span className="flex gap-1">
            <Button type="button" variant="ghost" size="xs" onClick={() => setPermissions(readOnlyPreset(held))}>
              Read-only
            </Button>
            <Button type="button" variant="ghost" size="xs" onClick={() => setPermissions(grantable.map((permission) => permission.key))}>
              Everything I hold
            </Button>
            <Button type="button" variant="ghost" size="xs" onClick={() => setPermissions([])}>
              None
            </Button>
          </span>
        </legend>
        <p className="text-micro text-muted-foreground">Only permissions you hold are listed; a token can never exceed its creator.</p>
        <div className="grid max-h-72 gap-3 overflow-y-auto rounded-lg p-3 ring-1 ring-border sm:grid-cols-2">
          {groups.map((group) => {
            const items = grantable.filter((permission) => permission.group === group)
            const all = items.every((permission) => selected.includes(permission.key))
            const some = !all && items.some((permission) => selected.includes(permission.key))
            return (
              <div key={group} className="grid content-start gap-1">
                <Label className="flex items-center gap-2 text-micro font-semibold tracking-wide text-subtle-foreground uppercase">
                  <Checkbox checked={all} indeterminate={some} onCheckedChange={() => setPermissions((prev) => (all ? prev.filter((key) => !items.some((item) => item.key === key)) : [...new Set([...prev, ...items.map((item) => item.key)])]))} />
                  {group}
                </Label>
                {items.map((permission) => (
                  <Label key={permission.key} className="flex items-start gap-2 rounded-md px-1 py-0.5 text-dense font-normal hover:bg-surface-2">
                    <Checkbox checked={selected.includes(permission.key)} onCheckedChange={() => toggle(permission.key)} className="mt-0.5" />
                    <span className="min-w-0">
                      <span className="block truncate">{permission.label}</span>
                      <span className={cn('block font-mono text-[10.5px]', permission.risk === 'high' ? 'text-warning' : 'text-subtle-foreground')}>{permission.key}</span>
                    </span>
                  </Label>
                ))}
              </div>
            )
          })}
        </div>
        {show('permissions') && <p className="text-dense text-critical">{show('permissions')}</p>}
      </fieldset>

      <Field data-invalid={Boolean(show('clients')) || undefined}>
        <FieldLabel>Clients</FieldLabel>
        <ClientScopePicker value={clientIds} onChange={setClientIds} allLabel="All my clients" allDescription="Your full scope, as it changes." idPrefix="token" />
        {show('clients') && <FieldError>{show('clients')}</FieldError>}
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field data-invalid={Boolean(show('expiry')) || undefined}>
          <FieldLabel htmlFor="token-expiry">Expires</FieldLabel>
          <SimpleSelect id="token-expiry" value={expiryPreset} onValueChange={setExpiryPreset} options={[...EXPIRY_PRESETS.map((preset) => ({ value: String(preset.days), label: preset.label })), { value: 'custom', label: 'Custom date' }]} />
          {expiryPreset === 'custom' && <Input type="date" aria-label="Expiry date" value={customDate} min={dateBounds.min} max={dateBounds.max} onChange={(event) => setCustomDate(event.target.value)} />}
          {show('expiry') ? <FieldError>{show('expiry')}</FieldError> : <FieldDescription>{expiresAt ? `On ${formatDate(expiresAt)}` : '—'} · one year at most.</FieldDescription>}
        </Field>
        <Field>
          <FieldLabel htmlFor="token-cidrs">Allowed source addresses</FieldLabel>
          <TokenInput id="token-cidrs" value={cidrs} onChange={setCidrs} placeholder="203.0.113.0/24, 2001:db8::/32" validate={cidrError} max={MAX_CIDRS} mono />
          <FieldDescription>IPs or CIDR blocks (IPv4 or IPv6). Empty allows any address.</FieldDescription>
        </Field>
      </div>

      {serverError && (
        <p role="alert" className="flex items-start gap-2 text-dense text-critical">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          {serverError}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={create.isPending}>
          {create.isPending && <Spinner data-icon="inline-start" />}
          Create token
        </Button>
      </DialogFooter>
    </form>
  )
}

function ShowOnce({ created, copied, onCopied, onDone }: { created: ApiTokenCreated; copied: boolean; onCopied: () => void; onDone: () => void }) {
  const [acknowledged, setAcknowledged] = useState(false)
  async function copy() {
    if (await copyText(created.token)) {
      onCopied()
      toast.success('Token copied')
    } else toast.error('Clipboard access was blocked; select the token and copy it manually.')
  }
  return (
    <div className="grid gap-5">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-full bg-success/15 text-success ring-1 ring-success/30">
            <Check className="size-4" />
          </span>
          “{created.item.name}” is ready
        </DialogTitle>
        <DialogDescription>Copy it now and store it in your password or secret manager.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-2 rounded-xl bg-warning/[0.07] p-4 ring-1 ring-warning/30">
        <p className="flex items-center gap-2 text-dense font-semibold text-warning">
          <CircleAlert className="size-4" />
          You won’t see this token again
        </p>
        <p className="text-micro text-muted-foreground">Only its SHA-256 hash is stored. If you lose it, revoke it and create a new one.</p>
        <div className="mt-1 flex min-w-0 items-center gap-2 rounded-lg bg-surface-1 p-2 ring-1 ring-border-strong">
          <code className="min-w-0 flex-1 font-mono text-[12.5px] break-all select-all" aria-label="API token">
            {created.token}
          </code>
          <Button type="button" size="sm" onClick={() => void copy()} variant={copied ? 'outline' : 'default'}>
            {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      </div>
      <dl className="grid gap-1 text-dense sm:grid-cols-2">
        <div className="flex gap-2">
          <dt className="text-muted-foreground">Expires</dt>
          <dd>{formatDate(created.item.expires_at)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted-foreground">Access</dt>
          <dd>
            {created.item.permissions.length} permissions · {created.item.client_ids ? `${created.item.client_ids.length} clients` : 'all your clients'}
          </dd>
        </div>
      </dl>
      <Label className="flex items-start gap-2 text-dense font-normal">
        <Checkbox checked={acknowledged} onCheckedChange={(value) => setAcknowledged(Boolean(value))} className="mt-0.5" />I stored the token somewhere safe
      </Label>
      <DialogFooter>
        <Button type="button" onClick={onDone} disabled={!acknowledged && !copied}>
          Done
        </Button>
      </DialogFooter>
    </div>
  )
}
