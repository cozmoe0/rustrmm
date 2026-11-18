import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Activity, Boxes, Gauge, RadioTower, Satellite, Sparkles } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { RelativeTime } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { assetsQuery, probesQuery, scansQuery, snmpDevicesQuery, snmpTrapsQuery } from '@/lib/api/queries'
import { formatNumber } from '@/lib/format'
import { ASSET_TYPE_LABEL, assetName } from '@/lib/network/assets'
import { trapName } from '@/lib/network/snmp'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { KpiTile } from '@/features/patching/patching-ui'
import { useNow } from '@/features/tickets/use-now'
import { AssetTypeTile, ProbeBadge, SectionCard, SnmpStatusBadge, SnmpStatusDot } from './network-ui'
import { useScopedSites } from './use-network'

const DAY = 86_400_000

export function NetworkOverviewPage() {
  useTitle('Network')
  const { sites, byId } = useScopedSites()
  const assets = useQuery(assetsQuery())
  const devices = useQuery(snmpDevicesQuery())
  const probes = useQuery(probesQuery)
  const scans = useQuery(scansQuery)
  const traps = useQuery(snmpTrapsQuery(undefined, 200))
  const now = useNow(60_000)

  const inScope = useMemo(() => {
    const visible = <T extends { site_id: string }>(list: T[] | undefined) => (list ?? []).filter((item) => byId.has(item.site_id))
    return { assets: visible(assets.data).filter((asset) => !asset.ignored), devices: visible(devices.data), probes: visible(probes.data), scans: visible(scans.data), traps: visible(traps.data) }
  }, [assets.data, devices.data, probes.data, scans.data, traps.data, byId])

  const unmanaged = inScope.assets.filter((asset) => !asset.managed_device_id && !asset.snmp_device_id)
  const fresh = unmanaged.filter((asset) => now - new Date(asset.first_seen_at).getTime() < 7 * DAY).sort((a, b) => b.first_seen_at.localeCompare(a.first_seen_at))
  const troubled = inScope.devices.filter((device) => device.enabled && (device.status === 'unreachable' || device.status === 'alerting'))
  const unreachable = troubled.filter((device) => device.status === 'unreachable').length
  const traps24 = inScope.traps.filter((trap) => now - new Date(trap.at).getTime() < DAY)
  const onlineProbes = inScope.probes.filter((probe) => probe.online).length
  const loading = assets.isLoading || devices.isLoading || probes.isLoading

  const rows = sites
    .map((site) => {
      const siteAssets = inScope.assets.filter((asset) => asset.site_id === site.id)
      const siteDevices = inScope.devices.filter((device) => device.site_id === site.id)
      const lastScan = inScope.scans
        .filter((scan) => scan.site_id === site.id && scan.last_run)
        .sort((a, b) => (b.last_run?.at ?? '').localeCompare(a.last_run?.at ?? ''))[0]
      return { site, probe: inScope.probes.find((probe) => probe.site_id === site.id), assets: siteAssets, devices: siteDevices, lastScan }
    })
    .filter((row) => row.probe || row.assets.length || row.devices.length || row.lastScan)

  return (
    <PageContainer className="grid grid-cols-1 gap-5">
      <PageHeader icon={<Gauge />} title="Network" description="What the site probes see: discovered assets, monitored SNMP devices and traps." />
      {loading ? (
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-[118px] rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <KpiTile label="Discovered assets" value={formatNumber(inScope.assets.length)} icon={<Boxes />} to="/network/assets" footer={`${formatNumber(unmanaged.length)} unmanaged`} />
          <KpiTile
            label="SNMP devices"
            value={formatNumber(inScope.devices.length)}
            icon={<Activity />}
            tone={unreachable ? 'critical' : troubled.length ? 'warning' : 'live'}
            to="/network/snmp"
            search={troubled.length ? { status: unreachable ? 'unreachable' : 'alerting' } : undefined}
            footer={troubled.length ? `${troubled.length - unreachable} alerting · ${unreachable} unreachable` : 'All answering'}
          />
          <KpiTile label="Traps (24 h)" value={formatNumber(traps24.length)} icon={<RadioTower />} to="/network/traps" footer={`${formatNumber(inScope.traps.length)} in the last week`} />
          <KpiTile
            label="Probes online"
            value={`${formatNumber(onlineProbes)}/${formatNumber(inScope.probes.length)}`}
            icon={<Satellite />}
            tone={onlineProbes < inScope.probes.length ? 'warning' : 'live'}
            to="/network/probes"
            footer={`${formatNumber(sites.length - inScope.probes.length)} sites without a probe`}
          />
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <SectionCard icon={<Satellite />} title="Sites" description="Probe, discovery and SNMP health per site.">
          {rows.length === 0 ? (
            <p className="px-4 py-6 text-dense text-muted-foreground">
              No site has a probe yet.{' '}
              <Link to="/network/probes" className="text-primary underline-offset-2 hover:underline">
                Assign one
              </Link>{' '}
              to start discovering.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-dense">
                <thead>
                  <tr className="text-left text-micro font-semibold tracking-[0.06em] text-subtle-foreground uppercase">
                    <th className="px-4 py-2">Site</th>
                    <th className="px-3 py-2">Probe</th>
                    <th className="px-3 py-2 text-right">Assets</th>
                    <th className="px-3 py-2">SNMP</th>
                    <th className="px-4 py-2">Last scan</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const bad = row.devices.filter((device) => device.enabled && device.status !== 'ok' && device.status !== 'pending')
                    return (
                      <tr key={row.site.id} className="border-t border-border">
                        <td className="px-4 py-2.5">
                          <Link to="/network/assets" search={{ site_id: row.site.id }} className="block max-w-52 truncate font-medium hover:underline">
                            {row.site.name}
                          </Link>
                          <span className="block max-w-52 truncate text-[10.5px] text-subtle-foreground">{row.site.client_name}</span>
                        </td>
                        <td className="px-3 py-2.5">
                          <ProbeBadge probe={row.probe} />
                        </td>
                        <td className="tabular px-3 py-2.5 text-right">
                          {formatNumber(row.assets.length)}
                          <span className="text-micro text-subtle-foreground"> · {formatNumber(row.assets.filter((asset) => !asset.managed_device_id).length)} unmanaged</span>
                        </td>
                        <td className="px-3 py-2.5">
                          {row.devices.length === 0 ? (
                            <span className="text-subtle-foreground">—</span>
                          ) : (
                            <Link to="/network/snmp" search={{ site_id: row.site.id }} className="inline-flex items-center gap-1.5 hover:underline">
                              <span className="flex -space-x-0.5">
                                {row.devices.slice(0, 8).map((device) => (
                                  <SnmpStatusDot key={device.id} status={device.status} enabled={device.enabled} />
                                ))}
                              </span>
                              <span className={cn('tabular', bad.length ? 'text-warning' : 'text-muted-foreground')}>{bad.length ? `${bad.length} need attention` : `${row.devices.length} OK`}</span>
                            </Link>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">
                          {row.lastScan?.last_run ? (
                            <span>
                              {row.lastScan.last_run.status === 'running' ? <span className="text-live">Scanning now</span> : <RelativeTime value={row.lastScan.last_run.at} />}
                              {row.lastScan.last_run.status === 'failed' && <span className="text-critical"> · failed</span>}
                              {row.lastScan.last_run.status === 'succeeded' && <span className="text-subtle-foreground"> · {row.lastScan.last_run.hosts_found} hosts</span>}
                            </span>
                          ) : (
                            <span className="text-subtle-foreground">Never</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>

        <div className="grid content-start gap-5">
          <SectionCard icon={<Activity />} title="Needs attention" description="SNMP devices that are alerting or not answering.">
            {troubled.length === 0 ? (
              <p className="px-4 py-4 text-dense text-success">Every monitored device is answering within its thresholds.</p>
            ) : (
              <ul className="divide-y divide-border">
                {troubled.map((device) => (
                  <li key={device.id}>
                    <Link to="/network/snmp/$snmpDeviceId" params={{ snmpDeviceId: device.id }} className="flex min-w-0 items-center gap-2.5 px-4 py-2.5 hover:bg-surface-2">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-dense font-medium">{device.name}</span>
                        <span className="block truncate text-micro text-subtle-foreground">{byId.get(device.site_id)?.client_name ?? device.site_name}</span>
                      </span>
                      <SnmpStatusBadge status={device.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
          <SectionCard icon={<Sparkles />} title="New on the network" description="Unmanaged assets first seen in the last 7 days.">
            {fresh.length === 0 ? (
              <p className="px-4 py-4 text-dense text-muted-foreground">Nothing new this week.</p>
            ) : (
              <ul className="divide-y divide-border">
                {fresh.slice(0, 6).map((asset) => (
                  <li key={asset.id}>
                    <Link to="/network/assets" search={{ asset: asset.id }} className="flex min-w-0 items-center gap-2.5 px-4 py-2 hover:bg-surface-2">
                      <AssetTypeTile type={asset.type_guess} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-dense font-medium">{assetName(asset)}</span>
                        <span className="block truncate text-micro text-subtle-foreground">
                          {asset.ip} · {asset.vendor ?? ASSET_TYPE_LABEL[asset.type_guess]}
                        </span>
                      </span>
                      <RelativeTime value={asset.first_seen_at} className="shrink-0 text-micro text-subtle-foreground" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
          <SectionCard icon={<RadioTower />} title="Recent traps" actions={<Link to="/network/traps" className="text-micro text-muted-foreground hover:text-foreground">All traps</Link>}>
            {inScope.traps.length === 0 ? (
              <p className="px-4 py-4 text-dense text-muted-foreground">No traps received.</p>
            ) : (
              <ul className="divide-y divide-border">
                {inScope.traps.slice(0, 5).map((trap) => (
                  <li key={trap.id} className="flex min-w-0 items-center gap-2.5 px-4 py-2 text-dense">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{trapName(trap.oid) ?? trap.oid}</span>
                      <span className="block truncate text-micro text-subtle-foreground">{trap.snmp_device_name ?? trap.from_ip}</span>
                    </span>
                    <RelativeTime value={trap.at} className="shrink-0 text-micro text-subtle-foreground" />
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>
      </div>
    </PageContainer>
  )
}
