import { useQuery } from '@tanstack/react-query'
import { Layers, TriangleExclamationPoint } from 'lucide-react'
import { ContextGroup, ContextLink, ContextPanel } from '@/components/shell/context-panel'
import { EntityAvatar } from '@/components/common/misc'
import { clientsQuery } from '@/lib/api/queries'
import { formatNumber } from '@/lib/format'
import { useWorkspaceTabs } from '@/lib/workspace'

export function ClientsContextPanel() {
  const { data: clients = [] } = useQuery(clientsQuery())
  const tabs = useWorkspaceTabs().filter((tab) => tab.kind === 'client')
  const totals = clients.reduce(
    (sum, client) => ({ sites: sum.sites + client.site_count, devices: sum.devices + client.device_count }),
    { sites: 0, devices: 0 },
  )

  return (
    <ContextPanel
      section="clients"
      title="Clients"
      footer={
        <dl className="grid grid-cols-3 gap-2 text-center">
          {[
            ['Clients', clients.length],
            ['Sites', totals.sites],
            ['Devices', totals.devices],
          ].map(([label, value]) => (
            <div key={label} className="rounded-md bg-surface-2 py-1.5">
              <dd className="tabular text-dense font-semibold">{formatNumber(value as number)}</dd>
              <dt className="text-micro text-subtle-foreground">{label}</dt>
            </div>
          ))}
        </dl>
      }
    >
      <ContextGroup label="Views">
        <ContextLink to="/clients" icon={<Layers />} activeExact badge={<span className="tabular text-micro text-subtle-foreground">{clients.length}</span>}>
          All clients
        </ContextLink>
        <li>
          <span className="flex h-8 items-center gap-2.5 rounded-md px-2 text-dense text-subtle-foreground/80 [&_svg]:size-4">
            <TriangleExclamationPoint />
            Needs attention
            <span className="ml-auto text-micro">Phase 6</span>
          </span>
        </li>
      </ContextGroup>
      {tabs.length > 0 && (
        <ContextGroup label="Open in workspace">
          {tabs.map((tab) => (
            <ContextLink
              key={tab.id}
              to="/clients/$clientId"
              params={tab.params}
              icon={<EntityAvatar name={tab.title} seed={tab.params?.clientId} accent={tab.accent} size="xs" />}
            >
              {tab.title}
            </ContextLink>
          ))}
        </ContextGroup>
      )}
    </ContextPanel>
  )
}
