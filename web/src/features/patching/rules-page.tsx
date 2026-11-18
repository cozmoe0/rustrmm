import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowUpRight, Info, ScrollText, Sparkles } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { patchRulesQuery, policiesQuery } from '@/lib/api/queries'
import type { PatchApprovalRuleRow } from '@/lib/api/types'
import { ringDelay } from '@/lib/patching/approval'
import { CLASSIFICATION_LABEL, RING_LABEL, RING_ORDER, classificationLabel } from '@/lib/patching/labels'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { AssignmentChip } from '@/features/automation/policies-page'
import { PlatformMark } from './patching-ui'
import { SEVERITY_BAR } from './patching-styles'

/** Three small ring columns showing the delay in days. */
export function RingDelays({ delays, highlight }: { delays: PatchApprovalRuleRow['delay_days']; highlight?: string }) {
  return (
    <div className="grid grid-cols-3 gap-1">
      {RING_ORDER.map((ring) => {
        const days = ringDelay(delays, ring)
        return (
          <div key={ring} className={cn('min-w-14 rounded-md px-2 py-1 text-center ring-1', highlight === ring ? 'bg-primary/[0.08] ring-primary/30' : 'bg-surface-2 ring-border')}>
            <div className="text-[10px] text-subtle-foreground">{RING_LABEL[ring]}</div>
            <div className="tabular text-dense font-semibold">{days === 0 ? 'Day 0' : `+${days}d`}</div>
          </div>
        )
      })}
    </div>
  )
}

export function RuleSummary({ rule }: { rule: Pick<PatchApprovalRuleRow, 'platform' | 'classifications' | 'severities'> }) {
  const classes = rule.classifications ?? []
  const severities = rule.severities ?? []
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <PlatformMark platform={rule.platform} className="mr-1 text-dense font-medium" />
      {classes.length === 0 ? (
        <Badge variant="outline">Every classification</Badge>
      ) : (
        classes.map((item) => (
          <Badge key={item} variant="secondary">
            {classificationLabel(rule.platform, item) ?? CLASSIFICATION_LABEL[item]}
          </Badge>
        ))
      )}
      {severities.length > 0 &&
        severities.map((severity) => (
          <Badge key={severity} variant="outline" className="gap-1">
            <span className={cn('size-1.5 rounded-[2px]', SEVERITY_BAR[severity])} />
            {severity}
          </Badge>
        ))}
    </div>
  )
}

export function RulesPage() {
  useTitle('Approval rules')
  const me = useMe()
  const { data: rules, isLoading, error, refetch } = useQuery(patchRulesQuery)
  const { data: policies } = useQuery({ ...policiesQuery, enabled: hasPermission(me, PERMISSIONS.devicesView), meta: { silent: true } })
  const groups = useMemo(() => {
    const map = new Map<string, { name: string; rules: PatchApprovalRuleRow[] }>()
    for (const rule of rules ?? []) {
      const entry = map.get(rule.policy_id) ?? { name: rule.policy_name, rules: [] }
      entry.rules.push(rule)
      map.set(rule.policy_id, entry)
    }
    return [...map.entries()].map(([policyId, entry]) => ({ policyId, ...entry, policy: policies?.find((policy) => policy.id === policyId) }))
  }, [rules, policies])

  return (
    <PageContainer className="grid grid-cols-1 gap-4">
      <PageHeader
        title="Approval rules"
        description="Rules approve new updates automatically, client by client, and hold them back per ring. They live in policies; edit them on a policy’s Patching tab."
        actions={
          <Button size="sm" variant="outline" render={<Link to="/automation/policies" />} nativeButton={false}>
            <ScrollText data-icon="inline-start" />
            Policies
          </Button>
        }
      />
      <div className="flex items-start gap-3 rounded-xl bg-surface-2 px-4 py-3 text-dense text-muted-foreground ring-1 ring-border">
        <Info className="mt-0.5 size-4 shrink-0 text-info" />
        <p>
          A device uses the rule list of the <span className="font-medium text-foreground">last policy layer that sets one</span>; lists are not merged. Rules run when a client first sees an update,
          the first matching rule wins, and manual decisions always take precedence. Delays count from the release date.
        </p>
      </div>
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isLoading ? (
        <div className="grid gap-3">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-36 rounded-xl" />
          ))}
        </div>
      ) : groups.length === 0 ? (
        <EmptyState
          illustration="patching"
          title="No approval rules"
          description="Without rules every update waits for a manual decision. Add rules on a policy’s Patching tab."
          actions={
            <Button size="sm" render={<Link to="/automation/policies" />} nativeButton={false}>
              Open policies
            </Button>
          }
        />
      ) : (
        groups.map((group) => (
          <section key={group.policyId} className="overflow-hidden rounded-xl bg-card shadow-card">
            <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
                <Sparkles className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <Link to="/automation/policies/$policyId" params={{ policyId: group.policyId }} search={{ tab: 'patching' }} className="inline-flex items-center gap-1 text-sm font-semibold hover:underline">
                  {group.name}
                  <ArrowUpRight className="size-3.5 text-subtle-foreground" />
                </Link>
                <div className="mt-1 flex flex-wrap gap-1">
                  {group.policy?.assignments.length ? (
                    group.policy.assignments.map((assignment) => <AssignmentChip key={assignment.id} assignment={assignment} className="h-5" />)
                  ) : (
                    <span className="text-micro text-subtle-foreground">{group.policy ? 'Not assigned' : ''}</span>
                  )}
                </div>
              </div>
              <span className="tabular text-micro text-muted-foreground">
                {group.rules.length} {group.rules.length === 1 ? 'rule' : 'rules'}
              </span>
            </header>
            <ol className="divide-y divide-border">
              {group.rules.map((rule, index) => (
                <li key={`${rule.policy_id}-${rule.index ?? index}`} className="grid grid-cols-1 gap-3 px-4 py-3 md:grid-cols-[2rem_minmax(0,1fr)_auto] md:items-center">
                  <span className="tabular hidden size-6 items-center justify-center rounded-full bg-surface-3 text-[11px] font-semibold text-muted-foreground ring-1 ring-border md:flex">{(rule.index ?? index) + 1}</span>
                  <RuleSummary rule={rule} />
                  <RingDelays delays={rule.delay_days} />
                </li>
              ))}
            </ol>
          </section>
        ))
      )}
    </PageContainer>
  )
}
