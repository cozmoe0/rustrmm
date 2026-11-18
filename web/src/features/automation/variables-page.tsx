import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { ChevronRight, Ellipsis, KeyRound, Lock, Pencil, Plus, Trash, Variable as VariableIcon } from 'lucide-react'
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
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Can } from '@/components/common/can'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { DataTable } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, RelativeTime } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/simple-select'
import { variablesApi } from '@/lib/api/endpoints'
import { clientsQuery, keys, sitesQuery, variablesQuery } from '@/lib/api/queries'
import type { Variable, VariableInput, VariableScope } from '@/lib/api/types'
import { SECRET_MASK, envNameError } from '@/lib/automation/params'
import { formatNumber } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { SearchField } from '@/features/devices/remote-ui'
import { SEGMENTED } from './styles'

const SCOPE_LABEL: Record<VariableScope, string> = { global: 'Global', client: 'Client', site: 'Site' }

function Precedence() {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl bg-card px-4 py-3 text-dense shadow-card">
      <span className="text-muted-foreground">When names collide:</span>
      {(['site', 'client', 'global'] as const).map((scope, index) => (
        <span key={scope} className="inline-flex items-center gap-2">
          <span
            className={cn(
              'inline-flex h-6 items-center rounded-md px-2 font-medium ring-1',
              index === 0
                ? 'bg-primary/10 text-foreground ring-primary/25'
                : 'bg-surface-3 text-muted-foreground ring-border',
            )}
          >
            {SCOPE_LABEL[scope]}
          </span>
          {index < 2 && <ChevronRight className="size-3.5 text-subtle-foreground" />}
        </span>
      ))}
      <span className="text-muted-foreground">
        · the most specific scope wins. Script parameters override variables.
      </span>
    </div>
  )
}

function VariableDialog({
  open,
  onOpenChange,
  variable,
  defaultScope,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  variable: Variable | null
  defaultScope: VariableScope
}) {
  const queryClient = useQueryClient()
  const { data: clients = [] } = useQuery(clientsQuery())
  const { data: sites = [] } = useQuery(sitesQuery())
  const [scope, setScope] = useState<VariableScope>(variable?.scope ?? defaultScope)
  const [scopeId, setScopeId] = useState<string | null>(variable?.scope_id ?? null)
  const [name, setName] = useState(variable?.name ?? '')
  const [secret, setSecret] = useState(variable?.secret ?? false)
  const [value, setValue] = useState(variable?.secret ? '' : (variable?.value ?? ''))
  const [replacing, setReplacing] = useState(!variable?.secret)
  const [description, setDescription] = useState(variable?.description ?? '')
  const [attempted, setAttempted] = useState(false)
  const keepsSecret = Boolean(variable?.secret) && secret && !replacing

  const nameError = envNameError(name)
  const scopeError = scope !== 'global' && !scopeId ? `Choose a ${scope}` : null
  const valueError = !keepsSecret && value === '' ? 'Enter a value' : null

  const save = useMutation({
    mutationFn: () => {
      const body: VariableInput = {
        scope,
        scope_id: scope === 'global' ? null : scopeId,
        name: name.trim(),
        secret,
        description: description.trim(),
        ...(keepsSecret ? {} : { value }),
      }
      return variable ? variablesApi.update(variable.id, body) : variablesApi.create(body)
    },
    meta: { successMessage: variable ? 'Variable saved' : 'Variable created' },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.variables })
      onOpenChange(false)
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{variable ? `Edit ${variable.name}` : 'New variable'}</DialogTitle>
          <DialogDescription>
            Scripts read it as an environment variable. Secrets are encrypted, never shown again and masked in output.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid grid-cols-1 gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            setAttempted(true)
            if (nameError || scopeError || valueError) return
            save.mutate()
          }}
        >
          <Field>
            <FieldLabel>Scope</FieldLabel>
            <ToggleGroup
              value={[scope]}
              onValueChange={(next: string[]) => {
                if (!next[0]) return
                setScope(next[0] as VariableScope)
                setScopeId(null)
              }}
              variant="outline"
              spacing={0}
              className={cn('w-full', SEGMENTED)}
            >
              {(['global', 'client', 'site'] as const).map((item) => (
                <ToggleGroupItem key={item} value={item} className="flex-1">
                  {SCOPE_LABEL[item]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>
          {scope !== 'global' && (
            <Field data-invalid={Boolean(attempted && scopeError) || undefined}>
              <FieldLabel htmlFor="var-scope-id">{scope === 'client' ? 'Client' : 'Site'}</FieldLabel>
              <SimpleSelect
                id="var-scope-id"
                value={scopeId}
                onValueChange={setScopeId}
                placeholder={`Choose a ${scope}…`}
                ariaInvalid={Boolean(attempted && scopeError)}
                options={
                  scope === 'client'
                    ? clients.map((client) => ({ value: client.id, label: client.name }))
                    : sites.map((site) => ({
                        value: site.id,
                        label: site.name,
                        group: clients.find((client) => client.id === site.client_id)?.name,
                      }))
                }
              />
              <FieldError>{attempted ? scopeError : null}</FieldError>
            </Field>
          )}
          <Field data-invalid={Boolean(attempted && nameError) || undefined}>
            <FieldLabel htmlFor="var-name">Name</FieldLabel>
            <Input
              id="var-name"
              className="font-mono"
              value={name}
              spellCheck={false}
              autoComplete="off"
              placeholder="ProxyUrl"
              onChange={(event) => setName(event.target.value)}
            />
            {attempted && nameError ? (
              <FieldError>{nameError}</FieldError>
            ) : (
              <FieldDescription>
                Letters, digits and underscores. Reserved names such as PATH are rejected.
              </FieldDescription>
            )}
          </Field>
          <label className="flex items-start justify-between gap-3 rounded-lg px-3 py-2.5 ring-1 ring-border">
            <span className="text-dense">
              <span className="flex items-center gap-1.5 font-medium">
                <Lock className="size-3.5" />
                Secret
              </span>
              <span className="block text-micro text-muted-foreground">
                Write-only: stored field-encrypted, never returned by the API, masked in script output.
              </span>
            </span>
            <Switch
              checked={secret}
              onCheckedChange={(checked) => {
                setSecret(checked)
                if (!checked) setReplacing(true)
              }}
            />
          </label>
          <Field data-invalid={Boolean(attempted && valueError) || undefined}>
            <FieldLabel htmlFor="var-value">Value</FieldLabel>
            {keepsSecret ? (
              <div className="flex items-center gap-2">
                <div className="flex h-(--control-h) flex-1 items-center gap-2 rounded-lg border border-input bg-surface-2 px-3 font-mono text-dense text-muted-foreground">
                  <KeyRound className="size-3.5" />
                  {SECRET_MASK}
                </div>
                <Button type="button" variant="outline" onClick={() => setReplacing(true)}>
                  Replace value
                </Button>
              </div>
            ) : secret ? (
              <Input
                id="var-value"
                type="password"
                autoComplete="new-password"
                className="font-mono"
                value={value}
                autoFocus={Boolean(variable)}
                onChange={(event) => setValue(event.target.value)}
              />
            ) : (
              <Textarea
                id="var-value"
                rows={2}
                className="font-mono text-[12.5px]"
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            )}
            {attempted && valueError ? (
              <FieldError>{valueError}</FieldError>
            ) : keepsSecret ? (
              <FieldDescription>The current value is kept unless you replace it.</FieldDescription>
            ) : null}
          </Field>
          <Field>
            <FieldLabel htmlFor="var-description">Description</FieldLabel>
            <Input
              id="var-description"
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
              {variable ? 'Save' : 'Create variable'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function VariablesPage({ scope }: { scope: VariableScope }) {
  useTitle('Variables')
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const me = useMe()
  const canManage = hasPermission(me, PERMISSIONS.scriptsManage)
  const { data, isLoading, error, refetch } = useQuery(variablesQuery())
  const { data: clients = [] } = useQuery(clientsQuery())
  const [filterId, setFilterId] = useState('all')
  const [query, setQuery] = useState('')
  const [dialog, setDialog] = useState<{ variable: Variable | null; nonce: number } | null>(null)
  const [deleting, setDeleting] = useState<Variable | null>(null)
  const all = useMemo(() => data ?? [], [data])
  const counts = { global: 0, client: 0, site: 0 }
  for (const variable of all) counts[variable.scope] += 1
  const needle = query.trim().toLowerCase()
  const rows = all
    .filter((variable) => variable.scope === scope)
    .filter((variable) => filterId === 'all' || variable.scope_id === filterId)
    .filter(
      (variable) =>
        !needle ||
        `${variable.name} ${variable.description} ${variable.scope_name ?? ''} ${variable.value ?? ''}`
          .toLowerCase()
          .includes(needle),
    )

  const remove = useMutation({
    mutationFn: (variable: Variable) => variablesApi.remove(variable.id),
    meta: { successMessage: 'Variable deleted' },
    onSuccess: () => {
      setDeleting(null)
      void queryClient.invalidateQueries({ queryKey: keys.variables })
    },
  })

  const columns = useMemo<ColumnDef<Variable>[]>(
    () => [
      {
        id: 'name',
        accessorFn: (variable) => variable.name.toLowerCase(),
        header: 'Name',
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-2">
            {row.original.secret ? (
              <Lock className="size-3.5 text-warning" />
            ) : (
              <VariableIcon className="size-3.5 text-subtle-foreground" />
            )}
            <code className="font-mono text-[12px] font-medium">{row.original.name}</code>
          </span>
        ),
      },
      {
        id: 'value',
        accessorFn: (variable) => variable.value ?? '',
        header: 'Value',
        enableSorting: false,
        cell: ({ row }) =>
          row.original.secret ? (
            <span className="inline-flex items-center gap-2">
              <span className="font-mono text-[12px] tracking-widest text-muted-foreground">{SECRET_MASK}</span>
              <Badge variant="warning">Secret</Badge>
            </span>
          ) : (
            <code
              className="block max-w-80 truncate font-mono text-[11.5px] text-muted-foreground"
              title={row.original.value ?? ''}
            >
              {row.original.value}
            </code>
          ),
      },
      ...(scope === 'global'
        ? []
        : [
            {
              id: 'scope',
              accessorFn: (variable: Variable) => variable.scope_name ?? '',
              header: SCOPE_LABEL[scope],
              cell: ({ row }: { row: { original: Variable } }) => (
                <span className="block max-w-56 truncate">{row.original.scope_name}</span>
              ),
            } as ColumnDef<Variable>,
          ]),
      {
        id: 'description',
        accessorKey: 'description',
        header: 'Description',
        enableSorting: false,
        cell: ({ getValue }) => (
          <span className="block max-w-72 truncate text-muted-foreground">{getValue<string>() || '—'}</span>
        ),
      },
      {
        id: 'updated',
        accessorKey: 'updated_at',
        header: 'Updated',
        cell: ({ row }) => (
          <div className="leading-tight">
            <RelativeTime value={row.original.updated_at} />
            <div className="text-[10.5px] text-subtle-foreground">{row.original.updated_by_name}</div>
          </div>
        ),
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
                <DropdownMenuItem onClick={() => setDialog({ variable: row.original, nonce: Date.now() })}>
                  {row.original.secret ? <KeyRound /> : <Pencil />}
                  {row.original.secret ? 'Edit or replace value' : 'Edit'}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => setDeleting(row.original)}>
                  <Trash />
                  Delete
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
        icon={<VariableIcon />}
        title="Variables"
        description="Named values delivered to scripts as environment variables — server names, URLs, credentials."
        actions={
          <Can permission={PERMISSIONS.scriptsManage}>
            <Button size="sm" onClick={() => setDialog({ variable: null, nonce: Date.now() })}>
              <Plus data-icon="inline-start" />
              New variable
            </Button>
          </Can>
        }
      />
      <Precedence />
      <div className="flex flex-wrap items-center gap-3">
        <Tabs
          value={scope}
          onValueChange={(value) =>
            void navigate({
              to: '/automation/variables',
              search: (prev) => ({ ...prev, scope: value === 'global' ? undefined : (value as VariableScope) }),
              replace: true,
            })
          }
          className="gap-0"
        >
          <TabsList>
            {(['global', 'client', 'site'] as const).map((item) => (
              <TabsTrigger key={item} value={item} className="px-3">
                {SCOPE_LABEL[item]}
                <span className="tabular text-micro text-subtle-foreground">{formatNumber(counts[item])}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {scope === 'client' && (
          <SimpleSelect
            size="sm"
            className="w-56"
            ariaLabel="Filter by client"
            value={filterId}
            onValueChange={setFilterId}
            options={[
              { value: 'all', label: 'All clients' },
              ...clients.map((client) => ({ value: client.id, label: client.name })),
            ]}
          />
        )}
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Search variables…"
          label="Search variables"
          className="sm:ml-auto sm:w-64"
        />
      </div>
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          loading={isLoading}
          getRowId={(variable) => variable.id}
          onRowClick={canManage ? (variable) => setDialog({ variable, nonce: Date.now() }) : undefined}
          caption={`${SCOPE_LABEL[scope]} variables`}
          empty={
            <div className="p-6">
              <EmptyState
                compact
                illustration="automation"
                title={`No ${scope} variables${needle ? ' match' : ' yet'}`}
                description={
                  scope === 'global'
                    ? 'Global variables reach every script on every device.'
                    : `Values set for one ${scope} override global ones with the same name.`
                }
              />
            </div>
          }
        />
      )}
      {dialog && (
        <VariableDialog
          key={dialog.nonce}
          open
          onOpenChange={(open) => !open && setDialog(null)}
          variable={dialog.variable}
          defaultScope={scope}
        />
      )}
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name}?`}
        description="Scripts that read this variable will no longer receive it. Jobs already running are not affected."
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </PageContainer>
  )
}
