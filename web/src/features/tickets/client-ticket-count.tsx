import { formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useTicketCounts } from './use-ticket-counts'

/** Active tickets for a client card, with the SLA breaches in red. */
export function ClientTicketCount({ clientId }: { clientId: string }) {
  const { counts, open } = useTicketCounts({ client_id: clientId })
  if (!counts) return <div className="tabular mt-0.5 text-dense font-medium text-subtle-foreground">—</div>
  return (
    <div className={cn('tabular mt-0.5 flex items-center gap-1.5 text-dense font-medium', !open && 'text-subtle-foreground')}>
      {formatNumber(open ?? 0)}
      {counts.breached > 0 && (
        <span className="inline-flex items-center gap-1 text-micro font-semibold text-critical" title={`${counts.breached} breaching SLA`}>
          <span className="size-1.5 rounded-full bg-critical" />
          {counts.breached}
        </span>
      )}
    </div>
  )
}
