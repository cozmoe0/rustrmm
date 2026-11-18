import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Ban, CalendarClock, Check, ExternalLink, HardDriveDownload, RotateCcw, RotateCw, Sparkles } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { CopyButton } from '@/components/common/copy-button'
import { ErrorState, KeyValue, Mono, RelativeTime } from '@/components/common/misc'
import { patchQuery, patchRulesQuery } from '@/lib/api/queries'
import type { DevicePatchState, Patch, PatchDecision } from '@/lib/api/types'
import { describeApproval, formatRingDelays, matchingRule, ringSchedule } from '@/lib/patching/approval'
import { PLATFORM_LABEL, RING_LABEL, isMissingState } from '@/lib/patching/labels'
import { formatBytes, formatDate, formatNumber } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { cn } from '@/lib/utils'
import { SearchField } from '@/features/devices/remote-ui'
import { DecisionDialog } from './decision-dialog'
import { ApprovalBadge, ClassificationLabel, FilterPill, PatchStateBadge, PlatformMark, SeverityPill } from './patching-ui'

type StateFilter = 'all' | 'missing' | 'failed' | 'restart' | 'installed'

const FILTER_MATCH: Record<StateFilter, (state: DevicePatchState) => boolean> = {
  all: () => true,
  missing: (state) => isMissingState(state) && state !== 'failed',
  failed: (state) => state === 'failed',
  restart: (state) => state === 'pending_reboot',
  installed: (state) => state === 'installed' || state === 'superseded',
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-surface-2 px-3 py-2 ring-1 ring-border">
      <div className="truncate text-micro text-subtle-foreground">{label}</div>
      <div className={cn('font-display tabular text-lg leading-tight font-semibold', tone)}>{formatNumber(value)}</div>
    </div>
  )
}

/** Matching approval rules by policy, with the date each ring may install. */
function RingSchedule({ patch }: { patch: Patch }) {
  const { data: rules } = useQuery(patchRulesQuery)
  const byPolicy = useMemo(() => {
    const groups = new Map<string, { name: string; rules: NonNullable<typeof rules> }>()
    for (const rule of rules ?? []) {
      const entry = groups.get(rule.policy_id) ?? { name: rule.policy_name, rules: [] }
      entry.rules.push(rule)
      groups.set(rule.policy_id, entry)
    }
    return [...groups.entries()]
      .map(([policyId, entry]) => ({ policyId, name: entry.name, rule: matchingRule(entry.rules, patch) }))
      .filter((entry) => entry.rule)
  }, [rules, patch])
  if (byPolicy.length === 0)
    return <p className="text-dense text-muted-foreground">No approval rule matches this update, so it needs a manual decision.</p>
  return (
    <ul className="grid grid-cols-1 gap-2">
      {byPolicy.map(({ policyId, name, rule }) => (
        <li key={policyId} className="rounded-lg bg-surface-2/70 p-3 ring-1 ring-border">
          <div className="mb-2 flex items-center justify-between gap-2">
            <Link to="/automation/policies/$policyId" params={{ policyId }} search={{ tab: 'patching' }} className="truncate text-dense font-medium hover:underline">
              {name}
            </Link>
            <span className="tabular shrink-0 text-micro text-subtle-foreground">{formatRingDelays(rule!.delay_days)}</span>
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {ringSchedule(patch, rule!.delay_days).map((ring) => (
              <div key={ring.ring} className={cn('rounded-md px-2 py-1.5 ring-1', ring.available ? 'bg-success/[0.07] ring-success/25' : 'bg-surface-1 ring-border')}>
                <div className="text-micro text-subtle-foreground">{RING_LABEL[ring.ring]}</div>
                <div className={cn('tabular text-dense font-medium', ring.available ? 'text-success' : 'text-foreground')}>
                  {ring.available ? 'Available' : formatDate(ring.at)}
                </div>
              </div>
            ))}
          </div>
        </li>
      ))}
    </ul>
  )
}

/** Details of one patch: description, CVEs, approval, ring schedule and its state on every device. */
export function PatchDrawer({ patchId, listPatch, clientId, onClose }: { patchId: string | null; listPatch?: Patch; clientId?: string; onClose: () => void }) {
  const me = useMe()
  const canApprove = hasPermission(me, PERMISSIONS.patchesApprove)
  const { data, isLoading, error, refetch } = useQuery({ ...patchQuery(patchId ?? ''), enabled: Boolean(patchId) })
  const [filter, setFilter] = useState<StateFilter>('all')
  const [query, setQuery] = useState('')
  const [deciding, setDeciding] = useState<PatchDecision | null>(null)
  // The list row carries the decision for the scoped client; the detail always shows the global one.
  const patch = data?.patch ? { ...data.patch, approval: listPatch?.id === data.patch.id ? listPatch.approval : data.patch.approval } : listPatch
  const devices = useMemo(() => data?.devices ?? [], [data])
  const counts = useMemo(() => {
    const out: Record<StateFilter, number> = { all: devices.length, missing: 0, failed: 0, restart: 0, installed: 0 }
    for (const device of devices) for (const key of ['missing', 'failed', 'restart', 'installed'] as StateFilter[]) if (FILTER_MATCH[key](device.state)) out[key] += 1
    return out
  }, [devices])
  const needle = query.trim().toLowerCase()
  const visible = devices
    .filter((device) => FILTER_MATCH[filter](device.state))
    .filter((device) => !needle || `${device.hostname} ${device.client_name}`.toLowerCase().includes(needle))
    .sort((a, b) => a.hostname.localeCompare(b.hostname))
  const approval = patch ? describeApproval(patch.approval) : null

  return (
    <Sheet
      open={Boolean(patchId)}
      onOpenChange={(next) => {
        if (!next) {
          onClose()
          setFilter('all')
          setQuery('')
        }
      }}
    >
      <SheetContent side="right" className="gap-0 p-0 shadow-popover data-[side=right]:w-full data-[side=right]:sm:max-w-[720px]">
        <SheetHeader className="gap-3 border-b border-border px-5 pt-5 pb-4">
          <div className="flex items-start gap-3 pr-8">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 shadow-raised ring-1 ring-border">
              {patch ? <PlatformMark platform={patch.platform} label={false} className="[&_svg]:size-4.5" /> : null}
            </span>
            <div className="min-w-0">
              <SheetTitle className="text-base leading-snug">{patch?.title ?? 'Update'}</SheetTitle>
              <SheetDescription className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                {patch?.kb && <Mono>{patch.kb}</Mono>}
                {patch && <span>{PLATFORM_LABEL[patch.platform]}</span>}
                {patch?.reboot_required && (
                  <span className="inline-flex items-center gap-1">
                    <RotateCw className="size-3" /> Restart required
                  </span>
                )}
              </SheetDescription>
            </div>
          </div>
          {patch && (
            <div className="flex flex-wrap items-center gap-2">
              <SeverityPill severity={patch.severity} />
              <span className="text-subtle-foreground">·</span>
              <ClassificationLabel platform={patch.platform} classification={patch.classification} />
              <span className="text-subtle-foreground">·</span>
              <ApprovalBadge approval={patch.approval} />
            </div>
          )}
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {error ? (
            <div className="p-5">
              <ErrorState error={error} onRetry={() => void refetch()} />
            </div>
          ) : !patch ? (
            <div className="grid gap-3 p-5">
              <Skeleton className="h-16 rounded-lg" />
              <Skeleton className="h-40 rounded-lg" />
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-5 p-5">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="Missing" value={patch.devices.missing} tone={patch.devices.missing ? 'text-warning' : undefined} />
                <Stat label="Failed" value={patch.devices.failed} tone={patch.devices.failed ? 'text-critical' : undefined} />
                <Stat label="Restart pending" value={patch.devices.pending_reboot} tone={patch.devices.pending_reboot ? 'text-info' : undefined} />
                <Stat label="Installed" value={patch.devices.installed} tone="text-success" />
              </div>

              <section className="grid grid-cols-1 gap-3 rounded-xl bg-card p-4 shadow-card">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold">Approval</h3>
                    <p className="mt-0.5 text-dense text-muted-foreground">{approval?.detail}</p>
                    {!clientId && patch.approval.status === 'none' && (
                      <p className="mt-1 text-micro text-subtle-foreground">
                        Rule approvals are recorded per client. Choose a client in the scope switcher to see them.
                      </p>
                    )}
                  </div>
                  {approval?.source === 'rule' && (
                    <Badge variant="default">
                      <Sparkles />
                      By rule
                    </Badge>
                  )}
                </div>
                {canApprove && (
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" variant="outline" onClick={() => setDeciding('approved')}>
                      <Check data-icon="inline-start" />
                      Approve
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setDeciding('declined')}>
                      <Ban data-icon="inline-start" />
                      Decline
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setDeciding('deferred')}>
                      <CalendarClock data-icon="inline-start" />
                      Defer…
                    </Button>
                    {patch.approval.status !== 'none' && (
                      <Button size="sm" variant="ghost" onClick={() => setDeciding('none')}>
                        <RotateCcw data-icon="inline-start" />
                        Reset
                      </Button>
                    )}
                  </div>
                )}
                <div className="border-t border-border pt-3">
                  <div className="eyebrow mb-2">Approval rules that match</div>
                  <RingSchedule patch={patch} />
                </div>
              </section>

              <section className="grid grid-cols-1 gap-2">
                <h3 className="text-sm font-semibold">Details</h3>
                <p className="text-dense leading-relaxed text-secondary-foreground">{patch.description || 'No description.'}</p>
                <dl className="mt-1">
                  <KeyValue label="Released">{patch.release_date ? formatDate(patch.release_date) : <span className="text-subtle-foreground">Not stated</span>}</KeyValue>
                  <KeyValue label="First seen">
                    <RelativeTime value={patch.first_seen_at} />
                  </KeyValue>
                  <KeyValue label="Size">
                    <span className="inline-flex items-center gap-1.5">
                      <HardDriveDownload className="size-3.5 text-subtle-foreground" />
                      {patch.size_bytes ? formatBytes(patch.size_bytes) : '—'}
                    </span>
                  </KeyValue>
                  <KeyValue label="Key">
                    <span className="inline-flex max-w-full items-center gap-1">
                      <Mono truncate={18}>{patch.key}</Mono>
                      <CopyButton value={patch.key} label="Copy key" />
                    </span>
                  </KeyValue>
                  {patch.support_url && (
                    <KeyValue label="Support">
                      <a href={patch.support_url} target="_blank" rel="noreferrer noopener" className="inline-flex max-w-full items-center gap-1 text-primary hover:underline">
                        <span className="truncate">{patch.support_url.replace(/^https?:\/\//, '')}</span>
                        <ExternalLink className="size-3 shrink-0" />
                      </a>
                    </KeyValue>
                  )}
                </dl>
                {patch.cves.length > 0 && (
                  <div className="mt-1">
                    <div className="eyebrow mb-1.5">{patch.cves.length} CVEs</div>
                    <div className="flex flex-wrap gap-1">
                      {patch.cves.map((cve) => (
                        <a
                          key={cve}
                          href={`https://www.cve.org/CVERecord?id=${cve}`}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="inline-flex h-6 items-center rounded-md bg-surface-2 px-2 font-mono text-[11px] text-secondary-foreground ring-1 ring-border hover:bg-surface-3 hover:text-foreground"
                        >
                          {cve}
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </section>

              <section className="grid grid-cols-1 gap-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">Devices</h3>
                  <SearchField value={query} onChange={setQuery} placeholder="Search devices…" label="Search devices" className="sm:w-56" />
                </div>
                <div className="flex flex-wrap gap-1">
                  {(['all', 'missing', 'failed', 'restart', 'installed'] as StateFilter[]).map((key) => (
                    <FilterPill key={key} active={filter === key} onClick={() => setFilter(key)} count={counts[key]} disabled={key !== 'all' && counts[key] === 0}>
                      {{ all: 'All', missing: 'Missing', failed: 'Failed', restart: 'Restart pending', installed: 'Installed' }[key]}
                    </FilterPill>
                  ))}
                </div>
                {isLoading ? (
                  <Skeleton className="h-40 rounded-lg" />
                ) : visible.length === 0 ? (
                  <p className="rounded-lg bg-surface-2 px-4 py-6 text-center text-dense text-muted-foreground ring-1 ring-border">No devices match.</p>
                ) : (
                  <ul className="divide-y divide-border overflow-hidden rounded-xl bg-card shadow-card">
                    {visible.map((device) => (
                      <li key={device.device_id}>
                        <Link
                          to="/devices/$deviceId"
                          params={{ deviceId: device.device_id }}
                          search={{ tab: 'patches' }}
                          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2.5 outline-none hover:bg-surface-2 focus-visible:bg-surface-2"
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-dense font-medium">{device.hostname}</span>
                            <span className="block truncate text-micro text-subtle-foreground">
                              {device.client_name}
                              {device.installed_at ? ` · installed ${formatDate(device.installed_at)}` : device.detected_at ? ` · detected ${formatDate(device.detected_at)}` : ''}
                            </span>
                          </span>
                          <PatchStateBadge state={device.state} />
                          {device.last_error && <span className="col-span-2 truncate font-mono text-[11px] text-critical/90" title={device.last_error}>{device.last_error}</span>}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}
        </div>
      </SheetContent>
      {patch && deciding && (
        <DecisionDialog
          key={`${patch.id}-${deciding}`}
          open
          onOpenChange={(open) => !open && setDeciding(null)}
          target={{ ids: [patch.id], label: patch.title }}
          initialDecision={deciding}
          defaultClientId={clientId}
        />
      )}
    </Sheet>
  )
}
