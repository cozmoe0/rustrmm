import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, Copy, FileSliders, Lock, Pencil, Plus, Trash, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { ErrorState } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/simple-select'
import { snmpApi } from '@/lib/api/endpoints'
import { isApiError } from '@/lib/api/errors'
import { networkKeys, snmpDevicesQuery, snmpTemplatesQuery } from '@/lib/api/queries'
import type { SnmpMetricDef, SnmpMetricKind, SnmpTemplate } from '@/lib/api/types'
import { emptyMetric, validateMetrics, type MetricIssue } from '@/lib/network/snmp'
import { PERMISSIONS, hasGlobalPermission, useMe } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { networkErrorMessage } from './use-network'

const KIND_LABEL: Record<SnmpMetricKind, string> = { gauge: 'Gauge', counter: 'Counter (as rate)', text: 'Text' }

function thresholdText(metric: SnmpMetricDef) {
  const t = metric.thresholds
  if (!t || (t.warn == null && t.crit == null)) return '—'
  const sign = t.direction === 'above' ? '≥' : '≤'
  const unit = metric.unit === '%' ? '%' : metric.unit ? ` ${metric.unit}` : ''
  return [t.warn != null && `warn ${sign} ${t.warn}${unit}`, t.crit != null && `crit ${sign} ${t.crit}${unit}`].filter(Boolean).join(' · ')
}

function MetricsTable({ metrics }: { metrics: SnmpMetricDef[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-dense">
        <thead>
          <tr className="text-left text-micro font-semibold tracking-[0.06em] text-subtle-foreground uppercase">
            <th className="px-4 py-2">Metric</th>
            <th className="px-3 py-2">OID</th>
            <th className="px-3 py-2">Kind</th>
            <th className="px-3 py-2">Thresholds</th>
          </tr>
        </thead>
        <tbody>
          {metrics.map((metric) => (
            <tr key={metric.key} className="border-t border-border">
              <td className="px-4 py-2">
                <div className="font-medium">{metric.label || metric.key}</div>
                <div className="font-mono text-[10.5px] text-subtle-foreground">
                  {metric.key}
                  {metric.table && ' · table'}
                  {metric.max_oid && ' · % of max'}
                </div>
              </td>
              <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">{metric.oid}</td>
              <td className="px-3 py-2 text-muted-foreground">
                {KIND_LABEL[metric.kind]}
                {metric.unit && <span className="text-subtle-foreground"> · {metric.unit}</span>}
              </td>
              <td className="px-3 py-2 text-muted-foreground">{thresholdText(metric)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function TemplateCard({ template, usedBy, canEdit, onEdit, onDuplicate, onDelete }: { template: SnmpTemplate; usedBy: number; canEdit: boolean; onEdit: () => void; onDuplicate: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <article className="overflow-hidden rounded-xl bg-card shadow-card">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <button type="button" onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none" aria-expanded={open}>
          <ChevronDown className={cn('size-4 shrink-0 text-subtle-foreground transition-transform', !open && '-rotate-90')} />
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-2">
              <span className="truncate text-sm font-semibold">{template.name}</span>
              {template.builtin ? <Badge variant="secondary">Built-in</Badge> : <Badge variant="default">Custom</Badge>}
            </span>
            <span className="block text-micro text-subtle-foreground">
              {template.metrics.length} {template.metrics.length === 1 ? 'metric' : 'metrics'} · used by {usedBy} {usedBy === 1 ? 'device' : 'devices'}
            </span>
          </span>
        </button>
        {canEdit && (
          <div className="flex gap-1">
            <Button variant="ghost" size="xs" onClick={onDuplicate}>
              <Copy data-icon="inline-start" />
              Duplicate
            </Button>
            {!template.builtin && (
              <>
                <Button variant="outline" size="xs" onClick={onEdit}>
                  <Pencil data-icon="inline-start" />
                  Edit
                </Button>
                <Button variant="ghost" size="icon-xs" aria-label={`Delete ${template.name}`} className="hover:text-critical" onClick={onDelete}>
                  <Trash />
                </Button>
              </>
            )}
          </div>
        )}
      </div>
      {open && (
        <div className="border-t border-border">
          <MetricsTable metrics={template.metrics} />
        </div>
      )}
    </article>
  )
}

function MetricEditor({ metric, index, issues, onChange, onRemove }: { metric: SnmpMetricDef; index: number; issues: MetricIssue[]; onChange: (metric: SnmpMetricDef) => void; onRemove: () => void }) {
  const issue = (field: MetricIssue['field']) => issues.find((item) => item.index === index && item.field === field)?.message
  const set = (patch: Partial<SnmpMetricDef>) => onChange({ ...metric, ...patch })
  const thresholds = metric.thresholds ?? null
  const num = (value: string) => (value.trim() === '' ? null : Number(value))
  return (
    <div className="grid gap-3 rounded-lg bg-surface-2 p-3 ring-1 ring-border">
      <div className="flex items-center gap-2">
        <span className="tabular text-micro font-semibold text-subtle-foreground">#{index + 1}</span>
        <span className="min-w-0 flex-1 truncate text-dense font-medium">{metric.label || metric.key || 'New metric'}</span>
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Remove metric" className="hover:text-critical" onClick={onRemove}>
          <Trash2 />
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field data-invalid={Boolean(issue('key')) || undefined}>
          <FieldLabel>Key</FieldLabel>
          <Input value={metric.key} onChange={(event) => set({ key: event.target.value })} className="font-mono text-[12.5px]" placeholder="fgSysCpuUsage" spellCheck={false} />
          {issue('key') && <FieldError>{issue('key')}</FieldError>}
        </Field>
        <Field>
          <FieldLabel>Label</FieldLabel>
          <Input value={metric.label} onChange={(event) => set({ label: event.target.value })} placeholder="CPU usage" />
        </Field>
        <Field data-invalid={Boolean(issue('oid')) || undefined} className="sm:col-span-2">
          <FieldLabel>OID</FieldLabel>
          <Input value={metric.oid} onChange={(event) => set({ oid: event.target.value })} className="font-mono text-[12.5px]" placeholder="1.3.6.1.4.1.12356.101.4.1.3.0" spellCheck={false} />
          {issue('oid') && <FieldError>{issue('oid')}</FieldError>}
        </Field>
        <Field>
          <FieldLabel>Kind</FieldLabel>
          <SimpleSelect value={metric.kind} onValueChange={(value) => set({ kind: value as SnmpMetricKind, thresholds: value === 'text' ? null : metric.thresholds })} options={(['gauge', 'counter', 'text'] as SnmpMetricKind[]).map((value) => ({ value, label: KIND_LABEL[value] }))} />
        </Field>
        <Field>
          <FieldLabel>Unit</FieldLabel>
          <Input value={metric.unit} onChange={(event) => set({ unit: event.target.value })} placeholder="%, B/s, V, min…" />
        </Field>
      </div>
      <div className="flex items-center gap-2">
        <Switch id={`metric-table-${index}`} checked={Boolean(metric.table)} onCheckedChange={(checked) => set({ table: checked, index_label_oid: checked ? metric.index_label_oid : null })} />
        <label htmlFor={`metric-table-${index}`} className="text-dense">
          Table (walk every row)
        </label>
      </div>
      {metric.table && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field data-invalid={Boolean(issue('index_label_oid')) || undefined}>
            <FieldLabel>Row label OID</FieldLabel>
            <Input value={metric.index_label_oid ?? ''} onChange={(event) => set({ index_label_oid: event.target.value || null })} className="font-mono text-[12.5px]" placeholder="1.3.6.1.2.1.2.2.1.2" spellCheck={false} />
            {issue('index_label_oid') && <FieldError>{issue('index_label_oid')}</FieldError>}
          </Field>
          <Field data-invalid={Boolean(issue('max_oid')) || undefined}>
            <FieldLabel>Percentage of (max OID)</FieldLabel>
            <Input value={metric.max_oid ?? ''} onChange={(event) => set({ max_oid: event.target.value || null })} className="font-mono text-[12.5px]" placeholder="optional" spellCheck={false} />
            {issue('max_oid') && <FieldError>{issue('max_oid')}</FieldError>}
          </Field>
        </div>
      )}
      {metric.kind !== 'text' && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field>
            <FieldLabel>Alert when</FieldLabel>
            <SimpleSelect
              value={thresholds ? thresholds.direction : 'none'}
              onValueChange={(value) => set({ thresholds: value === 'none' ? null : { warn: thresholds?.warn ?? null, crit: thresholds?.crit ?? null, direction: value as 'above' | 'below' } })}
              options={[
                { value: 'none', label: 'Never' },
                { value: 'above', label: 'At or above' },
                { value: 'below', label: 'At or below' },
              ]}
            />
          </Field>
          <Field>
            <FieldLabel>Warning</FieldLabel>
            <Input type="number" disabled={!thresholds} value={thresholds?.warn ?? ''} onChange={(event) => thresholds && set({ thresholds: { ...thresholds, warn: num(event.target.value) } })} className="tabular" />
          </Field>
          <Field data-invalid={Boolean(issue('thresholds')) || undefined}>
            <FieldLabel>Critical</FieldLabel>
            <Input type="number" disabled={!thresholds} value={thresholds?.crit ?? ''} onChange={(event) => thresholds && set({ thresholds: { ...thresholds, crit: num(event.target.value) } })} className="tabular" />
            {issue('thresholds') && <FieldError>{issue('thresholds')}</FieldError>}
          </Field>
        </div>
      )}
    </div>
  )
}

function TemplateSheet({ initial, open, onOpenChange }: { initial: { id: string | null; name: string; metrics: SnmpMetricDef[] } | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="gap-0 p-0 shadow-popover data-[side=right]:w-full data-[side=right]:sm:max-w-[640px]">
        {open && initial && <TemplateForm key={initial.id ?? `new-${initial.name}`} initial={initial} onDone={() => onOpenChange(false)} />}
      </SheetContent>
    </Sheet>
  )
}

function TemplateForm({ initial, onDone }: { initial: { id: string | null; name: string; metrics: SnmpMetricDef[] }; onDone: () => void }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(initial.name)
  const [metrics, setMetrics] = useState<SnmpMetricDef[]>(initial.metrics.length ? initial.metrics : [emptyMetric()])
  const [attempted, setAttempted] = useState(false)
  const issues = validateMetrics(metrics)
  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), metrics: metrics.map((metric) => ({ ...metric, key: metric.key.trim(), oid: metric.oid.trim().replace(/^\./, '') })) }
      return initial.id ? snmpApi.updateTemplate(initial.id, body) : snmpApi.createTemplate(body)
    },
    meta: { silent: true },
    onSuccess: (template) => {
      toast.success(initial.id ? `Saved “${template.name}”` : `Created “${template.name}”`)
      void queryClient.invalidateQueries({ queryKey: networkKeys.templates })
      onDone()
    },
    onError: (failure) => toast.error(isApiError(failure) && failure.status === 422 ? `${failure.message}${(failure.details as { path?: string } | undefined)?.path ? ` (${(failure.details as { path: string }).path})` : ''}` : networkErrorMessage(failure)),
  })
  return (
    <form
      className="flex h-full flex-col"
      onSubmit={(event) => {
        event.preventDefault()
        setAttempted(true)
        if (name.trim() && issues.length === 0) save.mutate()
      }}
    >
      <SheetHeader className="border-b border-border px-5 pt-5 pb-4">
        <SheetTitle>{initial.id ? 'Edit template' : 'New SNMP template'}</SheetTitle>
        <SheetDescription>Metrics the probe polls. Counters are stored as per-second rates; thresholds are inclusive and raise SNMP alerts.</SheetDescription>
      </SheetHeader>
      <div className="grid flex-1 content-start gap-4 overflow-y-auto px-5 py-4">
        <Field data-invalid={(attempted && !name.trim()) || undefined}>
          <FieldLabel htmlFor="template-name">Name</FieldLabel>
          <Input id="template-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Fortinet FortiGate" />
          {attempted && !name.trim() && <FieldError>Enter a name</FieldError>}
        </Field>
        {metrics.map((metric, index) => (
          <MetricEditor
            key={index}
            metric={metric}
            index={index}
            issues={attempted ? issues : []}
            onChange={(next) => setMetrics(metrics.map((item, position) => (position === index ? next : item)))}
            onRemove={() => setMetrics(metrics.filter((_, position) => position !== index))}
          />
        ))}
        <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => setMetrics([...metrics, emptyMetric()])}>
          <Plus data-icon="inline-start" />
          Add metric
        </Button>
        {attempted && issues.some((issue) => issue.index === -1) && <FieldError>Add at least one metric</FieldError>}
      </div>
      <SheetFooter className="flex-row justify-end border-t border-border px-5 py-3">
        <Button type="button" variant="ghost" onClick={onDone} disabled={save.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending && <Spinner data-icon="inline-start" />}
          {initial.id ? 'Save template' : 'Create template'}
        </Button>
      </SheetFooter>
    </form>
  )
}

export function TemplatesPage() {
  useTitle('SNMP templates')
  const me = useMe()
  const queryClient = useQueryClient()
  const canEdit = hasGlobalPermission(me, PERMISSIONS.networkManage)
  const { data, isLoading, error, refetch } = useQuery(snmpTemplatesQuery)
  const devices = useQuery(snmpDevicesQuery())
  const [editing, setEditing] = useState<{ id: string | null; name: string; metrics: SnmpMetricDef[] } | null>(null)
  const [deleting, setDeleting] = useState<SnmpTemplate | null>(null)
  const templates = data ?? []
  const usedBy = (id: string) => devices.data?.filter((device) => device.template_ids.includes(id)).length ?? 0

  const remove = useMutation({
    mutationFn: (template: SnmpTemplate) => snmpApi.removeTemplate(template.id),
    meta: { silent: true },
    onSuccess: (_result, template) => {
      toast.success(`Deleted “${template.name}”`)
      setDeleting(null)
      void queryClient.invalidateQueries({ queryKey: networkKeys.templates })
    },
    onError: (failure) => {
      setDeleting(null)
      toast.error(networkErrorMessage(failure))
    },
  })

  const section = (title: string, list: SnmpTemplate[]) => (
    <section className="grid gap-2">
      <h2 className="eyebrow">{title}</h2>
      {list.map((template) => (
        <TemplateCard
          key={template.id}
          template={template}
          usedBy={usedBy(template.id)}
          canEdit={canEdit}
          onEdit={() => setEditing({ id: template.id, name: template.name, metrics: template.metrics })}
          onDuplicate={() => setEditing({ id: null, name: `${template.name} (copy)`, metrics: template.metrics })}
          onDelete={() => setDeleting(template)}
        />
      ))}
    </section>
  )

  return (
    <PageContainer className="grid grid-cols-1 gap-5">
      <PageHeader
        icon={<FileSliders />}
        title="SNMP templates"
        description="What to poll from each kind of device. Built-in templates follow the standard MIBs and stay read-only; duplicate one to adapt it."
        actions={
          canEdit && (
            <Button size="sm" onClick={() => setEditing({ id: null, name: '', metrics: [] })}>
              <Plus data-icon="inline-start" />
              New template
            </Button>
          )
        }
      />
      {!canEdit && (
        <p className="flex items-start gap-2 rounded-xl bg-surface-2 px-4 py-3 text-dense text-muted-foreground ring-1 ring-border">
          <Lock className="mt-0.5 size-4 shrink-0" />
          Templates are installation-wide; changing them needs the “Manage network” permission held globally.
        </p>
      )}
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isLoading ? (
        <div className="grid gap-2">
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className="h-16 rounded-xl" />
          ))}
        </div>
      ) : (
        <>
          {templates.some((template) => !template.builtin) && section('Custom', templates.filter((template) => !template.builtin))}
          {section('Built-in', templates.filter((template) => template.builtin))}
        </>
      )}
      <TemplateSheet initial={editing} open={Boolean(editing)} onOpenChange={(open) => !open && setEditing(null)} />
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete “${deleting?.name}”?`}
        description="A template that SNMP devices still use can’t be deleted."
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </PageContainer>
  )
}
