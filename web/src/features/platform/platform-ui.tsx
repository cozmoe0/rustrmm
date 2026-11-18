/* Shared pieces for the Phase 11 settings screens. */
import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { CopyButton } from '@/components/common/copy-button'
import { clientsQuery } from '@/lib/api/queries'
import { isApiError } from '@/lib/api/errors'
import { cn } from '@/lib/utils'

/** A read-only value with a copy button (redirect URIs, signing thumbprints, headers). */
export function CopyField({ value, label, className, mono = true }: { value: string; label: string; className?: string; mono?: boolean }) {
  return (
    <div className={cn('flex min-w-0 items-center gap-1 rounded-md bg-surface-3 py-1 pr-1 pl-2.5 ring-1 ring-border', className)}>
      <code className={cn('min-w-0 flex-1 truncate text-[12px]', mono ? 'font-mono' : 'font-sans')} title={value}>
        {value}
      </code>
      <CopyButton value={value} label={label} />
    </div>
  )
}

/** A titled settings card. */
export function SettingsCard({ title, description, icon, actions, children, className }: { title: ReactNode; description?: ReactNode; icon?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <section className={cn('overflow-hidden rounded-xl bg-card shadow-card', className)}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-start gap-2.5">
          {icon && <span className="mt-0.5 text-subtle-foreground [&_svg]:size-4">{icon}</span>}
          <div className="min-w-0">
            <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
            {description && <p className="mt-0.5 text-dense text-muted-foreground">{description}</p>}
          </div>
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </header>
      {children}
    </section>
  )
}

/** Shown when a read needs re-authentication and the user dismissed the step-up dialog. */
export function StepUpGate({ error, onRetry, what }: { error: unknown; onRetry: () => void; what: string }) {
  if (!(isApiError(error) && error.code === 'step_up_required')) return null
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border-strong px-6 py-10 text-center">
      <ShieldAlert className="size-6 text-warning" />
      <div>
        <p className="font-medium">Verify it’s you to view {what}</p>
        <p className="mt-1 text-dense text-muted-foreground">These settings control who can sign in, so even reading them needs a fresh second factor.</p>
      </div>
      <Button size="sm" onClick={onRetry}>
        Verify and show
      </Button>
    </div>
  )
}

/** Choose all clients (null) or a specific list. */
export function ClientScopePicker({ value, onChange, allLabel = 'Every client', allDescription, idPrefix }: { value: string[] | null; onChange: (value: string[] | null) => void; allLabel?: string; allDescription?: string; idPrefix: string }) {
  const { data: clients = [] } = useQuery(clientsQuery())
  const [filter, setFilter] = useState('')
  const needle = filter.trim().toLowerCase()
  const shown = clients.filter((client) => !needle || client.name.toLowerCase().includes(needle))
  const specific = value !== null
  return (
    <div className="grid gap-2">
      <div role="radiogroup" aria-label="Client scope" className="grid gap-2 sm:grid-cols-2">
        {[
          { key: 'all', label: allLabel, description: allDescription ?? 'Including clients added later.', active: !specific, onSelect: () => onChange(null) },
          { key: 'some', label: 'Specific clients', description: specific ? `${value.length} selected` : 'Pick one or more clients.', active: specific, onSelect: () => onChange(value ?? []) },
        ].map((option) => (
          <button
            key={option.key}
            type="button"
            role="radio"
            aria-checked={option.active}
            onClick={option.onSelect}
            className={cn('rounded-lg p-2.5 text-left ring-1 ring-border outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring', option.active && 'bg-primary/[0.06] ring-primary/40')}
          >
            <span className="block text-dense font-medium">{option.label}</span>
            <span className="block text-micro text-muted-foreground">{option.description}</span>
          </button>
        ))}
      </div>
      {specific && (
        <div className="rounded-lg ring-1 ring-border">
          {clients.length > 6 && (
            <div className="relative border-b border-border p-1.5">
              <Search className="pointer-events-none absolute top-1/2 left-3.5 size-3.5 -translate-y-1/2 text-subtle-foreground" />
              <Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter clients…" aria-label="Filter clients" className="h-7 border-0 pl-7 shadow-none" />
            </div>
          )}
          <ul className="max-h-48 overflow-y-auto p-1">
            {shown.map((client) => {
              const id = `${idPrefix}-client-${client.id}`
              const checked = value.includes(client.id)
              return (
                <li key={client.id}>
                  <Label htmlFor={id} className="flex h-8 items-center gap-2.5 rounded-md px-2 text-dense font-normal hover:bg-surface-2">
                    <Checkbox id={id} checked={checked} onCheckedChange={() => onChange(checked ? value.filter((entry) => entry !== client.id) : [...value, client.id])} />
                    <span className="truncate">{client.name}</span>
                  </Label>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

/** A switch row with a label and explanation. */
export function ToggleRow({ title, description, control, tone }: { title: ReactNode; description?: ReactNode; control: ReactNode; tone?: 'warning' }) {
  return (
    <div className={cn('flex items-start justify-between gap-4 rounded-lg px-3 py-2.5 ring-1 ring-border', tone === 'warning' && 'bg-warning/[0.05] ring-warning/25')}>
      <div className="min-w-0">
        <div className="text-dense font-medium">{title}</div>
        {description && <div className="mt-0.5 text-micro text-muted-foreground">{description}</div>}
      </div>
      <div className="shrink-0 pt-0.5">{control}</div>
    </div>
  )
}
