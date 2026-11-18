/* Notification rules: which alerts go to which channels, with quiet hours and escalation. */
import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight, Copy, Ellipsis, Moon, Pencil, Plus, Trash } from 'lucide-react'
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
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/misc'
import { ChannelKindTile, SeverityIcon } from '@/features/monitoring/monitoring-ui'
import { notificationsApi } from '@/lib/api/endpoints'
import {
  checkTypesQuery,
  clientsQuery,
  keys,
  notificationChannelsQuery,
  notificationRulesQuery,
  sitesQuery,
} from '@/lib/api/queries'
import type { NotificationChannel, NotificationRule } from '@/lib/api/types'
import { checkTypeLabel, SEVERITY_LABEL, SOURCE_LABEL } from '@/lib/monitoring/labels'
import { describeQuietHours, quietStatus } from '@/lib/monitoring/quiet-hours'
import { escalationSummary, eventsSummary, ruleInput } from '@/lib/notifications/rules'
import { cn } from '@/lib/utils'
import { RuleEditor } from './rule-editor'
import { SEVERITY_STYLE } from '@/features/monitoring/monitoring-styles'

function FilterChip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-6 max-w-full items-center gap-1 rounded-md bg-surface-2 px-2 text-micro text-secondary-foreground ring-1 ring-border [&_svg]:size-3',
        className,
      )}
    >
      {children}
    </span>
  )
}

function RuleCard({
  rule,
  names,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  rule: NotificationRule
  names: {
    client: (id: string) => string
    site: (id: string) => string
    type: (type: string) => string
    channel: (id: string) => NotificationChannel | undefined
  }
  onEdit: () => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const queryClient = useQueryClient()
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => notificationsApi.updateRule(rule.id, { ...ruleInput(rule), enabled }),
    onMutate: (enabled) => {
      queryClient.setQueryData<NotificationRule[]>(keys.notificationRules, (list) =>
        list?.map((item) => (item.id === rule.id ? { ...item, enabled } : item)),
      )
    },
    onSuccess: (saved) => toast.success(saved.enabled ? `“${saved.name}” enabled` : `“${saved.name}” disabled`),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: keys.notificationRules }),
  })
  const filters = rule.filters
  const hasFilters = Object.values(filters).some((list) => list.length > 0)
  const quiet = rule.quiet_hours.enabled ? quietStatus(rule.quiet_hours) : null
  const escalation = escalationSummary(rule, (id) => names.channel(id)?.name ?? 'Deleted channel')
  return (
    <article className={cn('grid min-w-0 grid-cols-1 gap-3 rounded-xl bg-card p-4 shadow-card', !rule.enabled && 'opacity-75')}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={onEdit} className="truncate text-left text-dense font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
              {rule.name}
            </button>
            {!rule.enabled && <Badge variant="outline">Disabled</Badge>}
            {quiet?.quiet && (
              <Badge variant="info">
                <Moon />
                Quiet now
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-micro text-muted-foreground">On {eventsSummary(rule.events).toLowerCase()}</p>
        </div>
        <Switch
          checked={rule.enabled}
          disabled={toggle.isPending}
          aria-label={rule.enabled ? `Disable ${rule.name}` : `Enable ${rule.name}`}
          onCheckedChange={(enabled) => toggle.mutate(enabled)}
        />
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`More actions for ${rule.name}`} />}>
            <Ellipsis />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={onEdit}>
              <Pencil />
              Edit…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onDuplicate}>
              <Copy />
              Duplicate
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Trash />
              Delete…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex min-w-0 flex-wrap gap-1.5">
        {!hasFilters && <FilterChip>Every alert</FilterChip>}
        {filters.severities.map((severity) => (
          <FilterChip key={severity} className={cn(SEVERITY_STYLE[severity].soft, 'ring-inset')}>
            <SeverityIcon severity={severity} className="size-3" />
            {SEVERITY_LABEL[severity]}
          </FilterChip>
        ))}
        {filters.sources.map((source) => (
          <FilterChip key={source}>{SOURCE_LABEL[source]}</FilterChip>
        ))}
        {filters.client_ids.map((id) => (
          <FilterChip key={id}>
            <span className="truncate">{names.client(id)}</span>
          </FilterChip>
        ))}
        {filters.site_ids.map((id) => (
          <FilterChip key={id}>
            <span className="truncate">{names.site(id)}</span>
          </FilterChip>
        ))}
        {filters.check_types.map((type) => (
          <FilterChip key={type}>{names.type(type)}</FilterChip>
        ))}
        {filters.check_ids.map((id) => (
          <FilterChip key={id} className="font-mono text-[10.5px]">
            {id}
          </FilterChip>
        ))}
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <ArrowUpRight className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden="true" />
        {rule.channel_ids.length === 0 ? (
          <span className="text-micro text-critical">No channel — this rule sends nothing</span>
        ) : (
          rule.channel_ids.map((id) => {
            const channel = names.channel(id)
            return (
              <span key={id} className={cn('inline-flex h-6 max-w-full items-center gap-1.5 rounded-md pr-2 text-dense', !channel?.enabled && 'text-muted-foreground')}>
                {channel && <ChannelKindTile kind={channel.kind} size="sm" className="size-5 rounded-[5px] [&_svg]:size-3" />}
                <span className="truncate">{channel?.name ?? 'Deleted channel'}</span>
                {channel && !channel.enabled && <span className="text-micro text-subtle-foreground">(paused)</span>}
              </span>
            )
          })
        )}
      </div>

      {(rule.quiet_hours.enabled || escalation) && (
        <div className="grid grid-cols-1 gap-1 border-t border-border pt-3 text-micro text-muted-foreground">
          {rule.quiet_hours.enabled && (
            <p className="flex min-w-0 items-start gap-1.5">
              <Moon className="mt-px size-3.5 shrink-0 text-info" />
              <span className="min-w-0">
                {describeQuietHours(rule.quiet_hours)}
                {quiet && <span className="text-foreground/80"> · {quiet.label}</span>}
              </span>
            </p>
          )}
          {escalation && (
            <p className="flex min-w-0 items-start gap-1.5">
              <ArrowUpRight className="mt-px size-3.5 shrink-0 text-warning" />
              <span className="min-w-0">{escalation} if nobody acknowledges</span>
            </p>
          )}
        </div>
      )}
    </article>
  )
}

export function RulesTab() {
  const queryClient = useQueryClient()
  const { data, isLoading, error, refetch } = useQuery(notificationRulesQuery)
  const { data: channels = [] } = useQuery(notificationChannelsQuery)
  const { data: clients = [] } = useQuery(clientsQuery())
  const { data: sites = [] } = useQuery(sitesQuery())
  const { data: catalog = [] } = useQuery({ ...checkTypesQuery, meta: { silent: true } })
  const [editor, setEditor] = useState<{ rule: NotificationRule | null; nonce: number } | null>(null)
  const [deleting, setDeleting] = useState<NotificationRule | null>(null)
  const rules = data ?? []

  const names = {
    client: (id: string) => clients.find((client) => client.id === id)?.name ?? 'Unknown client',
    site: (id: string) => {
      const site = sites.find((item) => item.id === id)
      if (!site) return 'Unknown site'
      const client = clients.find((item) => item.id === site.client_id)
      return client ? `${client.name} · ${site.name}` : site.name
    },
    type: (type: string) => checkTypeLabel(type, catalog),
    channel: (id: string) => channels.find((item) => item.id === id),
  }

  const duplicate = useMutation({
    mutationFn: (rule: NotificationRule) =>
      notificationsApi.createRule({ ...ruleInput(rule), name: `${rule.name} (copy)`.slice(0, 80), enabled: false }),
    meta: { successMessage: 'Rule duplicated (disabled until you enable it)' },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.notificationRules }),
  })

  const remove = useMutation({
    mutationFn: (rule: NotificationRule) => notificationsApi.removeRule(rule.id),
    meta: { successMessage: 'Rule deleted' },
    onSuccess: () => {
      setDeleting(null)
      void queryClient.invalidateQueries({ queryKey: keys.notificationRules })
    },
  })

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-2xl text-dense text-muted-foreground">
          Every enabled rule is checked for each alert event. Snoozed alerts and devices in maintenance send nothing.
        </p>
        {rules.length > 0 && (
          <Button size="sm" className="self-start sm:self-auto" onClick={() => setEditor({ rule: null, nonce: Date.now() })}>
            <Plus data-icon="inline-start" />
            New rule
          </Button>
        )}
      </div>
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isLoading ? (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-44 rounded-xl" />
          ))}
        </div>
      ) : rules.length === 0 ? (
        <EmptyState
          illustration="alerts"
          title="No rules yet"
          description={
            channels.length
              ? 'Create a rule to route alerts to your channels by severity, client, source or check, with quiet hours and escalation.'
              : 'Add a channel first, then create a rule that routes alerts to it.'
          }
          actions={
            <Button size="sm" onClick={() => setEditor({ rule: null, nonce: Date.now() })}>
              <Plus data-icon="inline-start" />
              New rule
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {rules.map((rule) => (
            <RuleCard
              key={rule.id}
              rule={rule}
              names={names}
              onEdit={() => setEditor({ rule, nonce: Date.now() })}
              onDuplicate={() => duplicate.mutate(rule)}
              onDelete={() => setDeleting(rule)}
            />
          ))}
        </div>
      )}
      {editor && <RuleEditor key={editor.nonce} open rule={editor.rule} onOpenChange={(open) => !open && setEditor(null)} />}
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete “${deleting?.name}”?`}
        description="Alerts that only this rule routed stop sending notifications. Past deliveries stay in the log."
        confirmLabel="Delete rule"
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </div>
  )
}
