/* Settings → Webhooks: signed outbound events with delivery history, test, redeliver and receiver help. */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Check, CircleAlert, CircleCheck, Clock, Code, Copy, Ellipsis, History, LoaderCircle, Pencil, Plus, RefreshCw, Send, ShieldAlert, Trash, Webhook as WebhookIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { CopyButton } from '@/components/common/copy-button'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, RelativeTime } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { SecretInput } from '@/features/notifications/notification-ui'
import { FilterPill } from '@/features/patching/patching-ui'
import { webhooksApi } from '@/lib/api/endpoints'
import { errorMessage, isApiError } from '@/lib/api/errors'
import { clientsQuery, platformKeys, webhookDeliveriesQuery, webhooksQuery } from '@/lib/api/queries'
import type { Webhook, WebhookDelivery, WebhookDeliveryStatus, WebhookEvent, WebhookInput } from '@/lib/api/types'
import { copyText } from '@/lib/clipboard'
import type { SecretDraft } from '@/lib/notifications/channels'
import { formatDateTime } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { RETRY_SCHEDULE, VERIFY_SNIPPETS, WEBHOOK_EVENTS, eventLabel, generateSecret, isInsecureUrl, webhookSecretError, webhookUrlError } from '@/lib/webhooks'
import { ClientScopePicker, SettingsCard } from './platform-ui'

function DeliveryBadge({ delivery }: { delivery: Pick<WebhookDelivery, 'status' | 'attempts'> }) {
  if (delivery.status === 'delivered')
    return (
      <Badge variant="success">
        <CircleCheck />
        Delivered
      </Badge>
    )
  if (delivery.status === 'failed')
    return (
      <Badge variant="critical">
        <CircleAlert />
        Failed
      </Badge>
    )
  if (delivery.status === 'sending')
    return (
      <Badge variant="live">
        <LoaderCircle className="animate-spin" />
        Sending
      </Badge>
    )
  return (
    <Badge variant={delivery.attempts > 0 ? 'warning' : 'secondary'}>
      <Clock />
      {delivery.attempts > 0 ? 'Retrying' : 'Pending'}
    </Badge>
  )
}

export function WebhooksPage({ search }: { search: { webhook?: string; edit?: string } }) {
  useTitle('Webhooks')
  const me = useMe()
  const navigate = useNavigate({ from: '/settings/webhooks' })
  const queryClient = useQueryClient()
  const canManage = hasPermission(me, PERMISSIONS.apiManage)
  const { data, isLoading, error, refetch } = useQuery({ ...webhooksQuery, enabled: canManage })
  const { data: clients = [] } = useQuery(clientsQuery())
  const [deleting, setDeleting] = useState<Webhook | null>(null)
  const [revealed, setRevealed] = useState<{ name: string; secret: string } | null>(null)
  const webhooks = data?.items ?? []
  const editing = search.edit && search.edit !== 'new' ? (webhooks.find((item) => item.id === search.edit) ?? null) : null
  const viewing = search.webhook ? (webhooks.find((item) => item.id === search.webhook) ?? null) : null
  const setSearch = (patch: { webhook?: string; edit?: string }) => void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })
  const refresh = () => void queryClient.invalidateQueries({ queryKey: platformKeys.webhooks })

  const test = useMutation({
    mutationFn: (webhook: Webhook) => webhooksApi.test(webhook.id),
    meta: { silent: true },
    onSuccess: (delivery, webhook) => {
      if (delivery.status === 'delivered') toast.success(`Test delivered to ${webhook.name}`, { description: `HTTP ${delivery.response_status ?? 200}` })
      else toast.error(`Test to ${webhook.name} failed`, { description: delivery.error ?? `HTTP ${delivery.response_status}` })
      refresh()
    },
    onError: (failure) => toast.error(errorMessage(failure)),
  })
  const toggle = useMutation({
    mutationFn: (webhook: Webhook) => webhooksApi.update(webhook.id, { name: webhook.name, url: webhook.url, events: webhook.events, client_ids: webhook.client_ids, enabled: !webhook.enabled }),
    meta: { silent: true },
    onSuccess: (saved) => {
      toast.success(saved.enabled ? `${saved.name} enabled` : `${saved.name} paused`)
      refresh()
    },
    onError: (failure) => toast.error(errorMessage(failure)),
  })
  const remove = useMutation({
    mutationFn: (webhook: Webhook) => webhooksApi.remove(webhook.id),
    meta: { silent: true },
    onSuccess: (_result, webhook) => {
      toast.success(`Deleted ${webhook.name}`)
      setDeleting(null)
      refresh()
    },
    onError: (failure) => toast.error(errorMessage(failure)),
  })

  if (!canManage) {
    return (
      <PageContainer>
        <EmptyState illustration="automation" title="Webhooks need “Manage API access”" description="Ask an administrator for the Manage API access permission to send events to other systems." />
      </PageContainer>
    )
  }

  return (
    <PageContainer className="grid max-w-5xl grid-cols-1 gap-5">
      <PageHeader
        title="Webhooks"
        description="Push events to your PSA, chat or SIEM as signed JSON. Failed deliveries retry with backoff for 24 hours."
        actions={
          <Button size="sm" onClick={() => setSearch({ edit: 'new' })}>
            <Plus data-icon="inline-start" />
            New webhook
          </Button>
        }
      />
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isLoading ? (
        <div className="grid gap-3">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-28 rounded-xl" />
          ))}
        </div>
      ) : webhooks.length === 0 ? (
        <EmptyState
          illustration="automation"
          title="No webhooks yet"
          description="Send new tickets to your PSA, alerts to a chat relay or secret reveals to your SIEM."
          actions={
            <Button size="sm" onClick={() => setSearch({ edit: 'new' })}>
              New webhook
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3">
          {webhooks.map((webhook) => (
            <article key={webhook.id} className={cn('grid min-w-0 gap-3 rounded-xl bg-card p-4 shadow-card lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] lg:items-start', !webhook.enabled && 'opacity-80')}>
              <div className="flex min-w-0 items-start gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-muted-foreground ring-1 ring-border">
                  <WebhookIcon className="size-4" />
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <h3 className="truncate text-sm font-semibold">{webhook.name}</h3>
                    {!webhook.enabled && <Badge variant="outline">Paused</Badge>}
                    {isInsecureUrl(webhook.url) && <Badge variant="warning">http</Badge>}
                  </div>
                  <p className="truncate font-mono text-[11.5px] text-muted-foreground" title={webhook.url}>
                    {webhook.url}
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {webhook.events.map((event) => (
                      <span key={event} className="inline-flex h-5 items-center rounded-[5px] bg-surface-3 px-1.5 font-mono text-[10.5px] text-secondary-foreground ring-1 ring-border">
                        {event}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
              <div className="grid min-w-0 content-start gap-1 text-dense">
                <span className="truncate text-muted-foreground">{webhook.client_ids === null ? 'Every client (and installation-wide events)' : webhook.client_ids.map((id) => clients.find((client) => client.id === id)?.name ?? 'Unknown client').join(', ')}</span>
                {webhook.last_delivery ? (
                  <span className={cn('flex min-w-0 items-center gap-1 text-micro', webhook.last_delivery.status === 'delivered' ? 'text-success' : webhook.last_delivery.status === 'retrying' ? 'text-warning' : 'text-critical')}>
                    {webhook.last_delivery.status === 'delivered' ? <CircleCheck className="size-3 shrink-0" /> : webhook.last_delivery.status === 'retrying' ? <RefreshCw className="size-3 shrink-0" /> : <CircleAlert className="size-3 shrink-0" />}
                    <span className="truncate">
                      {webhook.last_delivery.status === 'delivered' ? 'Delivered' : webhook.last_delivery.status === 'retrying' ? 'Retrying' : 'Failed'} <RelativeTime value={webhook.last_delivery.at} />
                      {webhook.last_delivery.error && ` · ${webhook.last_delivery.error}`}
                    </span>
                  </span>
                ) : (
                  <span className="text-micro text-subtle-foreground">No deliveries yet</span>
                )}
              </div>
              <div className="flex items-center gap-1.5 lg:justify-end">
                <Switch checked={webhook.enabled} onCheckedChange={() => toggle.mutate(webhook)} disabled={toggle.isPending && toggle.variables?.id === webhook.id} aria-label={webhook.enabled ? `Pause ${webhook.name}` : `Enable ${webhook.name}`} />
                <Button variant="outline" size="sm" onClick={() => setSearch({ webhook: webhook.id })}>
                  <History data-icon="inline-start" />
                  Deliveries
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`More for ${webhook.name}`} />}>
                    <Ellipsis />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48">
                    <DropdownMenuItem onClick={() => test.mutate(webhook)} disabled={test.isPending}>
                      <Send />
                      Send a test
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setSearch({ edit: webhook.id })}>
                      <Pencil />
                      Edit webhook
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={() => setDeleting(webhook)}>
                      <Trash />
                      Delete webhook
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </article>
          ))}
        </div>
      )}

      <SignatureHelp />

      <WebhookEditor
        webhook={editing}
        open={search.edit === 'new' || Boolean(editing)}
        onOpenChange={(open) => !open && setSearch({ edit: undefined })}
        onSaved={(saved) => {
          refresh()
          if (saved.secret) setRevealed({ name: saved.name, secret: saved.secret })
        }}
      />
      <DeliveriesSheet webhook={viewing} onOpenChange={(open) => !open && setSearch({ webhook: undefined })} />
      <SecretOnce revealed={revealed} onClose={() => setRevealed(null)} />
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name}?`}
        description="No more events are sent to it, and its delivery history is removed."
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </PageContainer>
  )
}

function SignatureHelp() {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <SettingsCard
        icon={<ShieldAlert />}
        title="Verify signatures"
        description="Every delivery is signed with the webhook’s secret. Check the signature and timestamp before trusting the payload."
        actions={
          <CollapsibleTrigger render={<Button variant="outline" size="sm" />}>
            <Code data-icon="inline-start" />
            {open ? 'Hide code' : 'Show code'}
          </CollapsibleTrigger>
        }
      >
        <div className="grid gap-2 px-4 py-3 text-dense text-muted-foreground">
          <p>
            Headers: <code className="font-mono text-[12px] text-foreground">X-RustRMM-Event</code>, <code className="font-mono text-[12px] text-foreground">X-RustRMM-Delivery</code> and{' '}
            <code className="font-mono text-[12px] text-foreground">X-RustRMM-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</code>, where <span className="font-mono text-[12px] text-foreground">v1</span> is the HMAC-SHA256 of{' '}
            <span className="font-mono text-[12px] text-foreground">&lt;t&gt;.&lt;raw body&gt;</span> keyed with the secret. Reject old timestamps and compare in constant time.
          </p>
          <p className="text-micro">Any 2xx counts as delivered. Retries: {RETRY_SCHEDULE.join(', ')}. The event id stays the same on redelivery, so receivers can de-duplicate.</p>
        </div>
        <CollapsibleContent>
          <Tabs defaultValue={VERIFY_SNIPPETS[0].id} className="gap-0 border-t border-border">
            <div className="flex items-center justify-between gap-2 px-4 pt-2">
              <TabsList variant="line" className="h-8 gap-4">
                {VERIFY_SNIPPETS.map((snippet) => (
                  <TabsTrigger key={snippet.id} value={snippet.id} className="px-0">
                    {snippet.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
            {VERIFY_SNIPPETS.map((snippet) => (
              <TabsContent key={snippet.id} value={snippet.id} className="relative px-4 pt-2 pb-4">
                <CopyButton value={snippet.code} label={`Copy ${snippet.label} code`} className="absolute top-3.5 right-5.5 z-[1]" />
                <pre className="max-h-80 overflow-auto rounded-lg bg-surface-3 px-3 py-2.5 font-mono text-[11.5px] leading-relaxed ring-1 ring-border">{snippet.code}</pre>
              </TabsContent>
            ))}
          </Tabs>
        </CollapsibleContent>
      </SettingsCard>
    </Collapsible>
  )
}

function WebhookEditor({ webhook, open, onOpenChange, onSaved }: { webhook: Webhook | null; open: boolean; onOpenChange: (open: boolean) => void; onSaved: (saved: Webhook) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-[640px]">{open && <WebhookForm key={webhook?.id ?? 'new'} webhook={webhook} onDone={() => onOpenChange(false)} onSaved={onSaved} />}</DialogContent>
    </Dialog>
  )
}

function WebhookForm({ webhook, onDone, onSaved }: { webhook: Webhook | null; onDone: () => void; onSaved: (saved: Webhook) => void }) {
  const [name, setName] = useState(webhook?.name ?? '')
  const [url, setUrl] = useState(webhook?.url ?? 'https://')
  const [events, setEvents] = useState<WebhookEvent[]>(webhook?.events ?? ['alert.opened', 'ticket.created'])
  const [clientIds, setClientIds] = useState<string[] | null>(webhook?.client_ids ?? null)
  const [enabled, setEnabled] = useState(webhook?.enabled ?? true)
  const [secretMode, setSecretMode] = useState<'generate' | 'own'>('generate')
  const [secret, setSecret] = useState<SecretDraft>(webhook ? { stored: true, mode: 'keep', value: '' } : { stored: false, mode: 'replace', value: '' })
  const [attempted, setAttempted] = useState(false)
  const [serverError, setServerError] = useState<{ path: string; message: string } | null>(null)
  const ownSecret = webhook ? secret.mode === 'replace' : secretMode === 'own'
  const errors = {
    name: name.trim() ? null : 'Enter a name',
    url: webhookUrlError(url),
    events: events.length ? null : 'Choose at least one event',
    clients: clientIds !== null && clientIds.length === 0 ? 'Choose a client, or send events for every client' : null,
    secret: ownSecret ? webhookSecretError(secret.value) : null,
  }
  const invalid = Object.values(errors).some(Boolean)
  const show = (key: keyof typeof errors) => (attempted ? errors[key] : null) ?? (serverError?.path === key ? serverError.message : null)
  const groups = [...new Set(WEBHOOK_EVENTS.map((item) => item.group))]

  const save = useMutation({
    mutationFn: () => {
      const body: WebhookInput = { name: name.trim(), url: url.trim(), events, client_ids: clientIds, enabled, ...(ownSecret ? { secret: secret.value } : {}) }
      return webhook ? webhooksApi.update(webhook.id, body) : webhooksApi.create(body)
    },
    meta: { silent: true },
    onSuccess: (saved) => {
      toast.success(webhook ? `Saved ${saved.name}` : `Created ${saved.name}`)
      onSaved(saved)
      onDone()
    },
    onError: (failure) => {
      if (isApiError(failure) && failure.status === 422) setServerError({ path: String((failure.details as { path?: string } | undefined)?.path ?? ''), message: failure.message })
      else toast.error(errorMessage(failure))
    },
  })

  return (
    <form
      className="grid grid-cols-1 gap-5"
      onSubmit={(event) => {
        event.preventDefault()
        setAttempted(true)
        setServerError(null)
        if (!invalid) save.mutate()
      }}
    >
      <DialogHeader>
        <DialogTitle>{webhook ? `Edit ${webhook.name}` : 'New webhook'}</DialogTitle>
        <DialogDescription>Deliveries go through the SSRF guard: private and loopback targets need the monitoring allowlist.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <Field data-invalid={Boolean(show('name')) || undefined}>
          <FieldLabel htmlFor="webhook-name">Name</FieldLabel>
          <Input id="webhook-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="PSA ticket bridge" />
          {show('name') && <FieldError>{show('name')}</FieldError>}
        </Field>
        <Field data-invalid={Boolean(show('url')) || undefined}>
          <FieldLabel htmlFor="webhook-url">Receiver URL</FieldLabel>
          <Input id="webhook-url" className="font-mono text-[12.5px]" value={url} onChange={(event) => setUrl(event.target.value)} spellCheck={false} />
          {show('url') ? <FieldError>{show('url')}</FieldError> : isInsecureUrl(url) ? <FieldDescription className="text-warning">Plain http: payloads travel unencrypted. Prefer https.</FieldDescription> : null}
        </Field>
      </div>

      <fieldset className="grid min-w-0 gap-2">
        <legend className="mb-1 text-dense font-medium">Events</legend>
        <div className="grid gap-3 rounded-lg p-3 ring-1 ring-border sm:grid-cols-2">
          {groups.map((group) => (
            <div key={group} className="grid content-start gap-1">
              <span className="text-micro font-semibold tracking-wide text-subtle-foreground uppercase">{group}</span>
              {WEBHOOK_EVENTS.filter((item) => item.group === group).map((item) => (
                <Label key={item.event} className="flex items-start gap-2 rounded-md px-1 py-0.5 text-dense font-normal hover:bg-surface-2">
                  <Checkbox checked={events.includes(item.event)} onCheckedChange={() => setEvents((prev) => (prev.includes(item.event) ? prev.filter((event) => event !== item.event) : [...prev, item.event]))} className="mt-0.5" />
                  <span className="min-w-0">
                    <span className="block">{item.label}</span>
                    <span className="block text-micro text-muted-foreground">{item.description}</span>
                  </span>
                </Label>
              ))}
            </div>
          ))}
        </div>
        {show('events') && <p className="text-dense text-critical">{show('events')}</p>}
      </fieldset>

      <Field data-invalid={Boolean(show('clients')) || undefined}>
        <FieldLabel>Clients</FieldLabel>
        <ClientScopePicker value={clientIds} onChange={setClientIds} allDescription="Includes installation-wide events without a client." idPrefix="webhook" />
        {show('clients') && <FieldError>{show('clients')}</FieldError>}
      </Field>

      <Field data-invalid={Boolean(show('secret')) || undefined}>
        <FieldLabel htmlFor="webhook-secret">Signing secret</FieldLabel>
        {webhook ? (
          <SecretInput id="webhook-secret" secret={secret} onChange={setSecret} placeholder="16–256 characters" />
        ) : (
          <div className="grid gap-2">
            <div role="radiogroup" aria-label="Signing secret" className="grid gap-2 sm:grid-cols-2">
              {(['generate', 'own'] as const).map((mode) => (
                <button key={mode} type="button" role="radio" aria-checked={secretMode === mode} onClick={() => setSecretMode(mode)} className={cn('rounded-lg p-2.5 text-left ring-1 ring-border outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring', secretMode === mode && 'bg-primary/[0.06] ring-primary/40')}>
                  <span className="block text-dense font-medium">{mode === 'generate' ? 'Generate one for me' : 'Use my own'}</span>
                  <span className="block text-micro text-muted-foreground">{mode === 'generate' ? 'Shown once after you create the webhook.' : 'Paste the secret your receiver expects.'}</span>
                </button>
              ))}
            </div>
            {secretMode === 'own' && <Input id="webhook-secret" className="font-mono text-[12.5px]" value={secret.value} onChange={(event) => setSecret({ ...secret, value: event.target.value })} placeholder="16–256 characters" autoComplete="off" spellCheck={false} />}
          </div>
        )}
        {ownSecret && (
          <Button type="button" variant="ghost" size="xs" className="w-fit" onClick={() => setSecret({ stored: Boolean(webhook), mode: 'replace', value: generateSecret() })}>
            <RefreshCw data-icon="inline-start" />
            Generate a random secret
          </Button>
        )}
        {show('secret') && <FieldError>{show('secret')}</FieldError>}
      </Field>

      <label className="flex items-center justify-between gap-4 rounded-lg px-3 py-2.5 ring-1 ring-border">
        <span className="text-dense font-medium">Enabled</span>
        <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enabled" />
      </label>
      {serverError && !['name', 'url', 'events', 'secret', 'client_ids'].includes(serverError.path) && (
        <p role="alert" className="text-dense text-critical">
          {serverError.message}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending && <Spinner data-icon="inline-start" />}
          {webhook ? 'Save webhook' : 'Create webhook'}
        </Button>
      </DialogFooter>
    </form>
  )
}

function SecretOnce({ revealed, onClose }: { revealed: { name: string; secret: string } | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <Dialog open={Boolean(revealed)} onOpenChange={(open) => !open && copied && onClose()}>
      <DialogContent className="sm:max-w-[560px]" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Signing secret for {revealed?.name}</DialogTitle>
          <DialogDescription>Configure your receiver with this secret now. It is shown only once.</DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 items-center gap-2 rounded-lg bg-warning/[0.07] p-2 ring-1 ring-warning/30">
          <code className="min-w-0 flex-1 font-mono text-[12.5px] break-all select-all">{revealed?.secret}</code>
          <Button
            size="sm"
            variant={copied ? 'outline' : 'default'}
            onClick={async () => {
              if (revealed && (await copyText(revealed.secret))) setCopied(true)
              else toast.error('Clipboard access was blocked; select the secret and copy it manually.')
            }}
          >
            {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <DialogFooter>
          <Button
            onClick={() => {
              setCopied(false)
              onClose()
            }}
            variant={copied ? 'default' : 'outline'}
          >
            {copied ? 'Done' : 'I saved it elsewhere'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DeliveriesSheet({ webhook, onOpenChange }: { webhook: Webhook | null; onOpenChange: (open: boolean) => void }) {
  return (
    <Sheet open={Boolean(webhook)} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="gap-0 p-0 shadow-popover data-[side=right]:w-full data-[side=right]:sm:max-w-[680px]">{webhook && <Deliveries key={webhook.id} webhook={webhook} />}</SheetContent>
    </Sheet>
  )
}

function Deliveries({ webhook }: { webhook: Webhook }) {
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<WebhookDeliveryStatus | undefined>(undefined)
  const [open, setOpen] = useState<string | null>(null)
  const { data: deliveries = [], isLoading, error, refetch } = useQuery(webhookDeliveriesQuery(webhook.id, status))
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['webhooks', 'deliveries', webhook.id] })
    void queryClient.invalidateQueries({ queryKey: platformKeys.webhooks })
  }
  const test = useMutation({
    mutationFn: () => webhooksApi.test(webhook.id),
    meta: { silent: true },
    onSuccess: (delivery) => {
      if (delivery.status === 'delivered') toast.success('Test delivered', { description: `HTTP ${delivery.response_status ?? 200}` })
      else toast.error('Test failed', { description: delivery.error ?? undefined })
      setOpen(delivery.id)
      refresh()
    },
    onError: (failure) => toast.error(errorMessage(failure)),
  })
  const redeliver = useMutation({
    mutationFn: (delivery: WebhookDelivery) => webhooksApi.redeliver(delivery.id),
    meta: { silent: true },
    onSuccess: () => {
      toast.success('Queued for redelivery', { description: 'Same event id, so receivers can de-duplicate.' })
      refresh()
    },
    onError: (failure) => toast.error(errorMessage(failure)),
  })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SheetHeader className="border-b border-border px-5 pt-5 pb-4">
        <SheetTitle>Deliveries · {webhook.name}</SheetTitle>
        <SheetDescription className="truncate font-mono text-[11.5px]">{webhook.url}</SheetDescription>
      </SheetHeader>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-5 py-2.5">
        {(['delivered', 'pending', 'failed'] as WebhookDeliveryStatus[]).map((value) => (
          <FilterPill key={value} active={status === value} onClick={() => setStatus(status === value ? undefined : value)}>
            <span className="capitalize">{value === 'pending' ? 'Pending / retrying' : value}</span>
          </FilterPill>
        ))}
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => test.mutate()} disabled={test.isPending}>
          {test.isPending ? <Spinner data-icon="inline-start" /> : <Send data-icon="inline-start" />}
          Send test
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <ErrorState error={error} onRetry={() => void refetch()} className="m-5" />
        ) : isLoading ? (
          <div className="grid gap-2 p-5">
            {Array.from({ length: 5 }, (_, index) => (
              <Skeleton key={index} className="h-12 rounded-lg" />
            ))}
          </div>
        ) : deliveries.length === 0 ? (
          <p className="px-5 py-8 text-center text-dense text-muted-foreground">No deliveries{status ? ' with this status' : ''} in the last 30 days.</p>
        ) : (
          <ul className="divide-y divide-border">
            {deliveries.map((delivery) => (
              <li key={delivery.id}>
                <button type="button" aria-expanded={open === delivery.id} onClick={() => setOpen(open === delivery.id ? null : delivery.id)} className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-5 py-2.5 text-left outline-none hover:bg-surface-2 focus-visible:bg-surface-2">
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-dense font-medium">{eventLabel(delivery.event)}</span>
                      {delivery.redelivery_of && <Badge variant="outline">Redelivery</Badge>}
                    </span>
                    <span className="tabular block truncate text-micro text-muted-foreground">
                      <RelativeTime value={delivery.created_at} /> · {delivery.attempts} {delivery.attempts === 1 ? 'attempt' : 'attempts'}
                      {delivery.response_status !== null && ` · HTTP ${delivery.response_status}`}
                      {delivery.error && ` · ${delivery.error}`}
                    </span>
                  </span>
                  <DeliveryBadge delivery={delivery} />
                </button>
                {open === delivery.id && (
                  <div className="grid gap-3 bg-surface-1/60 px-5 pt-1 pb-4">
                    <dl className="grid gap-x-4 gap-y-1 text-micro sm:grid-cols-2">
                      <div className="flex gap-2">
                        <dt className="text-muted-foreground">Delivery</dt>
                        <dd className="truncate font-mono">{delivery.id}</dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="text-muted-foreground">Event id</dt>
                        <dd className="truncate font-mono">{delivery.event_id}</dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="text-muted-foreground">Last attempt</dt>
                        <dd>{delivery.last_attempt_at ? formatDateTime(delivery.last_attempt_at) : '—'}</dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="text-muted-foreground">{delivery.status === 'delivered' ? 'Delivered' : 'Next attempt'}</dt>
                        <dd>{delivery.delivered_at ? formatDateTime(delivery.delivered_at) : delivery.next_attempt_at ? formatDateTime(delivery.next_attempt_at) : '—'}</dd>
                      </div>
                    </dl>
                    <div className="relative">
                      <CopyButton value={JSON.stringify(delivery.payload, null, 2)} label="Copy payload" className="absolute top-1.5 right-1.5 z-[1]" />
                      <pre className="max-h-72 overflow-auto rounded-lg bg-surface-3 px-3 py-2 font-mono text-[11.5px] leading-relaxed ring-1 ring-border">{JSON.stringify(delivery.payload, null, 2)}</pre>
                    </div>
                    <div className="flex justify-end">
                      <Button size="sm" variant="outline" onClick={() => redeliver.mutate(delivery)} disabled={redeliver.isPending}>
                        <RefreshCw data-icon="inline-start" />
                        Redeliver
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
