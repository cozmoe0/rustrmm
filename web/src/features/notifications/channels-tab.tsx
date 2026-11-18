/* Notification channels: where alert notifications are delivered, with test sends. */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleAlert, CircleCheck, Ellipsis, Pencil, Plus, Send, Trash } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/misc'
import { ChannelKindTile, When } from '@/features/monitoring/monitoring-ui'
import { notificationsApi } from '@/lib/api/endpoints'
import { errorMessage } from '@/lib/api/errors'
import { keys, notificationChannelsQuery, notificationRulesQuery } from '@/lib/api/queries'
import type { ChannelTestResult, NotificationChannel } from '@/lib/api/types'
import { CHANNEL_KIND_LABEL } from '@/lib/monitoring/labels'
import { channelTarget, toggleInput } from '@/lib/notifications/channels'
import { cn } from '@/lib/utils'
import { ChannelDialog } from './channel-dialog'

interface TestOutcome extends ChannelTestResult {
  at: string
}

function TestResultLine({ result }: { result: TestOutcome }) {
  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-2 rounded-lg px-3 py-2 text-dense ring-1',
        result.ok ? 'bg-success/[0.07] text-success ring-success/25' : 'bg-critical/[0.06] text-critical ring-critical/25',
      )}
    >
      {result.ok ? <CircleCheck className="mt-0.5 size-4 shrink-0" /> : <CircleAlert className="mt-0.5 size-4 shrink-0" />}
      <span className="min-w-0">
        <span className="font-medium">{result.ok ? 'Test delivered' : 'Test failed'}</span>
        {result.status ? <span className="tabular"> · HTTP {result.status}</span> : null}
        {result.error ? <span className="block break-words text-foreground/80">{result.error}</span> : null}
        <span className="block text-micro opacity-80">
          <When value={result.at} /> · logged in the delivery log
        </span>
      </span>
    </div>
  )
}

function ChannelCard({
  channel,
  rules,
  result,
  testing,
  onTest,
  onEdit,
  onDelete,
}: {
  channel: NotificationChannel
  rules: string[]
  result: TestOutcome | undefined
  testing: boolean
  onTest: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const queryClient = useQueryClient()
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => notificationsApi.updateChannel(channel.id, toggleInput(channel, enabled)),
    onMutate: (enabled) => {
      queryClient.setQueryData<NotificationChannel[]>(keys.notificationChannels, (list) =>
        list?.map((item) => (item.id === channel.id ? { ...item, enabled } : item)),
      )
    },
    onSuccess: (saved) => toast.success(saved.enabled ? `“${saved.name}” resumed` : `“${saved.name}” paused`),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: keys.notificationChannels }),
  })
  return (
    <article className={cn('grid min-w-0 grid-cols-1 content-start gap-3 rounded-xl bg-card p-4 shadow-card', !channel.enabled && 'opacity-80')}>
      <div className="flex items-start gap-3">
        <ChannelKindTile kind={channel.kind} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-dense font-medium">{channel.name}</h3>
            {!channel.enabled && <Badge variant="outline">Paused</Badge>}
          </div>
          <p className="truncate text-micro text-muted-foreground">
            {CHANNEL_KIND_LABEL[channel.kind]} · <span className="font-mono text-[11px]">{channelTarget(channel)}</span>
          </p>
        </div>
        <Switch
          checked={channel.enabled}
          disabled={toggle.isPending}
          aria-label={channel.enabled ? `Pause ${channel.name}` : `Resume ${channel.name}`}
          onCheckedChange={(enabled) => toggle.mutate(enabled)}
        />
      </div>
      {channel.last_error && !result?.ok && (
        <p className="flex items-start gap-2 rounded-lg bg-critical/[0.06] px-3 py-2 text-dense text-critical ring-1 ring-critical/20">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 break-words">
            <span className="font-medium">Last delivery failed:</span> {channel.last_error}
          </span>
        </p>
      )}
      {result && <TestResultLine result={result} />}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border pt-3 text-micro text-muted-foreground">
        <span>
          Last used <When value={channel.last_used_at} className="text-foreground/80" />
        </span>
        <span className="min-w-0 truncate" title={rules.join(', ')}>
          {rules.length === 0 ? 'Not used by any rule' : `${rules.length} ${rules.length === 1 ? 'rule' : 'rules'}: ${rules.join(', ')}`}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="outline" size="sm" disabled={testing || !channel.enabled} onClick={onTest} title={channel.enabled ? undefined : 'Resume the channel to test it'}>
            {testing ? <Spinner data-icon="inline-start" /> : <Send data-icon="inline-start" />}
            Send test
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`More actions for ${channel.name}`} />}>
              <Ellipsis />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={onEdit}>
                <Pencil />
                Edit…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trash />
                Delete…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </article>
  )
}

export function ChannelsTab() {
  const queryClient = useQueryClient()
  const { data, isLoading, error, refetch } = useQuery(notificationChannelsQuery)
  const { data: rules = [] } = useQuery(notificationRulesQuery)
  const [dialog, setDialog] = useState<{ channel: NotificationChannel | null; nonce: number } | null>(null)
  const [deleting, setDeleting] = useState<NotificationChannel | null>(null)
  const [results, setResults] = useState<Record<string, TestOutcome>>({})
  const [testingId, setTestingId] = useState<string | null>(null)
  const channels = data ?? []

  const rulesFor = (id: string) =>
    rules.filter((rule) => rule.channel_ids.includes(id) || rule.escalation.channel_ids.includes(id)).map((rule) => rule.name)

  const test = useMutation({
    mutationFn: (channel: NotificationChannel) => notificationsApi.testChannel(channel.id),
    meta: { silent: true },
    onMutate: (channel) => setTestingId(channel.id),
    onSuccess: (result, channel) => {
      setResults((prev) => ({ ...prev, [channel.id]: { ...result, at: new Date().toISOString() } }))
      if (result.ok) toast.success(`Test sent to “${channel.name}”`)
      else toast.error(`“${channel.name}” test failed${result.error ? `: ${result.error}` : ''}`)
      void queryClient.invalidateQueries({ queryKey: keys.notifications })
    },
    onError: (failure, channel) => {
      setResults((prev) => ({ ...prev, [channel.id]: { ok: false, error: errorMessage(failure), at: new Date().toISOString() } }))
      toast.error(errorMessage(failure))
    },
    onSettled: () => setTestingId(null),
  })

  const remove = useMutation({
    mutationFn: (channel: NotificationChannel) => notificationsApi.removeChannel(channel.id),
    meta: { successMessage: 'Channel deleted' },
    onSuccess: () => {
      setDeleting(null)
      void queryClient.invalidateQueries({ queryKey: keys.notifications })
    },
  })

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-2xl text-dense text-muted-foreground">
          Channels are destinations. Rules decide which alerts reach them. Webhook URLs, tokens and secrets are write-only.
        </p>
        {channels.length > 0 && (
          <Button size="sm" className="self-start sm:self-auto" onClick={() => setDialog({ channel: null, nonce: Date.now() })}>
            <Plus data-icon="inline-start" />
            Add channel
          </Button>
        )}
      </div>
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isLoading ? (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-40 rounded-xl" />
          ))}
        </div>
      ) : channels.length === 0 ? (
        <EmptyState
          illustration="alerts"
          title="No channels yet"
          description="Add email, Slack, Microsoft Teams, Discord, ntfy or a signed webhook, then create a rule that routes alerts to it."
          actions={
            <Button size="sm" onClick={() => setDialog({ channel: null, nonce: Date.now() })}>
              <Plus data-icon="inline-start" />
              Add channel
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {channels.map((channel) => (
            <ChannelCard
              key={channel.id}
              channel={channel}
              rules={rulesFor(channel.id)}
              result={results[channel.id]}
              testing={testingId === channel.id}
              onTest={() => test.mutate(channel)}
              onEdit={() => setDialog({ channel, nonce: Date.now() })}
              onDelete={() => setDeleting(channel)}
            />
          ))}
        </div>
      )}
      {dialog && (
        <ChannelDialog key={dialog.nonce} open channel={dialog.channel} onOpenChange={(open) => !open && setDialog(null)} />
      )}
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete “${deleting?.name}”?`}
        description={
          deleting && rulesFor(deleting.id).length
            ? `It is removed from ${rulesFor(deleting.id).length === 1 ? 'the rule' : 'every rule'} that uses it (${rulesFor(deleting.id).join(', ')}). Rules left without a channel stop sending.`
            : 'No rule uses this channel. Its delivery history stays in the log.'
        }
        confirmLabel="Delete channel"
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </div>
  )
}
