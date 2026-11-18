import { Link } from '@tanstack/react-router'
import { ArrowUpRight, Bell, Hourglass } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Illustration } from '@/components/common/illustrations'
import { RelativeTime } from '@/components/common/misc'
import { usePendingApprovals } from '@/features/automation/use-automation-live'

export function NotificationsButton() {
  const approvals = usePendingApprovals()
  const actionable = approvals.items.filter((approval) => approval.status === 'pending')
  const count = approvals.count

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={count ? `Notifications, ${count} approvals waiting` : 'Notifications'}
            className="relative flex size-10 items-center justify-center rounded-lg text-rail-muted transition-colors outline-none hover:bg-rail-hover hover:text-rail-foreground focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-rail-hover data-[popup-open]:text-rail-foreground"
          />
        }
      >
        <Bell className="size-[18px]" strokeWidth={1.75} />
        {count > 0 && (
          <span className="tabular absolute top-1.5 right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9.5px] font-semibold text-primary-foreground ring-2 ring-rail">
            {count > 9 ? '9+' : count}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent side="right" align="end" sideOffset={10} className="w-80 p-0">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="text-sm font-semibold">Notifications</span>
          <span className="text-micro text-subtle-foreground">
            {count ? `${count} waiting on you` : 'All caught up'}
          </span>
        </div>
        {actionable.length > 0 ? (
          <div className="grid">
            <div className="px-4 pt-3 pb-1 text-micro font-medium text-subtle-foreground">Approvals</div>
            <ul className="max-h-72 overflow-y-auto px-1.5 pb-1.5">
              {actionable.slice(0, 6).map((approval) => (
                <li key={approval.id}>
                  <Link
                    to="/automation/jobs/$jobId"
                    params={{ jobId: approval.subject.id }}
                    className="flex items-start gap-2.5 rounded-lg px-2.5 py-2 outline-none hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-warning/12 text-warning">
                      <Hourglass className="size-3.5" />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-dense font-medium">{approval.subject.name}</span>
                      <span className="block truncate text-micro text-muted-foreground">
                        {approval.requested_by_name} · <RelativeTime value={approval.requested_at} />
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            <Link
              to="/automation/approvals"
              className="flex items-center justify-center gap-1 border-t border-border px-4 py-2.5 text-dense font-medium text-primary hover:bg-surface-3"
            >
              Open approvals inbox
              <ArrowUpRight className="size-3.5" />
            </Link>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
            <Illustration name="alerts" className="h-20" />
            <p className="text-dense font-medium">No notifications yet</p>
            <p className="text-micro text-muted-foreground">
              Approval requests, alert escalations and finished jobs will appear here.
            </p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
