import { useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { Ban, CalendarClock, Check, ChevronDown, CircleX, Info, RotateCcw, RotateCw, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { DataTable } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/simple-select'
import { clientsQuery, patchesQuery } from '@/lib/api/queries'
import type { Patch, PatchApprovalStatus, PatchDecision, PatchPlatform, PatchSeverity } from '@/lib/api/types'
import { APPROVAL_LABEL, APPROVAL_ORDER, PLATFORM_LABEL, PLATFORM_ORDER, SEVERITY_ORDER, SEVERITY_RANK, classificationLabel, daysBetween } from '@/lib/patching/labels'
import { formatDate, formatNumber } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useScope } from '@/lib/scope'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { SearchField } from '@/features/devices/remote-ui'
import { SEGMENTED } from '@/features/automation/styles'
import { DecisionDialog } from './decision-dialog'
import { PatchDrawer } from './patch-drawer'
import { ApprovalBadge, ClassificationLabel, PlatformMark, SeverityPill } from './patching-ui'

export interface UpdatesSearch {
  q?: string
  platform?: PatchPlatform
  classification?: string
  severity?: PatchSeverity | 'none'
  approval?: PatchApprovalStatus
  /** `any` includes installed updates; the default lists updates missing somewhere. */
  status?: 'any'
  /** Quick filters from the overview: updates with failed installs or waiting for restarts. */
  health?: 'failed' | 'restart'
  /** The update shown in the drawer. */
  patch?: string
  client?: string
  site?: string
}

type FacetKey = 'platform' | 'classification' | 'severity' | 'approval' | 'health'

function matches(patch: Patch, search: UpdatesSearch, skip?: FacetKey): boolean {
  if (skip !== 'platform' && search.platform && patch.platform !== search.platform) return false
  if (skip !== 'classification' && search.classification && patch.classification !== search.classification) return false
  if (skip !== 'severity' && search.severity && (search.severity === 'none' ? patch.severity !== null : patch.severity !== search.severity)) return false
  if (skip !== 'approval' && search.approval && patch.approval.status !== search.approval) return false
  if (skip !== 'health' && search.health === 'failed' && patch.devices.failed === 0) return false
  if (skip !== 'health' && search.health === 'restart' && patch.devices.pending_reboot === 0) return false
  const needle = search.q?.trim().toLowerCase()
  if (needle && !`${patch.title} ${patch.kb ?? ''} ${patch.key} ${patch.cves.join(' ')}`.toLowerCase().includes(needle)) return false
  return true
}

function FacetMenu<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T | undefined
  options: { value: T; label: string; count: number; icon?: ReactNode }[]
  onChange: (value: T | undefined) => void
}) {
  const current = options.find((option) => option.value === value)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" size="sm" className={cn('shrink-0', current && 'border-primary/40 bg-primary/[0.06] text-foreground')} />}
      >
        <span className="text-muted-foreground">{label}</span>
        {current && <span className="max-w-32 truncate font-medium">{current.label}</span>}
        <ChevronDown className="text-subtle-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          <DropdownMenuCheckboxItem checked={!value} onCheckedChange={() => onChange(undefined)}>
            Any
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          {options.map((option) => (
            <DropdownMenuCheckboxItem
              key={option.value}
              checked={option.value === value}
              disabled={option.count === 0 && option.value !== value}
              onCheckedChange={() => onChange(option.value === value ? undefined : option.value)}
            >
              {option.icon}
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              <span className="tabular text-micro text-subtle-foreground">{formatNumber(option.count)}</span>
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function UpdatesPage({ search }: { search: UpdatesSearch }) {
  useTitle('Updates')
  const navigate = useNavigate()
  const me = useMe()
  const canApprove = hasPermission(me, PERMISSIONS.patchesApprove)
  const { clientId, setClient } = useScope()
  const { data: clients = [] } = useQuery(clientsQuery())
  const { data, isLoading, error, refetch } = useQuery(patchesQuery({ status: search.status === 'any' ? 'any' : 'missing', client_id: clientId }))
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [deciding, setDeciding] = useState<PatchDecision | null>(null)
  const all = useMemo(() => data ?? [], [data])
  const filtered = useMemo(() => all.filter((patch) => matches(patch, search)), [all, search])
  const selectedPatches = useMemo(() => filtered.filter((patch) => selected.has(patch.id)), [filtered, selected])
  const clientName = clients.find((client) => client.id === clientId)?.name

  const setSearch = (patch: Partial<UpdatesSearch>) =>
    void navigate({ from: '/patching/updates', to: '/patching/updates', search: (prev) => ({ ...prev, ...patch }), replace: true })

  const facet = <T extends string>(key: FacetKey, values: readonly T[], value: (patch: Patch) => string | null, label: (value: T) => string, icon?: (value: T) => ReactNode) => {
    const base = all.filter((patch) => matches(patch, search, key))
    return values
      .map((option) => ({ value: option, label: label(option), count: base.filter((patch) => value(patch) === option).length, icon: icon?.(option) }))
      .filter((option) => option.count > 0 || search[key] === option.value)
  }
  const classifications = [...new Set(all.map((patch) => `${patch.platform}|${patch.classification}`))]
    .map((entry) => entry.split('|') as [PatchPlatform, string])
    .reduce<{ value: string; label: string }[]>((out, [platform, classification]) => {
      if (!out.some((item) => item.value === classification)) out.push({ value: classification, label: classificationLabel(platform, classification) })
      return out
    }, [])
    .sort((a, b) => a.label.localeCompare(b.label))

  const toggleRow = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const columns = useMemo<ColumnDef<Patch>[]>(() => {
    const allSelected = filtered.length > 0 && filtered.every((patch) => selected.has(patch.id))
    const someSelected = !allSelected && filtered.some((patch) => selected.has(patch.id))
    const defs: ColumnDef<Patch>[] = []
    if (canApprove) {
      defs.push({
        id: 'select',
        enableSorting: false,
        size: 40,
        meta: { className: 'w-10 pr-0', headerClassName: 'w-10 pr-0' },
        header: () => (
          <Checkbox
            aria-label={allSelected ? 'Clear selection' : 'Select all visible updates'}
            checked={allSelected}
            indeterminate={someSelected}
            onCheckedChange={() => setSelected(allSelected ? new Set() : new Set(filtered.map((patch) => patch.id)))}
          />
        ),
        cell: ({ row }) => (
          <span className="flex" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
            <Checkbox aria-label={`Select ${row.original.title}`} checked={selected.has(row.original.id)} onCheckedChange={() => toggleRow(row.original.id)} />
          </span>
        ),
      })
    }
    defs.push(
      {
        id: 'title',
        accessorFn: (patch) => patch.title.toLowerCase(),
        header: 'Update',
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-2.5">
            <PlatformMark platform={row.original.platform} label={false} />
            <div className="min-w-0 leading-tight">
              <div className="max-w-[26rem] truncate font-medium" title={row.original.title}>
                {row.original.title}
              </div>
              <div className="flex max-w-[26rem] items-center gap-1.5 truncate text-[10.5px] text-subtle-foreground">
                {row.original.kb && <span className="font-mono">{row.original.kb}</span>}
                {row.original.platform !== 'windows' && <span className="truncate font-mono">{row.original.key}</span>}
                {row.original.reboot_required && (
                  <span className="inline-flex items-center gap-0.5" title="Restart required">
                    <RotateCw className="size-2.5" />
                    restart
                  </span>
                )}
                {row.original.cves.length > 0 && <span>{row.original.cves.length} CVEs</span>}
              </div>
            </div>
          </div>
        ),
      },
      {
        id: 'classification',
        accessorFn: (patch) => classificationLabel(patch.platform, patch.classification),
        header: 'Classification',
        cell: ({ row }) => <ClassificationLabel platform={row.original.platform} classification={row.original.classification} />,
      },
      {
        id: 'severity',
        accessorFn: (patch) => (patch.severity ? SEVERITY_RANK[patch.severity] : 9),
        header: 'Severity',
        cell: ({ row }) => <SeverityPill severity={row.original.severity} />,
      },
      {
        id: 'approval',
        accessorFn: (patch) => APPROVAL_ORDER.indexOf(patch.approval.status),
        header: 'Approval',
        cell: ({ row }) => <ApprovalBadge approval={row.original.approval} />,
      },
      {
        id: 'released',
        accessorFn: (patch) => patch.release_date ?? patch.first_seen_at,
        header: 'Released',
        cell: ({ row }) => {
          const date = row.original.release_date ?? row.original.first_seen_at
          return (
            <span className="tabular text-muted-foreground" title={row.original.release_date ? undefined : 'No release date; first seen'}>
              {formatDate(date)} <span className="text-subtle-foreground">· {daysBetween(new Date(date).getTime(), Date.now())}d</span>
            </span>
          )
        },
      },
      {
        id: 'missing',
        accessorFn: (patch) => patch.devices.missing,
        header: 'Missing',
        meta: { align: 'right' },
        cell: ({ row }) => <span className={cn('tabular', row.original.devices.missing ? 'font-medium text-warning' : 'text-subtle-foreground')}>{formatNumber(row.original.devices.missing)}</span>,
      },
      {
        id: 'failed',
        accessorFn: (patch) => patch.devices.failed,
        header: 'Failed',
        meta: { align: 'right' },
        cell: ({ row }) => <span className={cn('tabular', row.original.devices.failed ? 'font-semibold text-critical' : 'text-subtle-foreground')}>{formatNumber(row.original.devices.failed)}</span>,
      },
      {
        id: 'installed',
        accessorFn: (patch) => patch.devices.installed + patch.devices.pending_reboot,
        header: 'Installed',
        meta: { align: 'right' },
        cell: ({ row }) => (
          <span className="tabular text-muted-foreground">
            {formatNumber(row.original.devices.installed)}
            {row.original.devices.pending_reboot > 0 && <span className="text-info" title="Installed, restart pending"> +{row.original.devices.pending_reboot}</span>}
          </span>
        ),
      },
    )
    return defs
  }, [filtered, selected, canApprove])

  const chips: { key: string; label: string; clear: () => void }[] = []
  if (search.platform) chips.push({ key: 'platform', label: PLATFORM_LABEL[search.platform], clear: () => setSearch({ platform: undefined }) })
  if (search.classification) chips.push({ key: 'classification', label: classificationChip(search.classification, all), clear: () => setSearch({ classification: undefined }) })
  if (search.severity) chips.push({ key: 'severity', label: search.severity === 'none' ? 'Unrated' : search.severity, clear: () => setSearch({ severity: undefined }) })
  if (search.approval) chips.push({ key: 'approval', label: APPROVAL_LABEL[search.approval], clear: () => setSearch({ approval: undefined }) })
  if (search.health) chips.push({ key: 'health', label: search.health === 'failed' ? 'Failed installs' : 'Restart pending', clear: () => setSearch({ health: undefined }) })
  const drawerPatch = all.find((patch) => patch.id === search.patch)

  return (
    <div className="relative h-full">
      <div className="h-full overflow-y-auto">
        <PageContainer className="flex min-h-full flex-col gap-4 lg:h-full lg:min-h-[680px]">
          <PageHeader
            title="Updates"
            description={
              clientName
                ? `The catalog as ${clientName} sees it: its overrides and rule approvals apply.`
                : 'Every update your devices report. Approve, decline or defer them here, globally or for one client.'
            }
          />

          {!clientId && (
            <div className="flex flex-wrap items-center gap-3 rounded-xl bg-info/[0.06] px-4 py-2.5 ring-1 ring-info/20">
              <Info className="size-4 shrink-0 text-info" />
              <p className="min-w-0 flex-1 basis-64 text-dense text-muted-foreground">
                Showing <span className="font-medium text-foreground">global decisions</span>. Rule approvals and client overrides are recorded per client.
              </p>
              <SimpleSelect
                value={null}
                onValueChange={(value) => setClient(value)}
                placeholder="View as client…"
                size="sm"
                className="w-full sm:w-56"
                options={clients.map((client) => ({ value: client.id, label: client.name }))}
              />
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <SearchField value={search.q ?? ''} onChange={(value) => setSearch({ q: value || undefined })} placeholder="Search title, KB, package or CVE…" label="Search updates" className="sm:w-72" />
            <FacetMenu
              label="Platform"
              value={search.platform}
              onChange={(value) => setSearch({ platform: value })}
              options={facet('platform', PLATFORM_ORDER, (patch) => patch.platform, (value) => PLATFORM_LABEL[value], (value) => <PlatformMark platform={value} label={false} />)}
            />
            <FacetMenu
              label="Classification"
              value={search.classification}
              onChange={(value) => setSearch({ classification: value })}
              options={facet('classification', classifications.map((item) => item.value), (patch) => patch.classification, (value) => classifications.find((item) => item.value === value)?.label ?? value)}
            />
            <FacetMenu
              label="Severity"
              value={search.severity}
              onChange={(value) => setSearch({ severity: value })}
              options={facet<PatchSeverity | 'none'>('severity', [...SEVERITY_ORDER, 'none'], (patch) => patch.severity ?? 'none', (value) => (value === 'none' ? 'Unrated' : value))}
            />
            <FacetMenu
              label="Approval"
              value={search.approval}
              onChange={(value) => setSearch({ approval: value })}
              options={facet('approval', APPROVAL_ORDER, (patch) => patch.approval.status, (value) => APPROVAL_LABEL[value])}
            />
            <ToggleGroup
              value={[search.status === 'any' ? 'any' : 'missing']}
              onValueChange={(next: string[]) => next[0] && setSearch({ status: next[0] === 'any' ? 'any' : undefined })}
              variant="outline"
              spacing={0}
              size="sm"
              className={cn('sm:ml-auto', SEGMENTED)}
              aria-label="Which updates"
            >
              <ToggleGroupItem value="missing" className="px-3">
                Missing
              </ToggleGroupItem>
              <ToggleGroupItem value="any" className="px-3">
                All
              </ToggleGroupItem>
            </ToggleGroup>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="tabular mr-1 text-dense text-muted-foreground">
              {formatNumber(filtered.length)} of {formatNumber(all.length)} updates
            </span>
            <button
              type="button"
              aria-pressed={search.health === 'failed'}
              onClick={() => setSearch({ health: search.health === 'failed' ? undefined : 'failed' })}
              className={cn(
                'inline-flex h-6 items-center gap-1 rounded-full px-2 text-micro text-muted-foreground ring-1 ring-border hover:bg-surface-3',
                search.health === 'failed' && 'bg-critical/10 text-critical ring-critical/30',
              )}
            >
              <CircleX className="size-3" />
              Failed installs
            </button>
            <button
              type="button"
              aria-pressed={search.health === 'restart'}
              onClick={() => setSearch({ health: search.health === 'restart' ? undefined : 'restart', status: search.health === 'restart' ? search.status : 'any' })}
              className={cn(
                'inline-flex h-6 items-center gap-1 rounded-full px-2 text-micro text-muted-foreground ring-1 ring-border hover:bg-surface-3',
                search.health === 'restart' && 'bg-info/10 text-info ring-info/30',
              )}
            >
              <RotateCw className="size-3" />
              Restart pending
            </button>
            {chips.map((chip) => (
              <Badge key={chip.key} variant="secondary" className="h-6 gap-1 pr-1">
                {chip.label}
                <button type="button" aria-label={`Clear ${chip.label}`} onClick={chip.clear} className="rounded-sm p-0.5 hover:bg-surface-4">
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
            {chips.length > 1 && (
              <Button variant="ghost" size="xs" onClick={() => setSearch({ platform: undefined, classification: undefined, severity: undefined, approval: undefined, health: undefined })}>
                Clear all
              </Button>
            )}
          </div>

          {error ? (
            <ErrorState error={error} onRetry={() => void refetch()} />
          ) : !isLoading && all.length === 0 ? (
            <EmptyState
              illustration="patching"
              title={search.status === 'any' ? 'No updates reported yet' : 'Nothing is missing'}
              description={search.status === 'any' ? 'Devices report available updates after their first scan.' : 'Every update your devices report is installed. Switch to “All” to see the full catalog.'}
            />
          ) : (
            <div className="h-[560px] min-h-0 lg:h-auto lg:flex-1">
              <DataTable
                data={filtered}
                columns={columns}
                loading={isLoading}
                getRowId={(patch) => patch.id}
                onRowClick={(patch) => setSearch({ patch: patch.id })}
                activeRowId={search.patch}
                rowClassName={(patch) => selected.has(patch.id) && 'bg-primary/[0.05]'}
                initialSorting={[{ id: 'missing', desc: true }]}
                virtualHeight="100%"
                caption="Updates"
                empty={
                  <div className="p-6">
                    <EmptyState
                      compact
                      illustration="search"
                      title="No updates match"
                      description="Try removing a filter or searching for something else."
                      actions={
                        <Button variant="outline" size="sm" onClick={() => setSearch({ q: undefined, platform: undefined, classification: undefined, severity: undefined, approval: undefined, health: undefined })}>
                          Clear filters
                        </Button>
                      }
                    />
                  </div>
                }
              />
            </div>
          )}
        </PageContainer>
      </div>

      {selectedPatches.length > 0 && canApprove && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-4">
          <div role="toolbar" aria-label="Bulk actions" className="pointer-events-auto flex max-w-full items-center gap-1 overflow-x-auto rounded-xl bg-popover p-1.5 pl-3 shadow-popover ring-1 ring-border-strong">
            <span className="tabular shrink-0 pr-2 text-dense font-medium">{selectedPatches.length} selected</span>
            <span className="mx-1 h-5 w-px shrink-0 bg-border-strong" />
            <Button variant="ghost" size="sm" className="shrink-0" onClick={() => setDeciding('approved')}>
              <Check data-icon="inline-start" />
              Approve
            </Button>
            <Button variant="ghost" size="sm" className="shrink-0" onClick={() => setDeciding('declined')}>
              <Ban data-icon="inline-start" />
              Decline
            </Button>
            <Button variant="ghost" size="sm" className="shrink-0" onClick={() => setDeciding('deferred')}>
              <CalendarClock data-icon="inline-start" />
              Defer…
            </Button>
            <Button variant="ghost" size="sm" className="shrink-0" onClick={() => setDeciding('none')}>
              <RotateCcw data-icon="inline-start" />
              Reset
            </Button>
            <Button variant="ghost" size="icon-sm" className="shrink-0" aria-label="Clear selection" onClick={() => setSelected(new Set())}>
              <X />
            </Button>
          </div>
        </div>
      )}

      {deciding && (
        <DecisionDialog
          key={deciding}
          open
          onOpenChange={(open) => !open && setDeciding(null)}
          target={{
            ids: selectedPatches.map((patch) => patch.id),
            label: selectedPatches.length === 1 ? selectedPatches[0].title : selectedPatches.slice(0, 3).map((patch) => patch.kb ?? patch.title).join(', ') + (selectedPatches.length > 3 ? ` and ${selectedPatches.length - 3} more` : ''),
          }}
          initialDecision={deciding}
          defaultClientId={clientId}
          onDone={() => setSelected(new Set())}
        />
      )}
      <PatchDrawer patchId={search.patch ?? null} listPatch={drawerPatch} clientId={clientId} onClose={() => setSearch({ patch: undefined })} />
    </div>
  )
}

function classificationChip(classification: string, patches: Patch[]): string {
  const platform = patches.find((patch) => patch.classification === classification)?.platform ?? 'windows'
  return classificationLabel(platform, classification)
}
