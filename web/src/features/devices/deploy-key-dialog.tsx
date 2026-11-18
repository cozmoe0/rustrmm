import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, EyeOff, KeyRound, ShieldCheck, TriangleExclamationPoint } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { CopyButton } from '@/components/common/copy-button'
import { SimpleSelect } from '@/components/common/simple-select'
import { TokenInput } from '@/components/common/token-input'
import { enrollmentApi } from '@/lib/api/endpoints'
import { clientsQuery, keys, sitesQuery } from '@/lib/api/queries'
import type { EnrollmentTokenCreate } from '@/lib/api/types'
import { cidrError, domainError, maskDeployKey } from '@/lib/deploy'
import { InstallerDownloads } from './installer-downloads'

export function NewDeployKeyDialog({
  open,
  onOpenChange,
  defaultClientId,
  defaultSiteId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultClientId?: string
  defaultSiteId?: string
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {open && <DeployKeyFlow defaultClientId={defaultClientId} defaultSiteId={defaultSiteId} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

interface Draft {
  clientId: string | null
  siteId: string | null
  name: string
  expires: boolean
  expiresInDays: string
  limitUses: boolean
  maxUses: string
  requireApproval: boolean
  domains: string[]
  cidrs: string[]
}

function validate(draft: Draft): Partial<Record<'site' | 'name' | 'expires' | 'uses', string>> {
  const errors: Partial<Record<'site' | 'name' | 'expires' | 'uses', string>> = {}
  if (!draft.siteId) errors.site = 'Choose the site devices will join'
  if (draft.name.trim().length < 2) errors.name = 'Give the key a name you will recognise later'
  else if (draft.name.trim().length > 80) errors.name = 'Keep it under 80 characters'
  const days = Number(draft.expiresInDays)
  if (draft.expires && (!Number.isInteger(days) || days < 1 || days > 365)) errors.expires = 'Between 1 and 365 days'
  const uses = Number(draft.maxUses)
  if (draft.limitUses && (!Number.isInteger(uses) || uses < 1 || uses > 10_000)) errors.uses = 'Between 1 and 10,000'
  return errors
}

function DeployKeyFlow({
  defaultClientId,
  defaultSiteId,
  onClose,
}: {
  defaultClientId?: string
  defaultSiteId?: string
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const { data: clients = [] } = useQuery(clientsQuery())
  const [draft, setDraft] = useState<Draft>({
    clientId: defaultClientId ?? null,
    siteId: defaultSiteId ?? null,
    name: '',
    expires: true,
    expiresInDays: '30',
    limitUses: false,
    maxUses: '25',
    requireApproval: false,
    domains: [],
    cidrs: [],
  })
  const [submitted, setSubmitted] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const { data: sites = [] } = useQuery({ ...sitesQuery(draft.clientId ?? undefined), enabled: Boolean(draft.clientId) })
  const errors = validate(draft)
  const update = (patch: Partial<Draft>) => setDraft((prev) => ({ ...prev, ...patch }))

  const create = useMutation({
    mutationFn: () => {
      const body: EnrollmentTokenCreate = {
        name: draft.name.trim(),
        require_approval: draft.requireApproval,
        allowed_domains: draft.domains,
        allowed_cidrs: draft.cidrs,
        ...(draft.expires ? { expires_in_days: Number(draft.expiresInDays) } : {}),
        ...(draft.limitUses ? { max_uses: Number(draft.maxUses) } : {}),
      }
      return enrollmentApi.create(draft.siteId!, body)
    },
    meta: { successMessage: 'Deploy key created' },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.enrollment }),
  })

  const site = sites.find((item) => item.id === draft.siteId)
  const client = clients.find((item) => item.id === draft.clientId)

  if (create.data) {
    const key = create.data.deploy_key
    return (
      <>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-lg bg-live/15 text-live">
              <KeyRound className="size-4" />
            </span>
            Deploy key ready
          </DialogTitle>
          <DialogDescription>
            Devices installed with this key join <span className="font-medium text-foreground">{client?.name}</span> /{' '}
            <span className="font-medium text-foreground">{site?.name}</span>
            {draft.requireApproval ? ' and wait for your approval.' : ' automatically.'}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <span className="text-dense font-medium">Deploy key</span>
            <div className="flex items-center gap-1 rounded-lg bg-surface-2 py-1 pr-1 pl-3 ring-1 ring-border">
              <code className="min-w-0 flex-1 truncate font-mono text-[12px]" title={revealed ? key : undefined}>
                {revealed ? key : maskDeployKey(key)}
              </code>
              <Button variant="ghost" size="icon-xs" aria-label={revealed ? 'Hide deploy key' : 'Show deploy key'} onClick={() => setRevealed((value) => !value)}>
                {revealed ? <EyeOff /> : <Eye />}
              </Button>
              <CopyButton value={key} label="Copy deploy key" />
            </div>
            <p className="flex items-start gap-1.5 text-micro text-muted-foreground">
              <TriangleExclamationPoint className="mt-px size-3.5 shrink-0 text-warning" />
              Treat it like a password: anyone holding it can enroll machines into this site until it expires, runs out of uses or is revoked.
            </p>
          </div>
          <div className="grid gap-2">
            <span className="text-dense font-medium">Download an installer</span>
            <InstallerDownloads tokenId={create.data.id} />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </>
    )
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>New deploy key</DialogTitle>
        <DialogDescription>A deploy key enrolls agents into one site. Scope it tightly and let it expire.</DialogDescription>
      </DialogHeader>
      <form
        id="new-deploy-key"
        noValidate
        className="max-h-[62vh] overflow-y-auto pr-1"
        onSubmit={(event) => {
          event.preventDefault()
          setSubmitted(true)
          if (Object.keys(errors).length === 0) create.mutate()
        }}
      >
        <FieldGroup className="gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="key-client">Client</FieldLabel>
              <SimpleSelect
                id="key-client"
                value={draft.clientId}
                onValueChange={(value) => update({ clientId: value, siteId: null })}
                placeholder="Choose a client…"
                options={clients.map((item) => ({ value: item.id, label: item.name }))}
              />
            </Field>
            <Field data-invalid={(submitted && Boolean(errors.site)) || undefined}>
              <FieldLabel htmlFor="key-site">Site</FieldLabel>
              <SimpleSelect
                id="key-site"
                value={draft.siteId}
                onValueChange={(value) => update({ siteId: value })}
                placeholder={draft.clientId ? 'Choose a site…' : 'Pick a client first'}
                disabled={!draft.clientId}
                ariaInvalid={submitted && Boolean(errors.site)}
                options={sites.map((item) => ({ value: item.id, label: item.name }))}
              />
              {submitted && <FieldError>{errors.site}</FieldError>}
            </Field>
          </div>
          <Field data-invalid={(submitted && Boolean(errors.name)) || undefined}>
            <FieldLabel htmlFor="key-name">Name</FieldLabel>
            <Input
              id="key-name"
              autoFocus
              value={draft.name}
              maxLength={80}
              placeholder="Front office rollout"
              aria-invalid={(submitted && Boolean(errors.name)) || undefined}
              onChange={(event) => update({ name: event.target.value })}
            />
            {submitted && <FieldError>{errors.name}</FieldError>}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field data-invalid={(submitted && Boolean(errors.expires)) || undefined}>
              <div className="flex items-center justify-between">
                <FieldLabel htmlFor="key-expiry">Expires after</FieldLabel>
                <label className="flex items-center gap-1.5 text-micro text-muted-foreground">
                  <Switch size="sm" checked={draft.expires} onCheckedChange={(value) => update({ expires: value })} aria-label="Key expires" />
                  {draft.expires ? 'On' : 'Never'}
                </label>
              </div>
              <div className="relative">
                <Input
                  id="key-expiry"
                  type="number"
                  min={1}
                  max={365}
                  inputMode="numeric"
                  disabled={!draft.expires}
                  value={draft.expires ? draft.expiresInDays : ''}
                  placeholder="No expiry"
                  className="pr-12"
                  onChange={(event) => update({ expiresInDays: event.target.value })}
                />
                <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-dense text-subtle-foreground">days</span>
              </div>
              {submitted && <FieldError>{errors.expires}</FieldError>}
            </Field>
            <Field data-invalid={(submitted && Boolean(errors.uses)) || undefined}>
              <div className="flex items-center justify-between">
                <FieldLabel htmlFor="key-uses">Max enrollments</FieldLabel>
                <label className="flex items-center gap-1.5 text-micro text-muted-foreground">
                  <Switch size="sm" checked={draft.limitUses} onCheckedChange={(value) => update({ limitUses: value })} aria-label="Limit enrollments" />
                  {draft.limitUses ? 'On' : 'Unlimited'}
                </label>
              </div>
              <Input
                id="key-uses"
                type="number"
                min={1}
                max={10000}
                inputMode="numeric"
                disabled={!draft.limitUses}
                value={draft.limitUses ? draft.maxUses : ''}
                placeholder="Unlimited"
                onChange={(event) => update({ maxUses: event.target.value })}
              />
              {submitted && <FieldError>{errors.uses}</FieldError>}
            </Field>
          </div>
          <label className="flex items-start gap-3 rounded-lg bg-surface-2/70 p-3 ring-1 ring-border">
            <Switch checked={draft.requireApproval} onCheckedChange={(value) => update({ requireApproval: value })} className="mt-0.5" />
            <span className="grid gap-0.5">
              <span className="flex items-center gap-1.5 text-dense font-medium">
                <ShieldCheck className="size-3.5 text-subtle-foreground" />
                Require approval
              </span>
              <span className="text-micro text-muted-foreground">
                New devices wait in Awaiting approval until a technician approves them. Recommended for keys shared outside IT.
              </span>
            </span>
          </label>
          <Field>
            <FieldLabel htmlFor="key-domains">Allowed domains</FieldLabel>
            <TokenInput
              id="key-domains"
              value={draft.domains}
              onChange={(domains) => update({ domains })}
              normalize={(value) => value.trim().toLowerCase().replace(/\.$/, '')}
              validate={domainError}
              max={20}
              mono
              placeholder="corp.example.com"
            />
            <FieldDescription>Only machines joined to these AD / DNS domains can enroll. Leave empty to allow any.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="key-cidrs">Allowed networks</FieldLabel>
            <TokenInput
              id="key-cidrs"
              value={draft.cidrs}
              onChange={(cidrs) => update({ cidrs })}
              normalize={(value) => value.trim().toLowerCase()}
              validate={cidrError}
              max={20}
              mono
              placeholder="10.40.0.0/16"
            />
            <FieldDescription>Enrollment requests must come from these source networks (as seen by the server).</FieldDescription>
          </Field>
        </FieldGroup>
      </form>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" form="new-deploy-key" disabled={create.isPending}>
          {create.isPending && <Spinner data-icon="inline-start" />}
          Create deploy key
        </Button>
      </DialogFooter>
    </>
  )
}
