/*
 * Deterministic per-device data for the Phase 4 remote tools mock: processes, services, event logs,
 * registry, a small file system, network diagnostics, session history and asciicast recordings.
 * Mutable state (killed processes, service states, file changes) lives in memory for the tab.
 */
import type {
  CommandDiagnostic,
  DnsDiagnostic,
  EventLogEntry,
  FileEntry,
  PortDiagnostic,
  RegistryListing,
  RemoteProcess,
  RemoteService,
  RemoteSession,
} from '@/lib/api/types'
import { hashString, type MockDevice } from './devices'

export interface MockRemoteSession extends RemoteSession {
  /** Which scripted recording to generate for seeded shell sessions. */
  script?: string
}

const DAY = 86_400_000
const MINUTE = 60_000

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

function rng(seed: number) {
  const next = mulberry32(seed)
  return {
    next,
    between: (min: number, max: number) => Math.floor(min + next() * (max - min + 1)),
    float: (min: number, max: number) => min + next() * (max - min),
    pick: <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
    chance: (p: number) => next() < p,
    hex: (length: number) => Array.from({ length }, () => Math.floor(next() * 16).toString(16)).join(''),
  }
}

export function userShort(device: MockDevice): string {
  return device.last_user?.split('\\').pop()?.split('@')[0] ?? (device.os_family === 'macos' ? 'admin' : 'deploy')
}

const isServer = (device: MockDevice) => device.os_name.includes('Server')

// ------------------------------------------------------------------ processes

interface ProcSpec {
  name: string
  exe: string | null
  user: string | null
  cpu: number
  memMb: number
  parent?: string
  count?: number
}

function windowsProcesses(device: MockDevice): ProcSpec[] {
  const user = userShort(device)
  const sys = 'SYSTEM'
  const w = 'C:\\Windows\\System32'
  const specs: ProcSpec[] = [
    { name: 'System Idle Process', exe: null, user: sys, cpu: 0, memMb: 0.01 },
    { name: 'System', exe: null, user: sys, cpu: 0.4, memMb: 0.2 },
    { name: 'Registry', exe: null, user: sys, cpu: 0, memMb: 48, parent: 'System' },
    { name: 'smss.exe', exe: `${w}\\smss.exe`, user: sys, cpu: 0, memMb: 1.2, parent: 'System' },
    { name: 'csrss.exe', exe: `${w}\\csrss.exe`, user: sys, cpu: 0.1, memMb: 5.8, count: 2 },
    { name: 'wininit.exe', exe: `${w}\\wininit.exe`, user: sys, cpu: 0, memMb: 6.4 },
    { name: 'services.exe', exe: `${w}\\services.exe`, user: sys, cpu: 0.1, memMb: 11, parent: 'wininit.exe' },
    { name: 'lsass.exe', exe: `${w}\\lsass.exe`, user: sys, cpu: 0.2, memMb: device.tags.includes('domain-controller') ? 420 : 26, parent: 'wininit.exe' },
    { name: 'winlogon.exe', exe: `${w}\\winlogon.exe`, user: sys, cpu: 0, memMb: 9 },
    { name: 'fontdrvhost.exe', exe: `${w}\\fontdrvhost.exe`, user: 'UMFD-0', cpu: 0, memMb: 4, count: 2 },
    { name: 'svchost.exe', exe: `${w}\\svchost.exe`, user: sys, cpu: 0.2, memMb: 18, parent: 'services.exe', count: 22 },
    { name: 'svchost.exe', exe: `${w}\\svchost.exe`, user: 'LOCAL SERVICE', cpu: 0.1, memMb: 12, parent: 'services.exe', count: 12 },
    { name: 'svchost.exe', exe: `${w}\\svchost.exe`, user: 'NETWORK SERVICE', cpu: 0.1, memMb: 14, parent: 'services.exe', count: 6 },
    { name: 'spoolsv.exe', exe: `${w}\\spoolsv.exe`, user: sys, cpu: 0, memMb: 13, parent: 'services.exe' },
    { name: 'MsMpEng.exe', exe: 'C:\\ProgramData\\Microsoft\\Windows Defender\\Platform\\4.18.25090.3009-0\\MsMpEng.exe', user: sys, cpu: 1.4, memMb: 236, parent: 'services.exe' },
    { name: 'NisSrv.exe', exe: 'C:\\ProgramData\\Microsoft\\Windows Defender\\Platform\\4.18.25090.3009-0\\NisSrv.exe', user: 'LOCAL SERVICE', cpu: 0, memMb: 9, parent: 'services.exe' },
    { name: 'SecurityHealthService.exe', exe: `${w}\\SecurityHealthService.exe`, user: sys, cpu: 0, memMb: 12, parent: 'services.exe' },
    { name: 'SearchIndexer.exe', exe: `${w}\\SearchIndexer.exe`, user: sys, cpu: 0.3, memMb: 38, parent: 'services.exe' },
    { name: 'WmiPrvSE.exe', exe: `${w}\\wbem\\WmiPrvSE.exe`, user: 'NETWORK SERVICE', cpu: 0.6, memMb: 22, count: 2 },
    { name: 'dllhost.exe', exe: `${w}\\dllhost.exe`, user: sys, cpu: 0, memMb: 9 },
    { name: 'conhost.exe', exe: `${w}\\conhost.exe`, user: sys, cpu: 0, memMb: 7, parent: 'rustrmm-agent.exe' },
    { name: 'rustrmm-agent.exe', exe: 'C:\\Program Files\\RustRMM\\rustrmm-agent.exe', user: sys, cpu: 0.3, memMb: 21, parent: 'services.exe' },
  ]
  if (isServer(device)) {
    specs.push(
      { name: 'TiWorker.exe', exe: 'C:\\Windows\\WinSxS\\amd64_microsoft-windows-servicingstack\\TiWorker.exe', user: sys, cpu: 0.8, memMb: 64, parent: 'svchost.exe' },
      { name: 'ServerManager.exe', exe: `${w}\\ServerManager.exe`, user: 'Administrator', cpu: 0.1, memMb: 118 },
    )
    if (device.tags.includes('domain-controller')) {
      specs.push(
        { name: 'dns.exe', exe: `${w}\\dns.exe`, user: sys, cpu: 0.4, memMb: 96, parent: 'services.exe' },
        { name: 'ismserv.exe', exe: `${w}\\ismserv.exe`, user: sys, cpu: 0, memMb: 6, parent: 'services.exe' },
        { name: 'dfsrs.exe', exe: `${w}\\dfsrs.exe`, user: sys, cpu: 0.2, memMb: 28, parent: 'services.exe' },
        { name: 'Microsoft.ActiveDirectory.WebServices.exe', exe: 'C:\\Windows\\ADWS\\Microsoft.ActiveDirectory.WebServices.exe', user: sys, cpu: 0.1, memMb: 54, parent: 'services.exe' },
      )
    }
    if (device.tags.includes('file-server')) specs.push({ name: 'vds.exe', exe: `${w}\\vds.exe`, user: sys, cpu: 0, memMb: 11, parent: 'services.exe' })
    if (device.tags.includes('document-management')) {
      specs.push(
        { name: 'sqlservr.exe', exe: 'C:\\Program Files\\Microsoft SQL Server\\MSSQL16.MSSQLSERVER\\MSSQL\\Binn\\sqlservr.exe', user: 'MSSQLSERVER', cpu: 18, memMb: 6200, parent: 'services.exe' },
        { name: 'w3wp.exe', exe: `${w}\\inetsrv\\w3wp.exe`, user: 'DefaultAppPool', cpu: 6, memMb: 780, parent: 'svchost.exe', count: 3 },
      )
    }
    if (device.tags.includes('practice-management')) specs.push({ name: 'Cornerstone.Server.exe', exe: 'C:\\Program Files\\IDEXX\\Cornerstone\\Cornerstone.Server.exe', user: sys, cpu: 4, memMb: 1400, parent: 'services.exe' })
    return specs
  }
  specs.push(
    { name: 'dwm.exe', exe: `${w}\\dwm.exe`, user: 'DWM-1', cpu: 1.2, memMb: 92, parent: 'winlogon.exe' },
    { name: 'sihost.exe', exe: `${w}\\sihost.exe`, user, cpu: 0.1, memMb: 28 },
    { name: 'taskhostw.exe', exe: `${w}\\taskhostw.exe`, user, cpu: 0, memMb: 16 },
    { name: 'explorer.exe', exe: 'C:\\Windows\\explorer.exe', user, cpu: 0.8, memMb: 168 },
    { name: 'RuntimeBroker.exe', exe: `${w}\\RuntimeBroker.exe`, user, cpu: 0, memMb: 14, count: 4 },
    { name: 'StartMenuExperienceHost.exe', exe: 'C:\\Windows\\SystemApps\\Microsoft.Windows.StartMenuExperienceHost_cw5n1h2txyewy\\StartMenuExperienceHost.exe', user, cpu: 0, memMb: 64 },
    { name: 'SearchHost.exe', exe: 'C:\\Windows\\SystemApps\\MicrosoftWindows.Client.CBS_cw5n1h2txyewy\\SearchHost.exe', user, cpu: 0, memMb: 120 },
    { name: 'TextInputHost.exe', exe: 'C:\\Windows\\SystemApps\\MicrosoftWindows.Client.CBS_cw5n1h2txyewy\\TextInputHost.exe', user, cpu: 0, memMb: 48 },
    { name: 'ctfmon.exe', exe: `${w}\\ctfmon.exe`, user, cpu: 0, memMb: 18 },
    { name: 'OneDrive.exe', exe: `C:\\Users\\${user}\\AppData\\Local\\Microsoft\\OneDrive\\OneDrive.exe`, user, cpu: 0.2, memMb: 96, parent: 'explorer.exe' },
    { name: 'msedge.exe', exe: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', user, cpu: 2.1, memMb: 210, parent: 'explorer.exe' },
    { name: 'msedge.exe', exe: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', user, cpu: 0.6, memMb: 120, parent: 'msedge.exe', count: 7 },
    { name: 'ms-teams.exe', exe: 'C:\\Program Files\\WindowsApps\\MSTeams_25306.804.4102.7193_x64__8wekyb3d8bbwe\\ms-teams.exe', user, cpu: 1.6, memMb: 340, parent: 'explorer.exe' },
    { name: 'msedgewebview2.exe', exe: 'C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\142.0.3595.53\\msedgewebview2.exe', user, cpu: 0.9, memMb: 150, parent: 'ms-teams.exe', count: 5 },
    { name: 'OUTLOOK.EXE', exe: 'C:\\Program Files\\Microsoft Office\\root\\Office16\\OUTLOOK.EXE', user, cpu: 0.7, memMb: 380, parent: 'explorer.exe' },
  )
  const apps: Record<string, ProcSpec[]> = {
    dental: [{ name: 'Dentrix.exe', exe: 'C:\\Program Files (x86)\\Dentrix\\Dentrix.exe', user, cpu: 1.1, memMb: 420, parent: 'explorer.exe' }],
    legal: [{ name: 'iManageWork.exe', exe: 'C:\\Program Files\\iManage\\Work\\iManageWork.exe', user, cpu: 0.6, memMb: 290, parent: 'explorer.exe' }],
    freight: [{ name: 'LoadMaster.exe', exe: 'C:\\Program Files\\McLeod\\LoadMaster\\LoadMaster.exe', user, cpu: 2.4, memMb: 610, parent: 'explorer.exe' }],
    architecture: [
      { name: 'acad.exe', exe: 'C:\\Program Files\\Autodesk\\AutoCAD 2026\\acad.exe', user, cpu: device.sim.cpuBase > 50 ? 38 : 9, memMb: 3800, parent: 'explorer.exe' },
      { name: 'Revit.exe', exe: 'C:\\Program Files\\Autodesk\\Revit 2026\\Revit.exe', user, cpu: device.sim.cpuBase > 50 ? 26 : 3, memMb: 5200, parent: 'explorer.exe' },
    ],
    banking: [{ name: 'SymXchange.exe', exe: 'C:\\Program Files\\Jack Henry\\SymXchange\\SymXchange.exe', user, cpu: 0.8, memMb: 260, parent: 'explorer.exe' }],
    vet: [{ name: 'Cornerstone.exe', exe: 'C:\\Program Files (x86)\\IDEXX\\Cornerstone\\Cornerstone.exe', user, cpu: 1.2, memMb: 380, parent: 'explorer.exe' }],
    bakery: [{ name: 'SquarePOS.exe', exe: 'C:\\Program Files\\Square\\SquarePOS.exe', user, cpu: 0.9, memMb: 210, parent: 'explorer.exe' }],
    schools: [{ name: 'GoogleDriveFS.exe', exe: 'C:\\Program Files\\Google\\Drive File Stream\\113.0.2.0\\GoogleDriveFS.exe', user, cpu: 0.3, memMb: 140, parent: 'explorer.exe', count: 2 }],
  }
  specs.push(...(apps[device.sim.industry] ?? []))
  return specs
}

function linuxProcesses(device: MockDevice): ProcSpec[] {
  const specs: ProcSpec[] = [
    { name: 'systemd', exe: '/usr/lib/systemd/systemd', user: 'root', cpu: 0.1, memMb: 13 },
    { name: 'kthreadd', exe: null, user: 'root', cpu: 0, memMb: 0 },
  ]
  for (const thread of ['rcu_gp', 'rcu_par_gp', 'slub_flushwq', 'netns', 'mm_percpu_wq', 'rcu_tasks_kthread', 'ksoftirqd/0', 'rcu_preempt', 'migration/0', 'cpuhp/0', 'kdevtmpfs', 'inet_frag_wq', 'kauditd', 'khungtaskd', 'oom_reaper', 'writeback', 'kcompactd0', 'ksmd', 'khugepaged', 'kintegrityd', 'kblockd', 'blkcg_punt_bio', 'md', 'edac-poller', 'watchdogd', 'kswapd0', 'ecryptfs-kthread', 'kthrotld', 'jbd2/sda1-8', 'ext4-rsv-conver']) {
    specs.push({ name: thread, exe: null, user: 'root', cpu: 0, memMb: 0, parent: 'kthreadd' })
  }
  specs.push(
    { name: 'kworker/u8:2-events_unbound', exe: null, user: 'root', cpu: 0.1, memMb: 0, parent: 'kthreadd', count: 6 },
    { name: 'systemd-journald', exe: '/usr/lib/systemd/systemd-journald', user: 'root', cpu: 0.2, memMb: 48, parent: 'systemd' },
    { name: 'systemd-udevd', exe: '/usr/lib/systemd/systemd-udevd', user: 'root', cpu: 0, memMb: 9, parent: 'systemd' },
    { name: 'systemd-resolved', exe: '/usr/lib/systemd/systemd-resolved', user: 'systemd-resolve', cpu: 0, memMb: 12, parent: 'systemd' },
    { name: 'systemd-timesyncd', exe: '/usr/lib/systemd/systemd-timesyncd', user: 'systemd-timesync', cpu: 0, memMb: 7, parent: 'systemd' },
    { name: 'systemd-logind', exe: '/usr/lib/systemd/systemd-logind', user: 'root', cpu: 0, memMb: 8, parent: 'systemd' },
    { name: 'dbus-daemon', exe: '/usr/bin/dbus-daemon', user: 'messagebus', cpu: 0, memMb: 5, parent: 'systemd' },
    { name: 'cron', exe: '/usr/sbin/cron', user: 'root', cpu: 0, memMb: 3, parent: 'systemd' },
    { name: 'rsyslogd', exe: '/usr/sbin/rsyslogd', user: 'syslog', cpu: 0, memMb: 6, parent: 'systemd' },
    { name: 'chronyd', exe: '/usr/sbin/chronyd', user: '_chrony', cpu: 0, memMb: 3, parent: 'systemd' },
    { name: 'polkitd', exe: '/usr/lib/polkit-1/polkitd', user: 'polkitd', cpu: 0, memMb: 9, parent: 'systemd' },
    { name: 'sshd', exe: '/usr/sbin/sshd', user: 'root', cpu: 0, memMb: 9, parent: 'systemd' },
    { name: 'agetty', exe: '/usr/sbin/agetty', user: 'root', cpu: 0, memMb: 2, parent: 'systemd' },
    { name: 'rustrmm-agent', exe: '/opt/rustrmm/bin/rustrmm-agent', user: 'root', cpu: 0.2, memMb: 19, parent: 'systemd' },
  )
  const roles: Record<string, ProcSpec[]> = {
    imaging: [
      { name: 'Orthanc', exe: '/usr/sbin/Orthanc', user: 'orthanc', cpu: 3.2, memMb: 640, parent: 'systemd' },
      { name: 'postgres', exe: '/usr/lib/postgresql/16/bin/postgres', user: 'postgres', cpu: 1.1, memMb: 220, parent: 'systemd' },
      { name: 'postgres', exe: '/usr/lib/postgresql/16/bin/postgres', user: 'postgres', cpu: 0.4, memMb: 46, parent: 'postgres', count: 6 },
    ],
    wms: [
      { name: 'nginx', exe: '/usr/sbin/nginx', user: 'root', cpu: 0, memMb: 6, parent: 'systemd' },
      { name: 'nginx', exe: '/usr/sbin/nginx', user: 'nginx', cpu: 0.9, memMb: 14, parent: 'nginx', count: 4 },
      { name: 'java', exe: '/usr/lib/jvm/java-21-openjdk/bin/java', user: 'wms', cpu: 21, memMb: 5400, parent: 'systemd' },
      { name: 'postgres', exe: '/usr/bin/postgres', user: 'postgres', cpu: 4.2, memMb: 1800, parent: 'systemd' },
      { name: 'postgres', exe: '/usr/bin/postgres', user: 'postgres', cpu: 0.6, memMb: 90, parent: 'postgres', count: 9 },
    ],
    network: [
      { name: 'dnsmasq', exe: '/usr/sbin/dnsmasq', user: 'dnsmasq', cpu: 0.1, memMb: 4, parent: 'systemd' },
      { name: 'fail2ban-server', exe: '/usr/bin/python3', user: 'root', cpu: 0.3, memMb: 38, parent: 'systemd' },
    ],
    render: [
      { name: 'blender', exe: '/usr/bin/blender', user: 'render', cpu: 58, memMb: 22_000, parent: 'systemd', count: 2 },
      { name: 'nvidia-persistenced', exe: '/usr/bin/nvidia-persistenced', user: 'nvidia-persistenced', cpu: 0, memMb: 3, parent: 'systemd' },
    ],
    'core-banking': [
      { name: 'nginx', exe: '/usr/sbin/nginx', user: 'root', cpu: 0, memMb: 6, parent: 'systemd' },
      { name: 'nginx', exe: '/usr/sbin/nginx', user: 'nginx', cpu: 1.2, memMb: 16, parent: 'nginx', count: 8 },
      { name: 'java', exe: '/usr/lib/jvm/java-21-openjdk/bin/java', user: 'corebank', cpu: 24, memMb: 12_800, parent: 'systemd' },
    ],
    backup: [
      { name: 'dockerd', exe: '/usr/bin/dockerd', user: 'root', cpu: 0.6, memMb: 92, parent: 'systemd' },
      { name: 'containerd', exe: '/usr/bin/containerd', user: 'root', cpu: 0.3, memMb: 48, parent: 'systemd' },
      { name: 'restic', exe: '/usr/bin/restic', user: 'backup', cpu: 12, memMb: 860, parent: 'cron' },
      { name: 'borg', exe: '/usr/bin/borg', user: 'backup', cpu: 6, memMb: 410, parent: 'cron' },
    ],
  }
  for (const tag of device.tags) specs.push(...(roles[tag] ?? []))
  return specs
}

function macProcesses(device: MockDevice): ProcSpec[] {
  const user = userShort(device)
  const specs: ProcSpec[] = [
    { name: 'kernel_task', exe: null, user: 'root', cpu: 2.4, memMb: 0.2 },
    { name: 'launchd', exe: '/sbin/launchd', user: 'root', cpu: 0.2, memMb: 32 },
    { name: 'logd', exe: '/usr/libexec/logd', user: 'root', cpu: 0.4, memMb: 18, parent: 'launchd' },
    { name: 'UserEventAgent', exe: '/usr/libexec/UserEventAgent', user: 'root', cpu: 0, memMb: 12, parent: 'launchd' },
    { name: 'configd', exe: '/usr/libexec/configd', user: 'root', cpu: 0, memMb: 9, parent: 'launchd' },
    { name: 'WindowServer', exe: '/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer', user: '_windowserver', cpu: 4.8, memMb: 420, parent: 'launchd' },
    { name: 'loginwindow', exe: '/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow', user, cpu: 0, memMb: 64, parent: 'launchd' },
    { name: 'Dock', exe: '/System/Library/CoreServices/Dock.app/Contents/MacOS/Dock', user, cpu: 0.1, memMb: 88, parent: 'launchd' },
    { name: 'Finder', exe: '/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder', user, cpu: 0.1, memMb: 120, parent: 'launchd' },
    { name: 'SystemUIServer', exe: '/System/Library/CoreServices/SystemUIServer.app/Contents/MacOS/SystemUIServer', user, cpu: 0, memMb: 36, parent: 'launchd' },
    { name: 'mds', exe: '/System/Library/Frameworks/CoreServices.framework/Frameworks/Metadata.framework/Support/mds', user: 'root', cpu: 0.6, memMb: 74, parent: 'launchd' },
    { name: 'mds_stores', exe: '/System/Library/Frameworks/CoreServices.framework/Frameworks/Metadata.framework/Support/mds_stores', user: 'root', cpu: 1.3, memMb: 160, parent: 'launchd' },
    { name: 'mdworker_shared', exe: '/System/Library/Frameworks/CoreServices.framework/Frameworks/Metadata.framework/Versions/A/Support/mdworker_shared', user, cpu: 0.2, memMb: 18, parent: 'launchd', count: 5 },
    { name: 'cfprefsd', exe: '/usr/sbin/cfprefsd', user, cpu: 0, memMb: 8, parent: 'launchd', count: 2 },
    { name: 'trustd', exe: '/usr/libexec/trustd', user: 'root', cpu: 0, memMb: 14, parent: 'launchd' },
    { name: 'coreaudiod', exe: '/usr/sbin/coreaudiod', user: '_coreaudiod', cpu: 0.3, memMb: 22, parent: 'launchd' },
    { name: 'bluetoothd', exe: '/usr/sbin/bluetoothd', user: 'root', cpu: 0.1, memMb: 16, parent: 'launchd' },
    { name: 'Safari', exe: '/Applications/Safari.app/Contents/MacOS/Safari', user, cpu: 1.4, memMb: 310, parent: 'launchd' },
    { name: 'com.apple.WebKit.WebContent', exe: '/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent', user, cpu: 0.8, memMb: 190, parent: 'Safari', count: 4 },
    { name: 'Slack', exe: '/Applications/Slack.app/Contents/MacOS/Slack', user, cpu: 0.9, memMb: 260, parent: 'launchd' },
    { name: 'Slack Helper (Renderer)', exe: '/Applications/Slack.app/Contents/Frameworks/Slack Helper (Renderer).app/Contents/MacOS/Slack Helper (Renderer)', user, cpu: 1.2, memMb: 340, parent: 'Slack', count: 2 },
    { name: 'zoom.us', exe: '/Applications/zoom.us.app/Contents/MacOS/zoom.us', user, cpu: 0.4, memMb: 180, parent: 'launchd' },
    { name: '1Password', exe: '/Applications/1Password.app/Contents/MacOS/1Password', user, cpu: 0.2, memMb: 150, parent: 'launchd' },
    { name: 'rustrmm-agent', exe: '/Library/Application Support/RustRMM/rustrmm-agent', user: 'root', cpu: 0.2, memMb: 17, parent: 'launchd' },
  ]
  if (device.tags.includes('design')) {
    specs.push(
      { name: 'Figma', exe: '/Applications/Figma.app/Contents/MacOS/Figma', user, cpu: 6.5, memMb: 1200, parent: 'launchd' },
      { name: 'Adobe Photoshop 2026', exe: '/Applications/Adobe Photoshop 2026/Adobe Photoshop 2026.app/Contents/MacOS/Adobe Photoshop 2026', user, cpu: 3.2, memMb: 2600, parent: 'launchd' },
    )
  }
  return specs
}

interface ProcessState {
  base: (RemoteProcess & { cpuBase: number; memBase: number })[]
  killed: Set<number>
}

const processState = new Map<string, ProcessState>()

function buildProcesses(device: MockDevice): ProcessState['base'] {
  const r = rng(device.seed ^ 0x9e3779b9)
  const specs = device.os_family === 'windows' ? windowsProcesses(device) : device.os_family === 'linux' ? linuxProcesses(device) : macProcesses(device)
  const uptimeStart = Math.floor(Date.now() / 1000) - (device.uptime_s ?? 7 * 86_400)
  const byName = new Map<string, number>()
  const result: ProcessState['base'] = []
  let pid = device.os_family === 'windows' ? 0 : 1
  const nextPid = () => {
    if (result.length === 0) return device.os_family === 'macos' ? 0 : pid
    pid += device.os_family === 'windows' ? r.between(4, 60) * 4 : r.between(1, 40)
    return pid
  }
  const fixed: Record<string, number> = device.os_family === 'windows' ? { System: 4 } : device.os_family === 'macos' ? { launchd: 1 } : { kthreadd: 2 }
  for (const spec of specs) {
    for (let copy = 0; copy < (spec.count ?? 1); copy += 1) {
      const pinned = copy === 0 ? fixed[spec.name] : undefined
      const id = pinned ?? nextPid()
      if (pinned !== undefined) pid = Math.max(pid, pinned)
      const parent = spec.parent ? (byName.get(spec.parent) ?? null) : result.length === 0 ? null : device.os_family === 'windows' ? null : 1
      const late = spec.user && !['SYSTEM', 'root', 'LOCAL SERVICE', 'NETWORK SERVICE'].includes(spec.user)
      result.push({
        pid: id,
        parent: parent === id ? null : parent,
        name: spec.name,
        exe: spec.exe,
        user: spec.user,
        cpu: 0,
        memory: 0,
        cpuBase: spec.cpu * r.float(0.6, 1.4),
        memBase: Math.max(0, spec.memMb * r.float(0.8, 1.25) * 1_048_576),
        started_at: spec.exe === null && result.length < 3 ? uptimeStart : uptimeStart + (late ? r.between(600, 60_000) : r.between(5, 120)),
        status: device.os_family === 'windows' ? null : r.chance(0.94) ? 'Sleep' : 'Run',
      })
      if (!byName.has(spec.name)) byName.set(spec.name, id)
    }
  }
  return result
}

export function processesFor(device: MockDevice): RemoteProcess[] {
  let state = processState.get(device.id)
  if (!state) {
    state = { base: buildProcesses(device), killed: new Set() }
    processState.set(device.id, state)
  }
  const tick = Math.floor(Date.now() / 2500)
  return state.base
    .filter((item) => !state.killed.has(item.pid))
    .map((item, index) => {
      const wave = Math.sin(tick * 0.9 + index * 1.7) * 0.5 + Math.sin(tick * 0.37 + index) * 0.35
      const cpu = item.cpuBase === 0 ? 0 : Math.max(0, item.cpuBase * (1 + wave * 0.8))
      const memory = Math.round(item.memBase * (1 + Math.sin(tick * 0.2 + index) * 0.03))
      const { cpuBase: _cpu, memBase: _mem, ...rest } = item
      void _cpu
      void _mem
      return { ...rest, cpu: Math.round(cpu * 100) / 100, memory }
    })
    .sort((a, b) => b.cpu - a.cpu || b.memory - a.memory)
}

/** Ends a process (and optionally its descendants); returns how many were terminated. */
export function killProcess(device: MockDevice, pid: number, tree: boolean): number {
  const state = processState.get(device.id)
  if (!state) return 0
  const alive = state.base.filter((item) => !state.killed.has(item.pid))
  const targets = new Set<number>([pid])
  if (tree) {
    let grew = true
    while (grew) {
      grew = false
      for (const item of alive) {
        if (item.parent !== null && targets.has(item.parent) && !targets.has(item.pid)) {
          targets.add(item.pid)
          grew = true
        }
      }
    }
  }
  targets.forEach((target) => state.killed.add(target))
  return targets.size
}

// ------------------------------------------------------------------ services

const WIN_SERVICES: [string, string, string, string, string][] = [
  ['AppIDSvc', 'Application Identity', 'stopped', 'manual', 'NT AUTHORITY\\LocalService'],
  ['Appinfo', 'Application Information', 'running', 'manual', 'LocalSystem'],
  ['AudioSrv', 'Windows Audio', 'running', 'auto', 'NT AUTHORITY\\LocalService'],
  ['BFE', 'Base Filtering Engine', 'running', 'auto', 'NT AUTHORITY\\LocalService'],
  ['BITS', 'Background Intelligent Transfer Service', 'running', 'manual', 'LocalSystem'],
  ['BrokerInfrastructure', 'Background Tasks Infrastructure Service', 'running', 'auto', 'LocalSystem'],
  ['CryptSvc', 'Cryptographic Services', 'running', 'auto', 'NT AUTHORITY\\NetworkService'],
  ['DcomLaunch', 'DCOM Server Process Launcher', 'running', 'auto', 'LocalSystem'],
  ['Dhcp', 'DHCP Client', 'running', 'auto', 'NT AUTHORITY\\LocalService'],
  ['DiagTrack', 'Connected User Experiences and Telemetry', 'running', 'auto', 'LocalSystem'],
  ['Dnscache', 'DNS Client', 'running', 'auto', 'NT AUTHORITY\\NetworkService'],
  ['DPS', 'Diagnostic Policy Service', 'running', 'auto', 'NT AUTHORITY\\LocalService'],
  ['EventLog', 'Windows Event Log', 'running', 'auto', 'NT AUTHORITY\\LocalService'],
  ['EventSystem', 'COM+ Event System', 'running', 'auto', 'NT AUTHORITY\\LocalService'],
  ['Fax', 'Fax', 'stopped', 'disabled', 'NT AUTHORITY\\NetworkService'],
  ['FontCache', 'Windows Font Cache Service', 'running', 'auto', 'NT AUTHORITY\\LocalService'],
  ['gpsvc', 'Group Policy Client', 'running', 'auto', 'LocalSystem'],
  ['iphlpsvc', 'IP Helper', 'running', 'auto', 'LocalSystem'],
  ['LanmanServer', 'Server', 'running', 'auto', 'LocalSystem'],
  ['LanmanWorkstation', 'Workstation', 'running', 'auto', 'NT AUTHORITY\\NetworkService'],
  ['lmhosts', 'TCP/IP NetBIOS Helper', 'running', 'manual', 'NT AUTHORITY\\LocalService'],
  ['MpsSvc', 'Windows Defender Firewall', 'running', 'auto', 'NT AUTHORITY\\LocalService'],
  ['msiserver', 'Windows Installer', 'stopped', 'manual', 'LocalSystem'],
  ['NlaSvc', 'Network Location Awareness', 'running', 'auto', 'NT AUTHORITY\\NetworkService'],
  ['nsi', 'Network Store Interface Service', 'running', 'auto', 'NT AUTHORITY\\LocalService'],
  ['PlugPlay', 'Plug and Play', 'running', 'manual', 'LocalSystem'],
  ['Power', 'Power', 'running', 'auto', 'LocalSystem'],
  ['ProfSvc', 'User Profile Service', 'running', 'auto', 'LocalSystem'],
  ['RemoteRegistry', 'Remote Registry', 'stopped', 'disabled', 'NT AUTHORITY\\LocalService'],
  ['RpcEptMapper', 'RPC Endpoint Mapper', 'running', 'auto', 'NT AUTHORITY\\NetworkService'],
  ['RpcSs', 'Remote Procedure Call (RPC)', 'running', 'auto', 'NT AUTHORITY\\NetworkService'],
  ['RustRMMAgent', 'RustRMM Agent', 'running', 'auto', 'LocalSystem'],
  ['SamSs', 'Security Accounts Manager', 'running', 'auto', 'LocalSystem'],
  ['Schedule', 'Task Scheduler', 'running', 'auto', 'LocalSystem'],
  ['SecurityHealthService', 'Windows Security Service', 'running', 'manual', 'LocalSystem'],
  ['SENS', 'System Event Notification Service', 'running', 'auto', 'LocalSystem'],
  ['ShellHWDetection', 'Shell Hardware Detection', 'running', 'auto', 'LocalSystem'],
  ['Spooler', 'Print Spooler', 'running', 'auto', 'LocalSystem'],
  ['SysMain', 'SysMain', 'running', 'auto', 'LocalSystem'],
  ['TermService', 'Remote Desktop Services', 'stopped', 'manual', 'NT AUTHORITY\\NetworkService'],
  ['Themes', 'Themes', 'running', 'auto', 'LocalSystem'],
  ['TrustedInstaller', 'Windows Modules Installer', 'stopped', 'manual', 'LocalSystem'],
  ['UsoSvc', 'Update Orchestrator Service', 'running', 'auto', 'LocalSystem'],
  ['VSS', 'Volume Shadow Copy', 'stopped', 'manual', 'LocalSystem'],
  ['W32Time', 'Windows Time', 'running', 'manual', 'NT AUTHORITY\\LocalService'],
  ['WdNisSvc', 'Microsoft Defender Antivirus Network Inspection Service', 'running', 'manual', 'NT AUTHORITY\\LocalService'],
  ['WinDefend', 'Microsoft Defender Antivirus Service', 'running', 'auto', 'LocalSystem'],
  ['WinHttpAutoProxySvc', 'WinHTTP Web Proxy Auto-Discovery Service', 'running', 'manual', 'NT AUTHORITY\\LocalService'],
  ['Winmgmt', 'Windows Management Instrumentation', 'running', 'auto', 'LocalSystem'],
  ['WinRM', 'Windows Remote Management (WS-Management)', 'stopped', 'manual', 'NT AUTHORITY\\NetworkService'],
  ['wscsvc', 'Security Center', 'running', 'auto', 'NT AUTHORITY\\LocalService'],
  ['WSearch', 'Windows Search', 'running', 'auto', 'LocalSystem'],
  ['wuauserv', 'Windows Update', 'running', 'manual', 'LocalSystem'],
]

const WIN_SERVER_EXTRA: Record<string, [string, string, string, string, string][]> = {
  'domain-controller': [
    ['NTDS', 'Active Directory Domain Services', 'running', 'auto', 'LocalSystem'],
    ['DNS', 'DNS Server', 'running', 'auto', 'LocalSystem'],
    ['DFSR', 'DFS Replication', 'running', 'auto', 'LocalSystem'],
    ['Kdc', 'Kerberos Key Distribution Center', 'running', 'auto', 'LocalSystem'],
    ['Netlogon', 'Netlogon', 'running', 'auto', 'LocalSystem'],
    ['ADWS', 'Active Directory Web Services', 'running', 'auto', 'LocalSystem'],
  ],
  'document-management': [
    ['MSSQLSERVER', 'SQL Server (MSSQLSERVER)', 'running', 'auto', 'NT Service\\MSSQLSERVER'],
    ['SQLSERVERAGENT', 'SQL Server Agent (MSSQLSERVER)', 'stopped', 'manual', 'NT Service\\SQLSERVERAGENT'],
    ['W3SVC', 'World Wide Web Publishing Service', 'running', 'auto', 'LocalSystem'],
    ['iManageWorkServer', 'iManage Work Server', 'running', 'auto', 'HARBORPINE\\svc-imanage'],
  ],
  'file-server': [
    ['LanmanServer', 'Server', 'running', 'auto', 'LocalSystem'],
    ['srmsvc', 'File Server Resource Manager', 'running', 'auto', 'LocalSystem'],
  ],
  'practice-management': [['CornerstoneServer', 'IDEXX Cornerstone Server', 'running', 'auto', 'LocalSystem']],
}

const LINUX_UNITS: [string, string, string, string][] = [
  ['apparmor.service', 'Load AppArmor profiles', 'exited', 'active'],
  ['certbot-renew.service', 'Certbot renewal', 'failed', 'failed'],
  ['chrony.service', 'chrony, an NTP client/server', 'running', 'active'],
  ['cron.service', 'Regular background program processing daemon', 'running', 'active'],
  ['dbus.service', 'D-Bus System Message Bus', 'running', 'active'],
  ['getty@tty1.service', 'Getty on tty1', 'running', 'active'],
  ['multipathd.service', 'Device-Mapper Multipath Device Controller', 'dead', 'inactive'],
  ['networkd-dispatcher.service', 'Dispatcher daemon for systemd-networkd', 'running', 'active'],
  ['polkit.service', 'Authorization Manager', 'running', 'active'],
  ['rsyslog.service', 'System Logging Service', 'running', 'active'],
  ['rustrmm-agent.service', 'RustRMM agent', 'running', 'active'],
  ['ssh.service', 'OpenBSD Secure Shell server', 'running', 'active'],
  ['systemd-journald.service', 'Journal Service', 'running', 'active'],
  ['systemd-logind.service', 'User Login Management', 'running', 'active'],
  ['systemd-networkd.service', 'Network Configuration', 'running', 'active'],
  ['systemd-resolved.service', 'Network Name Resolution', 'running', 'active'],
  ['systemd-timesyncd.service', 'Network Time Synchronization', 'dead', 'inactive'],
  ['systemd-udevd.service', 'Rule-based Manager for Device Events and Files', 'running', 'active'],
  ['ufw.service', 'Uncomplicated firewall', 'exited', 'active'],
  ['unattended-upgrades.service', 'Unattended Upgrades Shutdown', 'running', 'active'],
  ['snapd.service', 'Snap Daemon', 'dead', 'inactive'],
]

const LINUX_ROLE_UNITS: Record<string, [string, string, string, string][]> = {
  imaging: [
    ['orthanc.service', 'Orthanc DICOM server', 'running', 'active'],
    ['postgresql@16-main.service', 'PostgreSQL Cluster 16-main', 'running', 'active'],
  ],
  wms: [
    ['nginx.service', 'The nginx HTTP and reverse proxy server', 'running', 'active'],
    ['postgresql.service', 'PostgreSQL database server', 'running', 'active'],
    ['wms-app.service', 'Summit WMS application', 'running', 'active'],
  ],
  network: [
    ['wg-quick@wg0.service', 'WireGuard via wg-quick(8) for wg0', 'exited', 'active'],
    ['dnsmasq.service', 'dnsmasq - A lightweight DHCP and caching DNS server', 'running', 'active'],
    ['fail2ban.service', 'Fail2Ban Service', 'running', 'active'],
  ],
  render: [['render-node.service', 'Atlas render node', 'running', 'active']],
  'core-banking': [
    ['nginx.service', 'The nginx HTTP and reverse proxy server', 'running', 'active'],
    ['corebank.service', 'Core banking application server', 'running', 'active'],
  ],
  backup: [
    ['docker.service', 'Docker Application Container Engine', 'running', 'active'],
    ['containerd.service', 'containerd container runtime', 'running', 'active'],
    ['restic-backup.service', 'Nightly restic backup', 'dead', 'inactive'],
  ],
}

const MAC_LABELS: [string, string, number | null][] = [
  ['com.apple.cloudd', 'running', 0],
  ['com.apple.mdworker.shared', 'running', 0],
  ['com.apple.softwareupdated', 'running', 0],
  ['com.apple.backupd', 'stopped', 0],
  ['com.apple.bird', 'running', 0],
  ['com.apple.coreservices.uiagent', 'stopped', -9],
  ['com.apple.icloud.findmydeviced', 'running', 0],
  ['com.apple.TrustEvaluationAgent', 'stopped', 0],
  ['com.microsoft.autoupdate.helper', 'stopped', 78],
  ['com.1password.1password-launcher', 'running', 0],
  ['com.google.keystone.daemon', 'stopped', 0],
  ['com.rustrmm.agent', 'running', 0],
  ['us.zoom.ZoomDaemon', 'running', 0],
]

const serviceState = new Map<string, Map<string, RemoteService>>()

export function servicesFor(device: MockDevice): Map<string, RemoteService> {
  let state = serviceState.get(device.id)
  if (state) return state
  state = new Map()
  if (device.os_family === 'windows') {
    const extra = device.tags.flatMap((tag) => WIN_SERVER_EXTRA[tag] ?? [])
    for (const [name, display, svcState, mode, account] of [...WIN_SERVICES, ...extra]) {
      const value: RemoteService = { name, display_name: display, state: svcState, start_mode: mode, account }
      if (name === 'WinDefend' && !device.sim.avEnabled) value.state = 'stopped'
      if (name === 'MpsSvc' && !device.sim.firewall) value.state = 'stopped'
      if (name === 'TermService' && isServer(device)) value.state = 'running'
      state.set(name, value)
    }
  } else if (device.os_family === 'linux') {
    const extra = device.tags.flatMap((tag) => LINUX_ROLE_UNITS[tag] ?? [])
    for (const [name, display, sub, active] of [...LINUX_UNITS, ...extra]) {
      state.set(name, { name, display_name: display, state: sub, active, load: 'loaded' })
    }
  } else {
    for (const [name, svcState, lastExit] of MAC_LABELS) state.set(name, { name, state: svcState, last_exit: lastExit })
  }
  serviceState.set(device.id, state)
  return state
}

// ------------------------------------------------------------------ event logs

interface EventTemplate {
  level: number
  id: number | null
  source: string
  message: (r: ReturnType<typeof rng>, device: MockDevice) => string
  weight: number
}

const KB = ['KB5066835', 'KB5067112', 'KB5065789', 'KB890830', 'KB2267602']

const WINDOWS_TEMPLATES: Record<string, EventTemplate[]> = {
  System: [
    { level: 4, id: 7036, source: 'Service Control Manager', weight: 18, message: (r) => `The ${r.pick(['Windows Update', 'Background Intelligent Transfer Service', 'Windows Modules Installer', 'WinHTTP Web Proxy Auto-Discovery Service', 'Device Setup Manager'])} service entered the ${r.pick(['running', 'stopped'])} state.` },
    { level: 4, id: 7040, source: 'Service Control Manager', weight: 4, message: () => 'The start type of the Background Intelligent Transfer Service service was changed from auto start to demand start.' },
    { level: 4, id: 16, source: 'Microsoft-Windows-Kernel-General', weight: 6, message: (r) => `The access history in hive \\??\\C:\\Users\\${r.pick(['Default', 'Public'])}\\NTUSER.DAT was cleared updating 12 keys and creating 2 modified pages.` },
    { level: 4, id: 19, source: 'Microsoft-Windows-WindowsUpdateClient', weight: 3, message: (r) => `Installation Successful: Windows successfully installed the following update: Security Intelligence Update for Microsoft Defender Antivirus - ${r.pick(KB)} (Version 1.441.${r.between(100, 400)}.0) - Current Channel (Broad)` },
    { level: 4, id: 37, source: 'Microsoft-Windows-Time-Service', weight: 3, message: (r, d) => `The time provider NtpClient is currently receiving valid time data from ${d.domain ? `DC01.${d.domain}` : 'time.windows.com'} (ntp.d|${r.between(10, 250)}.${r.between(0, 255)}.0.1:123->10.0.0.1:123).` },
    { level: 3, id: 4231, source: 'Tcpip', weight: 2, message: () => 'A request to allocate an ephemeral port number from the global TCP port space has failed due to all such ports being in use.' },
    { level: 3, id: 10016, source: 'Microsoft-Windows-DistributedCOM', weight: 6, message: () => 'The application-specific permission settings do not grant Local Activation permission for the COM Server application with CLSID {2593F8B9-4EAF-457C-B68A-50F6B8EA6B54} and APPID {15C20B67-12E7-4BB6-92BB-7AFF07997402} to the user NT AUTHORITY\\LOCAL SERVICE SID (S-1-5-19) from address LocalHost (Using LRPC) running in the application container Unavailable SID (Unavailable). This security permission can be modified using the Component Services administrative tool.' },
    { level: 3, id: 153, source: 'disk', weight: 1, message: () => 'The IO operation at logical block address 0x2c3f1a8 for Disk 0 (PDO name: \\Device\\0000003a) was retried.' },
    { level: 3, id: 1014, source: 'Microsoft-Windows-DNS-Client', weight: 2, message: (r) => `Name resolution for the name ${r.pick(['wpad.local', 'settings-win.data.microsoft.com', 'fs01.corp.local'])} timed out after none of the configured DNS servers responded.` },
    { level: 2, id: 7000, source: 'Service Control Manager', weight: 1, message: () => 'The Fax service failed to start due to the following error: \r\nThe service cannot be started, either because it is disabled or because it has no enabled devices associated with it.' },
    { level: 2, id: 7023, source: 'Service Control Manager', weight: 1, message: () => 'The Connected Devices Platform User Service_3a5f1 service terminated with the following error: \r\nThe operation completed successfully.' },
    { level: 1, id: 41, source: 'Microsoft-Windows-Kernel-Power', weight: 0.3, message: () => 'The system has rebooted without cleanly shutting down first. This error could be caused if the system stopped responding, crashed, or lost power unexpectedly.' },
    { level: 4, id: 6013, source: 'EventLog', weight: 1, message: (_r, d) => `The system uptime is ${d.uptime_s ?? 86_400} seconds.` },
  ],
  Application: [
    { level: 4, id: 1040, source: 'MsiInstaller', weight: 3, message: (r) => `Beginning a Windows Installer transaction: {${r.hex(8).toUpperCase()}-${r.hex(4).toUpperCase()}-${r.hex(4).toUpperCase()}-${r.hex(4).toUpperCase()}-${r.hex(12).toUpperCase()}}. Client Process Id: ${r.between(1000, 9000)}.` },
    { level: 4, id: 15, source: 'SecurityCenter', weight: 4, message: () => 'Updated Windows Defender status successfully to SECURITY_PRODUCT_STATE_ON.' },
    { level: 4, id: 16384, source: 'Microsoft-Windows-Security-SPP', weight: 5, message: () => 'Successfully scheduled Software Protection service for re-start at 2026-11-18T09:12:44Z. Reason: RulesEngine.' },
    { level: 4, id: 1000, source: 'Microsoft-Windows-RestartManager', weight: 2, message: (r) => `Starting session ${r.between(0, 3)} - 2026-11-17T${String(r.between(0, 23)).padStart(2, '0')}:${String(r.between(0, 59)).padStart(2, '0')}:14.8812210Z.` },
    { level: 4, id: 8224, source: 'VSS', weight: 2, message: () => 'The VSS service is shutting down due to idle timeout.' },
    { level: 3, id: 1530, source: 'Microsoft-Windows-User Profiles Service', weight: 3, message: () => 'Windows detected your registry file is still in use by other applications or services. The file will be unloaded now. The applications or services that hold your registry file may not function properly afterwards.' },
    { level: 2, id: 1000, source: 'Application Error', weight: 2, message: (r) => { const app = r.pick(['OUTLOOK.EXE', 'msedge.exe', 'Dentrix.exe', 'acad.exe']); return `Faulting application name: ${app}, version: 16.0.19328.20190, time stamp: 0x672f1b2c\r\nFaulting module name: ${r.pick(['ntdll.dll', 'mso20win32client.dll', 'KERNELBASE.dll'])}, version: 10.0.26100.6899, time stamp: 0x9a5b3c21\r\nException code: 0xc0000005\r\nFault offset: 0x00000000000a1f2b\r\nFaulting process id: 0x${r.hex(4)}\r\nFaulting application path: C:\\Program Files\\Microsoft Office\\root\\Office16\\${app}\r\nReport Id: ${r.hex(8)}-${r.hex(4)}-${r.hex(4)}-${r.hex(4)}-${r.hex(12)}` } },
    { level: 2, id: 1026, source: '.NET Runtime', weight: 1, message: () => 'Application: LOB.Client.exe\r\nCoreCLR Version: 8.0.1125.51716\r\n.NET Version: 8.0.11\r\nDescription: The process was terminated due to an unhandled exception.\r\nException Info: System.IO.IOException: The network path was not found.\r\n   at LOB.Client.Sync.Run()' },
    { level: 4, id: 300, source: 'Microsoft Office Alerts', weight: 1, message: () => 'Microsoft Outlook\r\nOutlook is trying to retrieve data from the Microsoft Exchange server. Retrying.' },
  ],
  Security: [
    { level: 4, id: 4624, source: 'Microsoft-Windows-Security-Auditing', weight: 14, message: (r, d) => `An account was successfully logged on.\r\n\r\nSubject:\r\n\tSecurity ID:\t\tSYSTEM\r\n\tAccount Name:\t\t${d.hostname}$\r\n\r\nLogon Information:\r\n\tLogon Type:\t\t${r.pick([2, 3, 5, 10])}\r\n\tElevated Token:\t\tYes\r\n\r\nNew Logon:\r\n\tAccount Name:\t\t${r.pick([userShort(d), 'SYSTEM', 'svc-backup'])}\r\n\tAccount Domain:\t\t${d.domain?.split('.')[0].toUpperCase() ?? d.hostname}` },
    { level: 4, id: 4672, source: 'Microsoft-Windows-Security-Auditing', weight: 8, message: () => 'Special privileges assigned to new logon.\r\n\r\nSubject:\r\n\tSecurity ID:\t\tSYSTEM\r\n\tAccount Name:\t\tSYSTEM\r\n\r\nPrivileges:\t\tSeAssignPrimaryTokenPrivilege\r\n\t\t\tSeTcbPrivilege\r\n\t\t\tSeSecurityPrivilege' },
    { level: 4, id: 4634, source: 'Microsoft-Windows-Security-Auditing', weight: 6, message: () => 'An account was logged off.\r\n\r\nLogon Type:\t\t\t3' },
    { level: 3, id: 4625, source: 'Microsoft-Windows-Security-Auditing', weight: 2, message: (r) => `An account failed to log on.\r\n\r\nAccount For Which Logon Failed:\r\n\tAccount Name:\t\t${r.pick(['administrator', 'admin', 'scanner', 'test'])}\r\n\r\nFailure Information:\r\n\tFailure Reason:\t\tUnknown user name or bad password.\r\n\tStatus:\t\t\t0xC000006D\r\n\r\nNetwork Information:\r\n\tSource Network Address:\t${r.between(10, 192)}.${r.between(0, 255)}.${r.between(0, 255)}.${r.between(1, 254)}` },
    { level: 4, id: 4798, source: 'Microsoft-Windows-Security-Auditing', weight: 2, message: () => "A user's local group membership was enumerated." },
  ],
  Setup: [
    { level: 4, id: 2, source: 'Microsoft-Windows-Servicing', weight: 3, message: (r) => `Package ${r.pick(KB)} was successfully changed to the Installed state.` },
    { level: 4, id: 4, source: 'Microsoft-Windows-Servicing', weight: 2, message: (r) => `A reboot is necessary before package ${r.pick(KB)} can be changed to the Installed state.` },
    { level: 4, id: 1, source: 'Microsoft-Windows-Servicing', weight: 2, message: (r) => `Initiating changes for package ${r.pick(KB)}. Current state is Absent. Target state is Installed. Client id: UpdateAgentLCU.` },
  ],
  'Microsoft-Windows-PowerShell/Operational': [
    { level: 5, id: 4104, source: 'Microsoft-Windows-PowerShell', weight: 6, message: () => 'Creating Scriptblock text (1 of 1):\r\nGet-CimInstance -ClassName Win32_OperatingSystem | Select-Object Caption, Version, LastBootUpTime\r\n\r\nScriptBlock ID: 6c1d4f21-08a2-4f8b-9a7e-1e2f9a2b6d11' },
    { level: 4, id: 40961, source: 'Microsoft-Windows-PowerShell', weight: 3, message: () => 'PowerShell console is starting up' },
    { level: 4, id: 40962, source: 'Microsoft-Windows-PowerShell', weight: 3, message: () => 'PowerShell console is ready for user input' },
    { level: 3, id: 4100, source: 'Microsoft-Windows-PowerShell', weight: 1, message: () => 'Error Message = The term \'Get-WindowsUpdateLog2\' is not recognized as a name of a cmdlet, function, script file, or executable program.\r\nFully Qualified Error ID = CommandNotFoundException' },
  ],
  'Microsoft-Windows-TaskScheduler/Operational': [
    { level: 4, id: 100, source: 'Microsoft-Windows-TaskScheduler', weight: 5, message: (r) => `Task Scheduler started "{${r.hex(8)}-${r.hex(4)}-${r.hex(4)}-${r.hex(4)}-${r.hex(12)}}" instance of the "\\Microsoft\\Windows\\${r.pick(['UpdateOrchestrator\\Schedule Scan', 'Defrag\\ScheduledDefrag', 'WindowsUpdate\\Scheduled Start'])}" task.` },
    { level: 4, id: 102, source: 'Microsoft-Windows-TaskScheduler', weight: 5, message: () => 'Task Scheduler successfully finished "{a1b2c3d4-0000-4000-8000-1234567890ab}" instance of the "\\Microsoft\\Windows\\UpdateOrchestrator\\Schedule Scan" task.' },
    { level: 2, id: 103, source: 'Microsoft-Windows-TaskScheduler', weight: 1, message: () => 'Task Scheduler failed to start instance "{e5f6a7b8-0000-4000-8000-0987654321fe}" of "\\BackupNightly" task for user "NT AUTHORITY\\SYSTEM". Additional Data: Error Value: 2147942402.' },
  ],
  'Microsoft-Windows-Windows Defender/Operational': [
    { level: 4, id: 1150, source: 'Microsoft-Windows-Windows Defender', weight: 4, message: () => 'Endpoint Protection client is up and running in a healthy state.\r\nPlatform version: 4.18.25090.3009\r\nEngine version: 1.1.25090.3001\r\nSecurity intelligence version: 1.441.231.0' },
    { level: 4, id: 2000, source: 'Microsoft-Windows-Windows Defender', weight: 3, message: () => 'Microsoft Defender Antivirus security intelligence version updated.\r\nCurrent security intelligence Version: 1.441.231.0\r\nPrevious security intelligence Version: 1.441.198.0' },
    { level: 3, id: 1116, source: 'Microsoft-Windows-Windows Defender', weight: 0.4, message: () => 'Microsoft Defender Antivirus has detected malware or other potentially unwanted software.\r\nName: PUA:Win32/Presenoker\r\nSeverity: Low\r\nPath: file:_C:\\Users\\Public\\Downloads\\setup_free_pdf.exe\r\nDetection Origin: Local machine' },
  ],
}

const JOURNAL_TEMPLATES: EventTemplate[] = [
  { level: 4, id: null, source: 'systemd', weight: 10, message: (r) => `Started ${r.pick(['session-4213.scope - Session 4213 of User deploy', 'apt-daily.service - Daily apt download activities', 'logrotate.service - Rotate log files', 'sysstat-collect.service - system activity accounting tool', 'man-db.service - Daily man-db regeneration'])}.` },
  { level: 4, id: null, source: 'sshd', weight: 8, message: (r) => `Accepted publickey for deploy from 10.60.1.${r.between(10, 200)} port ${r.between(40000, 65000)} ssh2: ED25519 SHA256:${r.hex(10)}Qk3vN7xV` },
  { level: 4, id: null, source: 'CRON', weight: 6, message: () => 'pam_unix(cron:session): session opened for user root(uid=0) by root(uid=0)' },
  { level: 4, id: null, source: 'rustrmm-agent', weight: 5, message: (r) => `inventory: collected section ${r.pick(['software', 'services', 'network', 'storage'])} in ${r.between(40, 900)} ms` },
  { level: 4, id: null, source: 'systemd-logind', weight: 3, message: (r) => `New session ${r.between(4000, 5000)} of user deploy.` },
  { level: 4, id: null, source: 'chronyd', weight: 2, message: (r) => `Selected source ${r.between(100, 200)}.${r.between(0, 255)}.12.4 (ntp.ubuntu.com)` },
  { level: 3, id: null, source: 'kernel', weight: 2, message: (r) => `[UFW BLOCK] IN=eth0 OUT= MAC=52:54:00:3a:91:0c SRC=${r.between(40, 200)}.${r.between(0, 255)}.${r.between(0, 255)}.${r.between(1, 254)} DST=10.60.1.20 LEN=44 PROTO=TCP SPT=${r.between(1024, 65000)} DPT=${r.pick([23, 445, 3389, 8080])} WINDOW=1024 SYN URGP=0` },
  { level: 3, id: null, source: 'sshd', weight: 3, message: (r) => `Invalid user ${r.pick(['admin', 'oracle', 'test', 'ubuntu'])} from ${r.between(40, 220)}.${r.between(0, 255)}.${r.between(0, 255)}.${r.between(1, 254)} port ${r.between(30000, 65000)}` },
  { level: 2, id: null, source: 'certbot', weight: 1, message: () => 'Failed to renew certificate wms.summitfreight.com with error: Some challenges have failed.' },
  { level: 2, id: null, source: 'systemd', weight: 1, message: () => 'certbot-renew.service: Failed with result \'exit-code\'.' },
  { level: 4, id: null, source: 'nginx', weight: 2, message: () => 'nginx.service: Reloading.' },
  { level: 1, id: null, source: 'kernel', weight: 0.2, message: () => 'EXT4-fs warning (device sda1): ext4_dx_add_entry:2516: Directory (ino: 1310722) index full, reach max htree level :2' },
]

const UNIFIED_TEMPLATES: EventTemplate[] = [
  { level: 4, id: null, source: 'com.apple.xpc.launchd', weight: 8, message: (r) => `Service only ran for ${r.between(0, 9)} seconds. Pushing respawn out by ${r.between(1, 10)} seconds.` },
  { level: 4, id: null, source: 'softwareupdated', weight: 4, message: () => 'SUOSUServiceDaemon: Checking for available updates (background)' },
  { level: 4, id: null, source: 'mDNSResponder', weight: 4, message: (r) => `[R${r.between(1000, 9999)}] DNSServiceQueryRecord(1D000, 0, <private>, Addr) START PID[${r.between(300, 900)}](trustd)` },
  { level: 4, id: null, source: 'rustrmm-agent', weight: 5, message: (r) => `heartbeat ok (rtt ${r.between(8, 60)} ms)` },
  { level: 3, id: null, source: 'kernel', weight: 2, message: () => 'Sandbox: mdworker_shared(1452) deny(1) file-read-data /Users/Shared/.fseventsd' },
  { level: 2, id: null, source: 'com.apple.backupd', weight: 0.6, message: () => 'Backup failed with error 19: The backup disk could not be found.' },
]

const KNOWN_UNITS = ['ssh', 'cron', 'nginx', 'rustrmm-agent', 'systemd', 'kernel', 'certbot', 'chronyd', 'systemd-logind']

/** Throws a `device_error` message for channels the "agent" can't open. */
export class AgentError extends Error {}

export function eventLogsFor(device: MockDevice, log: string, level: number, hours: number, limit: number): EventLogEntry[] {
  let templates: EventTemplate[]
  if (device.os_family === 'windows') {
    const channel = log || 'System'
    const match = Object.keys(WINDOWS_TEMPLATES).find((name) => name.toLowerCase() === channel.toLowerCase())
    if (!match) throw new AgentError(`The specified channel could not be found. (os error 15007)`)
    templates = WINDOWS_TEMPLATES[match]
  } else if (device.os_family === 'linux') {
    const unit = log && log !== 'system' ? log.replace(/\.service$/, '') : ''
    templates = unit ? JOURNAL_TEMPLATES.filter((item) => item.source.toLowerCase().includes(unit.toLowerCase()) || unit.includes(item.source.toLowerCase())) : JOURNAL_TEMPLATES
    if (unit && templates.length === 0 && !KNOWN_UNITS.includes(unit)) return []
  } else {
    templates = UNIFIED_TEMPLATES
  }
  const totalWeight = templates.reduce((sum, item) => sum + item.weight, 0)
  if (totalWeight === 0) return []
  const now = Date.now()
  const perHour = device.os_family === 'windows' ? (log === 'Security' ? 26 : 9) : 14
  const count = Math.min(1500, Math.round(perHour * hours))
  const entries: EventLogEntry[] = []
  // Bucket by hour so results are stable between refreshes but move with time.
  const bucket = Math.floor(now / 3_600_000)
  const r = rng(hashString(`${device.id}:${log}:${bucket}`))
  for (let index = 0; index < count; index += 1) {
    let roll = r.next() * totalWeight
    let template = templates[0]
    for (const item of templates) {
      roll -= item.weight
      if (roll <= 0) {
        template = item
        break
      }
    }
    const at = now - ((index + r.next()) / count) * hours * 3_600_000
    entries.push({ time: new Date(at).toISOString(), level: template.level, id: template.id, source: template.source, message: template.message(r, device) })
  }
  return entries.filter((entry) => level === 0 || (entry.level >= 1 && entry.level <= level)).slice(0, limit)
}

// ------------------------------------------------------------------ registry

interface RegNode {
  values?: [string, string, string][]
  keys?: Record<string, RegNode>
  denied?: boolean
}

function registryTree(device: MockDevice): Record<string, RegNode> {
  const r = rng(device.seed ^ 0x51ed)
  const build = device.os_version.split('.').pop() ?? '26100'
  const productName = device.os_name.replace('Windows 11', 'Windows 10')
  const services: Record<string, RegNode> = {}
  for (const [name, display, , mode] of WIN_SERVICES) {
    services[name] = {
      values: [
        ['DisplayName', 'REG_SZ', display],
        ['ImagePath', 'REG_EXPAND_SZ', name === 'RustRMMAgent' ? '"C:\\Program Files\\RustRMM\\rustrmm-agent.exe" service' : `%SystemRoot%\\System32\\svchost.exe -k ${r.pick(['netsvcs', 'LocalService', 'NetworkService'])} -p`],
        ['Start', 'REG_DWORD', String(mode === 'auto' ? 2 : mode === 'manual' ? 3 : 4)],
        ['Type', 'REG_DWORD', String(name === 'RustRMMAgent' ? 16 : 32)],
        ['ErrorControl', 'REG_DWORD', '1'],
        ['ObjectName', 'REG_SZ', name === 'RustRMMAgent' ? 'LocalSystem' : 'NT AUTHORITY\\LocalService'],
      ],
      keys: { Parameters: { values: [['ServiceDll', 'REG_EXPAND_SZ', `%SystemRoot%\\System32\\${name.toLowerCase()}.dll`]] } },
    }
  }
  const sid = `S-1-5-21-${r.between(1_000_000_000, 4_000_000_000)}-${r.between(1_000_000_000, 4_000_000_000)}-${r.between(1_000_000_000, 4_000_000_000)}-1001`
  const digitalId = Array.from({ length: 300 }, () => r.hex(2)).join('')
  return {
    HKLM: {
      keys: {
        HARDWARE: {
          keys: {
            DESCRIPTION: {
              keys: {
                System: {
                  values: [['SystemBiosVersion', 'REG_MULTI_SZ', `${device.manufacturer ?? 'OEM'} - 1072009\u0000${r.between(1, 3)}.${r.between(0, 30)}.0\u0000`]],
                  keys: {
                    BIOS: { values: [['BaseBoardManufacturer', 'REG_SZ', device.manufacturer ?? ''], ['SystemProductName', 'REG_SZ', device.model ?? ''], ['BIOSVersion', 'REG_SZ', `${r.between(1, 3)}.${r.between(0, 30)}.0`]] },
                    CentralProcessor: { keys: { '0': { values: [['ProcessorNameString', 'REG_SZ', device.model?.includes('Precision') ? 'Intel(R) Core(TM) i9-14900K' : 'Intel(R) Core(TM) i7-14700'], ['~MHz', 'REG_DWORD', String(r.between(2100, 3600))], ['Identifier', 'REG_SZ', 'Intel64 Family 6 Model 183 Stepping 1']] } } },
                  },
                },
              },
            },
          },
        },
        SAM: { denied: true },
        SECURITY: { denied: true },
        SOFTWARE: {
          keys: {
            Classes: { keys: { '.txt': { values: [['(Default)', 'REG_SZ', 'txtfile'], ['Content Type', 'REG_SZ', 'text/plain']] } } },
            Clients: { keys: { StartMenuInternet: { keys: { 'Microsoft Edge': { values: [['(Default)', 'REG_SZ', 'Microsoft Edge']] } } } } },
            Microsoft: {
              keys: {
                Windows: {
                  keys: {
                    CurrentVersion: {
                      values: [
                        ['ProgramFilesDir', 'REG_SZ', 'C:\\Program Files'],
                        ['CommonFilesDir', 'REG_SZ', 'C:\\Program Files\\Common Files'],
                        ['ProgramFilesPath', 'REG_EXPAND_SZ', '%ProgramFiles%'],
                        ['MediaPathUnexpanded', 'REG_EXPAND_SZ', '%SystemRoot%\\Media'],
                      ],
                      keys: {
                        Run: {
                          values: [
                            ['SecurityHealth', 'REG_EXPAND_SZ', '%windir%\\system32\\SecurityHealthSystray.exe'],
                            ['OneDrive', 'REG_SZ', '"C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe" /background'],
                          ],
                        },
                        RunOnce: { values: [] },
                        Uninstall: { keys: { RustRMM: { values: [['DisplayName', 'REG_SZ', 'RustRMM Agent'], ['DisplayVersion', 'REG_SZ', device.agent_version], ['Publisher', 'REG_SZ', 'RustRMM'], ['EstimatedSize', 'REG_DWORD', '18432']] } } },
                        Policies: { keys: { System: { values: [['EnableLUA', 'REG_DWORD', '1'], ['ConsentPromptBehaviorAdmin', 'REG_DWORD', '5'], ['legalnoticecaption', 'REG_SZ', '']] } } },
                      },
                    },
                  },
                },
                'Windows NT': {
                  keys: {
                    CurrentVersion: {
                      values: [
                        ['ProductName', 'REG_SZ', productName],
                        ['DisplayVersion', 'REG_SZ', build >= '26100' ? '24H2' : '22H2'],
                        ['CurrentBuild', 'REG_SZ', build],
                        ['CurrentBuildNumber', 'REG_SZ', build],
                        ['UBR', 'REG_DWORD', String(r.between(4000, 6999))],
                        ['EditionID', 'REG_SZ', device.os_name.includes('Enterprise') ? 'Enterprise' : device.os_name.includes('Server') ? 'ServerStandard' : 'Professional'],
                        ['InstallationType', 'REG_SZ', isServer(device) ? 'Server' : 'Client'],
                        ['InstallDate', 'REG_DWORD', String(Math.floor(Date.parse(device.enrolled_at) / 1000) - 86_400 * 30)],
                        ['RegisteredOwner', 'REG_SZ', device.client_name],
                        ['RegisteredOrganization', 'REG_SZ', device.client_name],
                        ['SystemRoot', 'REG_SZ', 'C:\\WINDOWS'],
                        ['DigitalProductId', 'REG_BINARY', digitalId.slice(0, 512)],
                      ],
                      keys: { Winlogon: { values: [['Shell', 'REG_SZ', 'explorer.exe'], ['Userinit', 'REG_SZ', 'C:\\Windows\\system32\\userinit.exe,'], ['AutoAdminLogon', 'REG_SZ', device.tags.includes('kiosk') ? '1' : '0']] } },
                    },
                  },
                },
                'Windows Defender': { values: [['ProductStatus', 'REG_DWORD', device.sim.avEnabled ? '0' : '1'], ['InstallLocation', 'REG_SZ', 'C:\\ProgramData\\Microsoft\\Windows Defender\\Platform\\4.18.25090.3009-0\\']] },
              },
            },
            Policies: { keys: { Microsoft: { keys: { Windows: { keys: { WindowsUpdate: { values: [['WUServer', 'REG_SZ', ''], ['DisableWindowsUpdateAccess', 'REG_DWORD', '0']] } } } } } } },
            RustRMM: {
              keys: {
                Agent: {
                  values: [
                    ['Version', 'REG_SZ', device.agent_version],
                    ['InstallDir', 'REG_SZ', 'C:\\Program Files\\RustRMM'],
                    ['DataDir', 'REG_SZ', 'C:\\ProgramData\\RustRMM'],
                    ['DeviceId', 'REG_SZ', device.id],
                    ['ShellPolicy', 'REG_DWORD', device.hostname === 'MCU-DC01' ? '0' : '1'],
                  ],
                },
              },
            },
            WOW6432Node: { keys: { Microsoft: { keys: {} } } },
          },
        },
        SYSTEM: {
          keys: {
            CurrentControlSet: {
              keys: {
                Control: {
                  keys: {
                    ComputerName: { keys: { ComputerName: { values: [['ComputerName', 'REG_SZ', device.hostname]] }, ActiveComputerName: { values: [['ComputerName', 'REG_SZ', device.hostname]] } } },
                    'Session Manager': {
                      keys: {
                        Environment: { values: [['Path', 'REG_EXPAND_SZ', '%SystemRoot%\\system32;%SystemRoot%;%SystemRoot%\\System32\\Wbem;%SYSTEMROOT%\\System32\\WindowsPowerShell\\v1.0\\'], ['NUMBER_OF_PROCESSORS', 'REG_SZ', String(r.pick([8, 12, 16, 20]))], ['OS', 'REG_SZ', 'Windows_NT'], ['TEMP', 'REG_EXPAND_SZ', '%SystemRoot%\\TEMP']] },
                        'Memory Management': { values: [['PagingFiles', 'REG_MULTI_SZ', '?:\\pagefile.sys\u0000'], ['ClearPageFileAtShutdown', 'REG_DWORD', '0']] },
                      },
                    },
                    TimeZoneInformation: { values: [['TimeZoneKeyName', 'REG_SZ', 'Pacific Standard Time'], ['Bias', 'REG_DWORD', '480']] },
                  },
                },
                Services: { keys: services },
              },
            },
            Select: { values: [['Current', 'REG_DWORD', '1'], ['Default', 'REG_DWORD', '1'], ['LastKnownGood', 'REG_DWORD', '1']] },
          },
        },
      },
    },
    HKU: {
      keys: {
        '.DEFAULT': { keys: { 'Control Panel': { keys: { Desktop: { values: [['ScreenSaveActive', 'REG_SZ', '1']] } } } } },
        'S-1-5-18': { keys: { Software: { keys: {} } } },
        'S-1-5-19': { denied: true },
        [sid]: {
          keys: {
            Environment: { values: [['TEMP', 'REG_EXPAND_SZ', '%USERPROFILE%\\AppData\\Local\\Temp'], ['TMP', 'REG_EXPAND_SZ', '%USERPROFILE%\\AppData\\Local\\Temp']] },
            'Control Panel': { keys: { Desktop: { values: [['Wallpaper', 'REG_SZ', 'C:\\Windows\\web\\wallpaper\\Windows\\img0.jpg'], ['WallpaperStyle', 'REG_SZ', '10']] } } },
            Software: { keys: { Microsoft: { keys: { Office: { keys: { '16.0': { keys: { Outlook: { values: [['DefaultProfile', 'REG_SZ', 'Outlook']] } } } } } } } } },
            Volatile: { values: [['USERNAME', 'REG_SZ', userShort(device)], ['USERDOMAIN', 'REG_SZ', device.domain?.split('.')[0].toUpperCase() ?? device.hostname]] },
          },
        },
      },
    },
    HKCR: {
      keys: {
        '.pdf': { values: [['(Default)', 'REG_SZ', 'AcroExch.Document.DC'], ['Content Type', 'REG_SZ', 'application/pdf']] },
        '.txt': { values: [['(Default)', 'REG_SZ', 'txtfile'], ['PerceivedType', 'REG_SZ', 'text']] },
        txtfile: { values: [['(Default)', 'REG_SZ', 'Text Document'], ['EditFlags', 'REG_DWORD', '2162688']] },
        CLSID: { keys: { '{20D04FE0-3AEA-1069-A2D8-08002B30309D}': { values: [['(Default)', 'REG_SZ', 'This PC'], ['InfoTip', 'REG_EXPAND_SZ', '@%SystemRoot%\\system32\\shell32.dll,-22913']] } } },
      },
    },
    HKCC: {
      keys: {
        Software: { keys: { Fonts: { values: [['LogPixels', 'REG_DWORD', '96']] } } },
        System: { keys: { CurrentControlSet: { keys: { Control: { keys: { Print: { keys: { Printers: { values: [] } } } } } } } } },
      },
    },
  }
}

const registryCache = new Map<string, Record<string, RegNode>>()

export function registryFor(device: MockDevice, path: string): RegistryListing {
  let tree = registryCache.get(device.id)
  if (!tree) {
    tree = registryTree(device)
    registryCache.set(device.id, tree)
  }
  if (!path) {
    return { path: '', keys: Object.keys(tree).map((name) => ({ name, path: name })), values: [] }
  }
  const parts = path.split('\\').filter(Boolean)
  let node: RegNode | undefined = { keys: tree }
  let realPath = ''
  for (const part of parts) {
    const entry: [string, RegNode] | undefined = Object.entries(node?.keys ?? {}).find(([name]) => name.toLowerCase() === part.toLowerCase())
    if (!entry) throw new AgentError('The system cannot find the file specified. (os error 2)')
    realPath = realPath ? `${realPath}\\${entry[0]}` : entry[0]
    node = entry[1]
    if (node.denied) throw new AgentError('Access is denied. (os error 5)')
  }
  const values = (node?.values ?? []).map(([name, type, data]) => ({ name, type, data }))
  if (!values.some((value) => value.name === '(Default)')) values.unshift({ name: '(Default)', type: 'REG_SZ', data: '' })
  return {
    path: realPath,
    keys: Object.keys(node?.keys ?? {})
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      .map((name) => ({ name, path: `${realPath}\\${name}` })),
    values,
  }
}

// ------------------------------------------------------------------ file system

export interface FsNode {
  name: string
  dir: boolean
  size: number
  modified: number
  hidden?: boolean
  readonly?: boolean
  link?: boolean
  children?: Map<string, FsNode>
  content?: Blob | string
  /** Generated lazily for very large folders. */
  bulk?: number
}

function dir(name: string, modified: number, children: FsNode[] = [], extra: Partial<FsNode> = {}): FsNode {
  return { name, dir: true, size: 0, modified, children: new Map(children.map((child) => [child.name.toLowerCase(), child])), ...extra }
}

function file(name: string, size: number, modified: number, extra: Partial<FsNode> = {}): FsNode {
  return { name, dir: false, size, modified, ...extra }
}

function windowsFs(device: MockDevice): Map<string, FsNode> {
  const r = rng(device.seed ^ 0xf11e)
  const now = Date.now()
  const ago = (days: number) => now - days * DAY - r.between(0, 86_000_000)
  const user = userShort(device)
  const docs: Record<string, string[]> = {
    dental: ['Patient Schedule - Week 47.xlsx', 'Insurance Claims Q3.pdf', 'Hygiene Recall List.docx'],
    legal: ['Engagement Letter - Pine Estate.docx', 'Discovery Index 2026.xlsx', 'Deposition Notes.pdf'],
    freight: ['Load Board Export.csv', 'Driver Settlements Nov.xlsx', 'Fuel Surcharge Table.pdf'],
    bakery: ['Holiday Orders.xlsx', 'Supplier Invoices.pdf'],
    vet: ['Vaccination Reminders.xlsx', 'Lab Results - Bella.pdf'],
    architecture: ['Harbor Pavilion - Concept.pdf', 'Site Survey.dwg', 'Fee Proposal v3.docx'],
    banking: ['Teller Balancing Nov.xlsx', 'Compliance Checklist.docx', 'BSA Training.pdf'],
    schools: ['Board Minutes Oct.docx', 'Grant Budget 2027.xlsx'],
  }
  const userDocs = (docs[device.sim.industry] ?? []).map((name) => file(name, r.between(40, 9000) * 1024, ago(r.between(0, 40))))
  const home = dir(user, ago(200), [
    dir('Desktop', ago(1), [file('Remote Support.url', 214, ago(80)), file('Line of Business.lnk', 1_420, ago(150)), ...userDocs.slice(0, 1)]),
    dir('Documents', ago(2), [...userDocs, dir('Scans', ago(5), [file('scan_20261114_0912.pdf', 812_000, ago(3)), file('scan_20261110_1530.pdf', 1_240_000, ago(7))])]),
    dir('Downloads', ago(0), [
      file('ChromeSetup.exe', 10_592_000, ago(20)),
      file('invoice_88213.pdf', 184_000, ago(1)),
      file('TeamViewerQS_x64.exe', 34_800_000, ago(60)),
      file('Q4 planning.pptx', 6_120_000, ago(4)),
    ]),
    dir('Pictures', ago(30), [dir('Screenshots', ago(2), [file('Screenshot 2026-11-15 101233.png', 412_000, ago(2))])]),
    dir('AppData', ago(1), [dir('Local', ago(0), [dir('Temp', ago(0), [file('~DF3A21.tmp', 16_384, ago(0))])]), dir('Roaming', ago(3))], { hidden: true }),
    file('NTUSER.DAT', 3_407_872, ago(0), { hidden: true }),
    file('ntuser.ini', 20, ago(200), { hidden: true }),
  ])
  const c = dir('C:', ago(400), [
    dir('$Recycle.Bin', ago(3), [], { hidden: true }),
    dir('PerfLogs', ago(400)),
    dir('Program Files', ago(5), [
      dir('Common Files', ago(40)),
      dir('Microsoft Office', ago(30), [dir('root', ago(30), [dir('Office16', ago(30), [file('OUTLOOK.EXE', 41_200_000, ago(30), { readonly: true }), file('WINWORD.EXE', 2_100_000, ago(30), { readonly: true })])])]),
      dir('RustRMM', ago(20), [file('rustrmm-agent.exe', 14_811_136, ago(20)), file('LICENSE.txt', 11_357, ago(20))]),
      dir('Windows Defender', ago(100)),
      dir('WindowsApps', ago(2), [], { hidden: true }),
    ]),
    dir('Program Files (x86)', ago(10), [dir('Microsoft', ago(10), [dir('Edge', ago(5))]), dir('Common Files', ago(60))]),
    dir('ProgramData', ago(1), [dir('Microsoft', ago(1)), dir('RustRMM', ago(0), [dir('logs', ago(0), [file('agent.log', 2_480_112, ago(0)), file('agent.log.1', 10_485_760, ago(3))]), file('agent.toml', 812, ago(20))])], { hidden: true }),
    dir('Users', ago(200), [dir('Public', ago(200), [dir('Documents', ago(100)), dir('Downloads', ago(20))]), dir('Default', ago(400), [], { hidden: true }), file('desktop.ini', 174, ago(400), { hidden: true, readonly: true }), home]),
    dir('Windows', ago(2), [
      dir('System32', ago(1), [dir('drivers', ago(10), [dir('etc', ago(40), [file('hosts', 824, ago(40)), file('services', 17_635, ago(400))])]), file('cmd.exe', 323_584, ago(30), { readonly: true }), file('notepad.exe', 360_448, ago(30), { readonly: true })]),
      dir('Temp', ago(0), [file('MpCmdRun.log', 182_340, ago(0)), file('rustrmm-update.tmp', 0, ago(1))]),
      dir('WinSxS', ago(2), [], { bulk: 5200 }),
      dir('Logs', ago(1), [dir('CBS', ago(1), [file('CBS.log', 18_340_112, ago(1))])]),
      file('explorer.exe', 5_640_480, ago(30), { readonly: true }),
    ]),
    file('pagefile.sys', 8_589_934_592, ago(0), { hidden: true }),
    file('swapfile.sys', 268_435_456, ago(0), { hidden: true }),
    file('DumpStack.log.tmp', 12_288, ago(0), { hidden: true }),
  ])
  const roots = new Map<string, FsNode>([['c:', c]])
  if (isServer(device)) {
    roots.set(
      'd:',
      dir('D:', ago(300), [
        dir('Shares', ago(1), [dir('Clinic', ago(1), [dir('Forms', ago(20)), file('Phone List.xlsx', 48_000, ago(9))]), dir('Scans', ago(0))]),
        dir('Backups', ago(0), [file(`${device.hostname}-system-state.vhdx`, 21_474_836_480, ago(1)), file('backup.log', 92_340, ago(0))]),
        dir('System Volume Information', ago(1), [], { hidden: true }),
      ]),
    )
  }
  return roots
}

function posixFs(device: MockDevice): Map<string, FsNode> {
  const r = rng(device.seed ^ 0xf11e)
  const now = Date.now()
  const ago = (days: number) => now - days * DAY - r.between(0, 86_000_000)
  const mac = device.os_family === 'macos'
  const user = userShort(device)
  const etc = dir('etc', ago(3), [
    file('hostname', device.hostname.length + 1, ago(90), { content: `${device.hostname}\n` }),
    file('hosts', 221, ago(90), { content: `127.0.0.1 localhost\n127.0.1.1 ${device.hostname}\n\n# The following lines are desirable for IPv6 capable hosts\n::1     ip6-localhost ip6-loopback\n` }),
    file('os-release', 386, ago(40), { content: `PRETTY_NAME="${device.os_name}"\nNAME="${device.os_name.split(' ')[0]}"\nVERSION_ID="${device.os_version}"\n` }),
    file('fstab', 657, ago(200)),
    file('passwd', 2_871, ago(20)),
    file('shadow', 1_402, ago(20), { readonly: true }),
    dir('ssh', ago(60), [file('sshd_config', 3_282, ago(60)), file('ssh_host_ed25519_key.pub', 98, ago(200))]),
    dir('systemd', ago(10), [dir('system', ago(10))]),
    ...(device.tags.includes('wms') || device.tags.includes('core-banking') ? [dir('nginx', ago(12), [file('nginx.conf', 2_656, ago(12)), dir('conf.d', ago(12), [file('app.conf', 1_204, ago(12))])])] : []),
    dir('rustrmm', ago(20), [file('agent.toml', 640, ago(20))]),
  ])
  const varLog = dir('log', ago(0), [
    file(device.os_name.startsWith('Red Hat') ? 'messages' : 'syslog', 4_812_331, ago(0)),
    file(device.os_name.startsWith('Red Hat') ? 'secure' : 'auth.log', 1_022_004, ago(0)),
    file('kern.log', 312_400, ago(0)),
    dir('journal', ago(0), [], { hidden: false }),
    ...(device.tags.includes('wms') ? [dir('nginx', ago(0), [file('access.log', 82_440_120, ago(0)), file('error.log', 41_200, ago(0))])] : []),
  ])
  if (mac) {
    return new Map([
      [
        '/',
        dir('/', ago(300), [
          dir('Applications', ago(2), ['Safari.app', 'Slack.app', 'zoom.us.app', '1Password.app', 'Microsoft Word.app', ...(device.tags.includes('design') ? ['Figma.app', 'Adobe Photoshop 2026'] : [])].map((name) => dir(name, ago(r.between(1, 60))))),
          dir('Library', ago(3), [dir('Application Support', ago(1), [dir('RustRMM', ago(0), [file('rustrmm-agent', 13_240_112, ago(20)), dir('logs', ago(0), [file('agent.log', 1_302_441, ago(0))])])]), dir('LaunchDaemons', ago(20), [file('com.rustrmm.agent.plist', 812, ago(20))])]),
          dir('System', ago(30), [], { readonly: true }),
          dir('Users', ago(100), [
            dir('Shared', ago(40)),
            dir(user, ago(100), [
              dir('Desktop', ago(0), [file('Screenshot 2026-11-16 at 09.12.33.png', 1_840_221, ago(1))]),
              dir('Documents', ago(2), [file('Client brief.pages', 2_120_000, ago(9)), file('Invoices 2026.numbers', 840_000, ago(3))]),
              dir('Downloads', ago(0), [file('figma-agent.dmg', 48_222_100, ago(15)), file('statement-oct.pdf', 220_400, ago(6))]),
              dir('Library', ago(0), [], { hidden: true }),
              file('.zshrc', 412, ago(90), { hidden: true, content: 'export PATH="/opt/homebrew/bin:$PATH"\n' }),
              file('.DS_Store', 6_148, ago(0), { hidden: true }),
            ]),
          ]),
          dir('Volumes', ago(1), [dir('Macintosh HD', ago(1), [], { link: true })]),
          dir('private', ago(30), [dir('etc', ago(30), [file('hosts', 213, ago(200))]), dir('var', ago(0), [varLog])]),
          dir('tmp', ago(0), [], { link: true }),
          dir('usr', ago(30), [], { readonly: true }),
          dir('opt', ago(60), [dir('homebrew', ago(5))]),
          file('.file', 0, ago(300), { hidden: true }),
        ]),
      ],
    ])
  }
  return new Map([
    [
      '/',
      dir('/', ago(300), [
        dir('bin', ago(30), [], { link: true }),
        dir('boot', ago(12), [file(`vmlinuz-${device.os_version}`, 14_780_000, ago(12)), file('initrd.img', 72_440_000, ago(12))]),
        dir('dev', ago(0)),
        etc,
        dir('home', ago(60), [dir('deploy', ago(1), [file('.bashrc', 3_771, ago(200), { hidden: true }), dir('.ssh', ago(60), [file('authorized_keys', 742, ago(60))], { hidden: true }), dir('scripts', ago(9), [file('rotate-logs.sh', 1_204, ago(9)), file('db-backup.sh', 2_880, ago(30))]), file('notes.txt', 640, ago(5), { content: 'TODO: renew certs before Dec 1\n' })]), dir('backup', ago(4))]),
        dir('lib', ago(30), [], { link: true }),
        dir('opt', ago(20), [dir('rustrmm', ago(20), [dir('bin', ago(20), [file('rustrmm-agent', 12_904_112, ago(20))])])]),
        dir('proc', ago(0)),
        dir('root', ago(4), [file('.bash_history', 12_400, ago(0), { hidden: true })]),
        dir('srv', ago(100), device.tags.includes('imaging') ? [dir('orthanc', ago(0), [dir('db', ago(0), [], { bulk: 1200 })])] : []),
        dir('tmp', ago(0), [file('systemd-private-3f1a', 0, ago(1)), file('.X11-unix', 0, ago(3), { hidden: true })]),
        dir('usr', ago(10), [dir('bin', ago(3), [], { bulk: 900 }), dir('lib', ago(3)), dir('local', ago(40)), dir('share', ago(5))]),
        dir('var', ago(0), [dir('backups', ago(1)), dir('cache', ago(0)), dir('lib', ago(0)), varLog, dir('tmp', ago(0))]),
        file('swap.img', 4_294_967_296, ago(100), { hidden: false }),
      ]),
    ],
  ])
}

const fsState = new Map<string, Map<string, FsNode>>()

export function fsRoots(device: MockDevice): Map<string, FsNode> {
  let roots = fsState.get(device.id)
  if (!roots) {
    roots = device.os_family === 'windows' ? windowsFs(device) : posixFs(device)
    fsState.set(device.id, roots)
  }
  return roots
}

export function splitPath(device: MockDevice, path: string): { root: string; parts: string[] } | null {
  if (device.os_family === 'windows') {
    const match = /^([a-zA-Z]:)\\?(.*)$/.exec(path)
    if (!match) return null
    return { root: match[1].toLowerCase(), parts: match[2].split('\\').filter(Boolean) }
  }
  if (!path.startsWith('/')) return null
  return { root: '/', parts: path.split('/').filter(Boolean) }
}

export function findNode(device: MockDevice, path: string): FsNode | null {
  const split = splitPath(device, path)
  if (!split) return null
  let node = fsRoots(device).get(split.root) ?? null
  for (const part of split.parts) {
    if (!node?.dir) return null
    materialize(node)
    node = node.children?.get(part.toLowerCase()) ?? null
  }
  return node
}

/** The path with each segment spelled as stored (the agent returns canonical casing). */
export function canonicalPath(device: MockDevice, path: string): string {
  const split = splitPath(device, path)
  if (!split) return path
  let node = fsRoots(device).get(split.root) ?? null
  const names: string[] = []
  for (const part of split.parts) {
    const next: FsNode | null = node?.children?.get(part.toLowerCase()) ?? null
    names.push(next?.name ?? part)
    node = next
  }
  if (device.os_family === 'windows') return `${split.root.toUpperCase()}\\${names.join('\\')}`
  return `/${names.join('/')}`
}

/** Expands a "bulk" folder (WinSxS and friends) into real entries the first time it is opened. */
function materialize(node: FsNode) {
  if (!node.bulk || !node.children) return
  const r = rng(hashString(node.name))
  for (let index = 0; index < node.bulk; index += 1) {
    const name = `amd64_microsoft-windows-${r.pick(['servicingstack', 'shell32', 'ntdll', 'kernel32', 'wininet', 'mshtml', 'netfx4', 'printing'])}_31bf3856ad364e35_10.0.${r.between(19041, 26100)}.${r.between(1, 6999)}_none_${r.hex(16)}`
    node.children.set(name.toLowerCase(), r.chance(0.8) ? dir(name, node.modified - r.between(0, 200) * DAY) : file(`${name}.manifest`, r.between(800, 90_000), node.modified - r.between(0, 200) * DAY))
  }
  node.bulk = undefined
}

export function joinMockPath(device: MockDevice, dirPath: string, name: string): string {
  const sep = device.os_family === 'windows' ? '\\' : '/'
  return dirPath.endsWith(sep) ? `${dirPath}${name}` : `${dirPath}${sep}${name}`
}

export function parentOf(device: MockDevice, path: string): string | null {
  if (device.os_family === 'windows') {
    if (/^[a-zA-Z]:\\?$/.test(path)) return ''
    const trimmed = path.replace(/\\+$/, '')
    const index = trimmed.lastIndexOf('\\')
    const head = trimmed.slice(0, index)
    return /^[a-zA-Z]:$/.test(head) ? `${head}\\` : head
  }
  if (path === '/') return null
  const index = path.replace(/\/+$/, '').lastIndexOf('/')
  return index <= 0 ? '/' : path.slice(0, index)
}

export function toEntry(device: MockDevice, node: FsNode, path: string, drive = false): FileEntry {
  return {
    name: node.name,
    path,
    is_dir: node.dir,
    is_link: Boolean(node.link),
    size: node.dir ? null : node.size,
    modified: node.modified,
    readonly: Boolean(node.readonly),
    hidden: Boolean(node.hidden) || (device.os_family !== 'windows' && node.name.startsWith('.')),
    ...(drive ? { drive: true } : {}),
  }
}

export function listChildren(device: MockDevice, node: FsNode, path: string): FileEntry[] {
  materialize(node)
  return [...(node.children?.values() ?? [])]
    .map((child) => toEntry(device, child, joinMockPath(device, path, child.name)))
    .sort((a, b) => (a.is_dir === b.is_dir ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.is_dir ? -1 : 1))
}

/** Paths the agent refuses to modify: roots, the Windows folder and its own install/data folders. */
export function isProtectedPath(device: MockDevice, path: string): boolean {
  const lower = path.toLowerCase().replace(/[\\/]+$/, '')
  if (device.os_family === 'windows') {
    if (/^[a-z]:$/.test(lower)) return true
    return ['c:\\windows', 'c:\\program files\\rustrmm', 'c:\\programdata\\rustrmm'].some((protectedPath) => lower === protectedPath || lower.startsWith(`${protectedPath}\\`))
  }
  if (lower === '') return true
  return ['/opt/rustrmm', '/etc/rustrmm', '/library/application support/rustrmm', '/proc', '/dev'].some((protectedPath) => lower === protectedPath || lower.startsWith(`${protectedPath}/`))
}

/** Content for a download: real text for small config files, a deterministic filler otherwise. */
export function fileContent(node: FsNode, path: string): Blob {
  if (node.content instanceof Blob) return node.content
  if (typeof node.content === 'string') return new Blob([node.content], { type: 'text/plain' })
  const size = Math.min(node.size, 512 * 1024)
  const header = `RustRMM mock file\npath: ${path}\nreported size: ${node.size} bytes\n\n`
  const filler = 'The quick brown fox jumps over the lazy dog. '
  let text = header
  while (text.length < size) text += filler
  return new Blob([text.slice(0, Math.max(header.length, size))], { type: 'application/octet-stream' })
}

// ------------------------------------------------------------------ diagnostics

function hashIp(target: string, v6 = false): string {
  const h = hashString(target)
  if (v6) return `2606:4700:${(h & 0xffff).toString(16)}::${((h >>> 16) & 0xffff).toString(16)}`
  return `${104 + (h % 80)}.${(h >>> 8) & 255}.${(h >>> 16) & 255}.${Math.max(1, (h >>> 24) & 254)}`
}

function resolveTarget(device: MockDevice, target: string): string[] | null {
  const lower = target.toLowerCase()
  if (/^(\d+\.){3}\d+$/.test(target) || target.includes(':')) return [target]
  if (lower === 'localhost') return ['127.0.0.1', '::1']
  if (lower.endsWith('.invalid') || lower.includes('nonexistent') || lower.endsWith('.test')) return null
  if (lower === device.hostname.toLowerCase() || (device.domain && lower.endsWith(device.domain))) return [device.last_ip ?? '10.0.0.10']
  if (!lower.includes('.')) {
    // Single-label names resolve on the LAN when they look like a local host.
    return hashString(lower) % 3 === 0 ? null : [`${(device.last_ip ?? '10.0.0.10').split('.').slice(0, 3).join('.')}.${(hashString(lower) % 200) + 20}`]
  }
  return [hashIp(lower), hashIp(lower, true)]
}

function isPrivate(ip: string) {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(ip)
}

export function runDiagnostic(device: MockDevice, kind: string, target: string, port?: number): { delay: number; result: CommandDiagnostic | DnsDiagnostic | PortDiagnostic } {
  const r = rng(hashString(`${target}:${Math.floor(Date.now() / 10_000)}`))
  const windows = device.os_family === 'windows'
  const addresses = resolveTarget(device, target)
  const ip = addresses?.[0] ?? null
  const unreachable = ip !== null && (ip === '10.255.255.1' || ip.startsWith('192.0.2.'))
  const baseRtt = ip === null ? 0 : isPrivate(ip) ? r.between(1, 4) : r.between(9, 38)

  if (kind === 'dns') {
    const duration = r.between(4, 60)
    if (!addresses) {
      return { delay: 400, result: { resolved: false, addresses: [], duration_ms: duration, error: windows ? 'No such host is known. (os error 11001)' : 'failed to lookup address information: Name or service not known' } }
    }
    return { delay: 300 + duration, result: { resolved: true, addresses, duration_ms: duration } }
  }

  if (kind === 'port') {
    const p = port ?? 443
    if (!addresses) return { delay: 500, result: { open: false, address: null, latency_ms: null, error: windows ? 'No such host is known. (os error 11001)' : 'failed to lookup address information: Name or service not known' } }
    const likelyOpen = [80, 443, 53, 25, 587, 993, 8443].includes(p) ? !isPrivate(ip!) || p === 53 : isPrivate(ip!) && [22, 445, 3389, 5432, 9100].includes(p)
    const open = !unreachable && likelyOpen && hashString(`${target}:${p}`) % 5 !== 0
    const address = `${ip!.includes(':') ? `[${ip}]` : ip}:${p}`
    if (open) return { delay: 300 + baseRtt * 3, result: { open: true, address, latency_ms: baseRtt + r.between(0, 6), error: null } }
    const refused = !unreachable && hashString(`${target}:${p}`) % 2 === 0
    return {
      delay: refused ? 400 : 3200,
      result: {
        open: false,
        address,
        latency_ms: null,
        error: refused ? (windows ? 'No connection could be made because the target machine actively refused it. (os error 10061)' : 'Connection refused (os error 111)') : 'connection timed out after 3s',
      },
    }
  }

  if (kind === 'ping') {
    const command = windows ? `ping -n 4 -w 2000 ${target}` : device.os_family === 'macos' ? `ping -c 4 -t 10 ${target}` : `ping -c 4 -W 2 ${target}`
    if (!addresses) {
      const output = windows ? `Ping request could not find host ${target}. Please check the name and try again.\r\n` : `ping: ${target}: Name or service not known\n`
      return { delay: 600, result: { command, exit_code: windows ? 1 : 2, timed_out: false, duration_ms: 540, output } }
    }
    const rtts = Array.from({ length: 4 }, () => baseRtt + r.between(0, Math.max(2, Math.round(baseRtt / 3))))
    if (windows) {
      const lines = [`Pinging ${target === ip ? ip : `${target} [${ip}]`} with 32 bytes of data:`]
      for (const rtt of rtts) lines.push(unreachable ? 'Request timed out.' : `Reply from ${ip}: bytes=32 time${rtt < 1 ? '<1' : `=${rtt}`}ms TTL=${isPrivate(ip!) ? 128 : 56}`)
      lines.push('', `Ping statistics for ${ip}:`, `    Packets: Sent = 4, Received = ${unreachable ? 0 : 4}, Lost = ${unreachable ? 4 : 0} (${unreachable ? 100 : 0}% loss),`)
      if (!unreachable) lines.push('Approximate round trip times in milli-seconds:', `    Minimum = ${Math.min(...rtts)}ms, Maximum = ${Math.max(...rtts)}ms, Average = ${Math.round(rtts.reduce((a, b) => a + b, 0) / 4)}ms`)
      return { delay: unreachable ? 8200 : 3100, result: { command, exit_code: unreachable ? 1 : 0, timed_out: false, duration_ms: unreachable ? 8012 : 3046, output: `${lines.join('\r\n')}\r\n` } }
    }
    const lines = [`PING ${target} (${ip}) 56(84) bytes of data.`]
    rtts.forEach((rtt, index) => !unreachable && lines.push(`64 bytes from ${ip}: icmp_seq=${index + 1} ttl=${isPrivate(ip!) ? 64 : 55} time=${(rtt + r.next()).toFixed(1)} ms`))
    lines.push('', `--- ${target} ping statistics ---`, `4 packets transmitted, ${unreachable ? 0 : 4} received, ${unreachable ? 100 : 0}% packet loss, time 3004ms`)
    if (!unreachable) lines.push(`rtt min/avg/max/mdev = ${Math.min(...rtts).toFixed(3)}/${(rtts.reduce((a, b) => a + b, 0) / 4).toFixed(3)}/${Math.max(...rtts).toFixed(3)}/0.412 ms`)
    return { delay: unreachable ? 5200 : 3100, result: { command, exit_code: unreachable ? 1 : 0, timed_out: false, duration_ms: unreachable ? 5003 : 3008, output: `${lines.join('\n')}\n` } }
  }

  // traceroute
  const command = windows ? `tracert -d -h 30 -w 1000 ${target}` : `traceroute -n -m 30 -w 2 ${target}`
  if (!addresses) {
    const output = windows ? `Unable to resolve target system name ${target}.\r\n` : `${target}: Name or service not known\nCannot handle "host" cmdline arg \`${target}' on position 1 (argc 4)\n`
    return { delay: 700, result: { command, exit_code: windows ? 1 : 2, timed_out: false, duration_ms: 640, output } }
  }
  const gateway = `${(device.last_ip ?? '10.0.0.10').split('.').slice(0, 3).join('.')}.1`
  const hops: string[] = [gateway]
  if (!isPrivate(ip!)) {
    const count = r.between(5, 9)
    for (let index = 0; index < count; index += 1) hops.push(index === 0 ? `100.${r.between(64, 127)}.${r.between(0, 255)}.1` : `${r.pick([68, 96, 152, 4, 62])}.${r.between(0, 255)}.${r.between(0, 255)}.${r.between(1, 254)}`)
  }
  if (!unreachable) hops.push(ip!)
  const lines: string[] = windows ? [`Tracing route to ${target === ip ? ip : `${target} [${ip}]`}`, 'over a maximum of 30 hops:', ''] : [`traceroute to ${target} (${ip}), 30 hops max, 60 byte packets`]
  hops.forEach((hop, index) => {
    const rtt = Math.max(1, Math.round(((index + 1) / hops.length) * (baseRtt || 2)))
    const times = [rtt, rtt + r.between(0, 2), rtt + r.between(0, 3)]
    if (windows) lines.push(`  ${String(index + 1).padStart(2)}    ${times.map((t) => `${t < 1 ? '<1' : t} ms`.padStart(6)).join('  ')}  ${hop}`)
    else lines.push(`${String(index + 1).padStart(2)}  ${hop}  ${times.map((t) => `${(t + r.next()).toFixed(3)} ms`).join('  ')}`)
  })
  if (unreachable) {
    for (let index = hops.length; index < hops.length + 8; index += 1) lines.push(windows ? `  ${String(index + 1).padStart(2)}     *        *        *     Request timed out.` : `${String(index + 1).padStart(2)}  * * *`)
  }
  if (windows) lines.push('', 'Trace complete.')
  const duration = unreachable ? 24_800 : 2400 + hops.length * 700
  return { delay: Math.min(duration, 9000), result: { command, exit_code: 0, timed_out: false, duration_ms: duration, output: `${lines.join(windows ? '\r\n' : '\n')}${windows ? '\r\n' : '\n'}` } }
}

// ------------------------------------------------------------------ recordings

/** Builds an asciicast v2 document from scripted steps: output, typed input, pauses and resizes. */
class CastBuilder {
  private lines: string[] = []
  private t = 0
  constructor(width: number, height: number, timestamp: number, title: string, shell: string) {
    this.lines.push(JSON.stringify({ version: 2, width, height, timestamp, title, env: { SHELL: shell, TERM: 'xterm-256color' } }))
  }
  out(text: string, after = 0.05) {
    this.t += after
    this.lines.push(JSON.stringify([Number(this.t.toFixed(6)), 'o', text]))
    return this
  }
  type(text: string, r: ReturnType<typeof rng>) {
    for (const char of text) this.out(char, r.float(0.05, 0.19))
    return this.out('\r\n', r.float(0.2, 0.5))
  }
  wait(seconds: number) {
    this.t += seconds
    return this
  }
  resize(cols: number, rows: number) {
    this.t += 0.05
    this.lines.push(JSON.stringify([Number(this.t.toFixed(6)), 'r', `${cols}x${rows}`]))
    return this
  }
  toString() {
    return `${this.lines.join('\n')}\n`
  }
}

export function scriptedRecording(session: MockRemoteSession, device: MockDevice | undefined): string {
  const r = rng(hashString(session.id))
  const shell = session.detail?.shell ?? 'powershell'
  const cols = session.detail?.cols ?? 120
  const rows = session.detail?.rows ?? 32
  const host = session.hostname
  const cast = new CastBuilder(cols, rows, Math.floor(Date.parse(session.connected_at ?? session.started_at) / 1000), `${shell} on ${host}`, shell)
  if (shell === 'powershell' || shell === 'pwsh') {
    const prompt = 'PS C:\\Windows\\system32> '
    cast
      .out(shell === 'pwsh' ? 'PowerShell 7.5.4\r\n' : 'Windows PowerShell\r\nCopyright (C) Microsoft Corporation. All rights reserved.\r\n\r\nInstall the latest PowerShell for new features and improvements! https://aka.ms/PSWindows\r\n\r\n', 0.3)
      .out(prompt, 0.2)
      .wait(1.4)
      .type('Get-Service Spooler', r)
      .out('\r\nStatus   Name               DisplayName\r\n------   ----               -----------\r\n\x1b[32mRunning\x1b[0m  Spooler            Print Spooler\r\n\r\n', 0.3)
      .out(prompt, 0.05)
      .wait(9.5)
      .type('Restart-Service Spooler -Force', r)
      .out("\x1b[33mWARNING: Waiting for service 'Print Spooler (Spooler)' to start...\x1b[0m\r\n", 1.1)
      .out(prompt, 1.4)
      .resize(cols + 20, rows + 4)
      .wait(2)
      .type('Get-WinEvent -LogName System -MaxEvents 3 | Format-Table TimeCreated, Id, ProviderName -AutoSize', r)
      .out(
        '\r\nTimeCreated            Id ProviderName\r\n-----------            -- ------------\r\n11/17/2026 9:41:12 AM 7036 Service Control Manager\r\n11/17/2026 9:41:10 AM 7036 Service Control Manager\r\n11/17/2026 9:12:03 AM   16 Microsoft-Windows-Kernel-General\r\n\r\n',
        0.8,
      )
      .out(prompt, 0.05)
      .wait(3)
      .type('Get-PSDrive C | Select-Object Used, Free', r)
      .out(`\r\n        Used         Free\r\n        ----         ----\r\n${String(r.between(80, 300) * 1_073_741_824).padStart(12)} ${String(r.between(40, 300) * 1_073_741_824).padStart(12)}\r\n\r\n`, 0.6)
      .out(prompt, 0.05)
      .wait(1.5)
      .type('exit', r)
    return cast.toString()
  }
  const mac = device?.os_family === 'macos'
  const prompt = mac ? `${host}:~ root# ` : `\x1b[01;31mroot@${host}\x1b[00m:\x1b[01;34m~\x1b[00m# `
  cast
    .out(mac ? `Last login: ${new Date(Date.parse(session.started_at) - DAY).toDateString()} on ttys000\r\n` : `Welcome to ${device?.os_name ?? 'Linux'}\r\n\r\n`, 0.3)
    .out(prompt, 0.2)
    .wait(1.2)
  if (mac) {
    cast
      .type('sw_vers', r)
      .out(`ProductName:\t\tmacOS\r\nProductVersion:\t\t${device?.os_version ?? '15.7.2'}\r\nBuildVersion:\t\t25B78\r\n`, 0.2)
      .out(prompt, 0.05)
      .wait(7.5)
      .type('top -l 1 -o cpu -n 5 | tail -6', r)
      .out('PID    COMMAND          %CPU TIME     #TH  MEM\r\n412    WindowServer     12.1 31:02.44 23   612M\r\n0      kernel_task      6.4  58:11.21 512  12M\r\n1902   Figma Helper     4.2  12:40.10 18   940M\r\n733    mds_stores       1.9  02:11.92 7    160M\r\n88     logd             0.6  01:02.31 5    18M\r\n', 1.2)
      .out(prompt, 0.05)
  } else {
    const unit = device?.tags.includes('wms') ? 'nginx' : 'ssh'
    cast
      .type(`systemctl status ${unit} --no-pager`, r)
      .out(`\x1b[0;1;32m●\x1b[0m ${unit}.service - ${unit === 'nginx' ? 'The nginx HTTP and reverse proxy server' : 'OpenBSD Secure Shell server'}\r\n     Loaded: loaded (/usr/lib/systemd/system/${unit}.service; \x1b[0;1;32menabled\x1b[0m; preset: \x1b[0;1;32menabled\x1b[0m)\r\n     Active: \x1b[0;1;32mactive (running)\x1b[0m since Mon 2026-11-10 06:02:11 UTC; 1 week 0 days ago\r\n   Main PID: 912 (${unit === 'nginx' ? 'nginx' : 'sshd'})\r\n      Tasks: ${unit === 'nginx' ? 5 : 1} (limit: 18902)\r\n     Memory: ${unit === 'nginx' ? '24.1M' : '6.2M'}\r\n`, 0.4)
      .out(prompt, 0.05)
      .wait(11)
      .type('df -h /', r)
      .out(`Filesystem      Size  Used Avail Use% Mounted on\r\n/dev/sda1       ${r.between(200, 900)}G  ${r.between(80, 400)}G  ${r.between(40, 300)}G  ${device?.disk_pct ? Math.round(device.disk_pct) : 54}% /\r\n`, 0.15)
      .out(prompt, 0.05)
      .resize(cols + 12, rows)
      .wait(2.5)
      .type('journalctl -p warning -n 3 --no-pager', r)
      .out(`Nov 17 08:12:40 ${host} sshd[20112]: Invalid user oracle from 185.220.101.4 port 51122\r\nNov 17 08:41:02 ${host} kernel: [UFW BLOCK] IN=eth0 OUT= SRC=45.148.10.12 DST=10.60.1.20 PROTO=TCP DPT=23\r\nNov 17 09:02:11 ${host} systemd[1]: certbot-renew.service: Failed with result 'exit-code'.\r\n`, 0.6)
      .out(prompt, 0.05)
  }
  cast.wait(1.8).type('exit', r).out('logout\r\n', 0.1)
  return cast.toString()
}

// ------------------------------------------------------------------ session history

export function seedSessionsFor(device: MockDevice, users: string[], now = Date.now()): MockRemoteSession[] {
  const r = rng(device.seed ^ 0x5e55)
  const sessions: MockRemoteSession[] = []
  const count = r.between(4, 8)
  const shell = device.os_family === 'windows' ? 'powershell' : device.os_family === 'macos' ? 'zsh' : 'bash'
  const home = device.os_family === 'windows' ? `C:\\Users\\${userShort(device)}` : device.os_family === 'macos' ? `/Users/${userShort(device)}` : '/home/deploy'
  const sep = device.os_family === 'windows' ? '\\' : '/'
  for (let index = 0; index < count; index += 1) {
    const started = now - r.between(1, 28) * DAY - r.between(0, 20) * 3_600_000
    const kind = r.pick(['shell', 'shell', 'shell', 'download', 'upload'] as const)
    const id = `${r.hex(8)}-${r.hex(4)}-7${r.hex(3)}-a${r.hex(3)}-${r.hex(12)}`
    const user = r.pick(users)
    if (kind === 'shell') {
      const seconds = r.between(40, 1500)
      const reason = r.pick(['Closed by operator', 'Shell exited (code 0)', 'Shell exited (code 0)', 'No input for 30 minutes', 'Ended by an administrator'])
      sessions.push({
        id,
        device_id: device.id,
        hostname: device.hostname,
        user_name: user,
        kind,
        detail: { shell: device.os_family === 'windows' && r.chance(0.2) ? 'pwsh' : shell, cols: r.pick([120, 132, 160]), rows: r.pick([32, 36, 40]) },
        started_at: new Date(started).toISOString(),
        connected_at: new Date(started + r.between(900, 2400)).toISOString(),
        ended_at: new Date(started + seconds * 1000 + (reason === 'No input for 30 minutes' ? 30 * MINUTE : 0)).toISOString(),
        end_reason: reason,
        bytes_to_device: r.between(200, 4000),
        bytes_from_device: r.between(8_000, 220_000),
        has_recording: true,
        recording_bytes: r.between(6_000, 90_000),
        live: false,
        script: shell,
      })
    } else {
      const name = kind === 'download' ? r.pick(['agent.log', 'CBS.log', 'syslog', 'Insurance Claims Q3.pdf', 'backup.log']) : r.pick(['fix-printer.ps1', 'Install-Agent.msi', 'hosts', 'config-backup.zip'])
      const bytes = r.between(4_000, 40_000_000)
      sessions.push({
        id,
        device_id: device.id,
        hostname: device.hostname,
        user_name: user,
        kind,
        detail: { path: `${home}${sep}${kind === 'download' ? '' : `Downloads${sep}`}${name}` },
        started_at: new Date(started).toISOString(),
        connected_at: new Date(started + r.between(300, 900)).toISOString(),
        ended_at: new Date(started + 1000 + bytes / 2_000_000 * 1000).toISOString(),
        end_reason: r.chance(0.9) ? 'Completed' : 'Cancelled by operator',
        bytes_to_device: kind === 'upload' ? bytes : 0,
        bytes_from_device: kind === 'download' ? bytes : 0,
        has_recording: false,
        recording_bytes: null,
        live: false,
      })
    }
  }
  // A colleague's live shell on one server, so the "End session" flow has something to end.
  if (device.hostname === 'NWD-DC01' && device.online) {
    const started = now - 14 * MINUTE
    sessions.push({
      id: `${r.hex(8)}-${r.hex(4)}-7${r.hex(3)}-a${r.hex(3)}-${r.hex(12)}`,
      device_id: device.id,
      hostname: device.hostname,
      user_name: 'Sam Rivera',
      kind: 'shell',
      detail: { shell: 'powershell', cols: 132, rows: 36 },
      started_at: new Date(started).toISOString(),
      connected_at: new Date(started + 1400).toISOString(),
      ended_at: null,
      end_reason: null,
      bytes_to_device: 1_840,
      bytes_from_device: 64_220,
      has_recording: true,
      recording_bytes: 41_200,
      live: true,
      script: 'powershell',
    })
  }
  return sessions
}
