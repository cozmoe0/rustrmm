/*
 * Phase 10 network seed: probes for three sites (Northwind Main Clinic, Summit Freight HQ, Meridian Data
 * Room), scans with run history, discovered assets (printers, switches, APs, NAS, cameras, phones, UPSes,
 * managed PCs and a few unknowns), SNMP credentials, a custom template, monitored SNMP devices with
 * simulation profiles, trap rules and a week of traps. SNMP alerts are opened by the simulator's first sweep.
 */
import type { AssetType, Client, Site, SnmpTemplate, SnmpTrap, TrapRule } from '@/lib/api/types'
import { BUILTIN_TEMPLATE, guessAssetType } from '@/lib/network/assets'
import { hashString, inventoryFor, rng, type MockDevice } from './devices'
import { TRAP_OID } from './network-catalog'
import {
  DEFAULT_METHODS,
  type MockCredential,
  type MockNetwork,
  type MockProbe,
  type MockScan,
  type MockScanRun,
  type MockSnmpDevice,
  type SnmpSim,
} from './network-state'

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString()

interface AssetSpec {
  ip: string
  vendor: string | null
  hostname?: string | null
  ports?: number[]
  descr?: string
  sysName?: string
  objectId?: string
  mdns?: string[]
  netbios?: string
  notes?: string
  ignored?: boolean
  type?: AssetType
  /** Days ago the asset was first seen. */
  first?: number
}

const SITE_ASSETS: Record<string, { client: string; site: string; probe: string; assets: AssetSpec[] }> = {
  northwind: {
    client: 'Northwind Dental',
    site: 'Main Clinic',
    probe: 'NWD-DC01',
    assets: [
      { ip: '10.12.1.1', vendor: 'Fortinet', hostname: 'nwd-fw01', ports: [22, 443], descr: 'FortiGate-40F v7.4.5,build2702,241220 (GA.M)', sysName: 'nwd-fw01', objectId: '1.3.6.1.4.1.12356.101.1.441' },
      { ip: '10.12.1.2', vendor: 'Ubiquiti', hostname: 'nwd-core-sw', ports: [22, 80, 443, 161], descr: 'UniFi Switch USW-Pro-24-PoE, 7.1.26.15869', sysName: 'nwd-core-sw' },
      { ip: '10.12.1.3', vendor: 'Ubiquiti', hostname: 'nwd-ap-lobby', ports: [22], mdns: ['U6-Pro-Lobby._ubnt._tcp'], descr: 'UniFi AP U6-Pro 6.6.77' },
      { ip: '10.12.1.4', vendor: 'Ubiquiti', hostname: 'nwd-ap-ops', ports: [22], mdns: ['U6-Pro-Ops._ubnt._tcp'], descr: 'UniFi AP U6-Pro 6.6.77' },
      { ip: '10.12.1.20', vendor: 'HP Inc.', hostname: 'NWD-FRONT-PRN', ports: [80, 443, 515, 631, 9100, 161], descr: 'HP ETHERNET MULTI-ENVIRONMENT,ROM none,JETDIRECT,JD153,EEPROM JSI24090039', sysName: 'HP LaserJet Pro M404dn' },
      { ip: '10.12.1.21', vendor: 'Brother Industries', hostname: 'BRN30055C8A1F2', ports: [80, 631, 9100], mdns: ['Brother QL-820NWB._ipp._tcp'], first: 41 },
      { ip: '10.12.1.30', vendor: 'Synology', hostname: 'nwd-imaging-nas', ports: [22, 80, 443, 445, 5000, 5001, 161], descr: 'Synology DiskStation DS920+ DSM 7.2.2-72806', sysName: 'nwd-imaging-nas' },
      { ip: '10.12.1.40', vendor: 'Hikvision', hostname: null, ports: [80, 554, 8000], netbios: undefined, notes: 'Parking lot camera (NVR in the server closet).' },
      { ip: '10.12.1.41', vendor: 'Hikvision', hostname: null, ports: [80, 554] },
      { ip: '10.12.1.50', vendor: 'American Power Conversion', hostname: 'nwd-rack-ups', ports: [80, 443, 161], descr: 'APC Web/SNMP Management Card (MB:v4.1.0 PF:v6.9.6 MN:AP9631 HR:05)', objectId: '1.3.6.1.4.1.318.1.3.27', sysName: 'nwd-rack-ups' },
      { ip: '10.12.1.60', vendor: 'Yealink', hostname: 'SIP-T54W-front', ports: [80, 443, 5060] },
      { ip: '10.12.1.61', vendor: 'Yealink', hostname: 'SIP-T54W-ops', ports: [80, 443, 5060] },
      { ip: '10.12.1.62', vendor: 'Yealink', hostname: 'SIP-T33G-lab', ports: [80, 5060], first: 12 },
      { ip: '10.12.1.77', vendor: 'Dell Inc.', hostname: null, netbios: 'NWD-XRAY-SENSOR', ports: [135, 139, 445, 3389], notes: 'Vendor-managed sensor PC (Carestream); the vendor does not allow our agent.' },
      { ip: '10.12.1.87', vendor: 'Espressif', hostname: null, ports: [], first: 3 },
      { ip: '10.12.1.112', vendor: null, hostname: null, ports: [62078], mdns: ['iPhone._companion-link._tcp'], first: 1 },
      { ip: '10.12.1.199', vendor: 'Samsung Electronics', hostname: 'Samsung-Q60', ports: [8001, 8002], ignored: true, notes: 'Waiting room TV; moving to the guest VLAN.' },
    ],
  },
  summit: {
    client: 'Summit Freight',
    site: 'Headquarters',
    probe: 'sf-edge-gw',
    assets: [
      { ip: '10.60.1.1', vendor: 'Fortinet', hostname: 'sf-hq-fw', ports: [22, 443, 161], descr: 'FortiGate-100F v7.4.5,build2702', sysName: 'sf-hq-fw', objectId: '1.3.6.1.4.1.12356.101.1.1041' },
      { ip: '10.60.1.2', vendor: 'Cisco Systems', hostname: 'sf-hq-core', ports: [22, 443, 161], descr: 'Cisco IOS Software [Cupertino], Catalyst L3 Switch Software (CAT9K_LITE_IOSXE), Version 17.9.4a', sysName: 'sf-hq-core' },
      { ip: '10.60.1.3', vendor: 'Cisco Systems', hostname: 'sf-hq-idf2', ports: [22, 161], descr: 'Cisco IOS Software, C1000 Software (C1000-UNIVERSALK9-M), Version 15.2(7)E10, Catalyst 1000-48P switch', sysName: 'sf-hq-idf2' },
      { ip: '10.60.1.10', vendor: 'Hewlett Packard Enterprise', hostname: 'sf-ap-dispatch', ports: [80, 443], descr: 'Aruba Instant On AP22 access point 3.2.0' },
      { ip: '10.60.1.11', vendor: 'Hewlett Packard Enterprise', hostname: 'sf-ap-yard', ports: [80, 443], descr: 'Aruba Instant On AP22 access point 3.2.0' },
      { ip: '10.60.1.25', vendor: 'Zebra Technologies', hostname: 'SF-LBL-ZT411', ports: [80, 9100, 161], descr: 'Zebra ZT411 Industrial Printer, V92.21.27Z', sysName: 'SF-LBL-ZT411' },
      { ip: '10.60.1.26', vendor: 'Canon', hostname: 'SF-HQ-MFP', ports: [80, 443, 515, 631, 9100], descr: 'Canon iR-ADV DX C3826 /P' },
      { ip: '10.60.1.35', vendor: 'QNAP Systems', hostname: 'sf-backup-nas', ports: [22, 443, 445, 8080] },
      { ip: '10.60.1.45', vendor: 'Axis Communications', hostname: 'yard-cam-01', ports: [80, 443, 554] },
      { ip: '10.60.1.46', vendor: 'Axis Communications', hostname: 'yard-cam-02', ports: [80, 443, 554] },
      { ip: '10.60.1.55', vendor: 'Eaton', hostname: 'sf-hq-ups', ports: [80, 443, 161], descr: 'Eaton 5PX 2200 Network-M2 card 2.1.3', sysName: 'sf-hq-ups' },
      { ip: '10.60.1.140', vendor: 'Raspberry Pi Trading', hostname: 'forklift-hub', ports: [22, 1883], first: 6, notes: 'Forklift telemetry hub installed by the leasing company?' },
      { ip: '10.60.1.141', vendor: 'Tuya Smart', hostname: null, ports: [6668], first: 2 },
      { ip: '10.60.11.21', vendor: 'Polycom', hostname: 'VVX450-dispatch1', ports: [80, 443, 5060] },
      { ip: '10.60.11.22', vendor: 'Polycom', hostname: 'VVX450-dispatch2', ports: [80, 443, 5060] },
      { ip: '10.60.11.23', vendor: 'Polycom', hostname: 'VVX450-cfo', ports: [80, 443, 5060] },
    ],
  },
  meridian: {
    client: 'Meridian Credit Union',
    site: 'Data Room',
    probe: 'mcu-backup-01',
    assets: [
      { ip: '10.80.4.1', vendor: 'Cisco Systems', hostname: 'mcu-dr-sw01', ports: [22, 161], descr: 'Cisco IOS Software [Dublin], Catalyst L3 Switch Software (CAT9K_IOSXE), Version 17.12.3', sysName: 'mcu-dr-sw01' },
      { ip: '10.80.4.5', vendor: 'American Power Conversion', hostname: 'mcu-dr-ups', ports: [80, 443, 161], descr: 'APC Web/SNMP Management Card (MB:v4.5.4 PF:v2.6.3 MN:AP9641 HR:01) Smart-UPS SRT 3000', objectId: '1.3.6.1.4.1.318.1.3.28', sysName: 'mcu-dr-ups' },
      { ip: '10.80.4.6', vendor: 'Dell Inc.', hostname: 'mcu-core-app-idrac', ports: [22, 80, 443], notes: 'iDRAC9 of mcu-core-app.' },
      { ip: '10.80.4.10', vendor: 'Synology', hostname: 'mcu-dr-nas', ports: [22, 443, 445, 5001, 161], descr: 'Synology RackStation RS1221+ DSM 7.2.2-72806', sysName: 'mcu-dr-nas' },
    ],
  },
}

function mac(r: ReturnType<typeof rng>, vendorPrefix?: string) {
  const tail = Array.from({ length: 3 }, () => r.hex(2)).join(':').toUpperCase()
  return `${vendorPrefix ?? Array.from({ length: 3 }, () => r.hex(2)).join(':').toUpperCase()}:${tail}`
}

const OUI: Record<string, string> = {
  Fortinet: '04:D5:90',
  Ubiquiti: '78:45:58',
  'HP Inc.': 'A0:8C:FD',
  'Brother Industries': '30:05:5C',
  Synology: '00:11:32',
  Hikvision: 'BC:AD:28',
  'American Power Conversion': '00:C0:B7',
  Yealink: '80:5E:C0',
  'Dell Inc.': 'D0:94:66',
  Espressif: '24:0A:C4',
  'Samsung Electronics': '8C:79:F5',
  'Cisco Systems': '00:1B:54',
  'Hewlett Packard Enterprise': '20:4C:03',
  'Zebra Technologies': '00:07:4D',
  Canon: '00:1E:8F',
  'QNAP Systems': '24:5E:BE',
  'Axis Communications': 'AC:CC:8E',
  Eaton: '00:20:85',
  'Raspberry Pi Trading': 'D8:3A:DD',
  'Tuya Smart': '10:D5:61',
  Polycom: '00:04:F2',
}

export function seedNetwork(input: { clients: Client[]; sites: Site[]; devices: MockDevice[]; now: number; id: () => string }): MockNetwork {
  const { clients, sites, devices, now, id } = input
  const r = rng(hashString('phase-10-network'))
  const network: MockNetwork = {
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
  const siteOf = (clientName: string, siteName: string) => {
    const client = clients.find((item) => item.name === clientName)!
    return { client, site: sites.find((item) => item.client_id === client.id && item.name === siteName)! }
  }
  const host = (hostname: string) => devices.find((device) => device.hostname === hostname && device.status === 'active')!

  // ------------------------------------------------------------ credentials and templates
  const credential = (spec: Omit<MockCredential, 'id' | 'created_at' | 'updated_at'>, daysAgo: number): MockCredential => {
    const created = iso(now - daysAgo * DAY)
    const item = { id: id(), created_at: created, updated_at: created, ...spec }
    network.credentials.push(item)
    return item
  }
  const clinic = credential({ name: 'Northwind read-only (v2c)', version: 'v2c', community: 'nwd-ro-7Hq2pX', username: null, auth: 'none', privacy: 'none', auth_password: null, privacy_password: null }, 60)
  const summitV3 = credential({ name: 'Summit monitoring (v3)', version: 'v3', community: null, username: 'rmm-monitor', auth: 'sha256', privacy: 'aes128', auth_password: 'Fx9!c2Lr8wQz', privacy_password: 'p7Kd#4mVy2Ns' }, 45)
  const meridianV3 = credential({ name: 'Meridian monitoring (v3)', version: 'v3', community: null, username: 'mcu-snmp', auth: 'sha', privacy: 'aes128', auth_password: 'Mq3$vT8hLz1e', privacy_password: 'Hr6%nB2wKx9u' }, 30)
  const publicCred = credential({ name: 'Factory default “public”', version: 'v2c', community: 'public', username: null, auth: 'none', privacy: 'none', auth_password: null, privacy_password: null }, 60)

  const fortigate: SnmpTemplate = {
    id: id(),
    name: 'Fortinet FortiGate',
    builtin: false,
    created_at: iso(now - 40 * DAY),
    updated_at: iso(now - 12 * DAY),
    metrics: [
      { key: 'fgSysCpuUsage', label: 'CPU usage', oid: '1.3.6.1.4.1.12356.101.4.1.3.0', table: false, index_label_oid: null, max_oid: null, unit: '%', kind: 'gauge', thresholds: { warn: 80, crit: 95, direction: 'above' } },
      { key: 'fgSysMemUsage', label: 'Memory usage', oid: '1.3.6.1.4.1.12356.101.4.1.4.0', table: false, index_label_oid: null, max_oid: null, unit: '%', kind: 'gauge', thresholds: { warn: 85, crit: 95, direction: 'above' } },
      { key: 'fgSysSesCount', label: 'Active sessions', oid: '1.3.6.1.4.1.12356.101.4.1.8.0', table: false, index_label_oid: null, max_oid: null, unit: 'sessions', kind: 'gauge', thresholds: null },
    ],
  }
  network.templates.push(fortigate)

  // ------------------------------------------------------------ probes, assets, scans
  for (const [key, spec] of Object.entries(SITE_ASSETS)) {
    const { client, site } = siteOf(spec.client, spec.site)
    const probe = host(spec.probe)
    const probeRecord: MockProbe = { site_id: site.id, device_id: probe.id, trap_receiver: true, trap_port: 162, assigned_at: iso(now - (key === 'meridian' ? 12 : 58) * DAY) }
    network.probes.push(probeRecord)

    const seen = (first = 0) => {
      const firstSeen = now - (first || r.between(20, 70)) * DAY - r.between(0, 600) * MINUTE
      return { first_seen_at: iso(firstSeen), last_seen_at: iso(now - r.between(20, 160) * MINUTE) }
    }
    for (const item of spec.assets) {
      const auto = guessAssetType({ vendor: item.vendor, hostname: item.hostname, open_ports: item.ports, snmp_sys_descr: item.descr, snmp_sys_object_id: item.objectId, mdns: item.mdns })
      network.assets.push({
        id: id(),
        site_id: site.id,
        client_id: client.id,
        ip: item.ip,
        mac: item.vendor ? mac(r, OUI[item.vendor]) : `${['DA', '5E', '72', 'AE'][r.between(0, 3)]}:${mac(r).slice(3)}`,
        vendor: item.vendor,
        hostname: item.hostname ?? null,
        type_auto: auto,
        type_override: item.type ?? null,
        managed_device_id: null,
        ...seen(item.first),
        open_ports: item.ports ?? [],
        snmp_sys_descr: item.descr ?? null,
        snmp_sys_name: item.sysName ?? null,
        snmp_sys_object_id: item.objectId ?? null,
        mdns: item.mdns ?? [],
        netbios_name: item.netbios ?? null,
        rtt_ms: Math.round((0.3 + r.next() * 4) * 10) / 10,
        notes: item.notes ?? '',
        ignored: item.ignored ?? false,
      })
    }
    // Managed devices of the site show up too (matched by the MAC in their network inventory).
    for (const device of devices.filter((candidate) => candidate.site_id === site.id && candidate.status === 'active' && candidate.last_ip)) {
      const inventoryMac = inventoryFor(device).network?.data.interfaces?.[0]?.mac ?? mac(r)
      const type: AssetType = device.os_family === 'windows' ? 'windows' : device.os_family === 'macos' ? 'mac' : 'linux'
      network.assets.push({
        id: id(),
        site_id: site.id,
        client_id: client.id,
        ip: device.last_ip!,
        mac: inventoryMac,
        vendor: device.manufacturer === 'Apple' ? 'Apple' : (device.manufacturer ?? null),
        hostname: device.hostname.toLowerCase(),
        type_auto: type,
        type_override: null,
        managed_device_id: device.id,
        first_seen_at: iso(Math.max(new Date(device.enrolled_at).getTime(), now - 60 * DAY)),
        last_seen_at: device.online ? iso(now - r.between(20, 160) * MINUTE) : (device.last_seen_at ?? iso(now - DAY)),
        open_ports: type === 'windows' ? [135, 139, 445, ...(device.os_name.includes('Server') ? [3389] : [])] : [22],
        snmp_sys_descr: null,
        snmp_sys_name: null,
        snmp_sys_object_id: null,
        mdns: [],
        netbios_name: type === 'windows' ? device.hostname.toUpperCase() : null,
        rtt_ms: Math.round((0.2 + r.next() * 1.5) * 10) / 10,
        notes: '',
        ignored: false,
      })
    }
  }

  const scan = (siteKey: keyof typeof SITE_ASSETS | { client: string; site: string }, spec: Omit<MockScan, 'id' | 'site_id' | 'client_id' | 'created_at' | 'updated_at'>, created: number): MockScan => {
    const where = typeof siteKey === 'string' ? SITE_ASSETS[siteKey] : siteKey
    const { client, site } = siteOf(where.client, where.site)
    const item: MockScan = { id: id(), site_id: site.id, client_id: client.id, created_at: iso(now - created * DAY), updated_at: iso(now - Math.min(created, 9) * DAY), ...spec }
    network.scans.push(item)
    return item
  }
  const runs = (target: MockScan, count: number, every: number, hosts: number, lastAgo: number, failures: number[] = []) => {
    for (let index = 0; index < count; index += 1) {
      const started = now - lastAgo - index * every
      const failed = failures.includes(index)
      const duration = failed ? null : r.between(28_000, 95_000)
      const run: MockScanRun = {
        id: id(),
        scan_id: target.id,
        site_id: target.site_id,
        status: failed ? 'failed' : 'succeeded',
        trigger: target.schedule ? 'schedule' : 'manual',
        hosts_found: failed ? 0 : hosts - (index % 3 === 2 ? 1 : 0),
        started_at: iso(started),
        finished_at: failed ? iso(started + 2 * HOUR) : iso(started + (duration ?? 0)),
        duration_ms: duration,
        error: failed ? 'The probe went offline during the scan; no final batch arrived within 2 hours' : null,
      }
      network.runs.push(run)
    }
  }
  const count = (siteKey: keyof typeof SITE_ASSETS, prefix = '') => {
    const { site } = siteOf(SITE_ASSETS[siteKey].client, SITE_ASSETS[siteKey].site)
    return network.assets.filter((asset) => asset.site_id === site.id && asset.ip.startsWith(prefix)).length
  }
  const nextAt = (hoursAhead: number) => iso(Math.ceil((now + hoursAhead * HOUR) / HOUR) * HOUR)
  const clinicLan = scan('northwind', { name: 'Main Clinic LAN', ranges: ['10.12.1.0/24'], methods: { ...DEFAULT_METHODS, tcp_ports: [22, 80, 443, 445, 554, 3389, 5000, 5060, 9100, 161] }, schedule: { cron: '0 */6 * * *', timezone: 'America/Denver' }, snmp_credential_ids: [clinic.id, publicCred.id], next_run_at: nextAt(3) }, 58)
  runs(clinicLan, 8, 6 * HOUR, count('northwind'), 2 * HOUR + 14 * MINUTE)
  const hqLan = scan('summit', { name: 'HQ LAN', ranges: ['10.60.1.0/24'], methods: DEFAULT_METHODS, schedule: { cron: '30 2 * * *', timezone: 'America/Los_Angeles' }, snmp_credential_ids: [summitV3.id, publicCred.id], next_run_at: nextAt(15) }, 50)
  runs(hqLan, 6, DAY, count('summit', '10.60.1.'), 9 * HOUR, [3])
  const voice = scan('summit', { name: 'HQ voice VLAN', ranges: ['10.60.11.0/24'], methods: { ...DEFAULT_METHODS, tcp_ports: [80, 443, 5060, 5061], snmp: false }, schedule: null, snmp_credential_ids: [], next_run_at: null }, 33)
  runs(voice, 2, 13 * DAY, count('summit', '10.60.11.'), 6 * DAY + 5 * HOUR)
  scan({ client: 'Summit Freight', site: 'Dock 4 Warehouse' }, { name: 'Dock 4 warehouse', ranges: ['10.60.2.0/24', '10.60.12.0/24'], methods: DEFAULT_METHODS, schedule: null, snmp_credential_ids: [summitV3.id], next_run_at: null }, 4)
  const dataRoom = scan('meridian', { name: 'Data room', ranges: ['10.80.4.0/24'], methods: DEFAULT_METHODS, schedule: { cron: '0 3 * * 0', timezone: 'America/Chicago' }, snmp_credential_ids: [meridianV3.id], next_run_at: nextAt(24 * 3 + 5) }, 12)
  runs(dataRoom, 2, 7 * DAY, count('meridian'), 2 * DAY + 4 * HOUR)

  // ------------------------------------------------------------ SNMP devices
  const assetAt = (ip: string) => network.assets.find((asset) => asset.ip === ip)!
  const snmp = (ip: string, spec: { name: string; credential: MockCredential; templates: string[]; interval: number; sim: Omit<SnmpSim, 'seed' | 'boot_at' | 'sys_descr' | 'down_since'> & { down_since?: number | null; bootDays?: number }; createdDays: number }) => {
    const asset = assetAt(ip)
    const seed = hashString(`${spec.name}:${ip}`)
    const down = spec.sim.down_since ?? null
    const device: MockSnmpDevice = {
      id: id(),
      site_id: asset.site_id,
      client_id: asset.client_id,
      asset_id: asset.id,
      name: spec.name,
      ip,
      port: 161,
      credential_id: spec.credential.id,
      template_ids: spec.templates,
      poll_interval_secs: spec.interval,
      enabled: true,
      status: down ? 'unreachable' : 'ok',
      last_poll_at: iso(down ?? now - r.between(10, Math.min(spec.interval, 240)) * 1000),
      sys_descr: asset.snmp_sys_descr,
      uptime_secs: null,
      last_error: down ? 'Request timed out (no response from 10.60.1.25:161 after 3 attempts)' : null,
      created_at: iso(now - spec.createdDays * DAY),
      updated_at: iso(now - Math.min(spec.createdDays, 6) * DAY),
      sim: { ...spec.sim, seed, sys_descr: asset.snmp_sys_descr ?? spec.name, boot_at: now - (spec.sim.bootDays ?? r.between(9, 140)) * DAY, down_since: down },
    }
    device.uptime_secs = down ? null : Math.round((now - device.sim.boot_at) / 1000)
    network.devices.push(device)
    return device
  }
  const ports = (count: number, prefix: string, up: number[], neighbours: Record<number, string> = {}, uplink?: { index: number; name: string; base: number; errors?: number }) => {
    const list = Array.from({ length: count }, (_, index) => ({
      index: String(index + 1),
      name: `${prefix}${index + 1}`,
      base: up.includes(index + 1) ? r.between(40_000, 1_800_000) : 0,
      up: up.includes(index + 1),
      neighbour: neighbours[index + 1],
    }))
    if (uplink) list.push({ index: String(uplink.index), name: uplink.name, base: uplink.base, up: true, neighbour: neighbours[uplink.index], errors: uplink.errors } as (typeof list)[number] & { errors?: number })
    return list
  }
  const generic = BUILTIN_TEMPLATE.generic
  snmp('10.12.1.20', {
    name: 'Front desk printer',
    credential: clinic,
    templates: [generic, BUILTIN_TEMPLATE.printer],
    interval: 300,
    createdDays: 55,
    sim: { kind: 'printer', supplies: [
      { index: '1', name: 'Black Toner', level: 8, use: 1.6 },
      { index: '2', name: 'Cyan Toner', level: 18, use: 0.7 },
      { index: '3', name: 'Magenta Toner', level: 54, use: 0.6 },
      { index: '4', name: 'Yellow Toner', level: 71, use: 0.5 },
      { index: '5', name: 'Imaging Drum', level: 63, use: 0.2 },
    ] },
  })
  snmp('10.12.1.2', {
    name: 'Core switch',
    credential: clinic,
    templates: [generic, BUILTIN_TEMPLATE.interfaces],
    interval: 60,
    createdDays: 57,
    sim: { kind: 'switch', interfaces: ports(12, 'Port ', [1, 2, 3, 4, 5, 6, 7, 9, 10, 11], { 1: 'nwd-fw01', 3: 'nwd-ap-lobby', 4: 'nwd-ap-ops' }, { index: 25, name: 'SFP+ 1', base: 6_400_000 }) },
  })
  snmp('10.12.1.50', { name: 'Rack UPS', credential: clinic, templates: [generic, BUILTIN_TEMPLATE.ups], interval: 120, createdDays: 57, sim: { kind: 'ups', ups: { charge: 100, runtime: 48, load: 31, voltage: 121 } } })
  snmp('10.12.1.30', {
    name: 'Imaging NAS',
    credential: clinic,
    templates: [generic, BUILTIN_TEMPLATE.hostResources, BUILTIN_TEMPLATE.interfaces],
    interval: 300,
    createdDays: 50,
    sim: { kind: 'nas', cpus: 4, cpu_base: 9, storage: [{ index: '31', name: 'Physical memory', used: 46 }, { index: '41', name: '/volume1', used: 78.4 }], interfaces: ports(2, 'eth', [1, 2]) },
  })
  snmp('10.60.1.2', {
    name: 'HQ core switch',
    credential: summitV3,
    templates: [generic, BUILTIN_TEMPLATE.interfaces],
    interval: 60,
    createdDays: 44,
    sim: { kind: 'switch', interfaces: [
      ...ports(10, 'GigabitEthernet1/0/', [1, 2, 3, 4, 5, 6, 8, 10], { 1: 'sf-hq-fw', 2: 'sf-hq-idf2', 5: 'sf-ap-dispatch', 6: 'sf-ap-yard' }),
      { index: '25', name: 'TenGigabitEthernet1/1/1', base: 9_800_000, up: true, errors: 1.8, neighbour: 'sf-wms-01' },
    ] },
  })
  snmp('10.60.1.1', { name: 'HQ firewall', credential: summitV3, templates: [generic, BUILTIN_TEMPLATE.interfaces, fortigate.id], interval: 60, createdDays: 44, sim: { kind: 'router', cpu_base: 18, interfaces: [{ index: '1', name: 'wan1', base: 3_200_000, up: true }, { index: '2', name: 'wan2', base: 0, up: false }, { index: '5', name: 'internal', base: 4_100_000, up: true }] } })
  snmp('10.60.1.25', { name: 'Shipping label printer', credential: summitV3, templates: [generic, BUILTIN_TEMPLATE.printer], interval: 300, createdDays: 30, sim: { kind: 'printer', supplies: [{ index: '1', name: 'Ribbon', level: 46, use: 2.1 }, { index: '2', name: 'Labels', level: 39, use: 3.4 }], down_since: now - 2 * DAY - 3 * HOUR } })
  snmp('10.60.1.55', { name: 'HQ UPS', credential: summitV3, templates: [generic, BUILTIN_TEMPLATE.ups], interval: 120, createdDays: 44, sim: { kind: 'ups', ups: { charge: 100, runtime: 22, load: 58, voltage: 119 } } })
  snmp('10.80.4.5', { name: 'Data room UPS', credential: meridianV3, templates: [generic, BUILTIN_TEMPLATE.ups], interval: 60, createdDays: 12, sim: { kind: 'ups', ups: { charge: 100, runtime: 34, load: 44, voltage: 120, outage: { at: now - 3 * DAY - 7 * HOUR, minutes: 23 } } } })
  snmp('10.80.4.1', { name: 'Data room switch', credential: meridianV3, templates: [generic, BUILTIN_TEMPLATE.interfaces], interval: 60, createdDays: 12, sim: { kind: 'switch', interfaces: ports(8, 'GigabitEthernet1/0/', [1, 2, 3, 4, 6], { 4: 'mcu-dr-ups' }) } })
  snmp('10.80.4.10', { name: 'Backup NAS', credential: meridianV3, templates: [generic, BUILTIN_TEMPLATE.hostResources], interval: 300, createdDays: 12, sim: { kind: 'nas', cpus: 4, cpu_base: 22, storage: [{ index: '31', name: 'Physical memory', used: 61 }, { index: '41', name: '/volume1', used: 89.6 }] } })

  // ------------------------------------------------------------ trap rules and traps
  const rule = (spec: Omit<TrapRule, 'id' | 'created_at' | 'updated_at'>, daysAgo: number): TrapRule => {
    const at = iso(now - daysAgo * DAY)
    const item = { id: id(), created_at: at, updated_at: at, ...spec }
    network.trapRules.push(item)
    return item
  }
  const onBattery = rule({ name: 'UPS on battery (APC)', enabled: true, oid_prefix: TRAP_OID.apcOnBattery, severity: 'critical', site_ids: [], title: 'UPS switched to battery' }, 40)
  rule({ name: 'Interface down', enabled: true, oid_prefix: TRAP_OID.linkDown, severity: 'warning', site_ids: [], title: 'Link down' }, 40)
  rule({ name: 'Printer alerts', enabled: false, oid_prefix: '1.3.6.1.2.1.43.18.2', severity: 'info', site_ids: [siteOf('Northwind Dental', 'Main Clinic').site.id], title: 'Printer reported an alert' }, 20)

  const deviceAt = (ip: string) => network.devices.find((device) => device.ip === ip)
  const trap = (ip: string, at: number, oid: string, varbinds: SnmpTrap['varbinds'], ruleId: string | null = null) => {
    const asset = network.assets.find((item) => item.ip === ip)!
    const device = deviceAt(ip)
    network.traps.push({
      id: id(),
      site_id: asset.site_id,
      snmp_device_id: device?.id ?? null,
      snmp_device_name: device?.name ?? null,
      from_ip: ip,
      at: iso(at),
      version: 'v2c',
      oid,
      varbinds,
      rule_id: ruleId,
      alert_id: null,
    })
  }
  const ifVar = (index: number, name: string, up: boolean): SnmpTrap['varbinds'] => [
    { oid: `1.3.6.1.2.1.2.2.1.1.${index}`, type: 'integer', value: index },
    { oid: `1.3.6.1.2.1.2.2.1.2.${index}`, type: 'string', value: name },
    { oid: `1.3.6.1.2.1.2.2.1.8.${index}`, type: 'integer', value: up ? 1 : 2 },
  ]
  for (let day = 6; day >= 0; day -= 1) {
    const at = now - day * DAY - r.between(1, 10) * HOUR
    trap('10.12.1.2', at, TRAP_OID.linkDown, ifVar(7, 'Port 7', false))
    trap('10.12.1.2', at + r.between(2, 40) * 1000, TRAP_OID.linkUp, ifVar(7, 'Port 7', true))
  }
  const outage = now - 3 * DAY - 7 * HOUR
  trap('10.80.4.5', outage + 2000, TRAP_OID.apcOnBattery, [{ oid: '1.3.6.1.4.1.318.2.3.3.0', type: 'string', value: 'UPS: On battery power in response to an input power problem.' }], onBattery.id)
  trap('10.80.4.5', outage + 23 * MINUTE, TRAP_OID.apcPowerRestored, [{ oid: '1.3.6.1.4.1.318.2.3.3.0', type: 'string', value: 'UPS: No longer on battery power.' }])
  trap('10.60.1.3', now - 4 * DAY - 2 * HOUR, TRAP_OID.coldStart, [])
  trap('10.60.1.2', now - 30 * HOUR, TRAP_OID.authFailure, [{ oid: '1.3.6.1.4.1.9.2.1.5.0', type: 'ip', value: '10.60.1.140' }])
  trap('10.12.1.20', now - 20 * HOUR, '1.3.6.1.2.1.43.18.2.0.1', [
    { oid: '1.3.6.1.2.1.43.18.1.1.8.1.14', type: 'string', value: 'Black toner low' },
    { oid: '1.3.6.1.2.1.43.18.1.1.2.1.14', type: 'integer', value: 4 },
  ])
  network.traps.sort((a, b) => b.at.localeCompare(a.at))
  return network
}
