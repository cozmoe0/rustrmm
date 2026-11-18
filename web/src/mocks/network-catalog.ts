/* The server's built-in SNMP templates (refreshed at start-up, read-only) and well-known trap OIDs. */
import type { SnmpMetricDef, SnmpTemplate } from '@/lib/api/types'
import { BUILTIN_TEMPLATE } from '@/lib/network/assets'

const IF_DESCR = '1.3.6.1.2.1.2.2.1.2'

const m = (
  key: string,
  label: string,
  oid: string,
  unit: string,
  kind: SnmpMetricDef['kind'],
  extra: Partial<SnmpMetricDef> = {},
): SnmpMetricDef => ({ key, label, oid, unit, kind, table: false, index_label_oid: null, max_oid: null, thresholds: null, ...extra })

const CREATED = '2026-01-01T00:00:00.000Z'

export const BUILTIN_TEMPLATES: SnmpTemplate[] = [
  {
    id: BUILTIN_TEMPLATE.generic,
    name: 'Generic',
    builtin: true,
    created_at: CREATED,
    updated_at: CREATED,
    metrics: [m('sysUpTime', 'Uptime', '1.3.6.1.2.1.1.3.0', 's', 'gauge'), m('sysDescr', 'Description', '1.3.6.1.2.1.1.1.0', '', 'text')],
  },
  {
    id: BUILTIN_TEMPLATE.interfaces,
    name: 'Interfaces (IF-MIB)',
    builtin: true,
    created_at: CREATED,
    updated_at: CREATED,
    metrics: [
      m('ifHCInOctets', 'Inbound traffic', '1.3.6.1.2.1.31.1.1.1.6', 'B/s', 'counter', { table: true, index_label_oid: IF_DESCR }),
      m('ifHCOutOctets', 'Outbound traffic', '1.3.6.1.2.1.31.1.1.1.10', 'B/s', 'counter', { table: true, index_label_oid: IF_DESCR }),
      m('ifOperStatus', 'Operational status (1 up, 2 down)', '1.3.6.1.2.1.2.2.1.8', '', 'gauge', { table: true, index_label_oid: IF_DESCR }),
      m('ifInErrors', 'Inbound errors', '1.3.6.1.2.1.2.2.1.14', 'errors/s', 'counter', { table: true, index_label_oid: IF_DESCR }),
      m('ifOutErrors', 'Outbound errors', '1.3.6.1.2.1.2.2.1.20', 'errors/s', 'counter', { table: true, index_label_oid: IF_DESCR }),
      m('lldpRemSysName', 'LLDP neighbour', '1.0.8802.1.1.2.1.4.1.1.9', '', 'text', { table: true }),
    ],
  },
  {
    id: BUILTIN_TEMPLATE.hostResources,
    name: 'Host resources',
    builtin: true,
    created_at: CREATED,
    updated_at: CREATED,
    metrics: [
      m('hrProcessorLoad', 'CPU load', '1.3.6.1.2.1.25.3.3.1.2', '%', 'gauge', { table: true, thresholds: { warn: 85, crit: 95, direction: 'above' } }),
      m('hrStorageUsed', 'Storage used', '1.3.6.1.2.1.25.2.3.1.6', '%', 'gauge', {
        table: true,
        index_label_oid: '1.3.6.1.2.1.25.2.3.1.3',
        max_oid: '1.3.6.1.2.1.25.2.3.1.5',
        thresholds: { warn: 85, crit: 95, direction: 'above' },
      }),
    ],
  },
  {
    id: BUILTIN_TEMPLATE.printer,
    name: 'Printer-MIB',
    builtin: true,
    created_at: CREATED,
    updated_at: CREATED,
    metrics: [
      m('prtMarkerSuppliesLevel', 'Supply level', '1.3.6.1.2.1.43.11.1.1.9', '%', 'gauge', {
        table: true,
        index_label_oid: '1.3.6.1.2.1.43.11.1.1.6',
        max_oid: '1.3.6.1.2.1.43.11.1.1.8',
        thresholds: { warn: 20, crit: 10, direction: 'below' },
      }),
      m('hrPrinterStatus', 'Printer status (3 idle, 4 printing, 5 warming up)', '1.3.6.1.2.1.25.3.5.1.1', '', 'gauge', { table: true }),
    ],
  },
  {
    id: BUILTIN_TEMPLATE.ups,
    name: 'UPS-MIB',
    builtin: true,
    created_at: CREATED,
    updated_at: CREATED,
    metrics: [
      m('upsBatteryStatus', 'Battery status (2 normal, 3 low, 4 depleted)', '1.3.6.1.2.1.33.1.2.1.0', '', 'gauge', { thresholds: { warn: 3, crit: 4, direction: 'above' } }),
      m('upsEstimatedChargeRemaining', 'Battery charge', '1.3.6.1.2.1.33.1.2.4.0', '%', 'gauge', { thresholds: { warn: 50, crit: 20, direction: 'below' } }),
      m('upsEstimatedMinutesRemaining', 'Runtime remaining', '1.3.6.1.2.1.33.1.2.3.0', 'min', 'gauge', { thresholds: { warn: 15, crit: 5, direction: 'below' } }),
      m('upsInputVoltage', 'Input voltage', '1.3.6.1.2.1.33.1.3.3.1.3', 'V', 'gauge', { table: true }),
      m('upsOutputPercentLoad', 'Load', '1.3.6.1.2.1.33.1.4.4.1.5', '%', 'gauge', { table: true, thresholds: { warn: 80, crit: 95, direction: 'above' } }),
    ],
  },
]

export const TRAP_OID = {
  coldStart: '1.3.6.1.6.3.1.1.5.1',
  linkDown: '1.3.6.1.6.3.1.1.5.3',
  linkUp: '1.3.6.1.6.3.1.1.5.4',
  authFailure: '1.3.6.1.6.3.1.1.5.5',
  apcOnBattery: '1.3.6.1.4.1.318.0.5',
  apcPowerRestored: '1.3.6.1.4.1.318.0.9',
  printerAlert: '1.3.6.1.2.1.43.18.2.0.1',
} as const
