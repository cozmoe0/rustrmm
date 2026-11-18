import { useMemo } from 'react'
import { CalendarClock } from 'lucide-react'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/common/simple-select'
import { TimezonePicker } from '@/components/common/timezone-picker'
import { describeCron, formatInZone, isValidCron, nextCronRuns, normalizeCron } from '@/lib/cron'
import { formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'

const JOB_CRON_PRESETS: { value: string; label: string; cron: string }[] = [
  { value: 'every-15', label: 'Every 15 minutes', cron: '*/15 * * * *' },
  { value: 'hourly', label: 'Every hour', cron: '0 * * * *' },
  { value: 'daily', label: 'Daily at 03:00', cron: '0 3 * * *' },
  { value: 'weekdays', label: 'Weekdays at 08:00', cron: '0 8 * * 1-5' },
  { value: 'weekly', label: 'Weekly, Sunday at 03:00', cron: '0 3 * * 0' },
  { value: 'monthly', label: 'Monthly, 1st at 02:00', cron: '0 2 1 * *' },
]

function presetFor(cron: string) {
  const normalized = normalizeCron(cron)
  return JOB_CRON_PRESETS.find((preset) => preset.cron === normalized)?.value ?? 'custom'
}

/** The next few runs on the schedule's own wall clock, with the local time when it differs. */
export function NextRuns({
  cron,
  timezone,
  count = 5,
  className,
}: {
  cron: string
  timezone: string
  count?: number
  className?: string
}) {
  const runs = useMemo(
    () => (isValidCron(cron) ? nextCronRuns(cron, { timeZone: timezone, count }) : []),
    [cron, timezone, count],
  )
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (runs.length === 0) return null
  return (
    <div className={cn('rounded-lg bg-surface-2 p-3 ring-1 ring-border', className)}>
      <div className="mb-2 flex items-center gap-1.5 text-micro font-medium text-muted-foreground">
        <CalendarClock className="size-3.5" />
        Next {runs.length} runs · {timezone.replace(/_/g, ' ')}
      </div>
      <ol className="grid grid-cols-1 gap-1">
        {runs.map((run, index) => (
          <li key={run.toISOString()} className="flex items-baseline justify-between gap-3 text-dense">
            <span className={cn('tabular', index === 0 ? 'font-medium' : 'text-muted-foreground')}>
              {formatInZone(run, timezone)}
            </span>
            <span className="tabular truncate text-micro text-subtle-foreground">
              {local !== timezone ? `${formatInZone(run, local)} your time · ` : ''}
              {formatRelative(run)}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}

/** Preset + cron expression + time zone, with a readable description and the upcoming runs. */
export function CronField({
  cron,
  timezone,
  onCronChange,
  onTimezoneChange,
  idPrefix = 'cron',
  error,
  preview = true,
}: {
  cron: string
  timezone: string
  onCronChange: (cron: string) => void
  onTimezoneChange: (zone: string) => void
  idPrefix?: string
  error?: string
  preview?: boolean
}) {
  const preset = presetFor(cron)
  const valid = isValidCron(cron)
  return (
    <div className="grid grid-cols-1 gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-preset`}>Repeat</FieldLabel>
          <SimpleSelect
            id={`${idPrefix}-preset`}
            value={preset}
            onValueChange={(value) => {
              const match = JOB_CRON_PRESETS.find((item) => item.value === value)
              if (match) onCronChange(match.cron)
            }}
            options={[
              ...JOB_CRON_PRESETS.map((item) => ({ value: item.value, label: item.label })),
              { value: 'custom', label: 'Custom (cron)' },
            ]}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-zone`}>Time zone</FieldLabel>
          <TimezonePicker id={`${idPrefix}-zone`} value={timezone} onChange={onTimezoneChange} />
        </Field>
      </div>
      <Field data-invalid={!valid || Boolean(error) || undefined}>
        <FieldLabel htmlFor={`${idPrefix}-expr`}>Cron expression</FieldLabel>
        <Input
          id={`${idPrefix}-expr`}
          className="font-mono"
          value={cron}
          aria-invalid={!valid || undefined}
          onChange={(event) => onCronChange(event.target.value)}
          spellCheck={false}
        />
        {valid ? (
          <FieldDescription>
            <span className="font-medium text-foreground">{describeCron(cron)}</span> · minute hour day month weekday
          </FieldDescription>
        ) : (
          <FieldError>Enter five fields: minute hour day-of-month month day-of-week</FieldError>
        )}
        {error && <FieldError>{error}</FieldError>}
      </Field>
      {preview && valid && <NextRuns cron={cron} timezone={timezone} />}
    </div>
  )
}
