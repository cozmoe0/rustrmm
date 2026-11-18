/* The widget picker (all twelve widgets by category) and the per-widget settings dialog. */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Lock } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/common/simple-select'
import { clientsQuery, customFieldsQuery, sitesQuery } from '@/lib/api/queries'
import type { WidgetConfig, WidgetName } from '@/lib/api/types'
import { WIDGETS, WIDGET_BY_NAME, WIDGET_CATEGORIES, cleanConfig, configIssues } from '@/lib/dashboards/widgets'
import { hasPermission, useMe } from '@/lib/permissions'
import { cn } from '@/lib/utils'
import { WIDGET_ICON } from './widget-icons'


export function WidgetPicker({ open, onOpenChange, onPick, used, full }: { open: boolean; onOpenChange: (open: boolean) => void; onPick: (widget: WidgetName) => void; used: WidgetName[]; full: boolean }) {
  const me = useMe()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle>Add a widget</DialogTitle>
          <DialogDescription>{full ? 'This dashboard already holds 40 widgets, the most it can.' : 'Widgets you can’t see the data of are greyed out. Each widget can be scoped to one client in its settings.'}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-5">
          {WIDGET_CATEGORIES.map((category) => {
            const items = WIDGETS.filter((def) => def.category === category)
            return (
              <section key={category} className="grid gap-2">
                <h3 className="eyebrow">{category}</h3>
                <div className="grid gap-2 sm:grid-cols-2">
                  {items.map((def) => {
                    const Icon = WIDGET_ICON[def.name]
                    const allowed = hasPermission(me, def.permission)
                    const count = used.filter((name) => name === def.name).length
                    return (
                      <button
                        key={def.name}
                        type="button"
                        disabled={!allowed || full}
                        onClick={() => onPick(def.name)}
                        className="group flex min-w-0 items-start gap-3 rounded-lg p-3 text-left ring-1 ring-border outline-none transition-colors hover:bg-surface-2 hover:ring-primary/30 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-muted-foreground ring-1 ring-border group-hover:text-primary [&_svg]:size-4">
                          {allowed ? <Icon /> : <Lock />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5 text-dense font-medium">
                            {def.label}
                            {count > 0 && <Badge variant="secondary">On dashboard{count > 1 ? ` ×${count}` : ''}</Badge>}
                          </span>
                          <span className="mt-0.5 block text-micro text-muted-foreground">{def.description}</span>
                          <span className="mt-1 block font-mono text-[10.5px] text-subtle-foreground">
                            {def.defaultSize.w}×{def.defaultSize.h} · {def.permission}
                          </span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              </section>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function WidgetSettings({ widget, config, open, onOpenChange, onSave }: { widget: WidgetName | null; config: WidgetConfig; open: boolean; onOpenChange: (open: boolean) => void; onSave: (config: WidgetConfig) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">{open && widget && <SettingsForm key={widget} widget={widget} config={config} onCancel={() => onOpenChange(false)} onSave={onSave} />}</DialogContent>
    </Dialog>
  )
}

function SettingsForm({ widget, config, onCancel, onSave }: { widget: WidgetName; config: WidgetConfig; onCancel: () => void; onSave: (config: WidgetConfig) => void }) {
  const def = WIDGET_BY_NAME[widget]
  const [draft, setDraft] = useState<WidgetConfig>({ ...config, limit: config.limit ?? (def.settings.includes('limit') ? def.defaultLimit : undefined), days: config.days ?? (def.settings.includes('days') ? 7 : undefined) })
  const { data: clients = [] } = useQuery(clientsQuery())
  const { data: sites = [] } = useQuery({ ...sitesQuery(draft.client_id ?? undefined), enabled: Boolean(draft.client_id) })
  const { data: fields = [] } = useQuery({ ...customFieldsQuery('device'), enabled: def.settings.includes('field') })
  const issues = configIssues(widget, draft)
  const set = (patch: Partial<WidgetConfig>) => setDraft((prev) => ({ ...prev, ...patch }))
  const number = (value: string) => (value === '' ? null : Number(value))

  return (
    <form
      className="grid grid-cols-1 gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (Object.keys(issues).length === 0) onSave(cleanConfig(widget, draft))
      }}
    >
      <DialogHeader>
        <DialogTitle>{def.label} settings</DialogTitle>
        <DialogDescription>{def.description}</DialogDescription>
      </DialogHeader>
      <Field data-invalid={Boolean(issues.title) || undefined}>
        <FieldLabel htmlFor="widget-title">Title</FieldLabel>
        <Input id="widget-title" value={draft.title ?? ''} onChange={(event) => set({ title: event.target.value })} placeholder={def.label} />
        {issues.title && <FieldError>{issues.title}</FieldError>}
      </Field>
      {def.settings.includes('client') && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="widget-client">Client</FieldLabel>
            <SimpleSelect id="widget-client" value={draft.client_id ?? ''} onValueChange={(value) => set({ client_id: value || null, site_id: null })} options={[{ value: '', label: 'All clients' }, ...clients.map((client) => ({ value: client.id, label: client.name }))]} />
          </Field>
          <Field>
            <FieldLabel htmlFor="widget-site">Site</FieldLabel>
            <SimpleSelect id="widget-site" value={draft.site_id ?? ''} disabled={!draft.client_id} onValueChange={(value) => set({ site_id: value || null })} options={[{ value: '', label: draft.client_id ? 'All sites' : 'Choose a client' }, ...sites.map((site) => ({ value: site.id, label: site.name }))]} />
          </Field>
        </div>
      )}
      {(def.settings.includes('limit') || def.settings.includes('days')) && (
        <div className="grid gap-4 sm:grid-cols-2">
          {def.settings.includes('limit') && (
            <Field data-invalid={Boolean(issues.limit) || undefined}>
              <FieldLabel htmlFor="widget-limit">Items</FieldLabel>
              <Input id="widget-limit" type="number" min={1} max={100} inputMode="numeric" value={draft.limit ?? ''} onChange={(event) => set({ limit: number(event.target.value) })} />
              {issues.limit ? <FieldError>{issues.limit}</FieldError> : <FieldDescription>1–100</FieldDescription>}
            </Field>
          )}
          {def.settings.includes('days') && (
            <Field data-invalid={Boolean(issues.days) || undefined}>
              <FieldLabel htmlFor="widget-days">Look back (days)</FieldLabel>
              <Input id="widget-days" type="number" min={1} max={90} inputMode="numeric" value={draft.days ?? ''} onChange={(event) => set({ days: number(event.target.value) })} />
              {issues.days ? <FieldError>{issues.days}</FieldError> : <FieldDescription>1–90</FieldDescription>}
            </Field>
          )}
        </div>
      )}
      {def.settings.includes('field') && (
        <Field data-invalid={Boolean(issues.field) || undefined}>
          <FieldLabel htmlFor="widget-field">Device custom field</FieldLabel>
          <SimpleSelect id="widget-field" value={draft.field ?? null} onValueChange={(value) => set({ field: value })} placeholder="Choose a field…" options={fields.map((field) => ({ value: field.key, label: field.name }))} />
          {issues.field ? <FieldError>{issues.field}</FieldError> : <FieldDescription>Devices are grouped by the field’s value; “(not set)” is included.</FieldDescription>}
        </Field>
      )}
      {issues.size && <p className={cn('text-dense text-critical')}>{issues.size}</p>}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={Object.keys(issues).length > 0}>
          Apply
        </Button>
      </DialogFooter>
    </form>
  )
}
