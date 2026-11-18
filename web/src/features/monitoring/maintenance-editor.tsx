/* The maintenance window editor: targets, a one-off or recurring schedule with a live preview, and the suppress mode. */
import { useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BellOff, CalendarClock, ChevronsUpDown, Globe, Plus, Repeat, Save, ShieldOff, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { OsIcon } from '@/components/common/os-icon'
import { SimpleSelect } from '@/components/common/simple-select'
import { maintenanceApi } from '@/lib/api/endpoints'
import { clientsQuery, devicesQuery, groupsQuery, keys, sitesQuery } from '@/lib/api/queries'
import type { MaintenanceTarget, MaintenanceTargetType, MaintenanceWindow, MaintenanceWindowInput } from '@/lib/api/types'
import { formatInZone, localTimeZone } from '@/lib/cron'
import { deviceName } from '@/lib/devices'
import { formatRelative } from '@/lib/format'
import { formatMinutes } from '@/lib/monitoring/labels'
import { describeSchedule, MAX_DURATION_MINUTES, occurrences, validateMaintenance } from '@/lib/monitoring/maintenance'
import {
  addTarget,
  DURATION_PRESETS,
  emptyWindow,
  extraMaintenanceIssues,
  fromLocalInput,
  switchSchedule,
  targetKey,
  toLocalInput,
  windowToInput,
} from '@/lib/monitoring/maintenance-editor'
import { cn } from '@/lib/utils'
import { CronField } from '@/features/automation/schedule-editor'
import { SEGMENTED } from '@/features/automation/styles'
import { TARGET_ICON } from '@/features/automation/target-icons'

const TARGET_TYPES: { value: Exclude<MaintenanceTargetType, 'global'>; label: string }[] = [
  { value: 'client', label: 'Client' },
  { value: 'site', label: 'Site' },
  { value: 'group', label: 'Device group' },
  { value: 'device', label: 'Device' },
]

interface TargetOption {
  value: string
  label: string
  hint?: string
  icon?: ReactNode
}

function useTargetOptions(enabled: boolean): Record<Exclude<MaintenanceTargetType, 'global'>, TargetOption[]> {
  const { data: clients = [] } = useQuery({ ...clientsQuery(), enabled })
  const { data: sites = [] } = useQuery({ ...sitesQuery(), enabled })
  const { data: groups = [] } = useQuery({ ...groupsQuery(), enabled })
  const { data: devices = [] } = useQuery({ ...devicesQuery(), enabled })
  return useMemo(
    () => ({
      client: clients.map((client) => ({ value: client.id, label: client.name, hint: `${client.device_count} devices` })),
      site: sites.map((site) => ({
        value: site.id,
        label: site.name,
        hint: clients.find((client) => client.id === site.client_id)?.name,
      })),
      group: groups.map((group) => ({ value: group.id, label: group.name, hint: `${group.kind} · ${group.member_count} devices` })),
      device: devices
        .filter((device) => device.status === 'active')
        .map((device) => ({
          value: device.id,
          label: deviceName(device),
          hint: device.client_name,
          icon: <OsIcon family={device.os_family} />,
        })),
    }),
    [clients, sites, groups, devices],
  )
}

function TargetAdder({
  options,
  taken,
  onAdd,
}: {
  options: Record<Exclude<MaintenanceTargetType, 'global'>, TargetOption[]>
  taken: string[]
  onAdd: (target: MaintenanceTarget) => void
}) {
  const [type, setType] = useState<Exclude<MaintenanceTargetType, 'global'>>('client')
  const [open, setOpen] = useState(false)
  const Icon = TARGET_ICON[type]
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[10rem_minmax(0,1fr)]">
      <SimpleSelect
        ariaLabel="Target type"
        value={type}
        onValueChange={(value) => setType(value as Exclude<MaintenanceTargetType, 'global'>)}
        options={TARGET_TYPES.map((item) => {
          const ItemIcon = TARGET_ICON[item.value]
          return { value: item.value, label: item.label, icon: <ItemIcon className="size-3.5 text-subtle-foreground" /> }
        })}
      />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={<Button type="button" variant="outline" role="combobox" aria-expanded={open} className="w-full justify-between font-normal" />}
        >
          <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
            <Plus className="size-3.5" />
            Add a {TARGET_TYPES.find((item) => item.value === type)?.label.toLowerCase()}…
          </span>
          <ChevronsUpDown className="text-muted-foreground" />
        </PopoverTrigger>
        <PopoverContent className="w-(--anchor-width) min-w-72 p-0" align="start">
          <Command>
            <CommandInput placeholder="Search…" />
            <CommandList className="max-h-72">
              <CommandEmpty>Nothing matches.</CommandEmpty>
              <CommandGroup>
                {options[type].map((option) => {
                  const used = taken.includes(`${type}:${option.value}`)
                  return (
                    <CommandItem
                      key={option.value}
                      value={`${option.label} ${option.hint ?? ''}`}
                      disabled={used}
                      data-checked={used}
                      onSelect={() => {
                        onAdd({ type, id: option.value })
                        setOpen(false)
                      }}
                    >
                      {option.icon ?? <Icon className="size-3.5 text-subtle-foreground" />}
                      <span className="min-w-0 flex-1 truncate">{option.label}</span>
                      {option.hint && <span className="max-w-[45%] truncate text-micro text-subtle-foreground">{option.hint}</span>}
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}

function OccurrencePreview({ draft }: { draft: MaintenanceWindowInput }) {
  // The editor is short-lived, so the moment it opened is a fine reference for the preview.
  const [now] = useState(() => Date.now())
  const list = occurrences(draft.schedule, { count: 5, from: new Date(now) })
  const local = localTimeZone()
  const zone = draft.schedule.type === 'recurring' ? draft.schedule.timezone : local
  return (
    <div className="grid grid-cols-1 gap-2 rounded-lg bg-surface-2 p-3 ring-1 ring-border">
      <div className="flex items-start gap-2 text-dense">
        <CalendarClock className="mt-0.5 size-4 shrink-0 text-subtle-foreground" />
        <span className="font-medium">{describeSchedule(draft.schedule, local)}</span>
      </div>
      {list.length > 0 ? (
        <ol className="grid grid-cols-1 gap-1 sm:pl-6">
          {list.map((item, index) => {
            const active = item.start.getTime() <= now && item.end.getTime() > now
            return (
              <li key={item.start.toISOString()} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-dense">
                <span className={cn('tabular', index === 0 ? 'font-medium' : 'text-muted-foreground')}>
                  {formatInZone(item.start, zone)} → {formatInZone(item.end, zone)}
                </span>
                <span className={cn('tabular text-micro', active ? 'font-medium text-live' : 'text-subtle-foreground')}>
                  {active ? 'Active now' : formatRelative(item.start)}
                  {!active && zone !== local ? ` · ${formatInZone(item.start, local)} your time` : ''}
                </span>
              </li>
            )
          })}
        </ol>
      ) : (
        <p className="text-micro text-muted-foreground sm:pl-6">No upcoming occurrences.</p>
      )}
    </div>
  )
}

function SuppressCard({
  selected,
  onSelect,
  icon,
  title,
  description,
  disabled,
}: {
  selected: boolean
  onSelect: () => void
  icon: ReactNode
  title: string
  description: string
  disabled: boolean
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'flex items-start gap-3 rounded-lg p-3 text-left ring-1 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60',
        selected ? 'bg-primary/[0.06] ring-primary/40' : 'ring-border hover:bg-surface-2',
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border',
          selected ? 'border-primary bg-primary' : 'border-input',
        )}
        aria-hidden="true"
      >
        {selected && <span className="size-1.5 rounded-full bg-primary-foreground" />}
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-dense font-medium [&_svg]:size-3.5 [&_svg]:text-subtle-foreground">
          {icon}
          {title}
        </span>
        <span className="mt-0.5 block text-micro text-muted-foreground">{description}</span>
      </span>
    </button>
  )
}

export function MaintenanceEditor({
  existing,
  creating,
  open,
  onClose,
  canManage,
}: {
  existing: MaintenanceWindow | null
  creating: boolean
  open: boolean
  onClose: () => void
  canManage: boolean
}) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<MaintenanceWindowInput>(() => (existing ? windowToInput(existing) : emptyWindow()))
  const [attempted, setAttempted] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const options = useTargetOptions(open)
  const readOnly = !canManage
  const set = (patch: Partial<MaintenanceWindowInput>) => setDraft((prev) => ({ ...prev, ...patch }))

  const issues = [...validateMaintenance(draft), ...extraMaintenanceIssues(draft)]
  const issue = (field: string) => (attempted ? issues.find((item) => item.field === field)?.message : undefined)
  const global = draft.targets.some((target) => target.type === 'global')
  const names = new Map<string, string>()
  for (const target of existing?.targets ?? []) if (target.name) names.set(targetKey(target), target.name)
  const nameOf = (target: MaintenanceTarget) => {
    if (target.type === 'global') return 'Every managed device'
    const fromOptions = options[target.type].find((option) => option.value === target.id)?.label
    return fromOptions ?? names.get(targetKey(target)) ?? 'Unknown'
  }

  const save = useMutation({
    mutationFn: () => {
      const body = { ...draft, name: draft.name.trim() }
      return existing ? maintenanceApi.update(existing.id, body) : maintenanceApi.create(body)
    },
    meta: { successMessage: existing ? 'Maintenance window saved' : 'Maintenance window created' },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.maintenance })
      onClose()
    },
  })
  const remove = useMutation({
    mutationFn: () => maintenanceApi.remove(existing!.id),
    meta: { successMessage: 'Maintenance window deleted' },
    onSuccess: () => {
      setConfirmDelete(false)
      void queryClient.invalidateQueries({ queryKey: keys.maintenance })
      onClose()
    },
  })

  const recurring = draft.schedule.type === 'recurring' ? draft.schedule : null
  const once = draft.schedule.type === 'once' ? draft.schedule : null
  const durationChoice = recurring && DURATION_PRESETS.includes(recurring.duration_minutes) ? String(recurring.duration_minutes) : 'custom'
  const [customDuration, setCustomDuration] = useState(durationChoice === 'custom')
  const zone = localTimeZone()

  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent side="right" className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[560px]">
        <SheetHeader className="border-b border-border px-5 pt-5 pb-4">
          <SheetTitle className="pr-8 text-base">
            {creating ? 'New maintenance window' : readOnly ? (existing?.name ?? 'Maintenance window') : 'Edit maintenance window'}
          </SheetTitle>
          <SheetDescription>
            While a window is active, matching devices send no notifications and run no remediation.
          </SheetDescription>
        </SheetHeader>
        <form
          id="maintenance-form"
          className="flex-1 overflow-y-auto"
          onSubmit={(event) => {
            event.preventDefault()
            setAttempted(true)
            if (issues.length === 0 && canManage) save.mutate()
          }}
        >
          <fieldset disabled={readOnly} className="grid grid-cols-1 gap-6 px-5 py-5">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <Field data-invalid={Boolean(issue('name')) || undefined}>
                <FieldLabel htmlFor="maintenance-name">Name</FieldLabel>
                <Input
                  id="maintenance-name"
                  value={draft.name}
                  maxLength={120}
                  placeholder="Patch night — servers"
                  autoFocus={creating}
                  onChange={(event) => set({ name: event.target.value })}
                />
                <FieldError>{issue('name')}</FieldError>
              </Field>
              <label className="flex h-(--control-h) items-center gap-2 text-dense">
                <Switch checked={draft.enabled} onCheckedChange={(enabled) => set({ enabled })} aria-label="Enabled" />
                Enabled
              </label>
            </div>

            <section className="grid grid-cols-1 gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-dense font-semibold">Applies to</h3>
                <ToggleGroup
                  className={SEGMENTED}
                  value={[global ? 'global' : 'targets']}
                  onValueChange={(next: string[]) => {
                    if (next[0] === 'global') set({ targets: [{ type: 'global' }] })
                    else if (next[0] === 'targets' && global) set({ targets: [] })
                  }}
                  variant="outline"
                  spacing={0}
                  size="sm"
                  aria-label="Scope"
                >
                  <ToggleGroupItem value="targets" className="px-3">
                    Specific targets
                  </ToggleGroupItem>
                  <ToggleGroupItem value="global" className="px-3">
                    <Globe />
                    Everywhere
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
              {global ? (
                <p className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2.5 text-dense text-muted-foreground ring-1 ring-border">
                  <Globe className="size-4 shrink-0" />
                  Every managed device, in every client.
                </p>
              ) : (
                <>
                  {draft.targets.length > 0 && (
                    <ul className="flex flex-wrap gap-1.5">
                      {draft.targets.map((target) => {
                        const Icon = TARGET_ICON[target.type]
                        return (
                          <li
                            key={targetKey(target)}
                            className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-md bg-surface-2 pr-0.5 pl-2 text-dense ring-1 ring-border"
                          >
                            <Icon className="size-3.5 shrink-0 text-subtle-foreground" />
                            <span className="truncate">{nameOf(target)}</span>
                            {!readOnly && (
                              <button
                                type="button"
                                aria-label={`Remove ${nameOf(target)}`}
                                onClick={() => set({ targets: draft.targets.filter((item) => targetKey(item) !== targetKey(target)) })}
                                className="flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-surface-4 hover:text-foreground"
                              >
                                <X className="size-3" />
                              </button>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  )}
                  {!readOnly && (
                    <TargetAdder options={options} taken={draft.targets.map(targetKey)} onAdd={(target) => set({ targets: addTarget(draft.targets, target) })} />
                  )}
                </>
              )}
              {issue('targets') && <p className="text-dense text-destructive">{issue('targets')}</p>}
            </section>

            <section className="grid grid-cols-1 gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-dense font-semibold">Schedule</h3>
                <ToggleGroup
                  className={SEGMENTED}
                  value={[draft.schedule.type]}
                  onValueChange={(next: string[]) =>
                    next[0] && set({ schedule: switchSchedule(draft.schedule, next[0] as 'once' | 'recurring', zone) })
                  }
                  variant="outline"
                  spacing={0}
                  size="sm"
                  aria-label="Schedule type"
                >
                  <ToggleGroupItem value="once" className="px-3">
                    <CalendarClock />
                    One-off
                  </ToggleGroupItem>
                  <ToggleGroupItem value="recurring" className="px-3">
                    <Repeat />
                    Recurring
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
              {once && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field data-invalid={Boolean(issue('start')) || undefined}>
                    <FieldLabel htmlFor="maintenance-start">Starts</FieldLabel>
                    <Input
                      id="maintenance-start"
                      type="datetime-local"
                      className="tabular"
                      value={toLocalInput(once.start)}
                      onChange={(event) => set({ schedule: { ...once, start: fromLocalInput(event.target.value) ?? '' } })}
                    />
                    <FieldError>{issue('start')}</FieldError>
                  </Field>
                  <Field data-invalid={Boolean(issue('end')) || undefined}>
                    <FieldLabel htmlFor="maintenance-end">Ends</FieldLabel>
                    <Input
                      id="maintenance-end"
                      type="datetime-local"
                      className="tabular"
                      value={toLocalInput(once.end)}
                      onChange={(event) => set({ schedule: { ...once, end: fromLocalInput(event.target.value) ?? '' } })}
                    />
                    <FieldError>{issue('end')}</FieldError>
                  </Field>
                  <p className="text-micro text-subtle-foreground sm:col-span-2">
                    Times are in your time zone ({zone.replace(/_/g, ' ')}). One-off windows last at most 31 days.
                  </p>
                </div>
              )}
              {recurring && (
                <div className="grid grid-cols-1 gap-3">
                  <CronField
                    cron={recurring.cron}
                    timezone={recurring.timezone}
                    idPrefix="maintenance"
                    preview={false}
                    error={issue('cron')}
                    onCronChange={(cron) => set({ schedule: { ...recurring, cron } })}
                    onTimezoneChange={(timezone) => set({ schedule: { ...recurring, timezone } })}
                  />
                  <Field data-invalid={Boolean(issue('duration')) || undefined}>
                    <FieldLabel htmlFor="maintenance-duration">Duration</FieldLabel>
                    <div className="flex gap-2">
                      <SimpleSelect
                        id="maintenance-duration"
                        className="min-w-0 flex-1"
                        value={customDuration ? 'custom' : durationChoice}
                        onValueChange={(value) => {
                          if (value === 'custom') setCustomDuration(true)
                          else {
                            setCustomDuration(false)
                            set({ schedule: { ...recurring, duration_minutes: Number(value) } })
                          }
                        }}
                        options={[
                          ...DURATION_PRESETS.map((minutes) => ({ value: String(minutes), label: formatMinutes(minutes) })),
                          { value: 'custom', label: 'Custom…' },
                        ]}
                      />
                      {(customDuration || durationChoice === 'custom') && (
                        <div className="relative w-36 shrink-0">
                          <Input
                            type="number"
                            min={1}
                            max={MAX_DURATION_MINUTES}
                            className="tabular pr-12"
                            aria-label="Duration in minutes"
                            value={Number.isNaN(recurring.duration_minutes) ? '' : recurring.duration_minutes}
                            onChange={(event) =>
                              set({ schedule: { ...recurring, duration_minutes: event.target.value === '' ? Number.NaN : Number(event.target.value) } })
                            }
                          />
                          <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-micro text-subtle-foreground">
                            min
                          </span>
                        </div>
                      )}
                    </div>
                    {issue('duration') ? (
                      <FieldError>{issue('duration')}</FieldError>
                    ) : (
                      <FieldDescription>Each occurrence lasts this long and may cross midnight (up to 7 days).</FieldDescription>
                    )}
                  </Field>
                </div>
              )}
              <OccurrencePreview draft={draft} />
            </section>

            <section className="grid grid-cols-1 gap-3">
              <h3 className="text-dense font-semibold">During the window</h3>
              <div role="radiogroup" aria-label="Suppress mode" className="grid grid-cols-1 gap-2">
                <SuppressCard
                  selected={draft.suppress === 'notifications'}
                  onSelect={() => set({ suppress: 'notifications' })}
                  disabled={readOnly}
                  icon={<BellOff />}
                  title="Hold notifications"
                  description="Alerts still open and show in the inbox with a maintenance badge, but no notifications are sent and no remediation runs."
                />
                <SuppressCard
                  selected={draft.suppress === 'alerts'}
                  onSelect={() => set({ suppress: 'alerts' })}
                  disabled={readOnly}
                  icon={<ShieldOff />}
                  title="Suppress alerts"
                  description="No new alerts open at all. Check states are still recorded, so the device page stays accurate."
                />
              </div>
            </section>
            {existing && (
              <p className="text-micro text-subtle-foreground">
                Created by {existing.created_by_name}
                {existing.updated_at ? ` · updated ${formatRelative(existing.updated_at)}` : ''}
              </p>
            )}
          </fieldset>
        </form>
        <SheetFooter className="flex-row items-center gap-2 border-t border-border px-5 py-3">
          {existing && canManage && (
            <Button type="button" variant="ghost" className="mr-auto text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)}>
              <Trash2 data-icon="inline-start" />
              Delete
            </Button>
          )}
          <Button type="button" variant="ghost" className={cn(!(existing && canManage) && 'ml-auto')} onClick={onClose}>
            {canManage ? 'Cancel' : 'Close'}
          </Button>
          {canManage && (
            <Button type="submit" form="maintenance-form" disabled={save.isPending || (attempted && issues.length > 0)}>
              {save.isPending ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}
              {existing ? 'Save window' : 'Create window'}
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
      {existing && (
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title={`Delete “${existing.name}”?`}
          description={
            existing.active_now
              ? 'The window is active now: notifications for its devices resume immediately.'
              : 'Its devices are no longer covered when it would next start. This can’t be undone.'
          }
          confirmLabel="Delete window"
          pending={remove.isPending}
          onConfirm={() => remove.mutate()}
        />
      )}
    </Sheet>
  )
}
