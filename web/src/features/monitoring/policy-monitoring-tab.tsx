/* The policy editor's Monitoring tab: agent checks, check overrides and server-side check settings. */
import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ChevronDown,
  CircleExclamationPoint,
  Gauge,
  Layers,
  Lock,
  Plus,
  RefreshCw,
  ServerCog,
  Trash2,
  Wrench,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Toggle } from '@/components/ui/toggle'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { EmptyState } from '@/components/common/empty-state'
import { OsIcon } from '@/components/common/os-icon'
import { SimpleSelect } from '@/components/common/simple-select'
import { scriptQuery } from '@/lib/api/queries'
import type {
  AlertSeverity,
  CheckRemediation,
  CheckTypeDefinition,
  MonitoringCheck,
  ParameterValue,
  PolicyDocument,
} from '@/lib/api/types'
import { defaultParameterValues, toApiParameters, validateParameterValues } from '@/lib/automation/params'
import { OS_LABEL } from '@/lib/devices'
import { describeConfig, type CheckConfig } from '@/lib/monitoring/check-schema'
import { checkTypeLabel, formatInterval, formatMinutes, INTERVAL_PRESETS, SEVERITY_LABEL } from '@/lib/monitoring/labels'
import {
  checkIssues,
  configErrors,
  firstIssue,
  intervalChoice,
  removeCheck,
  renameCheck,
  setChecks,
  setServerKey,
  togglePlatform,
  typePlatforms,
  updateCheck,
  type EditorIssue,
} from '@/lib/monitoring/policy-editor'
import {
  DEFAULT_INTERVAL_SECS,
  DEFAULT_SEVERITY,
  INTERVAL_MAX,
  INTERVAL_MIN,
  isOverride,
  MAX_ATTEMPTS_MAX,
  MAX_CHECKS,
  newCheck,
  SERVER_KEYS,
  SERVER_SETTINGS,
  SEVERITIES,
  type ServerKey,
} from '@/lib/monitoring/policy-monitoring'
import { cn } from '@/lib/utils'
import { PlatformIcons } from '@/features/automation/automation-ui'
import { ParameterForm } from '@/features/automation/parameter-form'
import { ScriptPicker } from '@/features/automation/run-dialog'
import { SEGMENTED } from '@/features/automation/styles'
import { CheckConfigForm } from './check-config-form'
import { CheckTypePicker } from './policy-check-type-picker'
import { CheckTypeTile, SeverityBadge } from './monitoring-ui'

const SEVERITY_TEXT: Record<AlertSeverity, string> = {
  info: 'data-[pressed]:text-info',
  warning: 'data-[pressed]:text-warning',
  critical: 'data-[pressed]:text-critical',
}

function SeverityControl({
  value,
  onChange,
  disabled,
  label,
  inherit,
}: {
  value: AlertSeverity | undefined
  onChange: (value: AlertSeverity | undefined) => void
  disabled?: boolean
  label: string
  /** Adds an "Inherit" option that clears the value. */
  inherit?: boolean
}) {
  const current = value ?? (inherit ? 'inherit' : DEFAULT_SEVERITY)
  return (
    <ToggleGroup
      className={SEGMENTED}
      value={[current]}
      onValueChange={(next: string[]) => next[0] && onChange(next[0] === 'inherit' ? undefined : (next[0] as AlertSeverity))}
      variant="outline"
      spacing={0}
      size="sm"
      disabled={disabled}
      aria-label={label}
    >
      {inherit && (
        <ToggleGroupItem value="inherit" className="px-3">
          Inherit
        </ToggleGroupItem>
      )}
      {SEVERITIES.map((severity) => (
        <ToggleGroupItem key={severity} value={severity} className={cn('px-3', SEVERITY_TEXT[severity])}>
          {SEVERITY_LABEL[severity]}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

function IntervalField({
  value,
  onChange,
  id,
  error,
  disabled,
}: {
  value: number | undefined
  onChange: (value: number | undefined) => void
  id: string
  error?: string
  disabled?: boolean
}) {
  const [custom, setCustom] = useState(intervalChoice(value) === 'custom')
  const choice = custom ? 'custom' : intervalChoice(value)
  return (
    <Field data-invalid={Boolean(error) || undefined}>
      <FieldLabel htmlFor={id}>Interval</FieldLabel>
      <div className="flex gap-2">
        <SimpleSelect
          id={id}
          className="min-w-0 flex-1"
          value={choice}
          disabled={disabled}
          onValueChange={(next) => {
            if (next === 'custom') setCustom(true)
            else {
              setCustom(false)
              onChange(Number(next))
            }
          }}
          options={[
            ...INTERVAL_PRESETS.map((seconds) => ({ value: String(seconds), label: `Every ${formatInterval(seconds)}` })),
            { value: 'custom', label: 'Custom…' },
          ]}
        />
        {choice === 'custom' && (
          <div className="relative w-32 shrink-0">
            <Input
              type="number"
              min={INTERVAL_MIN}
              max={INTERVAL_MAX}
              className="tabular pr-8"
              aria-label="Interval in seconds"
              disabled={disabled}
              value={value === undefined || Number.isNaN(value) ? '' : value}
              onChange={(event) => onChange(event.target.value === '' ? undefined : Number(event.target.value))}
            />
            <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-micro text-subtle-foreground">s</span>
          </div>
        )}
      </div>
      {error ? (
        <FieldError>{error}</FieldError>
      ) : (
        <FieldDescription>
          {INTERVAL_MIN} s to {formatInterval(INTERVAL_MAX)}
          {value ? ` · runs every ${formatInterval(value)}` : ''}
        </FieldDescription>
      )}
    </Field>
  )
}

function RemediationEditor({
  remediation,
  onChange,
  issues,
  readOnly,
  idPrefix,
}: {
  remediation: Partial<CheckRemediation> | null | undefined
  onChange: (remediation: Partial<CheckRemediation> | undefined) => void
  issues: EditorIssue[]
  readOnly: boolean
  idPrefix: string
}) {
  const enabled = Boolean(remediation)
  const scriptId = remediation?.script_id ?? ''
  const { data: script } = useQuery({ ...scriptQuery(scriptId), enabled: Boolean(scriptId) })
  const values = { ...(script ? defaultParameterValues(script.parameters) : {}), ...(remediation?.parameters ?? {}) }
  const paramErrors = script ? validateParameterValues(script.parameters, values) : {}
  return (
    <section className="grid grid-cols-1 gap-3 rounded-lg p-3 ring-1 ring-border">
      <div className="flex items-start gap-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary ring-1 ring-primary/20">
          <Wrench className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-dense font-medium">Auto-remediation</div>
          <p className="text-micro text-muted-foreground">
            Runs a script as a job on the device when the alert opens or reopens. Never during maintenance, for server-side checks or for
            unknown results.
          </p>
        </div>
        <Switch
          checked={enabled}
          disabled={readOnly}
          aria-label="Run a remediation script"
          onCheckedChange={(checked) => onChange(checked ? { script_id: '', parameters: {}, max_attempts: 1 } : undefined)}
        />
      </div>
      {enabled && (
        <div className="grid grid-cols-1 gap-3 sm:pl-10">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_9rem]">
            <Field data-invalid={Boolean(firstIssue(issues, 'remediation.script_id')) || undefined}>
              <FieldLabel>Script</FieldLabel>
              {readOnly ? (
                <div className="rounded-lg bg-surface-2 px-3 py-2 text-dense ring-1 ring-border">{script?.name ?? '—'}</div>
              ) : (
                <ScriptPicker value={scriptId || null} onChange={(id) => onChange({ ...remediation, script_id: id, parameters: {} })} />
              )}
              <FieldError>{firstIssue(issues, 'remediation.script_id')}</FieldError>
            </Field>
            <Field data-invalid={Boolean(firstIssue(issues, 'remediation.max_attempts')) || undefined}>
              <FieldLabel htmlFor={`${idPrefix}-attempts`}>Attempts per alert</FieldLabel>
              <Input
                id={`${idPrefix}-attempts`}
                type="number"
                min={1}
                max={MAX_ATTEMPTS_MAX}
                className="tabular"
                disabled={readOnly}
                value={remediation?.max_attempts ?? ''}
                onChange={(event) =>
                  onChange({ ...remediation, max_attempts: event.target.value === '' ? undefined : Number(event.target.value) })
                }
              />
              <FieldError>{firstIssue(issues, 'remediation.max_attempts')}</FieldError>
            </Field>
          </div>
          {script && (
            <ParameterForm
              parameters={script.parameters.filter((param) => param.type !== 'secret')}
              values={values}
              errors={paramErrors}
              disabled={readOnly}
              idPrefix={`${idPrefix}-fix`}
              onChange={(name, value: ParameterValue) =>
                onChange({ ...remediation, parameters: toApiParameters(script.parameters, { ...values, [name]: value }) })
              }
            />
          )}
        </div>
      )}
    </section>
  )
}

function CheckCard({
  check,
  definition,
  onChange,
  onRemove,
  readOnly,
  issues,
  taken,
  defaultOpen,
  catalog,
}: {
  check: MonitoringCheck
  definition: CheckTypeDefinition | undefined
  onChange: (check: MonitoringCheck) => void
  onRemove: () => void
  readOnly: boolean
  issues: EditorIssue[]
  taken: string[]
  defaultOpen: boolean
  catalog: CheckTypeDefinition[]
}) {
  const [open, setOpen] = useState(defaultOpen)
  const id = `check-${check.id}`
  const available = typePlatforms(definition)
  const config = (check.config ?? {}) as CheckConfig
  const fieldErrors = configErrors(issues)
  const summary = describeConfig(definition, config)
  const typeLabel = check.type ? checkTypeLabel(check.type, catalog) : 'Check'
  const enabled = check.enabled !== false
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className={cn('overflow-hidden rounded-xl bg-card shadow-card', issues.length > 0 && 'ring-1 ring-critical/30', !enabled && 'opacity-75')}>
        <div className="flex items-center gap-3 px-4 py-3">
          <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform', !open && '-rotate-90')} />
            <CheckTypeTile type={check.type ?? 'check'} />
            <span className="min-w-0">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate text-dense font-medium">{check.name || typeLabel}</span>
                {!enabled && <Badge variant="outline">Off</Badge>}
              </span>
              <span className="block truncate text-micro text-muted-foreground">
                {typeLabel}
                {summary ? ` · ${summary}` : ''} · every {formatInterval(check.interval_secs ?? DEFAULT_INTERVAL_SECS)}
              </span>
            </span>
          </CollapsibleTrigger>
          <span className="hidden shrink-0 items-center gap-2 md:flex">
            {check.platforms?.length ? <PlatformIcons platforms={check.platforms} className="text-muted-foreground" /> : null}
            {check.remediation && (
              <Badge variant="default">
                <RefreshCw />
                Auto-fix
              </Badge>
            )}
            {definition?.graded ? (
              <Badge variant="secondary">
                <Gauge />
                Follows state
              </Badge>
            ) : (
              <SeverityBadge severity={check.severity ?? DEFAULT_SEVERITY} />
            )}
          </span>
          {issues.length > 0 && <CircleExclamationPoint className="size-4 shrink-0 text-critical" aria-label="Has problems" />}
          <Switch checked={enabled} disabled={readOnly} aria-label="Enabled" onCheckedChange={(next) => onChange({ ...check, enabled: next })} />
          {!readOnly && (
            <Button variant="ghost" size="icon-sm" aria-label={`Remove ${check.name ?? check.id}`} className="hover:text-critical" onClick={onRemove}>
              <Trash2 />
            </Button>
          )}
        </div>
        <CollapsibleContent>
          <fieldset disabled={readOnly} className="grid grid-cols-1 gap-4 border-t border-border p-4">
            {issues.some((issue) => issue.path === '') && (
              <p className="rounded-lg bg-critical/[0.05] px-3 py-2 text-dense text-critical ring-1 ring-critical/20">
                {issues.find((issue) => issue.path === '')?.message}
              </p>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field data-invalid={Boolean(firstIssue(issues, 'name')) || undefined}>
                <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
                <Input
                  id={`${id}-name`}
                  value={check.name ?? ''}
                  maxLength={120}
                  placeholder={definition?.label}
                  onChange={(event) => onChange(renameCheck(check, event.target.value, taken))}
                />
                <FieldError>{firstIssue(issues, 'name')}</FieldError>
              </Field>
              <Field data-invalid={Boolean(firstIssue(issues, 'id')) || undefined}>
                <FieldLabel htmlFor={`${id}-id`}>Check ID</FieldLabel>
                <Input
                  id={`${id}-id`}
                  className="font-mono"
                  value={check.id}
                  spellCheck={false}
                  onChange={(event) => onChange({ ...check, id: event.target.value })}
                />
                {firstIssue(issues, 'id') ? (
                  <FieldError>{firstIssue(issues, 'id')}</FieldError>
                ) : (
                  <FieldDescription>A later layer can override or disable this check by its ID.</FieldDescription>
                )}
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <IntervalField
                id={`${id}-interval`}
                value={check.interval_secs}
                error={firstIssue(issues, 'interval_secs')}
                disabled={readOnly}
                onChange={(interval_secs) => onChange({ ...check, interval_secs })}
              />
              <Field data-invalid={Boolean(firstIssue(issues, 'severity')) || undefined}>
                <FieldLabel>Alert severity</FieldLabel>
                {definition?.graded ? (
                  <p className="flex min-h-(--control-h) items-center gap-2 rounded-lg bg-surface-2 px-3 py-1.5 text-dense text-muted-foreground ring-1 ring-border">
                    <Gauge className="size-4 shrink-0 text-subtle-foreground" />
                    Follows the check’s state: warning or critical.
                  </p>
                ) : (
                  <>
                    <div className="max-w-full overflow-x-auto [scrollbar-width:none]">
                      <SeverityControl
                        label="Alert severity"
                        value={check.severity}
                        disabled={readOnly}
                        onChange={(severity) => onChange({ ...check, severity })}
                      />
                    </div>
                    <FieldDescription>A failing check opens an alert with this severity.</FieldDescription>
                  </>
                )}
                <FieldError>{firstIssue(issues, 'severity')}</FieldError>
              </Field>
            </div>
            <Field data-invalid={Boolean(firstIssue(issues, 'platforms')) || undefined}>
              <FieldLabel>Platforms</FieldLabel>
              <div className="flex flex-wrap items-center gap-1.5">
                {available.map((os) => {
                  const pressed = !check.platforms?.length || check.platforms.includes(os)
                  return (
                    <Toggle
                      key={os}
                      variant="outline"
                      size="sm"
                      pressed={pressed}
                      disabled={readOnly || available.length < 2}
                      onPressedChange={() => onChange({ ...check, platforms: togglePlatform(check.platforms, os, available) })}
                      className="gap-1.5 px-2.5 data-[pressed]:border-primary/40 data-[pressed]:bg-primary/[0.07] data-[pressed]:text-foreground"
                    >
                      <OsIcon family={os} className="size-3.5" />
                      {OS_LABEL[os]}
                    </Toggle>
                  )
                })}
              </div>
              <FieldDescription>
                {check.platforms?.length
                  ? `Runs on ${check.platforms.map((os) => OS_LABEL[os]).join(' and ')} only.`
                  : available.length < 3
                    ? `This check type runs on ${available.map((os) => OS_LABEL[os]).join(' and ')}.`
                    : 'Runs on every platform. Deselect one to limit the check.'}
              </FieldDescription>
              <FieldError>{firstIssue(issues, 'platforms')}</FieldError>
            </Field>
            {definition ? (
              <div className="grid grid-cols-1 gap-2">
                <div className="flex items-center gap-2 text-dense font-medium">
                  Settings
                  <span className="text-micro font-normal text-subtle-foreground">{definition.description}</span>
                </div>
                <CheckConfigForm
                  definition={definition}
                  config={config}
                  serverErrors={fieldErrors}
                  readOnly={readOnly}
                  idPrefix={id}
                  onChange={(next) => onChange({ ...check, config: next })}
                />
              </div>
            ) : (
              <p className="rounded-lg bg-warning/[0.07] px-3 py-2 text-dense ring-1 ring-warning/25">
                The check type “{check.type}” isn’t in this server’s catalog. Edit it in Advanced (JSON).
              </p>
            )}
            <RemediationEditor
              remediation={check.remediation}
              issues={issues}
              readOnly={readOnly}
              idPrefix={id}
              onChange={(remediation) => {
                const next = { ...check, remediation }
                if (!remediation) delete next.remediation
                onChange(next)
              }}
            />
          </fieldset>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

function OverrideCard({
  check,
  onChange,
  onRemove,
  readOnly,
  issues,
}: {
  check: MonitoringCheck
  onChange: (check: MonitoringCheck) => void
  onRemove: () => void
  readOnly: boolean
  issues: EditorIssue[]
}) {
  const id = `override-${check.id}`
  const enabledState = check.enabled === undefined ? 'inherit' : check.enabled ? 'on' : 'off'
  const extras = (['config', 'platforms', 'remediation', 'name'] as const).filter((key) => check[key] !== undefined)
  return (
    <div className={cn('grid grid-cols-1 gap-4 rounded-xl border border-dashed border-border-strong bg-card/60 p-4', issues.length > 0 && 'border-critical/40')}>
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-muted-foreground ring-1 ring-border">
          <Layers className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-dense font-medium">
            Override of <code className="rounded-sm bg-surface-3 px-1.5 font-mono text-[12px]">{check.id}</code>
          </div>
          <p className="text-micro text-muted-foreground">
            Changes a check that an earlier layer defines. Fields left on “Inherit” keep that layer’s value.
          </p>
        </div>
        {!readOnly && (
          <Button variant="ghost" size="icon-sm" aria-label={`Remove override of ${check.id}`} className="hover:text-critical" onClick={onRemove}>
            <Trash2 />
          </Button>
        )}
      </div>
      <fieldset disabled={readOnly} className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <Field>
          <FieldLabel>Enabled</FieldLabel>
          <ToggleGroup
            className={SEGMENTED}
            value={[enabledState]}
            onValueChange={(next: string[]) => {
              if (!next[0]) return
              const updated = { ...check, enabled: next[0] === 'inherit' ? undefined : next[0] === 'on' }
              if (updated.enabled === undefined) delete updated.enabled
              onChange(updated)
            }}
            variant="outline"
            spacing={0}
            size="sm"
            aria-label="Enabled"
          >
            <ToggleGroupItem value="inherit" className="px-3">
              Inherit
            </ToggleGroupItem>
            <ToggleGroupItem value="on" className="px-3 data-[pressed]:text-success">
              On
            </ToggleGroupItem>
            <ToggleGroupItem value="off" className="px-3 data-[pressed]:text-critical">
              Off
            </ToggleGroupItem>
          </ToggleGroup>
        </Field>
        <Field data-invalid={Boolean(firstIssue(issues, 'interval_secs')) || undefined}>
          <FieldLabel htmlFor={`${id}-interval`} className="flex w-full items-center justify-between gap-2">
            Interval
            <Switch
              size="sm"
              checked={check.interval_secs !== undefined}
              aria-label="Override the interval"
              onCheckedChange={(on) => {
                const updated = { ...check, interval_secs: on ? DEFAULT_INTERVAL_SECS : undefined }
                if (!on) delete updated.interval_secs
                onChange(updated)
              }}
            />
          </FieldLabel>
          {check.interval_secs !== undefined ? (
            <SimpleSelect
              id={`${id}-interval`}
              value={intervalChoice(check.interval_secs) === 'custom' ? null : String(check.interval_secs)}
              onValueChange={(value) => onChange({ ...check, interval_secs: Number(value) })}
              options={INTERVAL_PRESETS.map((seconds) => ({ value: String(seconds), label: `Every ${formatInterval(seconds)}` }))}
              placeholder={`Every ${formatInterval(check.interval_secs)}`}
            />
          ) : (
            <p className="flex h-(--control-h) items-center text-dense text-muted-foreground">Inherited</p>
          )}
          <FieldError>{firstIssue(issues, 'interval_secs')}</FieldError>
        </Field>
        <Field>
          <FieldLabel>Severity</FieldLabel>
          <div className="max-w-full overflow-x-auto [scrollbar-width:none]">
            <SeverityControl
              label="Severity override"
              inherit
              value={check.severity}
              onChange={(severity) => {
                const updated = { ...check, severity }
                if (!severity) delete updated.severity
                onChange(updated)
              }}
            />
          </div>
        </Field>
      </fieldset>
      <p className="text-micro text-subtle-foreground">
        {extras.length
          ? `Also overrides ${extras.join(', ')} — edit those in Advanced (JSON).`
          : 'Threshold and other setting overrides are edited in Advanced (JSON), for example "config": { "warn_pct": 80 }.'}
      </p>
    </div>
  )
}

function ServerRow({
  settingKey,
  doc,
  onChange,
  readOnly,
  issue,
  defaultOfflineMinutes,
}: {
  settingKey: ServerKey
  doc: PolicyDocument
  onChange: (doc: PolicyDocument) => void
  readOnly: boolean
  issue?: string
  defaultOfflineMinutes: number
}) {
  const meta = SERVER_SETTINGS[settingKey]
  const value = doc.monitoring?.server?.[settingKey]
  const overridden = value !== undefined
  const fallback = settingKey === 'offline_minutes' ? defaultOfflineMinutes : meta.fallback
  const describe = (raw: unknown) => {
    if (meta.kind === 'boolean') return raw ? 'On' : 'Off'
    if (meta.kind === 'severity') return SEVERITY_LABEL[raw as AlertSeverity]
    if (raw === 0) return 'Off'
    return meta.kind === 'minutes' ? formatMinutes(raw as number) : `${raw} days`
  }
  const set = (next: unknown) => onChange(setServerKey(doc, settingKey, next as never))
  let control: ReactNode = null
  if (overridden) {
    if (meta.kind === 'boolean')
      control = (
        <ToggleGroup
          className={SEGMENTED}
          value={[value ? 'on' : 'off']}
          onValueChange={(next: string[]) => next[0] && set(next[0] === 'on')}
          variant="outline"
          spacing={0}
          size="sm"
          disabled={readOnly}
          aria-label={meta.label}
        >
          <ToggleGroupItem value="on" className="px-3 data-[pressed]:text-success">
            On
          </ToggleGroupItem>
          <ToggleGroupItem value="off" className="px-3 data-[pressed]:text-critical">
            Off
          </ToggleGroupItem>
        </ToggleGroup>
      )
    else if (meta.kind === 'severity')
      control = <SeverityControl label={meta.label} value={value as AlertSeverity} disabled={readOnly} onChange={(next) => set(next ?? 'critical')} />
    else
      control = (
        <Field data-invalid={Boolean(issue) || undefined}>
          <div className="relative">
            <Input
              type="number"
              min={0}
              max={meta.max}
              className="tabular pr-20"
              disabled={readOnly}
              aria-label={meta.label}
              value={Number.isNaN(value) ? '' : (value as number)}
              onChange={(event) => set(event.target.value === '' ? Number.NaN : Number(event.target.value))}
            />
            <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-micro text-subtle-foreground">
              {meta.kind === 'minutes' ? 'minutes' : 'days'}
            </span>
          </div>
          {issue ? <FieldError>{issue}</FieldError> : <FieldDescription>0 turns it off · up to {meta.max}</FieldDescription>}
        </Field>
      )
  }
  return (
    <div className={cn('grid gap-3 px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,18rem)] sm:items-center', issue && 'bg-critical/[0.03]')}>
      <div className="flex items-start gap-3">
        <Switch
          className="mt-0.5"
          checked={overridden}
          disabled={readOnly}
          aria-label={`Set ${meta.label} in this policy`}
          onCheckedChange={(checked) => set(checked ? fallback : undefined)}
        />
        <div className="min-w-0">
          <div className="text-dense font-medium">{meta.label}</div>
          <p className="text-micro text-muted-foreground">{meta.description}</p>
        </div>
      </div>
      {overridden ? (
        <div className="max-w-full overflow-x-auto [scrollbar-width:none] sm:justify-self-end">{control}</div>
      ) : (
        <div className="text-dense text-muted-foreground sm:text-right">
          Inherited · default <span className="tabular font-medium text-foreground">{describe(fallback)}</span>
          {settingKey === 'offline_minutes' && <span className="block text-micro text-subtle-foreground">from the monitoring settings</span>}
        </div>
      )}
    </div>
  )
}

/**
 * The Monitoring tab. `readOnly` covers people without `policies.manage`; `locked` adds the case of
 * missing `monitors.manage`, with a notice.
 */
export function PolicyMonitoringTab({
  doc,
  onChange,
  readOnly,
  locked,
  issues,
  catalog,
  catalogLoading,
  defaultOfflineMinutes = 15,
}: {
  doc: PolicyDocument
  onChange: (doc: PolicyDocument) => void
  readOnly: boolean
  locked: boolean
  issues: EditorIssue[]
  catalog: CheckTypeDefinition[]
  catalogLoading: boolean
  defaultOfflineMinutes?: number
}) {
  const [picking, setPicking] = useState(false)
  const [added, setAdded] = useState<number | null>(null)
  const checks = doc.monitoring?.checks ?? []
  const ids = checks.map((check) => check.id)
  const disabled = readOnly || locked
  const full = checks.filter((check) => !isOverride(check)).length
  const overrides = checks.length - full
  const sectionIssue = issues.find((issue) => issue.path === 'monitoring.checks' || issue.path === 'monitoring')
  const add = (definition: CheckTypeDefinition) => {
    setPicking(false)
    setAdded(checks.length)
    onChange(setChecks(doc, [...checks, newCheck(definition, ids)]))
  }
  return (
    <div className="grid grid-cols-1 gap-5">
      {locked && !readOnly && (
        <p className="flex items-start gap-2.5 rounded-xl bg-surface-2 px-4 py-3 text-dense text-muted-foreground ring-1 ring-border">
          <Lock className="mt-0.5 size-4 shrink-0" />
          <span>
            Monitoring checks need the <span className="font-medium text-foreground">Manage monitoring</span> permission in addition to Manage
            policies. You can review them here; the other tabs stay editable.
          </span>
        </p>
      )}

      <section className="grid grid-cols-1 gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold tracking-tight">Agent checks</h3>
            <p className="mt-0.5 text-dense text-muted-foreground">
              {checks.length
                ? `${full} ${full === 1 ? 'check' : 'checks'}${overrides ? ` and ${overrides} ${overrides === 1 ? 'override' : 'overrides'}` : ''}. Checks merge by ID with the other layers.`
                : 'Checks run on every device this policy reaches; failing checks open alerts.'}
            </p>
          </div>
          {!disabled && checks.length > 0 && (
            <Button size="sm" onClick={() => setPicking(true)} disabled={checks.length >= MAX_CHECKS}>
              <Plus data-icon="inline-start" />
              Add check
            </Button>
          )}
        </div>
        {sectionIssue && (
          <p className="rounded-lg bg-critical/[0.05] px-3 py-2 text-dense text-critical ring-1 ring-critical/20">{sectionIssue.message}</p>
        )}
        {checks.length === 0 ? (
          <EmptyState
            compact
            illustration="alerts"
            title="No checks in this policy"
            description="Add CPU, disk, service, HTTP and other checks. Devices inherit checks from every layer of their effective policy."
            actions={
              !disabled && (
                <Button size="sm" onClick={() => setPicking(true)}>
                  <Plus data-icon="inline-start" />
                  Add check
                </Button>
              )
            }
          />
        ) : (
          checks.map((check, index) => {
            const mine = checkIssues(issues, index, check.id)
            const set = (next: MonitoringCheck) => onChange(updateCheck(doc, index, next))
            const remove = () => onChange(removeCheck(doc, index))
            return isOverride(check) ? (
              <OverrideCard key={index} check={check} onChange={set} onRemove={remove} readOnly={disabled} issues={mine} />
            ) : (
              <CheckCard
                key={index}
                check={check}
                definition={catalog.find((item) => item.type === check.type)}
                catalog={catalog}
                onChange={set}
                onRemove={remove}
                readOnly={disabled}
                issues={mine}
                taken={ids.filter((_, position) => position !== index)}
                defaultOpen={added === index}
              />
            )
          })
        )}
      </section>

      <section className="overflow-hidden rounded-xl bg-card shadow-card">
        <div className="flex items-start gap-3 border-b border-border px-4 py-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-muted-foreground ring-1 ring-border">
            <ServerCog className="size-4" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">Server-side checks</h3>
            <p className="text-micro text-muted-foreground">
              Evaluated by the server for the devices this policy reaches: offline devices, outdated agents, disk fill forecasts and security
              changes.
            </p>
          </div>
        </div>
        <div className="divide-y divide-border">
          {SERVER_KEYS.map((key) => (
            <ServerRow
              key={key}
              settingKey={key}
              doc={doc}
              onChange={onChange}
              readOnly={disabled}
              defaultOfflineMinutes={defaultOfflineMinutes}
              issue={issues.find((issue) => issue.path === `monitoring.server.${key}`)?.message}
            />
          ))}
        </div>
      </section>

      <CheckTypePicker
        open={picking}
        onOpenChange={setPicking}
        catalog={catalog}
        loading={catalogLoading}
        usedTypes={checks.map((check) => check.type ?? '')}
        onPick={add}
      />
    </div>
  )
}
