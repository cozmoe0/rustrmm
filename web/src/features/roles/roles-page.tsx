import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Lock, Plus, Shield, Trash, Users } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { ErrorState } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { rolesApi } from '@/lib/api/endpoints'
import { keys, permissionsQuery, rolesQuery } from '@/lib/api/queries'
import type { Permission, Risk, Role } from '@/lib/api/types'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'

const RISK: Record<Risk, { label: string; variant: 'success' | 'warning' | 'critical' }> = {
  low: { label: 'Low risk', variant: 'success' },
  medium: { label: 'Medium risk', variant: 'warning' },
  high: { label: 'High risk', variant: 'critical' },
}

interface Draft {
  id: string | null
  name: string
  description: string
  permissions: Set<string>
}

function draftFrom(role: Role | null, copy = false): Draft {
  return {
    id: copy ? null : (role?.id ?? null),
    name: role ? (copy ? `${role.name} (copy)` : role.name) : 'New role',
    description: role?.description ?? '',
    permissions: new Set(role?.permissions ?? []),
  }
}

function PermissionMatrix({
  catalog,
  selected,
  readOnly,
  onToggle,
  onToggleGroup,
}: {
  catalog: Permission[]
  selected: Set<string>
  readOnly: boolean
  onToggle: (key: string) => void
  onToggleGroup: (keys: string[], value: boolean) => void
}) {
  const groups = useMemo(() => {
    const map = new Map<string, Permission[]>()
    for (const permission of catalog) map.set(permission.group, [...(map.get(permission.group) ?? []), permission])
    return [...map.entries()]
  }, [catalog])

  return (
    <div className="grid gap-4">
      {groups.map(([group, permissions]) => {
        const keysInGroup = permissions.map((permission) => permission.key)
        const count = keysInGroup.filter((key) => selected.has(key)).length
        const all = count === keysInGroup.length
        return (
          <section key={group} className="overflow-hidden rounded-lg ring-1 ring-border">
            <header className="flex items-center gap-3 bg-surface-2/80 px-3 py-2">
              <Checkbox
                aria-label={`All ${group} permissions`}
                checked={all}
                indeterminate={count > 0 && !all}
                disabled={readOnly}
                onCheckedChange={(value) => onToggleGroup(keysInGroup, value === true)}
              />
              <h3 className="text-dense font-semibold">{group}</h3>
              <span className="tabular ml-auto text-micro text-subtle-foreground">
                {count}/{keysInGroup.length}
              </span>
            </header>
            <ul className="divide-y divide-border">
              {permissions.map((permission) => (
                <li key={permission.key}>
                  <label
                    className={cn(
                      'flex items-start gap-3 px-3 py-2.5',
                      !readOnly && 'cursor-pointer hover:bg-surface-2/50',
                    )}
                  >
                    <Checkbox
                      className="mt-0.5"
                      checked={selected.has(permission.key)}
                      disabled={readOnly}
                      onCheckedChange={() => onToggle(permission.key)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-dense font-medium">{permission.label}</span>
                        <code className="font-mono text-[10.5px] text-subtle-foreground">{permission.key}</code>
                      </span>
                      <span className="block text-micro text-muted-foreground">{permission.description}</span>
                    </span>
                    <Badge variant={RISK[permission.risk].variant}>{RISK[permission.risk].label}</Badge>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

export function RolesPage() {
  useTitle('Roles & permissions')
  const me = useMe()
  const queryClient = useQueryClient()
  const canManage = hasPermission(me, PERMISSIONS.rolesManage)
  const { data: roles, isLoading, error, refetch } = useQuery(rolesQuery)
  const { data: catalog = [] } = useQuery(permissionsQuery)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  /** Unsaved edits for the role being shown; null means "show the saved role as-is". */
  const [edits, setEdits] = useState<Draft | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const selected = creating ? null : (roles?.find((role) => role.id === selectedId) ?? roles?.[0] ?? null)
  const draft = edits ?? (creating ? draftFrom(null) : selected ? draftFrom(selected) : null)
  const readOnly = !canManage || Boolean(selected?.builtin)
  const dirty = creating || edits !== null

  function select(role: Role) {
    setCreating(false)
    setSelectedId(role.id)
    setEdits(null)
  }

  const save = useMutation({
    mutationFn: (value: Draft) => {
      const body = { name: value.name.trim(), description: value.description.trim(), permissions: [...value.permissions] }
      return value.id ? rolesApi.update(value.id, body) : rolesApi.create(body)
    },
    meta: { successMessage: 'Role saved' },
    onSuccess: (role) => {
      void queryClient.invalidateQueries({ queryKey: keys.roles })
      select(role)
    },
  })

  const remove = useMutation({
    mutationFn: (id: string) => rolesApi.remove(id),
    meta: { successMessage: 'Role deleted' },
    onSuccess: () => {
      setConfirmDelete(false)
      setSelectedId(null)
      setEdits(null)
      void queryClient.invalidateQueries({ queryKey: keys.roles })
    },
  })

  function update(patch: Partial<Draft>) {
    if (draft) setEdits({ ...draft, ...patch })
  }

  function toggle(key: string) {
    if (!draft) return
    const next = new Set(draft.permissions)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    update({ permissions: next })
  }

  function toggleGroup(keysInGroup: string[], value: boolean) {
    if (!draft) return
    const next = new Set(draft.permissions)
    keysInGroup.forEach((key) => (value ? next.add(key) : next.delete(key)))
    update({ permissions: next })
  }

  return (
    <PageContainer className="grid gap-5">
      <PageHeader
        eyebrow="Settings"
        title="Roles & permissions"
        description="Roles bundle permissions. Assign them to users globally, per client, or per site."
        actions={
          canManage && (
            <Button
              onClick={() => {
                setCreating(true)
                setEdits(null)
              }}
            >
              <Plus data-icon="inline-start" />
              New role
            </Button>
          )
        }
      />

      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
          <Card className="h-fit gap-0 py-1.5">
            <ul role="listbox" aria-label="Roles" className="grid gap-px px-1.5">
              {isLoading &&
                Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="m-1 h-12" />)}
              {roles?.map((role) => {
                const active = !creating && selected?.id === role.id
                return (
                  <li key={role.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={active}
                      onClick={() => select(role)}
                      className={cn(
                        'flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left outline-none transition-colors hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-ring',
                        active && 'bg-surface-3 shadow-[inset_2px_0_0_var(--primary)]',
                      )}
                    >
                      {role.builtin ? (
                        <Lock className="mt-0.5 size-3.5 shrink-0 text-subtle-foreground" />
                      ) : (
                        <Shield className="mt-0.5 size-3.5 shrink-0 text-primary" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-dense font-medium">{role.name}</span>
                        <span className="block text-micro text-subtle-foreground">
                          {role.permissions.length} permissions
                        </span>
                      </span>
                      <span className="tabular mt-0.5 flex items-center gap-1 text-micro text-subtle-foreground">
                        <Users className="size-3" />
                        {role.user_count}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </Card>

          {draft && (
            <Card className="gap-0 py-0">
              <div className="flex flex-col gap-4 border-b border-border p-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="grid flex-1 gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="role-name" className="text-micro text-subtle-foreground">
                      Role name
                    </Label>
                    <Input
                      id="role-name"
                      value={draft.name}
                      disabled={readOnly}
                      onChange={(event) => update({ name: event.target.value })}
                      className="max-w-sm text-[15px] font-semibold"
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="role-description" className="text-micro text-subtle-foreground">
                      Description
                    </Label>
                    <Textarea
                      id="role-description"
                      rows={2}
                      value={draft.description}
                      disabled={readOnly}
                      onChange={(event) => update({ description: event.target.value })}
                      className="max-w-xl"
                    />
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {selected && canManage && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setCreating(true)
                        setEdits(draftFrom(selected, true))
                      }}
                    >
                      <Copy data-icon="inline-start" />
                      Duplicate
                    </Button>
                  )}
                  {canManage && selected && !selected.builtin && (
                    <Button variant="destructive-soft" size="sm" onClick={() => setConfirmDelete(true)}>
                      <Trash data-icon="inline-start" />
                      Delete
                    </Button>
                  )}
                </div>
              </div>

              {selected?.builtin && (
                <div className="flex items-center gap-2 border-b border-border bg-surface-2/60 px-4 py-2.5 text-dense text-muted-foreground">
                  <Lock className="size-3.5" />
                  Built-in roles are read-only. Duplicate one to customise it.
                </div>
              )}

              <div className="p-4">
                <PermissionMatrix
                  catalog={catalog}
                  selected={draft.permissions}
                  readOnly={readOnly}
                  onToggle={toggle}
                  onToggleGroup={toggleGroup}
                />
              </div>

              {!readOnly && (
                <div className="sticky bottom-0 flex items-center justify-between gap-3 border-t border-border bg-card/95 px-4 py-3 backdrop-blur">
                  <span className="text-dense text-muted-foreground">
                    {draft.permissions.size} of {catalog.length} permissions selected
                  </span>
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      disabled={!dirty}
                      onClick={() => {
                        setEdits(null)
                        setCreating(false)
                      }}
                    >
                      Discard
                    </Button>
                    <Button
                      disabled={!dirty || draft.name.trim().length < 2 || save.isPending}
                      onClick={() => save.mutate(draft)}
                    >
                      {save.isPending && <Spinner data-icon="inline-start" />}
                      {draft.id ? 'Save role' : 'Create role'}
                    </Button>
                  </div>
                </div>
              )}
            </Card>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${selected?.name}?`}
        description="Roles that are still assigned to users cannot be deleted."
        pending={remove.isPending}
        onConfirm={() => selected && remove.mutate(selected.id)}
      />
    </PageContainer>
  )
}
