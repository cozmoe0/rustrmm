import { describe, expect, it } from 'vitest'
import type { SnmpMetricsResponse, SnmpSeries } from '@/lib/api/types'
import { ASSET_TYPE_ICON, ASSET_TYPES, defaultTemplatesFor, guessAssetType } from './assets'
import {
  baseLabel,
  chartRows,
  formatSnmpValue,
  groupSeries,
  interfaceRows,
  oidMatches,
  printerSupplies,
  rowLabel,
  thresholdState,
  trapName,
  upsPanel,
  validateMetrics,
} from './snmp'
import { layoutTopology } from './topology'

const series = (key: string, index: string | null, label: string, unit: string, points: [number, number][]): SnmpSeries => ({ key, index, label, unit, points })

describe('SNMP metrics shaping', () => {
  it('reads row labels the server appends', () => {
    expect(rowLabel({ label: 'Supply level (Black Toner)', index: '1.1' })).toBe('Black Toner')
    expect(rowLabel({ label: 'CPU load', index: '196608' })).toBe('#196608')
    expect(rowLabel({ label: 'Uptime', index: null })).toBeNull()
    expect(baseLabel('Inbound traffic (Port 3)')).toBe('Inbound traffic')
  })

  it('aligns several series on one time axis', () => {
    const rows = chartRows([series('a', '1', 'A (x)', '%', [[10, 1], [20, 2]]), series('a', '2', 'A (y)', '%', [[20, 5], [30, 6]])])
    expect(rows).toEqual([
      { ts: 10, 'a:1': 1, 'a:2': null },
      { ts: 20, 'a:1': 2, 'a:2': 5 },
      { ts: 30, 'a:1': null, 'a:2': 6 },
    ])
    expect(chartRows([series('b', null, 'B', 'B/s', [[1, 100]])], (value) => value * 8)).toEqual([{ ts: 1, b: 800 }])
  })

  it('groups series by metric and orders rows by index', () => {
    const groups = groupSeries([series('x', '10', 'X (ten)', '', []), series('x', '2', 'X (two)', '', []), series('y', null, 'Y', '%', [])])
    expect(groups.map((group) => group.key)).toEqual(['x', 'y'])
    expect(groups[0].series.map((item) => item.index)).toEqual(['2', '10'])
    expect(groups[0].label).toBe('X')
  })

  it('builds the interface table in bits per second', () => {
    const response: SnmpMetricsResponse = {
      series: [series('ifHCInOctets', '1', 'Inbound traffic (Gi1/0/1)', 'B/s', [[1, 1000], [2, 2000]]), series('ifHCOutOctets', '1', 'Outbound traffic (Gi1/0/1)', 'B/s', [[1, 500], [2, 500]])],
      current: [
        { key: 'ifOperStatus', index: '1', label: 'Operational status (Gi1/0/1)', unit: '', value: 1 },
        { key: 'ifOperStatus', index: '2', label: 'Operational status (Gi1/0/2)', unit: '', value: 2 },
        { key: 'ifInErrors', index: '1', label: 'Inbound errors (Gi1/0/1)', unit: 'errors/s', value: 0.5 },
      ],
    }
    const rows = interfaceRows(response)
    expect(rows.map((row) => [row.name, row.status])).toEqual([
      ['Gi1/0/1', 'up'],
      ['Gi1/0/2', 'down'],
    ])
    expect(rows[0]).toMatchObject({ inBps: 16_000, outBps: 4_000, inErrors: 0.5 })
    expect(rows[0].trend).toEqual([12_000, 20_000])
  })

  it('shapes printer supplies and the UPS panel', () => {
    const supplies = printerSupplies({
      series: [],
      current: [
        { key: 'prtMarkerSuppliesLevel', index: '1.2', label: 'Supply level (Cyan Toner)', unit: '%', value: 18 },
        { key: 'prtMarkerSuppliesLevel', index: '1.1', label: 'Supply level (Black Toner)', unit: '%', value: 8 },
        { key: 'prtMarkerSuppliesLevel', index: '1.5', label: 'Supply level (Imaging Drum)', unit: '%', value: 63 },
      ],
    })
    expect(supplies.map((supply) => [supply.name, supply.color, supply.state])).toEqual([
      ['Black Toner', 'black', 'critical'],
      ['Cyan Toner', 'cyan', 'warning'],
      ['Imaging Drum', 'other', 'ok'],
    ])
    const ups = upsPanel({
      series: [series('upsEstimatedChargeRemaining', null, 'Battery charge', '%', [[1, 90], [2, 100]])],
      current: [
        { key: 'upsBatteryStatus', index: null, label: 'Battery status', unit: '', value: 2 },
        { key: 'upsEstimatedMinutesRemaining', index: null, label: 'Runtime remaining', unit: 'min', value: 34 },
        { key: 'upsInputVoltage', index: '1', label: 'Input voltage (1)', unit: 'V', value: 120 },
        { key: 'upsOutputPercentLoad', index: '1', label: 'Load (1)', unit: '%', value: 44 },
      ],
    })
    expect(ups).toEqual({ battery: 'normal', chargePct: 100, runtimeMin: 34, inputVolts: 120, loadPct: 44, chargeTrend: [90, 100] })
    expect(upsPanel({ series: [] })).toBeNull()
  })

  it('treats thresholds as inclusive and formats by unit', () => {
    const above = { warn: 85, crit: 95, direction: 'above' as const }
    expect([84, 85, 94.9, 95].map((value) => thresholdState(value, above))).toEqual(['ok', 'warning', 'warning', 'critical'])
    const below = { warn: 20, crit: 10, direction: 'below' as const }
    expect([21, 20, 10].map((value) => thresholdState(value, below))).toEqual(['ok', 'warning', 'critical'])
    expect(formatSnmpValue(1_250_000, 'B/s')).toBe('10.0 Mb/s')
    expect(formatSnmpValue(7.5, '%')).toBe('7.5%')
    expect(formatSnmpValue(34, 'min')).toBe('34 min')
    expect(formatSnmpValue(null, '%')).toBe('—')
  })

  it('validates template metrics', () => {
    expect(validateMetrics([{ key: 'ok', label: '', oid: '1.3.6.1.2.1.1.3.0', unit: 's', kind: 'gauge' }])).toEqual([])
    const issues = validateMetrics([
      { key: '1bad', label: '', oid: 'abc', unit: '', kind: 'gauge' },
      { key: 'dup', label: '', oid: '1.3.6', unit: '%', kind: 'gauge', thresholds: { warn: 20, crit: 30, direction: 'below' } },
      { key: 'dup', label: '', oid: '1.3.6', unit: '', kind: 'text', thresholds: { warn: 1, direction: 'above' } },
    ])
    expect(issues.map((issue) => `${issue.index}:${issue.field}`)).toEqual(['0:key', '0:oid', '1:thresholds', '2:key', '2:thresholds'])
    expect(validateMetrics([])[0].index).toBe(-1)
  })

  it('matches trap OIDs on arc boundaries and names well-known traps', () => {
    expect(oidMatches('1.3.6.1.4.1.318', '1.3.6.1.4.1.318.0.5')).toBe(true)
    expect(oidMatches('1.3.6.1.4.1.318', '1.3.6.1.4.1.3180.1')).toBe(false)
    expect(oidMatches('.1.3.6.1.6.3.1.1.5.3', '1.3.6.1.6.3.1.1.5.3')).toBe(true)
    expect(trapName('1.3.6.1.6.3.1.1.5.3')).toBe('linkDown')
    expect(trapName('1.2.3')).toBeNull()
  })
})

describe('asset types', () => {
  it('has an icon and default templates for every type', () => {
    for (const type of ASSET_TYPES) {
      expect(ASSET_TYPE_ICON[type]).toBeTruthy()
      expect(defaultTemplatesFor(type)[0]).toBe('builtin-snmp-generic')
    }
    expect(defaultTemplatesFor('printer')).toContain('builtin-snmp-printer')
    expect(defaultTemplatesFor('ups')).toContain('builtin-snmp-ups')
    expect(defaultTemplatesFor('nas')).toEqual(['builtin-snmp-generic', 'builtin-snmp-host-resources', 'builtin-snmp-if-mib'])
  })

  it('guesses types from SNMP, ports, vendor and names', () => {
    expect(guessAssetType({ snmp_sys_descr: 'HP ETHERNET MULTI-ENVIRONMENT,JETDIRECT,JD153' })).toBe('printer')
    expect(guessAssetType({ snmp_sys_object_id: '1.3.6.1.4.1.318.1.3.27' })).toBe('ups')
    expect(guessAssetType({ open_ports: [80, 9100] })).toBe('printer')
    expect(guessAssetType({ open_ports: [80, 554] })).toBe('camera')
    expect(guessAssetType({ open_ports: [5000, 5001, 445] })).toBe('nas')
    expect(guessAssetType({ open_ports: [5060] })).toBe('phone')
    expect(guessAssetType({ vendor: 'Synology', open_ports: [22] })).toBe('nas')
    expect(guessAssetType({ vendor: 'Ubiquiti', hostname: 'nwd-ap-lobby' })).toBe('ap')
    expect(guessAssetType({ open_ports: [135, 139, 445, 3389] })).toBe('windows')
    expect(guessAssetType({ open_ports: [22] })).toBe('linux')
    expect(guessAssetType({ snmp_sys_descr: 'Cisco IOS Software, Catalyst L3 Switch Software' })).toBe('switch')
    expect(guessAssetType({ vendor: 'Espressif' })).toBe('unknown')
  })
})

describe('topology layout', () => {
  it('roots the tree at the probe with the LLDP subtree under it', () => {
    const layout = layoutTopology({
      nodes: [
        { id: 'device:p', kind: 'probe', label: 'probe', type: 'windows' },
        { id: 'snmp:sw', kind: 'snmp', label: 'Core switch', type: 'switch' },
        { id: 'asset:fw', kind: 'asset', label: 'fw', type: 'router' },
        { id: 'asset:ap', kind: 'asset', label: 'ap', type: 'ap' },
        { id: 'asset:prn', kind: 'asset', label: 'printer', type: 'printer' },
      ],
      edges: [
        { from: 'device:p', to: 'snmp:sw', kind: 'arp' },
        { from: 'device:p', to: 'asset:prn', kind: 'arp' },
        { from: 'snmp:sw', to: 'asset:fw', kind: 'lldp', local_port: 'Port 1' },
        { from: 'snmp:sw', to: 'asset:ap', kind: 'lldp', local_port: 'Port 3' },
      ],
    })
    const at = (id: string) => layout.nodes.find((node) => node.node.id === id)!
    expect(at('device:p').depth).toBe(0)
    expect(at('snmp:sw').depth).toBe(1)
    expect(at('asset:fw').depth).toBe(2)
    expect(at('asset:prn').depth).toBe(1)
    const lldp = layout.links.filter((link) => link.kind === 'lldp')
    expect(lldp.map((link) => link.localPort).sort()).toEqual(['Port 1', 'Port 3'])
    // Parents sit between their children.
    expect(at('snmp:sw').y).toBe((at('asset:ap').y + at('asset:fw').y) / 2)
    expect(new Set(layout.nodes.map((node) => `${node.x}:${node.y}`)).size).toBe(layout.nodes.length)
  })
})
