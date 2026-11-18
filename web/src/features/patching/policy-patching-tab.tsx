/* The policy editor's Patching tab: every key of the `patching` section, each one set here or inherited. */
import type { ReactNode } from 'react'
import { ArrowDown, ArrowUp, CalendarClock, Info, Lock, MonitorCog, Plus, RotateCw, ShieldCheck, Sparkles, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { EmptyState } from '@/components/common/empty-state'
import { SimpleSelect } from '@/components/common/simple-select'
import type { AutoApproveRule, PatchPlatform, PatchRing, PatchSeverity, PolicyDocument, RebootMode } from '@/lib/api/types'
import { formatInZone, localTimeZone } from '@/lib/cron'
import { formatDate, formatRelative } from '@/lib/format'
import { ringSchedule } from '@/lib/patching/approval'
import {
  CLASSIFICATION_LABEL,
  PLATFORM_LABEL,
  REBOOT_MODE_DESCRIPTION,
  REBOOT_MODE_LABEL,
  RING_DESCRIPTION,
  RING_LABEL,
  RING_ORDER,
  SEVERITY_ORDER,
  classificationLabel,
  classificationsFor,
} from '@/lib/patching/labels'
import {
  DELAY_MAX,
  DEFERRALS_MAX,
  DURATION_MAX,
  DURATION_MIN,
  MAX_RULES,
  MESSAGE_MAX,
  PATCHING_DEFAULTS,
  RULE_PLATFORMS,
  SCAN_MAX,
  SCAN_MIN,
  changeRulePlatform,
  newRule,
  rebootPreview,
  ruleIssues,
  setPatchingField,
  setPatchingKey,
  setPatchingSection,
  windowOccurrences,
  type PatchingIssue,
} from '@/lib/patching/policy'
import { cn } from '@/lib/utils'
import { CronField } from '@/features/automation/schedule-editor'
import { SEGMENTED } from '@/features/automation/styles'
import { PlatformMark } from './patching-ui'
import { RunWindowButton } from './run-window-dialog'
import { SEVERITY_BAR } from './patching-styles'

interface TabProps {
  doc: PolicyDocument
  onChange: (doc: PolicyDocument) => void
  disabled: boolean
  issues: PatchingIssue[]
  /** Saved policy whose stored window can be run now (absent for unsaved or windowless policies). */
  runNow?: { policyId: string; policyName: string; duration: number } | null
}

const issueAt = (issues: PatchingIssue[], path: string) =>
  issues.find((issue) => issue.path === path || issue.path.startsWith(`${path}.`) || issue.path.startsWith(`${path}[`))?.message

// ------------------------------------------------------------------ building blocks

function Card({ icon, title, description, children, aside }: { icon: ReactNode; title: string; description: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl bg-card shadow-card">
      <div className="flex items-start gap-3 border-b border-border px-4 py-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-muted-foreground ring-1 ring-border [&_svg]:size-4">{icon}</span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="text-micro text-muted-foreground">{description}</p>
        </div>
        {aside}
      </div>
      {children}
    </section>
  )
}

/** One inheritable setting: the switch sets it in this policy, otherwise the inherited default shows. */
function Row({
  label,
  description,
  set,
  onSet,
  disabled,
  inherited,
  issue,
  children,
  wide = false,
}: {
  label: string
  description: ReactNode
  set: boolean
  onSet: (set: boolean) => void
  disabled: boolean
  inherited: ReactNode
  issue?: string
  children: ReactNode
  wide?: boolean
}) {
  return (
    <div className={cn('grid gap-3 px-4 py-3.5', wide ? 'grid-cols-1' : 'sm:grid-cols-[minmax(0,1fr)_minmax(0,20rem)] sm:items-center', issue && 'bg-critical/[0.03]')}>
      <div className="flex items-start gap-3">
        <Switch className="mt-0.5" checked={set} disabled={disabled} aria-label={`Set ${label} in this policy`} onCheckedChange={onSet} />
        <div className="min-w-0">
          <div className="text-dense font-medium">{label}</div>
          <p className="text-micro text-muted-foreground">{description}</p>
        </div>
      </div>
      {set ? (
        <div className={cn('min-w-0', !wide && 'sm:justify-self-end', wide && 'sm:pl-12')}>
          {children}
          {issue && <FieldError className="mt-1">{issue}</FieldError>}
        </div>
      ) : (
        <div className={cn('text-dense text-muted-foreground', !wide && 'sm:text-right', wide && 'sm:pl-12')}>
          Inherited · default <span className="font-medium text-foreground">{inherited}</span>
        </div>
      )}
    </div>
  )
}

function OnOff({ value, onChange, disabled, label, on = 'On', off = 'Off' }: { value: boolean; onChange: (value: boolean) => void; disabled: boolean; label: string; on?: string; off?: string }) {
  return (
    <ToggleGroup className={SEGMENTED} value={[value ? 'on' : 'off']} onValueChange={(next: string[]) => next[0] && onChange(next[0] === 'on')} variant="outline" spacing={0} size="sm" disabled={disabled} aria-label={label}>
      <ToggleGroupItem value="on" className="px-3 data-[pressed]:text-success">
        {on}
      </ToggleGroupItem>
      <ToggleGroupItem value="off" className="px-3">
        {off}
      </ToggleGroupItem>
    </ToggleGroup>
  )
}

function NumberInput({ value, onChange, min, max, unit, disabled, label }: { value: number | undefined; onChange: (value: number) => void; min: number; max: number; unit: string; disabled: boolean; label: string }) {
  return (
    <div className="relative w-full sm:w-48">
      <Input
        type="number"
        min={min}
        max={max}
        className="tabular pr-16"
        disabled={disabled}
        aria-label={label}
        value={value === undefined || Number.isNaN(value) ? '' : value}
        onChange={(event) => onChange(event.target.value === '' ? Number.NaN : Number(event.target.value))}
      />
      <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-micro text-subtle-foreground">{unit}</span>
    </div>
  )
}

const spanLabel = (minutes: number) => (minutes % 60 === 0 ? `${minutes / 60} h` : minutes > 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`)

// ------------------------------------------------------------------ sections

function GeneralCard({ doc, onChange, disabled, issues }: TabProps) {
  const section = doc.patching ?? {}
  return (
    <Card icon={<ShieldCheck />} title="Patching" description="Whether devices this policy reaches are scanned and patched, how often they scan, and which ring they are in.">
      <div className="divide-y divide-border">
        <Row
          label="Patch these devices"
          description="Devices are only patched when their effective policy turns this on. Off still lets you see what's missing after a manual scan."
          set={section.enabled !== undefined}
          onSet={(set) => onChange(setPatchingKey(doc, 'enabled', set ? true : undefined))}
          disabled={disabled}
          inherited="Off"
          issue={issueAt(issues, 'patching.enabled')}
        >
          <OnOff value={section.enabled ?? false} onChange={(value) => onChange(setPatchingKey(doc, 'enabled', value))} disabled={disabled} label="Patching" on="Enabled" off="Off" />
        </Row>
        <Row
          label="Scan interval"
          description="How often devices look for updates. They also scan after every install."
          set={section.scan_interval_hours !== undefined}
          onSet={(set) => onChange(setPatchingKey(doc, 'scan_interval_hours', set ? PATCHING_DEFAULTS.scan_interval_hours : undefined))}
          disabled={disabled}
          inherited={`${PATCHING_DEFAULTS.scan_interval_hours} hours`}
          issue={issueAt(issues, 'patching.scan_interval_hours')}
        >
          <NumberInput value={section.scan_interval_hours} onChange={(value) => onChange(setPatchingKey(doc, 'scan_interval_hours', value))} min={SCAN_MIN} max={SCAN_MAX} unit="hours" disabled={disabled} label="Scan interval" />
        </Row>
        <Row
          label="Ring"
          description="Approval rules hold updates back by ring, so pilot devices surface problems before the rest."
          set={section.ring !== undefined}
          onSet={(set) => onChange(setPatchingKey(doc, 'ring', set ? PATCHING_DEFAULTS.ring : undefined))}
          disabled={disabled}
          inherited={RING_LABEL[PATCHING_DEFAULTS.ring]}
          issue={issueAt(issues, 'patching.ring')}
        >
          <div className="grid gap-1.5 sm:justify-items-end">
            <ToggleGroup className={SEGMENTED} value={[section.ring ?? 'broad']} onValueChange={(next: string[]) => next[0] && onChange(setPatchingKey(doc, 'ring', next[0] as PatchRing))} variant="outline" spacing={0} size="sm" disabled={disabled} aria-label="Ring">
              {RING_ORDER.map((ring) => (
                <ToggleGroupItem key={ring} value={ring} className="px-3">
                  {RING_LABEL[ring]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <p className="text-micro text-muted-foreground sm:text-right">{RING_DESCRIPTION[section.ring ?? 'broad']}</p>
          </div>
        </Row>
      </div>
    </Card>
  )
}

function WindowCard({ doc, onChange, disabled, issues, runNow }: TabProps) {
  const window = doc.patching?.window
  const duration = window?.duration_minutes ?? PATCHING_DEFAULTS.window.duration_minutes
  const zone = window?.timezone ?? 'UTC'
  const occurrences = window ? windowOccurrences(window, 5) : []
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone
  const update = (patch: Partial<NonNullable<typeof window>>) => window && onChange(setPatchingSection(doc, 'window', { ...window, ...patch }))
  return (
    <Card
      icon={<CalendarClock />}
      title="Maintenance window"
      description="Approved updates install only while the window is open. Without a window nothing installs automatically."
      aside={
        <div className="flex shrink-0 items-center gap-2">
          {runNow && <RunWindowButton policyId={runNow.policyId} policyName={runNow.policyName} defaultDuration={runNow.duration} />}
          <Switch
            checked={Boolean(window)}
            disabled={disabled}
            aria-label="Set a maintenance window in this policy"
            onCheckedChange={(checked) => onChange(setPatchingSection(doc, 'window', checked ? { cron: '0 2 * * 3', duration_minutes: 180, timezone: localTimeZone() } : undefined))}
          />
        </div>
      }
    >
      {!window ? (
        <p className="px-4 py-3.5 text-dense text-muted-foreground">Inherited from an earlier layer, if any sets one. Turn the switch on to set this policy’s own window.</p>
      ) : (
        <fieldset disabled={disabled} className="grid grid-cols-1 gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="grid grid-cols-1 gap-4">
            <CronField cron={window.cron} timezone={zone} onCronChange={(cron) => update({ cron })} onTimezoneChange={(timezone) => update({ timezone })} idPrefix="patch-window" preview={false} error={issueAt(issues, 'patching.window.cron')} />
            <Field data-invalid={Boolean(issueAt(issues, 'patching.window.duration_minutes')) || undefined} className="sm:max-w-xs">
              <FieldLabel htmlFor="patch-window-duration">Duration</FieldLabel>
              <NumberInput value={window.duration_minutes} onChange={(value) => update({ duration_minutes: value })} min={DURATION_MIN} max={DURATION_MAX} unit="minutes" disabled={disabled} label="Window duration" />
              {issueAt(issues, 'patching.window.duration_minutes') ? (
                <FieldError>{issueAt(issues, 'patching.window.duration_minutes')}</FieldError>
              ) : (
                <FieldDescription>
                  {Number.isFinite(duration) ? spanLabel(duration) : '—'} · {DURATION_MIN}–{DURATION_MAX} minutes. With “force at window end”, pending restarts happen when it closes.
                </FieldDescription>
              )}
            </Field>
          </div>
          <div className="self-start rounded-lg bg-surface-2 p-3 ring-1 ring-border">
            <div className="mb-2 flex items-center gap-1.5 text-micro font-medium text-muted-foreground">
              <CalendarClock className="size-3.5" />
              Next {occurrences.length} windows · {zone.replace(/_/g, ' ')}
            </div>
            {occurrences.length === 0 ? (
              <p className="text-dense text-muted-foreground">Enter a valid schedule to preview it.</p>
            ) : (
              <ol className="grid grid-cols-1 gap-1.5">
                {occurrences.map((start, index) => {
                  const end = new Date(start.getTime() + (Number.isFinite(duration) ? duration : 0) * 60_000)
                  return (
                    <li key={start.toISOString()} className="grid grid-cols-1 text-dense">
                      <span className={cn('tabular', index === 0 ? 'font-medium' : 'text-muted-foreground')}>
                        {formatInZone(start, zone)} → {formatInZone(end, zone).split(' ').pop()}
                      </span>
                      <span className="tabular truncate text-micro text-subtle-foreground">
                        {local !== zone ? `${formatInZone(start, local)} your time · ` : ''}
                        {formatRelative(start)}
                      </span>
                    </li>
                  )
                })}
              </ol>
            )}
          </div>
        </fieldset>
      )}
    </Card>
  )
}

function ChipToggle({ active, onClick, disabled, children }: { active: boolean; onClick: () => void; disabled: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-dense text-muted-foreground ring-1 ring-border transition-colors outline-none hover:bg-surface-3 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60',
        active && 'bg-primary/10 font-medium text-foreground ring-primary/35',
      )}
    >
      {children}
    </button>
  )
}

function RuleCard({
  rule,
  index,
  count,
  onChange,
  onRemove,
  onMove,
  disabled,
  issues,
}: {
  rule: AutoApproveRule
  index: number
  count: number
  onChange: (rule: AutoApproveRule) => void
  onRemove: () => void
  onMove: (delta: -1 | 1) => void
  disabled: boolean
  issues: PatchingIssue[]
}) {
  const classes = rule.classifications ?? []
  const severities = rule.severities ?? []
  const allowed = classificationsFor(rule.platform)
  const toggle = <T extends string>(list: T[], value: T) => (list.includes(value) ? list.filter((item) => item !== value) : [...list, value])
  const example = ringSchedule({ release_date: new Date().toISOString(), first_seen_at: new Date().toISOString() }, rule.delay_days)
  return (
    <div className={cn('overflow-hidden rounded-xl bg-card shadow-card', issues.length && 'ring-1 ring-critical/30')}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="tabular flex size-6 items-center justify-center rounded-full bg-surface-3 text-[11px] font-semibold text-muted-foreground ring-1 ring-border">{index + 1}</span>
        <div className="w-44">
          <SimpleSelect
            size="sm"
            value={rule.platform}
            disabled={disabled}
            ariaLabel="Platform"
            onValueChange={(value) => onChange(changeRulePlatform(rule, value as PatchPlatform))}
            options={RULE_PLATFORMS.map((platform) => ({ value: platform, label: PLATFORM_LABEL[platform], icon: <PlatformMark platform={platform} label={false} /> }))}
          />
        </div>
        <span className="min-w-0 flex-1 truncate text-micro text-muted-foreground">{index === 0 ? 'Checked first' : 'Checked if no earlier rule matched'}</span>
        {!disabled && (
          <div className="flex items-center gap-0.5">
            <Button variant="ghost" size="icon-sm" aria-label="Move up" disabled={index === 0} onClick={() => onMove(-1)}>
              <ArrowUp />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Move down" disabled={index === count - 1} onClick={() => onMove(1)}>
              <ArrowDown />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label={`Remove rule ${index + 1}`} className="hover:text-critical" onClick={onRemove}>
              <Trash2 />
            </Button>
          </div>
        )}
      </div>
      <div className="grid grid-cols-1 gap-4 p-4">
        <Field>
          <FieldLabel>Classifications</FieldLabel>
          <div className="flex flex-wrap gap-1.5">
            <ChipToggle active={classes.length === 0} disabled={disabled} onClick={() => onChange({ ...rule, classifications: [] })}>
              Any
            </ChipToggle>
            {allowed.map((value) => (
              <ChipToggle key={value} active={classes.includes(value)} disabled={disabled} onClick={() => onChange({ ...rule, classifications: toggle(classes, value) })}>
                {classificationLabel(rule.platform, value) ?? CLASSIFICATION_LABEL[value]}
              </ChipToggle>
            ))}
          </div>
          <FieldError>{issueAt(issues, 'classifications')}</FieldError>
        </Field>
        <Field>
          <FieldLabel>Severities</FieldLabel>
          <div className="flex flex-wrap gap-1.5">
            <ChipToggle active={severities.length === 0} disabled={disabled} onClick={() => onChange({ ...rule, severities: [] })}>
              Any, including unrated
            </ChipToggle>
            {SEVERITY_ORDER.map((value) => (
              <ChipToggle key={value} active={severities.includes(value)} disabled={disabled} onClick={() => onChange({ ...rule, severities: toggle<PatchSeverity>(severities, value) })}>
                <span className={cn('size-2 rounded-[3px]', SEVERITY_BAR[value])} />
                {value}
              </ChipToggle>
            ))}
          </div>
          <FieldDescription>Listing severities leaves out updates without one (definitions, most Linux and macOS updates).</FieldDescription>
          <FieldError>{issueAt(issues, 'severities')}</FieldError>
        </Field>
        <div className="grid grid-cols-1 gap-2">
          <div className="text-dense font-medium">Delay by ring</div>
          <div className="grid grid-cols-3 gap-2 sm:max-w-md">
            {RING_ORDER.map((ring) => {
              const problem = issueAt(issues, `delay_days.${ring}`)
              return (
                <Field key={ring} data-invalid={Boolean(problem) || undefined}>
                  <FieldLabel htmlFor={`rule-${index}-${ring}`} className="text-micro text-muted-foreground">
                    {RING_LABEL[ring]}
                  </FieldLabel>
                  <div className="relative">
                    <Input
                      id={`rule-${index}-${ring}`}
                      type="number"
                      min={0}
                      max={DELAY_MAX}
                      disabled={disabled}
                      className="tabular pr-11"
                      value={rule.delay_days?.[ring] ?? 0}
                      onChange={(event) => onChange({ ...rule, delay_days: { ...rule.delay_days, [ring]: event.target.value === '' ? Number.NaN : Number(event.target.value) } })}
                    />
                    <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-micro text-subtle-foreground">days</span>
                  </div>
                  {problem && <FieldError>{problem}</FieldError>}
                </Field>
              )
            })}
          </div>
          <p className="text-micro text-muted-foreground">
            A matching update released today reaches{' '}
            {example.map((ring, position) => (
              <span key={ring.ring}>
                {position > 0 && (position === example.length - 1 ? ' and ' : ', ')}
                <span className="font-medium text-foreground">{RING_LABEL[ring.ring].toLowerCase()}</span> {ring.delay === 0 ? 'today' : `on ${formatDate(ring.at)}`}
              </span>
            ))}
            .
          </p>
        </div>
      </div>
    </div>
  )
}

function RulesSection({ doc, onChange, disabled, issues }: TabProps) {
  const rules = doc.patching?.auto_approve
  const set = (next: AutoApproveRule[] | undefined) => onChange(setPatchingKey(doc, 'auto_approve', next))
  const listIssue = issues.find((issue) => issue.path === 'patching.auto_approve')?.message
  return (
    <section className="grid grid-cols-1 gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <Switch className="mt-1" checked={rules !== undefined} disabled={disabled} aria-label="Set approval rules in this policy" onCheckedChange={(checked) => set(checked ? [newRule('windows'), newRule('linux')] : undefined)} />
          <div className="min-w-0">
            <h3 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
              <Sparkles className="size-4 text-primary" />
              Auto-approval rules
            </h3>
            <p className="mt-0.5 text-dense text-muted-foreground">
              {rules === undefined
                ? 'Inherited. Setting rules here replaces the whole inherited list for devices this policy reaches.'
                : rules.length === 0
                  ? 'An empty list turns auto-approval off: every update waits for a manual decision.'
                  : 'The first matching rule approves a new update for the client, then each ring waits its delay.'}
            </p>
          </div>
        </div>
        {!disabled && rules !== undefined && rules.length > 0 && (
          <Button size="sm" variant="outline" disabled={rules.length >= MAX_RULES} onClick={() => set([...rules, newRule('windows')])}>
            <Plus data-icon="inline-start" />
            Add rule
          </Button>
        )}
      </div>
      {listIssue && <p className="rounded-lg bg-critical/[0.05] px-3 py-2 text-dense text-critical ring-1 ring-critical/20">{listIssue}</p>}
      {rules !== undefined &&
        (rules.length === 0 ? (
          <EmptyState
            compact
            illustration="patching"
            title="No approval rules"
            description="Add a rule for security updates on Windows, for example, with a week's delay for the broad ring."
            actions={
              !disabled && (
                <Button size="sm" onClick={() => set([newRule('windows')])}>
                  <Plus data-icon="inline-start" />
                  Add rule
                </Button>
              )
            }
          />
        ) : (
          rules.map((rule, index) => (
            <RuleCard
              key={index}
              rule={rule}
              index={index}
              count={rules.length}
              disabled={disabled}
              issues={ruleIssues(issues, index)}
              onChange={(next) => set(rules.map((item, position) => (position === index ? next : item)))}
              onRemove={() => set(rules.filter((_, position) => position !== index))}
              onMove={(delta) => {
                const next = [...rules]
                const [moved] = next.splice(index, 1)
                next.splice(index + delta, 0, moved)
                set(next)
              }}
            />
          ))
        ))}
    </section>
  )
}

function RebootPreviewPanel({ doc }: { doc: PolicyDocument }) {
  const preview = rebootPreview({ ...PATCHING_DEFAULTS.reboot, ...doc.patching?.reboot })
  return (
    <div className="grid content-start gap-2">
      <div className="text-micro font-medium text-muted-foreground">What the signed-in user sees</div>
      <div className="overflow-hidden rounded-lg bg-surface-1 shadow-popover ring-1 ring-border-strong">
        <div className="flex items-center gap-2 border-b border-border bg-surface-2 px-3 py-1.5">
          <span className="size-2.5 rounded-sm bg-primary/70" aria-hidden="true" />
          <span className="truncate text-micro font-medium">{preview.title}</span>
        </div>
        <div className="grid gap-3 px-3.5 py-3">
          <p className="text-dense whitespace-pre-line text-foreground/90">{preview.body}</p>
          {preview.actions.length > 0 && (
            <div className="flex justify-end gap-1.5">
              {preview.actions.map((action, index) => (
                <span key={action} className={cn('inline-flex h-6 min-w-14 items-center justify-center rounded-[4px] px-2.5 text-micro ring-1', index === 0 ? 'bg-primary text-primary-foreground ring-primary' : 'bg-surface-2 ring-border-strong')}>
                  {action}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      <p className="text-micro text-muted-foreground">{preview.footnote}</p>
    </div>
  )
}

function RebootCard({ doc, onChange, disabled, issues }: TabProps) {
  const reboot = doc.patching?.reboot ?? {}
  const mode = reboot.mode ?? PATCHING_DEFAULTS.reboot.mode
  const message = reboot.message ?? ''
  return (
    <Card icon={<RotateCw />} title="Restarts" description="What happens when installed updates need a restart.">
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="divide-y divide-border">
          <Row
            label="Restart behaviour"
            description={REBOOT_MODE_DESCRIPTION[mode]}
            set={reboot.mode !== undefined}
            onSet={(set) => onChange(setPatchingField(doc, 'reboot', 'mode', set ? PATCHING_DEFAULTS.reboot.mode : undefined))}
            disabled={disabled}
            inherited={REBOOT_MODE_LABEL[PATCHING_DEFAULTS.reboot.mode]}
            issue={issueAt(issues, 'patching.reboot.mode')}
          >
            <ToggleGroup className={SEGMENTED} value={[mode]} onValueChange={(next: string[]) => next[0] && onChange(setPatchingField(doc, 'reboot', 'mode', next[0] as RebootMode))} variant="outline" spacing={0} size="sm" disabled={disabled} aria-label="Restart behaviour">
              <ToggleGroupItem value="never" className="px-2.5">
                Never
              </ToggleGroupItem>
              <ToggleGroupItem value="prompt" className="px-2.5">
                Prompt
              </ToggleGroupItem>
              <ToggleGroupItem value="force" className="px-2.5 data-[pressed]:text-warning">
                Force
              </ToggleGroupItem>
            </ToggleGroup>
          </Row>
          <Row
            label="Postponements"
            description="How many times the user may postpone the prompt, 60 minutes each. Applies to “Prompt”."
            set={reboot.prompt_deferrals !== undefined}
            onSet={(set) => onChange(setPatchingField(doc, 'reboot', 'prompt_deferrals', set ? PATCHING_DEFAULTS.reboot.prompt_deferrals : undefined))}
            disabled={disabled}
            inherited={String(PATCHING_DEFAULTS.reboot.prompt_deferrals)}
            issue={issueAt(issues, 'patching.reboot.prompt_deferrals')}
          >
            <NumberInput value={reboot.prompt_deferrals} onChange={(value) => onChange(setPatchingField(doc, 'reboot', 'prompt_deferrals', value))} min={0} max={DEFERRALS_MAX} unit="times" disabled={disabled} label="Postponements" />
          </Row>
          <Row
            label="Force at window end"
            description="Restart when the window closes if a restart is still pending."
            set={reboot.force_at_window_end !== undefined}
            onSet={(set) => onChange(setPatchingField(doc, 'reboot', 'force_at_window_end', set ? PATCHING_DEFAULTS.reboot.force_at_window_end : undefined))}
            disabled={disabled}
            inherited="On"
            issue={issueAt(issues, 'patching.reboot.force_at_window_end')}
          >
            <OnOff value={reboot.force_at_window_end ?? true} onChange={(value) => onChange(setPatchingField(doc, 'reboot', 'force_at_window_end', value))} disabled={disabled} label="Force at window end" />
          </Row>
          <Row
            label="Message"
            description="Shown in the restart prompt and the shutdown notice."
            set={reboot.message !== undefined}
            onSet={(set) => onChange(setPatchingField(doc, 'reboot', 'message', set ? PATCHING_DEFAULTS.reboot.message : undefined))}
            disabled={disabled}
            inherited="the standard message"
            issue={issueAt(issues, 'patching.reboot.message')}
            wide
          >
            <Textarea value={message} maxLength={MESSAGE_MAX + 50} rows={3} disabled={disabled} aria-label="Restart message" onChange={(event) => onChange(setPatchingField(doc, 'reboot', 'message', event.target.value))} />
            <div className={cn('tabular mt-1 text-right text-micro', [...message].length > MESSAGE_MAX ? 'text-critical' : 'text-subtle-foreground')}>
              {[...message].length} / {MESSAGE_MAX}
            </div>
          </Row>
        </div>
        <div className="border-t border-border bg-surface-1/60 p-4 xl:border-t-0 xl:border-l">
          <RebootPreviewPanel doc={doc} />
        </div>
      </div>
    </Card>
  )
}

function ScopeCard({ doc, onChange, disabled, issues }: TabProps) {
  const section = doc.patching ?? {}
  const windowsRow = (key: 'include_drivers' | 'include_feature_updates' | 'include_preview', label: string, description: string) => (
    <Row
      key={key}
      label={label}
      description={description}
      set={section.windows?.[key] !== undefined}
      onSet={(set) => onChange(setPatchingField(doc, 'windows', key, set ? false : undefined))}
      disabled={disabled}
      inherited="Off"
      issue={issueAt(issues, `patching.windows.${key}`)}
    >
      <OnOff value={section.windows?.[key] ?? false} onChange={(value) => onChange(setPatchingField(doc, 'windows', key, value))} disabled={disabled} label={label} />
    </Row>
  )
  return (
    <Card icon={<MonitorCog />} title="Scope by platform" description="What scans report and installs cover on each operating system.">
      <div className="divide-y divide-border">
        {windowsRow('include_drivers', 'Windows drivers', 'Offer driver updates from Windows Update. Usually better left to the hardware vendor’s tools.')}
        {windowsRow('include_feature_updates', 'Windows feature updates', 'Offer upgrades to a new Windows version (classification Upgrades).')}
        {windowsRow('include_preview', 'Windows previews', 'Offer optional “Preview” cumulative updates.')}
        <Row
          label="Linux updates"
          description="What “approved” installs mean for distribution packages: rule approvals of security updates only, or everything approved."
          set={section.linux?.mode !== undefined}
          onSet={(set) => onChange(setPatchingField(doc, 'linux', 'mode', set ? 'security' : undefined))}
          disabled={disabled}
          inherited="Security only"
          issue={issueAt(issues, 'patching.linux.mode')}
        >
          <ToggleGroup className={SEGMENTED} value={[section.linux?.mode ?? 'security']} onValueChange={(next: string[]) => next[0] && onChange(setPatchingField(doc, 'linux', 'mode', next[0] as 'security' | 'all'))} variant="outline" spacing={0} size="sm" disabled={disabled} aria-label="Linux updates">
            <ToggleGroupItem value="security" className="px-3">
              Security only
            </ToggleGroupItem>
            <ToggleGroupItem value="all" className="px-3">
              All updates
            </ToggleGroupItem>
          </ToggleGroup>
        </Row>
        <Row
          label="Install on macOS"
          description="macOS is report-only by default: Apple silicon needs the user’s consent to install without MDM."
          set={section.macos?.install !== undefined}
          onSet={(set) => onChange(setPatchingField(doc, 'macos', 'install', set ? false : undefined))}
          disabled={disabled}
          inherited="Report only"
          issue={issueAt(issues, 'patching.macos.install')}
        >
          <OnOff value={section.macos?.install ?? false} onChange={(value) => onChange(setPatchingField(doc, 'macos', 'install', value))} disabled={disabled} label="Install on macOS" on="Install" off="Report only" />
        </Row>
        <Row
          label="Third-party apps (winget)"
          description="Also offer winget upgrades of installed apps as patches on Windows."
          set={section.third_party?.winget !== undefined}
          onSet={(set) => onChange(setPatchingField(doc, 'third_party', 'winget', set ? false : undefined))}
          disabled={disabled}
          inherited="Off"
          issue={issueAt(issues, 'patching.third_party.winget')}
        >
          <OnOff value={section.third_party?.winget ?? false} onChange={(value) => onChange(setPatchingField(doc, 'third_party', 'winget', value))} disabled={disabled} label="winget upgrades" />
        </Row>
      </div>
    </Card>
  )
}

/**
 * The Patching tab. `readOnly` covers people without `policies.manage`; `locked` adds the case of
 * missing `patches.approve`, which changing this section also needs.
 */
export function PolicyPatchingTab({
  doc,
  onChange,
  readOnly,
  locked,
  issues,
  runNow,
}: {
  doc: PolicyDocument
  onChange: (doc: PolicyDocument) => void
  readOnly: boolean
  locked: boolean
  issues: PatchingIssue[]
  runNow?: TabProps['runNow']
}) {
  const disabled = readOnly || locked
  const props: TabProps = { doc, onChange, disabled, issues: issues.filter((issue) => issue.path.startsWith('patching')), runNow }
  const keys = Object.keys(doc.patching ?? {}).length
  return (
    <div className="grid grid-cols-1 gap-5">
      {locked && !readOnly && (
        <p className="flex items-start gap-2.5 rounded-xl bg-surface-2 px-4 py-3 text-dense text-muted-foreground ring-1 ring-border">
          <Lock className="mt-0.5 size-4 shrink-0" />
          <span>
            Patching settings need the <span className="font-medium text-foreground">Approve patches</span> permission over every target of this policy, because approval rules approve
            updates. You can review them here; the other tabs stay editable.
          </span>
        </p>
      )}
      <div className="flex items-start gap-2 text-dense text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0 text-info" />
        <span className="min-w-0">
          Each setting merges with the other policy layers; only what you switch on here is set by this policy.
          {keys > 0 && (
            <Badge variant="secondary" className="ml-2">
              {keys} {keys === 1 ? 'setting' : 'settings'} set
            </Badge>
          )}
        </span>
      </div>
      <GeneralCard {...props} />
      <WindowCard {...props} />
      <RulesSection {...props} />
      <RebootCard {...props} />
      <ScopeCard {...props} />
    </div>
  )
}
