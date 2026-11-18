import { useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Checkbox } from '@/components/ui/checkbox'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { EntityAvatar } from '@/components/common/misc'
import { clientsQuery, devicesQuery, groupsQuery, sitesQuery } from '@/lib/api/queries'
import type { JobTargetInput, JobTargetType } from '@/lib/api/types'
import { TARGET_LABEL } from '@/lib/automation/labels'
import { formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import { SearchField } from '@/features/devices/remote-ui'
import { TargetIcon } from './automation-ui'
import { DevicePicker } from './device-picker'
import { SEGMENTED } from './styles'

interface Option {
  id: string
  label: string
  hint?: string
  count?: number
  icon?: ReactNode
  group?: string
}

function Checklist({
  options,
  selected,
  onChange,
  empty,
}: {
  options: Option[]
  selected: string[]
  onChange: (ids: string[]) => void
  empty: string
}) {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const visible = options.filter(
    (option) => !needle || `${option.label} ${option.hint ?? ''} ${option.group ?? ''}`.toLowerCase().includes(needle),
  )
  const groups = new Map<string, Option[]>()
  for (const option of visible) groups.set(option.group ?? '', [...(groups.get(option.group ?? '') ?? []), option])
  return (
    <div className="overflow-hidden rounded-lg ring-1 ring-border">
      {options.length > 6 && (
        <div className="border-b border-border bg-surface-2/60 p-2">
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder="Search…"
            label="Search targets"
            className="sm:w-64"
          />
        </div>
      )}
      <div className="max-h-[280px] overflow-y-auto overscroll-contain">
        {visible.length === 0 && <div className="p-6 text-center text-dense text-muted-foreground">{empty}</div>}
        {[...groups.entries()].map(([group, items]) => (
          <div key={group || 'all'}>
            {group && (
              <div className="sticky top-0 z-10 bg-surface-2/95 px-3 py-1 text-micro font-medium text-subtle-foreground backdrop-blur">
                {group}
              </div>
            )}
            {items.map((option) => {
              const checked = selected.includes(option.id)
              return (
                <label
                  key={option.id}
                  className={cn(
                    'flex h-10 cursor-pointer items-center gap-3 border-b border-border px-3 text-dense last:border-b-0 hover:bg-surface-3/60',
                    checked && 'bg-primary/[0.06]',
                  )}
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() =>
                      onChange(checked ? selected.filter((id) => id !== option.id) : [...selected, option.id])
                    }
                  />
                  {option.icon}
                  <span className="min-w-0 flex-1 truncate font-medium">{option.label}</span>
                  {option.hint && (
                    <span className="hidden truncate text-micro text-subtle-foreground sm:block sm:max-w-[40%]">
                      {option.hint}
                    </span>
                  )}
                  {option.count !== undefined && (
                    <span className="tabular text-micro text-muted-foreground">{formatNumber(option.count)}</span>
                  )}
                </label>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

/** Choose devices, groups, sites or clients as a job's target. */
export function TargetPicker({
  value,
  onChange,
}: {
  value: JobTargetInput
  onChange: (target: JobTargetInput) => void
}) {
  const { data: devices = [], isLoading } = useQuery(devicesQuery())
  const { data: groups = [] } = useQuery(groupsQuery())
  const { data: clients = [] } = useQuery(clientsQuery())
  const { data: sites = [] } = useQuery(sitesQuery())
  const managed = useMemo(
    () => devices.filter((device) => device.status === 'active' || device.status === 'quarantined'),
    [devices],
  )

  // Keep each type's selection when switching back and forth.
  const [memory, setMemory] = useState<Partial<Record<JobTargetType, string[]>>>({ [value.type]: value.ids })
  const setIds = (ids: string[]) => {
    setMemory((prev) => ({ ...prev, [value.type]: ids }))
    onChange({ type: value.type, ids })
  }

  return (
    <div className="grid grid-cols-1 gap-3">
      <ToggleGroup
        value={[value.type]}
        onValueChange={(next: string[]) => {
          const type = next[0] as JobTargetType | undefined
          if (!type || type === value.type) return
          setMemory((prev) => ({ ...prev, [value.type]: value.ids }))
          onChange({ type, ids: memory[type] ?? [] })
        }}
        variant="outline"
        spacing={0}
        className={cn('w-full', SEGMENTED)}
        aria-label="Target type"
      >
        {(['devices', 'group', 'site', 'client'] as const).map((type) => (
          <ToggleGroupItem key={type} value={type} className="flex-1 gap-1.5">
            <TargetIcon type={type} className="text-current" />
            {type === 'devices' ? 'Devices' : `${TARGET_LABEL[type]}s`}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      {value.type === 'devices' && (
        <DevicePicker devices={managed} selected={value.ids} onChange={setIds} loading={isLoading} />
      )}
      {value.type === 'group' && (
        <Checklist
          options={groups.map((group) => ({
            id: group.id,
            label: group.name,
            hint: `${group.kind === 'dynamic' ? 'Dynamic' : 'Static'}${group.client_name ? ` · ${group.client_name}` : ''}`,
            count: group.member_count,
            icon: <TargetIcon type="group" />,
          }))}
          selected={value.ids}
          onChange={setIds}
          empty="No device groups yet."
        />
      )}
      {value.type === 'site' && (
        <Checklist
          options={sites.map((site) => ({
            id: site.id,
            label: site.name,
            group: clients.find((client) => client.id === site.client_id)?.name ?? 'Other',
            count: site.device_count,
            icon: <TargetIcon type="site" />,
          }))}
          selected={value.ids}
          onChange={setIds}
          empty="No sites match."
        />
      )}
      {value.type === 'client' && (
        <Checklist
          options={clients.map((client) => ({
            id: client.id,
            label: client.name,
            hint: `${client.site_count} sites`,
            count: client.device_count,
            icon: <EntityAvatar name={client.name} seed={client.id} accent={client.accent_color} size="xs" />,
          }))}
          selected={value.ids}
          onChange={setIds}
          empty="No clients match."
        />
      )}
    </div>
  )
}
