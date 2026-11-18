/* Create and edit a notification channel: pick the kind first, then the kind's fields. */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, CircleAlert, Info, KeyRound, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { ListInput } from '@/features/automation/list-input'
import { ChannelKindTile } from '@/features/monitoring/monitoring-ui'
import { notificationsApi } from '@/lib/api/endpoints'
import { errorMessage, isApiError } from '@/lib/api/errors'
import { keys, monitoringSettingsQuery } from '@/lib/api/queries'
import type { NotificationChannel, NotificationChannelKind } from '@/lib/api/types'
import { SECRET_MASK } from '@/lib/automation/params'
import { CHANNEL_KIND_DESCRIPTION, CHANNEL_KIND_LABEL, CHANNEL_KIND_ORDER } from '@/lib/monitoring/labels'
import {
  channelInput,
  draftFromChannel,
  emptyDraft,
  MAX_RECIPIENTS,
  newHeader,
  NTFY_DEFAULT_SERVER,
  validateChannelDraft,
  type ChannelDraft,
  type ChannelErrors,
  type HeaderDraft,
} from '@/lib/notifications/channels'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { cn } from '@/lib/utils'
import { SecretInput } from './notification-ui'

const WEBHOOK_HINT: Partial<Record<NotificationChannelKind, string>> = {
  slack: 'Slack → Apps → Incoming Webhooks → the URL for the channel to post in.',
  teams: 'In Teams, add a Power Automate “Workflows” flow that posts to a channel from a webhook request.',
  discord: 'Discord → Channel settings → Integrations → Webhooks → Copy webhook URL.',
}

function KindPicker({ onPick }: { onPick: (kind: NotificationChannelKind) => void }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {CHANNEL_KIND_ORDER.map((kind) => (
        <button
          key={kind}
          type="button"
          onClick={() => onPick(kind)}
          className="flex items-start gap-3 rounded-xl bg-card p-3 text-left shadow-card outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChannelKindTile kind={kind} />
          <span className="min-w-0">
            <span className="block text-dense font-medium">{CHANNEL_KIND_LABEL[kind]}</span>
            <span className="block text-micro text-muted-foreground">{CHANNEL_KIND_DESCRIPTION[kind]}</span>
          </span>
        </button>
      ))}
    </div>
  )
}

function HeadersEditor({
  headers,
  onChange,
  error,
}: {
  headers: HeaderDraft[]
  onChange: (headers: HeaderDraft[]) => void
  error?: string
}) {
  const set = (key: string, patch: Partial<HeaderDraft>) =>
    onChange(headers.map((header) => (header.key === key ? { ...header, ...patch } : header)))
  return (
    <Field data-invalid={Boolean(error) || undefined}>
      <FieldLabel>Headers</FieldLabel>
      {headers.length > 0 && (
        <ul className="grid grid-cols-1 gap-2">
          {headers.map((header) => (
            <li key={header.key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_auto]">
              <Input
                aria-label="Header name"
                className="font-mono text-[12.5px]"
                placeholder="X-Tenant"
                value={header.name}
                spellCheck={false}
                onChange={(event) =>
                  // A stored value belongs to its header name: renaming the header needs the value again.
                  set(header.key, {
                    name: event.target.value,
                    ...(header.stored && !header.replacing ? { replacing: true, value: '' } : {}),
                  })
                }
              />
              <div className="col-span-2 row-start-2 min-w-0 sm:col-span-1 sm:row-start-auto">
                {header.stored && !header.replacing ? (
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="flex h-(--control-h) min-w-0 flex-1 items-center gap-2 rounded-lg border border-input bg-surface-2 px-3 font-mono text-dense text-muted-foreground">
                      <KeyRound className="size-3.5 shrink-0" />
                      <span className="truncate">{SECRET_MASK} stored</span>
                    </div>
                    <Button type="button" variant="outline" size="sm" onClick={() => set(header.key, { replacing: true, value: '' })}>
                      Replace
                    </Button>
                  </div>
                ) : (
                  <Input
                    aria-label={`Value for ${header.name || 'header'}`}
                    type="password"
                    autoComplete="new-password"
                    className="font-mono text-[12.5px]"
                    placeholder="Value"
                    value={header.value}
                    onChange={(event) => set(header.key, { value: event.target.value })}
                  />
                )}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="row-start-1 self-center hover:text-critical sm:row-start-auto"
                aria-label={`Remove ${header.name || 'header'}`}
                onClick={() => onChange(headers.filter((item) => item.key !== header.key))}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={() => onChange([...headers, newHeader()])}>
        <Plus data-icon="inline-start" />
        Add header
      </Button>
      {error ? (
        <FieldError>{error}</FieldError>
      ) : (
        <FieldDescription>Header values are write-only, like the secret. Host, Content-Type and the signature header are set by RustRMM.</FieldDescription>
      )}
    </Field>
  )
}

function KindFields({
  draft,
  setDraft,
  errors,
}: {
  draft: ChannelDraft
  setDraft: (patch: Partial<ChannelDraft>) => void
  errors: ChannelErrors
}) {
  switch (draft.kind) {
    case 'email':
      return (
        <>
          <Field data-invalid={Boolean(errors.to) || undefined}>
            <FieldLabel htmlFor="channel-to">To</FieldLabel>
            <ListInput
              id="channel-to"
              value={draft.to}
              onChange={(to) => setDraft({ to })}
              placeholder="ops@example.com"
              invalid={Boolean(errors.to)}
              max={MAX_RECIPIENTS}
            />
            {errors.to ? (
              <FieldError>{errors.to}</FieldError>
            ) : (
              <FieldDescription>Up to {MAX_RECIPIENTS} addresses. Press Enter or type a comma after each one.</FieldDescription>
            )}
          </Field>
          <Field data-invalid={Boolean(errors.cc) || undefined}>
            <FieldLabel htmlFor="channel-cc">Cc (optional)</FieldLabel>
            <ListInput id="channel-cc" value={draft.cc} onChange={(cc) => setDraft({ cc })} invalid={Boolean(errors.cc)} max={MAX_RECIPIENTS} />
            <FieldError>{errors.cc}</FieldError>
          </Field>
          <p className="flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2 text-micro text-muted-foreground ring-1 ring-border">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            Email goes through the SMTP server on the “Email server” tab.
          </p>
        </>
      )
    case 'slack':
    case 'teams':
    case 'discord':
      return (
        <Field data-invalid={Boolean(errors.webhook_url) || undefined}>
          <FieldLabel htmlFor="channel-webhook">Webhook URL</FieldLabel>
          <SecretInput
            id="channel-webhook"
            secret={draft.webhook_url}
            onChange={(webhook_url) => setDraft({ webhook_url })}
            placeholder="https://"
            invalid={Boolean(errors.webhook_url)}
          />
          {errors.webhook_url ? (
            <FieldError>{errors.webhook_url}</FieldError>
          ) : (
            <FieldDescription>{WEBHOOK_HINT[draft.kind]} The URL is a secret: it is stored encrypted and never shown again.</FieldDescription>
          )}
        </Field>
      )
    case 'ntfy':
      return (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,12rem)]">
            <Field data-invalid={Boolean(errors.server_url) || undefined}>
              <FieldLabel htmlFor="channel-ntfy-server">Server</FieldLabel>
              <Input
                id="channel-ntfy-server"
                value={draft.server_url}
                placeholder={NTFY_DEFAULT_SERVER}
                spellCheck={false}
                onChange={(event) => setDraft({ server_url: event.target.value })}
              />
              <FieldError>{errors.server_url}</FieldError>
            </Field>
            <Field data-invalid={Boolean(errors.topic) || undefined}>
              <FieldLabel htmlFor="channel-ntfy-topic">Topic</FieldLabel>
              <Input
                id="channel-ntfy-topic"
                className="font-mono text-[12.5px]"
                value={draft.topic}
                placeholder="oncall-alerts"
                spellCheck={false}
                onChange={(event) => setDraft({ topic: event.target.value })}
              />
              <FieldError>{errors.topic}</FieldError>
            </Field>
          </div>
          <Field data-invalid={Boolean(errors.token) || undefined}>
            <FieldLabel htmlFor="channel-ntfy-token">Access token (optional)</FieldLabel>
            <SecretInput id="channel-ntfy-token" secret={draft.token} optional onChange={(token) => setDraft({ token })} placeholder="tk_…" />
            {errors.token ? (
              <FieldError>{errors.token}</FieldError>
            ) : (
              <FieldDescription>Needed for protected topics. Priority follows severity: critical 5, warning 4, info 3, resolved 2.</FieldDescription>
            )}
          </Field>
        </>
      )
    case 'webhook':
      return (
        <>
          <Field data-invalid={Boolean(errors.url) || undefined}>
            <FieldLabel htmlFor="channel-url">URL</FieldLabel>
            <Input
              id="channel-url"
              value={draft.url}
              placeholder="https://example.com/rustrmm"
              spellCheck={false}
              aria-invalid={Boolean(errors.url) || undefined}
              onChange={(event) => setDraft({ url: event.target.value })}
            />
            {errors.url ? (
              <FieldError>{errors.url}</FieldError>
            ) : (
              <FieldDescription>RustRMM POSTs a JSON body with the event and the alert. Redirects are not followed.</FieldDescription>
            )}
          </Field>
          <Field data-invalid={Boolean(errors.secret) || undefined}>
            <FieldLabel htmlFor="channel-secret">Signing secret (optional)</FieldLabel>
            <SecretInput id="channel-secret" secret={draft.secret} optional onChange={(secret) => setDraft({ secret })} />
            {errors.secret ? (
              <FieldError>{errors.secret}</FieldError>
            ) : (
              <FieldDescription>
                Requests then carry <code className="font-mono text-[11px]">X-RustRMM-Signature: sha256=…</code>, an HMAC of the body.
              </FieldDescription>
            )}
          </Field>
          <HeadersEditor headers={draft.headers} error={errors.headers} onChange={(headers) => setDraft({ headers, headersTouched: true })} />
        </>
      )
  }
}

function ChannelForm({
  channel,
  initialKind,
  onBack,
  onDone,
}: {
  channel: NotificationChannel | null
  initialKind: NotificationChannelKind
  onBack?: () => void
  onDone: () => void
}) {
  const queryClient = useQueryClient()
  const me = useMe()
  const { data: settings } = useQuery({
    ...monitoringSettingsQuery,
    enabled: hasPermission(me, PERMISSIONS.settingsView),
    meta: { silent: true },
  })
  const [draft, setDraftState] = useState<ChannelDraft>(() => (channel ? draftFromChannel(channel) : emptyDraft(initialKind)))
  const [attempted, setAttempted] = useState(false)
  const errors = validateChannelDraft(draft, settings?.webhook_allowlist ?? [])
  const shown: ChannelErrors = attempted ? errors : {}
  const setDraft = (patch: Partial<ChannelDraft>) => setDraftState((prev) => ({ ...prev, ...patch }))

  const save = useMutation({
    mutationFn: () => {
      const body = channelInput(draft)
      return channel ? notificationsApi.updateChannel(channel.id, body) : notificationsApi.createChannel(body)
    },
    meta: { silent: true },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: keys.notifications })
      toast.success(channel ? `Saved “${saved.name}”` : `Added “${saved.name}” — send a test to check it`)
      onDone()
    },
    onError: (failure) => {
      if (!(isApiError(failure) && failure.status === 422)) toast.error(errorMessage(failure))
    },
  })
  const serverError = save.error && isApiError(save.error) && save.error.status === 422 ? save.error.message : null

  return (
    <form
      className="grid grid-cols-1 gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        setAttempted(true)
        if (Object.keys(errors).length) return
        save.mutate()
      }}
    >
      <div className="flex items-center gap-3 rounded-xl bg-surface-2 px-3 py-2.5 ring-1 ring-border">
        <ChannelKindTile kind={draft.kind} />
        <div className="min-w-0 flex-1">
          <div className="text-dense font-medium">{CHANNEL_KIND_LABEL[draft.kind]}</div>
          <div className="truncate text-micro text-muted-foreground">{CHANNEL_KIND_DESCRIPTION[draft.kind]}</div>
        </div>
        {onBack && (
          <Button type="button" variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft data-icon="inline-start" />
            Change
          </Button>
        )}
      </div>
      {serverError && (
        <p role="alert" className="flex items-start gap-2 rounded-lg bg-critical/[0.06] px-3 py-2 text-dense text-critical ring-1 ring-critical/25">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          {serverError}
        </p>
      )}
      <Field data-invalid={Boolean(shown.name) || undefined}>
        <FieldLabel htmlFor="channel-name">Name</FieldLabel>
        <Input
          id="channel-name"
          value={draft.name}
          maxLength={80}
          placeholder={draft.kind === 'email' ? 'Service desk email' : `Ops ${CHANNEL_KIND_LABEL[draft.kind]}`}
          autoFocus={!channel}
          onChange={(event) => setDraft({ name: event.target.value })}
        />
        <FieldError>{shown.name}</FieldError>
      </Field>
      <KindFields draft={draft} setDraft={setDraft} errors={shown} />
      <label className="flex items-start justify-between gap-3 rounded-lg px-3 py-2.5 ring-1 ring-border">
        <span className="text-dense">
          <span className="block font-medium">Enabled</span>
          <span className="block text-micro text-muted-foreground">Paused channels are skipped by every rule.</span>
        </span>
        <Switch checked={draft.enabled} onCheckedChange={(enabled) => setDraft({ enabled })} />
      </label>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending && <Spinner data-icon="inline-start" />}
          {channel ? 'Save channel' : 'Add channel'}
        </Button>
      </DialogFooter>
    </form>
  )
}

export function ChannelDialog({
  open,
  onOpenChange,
  channel,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  channel: NotificationChannel | null
}) {
  const [kind, setKind] = useState<NotificationChannelKind | null>(channel?.kind ?? null)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn('max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[560px]')}>
        <DialogHeader>
          <DialogTitle>{channel ? `Edit “${channel.name}”` : kind ? `New ${CHANNEL_KIND_LABEL[kind]} channel` : 'Add a channel'}</DialogTitle>
          <DialogDescription>
            {channel
              ? 'Secrets stay as they are unless you replace them.'
              : kind
                ? 'Rules send alert notifications to this channel.'
                : 'Where should alert notifications go? The kind cannot change later.'}
          </DialogDescription>
        </DialogHeader>
        {kind ? (
          <ChannelForm
            key={kind}
            channel={channel}
            initialKind={kind}
            onBack={channel ? undefined : () => setKind(null)}
            onDone={() => onOpenChange(false)}
          />
        ) : (
          <KindPicker onPick={setKind} />
        )}
      </DialogContent>
    </Dialog>
  )
}
