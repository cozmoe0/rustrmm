import { useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  ArrowLeft,
  ChevronDown,
  ChevronsUpDown,
  CircleCheck,
  CircleExclamationPoint,
  Ellipsis,
  Pencil,
  Plus,
  Save,
  ScrollText,
  Trash,
  Trash2,
  Undo2,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, RelativeTime } from '@/components/common/misc'
import { OsIcon } from '@/components/common/os-icon'
import { PageContainer } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/simple-select'
import { policiesApi } from '@/lib/api/endpoints'
import { errorMessage, isApiError } from '@/lib/api/errors'
import {
  checkTypesQuery,
  clientsQuery,
  devicesQuery,
  groupsQuery,
  keys,
  monitoringSettingsQuery,
  policyQuery,
  scriptQuery,
  scriptsQuery,
  sitesQuery,
} from '@/lib/api/queries'
import type { Policy, PolicyDocument, PolicyTargetType, PolicyTask } from '@/lib/api/types'
import { OFFLINE_WAIT_OPTIONS } from '@/lib/automation/labels'
import { defaultParameterValues, toApiParameters, validateParameterValues } from '@/lib/automation/params'
import {
  AGENT_KEYS,
  AGENT_SETTINGS,
  CONSENT_TIMEOUT_RANGE,
  DESKTOP_CONSENT_LABEL,
  DESKTOP_POLICY_DEFAULTS,
  DESKTOP_POLICY_SETTINGS,
  REMOTE_KEYS,
  REMOTE_SETTINGS,
  TARGET_TYPE_LABEL,
  compactPolicy,
  formatAgentValue,
  newTask,
  parsePolicyJson,
  sortSources,
  taskIdFromName,
  validatePolicyDocument,
  type AgentKey,
  type DesktopPolicyKey,
  type PolicyIssue,
  type RemoteKey,
} from '@/lib/automation/policy'
import { describeCron, localTimeZone } from '@/lib/cron'
import { monitoringChanged } from '@/lib/monitoring/policy-editor'
import { PolicyMonitoringTab } from '@/features/monitoring/policy-monitoring-tab'
import { PolicyPatchingTab } from '@/features/patching/policy-patching-tab'
import { patchingChanged } from '@/lib/patching/policy'
import { escrowChanged } from '@/lib/escrow/policy'
import { PolicyEscrowTab } from '@/features/secrets/policy-escrow-tab'
import { deviceName } from '@/lib/devices'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { LanguageMark } from './automation-ui'
import { CodeEditor } from './code-editor'
import { ParameterForm } from './parameter-form'
import { AssignmentChip } from './policies-page'
import { TARGET_ICON } from './target-icons'
import { ScriptPicker } from './run-dialog'
import { CronField } from './schedule-editor'
import { UnsavedChangesGuard } from './unsaved-guard'
import { SEGMENTED } from './styles'

export type PolicyTab = 'agent' | 'remote' | 'tasks' | 'monitoring' | 'patching' | 'escrow' | 'json' | 'assignments'

interface Draft {
  name: string
  description: string
  document: PolicyDocument
}

function issuesFor(issues: PolicyIssue[], prefix: string) {
  return issues.filter(
    (issue) => issue.path === prefix || issue.path.startsWith(`${prefix}.`) || issue.path.startsWith(`${prefix}[`),
  )
}

// ------------------------------------------------------------------ sections

function AgentSection({
  doc,
  onChange,
  readOnly,
  issues,
}: {
  doc: PolicyDocument
  onChange: (doc: PolicyDocument) => void
  readOnly: boolean
  issues: PolicyIssue[]
}) {
  const set = (key: AgentKey, value: number | undefined) => {
    const agent = { ...doc.agent }
    if (value === undefined) delete agent[key]
    else agent[key] = value
    onChange({ ...doc, agent })
  }
  return (
    <div className="grid grid-cols-1 gap-3">
      {AGENT_KEYS.map((key) => {
        const meta = AGENT_SETTINGS[key]
        const value = doc.agent?.[key]
        const overridden = value !== undefined
        const problem = issuesFor(issues, `agent.${key}`)[0]
        return (
          <div
            key={key}
            className={cn(
              'grid gap-3 rounded-xl bg-card p-4 shadow-card sm:grid-cols-[minmax(0,1fr)_minmax(0,18rem)] sm:items-center',
              problem && 'ring-1 ring-critical/30',
            )}
          >
            <div className="flex items-start gap-3">
              <Switch
                className="mt-0.5"
                checked={overridden}
                disabled={readOnly}
                aria-label={`Set ${meta.label} in this policy`}
                onCheckedChange={(checked) => set(key, checked ? meta.fallback : undefined)}
              />
              <div className="min-w-0">
                <div className="text-dense font-medium">{meta.label}</div>
                <p className="text-micro text-muted-foreground">{meta.description}</p>
              </div>
            </div>
            {overridden ? (
              <Field data-invalid={Boolean(problem) || undefined}>
                <div className="relative">
                  <Input
                    type="number"
                    min={meta.min}
                    max={meta.max}
                    className="tabular pr-20"
                    disabled={readOnly}
                    aria-label={meta.label}
                    value={Number.isNaN(value) ? '' : value}
                    onChange={(event) => set(key, event.target.value === '' ? Number.NaN : Number(event.target.value))}
                  />
                  <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-micro text-subtle-foreground">
                    {meta.unit}
                  </span>
                </div>
                {problem ? (
                  <FieldError>{problem.message}</FieldError>
                ) : (
                  <FieldDescription>
                    Allowed {meta.min}–{meta.max} {meta.unit}
                    {Number.isFinite(value) ? ` · ${formatAgentValue(key, value!)}` : ''}
                  </FieldDescription>
                )}
              </Field>
            ) : (
              <div className="text-dense text-muted-foreground sm:text-right">
                Inherited · default{' '}
                <span className="tabular font-medium text-foreground">{formatAgentValue(key, meta.fallback)}</span>
              </div>
            )}
          </div>
        )
      })}
      <p className="px-1 text-micro text-subtle-foreground">
        Agent settings are pushed to every affected online device as soon as you save, and applied when offline devices
        reconnect.
      </p>
    </div>
  )
}

function RemoteSection({
  doc,
  onChange,
  readOnly,
}: {
  doc: PolicyDocument
  onChange: (doc: PolicyDocument) => void
  readOnly: boolean
}) {
  const set = (key: RemoteKey, value: 'inherit' | 'allow' | 'block') => {
    const remote = { ...doc.remote_access }
    if (value === 'inherit') delete remote[key]
    else remote[key] = value === 'allow'
    onChange({ ...doc, remote_access: remote })
  }
  return (
    <div className="grid grid-cols-1 gap-3">
      {REMOTE_KEYS.map((key) => {
        const value = doc.remote_access?.[key]
        const state = value === undefined ? 'inherit' : value ? 'allow' : 'block'
        return (
          <div
            key={key}
            className="flex flex-col gap-3 rounded-xl bg-card p-4 shadow-card sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <div className="text-dense font-medium">{REMOTE_SETTINGS[key].label}</div>
              <p className="text-micro text-muted-foreground">{REMOTE_SETTINGS[key].description}</p>
            </div>
            <ToggleGroup
              className={SEGMENTED}
              value={[state]}
              onValueChange={(next: string[]) => next[0] && set(key, next[0] as 'inherit' | 'allow' | 'block')}
              variant="outline"
              spacing={0}
              size="sm"
              disabled={readOnly}
              aria-label={REMOTE_SETTINGS[key].label}
            >
              <ToggleGroupItem value="inherit" className="px-3">
                Inherit
              </ToggleGroupItem>
              <ToggleGroupItem value="allow" className="px-3 data-[pressed]:text-success">
                Allow
              </ToggleGroupItem>
              <ToggleGroupItem value="block" className="px-3 data-[pressed]:text-critical">
                Block
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        )
      })}
      <DesktopRules doc={doc} onChange={onChange} readOnly={readOnly} />
      <p className="px-1 text-micro text-subtle-foreground">
        Blocked tools are refused by the server’s remote-tools API with “disabled by policy”, whatever a user’s
        permissions are.
      </p>
    </div>
  )
}

/** Phase 8: consent, banner and view-only rules for remote desktop sessions. */
function DesktopRules({ doc, onChange, readOnly }: { doc: PolicyDocument; onChange: (doc: PolicyDocument) => void; readOnly: boolean }) {
  const remote = doc.remote_access ?? {}
  const [timeoutText, setTimeoutText] = useState(remote.consent_timeout_secs !== undefined ? String(remote.consent_timeout_secs) : '')
  const update = (key: DesktopPolicyKey, value: unknown) => {
    const next: Record<string, unknown> = { ...doc.remote_access }
    if (value === undefined) delete next[key]
    else next[key] = value
    onChange({ ...doc, remote_access: next })
  }
  const timeoutValue = Number(timeoutText)
  const timeoutError =
    timeoutText.trim() !== '' &&
    (!Number.isInteger(timeoutValue) || timeoutValue < CONSENT_TIMEOUT_RANGE.min || timeoutValue > CONSENT_TIMEOUT_RANGE.max)
      ? `Use ${CONSENT_TIMEOUT_RANGE.min}–${CONSENT_TIMEOUT_RANGE.max} seconds`
      : null
  const blocked = remote.desktop === false
  const tri = (key: 'desktop_banner' | 'desktop_view_only', on: string, off: string) => {
    const value = remote[key]
    return (
      <ToggleGroup
        className={SEGMENTED}
        value={[value === undefined ? 'inherit' : value ? 'on' : 'off']}
        onValueChange={(next: string[]) => next[0] && update(key, next[0] === 'inherit' ? undefined : next[0] === 'on')}
        variant="outline"
        spacing={0}
        size="sm"
        disabled={readOnly}
        aria-label={DESKTOP_POLICY_SETTINGS[key].label}
      >
        <ToggleGroupItem value="inherit" className="px-3">
          Inherit
        </ToggleGroupItem>
        <ToggleGroupItem value="on" className="px-3">
          {on}
        </ToggleGroupItem>
        <ToggleGroupItem value="off" className="px-3">
          {off}
        </ToggleGroupItem>
      </ToggleGroup>
    )
  }
  const row = (key: DesktopPolicyKey, control: ReactNode) => (
    <div key={key} className="flex flex-col gap-2.5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="text-dense font-medium">{DESKTOP_POLICY_SETTINGS[key].label}</div>
        <p className="text-micro text-muted-foreground">{DESKTOP_POLICY_SETTINGS[key].description}</p>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  )
  return (
    <div className={cn('overflow-hidden rounded-xl bg-card shadow-card', blocked && 'opacity-60')}>
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <div className="text-dense font-semibold">Remote desktop sessions</div>
        {blocked && <span className="text-micro text-subtle-foreground">Remote desktop is blocked by this policy</span>}
      </div>
      <div className="divide-y divide-border">
        {row(
          'desktop_consent',
          <SimpleSelect
            size="sm"
            className="w-full sm:w-[230px]"
            ariaLabel={DESKTOP_POLICY_SETTINGS.desktop_consent.label}
            disabled={readOnly}
            value={remote.desktop_consent ?? 'inherit'}
            onValueChange={(value) => update('desktop_consent', value === 'inherit' ? undefined : value)}
            options={[
              { value: 'inherit', label: `Inherit (${DESKTOP_CONSENT_LABEL[DESKTOP_POLICY_DEFAULTS.desktop_consent].toLowerCase()})` },
              ...(Object.keys(DESKTOP_CONSENT_LABEL) as (keyof typeof DESKTOP_CONSENT_LABEL)[]).map((mode) => ({ value: mode, label: DESKTOP_CONSENT_LABEL[mode] })),
            ]}
          />,
        )}
        {row(
          'consent_timeout_secs',
          <div className="grid gap-1">
            <div className="flex items-center gap-2">
              <Input
                inputMode="numeric"
                className="h-7 w-24 text-dense"
                placeholder={String(DESKTOP_POLICY_DEFAULTS.consent_timeout_secs)}
                aria-label={DESKTOP_POLICY_SETTINGS.consent_timeout_secs.label}
                aria-invalid={timeoutError ? true : undefined}
                disabled={readOnly}
                value={timeoutText}
                onChange={(event) => {
                  const text = event.target.value.replace(/[^0-9]/g, '')
                  setTimeoutText(text)
                  const value = Number(text)
                  if (text === '') update('consent_timeout_secs', undefined)
                  else if (Number.isInteger(value) && value >= CONSENT_TIMEOUT_RANGE.min && value <= CONSENT_TIMEOUT_RANGE.max) update('consent_timeout_secs', value)
                }}
              />
              <span className="text-micro text-muted-foreground">seconds</span>
            </div>
            {timeoutError && <span className="text-micro text-critical">{timeoutError}</span>}
          </div>,
        )}
        {row('desktop_banner', tri('desktop_banner', 'Show', 'Hide'))}
        {row('desktop_view_only', tri('desktop_view_only', 'Force', 'Off'))}
      </div>
    </div>
  )
}

function TaskCard({
  task,
  onChange,
  onRemove,
  readOnly,
  issues,
  taken,
}: {
  task: PolicyTask
  onChange: (task: PolicyTask) => void
  onRemove: () => void
  readOnly: boolean
  issues: PolicyIssue[]
  taken: string[]
}) {
  const [open, setOpen] = useState(!task.script_id)
  const { data: script } = useQuery({ ...scriptQuery(task.script_id), enabled: Boolean(task.script_id) })
  const values = { ...(script ? defaultParameterValues(script.parameters) : {}), ...task.parameters }
  const paramErrors = script ? validateParameterValues(script.parameters, values) : {}
  const hasProblems = issues.length > 0 || Object.keys(paramErrors).length > 0
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className={cn('overflow-hidden rounded-xl bg-card shadow-card', hasProblems && 'ring-1 ring-critical/30')}>
        <div className="flex items-center gap-3 px-4 py-3">
          <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronDown
              className={cn('size-4 shrink-0 text-muted-foreground transition-transform', !open && '-rotate-90')}
            />
            {script ? (
              <LanguageMark language={script.language} size="sm" />
            ) : (
              <span className="h-5 w-7 rounded-[5px] bg-surface-3" />
            )}
            <span className="min-w-0">
              <span className="block truncate text-dense font-medium">{task.name || 'Untitled task'}</span>
              <span className="block truncate text-micro text-muted-foreground">
                {script?.name ?? 'No script chosen'} · {describeCron(task.cron)} · {task.timezone.replace(/_/g, ' ')}
              </span>
            </span>
          </CollapsibleTrigger>
          {hasProblems && <CircleExclamationPoint className="size-4 shrink-0 text-critical" />}
          <Switch
            checked={task.enabled}
            disabled={readOnly}
            aria-label="Enabled"
            onCheckedChange={(enabled) => onChange({ ...task, enabled })}
          />
          {!readOnly && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove ${task.name}`}
              className="hover:text-critical"
              onClick={onRemove}
            >
              <Trash2 />
            </Button>
          )}
        </div>
        <CollapsibleContent>
          <fieldset disabled={readOnly} className="grid grid-cols-1 gap-4 border-t border-border p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field data-invalid={Boolean(issuesFor(issues, 'name').length) || undefined}>
                <FieldLabel htmlFor={`task-${task.id}-name`}>Name</FieldLabel>
                <Input
                  id={`task-${task.id}-name`}
                  value={task.name}
                  maxLength={80}
                  onChange={(event) => {
                    const name = event.target.value
                    const autoId = task.id === taskIdFromName(task.name, taken)
                    onChange({ ...task, name, ...(autoId ? { id: taskIdFromName(name, taken) } : {}) })
                  }}
                />
              </Field>
              <Field data-invalid={Boolean(issuesFor(issues, 'id').length) || undefined}>
                <FieldLabel htmlFor={`task-${task.id}-id`}>Task ID</FieldLabel>
                <Input
                  id={`task-${task.id}-id`}
                  className="font-mono"
                  value={task.id}
                  spellCheck={false}
                  onChange={(event) => onChange({ ...task, id: event.target.value })}
                />
                <FieldDescription>A task with the same ID in a later layer replaces this one.</FieldDescription>
                <FieldError>{issuesFor(issues, 'id')[0]?.message}</FieldError>
              </Field>
            </div>
            <Field data-invalid={Boolean(issuesFor(issues, 'script_id').length) || undefined}>
              <FieldLabel>Script</FieldLabel>
              <ScriptPicker
                value={task.script_id || null}
                onChange={(scriptId) => onChange({ ...task, script_id: scriptId, parameters: {} })}
              />
              <FieldError>{issuesFor(issues, 'script_id')[0]?.message}</FieldError>
            </Field>
            {script && (
              <div className="grid grid-cols-1 gap-2">
                <div className="text-dense font-medium">Parameters</div>
                <ParameterForm
                  parameters={script.parameters}
                  values={values}
                  errors={paramErrors}
                  disabled={readOnly}
                  idPrefix={`task-${task.id}`}
                  onChange={(name, value) =>
                    onChange({ ...task, parameters: toApiParameters(script.parameters, { ...values, [name]: value }) })
                  }
                />
              </div>
            )}
            <CronField
              cron={task.cron}
              timezone={task.timezone}
              idPrefix={`task-${task.id}`}
              onCronChange={(cron) => onChange({ ...task, cron })}
              onTimezoneChange={(timezone) => onChange({ ...task, timezone })}
            />
            <Field className="sm:max-w-xs">
              <FieldLabel htmlFor={`task-${task.id}-wait`}>Offline devices</FieldLabel>
              <SimpleSelect
                id={`task-${task.id}-wait`}
                value={String(task.offline_wait_minutes ?? 720)}
                disabled={readOnly}
                onValueChange={(value) => onChange({ ...task, offline_wait_minutes: Number(value) })}
                options={OFFLINE_WAIT_OPTIONS.map((option) => ({
                  value: String(option.value),
                  label: option.value === 0 ? option.label : `Wait up to ${option.label}`,
                }))}
              />
            </Field>
          </fieldset>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

function TasksSection({
  doc,
  onChange,
  readOnly,
  issues,
}: {
  doc: PolicyDocument
  onChange: (doc: PolicyDocument) => void
  readOnly: boolean
  issues: PolicyIssue[]
}) {
  const tasks = doc.tasks ?? []
  const ids = tasks.map((task) => task.id)
  const set = (next: PolicyTask[]) => onChange({ ...doc, tasks: next })
  return (
    <div className="grid grid-cols-1 gap-3">
      {tasks.length === 0 ? (
        <EmptyState
          compact
          illustration="automation"
          title="No scheduled tasks"
          description="Tasks run a script on every device this policy reaches, on a cron schedule in a time zone you choose."
          actions={
            !readOnly && (
              <Button size="sm" onClick={() => set([newTask(ids, localTimeZone())])}>
                <Plus data-icon="inline-start" />
                Add task
              </Button>
            )
          }
        />
      ) : (
        tasks.map((task, index) => (
          <TaskCard
            key={index}
            task={task}
            readOnly={readOnly}
            taken={ids.filter((_, position) => position !== index)}
            issues={issuesFor(issues, `tasks[${index}]`).map((issue) => ({
              ...issue,
              path: issue.path.replace(`tasks[${index}].`, ''),
            }))}
            onChange={(next) => set(tasks.map((item, position) => (position === index ? next : item)))}
            onRemove={() => set(tasks.filter((_, position) => position !== index))}
          />
        ))
      )}
      {!readOnly && tasks.length > 0 && (
        <Button
          variant="outline"
          size="sm"
          className="justify-self-start"
          onClick={() => set([...tasks, newTask(ids, localTimeZone())])}
        >
          <Plus data-icon="inline-start" />
          Add task
        </Button>
      )}
    </div>
  )
}

function JsonSection({
  text,
  onText,
  issues,
  readOnly,
}: {
  text: string
  onText: (text: string) => void
  issues: PolicyIssue[]
  readOnly: boolean
}) {
  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="overflow-hidden rounded-xl bg-card shadow-card">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <code className="font-mono text-[12px] text-muted-foreground">policy.json</code>
          {issues.length === 0 ? (
            <Badge variant="success">
              <CircleCheck />
              Valid
            </Badge>
          ) : (
            <Badge variant="critical">
              <CircleExclamationPoint />
              {issues.length} {issues.length === 1 ? 'problem' : 'problems'}
            </Badge>
          )}
        </div>
        <CodeEditor
          value={text}
          onChange={onText}
          language="json"
          readOnly={readOnly}
          height="clamp(360px, calc(100dvh - 420px), 720px)"
          ariaLabel="Policy JSON"
        />
      </div>
      <aside className="grid grid-cols-1 content-start gap-2 rounded-xl bg-card p-4 shadow-card">
        <h3 className="text-sm font-semibold">Validation</h3>
        {issues.length === 0 ? (
          <p className="text-dense text-muted-foreground">
            The document is valid. Changes here update the other tabs as you type.
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-2">
            {issues.map((issue, index) => (
              <li
                key={`${issue.path}-${index}`}
                className="grid grid-cols-1 gap-0.5 rounded-lg bg-critical/[0.05] px-3 py-2 text-dense ring-1 ring-critical/20"
              >
                {issue.path && <code className="font-mono text-[11px] text-critical">{issue.path}</code>}
                <span>{issue.message}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-micro text-subtle-foreground">
          Sections: <code className="font-mono">agent</code>, <code className="font-mono">remote_access</code>,{' '}
          <code className="font-mono">tasks</code>, <code className="font-mono">patching</code>, <code className="font-mono">escrow</code> and <code className="font-mono">monitoring</code> (
          <code className="font-mono">checks</code>, <code className="font-mono">server</code>). Checks without a{' '}
          <code className="font-mono">type</code> override a check from an earlier layer, for example{' '}
          <code className="font-mono">{'{ "id": "cpu-high", "config": { "warn_pct": 80 } }'}</code>. Unknown sections are refused.
        </p>
      </aside>
    </div>
  )
}

// ------------------------------------------------------------------ assignments

function TargetCombobox({
  options,
  value,
  onChange,
  placeholder,
}: {
  options: { value: string; label: string; hint?: string; icon?: ReactNode }[]
  value: string | null
  onChange: (value: string) => void
  placeholder: string
}) {
  const [open, setOpen] = useState(false)
  const current = options.find((option) => option.value === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between font-normal"
          />
        }
      >
        <span className={cn('flex min-w-0 items-center gap-2 truncate', !current && 'text-muted-foreground')}>
          {current?.icon}
          {current?.label ?? placeholder}
        </span>
        <ChevronsUpDown className="text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent className="w-(--anchor-width) min-w-72 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search…" />
          <CommandList className="max-h-72">
            <CommandEmpty>Nothing matches.</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={`${option.label} ${option.hint ?? ''}`}
                  data-checked={option.value === value}
                  onSelect={() => {
                    onChange(option.value)
                    setOpen(false)
                  }}
                >
                  {option.icon}
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.hint && (
                    <span className="max-w-[45%] truncate text-micro text-subtle-foreground">{option.hint}</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function AssignDialog({
  policy,
  open,
  onOpenChange,
}: {
  policy: Policy
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const { data: clients = [] } = useQuery(clientsQuery())
  const { data: sites = [] } = useQuery(sitesQuery())
  const { data: groups = [] } = useQuery(groupsQuery())
  const { data: devices = [] } = useQuery(devicesQuery())
  const [type, setType] = useState<PolicyTargetType>('client')
  const [targetId, setTargetId] = useState<string | null>(null)
  const [priority, setPriority] = useState('10')
  const options = useMemo(() => {
    if (type === 'client')
      return clients.map((client) => ({ value: client.id, label: client.name, hint: `${client.device_count} devices` }))
    if (type === 'site')
      return sites.map((site) => ({
        value: site.id,
        label: site.name,
        hint: clients.find((client) => client.id === site.client_id)?.name,
      }))
    if (type === 'group')
      return groups.map((group) => ({
        value: group.id,
        label: group.name,
        hint: `${group.kind} · ${group.member_count} devices`,
      }))
    if (type === 'device')
      return devices
        .filter((device) => device.status === 'active')
        .map((device) => ({
          value: device.id,
          label: deviceName(device),
          hint: device.client_name,
          icon: <OsIcon family={device.os_family} />,
        }))
    return []
  }, [type, clients, sites, groups, devices])
  const assign = useMutation({
    mutationFn: () =>
      policiesApi.assign(policy.id, {
        target_type: type,
        target_id: type === 'global' ? null : targetId,
        priority: Number(priority) || 0,
      }),
    meta: { successMessage: 'Policy assigned' },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.policies })
      onOpenChange(false)
      setTargetId(null)
    },
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Assign “{policy.name}”</DialogTitle>
          <DialogDescription>
            The policy applies to every device the target covers, merged with the other layers.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-4">
          <Field>
            <FieldLabel htmlFor="assign-type">Applies to</FieldLabel>
            <SimpleSelect
              id="assign-type"
              value={type}
              onValueChange={(value) => {
                setType(value as PolicyTargetType)
                setTargetId(null)
              }}
              options={(['global', 'client', 'site', 'group', 'device'] as const).map((item) => {
                const Icon = TARGET_ICON[item]
                return {
                  value: item,
                  label: TARGET_TYPE_LABEL[item],
                  icon: <Icon className="size-3.5 text-subtle-foreground" />,
                }
              })}
            />
          </Field>
          {type !== 'global' && (
            <Field>
              <FieldLabel>{TARGET_TYPE_LABEL[type]}</FieldLabel>
              <TargetCombobox
                options={options}
                value={targetId}
                onChange={setTargetId}
                placeholder={`Choose a ${type}…`}
              />
            </Field>
          )}
          {type === 'group' && (
            <Field>
              <FieldLabel htmlFor="assign-priority">Priority</FieldLabel>
              <Input
                id="assign-priority"
                type="number"
                className="tabular"
                value={priority}
                onChange={(event) => setPriority(event.target.value)}
              />
              <FieldDescription>
                Group layers apply in ascending priority, so a higher number wins over a lower one.
              </FieldDescription>
            </Field>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={(type !== 'global' && !targetId) || assign.isPending} onClick={() => assign.mutate()}>
            {assign.isPending && <Spinner data-icon="inline-start" />}
            Assign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AssignmentsSection({ policy, canManage }: { policy: Policy; canManage: boolean }) {
  const queryClient = useQueryClient()
  const [adding, setAdding] = useState(false)
  const unassign = useMutation({
    mutationFn: (id: string) => policiesApi.unassign(id),
    meta: { successMessage: 'Assignment removed' },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.policies }),
  })
  const assignments = sortSources(policy.assignments)
  return (
    <div className="grid grid-cols-1 gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-dense text-muted-foreground">
          Assignments take effect immediately; devices receive new agent settings when they’re online.
        </p>
        {canManage && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus data-icon="inline-start" />
            Assign
          </Button>
        )}
      </div>
      {assignments.length === 0 ? (
        <EmptyState
          compact
          illustration="automation"
          title="Not assigned"
          description="Assign the policy everywhere, to a client, a site, a group or a single device."
        />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl bg-card shadow-card">
          {assignments.map((assignment) => {
            const Icon = TARGET_ICON[assignment.target_type]
            return (
              <li key={assignment.id} className="flex items-center gap-3 px-4 py-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-muted-foreground">
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-dense font-medium">
                    {assignment.target_type === 'global' ? 'Every managed device' : assignment.target_name}
                  </div>
                  <div className="text-micro text-muted-foreground">
                    {TARGET_TYPE_LABEL[assignment.target_type]}
                    {assignment.target_type === 'group' && ` · priority ${assignment.priority}`}
                  </div>
                </div>
                {canManage && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={unassign.isPending}
                    onClick={() => unassign.mutate(assignment.id)}
                  >
                    Remove
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <AssignDialog policy={policy} open={adding} onOpenChange={setAdding} />
    </div>
  )
}

// ------------------------------------------------------------------ page

function RenameDialog({
  draft,
  open,
  onOpenChange,
  onSave,
}: {
  draft: Draft
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (name: string, description: string) => void
}) {
  const [name, setName] = useState(draft.name)
  const [description, setDescription] = useState(draft.description)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Name and description</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-4">
          <Field data-invalid={!name.trim() || undefined}>
            <FieldLabel htmlFor="rename-policy">Name</FieldLabel>
            <Input id="rename-policy" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="rename-policy-description">Description</FieldLabel>
            <Input
              id="rename-policy-description"
              value={description}
              maxLength={240}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!name.trim()}
            onClick={() => {
              onSave(name.trim(), description.trim())
              onOpenChange(false)
            }}
          >
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function PolicyPage({ policyId, tab }: { policyId: string; tab: PolicyTab }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const me = useMe()
  const { data: policy, isLoading, error, refetch } = useQuery(policyQuery(policyId))
  useQuery(scriptsQuery())
  const checkTypes = useQuery(checkTypesQuery)
  const catalog = checkTypes.data
  const { data: monitoringSettings } = useQuery({
    ...monitoringSettingsQuery,
    enabled: hasPermission(me, PERMISSIONS.settingsView),
    meta: { silent: true },
  })
  const base = useMemo<Draft | null>(
    () => (policy ? { name: policy.name, description: policy.description, document: policy.document } : null),
    [policy],
  )
  const [edit, setEdit] = useState<{ for: string; draft: Draft } | null>(null)
  const [jsonText, setJsonText] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [serverIssue, setServerIssue] = useState<PolicyIssue | null>(null)
  useTitle(policy?.name)
  const canManage = hasPermission(me, PERMISSIONS.policiesManage)
  const canMonitor = hasPermission(me, PERMISSIONS.monitorsManage)
  const canPatch = hasPermission(me, PERMISSIONS.patchesApprove)
  const canEscrow = hasPermission(me, PERMISSIONS.secretsManage)
  const validation = { checkTypes: catalog }
  const draft = edit && edit.for === policyId ? edit.draft : base

  const setDraft = (patch: Partial<Draft>) => draft && setEdit({ for: policyId, draft: { ...draft, ...patch } })
  const setDocument = (document: PolicyDocument) => {
    setDraft({ document })
    setJsonText(null)
    setServerIssue(null)
  }
  const discard = () => {
    setEdit(null)
    setJsonText(null)
    setServerIssue(null)
  }

  const save = useMutation({
    mutationFn: () =>
      policiesApi.update(policyId, {
        name: draft!.name,
        description: draft!.description,
        document: compactPolicy(draft!.document, catalog),
      }),
    meta: { silent: true },
    onSuccess: (updated) => {
      queryClient.setQueryData(keys.policy(policyId), updated)
      void queryClient.invalidateQueries({ queryKey: keys.policies })
      void queryClient.invalidateQueries({ queryKey: keys.jobs })
      discard()
      toast.success(`Saved as version ${updated.version}`)
    },
    onError: (failure) => {
      if (isApiError(failure) && failure.status === 422)
        setServerIssue({
          path: String((failure.details as { path?: string } | undefined)?.path ?? ''),
          message: failure.message,
        })
      toast.error(errorMessage(failure))
    },
  })

  const remove = useMutation({
    mutationFn: () => policiesApi.remove(policyId),
    onSuccess: () => {
      setDeleting(false)
      void queryClient.invalidateQueries({ queryKey: keys.policies })
      toast.success(`Deleted “${policy?.name}”`)
      void navigate({ to: '/automation/policies' })
    },
  })

  const setTab = (next: string) => {
    if (tab === 'json' && next !== 'json' && jsonText !== null) {
      const parsed = parsePolicyJson(jsonText, validation)
      if (!parsed.document) toast.warning('The JSON had errors, so the other tabs show the last valid document.')
      setJsonText(null)
    }
    void navigate({
      to: '/automation/policies/$policyId',
      params: { policyId },
      search: (prev) => ({ ...prev, tab: next === 'agent' ? undefined : (next as PolicyTab) }),
      replace: true,
    })
  }

  if (error) {
    return (
      <PageContainer>
        <ErrorState
          error={error}
          title={isApiError(error) && error.status === 404 ? 'Policy not found' : 'Could not load this policy'}
          onRetry={() => void refetch()}
        />
      </PageContainer>
    )
  }
  if (isLoading || !policy || !draft) {
    return (
      <PageContainer className="grid grid-cols-1 gap-4">
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </PageContainer>
    )
  }

  const readOnly = !canManage
  const dirty = JSON.stringify(draft) !== JSON.stringify(base)
  const text = jsonText ?? JSON.stringify(draft.document, null, 2)
  const jsonIssues =
    jsonText !== null ? parsePolicyJson(jsonText, validation).issues : validatePolicyDocument(draft.document, validation)
  const localIssues = validatePolicyDocument(draft.document, validation)
  const issues = [...localIssues, ...(serverIssue ? [serverIssue] : [])]
  const tabProblems = (prefix: string) => issues.some((issue) => issue.path.startsWith(prefix))
  // Changing the monitoring section also needs `monitors.manage`.
  const monitoringBlocked = !canMonitor && monitoringChanged(policy.document, draft.document, catalog)
  // So does the patching section (`patches.approve`), because approval rules approve updates.
  const patchingBlocked = !canPatch && patchingChanged(policy.document, draft.document)
  // And the escrow section (`secrets.manage`), because it controls administrator passwords.
  const escrowBlocked = !canEscrow && escrowChanged(policy.document.escrow, draft.document.escrow)
  const blocked = monitoringBlocked || patchingBlocked || escrowBlocked
  const escrowKeys = Object.keys(draft.document.escrow?.laps ?? {}).length + (draft.document.escrow?.filevault?.escrow !== undefined ? 1 : 0)
  const patchingKeys = Object.keys(draft.document.patching ?? {}).length
  const checkCount = draft.document.monitoring?.checks?.length ?? 0

  return (
    <div className="flex min-h-full flex-col">
      <UnsavedChangesGuard when={dirty && !save.isPending} what="policy changes" />
      <PageContainer className="grid flex-1 grid-cols-1 content-start gap-5 pb-28">
        <header className="grid grid-cols-1 gap-4">
          <Link
            to="/automation/policies"
            className="inline-flex w-fit items-center gap-1 text-dense text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            Policies
          </Link>
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex min-w-0 items-start gap-3.5">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary shadow-raised ring-1 ring-primary/20">
                <ScrollText className="size-5" />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="font-display truncate text-[22px] leading-tight font-semibold">{draft.name}</h1>
                  <Badge variant="outline" className="tabular">
                    v{policy.version}
                  </Badge>
                  {dirty && <Badge variant="warning">Edited</Badge>}
                </div>
                <p className="mt-1 text-dense text-muted-foreground">
                  {draft.description || 'No description'} · updated <RelativeTime value={policy.updated_at} /> by{' '}
                  {policy.updated_by_name}
                </p>
                {policy.assignments.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {sortSources(policy.assignments).map((assignment) => (
                      <AssignmentChip key={assignment.id} assignment={assignment} />
                    ))}
                  </div>
                )}
              </div>
            </div>
            {canManage && (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="outline" size="icon-sm" aria-label="More actions" />}>
                  <Ellipsis />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuItem onClick={() => setRenaming(true)}>
                    <Pencil />
                    Rename…
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}>
                    <Trash />
                    Delete policy…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </header>

        <Tabs value={tab} onValueChange={(value) => setTab(String(value))} className="gap-4">
          <div className="-mx-4 [scrollbar-width:none] overflow-x-auto border-b border-border px-4 sm:-mx-6 sm:px-6">
            <TabsList variant="line" className="-mb-px h-10 w-max gap-4">
              <TabsTrigger value="agent" className="flex-none px-0">
                Agent
                {tabProblems('agent') && <CircleExclamationPoint className="size-3.5 text-critical" />}
              </TabsTrigger>
              <TabsTrigger value="remote" className="flex-none px-0">
                Remote access
              </TabsTrigger>
              <TabsTrigger value="tasks" className="flex-none px-0">
                Scheduled tasks
                <span className="tabular text-micro text-subtle-foreground">{draft.document.tasks?.length ?? 0}</span>
                {tabProblems('tasks') && <CircleExclamationPoint className="size-3.5 text-critical" />}
              </TabsTrigger>
              <TabsTrigger value="monitoring" className="flex-none px-0">
                Monitoring
                <span className="tabular text-micro text-subtle-foreground">{checkCount}</span>
                {tabProblems('monitoring') && <CircleExclamationPoint className="size-3.5 text-critical" />}
              </TabsTrigger>
              <TabsTrigger value="patching" className="flex-none px-0">
                Patching
                {draft.document.patching?.enabled === true && <span className="size-1.5 rounded-full bg-live" aria-label="enabled" />}
                {patchingKeys > 0 && <span className="tabular text-micro text-subtle-foreground">{patchingKeys}</span>}
                {tabProblems('patching') && <CircleExclamationPoint className="size-3.5 text-critical" />}
              </TabsTrigger>
              <TabsTrigger value="escrow" className="flex-none px-0">
                Secrets escrow
                {draft.document.escrow?.laps?.enabled === true && <span className="size-1.5 rounded-full bg-live" aria-label="LAPS enabled" />}
                {escrowKeys > 0 && <span className="tabular text-micro text-subtle-foreground">{escrowKeys}</span>}
                {tabProblems('escrow') && <CircleExclamationPoint className="size-3.5 text-critical" />}
              </TabsTrigger>
              <TabsTrigger value="json" className="flex-none px-0">
                Advanced (JSON)
              </TabsTrigger>
              <TabsTrigger value="assignments" className="flex-none px-0">
                Assignments
                <span className="tabular text-micro text-subtle-foreground">{policy.assignments.length}</span>
              </TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="agent">
            <AgentSection doc={draft.document} onChange={setDocument} readOnly={readOnly} issues={issues} />
          </TabsContent>
          <TabsContent value="remote">
            <RemoteSection doc={draft.document} onChange={setDocument} readOnly={readOnly} />
          </TabsContent>
          <TabsContent value="tasks">
            <TasksSection doc={draft.document} onChange={setDocument} readOnly={readOnly} issues={issues} />
          </TabsContent>
          <TabsContent value="monitoring">
            <PolicyMonitoringTab
              doc={draft.document}
              onChange={setDocument}
              readOnly={readOnly}
              locked={!canMonitor}
              issues={issues}
              catalog={catalog ?? []}
              catalogLoading={checkTypes.isLoading}
              defaultOfflineMinutes={monitoringSettings?.default_offline_minutes}
            />
          </TabsContent>
          <TabsContent value="patching">
            <PolicyPatchingTab
              doc={draft.document}
              onChange={setDocument}
              readOnly={readOnly}
              locked={!canPatch}
              issues={issues}
              runNow={canPatch && policy.document.patching?.window ? { policyId: policy.id, policyName: policy.name, duration: policy.document.patching.window.duration_minutes ?? 180 } : null}
            />
          </TabsContent>
          <TabsContent value="escrow">
            <PolicyEscrowTab doc={draft.document} onChange={setDocument} readOnly={readOnly} locked={!canEscrow} issues={issues.filter((issue) => issue.path.startsWith('escrow'))} />
          </TabsContent>
          <TabsContent value="json">
            <JsonSection
              text={text}
              readOnly={readOnly}
              issues={jsonIssues}
              onText={(next) => {
                setJsonText(next)
                const parsed = parsePolicyJson(next, validation)
                if (parsed.document) setEdit({ for: policyId, draft: { ...draft, document: parsed.document } })
              }}
            />
          </TabsContent>
          <TabsContent value="assignments">
            <AssignmentsSection policy={policy} canManage={canManage} />
          </TabsContent>
        </Tabs>
      </PageContainer>

      {dirty && canManage && (
        <div className="pointer-events-none sticky bottom-0 z-20 px-4 pb-4 sm:px-6">
          <div className="pointer-events-auto mx-auto flex max-w-[1392px] flex-col gap-3 rounded-xl bg-popover p-3 shadow-popover ring-1 ring-border-strong sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <span
                className={cn('size-2 shrink-0 rounded-full', issues.length || blocked ? 'bg-critical' : 'bg-warning')}
                aria-hidden="true"
              />
              <div className="min-w-0 text-dense">
                <div className="font-medium">Unsaved changes</div>
                <div className="truncate text-micro text-muted-foreground">
                  {issues.length
                    ? `${issues.length} ${issues.length === 1 ? 'problem' : 'problems'} to fix: ${issues[0].path ? `${issues[0].path} — ` : ''}${issues[0].message}`
                    : monitoringBlocked
                      ? 'You changed the monitoring section, which needs the “Manage monitoring” permission. Discard those changes to save.'
                      : patchingBlocked
                        ? 'You changed the patching section, which needs the “Approve patches” permission. Discard those changes to save.'
                      : escrowBlocked
                        ? 'You changed the secrets escrow section, which needs the “Manage escrow” permission. Discard those changes to save.'
                      : `Saving creates version ${policy.version + 1} and pushes agent settings and checks to affected devices.`}
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={discard} disabled={save.isPending}>
                <Undo2 data-icon="inline-start" />
                Discard
              </Button>
              <Button
                onClick={() => save.mutate()}
                disabled={save.isPending || localIssues.length > 0 || blocked}
              >
                {save.isPending ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}
                Save policy
              </Button>
            </div>
          </div>
        </div>
      )}

      {renaming && (
        <RenameDialog
          draft={draft}
          open
          onOpenChange={setRenaming}
          onSave={(name, description) => setDraft({ name, description })}
        />
      )}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete “${policy.name}”?`}
        description="Its assignments are removed and devices fall back to the remaining layers. Its scheduled tasks stop. You'll be asked to confirm it's you."
        confirmLabel="Delete policy"
        confirmText={policy.name}
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  )
}
