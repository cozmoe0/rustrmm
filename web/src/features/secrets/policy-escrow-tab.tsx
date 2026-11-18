/* The policy editor's Secrets escrow tab: LAPS-style rotation and FileVault escrow, each key set here or inherited. */
import type { ReactNode } from 'react'
import { Info, KeyRound, Laptop, Lock } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { FieldError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { LapsComplexity, PolicyDocument, PolicyEscrowLaps } from '@/lib/api/types'
import {
  COMPLEXITY_LABEL,
  FILEVAULT_DEFAULTS,
  LAPS_DEFAULTS,
  LAPS_LIMITS,
  formatHours,
  setFilevaultEscrow,
  setLapsKey,
  type EscrowIssue,
  type LapsKey,
} from '@/lib/escrow/policy'
import { cn } from '@/lib/utils'
import { SEGMENTED } from '@/features/automation/styles'

function Card({ icon, title, description, children }: { icon: ReactNode; title: string; description: ReactNode; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl bg-card shadow-card">
      <div className="flex items-start gap-3 border-b border-border px-4 py-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-muted-foreground ring-1 ring-border [&_svg]:size-4">{icon}</span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="text-micro text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="divide-y divide-border">{children}</div>
    </section>
  )
}

function Row({
  label,
  description,
  set,
  onSet,
  disabled,
  inherited,
  issue,
  children,
}: {
  label: string
  description: ReactNode
  set: boolean
  onSet: (set: boolean) => void
  disabled: boolean
  inherited: ReactNode
  issue?: string
  children: ReactNode
}) {
  return (
    <div className={cn('grid gap-3 px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,18rem)] sm:items-center', issue && 'bg-critical/[0.03]')}>
      <div className="flex items-start gap-3">
        <Switch className="mt-0.5" checked={set} disabled={disabled} aria-label={`Set ${label} in this policy`} onCheckedChange={onSet} />
        <div className="min-w-0">
          <div className="text-dense font-medium">{label}</div>
          <p className="text-micro text-muted-foreground">{description}</p>
        </div>
      </div>
      {set ? (
        <div className="min-w-0 sm:justify-self-end">
          {children}
          {issue && <FieldError className="mt-1">{issue}</FieldError>}
        </div>
      ) : (
        <div className="text-dense text-muted-foreground sm:text-right">
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

function NumberInput({ value, onChange, disabled, label, unit, min, max }: { value: number | undefined; onChange: (value: number) => void; disabled: boolean; label: string; unit: string; min: number; max: number }) {
  return (
    <div className="relative w-full sm:w-44">
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

export function PolicyEscrowTab({
  doc,
  onChange,
  readOnly,
  locked,
  issues,
}: {
  doc: PolicyDocument
  onChange: (doc: PolicyDocument) => void
  readOnly: boolean
  /** The user lacks `secrets.manage`: the section is shown read-only. */
  locked: boolean
  issues: EscrowIssue[]
}) {
  const disabled = readOnly || locked
  const laps = doc.escrow?.laps ?? {}
  const issueAt = (path: string) => issues.find((issue) => issue.path === path || issue.path.startsWith(`${path}.`))?.message
  const set = <K extends LapsKey>(key: K, value: PolicyEscrowLaps[K] | undefined) => onChange({ ...doc, escrow: setLapsKey(doc.escrow, key, value) })
  const toggle = <K extends LapsKey>(key: K) => (on: boolean) => set(key, on ? LAPS_DEFAULTS[key] : undefined)
  const keys = Object.keys(laps).length + (doc.escrow?.filevault?.escrow !== undefined ? 1 : 0)
  const has = (key: LapsKey) => laps[key] !== undefined

  return (
    <div className="grid grid-cols-1 gap-5">
      {locked && !readOnly && (
        <p className="flex items-start gap-2.5 rounded-xl bg-surface-2 px-4 py-3 text-dense text-muted-foreground ring-1 ring-border">
          <Lock className="mt-0.5 size-4 shrink-0" />
          <span>
            Escrow settings need the <span className="font-medium text-foreground">Manage escrow</span> permission over every target of this policy, because they control
            administrator passwords. You can review them here; the other tabs stay editable.
          </span>
        </p>
      )}
      <div className="flex items-start gap-2 text-dense text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0 text-info" />
        <span className="min-w-0">
          BitLocker recovery keys are escrowed automatically on every Windows device. These settings add LAPS-style rotation of a local administrator account.
          {keys > 0 && (
            <Badge variant="secondary" className="ml-2">
              {keys} {keys === 1 ? 'setting' : 'settings'} set
            </Badge>
          )}
        </span>
      </div>

      <Card icon={<KeyRound />} title="Local administrator rotation (LAPS)" description="The agent sets a random password (Windows, macOS and Linux), escrows it first, and the server schedules the next rotation.">
        <Row label="Rotation" description="Rotate and escrow the managed account’s password." set={has('enabled')} onSet={toggle('enabled')} disabled={disabled} inherited="Off" issue={issueAt('escrow.laps.enabled')}>
          <OnOff value={Boolean(laps.enabled)} onChange={(value) => set('enabled', value)} disabled={disabled} label="LAPS rotation" />
        </Row>
        <Row label="Account" description="1–20 letters, digits, -, _ or ." set={has('account')} onSet={toggle('account')} disabled={disabled} inherited={LAPS_DEFAULTS.account} issue={issueAt('escrow.laps.account')}>
          <Input className="w-full font-mono text-[12.5px] sm:w-44" disabled={disabled} aria-label="Account name" value={laps.account ?? ''} spellCheck={false} onChange={(event) => set('account', event.target.value)} />
        </Row>
        <Row label="Create if missing" description="Create the account (and add it to Administrators, sudo or wheel) when it doesn’t exist." set={has('create_if_missing')} onSet={toggle('create_if_missing')} disabled={disabled} inherited="Yes" issue={issueAt('escrow.laps.create_if_missing')}>
          <OnOff value={laps.create_if_missing ?? true} onChange={(value) => set('create_if_missing', value)} disabled={disabled} label="Create if missing" on="Yes" off="No" />
        </Row>
        <Row label="Password length" description={`${LAPS_LIMITS.length[0]}–${LAPS_LIMITS.length[1]} characters; every character class appears at least once.`} set={has('length')} onSet={toggle('length')} disabled={disabled} inherited={`${LAPS_DEFAULTS.length} characters`} issue={issueAt('escrow.laps.length')}>
          <NumberInput value={laps.length} onChange={(value) => set('length', value)} disabled={disabled} label="Password length" unit="chars" min={LAPS_LIMITS.length[0]} max={LAPS_LIMITS.length[1]} />
        </Row>
        <Row label="Characters" description="Alphanumeric passwords are easier to type on consoles without a clipboard." set={has('complexity')} onSet={toggle('complexity')} disabled={disabled} inherited={COMPLEXITY_LABEL.full} issue={issueAt('escrow.laps.complexity')}>
          <ToggleGroup className={SEGMENTED} value={[laps.complexity ?? 'full']} onValueChange={(next: string[]) => next[0] && set('complexity', next[0] as LapsComplexity)} variant="outline" spacing={0} size="sm" disabled={disabled} aria-label="Password characters">
            <ToggleGroupItem value="full" className="px-3">
              With symbols
            </ToggleGroupItem>
            <ToggleGroupItem value="alphanumeric" className="px-3">
              A–Z, 0–9
            </ToggleGroupItem>
          </ToggleGroup>
        </Row>
        <Row label="Rotate every" description={`${LAPS_LIMITS.rotate_days[0]}–${LAPS_LIMITS.rotate_days[1]} days.`} set={has('rotate_days')} onSet={toggle('rotate_days')} disabled={disabled} inherited={`${LAPS_DEFAULTS.rotate_days} days`} issue={issueAt('escrow.laps.rotate_days')}>
          <NumberInput value={laps.rotate_days} onChange={(value) => set('rotate_days', value)} disabled={disabled} label="Rotate every" unit="days" min={LAPS_LIMITS.rotate_days[0]} max={LAPS_LIMITS.rotate_days[1]} />
        </Row>
        <Row
          label="Rotate after a reveal"
          description={`Hours after someone reveals the password (0 turns this off, at most ${LAPS_LIMITS.rotate_after_reveal_hours[1]}).${Number.isFinite(laps.rotate_after_reveal_hours) && laps.rotate_after_reveal_hours !== undefined ? ` Currently: ${formatHours(laps.rotate_after_reveal_hours)}.` : ''}`}
          set={has('rotate_after_reveal_hours')}
          onSet={toggle('rotate_after_reveal_hours')}
          disabled={disabled}
          inherited={`${LAPS_DEFAULTS.rotate_after_reveal_hours} hours`}
          issue={issueAt('escrow.laps.rotate_after_reveal_hours')}
        >
          <NumberInput value={laps.rotate_after_reveal_hours} onChange={(value) => set('rotate_after_reveal_hours', value)} disabled={disabled} label="Rotate after a reveal" unit="hours" min={0} max={LAPS_LIMITS.rotate_after_reveal_hours[1]} />
        </Row>
        <div className="flex items-start gap-3 px-4 py-3 text-micro text-subtle-foreground">
          <Lock className="mt-0.5 size-3.5 shrink-0" />
          <span>Disabling other local administrators isn’t offered: the current agent refuses that option.</span>
        </div>
      </Card>

      <Card icon={<Laptop />} title="FileVault" description="Escrow of a personal recovery key on macOS (attended: an administrator triggers it on the Mac).">
        <Row
          label="Escrow recovery key"
          description="Stored for when the agent supports it; the current agent only reports FileVault status."
          set={doc.escrow?.filevault?.escrow !== undefined}
          onSet={(on) => onChange({ ...doc, escrow: setFilevaultEscrow(doc.escrow, on ? FILEVAULT_DEFAULTS.escrow : undefined) })}
          disabled={disabled}
          inherited="Off"
          issue={issueAt('escrow.filevault')}
        >
          <OnOff value={Boolean(doc.escrow?.filevault?.escrow)} onChange={(value) => onChange({ ...doc, escrow: setFilevaultEscrow(doc.escrow, value) })} disabled={disabled} label="FileVault escrow" />
        </Row>
      </Card>
    </div>
  )
}
