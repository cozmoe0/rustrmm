/* The device page's Software tab: deployments to this device, then the installed software with library actions. */
import { useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowUpCircle, Rocket, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { RelativeTime } from '@/components/common/misc'
import { deviceDeploymentsQuery, packagesQuery } from '@/lib/api/queries'
import type { DeviceDetail, InventoryResponse, SoftwareItem } from '@/lib/api/types'
import { compareVersions, findPackageFor } from '@/lib/software/detection'
import { canUninstall } from '@/lib/software/labels'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { cn } from '@/lib/utils'
import { SoftwareTab } from '@/features/devices/cockpit-inventory'
import { openDeployDialog } from './deploy-dialog-store'
import { ActionBadge, ResultBadge } from './software-ui'

function Deployments({ device, canDeploy }: { device: DeviceDetail; canDeploy: boolean }) {
  const { data = [], isLoading } = useQuery(deviceDeploymentsQuery(device.id))
  const recent = data.slice(0, 6)
  return (
    <section className="overflow-hidden rounded-xl bg-card shadow-card">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Rocket className="size-4 text-subtle-foreground" />
          Deployments to this device
          {data.length > 0 && <span className="tabular text-micro font-normal text-subtle-foreground">{data.length}</span>}
        </h3>
        {canDeploy && device.status === 'active' && (
          <Button size="xs" variant="outline" onClick={() => openDeployDialog({ target: { type: 'devices', ids: [device.id] } })}>
            <Rocket data-icon="inline-start" />
            Deploy software
          </Button>
        )}
      </header>
      {isLoading ? (
        <div className="grid gap-2 p-4">
          <Skeleton className="h-9 rounded-lg" />
          <Skeleton className="h-9 rounded-lg" />
        </div>
      ) : recent.length === 0 ? (
        <p className="px-4 py-4 text-dense text-muted-foreground">No software has been deployed to this device yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {recent.map((item) => (
            <li key={item.deployment_id}>
              <Link
                to="/software/deployments/$deploymentId"
                params={{ deploymentId: item.deployment_id }}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2.5 outline-none hover:bg-surface-2 focus-visible:bg-surface-2 sm:grid-cols-[minmax(0,1fr)_auto_7rem]"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <ActionBadge action={item.action} />
                  <span className="truncate text-dense font-medium">{item.package.name}</span>
                  {item.exit_code !== null && <span className={cn('font-mono text-[11px]', [0, 3010, 1641].includes(item.exit_code) ? 'text-subtle-foreground' : 'text-critical')}>exit {item.exit_code}</span>}
                </span>
                <ResultBadge status={item.status} />
                <span className="col-span-2 text-micro text-muted-foreground sm:col-span-1 sm:text-right">
                  <RelativeTime value={item.finished_at ?? item.created_at} />
                </span>
                {item.error && <span className="col-span-2 truncate font-mono text-[11px] text-muted-foreground sm:col-span-3" title={item.error}>{item.error}</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function DeviceSoftwareTab({ device, inventory, loading }: { device: DeviceDetail; inventory: InventoryResponse | undefined; loading: boolean }) {
  const me = useMe()
  const canView = hasPermission(me, PERMISSIONS.softwareView)
  const canDeploy = hasPermission(me, PERMISSIONS.softwareDeploy)
  const { data: packages = [] } = useQuery({ ...packagesQuery, enabled: canView })
  const active = device.status === 'active'

  const actions = useCallback(
    (item: SoftwareItem) => {
      const pkg = findPackageFor(packages, item, device.os_family)
      if (!pkg) return <span className="text-subtle-foreground">—</span>
      const min = pkg.detection.type === 'software_name' ? pkg.detection.min_version : undefined
      const outdated = Boolean(min && item.version && compareVersions(item.version, min) < 0)
      return (
        <span className="flex items-center justify-end gap-1">
          {outdated ? (
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" />}>
                <Badge variant="warning">Below {min}</Badge>
              </TooltipTrigger>
              <TooltipContent>The library package “{pkg.name}” expects {min} or later.</TooltipContent>
            </Tooltip>
          ) : (
            <Badge variant="secondary" className="max-w-36">
              <span className="truncate">{pkg.name}</span>
            </Badge>
          )}
          {canDeploy && active && outdated && (
            <Button size="icon-xs" variant="ghost" aria-label={`Update ${item.name}`} title="Deploy the library version" onClick={() => openDeployDialog({ packageId: pkg.id, action: 'install', target: { type: 'devices', ids: [device.id] } })}>
              <ArrowUpCircle />
            </Button>
          )}
          {canDeploy && active && canUninstall(pkg.source) && (
            <Button size="icon-xs" variant="ghost" aria-label={`Uninstall ${item.name}`} title={`Uninstall with “${pkg.name}”`} className="hover:text-critical" onClick={() => openDeployDialog({ packageId: pkg.id, action: 'uninstall', target: { type: 'devices', ids: [device.id] } })}>
              <Trash2 />
            </Button>
          )}
        </span>
      )
    },
    [packages, device.os_family, device.id, canDeploy, active],
  )

  return (
    <div className="grid grid-cols-1 gap-4 [&>*]:min-w-0">
      {canView && <Deployments device={device} canDeploy={canDeploy} />}
      <SoftwareTab device={device} inventory={inventory} loading={loading} actions={canView ? actions : undefined} />
    </div>
  )
}
