import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { Boxes, Hand, Plus, Sparkles } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Can } from '@/components/common/can'
import { DataTable } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, RelativeTime } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/simple-select'
import { groupsApi } from '@/lib/api/endpoints'
import { clientsQuery, customFieldsQuery, groupsQuery, keys, sitesQuery } from '@/lib/api/queries'
import type { DeviceGroup, GroupKind } from '@/lib/api/types'
import { describeRules, ruleFieldCatalog } from '@/lib/automation/rules'
import { formatNumber } from '@/lib/format'
import { PERMISSIONS } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { SearchField } from '@/features/devices/remote-ui'

export function GroupKindBadge({ kind }: { kind: GroupKind }) {
  return kind === 'dynamic' ? (
    <Badge variant="info">
      <Sparkles />
      Dynamic
    </Badge>
  ) : (
    <Badge variant="secondary">
      <Hand />
      Static
    </Badge>
  )
}

export function NewGroupDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: clients = [] } = useQuery(clientsQuery())
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [kind, setKind] = useState<GroupKind>('dynamic')
  const [clientId, setClientId] = useState('all')
  const [attempted, setAttempted] = useState(false)
  const create = useMutation({
    mutationFn: () =>
      groupsApi.create({
        name: name.trim(),
        description: description.trim(),
        kind,
        client_id: clientId === 'all' ? null : clientId,
        rules:
          kind === 'dynamic'
            ? { match: 'all', conditions: [{ field: 'os_family', op: 'eq', value: 'windows' }] }
            : null,
      }),
    onSuccess: (group) => {
      void queryClient.invalidateQueries({ queryKey: keys.groups })
      onOpenChange(false)
      void navigate({ to: '/automation/groups/$groupId', params: { groupId: group.id } })
    },
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>New device group</DialogTitle>
          <DialogDescription>Groups are targets for jobs and policies.</DialogDescription>
        </DialogHeader>
        <form
          className="grid grid-cols-1 gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            setAttempted(true)
            if (!name.trim()) return
            create.mutate()
          }}
        >
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Group kind">
            {(
              [
                {
                  value: 'dynamic',
                  icon: Sparkles,
                  title: 'Dynamic',
                  text: 'Membership follows rules and updates itself.',
                },
                { value: 'static', icon: Hand, title: 'Static', text: 'You pick the devices by hand.' },
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={kind === option.value}
                onClick={() => setKind(option.value)}
                className={cn(
                  'grid gap-1.5 rounded-xl p-3 text-left ring-1 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  kind === option.value
                    ? 'bg-primary/[0.07] ring-primary/40'
                    : 'ring-border-strong hover:bg-surface-3/60',
                )}
              >
                <option.icon
                  className={cn('size-4', kind === option.value ? 'text-primary' : 'text-muted-foreground')}
                />
                <span className="text-dense font-medium">{option.title}</span>
                <span className="text-micro text-muted-foreground">{option.text}</span>
              </button>
            ))}
          </div>
          <Field data-invalid={Boolean(attempted && !name.trim()) || undefined}>
            <FieldLabel htmlFor="group-name">Name</FieldLabel>
            <Input
              id="group-name"
              value={name}
              maxLength={80}
              autoFocus
              placeholder="Windows servers"
              onChange={(event) => setName(event.target.value)}
            />
            <FieldError>{attempted && !name.trim() ? 'Enter a name' : null}</FieldError>
          </Field>
          <Field>
            <FieldLabel htmlFor="group-description">Description</FieldLabel>
            <Input
              id="group-description"
              value={description}
              maxLength={200}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="group-scope">Scope</FieldLabel>
            <SimpleSelect
              id="group-scope"
              value={clientId}
              onValueChange={setClientId}
              options={[
                { value: 'all', label: 'All clients' },
                ...clients.map((client) => ({ value: client.id, label: client.name })),
              ]}
            />
            <FieldDescription>A client-scoped group only ever contains that client’s devices.</FieldDescription>
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending && <Spinner data-icon="inline-start" />}
              Create group
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function GroupsPage({ createRequested }: { createRequested: boolean }) {
  useTitle('Device groups')
  const navigate = useNavigate()
  const { data, isLoading, error, refetch } = useQuery(groupsQuery())
  const { data: customFields = [] } = useQuery(customFieldsQuery('device'))
  const { data: clients = [] } = useQuery(clientsQuery())
  const { data: sites = [] } = useQuery(sitesQuery())
  const [creating, setCreating] = useState(false)
  const [query, setQuery] = useState('')
  const fields = useMemo(() => ruleFieldCatalog(customFields), [customFields])
  const lookup = useMemo(
    () => (field: { entity?: 'client' | 'site' }, id: string) =>
      field.entity === 'client'
        ? clients.find((client) => client.id === id)?.name
        : sites.find((site) => site.id === id)?.name,
    [clients, sites],
  )
  const needle = query.trim().toLowerCase()
  const rows = (data ?? []).filter(
    (group) =>
      !needle || `${group.name} ${group.description} ${group.client_name ?? ''}`.toLowerCase().includes(needle),
  )

  const columns = useMemo<ColumnDef<DeviceGroup>[]>(
    () => [
      {
        id: 'name',
        accessorFn: (group) => group.name.toLowerCase(),
        header: 'Group',
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              className={cn(
                'flex size-7 shrink-0 items-center justify-center rounded-md',
                row.original.kind === 'dynamic' ? 'bg-info/12 text-info' : 'bg-surface-3 text-muted-foreground',
              )}
            >
              {row.original.kind === 'dynamic' ? <Sparkles className="size-3.5" /> : <Hand className="size-3.5" />}
            </span>
            <div className="min-w-0 leading-tight">
              <div className="max-w-64 truncate font-medium">{row.original.name}</div>
              <div className="max-w-64 truncate text-[10.5px] text-subtle-foreground">
                {row.original.description || '—'}
              </div>
            </div>
          </div>
        ),
      },
      {
        id: 'kind',
        accessorKey: 'kind',
        header: 'Kind',
        cell: ({ row }) => <GroupKindBadge kind={row.original.kind} />,
      },
      {
        id: 'scope',
        accessorFn: (group) => group.client_name ?? '',
        header: 'Scope',
        cell: ({ row }) => <span className="text-muted-foreground">{row.original.client_name ?? 'All clients'}</span>,
      },
      {
        id: 'members',
        accessorKey: 'member_count',
        header: 'Devices',
        meta: { align: 'right' },
        cell: ({ getValue }) => <span className="tabular font-medium">{formatNumber(getValue<number>())}</span>,
      },
      {
        id: 'rules',
        accessorFn: (group) => (group.rules ? describeRules(group.rules, fields, lookup) : ''),
        header: 'Membership',
        enableSorting: false,
        cell: ({ row, getValue }) => (
          <span className="block max-w-[26rem] truncate text-muted-foreground" title={getValue<string>()}>
            {row.original.kind === 'dynamic' ? getValue<string>() : 'Hand-picked devices'}
          </span>
        ),
      },
      {
        id: 'updated',
        accessorKey: 'updated_at',
        header: 'Updated',
        cell: ({ getValue }) => <RelativeTime value={getValue<string>()} className="text-muted-foreground" />,
      },
    ],
    [fields, lookup],
  )

  return (
    <PageContainer className="grid grid-cols-1 gap-4">
      <PageHeader
        icon={<Boxes />}
        title="Device groups"
        description="Target jobs and policies at a curated list of devices or a rule that keeps itself up to date."
        actions={
          <Can permission={PERMISSIONS.devicesManage}>
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus data-icon="inline-start" />
              New group
            </Button>
          </Can>
        }
      />
      <div className="flex items-center gap-2">
        <SearchField value={query} onChange={setQuery} placeholder="Search groups…" label="Search groups" />
        <span className="tabular text-dense text-muted-foreground">{formatNumber(rows.length)} groups</span>
      </div>
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          loading={isLoading}
          getRowId={(group) => group.id}
          onRowClick={(group) => void navigate({ to: '/automation/groups/$groupId', params: { groupId: group.id } })}
          initialSorting={[{ id: 'name', desc: false }]}
          caption="Device groups"
          empty={
            <div className="p-6">
              <EmptyState
                compact
                illustration="devices"
                title={needle ? 'No groups match' : 'No groups yet'}
                description="Create a dynamic group such as “Windows servers” or a static list of VIP devices."
              />
            </div>
          }
        />
      )}
      <NewGroupDialog
        open={creating || createRequested}
        onOpenChange={(open) => {
          setCreating(open)
          if (!open && createRequested) void navigate({ to: '/automation/groups', search: {}, replace: true })
        }}
      />
    </PageContainer>
  )
}
