import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowRight, Plus, ScrollText } from 'lucide-react'
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
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Can } from '@/components/common/can'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, RelativeTime } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { policiesApi } from '@/lib/api/endpoints'
import { keys, policiesQuery } from '@/lib/api/queries'
import type { Policy, PolicyAssignment } from '@/lib/api/types'
import { TARGET_ORDER, TARGET_TYPE_LABEL, policyHighlights, sortSources } from '@/lib/automation/policy'
import { PERMISSIONS } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { TARGET_ICON } from './target-icons'

export function AssignmentChip({ assignment, className }: { assignment: PolicyAssignment; className?: string }) {
  const Icon = TARGET_ICON[assignment.target_type]
  return (
    <span
      className={cn(
        'inline-flex h-6 max-w-full items-center gap-1.5 rounded-md bg-surface-2 px-2 text-micro ring-1 ring-border',
        className,
      )}
    >
      <Icon className="size-3 shrink-0 text-subtle-foreground" />
      <span className="truncate">{assignment.target_type === 'global' ? 'Everywhere' : assignment.target_name}</span>
      {assignment.target_type === 'group' && (
        <span className="tabular text-subtle-foreground">p{assignment.priority}</span>
      )}
    </span>
  )
}

function Inheritance() {
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-xl bg-card px-4 py-3 shadow-card">
      <span className="mr-1 text-dense text-muted-foreground">Layers apply in order — later wins:</span>
      {TARGET_ORDER.map((type, index) => {
        const Icon = TARGET_ICON[type]
        return (
          <span key={type} className="inline-flex items-center gap-1.5">
            <span className="inline-flex h-6 items-center gap-1.5 rounded-md bg-surface-2 px-2 text-micro font-medium ring-1 ring-border">
              <Icon className="size-3 text-subtle-foreground" />
              {type === 'group' ? 'Groups by priority' : TARGET_TYPE_LABEL[type]}
            </span>
            {index < TARGET_ORDER.length - 1 && <ArrowRight className="size-3 text-subtle-foreground" />}
          </span>
        )
      })}
    </div>
  )
}

function PolicyCard({ policy }: { policy: Policy }) {
  const highlights = policyHighlights(policy.document)
  const assignments = sortSources(policy.assignments)
  return (
    <Link
      to="/automation/policies/$policyId"
      params={{ policyId: policy.id }}
      className="grid grid-cols-1 content-start gap-3 rounded-xl bg-card p-4 shadow-card transition-shadow outline-none hover:shadow-[0_0_0_1px_var(--border-strong),0_6px_18px_-8px_rgb(0_0_0/0.18)] focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
          <ScrollText className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{policy.name}</span>
            <Badge variant="outline" className="tabular">
              v{policy.version}
            </Badge>
          </div>
          <p className="mt-0.5 line-clamp-2 text-dense text-muted-foreground">
            {policy.description || 'No description.'}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        {highlights.length === 0 ? (
          <span className="text-micro text-subtle-foreground">Sets nothing yet</span>
        ) : (
          highlights.slice(0, 5).map((item) => (
            <span
              key={item}
              className="inline-flex h-5 items-center rounded-[5px] bg-primary/[0.07] px-1.5 text-[10.5px] text-foreground/85 ring-1 ring-primary/15"
            >
              {item}
            </span>
          ))
        )}
        {highlights.length > 5 && (
          <span className="text-[10.5px] text-subtle-foreground">+{highlights.length - 5}</span>
        )}
      </div>
      <div className="grid grid-cols-1 gap-1.5 border-t border-border pt-3">
        <div className="text-micro text-subtle-foreground">
          {assignments.length ? 'Assigned to' : 'Not assigned — it has no effect yet'}
        </div>
        {assignments.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {assignments.map((assignment) => (
              <AssignmentChip key={assignment.id} assignment={assignment} />
            ))}
          </div>
        )}
      </div>
      <div className="text-micro text-subtle-foreground">
        Updated <RelativeTime value={policy.updated_at} /> by {policy.updated_by_name}
      </div>
    </Link>
  )
}

function NewPolicyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [attempted, setAttempted] = useState(false)
  const create = useMutation({
    mutationFn: () => policiesApi.create({ name: name.trim(), description: description.trim(), document: {} }),
    onSuccess: (policy) => {
      void queryClient.invalidateQueries({ queryKey: keys.policies })
      onOpenChange(false)
      void navigate({ to: '/automation/policies/$policyId', params: { policyId: policy.id } })
    },
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>New policy</DialogTitle>
          <DialogDescription>
            Start empty, then set only what this layer should change. Assign it when it's ready.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid grid-cols-1 gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            setAttempted(true)
            if (name.trim()) create.mutate()
          }}
        >
          <Field data-invalid={Boolean(attempted && !name.trim()) || undefined}>
            <FieldLabel htmlFor="policy-name">Name</FieldLabel>
            <Input
              id="policy-name"
              value={name}
              maxLength={80}
              autoFocus
              placeholder="Servers — maintenance window"
              onChange={(event) => setName(event.target.value)}
            />
            <FieldError>{attempted && !name.trim() ? 'Enter a name' : null}</FieldError>
          </Field>
          <Field>
            <FieldLabel htmlFor="policy-description">Description</FieldLabel>
            <Input
              id="policy-description"
              value={description}
              maxLength={240}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending && <Spinner data-icon="inline-start" />}
              Create policy
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function PoliciesPage({ createRequested }: { createRequested: boolean }) {
  useTitle('Policies')
  const navigate = useNavigate()
  const { data, isLoading, error, refetch } = useQuery(policiesQuery)
  const [creating, setCreating] = useState(false)
  return (
    <PageContainer className="grid grid-cols-1 gap-4">
      <PageHeader
        icon={<ScrollText />}
        title="Policies"
        description="Agent intervals, remote-access rules and scheduled tasks, layered from the whole MSP down to a single device."
        actions={
          <Can permission={PERMISSIONS.policiesManage}>
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus data-icon="inline-start" />
              New policy
            </Button>
          </Can>
        }
      />
      <Inheritance />
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isLoading ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-60 rounded-xl" />
          ))}
        </div>
      ) : !data?.length ? (
        <EmptyState
          illustration="automation"
          title="No policies yet"
          description="Create an MSP-wide baseline first, then layer client, site and group policies on top."
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {data.map((policy) => (
            <PolicyCard key={policy.id} policy={policy} />
          ))}
        </div>
      )}
      <NewPolicyDialog
        open={creating || createRequested}
        onOpenChange={(open) => {
          setCreating(open)
          if (!open && createRequested) void navigate({ to: '/automation/policies', search: {}, replace: true })
        }}
      />
    </PageContainer>
  )
}
