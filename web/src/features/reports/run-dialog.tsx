/* Run a report: type, typed parameters, then on screen (JSON), PDF or CSV — optionally queued in the background. */
import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { FileSpreadsheet, FileText, MonitorPlay, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldLabel } from '@/components/ui/field'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { SimpleSelect } from '@/components/common/simple-select'
import { reportsApi } from '@/lib/api/endpoints'
import { errorMessage } from '@/lib/api/errors'
import type { ReportFormat, ReportTypeInfo } from '@/lib/api/types'
import { buildParameters, customRangeError, emptyReportForm, searchFromForm, type ReportForm } from '@/lib/reports/params'
import { cn } from '@/lib/utils'
import { reportMeta } from './report-meta'
import { ReportParamsForm } from './report-params-form'
import { useReportFiles } from './use-report-runner'

const FORMATS: { value: ReportFormat; label: string; description: string; icon: typeof MonitorPlay }[] = [
  { value: 'json', label: 'On screen', description: 'Interactive viewer with sortable tables and charts', icon: MonitorPlay },
  { value: 'pdf', label: 'PDF', description: 'Branded document with your logo and accent', icon: FileText },
  { value: 'csv', label: 'CSV', description: 'Every section and row, for spreadsheets', icon: FileSpreadsheet },
]

export function RunDialog({
  open,
  onOpenChange,
  types,
  initialType,
  initialForm,
  initialFormat = 'json',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  types: ReportTypeInfo[]
  initialType?: string
  initialForm?: ReportForm
  initialFormat?: ReportFormat
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-[620px]">
        {open && <RunForm key={`${initialType}-${initialFormat}`} types={types} initialType={initialType} initialForm={initialForm} initialFormat={initialFormat} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function RunForm({ types, initialType, initialForm, initialFormat, onDone }: { types: ReportTypeInfo[]; initialType?: string; initialForm?: ReportForm; initialFormat: ReportFormat; onDone: () => void }) {
  const navigate = useNavigate()
  const { runFile } = useReportFiles()
  const [typeId, setTypeId] = useState(initialType && types.some((type) => type.type === initialType) ? initialType : (types[0]?.type ?? ''))
  const [form, setForm] = useState<ReportForm>(() => initialForm ?? emptyReportForm())
  const [format, setFormat] = useState<ReportFormat>(initialFormat)
  const [background, setBackground] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const type = types.find((item) => item.type === typeId)
  const meta = reportMeta(typeId)
  const rangeError = form.period === 'custom' ? customRangeError(form.customFrom, form.customTo) : null

  async function submit() {
    if (!type || rangeError) return
    setError(null)
    const parameters = buildParameters(type, form)
    if (format !== 'json') {
      void runFile({ type: type.type, parameters, format, async: background || undefined }, type.name)
      onDone()
      return
    }
    if (!background) {
      onDone()
      void navigate({ to: '/reports/view', search: searchFromForm(type.type, form) })
      return
    }
    setPending(true)
    try {
      const outcome = await reportsApi.run({ type: type.type, parameters, format: 'json', async: true })
      onDone()
      void navigate({ to: '/reports/view', search: { ...searchFromForm(type.type, form), run: outcome.kind === 'file' ? undefined : outcome.run_id } })
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setPending(false)
    }
  }

  return (
    <form
      className="grid grid-cols-1 gap-5"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2.5">
          <span className={cn('flex size-7 items-center justify-center rounded-lg ring-1 [&_svg]:size-3.5', meta.tone)}>
            <meta.icon />
          </span>
          Run a report
        </DialogTitle>
        <DialogDescription>{type?.description ?? 'Choose a report and its parameters.'}</DialogDescription>
      </DialogHeader>

      <Field>
        <FieldLabel htmlFor="run-type">Report</FieldLabel>
        <SimpleSelect id="run-type" value={typeId} onValueChange={setTypeId} options={types.map((item) => ({ value: item.type, label: item.name }))} />
      </Field>

      <ReportParamsForm type={type} form={form} onChange={setForm} idPrefix="run" />

      <fieldset className="grid min-w-0 gap-2">
        <legend className="mb-1.5 text-dense font-medium">Output</legend>
        <div role="radiogroup" aria-label="Output" className="grid gap-2 sm:grid-cols-3">
          {FORMATS.map((item) => (
            <button
              key={item.value}
              type="button"
              role="radio"
              aria-checked={format === item.value}
              onClick={() => setFormat(item.value)}
              className={cn(
                'flex min-w-0 flex-col items-start gap-1 rounded-lg p-3 text-left ring-1 ring-border outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring',
                format === item.value && 'bg-primary/[0.06] ring-primary/40',
              )}
            >
              <span className="flex items-center gap-1.5 text-dense font-medium">
                <item.icon className={cn('size-4', format === item.value ? 'text-primary' : 'text-subtle-foreground')} />
                {item.label}
              </span>
              <span className="text-micro text-muted-foreground">{item.description}</span>
            </button>
          ))}
        </div>
        <Label className="mt-1 flex items-start gap-2 text-dense font-normal text-muted-foreground">
          <Checkbox checked={background} onCheckedChange={(checked) => setBackground(Boolean(checked))} className="mt-0.5" />
          <span>
            Generate in the background
            <span className="block text-micro text-subtle-foreground">Runs over more than 500 devices are always queued; you can keep working and pick the result up in Run history.</span>
          </span>
        </Label>
      </fieldset>

      {error && (
        <p role="alert" className="text-dense text-critical">
          {error}
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={!type || Boolean(rangeError) || pending}>
          {pending ? <Spinner data-icon="inline-start" /> : <Play data-icon="inline-start" />}
          {format === 'json' ? 'View report' : `Download ${format.toUpperCase()}`}
        </Button>
      </DialogFooter>
    </form>
  )
}
