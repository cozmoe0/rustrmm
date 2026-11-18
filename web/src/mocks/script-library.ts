/*
 * The built-in script library the mock API seeds (the real server ships its own), with content
 * per OS and generators for plausible stdout/stderr. Output is derived from a seed so a result
 * always reads the same when reopened.
 */
import type {
  OsFamily,
  ParameterType,
  ParameterValue,
  ScriptLanguage,
  ScriptParameter,
  ScriptRisk,
} from '@/lib/api/types'
import type { MockDevice } from './devices'
import { rng } from './devices'

export type Rng = ReturnType<typeof rng>

export interface OutputContext {
  device: MockDevice
  params: Record<string, ParameterValue>
  r: Rng
  /** The planned outcome: false means the script should fail. */
  ok: boolean
}

export interface ScriptOutput {
  stdout: string
  stderr?: string
  exit?: number
}

export interface LibraryScript {
  key: string
  name: string
  description: string
  category: string
  language: ScriptLanguage
  platforms: OsFamily[]
  timeout: number
  risk?: ScriptRisk
  parameters?: ScriptParameter[]
  content: string
  /** Earlier versions, oldest first. */
  history?: { content: string; notes: string; parameters?: ScriptParameter[] }[]
  /** Probability of failure per device. */
  failRate?: number
  /** Typical duration range in ms (reported for historical runs). */
  duration?: [number, number]
  output: (ctx: OutputContext) => ScriptOutput
}

function p(
  name: string,
  label: string,
  type: ParameterType,
  extra: Partial<Omit<ScriptParameter, 'name' | 'label' | 'type'>> = {},
): ScriptParameter {
  return { name, label, type, description: '', required: false, default: null, ...extra }
}

const str = (value: ParameterValue | undefined, fallback = '') =>
  value === null || value === undefined || value === '' ? fallback : String(value)
const num = (value: ParameterValue | undefined, fallback: number) => {
  const parsed = Number(value)
  return value === null || value === undefined || value === '' || !Number.isFinite(parsed) ? fallback : parsed
}
const bool = (value: ParameterValue | undefined, fallback = false) =>
  value === undefined || value === null ? fallback : value === true || value === 'true'

const fmt = (value: number) => value.toLocaleString('en-US')
const gb = (value: number) => `${value.toFixed(2)} GB`
const short = (device: MockDevice) => device.hostname.toUpperCase()
const user = (device: MockDevice) => device.last_user?.split('\\').pop() ?? 'admin'
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19)

function table(rows: string[][]): string {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)))
  const line = (row: string[]) =>
    row
      .map((cell, column) => cell.padEnd(widths[column]))
      .join('  ')
      .trimEnd()
  return [line(rows[0]), line(rows[0].map((_, column) => '-'.repeat(widths[column]))), ...rows.slice(1).map(line)].join(
    '\n',
  )
}

function psError(command: string, message: string, category = 'NotSpecified') {
  return `${command} : ${message}\nAt C:\\ProgramData\\RustRMM\\scripts\\run.ps1:12 char:5\n+     ${command} @params\n+     ${'~'.repeat(command.length)}\n    + CategoryInfo          : ${category}: (:) [${command}], Exception\n    + FullyQualifiedErrorId : ${command.replace('-', '')}Failed`
}

// ------------------------------------------------------------------ library

export const LIBRARY: LibraryScript[] = [
  {
    key: 'win-clear-temp',
    name: 'Clear temporary files',
    description:
      'Removes stale files from the Windows and per-user temp folders, the Windows Update download cache and crash dumps.',
    category: 'Maintenance',
    language: 'powershell',
    platforms: ['windows'],
    timeout: 900,
    parameters: [
      p('MinAgeDays', 'Minimum age (days)', 'number', {
        default: 7,
        required: true,
        description: 'Only files older than this are removed.',
      }),
      p('IncludeUpdateCache', 'Include Windows Update cache', 'boolean', { default: true }),
    ],
    content: `$ErrorActionPreference = 'Continue'
$cutoff = (Get-Date).AddDays(-[int]$env:MinAgeDays)
$paths = @("$env:SystemRoot\\Temp", 'C:\\Users\\*\\AppData\\Local\\Temp', "$env:SystemRoot\\Minidump")
if ($env:IncludeUpdateCache -eq 'true') { $paths += "$env:SystemRoot\\SoftwareDistribution\\Download" }

$removed = 0; $bytes = 0; $skipped = 0
foreach ($path in $paths) {
    Write-Output "Scanning $path (older than $($env:MinAgeDays) days)..."
    Get-ChildItem -Path $path -Recurse -Force -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt $cutoff } |
        ForEach-Object {
            try { $size = $_.Length; Remove-Item $_.FullName -Force -ErrorAction Stop; $removed++; $bytes += $size }
            catch { $skipped++ }
        }
}
"Removed {0:N0} files ({1:N2} GB) from {2} locations." -f $removed, ($bytes / 1GB), $paths.Count
if ($skipped) { "Skipped $skipped files that are in use." }
"::rustrmm::set-field last_maintenance=$(Get-Date -Format yyyy-MM-dd)"`,
    history: [
      {
        notes: 'Initial version',
        parameters: [p('MinAgeDays', 'Minimum age (days)', 'number', { default: 7, required: true })],
        content: `$ErrorActionPreference = 'Continue'
$cutoff = (Get-Date).AddDays(-[int]$env:MinAgeDays)
$paths = @("$env:SystemRoot\\Temp", 'C:\\Users\\*\\AppData\\Local\\Temp')

$removed = 0; $bytes = 0
foreach ($path in $paths) {
    Write-Output "Scanning $path..."
    Get-ChildItem -Path $path -Recurse -Force -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt $cutoff } |
        ForEach-Object { $bytes += $_.Length; Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue; $removed++ }
}
"Removed $removed files ($([math]::Round($bytes / 1GB, 2)) GB)."`,
      },
      {
        notes: 'Count files that are in use instead of failing silently; clear crash dumps',
        parameters: [p('MinAgeDays', 'Minimum age (days)', 'number', { default: 7, required: true })],
        content: `$ErrorActionPreference = 'Continue'
$cutoff = (Get-Date).AddDays(-[int]$env:MinAgeDays)
$paths = @("$env:SystemRoot\\Temp", 'C:\\Users\\*\\AppData\\Local\\Temp', "$env:SystemRoot\\Minidump")

$removed = 0; $bytes = 0; $skipped = 0
foreach ($path in $paths) {
    Write-Output "Scanning $path (older than $($env:MinAgeDays) days)..."
    Get-ChildItem -Path $path -Recurse -Force -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt $cutoff } |
        ForEach-Object {
            try { $size = $_.Length; Remove-Item $_.FullName -Force -ErrorAction Stop; $removed++; $bytes += $size }
            catch { $skipped++ }
        }
}
"Removed {0:N0} files ({1:N2} GB) from {2} locations." -f $removed, ($bytes / 1GB), $paths.Count
if ($skipped) { "Skipped $skipped files that are in use." }`,
      },
    ],
    failRate: 0.05,
    duration: [4000, 48000],
    output: ({ device, params, r, ok }) => {
      const days = num(params.MinAgeDays, 7)
      const paths = ['C:\\Windows\\Temp', 'C:\\Users\\*\\AppData\\Local\\Temp', 'C:\\Windows\\Minidump']
      if (bool(params.IncludeUpdateCache, true)) paths.push('C:\\Windows\\SoftwareDistribution\\Download')
      const lines = paths.map((path) => `Scanning ${path} (older than ${days} days)...`)
      if (!ok) {
        return {
          stdout: lines.slice(0, 2).join('\n'),
          stderr: psError(
            'Get-ChildItem',
            `Access to the path 'C:\\Users\\${user(device)}\\AppData\\Local\\Temp\\WinSAT' is denied.`,
            'PermissionDenied',
          ),
          exit: 1,
        }
      }
      const files = r.between(180, 9400)
      const skipped = r.between(0, 24)
      lines.push(
        `Removed ${fmt(files)} files (${gb((files * r.between(90, 900)) / 1_048_576)}) from ${paths.length} locations.`,
      )
      if (skipped) lines.push(`Skipped ${skipped} files that are in use.`)
      lines.push(`::rustrmm::set-field last_maintenance=${new Date().toISOString().slice(0, 10)}`)
      return { stdout: lines.join('\n') }
    },
  },
  {
    key: 'win-restart-service',
    name: 'Restart a service',
    description:
      'Restarts a Windows service by name and waits for it to report Running. Optionally stops dependent services first.',
    category: 'Services',
    language: 'powershell',
    platforms: ['windows'],
    timeout: 300,
    parameters: [
      p('ServiceName', 'Service name', 'string', {
        required: true,
        default: 'Spooler',
        description: 'The short service name, e.g. Spooler or wuauserv.',
      }),
      p('Force', 'Also restart dependent services', 'boolean', { default: false }),
    ],
    content: `$ErrorActionPreference = 'Stop'
$service = Get-Service -Name $env:ServiceName
Write-Output "Stopping service '$($service.Name)' ($($service.DisplayName))..."
$watch = [Diagnostics.Stopwatch]::StartNew()
Restart-Service -InputObject $service -Force:($env:Force -eq 'true')
$service.WaitForStatus('Running', '00:01:00')
Write-Output ("Service restarted in {0:N1} s." -f $watch.Elapsed.TotalSeconds)
Get-Service -Name $env:ServiceName | Format-Table Status, Name, DisplayName -AutoSize`,
    failRate: 0.06,
    duration: [1500, 9000],
    output: ({ params, r, ok }) => {
      const name = str(params.ServiceName, 'Spooler')
      const display: Record<string, string> = {
        Spooler: 'Print Spooler',
        wuauserv: 'Windows Update',
        W32Time: 'Windows Time',
        BITS: 'Background Intelligent Transfer Service',
        Dnscache: 'DNS Client',
      }
      if (!ok)
        return {
          stdout: '',
          stderr: psError('Get-Service', `Cannot find any service with service name '${name}'.`, 'ObjectNotFound'),
          exit: 1,
        }
      return {
        stdout: `Stopping service '${name}' (${display[name] ?? name})...\nService restarted in ${(r.between(8, 60) / 10).toFixed(1)} s.\n\n${table(
          [
            ['Status', 'Name', 'DisplayName'],
            ['Running', name, display[name] ?? name],
          ],
        )}`,
      }
    },
  },
  {
    key: 'win-spooler-reset',
    name: 'Reset print spooler and clear queue',
    description:
      'Stops the spooler, deletes stuck jobs from the spool folder and starts it again. Fixes most “stuck printing” tickets.',
    category: 'Printing',
    language: 'powershell',
    platforms: ['windows'],
    timeout: 300,
    content: `Stop-Service -Name Spooler -Force
$spool = "$env:SystemRoot\\System32\\spool\\PRINTERS"
$jobs = Get-ChildItem $spool -File -ErrorAction SilentlyContinue
$jobs | Remove-Item -Force -ErrorAction SilentlyContinue
Start-Service -Name Spooler
Write-Output "Cleared $($jobs.Count) queued job file(s)."
Get-Printer | Select-Object Name, PrinterStatus, JobCount | Format-Table -AutoSize`,
    failRate: 0.04,
    duration: [2500, 7000],
    output: ({ device, r, ok }) => {
      if (!ok)
        return {
          stdout: '',
          stderr: psError(
            'Start-Service',
            "Service 'Print Spooler (Spooler)' cannot be started due to the following error: Cannot start service Spooler on computer '.'.",
          ),
          exit: 1,
        }
      const printers =
        device.sim.industry === 'legal'
          ? ['HP LaserJet M507 - Floor 3', 'Canon iR-ADV C5840 - Records']
          : device.sim.industry === 'freight'
            ? ['Zebra ZT411 - Dock 4', 'Brother HL-L6200DW']
            : ['HP LaserJet Pro 4001n', 'Microsoft Print to PDF']
      return {
        stdout: `Cleared ${r.between(0, 14)} queued job file(s).\n\n${table([['Name', 'PrinterStatus', 'JobCount'], ...printers.map((name) => [name, 'Normal', '0'])])}`,
      }
    },
  },
  {
    key: 'win-flush-dns',
    name: 'Flush DNS cache',
    description: 'Clears the DNS client cache and re-registers the computer’s DNS records.',
    category: 'Network',
    language: 'powershell',
    platforms: ['windows'],
    timeout: 120,
    content: `Clear-DnsClientCache
ipconfig /registerdns | Out-Null
Write-Output "DNS client cache cleared on $env:COMPUTERNAME."
Get-DnsClientServerAddress -AddressFamily IPv4 | Where-Object ServerAddresses | Format-Table InterfaceAlias, ServerAddresses -AutoSize`,
    failRate: 0.01,
    duration: [600, 2200],
    output: ({ device }) => ({
      stdout: `DNS client cache cleared on ${short(device)}.\n\n${table([
        ['InterfaceAlias', 'ServerAddresses'],
        [
          'Ethernet',
          `{${device.last_ip?.split('.').slice(0, 3).join('.')}.10, ${device.last_ip?.split('.').slice(0, 3).join('.')}.11}`,
        ],
      ])}`,
    }),
  },
  {
    key: 'win-defender-scan',
    name: 'Run Microsoft Defender scan',
    description: 'Starts a Defender quick or full scan and reports any threats detected.',
    category: 'Security',
    language: 'powershell',
    platforms: ['windows'],
    timeout: 7200,
    parameters: [
      p('ScanType', 'Scan type', 'select', {
        options: ['QuickScan', 'FullScan'],
        default: 'QuickScan',
        required: true,
      }),
    ],
    content: `$ErrorActionPreference = 'Stop'
Write-Output "Starting Defender $env:ScanType..."
Start-MpScan -ScanType $env:ScanType
$threats = Get-MpThreatDetection | Where-Object { $_.InitialDetectionTime -gt (Get-Date).AddHours(-2) }
if ($threats) {
    $threats | Format-Table ThreatID, ProcessName, Resources -AutoSize
    exit 2
}
Write-Output 'Scan finished: no threats found.'`,
    failRate: 0.05,
    duration: [60000, 900000],
    output: ({ device, params, r, ok }) => {
      const type = str(params.ScanType, 'QuickScan')
      if (!device.sim.avEnabled)
        return {
          stdout: `Starting Defender ${type}...`,
          stderr: psError(
            'Start-MpScan',
            'A third-party antivirus is active; Microsoft Defender Antivirus is in passive mode. (0x800106BA)',
          ),
          exit: 1,
        }
      if (!ok)
        return {
          stdout: `Starting Defender ${type}...\n\n${table([
            ['ThreatID', 'ProcessName', 'Resources'],
            [
              '2147735503',
              'explorer.exe',
              `{file:_C:\\Users\\${user(device)}\\Downloads\\invoice_${r.between(1000, 9999)}.zip}`,
            ],
          ])}`,
          exit: 2,
        }
      return {
        stdout: `Starting Defender ${type}...\nScanned ${fmt(r.between(48_000, type === 'FullScan' ? 1_400_000 : 190_000))} items in ${r.between(2, type === 'FullScan' ? 80 : 9)} min.\nScan finished: no threats found.`,
      }
    },
  },
  {
    key: 'win-defender-update',
    name: 'Update Defender signatures',
    description: 'Downloads the latest Microsoft Defender security intelligence and reports the signature age.',
    category: 'Security',
    language: 'powershell',
    platforms: ['windows'],
    timeout: 600,
    content: `Update-MpSignature -UpdateSource MicrosoftUpdateServer
$status = Get-MpComputerStatus
"Antivirus signatures: {0} ({1})" -f $status.AntivirusSignatureVersion, $status.AntivirusSignatureLastUpdated
"Engine: {0}  Real-time protection: {1}" -f $status.AMEngineVersion, $status.RealTimeProtectionEnabled`,
    failRate: 0.04,
    duration: [5000, 45000],
    output: ({ device, r, ok }) => {
      if (!ok)
        return {
          stdout: '',
          stderr: psError(
            'Update-MpSignature',
            'Virus and spyware definitions update was completed with errors. (0x80070652)',
          ),
          exit: 1,
        }
      return {
        stdout: `Antivirus signatures: 1.421.${r.between(100, 999)}.0 (${new Date().toLocaleString('en-US')})\nEngine: 1.1.25090.3001  Real-time protection: ${device.sim.avEnabled ? 'True' : 'False'}`,
      }
    },
  },
  {
    key: 'win-pending-reboot',
    name: 'Check for a pending restart',
    description:
      'Checks Component Based Servicing, Windows Update and pending file renames, and records the result in the “Restart required” field.',
    category: 'Maintenance',
    language: 'powershell',
    platforms: ['windows'],
    timeout: 120,
    content: `$reasons = @()
if (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending') { $reasons += 'Component Based Servicing' }
if (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired') { $reasons += 'Windows Update' }
$renames = Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager' -Name PendingFileRenameOperations -ErrorAction SilentlyContinue
if ($renames) { $reasons += 'Pending file rename operations' }

if ($reasons) { "Restart pending: $($reasons -join ', ')" } else { 'No restart pending.' }
"::rustrmm::set-field reboot_required=$([bool]$reasons)".ToLower()`,
    failRate: 0,
    duration: [300, 1400],
    output: ({ device }) => {
      const pending = device.sim.pendingReboot
      return {
        stdout: `${pending ? 'Restart pending: Windows Update, Pending file rename operations' : 'No restart pending.'}\n::rustrmm::set-field reboot_required=${pending}`,
      }
    },
  },
  {
    key: 'win-bitlocker-status',
    name: 'Collect BitLocker status',
    description: 'Reports protection status and key protectors for every fixed volume and records the OS volume state.',
    category: 'Security',
    language: 'powershell',
    platforms: ['windows'],
    timeout: 120,
    content: `$volumes = Get-BitLockerVolume
$volumes | Format-Table MountPoint, VolumeStatus, ProtectionStatus, EncryptionPercentage, KeyProtector -AutoSize
$os = $volumes | Where-Object VolumeType -eq 'OperatingSystem'
"::rustrmm::set-field bitlocker_status=$($os.ProtectionStatus)"`,
    failRate: 0.02,
    duration: [400, 2000],
    output: ({ device, ok }) => {
      if (!ok)
        return {
          stdout: '',
          stderr: psError(
            'Get-BitLockerVolume',
            "The term 'Get-BitLockerVolume' is not recognized as the name of a cmdlet. BitLocker Drive Encryption is not installed on this edition.",
            'ObjectNotFound',
          ),
          exit: 1,
        }
      const on = device.sim.encrypted
      return {
        stdout: `${table([
          ['MountPoint', 'VolumeStatus', 'ProtectionStatus', 'EncryptionPercentage', 'KeyProtector'],
          [
            'C:',
            on ? 'FullyEncrypted' : 'FullyDecrypted',
            on ? 'On' : 'Off',
            on ? '100' : '0',
            on ? '{Tpm, RecoveryPassword}' : '{}',
          ],
        ])}\n::rustrmm::set-field bitlocker_status=${on ? 'On' : 'Off'}`,
      }
    },
  },
  {
    key: 'win-installed-software',
    name: 'List installed software',
    description: 'Lists 64- and 32-bit installed programs from the registry, sorted by name.',
    category: 'Inventory',
    language: 'powershell',
    platforms: ['windows'],
    timeout: 120,
    content: `$keys = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
        'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
Get-ItemProperty $keys -ErrorAction SilentlyContinue |
    Where-Object DisplayName |
    Sort-Object DisplayName |
    Format-Table DisplayName, DisplayVersion, Publisher -AutoSize`,
    failRate: 0,
    duration: [700, 3000],
    output: ({ device }) => {
      const rows = [
        ['DisplayName', 'DisplayVersion', 'Publisher'],
        ['7-Zip 25.01 (x64)', '25.01', 'Igor Pavlov'],
        ['Google Chrome', '142.0.7444.135', 'Google LLC'],
        ['Microsoft 365 Apps for business - en-us', '16.0.19328.20190', 'Microsoft Corporation'],
        ['Microsoft Edge', '142.0.3595.80', 'Microsoft Corporation'],
        ['Microsoft Teams', '25290.205.4069.4894', 'Microsoft Corporation'],
        ['RustRMM Agent', device.agent_version, 'RustRMM'],
        ['Zoom Workplace (64-bit)', '6.6.6.19875', 'Zoom Communications, Inc.'],
      ]
      if (device.sim.industry === 'dental') rows.splice(4, 0, ['Dentrix G7', '7.5.12.0', 'Henry Schein One'])
      if (device.sim.industry === 'architecture') rows.splice(1, 0, ['Autodesk AutoCAD 2026', '25.1.62.0', 'Autodesk'])
      return { stdout: table(rows) }
    },
  },
  {
    key: 'win-component-cleanup',
    name: 'Clean up the component store',
    description: 'Runs DISM component cleanup to reclaim space used by superseded Windows updates.',
    category: 'Maintenance',
    language: 'powershell',
    platforms: ['windows'],
    timeout: 3600,
    content: `$before = (Get-PSDrive C).Free
dism.exe /Online /Cleanup-Image /StartComponentCleanup /NoRestart
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$freed = ((Get-PSDrive C).Free - $before) / 1GB
"Reclaimed {0:N2} GB on C:" -f $freed`,
    failRate: 0.05,
    duration: [120000, 900000],
    output: ({ r, ok }) => {
      const header =
        'Deployment Image Servicing and Management tool\nVersion: 10.0.26100.5074\n\nImage Version: 10.0.26100.7171\n\n[==========================100.0%==========================]'
      if (!ok)
        return {
          stdout: `${header}\n\nError: 0x800f0806\n\nThe operation could not be completed due to pending operations.`,
          exit: 0x800f0806 & 0xff,
        }
      return {
        stdout: `${header}\nThe operation completed successfully.\nReclaimed ${(r.between(30, 640) / 100).toFixed(2)} GB on C:`,
      }
    },
  },
  {
    key: 'win-reset-wu',
    name: 'Reset Windows Update components',
    description:
      'Stops update services, renames SoftwareDistribution and catroot2, re-registers BITS and restarts the services.',
    category: 'Updates',
    language: 'powershell',
    platforms: ['windows'],
    timeout: 900,
    risk: 'high',
    content: `$ErrorActionPreference = 'Stop'
$services = 'wuauserv', 'bits', 'cryptsvc', 'msiserver'
$services | ForEach-Object { Stop-Service $_ -Force -ErrorAction SilentlyContinue }
$suffix = Get-Date -Format yyyyMMddHHmm
Rename-Item "$env:SystemRoot\\SoftwareDistribution" "SoftwareDistribution.$suffix"
Rename-Item "$env:SystemRoot\\System32\\catroot2" "catroot2.$suffix"
$services | ForEach-Object { Start-Service $_ }
Write-Output "Windows Update components reset. Previous caches kept with suffix .$suffix"`,
    failRate: 0.08,
    duration: [15000, 60000],
    output: ({ ok }) => {
      const suffix = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)
      if (!ok)
        return {
          stdout: '',
          stderr: psError(
            'Rename-Item',
            "The process cannot access the file because it is being used by another process. 'C:\\Windows\\System32\\catroot2'",
            'WriteError',
          ),
          exit: 1,
        }
      return {
        stdout: `Stopping wuauserv, bits, cryptsvc, msiserver...\nWindows Update components reset. Previous caches kept with suffix .${suffix}`,
      }
    },
  },
  {
    key: 'win-wu-scan',
    name: 'Scan for Windows updates',
    description: 'Asks the Windows Update agent to search for applicable updates and lists them without installing.',
    category: 'Updates',
    language: 'powershell',
    platforms: ['windows'],
    timeout: 1800,
    content: `$session = New-Object -ComObject Microsoft.Update.Session
$searcher = $session.CreateUpdateSearcher()
$result = $searcher.Search("IsInstalled=0 and IsHidden=0")
"{0} update(s) available" -f $result.Updates.Count
$result.Updates | ForEach-Object { " - {0}" -f $_.Title }`,
    failRate: 0.06,
    duration: [20000, 180000],
    output: ({ r, ok }) => {
      if (!ok)
        return {
          stdout: '',
          stderr:
            'Exception from HRESULT: 0x8024402C\nWindows Update could not reach the update service (WU_E_PT_WINHTTP_NAME_NOT_RESOLVED).',
          exit: 1,
        }
      const updates = [
        '2025-11 Cumulative Update for Windows 11 Version 24H2 for x64-based Systems (KB5068861)',
        'Security Intelligence Update for Microsoft Defender Antivirus - KB2267602 (Version 1.441.71.0)',
        '2025-11 Cumulative Update for .NET Framework 3.5 and 4.8.1 (KB5066131)',
        'Intel Corporation - Display - 32.0.101.6881',
      ]
      const count = r.between(0, 4)
      return {
        stdout: [`${count} update(s) available`, ...updates.slice(0, count).map((title) => ` - ${title}`)].join('\n'),
      }
    },
  },
  {
    key: 'win-local-admins',
    name: 'List local administrators',
    description: 'Lists members of the local Administrators group and records the count for compliance reporting.',
    category: 'Security',
    language: 'powershell',
    platforms: ['windows'],
    timeout: 120,
    content: `$members = Get-LocalGroupMember -SID S-1-5-32-544
$members | Format-Table Name, ObjectClass, PrincipalSource -AutoSize
"::rustrmm::set-field local_admin_count=$($members.Count)"`,
    failRate: 0,
    duration: [300, 1200],
    output: ({ device }) => {
      const domain = device.domain?.split('.')[0].toUpperCase() ?? short(device)
      const rows = [
        ['Name', 'ObjectClass', 'PrincipalSource'],
        [`${short(device)}\\Administrator`, 'User', 'Local'],
        [`${domain}\\Domain Admins`, 'Group', 'ActiveDirectory'],
        [`${short(device)}\\rmm-svc`, 'User', 'Local'],
      ]
      if (device.sim.extraAdmin) rows.push([device.sim.extraAdmin, 'User', 'ActiveDirectory'])
      return { stdout: `${table(rows)}\n::rustrmm::set-field local_admin_count=${rows.length - 1}` }
    },
  },
  {
    key: 'win-enable-rdp',
    name: 'Enable Remote Desktop',
    description: 'Enables RDP with Network Level Authentication and opens the Remote Desktop firewall rule group.',
    category: 'Remote access',
    language: 'powershell',
    platforms: ['windows'],
    timeout: 120,
    risk: 'high',
    content: `Set-ItemProperty 'HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server' -Name fDenyTSConnections -Value 0
Set-ItemProperty 'HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp' -Name UserAuthentication -Value 1
Enable-NetFirewallRule -DisplayGroup 'Remote Desktop'
Write-Output 'Remote Desktop enabled with Network Level Authentication.'`,
    failRate: 0.02,
    duration: [800, 3000],
    output: () => ({
      stdout:
        'Remote Desktop enabled with Network Level Authentication.\nFirewall rule group "Remote Desktop" enabled (3 rules).',
    }),
  },
  {
    key: 'win-power-plan',
    name: 'Set power plan',
    description: 'Activates a built-in power plan and disables sleep on AC power for servers and kiosks.',
    category: 'Power',
    language: 'powershell',
    platforms: ['windows'],
    timeout: 120,
    parameters: [
      p('Plan', 'Power plan', 'select', {
        options: ['Balanced', 'High performance', 'Power saver'],
        default: 'Balanced',
        required: true,
      }),
    ],
    content: `$guids = @{ 'Balanced' = '381b4222-f694-41f0-9685-ff5bb260df2e'; 'High performance' = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c'; 'Power saver' = 'a1841308-3541-4fab-bc81-f71556f20b4a' }
powercfg /setactive $guids[$env:Plan]
powercfg /change standby-timeout-ac 0
powercfg /getactivescheme`,
    failRate: 0.01,
    duration: [400, 1500],
    output: ({ params }) => {
      const plan = str(params.Plan, 'Balanced')
      const guid =
        plan === 'Balanced'
          ? '381b4222-f694-41f0-9685-ff5bb260df2e'
          : plan === 'Power saver'
            ? 'a1841308-3541-4fab-bc81-f71556f20b4a'
            : '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c'
      return { stdout: `Power Scheme GUID: ${guid}  (${plan})` }
    },
  },
  {
    key: 'win-event-errors',
    name: 'Summarise event log errors',
    description: 'Groups error and critical events from the last N hours by source and event ID.',
    category: 'Diagnostics',
    language: 'powershell',
    platforms: ['windows'],
    timeout: 300,
    parameters: [
      p('LogName', 'Log', 'select', { options: ['System', 'Application'], default: 'System', required: true }),
      p('Hours', 'Look back (hours)', 'number', { default: 24, required: true }),
    ],
    content: `$since = (Get-Date).AddHours(-[int]$env:Hours)
Get-WinEvent -FilterHashtable @{ LogName = $env:LogName; Level = 1, 2; StartTime = $since } -ErrorAction SilentlyContinue |
    Group-Object ProviderName, Id |
    Sort-Object Count -Descending |
    Select-Object -First 10 Count, Name |
    Format-Table -AutoSize`,
    failRate: 0,
    duration: [1500, 9000],
    output: ({ params, r }) => {
      const log = str(params.LogName, 'System')
      const sources =
        log === 'System'
          ? [
              'Microsoft-Windows-DistributedCOM, 10016',
              'Service Control Manager, 7023',
              'Microsoft-Windows-Kernel-Power, 41',
              'disk, 153',
              'Microsoft-Windows-Time-Service, 129',
            ]
          : [
              'Application Error, 1000',
              'Microsoft-Windows-Perflib, 1008',
              'SideBySide, 33',
              'Outlook, 1001',
              '.NET Runtime, 1026',
            ]
      const rows = sources.slice(0, r.between(1, sources.length)).map((name) => [String(r.between(1, 40)), name])
      return {
        stdout: `Errors in the ${log} log over the last ${num(params.Hours, 24)} hours:\n\n${table([['Count', 'Name'], ...rows])}`,
      }
    },
  },
  {
    key: 'win-test-connectivity',
    name: 'Test network connectivity',
    description: 'Resolves a host, pings it and tests a TCP port from the device. Useful for firewall and VPN checks.',
    category: 'Network',
    language: 'powershell',
    platforms: ['windows'],
    timeout: 120,
    parameters: [
      p('Target', 'Host or IP', 'string', { required: true, default: 'outlook.office365.com' }),
      p('Port', 'TCP port', 'number', { default: 443, required: true }),
    ],
    content: `$result = Test-NetConnection -ComputerName $env:Target -Port ([int]$env:Port) -InformationLevel Detailed
$result | Format-List ComputerName, RemoteAddress, RemotePort, InterfaceAlias, SourceAddress, PingSucceeded, TcpTestSucceeded
if (-not $result.TcpTestSucceeded) { exit 1 }`,
    failRate: 0.08,
    duration: [1200, 21000],
    output: ({ device, params, r, ok }) => {
      const target = str(params.Target, 'outlook.office365.com')
      const port = num(params.Port, 443)
      return {
        stdout: `ComputerName     : ${target}\nRemoteAddress    : 52.96.${r.between(1, 254)}.${r.between(1, 254)}\nRemotePort       : ${port}\nInterfaceAlias   : Ethernet\nSourceAddress    : ${device.last_ip}\nPingSucceeded    : ${ok ? 'True' : 'False'}\nTcpTestSucceeded : ${ok ? 'True' : 'False'}`,
        stderr: ok ? '' : `WARNING: TCP connect to (${target} : ${port}) failed`,
        exit: ok ? 0 : 1,
      }
    },
  },
  {
    key: 'win-rename-computer',
    name: 'Rename computer',
    description:
      'Renames the computer (domain-joined machines are renamed in Active Directory too) and optionally restarts.',
    category: 'Configuration',
    language: 'powershell',
    platforms: ['windows'],
    timeout: 300,
    risk: 'high',
    parameters: [
      p('NewName', 'New computer name', 'string', {
        required: true,
        description: '15 characters or fewer; letters, digits and dashes.',
      }),
      p('Restart', 'Restart afterwards', 'boolean', { default: false }),
    ],
    content: `if ($env:NewName -notmatch '^[A-Za-z0-9-]{1,15}$') { throw "Invalid computer name: $env:NewName" }
Rename-Computer -NewName $env:NewName -Force -Restart:($env:Restart -eq 'true')
Write-Output "Renamed $env:COMPUTERNAME to $env:NewName. The new name applies after a restart."`,
    failRate: 0.03,
    duration: [1500, 6000],
    output: ({ device, params, ok }) => {
      const name = str(params.NewName, 'NEW-NAME')
      if (!ok)
        return {
          stdout: '',
          stderr: psError(
            'Rename-Computer',
            `Skip computer '${short(device)}' with new name '${name}' because the new name is the same as the current name or is already in use.`,
          ),
          exit: 1,
        }
      return { stdout: `Renamed ${short(device)} to ${name}. The new name applies after a restart.` }
    },
  },
  {
    key: 'win-sfc',
    name: 'Repair system files (SFC and DISM)',
    description: 'Runs DISM RestoreHealth followed by System File Checker and summarises the CBS log.',
    category: 'Maintenance',
    language: 'powershell',
    platforms: ['windows'],
    timeout: 5400,
    content: `dism.exe /Online /Cleanup-Image /RestoreHealth /NoRestart
sfc.exe /scannow
Select-String -Path "$env:SystemRoot\\Logs\\CBS\\CBS.log" -Pattern '\\[SR\\] Cannot repair' |
    Select-Object -Last 5 | ForEach-Object { $_.Line }`,
    failRate: 0.1,
    duration: [300000, 2400000],
    output: ({ ok }) => ({
      stdout: `Deployment Image Servicing and Management tool\nVersion: 10.0.26100.5074\n\n[==========================100.0%==========================]\nThe restore operation completed successfully.\n\nBeginning system scan.  This process will take some time.\nVerification 100% complete.\n\n${ok ? 'Windows Resource Protection did not find any integrity violations.' : 'Windows Resource Protection found corrupt files but was unable to fix some of them.\nFor online repairs, details are included in the CBS log file located at windir\\Logs\\CBS\\CBS.log.'}`,
      exit: ok ? 0 : 1,
    }),
  },
  {
    key: 'win-disk-health',
    name: 'Check disk health',
    description: 'Reports physical disk health, wear and temperature from Storage Reliability Counters.',
    category: 'Hardware',
    language: 'powershell',
    platforms: ['windows'],
    timeout: 120,
    content: `Get-PhysicalDisk | ForEach-Object {
    $counters = $_ | Get-StorageReliabilityCounter
    [pscustomobject]@{
        Disk = $_.FriendlyName; Media = $_.MediaType; Health = $_.HealthStatus
        Wear = "$($counters.Wear)%"; TempC = $counters.Temperature; PowerOnHours = $counters.PowerOnHours
    }
} | Format-Table -AutoSize`,
    failRate: 0.03,
    duration: [500, 2500],
    output: ({ device, r, ok }) => {
      const model = device.device_type === 'server' ? 'DELL PERC H755 Virtual Disk' : 'Samsung SSD 990 PRO 1TB'
      return {
        stdout: table([
          ['Disk', 'Media', 'Health', 'Wear', 'TempC', 'PowerOnHours'],
          [
            model,
            'SSD',
            ok ? 'Healthy' : 'Warning',
            `${ok ? r.between(1, 12) : r.between(78, 96)}%`,
            String(r.between(31, 52)),
            fmt(r.between(900, 26_000)),
          ],
        ]),
        exit: ok ? 0 : 1,
      }
    },
  },
  {
    key: 'win-remove-old-profiles',
    name: 'Remove stale user profiles',
    description: 'Deletes local user profiles not used for N days. Skips special, loaded and excluded profiles.',
    category: 'Maintenance',
    language: 'powershell',
    platforms: ['windows'],
    timeout: 1800,
    risk: 'high',
    parameters: [
      p('Days', 'Unused for (days)', 'number', { default: 90, required: true }),
      p('Exclude', 'Accounts to keep', 'string', {
        default: 'Administrator,rmm-svc',
        description: 'Comma-separated user names.',
      }),
    ],
    content: `$cutoff = (Get-Date).AddDays(-[int]$env:Days)
$keep = $env:Exclude -split ','
Get-CimInstance Win32_UserProfile |
    Where-Object { -not $_.Special -and -not $_.Loaded -and $_.LastUseTime -lt $cutoff } |
    Where-Object { $keep -notcontains (Split-Path $_.LocalPath -Leaf) } |
    ForEach-Object { Write-Output "Removing $($_.LocalPath) (last used $($_.LastUseTime))"; $_ | Remove-CimInstance }`,
    failRate: 0.04,
    duration: [3000, 60000],
    output: ({ r, params }) => {
      const days = num(params.Days, 90)
      const names = ['former.staff', 'temp.agency', 'intern2024', 'kiosk-old', 'jmartinez']
      const removed = names.slice(0, r.between(0, 3))
      return {
        stdout: removed.length
          ? removed
              .map(
                (name) =>
                  `Removing C:\\Users\\${name} (last used ${new Date(Date.now() - (days + r.between(5, 200)) * 86_400_000).toLocaleDateString('en-US')})`,
              )
              .join('\n')
          : `No profiles unused for more than ${days} days.`,
      }
    },
  },
  {
    key: 'win-winget-install',
    name: 'Install a winget package',
    description:
      'Installs or upgrades a package with winget in machine scope, accepting source and package agreements.',
    category: 'Software',
    language: 'powershell',
    platforms: ['windows'],
    timeout: 1800,
    parameters: [
      p('PackageId', 'Package ID', 'string', {
        required: true,
        default: '7zip.7zip',
        description: 'The winget identifier, e.g. Google.Chrome.',
      }),
      p('Scope', 'Scope', 'select', { options: ['machine', 'user'], default: 'machine', required: true }),
    ],
    content: `$winget = Resolve-Path "$env:ProgramFiles\\WindowsApps\\Microsoft.DesktopAppInstaller_*_x64__8wekyb3d8bbwe\\winget.exe" | Select-Object -Last 1
& $winget install --id $env:PackageId --scope $env:Scope --silent --accept-source-agreements --accept-package-agreements
exit $LASTEXITCODE`,
    failRate: 0.07,
    duration: [15000, 240000],
    output: ({ params, r, ok }) => {
      const id = str(params.PackageId, '7zip.7zip')
      if (!ok)
        return {
          stdout: `Found ${id} [${id}] Version 25.01\nThis application is licensed to you by its owner.\nDownloading https://cdn.example-packages.net/${id.toLowerCase()}/setup.exe\nInstaller failed with exit code: 1603`,
          exit: 1603,
        }
      return {
        stdout: `Found ${id} [${id}] Version ${r.between(1, 30)}.${r.between(0, 9)}.${r.between(0, 999)}\nThis application is licensed to you by its owner.\nMicrosoft is not responsible for, nor does it grant any licenses to, third-party packages.\nSuccessfully verified installer hash\nStarting package install...\nSuccessfully installed`,
      }
    },
  },
  {
    key: 'win-asset-tag',
    name: 'Record BIOS asset tag and warranty',
    description: 'Reads the SMBIOS asset tag and serial number and stores them in the device’s custom fields.',
    category: 'Inventory',
    language: 'powershell',
    platforms: ['windows'],
    timeout: 60,
    content: `$enclosure = Get-CimInstance Win32_SystemEnclosure
$bios = Get-CimInstance Win32_BIOS
"Serial: $($bios.SerialNumber)"
"Asset tag: $($enclosure.SMBIOSAssetTag)"
if ($enclosure.SMBIOSAssetTag -and $enclosure.SMBIOSAssetTag -ne 'No Asset Tag') {
    "::rustrmm::set-field asset_tag=$($enclosure.SMBIOSAssetTag.Trim())"
}`,
    failRate: 0,
    duration: [300, 900],
    output: ({ device, r }) => {
      const tag = `${device.client_name.split(' ')[0].slice(0, 3).toUpperCase()}-${r.between(1000, 9999)}`
      return { stdout: `Serial: ${device.serial}\nAsset tag: ${tag}\n::rustrmm::set-field asset_tag=${tag}` }
    },
  },
  {
    key: 'win-restart',
    name: 'Restart computer (with warning)',
    description:
      'Warns signed-in users and restarts after a delay. Skips devices with an active RDP session when asked.',
    category: 'Power',
    language: 'powershell',
    platforms: ['windows'],
    timeout: 300,
    risk: 'high',
    parameters: [
      p('DelayMinutes', 'Delay (minutes)', 'number', { default: 5, required: true }),
      p('Message', 'Message to users', 'string', {
        default: 'Your computer will restart for maintenance. Please save your work.',
      }),
    ],
    content: `$seconds = [int]$env:DelayMinutes * 60
shutdown.exe /r /t $seconds /c "$env:Message" /d p:4:1
Write-Output "Restart scheduled in $env:DelayMinutes minute(s)."`,
    failRate: 0.02,
    duration: [300, 1000],
    output: ({ params, ok }) =>
      ok
        ? { stdout: `Restart scheduled in ${num(params.DelayMinutes, 5)} minute(s).` }
        : { stdout: '', stderr: 'A system shutdown has already been scheduled.(1190)', exit: 1190 & 0xff },
  },
  {
    key: 'win-uptime',
    name: 'Report uptime and last boot',
    description: 'Shows the last boot time, uptime and the reason for the most recent unexpected shutdown, if any.',
    category: 'Diagnostics',
    language: 'powershell',
    platforms: ['windows'],
    timeout: 60,
    content: `$os = Get-CimInstance Win32_OperatingSystem
$uptime = (Get-Date) - $os.LastBootUpTime
"Last boot: $($os.LastBootUpTime)"
"Uptime: {0}d {1}h {2}m" -f $uptime.Days, $uptime.Hours, $uptime.Minutes
Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 6008 } -MaxEvents 1 -ErrorAction SilentlyContinue |
    ForEach-Object { "Last unexpected shutdown: $($_.TimeCreated)" }`,
    failRate: 0,
    duration: [200, 800],
    output: ({ device }) => {
      const uptime = device.uptime_s ?? 3600
      const boot = new Date(Date.now() - uptime * 1000)
      return {
        stdout: `Last boot: ${boot.toLocaleString('en-US')}\nUptime: ${Math.floor(uptime / 86400)}d ${Math.floor((uptime % 86400) / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
      }
    },
  },
  {
    key: 'win-join-domain',
    name: 'Join computer to a domain',
    description: 'Joins the computer to an Active Directory domain, optionally into a specific OU, and restarts.',
    category: 'Configuration',
    language: 'powershell',
    platforms: ['windows'],
    timeout: 300,
    risk: 'high',
    parameters: [
      p('Domain', 'Domain', 'string', { required: true, default: 'corp.example.com' }),
      p('Username', 'Join account', 'string', {
        required: true,
        description: 'DOMAIN\\user with rights to join computers.',
      }),
      p('Password', 'Password', 'secret', { required: true }),
      p('OUPath', 'Organisational unit', 'string', {
        description: 'Optional distinguished name, e.g. OU=Workstations,DC=corp,DC=example,DC=com.',
      }),
      p('Restart', 'Restart afterwards', 'boolean', { default: true }),
    ],
    content: `$secure = ConvertTo-SecureString $env:Password -AsPlainText -Force
$credential = New-Object System.Management.Automation.PSCredential($env:Username, $secure)
$params = @{ DomainName = $env:Domain; Credential = $credential; Force = $true }
if ($env:OUPath) { $params.OUPath = $env:OUPath }
Add-Computer @params -Restart:($env:Restart -eq 'true')
Write-Output "Joined $env:COMPUTERNAME to $env:Domain."`,
    failRate: 0.1,
    duration: [4000, 20000],
    output: ({ device, params, ok }) =>
      ok
        ? { stdout: `Joined ${short(device)} to ${str(params.Domain, 'corp.example.com')}.` }
        : {
            stdout: '',
            stderr: psError(
              'Add-Computer',
              `Computer '${short(device)}' failed to join domain '${str(params.Domain)}' from its current workgroup 'WORKGROUP' with following error message: The user name or password is incorrect.`,
            ),
            exit: 1,
          },
  },
  {
    key: 'cmd-winsock-reset',
    name: 'Reset network stack',
    description: 'Resets Winsock and the TCP/IP stack and flushes DNS. A restart is required afterwards.',
    category: 'Network',
    language: 'cmd',
    platforms: ['windows'],
    timeout: 120,
    risk: 'high',
    content: `@echo off
netsh winsock reset
netsh int ip reset
ipconfig /flushdns
echo Network stack reset on %COMPUTERNAME%. Restart to complete.`,
    failRate: 0.01,
    duration: [1200, 4000],
    output: ({ device }) => ({
      stdout: `\nSucessfully reset the Winsock Catalog.\nYou must restart the computer in order to complete the reset.\n\nResetting Global, OK!\nResetting Interface, OK!\nRestart the computer to complete this action.\n\nWindows IP Configuration\n\nSuccessfully flushed the DNS Resolver Cache.\nNetwork stack reset on ${short(device)}. Restart to complete.`,
    }),
  },
  {
    key: 'cmd-ipconfig',
    name: 'Show IP configuration',
    description: 'Prints the full IP configuration, routing table and ARP cache.',
    category: 'Network',
    language: 'cmd',
    platforms: ['windows'],
    timeout: 60,
    content: `@echo off
ipconfig /all
route print -4
arp -a`,
    failRate: 0,
    duration: [300, 900],
    output: ({ device }) => {
      const prefix = device.last_ip?.split('.').slice(0, 3).join('.') ?? '10.0.0'
      return {
        stdout: `\nWindows IP Configuration\n\n   Host Name . . . . . . . . . . . . : ${short(device)}\n   Primary Dns Suffix  . . . . . . . : ${device.domain ?? ''}\n   Node Type . . . . . . . . . . . . : Hybrid\n\nEthernet adapter Ethernet:\n\n   Connection-specific DNS Suffix  . : ${device.domain ?? 'lan'}\n   Description . . . . . . . . . . . : Intel(R) Ethernet Connection (17) I219-LM\n   DHCP Enabled. . . . . . . . . . . : Yes\n   IPv4 Address. . . . . . . . . . . : ${device.last_ip}(Preferred)\n   Subnet Mask . . . . . . . . . . . : 255.255.255.0\n   Default Gateway . . . . . . . . . : ${prefix}.1\n   DNS Servers . . . . . . . . . . . : ${prefix}.10\n                                       ${prefix}.11`,
      }
    },
  },
  // ---------------------------------------------------------------- Linux & macOS
  {
    key: 'linux-update-lists',
    name: 'Refresh package lists',
    description: 'Refreshes the package index with apt or dnf and reports how many upgrades are pending.',
    category: 'Updates',
    language: 'bash',
    platforms: ['linux'],
    timeout: 600,
    content: `#!/usr/bin/env bash
set -euo pipefail
if command -v apt-get >/dev/null; then
  apt-get update -qq
  pending=$(apt list --upgradable 2>/dev/null | tail -n +2 | wc -l)
elif command -v dnf >/dev/null; then
  dnf -q makecache
  pending=$(dnf -q check-update | grep -c '^[a-zA-Z0-9]' || true)
else
  echo "No supported package manager found" >&2; exit 3
fi
echo "Package lists refreshed: $pending upgrade(s) pending."`,
    failRate: 0.04,
    duration: [4000, 40000],
    output: ({ device, r, ok }) => {
      if (!ok)
        return {
          stdout: '',
          stderr: device.os_name.includes('Red Hat')
            ? "Error: Failed to download metadata for repo 'rhel-9-for-x86_64-baseos-rpms': Cannot download repomd.xml: Curl error (6): Could not resolve host"
            : 'E: Could not get lock /var/lib/apt/lists/lock. It is held by process 1832 (apt-get)',
          exit: 100,
        }
      return { stdout: `Package lists refreshed: ${r.between(0, 48)} upgrade(s) pending.` }
    },
  },
  {
    key: 'linux-security-updates',
    name: 'Apply security updates',
    description:
      'Installs security updates non-interactively (unattended-upgrade or dnf --security) and optionally restarts if required.',
    category: 'Updates',
    language: 'bash',
    platforms: ['linux'],
    timeout: 3600,
    risk: 'high',
    parameters: [p('Reboot', 'Restart if required', 'boolean', { default: false })],
    content: `#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
if command -v unattended-upgrade >/dev/null; then
  unattended-upgrade -v
elif command -v dnf >/dev/null; then
  dnf -y upgrade --security
fi
if [ -f /var/run/reboot-required ] || needs-restarting -r >/dev/null 2>&1; [ $? -eq 1 ]; then
  echo "A restart is required."
  [ "\${Reboot:-false}" = "true" ] && shutdown -r +2 "Restarting to finish security updates"
fi`,
    failRate: 0.06,
    duration: [30000, 600000],
    output: ({ device, params, r, ok }) => {
      if (!ok)
        return {
          stdout: 'Checking for security updates...',
          stderr:
            'dpkg: error processing package linux-image-6.8.0-88-generic (--configure):\n installed linux-image-6.8.0-88-generic package post-installation script subprocess returned error exit status 1',
          exit: 1,
        }
      const pkgs = device.os_name.includes('Red Hat')
        ? ['openssl-3.2.2-6.el9_6.1', 'kernel-5.14.0-570.32.1.el9_6', 'glibc-2.34-168.el9_6.23']
        : [
            'openssl 3.0.13-0ubuntu3.6',
            'linux-image-6.8.0-88-generic',
            'libc6 2.39-0ubuntu8.6',
            'sudo 1.9.15p5-3ubuntu5.24.04.1',
          ]
      const count = r.between(1, pkgs.length)
      return {
        stdout: [
          `Checking for security updates...`,
          ...pkgs.slice(0, count).map((pkg) => `Installing ${pkg}`),
          `${count} security update(s) installed.`,
          'A restart is required.',
          bool(params.Reboot)
            ? 'Restart scheduled in 2 minutes.'
            : 'Restart not requested; leaving it to the maintenance window.',
        ].join('\n'),
      }
    },
  },
  {
    key: 'nix-disk-usage',
    name: 'Check disk usage',
    description: 'Lists filesystems above a usage threshold and the largest directories under / to help free space.',
    category: 'Diagnostics',
    language: 'sh',
    platforms: ['linux', 'macos'],
    timeout: 300,
    parameters: [p('ThresholdPct', 'Warn above (%)', 'number', { default: 85, required: true })],
    content: `#!/bin/sh
set -eu
threshold=\${ThresholdPct:-85}
df -hP -x tmpfs -x devtmpfs 2>/dev/null || df -hP
echo
df -P | awk -v t="$threshold" 'NR>1 { gsub("%","",$5); if ($5+0 > t) { print "WARNING: " $6 " is " $5 "% full"; bad=1 } } END { exit bad }'`,
    failRate: 0,
    duration: [300, 4000],
    output: ({ device, params }) => {
      const used = Math.round(device.disk_pct ?? 40)
      const threshold = num(params.ThresholdPct, 85)
      const root = device.os_family === 'macos' ? '/System/Volumes/Data' : '/'
      const rows = [
        ['Filesystem', 'Size', 'Used', 'Avail', 'Use%', 'Mounted on'],
        [
          device.os_family === 'macos' ? '/dev/disk3s5' : '/dev/mapper/vg0-root',
          '466G',
          `${Math.round((466 * used) / 100)}G`,
          `${Math.round((466 * (100 - used)) / 100)}G`,
          `${used}%`,
          root,
        ],
        [
          device.os_family === 'macos' ? '/dev/disk3s6' : '/dev/sda1',
          device.os_family === 'macos' ? '466G' : '1.1G',
          device.os_family === 'macos' ? '2.0G' : '6.2M',
          device.os_family === 'macos' ? '210G' : '1.1G',
          '1%',
          device.os_family === 'macos' ? '/System/Volumes/VM' : '/boot/efi',
        ],
      ]
      const warn = used > threshold
      return {
        stdout: `${table(rows).replace(/\n-+.*\n/, '\n')}\n${warn ? `\nWARNING: ${root} is ${used}% full` : `\nAll filesystems below ${threshold}%.`}`,
        exit: warn ? 1 : 0,
      }
    },
  },
  {
    key: 'linux-restart-unit',
    name: 'Restart a systemd unit',
    description: 'Restarts a systemd unit and prints its status and the last 20 journal lines.',
    category: 'Services',
    language: 'bash',
    platforms: ['linux'],
    timeout: 300,
    parameters: [p('Unit', 'Unit name', 'string', { required: true, default: 'nginx.service' })],
    content: `#!/usr/bin/env bash
set -euo pipefail
systemctl restart "$Unit"
systemctl --no-pager --lines=0 status "$Unit"
journalctl -u "$Unit" -n 20 --no-pager`,
    failRate: 0.05,
    duration: [800, 6000],
    output: ({ device, params, r, ok }) => {
      const unit = str(params.Unit, 'nginx.service')
      if (!ok) return { stdout: '', stderr: `Failed to restart ${unit}: Unit ${unit} not found.`, exit: 5 }
      return {
        stdout: `● ${unit} - ${unit.replace('.service', '')} daemon\n     Loaded: loaded (/usr/lib/systemd/system/${unit}; enabled; preset: enabled)\n     Active: active (running) since ${new Date().toUTCString()}; 1s ago\n   Main PID: ${r.between(1200, 98000)} (${unit.replace('.service', '')})\n      Tasks: ${r.between(3, 40)} (limit: 18980)\n     Memory: ${r.between(6, 220)}.${r.between(0, 9)}M\n\n${stamp()} ${device.hostname} systemd[1]: Stopping ${unit}...\n${stamp()} ${device.hostname} systemd[1]: Started ${unit}.`,
      }
    },
  },
  {
    key: 'linux-journal-vacuum',
    name: 'Vacuum the systemd journal',
    description: 'Rotates the journal and trims archived logs to a size limit.',
    category: 'Maintenance',
    language: 'bash',
    platforms: ['linux'],
    timeout: 300,
    parameters: [
      p('MaxSize', 'Keep at most', 'select', { options: ['200M', '500M', '1G'], default: '500M', required: true }),
    ],
    content: `#!/usr/bin/env bash
set -euo pipefail
journalctl --disk-usage
journalctl --rotate
journalctl --vacuum-size="$MaxSize"
journalctl --disk-usage`,
    failRate: 0,
    duration: [500, 5000],
    output: ({ params, r }) => {
      const before = r.between(800, 4200)
      return {
        stdout: `Archived and active journals take up ${(before / 1000).toFixed(1)}G in the file system.\nVacuuming done, freed ${(Math.max(0, before - 480) / 1000).toFixed(1)}G of archived journals from /var/log/journal/${r.hex(32)}.\nArchived and active journals take up ${str(params.MaxSize, '500M')} in the file system.`,
      }
    },
  },
  {
    key: 'linux-failed-units',
    name: 'List failed systemd units',
    description: 'Lists units in a failed state with their last log lines.',
    category: 'Diagnostics',
    language: 'bash',
    platforms: ['linux'],
    timeout: 60,
    content: `#!/usr/bin/env bash
failed=$(systemctl --failed --no-legend --plain | awk '{print $1}')
if [ -z "$failed" ]; then echo "0 failed units."; exit 0; fi
for unit in $failed; do
  echo "== $unit"; journalctl -u "$unit" -n 5 --no-pager
done
exit 1`,
    failRate: 0.15,
    duration: [300, 1500],
    output: ({ device, ok }) =>
      ok
        ? { stdout: '0 failed units.' }
        : {
            stdout: `== fwupd-refresh.service\n${stamp()} ${device.hostname} systemd[1]: fwupd-refresh.service: Main process exited, code=exited, status=1/FAILURE\n${stamp()} ${device.hostname} systemd[1]: Failed to start fwupd-refresh.service - Refresh fwupd metadata and update motd.`,
            exit: 1,
          },
  },
  {
    key: 'nix-serial',
    name: 'Record hardware serial number',
    description:
      'Reads the hardware serial number (dmidecode or system_profiler) and stores it as the asset tag when none is set.',
    category: 'Inventory',
    language: 'sh',
    platforms: ['linux', 'macos'],
    timeout: 60,
    content: `#!/bin/sh
if [ "$(uname)" = "Darwin" ]; then
  serial=$(system_profiler SPHardwareDataType | awk -F': ' '/Serial Number/ {print $2}')
else
  serial=$(dmidecode -s system-serial-number 2>/dev/null)
fi
echo "Serial number: $serial"
echo "::rustrmm::set-field asset_tag=$serial"`,
    failRate: 0,
    duration: [300, 1200],
    output: ({ device }) => ({
      stdout: `Serial number: ${device.serial}\n::rustrmm::set-field asset_tag=${device.serial}`,
    }),
  },
  {
    key: 'linux-docker-prune',
    name: 'Prune old Docker data',
    description: 'Removes stopped containers, dangling images and unused build cache older than a set age.',
    category: 'Maintenance',
    language: 'bash',
    platforms: ['linux'],
    timeout: 900,
    parameters: [p('UntilHours', 'Older than (hours)', 'number', { default: 168, required: true })],
    content: `#!/usr/bin/env bash
set -euo pipefail
command -v docker >/dev/null || { echo "Docker is not installed."; exit 0; }
docker system df
docker system prune --force --filter "until=\${UntilHours}h"
docker builder prune --force --filter "until=\${UntilHours}h"`,
    failRate: 0.02,
    duration: [2000, 60000],
    output: ({ device, r }) => {
      if (!device.tags.includes('render') && !device.tags.includes('wms') && !device.tags.includes('network'))
        return { stdout: 'Docker is not installed.' }
      return {
        stdout: `TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE\nImages          ${r.between(8, 40)}        ${r.between(2, 8)}         ${r.between(4, 30)}.${r.between(0, 9)}GB    ${r.between(1, 12)}.${r.between(0, 9)}GB (${r.between(20, 70)}%)\nContainers      ${r.between(3, 12)}         ${r.between(1, 4)}         ${r.between(10, 900)}MB     0B\nDeleted Containers:\n${r.hex(64)}\n\nTotal reclaimed space: ${r.between(1, 9)}.${r.between(0, 99)}GB`,
      }
    },
  },
  {
    key: 'linux-ssh-audit',
    name: 'Audit SSH server configuration',
    description:
      'Checks sshd for root login, password authentication and weak ciphers and reports a pass/fail summary.',
    category: 'Security',
    language: 'bash',
    platforms: ['linux'],
    timeout: 60,
    content: `#!/usr/bin/env bash
config=$(sshd -T 2>/dev/null)
fail=0
check() { if echo "$config" | grep -qi "^$1 $2$"; then echo "PASS  $1 $2"; else echo "FAIL  $1 (expected $2)"; fail=1; fi; }
check permitrootlogin no
check passwordauthentication no
check x11forwarding no
check maxauthtries 4
exit $fail`,
    failRate: 0.3,
    duration: [200, 800],
    output: ({ ok }) => ({
      stdout: [
        'PASS  permitrootlogin no',
        ok ? 'PASS  passwordauthentication no' : 'FAIL  passwordauthentication (expected no)',
        'PASS  x11forwarding no',
        ok ? 'PASS  maxauthtries 4' : 'FAIL  maxauthtries (expected 4)',
      ].join('\n'),
      exit: ok ? 0 : 1,
    }),
  },
  {
    key: 'mac-flush-dns',
    name: 'Flush DNS cache (macOS)',
    description: 'Flushes the macOS DNS cache and restarts mDNSResponder.',
    category: 'Network',
    language: 'zsh',
    platforms: ['macos'],
    timeout: 60,
    content: `#!/bin/zsh
dscacheutil -flushcache
killall -HUP mDNSResponder
echo "DNS cache flushed on $(scutil --get ComputerName)."`,
    failRate: 0,
    duration: [200, 700],
    output: ({ device }) => ({ stdout: `DNS cache flushed on ${device.hostname}.` }),
  },
  {
    key: 'mac-softwareupdate',
    name: 'Check for macOS updates',
    description: 'Lists available macOS and Rapid Security Response updates without installing them.',
    category: 'Updates',
    language: 'zsh',
    platforms: ['macos'],
    timeout: 900,
    content: `#!/bin/zsh
softwareupdate --list --all 2>&1`,
    failRate: 0.03,
    duration: [8000, 60000],
    output: ({ device, r }) => {
      const pending = r.chance(0.6)
      return {
        stdout: pending
          ? `Software Update Tool\n\nFinding available software\nSoftware Update found the following new or updated software:\n* Label: macOS ${device.os_name.includes('26') ? 'Tahoe 26.1.1' : 'Sequoia 15.7.3'}-${r.between(10, 99)}\n\tTitle: macOS ${device.os_name.includes('26') ? 'Tahoe 26.1.1' : 'Sequoia 15.7.3'}, Version: ${device.os_name.includes('26') ? '26.1.1' : '15.7.3'}, Size: ${r.between(900, 3400)}K, Recommended: YES, Action: restart,`
          : 'Software Update Tool\n\nFinding available software\nNo new software available.',
      }
    },
  },
  {
    key: 'mac-filevault',
    name: 'Check FileVault status',
    description: 'Reports FileVault encryption status and whether a personal recovery key is escrowed.',
    category: 'Security',
    language: 'zsh',
    platforms: ['macos'],
    timeout: 60,
    content: `#!/bin/zsh
fdesetup status
fdesetup haspersonalrecoverykey
status=$(fdesetup isactive && echo On || echo Off)
echo "::rustrmm::set-field bitlocker_status=$status"`,
    failRate: 0,
    duration: [200, 600],
    output: ({ device }) => ({
      stdout: `${device.sim.encrypted ? 'FileVault is On.' : 'FileVault is Off.'}\n${device.sim.encrypted ? 'true' : 'false'}\n::rustrmm::set-field bitlocker_status=${device.sim.encrypted ? 'On' : 'Off'}`,
    }),
  },
  {
    key: 'mac-clear-caches',
    name: 'Clear user caches (macOS)',
    description: 'Clears ~/Library/Caches for every local user, keeping caches younger than a day.',
    category: 'Maintenance',
    language: 'zsh',
    platforms: ['macos'],
    timeout: 600,
    content: `#!/bin/zsh
for home in /Users/*; do
  [[ -d "$home/Library/Caches" ]] || continue
  before=$(du -sk "$home/Library/Caches" | cut -f1)
  find "$home/Library/Caches" -mindepth 1 -mtime +1 -delete 2>/dev/null
  after=$(du -sk "$home/Library/Caches" | cut -f1)
  echo "$(basename $home): freed $(( (before - after) / 1024 )) MB"
done`,
    failRate: 0.02,
    duration: [2000, 30000],
    output: ({ device, r }) => ({
      stdout: [`${user(device)}: freed ${r.between(120, 4800)} MB`, `Shared: freed ${r.between(0, 40)} MB`].join('\n'),
    }),
  },
  {
    key: 'py-cert-expiry',
    name: 'Check TLS certificate expiry',
    description: 'Connects to a host from the device and reports how many days remain on its TLS certificate.',
    category: 'Diagnostics',
    language: 'python',
    platforms: ['windows', 'linux', 'macos'],
    timeout: 120,
    parameters: [
      p('Host', 'Host', 'string', { required: true, default: 'portal.example.com' }),
      p('Port', 'Port', 'number', { default: 443, required: true }),
      p('WarnDays', 'Warn when fewer than (days)', 'number', { default: 30, required: true }),
    ],
    content: `#!/usr/bin/env python3
import os, socket, ssl, sys
from datetime import datetime, timezone

host, port = os.environ["Host"], int(os.environ.get("Port", "443"))
warn = int(os.environ.get("WarnDays", "30"))
ctx = ssl.create_default_context()
with socket.create_connection((host, port), timeout=10) as sock:
    with ctx.wrap_socket(sock, server_hostname=host) as tls:
        cert = tls.getpeercert()
expires = datetime.strptime(cert["notAfter"], "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
days = (expires - datetime.now(timezone.utc)).days
issuer = dict(x[0] for x in cert["issuer"]).get("organizationName", "unknown")
print(f"{host}:{port} expires {expires:%Y-%m-%d} ({days} days), issued by {issuer}")
print(f"::rustrmm::set-field cert_days_left={days}")
sys.exit(1 if days < warn else 0)`,
    failRate: 0.08,
    duration: [400, 3000],
    output: ({ params, r, ok }) => {
      const host = str(params.Host, 'portal.example.com')
      const port = num(params.Port, 443)
      if (!ok)
        return {
          stdout: '',
          stderr: `Traceback (most recent call last):\n  File "run.py", line 10, in <module>\n    with socket.create_connection((host, port), timeout=10) as sock:\nTimeoutError: timed out`,
          exit: 1,
        }
      const days = r.between(9, 340)
      const expires = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
      return {
        stdout: `${host}:${port} expires ${expires} (${days} days), issued by Let's Encrypt\n::rustrmm::set-field cert_days_left=${days}`,
        exit: days < num(params.WarnDays, 30) ? 1 : 0,
      }
    },
  },
  {
    key: 'py-top-processes',
    name: 'Top processes by memory',
    description: 'Lists the processes using the most memory and CPU, without needing extra Python packages.',
    category: 'Diagnostics',
    language: 'python',
    platforms: ['linux', 'macos'],
    timeout: 60,
    parameters: [p('Count', 'Number of processes', 'number', { default: 10, required: true })],
    content: `#!/usr/bin/env python3
import os, subprocess
count = int(os.environ.get("Count", "10"))
out = subprocess.run(["ps", "-eo", "pid,pcpu,pmem,rss,comm", "--sort=-rss"], capture_output=True, text=True).stdout
for line in out.splitlines()[: count + 1]:
    print(line)`,
    failRate: 0,
    duration: [200, 900],
    output: ({ device, params, r }) => {
      const procs = device.tags.includes('render')
        ? ['blender', 'python3', 'dockerd', 'systemd-journald', 'sshd']
        : device.os_family === 'macos'
          ? ['WindowServer', 'Google Chrome Helper', 'Microsoft Teams', 'mds_stores', 'Finder']
          : ['java', 'postgres', 'node', 'dockerd', 'systemd-journald', 'sshd']
      const rows = procs
        .slice(0, Math.min(num(params.Count, 10), procs.length))
        .map((name) => [
          String(r.between(400, 98000)),
          (r.between(0, 400) / 10).toFixed(1),
          (r.between(5, 180) / 10).toFixed(1),
          String(r.between(40_000, 4_200_000)),
          name,
        ])
      return { stdout: table([['PID', '%CPU', '%MEM', 'RSS', 'COMMAND'], ...rows]).replace(/\n-+.*\n/, '\n') }
    },
  },
  {
    key: 'pwsh-system-summary',
    name: 'System summary (cross-platform)',
    description: 'A PowerShell 7 script that prints OS, CPU, memory and disk on Windows, Linux and macOS.',
    category: 'Inventory',
    language: 'pwsh',
    platforms: ['windows', 'linux', 'macos'],
    timeout: 120,
    content: `$ErrorActionPreference = 'Stop'
[pscustomobject]@{
    Host     = [System.Net.Dns]::GetHostName()
    OS       = [System.Runtime.InteropServices.RuntimeInformation]::OSDescription
    Arch     = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
    CPUs     = [Environment]::ProcessorCount
    Uptime   = [TimeSpan]::FromMilliseconds([Environment]::TickCount64).ToString('d\\.hh\\:mm')
    PSVersion = $PSVersionTable.PSVersion.ToString()
} | Format-List`,
    failRate: 0.05,
    duration: [500, 2500],
    output: ({ device, ok }) =>
      ok
        ? {
            stdout: `Host      : ${device.hostname}\nOS        : ${device.os_name}\nArch      : ${device.arch === 'aarch64' ? 'Arm64' : 'X64'}\nCPUs      : ${device.device_type === 'server' ? 24 : 12}\nUptime    : ${Math.floor((device.uptime_s ?? 0) / 86400)}.${String(Math.floor(((device.uptime_s ?? 0) % 86400) / 3600)).padStart(2, '0')}:12\nPSVersion : 7.5.4`,
          }
        : {
            stdout: '',
            stderr:
              device.os_family === 'windows'
                ? 'The system cannot find the file specified: C:\\Program Files\\PowerShell\\7\\pwsh.exe'
                : '/usr/bin/pwsh: No such file or directory',
            exit: 127,
          },
  },
]

export function libraryScript(key: string | null | undefined): LibraryScript | undefined {
  return key ? LIBRARY.find((script) => script.key === key) : undefined
}

/** Fallback output for custom scripts the library doesn't know. */
export function genericOutput({ device, r, ok }: OutputContext, name: string): ScriptOutput {
  if (!ok) {
    return {
      stdout: `[${stamp()}] Starting “${name}” on ${device.hostname}`,
      stderr:
        device.os_family === 'windows'
          ? psError(
              'Invoke-Command',
              'The operation has timed out while waiting for a response from the remote service.',
            )
          : 'curl: (28) Failed to connect to deploy.internal port 443 after 10002 ms: Timeout was reached',
      exit: device.os_family === 'windows' ? 1 : 28,
    }
  }
  return {
    stdout: [
      `[${stamp()}] Starting “${name}” on ${device.hostname}`,
      `[${stamp()}] Checked ${r.between(3, 40)} items`,
      `[${stamp()}] Completed successfully in ${(r.between(4, 90) / 10).toFixed(1)}s`,
    ].join('\n'),
  }
}
