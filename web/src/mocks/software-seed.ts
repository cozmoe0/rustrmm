/*
 * Seeds the software library (winget, Homebrew, apt and dnf packages plus three uploaded installers)
 * and a history of deployments: finished ones, one scheduled, one waiting for patch windows and one in
 * flight that the simulator completes.
 */
import type { DeploymentAction, DeploymentSchedule, JobTargetInput, SoftwareFileUpload, User } from '@/lib/api/types'
import { resolveTarget, targetLabel, type World } from './automation-model'
import { hashString, rng } from './devices'
import type { MockDeployment, MockDeploymentResult, MockPackage } from './patching-model'
import { planDeployment } from './software-model'

const DAY = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString()

function sha(seed: string): string {
  const r = rng(hashString(seed))
  return r.hex(64)
}

export function seedSoftware(input: { world: World; now: number; id: () => string; users: User[] }): {
  packages: MockPackage[]
  files: SoftwareFileUpload[]
  deployments: MockDeployment[]
} {
  const { world, now, id } = input
  const files: SoftwareFileUpload[] = [
    { file_id: id(), sha256: sha('dentrix'), size_bytes: 48_211_968, file_name: 'DentrixConnector-7.5.24.msi' },
    { file_id: id(), sha256: sha('teller'), size_bytes: 6_291_456, file_name: 'TellerCaptureConfig-11.2.0.msi' },
    { file_id: id(), sha256: sha('veeam'), size_bytes: 283_115_520, file_name: 'VeeamAgentWindows_6.3.2.1205.exe' },
  ]
  const at = (days: number) => iso(now - days * DAY)
  const pkg = (spec: Omit<MockPackage, 'id' | 'created_by_name' | 'created_at' | 'updated_at'> & { by?: string; days: number }): MockPackage => {
    const { by, days, ...rest } = spec
    return { id: id(), ...rest, created_by_name: by ?? 'Sam Rivera', created_at: at(days + 20), updated_at: at(days) }
  }
  const packages: MockPackage[] = [
    pkg({ name: '7-Zip', publisher: 'Igor Pavlov', description: 'File archiver with a high compression ratio.', platforms: ['windows'], source: { type: 'winget', id: '7zip.7zip' }, detection: { type: 'software_name', pattern: '7-Zip*', min_version: '25.01' }, days: 30 }),
    pkg({ name: 'Google Chrome', publisher: 'Google LLC', description: 'Chrome for Business, machine-wide install.', platforms: ['windows'], source: { type: 'winget', id: 'Google.Chrome' }, detection: { type: 'software_name', pattern: 'Google Chrome', min_version: '142.0' }, days: 12 }),
    pkg({ name: 'Mozilla Firefox', publisher: 'Mozilla', description: 'Firefox for teams that need it next to Chrome.', platforms: ['windows'], source: { type: 'winget', id: 'Mozilla.Firefox' }, detection: { type: 'software_name', pattern: 'Mozilla Firefox*', min_version: '146.0' }, days: 4 }),
    pkg({ name: 'Notepad++', publisher: 'Notepad++ Team', description: 'Source code editor.', platforms: ['windows'], source: { type: 'winget', id: 'Notepad++.Notepad++' }, detection: { type: 'software_name', pattern: 'Notepad++*', min_version: '8.8.9' }, days: 6 }),
    pkg({ name: 'Zoom Workplace', publisher: 'Zoom Communications, Inc.', description: 'Meetings client, per-machine.', platforms: ['windows'], source: { type: 'winget', id: 'Zoom.Zoom' }, detection: { type: 'software_name', pattern: 'Zoom Workplace*', min_version: '6.6' }, days: 21 }),
    pkg({ name: 'Adobe Acrobat Reader', publisher: 'Adobe', description: 'PDF reader (64-bit).', platforms: ['windows'], source: { type: 'winget', id: 'Adobe.Acrobat.Reader.64-bit' }, detection: { type: 'software_name', pattern: 'Adobe Acrobat*' }, days: 45 }),
    pkg({ name: 'VLC media player', publisher: 'VideoLAN', description: 'Media player. Removed from regulated clients.', platforms: ['windows'], source: { type: 'winget', id: 'VideoLAN.VLC' }, detection: { type: 'software_name', pattern: 'VLC media player' }, days: 60 }),
    pkg({ name: 'PowerShell 7', publisher: 'Microsoft Corporation', description: 'Cross-platform PowerShell, needed by the pwsh scripts.', platforms: ['windows'], source: { type: 'winget', id: 'Microsoft.PowerShell' }, detection: { type: 'software_name', pattern: 'PowerShell 7*', min_version: '7.5' }, days: 33, by: 'Jordan Patel' }),
    pkg({ name: 'Microsoft Teams', publisher: 'Microsoft Corporation', description: 'New Teams, machine-wide.', platforms: ['windows'], source: { type: 'winget', id: 'Microsoft.Teams' }, detection: { type: 'software_name', pattern: 'Microsoft Teams*' }, days: 50 }),
    pkg({
      name: 'Dentrix Connector',
      publisher: 'Henry Schein One',
      description: 'Practice-management connector for Northwind workstations. Vendor MSI, licensed per site.',
      platforms: ['windows'],
      source: { type: 'file', file_id: files[0].file_id, file_name: files[0].file_name, sha256: files[0].sha256, size_bytes: files[0].size_bytes, installer: 'msi', install_args: '/qn /norestart SITEKEY=NWD-MAIN', uninstall_args: '/qn /norestart' },
      detection: { type: 'file', path: 'C:\\Program Files (x86)\\Dentrix\\Connector\\DtxConnector.exe', min_version: '7.5.24' },
      days: 8,
      by: 'Avery Chen',
    }),
    pkg({
      name: 'Teller Capture configuration',
      publisher: 'Meridian Credit Union',
      description: 'Scanner profiles and endpoints for Verint Teller Capture.',
      platforms: ['windows'],
      source: { type: 'file', file_id: files[1].file_id, file_name: files[1].file_name, sha256: files[1].sha256, size_bytes: files[1].size_bytes, installer: 'msi', install_args: '/qn ENDPOINT=https://capture.meridiancu.org', uninstall_args: '/qn' },
      detection: { type: 'registry', key: 'HKLM\\SOFTWARE\\Meridian\\TellerCapture', value: 'ConfigVersion', equals: '11.2.0' },
      days: 15,
      by: 'Jordan Patel',
    }),
    pkg({
      name: 'Veeam Agent for Windows',
      publisher: 'Veeam Software Group GmbH',
      description: 'Backup agent for servers. Uninstall through Veeam’s own tooling.',
      platforms: ['windows'],
      source: { type: 'file', file_id: files[2].file_id, file_name: files[2].file_name, sha256: files[2].sha256, size_bytes: files[2].size_bytes, installer: 'exe', install_args: '/silent /accepteula /acceptthirdpartylicenses', uninstall_args: '' },
      detection: { type: 'registry', key: 'HKLM\\SOFTWARE\\Veeam\\Veeam Endpoint Backup' },
      days: 70,
      by: 'Jordan Patel',
    }),
    pkg({ name: 'htop', publisher: 'Upstream', description: 'Interactive process viewer for the Linux fleet.', platforms: ['linux'], source: { type: 'apt', id: 'htop' }, detection: { type: 'file', path: '/usr/bin/htop' }, days: 26, by: 'Riley Brooks' }),
    pkg({ name: 'Wazuh agent', publisher: 'Wazuh, Inc.', description: 'Security monitoring agent for RHEL servers.', platforms: ['linux'], source: { type: 'dnf', id: 'wazuh-agent' }, detection: { type: 'file', path: '/var/ossec/bin/wazuh-control' }, days: 19, by: 'Riley Brooks' }),
    pkg({ name: 'Google Chrome for Mac', publisher: 'Google LLC', description: 'Chrome as a Homebrew cask.', platforms: ['macos'], source: { type: 'brew', id: 'google-chrome', cask: true }, detection: { type: 'software_name', pattern: 'Google Chrome' }, days: 12 }),
    pkg({ name: '1Password', publisher: 'AgileBits', description: 'Password manager for design staff.', platforms: ['macos'], source: { type: 'brew', id: '1password', cask: true }, detection: { type: 'software_name', pattern: '1Password', min_version: '8.11' }, days: 40 }),
  ]

  const group = (name: string) => world.automation.groups.find((item) => item.name === name)?.id
  const client = (prefix: string) => world.clients.find((item) => item.name.startsWith(prefix))?.id
  const byName = (name: string) => packages.find((item) => item.name === name)!
  const deployments: MockDeployment[] = []
  let salt = 11
  const deploy = (spec: {
    pkg: string
    action: DeploymentAction
    target: JobTargetInput | null
    schedule: DeploymentSchedule
    by: string
    createdAgo: number
    state: 'done' | 'scheduled' | 'window' | 'live'
  }) => {
    if (!spec.target || spec.target.ids.some((value) => !value)) return
    salt += 1
    const pack = byName(spec.pkg)
    const devices = resolveTarget(world, spec.target)
    if (devices.length === 0) return
    const created = now - spec.createdAgo
    const results: MockDeploymentResult[] = devices.map((device, index) => {
      const outcome = planDeployment(pack, spec.action, device, salt)
      const lastSeen = device.last_seen_at ? new Date(device.last_seen_at).getTime() : now
      if (spec.state === 'done') {
        const offline = lastSeen < created && outcome.status !== 'skipped'
        return {
          device_id: device.id,
          ...(offline ? { status: 'skipped' as const, exit_code: null, detected_after: null, error: 'The device was offline', output_preview: null } : outcome),
          start_at: null,
          finish_at: null,
          outcome: null,
        }
      }
      if (spec.state === 'live') {
        const start = now + (index % 4) * 6000 - 20_000
        return { device_id: device.id, status: start <= now ? 'running' : 'pending', exit_code: null, detected_after: null, error: null, output_preview: null, start_at: device.online ? start : null, finish_at: device.online ? start + 15_000 + (index % 5) * 7000 : null, outcome }
      }
      return { device_id: device.id, status: 'pending', exit_code: null, detected_after: null, error: null, output_preview: null, start_at: null, finish_at: null, outcome }
    })
    const clients = new Set(devices.map((device) => device.client_id))
    deployments.push({
      id: id(),
      package_id: pack.id,
      package_name: pack.name,
      action: spec.action,
      target: spec.target,
      target_label: targetLabel(world, spec.target),
      schedule: spec.schedule,
      status: spec.state === 'done' ? 'completed' : spec.state === 'scheduled' ? 'scheduled' : 'running',
      created_by_name: spec.by,
      created_at: iso(created),
      finished_at: spec.state === 'done' ? iso(created + 40 * 60_000) : null,
      client_id: clients.size === 1 ? [...clients][0] : null,
      results,
    })
  }
  const target = (type: JobTargetInput['type'], value: string | undefined): JobTargetInput | null => (value ? { type, ids: [value] } : null)
  deploy({ pkg: 'VLC media player', action: 'uninstall', target: target('client', client('Meridian')), schedule: { type: 'now' }, by: 'Jordan Patel', createdAgo: 11 * DAY, state: 'done' })
  deploy({ pkg: 'Google Chrome', action: 'install', target: target('client', client('Atlas')), schedule: { type: 'now' }, by: 'Sam Rivera', createdAgo: 6 * DAY, state: 'done' })
  deploy({ pkg: 'htop', action: 'install', target: target('group', group('Linux fleet')), schedule: { type: 'now' }, by: 'Riley Brooks', createdAgo: 5 * DAY, state: 'done' })
  deploy({ pkg: '7-Zip', action: 'install', target: target('group', group('Northwind front desk')), schedule: { type: 'now' }, by: 'Sam Rivera', createdAgo: 3 * DAY, state: 'done' })
  deploy({ pkg: 'Dentrix Connector', action: 'install', target: target('client', client('Northwind')), schedule: { type: 'window' }, by: 'Avery Chen', createdAgo: 2 * DAY, state: 'window' })
  const tomorrow = new Date(now + DAY)
  tomorrow.setHours(22, 0, 0, 0)
  deploy({ pkg: 'Zoom Workplace', action: 'install', target: target('client', client('Harbor')), schedule: { type: 'once', at: tomorrow.toISOString() }, by: 'Sam Rivera', createdAgo: 3 * 3_600_000, state: 'scheduled' })
  deploy({ pkg: 'Notepad++', action: 'install', target: target('client', client('Summit')), schedule: { type: 'now' }, by: 'Riley Brooks', createdAgo: 45_000, state: 'live' })
  return { packages, files, deployments: deployments.sort((a, b) => b.created_at.localeCompare(a.created_at)) }
}
