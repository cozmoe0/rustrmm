/*
 * Deterministic Phase 5 demo data: the built-in library, a few custom scripts with history,
 * variables, groups, policies, custom fields, approvals and jobs with run history.
 */
import type {
  Client,
  CustomField,
  JobSchedule,
  JobTargetType,
  JobTrigger,
  ParameterValue,
  RuleDocument,
  ScriptParameter,
  Site,
} from '@/lib/api/types'
import type { MockDevice } from './devices'
import { hashString, rng } from './devices'
import {
  countResults,
  emptyAutomation,
  nextRunAt,
  resolveTarget,
  syntheticResults,
  targetLabel,
  type MockAutomation,
  type MockJob,
  type MockRun,
  type MockScript,
  type MockScriptVersion,
  type World,
} from './automation-model'
import { LIBRARY } from './script-library'
import { sha256Hex } from './sha256'

interface SeedUser {
  id: string
  name: string
}

const DAY = 86_400_000
const HOUR = 3_600_000
const iso = (ms: number) => new Date(ms).toISOString()

export function seedAutomation(input: {
  clients: Client[]
  sites: Site[]
  devices: MockDevice[]
  users: SeedUser[]
  now?: number
}): MockAutomation {
  const now = input.now ?? Date.now()
  const r = rng(20261118)
  const id = () => {
    const hex = r.hex(32)
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-b${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  }
  const automation = emptyAutomation()
  automation.settings.four_eyes_jobs = true
  const world: World = { automation, devices: input.devices, clients: input.clients, sites: input.sites }
  const person = (name: string) => input.users.find((user) => user.name === name) ?? { id: null, name }
  const client = (prefix: string) => input.clients.find((item) => item.name.startsWith(prefix))!
  const site = (clientPrefix: string, name: string) =>
    input.sites.find((item) => item.client_id === client(clientPrefix).id && item.name === name)!
  const device = (hostname: string) =>
    input.devices.find((item) => item.hostname === hostname && item.status === 'active')

  // ---------------------------------------------------------------- custom fields
  const field = (
    key: string,
    name: string,
    type: CustomField['type'],
    scope: CustomField['scope'],
    extra: Partial<CustomField> = {},
  ): CustomField => ({
    id: id(),
    key,
    name,
    description: '',
    type,
    options: [],
    scope,
    script_writable: false,
    created_at: iso(now - 90 * DAY),
    ...extra,
  })
  automation.customFields = [
    field('asset_tag', 'Asset tag', 'text', 'device', {
      script_writable: true,
      description: 'Physical asset label. Written by the “Record BIOS asset tag” script.',
    }),
    field('warranty_end', 'Warranty ends', 'date', 'device', { description: 'Manufacturer warranty end date.' }),
    field('patch_ring', 'Patch ring', 'select', 'device', {
      options: ['Pilot', 'Broad', 'Deferred'],
      description: 'Which wave receives updates first.',
    }),
    field('reboot_required', 'Restart required', 'boolean', 'device', {
      script_writable: true,
      description: 'Set by the pending-restart check.',
    }),
    field('bitlocker_status', 'Disk encryption', 'select', 'device', {
      options: ['On', 'Off', 'Suspended'],
      script_writable: true,
    }),
    field('last_maintenance', 'Last maintenance', 'date', 'device', { script_writable: true }),
    field('local_admin_count', 'Local admins', 'number', 'device', { script_writable: true }),
    field('backup_agent', 'Backup agent installed', 'boolean', 'device'),
    field('contract_tier', 'Contract tier', 'select', 'client', { options: ['Platinum', 'Gold', 'Silver'] }),
    field('account_manager', 'Account manager', 'text', 'client'),
    field('msa_renewal', 'MSA renewal', 'date', 'client'),
    field('isp', 'Internet provider', 'text', 'site'),
    field('circuit_id', 'Circuit ID', 'text', 'site'),
    field('alarm_contact', 'After-hours contact', 'text', 'site'),
  ]
  const setValue = (
    scope: 'device' | 'client' | 'site',
    target: string,
    key: string,
    value: ParameterValue,
    by = 'Avery Chen',
    at = now - r.between(1, 60) * DAY,
  ) => {
    automation.customValues[scope][target] ??= {}
    automation.customValues[scope][target][key] = { value, updated_at: iso(at), updated_by: by }
  }
  for (const item of input.devices.filter((entry) => entry.status === 'active')) {
    const dr = rng(hashString(`${item.hostname}:fields`))
    if (dr.chance(0.7))
      setValue(
        'device',
        item.id,
        'asset_tag',
        `${item.client_name.split(' ')[0].slice(0, 3).toUpperCase()}-${dr.between(1000, 9999)}`,
        dr.chance(0.5) ? 'script' : 'Sam Rivera',
      )
    if (item.manufacturer !== 'QEMU' && item.manufacturer !== 'VMware, Inc.' && item.device_type !== 'virtual') {
      setValue('device', item.id, 'warranty_end', iso(now + dr.between(-120, 1000) * DAY).slice(0, 10), 'Jordan Patel')
    }
    setValue(
      'device',
      item.id,
      'patch_ring',
      item.tags.includes('vip') || item.tags.includes('domain-controller')
        ? 'Deferred'
        : dr.chance(0.18)
          ? 'Pilot'
          : 'Broad',
      'Jordan Patel',
    )
    if (item.os_family === 'windows') {
      setValue('device', item.id, 'reboot_required', item.sim.pendingReboot, 'script', now - dr.between(1, 20) * HOUR)
      setValue(
        'device',
        item.id,
        'bitlocker_status',
        item.sim.encrypted ? 'On' : 'Off',
        'script',
        now - dr.between(1, 6) * DAY,
      )
      setValue(
        'device',
        item.id,
        'local_admin_count',
        item.sim.extraAdmin ? 4 : 3,
        'script',
        now - dr.between(1, 6) * DAY,
      )
    }
    if (item.device_type === 'server' || item.device_type === 'virtual')
      setValue('device', item.id, 'backup_agent', dr.chance(0.85), 'Sam Rivera')
    if (dr.chance(0.5))
      setValue('device', item.id, 'last_maintenance', iso(now - dr.between(1, 9) * DAY).slice(0, 10), 'script')
  }
  const tiers = ['Platinum', 'Gold', 'Gold', 'Silver', 'Gold', 'Silver', 'Platinum', 'Silver']
  const managers = [
    'Jordan Patel',
    'Sam Rivera',
    'Riley Brooks',
    'Sam Rivera',
    'Jordan Patel',
    'Morgan Lee',
    'Jordan Patel',
    'Morgan Lee',
  ]
  input.clients.forEach((entry, index) => {
    setValue('client', entry.id, 'contract_tier', tiers[index % tiers.length])
    setValue('client', entry.id, 'account_manager', managers[index % managers.length])
    setValue('client', entry.id, 'msa_renewal', iso(now + (40 + index * 37) * DAY).slice(0, 10))
  })
  const isps = ['Comcast Business', 'Lumen Fiber', 'AT&T Dedicated Internet', 'Spectrum Business', 'Ziply Fiber']
  input.sites.forEach((entry, index) => {
    setValue('site', entry.id, 'isp', isps[index % isps.length])
    if (index % 2 === 0)
      setValue('site', entry.id, 'circuit_id', `${['CBUS', 'LMN', 'ATT', 'SPEC'][index % 4]}-${100000 + index * 7919}`)
    if (index % 3 === 0)
      setValue('site', entry.id, 'alarm_contact', `(${200 + index}) 555-01${String(index).padStart(2, '0')}`)
  })

  // ---------------------------------------------------------------- scripts
  const version = (
    number: number,
    content: string,
    parameters: ScriptParameter[],
    notes: string,
    by: { id: string | null; name: string },
    at: number,
    approvedBy?: { name: string; at: number },
  ): MockScriptVersion => ({
    version: number,
    content,
    parameters,
    content_sha256: sha256Hex(content),
    notes,
    created_by_name: by.name,
    created_by_id: by.id,
    created_at: iso(at),
    approved_by_name: approvedBy?.name ?? null,
    approved_at: approvedBy ? iso(approvedBy.at) : null,
  })
  const rustrmm = { id: null, name: 'RustRMM' }
  for (const entry of LIBRARY) {
    const created = now - (180 + (hashString(entry.key) % 120)) * DAY
    const history = entry.history ?? []
    const versions: MockScriptVersion[] = history.map((past, index) =>
      version(
        index + 1,
        past.content,
        past.parameters ?? entry.parameters ?? [],
        past.notes,
        rustrmm,
        created + index * 30 * DAY,
        { name: 'RustRMM', at: created + index * 30 * DAY },
      ),
    )
    const updated = created + history.length * 30 * DAY
    versions.push(
      version(
        history.length + 1,
        entry.content,
        entry.parameters ?? [],
        history.length ? 'Report results in a custom field' : 'Initial version',
        rustrmm,
        updated,
        { name: 'RustRMM', at: updated },
      ),
    )
    automation.scripts.push({
      id: id(),
      key: entry.key,
      name: entry.name,
      description: entry.description,
      category: entry.category,
      language: entry.language,
      platforms: entry.platforms,
      timeout_secs: entry.timeout,
      risk: entry.risk ?? 'normal',
      builtin: true,
      archived: false,
      approved_version: versions.length,
      versions,
      created_by_name: 'RustRMM',
      created_by_id: null,
      created_at: iso(created),
      updated_at: iso(updated),
    })
  }

  const sam = person('Sam Rivera')
  const jordan = person('Jordan Patel')
  const avery = person('Avery Chen')
  const riley = person('Riley Brooks')

  const custom = (spec: {
    name: string
    description: string
    category: string
    language: MockScript['language']
    platforms: MockScript['platforms']
    timeout: number
    risk?: MockScript['risk']
    by: { id: string | null; name: string }
    created: number
    versions: {
      content: string
      parameters?: ScriptParameter[]
      notes: string
      approvedBy?: string
      daysAfter: number
      by?: { id: string | null; name: string }
    }[]
  }): MockScript => {
    const versions = spec.versions.map((entry, index) => {
      const at = spec.created + entry.daysAfter * DAY
      return version(
        index + 1,
        entry.content,
        entry.parameters ?? [],
        entry.notes,
        entry.by ?? spec.by,
        at,
        entry.approvedBy ? { name: entry.approvedBy, at: at + 6 * HOUR } : undefined,
      )
    })
    const approved = [...versions].reverse().find((entry) => entry.approved_by_name)
    const script: MockScript = {
      id: id(),
      key: null,
      name: spec.name,
      description: spec.description,
      category: spec.category,
      language: spec.language,
      platforms: spec.platforms,
      timeout_secs: spec.timeout,
      risk: spec.risk ?? 'normal',
      builtin: false,
      archived: false,
      approved_version: approved?.version ?? null,
      versions,
      created_by_name: spec.by.name,
      created_by_id: spec.by.id,
      created_at: iso(spec.created),
      updated_at: versions[versions.length - 1].created_at,
    }
    automation.scripts.push(script)
    return script
  }

  const bridgeParams = (withChannel: boolean): ScriptParameter[] => [
    {
      name: 'BridgeVersion',
      label: 'Bridge version',
      description: 'Imaging bridge release to install.',
      type: 'select',
      required: true,
      default: withChannel ? '4.3.0' : '4.2.1',
      options: withChannel ? ['4.2.1', '4.3.0'] : ['4.2.1'],
    },
    {
      name: 'LicenseKey',
      label: 'License key',
      description: 'Vendor license key; masked in output.',
      type: 'secret',
      required: true,
      default: null,
    },
    ...(withChannel
      ? [
          {
            name: 'RestartImaging',
            label: 'Restart imaging service',
            description: '',
            type: 'boolean' as const,
            required: false,
            default: true,
          },
        ]
      : []),
  ]
  const share = '\\\\NWD-FS01\\Deploy\\ImagingBridge'
  const bridgeV1 = `$ErrorActionPreference = 'Stop'
$installer = "${share}\\ImagingBridge-$env:BridgeVersion.msi"
Write-Output "Installing imaging bridge $env:BridgeVersion from $installer"
Start-Process msiexec.exe -ArgumentList "/i \`"$installer\`" /qn LICENSEKEY=$env:LicenseKey" -Wait
Write-Output 'Imaging bridge installed.'`
  const bridgeV2 = `$ErrorActionPreference = 'Stop'
$installer = "${share}\\ImagingBridge-$env:BridgeVersion.msi"
$log = "$env:TEMP\\ImagingBridge-install.log"
Write-Output "Installing imaging bridge $env:BridgeVersion from $installer"
$process = Start-Process msiexec.exe -ArgumentList "/i \`"$installer\`" /qn /l*v \`"$log\`" LICENSEKEY=$env:LicenseKey" -Wait -PassThru
if ($process.ExitCode -ne 0) {
    Get-Content $log -Tail 20
    exit $process.ExitCode
}
Write-Output 'Imaging bridge installed.'`
  const bridgeV3 = `${bridgeV2}
if ($env:RestartImaging -eq 'true') {
    Restart-Service -Name 'DexisImagingSvc' -ErrorAction SilentlyContinue
    Write-Output 'Imaging service restarted.'
}`
  const bridge = custom({
    name: 'Deploy imaging bridge (Northwind)',
    description:
      'Installs the X-ray imaging bridge used by operatory PCs at Northwind Dental. Pulls the MSI from the clinic file server.',
    category: 'Software',
    language: 'powershell',
    platforms: ['windows'],
    timeout: 1200,
    by: sam,
    created: now - 75 * DAY,
    versions: [
      {
        content: bridgeV1,
        parameters: bridgeParams(false),
        notes: 'Initial version',
        approvedBy: 'Jordan Patel',
        daysAfter: 0,
      },
      {
        content: bridgeV2,
        parameters: bridgeParams(false),
        notes: 'Write a verbose MSI log and surface the tail on failure',
        approvedBy: 'Jordan Patel',
        daysAfter: 21,
      },
      {
        content: bridgeV3,
        parameters: bridgeParams(true),
        notes: 'Support bridge 4.3.0 and optionally restart the imaging service',
        daysAfter: 63,
      },
    ],
  })

  const dms = custom({
    name: 'Harbor DMS cache reset',
    description:
      'Clears the document management client cache and re-registers the Outlook add-in for Harbor & Pine Legal.',
    category: 'Software',
    language: 'powershell',
    platforms: ['windows'],
    timeout: 300,
    by: jordan,
    created: now - 140 * DAY,
    versions: [
      {
        content: `Get-Process -Name 'DMSClient' -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item "$env:LOCALAPPDATA\\DMS\\Cache\\*" -Recurse -Force -ErrorAction SilentlyContinue
Write-Output 'DMS cache cleared.'`,
        notes: 'Initial version',
        approvedBy: 'Avery Chen',
        daysAfter: 0,
      },
      {
        content: `Get-Process -Name 'DMSClient', 'OUTLOOK' -ErrorAction SilentlyContinue | Stop-Process -Force
foreach ($profile in Get-ChildItem 'C:\\Users' -Directory) {
    Remove-Item "$($profile.FullName)\\AppData\\Local\\DMS\\Cache\\*" -Recurse -Force -ErrorAction SilentlyContinue
}
& "$env:ProgramFiles\\DMS\\Client\\RegisterAddin.exe" /silent
Write-Output 'DMS cache cleared and Outlook add-in re-registered for all profiles.'`,
        notes: 'Clear every profile and re-register the Outlook add-in',
        approvedBy: 'Avery Chen',
        daysAfter: 30,
      },
    ],
  })

  custom({
    name: 'Summit WMS log shipping check',
    description:
      'Verifies the warehouse management system is shipping logs to the central collector and reports the backlog.',
    category: 'Diagnostics',
    language: 'bash',
    platforms: ['linux'],
    timeout: 120,
    by: riley,
    created: now - 4 * DAY,
    versions: [
      {
        content: `#!/usr/bin/env bash
set -euo pipefail
backlog=$(find /var/log/wms/outbox -type f -mmin +15 | wc -l)
systemctl is-active --quiet fluent-bit || { echo "fluent-bit is not running" >&2; exit 2; }
echo "Outbox backlog: $backlog file(s) older than 15 minutes"
[ "$backlog" -lt 50 ]`,
        notes: 'Initial version',
        daysAfter: 0,
      },
    ],
  })

  const baselineParams: ScriptParameter[] = [
    {
      name: 'TimeZoneId',
      label: 'Time zone',
      description: 'Windows time zone ID.',
      type: 'select',
      required: true,
      default: 'Pacific Standard Time',
      options: ['Pacific Standard Time', 'Mountain Standard Time', 'Central Standard Time', 'Eastern Standard Time'],
    },
    {
      name: 'InstallChrome',
      label: 'Install Chrome',
      description: '',
      type: 'boolean',
      required: false,
      default: true,
    },
  ]
  const baselineV3 = `$ErrorActionPreference = 'Stop'
Set-TimeZone -Id $env:TimeZoneId
powercfg /change standby-timeout-ac 0
Set-ItemProperty 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\Personalization' -Name NoLockScreenCamera -Value 1
if ($env:InstallChrome -eq 'true') { winget install --id Google.Chrome --scope machine --silent --accept-package-agreements }
Write-Output "Baseline applied to $env:COMPUTERNAME"`
  custom({
    name: 'New workstation baseline',
    description:
      'Applies the Lumen IT workstation baseline: time zone, power settings, lock screen policy and standard apps.',
    category: 'Configuration',
    language: 'powershell',
    platforms: ['windows'],
    timeout: 1800,
    risk: 'high',
    by: avery,
    created: now - 200 * DAY,
    versions: [
      {
        content: baselineV3.replace(/\nif \(\$env:InstallChrome[^\n]+/, ''),
        parameters: baselineParams.slice(0, 1),
        notes: 'Initial version',
        approvedBy: 'Jordan Patel',
        daysAfter: 0,
      },
      {
        content: baselineV3.replace('powercfg /change standby-timeout-ac 0\n', ''),
        parameters: baselineParams,
        notes: 'Optionally install Chrome',
        approvedBy: 'Jordan Patel',
        daysAfter: 60,
      },
      {
        content: baselineV3,
        parameters: baselineParams,
        notes: 'Disable sleep on AC power',
        approvedBy: 'Jordan Patel',
        daysAfter: 120,
      },
      {
        content: `${baselineV3}
Enable-BitLocker -MountPoint 'C:' -EncryptionMethod XtsAes256 -TpmProtector -SkipHardwareTest -ErrorAction SilentlyContinue
"::rustrmm::set-field last_maintenance=$(Get-Date -Format yyyy-MM-dd)"`,
        parameters: baselineParams,
        notes: 'Turn on BitLocker with a TPM protector',
        daysAfter: 196,
      },
    ],
  })

  custom({
    name: 'Map finance share',
    description: 'Maps the finance department share for the signed-in user with a stored service credential.',
    category: 'Configuration',
    language: 'powershell',
    platforms: ['windows'],
    timeout: 120,
    by: sam,
    created: now - 33 * DAY,
    versions: [
      {
        content: `$secure = ConvertTo-SecureString $env:SharePassword -AsPlainText -Force
$credential = New-Object PSCredential($env:ShareUser, $secure)
New-PSDrive -Name $env:DriveLetter -PSProvider FileSystem -Root $env:SharePath -Credential $credential -Persist -Scope Global
Write-Output "Mapped $($env:DriveLetter): to $env:SharePath"`,
        parameters: [
          {
            name: 'SharePath',
            label: 'Share path',
            description: '',
            type: 'string',
            required: true,
            default: '\\\\MCU-DC01\\Finance',
          },
          {
            name: 'DriveLetter',
            label: 'Drive letter',
            description: '',
            type: 'select',
            required: true,
            default: 'F',
            options: ['F', 'G', 'P', 'S'],
          },
          {
            name: 'ShareUser',
            label: 'Service account',
            description: '',
            type: 'string',
            required: true,
            default: 'MERIDIAN\\svc-finance',
          },
          { name: 'SharePassword', label: 'Password', description: '', type: 'secret', required: true, default: null },
        ],
        notes: 'Initial version',
        approvedBy: 'Avery Chen',
        daysAfter: 1,
      },
    ],
  })

  const scriptByKey = (key: string) => automation.scripts.find((script) => script.key === key)!

  // ---------------------------------------------------------------- variables
  const variable = (
    scope: 'global' | 'client' | 'site',
    scopeId: string | null,
    name: string,
    value: string,
    secret: boolean,
    description: string,
    by = 'Avery Chen',
    days = 20,
  ) => {
    automation.variables.push({
      id: id(),
      scope,
      scope_id: scopeId,
      name,
      value,
      secret,
      description,
      updated_at: iso(now - days * DAY),
      updated_by_name: by,
    })
  }
  variable(
    'global',
    null,
    'SupportEmail',
    'help@lumen-it.example',
    false,
    'Shown in user-facing messages and notifications.',
  )
  variable(
    'global',
    null,
    'ProxyUrl',
    'http://proxy.lumen-it.example:3128',
    false,
    'Outbound proxy for scripts that download installers.',
    'Jordan Patel',
    44,
  )
  variable(
    'global',
    null,
    'DeployShareUser',
    'LUMEN\\svc-deploy',
    false,
    'Account used to read the installer share.',
    'Jordan Patel',
    80,
  )
  variable(
    'global',
    null,
    'DeploySharePassword',
    'Wint3r-Harbor-42!',
    true,
    'Password for the installer share account.',
    'Jordan Patel',
    80,
  )
  variable(
    'global',
    null,
    'TeamsWebhookUrl',
    'https://hooks.example.com/services/T000/B000/XXXX',
    true,
    'Incoming webhook for script notifications.',
    'Avery Chen',
    12,
  )
  variable(
    'client',
    client('Northwind').id,
    'DentrixServer',
    'NWD-FS01',
    false,
    'Practice management server.',
    'Sam Rivera',
    64,
  )
  variable(
    'client',
    client('Northwind').id,
    'ImagingLicenseKey',
    'DXB-4410-2297-AA81',
    true,
    'Imaging bridge license.',
    'Sam Rivera',
    63,
  )
  variable(
    'client',
    client('Harbor').id,
    'DmsServer',
    'HPL-DMS01.harborpine.law',
    false,
    'Document management server.',
    'Jordan Patel',
    140,
  )
  variable(
    'client',
    client('Summit').id,
    'WmsApiToken',
    'wms_live_8c1f2e7a9b0d4c3e',
    true,
    'Read-only API token for the WMS health endpoint.',
    'Riley Brooks',
    5,
  )
  variable(
    'client',
    client('Meridian').id,
    'ComplianceContact',
    'security@meridiancu.example',
    false,
    'Receives encryption and patch compliance reports.',
    'Jordan Patel',
    30,
  )
  variable(
    'client',
    client('Meridian').id,
    'ProxyUrl',
    'http://proxy.meridiancu.example:8080',
    false,
    'Overrides the global proxy for Meridian devices.',
    'Jordan Patel',
    30,
  )
  variable(
    'site',
    site('Northwind', 'Main Clinic').id,
    'PrinterIp',
    '10.12.1.40',
    false,
    'Front-desk laser printer.',
    'Sam Rivera',
    18,
  )
  variable(
    'site',
    site('Summit', 'Dock 4 Warehouse').id,
    'LabelPrinter',
    'ZT411-DOCK4',
    false,
    'Zebra label printer queue name.',
    'Riley Brooks',
    9,
  )

  // ---------------------------------------------------------------- groups
  const group = (
    name: string,
    description: string,
    kind: 'static' | 'dynamic',
    options: { rules?: RuleDocument; ids?: string[]; clientId?: string | null; by?: string; days?: number },
  ) => {
    const created = {
      id: id(),
      name,
      description,
      kind,
      client_id: options.clientId ?? null,
      rules: options.rules ?? null,
      static_ids: options.ids ?? [],
      created_by_name: options.by ?? 'Jordan Patel',
      updated_at: iso(now - (options.days ?? 10) * DAY),
    }
    automation.groups.push(created)
    return created
  }
  const winServers = group('Windows servers', 'Every Windows server and server VM across all clients.', 'dynamic', {
    rules: {
      match: 'all',
      conditions: [
        { field: 'os_family', op: 'eq', value: 'windows' },
        { field: 'device_type', op: 'in', value: ['server', 'virtual'] },
      ],
    },
    days: 40,
  })
  const winWorkstations = group('Windows workstations', 'Desktops and laptops running Windows.', 'dynamic', {
    rules: {
      match: 'all',
      conditions: [
        { field: 'os_family', op: 'eq', value: 'windows' },
        { field: 'device_type', op: 'in', value: ['workstation', 'laptop'] },
      ],
    },
    days: 40,
  })
  const linux = group('Linux fleet', 'All Linux servers and appliances.', 'dynamic', {
    rules: { match: 'all', conditions: [{ field: 'os_family', op: 'eq', value: 'linux' }] },
    days: 70,
  })
  group('Low disk space', 'Devices whose fullest fixed volume has less than 15% free.', 'dynamic', {
    rules: { match: 'all', conditions: [{ field: 'disk_free_pct', op: 'lt', value: 15 }] },
    by: 'Sam Rivera',
    days: 8,
  })
  group('Windows 10 end of life', 'Still on Windows 10 — plan upgrades or ESU.', 'dynamic', {
    rules: {
      match: 'any',
      conditions: [
        { field: 'os_name', op: 'contains', value: 'Windows 10' },
        { field: 'tag', op: 'eq', value: 'win10-eol' },
      ],
    },
    days: 25,
  })
  group('Domain controllers', 'Matched by tag or the -DCnn naming convention.', 'dynamic', {
    rules: {
      match: 'any',
      conditions: [
        { field: 'tag', op: 'eq', value: 'domain-controller' },
        { field: 'hostname', op: 'matches', value: '-DC\\d+$' },
      ],
    },
    days: 55,
  })
  group('Needs attention', 'Workstations that are unhealthy or waiting for a restart.', 'dynamic', {
    rules: {
      match: 'all',
      conditions: [
        { field: 'os_family', op: 'eq', value: 'windows' },
        {
          match: 'any',
          conditions: [
            { field: 'health_score', op: 'lt', value: 70 },
            { field: 'pending_reboot', op: 'eq', value: true },
            { field: 'custom.bitlocker_status', op: 'eq', value: 'Off' },
          ],
        },
      ],
    },
    by: 'Sam Rivera',
    days: 3,
  })
  group('Pilot ring', 'Devices that receive updates and script changes first.', 'dynamic', {
    rules: { match: 'all', conditions: [{ field: 'custom.patch_ring', op: 'eq', value: 'Pilot' }] },
    days: 15,
  })
  const vipIds = input.devices
    .filter((entry) => entry.status === 'active' && entry.tags.includes('vip'))
    .map((entry) => entry.id)
  group('VIP devices', 'Partners and owners — call before any disruptive change.', 'static', {
    ids: vipIds,
    by: 'Avery Chen',
    days: 60,
  })
  group('Northwind front desk', 'Reception PCs at both Northwind clinics.', 'static', {
    ids: ['NWD-FRONT-01', 'NWD-FRONT-02', 'NWD-ES-FRONT'].map((host) => device(host)?.id).filter(Boolean) as string[],
    clientId: client('Northwind').id,
    by: 'Sam Rivera',
    days: 30,
  })

  // ---------------------------------------------------------------- policies
  const kiosk = device('SF-TAC-KIOSK')
  automation.policies = [
    {
      id: id(),
      name: 'MSP baseline',
      description:
        'Defaults for every managed device: standard agent intervals, remote tools on and a weekly temp cleanup.',
      version: 7,
      document: {
        agent: { heartbeat_secs: 30, metrics_secs: 60, inventory_minutes: 240 },
        remote_access: { shell: true, files: true, system: true, power: true, desktop: true, desktop_consent: 'never', desktop_banner: true },
        tasks: [
          {
            id: 'weekly-temp-cleanup',
            name: 'Weekly temp cleanup',
            script_id: scriptByKey('win-clear-temp').id,
            parameters: { MinAgeDays: 7, IncludeUpdateCache: true },
            cron: '0 3 * * 0',
            timezone: 'America/Chicago',
            enabled: true,
            offline_wait_minutes: 720,
          },
        ],
      },
      assignments: [{ id: id(), target_type: 'global', target_id: null, priority: 0 }],
      updated_at: iso(now - 12 * DAY),
      updated_by_name: 'Avery Chen',
    },
    {
      id: id(),
      name: 'Servers — maintenance window',
      description: 'Faster metrics, nightly Defender updates, and no remote power actions outside the change process.',
      version: 4,
      document: {
        agent: { metrics_secs: 30 },
        remote_access: { power: false },
        tasks: [
          {
            id: 'nightly-defender-update',
            name: 'Nightly Defender signatures',
            script_id: scriptByKey('win-defender-update').id,
            parameters: {},
            cron: '0 1 * * *',
            timezone: 'UTC',
            enabled: true,
            offline_wait_minutes: 120,
          },
        ],
      },
      assignments: [{ id: id(), target_type: 'group', target_id: winServers.id, priority: 10 }],
      updated_at: iso(now - 30 * DAY),
      updated_by_name: 'Jordan Patel',
    },
    {
      id: id(),
      name: 'Meridian compliance',
      description: 'Credit union requirements: tighter heartbeat, no file transfers, daily encryption check.',
      version: 3,
      document: {
        agent: { heartbeat_secs: 20 },
        remote_access: { files: false, desktop_view_only: true, desktop_consent: 'always' },
        tasks: [
          {
            id: 'daily-bitlocker-check',
            name: 'Daily BitLocker check',
            script_id: scriptByKey('win-bitlocker-status').id,
            parameters: {},
            cron: '30 6 * * *',
            timezone: 'America/Chicago',
            enabled: true,
            offline_wait_minutes: 240,
          },
        ],
      },
      assignments: [{ id: id(), target_type: 'client', target_id: client('Meridian').id, priority: 0 }],
      updated_at: iso(now - 21 * DAY),
      updated_by_name: 'Jordan Patel',
    },
    {
      id: id(),
      name: 'Linux patch Tuesday',
      description: 'Security updates for Linux every Tuesday at 04:00 site time.',
      version: 2,
      document: {
        tasks: [
          {
            id: 'linux-security-updates',
            name: 'Apply security updates',
            script_id: scriptByKey('linux-security-updates').id,
            parameters: { Reboot: false },
            cron: '0 4 * * 2',
            timezone: 'America/Los_Angeles',
            enabled: true,
            offline_wait_minutes: 360,
          },
        ],
      },
      assignments: [{ id: id(), target_type: 'group', target_id: linux.id, priority: 20 }],
      updated_at: iso(now - 50 * DAY),
      updated_by_name: 'Riley Brooks',
    },
    {
      id: id(),
      name: 'Remote staff',
      description: 'Laptops on home connections: slower heartbeat and inventory to save bandwidth. Users are always asked before remote desktop.',
      version: 2,
      document: { agent: { heartbeat_secs: 60, inventory_minutes: 720 }, remote_access: { desktop_consent: 'always', consent_timeout_secs: 15 } },
      assignments: [{ id: id(), target_type: 'site', target_id: site('Atlas', 'Remote Staff').id, priority: 0 }],
      updated_at: iso(now - 9 * DAY),
      updated_by_name: 'Sam Rivera',
    },
    {
      id: id(),
      name: 'Kiosk lockdown',
      description: 'Public kiosks: no shell, file or screen access, ever.',
      version: 3,
      document: { remote_access: { shell: false, files: false, desktop: false }, agent: { inventory_minutes: 1440 } },
      assignments: kiosk ? [{ id: id(), target_type: 'device', target_id: kiosk.id, priority: 0 }] : [],
      updated_at: iso(now - 70 * DAY),
      updated_by_name: 'Riley Brooks',
    },
  ]

  // ---------------------------------------------------------------- jobs & runs
  const addRun = (job: MockJob, at: number, trigger: JobTrigger): MockRun => {
    const run: MockRun = {
      id: id(),
      job_id: job.id,
      status: 'completed',
      trigger,
      started_at: iso(at),
      finished_at: null,
      synthetic: true,
      counts: { total: 0, pending: 0, waiting_offline: 0, running: 0, succeeded: 0, failed: 0 },
    }
    automation.runs.push(run)
    const results = syntheticResults(world, run)
    run.counts = countResults(results)
    const last = Math.max(
      at + 2000,
      ...results.map((result) => (result.finished_at ? new Date(result.finished_at).getTime() : 0)),
    )
    run.finished_at = iso(last)
    return run
  }
  const addJob = (spec: {
    name: string
    script: MockScript
    target: { type: JobTargetType; ids: string[] }
    schedule: JobSchedule
    status: MockJob['status']
    by: { id: string | null; name: string }
    created: number
    params?: Record<string, ParameterValue>
    approvedBy?: string | null
    offline?: number
    concurrency?: number
    policy?: { policy_id: string; task_id: string }
    label?: string
  }): MockJob => {
    const current = spec.script.versions[spec.script.versions.length - 1]
    const job: MockJob = {
      id: id(),
      name: spec.name,
      script_id: spec.script.id,
      script_version: spec.script.approved_version ?? current.version,
      content_sha256: (
        spec.script.versions.find((entry) => entry.version === (spec.script.approved_version ?? current.version)) ??
        current
      ).content_sha256,
      parameters:
        spec.params ??
        Object.fromEntries(
          current.parameters.filter((param) => param.default !== null).map((param) => [param.name, param.default]),
        ),
      target: { ...spec.target, label: spec.label ?? targetLabel(world, spec.target) },
      schedule: spec.schedule,
      next_run_at: spec.status === 'scheduled' ? nextRunAt(spec.schedule, new Date(now)) : null,
      status: spec.status,
      offline_wait_minutes: spec.offline ?? 60,
      concurrency: spec.concurrency ?? 25,
      timeout_secs: spec.script.timeout_secs,
      created_by_name: spec.by.name,
      created_by_id: spec.by.id,
      created_at: iso(spec.created),
      approved_by_name: spec.approvedBy ?? null,
      deleted: false,
      policy: spec.policy,
    }
    automation.jobs.push(job)
    return job
  }

  // Weekly cleanup on all Windows workstations (cron, with history).
  const weekly = addJob({
    name: 'Weekly temp cleanup — workstations',
    script: scriptByKey('win-clear-temp'),
    target: { type: 'group', ids: [winWorkstations.id] },
    schedule: { type: 'cron', cron: '0 3 * * 0', timezone: 'America/Chicago' },
    status: 'scheduled',
    by: jordan,
    created: now - 60 * DAY,
    approvedBy: 'Avery Chen',
    params: { MinAgeDays: 7, IncludeUpdateCache: true },
    offline: 720,
  })
  for (const past of nextCronRunsBefore('0 3 * * 0', 'America/Chicago', now, 6)) addRun(weekly, past, 'schedule')

  const nightly = addJob({
    name: 'Defender signatures — servers',
    script: scriptByKey('win-defender-update'),
    target: { type: 'group', ids: [winServers.id] },
    schedule: { type: 'cron', cron: '0 1 * * *', timezone: 'UTC' },
    status: 'scheduled',
    by: avery,
    created: now - 45 * DAY,
    offline: 120,
  })
  for (const past of nextCronRunsBefore('0 1 * * *', 'UTC', now, 10)) addRun(nightly, past, 'schedule')

  const reboot = addJob({
    name: 'Pending restart check',
    script: scriptByKey('win-pending-reboot'),
    target: { type: 'client', ids: [client('Northwind').id, client('Cedar').id] },
    schedule: { type: 'cron', cron: '*/20 * * * *', timezone: 'UTC' },
    status: 'scheduled',
    by: sam,
    created: now - 12 * DAY,
    offline: 0,
    label: '2 clients',
  })
  for (const past of nextCronRunsBefore('*/20 * * * *', 'UTC', now, 6)) addRun(reboot, past, 'schedule')

  const spooler = addJob({
    name: 'Spooler reset — Harbor & Pine',
    script: scriptByKey('win-spooler-reset'),
    target: { type: 'client', ids: [client('Harbor').id] },
    schedule: { type: 'now' },
    status: 'completed',
    by: sam,
    created: now - 2 * DAY - 3 * HOUR,
    offline: 60,
  })
  addRun(spooler, now - 2 * DAY - 3 * HOUR, 'manual')

  const disk = addJob({
    name: 'Linux disk audit',
    script: scriptByKey('nix-disk-usage'),
    target: { type: 'group', ids: [linux.id] },
    schedule: { type: 'once', at: iso(now - 3 * DAY - 5 * HOUR) },
    status: 'completed',
    by: riley,
    created: now - 4 * DAY,
    params: { ThresholdPct: 85 },
  })
  addRun(disk, now - 3 * DAY - 5 * HOUR, 'schedule')

  const assets = addJob({
    name: 'Asset tag collection',
    script: scriptByKey('win-asset-tag'),
    target: { type: 'client', ids: [client('Summit').id, client('Meridian').id] },
    schedule: { type: 'now' },
    status: 'completed',
    by: jordan,
    created: now - 6 * DAY,
    approvedBy: 'Avery Chen',
    label: '2 clients',
  })
  addRun(assets, now - 6 * DAY + 4 * HOUR, 'manual')

  const dmsJob = addJob({
    name: 'DMS cache reset — partners',
    script: dms,
    target: {
      type: 'devices',
      ids: ['HPL-LT-PARTNER1', 'HPL-LT-PARTNER2', 'HPL-WS-011']
        .map((host) => device(host)?.id)
        .filter(Boolean) as string[],
    },
    schedule: { type: 'now' },
    status: 'completed',
    by: jordan,
    created: now - 9 * DAY,
  })
  addRun(dmsJob, now - 9 * DAY, 'manual')
  addRun(dmsJob, now - 9 * DAY + 2 * HOUR, 'rerun')

  const imaging = addJob({
    name: 'Imaging bridge 4.2.1 rollout',
    script: bridge,
    target: { type: 'site', ids: [site('Northwind', 'Imaging Lab').id, site('Northwind', 'Main Clinic').id] },
    schedule: { type: 'now' },
    status: 'completed',
    by: sam,
    created: now - 30 * DAY,
    params: { BridgeVersion: '4.2.1', LicenseKey: 'DXB-4410-2297-AA81' },
    label: '2 sites',
  })
  addRun(imaging, now - 30 * DAY, 'manual')

  // Policy-created job.
  const baseline = automation.policies[0]
  const policyJob = addJob({
    name: 'MSP baseline · Weekly temp cleanup',
    script: scriptByKey('win-clear-temp'),
    target: { type: 'client', ids: input.clients.map((entry) => entry.id) },
    schedule: { type: 'cron', cron: '0 3 * * 0', timezone: 'America/Chicago' },
    status: 'scheduled',
    by: { id: null, name: 'Policy: MSP baseline' },
    created: now - 80 * DAY,
    params: { MinAgeDays: 7, IncludeUpdateCache: true },
    offline: 720,
    policy: { policy_id: baseline.id, task_id: 'weekly-temp-cleanup' },
    label: 'Policy · MSP baseline',
  })
  for (const past of nextCronRunsBefore('0 3 * * 0', 'America/Chicago', now, 4)) addRun(policyJob, past, 'policy')

  // Approved then run.
  const restart = addJob({
    name: 'Restart dispatch PCs after driver update',
    script: scriptByKey('win-restart'),
    target: {
      type: 'devices',
      ids: ['SF-DISPATCH-01', 'SF-DISPATCH-02'].map((host) => device(host)?.id).filter(Boolean) as string[],
    },
    schedule: { type: 'now' },
    status: 'completed',
    by: riley,
    created: now - 1 * DAY - 6 * HOUR,
    approvedBy: 'Avery Chen',
    params: { DelayMinutes: 10, Message: 'Restarting to finish the label printer driver update. Save your work.' },
  })
  addRun(restart, now - 1 * DAY - 5 * HOUR, 'manual')

  // Pending approvals (requested by other people so the signed-in owner can decide).
  const linuxUpdates = addJob({
    name: 'Security updates — Summit Linux',
    script: scriptByKey('linux-security-updates'),
    target: { type: 'client', ids: [client('Summit').id] },
    schedule: { type: 'once', at: iso(nextOnDay(now, 2, 22)) },
    status: 'pending_approval',
    by: riley,
    created: now - 5 * HOUR,
    params: { Reboot: true },
    offline: 240,
  })
  const wuReset = addJob({
    name: 'Reset Windows Update — Records Annex',
    script: scriptByKey('win-reset-wu'),
    target: { type: 'site', ids: [site('Harbor', 'Records Annex').id] },
    schedule: { type: 'now' },
    status: 'pending_approval',
    by: sam,
    created: now - 50 * 60_000,
  })
  const profiles = addJob({
    name: 'Remove stale profiles — Oakline lab',
    script: scriptByKey('win-remove-old-profiles'),
    target: { type: 'site', ids: [site('Oakline', 'Learning Center').id] },
    schedule: { type: 'cron', cron: '0 22 * * 5', timezone: 'America/New_York' },
    status: 'pending_approval',
    by: sam,
    created: now - 26 * HOUR,
    params: { Days: 60, Exclude: 'Administrator,rmm-svc,student' },
  })
  const rdp = addJob({
    name: 'Enable RDP — Atlas CAD stations',
    script: scriptByKey('win-enable-rdp'),
    target: {
      type: 'devices',
      ids: ['ATLAS-CAD-03', 'ATLAS-CAD-07'].map((host) => device(host)?.id).filter(Boolean) as string[],
    },
    schedule: { type: 'now' },
    status: 'rejected',
    by: sam,
    created: now - 3 * DAY,
  })
  addJob({
    name: 'Component cleanup — Meridian tellers',
    script: scriptByKey('win-component-cleanup'),
    target: {
      type: 'devices',
      ids: ['MCU-LV-TELLER1', 'MCU-MT-TELLER1'].map((host) => device(host)?.id).filter(Boolean) as string[],
    },
    schedule: { type: 'once', at: iso(now - 2 * DAY) },
    status: 'cancelled',
    by: jordan,
    created: now - 4 * DAY,
  })

  automation.approvals = [
    {
      id: id(),
      job_id: linuxUpdates.id,
      requested_by_name: riley.name,
      requested_by_id: riley.id,
      requested_at: linuxUpdates.created_at,
      status: 'pending',
      decided_by_name: null,
      decided_at: null,
      comment: null,
    },
    {
      id: id(),
      job_id: wuReset.id,
      requested_by_name: sam.name,
      requested_by_id: sam.id,
      requested_at: wuReset.created_at,
      status: 'pending',
      decided_by_name: null,
      decided_at: null,
      comment: null,
    },
    {
      id: id(),
      job_id: profiles.id,
      requested_by_name: sam.name,
      requested_by_id: sam.id,
      requested_at: profiles.created_at,
      status: 'pending',
      decided_by_name: null,
      decided_at: null,
      comment: null,
    },
    {
      id: id(),
      job_id: rdp.id,
      requested_by_name: sam.name,
      requested_by_id: sam.id,
      requested_at: rdp.created_at,
      status: 'rejected',
      decided_by_name: 'Jordan Patel',
      decided_at: iso(now - 3 * DAY + 40 * 60_000),
      comment: 'Use the RD Gateway instead of opening RDP on the CAD workstations.',
    },
    {
      id: id(),
      job_id: restart.id,
      requested_by_name: riley.name,
      requested_by_id: riley.id,
      requested_at: restart.created_at,
      status: 'approved',
      decided_by_name: 'Avery Chen',
      decided_at: iso(now - 1 * DAY - 5 * HOUR - 10 * 60_000),
      comment: 'Approved — dispatch confirmed the window.',
    },
    {
      id: id(),
      job_id: assets.id,
      requested_by_name: jordan.name,
      requested_by_id: jordan.id,
      requested_at: assets.created_at,
      status: 'approved',
      decided_by_name: 'Avery Chen',
      decided_at: iso(now - 6 * DAY + 3 * HOUR),
      comment: null,
    },
  ]

  // A run in progress: the simulator picks it up and streams results.
  const audit = addJob({
    name: 'BitLocker audit — Meridian',
    script: scriptByKey('win-bitlocker-status'),
    target: { type: 'client', ids: [client('Meridian').id] },
    schedule: { type: 'now' },
    status: 'running',
    by: jordan,
    created: now - 25_000,
    offline: 60,
  })
  const liveRun: MockRun = {
    id: id(),
    job_id: audit.id,
    status: 'running',
    trigger: 'manual',
    started_at: iso(now - 25_000),
    finished_at: null,
    synthetic: false,
    counts: { total: 0, pending: 0, waiting_offline: 0, running: 0, succeeded: 0, failed: 0 },
  }
  const auditScript = scriptByKey('win-bitlocker-status')
  liveRun.results = resolveTarget(world, audit.target).map((entry) => {
    const seed = hashString(`${liveRun.id}:${entry.id}`)
    const base = {
      device_id: entry.id,
      hostname: entry.hostname,
      os_family: entry.os_family,
      client_name: entry.client_name,
      seed,
      ok: !rng(seed).chance(0.04),
      exit_code: null,
      finished_at: null,
      duration_ms: null,
      error: null,
    }
    if (!auditScript.platforms.includes(entry.os_family))
      return { ...base, status: 'skipped' as const, started_at: null, error: 'Script runs on Windows only' }
    if (!entry.online)
      return { ...base, status: 'waiting_offline' as const, started_at: null, wait_until: now + 60 * 60_000 }
    return { ...base, status: 'pending' as const, started_at: null }
  })
  liveRun.counts = countResults(liveRun.results)
  automation.runs.push(liveRun)

  return automation
}

/** The last `count` cron fire times before `now`, oldest first. */
function nextCronRunsBefore(cron: string, timeZone: string, now: number, count: number): number[] {
  // Walk forward from a start point far enough back to cover `count` occurrences.
  const spans: Record<string, number> = { '0 3 * * 0': 7 * DAY, '0 1 * * *': DAY, '*/20 * * * *': 20 * 60_000 }
  const span = spans[cron] ?? DAY
  const runs: number[] = []
  let from = new Date(now - span * (count + 1))
  for (let guard = 0; guard < count * 4 && runs.length < count + 1; guard += 1) {
    const next = nextRunAt({ type: 'cron', cron, timezone: timeZone }, from)
    if (!next) break
    const at = new Date(next).getTime()
    if (at >= now) break
    runs.push(at)
    from = new Date(at)
  }
  return runs.slice(-count)
}

/** The next given weekday (0 = Sunday) at `hour`:00 local time. */
function nextOnDay(now: number, weekday: number, hour: number): number {
  const date = new Date(now)
  date.setHours(hour, 0, 0, 0)
  const delta = (weekday - date.getDay() + 7) % 7 || 7
  date.setDate(date.getDate() + delta)
  return date.getTime()
}
