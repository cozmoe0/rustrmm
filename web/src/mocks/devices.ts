/*
 * Deterministic fictional fleet for the mock API: ~60 devices across the demo clients, plus
 * inventory, metrics, timelines, deploy keys and agent artifacts generated on demand from
 * each device's seed (so nothing heavy is persisted to localStorage).
 */
import type {
  AgentArtifact,
  Client,
  Device,
  DeviceType,
  EnrollmentToken,
  HealthReason,
  InventorySections,
  MetricPoint,
  MetricsRange,
  MetricsResponse,
  OsFamily,
  SecurityInventory,
  Site,
  SoftwareItem,
  TimelineEntry,
  TimelineSeverity,
} from '@/lib/api/types'

export interface MockDevice extends Device {
  notes: string
  seed: number
  /** Simulated agent state used by the generators. */
  sim: {
    cpuBase: number
    memBase: number
    diskBase: number
    avEnabled: boolean
    firewall: boolean
    encrypted: boolean
    pendingReboot: boolean
    extraAdmin: string | null
    industry: Industry
  }
  inventory_at: string
}

export interface MockToken extends EnrollmentToken {
  secret: string
}

type Industry = 'dental' | 'legal' | 'freight' | 'bakery' | 'vet' | 'architecture' | 'banking' | 'schools'

const DAY = 86_400_000
const HOUR = 3_600_000
const iso = (ms: number) => new Date(ms).toISOString()

// ------------------------------------------------------------------ deterministic random

function mulberry32(seed: number) {
  let state = seed
  return () => {
    state |= 0
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function hashString(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function rng(seed: number) {
  const next = mulberry32(seed)
  return {
    next,
    between: (min: number, max: number) => Math.floor(min + next() * (max - min + 1)),
    pick: <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
    chance: (p: number) => next() < p,
    hex: (length: number) => Array.from({ length }, () => Math.floor(next() * 16).toString(16)).join(''),
  }
}

function seededUuid(r: ReturnType<typeof rng>): string {
  const hex = r.hex(32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

// ------------------------------------------------------------------ catalogs

interface OsProfile {
  family: OsFamily
  name: string
  version: string
  build?: string
  display?: string
  edition?: string
  kernel: string
  id?: string
}

const OS: Record<string, OsProfile> = {
  win11: { family: 'windows', name: 'Windows 11 Pro', version: '10.0.26100', build: '26100', display: '24H2', edition: 'Professional', kernel: '26100' },
  win11e: { family: 'windows', name: 'Windows 11 Enterprise', version: '10.0.26200', build: '26200', display: '25H2', edition: 'Enterprise', kernel: '26200' },
  win10: { family: 'windows', name: 'Windows 10 Pro', version: '10.0.19045', build: '19045', display: '22H2', edition: 'Professional', kernel: '19045' },
  srv2022: { family: 'windows', name: 'Windows Server 2022 Standard', version: '10.0.20348', build: '20348', display: '21H2', edition: 'ServerStandard', kernel: '20348' },
  srv2025: { family: 'windows', name: 'Windows Server 2025 Datacenter', version: '10.0.26100', build: '26100', display: '24H2', edition: 'ServerDatacenter', kernel: '26100' },
  ubuntu: { family: 'linux', name: 'Ubuntu 24.04.3 LTS', version: '24.04', kernel: '6.8.0-87-generic', id: 'ubuntu' },
  rhel: { family: 'linux', name: 'Red Hat Enterprise Linux 9.6 (Plow)', version: '9.6', kernel: '5.14.0-570.25.1.el9_6.x86_64', id: 'rhel' },
  debian: { family: 'linux', name: 'Debian GNU/Linux 13 (trixie)', version: '13', kernel: '6.12.48+deb13-amd64', id: 'debian' },
  mac15: { family: 'macos', name: 'macOS 15.7.2', version: '15.7.2', build: '24G325', kernel: '24.6.0' },
  mac26: { family: 'macos', name: 'macOS 26.1', version: '26.1', build: '25B78', kernel: '25.1.0' },
}

interface HardwareProfile {
  manufacturer: string
  model: string
  cpu: string
  cores: number
  threads: number
  ramGb: number
  gpu?: string
  type: DeviceType
  arch?: string
  chip?: string
}

const HW: Record<string, HardwareProfile> = {
  optiplex: { manufacturer: 'Dell Inc.', model: 'OptiPlex Tower Plus 7020', cpu: 'Intel(R) Core(TM) i7-14700', cores: 20, threads: 28, ramGb: 32, gpu: 'Intel(R) UHD Graphics 770', type: 'workstation' },
  elitedesk: { manufacturer: 'HP', model: 'HP EliteDesk 800 G9 Desktop Mini PC', cpu: 'Intel(R) Core(TM) i5-12500T', cores: 6, threads: 12, ramGb: 16, gpu: 'Intel(R) UHD Graphics 770', type: 'workstation' },
  precision: { manufacturer: 'Dell Inc.', model: 'Precision 3680 Tower', cpu: 'Intel(R) Core(TM) i9-14900K', cores: 24, threads: 32, ramGb: 64, gpu: 'NVIDIA RTX 4000 Ada Generation', type: 'workstation' },
  nuc: { manufacturer: 'ASUSTeK COMPUTER INC.', model: 'NUC 14 Pro', cpu: 'Intel(R) Core(TM) Ultra 5 125H', cores: 14, threads: 18, ramGb: 16, gpu: 'Intel(R) Arc(TM) Graphics', type: 'workstation' },
  latitude: { manufacturer: 'Dell Inc.', model: 'Latitude 7450', cpu: 'Intel(R) Core(TM) Ultra 7 165U', cores: 12, threads: 14, ramGb: 16, gpu: 'Intel(R) Graphics', type: 'laptop' },
  thinkpad: { manufacturer: 'LENOVO', model: 'ThinkPad T14 Gen 5', cpu: 'AMD Ryzen 7 PRO 8840U w/ Radeon 780M Graphics', cores: 8, threads: 16, ramGb: 32, gpu: 'AMD Radeon(TM) 780M', type: 'laptop' },
  probook: { manufacturer: 'HP', model: 'HP ProBook 450 15.6 inch G10', cpu: 'Intel(R) Core(TM) i5-1335U', cores: 10, threads: 12, ramGb: 16, gpu: 'Intel(R) Iris(R) Xe Graphics', type: 'laptop' },
  surface: { manufacturer: 'Microsoft Corporation', model: 'Surface Laptop, 7th Edition', cpu: 'Snapdragon(R) X Elite - X1E80100', cores: 12, threads: 12, ramGb: 16, gpu: 'Qualcomm(R) Adreno(TM) X1-85 GPU', type: 'laptop', arch: 'aarch64' },
  poweredge: { manufacturer: 'Dell Inc.', model: 'PowerEdge R660', cpu: 'Intel(R) Xeon(R) Silver 4410Y', cores: 12, threads: 24, ramGb: 128, gpu: 'Matrox G200eW3', type: 'server' },
  proliant: { manufacturer: 'HPE', model: 'ProLiant DL360 Gen11', cpu: 'Intel(R) Xeon(R) Gold 5416S', cores: 16, threads: 32, ramGb: 256, type: 'server' },
  hyperv: { manufacturer: 'Microsoft Corporation', model: 'Virtual Machine', cpu: 'Intel(R) Xeon(R) Silver 4410Y', cores: 4, threads: 4, ramGb: 16, type: 'virtual' },
  vmware: { manufacturer: 'VMware, Inc.', model: 'VMware20,1', cpu: 'Intel(R) Xeon(R) Gold 6338 CPU @ 2.00GHz', cores: 4, threads: 4, ramGb: 12, type: 'virtual' },
  kvm: { manufacturer: 'QEMU', model: 'Standard PC (Q35 + ICH9, 2009)', cpu: 'AMD EPYC 9124 16-Core Processor', cores: 4, threads: 4, ramGb: 8, type: 'virtual' },
  mbp: { manufacturer: 'Apple', model: 'MacBook Pro (14-inch, 2024)', cpu: 'Apple M4 Pro', cores: 12, threads: 12, ramGb: 24, type: 'laptop', arch: 'aarch64', chip: 'Apple M4 Pro' },
  mba: { manufacturer: 'Apple', model: 'MacBook Air (13-inch, M3, 2024)', cpu: 'Apple M3', cores: 8, threads: 8, ramGb: 16, type: 'laptop', arch: 'aarch64', chip: 'Apple M3' },
  macmini: { manufacturer: 'Apple', model: 'Mac mini (2024)', cpu: 'Apple M4', cores: 10, threads: 10, ramGb: 16, type: 'workstation', arch: 'aarch64', chip: 'Apple M4' },
}

interface Template {
  client: number
  site: number
  host: string
  os: keyof typeof OS
  hw: keyof typeof HW
  user?: string
  tags?: string[]
  /** Hours since last contact when the device is offline. */
  offlineHours?: number
  status?: 'pending' | 'revoked'
  reenrolls?: string
  disk?: number
  cpu?: number
  noAv?: boolean
  noFirewall?: boolean
  unencrypted?: boolean
  reboot?: boolean
  admin?: string
  notes?: string
}

const CLIENT_INFO: { domain: string | null; netPrefix: string; industry: Industry }[] = [
  { domain: 'nwdental.local', netPrefix: '10.12', industry: 'dental' },
  { domain: 'harborpine.law', netPrefix: '10.40', industry: 'legal' },
  { domain: 'summitfreight.com', netPrefix: '10.60', industry: 'freight' },
  { domain: null, netPrefix: '192.168', industry: 'bakery' },
  { domain: 'cedarridgevet.local', netPrefix: '10.24', industry: 'vet' },
  { domain: null, netPrefix: '172.20', industry: 'architecture' },
  { domain: 'meridiancu.org', netPrefix: '10.80', industry: 'banking' },
  { domain: 'oakline.org', netPrefix: '10.90', industry: 'schools' },
]

const TEMPLATES: Template[] = [
  // Northwind Dental
  { client: 0, site: 0, host: 'NWD-FRONT-01', os: 'win11', hw: 'optiplex', user: 'NWD\\jlopez', tags: ['front-desk'] },
  { client: 0, site: 0, host: 'NWD-FRONT-02', os: 'win11', hw: 'optiplex', user: 'NWD\\mkhan', tags: ['front-desk'] },
  { client: 0, site: 0, host: 'NWD-OP1', os: 'win11', hw: 'elitedesk', user: 'NWD\\op1', tags: ['operatory'] },
  { client: 0, site: 0, host: 'NWD-OP2', os: 'win11', hw: 'elitedesk', user: 'NWD\\op2', tags: ['operatory'], offlineHours: 3 },
  { client: 0, site: 0, host: 'NWD-DRCHEN-LT', os: 'win11', hw: 'latitude', user: 'NWD\\dr.chen', tags: ['vip'], notes: 'Practice owner. Call before any reboot during clinic hours (7am–6pm).' },
  { client: 0, site: 0, host: 'NWD-DC01', os: 'srv2022', hw: 'hyperv', tags: ['domain-controller'] },
  { client: 0, site: 0, host: 'NWD-FS01', os: 'srv2022', hw: 'poweredge', tags: ['file-server'], disk: 93 },
  { client: 0, site: 1, host: 'NWD-ES-FRONT', os: 'win10', hw: 'optiplex', user: 'NWD\\rpatel', tags: ['front-desk', 'win10-eol'], unencrypted: true },
  { client: 0, site: 1, host: 'NWD-ES-OP1', os: 'win11', hw: 'elitedesk', user: 'NWD\\es-op1', tags: ['operatory'] },
  { client: 0, site: 2, host: 'NWD-XRAY-01', os: 'win10', hw: 'precision', user: 'NWD\\imaging', tags: ['imaging', 'win10-eol'], reboot: true },
  { client: 0, site: 2, host: 'nwd-pacs-01', os: 'ubuntu', hw: 'kvm', tags: ['imaging', 'linux'] },
  // Harbor & Pine Legal
  { client: 1, site: 0, host: 'HPL-WS-011', os: 'win11e', hw: 'optiplex', user: 'HARBORPINE\\a.morgan' },
  { client: 1, site: 0, host: 'HPL-WS-014', os: 'win11e', hw: 'optiplex', user: 'HARBORPINE\\d.rossi', admin: 'HARBORPINE\\d.rossi' },
  { client: 1, site: 0, host: 'HPL-LT-PARTNER1', os: 'win11e', hw: 'thinkpad', user: 'HARBORPINE\\e.harbor', tags: ['vip', 'partner'] },
  { client: 1, site: 0, host: 'HPL-LT-PARTNER2', os: 'win11e', hw: 'surface', user: 'HARBORPINE\\l.pine', tags: ['vip', 'partner'], offlineHours: 51 },
  { client: 1, site: 0, host: 'HPL-DC01', os: 'srv2025', hw: 'hyperv', tags: ['domain-controller'] },
  { client: 1, site: 0, host: 'HPL-DMS01', os: 'srv2022', hw: 'proliant', tags: ['document-management'], cpu: 46 },
  { client: 1, site: 0, host: 'mbp-jsato', os: 'mac26', hw: 'mbp', user: 'jsato', tags: ['marketing'] },
  { client: 1, site: 1, host: 'HPL-ANX-SCAN01', os: 'win10', hw: 'elitedesk', user: 'HARBORPINE\\records', tags: ['scanner', 'win10-eol'], disk: 96, noAv: true },
  { client: 1, site: 1, host: 'HPL-ANX-WS02', os: 'win11e', hw: 'elitedesk', user: 'HARBORPINE\\t.nguyen', status: 'pending' },
  // Summit Freight
  { client: 2, site: 0, host: 'SF-DISPATCH-01', os: 'win11', hw: 'optiplex', user: 'SUMMIT\\dispatch1', tags: ['dispatch'] },
  { client: 2, site: 0, host: 'SF-DISPATCH-02', os: 'win11', hw: 'optiplex', user: 'SUMMIT\\dispatch2', tags: ['dispatch'] },
  { client: 2, site: 0, host: 'SF-HQ-CFO-LT', os: 'win11', hw: 'latitude', user: 'SUMMIT\\k.wright', tags: ['vip'] },
  { client: 2, site: 0, host: 'SF-HQ-DC01', os: 'srv2022', hw: 'vmware', tags: ['domain-controller'] },
  { client: 2, site: 0, host: 'sf-wms-01', os: 'rhel', hw: 'poweredge', tags: ['wms', 'linux'], cpu: 38 },
  { client: 2, site: 0, host: 'sf-edge-gw', os: 'ubuntu', hw: 'nuc', tags: ['network', 'linux'] },
  { client: 2, site: 1, host: 'SF-DOCK-TAB-03', os: 'win11', hw: 'surface', user: 'SUMMIT\\dock3', tags: ['rugged'], offlineHours: 9 * 24 + 4 },
  { client: 2, site: 1, host: 'SF-DOCK-WS01', os: 'win10', hw: 'elitedesk', user: 'SUMMIT\\dockmgr', tags: ['win10-eol'], unencrypted: true },
  { client: 2, site: 2, host: 'SF-RENO-WS01', os: 'win11', hw: 'probook', user: 'SUMMIT\\reno1' },
  { client: 2, site: 2, host: 'SF-RENO-WS02', os: 'win11', hw: 'probook', user: 'SUMMIT\\reno2', status: 'pending' },
  { client: 2, site: 0, host: 'SF-DISPATCH-02', os: 'win11', hw: 'optiplex', user: 'SUMMIT\\dispatch2', status: 'pending', reenrolls: 'SF-DISPATCH-02' },
  { client: 2, site: 3, host: 'SF-TAC-KIOSK', os: 'win11', hw: 'nuc', user: 'SUMMIT\\kiosk', tags: ['kiosk'] },
  // Bluebird Bakery
  { client: 3, site: 0, host: 'BB-OFFICE-LT', os: 'win11', hw: 'probook', user: 'owner', reboot: true },
  { client: 3, site: 1, host: 'BB-POS-01', os: 'win10', hw: 'nuc', user: 'pos', tags: ['pos', 'win10-eol'], noFirewall: true, unencrypted: true },
  { client: 3, site: 0, host: 'mba-bluebird', os: 'mac15', hw: 'mba', user: 'marie' },
  // Cedar Ridge Veterinary
  { client: 4, site: 0, host: 'CRV-RECEPTION', os: 'win11', hw: 'optiplex', user: 'CRV\\reception', tags: ['front-desk'] },
  { client: 4, site: 0, host: 'CRV-EXAM-1', os: 'win11', hw: 'elitedesk', user: 'CRV\\exam1' },
  { client: 4, site: 0, host: 'CRV-EXAM-2', os: 'win11', hw: 'elitedesk', user: 'CRV\\exam2' },
  { client: 4, site: 0, host: 'CRV-LAB-01', os: 'win11', hw: 'optiplex', user: 'CRV\\lab', tags: ['lab'] },
  { client: 4, site: 0, host: 'CRV-SRV-01', os: 'srv2025', hw: 'poweredge', tags: ['practice-management'], disk: 81 },
  { client: 4, site: 1, host: 'CRV-MOBILE-LT', os: 'win11', hw: 'thinkpad', user: 'CRV\\vet.mobile', tags: ['mobile'], offlineHours: 5 },
  // Atlas Architecture
  { client: 5, site: 0, host: 'ATLAS-CAD-03', os: 'win11e', hw: 'precision', user: 'AzureAD\\NoraVance', tags: ['cad'] },
  { client: 5, site: 0, host: 'ATLAS-CAD-07', os: 'win11e', hw: 'precision', user: 'AzureAD\\IsaacBell', tags: ['cad'], cpu: 78 },
  { client: 5, site: 0, host: 'mbp-ines', os: 'mac26', hw: 'mbp', user: 'ines', tags: ['design'] },
  { client: 5, site: 0, host: 'mbp-oliver', os: 'mac15', hw: 'mbp', user: 'oliver', tags: ['design'], reboot: true },
  { client: 5, site: 0, host: 'atlas-render-01', os: 'debian', hw: 'proliant', tags: ['render', 'linux'], cpu: 64 },
  { client: 5, site: 1, host: 'ATLAS-RMT-LT04', os: 'win11e', hw: 'thinkpad', user: 'AzureAD\\PriyaShah', tags: ['remote'] },
  { client: 5, site: 1, host: 'macmini-studio', os: 'mac26', hw: 'macmini', user: 'studio', status: 'pending' },
  { client: 5, site: 2, host: 'ATLAS-PLOT-01', os: 'win10', hw: 'elitedesk', user: 'ATLAS\\plotter', tags: ['plotter', 'win10-eol'] },
  // Meridian Credit Union
  { client: 6, site: 0, host: 'MCU-HO-WS01', os: 'win11e', hw: 'optiplex', user: 'MERIDIAN\\j.ortiz' },
  { client: 6, site: 0, host: 'MCU-HO-WS02', os: 'win11e', hw: 'optiplex', user: 'MERIDIAN\\s.bauer' },
  { client: 6, site: 1, host: 'MCU-LV-TELLER1', os: 'win11e', hw: 'elitedesk', user: 'MERIDIAN\\teller.lv1', tags: ['teller'] },
  { client: 6, site: 2, host: 'MCU-MT-TELLER1', os: 'win11e', hw: 'elitedesk', user: 'MERIDIAN\\teller.mt1', tags: ['teller'] },
  { client: 6, site: 3, host: 'MCU-DC01', os: 'srv2025', hw: 'hyperv', tags: ['domain-controller'] },
  { client: 6, site: 3, host: 'mcu-core-app', os: 'rhel', hw: 'proliant', tags: ['core-banking', 'linux'], cpu: 41 },
  { client: 6, site: 3, host: 'mcu-backup-01', os: 'ubuntu', hw: 'poweredge', tags: ['backup', 'linux'], disk: 88 },
  { client: 6, site: 0, host: 'MCU-OLD-WS07', os: 'win10', hw: 'optiplex', user: 'MERIDIAN\\former.staff', status: 'revoked' },
  // Oakline Schools Foundation
  { client: 7, site: 0, host: 'OAK-ADMIN-01', os: 'win11', hw: 'optiplex', user: 'OAKLINE\\admin1' },
  { client: 7, site: 1, host: 'OAK-LC-LAB12', os: 'win11', hw: 'elitedesk', user: 'OAKLINE\\student', tags: ['lab'] },
  { client: 7, site: 0, host: 'mba-oak-director', os: 'mac15', hw: 'mba', user: 'director' },
]

// ------------------------------------------------------------------ health (mirrors the server)

export function evaluateHealth(device: Pick<MockDevice, 'online' | 'last_seen_at' | 'disk_pct' | 'mem_pct' | 'sim' | 'os_family'>): {
  score: number
  reasons: HealthReason[]
} {
  const reasons: HealthReason[] = []
  const add = (label: string, penalty: number) => reasons.push({ label, penalty })
  if (!device.online) {
    const hours = device.last_seen_at ? (Date.now() - new Date(device.last_seen_at).getTime()) / HOUR : null
    if (hours !== null && hours > 24 * 7) add('Offline for more than a week', 45)
    else if (hours !== null && hours > 24) add('Offline for more than a day', 35)
    else add('Offline', 25)
  }
  if (device.disk_pct !== null) {
    if (device.disk_pct >= 95) add('Disk almost full', 25)
    else if (device.disk_pct >= 90) add('Disk above 90%', 15)
    else if (device.disk_pct >= 80) add('Disk above 80%', 5)
  }
  if (device.mem_pct !== null && device.mem_pct >= 95) add('Memory pressure', 5)
  if (device.os_family === 'windows') {
    if (!device.sim.avEnabled) add('Antivirus disabled', 20)
  }
  if (!device.sim.firewall) add('Firewall disabled', 10)
  if (!device.sim.encrypted) add('System drive not encrypted', 10)
  if (device.sim.pendingReboot) add('Restart pending', 5)
  const total = reasons.reduce((sum, reason) => sum + reason.penalty, 0)
  return { score: Math.max(0, Math.min(100, 100 - total)), reasons }
}

// ------------------------------------------------------------------ seeding

export function seedDevices(clients: Client[], sites: Site[], now = Date.now()): MockDevice[] {
  const r = rng(20261117)
  const devices: MockDevice[] = []
  const byHost = new Map<string, MockDevice>()
  for (const template of TEMPLATES) {
    const client = clients[template.client]
    const clientSites = sites.filter((site) => site.client_id === client?.id)
    const site = clientSites[template.site] ?? clientSites[0]
    if (!client || !site) continue
    const info = CLIENT_INFO[template.client]
    const os = OS[template.os]
    const hw = HW[template.hw]
    const id = seededUuid(r)
    const seed = hashString(`${template.host}:${template.status ?? 'active'}`)
    const dr = rng(seed)
    const pending = template.status === 'pending'
    const revoked = template.status === 'revoked'
    const online = !pending && !revoked && template.offlineHours === undefined
    const lastSeen = pending
      ? iso(now - dr.between(2, 40) * 60_000)
      : revoked
        ? iso(now - 64 * DAY)
        : online
          ? iso(now - dr.between(2, 40) * 1000)
          : iso(now - (template.offlineHours ?? 1) * HOUR)
    const type: DeviceType = hw.type === 'virtual' || hw.type === 'server' ? hw.type : hw.type
    const serverish = os.name.includes('Server') || type === 'server' || type === 'virtual' || os.family === 'linux'
    const cpuBase = template.cpu ?? (serverish ? dr.between(8, 26) : dr.between(3, 18))
    const memBase = serverish ? dr.between(45, 78) : dr.between(38, 72)
    const diskBase = template.disk ?? dr.between(28, 74)
    const sim: MockDevice['sim'] = {
      cpuBase,
      memBase,
      diskBase,
      avEnabled: !template.noAv,
      firewall: !template.noFirewall,
      encrypted: !template.unencrypted && !(os.family === 'linux' && dr.chance(0.5)),
      pendingReboot: Boolean(template.reboot),
      extraAdmin: template.admin ?? null,
      industry: info.industry,
    }
    const enrolled = now - dr.between(20, 210) * DAY
    const device: MockDevice = {
      id,
      hostname: template.host,
      display_name: template.tags?.includes('vip') && template.user ? `${template.host} (${template.user.split('\\').pop()})` : null,
      status: pending ? 'pending' : revoked ? 'revoked' : 'active',
      online,
      os_family: os.family,
      os_name: os.name,
      os_version: os.version,
      arch: hw.arch ?? 'x86_64',
      device_type: type,
      manufacturer: hw.manufacturer,
      model: hw.model,
      serial: hw.manufacturer === 'Apple' ? `${dr.pick(['C02', 'FVF', 'H4T', 'K9Q'])}${dr.hex(7).toUpperCase()}` : hw.type === 'virtual' ? `VMware-${dr.hex(8)}` : dr.hex(7).toUpperCase(),
      domain: os.family === 'windows' ? info.domain : null,
      client_id: client.id,
      client_name: client.name,
      site_id: site.id,
      site_name: site.name,
      last_seen_at: lastSeen,
      last_user: template.user ?? (os.family === 'linux' ? null : null),
      last_ip: `${info.netPrefix}.${template.site + 1}.${dr.between(10, 240)}`,
      cpu_pct: pending || revoked ? null : cpuBase + dr.next() * 6,
      mem_pct: pending || revoked ? null : memBase + dr.next() * 5,
      disk_pct: pending || revoked ? null : diskBase,
      uptime_s: online ? dr.between(2, 30) * 86_400 + dr.between(0, 86_000) : null,
      health_score: null,
      agent_version: pending ? '0.1.0' : dr.chance(0.85) ? '0.1.0' : '0.0.9',
      enrolled_at: iso(pending ? now - dr.between(5, 90) * 60_000 : enrolled),
      tags: template.tags ?? [],
      replaces_device_id: null,
      notes: template.notes ?? '',
      seed,
      sim,
      inventory_at: iso(now - dr.between(5, 200) * 60_000),
    }
    if (template.reenrolls) device.replaces_device_id = byHost.get(template.reenrolls)?.id ?? null
    if (device.status === 'active') device.health_score = evaluateHealth(device).score
    if (!template.status) byHost.set(template.host, device)
    devices.push(device)
  }
  return devices
}

export function seedTokens(clients: Client[], sites: Site[], now = Date.now()): MockToken[] {
  const r = rng(777)
  const site = (client: number, index: number) => sites.filter((s) => s.client_id === clients[client]?.id)[index]
  const specs: {
    client: number
    site: number
    name: string
    status?: 'revoked'
    expiresDays?: number | null
    max?: number | null
    uses: number
    approval?: boolean
    domains?: string[]
    cidrs?: string[]
    createdDays: number
    lastUsedHours?: number | null
  }[] = [
    { client: 0, site: 0, name: 'Main Clinic rollout', expiresDays: 21, max: 40, uses: 11, domains: ['nwdental.local'], createdDays: 38, lastUsedHours: 30 },
    { client: 1, site: 0, name: 'Group Policy deployment', expiresDays: null, max: null, uses: 9, approval: true, domains: ['harborpine.law'], cidrs: ['10.40.0.0/16'], createdDays: 64, lastUsedHours: 2 },
    { client: 2, site: 2, name: 'Depot laptops', expiresDays: 3, max: 10, uses: 2, createdDays: 11, lastUsedHours: 20 },
    { client: 5, site: 1, name: 'Remote staff self-install', expiresDays: 30, max: 25, uses: 4, approval: true, createdDays: 9, lastUsedHours: 6 },
    { client: 6, site: 1, name: 'Lakeview branch refresh', status: 'revoked', expiresDays: 14, max: 20, uses: 6, createdDays: 70, lastUsedHours: 24 * 52 },
    { client: 4, site: 0, name: 'Hospital pilot', expiresDays: -12, max: 10, uses: 5, createdDays: 45, lastUsedHours: 24 * 20 },
    { client: 3, site: 1, name: 'Retail POS', expiresDays: 60, max: 2, uses: 2, createdDays: 25, lastUsedHours: 24 * 3 },
  ]
  return specs.flatMap((spec) => {
    const s = site(spec.client, spec.site)
    const client = clients[spec.client]
    if (!s || !client) return []
    const expires = spec.expiresDays === null || spec.expiresDays === undefined ? null : iso(now + spec.expiresDays * DAY)
    const status: MockToken['status'] =
      spec.status === 'revoked'
        ? 'revoked'
        : expires && new Date(expires).getTime() <= now
          ? 'expired'
          : spec.max !== null && spec.max !== undefined && spec.uses >= spec.max
            ? 'exhausted'
            : 'active'
    return [
      {
        id: seededUuid(r),
        site_id: s.id,
        site_name: s.name,
        client_id: client.id,
        client_name: client.name,
        name: spec.name,
        expires_at: expires,
        max_uses: spec.max ?? null,
        uses: spec.uses,
        require_approval: Boolean(spec.approval),
        allowed_domains: spec.domains ?? [],
        allowed_cidrs: spec.cidrs ?? [],
        status,
        created_at: iso(now - spec.createdDays * DAY),
        last_used_at: spec.lastUsedHours ? iso(now - spec.lastUsedHours * HOUR) : null,
        secret: r.hex(24),
      },
    ]
  })
}

export function seedArtifacts(): AgentArtifact[] {
  const r = rng(4242)
  return [
    { platform: 'windows-x86_64', file: 'rustrmm-agent.exe', label: 'Windows (x64)', size_bytes: 11_843_072, sha256: r.hex(64) },
    { platform: 'windows-x86_64', file: 'RustRMMAgent-x64.msi', label: 'Windows MSI (x64)', size_bytes: 12_451_840, sha256: r.hex(64) },
    { platform: 'linux-x86_64', file: 'rustrmm-agent', label: 'Linux (x86-64)', size_bytes: 9_617_408, sha256: r.hex(64) },
    { platform: 'linux-aarch64', file: 'rustrmm-agent', label: 'Linux (ARM64)', size_bytes: 8_937_472, sha256: r.hex(64) },
    { platform: 'macos-universal', file: 'rustrmm-agent', label: 'macOS (Apple silicon & Intel)', size_bytes: 19_204_096, sha256: r.hex(64) },
  ]
}

// ------------------------------------------------------------------ deploy keys & installers

function base64Url(text: string): string {
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function deployKeyFor(token: Pick<MockToken, 'secret' | 'client_name' | 'site_name'>): string {
  const r = rng(hashString(token.secret))
  const identity = base64Url(String.fromCharCode(...Array.from({ length: 32 }, () => r.between(0, 255))))
  const pin = btoa(String.fromCharCode(...Array.from({ length: 32 }, () => r.between(0, 255))))
  const payload = {
    v: 1,
    urls: ['https://rmm.lumen-it.example:8444'],
    secret: base64Url(token.secret).slice(0, 22),
    identity: `ed25519:${identity}`,
    ca_pin: pin,
    label: `${token.client_name} / ${token.site_name}`,
  }
  return `rrmm1_${base64Url(JSON.stringify(payload))}`
}

export function installerScript(kind: string, token: MockToken): { body: string; filename: string } {
  const key = deployKeyFor(token)
  const label = `${token.client_name} / ${token.site_name}`
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  switch (kind) {
    case 'powershell':
      return {
        filename: `install-rustrmm-${slug}.ps1`,
        body: `#Requires -RunAsAdministrator\n# RustRMM agent installer — ${label}\n$ErrorActionPreference = 'Stop'\n$DeployKey = '${key}'\n$BaseUrl   = 'https://rmm.lumen-it.example:8444'\n# (mock) downloads rustrmm-agent.exe, verifies SHA-256 and runs: rustrmm-agent.exe install --key $DeployKey\n`,
      }
    case 'linux':
    case 'macos':
      return {
        filename: kind === 'linux' ? `install-rustrmm-${slug}.sh` : `install-rustrmm-${slug}-macos.sh`,
        body: `#!/bin/sh\n# RustRMM agent installer — ${label}\nset -eu\nDEPLOY_KEY='${key}'\nBASE_URL='https://rmm.lumen-it.example:8444'\n# (mock) downloads the agent with a pinned TLS key, verifies SHA-256 and runs: rustrmm-agent install --key "$DEPLOY_KEY"\n`,
      }
    case 'gpo':
      return {
        filename: 'Install-RustRMM.ps1',
        body: `# RustRMM — Group Policy computer startup script (${label})\n$DeployKey = '${key}'\n$Msi = Join-Path $PSScriptRoot 'RustRMMAgent-x64.msi'\nif (Get-Service -Name 'RustRMMAgent' -ErrorAction SilentlyContinue) { exit 0 }\n# (mock) msiexec /i $Msi /qn /norestart DEPLOY_KEY=$DeployKey\n`,
      }
    default:
      return { filename: 'deploy.key', body: `${key}\n` }
  }
}

// ------------------------------------------------------------------ inventory

const WIN_COMMON: [string, string, string][] = [
  ['Google Chrome', '142.0.7444.176', 'Google LLC'],
  ['Microsoft Edge', '142.0.3595.94', 'Microsoft Corporation'],
  ['Microsoft 365 Apps for business - en-us', '16.0.19328.20244', 'Microsoft Corporation'],
  ['Microsoft Teams', '25306.804.4102.7193', 'Microsoft Corporation'],
  ['Adobe Acrobat (64-bit)', '25.001.20844', 'Adobe'],
  ['7-Zip 25.01 (x64)', '25.01', 'Igor Pavlov'],
  ['Zoom Workplace (64-bit)', '6.6.10.23158', 'Zoom Communications, Inc.'],
  ['Microsoft Visual C++ 2015-2022 Redistributable (x64) - 14.44.35211', '14.44.35211.0', 'Microsoft Corporation'],
  ['Microsoft Update Health Tools', '5.72.0.0', 'Microsoft Corporation'],
  ['Notepad++ (64-bit x64)', '8.8.8', 'Notepad++ Team'],
  ['PowerShell 7-x64', '7.5.4.0', 'Microsoft Corporation'],
  ['RustRMM Agent', '0.1.0', 'RustRMM'],
  ['Webex', '45.10.1.33410', 'Cisco Webex LLC'],
  ['VLC media player', '3.0.21', 'VideoLAN'],
  ['Mozilla Firefox (x64 en-US)', '145.0.2', 'Mozilla'],
]

const WIN_SERVER: [string, string, string][] = [
  ['Veeam Agent for Microsoft Windows', '6.3.2.1205', 'Veeam Software Group GmbH'],
  ['Microsoft Visual C++ 2015-2022 Redistributable (x64) - 14.44.35211', '14.44.35211.0', 'Microsoft Corporation'],
  ['PowerShell 7-x64', '7.5.4.0', 'Microsoft Corporation'],
  ['RustRMM Agent', '0.1.0', 'RustRMM'],
  ['Microsoft Edge', '142.0.3595.94', 'Microsoft Corporation'],
  ['7-Zip 25.01 (x64)', '25.01', 'Igor Pavlov'],
]

const INDUSTRY_APPS: Record<Industry, [string, string, string][]> = {
  dental: [
    ['Dentrix G7.5', '7.5.24.112', 'Henry Schein One'],
    ['DEXIS Imaging Suite', '10.4.2.1', 'Dexis LLC'],
  ],
  legal: [
    ['iManage Work Desktop for Windows', '10.9.1.67', 'iManage LLC'],
    ['Clio for Desktop', '4.11.0', 'Themis Solutions Inc.'],
  ],
  freight: [
    ['McLeod LoadMaster Client', '24.1.3', 'McLeod Software'],
    ['Samsara Driver Portal', '3.24.0', 'Samsara Inc.'],
  ],
  bakery: [['Square for Retail', '6.12.1', 'Block, Inc.']],
  vet: [
    ['IDEXX Cornerstone', '9.6.2', 'IDEXX Laboratories, Inc.'],
    ['VetConnect PLUS Agent', '2.4.1', 'IDEXX Laboratories, Inc.'],
  ],
  architecture: [
    ['Autodesk AutoCAD 2026', '25.1.65.0', 'Autodesk, Inc.'],
    ['Autodesk Revit 2026', '26.0.4.409', 'Autodesk, Inc.'],
    ['Rhino 8', '8.24.25281.15001', 'Robert McNeel & Associates'],
    ['Enscape', '4.10.0.452', 'Chaos'],
  ],
  banking: [
    ['Symitar SymXchange Client', '2025.1.4', 'Jack Henry & Associates'],
    ['Verint Teller Capture', '11.2.0', 'Verint Systems'],
  ],
  schools: [
    ['Google Drive', '113.0.2.0', 'Google LLC'],
    ['Securly Classroom', '3.9.1', 'Securly Inc.'],
  ],
}

const LINUX_BASE: Record<string, [string, string][]> = {
  ubuntu: [
    ['openssh-server', '1:9.6p1-3ubuntu13.14'],
    ['curl', '8.5.0-2ubuntu10.6'],
    ['ca-certificates', '20240203'],
    ['systemd', '255.4-1ubuntu8.11'],
    ['python3', '3.12.3-0ubuntu2.1'],
    ['sudo', '1.9.15p5-3ubuntu5.24.04.1'],
    ['ufw', '0.36.2-6'],
    ['unattended-upgrades', '2.9.1+nmu4ubuntu1'],
    ['chrony', '4.5-1ubuntu4.2'],
    ['prometheus-node-exporter', '1.7.0-1ubuntu0.3'],
  ],
  rhel: [
    ['openssh-server', '8.7p1-45.el9'],
    ['curl', '7.76.1-31.el9'],
    ['systemd', '252-51.el9'],
    ['python3', '3.9.21-2.el9'],
    ['sudo', '1.9.5p2-10.el9'],
    ['firewalld', '1.3.4-9.el9'],
    ['dnf-automatic', '4.14.0-25.el9'],
    ['chrony', '4.6.1-1.el9'],
  ],
  debian: [
    ['openssh-server', '1:10.0p1-7'],
    ['curl', '8.14.1-2'],
    ['systemd', '257.8-1~deb13u2'],
    ['python3', '3.13.5-1'],
    ['sudo', '1.9.16p2-3'],
    ['nftables', '1.1.3-1'],
    ['chrony', '4.6.1-3'],
  ],
}

const LINUX_ROLES: Record<string, [string, string][]> = {
  imaging: [['orthanc', '1.12.6+dfsg-1'], ['postgresql-16', '16.10-0ubuntu0.24.04.1']],
  wms: [['nginx', '1:1.26.3-2.el9'], ['postgresql-server', '16.8-1.el9'], ['java-21-openjdk', '21.0.8.0.9-1.el9']],
  network: [['wireguard-tools', '1.0.20210914-1ubuntu4'], ['dnsmasq', '2.90-2ubuntu0.1'], ['fail2ban', '1.0.2-3ubuntu0.1']],
  render: [['blender', '4.4.3+dfsg-1'], ['nvidia-driver', '550.163.01-2']],
  'core-banking': [['nginx', '1:1.26.3-2.el9'], ['java-21-openjdk', '21.0.8.0.9-1.el9'], ['oracle-instantclient-basic', '23.9.0.25.07-1']],
  backup: [['borgbackup', '1.2.8-1'], ['restic', '0.16.4-1ubuntu0.1'], ['docker-ce', '5:28.5.1-1~ubuntu.24.04~noble']],
}

const MAC_APPS: [string, string, string][] = [
  ['Safari', '26.1', 'Apple'],
  ['Google Chrome', '142.0.7444.176', 'Identified Developer'],
  ['Slack', '4.46.101', 'Mac App Store'],
  ['zoom.us', '6.6.10', 'Identified Developer'],
  ['Microsoft Word', '16.103', 'Identified Developer'],
  ['Microsoft Excel', '16.103', 'Identified Developer'],
  ['Microsoft Outlook', '16.103', 'Identified Developer'],
  ['Microsoft Teams', '25306.804', 'Identified Developer'],
  ['1Password', '8.11.16', 'Identified Developer'],
  ['Notion', '6.2.0', 'Identified Developer'],
]

const MAC_DESIGN: [string, string, string][] = [
  ['Figma', '125.10.6', 'Identified Developer'],
  ['Adobe Photoshop 2026', '27.1.0', 'Identified Developer'],
  ['Rhino 8', '8.24.25281', 'Identified Developer'],
  ['Visual Studio Code', '1.106.2', 'Identified Developer'],
]

const WIN_SERVICES: [string, string, string, string][] = [
  ['BITS', 'Background Intelligent Transfer Service', 'running', 'auto'],
  ['Dhcp', 'DHCP Client', 'running', 'auto'],
  ['Dnscache', 'DNS Client', 'running', 'auto'],
  ['EventLog', 'Windows Event Log', 'running', 'auto'],
  ['LanmanServer', 'Server', 'running', 'auto'],
  ['LanmanWorkstation', 'Workstation', 'running', 'auto'],
  ['MpsSvc', 'Windows Defender Firewall', 'running', 'auto'],
  ['RustRMMAgent', 'RustRMM Agent', 'running', 'auto'],
  ['Schedule', 'Task Scheduler', 'running', 'auto'],
  ['Spooler', 'Print Spooler', 'running', 'auto'],
  ['TermService', 'Remote Desktop Services', 'stopped', 'manual'],
  ['W32Time', 'Windows Time', 'running', 'manual'],
  ['WinDefend', 'Microsoft Defender Antivirus Service', 'running', 'auto'],
  ['WinRM', 'Windows Remote Management (WS-Management)', 'stopped', 'manual'],
  ['wuauserv', 'Windows Update', 'running', 'manual'],
  ['wscsvc', 'Security Center', 'running', 'auto'],
  ['VSS', 'Volume Shadow Copy', 'stopped', 'manual'],
  ['WSearch', 'Windows Search', 'running', 'auto'],
  ['RemoteRegistry', 'Remote Registry', 'stopped', 'disabled'],
  ['Fax', 'Fax', 'stopped', 'manual'],
]

const LINUX_SERVICES: [string, string, string, string][] = [
  ['ssh', 'OpenBSD Secure Shell server', 'running', 'active'],
  ['cron', 'Regular background program processing daemon', 'running', 'active'],
  ['systemd-journald', 'Journal Service', 'running', 'active'],
  ['systemd-resolved', 'Network Name Resolution', 'running', 'active'],
  ['chrony', 'chrony, an NTP client/server', 'running', 'active'],
  ['rustrmm-agent', 'RustRMM agent', 'running', 'active'],
  ['unattended-upgrades', 'Unattended Upgrades Shutdown', 'running', 'active'],
  ['rsyslog', 'System Logging Service', 'running', 'active'],
  ['apport', 'automatic crash report generation', 'exited', 'active'],
  ['multipathd', 'Device-Mapper Multipath Device Controller', 'dead', 'inactive'],
]

const MAC_SERVICES: [string, string][] = [
  ['com.rustrmm.agent', 'running'],
  ['com.apple.mdworker', 'running'],
  ['com.apple.softwareupdated', 'running'],
  ['com.apple.cloudd', 'running'],
  ['com.microsoft.autoupdate.helper', 'stopped'],
  ['com.1password.1password-launcher', 'running'],
  ['com.apple.backupd', 'stopped'],
]

function softwareFor(device: MockDevice, r: ReturnType<typeof rng>): SoftwareItem[] {
  const items: SoftwareItem[] = []
  const add = (name: string, version: string, publisher: string, source: string) =>
    items.push({
      name,
      version,
      publisher,
      install_date: new Date(Date.now() - r.between(3, 600) * DAY).toISOString().slice(0, 10),
      size_bytes: r.between(2, 900) * 1_048_576,
      source,
    })
  if (device.os_family === 'windows') {
    const server = device.os_name.includes('Server')
    for (const [name, version, publisher] of server ? WIN_SERVER : WIN_COMMON) {
      if (server || r.chance(0.82)) add(name, version, publisher, r.chance(0.8) ? 'machine' : 'machine-x86')
    }
    if (!server) for (const [name, version, publisher] of INDUSTRY_APPS[device.sim.industry]) add(name, version, publisher, 'machine')
    if (device.hostname.includes('DMS')) add('Microsoft SQL Server 2022 (64-bit)', '16.0.4210.1', 'Microsoft Corporation', 'machine')
    if (r.chance(0.1)) add('TeamViewer', '15.71.4', 'TeamViewer Germany GmbH', 'machine')
    if (r.chance(0.3)) add('Spotify', '1.2.76.298', 'Spotify AB', 'user')
  } else if (device.os_family === 'linux') {
    const distro = device.os_name.startsWith('Ubuntu') ? 'ubuntu' : device.os_name.startsWith('Red Hat') ? 'rhel' : 'debian'
    for (const [name, version] of LINUX_BASE[distro]) add(name, version, distro === 'rhel' ? 'Red Hat, Inc.' : `${distro === 'ubuntu' ? 'Ubuntu' : 'Debian'} Developers`, distro === 'rhel' ? 'rpm' : 'dpkg')
    for (const tag of device.tags) for (const [name, version] of LINUX_ROLES[tag] ?? []) add(name, version, 'Upstream', distro === 'rhel' ? 'rpm' : 'dpkg')
    add('rustrmm-agent', '0.1.0', 'RustRMM', 'binary')
  } else {
    for (const [name, version, publisher] of MAC_APPS) if (r.chance(0.85)) add(name, version, publisher, 'app')
    if (device.tags.includes('design')) for (const [name, version, publisher] of MAC_DESIGN) add(name, version, publisher, 'app')
  }
  return items.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
}

export function inventoryFor(device: MockDevice): InventorySections {
  const r = rng(device.seed ^ 0x5a5a)
  const os = Object.values(OS).find((profile) => profile.name === device.os_name) ?? OS.win11
  const hw = Object.values(HW).find((profile) => profile.model === device.model) ?? HW.optiplex
  const at = device.inventory_at
  const env = <T,>(data: T) => ({ data, collected_at: at })
  const windows = device.os_family === 'windows'
  const mac = device.os_family === 'macos'
  const server = device.os_name.includes('Server')
  const bootMs = device.uptime_s ? Date.now() - device.uptime_s * 1000 : Date.now() - 6 * DAY
  const ramBytes = hw.ramGb * 1_073_741_824
  const diskTotal = (server ? r.pick([480, 960, 1920]) : r.pick([256, 512, 1024])) * 1_000_000_000
  const diskPct = device.disk_pct ?? device.sim.diskBase
  const primaryMac = Array.from({ length: 6 }, () => r.hex(2)).join(':').toUpperCase()
  const ip = device.last_ip ?? '10.0.0.10'
  const gateway = ip.split('.').slice(0, 3).join('.') + '.1'
  const admins = windows
    ? [`${device.hostname}\\Administrator`, device.domain ? `${device.domain.split('.')[0].toUpperCase()}\\Domain Admins` : `${device.hostname}\\it-admin`]
    : mac
      ? ['root', device.last_user ?? 'admin']
      : ['root', 'deploy']
  if (device.sim.extraAdmin) admins.push(device.sim.extraAdmin)
  const security: SecurityInventory = windows
    ? {
        antivirus: [{ name: server ? 'Microsoft Defender Antivirus' : 'Windows Defender', enabled: device.sim.avEnabled, up_to_date: device.sim.avEnabled, source: server ? 'defender' : 'security_center' }],
        defender: {
          real_time_protection: device.sim.avEnabled,
          signature_age_days: device.sim.avEnabled ? r.between(0, 2) : 19,
          signatures_updated: new Date(Date.now() - r.between(1, 40) * HOUR).toISOString(),
          last_quick_scan: new Date(Date.now() - r.between(2, 70) * HOUR).toISOString(),
          last_full_scan: new Date(Date.now() - r.between(3, 30) * DAY).toISOString(),
          tamper_protection: device.sim.avEnabled,
        },
        firewall: {
          enabled: device.sim.firewall,
          profiles: ['Domain', 'Private', 'Public'].map((name) => ({ name, enabled: device.sim.firewall || name === 'Domain' })),
        },
        encryption: {
          method: 'bitlocker',
          system_volume_encrypted: device.sim.encrypted,
          volumes: [{ drive: 'C:', protected: device.sim.encrypted }],
        },
        uac_enabled: true,
        rdp_enabled: server,
        smb1_enabled: device.os_name.includes('10') && r.chance(0.3),
        autologon_enabled: device.tags.includes('kiosk') || device.tags.includes('pos'),
        secure_boot: hw.type !== 'virtual',
        local_admins: admins,
      }
    : mac
      ? {
          antivirus: [{ name: 'XProtect', enabled: true, up_to_date: null, source: 'builtin' }],
          firewall: { enabled: device.sim.firewall },
          encryption: { method: 'filevault', system_volume_encrypted: device.sim.encrypted },
          gatekeeper: true,
          sip: true,
          local_admins: admins,
        }
      : {
          firewall: { enabled: device.sim.firewall },
          encryption: { method: 'luks', system_volume_encrypted: device.sim.encrypted },
          selinux: device.os_name.startsWith('Red Hat') ? 'enforcing' : null,
          apparmor: !device.os_name.startsWith('Red Hat'),
          ssh_root_login: false,
          local_admins: admins,
        }

  const localUsers = windows
    ? [
        { name: 'Administrator', full_name: '', enabled: false, admin: true, builtin_administrator: true },
        { name: 'Guest', full_name: '', enabled: false, admin: false },
        { name: 'it-admin', full_name: 'IT Administrator (LAPS)', enabled: true, admin: true },
        { name: 'WDAGUtilityAccount', full_name: '', enabled: false, admin: false },
      ]
    : mac
      ? [
          { name: device.last_user ?? 'admin', full_name: device.last_user ?? 'Admin', enabled: true, admin: true, uid: 501 },
          { name: 'support', full_name: 'MSP Support', enabled: true, admin: true, uid: 502 },
        ]
      : [
          { name: 'root', full_name: 'root', enabled: true, admin: true, uid: 0 },
          { name: 'deploy', full_name: 'Deployment', enabled: true, admin: true, uid: 1000 },
          { name: 'backup', full_name: 'Backup operator', enabled: true, admin: false, uid: 1001 },
        ]

  const services = windows
    ? WIN_SERVICES.map(([name, display, state, mode]) => ({
        name,
        display_name: display,
        state: name === 'WinDefend' && !device.sim.avEnabled ? 'stopped' : name === 'MpsSvc' && !device.sim.firewall ? 'stopped' : state,
        start_mode: mode,
        account: name === 'RustRMMAgent' || name === 'Spooler' ? 'LocalSystem' : 'NT AUTHORITY\\LocalService',
      }))
    : mac
      ? MAC_SERVICES.map(([name, state]) => ({ name, display_name: name, state }))
      : LINUX_SERVICES.map(([name, display, state, active]) => ({ name, display_name: display, state, active }))

  return {
    system: env({
      hostname: device.hostname,
      os: {
        family: device.os_family,
        name: device.os_name,
        version: device.os_version,
        build: os.build ?? null,
        display_version: os.display ?? null,
        edition: os.edition ?? null,
        kernel: os.kernel,
        install_date: new Date(new Date(device.enrolled_at).getTime() - r.between(30, 600) * DAY).toISOString(),
        id: os.id ?? null,
      },
      arch: device.arch,
      boot_time: new Date(bootMs).toISOString(),
      last_boot: new Date(bootMs).toISOString(),
      utc_offset_minutes: -r.pick([480, 420, 360, 300]),
      agent_version: device.agent_version,
      device_type: device.device_type,
      domain: device.domain,
      workgroup: windows && !device.domain ? 'WORKGROUP' : null,
      entra_joined: device.sim.industry === 'architecture' && windows,
      domain_controller: device.tags.includes('domain-controller'),
      virtualization: device.device_type === 'virtual' ? (device.manufacturer === 'QEMU' ? 'kvm' : 'vmware') : null,
      pending_reboot: device.sim.pendingReboot,
      pending_reboot_reasons: device.sim.pendingReboot ? (windows ? ['windows_update'] : ['packages']) : [],
    }),
    hardware: env({
      manufacturer: device.manufacturer,
      model: device.model,
      family: windows && hw.manufacturer === 'Dell Inc.' ? hw.model.split(' ')[0] : null,
      chip: hw.chip ?? null,
      serial: device.serial,
      uuid: `${r.hex(8)}-${r.hex(4)}-${r.hex(4)}-${r.hex(4)}-${r.hex(12)}`.toUpperCase(),
      bios: mac
        ? { vendor: 'Apple', version: '11881.140.96', date: null }
        : { vendor: hw.type === 'virtual' ? hw.manufacturer : `${hw.manufacturer.replace(' Inc.', '')}`, version: `${r.between(1, 3)}.${r.between(0, 24)}.${r.between(0, 9)}`, date: new Date(Date.now() - r.between(60, 500) * DAY).toISOString() },
      baseboard: mac ? undefined : { manufacturer: hw.manufacturer, product: `0${r.hex(5).toUpperCase()}` },
      cpu: { model: hw.cpu, vendor: hw.cpu.includes('AMD') ? 'AuthenticAMD' : hw.cpu.includes('Apple') ? 'Apple' : hw.cpu.includes('Snapdragon') ? 'Qualcomm' : 'GenuineIntel', cores: hw.cores, threads: hw.threads, mhz: hw.cpu.includes('Apple') ? 4510 : r.between(2100, 5600) },
      memory: {
        total_bytes: ramBytes,
        modules: mac
          ? []
          : Array.from({ length: hw.ramGb >= 32 ? 2 : 1 }, (_, index) => ({
              slot: `DIMM ${index + 1}`,
              size_bytes: ramBytes / (hw.ramGb >= 32 ? 2 : 1),
              speed_mhz: hw.type === 'server' ? 4800 : 5600,
              manufacturer: r.pick(['Samsung', 'SK Hynix', 'Micron', 'Kingston']),
              part_number: `M${r.hex(4).toUpperCase()}${r.hex(6).toUpperCase()}`,
            })),
      },
      gpus: hw.gpu ? [{ name: hw.gpu, driver: windows ? `32.0.${r.between(100, 999)}.${r.between(1000, 9999)}` : null, memory_bytes: hw.gpu.includes('RTX') ? 20 * 1_073_741_824 : null }] : mac ? [{ name: hw.chip ?? 'Apple GPU', cores: hw.cores + 4 }] : [],
      monitors:
        hw.type === 'workstation' && !mac
          ? Array.from({ length: r.between(1, 2) }, () => ({
              manufacturer: r.pick(['DEL', 'LEN', 'HPN', 'SAM']),
              model: r.pick(['DELL P2425H', 'LEN T24i-30', 'HP E24 G5', 'DELL U2724D']),
              serial: r.hex(8).toUpperCase(),
              year: r.between(2021, 2025),
            }))
          : [],
      batteries:
        hw.type === 'laptop'
          ? [{ name: 'Internal battery', charge_pct: r.between(18, 100), status: 2, design_capacity: 57000, full_charge_capacity: r.between(42000, 56500), cycles: r.between(40, 680), condition: mac ? 'Normal' : null }]
          : [],
      secure_boot: hw.type !== 'virtual' ? true : false,
      tpm: hw.type === 'virtual' ? null : { present: true, enabled: true, activated: true, spec_version: '2.0, 0, 1.59' },
      printers: windows && !server ? [{ name: 'Microsoft Print to PDF', driver: 'Microsoft Print To PDF', port: 'PORTPROMPT:', default: false, network: false }, { name: r.pick(['HP LaserJet Pro M404', 'Brother MFC-L8900CDW', 'Canon imageRUNNER C3826']), driver: 'Universal Print Driver', port: `IP_${gateway.replace(/\.1$/, '.20')}`, default: true, network: true }] : [],
    }),
    storage: env({
      volumes: [
        {
          mount: windows ? 'C:\\' : '/',
          name: windows ? 'OS' : mac ? 'Macintosh HD' : '/dev/sda2',
          filesystem: windows ? 'NTFS' : mac ? 'apfs' : 'ext4',
          total_bytes: diskTotal,
          free_bytes: Math.round(diskTotal * (1 - diskPct / 100)),
          kind: hw.type === 'virtual' ? 'unknown' : 'ssd',
          removable: false,
          read_only: false,
        },
        ...(server && windows
          ? [{ mount: 'D:\\', name: 'Data', filesystem: 'NTFS', total_bytes: diskTotal * 4, free_bytes: Math.round(diskTotal * 4 * r.between(20, 60) / 100), kind: 'hdd', removable: false, read_only: false }]
          : []),
      ],
      disks: [{ index: 0, model: hw.type === 'virtual' ? 'Virtual Disk' : r.pick(['Samsung SSD 990 PRO 1TB', 'KXG80ZNV512G KIOXIA', 'WD PC SN740 SDDPNQD-512G', 'Micron 7450 MTFDKCC960TFR']), serial: r.hex(12).toUpperCase(), size_bytes: diskTotal, media: hw.type === 'virtual' ? 'Fixed hard disk media' : 'SSD', bus: hw.type === 'virtual' ? 'SCSI' : 'NVMe', health: diskPct > 95 ? 'Degraded' : 'OK' }],
      bitlocker: windows ? [{ drive: 'C:', protected: device.sim.encrypted, os_volume: true, conversion_status: device.sim.encrypted ? 1 : 0 }] : undefined,
      system_volume_encrypted: device.os_family === 'linux' ? device.sim.encrypted : undefined,
    }),
    network: env({
      interfaces: [
        { name: windows ? 'Ethernet' : mac ? 'en0' : 'eth0', mac: primaryMac, ipv4: [`${ip}/24`], ipv6: [`fe80::${r.hex(4)}:${r.hex(4)}:${r.hex(4)}:${r.hex(4)}/64`], mtu: 1500, speed_mbps: hw.type === 'laptop' ? null : hw.type === 'server' ? 10000 : 1000 },
        ...(hw.type === 'laptop' ? [{ name: windows ? 'Wi-Fi' : 'en1', mac: Array.from({ length: 6 }, () => r.hex(2)).join(':').toUpperCase(), ipv4: [], ipv6: [], mtu: 1500, speed_mbps: 866 }] : []),
      ],
      adapters: windows
        ? [{ name: 'Ethernet', description: hw.type === 'virtual' ? 'Microsoft Hyper-V Network Adapter' : 'Intel(R) Ethernet Connection (17) I219-LM', mac: primaryMac, addresses: [ip, `fe80::${r.hex(4)}:${r.hex(4)}`], subnets: ['255.255.255.0', '64'], gateways: [gateway], dns_servers: [gateway.replace(/\.1$/, '.10'), '1.1.1.1'], dhcp: !server, dhcp_server: server ? null : gateway, dns_domain: device.domain, speed_mbps: hw.type === 'server' ? 10000 : 1000 }]
        : undefined,
      wifi: hw.type === 'laptop' ? { ssid: `${device.client_name.split(' ')[0]}-Staff`, signal: `${r.between(55, 99)}%`, radio: '802.11ax' } : null,
      gateways: windows ? undefined : [gateway],
      dns_servers: windows ? undefined : [gateway.replace(/\.1$/, '.10'), '9.9.9.9'],
    }),
    software: env({ items: softwareFor(device, r) }),
    security: env(security),
    users: env({
      local: localUsers,
      last_user: device.last_user,
      sessions: device.online && device.last_user ? [{ user: device.last_user, kind: 'console' }] : [],
      profiles: windows && device.last_user ? [{ path: `C:\\Users\\${device.last_user.split('\\').pop()}`, last_used: device.last_seen_at }] : [],
    }),
    services: env({ items: services }),
    updates: env(
      windows
        ? {
            installed: [
              { id: 'KB5068861', description: 'Security Update', installed_on: '11/12/2025' },
              { id: 'KB5066835', description: 'Security Update', installed_on: '10/14/2025' },
              { id: 'KB5054979', description: 'Update', installed_on: '9/9/2025' },
              { id: 'KB5043080', description: 'Security Update', installed_on: '8/12/2025' },
            ].slice(0, r.between(2, 4)),
            pending_reboot: device.sim.pendingReboot,
            wsus_server: null,
          }
        : mac
          ? { pending: device.sim.pendingReboot ? [{ label: 'macOS Tahoe 26.1.1-25B90' }] : [], pending_reboot: device.sim.pendingReboot }
          : { pending_reboot: device.sim.pendingReboot, package_manager: device.os_name.startsWith('Red Hat') ? 'dnf' : 'apt-get' },
    ),
  }
}

// ------------------------------------------------------------------ metrics

const RANGE_SPEC: Record<MetricsRange, { points: number; step: number; resolution: MetricsResponse['resolution'] }> = {
  '1h': { points: 60, step: 60, resolution: 'raw' },
  '24h': { points: 288, step: 300, resolution: 'raw' },
  '7d': { points: 672, step: 900, resolution: '15m' },
  '30d': { points: 720, step: 3600, resolution: '1h' },
}

function clamp(value: number) {
  return Math.max(0, Math.min(100, value))
}

/** Smooth pseudo-noise: deterministic for a device + timestamp. */
function wave(seed: number, t: number, period: number) {
  return Math.sin((t / period) * Math.PI * 2 + (seed % 360)) * 0.5 + Math.sin((t / (period / 3.7)) * Math.PI * 2 + (seed % 97)) * 0.25
}

export function sampleAt(device: MockDevice, ts: number) {
  const s = device.seed
  const daily = Math.sin(((ts % 86_400) / 86_400) * Math.PI * 2 - Math.PI / 2) // peaks mid-day
  const workday = device.device_type === 'server' || device.device_type === 'virtual' ? 0.4 : 1
  const noise = (Math.sin(ts * 0.37 + s) + Math.sin(ts * 0.11 + s * 3)) * 0.5
  const base = device.sim.cpuBase
  const swing = Math.min(base * 0.6, Math.max(0, 92 - base) * 0.8)
  const cpu = clamp(base + daily * swing * workday + noise * 5 + wave(s, ts, 5400) * 6)
  const mem = clamp(device.sim.memBase + wave(s + 7, ts, 21_600) * 6 + noise * 1.5)
  const disk = clamp(device.sim.diskBase - (Date.now() / 1000 - ts) / 86_400 / 30 + wave(s + 3, ts, 86_400 * 7) * 0.4)
  const burst = Math.max(0, Math.sin(ts / 2400 + s)) ** 8
  const netBase = device.device_type === 'server' ? 18_000_000 : 1_600_000
  const rx = Math.max(0, netBase * (0.6 + daily * 0.4 * workday) * (1 + burst * 5) + noise * netBase * 0.15)
  const tx = rx * (device.device_type === 'server' ? 1.4 : 0.32)
  return { cpu, mem, disk, rx, tx }
}

export function metricsFor(device: MockDevice, range: MetricsRange): MetricsResponse {
  const spec = RANGE_SPEC[range]
  const nowTs = Math.floor(Date.now() / 1000 / spec.step) * spec.step
  const points: MetricPoint[] = []
  const lastSeenTs = device.last_seen_at ? new Date(device.last_seen_at).getTime() / 1000 : nowTs
  const enrolledTs = new Date(device.enrolled_at).getTime() / 1000
  for (let index = spec.points - 1; index >= 0; index -= 1) {
    const ts = nowTs - index * spec.step
    if (ts > lastSeenTs + spec.step || ts < enrolledTs) continue
    const v = sampleAt(device, ts)
    points.push({ ts, cpu: round(v.cpu), mem: round(v.mem), disk: round(v.disk), net_rx: Math.round(v.rx), net_tx: Math.round(v.tx) })
  }
  return { range, resolution: spec.resolution, points }
}

function round(value: number) {
  return Math.round(value * 10) / 10
}

// ------------------------------------------------------------------ timeline

export function timelineFor(device: MockDevice): TimelineEntry[] {
  const r = rng(device.seed ^ 0x7e57)
  const enrolled = new Date(device.enrolled_at).getTime()
  const now = Date.now()
  const entries: Omit<TimelineEntry, 'id'>[] = []
  const push = (at: number, kind: string, severity: TimelineSeverity, summary: string, details: Record<string, unknown> = {}) => {
    if (at >= enrolled && at <= now) entries.push({ at: iso(at), kind, severity, summary, details })
  }
  push(enrolled, 'agent.enrolled', 'notice', device.status === 'pending' ? 'Enrolled — waiting for approval' : 'Agent enrolled', { ip: device.last_ip })
  if (device.status === 'pending') return entries.map((entry, index) => ({ ...entry, id: index + 1 })).reverse()
  push(enrolled + 4 * 60_000, 'inventory.software', 'info', `Software inventory collected (${softwareFor(device, rng(device.seed)).length} items)`)
  const span = Math.min(30 * DAY, now - enrolled)
  const software = softwareFor(device, rng(device.seed))
  const count = r.between(14, 32)
  for (let index = 0; index < count; index += 1) {
    const at = now - r.next() * span
    const roll = r.next()
    if (roll < 0.28) {
      push(at, 'agent.online', 'info', 'Agent came online', { ip: device.last_ip })
    } else if (roll < 0.5 && software.length) {
      const item = r.pick(software)
      push(at, 'software.updated', 'info', `Updated ${item.name} to ${item.version ?? 'a newer version'}`, { name: item.name, version: item.version })
    } else if (roll < 0.62) {
      const name = r.pick(['Zoom Workplace (64-bit)', 'Microsoft Teams', 'Slack', 'Google Chrome', 'Spotify', 'TeamViewer', 'Visual Studio Code'])
      push(at, 'software.installed', 'notice', `Installed ${name}`, { name })
    } else if (roll < 0.68) {
      push(at, 'software.removed', 'notice', `Removed ${r.pick(['Java 8 Update 431', 'Adobe Flash Player', 'WinRAR 6.24', 'Skype'])}`)
    } else if (roll < 0.76) {
      push(at, 'system.reboot_pending', 'notice', 'A restart is pending', { reasons: ['windows_update'] })
    } else if (roll < 0.82 && device.os_family === 'windows') {
      push(at, 'agent.log', 'notice', 'Microsoft Defender definitions are more than 3 days old', { level: 'warn' })
    } else if (roll < 0.86) {
      const ram = Object.values(HW).find((profile) => profile.model === device.model)?.ramGb ?? 16
      push(at, 'hardware.changed', 'notice', `Hardware changed: memory ${ram / 2} → ${ram} GB`)
    } else if (roll < 0.9) {
      push(at, 'os.updated', 'notice', `Operating system updated: ${device.os_version.replace(/\d+$/, (m) => String(Number(m) - 1))} → ${device.os_version}`)
    } else {
      push(at, 'device.moved', 'info', 'Moved to another site')
    }
  }
  push(enrolled + 6 * 60_000, 'agent.noise_key', 'info', 'Agent registered its encrypted-channel key', {})
  if (device.hostname === 'CRV-MOBILE-LT') push(now - 26 * HOUR, 'agent.noise_failed', 'warning', 'Encrypted channel handshake failed; the connection was refused', { code: 'noise_failed' })
  if (device.sim.extraAdmin) push(now - 2 * DAY - 3 * HOUR, 'security.admin_added', 'warning', `New local administrator: ${device.sim.extraAdmin}`, { account: device.sim.extraAdmin })
  if (!device.online && device.last_seen_at) push(new Date(device.last_seen_at).getTime(), 'agent.offline', 'warning', 'Agent went offline')
  if ((device.disk_pct ?? 0) >= 90) push(now - 9 * HOUR, 'agent.log', 'warning', `Low disk space on ${device.os_family === 'windows' ? 'C:' : '/'} (${Math.round(device.disk_pct ?? 0)}% used)`, { level: 'warn' })
  entries.sort((a, b) => a.at.localeCompare(b.at))
  return entries.map((entry, index) => ({ ...entry, id: index + 1 })).reverse()
}

/** Live sample for the fake stream (jitters around the device baseline). */
export function liveSample(device: MockDevice) {
  const ts = Math.floor(Date.now() / 1000)
  const v = sampleAt(device, ts)
  const jitter = (Math.random() - 0.5) * 8
  return {
    ts,
    cpu: round(clamp(v.cpu + jitter)),
    mem: round(clamp(v.mem + jitter / 6)),
    disk: round(v.disk),
    net_rx_bps: Math.round(v.rx * (0.6 + Math.random() * 0.9)),
    net_tx_bps: Math.round(v.tx * (0.6 + Math.random() * 0.9)),
    disk_read_bps: Math.round(Math.random() * 18_000_000),
    disk_write_bps: Math.round(Math.random() * 9_000_000),
  }
}

/** Installed memory in GB, from the device's hardware profile (used by dynamic group rules). */
export function deviceRamGb(device: Pick<MockDevice, 'model'>): number | null {
  return Object.values(HW).find((profile) => profile.model === device.model)?.ramGb ?? null
}

export function deviceCpu(device: Pick<MockDevice, 'model'>): string | null {
  return Object.values(HW).find((profile) => profile.model === device.model)?.cpu ?? null
}

/** Devices the cockpit asked to stream (POST /devices/:id/live) → expiry timestamp. */
export const liveUntil = new Map<string, number>()

export function toPublicDevice(device: MockDevice): Device {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { notes, seed, sim, inventory_at, ...rest } = device
  return rest
}
