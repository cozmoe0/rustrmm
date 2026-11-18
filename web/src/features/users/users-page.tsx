import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { Ban, Ellipsis, KeyRound, Pencil, Plus, RefreshCw, Search, ShieldCheck, Trash, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
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
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Can } from '@/components/common/can'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { CopyButton } from '@/components/common/copy-button'
import { DataTable } from '@/components/common/data-table'
import { ErrorState, RelativeTime, UserAvatar } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { PasswordMeter } from '@/components/common/password-meter'
import { usersApi } from '@/lib/api/endpoints'
import { keys, usersQuery } from '@/lib/api/queries'
import type { AssignmentInput, User } from '@/lib/api/types'
import { generatePassword, MIN_PASSWORD_LENGTH } from '@/lib/password'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { AssignmentBuilder } from './assignment-builder'

const userSchema = z.object({
  name: z.string().trim().min(2, 'Enter a name').max(80),
  email: z.email('Enter a valid email'),
  password: z.string(),
})

function toInputs(user: User | null | undefined): AssignmentInput[] {
  return (user?.assignments ?? []).map((assignment) => ({
    role_id: assignment.role_id,
    scope_type: assignment.scope.type,
    scope_id: assignment.scope.id,
  }))
}

function UserDialog({
  open,
  onOpenChange,
  user,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  user: User | null
}) {
  const queryClient = useQueryClient()
  const editing = Boolean(user)
  const [assignments, setAssignments] = useState<AssignmentInput[]>([])
  const [assignmentError, setAssignmentError] = useState<string | null>(null)

  const form = useForm<z.infer<typeof userSchema>>({
    resolver: zodResolver(
      editing
        ? userSchema
        : userSchema.extend({
            password: z.string().min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters`),
          }),
    ),
    defaultValues: { name: '', email: '', password: '' },
  })

  useEffect(() => {
    if (open) {
      form.reset({ name: user?.name ?? '', email: user?.email ?? '', password: user ? '' : generatePassword() })
      setAssignments(toInputs(user))
      setAssignmentError(null)
    }
  }, [open, user, form])

  const mutation = useMutation({
    mutationFn: async (values: z.infer<typeof userSchema>) =>
      user
        ? usersApi.update(user.id, { name: values.name, assignments })
        : usersApi.create({ name: values.name, email: values.email, password: values.password, assignments }),
    meta: { successMessage: editing ? 'User updated' : 'User created' },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.users })
      void queryClient.invalidateQueries({ queryKey: keys.roles })
      onOpenChange(false)
    },
  })

  function submit(values: z.infer<typeof userSchema>) {
    if (assignments.some((item) => item.scope_type !== 'global' && !item.scope_id)) {
      setAssignmentError('Choose a client or site for every scoped role.')
      return
    }
    mutation.mutate(values)
  }

  const password = form.watch('password')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${user?.name}` : 'New user'}</DialogTitle>
          <DialogDescription>
            {editing
              ? 'Change the name and what this person can access.'
              : 'Share the temporary password securely. They will enroll two-factor authentication at first sign-in.'}
          </DialogDescription>
        </DialogHeader>
        <form id="user-form" noValidate onSubmit={form.handleSubmit(submit)}>
          <FieldGroup className="gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={Boolean(form.formState.errors.name) || undefined}>
                <FieldLabel htmlFor="user-name">Full name</FieldLabel>
                <Input id="user-name" autoFocus {...form.register('name')} />
                <FieldError errors={[form.formState.errors.name]} />
              </Field>
              <Field data-invalid={Boolean(form.formState.errors.email) || undefined}>
                <FieldLabel htmlFor="user-email">Email</FieldLabel>
                <Input id="user-email" type="email" disabled={editing} {...form.register('email')} />
                <FieldError errors={[form.formState.errors.email]} />
              </Field>
            </div>
            {!editing && (
              <Field data-invalid={Boolean(form.formState.errors.password) || undefined}>
                <FieldLabel htmlFor="user-password">Temporary password</FieldLabel>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input id="user-password" className="pr-9 font-mono" autoComplete="new-password" {...form.register('password')} />
                    <CopyButton value={password} label="Copy password" className="absolute top-1/2 right-1.5 -translate-y-1/2" />
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => form.setValue('password', generatePassword(), { shouldValidate: true })}
                  >
                    <RefreshCw data-icon="inline-start" />
                    Generate
                  </Button>
                </div>
                <PasswordMeter password={password} />
                <FieldError errors={[form.formState.errors.password]} />
              </Field>
            )}
            <Field>
              <FieldLabel>Roles</FieldLabel>
              <FieldDescription>Each role applies to all clients, one client, or a single site.</FieldDescription>
              <AssignmentBuilder value={assignments} onChange={setAssignments} />
              {assignmentError && <p className="text-dense text-critical">{assignmentError}</p>}
            </Field>
          </FieldGroup>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="user-form" disabled={mutation.isPending}>
            {mutation.isPending && <Spinner data-icon="inline-start" />}
            {editing ? 'Save changes' : 'Create user'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AssignmentChips({ user }: { user: User }) {
  if (user.assignments.length === 0) return <span className="text-subtle-foreground">No access</span>
  return (
    <div className="flex flex-wrap gap-1">
      {user.assignments.slice(0, 2).map((assignment) => (
        <Badge key={assignment.id} variant={assignment.role_name === 'Owner' ? 'default' : 'secondary'}>
          {assignment.role_name}
          {assignment.scope.type !== 'global' && <span className="text-subtle-foreground">· {assignment.scope.name}</span>}
        </Badge>
      ))}
      {user.assignments.length > 2 && <Badge variant="outline">+{user.assignments.length - 2}</Badge>}
    </div>
  )
}

export function UsersPage({ createRequested }: { createRequested: boolean }) {
  useTitle('Users')
  const me = useMe()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const canManage = hasPermission(me, PERMISSIONS.usersManage)
  const { data: users = [], isLoading, error, refetch } = useQuery(usersQuery)
  const [filter, setFilter] = useState('')
  const [editing, setEditing] = useState<User | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deleting, setDeleting] = useState<User | null>(null)
  const [resetting, setResetting] = useState<User | null>(null)

  // `?new=true` (from quick-create) opens the dialog for a new user without extra state.
  const creatingFromUrl = createRequested && canManage

  function setOpen(open: boolean) {
    setDialogOpen(open)
    if (!open && createRequested) void navigate({ to: '/settings/users', search: {}, replace: true })
  }

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: keys.users })

  const toggleStatus = useMutation({
    mutationFn: (user: User) => usersApi.update(user.id, { status: user.status === 'active' ? 'disabled' : 'active' }),
    onSuccess: (user) => {
      toast.success(user.status === 'active' ? `${user.name} enabled` : `${user.name} disabled`)
      invalidate()
    },
  })

  const resetMfa = useMutation({
    mutationFn: (user: User) => usersApi.resetMfa(user.id),
    meta: { successMessage: 'Two-factor authentication reset — they will enroll again at next sign-in' },
    onSuccess: () => {
      setResetting(null)
      invalidate()
    },
  })

  const remove = useMutation({
    mutationFn: (user: User) => usersApi.remove(user.id),
    meta: { successMessage: 'User deleted' },
    onSuccess: () => {
      setDeleting(null)
      invalidate()
    },
  })

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    return needle ? users.filter((user) => `${user.name} ${user.email}`.toLowerCase().includes(needle)) : users
  }, [users, filter])

  const columns = useMemo<ColumnDef<User>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'User',
        cell: ({ row }) => (
          <div className="flex items-center gap-2.5">
            <UserAvatar name={row.original.name} />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 truncate font-medium">
                {row.original.name}
                {row.original.id === me?.user.id && <Badge variant="outline">You</Badge>}
              </div>
              <div className="truncate text-micro text-subtle-foreground">{row.original.email}</div>
            </div>
          </div>
        ),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ row }) =>
          row.original.status === 'active' ? <Badge variant="live">Active</Badge> : <Badge variant="outline">Disabled</Badge>,
      },
      {
        accessorKey: 'mfa_enabled',
        header: '2FA',
        cell: ({ row }) =>
          row.original.mfa_enabled ? (
            <span className="inline-flex items-center gap-1 text-dense text-success">
              <ShieldCheck className="size-3.5" />
              Enrolled
            </span>
          ) : (
            <Badge variant="warning">Pending</Badge>
          ),
      },
      {
        id: 'roles',
        header: 'Roles',
        enableSorting: false,
        cell: ({ row }) => <AssignmentChips user={row.original} />,
      },
      {
        accessorKey: 'last_login_at',
        header: 'Last sign-in',
        cell: ({ getValue }) => <RelativeTime value={getValue<string | null>()} className="text-muted-foreground" />,
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
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem
                  onClick={() => {
                    setEditing(row.original)
                    setDialogOpen(true)
                  }}
                >
                  <Pencil />
                  Edit user
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setResetting(row.original)} disabled={!row.original.mfa_enabled}>
                  <KeyRound />
                  Reset two-factor
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => toggleStatus.mutate(row.original)}
                  disabled={row.original.id === me?.user.id}
                >
                  {row.original.status === 'active' ? <Ban /> : <UserPlus />}
                  {row.original.status === 'active' ? 'Disable' : 'Enable'}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  disabled={row.original.id === me?.user.id}
                  onClick={() => setDeleting(row.original)}
                >
                  <Trash />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null,
      },
    ],
    [canManage, me?.user.id, toggleStatus],
  )

  return (
    <PageContainer className="grid gap-5">
      <PageHeader
        eyebrow="Settings"
        title="Users"
        description="Everyone who can sign in to this console. Every account is required to use two-factor authentication."
        actions={
          <Can permission={PERMISSIONS.usersManage}>
            <Button
              onClick={() => {
                setEditing(null)
                setDialogOpen(true)
              }}
            >
              <Plus data-icon="inline-start" />
              New user
            </Button>
          </Can>
        }
      />
      <div className="flex items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-subtle-foreground" />
          <Input
            data-filter-input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter by name or email…"
            aria-label="Filter users"
            className="pl-8"
          />
        </div>
        <span className="tabular text-dense text-muted-foreground">{filtered.length} users</span>
      </div>
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <DataTable
          data={filtered}
          columns={columns}
          loading={isLoading}
          getRowId={(user) => user.id}
          onRowClick={
            canManage
              ? (user) => {
                  setEditing(user)
                  setDialogOpen(true)
                }
              : undefined
          }
          caption="Users"
        />
      )}

      <UserDialog
        open={dialogOpen || creatingFromUrl}
        onOpenChange={setOpen}
        user={creatingFromUrl && !dialogOpen ? null : editing}
      />
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name}?`}
        description="Their sessions end immediately. Audit history keeps their name."
        confirmText={deleting?.email}
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
      <ConfirmDialog
        open={Boolean(resetting)}
        onOpenChange={(open) => !open && setResetting(null)}
        title={`Reset two-factor for ${resetting?.name}?`}
        description="Their authenticator and passkeys are removed and they must enroll again at next sign-in. You'll be asked to confirm it's you."
        confirmLabel="Reset two-factor"
        pending={resetMfa.isPending}
        onConfirm={() => resetting && resetMfa.mutate(resetting)}
      />
    </PageContainer>
  )
}
