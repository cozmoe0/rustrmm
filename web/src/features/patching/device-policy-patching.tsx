/* The effective patching configuration of one device, with the policy each value comes from. */
import { Link } from '@tanstack/react-router'
import { ScrollText, ShieldCheck, Sparkles } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { EffectivePolicy } from '@/lib/api/types'
import { effectivePatching } from '@/lib/patching/policy'
import { PATCHING_DEFAULTS } from '@/lib/patching/policy'
import { cn } from '@/lib/utils'
import { RingDelays, RuleSummary } from './rules-page'

function Origin({ origin }: { origin: { id: string; name: string } | null }) {
  if (!origin) return <span className="text-micro text-subtle-foreground">Default</span>
  return (
    <Link
      to="/automation/policies/$policyId"
      params={{ policyId: origin.id }}
      search={{ tab: 'patching' }}
      className="inline-flex h-6 max-w-full items-center gap-1 rounded-md bg-primary/8 px-2 text-micro font-medium text-primary ring-1 ring-primary/20 hover:bg-primary/12"
    >
      <ScrollText className="size-3 shrink-0" />
      <span className="truncate">{origin.name}</span>
    </Link>
  )
}

export function DevicePolicyPatching({ effective }: { effective: EffectivePolicy }) {
  const { rows, rules, rulesOrigin, enabled } = effectivePatching(effective)
  const ring = effective.document.patching?.ring ?? PATCHING_DEFAULTS.ring
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section className="overflow-hidden rounded-xl bg-card shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <ShieldCheck className="size-4 text-subtle-foreground" />
            Patching settings
          </h3>
          {enabled ? <Badge variant="live">Patching on</Badge> : <Badge variant="outline">Patching off</Badge>}
        </div>
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li key={row.path} className="grid grid-cols-1 gap-x-4 gap-y-1 px-4 py-2.5 sm:grid-cols-[9rem_minmax(0,1fr)_minmax(0,10rem)] sm:items-center">
              <span className="text-dense text-muted-foreground">{row.label}</span>
              <span className={cn('min-w-0 text-dense', row.inherited ? 'text-muted-foreground' : 'font-medium')}>{row.value}</span>
              <span className="min-w-0 sm:text-right">
                <Origin origin={row.origin} />
              </span>
            </li>
          ))}
        </ul>
      </section>
      <section className="self-start overflow-hidden rounded-xl bg-card shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Sparkles className="size-4 text-subtle-foreground" />
            Auto-approval rules
          </h3>
          <Origin origin={rulesOrigin} />
        </div>
        {rules.length === 0 ? (
          <p className="px-4 py-5 text-dense text-muted-foreground">
            {rulesOrigin ? 'The policy that sets the rules lists none, so every update waits for a manual decision.' : 'No policy sets approval rules for this device; updates wait for a manual decision.'}
          </p>
        ) : (
          <ol className="divide-y divide-border">
            {rules.map((rule, index) => (
              <li key={index} className="grid grid-cols-1 gap-2.5 px-4 py-3">
                <RuleSummary rule={rule} />
                <RingDelays delays={rule.delay_days} highlight={ring} />
              </li>
            ))}
          </ol>
        )}
        <p className="border-t border-border px-4 py-2 text-micro text-subtle-foreground">The highlighted ring is this device’s. The last layer that sets rules supplies the whole list.</p>
      </section>
    </div>
  )
}
