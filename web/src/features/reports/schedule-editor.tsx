/* Create or edit a report schedule: report, scope, delivery cron + time zone, recipients and per-client mode. */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2, Mail } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { SimpleSelect } from '@/components/common/simple-select'
import { TimezonePicker } from '@/components/common/timezone-picker'
import { TokenInput } from '@/components/common/token-input'
import { NextRuns } from '@/features/automation/schedule-editor'
import { SEGMENTED } from '@/features/automation/styles'
import { reportsApi } from '@/lib/api/endpoints'
import { isApiError } from '@/lib/api/errors'
import { platformKeys, reportTypesQuery } from '@/lib/api/queries'
import type { ReportSchedule, ReportScheduleInput } from '@/lib/api/types'
import { isValidCron, localTimeZone } from '@/lib/cron'
import { buildParameters, emptyReportForm, formFromParameters, type ReportForm } from '@/lib/reports/params'
import { MAX_RECIPIENTS, REPORT_CRON_PRESETS, describeReportCron, normalizeRecipients, recipientError, reportPresetFor, scheduleIssues, type ScheduleIssues } from '@/lib/reports/schedule'
import { ReportParamsForm } from './report-params-form'

export function ScheduleEditor({ schedule, initialType, open, onOpenChange }: { schedule: ReportSchedule | null; initialType?: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="gap-0 p-0 shadow-popover data-[side=right]:w-full data-[side=right]:sm:max-w-[620px]">
        {open && <ScheduleForm key={schedule?.id ?? `new-${initialType ?? ''}`} schedule={schedule} initialType={initialType} onDone={() => onOpenChange(false)} />}
      </SheetContent>
    </Sheet>
  )
}

function ScheduleForm({ schedule, initialType, onDone }: { schedule: ReportSchedule | null; initialType?: string; onDone: () => void }) {
  const queryClient = useQueryClient()
  const { data: types = [] } = useQuery(reportTypesQuery)
  const [name, setName] = useState(schedule?.name ?? '')
  const [typeId, setTypeId] = useState(schedule?.type ?? initialType ?? 'executive_summary')
  const [form, setForm] = useState<ReportForm>(() => (schedule ? formFromParameters(schedule.parameters) : emptyReportForm()))
  const [format, setFormat] = useState<'pdf' | 'csv'>(schedule?.format ?? 'pdf')
  const [cron, setCron] = useState(schedule?.cron ?? REPORT_CRON_PRESETS[1].cron)
  const [timezone, setTimezone] = useState(schedule?.timezone ?? localTimeZone())
  const [recipients, setRecipients] = useState<string[]>(schedule?.recipients ?? [])
  const [perClient, setPerClient] = useState(schedule?.per_client ?? false)
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true)
  const [attempted, setAttempted] = useState(false)
  const [serverIssue, setServerIssue] = useState<{ path: string; message: string } | null>(null)
  const type = types.find((item) => item.type === typeId)
  const preset = reportPresetFor(cron)

  const input: ReportScheduleInput = {
    name: name.trim() || '',
    type: typeId,
    parameters: buildParameters(type, form, { withPeriod: false }),
    format,
    cron: cron.trim(),
    timezone,
    recipients: normalizeRecipients(recipients),
    per_client: perClient,
    enabled,
  }
  const issues: ScheduleIssues = scheduleIssues(input)
  const show = (key: keyof ScheduleIssues) => (attempted ? issues[key] : undefined) ?? (serverIssue?.path.startsWith(key) ? serverIssue.message : undefined)

  const save = useMutation({
    mutationFn: () => (schedule ? reportsApi.updateSchedule(schedule.id, input) : reportsApi.createSchedule(input)),
    meta: { silent: true },
    onSuccess: (saved) => {
      toast.success(schedule ? `Saved “${saved.name}”` : `Scheduled “${saved.name}”`, { description: saved.next_run_at ? `Next delivery ${new Date(saved.next_run_at).toLocaleString()}` : 'Disabled — it won’t run until you enable it.' })
      void queryClient.invalidateQueries({ queryKey: platformKeys.reportSchedules })
      onDone()
    },
    onError: (failure) => {
      if (isApiError(failure) && failure.status === 422) setServerIssue({ path: String((failure.details as { path?: string } | undefined)?.path ?? ''), message: failure.message })
      else toast.error(isApiError(failure) ? failure.message : 'Could not save the schedule')
    },
  })

  return (
    <form
      className="flex h-full min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault()
        setAttempted(true)
        setServerIssue(null)
        if (Object.keys(issues).length === 0) save.mutate()
      }}
    >
      <SheetHeader className="border-b border-border px-5 pt-5 pb-4">
        <SheetTitle>{schedule ? 'Edit schedule' : 'Schedule a report'}</SheetTitle>
        <SheetDescription>The report is generated with your current access and e-mailed as a branded PDF or a CSV. SMTP must be configured.</SheetDescription>
      </SheetHeader>
      <div className="grid min-h-0 flex-1 grid-cols-1 content-start gap-5 overflow-y-auto px-5 py-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field data-invalid={Boolean(show('name')) || undefined}>
            <FieldLabel htmlFor="schedule-name">Name</FieldLabel>
            <Input id="schedule-name" value={name} onChange={(event) => setName(event.target.value)} placeholder={type ? `Monthly ${type.name.toLowerCase()}` : 'Monthly report'} />
            {show('name') && <FieldError>{show('name')}</FieldError>}
          </Field>
          <Field data-invalid={Boolean(show('type')) || undefined}>
            <FieldLabel htmlFor="schedule-type">Report</FieldLabel>
            <SimpleSelect id="schedule-type" value={typeId} onValueChange={setTypeId} options={types.map((item) => ({ value: item.type, label: item.name }))} />
          </Field>
        </div>

        <ReportParamsForm type={type} form={form} onChange={setForm} withPeriod={false} idPrefix="schedule" />

        <Field>
          <FieldLabel>Format</FieldLabel>
          <ToggleGroup value={[format]} onValueChange={(next: string[]) => next[0] && setFormat(next[0] as 'pdf' | 'csv')} variant="outline" spacing={0} size="sm" className={`w-fit ${SEGMENTED}`} aria-label="Format">
            <ToggleGroupItem value="pdf" className="px-3">
              PDF
            </ToggleGroupItem>
            <ToggleGroupItem value="csv" className="px-3">
              CSV
            </ToggleGroupItem>
          </ToggleGroup>
        </Field>

        <fieldset className="grid min-w-0 gap-3 rounded-xl p-4 ring-1 ring-border">
          <legend className="px-1 text-dense font-medium">Delivery</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="schedule-preset">Repeat</FieldLabel>
              <SimpleSelect
                id="schedule-preset"
                value={preset}
                onValueChange={(value) => {
                  const match = REPORT_CRON_PRESETS.find((item) => item.value === value)
                  if (match) setCron(match.cron)
                }}
                options={[...REPORT_CRON_PRESETS.map((item) => ({ value: item.value, label: item.label })), { value: 'custom', label: 'Custom (cron)' }]}
              />
            </Field>
            <Field data-invalid={Boolean(show('timezone')) || undefined}>
              <FieldLabel htmlFor="schedule-zone">Time zone</FieldLabel>
              <TimezonePicker id="schedule-zone" value={timezone} onChange={setTimezone} />
              {show('timezone') && <FieldError>{show('timezone')}</FieldError>}
            </Field>
          </div>
          <Field data-invalid={Boolean(show('cron')) || !isValidCron(cron) || undefined}>
            <FieldLabel htmlFor="schedule-cron">Cron expression</FieldLabel>
            <Input id="schedule-cron" className="font-mono" value={cron} onChange={(event) => setCron(event.target.value)} spellCheck={false} aria-invalid={!isValidCron(cron) || undefined} />
            {isValidCron(cron) ? (
              <FieldDescription>
                <span className="font-medium text-foreground">{describeReportCron(cron)}</span> · minute hour day month weekday, in {timezone.replace(/_/g, ' ')}
              </FieldDescription>
            ) : (
              <FieldError>{show('cron') ?? 'Enter five fields: minute hour day-of-month month day-of-week'}</FieldError>
            )}
          </Field>
          {isValidCron(cron) && <NextRuns cron={cron} timezone={timezone} count={3} />}
        </fieldset>

        <fieldset className="grid min-w-0 gap-3 rounded-xl p-4 ring-1 ring-border">
          <legend className="px-1 text-dense font-medium">Recipients</legend>
          <label className="flex items-start justify-between gap-4">
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-dense font-medium">
                <Building2 className="size-4 text-subtle-foreground" />
                One report per client
              </span>
              <span className="block text-micro text-muted-foreground">Each client gets its own branded report, sent to its primary contacts (with an e-mail address) plus the recipients below.</span>
            </span>
            <Switch checked={perClient} onCheckedChange={setPerClient} aria-label="One report per client" />
          </label>
          <Field data-invalid={Boolean(show('recipients')) || undefined}>
            <FieldLabel htmlFor="schedule-recipients" className="flex items-center gap-1.5">
              <Mail className="size-3.5 text-subtle-foreground" />
              {perClient ? 'Also send to' : 'Send to'}
            </FieldLabel>
            <TokenInput id="schedule-recipients" value={recipients} onChange={setRecipients} placeholder="name@example.com" normalize={(value) => value.trim().toLowerCase()} validate={recipientError} max={MAX_RECIPIENTS} />
            {show('recipients') ? <FieldError>{show('recipients')}</FieldError> : <FieldDescription>Up to {MAX_RECIPIENTS} addresses, stored lower-case.</FieldDescription>}
          </Field>
        </fieldset>

        <label className="flex items-start justify-between gap-4 rounded-xl p-4 ring-1 ring-border">
          <span>
            <span className="block text-dense font-medium">Enabled</span>
            <span className="block text-micro text-muted-foreground">Disabled schedules keep their settings but never run.</span>
          </span>
          <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enabled" />
        </label>
        {serverIssue && !['name', 'type', 'cron', 'timezone', 'recipients'].some((key) => serverIssue.path.startsWith(key)) && (
          <p role="alert" className="text-dense text-critical">
            {serverIssue.message}
          </p>
        )}
      </div>
      <SheetFooter className="flex-row justify-end border-t border-border px-5 py-3">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending && <Spinner data-icon="inline-start" />}
          {schedule ? 'Save schedule' : 'Create schedule'}
        </Button>
      </SheetFooter>
    </form>
  )
}
