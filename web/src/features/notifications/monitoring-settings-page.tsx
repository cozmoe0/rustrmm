/* Settings › Monitoring: offline and unknown thresholds, retention and the webhook allowlist. */
import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, CircleAlert, Plus, Save, ShieldCheck, Undo2, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { FieldError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { ErrorState } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { monitoringApi } from '@/lib/api/endpoints'
import { keys, monitoringSettingsQuery } from '@/lib/api/queries'
import type { MonitoringSettings } from '@/lib/api/types'
import { allowlistKind, normalizeAllowlist, normalizeAllowlistEntry } from '@/lib/monitoring/allowlist'
import { formatMinutes } from '@/lib/monitoring/labels'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'

const KIND_LABEL = { host: 'Host', ip: 'IP address', cidr: 'Range' } as const

function SettingRow({ title, description, control }: { title: string; description: ReactNode; control: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
      <div className="min-w-0">
        <div className="text-dense font-medium">{title}</div>
        <p className="mt-0.5 max-w-xl text-micro text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  )
}

function NumberControl({
  value,
  onChange,
  unit,
  label,
  error,
  min,
  max,
}: {
  value: number
  onChange: (value: number) => void
  unit: string
  label: string
  error: string | null
  min: number
  max: number
}) {
  return (
    <div className="grid grid-cols-1 gap-1">
      <div className="relative w-40">
        <Input
          type="number"
          min={min}
          max={max}
          className="tabular pr-16"
          aria-label={label}
          aria-invalid={Boolean(error) || undefined}
          value={Number.isNaN(value) ? '' : value}
          onChange={(event) => onChange(event.target.value === '' ? Number.NaN : Number(event.target.value))}
        />
        <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-micro text-subtle-foreground">{unit}</span>
      </div>
      <FieldError>{error}</FieldError>
    </div>
  )
}

const rangeError = (value: number, min: number, max: number) =>
  Number.isInteger(value) && value >= min && value <= max ? null : `${min}–${max}`

function AllowlistEditor({ value, onChange, disabled }: { value: string[]; onChange: (value: string[]) => void; disabled: boolean }) {
  const [draft, setDraft] = useState('')
  const kind = draft.trim() ? allowlistKind(draft) : null
  const add = () => {
    const entry = normalizeAllowlistEntry(draft)
    if (!entry || !allowlistKind(entry)) return
    if (!value.includes(entry)) onChange([...value, entry])
    setDraft('')
  }
  return (
    <div className="grid grid-cols-1 gap-3">
      {!disabled && (
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-start"
          onSubmit={(event) => {
            event.preventDefault()
            add()
          }}
        >
          <div className="grid min-w-0 flex-1 grid-cols-1 gap-1 sm:max-w-md">
            <Input
              aria-label="Allowlist entry"
              className="font-mono text-[12.5px]"
              placeholder="hooks.internal.example, 10.20.0.0/16"
              spellCheck={false}
              value={draft}
              aria-invalid={(draft.trim() !== '' && !kind) || undefined}
              onChange={(event) => setDraft(event.target.value)}
            />
            {draft.trim() !== '' && (
              <p className={cn('text-micro', kind ? 'text-muted-foreground' : 'text-critical')}>
                {kind ? `${KIND_LABEL[kind]} · ${normalizeAllowlistEntry(draft)}` : 'Enter a host name, an IP address or a CIDR range such as 10.20.0.0/16'}
              </p>
            )}
          </div>
          <Button type="submit" variant="outline" disabled={!kind}>
            <Plus data-icon="inline-start" />
            Add
          </Button>
        </form>
      )}
      {value.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border-strong px-4 py-5 text-center text-dense text-muted-foreground">
          The allowlist is empty: webhooks can only reach public addresses over https.
        </p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg ring-1 ring-border">
          {value.map((entry) => {
            const entryKind = allowlistKind(entry)
            return (
              <li key={entry} className="flex min-w-0 items-center gap-3 px-3 py-2">
                <code className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{entry}</code>
                {entryKind ? (
                  <Badge variant="secondary">{KIND_LABEL[entryKind]}</Badge>
                ) : (
                  <Badge variant="critical">
                    <CircleAlert />
                    Invalid
                  </Badge>
                )}
                {!disabled && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${entry}`}
                    className="hover:text-critical"
                    onClick={() => onChange(value.filter((item) => item !== entry))}
                  >
                    <X />
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function Form({ settings, canManage }: { settings: MonitoringSettings; canManage: boolean }) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState(settings)
  const set = (patch: Partial<MonitoringSettings>) => setDraft((prev) => ({ ...prev, ...patch }))
  const { entries, invalid } = normalizeAllowlist(draft.webhook_allowlist)
  const errors = {
    offline: rangeError(draft.default_offline_minutes, 0, 10_080),
    unknown: rangeError(draft.unknown_threshold, 1, 100),
    retention: rangeError(draft.retention_days, 7, 3650),
    allowlist: invalid.length ? `Fix or remove: ${invalid.join(', ')}` : null,
  }
  const hasErrors = Object.values(errors).some(Boolean)
  const body: MonitoringSettings = { ...draft, webhook_allowlist: entries }
  const dirty = JSON.stringify(body) !== JSON.stringify(settings)
  const save = useMutation({
    mutationFn: () => monitoringApi.updateSettings(body),
    meta: { successMessage: 'Monitoring settings saved' },
    onSuccess: (updated) => {
      queryClient.setQueryData(keys.monitoringSettings, updated)
      setDraft(updated)
    },
  })

  return (
    <fieldset disabled={!canManage} className="grid min-w-0 grid-cols-1 gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Check engine</CardTitle>
          <CardDescription>Defaults for the server-side offline check and for checks that cannot run.</CardDescription>
        </CardHeader>
        <CardContent className="divide-y divide-border">
          <SettingRow
            title="Offline alert after"
            description={
              <>
                Used when no policy sets <code className="font-mono text-[11px]">monitoring.server.offline_minutes</code>. 0 turns the default
                offline alert off.
                {!errors.offline && draft.default_offline_minutes > 0 && ` Currently ${formatMinutes(draft.default_offline_minutes)}.`}
              </>
            }
            control={
              <NumberControl
                label="Default offline minutes"
                unit="min"
                min={0}
                max={10_080}
                value={draft.default_offline_minutes}
                error={errors.offline}
                onChange={(default_offline_minutes) => set({ default_offline_minutes })}
              />
            }
          />
          <SettingRow
            title="Unknown threshold"
            description="Consecutive “unknown” results (the check could not run) before an info alert opens."
            control={
              <NumberControl
                label="Unknown threshold"
                unit="results"
                min={1}
                max={100}
                value={draft.unknown_threshold}
                error={errors.unknown}
                onChange={(unknown_threshold) => set({ unknown_threshold })}
              />
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Retention</CardTitle>
          <CardDescription>Resolved alerts, their timelines and the delivery history older than this are purged.</CardDescription>
        </CardHeader>
        <CardContent>
          <SettingRow
            title="Keep resolved alerts for"
            description="Open and acknowledged alerts are never purged."
            control={
              <NumberControl
                label="Retention days"
                unit="days"
                min={7}
                max={3650}
                value={draft.retention_days}
                error={errors.retention}
                onChange={(retention_days) => set({ retention_days })}
              />
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-subtle-foreground" />
            Webhook allowlist
          </CardTitle>
          <CardDescription>
            Outbound Slack, Teams, Discord, ntfy and webhook deliveries are checked at send time: https only, no redirects, and never to
            loopback, private, link-local, CGNAT or multicast addresses. List internal hosts, IP addresses or CIDR ranges here to let
            deliveries reach them (plain http is then allowed too). Email always goes to the SMTP server.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-2">
          <AllowlistEditor value={draft.webhook_allowlist} onChange={(webhook_allowlist) => set({ webhook_allowlist })} disabled={!canManage} />
          <FieldError>{errors.allowlist}</FieldError>
        </CardContent>
      </Card>

      {canManage && (
        <div className="flex flex-wrap items-center justify-end gap-3">
          {dirty && (
            <Button variant="ghost" onClick={() => setDraft(settings)} disabled={save.isPending}>
              <Undo2 data-icon="inline-start" />
              Discard
            </Button>
          )}
          <Button disabled={!dirty || hasErrors || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}
            Save settings
          </Button>
        </div>
      )}
    </fieldset>
  )
}

export function MonitoringSettingsPage() {
  useTitle('Monitoring settings')
  const me = useMe()
  const canView = hasPermission(me, PERMISSIONS.settingsView)
  // PUT needs monitors.manage held globally (the settings are installation-wide).
  const canManage = hasPermission(me, PERMISSIONS.monitorsManage) && Boolean(me?.scopes.global)
  const { data, isLoading, error, refetch } = useQuery({ ...monitoringSettingsQuery, enabled: canView })
  return (
    <PageContainer className="grid max-w-4xl grid-cols-1 gap-5">
      <PageHeader
        icon={<Activity />}
        title="Monitoring settings"
        description="Installation-wide defaults for checks, alert retention and outbound webhooks."
      />
      {!canView ? (
        <ErrorState error={new Error('You need the “View settings” permission.')} title="No access" />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isLoading || !data ? (
        <div className="grid grid-cols-1 gap-4">
          <Skeleton className="h-48 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-56 rounded-xl" />
        </div>
      ) : (
        <>
          {!canManage && (
            <p className="flex items-center gap-2 rounded-xl bg-surface-2 px-4 py-3 text-dense text-muted-foreground ring-1 ring-border">
              <ShieldCheck className="size-4 shrink-0" />
              You can view these settings. Changing them needs the “Manage monitoring” permission held globally.
            </p>
          )}
          <Form key={JSON.stringify(data)} settings={data} canManage={canManage} />
        </>
      )}
    </PageContainer>
  )
}
