/* Home: escrow coverage (BitLocker keys, LAPS rotations) and SNMP health at a glance. */
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Activity, HardDrive, KeyRound, Vault } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { escrowStatsQuery, snmpDevicesQuery } from '@/lib/api/queries'
import { formatNumber } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { cn } from '@/lib/utils'
import { useScopedSites } from '@/features/network/use-network'

function Row({ icon, label, value, detail, tone, to, search }: { icon: ReactNode; label: string; value: string; detail: ReactNode; tone: 'success' | 'warning' | 'critical' | 'neutral'; to: string; search?: Record<string, string> }) {
  return (
    <Link to={to} search={search} className="group grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-lg px-2 py-2 hover:bg-surface-2">
      <span className="flex size-7 items-center justify-center rounded-lg bg-surface-3 text-muted-foreground ring-1 ring-border [&_svg]:size-3.5">{icon}</span>
      <span className="min-w-0">
        <span className="block truncate text-dense font-medium">{label}</span>
        <span className="block truncate text-micro text-subtle-foreground">{detail}</span>
      </span>
      <span className={cn('tabular text-sm font-semibold', tone === 'success' ? 'text-success' : tone === 'warning' ? 'text-warning' : tone === 'critical' ? 'text-critical' : 'text-foreground')}>{value}</span>
    </Link>
  )
}

export function SecurityNetworkCard() {
  const me = useMe()
  const canEscrow = hasPermission(me, PERMISSIONS.secretsManage)
  const canNetwork = hasPermission(me, PERMISSIONS.networkView)
  const stats = useQuery({ ...escrowStatsQuery, enabled: canEscrow, meta: { silent: true } })
  const devices = useQuery({ ...snmpDevicesQuery(), enabled: canNetwork, meta: { silent: true } })
  const { byId } = useScopedSites()
  if (!canEscrow && !canNetwork) return null
  const snmp = (devices.data ?? []).filter((device) => byId.has(device.site_id) && device.enabled)
  const unreachable = snmp.filter((device) => device.status === 'unreachable').length
  const alerting = snmp.filter((device) => device.status === 'alerting').length
  const bitlocker = stats.data ? (stats.data.bitlocker.encrypted_devices ? Math.round((stats.data.bitlocker.escrowed / stats.data.bitlocker.encrypted_devices) * 100) : null) : undefined
  return (
    <Card className="gap-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Vault className="size-4 text-subtle-foreground" />
          Security &amp; network
        </CardTitle>
        <CardDescription>Escrow coverage and SNMP monitoring</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-0.5 px-2">
        {canEscrow &&
          (stats.isLoading ? (
            <Skeleton className="mx-2 h-20" />
          ) : stats.data ? (
            <>
              <Row
                icon={<HardDrive />}
                label="BitLocker keys escrowed"
                value={bitlocker == null ? '—' : `${bitlocker}%`}
                tone={stats.data.bitlocker.missing.length ? 'warning' : 'success'}
                detail={stats.data.bitlocker.missing.length ? `${stats.data.bitlocker.missing.length} encrypted ${stats.data.bitlocker.missing.length === 1 ? 'device' : 'devices'} without a key` : 'Every encrypted device covered'}
                to="/secrets"
                search={{ kind: 'bitlocker' }}
              />
              <Row
                icon={<KeyRound />}
                label="LAPS rotations"
                value={`${formatNumber(stats.data.laps.rotated_within_policy)}/${formatNumber(stats.data.laps.enabled_devices)}`}
                tone={stats.data.laps.overdue.length ? 'warning' : 'success'}
                detail={stats.data.laps.overdue.length ? `${stats.data.laps.overdue.length} overdue` : stats.data.laps.enabled_devices ? 'All within policy' : 'Not enabled by any policy'}
                to="/secrets"
                search={{ kind: 'laps' }}
              />
            </>
          ) : null)}
        {canNetwork && (
          <Row
            icon={<Activity />}
            label="SNMP devices"
            value={formatNumber(snmp.length)}
            tone={unreachable ? 'critical' : alerting ? 'warning' : 'neutral'}
            detail={unreachable || alerting ? `${unreachable} unreachable · ${alerting} alerting` : snmp.length ? 'All answering' : 'None monitored yet'}
            to="/network/snmp"
            search={unreachable ? { status: 'unreachable' } : alerting ? { status: 'alerting' } : undefined}
          />
        )}
      </CardContent>
    </Card>
  )
}
