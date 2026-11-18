import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Waypoints } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/misc'
import { OsIcon } from '@/components/common/os-icon'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { probesQuery, snmpDevicesQuery, topologyQuery } from '@/lib/api/queries'
import type { AssetType, OsFamily, TopologyNode } from '@/lib/api/types'
import { isAssetType } from '@/lib/network/assets'
import { layoutTopology, type PlacedNode } from '@/lib/network/topology'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { AssetTypeTile, ProbeBadge, SiteSelect, SnmpStatusDot } from './network-ui'
import { useScopedSites } from './use-network'

const NODE_WIDTH = 184
const NODE_HEIGHT = 30
const PAD = 16

function NodeBox({ placed, status, onOpen }: { placed: PlacedNode; status?: Parameters<typeof SnmpStatusDot>[0]['status']; onOpen: (node: TopologyNode) => void }) {
  const { node } = placed
  const type: AssetType = isAssetType(node.type) ? node.type : 'unknown'
  const probe = node.kind === 'probe'
  return (
    <button
      type="button"
      onClick={() => onOpen(node)}
      title={[node.label, node.ip, node.mac].filter(Boolean).join(' · ')}
      className={cn(
        'absolute flex items-center gap-2 rounded-lg bg-card px-1.5 text-left shadow-card ring-1 outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring',
        probe ? 'ring-primary/40' : node.kind === 'snmp' ? 'ring-info/30' : node.kind === 'neighbour' ? 'ring-border border-dashed' : 'ring-border',
      )}
      style={{ left: placed.x + PAD, top: placed.y + PAD, width: NODE_WIDTH, height: NODE_HEIGHT }}
    >
      {probe ? (
        <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/12 ring-1 ring-primary/25">
          <OsIcon family={(['windows', 'linux', 'macos'].includes(node.type ?? '') ? node.type : 'linux') as OsFamily} />
        </span>
      ) : (
        <AssetTypeTile type={type} size="sm" />
      )}
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-[11.5px] font-medium">{node.label}</span>
        {(node.ip || probe) && <span className="block truncate font-mono text-[9.5px] text-subtle-foreground">{probe ? 'probe' : node.ip}</span>}
      </span>
      {status && <SnmpStatusDot status={status} />}
    </button>
  )
}

export function TopologyPage({ siteId }: { siteId?: string }) {
  useTitle('Topology')
  const navigate = useNavigate()
  const { sites } = useScopedSites()
  const probes = useQuery(probesQuery)
  const snmp = useQuery(snmpDevicesQuery())
  const probeSites = sites.filter((site) => probes.data?.some((probe) => probe.site_id === site.id && probe.device_id))
  const selected = siteId ?? probeSites[0]?.id
  const topology = useQuery({ ...topologyQuery(selected ?? ''), enabled: Boolean(selected) })
  const layout = useMemo(() => (topology.data ? layoutTopology(topology.data, { nodeWidth: NODE_WIDTH }) : null), [topology.data])
  const probe = probes.data?.find((item) => item.site_id === selected)

  const open = (node: TopologyNode) => {
    if (node.snmp_device_id) void navigate({ to: '/network/snmp/$snmpDeviceId', params: { snmpDeviceId: node.snmp_device_id } })
    else if (node.kind === 'probe' && node.device_id) void navigate({ to: '/devices/$deviceId', params: { deviceId: node.device_id } })
    else if (node.asset_id) void navigate({ to: '/network/assets', search: { asset: node.asset_id, site_id: selected } })
  }

  return (
    <PageContainer className="grid grid-cols-1 gap-4">
      <PageHeader
        icon={<Waypoints />}
        title="Topology"
        description="Best effort: built from the probe’s ARP view and LLDP neighbours reported by SNMP devices. Click a node to open it."
      />
      <div className="flex flex-wrap items-center gap-3">
        <SiteSelect value={selected ?? ''} any={null} onChange={(value) => void navigate({ to: '/network/topology', search: { site_id: value } })} sites={probeSites.length ? probeSites : sites} />
        {selected && <ProbeBadge probe={probe} />}
        <span className="flex items-center gap-4 text-micro text-muted-foreground sm:ml-auto">
          <span className="flex items-center gap-1.5">
            <svg width="24" height="6" aria-hidden="true">
              <line x1="0" y1="3" x2="24" y2="3" stroke="var(--info)" strokeWidth="1.6" />
            </svg>
            LLDP link
          </span>
          <span className="flex items-center gap-1.5">
            <svg width="24" height="6" aria-hidden="true">
              <line x1="0" y1="3" x2="24" y2="3" stroke="var(--border-strong)" strokeWidth="1.4" strokeDasharray="3 3" />
            </svg>
            Seen by the probe (ARP)
          </span>
        </span>
      </div>
      {!selected ? (
        <EmptyState illustration="network" title="No probes yet" description="Assign a probe to a site and run a scan; the topology builds from what it sees." />
      ) : topology.error ? (
        <ErrorState error={topology.error} onRetry={() => void topology.refetch()} />
      ) : topology.isLoading || !layout ? (
        <Skeleton className="h-96 rounded-xl" />
      ) : layout.nodes.length <= 1 ? (
        <EmptyState illustration="network" title="Nothing mapped yet" description="Run a scan for this site so the probe can report what it sees." />
      ) : (
        <div className="overflow-x-auto rounded-xl bg-card shadow-card">
          <div className="bg-grid relative" style={{ width: layout.width + PAD * 2, height: layout.height + PAD * 2 }}>
            <svg className="absolute inset-0" width={layout.width + PAD * 2} height={layout.height + PAD * 2} aria-hidden="true">
              {layout.links.map((link) => {
                const x1 = link.from.x + PAD + NODE_WIDTH
                const y1 = link.from.y + PAD + NODE_HEIGHT / 2
                const x2 = link.to.x + PAD
                const y2 = link.to.y + PAD + NODE_HEIGHT / 2
                const mid = (x1 + x2) / 2
                return (
                  <g key={`${link.from.node.id}-${link.to.node.id}`}>
                    <path
                      d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                      fill="none"
                      stroke={link.kind === 'lldp' ? 'var(--info)' : 'var(--border-strong)'}
                      strokeWidth={link.kind === 'lldp' ? 1.6 : 1.2}
                      strokeDasharray={link.kind === 'lldp' ? undefined : '3 3'}
                    />
                    {link.localPort && (
                      <text x={x2 - 6} y={y2 - 5} textAnchor="end" className="fill-subtle-foreground font-mono text-[9px]">
                        {link.localPort}
                      </text>
                    )}
                  </g>
                )
              })}
            </svg>
            {layout.nodes.map((placed) => (
              <NodeBox key={placed.node.id} placed={placed} status={snmp.data?.find((device) => device.id === placed.node.snmp_device_id)?.status} onOpen={open} />
            ))}
          </div>
        </div>
      )}
    </PageContainer>
  )
}
