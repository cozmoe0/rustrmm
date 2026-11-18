import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Lock, Save, Settings2, ShieldCheck, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { FieldError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { ErrorState } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/simple-select'
import { automationSettingsApi } from '@/lib/api/endpoints'
import { automationSettingsQuery, keys } from '@/lib/api/queries'
import type { AutomationSettings } from '@/lib/api/types'
import { OFFLINE_WAIT_OPTIONS } from '@/lib/automation/labels'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'

function SettingRow({
  title,
  description,
  control,
  className,
}: {
  title: string
  description: ReactNode
  control: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-8',
        className,
      )}
    >
      <div className="min-w-0">
        <div className="text-dense font-medium">{title}</div>
        <p className="mt-0.5 max-w-xl text-micro text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  )
}

function Form({ settings, canManage }: { settings: AutomationSettings; canManage: boolean }) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState(settings)
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings)
  const thresholdError =
    !Number.isInteger(draft.mass_action_threshold) ||
    draft.mass_action_threshold < 1 ||
    draft.mass_action_threshold > 10_000
      ? '1–10000 devices'
      : null
  const outputError =
    !Number.isInteger(draft.max_output_kb) || draft.max_output_kb < 16 || draft.max_output_kb > 4096
      ? '16–4096 KiB'
      : null
  const set = (patch: Partial<AutomationSettings>) => setDraft((prev) => ({ ...prev, ...patch }))
  const save = useMutation({
    mutationFn: () => automationSettingsApi.update(draft),
    meta: { successMessage: 'Automation settings saved' },
    onSuccess: (updated) => {
      queryClient.setQueryData(keys.automationSettings, updated)
      setDraft(updated)
    },
  })

  return (
    <fieldset disabled={!canManage} className="grid grid-cols-1 gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Mass-action guard</CardTitle>
          <CardDescription>
            Large jobs and high-risk scripts need a typed device-count confirmation and re-authentication.
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-y divide-border">
          <SettingRow
            title="Threshold"
            description="Jobs that resolve to more devices than this are guarded. High-risk scripts are always guarded."
            control={
              <div className="grid grid-cols-1 gap-1">
                <div className="relative w-40">
                  <Input
                    type="number"
                    min={1}
                    className="tabular pr-16"
                    aria-label="Mass-action threshold"
                    value={Number.isNaN(draft.mass_action_threshold) ? '' : draft.mass_action_threshold}
                    onChange={(event) => set({ mass_action_threshold: Number(event.target.value) })}
                  />
                  <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-micro text-subtle-foreground">
                    devices
                  </span>
                </div>
                <FieldError>{thresholdError}</FieldError>
              </div>
            }
          />
          <SettingRow
            title="Four-eyes approval for guarded jobs"
            description="A second person with “Approve scripts and jobs” must approve guarded jobs before anything runs. Requests expire after 7 days."
            control={
              <Switch
                checked={draft.four_eyes_jobs}
                onCheckedChange={(four_eyes_jobs) => set({ four_eyes_jobs })}
                aria-label="Four-eyes approval"
              />
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Script approval</CardTitle>
          <CardDescription>Control which versions of a script are allowed to run.</CardDescription>
        </CardHeader>
        <CardContent className="divide-y divide-border">
          <SettingRow
            title="Only approved versions may run"
            description="Jobs run a script’s approved version. Scripts without one can’t run until an approver reviews them. Built-in scripts are approved automatically."
            control={
              <Switch
                checked={draft.require_script_approval}
                onCheckedChange={(require_script_approval) => set({ require_script_approval })}
                aria-label="Require script approval"
              />
            }
          />
          <SettingRow
            title="Allow self-approval"
            description="Let the author of a script version approve it. Leave off for a true four-eyes process."
            control={
              <Switch
                checked={draft.allow_self_approval}
                onCheckedChange={(allow_self_approval) => set({ allow_self_approval })}
                aria-label="Allow self-approval"
              />
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Execution defaults</CardTitle>
          <CardDescription>Limits and defaults applied to every run.</CardDescription>
        </CardHeader>
        <CardContent className="divide-y divide-border">
          <SettingRow
            title="Output cap per stream"
            description="stdout and stderr are each truncated beyond this size on the device, before upload."
            control={
              <div className="grid grid-cols-1 gap-1">
                <div className="relative w-40">
                  <Input
                    type="number"
                    min={16}
                    max={4096}
                    className="tabular pr-12"
                    aria-label="Output cap"
                    value={Number.isNaN(draft.max_output_kb) ? '' : draft.max_output_kb}
                    onChange={(event) => set({ max_output_kb: Number(event.target.value) })}
                  />
                  <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-micro text-subtle-foreground">
                    KiB
                  </span>
                </div>
                <FieldError>{outputError}</FieldError>
              </div>
            }
          />
          <SettingRow
            title="Default offline wait"
            description="How long a new job waits for offline devices to reconnect. Each job can override it."
            control={
              <SimpleSelect
                className="w-52"
                ariaLabel="Default offline wait"
                value={String(draft.default_offline_wait_minutes)}
                onValueChange={(value) => set({ default_offline_wait_minutes: Number(value) })}
                options={OFFLINE_WAIT_OPTIONS.map((option) => ({
                  value: String(option.value),
                  label: option.value === 0 ? option.label : `Wait up to ${option.label}`,
                }))}
              />
            }
          />
        </CardContent>
      </Card>

      {canManage && (
        <div className="flex flex-wrap items-center justify-end gap-3">
          <span className="mr-auto inline-flex items-center gap-1.5 text-micro text-muted-foreground">
            <Lock className="size-3.5" />
            Saving asks you to confirm it’s you.
          </span>
          {dirty && (
            <Button variant="ghost" onClick={() => setDraft(settings)} disabled={save.isPending}>
              <Undo2 data-icon="inline-start" />
              Discard
            </Button>
          )}
          <Button
            disabled={!dirty || Boolean(thresholdError || outputError) || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}
            Save settings
          </Button>
        </div>
      )}
    </fieldset>
  )
}

export function AutomationSettingsPage() {
  useTitle('Automation settings')
  const me = useMe()
  const canView = hasPermission(me, PERMISSIONS.settingsView)
  const canManage = hasPermission(me, PERMISSIONS.settingsManage)
  const { data, isLoading, error, refetch } = useQuery({ ...automationSettingsQuery, enabled: canView })
  return (
    <PageContainer className="grid max-w-4xl grid-cols-1 gap-5">
      <PageHeader
        icon={<Settings2 />}
        title="Automation settings"
        description="Guardrails for running scripts across the fleet."
      />
      {!canView ? (
        <ErrorState error={new Error('You need the “View settings” permission.')} title="No access" />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isLoading || !data ? (
        <div className="grid grid-cols-1 gap-4">
          <Skeleton className="h-48 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
        </div>
      ) : (
        <>
          {!canManage && (
            <p className="flex items-center gap-2 rounded-xl bg-surface-2 px-4 py-3 text-dense text-muted-foreground ring-1 ring-border">
              <ShieldCheck className="size-4" />
              You can view these settings. Changing them needs the “Manage settings” permission.
            </p>
          )}
          <Form key={JSON.stringify(data)} settings={data} canManage={canManage} />
        </>
      )}
    </PageContainer>
  )
}
