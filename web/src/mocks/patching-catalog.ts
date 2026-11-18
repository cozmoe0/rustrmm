/*
 * The mock patch catalog: this month's and last month's Windows cumulative updates, Defender
 * definitions, .NET, Office, Edge and the MSRT; apt and dnf packages with security advisories; macOS
 * softwareupdate labels; and winget upgrades. Dates are relative to "now" so the data never ages.
 * Drivers are left out (no policy includes them), as the agent would.
 */
import type { PatchClassification, PatchPlatform, PatchSeverity } from '@/lib/api/types'
import type { MockPatch } from './patching-model'

const DAY = 86_400_000

/** The second Tuesday of a month, 17:00 UTC (Patch Tuesday, 10:00 Pacific). */
function secondTuesday(year: number, month: number): number {
  const first = new Date(Date.UTC(year, month, 1, 17))
  const offset = (2 - first.getUTCDay() + 7) % 7
  return first.getTime() + (offset + 7) * DAY
}

/** The most recent Patch Tuesday at or before `now`, and the one before it. */
export function patchTuesdays(now: number): { current: number; previous: number } {
  const date = new Date(now)
  let year = date.getUTCFullYear()
  let month = date.getUTCMonth()
  let current = secondTuesday(year, month)
  if (current > now) {
    month -= 1
    if (month < 0) {
      month = 11
      year -= 1
    }
    current = secondTuesday(year, month)
  }
  const prevMonth = month === 0 ? 11 : month - 1
  const previous = secondTuesday(month === 0 ? year - 1 : year, prevMonth)
  return { current, previous }
}

const label = (ms: number) => {
  const date = new Date(ms)
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

interface Spec {
  platform: PatchPlatform
  key?: string
  kb?: string | null
  title: string
  classification: PatchClassification
  severity: PatchSeverity | null
  size_mb: number
  reboot: boolean
  released: number | null
  seen?: number
  description: string
  support_url?: string | null
  cves?: string[]
  os?: string[]
  tags?: string[]
  hosts?: string[]
}

const WIN11_PRO = 'Windows 11 Pro'
const WIN11_ENT = 'Windows 11 Enterprise'
const WIN10 = 'Windows 10 Pro'
const SRV2022 = 'Windows Server 2022 Standard'
const SRV2025 = 'Windows Server 2025 Datacenter'
const WINDOWS = [WIN11_PRO, WIN11_ENT, WIN10, SRV2022, SRV2025]
const WIN_CLIENT = [WIN11_PRO, WIN11_ENT, WIN10]
const UBUNTU = 'Ubuntu 24.04.3 LTS'
const RHEL = 'Red Hat Enterprise Linux 9.6 (Plow)'
const DEBIAN = 'Debian GNU/Linux 13 (trixie)'
const MAC15 = 'macOS 15.7.2'
const MAC26 = 'macOS 26.1'

function cves(seed: number, count: number): string[] {
  const out = new Set<string>()
  let state = seed
  while (out.size < count) {
    state = (state * 1103515245 + 12345) % 2147483648
    out.add(`CVE-2026-${String(60000 + (state % 9999)).padStart(5, '0')}`)
  }
  return [...out].sort()
}

export function buildCatalog(now: number, id: () => string): MockPatch[] {
  const { current: tue, previous: prevTue } = patchTuesdays(now)
  const cur = label(tue)
  const prev = label(prevTue)
  const specs: Spec[] = [
    // ------------------------------------------------------------ Windows, this month
    {
      platform: 'windows',
      kb: 'KB5072033',
      title: `${cur} Cumulative Update for Windows 11 Version 25H2 for x64-based Systems (KB5072033)`,
      classification: 'SecurityUpdates',
      severity: 'Critical',
      size_mb: 812,
      reboot: true,
      released: tue,
      description:
        'This security update includes quality and security improvements, among them fixes for remote code execution in the Windows Kerberos KDC proxy and elevation of privilege in the Common Log File System driver.',
      support_url: 'https://support.microsoft.com/help/5072033',
      cves: cves(33, 14),
      os: [WIN11_ENT],
    },
    {
      platform: 'windows',
      kb: 'KB5072014',
      title: `${cur} Cumulative Update for Windows 11 Version 24H2 for x64-based Systems (KB5072014)`,
      classification: 'SecurityUpdates',
      severity: 'Critical',
      size_mb: 798,
      reboot: true,
      released: tue,
      description:
        'Security and quality rollup for Windows 11, version 24H2. Addresses remote code execution in Windows Graphics Component and Microsoft Message Queuing, and a Secure Boot bypass.',
      support_url: 'https://support.microsoft.com/help/5072014',
      cves: cves(14, 12),
      os: [WIN11_PRO],
    },
    {
      platform: 'windows',
      kb: 'KB5072014',
      title: `${cur} Cumulative Update for Microsoft server operating system version 24H2 for x64-based Systems (KB5072014)`,
      classification: 'SecurityUpdates',
      severity: 'Critical',
      size_mb: 905,
      reboot: true,
      released: tue,
      description: 'Security and quality rollup for Windows Server 2025, including fixes for Active Directory Certificate Services and Hyper-V.',
      support_url: 'https://support.microsoft.com/help/5072014',
      cves: cves(15, 16),
      os: [SRV2025],
    },
    {
      platform: 'windows',
      kb: 'KB5072041',
      title: `${cur} Cumulative Update for Microsoft server operating system version 21H2 for x64-based Systems (KB5072041)`,
      classification: 'SecurityUpdates',
      severity: 'Critical',
      size_mb: 612,
      reboot: true,
      released: tue,
      description: 'Security and quality rollup for Windows Server 2022. Fixes remote code execution in Windows DNS Server and LDAP.',
      support_url: 'https://support.microsoft.com/help/5072041',
      cves: cves(41, 13),
      os: [SRV2022],
    },
    {
      platform: 'windows',
      kb: 'KB5072046',
      title: `${cur} Cumulative Update for Windows 10 Version 22H2 for x64-based Systems (KB5072046)`,
      classification: 'SecurityUpdates',
      severity: 'Critical',
      size_mb: 701,
      reboot: true,
      released: tue,
      description: 'Extended Security Update for Windows 10, version 22H2. Requires an active ESU licence on the device.',
      support_url: 'https://support.microsoft.com/help/5072046',
      cves: cves(46, 11),
      os: [WIN10],
    },
    {
      platform: 'windows',
      kb: 'KB5070901',
      title: `${cur} Cumulative Update for .NET Framework 3.5 and 4.8.1 for Windows 11 for x64 (KB5070901)`,
      classification: 'SecurityUpdates',
      severity: 'Important',
      size_mb: 74,
      reboot: false,
      released: tue,
      description: 'Addresses a denial-of-service vulnerability in System.Text.Json and an information disclosure in ASP.NET when using certificate authentication.',
      support_url: 'https://support.microsoft.com/help/5070901',
      cves: cves(901, 2),
      os: [WIN11_PRO, WIN11_ENT],
    },
    {
      platform: 'windows',
      kb: 'KB5070903',
      title: `${cur} Cumulative Update for .NET Framework 3.5, 4.8 and 4.8.1 for Microsoft server operating system version 21H2 (KB5070903)`,
      classification: 'SecurityUpdates',
      severity: 'Important',
      size_mb: 81,
      reboot: false,
      released: tue,
      description: 'Security update for .NET Framework on Windows Server 2022.',
      support_url: 'https://support.microsoft.com/help/5070903',
      cves: cves(903, 2),
      os: [SRV2022],
    },
    {
      platform: 'windows',
      kb: 'KB5070906',
      title: `${cur} Cumulative Update for .NET Framework 3.5, 4.8 and 4.8.1 for Windows 10 Version 22H2 for x64 (KB5070906)`,
      classification: 'SecurityUpdates',
      severity: 'Important',
      size_mb: 69,
      reboot: false,
      released: tue,
      description: 'Security update for .NET Framework on Windows 10, version 22H2.',
      support_url: 'https://support.microsoft.com/help/5070906',
      cves: cves(906, 2),
      os: [WIN10],
    },
    {
      platform: 'windows',
      kb: 'KB2267602',
      title: 'Security Intelligence Update for Microsoft Defender Antivirus - KB2267602 (Version 1.441.312.0) - Current Channel (Broad)',
      classification: 'Definitions',
      severity: null,
      size_mb: 48,
      reboot: false,
      released: now - 0.4 * DAY,
      description: 'Install this update to revise the files that are used to detect viruses, spyware and other potentially unwanted software.',
      support_url: 'https://go.microsoft.com/fwlink/?linkid=2007160',
      os: WINDOWS,
    },
    {
      platform: 'windows',
      kb: 'KB890830',
      title: 'Windows Malicious Software Removal Tool x64 - v5.143 (KB890830)',
      classification: 'UpdateRollups',
      severity: null,
      size_mb: 82,
      reboot: false,
      released: tue,
      description: 'After the download, this tool runs one time to check your computer for infection by specific, prevalent malicious software.',
      support_url: 'https://support.microsoft.com/help/890830',
      os: WINDOWS,
    },
    {
      platform: 'windows',
      kb: null,
      title: 'Microsoft Edge-Stable Channel Version 142 Update for x64 based Editions (Build 142.0.3595.110)',
      classification: 'Updates',
      severity: null,
      size_mb: 176,
      reboot: false,
      released: now - 3 * DAY,
      description: 'Microsoft Edge stable channel update with the latest Chromium security fixes.',
      support_url: 'https://learn.microsoft.com/deployedge/microsoft-edge-relnotes-security',
      os: WINDOWS,
    },
    {
      platform: 'windows',
      kb: null,
      title: 'Microsoft 365 Apps Update - Current Channel Version 2510 (Build 19328.20266)',
      classification: 'SecurityUpdates',
      severity: 'Important',
      size_mb: 412,
      reboot: false,
      released: tue,
      description: 'Security fixes for Excel, Word and Outlook, including a remote code execution vulnerability triggered by the preview pane.',
      support_url: 'https://learn.microsoft.com/officeupdates/microsoft365-apps-security-updates',
      cves: cves(2510, 5),
      os: WIN_CLIENT,
    },
    {
      platform: 'windows',
      kb: 'KB5068450',
      title: 'Security Update for SQL Server 2022 RTM CU21 (KB5068450)',
      classification: 'SecurityUpdates',
      severity: 'Important',
      size_mb: 536,
      reboot: true,
      released: tue,
      description: 'Fixes an elevation of privilege vulnerability in the SQL Server OLE DB driver.',
      support_url: 'https://support.microsoft.com/help/5068450',
      cves: cves(450, 2),
      hosts: ['HPL-DMS01'],
    },
    {
      platform: 'windows',
      kb: 'KB5072200',
      title: 'Windows 11, version 25H2 (feature update)',
      classification: 'Upgrades',
      severity: null,
      size_mb: 4120,
      reboot: true,
      released: now - 46 * DAY,
      description: 'Upgrade to Windows 11, version 25H2. Only offered where the policy includes feature updates.',
      support_url: 'https://learn.microsoft.com/windows/release-health/windows11-release-information',
      os: [WIN10],
      tags: ['feature-updates'],
    },
    // ------------------------------------------------------------ Windows, last month (superseded on most devices)
    {
      platform: 'windows',
      kb: 'KB5070773',
      title: `${prev} Cumulative Update for Windows 11 Version 25H2 for x64-based Systems (KB5070773)`,
      classification: 'SecurityUpdates',
      severity: 'Critical',
      size_mb: 788,
      reboot: true,
      released: prevTue,
      description: 'Security and quality rollup for Windows 11, version 25H2.',
      support_url: 'https://support.microsoft.com/help/5070773',
      cves: cves(773, 12),
      os: [WIN11_ENT],
    },
    {
      platform: 'windows',
      kb: 'KB5070768',
      title: `${prev} Cumulative Update for Windows 11 Version 24H2 for x64-based Systems (KB5070768)`,
      classification: 'SecurityUpdates',
      severity: 'Critical',
      size_mb: 776,
      reboot: true,
      released: prevTue,
      description: 'Security and quality rollup for Windows 11, version 24H2.',
      support_url: 'https://support.microsoft.com/help/5070768',
      cves: cves(768, 10),
      os: [WIN11_PRO],
    },
    {
      platform: 'windows',
      kb: 'KB5070786',
      title: `${prev} Cumulative Update for Windows 10 Version 22H2 for x64-based Systems (KB5070786)`,
      classification: 'SecurityUpdates',
      severity: 'Critical',
      size_mb: 690,
      reboot: true,
      released: prevTue,
      description: 'Extended Security Update for Windows 10, version 22H2.',
      support_url: 'https://support.microsoft.com/help/5070786',
      cves: cves(786, 9),
      os: [WIN10],
    },
    // ------------------------------------------------------------ winget (third-party, Windows)
    {
      platform: 'winget',
      key: 'winget:Google.Chrome:143.0.7499.41',
      kb: null,
      title: 'Google Chrome 143.0.7499.41',
      classification: 'app',
      severity: null,
      size_mb: 118,
      reboot: false,
      released: now - 2 * DAY,
      description: 'Upgrade from 142.0.7444.176. Stable channel update with 11 security fixes.',
      support_url: 'https://chromereleases.googleblog.com/',
      os: WIN_CLIENT,
      tags: ['winget'],
    },
    {
      platform: 'winget',
      key: 'winget:Mozilla.Firefox:146.0.1',
      kb: null,
      title: 'Mozilla Firefox 146.0.1',
      classification: 'app',
      severity: null,
      size_mb: 64,
      reboot: false,
      released: now - 4 * DAY,
      description: 'Upgrade from 145.0.2.',
      support_url: 'https://www.mozilla.org/firefox/146.0.1/releasenotes/',
      os: WIN_CLIENT,
      tags: ['winget'],
    },
    {
      platform: 'winget',
      key: 'winget:Notepad++.Notepad++:8.8.9',
      kb: null,
      title: 'Notepad++ 8.8.9',
      classification: 'app',
      severity: null,
      size_mb: 6,
      reboot: false,
      released: now - 6 * DAY,
      description: 'Upgrade from 8.8.8.',
      support_url: 'https://notepad-plus-plus.org/news/',
      os: WIN_CLIENT,
      tags: ['winget'],
    },
    // ------------------------------------------------------------ Ubuntu (apt)
    {
      platform: 'linux',
      key: 'apt:openssl:3.0.13-0ubuntu3.6',
      kb: null,
      title: 'openssl 3.0.13-0ubuntu3.6 (USN-7841-1)',
      classification: 'security',
      severity: 'Important',
      size_mb: 1.9,
      reboot: false,
      released: now - 6 * DAY,
      description: 'OpenSSL could be made to crash or expose sensitive information when processing crafted CMS messages.',
      support_url: 'https://ubuntu.com/security/notices/USN-7841-1',
      cves: cves(7841, 3),
      os: [UBUNTU],
    },
    {
      platform: 'linux',
      key: 'apt:linux-image-6.8.0-88-generic:6.8.0-88.89',
      kb: null,
      title: 'linux-image-6.8.0-88-generic 6.8.0-88.89 (USN-7852-1)',
      classification: 'security',
      severity: 'Important',
      size_mb: 14.6,
      reboot: true,
      released: now - 9 * DAY,
      description: 'Several security issues were fixed in the Linux kernel, including use-after-free bugs in the netfilter subsystem.',
      support_url: 'https://ubuntu.com/security/notices/USN-7852-1',
      cves: cves(7852, 9),
      os: [UBUNTU],
    },
    {
      platform: 'linux',
      key: 'apt:sudo:1.9.15p5-3ubuntu5.24.04.2',
      kb: null,
      title: 'sudo 1.9.15p5-3ubuntu5.24.04.2 (USN-7833-1)',
      classification: 'security',
      severity: 'Moderate',
      size_mb: 0.9,
      reboot: false,
      released: now - 16 * DAY,
      description: 'sudo could allow a local attacker to bypass host restrictions with the --host option.',
      support_url: 'https://ubuntu.com/security/notices/USN-7833-1',
      cves: cves(7833, 1),
      os: [UBUNTU],
    },
    {
      platform: 'linux',
      key: 'apt:curl:8.5.0-2ubuntu10.7',
      kb: null,
      title: 'curl 8.5.0-2ubuntu10.7 (USN-7860-1)',
      classification: 'security',
      severity: 'Moderate',
      size_mb: 0.3,
      reboot: false,
      released: now - 2 * DAY,
      description: 'curl could leak credentials to a different host after a redirect.',
      support_url: 'https://ubuntu.com/security/notices/USN-7860-1',
      cves: cves(7860, 2),
      os: [UBUNTU],
    },
    {
      platform: 'linux',
      key: 'apt:systemd:255.4-1ubuntu8.12',
      kb: null,
      title: 'systemd 255.4-1ubuntu8.12',
      classification: 'bugfix',
      severity: null,
      size_mb: 3.6,
      reboot: false,
      released: now - 12 * DAY,
      description: 'Fixes journald rotation under heavy logging (noble-updates).',
      support_url: 'https://launchpad.net/ubuntu/+source/systemd',
      os: [UBUNTU],
    },
    {
      platform: 'linux',
      key: 'apt:docker-ce:5:28.5.2-1~ubuntu.24.04~noble',
      kb: null,
      title: 'docker-ce 5:28.5.2-1~ubuntu.24.04~noble',
      classification: 'other',
      severity: null,
      size_mb: 25.4,
      reboot: false,
      released: now - 5 * DAY,
      description: 'Docker Engine maintenance release (download.docker.com repository).',
      support_url: 'https://docs.docker.com/engine/release-notes/',
      os: [UBUNTU],
      tags: ['backup'],
    },
    // ------------------------------------------------------------ RHEL (dnf)
    {
      platform: 'linux',
      key: 'dnf:kernel.x86_64:5.14.0-611.5.1.el9_7',
      kb: null,
      title: 'kernel 5.14.0-611.5.1.el9_7 (RHSA-2026:21458)',
      classification: 'security',
      severity: 'Important',
      size_mb: 6.1,
      reboot: true,
      released: now - 7 * DAY,
      description: 'Important: kernel security update. Fixes a use-after-free in the ksmbd module and a race in the TCP stack.',
      support_url: 'https://access.redhat.com/errata/RHSA-2026:21458',
      cves: cves(21458, 7),
      os: [RHEL],
    },
    {
      platform: 'linux',
      key: 'dnf:openssl.x86_64:3.2.2-6.el9_7.1',
      kb: null,
      title: 'openssl 3.2.2-6.el9_7.1 (RHSA-2026:21102)',
      classification: 'security',
      severity: 'Moderate',
      size_mb: 1.4,
      reboot: false,
      released: now - 13 * DAY,
      description: 'Moderate: openssl security update.',
      support_url: 'https://access.redhat.com/errata/RHSA-2026:21102',
      cves: cves(21102, 2),
      os: [RHEL],
    },
    {
      platform: 'linux',
      key: 'dnf:java-21-openjdk.x86_64:21.0.9.0.10-1.el9',
      kb: null,
      title: 'java-21-openjdk 21.0.9.0.10-1.el9 (RHSA-2026:20877)',
      classification: 'security',
      severity: 'Important',
      size_mb: 48.2,
      reboot: false,
      released: now - 29 * DAY,
      description: 'Important: OpenJDK October critical patch update.',
      support_url: 'https://access.redhat.com/errata/RHSA-2026:20877',
      cves: cves(20877, 6),
      os: [RHEL],
      tags: ['wms', 'core-banking'],
    },
    {
      platform: 'linux',
      key: 'dnf:nginx.x86_64:1:1.26.3-3.el9_7',
      kb: null,
      title: 'nginx 1:1.26.3-3.el9_7 (RHSA-2026:21190)',
      classification: 'security',
      severity: 'Moderate',
      size_mb: 0.6,
      reboot: false,
      released: now - 10 * DAY,
      description: 'Moderate: nginx security update for HTTP/3 request smuggling.',
      support_url: 'https://access.redhat.com/errata/RHSA-2026:21190',
      cves: cves(21190, 1),
      os: [RHEL],
      tags: ['wms', 'core-banking'],
    },
    {
      platform: 'linux',
      key: 'dnf:tzdata.noarch:2026c-1.el9',
      kb: null,
      title: 'tzdata 2026c-1.el9 (RHBA-2026:20990)',
      classification: 'enhancement',
      severity: null,
      size_mb: 0.5,
      reboot: false,
      released: now - 20 * DAY,
      description: 'Time zone data update.',
      support_url: 'https://access.redhat.com/errata/RHBA-2026:20990',
      os: [RHEL],
    },
    {
      platform: 'linux',
      key: 'dnf:systemd.x86_64:252-55.el9_7.2',
      kb: null,
      title: 'systemd 252-55.el9_7.2 (RHBA-2026:21033)',
      classification: 'bugfix',
      severity: null,
      size_mb: 4.2,
      reboot: false,
      released: now - 15 * DAY,
      description: 'Bug fix update for systemd-resolved DNSSEC handling.',
      support_url: 'https://access.redhat.com/errata/RHBA-2026:21033',
      os: [RHEL],
    },
    // ------------------------------------------------------------ Debian (apt)
    {
      platform: 'linux',
      key: 'apt:openssh-server:1:10.0p1-7+deb13u1',
      kb: null,
      title: 'openssh-server 1:10.0p1-7+deb13u1 (DSA-6061-1)',
      classification: 'security',
      severity: 'Important',
      size_mb: 1.1,
      reboot: false,
      released: now - 8 * DAY,
      description: 'Fixes a pre-authentication denial of service in sshd.',
      support_url: 'https://security-tracker.debian.org/tracker/DSA-6061-1',
      cves: cves(6061, 1),
      os: [DEBIAN],
    },
    {
      platform: 'linux',
      key: 'apt:linux-image-amd64:6.12.57-1',
      kb: null,
      title: 'linux-image-amd64 6.12.57-1 (DSA-6058-1)',
      classification: 'security',
      severity: 'Important',
      size_mb: 98.5,
      reboot: true,
      released: now - 11 * DAY,
      description: 'Several vulnerabilities in the Linux kernel may lead to privilege escalation.',
      support_url: 'https://security-tracker.debian.org/tracker/DSA-6058-1',
      cves: cves(6058, 8),
      os: [DEBIAN],
    },
    // ------------------------------------------------------------ macOS (softwareupdate)
    {
      platform: 'macos',
      key: 'macOS Tahoe 26.1.1-25B90',
      kb: null,
      title: 'macOS Tahoe 26.1.1',
      classification: 'os',
      severity: null,
      size_mb: 2140,
      reboot: true,
      released: now - 5 * DAY,
      description: 'macOS Tahoe 26.1.1 provides important bug fixes and security updates.',
      support_url: 'https://support.apple.com/en-us/125634',
      cves: cves(125634, 6),
      os: [MAC26],
    },
    {
      platform: 'macos',
      key: 'macOS Sequoia 15.7.3-24G403',
      kb: null,
      title: 'macOS Sequoia 15.7.3',
      classification: 'os',
      severity: null,
      size_mb: 1830,
      reboot: true,
      released: now - 5 * DAY,
      description: 'This update provides important security fixes and is recommended for all users.',
      support_url: 'https://support.apple.com/en-us/125635',
      cves: cves(125635, 5),
      os: [MAC15],
    },
    {
      platform: 'macos',
      key: 'Safari26.1.1SequoiaAuto-26.1.1',
      kb: null,
      title: 'Safari 26.1.1',
      classification: 'app',
      severity: null,
      size_mb: 152,
      reboot: false,
      released: now - 5 * DAY,
      description: 'Safari 26.1.1 for macOS Sequoia.',
      support_url: 'https://support.apple.com/en-us/125636',
      cves: cves(125636, 3),
      os: [MAC15],
    },
    {
      platform: 'macos',
      key: 'XProtectPlistConfigData_10_15-5321',
      kb: null,
      title: 'XProtectPlistConfigData 5321',
      classification: 'security',
      severity: null,
      size_mb: 1,
      reboot: false,
      released: now - 1.5 * DAY,
      description: 'Background security data for XProtect.',
      support_url: null,
      os: [MAC15, MAC26],
    },
  ]
  return specs.map((spec) => ({
    id: id(),
    platform: spec.platform,
    key: spec.key ?? id(),
    kb: spec.kb ?? null,
    title: spec.title,
    classification: spec.classification,
    severity: spec.severity,
    size_bytes: Math.round(spec.size_mb * 1_048_576),
    reboot_required: spec.reboot,
    release_date: spec.released === null ? null : new Date(spec.released).toISOString(),
    first_seen_at: new Date(spec.seen ?? Math.min(now - 600_000, Math.max((spec.released ?? now) + 3 * 3_600_000, now - 60 * DAY))).toISOString(),
    description: spec.description,
    support_url: spec.support_url ?? null,
    cves: spec.cves ?? [],
    os: spec.os ?? [],
    tags: spec.tags,
    hosts: spec.hosts,
  }))
}
