/*
 * SNMP metrics for the console: status labels, value formatting by unit, and shaping the metrics response
 * into what the device page draws — chart rows aligned by timestamp, the IF-MIB interface table, printer
 * supply bars and the UPS battery panel.
 */
import type {
  SnmpCurrentValue,
  SnmpDeviceStatus,
  SnmpMetricDef,
  SnmpMetricsResponse,
  SnmpSeries,
  SnmpThresholds,
  SnmpValueState,
} from '@/lib/api/types'
import { formatBitrate } from '@/lib/devices'
import { formatDuration } from '@/lib/format'

export const SNMP_STATUS_LABEL: Record<SnmpDeviceStatus, string> = {
  pending: 'Waiting for first poll',
  ok: 'OK',
  unreachable: 'Unreachable',
  alerting: 'Alerting',
}

export const SNMP_STATUS_TONE: Record<SnmpDeviceStatus, 'live' | 'critical' | 'warning' | 'info'> = {
  pending: 'info',
  ok: 'live',
  unreachable: 'critical',
  alerting: 'warning',
}

export const POLL_INTERVALS = [30, 60, 120, 300, 600, 900, 1800, 3600] as const
export const POLL_MIN = 30
export const POLL_MAX = 86_400

/** Formats a value by its unit: counters arrive as per-second rates (B/s shown in bits/s). */
export function formatSnmpValue(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  switch (unit) {
    case '%':
      return `${value >= 10 || value === 0 ? Math.round(value) : value.toFixed(1)}%`
    case 'B/s':
      return formatBitrate(value * 8)
    case 's':
      return formatDuration(Math.max(0, Math.round(value)))
    case 'min':
      return `${Math.round(value)} min`
    case 'V':
      return `${Math.round(value)} V`
    case 'errors/s':
      return value === 0 ? '0/s' : `${value < 0.1 ? value.toFixed(3) : value.toFixed(2)}/s`
    case '':
      return Number.isInteger(value) ? String(value) : value.toFixed(2)
    default:
      return `${Number.isInteger(value) ? value : value.toFixed(2)} ${unit}`
  }
}

/** Inclusive thresholds, like the server: `above` breaches at value ≥ threshold, `below` at value ≤ threshold. */
export function thresholdState(value: number | null | undefined, thresholds: SnmpThresholds | null | undefined): SnmpValueState {
  if (value === null || value === undefined || !thresholds) return 'ok'
  const breach = (limit: number | null | undefined) =>
    limit !== null && limit !== undefined && (thresholds.direction === 'above' ? value >= limit : value <= limit)
  if (breach(thresholds.crit)) return 'critical'
  if (breach(thresholds.warn)) return 'warning'
  return 'ok'
}

/** `crit` must be at or beyond `warn` in the threshold's direction. */
export function thresholdIssue(thresholds: SnmpThresholds | null | undefined): string | null {
  if (!thresholds) return null
  const { warn, crit, direction } = thresholds
  if (warn === null || warn === undefined || crit === null || crit === undefined) return null
  if (direction === 'above' && crit < warn) return 'Critical must be at or above warning'
  if (direction === 'below' && crit > warn) return 'Critical must be at or below warning'
  return null
}

/** The row label the server appends in parentheses: `Supply level (Black Toner)` → `Black Toner`. */
export function rowLabel(item: Pick<SnmpSeries, 'label' | 'index'>): string | null {
  const match = /\(([^()]*)\)\s*$/.exec(item.label)
  if (match) return match[1]
  return item.index ? `#${item.index}` : null
}

/** The metric label without the row label. */
export function baseLabel(label: string): string {
  return label.replace(/\s*\([^()]*\)\s*$/, '')
}

export const seriesId = (item: Pick<SnmpSeries, 'key' | 'index'>) => (item.index ? `${item.key}:${item.index}` : item.key)

export interface SeriesGroup {
  key: string
  label: string
  unit: string
  series: SnmpSeries[]
}

/** Groups series by metric key, keeping the server's order (keys sorted, rows by index). */
export function groupSeries(series: SnmpSeries[]): SeriesGroup[] {
  const groups = new Map<string, SeriesGroup>()
  for (const item of series) {
    const group = groups.get(item.key) ?? { key: item.key, label: baseLabel(item.label), unit: item.unit, series: [] }
    group.series.push(item)
    groups.set(item.key, group)
  }
  for (const group of groups.values()) group.series.sort((a, b) => compareIndex(a.index, b.index))
  return [...groups.values()]
}

export function compareIndex(a: string | null | undefined, b: string | null | undefined): number {
  const left = (a ?? '').split('.').map(Number)
  const right = (b ?? '').split('.').map(Number)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? -1) - (right[index] ?? -1)
    if (diff !== 0 && Number.isFinite(diff)) return diff
  }
  return (a ?? '').localeCompare(b ?? '')
}

export type ChartRow = { ts: number } & Record<string, number | null>

/**
 * Aligns several series on one time axis for a multi-line chart: one row per timestamp (ascending), with
 * `null` where a series has no sample. Values are scaled with `transform` (e.g. B/s → bits/s).
 */
export function chartRows(series: SnmpSeries[], transform: (value: number) => number = (value) => value): ChartRow[] {
  const rows = new Map<number, ChartRow>()
  const ids = series.map(seriesId)
  series.forEach((item, position) => {
    for (const [ts, value] of item.points) {
      let row = rows.get(ts)
      if (!row) {
        row = { ts } as ChartRow
        for (const id of ids) row[id] = null
        rows.set(ts, row)
      }
      row[ids[position]] = Number.isFinite(value) ? transform(value) : null
    }
  })
  return [...rows.values()].sort((a, b) => a.ts - b.ts)
}

export function latest(item: SnmpSeries | undefined): number | null {
  const point = item?.points.at(-1)
  return point ? point[1] : null
}

function stat(values: number[]) {
  if (values.length === 0) return { avg: null, max: null }
  return { avg: values.reduce((sum, value) => sum + value, 0) / values.length, max: Math.max(...values) }
}

export function seriesStats(item: SnmpSeries) {
  return { ...stat(item.points.map((point) => point[1]).filter(Number.isFinite)), last: latest(item) }
}

/** The latest value for a key/index: `current` first (it has text and the threshold state), else the last point. */
export function currentValue(response: SnmpMetricsResponse | undefined, key: string, index?: string | null): SnmpCurrentValue | null {
  if (!response) return null
  const hit = response.current?.find((item) => item.key === key && (item.index ?? null) === (index ?? null))
  if (hit) return hit
  const item = response.series.find((series) => series.key === key && (series.index ?? null) === (index ?? null))
  if (!item) return null
  return { key, index: item.index ?? null, label: item.label, unit: item.unit, value: latest(item), text: null }
}

const IF_KEYS = ['ifHCInOctets', 'ifHCOutOctets', 'ifOperStatus', 'ifInErrors', 'ifOutErrors'] as const

export interface InterfaceRow {
  index: string
  name: string
  status: 'up' | 'down' | 'other'
  /** Bits per second. */
  inBps: number | null
  outBps: number | null
  inErrors: number | null
  outErrors: number | null
  /** Recent inbound + outbound bits/s for a sparkline. */
  trend: number[]
}

/** The IF-MIB table: one row per interface index, with rates in bits/s and `ifOperStatus` (1 up, 2 down). */
export function interfaceRows(response: SnmpMetricsResponse | undefined): InterfaceRow[] {
  if (!response) return []
  const rows = new Map<string, InterfaceRow>()
  const touch = (index: string, label: string | null) => {
    let row = rows.get(index)
    if (!row) {
      row = { index, name: label ?? `Interface ${index}`, status: 'other', inBps: null, outBps: null, inErrors: null, outErrors: null, trend: [] }
      rows.set(index, row)
    } else if (label && row.name.startsWith('Interface ')) row.name = label
    return row
  }
  const sources: { key: string; index?: string | null; label: string; value: number | null; points?: [number, number][] }[] = [
    ...response.series.filter((item) => (IF_KEYS as readonly string[]).includes(item.key)).map((item) => ({ ...item, value: latest(item) })),
    ...(response.current ?? []).filter((item) => (IF_KEYS as readonly string[]).includes(item.key)),
  ]
  for (const item of sources) {
    if (!item.index) continue
    const row = touch(item.index, rowLabel(item)?.startsWith('#') ? null : rowLabel(item))
    const value = item.value
    if (item.key === 'ifOperStatus') row.status = value === 1 ? 'up' : value === 2 ? 'down' : row.status
    else if (item.key === 'ifHCInOctets') {
      row.inBps = value === null ? row.inBps : value * 8
      if (item.points) row.trend = mergeTrend(row.trend, item.points)
    } else if (item.key === 'ifHCOutOctets') {
      row.outBps = value === null ? row.outBps : value * 8
      if (item.points) row.trend = mergeTrend(row.trend, item.points)
    } else if (item.key === 'ifInErrors') row.inErrors = value
    else if (item.key === 'ifOutErrors') row.outErrors = value
  }
  return [...rows.values()].sort((a, b) => compareIndex(a.index, b.index))
}

function mergeTrend(trend: number[], points: [number, number][]): number[] {
  const tail = points.slice(-30).map((point) => point[1] * 8)
  if (trend.length === 0) return tail
  return tail.map((value, index) => value + (trend[index] ?? 0))
}

export type SupplyColor = 'black' | 'cyan' | 'magenta' | 'yellow' | 'other'

export interface PrinterSupply {
  index: string
  name: string
  pct: number | null
  state: SnmpValueState
  color: SupplyColor
}

export function supplyColor(name: string): SupplyColor {
  const lower = name.toLowerCase()
  if (/black|\bk\b|schwarz/.test(lower)) return 'black'
  if (/cyan/.test(lower)) return 'cyan'
  if (/magenta/.test(lower)) return 'magenta'
  if (/yellow/.test(lower)) return 'yellow'
  return 'other'
}

const SUPPLY_THRESHOLDS: SnmpThresholds = { warn: 20, crit: 10, direction: 'below' }

/** Toner and supply levels (`prtMarkerSuppliesLevel` as a percentage), black/CMY first. */
export function printerSupplies(response: SnmpMetricsResponse | undefined, thresholds: SnmpThresholds = SUPPLY_THRESHOLDS): PrinterSupply[] {
  if (!response) return []
  const byIndex = new Map<string, PrinterSupply>()
  const add = (item: { index?: string | null; label: string; value: number | null; state?: SnmpValueState }) => {
    const index = item.index ?? '0'
    const name = rowLabel(item) ?? `Supply ${index}`
    const pct = item.value === null ? null : Math.max(0, Math.min(100, item.value))
    byIndex.set(index, { index, name, pct, state: item.state ?? thresholdState(pct, thresholds), color: supplyColor(name) })
  }
  for (const item of response.series.filter((series) => series.key === 'prtMarkerSuppliesLevel')) add({ ...item, value: latest(item) })
  for (const item of (response.current ?? []).filter((value) => value.key === 'prtMarkerSuppliesLevel')) add(item)
  const order: SupplyColor[] = ['black', 'cyan', 'magenta', 'yellow', 'other']
  return [...byIndex.values()].sort((a, b) => order.indexOf(a.color) - order.indexOf(b.color) || compareIndex(a.index, b.index))
}

export type UpsBattery = 'unknown' | 'normal' | 'low' | 'depleted'

export interface UpsPanel {
  battery: UpsBattery
  chargePct: number | null
  runtimeMin: number | null
  inputVolts: number | null
  loadPct: number | null
  /** The charge trend for a sparkline. */
  chargeTrend: number[]
}

const UPS_BATTERY: Record<number, UpsBattery> = { 1: 'unknown', 2: 'normal', 3: 'low', 4: 'depleted' }

/** UPS-MIB values for the battery panel; null when the device has no UPS metrics. */
export function upsPanel(response: SnmpMetricsResponse | undefined): UpsPanel | null {
  if (!response) return null
  const value = (key: string) => {
    const current = response.current?.filter((item) => item.key === key) ?? []
    if (current.length) return current[0].value
    const series = response.series.filter((item) => item.key === key)
    return series.length ? latest(series[0]) : null
  }
  const status = value('upsBatteryStatus')
  const charge = value('upsEstimatedChargeRemaining')
  if (status === null && charge === null) return null
  return {
    battery: status === null ? 'unknown' : (UPS_BATTERY[status] ?? 'unknown'),
    chargePct: charge,
    runtimeMin: value('upsEstimatedMinutesRemaining'),
    inputVolts: value('upsInputVoltage'),
    loadPct: value('upsOutputPercentLoad'),
    chargeTrend: response.series.find((item) => item.key === 'upsEstimatedChargeRemaining')?.points.slice(-40).map((point) => point[1]) ?? [],
  }
}

/** Keys drawn by the dedicated panels instead of generic charts. */
export const PANEL_KEYS = new Set(['ifHCInOctets', 'ifHCOutOctets', 'ifOperStatus', 'ifInErrors', 'ifOutErrors', 'lldpRemSysName', 'prtMarkerSuppliesLevel', 'hrPrinterStatus', 'upsBatteryStatus', 'upsEstimatedChargeRemaining', 'upsEstimatedMinutesRemaining', 'upsInputVoltage', 'upsOutputPercentLoad', 'sysUpTime', 'sysDescr'])

export const PRINTER_STATUS: Record<number, string> = { 1: 'Other', 2: 'Unknown', 3: 'Idle', 4: 'Printing', 5: 'Warming up' }

// ------------------------------------------------------------------ templates

export const METRIC_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/
export const OID = /^\d+(\.\d+)+$/

export interface MetricIssue {
  index: number
  field: keyof SnmpMetricDef | 'thresholds'
  message: string
}

/** Mirrors the server's template validation closely enough to catch mistakes before saving. */
export function validateMetrics(metrics: SnmpMetricDef[]): MetricIssue[] {
  const issues: MetricIssue[] = []
  const keys = new Set<string>()
  metrics.forEach((metric, index) => {
    if (!METRIC_KEY.test(metric.key)) issues.push({ index, field: 'key', message: '1–64 letters, digits, _, - or ., starting with a letter' })
    else if (keys.has(metric.key)) issues.push({ index, field: 'key', message: 'Used twice' })
    keys.add(metric.key)
    if (!OID.test(metric.oid.replace(/^\./, ''))) issues.push({ index, field: 'oid', message: 'A numeric OID such as 1.3.6.1.2.1.1.3' })
    if (metric.index_label_oid && !OID.test(metric.index_label_oid.replace(/^\./, ''))) issues.push({ index, field: 'index_label_oid', message: 'A numeric OID' })
    if (metric.max_oid && !OID.test(metric.max_oid.replace(/^\./, ''))) issues.push({ index, field: 'max_oid', message: 'A numeric OID' })
    if (metric.kind === 'text' && metric.thresholds && (metric.thresholds.warn != null || metric.thresholds.crit != null))
      issues.push({ index, field: 'thresholds', message: 'Text metrics have no thresholds' })
    const problem = thresholdIssue(metric.thresholds)
    if (problem) issues.push({ index, field: 'thresholds', message: problem })
  })
  if (metrics.length === 0) issues.push({ index: -1, field: 'key', message: 'Add at least one metric' })
  return issues
}

export function emptyMetric(): SnmpMetricDef {
  return { key: '', label: '', oid: '', table: false, index_label_oid: null, max_oid: null, unit: '', kind: 'gauge', thresholds: null }
}

// ------------------------------------------------------------------ traps

/** Names for common trap OIDs (generic traps per RFC 3584, plus vendor traps seen on UPSes and printers). */
export const TRAP_NAMES: Record<string, string> = {
  '1.3.6.1.6.3.1.1.5.1': 'coldStart',
  '1.3.6.1.6.3.1.1.5.2': 'warmStart',
  '1.3.6.1.6.3.1.1.5.3': 'linkDown',
  '1.3.6.1.6.3.1.1.5.4': 'linkUp',
  '1.3.6.1.6.3.1.1.5.5': 'authenticationFailure',
  '1.3.6.1.4.1.318.0.5': 'APC: on battery',
  '1.3.6.1.4.1.318.0.9': 'APC: power restored',
  '1.3.6.1.2.1.33.2.0.1': 'UPS-MIB: on battery',
  '1.3.6.1.2.1.43.18.2.0.1': 'Printer alert',
}

/** A readable name for a trap OID, or null when it isn't a well-known one. */
export function trapName(oid: string): string | null {
  return TRAP_NAMES[oid.replace(/^\./, '')] ?? null
}

/** Whether `prefix` matches `oid` on an arc boundary (`1.3.6.1.4.1.318` matches `1.3.6.1.4.1.318.0.5`, not `…3180`). */
export function oidMatches(prefix: string, oid: string): boolean {
  const clean = (value: string) => value.trim().replace(/^\./, '').replace(/\.$/, '')
  const p = clean(prefix)
  const o = clean(oid)
  return p !== '' && (o === p || o.startsWith(`${p}.`))
}

export function formatVarbind(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}
