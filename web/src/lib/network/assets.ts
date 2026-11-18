/*
 * Discovered asset types: labels, icons, the default SNMP templates per type, and a type guess built from
 * the same signals the server uses (sysDescr/sysObjectID keywords, open ports, OUI vendor, names). The
 * console shows the server's `type_guess`; the guess here backs the mock and previews.
 */
import type { LucideIcon } from 'lucide-react'
import {
  BatteryCharging,
  Cctv,
  CircleQuestionMark,
  HardDrive,
  Laptop,
  Monitor,
  Network,
  Phone,
  Printer,
  Router,
  Server,
  Wifi,
} from 'lucide-react'
import type { AssetType } from '@/lib/api/types'

export const ASSET_TYPES: AssetType[] = ['printer', 'switch', 'router', 'ap', 'nas', 'camera', 'phone', 'ups', 'windows', 'linux', 'mac', 'unknown']

export const ASSET_TYPE_LABEL: Record<AssetType, string> = {
  printer: 'Printer',
  switch: 'Switch',
  router: 'Router / firewall',
  ap: 'Access point',
  nas: 'NAS',
  camera: 'Camera',
  phone: 'IP phone',
  windows: 'Windows',
  linux: 'Linux',
  mac: 'Mac',
  ups: 'UPS',
  unknown: 'Unknown',
}

export const ASSET_TYPE_ICON: Record<AssetType, LucideIcon> = {
  printer: Printer,
  switch: Network,
  router: Router,
  ap: Wifi,
  nas: HardDrive,
  camera: Cctv,
  phone: Phone,
  windows: Monitor,
  linux: Server,
  mac: Laptop,
  ups: BatteryCharging,
  unknown: CircleQuestionMark,
}

/** Infrastructure types worth monitoring over SNMP (shown first in the "Monitor via SNMP" flow). */
export const SNMP_FRIENDLY: AssetType[] = ['printer', 'switch', 'router', 'ap', 'nas', 'ups']

export function isAssetType(value: unknown): value is AssetType {
  return typeof value === 'string' && (ASSET_TYPES as string[]).includes(value)
}

export const BUILTIN_TEMPLATE = {
  generic: 'builtin-snmp-generic',
  interfaces: 'builtin-snmp-if-mib',
  hostResources: 'builtin-snmp-host-resources',
  printer: 'builtin-snmp-printer',
  ups: 'builtin-snmp-ups',
} as const

/** The server's defaults when an asset becomes an SNMP device. */
export function defaultTemplatesFor(type: AssetType): string[] {
  switch (type) {
    case 'printer':
      return [BUILTIN_TEMPLATE.generic, BUILTIN_TEMPLATE.printer]
    case 'ups':
      return [BUILTIN_TEMPLATE.generic, BUILTIN_TEMPLATE.ups]
    case 'switch':
    case 'router':
    case 'ap':
      return [BUILTIN_TEMPLATE.generic, BUILTIN_TEMPLATE.interfaces]
    case 'nas':
    case 'windows':
    case 'linux':
    case 'mac':
      return [BUILTIN_TEMPLATE.generic, BUILTIN_TEMPLATE.hostResources, BUILTIN_TEMPLATE.interfaces]
    default:
      return [BUILTIN_TEMPLATE.generic]
  }
}

/** Well-known ports shown with a name in asset details. */
export const PORT_NAME: Record<number, string> = {
  22: 'SSH',
  23: 'Telnet',
  53: 'DNS',
  80: 'HTTP',
  139: 'NetBIOS',
  161: 'SNMP',
  443: 'HTTPS',
  445: 'SMB',
  515: 'LPD',
  548: 'AFP',
  554: 'RTSP',
  631: 'IPP',
  3389: 'RDP',
  5000: 'NAS web',
  5001: 'NAS web (TLS)',
  5060: 'SIP',
  5061: 'SIP (TLS)',
  8080: 'HTTP alt',
  8443: 'HTTPS alt',
  9100: 'JetDirect',
}

export interface AssetSignals {
  vendor?: string | null
  hostname?: string | null
  open_ports?: number[]
  snmp_sys_descr?: string | null
  snmp_sys_object_id?: string | null
  mdns?: string[]
}

const DESCR_RULES: [RegExp, AssetType][] = [
  [/\b(printer|laserjet|officejet|jetdirect|imagerunner|bizhub|workcentre|zebra|ecosys)\b/i, 'printer'],
  [/\b(smart-ups|ups|powerware|eaton 5px|network management card)\b/i, 'ups'],
  [/\b(diskstation|synology|qnap|readynas|truenas)\b/i, 'nas'],
  [/\b(access point|unifi ap|uap|aruba ap|instant on ap|wap)\b/i, 'ap'],
  [/\b(fortigate|fortios|edgerouter|routeros|mikrotik|pfsense|opnsense|sonicwall|asa|isr\d*)\b/i, 'router'],
  [/\b(switch|catalyst|procurve|aruba \d{4}|usw|ex\d{4}|netgear gs\d+)\b/i, 'switch'],
  [/\b(camera|hikvision|axis|dahua|ipc)\b/i, 'camera'],
  [/\b(yealink|polycom|grandstream|cisco ip phone|sip-t\d+)\b/i, 'phone'],
  [/\bdarwin\b|\bmacos\b/i, 'mac'],
  [/\bwindows\b/i, 'windows'],
  [/\blinux\b/i, 'linux'],
]

const VENDOR_RULES: [RegExp, AssetType][] = [
  [/\b(brother|canon|epson|lexmark|xerox|kyocera|ricoh|zebra|konica)\b/i, 'printer'],
  [/\b(american power conversion|apc|eaton|cyberpower|vertiv)\b/i, 'ups'],
  [/\b(synology|qnap|western digital|buffalo)\b/i, 'nas'],
  [/\b(hikvision|axis|dahua|hanwha|reolink)\b/i, 'camera'],
  [/\b(yealink|polycom|poly|grandstream|snom|mitel)\b/i, 'phone'],
  [/\b(fortinet|sonicwall|palo alto|netgate|mikrotik)\b/i, 'router'],
  [/\b(apple)\b/i, 'mac'],
]

/** The server's heuristics, in order: SNMP description, decisive ports, vendor, names, then OS ports. */
export function guessAssetType(signals: AssetSignals): AssetType {
  const descr = signals.snmp_sys_descr ?? ''
  for (const [pattern, type] of DESCR_RULES) if (descr && pattern.test(descr)) return type
  if (signals.snmp_sys_object_id?.startsWith('1.3.6.1.4.1.318.')) return 'ups'
  const ports = new Set(signals.open_ports ?? [])
  if (ports.has(9100) || ports.has(631) || ports.has(515)) return 'printer'
  if (ports.has(554)) return 'camera'
  if (ports.has(5000) || ports.has(5001)) return 'nas'
  if (ports.has(5060) || ports.has(5061)) return 'phone'
  const vendor = signals.vendor ?? ''
  for (const [pattern, type] of VENDOR_RULES) if (vendor && pattern.test(vendor)) return type
  const name = `${signals.hostname ?? ''} ${(signals.mdns ?? []).join(' ')}`
  if (/\b(ap|wap)[-_\d]|unifi-ap|\bu6-|\buap-/i.test(name)) return 'ap'
  if (/\b(sw|switch)[-_\d]/i.test(name)) return 'switch'
  if (/\b(prn|printer)[-_\d]/i.test(name)) return 'printer'
  if (ports.has(3389) || (ports.has(445) && ports.has(139))) return 'windows'
  if (ports.has(548) || /\.local$/i.test(signals.hostname ?? '') && /mac|imac|mbp/i.test(name)) return 'mac'
  if (ports.has(22)) return 'linux'
  return 'unknown'
}

/** A display name: host name, then SNMP sysName, NetBIOS or mDNS name, then the address. */
export function assetName(asset: { hostname?: string | null; snmp_sys_name?: string | null; netbios_name?: string | null; mdns?: string[]; ip: string }): string {
  return asset.hostname || asset.snmp_sys_name || asset.netbios_name || asset.mdns?.[0] || asset.ip
}
