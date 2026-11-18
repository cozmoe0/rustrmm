import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import {
  Bot,
  Calendar,
  Ellipsis,
  Hash,
  List,
  Pencil,
  Plus,
  SlidersHorizontal,
  ToggleLeft,
  Trash,
  Type,
} from 'lucide-react'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Can } from '@/components/common/can'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { DataTable } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, Mono, RelativeTime } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/simple-select'
import { customFieldsApi } from '@/lib/api/endpoints'
import { customFieldsQuery, keys } from '@/lib/api/queries'
import type { CustomField, CustomFieldScope, CustomFieldType } from '@/lib/api/types'
import { formatNumber } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { ListInput } from './list-input'

const SCOPE_LABEL: Record<CustomFieldScope, string> = { device: 'Devices', client: 'Clients', site: 'Sites' }
const TYPE_META: Record<CustomFieldType, { label: string; icon: typeof Type }> = {
  text: { label: 'Text', icon: Type },
  number: { label: 'Number', icon: Hash },
  boolean: { label: 'Yes / no', icon: ToggleLeft },
  date: { label: 'Date', icon: Calendar },
  select: { label: 'Choice', icon: List },
}
const KEY_PATTERN = /^[a-z][a-z0-9_]{0,47}$/

function keyFromName(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+|_+$/g, '')
    .slice(0, 48)
}

function FieldDialog({
  field,
  scope,
  onOpenChange,
}: {
  field: CustomField | null
  scope: CustomFieldScope
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(field?.name ?? '')
  const [key, setKey] = useState(field?.key ?? '')
  const [keyTouched, setKeyTouched] = useState(Boolean(field))
  const [fieldScope, setFieldScope] = useState<CustomFieldScope>(field?.scope ?? scope)
  const [type, setType] = useState<CustomFieldType>(field?.type ?? 'text')
  const [options, setOptions] = useState<string[]>(field?.options ?? [])
  const [description, setDescription] = useState(field?.description ?? '')
  const [writable, setWritable] = useState(field?.script_writable ?? false)
  const [attempted, setAttempted] = useState(false)
  const effectiveKey = keyTouched ? key : keyFromName(name)
  const errors = {
    name: name.trim() ? null : 'Enter a name',
    key: KEY_PATTERN.test(effectiveKey) ? null : 'Lower-case letters, digits and underscores; start with a letter',
    options: type === 'select' && options.length === 0 ? 'Add at least one option' : null,
  }
  const save = useMutation({
    mutationFn: () => {
      const body = {
        key: effectiveKey,
        name: name.trim(),
        description: description.trim(),
        type,
        options: type === 'select' ? options : [],
        scope: fieldScope,
        script_writable: fieldScope === 'device' && writable,
      }
      return field ? customFieldsApi.update(field.id, body) : customFieldsApi.create(body)
    },
    meta: { successMessage: field ? 'Field saved' : 'Field created' },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.customFields })
      void queryClient.invalidateQueries({ queryKey: keys.devices })
      onOpenChange(false)
    },
  })
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{field ? `Edit ${field.name}` : 'New custom field'}</DialogTitle>
          <DialogDescription>
            Typed values on devices, clients or sites. Device fields can be shown as grid columns and used in dynamic
            group rules.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid grid-cols-1 gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            setAttempted(true)
            if (Object.values(errors).some(Boolean)) return
            save.mutate()
          }}
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field data-invalid={Boolean(attempted && errors.name) || undefined}>
              <FieldLabel htmlFor="cf-name">Name</FieldLabel>
              <Input
                id="cf-name"
                value={name}
                maxLength={60}
                autoFocus
                placeholder="Asset tag"
                onChange={(event) => setName(event.target.value)}
              />
              <FieldError>{attempted ? errors.name : null}</FieldError>
            </Field>
            <Field data-invalid={Boolean(attempted && errors.key) || undefined}>
              <FieldLabel htmlFor="cf-key">Key</FieldLabel>
              <Input
                id="cf-key"
                className="font-mono"
                value={effectiveKey}
                disabled={Boolean(field)}
                spellCheck={false}
                onChange={(event) => {
                  setKeyTouched(true)
                  setKey(event.target.value)
                }}
              />
              {attempted && errors.key ? (
                <FieldError>{errors.key}</FieldError>
              ) : (
                <FieldDescription>
                  {field ? 'Keys can’t change.' : `Rules use custom.${effectiveKey || 'key'}`}
                </FieldDescription>
              )}
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="cf-scope">Applies to</FieldLabel>
              <SimpleSelect
                id="cf-scope"
                value={fieldScope}
                disabled={Boolean(field)}
                onValueChange={(value) => setFieldScope(value as CustomFieldScope)}
                options={(['device', 'client', 'site'] as const).map((item) => ({
                  value: item,
                  label: SCOPE_LABEL[item],
                }))}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="cf-type">Type</FieldLabel>
              <SimpleSelect
                id="cf-type"
                value={type}
                onValueChange={(value) => setType(value as CustomFieldType)}
                options={(Object.keys(TYPE_META) as CustomFieldType[]).map((item) => {
                  const Icon = TYPE_META[item].icon
                  return {
                    value: item,
                    label: TYPE_META[item].label,
                    icon: <Icon className="size-3.5 text-subtle-foreground" />,
                  }
                })}
              />
            </Field>
          </div>
          {type === 'select' && (
            <Field data-invalid={Boolean(attempted && errors.options) || undefined}>
              <FieldLabel htmlFor="cf-options">Options</FieldLabel>
              <ListInput
                id="cf-options"
                value={options}
                onChange={setOptions}
                invalid={Boolean(attempted && errors.options)}
                placeholder="Type an option and press Enter"
              />
              <FieldError>{attempted ? errors.options : null}</FieldError>
            </Field>
          )}
          <Field>
            <FieldLabel htmlFor="cf-description">Description</FieldLabel>
            <Input
              id="cf-description"
              value={description}
              maxLength={200}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          {fieldScope === 'device' && (
            <label className="flex items-start justify-between gap-3 rounded-lg px-3 py-2.5 ring-1 ring-border">
              <span className="text-dense">
                <span className="flex items-center gap-1.5 font-medium">
                  <Bot className="size-3.5" />
                  Scripts can write this field
                </span>
                <span className="mt-0.5 block text-micro text-muted-foreground">
                  A script line{' '}
                  <Mono className="text-[10.5px]">{`::rustrmm::set-field ${effectiveKey || 'key'}=value`}</Mono> sets it
                  on the device it ran on.
                </span>
              </span>
              <Switch checked={writable} onCheckedChange={setWritable} />
            </label>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending && <Spinner data-icon="inline-start" />}
              {field ? 'Save' : 'Create field'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function CustomFieldsPage({ scope }: { scope: CustomFieldScope }) {
  useTitle('Custom fields')
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const me = useMe()
  const canManage = hasPermission(me, PERMISSIONS.settingsManage)
  const { data, isLoading, error, refetch } = useQuery(customFieldsQuery())
  const [dialog, setDialog] = useState<{ field: CustomField | null; nonce: number } | null>(null)
  const [deleting, setDeleting] = useState<CustomField | null>(null)
  const all = useMemo(() => data ?? [], [data])
  const rows = all.filter((field) => field.scope === scope)
  const counts = { device: 0, client: 0, site: 0 }
  for (const field of all) counts[field.scope] += 1

  const remove = useMutation({
    mutationFn: (field: CustomField) => customFieldsApi.remove(field.id),
    meta: { successMessage: 'Field deleted' },
    onSuccess: () => {
      setDeleting(null)
      void queryClient.invalidateQueries({ queryKey: keys.customFields })
    },
  })

  const columns = useMemo<ColumnDef<CustomField>[]>(
    () => [
      {
        id: 'name',
        accessorFn: (field) => field.name.toLowerCase(),
        header: 'Field',
        cell: ({ row }) => (
          <div className="min-w-0 leading-tight">
            <div className="max-w-64 truncate font-medium">{row.original.name}</div>
            <code className="font-mono text-[10.5px] text-subtle-foreground">{row.original.key}</code>
          </div>
        ),
      },
      {
        id: 'type',
        accessorKey: 'type',
        header: 'Type',
        cell: ({ row }) => {
          const meta = TYPE_META[row.original.type]
          return (
            <div className="flex min-w-0 items-center gap-1.5">
              <meta.icon className="size-3.5 text-subtle-foreground" />
              <span>{meta.label}</span>
              {row.original.type === 'select' && (
                <span className="max-w-48 truncate text-micro text-subtle-foreground">
                  · {row.original.options.join(', ')}
                </span>
              )}
            </div>
          )
        },
      },
      ...(scope === 'device'
        ? [
            {
              id: 'writable',
              accessorFn: (field: CustomField) => (field.script_writable ? 1 : 0),
              header: 'Scripts',
              cell: ({ row }: { row: { original: CustomField } }) =>
                row.original.script_writable ? (
                  <Badge variant="default">
                    <Bot />
                    Writable
                  </Badge>
                ) : (
                  <span className="text-subtle-foreground">Read-only</span>
                ),
            } as ColumnDef<CustomField>,
          ]
        : []),
      {
        id: 'description',
        accessorKey: 'description',
        header: 'Description',
        enableSorting: false,
        cell: ({ getValue }) => (
          <span className="block max-w-80 truncate text-muted-foreground">{getValue<string>() || '—'}</span>
        ),
      },
      {
        id: 'created',
        accessorKey: 'created_at',
        header: 'Created',
        cell: ({ getValue }) => <RelativeTime value={getValue<string>()} className="text-muted-foreground" />,
      },
      {
        id: 'actions',
        header: '',
        enableSorting: false,
        meta: { align: 'right', className: 'w-12' },
        cell: ({ row }) =>
          canManage ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Actions for ${row.original.name}`}
                    onClick={(event) => event.stopPropagation()}
                  />
                }
              >
                <Ellipsis />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setDialog({ field: row.original, nonce: Date.now() })}>
                  <Pencil />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => setDeleting(row.original)}>
                  <Trash />
                  Delete…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null,
      },
    ],
    [canManage, scope],
  )

  return (
    <PageContainer className="grid grid-cols-1 gap-4">
      <PageHeader
        icon={<SlidersHorizontal />}
        title="Custom fields"
        description="Extra typed values on devices, clients and sites — asset tags, warranty dates, contract tiers. Scripts can write device fields."
        actions={
          <Can permission={PERMISSIONS.settingsManage}>
            <Button size="sm" onClick={() => setDialog({ field: null, nonce: Date.now() })}>
              <Plus data-icon="inline-start" />
              New field
            </Button>
          </Can>
        }
      />
      <Tabs
        value={scope}
        onValueChange={(value) =>
          void navigate({
            to: '/settings/custom-fields',
            search: (prev) => ({ ...prev, scope: value === 'device' ? undefined : (value as CustomFieldScope) }),
            replace: true,
          })
        }
        className="gap-0"
      >
        <TabsList>
          {(['device', 'client', 'site'] as const).map((item) => (
            <TabsTrigger key={item} value={item} className="px-3">
              {SCOPE_LABEL[item]}
              <span className="tabular text-micro text-subtle-foreground">{formatNumber(counts[item])}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          loading={isLoading}
          getRowId={(field) => field.id}
          onRowClick={canManage ? (field) => setDialog({ field, nonce: Date.now() }) : undefined}
          caption={`${SCOPE_LABEL[scope]} custom fields`}
          empty={
            <div className="p-6">
              <EmptyState
                compact
                illustration="automation"
                title={`No ${scope} fields yet`}
                description="Define a field, then fill it in on the record’s page or let a script set it."
              />
            </div>
          }
        />
      )}
      {dialog && (
        <FieldDialog
          key={dialog.nonce}
          field={dialog.field}
          scope={scope}
          onOpenChange={(open) => !open && setDialog(null)}
        />
      )}
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name}?`}
        description="The field and every stored value are deleted permanently. Group rules that use it stop matching. You'll be asked to confirm it's you."
        confirmLabel="Delete field"
        confirmText={deleting?.key}
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </PageContainer>
  )
}
