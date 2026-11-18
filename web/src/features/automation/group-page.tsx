import { useEffect, useMemo, useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { ArrowLeft, Ellipsis, Hand, Pencil, Play, Plus, Save, Sparkles, Trash, Undo2, UserMinus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { DataTable } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, RelativeTime } from '@/components/common/misc'
import { OsIcon } from '@/components/common/os-icon'
import { PageContainer } from '@/components/common/page-header'
import { StatusDot } from '@/components/common/status-dot'
import { groupsApi } from '@/lib/api/endpoints'
import {
  clientsQuery,
  customFieldsQuery,
  devicesQuery,
  groupMembersQuery,
  groupsQuery,
  keys,
  sitesQuery,
} from '@/lib/api/queries'
import type { Device, DeviceGroup, RuleDocument } from '@/lib/api/types'
import { describeRules, ruleFieldCatalog, validateRules } from '@/lib/automation/rules'
import { deviceName } from '@/lib/devices'
import { formatNumber } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { DevicePicker } from './device-picker'
import { GroupKindBadge } from './groups-page'
import { openRunDialog } from './run-dialog-store'
import { RuleBuilder } from './rule-builder'
import { UnsavedChangesGuard } from './unsaved-guard'

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(timer)
  }, [value, delay])
  return debounced
}

function DeviceRow({ device }: { device: Device }) {
  return (
    <Link
      to="/devices/$deviceId"
      params={{ deviceId: device.id }}
      className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-dense outline-none hover:bg-surface-3/60 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <StatusDot tone={device.online ? 'live' : 'offline'} label={device.online ? 'Online' : 'Offline'} />
      <OsIcon family={device.os_family} />
      <span className="min-w-0 flex-1 truncate font-medium">{deviceName(device)}</span>
      <span className="hidden max-w-[45%] truncate text-micro text-subtle-foreground sm:inline">
        {device.client_name}
      </span>
    </Link>
  )
}

function DynamicEditor({ group, canManage }: { group: DeviceGroup; canManage: boolean }) {
  const queryClient = useQueryClient()
  const { data: customFields = [] } = useQuery(customFieldsQuery('device'))
  const { data: clients = [] } = useQuery(clientsQuery())
  const { data: sites = [] } = useQuery(sitesQuery())
  const fields = useMemo(() => ruleFieldCatalog(customFields), [customFields])
  const base = group.rules ?? { match: 'all' as const, conditions: [] }
  const [edit, setEdit] = useState<{ for: string; rules: RuleDocument } | null>(null)
  const rules = edit && edit.for === group.id ? edit.rules : base
  const dirty = JSON.stringify(rules) !== JSON.stringify(base)
  const issues = validateRules(rules, fields)
  const debounced = useDebounced(rules, 350)
  const debouncedValid = validateRules(debounced, fields).length === 0
  const preview = useQuery({
    queryKey: ['groups', 'preview', group.client_id ?? 'all', JSON.stringify(debounced)],
    queryFn: () => groupsApi.preview(debounced, group.client_id),
    enabled: debouncedValid,
    placeholderData: keepPreviousData,
    meta: { silent: true },
  })
  const lookup = (field: { entity?: 'client' | 'site' }, id: string) =>
    field.entity === 'client'
      ? clients.find((client) => client.id === id)?.name
      : sites.find((site) => site.id === id)?.name

  const save = useMutation({
    mutationFn: () =>
      groupsApi.update(group.id, {
        name: group.name,
        description: group.description,
        kind: group.kind,
        client_id: group.client_id,
        rules,
      }),
    meta: { successMessage: 'Rules saved' },
    onSuccess: () => {
      setEdit(null)
      void queryClient.invalidateQueries({ queryKey: keys.groups })
    },
  })

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <UnsavedChangesGuard when={dirty && !save.isPending} what="rule changes" />
      <div className="grid min-w-0 grid-cols-1 content-start gap-3">
        <div className="rounded-xl bg-surface-2/60 px-4 py-3 text-dense ring-1 ring-border">
          <span className="text-muted-foreground">Devices where </span>
          <span className="font-medium">{describeRules(rules, fields, lookup)}</span>
        </div>
        <RuleBuilder
          value={rules}
          onChange={(next) => setEdit({ for: group.id, rules: next })}
          fields={fields}
          issues={issues}
          clients={clients}
          sites={sites}
          readOnly={!canManage}
        />
        {dirty && canManage && (
          <div className="sticky bottom-4 z-10 flex flex-wrap items-center gap-3 rounded-xl bg-popover p-3 shadow-popover ring-1 ring-border-strong">
            <span className="size-2 rounded-full bg-warning" aria-hidden="true" />
            <span className="flex-1 text-dense font-medium">Unsaved rule changes</span>
            <Button variant="ghost" onClick={() => setEdit(null)} disabled={save.isPending}>
              <Undo2 data-icon="inline-start" />
              Discard
            </Button>
            <Button
              onClick={() => (issues.length ? toast.error(issues[0].message) : save.mutate())}
              disabled={save.isPending}
            >
              {save.isPending ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}
              Save rules
            </Button>
          </div>
        )}
      </div>
      <aside className="grid grid-cols-1 content-start gap-3 xl:sticky xl:top-4 xl:self-start">
        <div className="overflow-hidden rounded-xl bg-card shadow-card">
          <div className="flex items-end justify-between gap-3 border-b border-border px-4 py-3">
            <div>
              <div className="eyebrow">{dirty ? 'Live preview' : 'Members'}</div>
              <div className="font-display tabular mt-1 text-3xl leading-none font-semibold tracking-tight">
                {issues.length ? (
                  '—'
                ) : preview.data ? (
                  formatNumber(preview.data.count)
                ) : (
                  <Skeleton className="h-7 w-12" />
                )}
              </div>
              <div className="mt-1 text-micro text-muted-foreground">
                {issues.length
                  ? 'Fix the rules to preview'
                  : `matching ${preview.data?.count === 1 ? 'device' : 'devices'}${group.client_name ? ` at ${group.client_name}` : ''}`}
              </div>
            </div>
            {preview.isFetching && <Spinner className="text-muted-foreground" />}
          </div>
          <div
            className={cn(
              'grid max-h-[460px] gap-px overflow-y-auto p-1.5 transition-opacity',
              (preview.isFetching || issues.length > 0) && 'opacity-60',
            )}
          >
            {preview.data?.items.map((device) => (
              <DeviceRow key={device.id} device={device} />
            ))}
            {preview.data && preview.data.count === 0 && (
              <p className="px-3 py-6 text-center text-dense text-muted-foreground">
                No device matches these rules right now.
              </p>
            )}
            {preview.data && preview.data.count > preview.data.items.length && (
              <p className="px-3 py-2 text-center text-micro text-subtle-foreground">
                and {formatNumber(preview.data.count - preview.data.items.length)} more…
              </p>
            )}
          </div>
        </div>
        <p className="px-1 text-micro text-subtle-foreground">
          Dynamic groups are evaluated whenever they’re used — listing members, resolving job targets or applying
          policies.
        </p>
      </aside>
    </div>
  )
}

function StaticMembers({ group, canManage }: { group: DeviceGroup; canManage: boolean }) {
  const queryClient = useQueryClient()
  const { data: members = [], isLoading } = useQuery(groupMembersQuery(group.id))
  const { data: devices = [] } = useQuery(devicesQuery(group.client_id ? { client_id: group.client_id } : {}))
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [adding, setAdding] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const memberIds = useMemo(() => new Set(members.map((device) => device.id)), [members])

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: keys.groupMembers(group.id) })
    void queryClient.invalidateQueries({ queryKey: keys.groups })
  }
  const add = useMutation({
    mutationFn: () => groupsApi.addMembers(group.id, picked),
    onSuccess: () => {
      toast.success(`Added ${picked.length} ${picked.length === 1 ? 'device' : 'devices'}`)
      setAdding(false)
      setPicked([])
      invalidate()
    },
  })
  const remove = useMutation({
    mutationFn: (ids: string[]) => groupsApi.removeMembers(group.id, ids),
    onSuccess: (_, ids) => {
      toast.success(`Removed ${ids.length} ${ids.length === 1 ? 'device' : 'devices'}`)
      setSelected(new Set())
      invalidate()
    },
  })

  const columns = useMemo<ColumnDef<Device>[]>(() => {
    const all = members.length > 0 && members.every((device) => selected.has(device.id))
    return [
      ...(canManage
        ? [
            {
              id: 'select',
              enableSorting: false,
              size: 40,
              meta: { className: 'w-10 pr-0', headerClassName: 'w-10 pr-0' },
              header: () => (
                <Checkbox
                  aria-label="Select all"
                  checked={all}
                  indeterminate={!all && selected.size > 0}
                  onCheckedChange={() => setSelected(all ? new Set() : new Set(members.map((device) => device.id)))}
                />
              ),
              cell: ({ row }: { row: { original: Device } }) => (
                <span className="flex" onClick={(event) => event.stopPropagation()}>
                  <Checkbox
                    aria-label={`Select ${row.original.hostname}`}
                    checked={selected.has(row.original.id)}
                    onCheckedChange={() =>
                      setSelected((prev) => {
                        const next = new Set(prev)
                        if (next.has(row.original.id)) next.delete(row.original.id)
                        else next.add(row.original.id)
                        return next
                      })
                    }
                  />
                </span>
              ),
            } as ColumnDef<Device>,
          ]
        : []),
      {
        id: 'device',
        accessorFn: (device) => deviceName(device).toLowerCase(),
        header: 'Device',
        cell: ({ row }) => (
          <span className="flex items-center gap-2.5">
            <StatusDot tone={row.original.online ? 'live' : 'offline'} />
            <OsIcon family={row.original.os_family} />
            <span className="max-w-60 truncate font-medium">{deviceName(row.original)}</span>
          </span>
        ),
      },
      {
        id: 'client',
        accessorFn: (device) => `${device.client_name} ${device.site_name}`,
        header: 'Client / site',
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {row.original.client_name} · {row.original.site_name}
          </span>
        ),
      },
      {
        id: 'os',
        accessorKey: 'os_name',
        header: 'OS',
        cell: ({ getValue }) => (
          <span className="block max-w-52 truncate text-muted-foreground">{getValue<string>()}</span>
        ),
      },
      {
        id: 'seen',
        accessorFn: (device) => (device.online ? 'z' : (device.last_seen_at ?? '')),
        header: 'Last seen',
        cell: ({ row }) =>
          row.original.online ? (
            <span className="text-live">Now</span>
          ) : (
            <RelativeTime value={row.original.last_seen_at} className="text-muted-foreground" />
          ),
      },
    ]
  }, [members, selected, canManage])

  return (
    <div className="grid grid-cols-1 gap-3">
      {canManage && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus data-icon="inline-start" />
            Add devices
          </Button>
          {selected.size > 0 && (
            <Button
              size="sm"
              variant="outline"
              disabled={remove.isPending}
              onClick={() => remove.mutate([...selected])}
            >
              {remove.isPending ? <Spinner data-icon="inline-start" /> : <UserMinus data-icon="inline-start" />}
              Remove {selected.size}
            </Button>
          )}
          <span className="tabular ml-auto text-dense text-muted-foreground">
            {formatNumber(members.length)} devices
          </span>
        </div>
      )}
      <DataTable
        data={members}
        columns={columns}
        loading={isLoading}
        getRowId={(device) => device.id}
        rowClassName={(device) => selected.has(device.id) && 'bg-primary/[0.05]'}
        caption={`Members of ${group.name}`}
        empty={
          <div className="p-6">
            <EmptyState
              compact
              illustration="devices"
              title="No devices yet"
              description="Add devices by hand. They stay in the group until you remove them."
            />
          </div>
        }
      />
      <Dialog
        open={adding}
        onOpenChange={(open) => {
          setAdding(open)
          if (!open) setPicked([])
        }}
      >
        <DialogContent className="sm:max-w-[640px]">
          <DialogHeader>
            <DialogTitle>Add devices to {group.name}</DialogTitle>
            <DialogDescription>
              {group.client_name
                ? `Only ${group.client_name} devices can join this group.`
                : 'Pick any managed device.'}
            </DialogDescription>
          </DialogHeader>
          <DevicePicker devices={devices} selected={picked} onChange={setPicked} exclude={memberIds} height={320} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button disabled={picked.length === 0 || add.isPending} onClick={() => add.mutate()}>
              {add.isPending && <Spinner data-icon="inline-start" />}
              Add {picked.length || ''} {picked.length === 1 ? 'device' : 'devices'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function EditGroupDialog({
  group,
  open,
  onOpenChange,
}: {
  group: DeviceGroup
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(group.name)
  const [description, setDescription] = useState(group.description)
  const save = useMutation({
    mutationFn: () =>
      groupsApi.update(group.id, {
        name: name.trim(),
        description: description.trim(),
        kind: group.kind,
        client_id: group.client_id,
        rules: group.rules,
      }),
    meta: { successMessage: 'Group updated' },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.groups })
      onOpenChange(false)
    },
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Edit group</DialogTitle>
        </DialogHeader>
        <form
          className="grid grid-cols-1 gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (name.trim()) save.mutate()
          }}
        >
          <Field data-invalid={!name.trim() || undefined}>
            <FieldLabel htmlFor="edit-group-name">Name</FieldLabel>
            <Input id="edit-group-name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
            <FieldError>{name.trim() ? null : 'Enter a name'}</FieldError>
          </Field>
          <Field>
            <FieldLabel htmlFor="edit-group-description">Description</FieldLabel>
            <Input
              id="edit-group-description"
              value={description}
              maxLength={200}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending && <Spinner data-icon="inline-start" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function GroupPage({ groupId }: { groupId: string }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const me = useMe()
  const { data: groups, isLoading, error, refetch } = useQuery(groupsQuery())
  const group = groups?.find((item) => item.id === groupId)
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  useTitle(group?.name)
  const canManage = hasPermission(me, PERMISSIONS.devicesManage)
  const canRun = hasPermission(me, PERMISSIONS.scriptsRun)

  const remove = useMutation({
    mutationFn: () => groupsApi.remove(groupId),
    onSuccess: () => {
      setDeleting(false)
      toast.success(`Deleted “${group?.name}”`)
      void queryClient.invalidateQueries({ queryKey: keys.groups })
      void navigate({ to: '/automation/groups' })
    },
    onError: () => setDeleting(false),
  })

  if (error)
    return (
      <PageContainer>
        <ErrorState error={error} onRetry={() => void refetch()} />
      </PageContainer>
    )
  if (isLoading)
    return (
      <PageContainer className="grid grid-cols-1 gap-4">
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </PageContainer>
    )
  if (!group) {
    return (
      <PageContainer>
        <EmptyState
          illustration="search"
          title="Group not found"
          description="It may have been deleted."
          actions={
            <Button variant="outline" render={<Link to="/automation/groups" />} nativeButton={false}>
              Back to groups
            </Button>
          }
        />
      </PageContainer>
    )
  }

  return (
    <PageContainer className="grid grid-cols-1 gap-5">
      <header className="grid grid-cols-1 gap-4">
        <Link
          to="/automation/groups"
          className="inline-flex w-fit items-center gap-1 text-dense text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Device groups
        </Link>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 items-start gap-3.5">
            <span
              className={cn(
                'flex size-10 shrink-0 items-center justify-center rounded-xl shadow-raised',
                group.kind === 'dynamic' ? 'bg-info/12 text-info' : 'bg-surface-2 text-muted-foreground',
              )}
            >
              {group.kind === 'dynamic' ? <Sparkles className="size-5" /> : <Hand className="size-5" />}
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="font-display truncate text-[22px] leading-tight font-semibold">{group.name}</h1>
                <GroupKindBadge kind={group.kind} />
              </div>
              <p className="mt-1 text-dense text-muted-foreground">
                {group.description || 'No description'} · {group.client_name ?? 'All clients'} ·{' '}
                <span className="tabular">{formatNumber(group.member_count)}</span>{' '}
                {group.member_count === 1 ? 'device' : 'devices'} · created by {group.created_by_name}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canRun && (
              <Button
                size="sm"
                disabled={group.member_count === 0}
                onClick={() => openRunDialog({ target: { type: 'group', ids: [group.id] } })}
              >
                <Play data-icon="inline-start" />
                Run script…
              </Button>
            )}
            {canManage && (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="outline" size="icon-sm" aria-label="More actions" />}>
                  <Ellipsis />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem onClick={() => setEditing(true)}>
                    <Pencil />
                    Rename…
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}>
                    <Trash />
                    Delete group…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      </header>

      {group.kind === 'dynamic' ? (
        <DynamicEditor group={group} canManage={canManage} />
      ) : (
        <StaticMembers group={group} canManage={canManage} />
      )}

      {editing && <EditGroupDialog group={group} open onOpenChange={setEditing} />}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete “${group.name}”?`}
        description="Groups used by a policy assignment or a scheduled job can't be deleted until they're unassigned."
        confirmLabel="Delete group"
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </PageContainer>
  )
}
