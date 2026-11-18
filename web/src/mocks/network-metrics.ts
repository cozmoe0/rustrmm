/*
 * Deterministic SNMP samples for the mock: every metric row of a device has a value at any timestamp,
 * derived from the device's simulation profile, so graphs, the latest values and threshold alerts agree.
 */
import type { MetricsRange, SnmpCurrentValue, SnmpMetricDef, SnmpMetricsResponse, SnmpSeries, SnmpTemplate } from '@/lib/api/types'
import { thresholdState } from '@/lib/network/snmp'
import { BUILTIN_TEMPLATES } from './network-catalog'
import type { MockSnmpDevice } from './network-state'

const DAY_S = 86_400
const STEP: Record<MetricsRange, { span: number; step: number }> = {
  '1h': { span: 3600, step: 60 },
  '24h': { span: DAY_S, step: 300 },
  '7d': { span: 7 * DAY_S, step: 900 },
  '30d': { span: 30 * DAY_S, step: 3600 },
}

const clamp = (value: number, min = 0, max = 100) => Math.min(max, Math.max(min, value))
const wave = (seed: number, ts: number, period: number) => Math.sin((ts / period) * Math.PI * 2 + seed)
/** Business-hours curve: about 0 at night, 1 mid-day. */
const daily = (ts: number) => Math.max(0, Math.sin((((ts % DAY_S) / DAY_S) * 24 - 7) / 12 * Math.PI))

export interface MetricRow {
  index: string | null
  label: string | null
}

export function templatesFor(device: Pick<MockSnmpDevice, 'template_ids'>, custom: SnmpTemplate[]): SnmpTemplate[] {
  const all = [...BUILTIN_TEMPLATES, ...custom]
  return device.template_ids.map((id) => all.find((template) => template.id === id)).filter((template): template is SnmpTemplate => Boolean(template))
}

/** Template metrics merged by key (a later template wins). */
export function metricsFor(device: Pick<MockSnmpDevice, 'template_ids'>, custom: SnmpTemplate[]): SnmpMetricDef[] {
  const byKey = new Map<string, SnmpMetricDef>()
  for (const template of templatesFor(device, custom)) for (const metric of template.metrics) byKey.set(metric.key, metric)
  return [...byKey.values()]
}

/** The rows a metric has on this device (one null row for scalars). */
export function rowsFor(device: MockSnmpDevice, metric: SnmpMetricDef): MetricRow[] {
  const sim = device.sim
  if (!metric.table) return [{ index: null, label: null }]
  switch (metric.key) {
    case 'ifHCInOctets':
    case 'ifHCOutOctets':
    case 'ifOperStatus':
    case 'ifInErrors':
    case 'ifOutErrors':
      return (sim.interfaces ?? []).map((item) => ({ index: item.index, label: item.name }))
    case 'lldpRemSysName':
      return (sim.interfaces ?? []).filter((item) => item.neighbour).map((item) => ({ index: `0.${item.index}.1`, label: null }))
    case 'hrProcessorLoad':
      return Array.from({ length: sim.cpus ?? 0 }, (_, index) => ({ index: String(196608 + index), label: null }))
    case 'hrStorageUsed':
      return (sim.storage ?? []).map((item) => ({ index: item.index, label: item.name }))
    case 'prtMarkerSuppliesLevel':
      return (sim.supplies ?? []).map((item) => ({ index: `1.${item.index}`, label: item.name }))
    case 'hrPrinterStatus':
      return sim.kind === 'printer' ? [{ index: '1', label: null }] : []
    case 'upsInputVoltage':
    case 'upsOutputPercentLoad':
      return sim.ups ? [{ index: '1', label: null }] : []
    default:
      // Custom table metrics get two plausible rows.
      return [{ index: '1', label: null }, { index: '2', label: null }]
  }
}

/** Seconds the UPS has been on battery at `ts` during the seeded outage (or null). */
function outageAt(device: MockSnmpDevice, ts: number): { into: number; minutes: number } | null {
  const outage = device.sim.ups?.outage
  if (!outage) return null
  const start = outage.at / 1000
  const into = ts - start
  if (into < 0 || into > outage.minutes * 60 + 4 * 3600) return null
  return { into, minutes: outage.minutes }
}

/** A numeric sample, or null for text metrics and rows that don't exist at `ts`. */
export function valueAt(device: MockSnmpDevice, metric: SnmpMetricDef, index: string | null, ts: number): number | null {
  const sim = device.sim
  const seed = sim.seed % 1000
  const noise = (Math.sin(ts * 0.37 + seed) + Math.sin(ts * 0.13 + seed * 3)) * 0.5
  const nowS = Date.now() / 1000
  switch (metric.key) {
    case 'sysUpTime':
      return Math.max(0, ts - sim.boot_at / 1000)
    case 'ifHCInOctets':
    case 'ifHCOutOctets': {
      const item = sim.interfaces?.find((row) => row.index === index)
      if (!item || !item.up) return 0
      const burst = Math.max(0, Math.sin(ts / 1800 + seed + Number(index))) ** 6
      const shape = 0.25 + daily(ts) * 0.75 + noise * 0.12 + burst * 1.4
      const out = metric.key === 'ifHCOutOctets' ? 0.42 + (Number(index) % 3) * 0.2 : 1
      return Math.max(0, Math.round(item.base * shape * out))
    }
    case 'ifOperStatus': {
      const item = sim.interfaces?.find((row) => row.index === index)
      return item?.up ? 1 : 2
    }
    case 'ifInErrors':
    case 'ifOutErrors': {
      const item = sim.interfaces?.find((row) => row.index === index)
      if (!item?.errors) return 0
      return Math.max(0, item.errors * (0.6 + Math.max(0, wave(seed, ts, 5400)) * 0.8) * (metric.key === 'ifOutErrors' ? 0.2 : 1))
    }
    case 'hrProcessorLoad': {
      const base = sim.cpu_base ?? 12
      return Math.round(clamp(base + daily(ts) * base * 0.8 + noise * 6 + wave(seed + Number(index ?? 0), ts, 4200) * 4))
    }
    case 'hrStorageUsed': {
      const item = sim.storage?.find((row) => row.index === index)
      if (!item) return null
      return Math.round(clamp(item.used - (nowS - ts) / DAY_S / 30 * 1.5 + wave(seed, ts, DAY_S * 3) * 0.3) * 10) / 10
    }
    case 'prtMarkerSuppliesLevel': {
      const item = sim.supplies?.find((row) => `1.${row.index}` === index)
      if (!item) return null
      let level = item.level + ((nowS - ts) / DAY_S) * item.use
      if (level > 100) level -= 96 // the previous cartridge
      return Math.round(clamp(level))
    }
    case 'hrPrinterStatus':
      return daily(ts) > 0.4 && Math.sin(ts / 700 + seed) > 0.55 ? 4 : 3
    case 'upsBatteryStatus': {
      const outage = outageAt(device, ts)
      if (outage && outage.into < outage.minutes * 60 && outage.into > outage.minutes * 45) return 3
      return 2
    }
    case 'upsEstimatedChargeRemaining': {
      const ups = sim.ups
      if (!ups) return null
      const outage = outageAt(device, ts)
      if (outage) {
        const drain = outage.minutes * 60
        if (outage.into <= drain) return Math.round(clamp(100 - (outage.into / drain) * 64))
        return Math.round(clamp(36 + ((outage.into - drain) / (4 * 3600)) * 64))
      }
      return Math.round(clamp(ups.charge + noise * 0.4))
    }
    case 'upsEstimatedMinutesRemaining': {
      const ups = sim.ups
      if (!ups) return null
      const charge = valueAt(device, { ...metric, key: 'upsEstimatedChargeRemaining' }, null, ts) ?? 100
      const load = valueAt(device, { ...metric, key: 'upsOutputPercentLoad' }, '1', ts) ?? ups.load
      return Math.max(0, Math.round((ups.runtime * charge) / 100 * (ups.load / Math.max(5, load))))
    }
    case 'upsInputVoltage': {
      const ups = sim.ups
      if (!ups) return null
      const outage = outageAt(device, ts)
      if (outage && outage.into < outage.minutes * 60) return 0
      return Math.round(ups.voltage + noise * 1.5 + wave(seed, ts, 3600) * 1.2)
    }
    case 'upsOutputPercentLoad': {
      const ups = sim.ups
      if (!ups) return null
      return Math.round(clamp(ups.load + daily(ts) * 6 + noise * 2))
    }
    default:
      if (metric.kind === 'text') return null
      if (metric.unit === '%') return Math.round(clamp(20 + daily(ts) * 30 + noise * 8 + (Number(index ?? 0) % 3) * 6))
      return Math.max(0, Math.round(1200 + daily(ts) * 3400 + noise * 300))
  }
}

export function textAt(device: MockSnmpDevice, metric: SnmpMetricDef, index: string | null): string | null {
  if (metric.key === 'sysDescr') return device.sim.sys_descr
  if (metric.key === 'lldpRemSysName') {
    const item = device.sim.interfaces?.find((row) => `0.${row.index}.1` === index)
    return item?.neighbour ?? null
  }
  return null
}

function label(metric: SnmpMetricDef, row: MetricRow): string {
  const base = metric.label || metric.key
  if (row.label) return `${base} (${row.label})`
  return row.index ? `${base} (${row.index})` : base
}

/** `GET /network/snmp/devices/{id}/metrics`: series for numeric metrics, plus the latest value of every row. */
export function metricsResponse(device: MockSnmpDevice, custom: SnmpTemplate[], range: MetricsRange): SnmpMetricsResponse {
  const spec = STEP[range]
  const nowTs = Math.floor(Date.now() / 1000 / spec.step) * spec.step
  const created = device.created_at ? new Date(device.created_at).getTime() / 1000 : nowTs - spec.span
  const lastPoll = device.last_poll_at ? new Date(device.last_poll_at).getTime() / 1000 : null
  const downSince = device.sim.down_since ? device.sim.down_since / 1000 : null
  const from = Math.max(nowTs - spec.span, created)
  const until = Math.min(nowTs, downSince ?? Infinity, lastPoll ?? (device.status === 'pending' ? -Infinity : Infinity))
  const series: SnmpSeries[] = []
  const current: SnmpCurrentValue[] = []
  for (const metric of metricsFor(device, custom)) {
    for (const row of rowsFor(device, metric)) {
      if (metric.kind !== 'text') {
        const points: [number, number][] = []
        for (let ts = Math.ceil(from / spec.step) * spec.step; ts <= until; ts += spec.step) {
          const value = valueAt(device, metric, row.index, ts)
          if (value !== null) points.push([ts, Math.round(value * 100) / 100])
        }
        if (points.length) series.push({ key: metric.key, index: row.index, label: label(metric, row), unit: metric.unit, points })
      }
      if (device.status === 'pending') continue
      const at = Math.min(Date.now() / 1000, downSince ?? Infinity)
      const value = metric.kind === 'text' ? null : valueAt(device, metric, row.index, at)
      current.push({
        key: metric.key,
        index: row.index,
        label: label(metric, row),
        unit: metric.unit,
        value: value === null ? null : Math.round(value * 100) / 100,
        text: metric.kind === 'text' ? textAt(device, metric, row.index) : null,
        state: thresholdState(value, metric.thresholds),
      })
    }
  }
  return { range, series, current }
}

/** Threshold breaches right now (`state` warning/critical), for the simulator's alerts. */
export function breaches(device: MockSnmpDevice, custom: SnmpTemplate[], at = Date.now() / 1000) {
  const out: { metric: SnmpMetricDef; row: MetricRow; value: number; state: 'warning' | 'critical' }[] = []
  for (const metric of metricsFor(device, custom)) {
    if (!metric.thresholds || metric.kind === 'text') continue
    for (const row of rowsFor(device, metric)) {
      const value = valueAt(device, metric, row.index, at)
      const state = thresholdState(value, metric.thresholds)
      if (value !== null && state !== 'ok') out.push({ metric, row, value, state })
    }
  }
  return out
}

export function metricTitle(device: Pick<MockSnmpDevice, 'name'>, metric: SnmpMetricDef, row: MetricRow, value: number): string {
  const base = metric.label.replace(/\s*\(.*\)$/, '') || metric.key
  const what = row.label ? `${base} (${row.label})` : base
  const shown = metric.unit === '%' ? `${Math.round(value)}%` : metric.unit ? `${Math.round(value)} ${metric.unit}` : String(Math.round(value))
  return `${device.name}: ${what} is ${shown}`
}
