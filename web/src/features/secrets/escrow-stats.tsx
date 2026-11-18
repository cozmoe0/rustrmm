/* Escrow coverage (`GET /escrow/stats`): BitLocker keys escrowed vs encrypted devices, LAPS rotations within policy. */
import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ChevronDown, HardDrive, KeyRound } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorState } from '@/components/common/misc'
import { escrowStatsQuery } from '@/lib/api/queries'
import type { EscrowStatsDevice } from '@/lib/api/types'
import { formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'

function pct(part: number, whole: number) {
  return whole === 0 ? null : Math.round((part / whole) * 1000) / 10
}

function CoverageBar({ value, tone }: { value: number | null; tone: 'success' | 'warning' | 'critical' }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3" role="img" aria-label={value === null ? 'No devices' : `${value}%`}>
      <div
        className={cn('h-full rounded-full transition-[width] duration-700', tone === 'success' ? 'bg-success' : tone === 'warning' ? 'bg-warning' : 'bg-critical')}
        style={{ width: `${value ?? 0}%` }}
      />
    </div>
  )
}

function DeviceList({ devices, empty, verb }: { devices: EscrowStatsDevice[]; empty: string; verb: string }) {
  const [open, setOpen] = useState(false)
  if (devices.length === 0) return <p className="text-micro text-success">{empty}</p>
  const shown = open ? devices : devices.slice(0, 4)
  return (
    <div className="grid gap-1">
      <p className="text-micro text-muted-foreground">
        {formatNumber(devices.length)} {devices.length === 1 ? 'device' : 'devices'} {verb}
      </p>
      <ul className="grid gap-px">
        {shown.map((device) => (
          <li key={device.id}>
            <Link
              to="/devices/$deviceId"
              params={{ deviceId: device.id }}
              search={{ tab: 'secrets' }}
              className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-dense hover:bg-surface-3"
            >
              <span className="truncate font-medium">{device.hostname}</span>
              <span className="ml-auto truncate text-micro text-subtle-foreground">{device.client_name}</span>
            </Link>
          </li>
        ))}
      </ul>
      {devices.length > 4 && (
        <button type="button" onClick={() => setOpen(!open)} className="inline-flex w-fit items-center gap-1 rounded-sm px-1.5 text-micro text-muted-foreground hover:text-foreground">
          <ChevronDown className={cn('size-3 transition-transform', open && 'rotate-180')} />
          {open ? 'Show fewer' : `Show all ${devices.length}`}
        </button>
      )}
    </div>
  )
}

function Panel({ icon, title, value, sub, bar, children }: { icon: ReactNode; title: string; value: string; sub: string; bar: ReactNode; children: ReactNode }) {
  return (
    <section className="grid min-w-0 content-start gap-3 rounded-xl bg-card p-4 shadow-card">
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-muted-foreground ring-1 ring-border [&_svg]:size-4">{icon}</span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          <p className="text-micro text-muted-foreground">{sub}</p>
        </div>
        <span className="font-display tabular text-[26px] leading-none font-semibold tracking-tight">{value}</span>
      </div>
      {bar}
      {children}
    </section>
  )
}

export function EscrowCoverage() {
  const { data, isLoading, error, refetch } = useQuery(escrowStatsQuery)
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} title="Could not load escrow coverage" />
  if (isLoading || !data) {
    return (
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    )
  }
  const bitlocker = pct(data.bitlocker.escrowed, data.bitlocker.encrypted_devices)
  const laps = pct(data.laps.rotated_within_policy, data.laps.enabled_devices)
  const toneFor = (value: number | null) => (value === null || value >= 98 ? 'success' : value >= 85 ? 'warning' : 'critical')
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Panel
        icon={<HardDrive />}
        title="BitLocker escrow"
        sub={`${formatNumber(data.bitlocker.escrowed)} of ${formatNumber(data.bitlocker.encrypted_devices)} encrypted Windows devices have a recovery key here`}
        value={bitlocker === null ? '—' : `${bitlocker}%`}
        bar={<CoverageBar value={bitlocker} tone={toneFor(bitlocker)} />}
      >
        <DeviceList devices={data.bitlocker.missing} empty="Every encrypted device has its recovery key escrowed." verb="encrypted without an escrowed key" />
      </Panel>
      <Panel
        icon={<KeyRound />}
        title="Local admin rotation"
        sub={`${formatNumber(data.laps.rotated_within_policy)} of ${formatNumber(data.laps.enabled_devices)} devices with LAPS rotated within their policy`}
        value={laps === null ? '—' : `${laps}%`}
        bar={<CoverageBar value={laps} tone={toneFor(laps)} />}
      >
        {data.laps.enabled_devices === 0 ? (
          <p className="text-micro text-muted-foreground">
            No device has LAPS enabled. Turn it on in a policy’s{' '}
            <Link to="/automation/policies" className="underline-offset-2 hover:underline">
              Secrets escrow
            </Link>{' '}
            section.
          </p>
        ) : (
          <DeviceList devices={data.laps.overdue} empty="Every password rotated on schedule." verb="overdue for rotation" />
        )}
      </Panel>
    </div>
  )
}
