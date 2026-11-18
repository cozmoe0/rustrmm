import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { Globe, Pencil, Satellite } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { DataTable } from '@/components/common/data-table'
import { ErrorState, RelativeTime } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { networkSettingsApi } from '@/lib/api/endpoints'
import { errorMessage } from '@/lib/api/errors'
import { networkKeys, networkSettingsQuery, probesQuery, scansQuery, snmpDevicesQuery } from '@/lib/api/queries'
import type { SiteProbe } from '@/lib/api/types'
import { formatNumber } from '@/lib/format'
import { PERMISSIONS, hasGlobalPermission, hasPermission, useMe } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { ProbeDialog } from './probe-dialog'
import { ProbeBadge, SectionCard } from './network-ui'
import { useScopedSites, type SiteOption } from './use-network'

interface Row {
  site: SiteOption
  probe: SiteProbe | undefined
  scans: number
  snmp: number
}

export function ProbesPage() {
  useTitle('Probes')
  const me = useMe()
  const queryClient = useQueryClient()
  const canManage = hasPermission(me, PERMISSIONS.networkManage)
  const canSettings = hasGlobalPermission(me, PERMISSIONS.networkManage)
  const { sites, isLoading: sitesLoading } = useScopedSites()
  const probes = useQuery(probesQuery)
  const scans = useQuery(scansQuery)
  const devices = useQuery(snmpDevicesQuery())
  const settings = useQuery(networkSettingsQuery)
  const [editing, setEditing] = useState<Row | null>(null)

  const updateSettings = useMutation({
    mutationFn: (allow: boolean) => networkSettingsApi.update({ allow_public_ranges: allow }),
    meta: { silent: true },
    onSuccess: (result) => {
      queryClient.setQueryData(networkKeys.settings, result)
      toast.success(result.allow_public_ranges ? 'Public ranges can now be scanned and monitored' : 'Scans and SNMP devices are limited to private ranges')
    },
    onError: (failure) => toast.error(errorMessage(failure)),
  })

  const rows = useMemo<Row[]>(
    () =>
      sites.map((site) => ({
        site,
        probe: probes.data?.find((probe) => probe.site_id === site.id),
        scans: scans.data?.filter((scan) => scan.site_id === site.id).length ?? 0,
        snmp: devices.data?.filter((device) => device.site_id === site.id).length ?? 0,
      })),
    [sites, probes.data, scans.data, devices.data],
  )
  const assigned = rows.filter((row) => row.probe?.device_id)
  const offline = assigned.filter((row) => !row.probe?.online)

  const columns = useMemo<ColumnDef<Row>[]>(
    () => [
      {
        id: 'site',
        accessorFn: (row) => `${row.site.client_name} ${row.site.name}`.toLowerCase(),
        header: 'Site',
        cell: ({ row }) => (
          <div className="min-w-0 leading-tight">
            <span className="block max-w-56 truncate font-medium">{row.original.site.name}</span>
            <span className="block max-w-56 truncate text-[10.5px] text-subtle-foreground">{row.original.site.client_name}</span>
          </div>
        ),
      },
      { id: 'probe', accessorFn: (row) => row.probe?.hostname ?? '', header: 'Probe', cell: ({ row }) => <ProbeBadge probe={row.original.probe} /> },
      {
        id: 'traps',
        accessorFn: (row) => (row.probe?.device_id && row.probe.trap_receiver ? 1 : 0),
        header: 'Trap receiver',
        cell: ({ row }) =>
          row.original.probe?.device_id ? (
            row.original.probe.trap_receiver ? (
              <Badge variant="live">On · UDP {row.original.probe.trap_port}</Badge>
            ) : (
              <span className="text-subtle-foreground">Off</span>
            )
          ) : (
            <span className="text-subtle-foreground">—</span>
          ),
      },
      { id: 'scans', accessorFn: (row) => row.scans, header: 'Scans', meta: { align: 'right' }, cell: ({ row }) => <span className="tabular">{formatNumber(row.original.scans)}</span> },
      { id: 'snmp', accessorFn: (row) => row.snmp, header: 'SNMP devices', meta: { align: 'right' }, cell: ({ row }) => <span className="tabular">{formatNumber(row.original.snmp)}</span> },
      {
        id: 'assigned',
        accessorFn: (row) => row.probe?.assigned_at ?? '',
        header: 'Assigned',
        cell: ({ row }) => (row.original.probe?.assigned_at ? <RelativeTime value={row.original.probe.assigned_at} className="text-muted-foreground" /> : <span className="text-subtle-foreground">—</span>),
      },
      {
        id: 'actions',
        header: '',
        enableSorting: false,
        meta: { align: 'right', className: 'w-28' },
        cell: ({ row }) =>
          canManage ? (
            <Button
              variant="outline"
              size="xs"
              onClick={(event) => {
                event.stopPropagation()
                setEditing(row.original)
              }}
            >
              {row.original.probe?.device_id ? <Pencil data-icon="inline-start" /> : <Satellite data-icon="inline-start" />}
              {row.original.probe?.device_id ? 'Change' : 'Assign'}
            </Button>
          ) : null,
      },
    ],
    [canManage],
  )

  return (
    <PageContainer className="grid grid-cols-1 gap-5">
      <PageHeader
        icon={<Satellite />}
        title="Probes"
        description={`One agent per site scans the network and polls SNMP devices. ${formatNumber(assigned.length)} of ${formatNumber(rows.length)} sites have a probe${offline.length ? `; ${offline.length} offline` : ''}.`}
      />

      <SectionCard
        icon={<Globe />}
        title="Public address ranges"
        description="By default, scans and SNMP devices are limited to private addresses (RFC 1918, 100.64.0.0/10 and 169.254.0.0/16). Turn this on only for networks you are allowed to probe."
        actions={
          <Switch
            checked={settings.data?.allow_public_ranges ?? false}
            disabled={!canSettings || settings.isLoading || updateSettings.isPending}
            aria-label="Allow public ranges"
            onCheckedChange={(checked) => updateSettings.mutate(checked)}
          />
        }
      >
        <p className="px-4 py-2.5 text-micro text-muted-foreground">
          {settings.data?.allow_public_ranges ? 'Public ranges are allowed. Scan editors still warn about them.' : 'Only private ranges are allowed.'}
          {!canSettings && ' Changing this needs the “Manage network” permission held globally.'}
          {canSettings && ' Changing it asks you to confirm your identity.'}
        </p>
      </SectionCard>

      {probes.error ? (
        <ErrorState error={probes.error} onRetry={() => void probes.refetch()} />
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          loading={sitesLoading || probes.isLoading}
          getRowId={(row) => row.site.id}
          onRowClick={canManage ? setEditing : undefined}
          initialSorting={[{ id: 'site', desc: false }]}
          caption="Sites and their probes"
        />
      )}
      <ProbeDialog site={editing?.site ?? null} probe={editing?.probe} open={Boolean(editing)} onOpenChange={(open) => !open && setEditing(null)} />
    </PageContainer>
  )
}
