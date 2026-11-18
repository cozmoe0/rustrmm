/* The typed report parameters shared by the run dialog and the schedule editor. */
import { useQuery } from '@tanstack/react-query'
import { CalendarRange, Info, Plus } from 'lucide-react'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { SimpleSelect } from '@/components/common/simple-select'
import { ListInput } from '@/features/automation/list-input'
import { SEGMENTED } from '@/features/automation/styles'
import { clientsQuery, sitesQuery, softwareQuery } from '@/lib/api/queries'
import type { ReportTypeInfo } from '@/lib/api/types'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { ALERT_SEVERITIES, PERIOD_PRESETS, acceptsParam, customRangeError, type PeriodPreset, type ReportForm } from '@/lib/reports/params'
import { cn } from '@/lib/utils'

const ACTION_PREFIXES = ['auth.', 'user.', 'role.', 'script.', 'job.', 'patch.', 'secret.', 'ticket.', 'settings.', 'api_token.']

export function ReportParamsForm({
  type,
  form,
  onChange,
  withPeriod = true,
  idPrefix = 'report',
}: {
  type: ReportTypeInfo | undefined
  form: ReportForm
  onChange: (form: ReportForm) => void
  withPeriod?: boolean
  idPrefix?: string
}) {
  const me = useMe()
  const { data: clients = [] } = useQuery(clientsQuery())
  const { data: sites = [] } = useQuery({ ...sitesQuery(form.clientId ?? undefined), enabled: Boolean(form.clientId) })
  const wantsProducts = acceptsParam(type, 'products')
  const { data: topProducts = [] } = useQuery({
    ...softwareQuery({ client_id: form.clientId ?? undefined }),
    enabled: wantsProducts && hasPermission(me, PERMISSIONS.softwareView),
    meta: { silent: true },
  })
  const set = (patch: Partial<ReportForm>) => onChange({ ...form, ...patch })
  const rangeError = withPeriod && form.period === 'custom' ? customRangeError(form.customFrom, form.customTo) : null
  const suggestions = topProducts
    .map((product) => product.name)
    .filter((name) => !form.products.includes(name))
    .slice(0, 6)

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-client`}>Client</FieldLabel>
          <SimpleSelect
            id={`${idPrefix}-client`}
            value={form.clientId ?? ''}
            onValueChange={(value) => set({ clientId: value || null, siteId: null })}
            options={[{ value: '', label: 'All clients' }, ...clients.map((client) => ({ value: client.id, label: client.name }))]}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-site`}>Site</FieldLabel>
          <SimpleSelect
            id={`${idPrefix}-site`}
            value={form.siteId ?? ''}
            disabled={!form.clientId}
            onValueChange={(value) => set({ siteId: value || null })}
            options={[{ value: '', label: form.clientId ? 'All sites' : 'Choose a client first' }, ...sites.map((site) => ({ value: site.id, label: site.name }))]}
          />
        </Field>
      </div>

      {withPeriod ? (
        <Field data-invalid={Boolean(rangeError) || undefined}>
          <FieldLabel htmlFor={`${idPrefix}-period`}>Period</FieldLabel>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:items-center">
            <SimpleSelect id={`${idPrefix}-period`} value={form.period} onValueChange={(value) => set({ period: value as PeriodPreset })} options={PERIOD_PRESETS.map((preset) => ({ value: preset.value, label: preset.label }))} />
            {form.period === 'custom' && (
              <div className="flex min-w-0 items-center gap-2">
                <Input type="date" aria-label="From" value={form.customFrom} max={form.customTo} onChange={(event) => set({ customFrom: event.target.value })} className="min-w-0 flex-1" aria-invalid={Boolean(rangeError) || undefined} />
                <span className="text-subtle-foreground">→</span>
                <Input type="date" aria-label="To" value={form.customTo} min={form.customFrom} onChange={(event) => set({ customTo: event.target.value })} className="min-w-0 flex-1" aria-invalid={Boolean(rangeError) || undefined} />
              </div>
            )}
          </div>
          {rangeError ? <FieldError>{rangeError}</FieldError> : <FieldDescription>Calendar periods use your local time; “this month” and “this quarter” end now.</FieldDescription>}
        </Field>
      ) : (
        <p className="flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2 text-dense text-muted-foreground ring-1 ring-border">
          <CalendarRange className="mt-0.5 size-4 shrink-0 text-subtle-foreground" />
          Each scheduled run covers the 30 days before it runs.
        </p>
      )}

      {wantsProducts && (
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-products`}>Licence count for products</FieldLabel>
          <ListInput id={`${idPrefix}-products`} value={form.products} onChange={(products) => set({ products })} placeholder="Type a product name and press Enter" max={50} />
          {suggestions.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-micro text-subtle-foreground">Most installed:</span>
              {suggestions.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => set({ products: [...form.products, name] })}
                  className="inline-flex h-6 max-w-56 items-center gap-1 rounded-md px-1.5 text-micro text-muted-foreground ring-1 ring-border hover:bg-surface-3 hover:text-foreground"
                >
                  <Plus className="size-3 shrink-0" />
                  <span className="truncate">{name}</span>
                </button>
              ))}
            </div>
          )}
          <FieldDescription>Optional: adds a per-client licence table for these products (names are matched after normalisation).</FieldDescription>
        </Field>
      )}

      {acceptsParam(type, 'severity') && (
        <Field>
          <FieldLabel>Severity</FieldLabel>
          <ToggleGroup
            value={[form.severity ?? 'any']}
            onValueChange={(next: string[]) => next[0] && set({ severity: next[0] === 'any' ? null : next[0] })}
            variant="outline"
            spacing={0}
            size="sm"
            className={cn('w-fit', SEGMENTED)}
            aria-label="Severity"
          >
            <ToggleGroupItem value="any" className="px-3">
              Any
            </ToggleGroupItem>
            {ALERT_SEVERITIES.map((severity) => (
              <ToggleGroupItem key={severity} value={severity} className="px-3 capitalize">
                {severity}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>
      )}

      {(acceptsParam(type, 'action') || acceptsParam(type, 'actor')) && (
        <div className="grid gap-4 sm:grid-cols-2">
          {acceptsParam(type, 'action') && (
            <Field>
              <FieldLabel htmlFor={`${idPrefix}-action`}>Action prefix</FieldLabel>
              <Input id={`${idPrefix}-action`} className="font-mono text-[12.5px]" value={form.action} onChange={(event) => set({ action: event.target.value })} placeholder="e.g. auth. or script.run" spellCheck={false} />
              <div className="flex flex-wrap gap-1">
                {ACTION_PREFIXES.map((prefix) => (
                  <button
                    key={prefix}
                    type="button"
                    aria-pressed={form.action === prefix}
                    onClick={() => set({ action: form.action === prefix ? '' : prefix })}
                    className={cn('h-5 rounded-[5px] px-1.5 font-mono text-[10.5px] text-muted-foreground ring-1 ring-border hover:bg-surface-3', form.action === prefix && 'bg-primary/10 text-primary ring-primary/30')}
                  >
                    {prefix}
                  </button>
                ))}
              </div>
            </Field>
          )}
          {acceptsParam(type, 'actor') && (
            <Field>
              <FieldLabel htmlFor={`${idPrefix}-actor`}>Actor</FieldLabel>
              <Input id={`${idPrefix}-actor`} value={form.actor} onChange={(event) => set({ actor: event.target.value })} placeholder="A user id or part of a name" />
              <FieldDescription>Installation-wide entries need the audit permission held globally.</FieldDescription>
            </Field>
          )}
        </div>
      )}

      {type && !type.parameters.some((param) => !['client_id', 'site_id', 'from', 'to'].includes(param.name)) && (
        <p className="flex items-center gap-1.5 text-micro text-subtle-foreground">
          <Info className="size-3.5" />
          Rows are limited to what you can see; this report takes no other options.
        </p>
      )}
    </div>
  )
}
