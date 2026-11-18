import { useEffect, useMemo, useRef } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import type { LucideIcon } from 'lucide-react'
import {
  ClipboardList,
  Cpu,
  FileWarning,
  MapPin,
  PackageCheck,
  PackageMinus,
  PackagePlus,
  Plug,
  Rocket,
  RotateCw,
  KeyRound,
  ShieldCheck,
  ShieldExclamationPoint,
  ShieldOff,
  Unplug,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, RelativeTime } from '@/components/common/misc'
import { devicesApi } from '@/lib/api/endpoints'
import { keys } from '@/lib/api/queries'
import type { TimelineEntry, TimelineSeverity } from '@/lib/api/types'
import { formatTime } from '@/lib/format'
import { cn } from '@/lib/utils'

const KIND_ICON: Record<string, LucideIcon> = {
  'agent.enrolled': Rocket,
  'agent.online': Plug,
  'agent.offline': Unplug,
  'agent.log': FileWarning,
  'software.installed': PackagePlus,
  'software.updated': PackageCheck,
  'software.removed': PackageMinus,
  'system.reboot_pending': RotateCw,
  'hardware.changed': Cpu,
  'os.updated': ShieldCheck,
  'device.moved': MapPin,
  'security.admin_added': ShieldExclamationPoint,
  'agent.noise_key': KeyRound,
  'agent.noise_failed': ShieldOff,
}

/** Readable names (and a fixed tone, where the kind implies one) for kinds the console knows. */
const KIND_META: Record<string, { label: string; tone?: TimelineSeverity }> = {
  'agent.noise_key': { label: 'Encryption key registered', tone: 'info' },
  'agent.noise_failed': { label: 'Encrypted channel failed', tone: 'warning' },
}

const SEVERITY: Record<TimelineSeverity, { dot: string; icon: string; label: string }> = {
  info: { dot: 'bg-surface-4 ring-border-strong', icon: 'text-muted-foreground', label: 'Info' },
  notice: { dot: 'bg-info/15 ring-info/30', icon: 'text-info', label: 'Notice' },
  warning: { dot: 'bg-warning/15 ring-warning/35', icon: 'text-warning', label: 'Warning' },
  critical: { dot: 'bg-critical/15 ring-critical/35', icon: 'text-critical', label: 'Critical' },
}

function dayLabel(iso: string) {
  const date = new Date(iso)
  const today = new Date()
  const yesterday = new Date(Date.now() - 86_400_000)
  if (date.toDateString() === today.toDateString()) return 'Today'
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' }).format(date)
}

function TimelineRow({ entry, compact = false }: { entry: TimelineEntry; compact?: boolean }) {
  const Icon = KIND_ICON[entry.kind] ?? (entry.kind.startsWith('inventory.') ? ClipboardList : FileWarning)
  const meta = KIND_META[entry.kind]
  const severity = meta?.tone ?? entry.severity
  const tone = SEVERITY[severity] ?? SEVERITY.info
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      <span className="absolute top-7 bottom-0 left-[13px] w-px bg-border group-last/day:last:hidden" aria-hidden="true" />
      <span className={cn('relative z-[1] flex size-7 shrink-0 items-center justify-center rounded-full ring-1', tone.dot)}>
        <Icon className={cn('size-3.5', tone.icon)} />
      </span>
      <div className="min-w-0 flex-1 pt-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <p className={cn('text-dense', severity === 'warning' || severity === 'critical' ? 'font-medium' : '')}>{entry.summary || meta?.label}</p>
          {(severity === 'warning' || severity === 'critical') && (
            <span className={cn('text-micro font-semibold tracking-wide uppercase', tone.icon)}>{tone.label}</span>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-micro text-subtle-foreground">
          {compact ? <RelativeTime value={entry.at} /> : <time dateTime={entry.at}>{formatTime(entry.at)}</time>}
          {meta ? (
            <span title={entry.kind}>{meta.label}</span>
          ) : (
            <span className="font-mono">{entry.kind}</span>
          )}
        </div>
      </div>
    </li>
  )
}

/** Last few events for the Overview bento. */
export function RecentTimeline({ deviceId, onShowAll }: { deviceId: string; onShowAll: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: [...keys.timeline(deviceId), 'recent'],
    queryFn: () => devicesApi.timeline(deviceId, null, 6),
    staleTime: 30_000,
  })
  if (isLoading) {
    return (
      <div className="grid gap-3">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-9" />
        ))}
      </div>
    )
  }
  const items = data?.items ?? []
  if (items.length === 0) return <p className="text-dense text-muted-foreground">Nothing has happened on this device yet.</p>
  return (
    <div className="grid gap-3">
      <ol className="group/day">
        {items.map((entry) => (
          <TimelineRow key={entry.id} entry={entry} compact />
        ))}
      </ol>
      <Button variant="link" size="xs" className="justify-self-start px-0" onClick={onShowAll}>
        Full timeline
      </Button>
    </div>
  )
}

export function TimelineTab({ deviceId }: { deviceId: string }) {
  const query = useInfiniteQuery({
    queryKey: [...keys.timeline(deviceId), 'all'],
    queryFn: ({ pageParam }) => devicesApi.timeline(deviceId, pageParam, 40),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.next_cursor,
  })
  const sentinel = useRef<HTMLDivElement>(null)
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query

  // Infinite scroll: load the next page when the end of the list comes into view.
  useEffect(() => {
    const node = sentinel.current
    if (!node || !hasNextPage) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && !isFetchingNextPage) void fetchNextPage()
    }, { rootMargin: '240px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  const groups = useMemo(() => {
    const out: { day: string; items: TimelineEntry[] }[] = []
    for (const entry of query.data?.pages.flatMap((page) => page.items) ?? []) {
      const day = dayLabel(entry.at)
      const last = out.at(-1)
      if (last && last.day === day) last.items.push(entry)
      else out.push({ day, items: [entry] })
    }
    return out
  }, [query.data])

  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />
  if (query.isLoading) {
    return (
      <div className="grid max-w-3xl gap-3">
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} className="h-10" />
        ))}
      </div>
    )
  }
  if (groups.length === 0) {
    return <EmptyState illustration="audit" title="No events yet" description="Agent connections, software changes and warnings will appear here." />
  }

  return (
    <div className="grid max-w-3xl gap-6">
      {groups.map((group) => (
        <section key={group.day} aria-label={group.day}>
          <h3 className="eyebrow sticky top-0 z-[2] mb-3 bg-background/90 py-1 backdrop-blur">{group.day}</h3>
          <ol className="group/day">
            {group.items.map((entry) => (
              <TimelineRow key={entry.id} entry={entry} />
            ))}
          </ol>
        </section>
      ))}
      <div ref={sentinel} className="flex justify-center">
        {query.hasNextPage ? (
          <Button variant="outline" size="sm" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
            {query.isFetchingNextPage ? 'Loading…' : 'Load older events'}
          </Button>
        ) : (
          <span className="text-micro text-subtle-foreground">Beginning of this device&apos;s history</span>
        )}
      </div>
    </div>
  )
}
