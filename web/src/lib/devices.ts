/*
 * Pure helpers for device lists: naming, health bands, faceted filtering, CSV export,
 * saved views and column preferences. Kept framework-free so they are easy to test.
 */
import type { Device, DevicePatchStateFilter, DeviceType, OsFamily } from './api/types'
import { createStore, useStore } from './store'

// ------------------------------------------------------------------ naming & labels

export function deviceName(device: Pick<Device, 'display_name' | 'hostname'>): string {
  return device.display_name?.trim() || device.hostname
}

export const OS_LABEL: Record<OsFamily, string> = { windows: 'Windows', macos: 'macOS', linux: 'Linux' }

export const DEVICE_TYPE_LABEL: Record<DeviceType, string> = {
  workstation: 'Workstation',
  laptop: 'Laptop',
  server: 'Server',
  virtual: 'Virtual machine',
}

/** Short OS label for dense tables, e.g. "Windows 11 Pro" or "Ubuntu 24.04.3 LTS". */
export function osShortName(device: Pick<Device, 'os_name' | 'os_family'>): string {
  const name = device.os_name?.replace(/^Microsoft\s+/, '').trim()
  return name || OS_LABEL[device.os_family]
}

// ------------------------------------------------------------------ health

export type HealthBand = 'good' | 'fair' | 'poor' | 'unknown'

export const HEALTH_BAND_LABEL: Record<HealthBand, string> = {
  good: 'Healthy (85+)',
  fair: 'Fair (65–84)',
  poor: 'Poor (under 65)',
  unknown: 'No score yet',
}

/** Matches the HealthRing colour thresholds: 85+ good, 65–84 fair, below 65 poor. */
export function healthBand(score: number | null | undefined): HealthBand {
  if (score === null || score === undefined || Number.isNaN(score)) return 'unknown'
  if (score >= 85) return 'good'
  if (score >= 65) return 'fair'
  return 'poor'
}

export function healthTone(band: HealthBand): 'live' | 'warning' | 'critical' | 'neutral' {
  return band === 'good' ? 'live' : band === 'fair' ? 'warning' : band === 'poor' ? 'critical' : 'neutral'
}

/** Meter colour for a 0–100 utilisation value. */
export function usageTone(pct: number | null | undefined): 'live' | 'warning' | 'critical' | 'neutral' {
  if (pct === null || pct === undefined) return 'neutral'
  if (pct >= 90) return 'critical'
  if (pct >= 75) return 'warning'
  return 'live'
}

// ------------------------------------------------------------------ facets

export type ConnectionState = 'online' | 'offline'

export interface DeviceFacets {
  q?: string
  os?: OsFamily[]
  state?: ConnectionState
  types?: (DeviceType | 'unknown')[]
  health?: HealthBand[]
  tag?: string
  /** Server-side patch state (`GET /devices?patch_state=`). */
  patch?: DevicePatchStateFilter
}

export const PATCH_STATE_LABEL: Record<DevicePatchStateFilter, string> = {
  compliant: 'Compliant',
  non_compliant: 'Not compliant',
  missing_critical: 'Missing critical updates',
  failed: 'Failed installs',
  pending_reboot: 'Restart pending',
  not_scanned: 'Not scanned yet',
}

export const PATCH_STATE_ORDER: DevicePatchStateFilter[] = ['non_compliant', 'missing_critical', 'failed', 'pending_reboot', 'compliant', 'not_scanned']

function matchesQuery(device: Device, q: string): boolean {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  return [
    device.hostname,
    device.display_name,
    device.last_user,
    device.last_ip,
    device.serial,
    device.model,
    device.manufacturer,
    device.os_name,
    device.client_name,
    device.site_name,
    ...device.tags,
  ].some((value) => value?.toLowerCase().includes(needle))
}

export function filterDevices(devices: Device[], facets: DeviceFacets): Device[] {
  return devices.filter((device) => {
    if (facets.q && !matchesQuery(device, facets.q)) return false
    if (facets.os?.length && !facets.os.includes(device.os_family)) return false
    if (facets.state === 'online' && !device.online) return false
    if (facets.state === 'offline' && device.online) return false
    if (facets.types?.length && !facets.types.includes(device.device_type ?? 'unknown')) return false
    if (facets.health?.length && !facets.health.includes(healthBand(device.health_score))) return false
    if (facets.tag && !device.tags.includes(facets.tag)) return false
    return true
  })
}

export interface FacetCounts {
  os: Record<OsFamily, number>
  state: Record<ConnectionState, number>
  types: Record<DeviceType | 'unknown', number>
  health: Record<HealthBand, number>
  tags: [string, number][]
}

export function facetCounts(devices: Device[]): FacetCounts {
  const counts: FacetCounts = {
    os: { windows: 0, macos: 0, linux: 0 },
    state: { online: 0, offline: 0 },
    types: { workstation: 0, laptop: 0, server: 0, virtual: 0, unknown: 0 },
    health: { good: 0, fair: 0, poor: 0, unknown: 0 },
    tags: [],
  }
  const tags = new Map<string, number>()
  for (const device of devices) {
    counts.os[device.os_family] += 1
    counts.state[device.online ? 'online' : 'offline'] += 1
    counts.types[device.device_type ?? 'unknown'] += 1
    counts.health[healthBand(device.health_score)] += 1
    for (const tag of device.tags) tags.set(tag, (tags.get(tag) ?? 0) + 1)
  }
  counts.tags = [...tags.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return counts
}

/** Toggles a value in an optional list facet, returning undefined when it becomes empty. */
export function toggleFacet<T>(list: T[] | undefined, value: T): T[] | undefined {
  const current = list ?? []
  const next = current.includes(value) ? current.filter((item) => item !== value) : [...current, value]
  return next.length ? next : undefined
}

// ------------------------------------------------------------------ search params <-> facets

export interface DeviceListSearch {
  q?: string
  os?: string
  state?: string
  type?: string
  health?: string
  tag?: string
  /** Patch state (`compliant`, `non_compliant`, `pending_reboot`, `failed`, `missing_critical`, `not_scanned`). */
  patch?: string
  /** Legacy links from Fleet Pulse: `status=online|offline`. */
  status?: string
}

const OS_VALUES: OsFamily[] = ['windows', 'macos', 'linux']
const TYPE_VALUES: (DeviceType | 'unknown')[] = ['workstation', 'laptop', 'server', 'virtual', 'unknown']
const HEALTH_VALUES: HealthBand[] = ['good', 'fair', 'poor', 'unknown']

function parseList<T extends string>(raw: string | undefined, allowed: readonly T[]): T[] | undefined {
  if (!raw) return undefined
  const values = raw.split(',').filter((value): value is T => (allowed as readonly string[]).includes(value))
  return values.length ? values : undefined
}

export function facetsFromSearch(search: DeviceListSearch): DeviceFacets {
  const stateRaw = search.state ?? search.status
  return {
    q: search.q || undefined,
    os: parseList(search.os, OS_VALUES),
    state: stateRaw === 'online' || stateRaw === 'offline' ? stateRaw : undefined,
    types: parseList(search.type, TYPE_VALUES),
    health: parseList(search.health, HEALTH_VALUES),
    tag: search.tag || undefined,
    patch: (PATCH_STATE_ORDER as string[]).includes(search.patch ?? '') ? (search.patch as DevicePatchStateFilter) : undefined,
  }
}

export function searchFromFacets(facets: DeviceFacets): DeviceListSearch {
  return {
    q: facets.q || undefined,
    os: facets.os?.join(',') || undefined,
    state: facets.state,
    type: facets.types?.join(',') || undefined,
    health: facets.health?.join(',') || undefined,
    tag: facets.tag || undefined,
    patch: facets.patch,
    status: undefined,
  }
}

export function hasActiveFacets(facets: DeviceFacets): boolean {
  return Boolean(facets.q || facets.os || facets.state || facets.types || facets.health || facets.tag || facets.patch)
}

// ------------------------------------------------------------------ CSV export

/** Quotes a CSV field and neutralises spreadsheet formula injection. */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return ''
  let text = Array.isArray(value) ? value.join('; ') : String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`
  return text
}

export interface CsvColumn<T> {
  header: string
  value: (row: T) => unknown
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const lines = [columns.map((column) => csvField(column.header)).join(',')]
  for (const row of rows) lines.push(columns.map((column) => csvField(column.value(row))).join(','))
  return `${lines.join('\r\n')}\r\n`
}

export const DEVICE_CSV_COLUMNS: CsvColumn<Device>[] = [
  { header: 'Hostname', value: (d) => d.hostname },
  { header: 'Display name', value: (d) => d.display_name },
  { header: 'Status', value: (d) => (d.status === 'active' ? (d.online ? 'online' : 'offline') : d.status) },
  { header: 'Client', value: (d) => d.client_name },
  { header: 'Site', value: (d) => d.site_name },
  { header: 'Operating system', value: (d) => d.os_name },
  { header: 'OS version', value: (d) => d.os_version },
  { header: 'Type', value: (d) => d.device_type },
  { header: 'Manufacturer', value: (d) => d.manufacturer },
  { header: 'Model', value: (d) => d.model },
  { header: 'Serial', value: (d) => d.serial },
  { header: 'Last user', value: (d) => d.last_user },
  { header: 'IP address', value: (d) => d.last_ip },
  { header: 'CPU %', value: (d) => (d.cpu_pct === null ? null : d.cpu_pct.toFixed(1)) },
  { header: 'Memory %', value: (d) => (d.mem_pct === null ? null : d.mem_pct.toFixed(1)) },
  { header: 'Disk %', value: (d) => (d.disk_pct === null ? null : d.disk_pct.toFixed(1)) },
  { header: 'Health', value: (d) => d.health_score },
  { header: 'Last seen', value: (d) => d.last_seen_at },
  { header: 'Agent version', value: (d) => d.agent_version },
  { header: 'Tags', value: (d) => d.tags },
]

// ------------------------------------------------------------------ formatting

/** Bits per second → "12.4 Mb/s". */
export function formatBitrate(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || Number.isNaN(bps)) return '—'
  if (bps < 1000) return `${Math.round(bps)} b/s`
  const units = ['Kb/s', 'Mb/s', 'Gb/s']
  let value = bps / 1000
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit += 1
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

export function formatPct(value: number | null | undefined, digits = 0): string {
  return value === null || value === undefined ? '—' : `${value.toFixed(digits)}%`
}

/** Normalises a free-form tag list: lower-case, trimmed, unique, at most 40 chars each. */
export function normalizeTags(tags: string[]): string[] {
  const out: string[] = []
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase().slice(0, 40)
    if (tag && !out.includes(tag)) out.push(tag)
  }
  return out.slice(0, 30)
}

// ------------------------------------------------------------------ saved views & columns

export interface SavedDeviceView {
  id: string
  name: string
  search: DeviceListSearch
}

export const savedViewsStore = createStore<SavedDeviceView[]>([], {
  key: 'rustrmm.device-views',
  deserialize: (raw) => {
    try {
      const value = JSON.parse(raw) as unknown
      return Array.isArray(value) ? (value as SavedDeviceView[]) : undefined
    } catch {
      return undefined
    }
  },
})

export function useSavedViews() {
  return useStore(savedViewsStore)
}

export function saveView(name: string, search: DeviceListSearch): SavedDeviceView {
  const view: SavedDeviceView = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    name: name.trim().slice(0, 60) || 'Untitled view',
    search,
  }
  savedViewsStore.set((views) => [...views, view].slice(-20))
  return view
}

export function deleteView(id: string) {
  savedViewsStore.set((views) => views.filter((view) => view.id !== id))
}

export const DEVICE_COLUMNS = [
  { id: 'site', label: 'Client / site' },
  { id: 'os', label: 'Operating system' },
  { id: 'user', label: 'Last user' },
  { id: 'ip', label: 'IP address' },
  { id: 'resources', label: 'CPU / RAM / disk' },
  { id: 'health', label: 'Health' },
  { id: 'last_seen', label: 'Last seen' },
  { id: 'agent', label: 'Agent version' },
  { id: 'tags', label: 'Tags' },
  { id: 'type', label: 'Type' },
  { id: 'model', label: 'Model' },
] as const

export type DeviceColumnId = (typeof DEVICE_COLUMNS)[number]['id']

const DEFAULT_HIDDEN: DeviceColumnId[] = ['type', 'model']

export const columnVisibilityStore = createStore<Record<string, boolean>>(
  Object.fromEntries(DEFAULT_HIDDEN.map((id) => [id, false])),
  { key: 'rustrmm.device-columns' },
)

export function useColumnVisibility() {
  return useStore(columnVisibilityStore)
}
