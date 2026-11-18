import { useQuery } from '@tanstack/react-query'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SimpleSelect } from '@/components/common/simple-select'
import { clientsQuery, rolesQuery, sitesQuery } from '@/lib/api/queries'
import type { AssignmentInput, ScopeType } from '@/lib/api/types'

/** Edits a user's role assignments: each row is a role plus where it applies. */
export function AssignmentBuilder({
  value,
  onChange,
  disabled,
}: {
  value: AssignmentInput[]
  onChange: (value: AssignmentInput[]) => void
  disabled?: boolean
}) {
  const { data: roles = [] } = useQuery(rolesQuery)
  const { data: clients = [] } = useQuery(clientsQuery())
  const { data: sites = [] } = useQuery(sitesQuery())

  const clientName = (id: string) => clients.find((client) => client.id === id)?.name ?? 'Unknown client'

  function update(index: number, patch: Partial<AssignmentInput>) {
    onChange(value.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)))
  }

  function add() {
    const fallback = roles.find((role) => role.name === 'Technician') ?? roles[0]
    if (fallback) onChange([...value, { role_id: fallback.id, scope_type: 'global', scope_id: null }])
  }

  return (
    <div className="grid gap-2">
      {value.length === 0 && (
        <p className="rounded-lg border border-dashed border-border-strong px-3 py-4 text-center text-dense text-muted-foreground">
          No roles yet — this user won&apos;t be able to see anything.
        </p>
      )}
      {value.map((row, index) => (
        <div
          key={index}
          className="grid grid-cols-[1fr_auto] gap-2 rounded-lg bg-surface-2/70 p-2 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,0.9fr)_minmax(0,1.4fr)_auto]"
        >
          <SimpleSelect
            ariaLabel="Role"
            value={row.role_id}
            disabled={disabled}
            onValueChange={(role_id) => update(index, { role_id })}
            options={roles.map((role) => ({ value: role.id, label: role.name, group: role.builtin ? 'Built-in' : 'Custom' }))}
          />
          <SimpleSelect
            ariaLabel="Scope"
            value={row.scope_type}
            disabled={disabled}
            className="max-sm:order-3"
            onValueChange={(scope_type) => update(index, { scope_type: scope_type as ScopeType, scope_id: null })}
            options={[
              { value: 'global', label: 'All clients' },
              { value: 'client', label: 'One client' },
              { value: 'site', label: 'One site' },
            ]}
          />
          {row.scope_type === 'global' ? (
            <div className="flex h-(--control-h) items-center px-2 text-dense text-muted-foreground max-sm:order-4 max-sm:col-span-2">
              Applies everywhere
            </div>
          ) : (
            <SimpleSelect
              ariaLabel={row.scope_type === 'client' ? 'Client' : 'Site'}
              value={row.scope_id}
              disabled={disabled}
              className="max-sm:order-4 max-sm:col-span-2"
              placeholder={row.scope_type === 'client' ? 'Choose a client' : 'Choose a site'}
              ariaInvalid={!row.scope_id}
              onValueChange={(scope_id) => update(index, { scope_id })}
              options={
                row.scope_type === 'client'
                  ? clients.map((client) => ({ value: client.id, label: client.name }))
                  : sites.map((site) => ({ value: site.id, label: site.name, group: clientName(site.client_id) }))
              }
            />
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Remove assignment"
            disabled={disabled}
            className="max-sm:order-2"
            onClick={() => onChange(value.filter((_, rowIndex) => rowIndex !== index))}
          >
            <X />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={add} disabled={disabled}>
        <Plus data-icon="inline-start" />
        Add role
      </Button>
    </div>
  )
}
