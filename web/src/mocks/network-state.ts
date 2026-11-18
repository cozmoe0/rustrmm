/* Phase 10 mock state for network discovery and SNMP, plus the public shapes the handlers return. */
import type {
  AssetType,
  NetworkAsset,
  NetworkScan,
  NetworkSettings,
  ScanMethods,
  ScanSchedule,
  SiteProbe,
  SnmpCredential,
  SnmpDevice,
  SnmpTemplate,
  SnmpTrap,
  TrapRule,
} from '@/lib/api/types'
import { SECRET_MASK } from '@/lib/automation/params'

export interface MockProbe {
  site_id: string
  device_id: string
  trap_receiver: boolean
  trap_port: number
  assigned_at: string
}

export interface MockScan {
  id: string
  site_id: string
  client_id: string
  name: string
  ranges: string[]
  methods: ScanMethods
  schedule: ScanSchedule | null
  snmp_credential_ids: string[]
  next_run_at: string | null
  created_at: string
  updated_at: string
}

export interface MockScanRun {
  id: string
  scan_id: string
  site_id: string
  status: 'running' | 'succeeded' | 'failed'
  trigger: 'manual' | 'schedule'
  hosts_found: number
  started_at: string
  finished_at: string | null
  duration_ms: number | null
  error: string | null
  /** Mock clock: when a running run finishes. */
  finishes_at?: number
}

export interface MockAsset {
  id: string
  site_id: string
  client_id: string
  ip: string
  mac: string | null
  vendor: string | null
  hostname: string | null
  type_auto: AssetType
  type_override: AssetType | null
  managed_device_id: string | null
  first_seen_at: string
  last_seen_at: string
  open_ports: number[]
  snmp_sys_descr: string | null
  snmp_sys_name: string | null
  snmp_sys_object_id: string | null
  mdns: string[]
  netbios_name: string | null
  rtt_ms: number | null
  notes: string
  ignored: boolean
}

export interface MockCredential {
  id: string
  name: string
  version: 'v2c' | 'v3'
  community: string | null
  username: string | null
  auth: 'none' | 'sha' | 'sha256'
  privacy: 'none' | 'aes128'
  auth_password: string | null
  privacy_password: string | null
  created_at: string
  updated_at: string
}

export type SimKind = 'printer' | 'switch' | 'router' | 'ups' | 'nas' | 'generic'

export interface SimInterface {
  index: string
  name: string
  /** Typical inbound bytes per second. */
  base: number
  up: boolean
  errors?: number
  neighbour?: string
}

export interface SimSupply {
  index: string
  name: string
  /** Level now (%). */
  level: number
  /** Percentage points used per day. */
  use: number
}

export interface SnmpSim {
  kind: SimKind
  seed: number
  sys_descr: string
  boot_at: number
  /** When set, the device stopped answering at this time (ms). */
  down_since: number | null
  interfaces?: SimInterface[]
  supplies?: SimSupply[]
  storage?: { index: string; name: string; used: number }[]
  cpus?: number
  cpu_base?: number
  ups?: { charge: number; runtime: number; load: number; voltage: number; outage?: { at: number; minutes: number } }
}

export interface MockSnmpDevice extends Omit<SnmpDevice, 'site_name'> {
  client_id: string
  sim: SnmpSim
}

export interface MockNetwork {
  settings: NetworkSettings
  probes: MockProbe[]
  scans: MockScan[]
  runs: MockScanRun[]
  assets: MockAsset[]
  credentials: MockCredential[]
  /** Custom templates only; built-ins come from the catalog. */
  templates: SnmpTemplate[]
  devices: MockSnmpDevice[]
  traps: SnmpTrap[]
  trapRules: TrapRule[]
}

export function emptyNetwork(): MockNetwork {
  return {
    settings: { allow_public_ranges: false },
    probes: [],
    scans: [],
    runs: [],
    assets: [],
    credentials: [],
    templates: [],
    devices: [],
    traps: [],
    trapRules: [],
  }
}

export const DEFAULT_METHODS: ScanMethods = { icmp: true, arp: true, tcp_ports: [22, 80, 443, 445, 3389, 9100, 161], snmp: true, mdns: true, netbios: true }

interface Lookup {
  siteName: (id: string) => string | undefined
  deviceHostname: (id: string) => string | undefined
}

export function publicScan(scan: MockScan, runs: MockScanRun[], lookup: Lookup): NetworkScan {
  const last = runs.filter((run) => run.scan_id === scan.id).sort((a, b) => b.started_at.localeCompare(a.started_at))[0]
  return {
    id: scan.id,
    site_id: scan.site_id,
    site_name: lookup.siteName(scan.site_id),
    name: scan.name,
    ranges: scan.ranges,
    methods: scan.methods,
    schedule: scan.schedule,
    snmp_credential_ids: scan.snmp_credential_ids,
    next_run_at: scan.next_run_at,
    created_at: scan.created_at,
    updated_at: scan.updated_at,
    last_run: last ? { at: last.started_at, hosts_found: last.hosts_found, duration_ms: last.duration_ms, status: last.status, error: last.error } : null,
  }
}

export function publicAsset(asset: MockAsset, lookup: Lookup & { snmpDeviceFor: (assetId: string) => string | undefined }): NetworkAsset {
  return {
    id: asset.id,
    site_id: asset.site_id,
    site_name: lookup.siteName(asset.site_id),
    ip: asset.ip,
    mac: asset.mac,
    vendor: asset.vendor,
    hostname: asset.hostname,
    type_guess: asset.type_override ?? asset.type_auto,
    type_source: asset.type_override ? 'manual' : 'guess',
    managed_device_id: asset.managed_device_id,
    managed_hostname: asset.managed_device_id ? (lookup.deviceHostname(asset.managed_device_id) ?? null) : null,
    first_seen_at: asset.first_seen_at,
    last_seen_at: asset.last_seen_at,
    open_ports: asset.open_ports,
    snmp_sys_descr: asset.snmp_sys_descr,
    snmp_sys_name: asset.snmp_sys_name,
    snmp_sys_object_id: asset.snmp_sys_object_id,
    mdns: asset.mdns,
    netbios_name: asset.netbios_name,
    rtt_ms: asset.rtt_ms,
    notes: asset.notes,
    ignored: asset.ignored,
    snmp_device_id: lookup.snmpDeviceFor(asset.id) ?? null,
  }
}

export function publicCredential(credential: MockCredential): SnmpCredential {
  const mask = (value: string | null) => (value ? SECRET_MASK : null)
  return {
    id: credential.id,
    name: credential.name,
    version: credential.version,
    community: credential.version === 'v2c' ? mask(credential.community) : null,
    v3:
      credential.version === 'v3'
        ? {
            username: credential.username ?? '',
            auth: credential.auth,
            auth_password: mask(credential.auth_password),
            privacy: credential.privacy,
            privacy_password: mask(credential.privacy_password),
          }
        : null,
    created_at: credential.created_at,
    updated_at: credential.updated_at,
  }
}

export function publicSnmpDevice(device: MockSnmpDevice, siteName: string | undefined): SnmpDevice {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { client_id, sim, ...rest } = device
  return { ...rest, site_name: siteName }
}

export function publicProbe(probe: MockProbe | undefined, siteId: string, lookup: { siteName?: string; device?: { hostname: string; os_family: SiteProbe['os_family']; online: boolean } }): SiteProbe {
  if (!probe || !lookup.device) {
    return { site_id: siteId, site_name: lookup.siteName, device_id: null, hostname: null, os_family: null, online: false, trap_receiver: probe?.trap_receiver ?? false, trap_port: probe?.trap_port ?? 162, assigned_at: null }
  }
  return {
    site_id: siteId,
    site_name: lookup.siteName,
    device_id: probe.device_id,
    hostname: lookup.device.hostname,
    os_family: lookup.device.os_family,
    online: lookup.device.online,
    trap_receiver: probe.trap_receiver,
    trap_port: probe.trap_port,
    assigned_at: probe.assigned_at,
  }
}
