import { useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { OsIcon } from '@/components/common/os-icon'
import { StatusDot } from '@/components/common/status-dot'
import type { Device } from '@/lib/api/types'
import { deviceName } from '@/lib/devices'
import { formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import { SearchField } from '@/features/devices/remote-ui'

const ROW = 40

/** Searchable, virtualised multi-select over devices. */
export function DevicePicker({
  devices,
  selected,
  onChange,
  height = 280,
  exclude,
  loading = false,
  autoFocus = false,
}: {
  devices: Device[]
  selected: string[]
  onChange: (ids: string[]) => void
  height?: number
  /** Devices that can't be picked (e.g. already members). */
  exclude?: Set<string>
  loading?: boolean
  autoFocus?: boolean
}) {
  const [query, setQuery] = useState('')
  // Devices that arrive preselected (the current device, a bulk selection) are listed first.
  const [pinned] = useState(() => new Set(selected))
  const scroller = useRef<HTMLDivElement>(null)
  const chosen = useMemo(() => new Set(selected), [selected])
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return [...devices]
      .sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)))
      .filter((device) => !exclude?.has(device.id))
      .filter(
        (device) =>
          !needle ||
          [
            device.hostname,
            device.display_name,
            device.client_name,
            device.site_name,
            device.last_user,
            device.os_name,
            ...device.tags,
          ]
            .filter(Boolean)
            .some((value) => String(value).toLowerCase().includes(needle)),
      )
  }, [devices, exclude, query, pinned])

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW,
    overscan: 10,
  })
  const allVisibleChosen = visible.length > 0 && visible.every((device) => chosen.has(device.id))

  const toggle = (id: string) => onChange(chosen.has(id) ? selected.filter((item) => item !== id) : [...selected, id])

  return (
    <div className="overflow-hidden rounded-lg ring-1 ring-border">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-2/60 p-2">
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Search devices, clients, tags…"
          label="Search devices"
          className="sm:w-64"
        />
        <span className="tabular text-micro text-muted-foreground">
          {formatNumber(selected.length)} selected · {formatNumber(visible.length)} shown
        </span>
        <div className="ml-auto flex gap-1">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={visible.length === 0}
            onClick={() =>
              onChange(
                allVisibleChosen
                  ? selected.filter((id) => !visible.some((device) => device.id === id))
                  : [...new Set([...selected, ...visible.map((device) => device.id)])],
              )
            }
          >
            {allVisibleChosen ? 'Clear shown' : 'Select shown'}
          </Button>
          {selected.length > 0 && (
            <Button type="button" variant="ghost" size="xs" onClick={() => onChange([])}>
              Clear
            </Button>
          )}
        </div>
      </div>
      <div
        ref={scroller}
        className="overflow-y-auto overscroll-contain"
        style={{ height }}
        role="listbox"
        aria-multiselectable="true"
        aria-label="Devices"
        tabIndex={autoFocus ? 0 : undefined}
      >
        {loading ? (
          <div className="p-4 text-center text-dense text-muted-foreground">Loading devices…</div>
        ) : visible.length === 0 ? (
          <div className="p-6 text-center text-dense text-muted-foreground">No devices match.</div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((item) => {
              const device = visible[item.index]
              const checked = chosen.has(device.id)
              return (
                <div
                  key={device.id}
                  role="option"
                  aria-selected={checked}
                  tabIndex={-1}
                  onClick={() => toggle(device.id)}
                  onKeyDown={(event) => {
                    if (event.key === ' ' || event.key === 'Enter') {
                      event.preventDefault()
                      toggle(device.id)
                    }
                  }}
                  className={cn(
                    'absolute inset-x-0 flex cursor-pointer items-center gap-3 border-b border-border px-3 text-dense transition-colors last:border-b-0 hover:bg-surface-3/60',
                    checked && 'bg-primary/[0.06]',
                  )}
                  style={{ top: item.start, height: ROW }}
                >
                  <Checkbox checked={checked} tabIndex={-1} aria-hidden="true" className="pointer-events-none" />
                  <OsIcon family={device.os_family} />
                  <span className="min-w-0 flex-1 truncate font-medium">{deviceName(device)}</span>
                  <span className="hidden min-w-0 truncate text-micro text-subtle-foreground sm:block sm:max-w-[45%]">
                    {device.client_name} · {device.site_name}
                  </span>
                  <StatusDot tone={device.online ? 'live' : 'offline'} label={device.online ? 'Online' : 'Offline'} />
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
