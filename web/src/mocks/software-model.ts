/*
 * The software side of the Phase 7 mock: the explorer built from the generated software inventory
 * (with the server's name normalisation), library packages with their installed-on counts, and
 * deployments with per-device results and planned outcomes for the simulator.
 */
import type {
  DeploymentAction,
  DeploymentCounts,
  DeploymentDetail,
  DeploymentResult,
  DeploymentSummary,
  DeviceDeployment,
  OsFamily,
  SoftwareItem,
  SoftwarePackage,
  SoftwareProduct,
  SoftwareProductSummary,
} from '@/lib/api/types'
import { compareVersions, detectionMatches, wildcardToRegExp } from '@/lib/software/detection'
import { sourcePlatforms } from '@/lib/software/labels'
import type { World } from './automation-model'
import { inventoryFor, type MockDevice } from './devices'
import type { MockDeployment, MockDeploymentResult, MockPackage, MockPatching } from './patching-model'

const isManaged = (device: MockDevice) => device.status === 'active' || device.status === 'quarantined'

// ------------------------------------------------------------------ inventory

const inventoryCache = new Map<string, SoftwareItem[]>()

/** The device's software inventory (generated deterministically; cached per inventory snapshot). */
export function softwareOf(device: MockDevice): SoftwareItem[] {
  const key = `${device.id}@${device.inventory_at}`
  let items = inventoryCache.get(key)
  if (!items) {
    items = inventoryFor(device).software?.data.items ?? []
    inventoryCache.set(key, items)
  }
  return items
}

/**
 * Normalises a display name like the server: architecture markers, trailing version numbers and
 * trailing "- …" separators go (`7-Zip 25.01 (x64)` → `7-Zip`).
 */
export function normalizeName(name: string): string {
  let out = name.trim()
  out = out.replace(/\s*\((?:[^)]*\b(?:x64|x86|64-bit|32-bit|amd64|arm64)\b[^)]*)\)/gi, '')
  out = out.replace(/\s+-\s+(?:[a-z]{2}-[a-z]{2}|v?\d[\w.]*)$/i, '')
  out = out.replace(/\s+v?\d+(?:\.\d+)+$/i, '')
  out = out.replace(/\s+(?:x64|x86|64-bit|32-bit)$/i, '')
  return out.replace(/\s+/g, ' ').replace(/\.+$/, '').trim()
}

const fold = (value: string | null | undefined) => (value ?? '').trim().replace(/\s+/g, ' ').replace(/\.+$/, '').toLowerCase()

interface ProductEntry {
  name: string
  names: Map<string, number>
  publisher: string | null
  versions: Map<string, number>
  devices: { device: MockDevice; version: string; install_date: string | null }[]
}

/** Groups the visible fleet's software by normalised name and publisher. */
export function catalogProducts(world: World, clientId?: string | null): Map<string, ProductEntry> {
  const products = new Map<string, ProductEntry>()
  for (const device of world.devices) {
    if (!isManaged(device) || (clientId && device.client_id !== clientId)) continue
    const seen = new Set<string>()
    for (const item of softwareOf(device)) {
      const name = normalizeName(item.name)
      const key = `${fold(name)}|${fold(item.publisher)}`
      if (seen.has(key)) continue
      seen.add(key)
      let entry = products.get(key)
      if (!entry) {
        entry = { name, names: new Map(), publisher: item.publisher ?? null, versions: new Map(), devices: [] }
        products.set(key, entry)
      }
      entry.names.set(name, (entry.names.get(name) ?? 0) + 1)
      const version = item.version ?? ''
      entry.versions.set(version, (entry.versions.get(version) ?? 0) + 1)
      entry.devices.push({ device, version, install_date: item.install_date ?? null })
    }
  }
  for (const entry of products.values()) entry.name = [...entry.names.entries()].sort((a, b) => b[1] - a[1])[0][0]
  return products
}

export function explorerItems(world: World, filters: { q?: string | null; publisher?: string | null; client_id?: string | null }): SoftwareProductSummary[] {
  const q = fold(filters.q)
  const publisher = fold(filters.publisher)
  return [...catalogProducts(world, filters.client_id).values()]
    .filter((entry) => (!q || fold(entry.name).includes(q)) && (!publisher || fold(entry.publisher).includes(publisher)))
    .map((entry) => {
      const versions = [...entry.versions.keys()].filter(Boolean).sort(compareVersions)
      return {
        name: entry.name,
        publisher: entry.publisher,
        versions: entry.versions.size,
        devices: entry.devices.length,
        latest_version: versions.at(-1) ?? null,
      }
    })
    .sort((a, b) => b.devices - a.devices || a.name.localeCompare(b.name))
}

export function productDetail(world: World, name: string, publisher: string | null): SoftwareProduct | null {
  const entry = catalogProducts(world).get(`${fold(name)}|${fold(publisher)}`)
  if (!entry) return null
  return {
    name: entry.name,
    publisher: entry.publisher,
    versions: [...entry.versions.entries()]
      .map(([version, devices]) => ({ version, devices }))
      .sort((a, b) => compareVersions(b.version, a.version)),
    devices: entry.devices
      .map(({ device, version, install_date }) => ({
        device_id: device.id,
        hostname: device.display_name ?? device.hostname,
        client_name: device.client_name,
        version,
        install_date,
      }))
      .sort((a, b) => a.hostname.localeCompare(b.hostname)),
  }
}

// ------------------------------------------------------------------ packages

/** Visible devices that have the package: inventory matches for name detection, else successful installs. */
export function installedOn(world: World, patching: MockPatching, pkg: MockPackage): number {
  const managed = world.devices.filter(isManaged)
  if (pkg.detection.type === 'software_name') {
    const rule = pkg.detection
    return managed.filter((device) => pkg.platforms.includes(device.os_family) && softwareOf(device).some((item) => detectionMatches(rule, item))).length
  }
  const installed = new Set<string>()
  for (const deployment of patching.deployments) {
    if (deployment.package_id !== pkg.id) continue
    for (const result of deployment.results) {
      if (result.status !== 'succeeded') continue
      if (deployment.action === 'install') installed.add(result.device_id)
      else installed.delete(result.device_id)
    }
  }
  return installed.size
}

export function publicPackage(world: World, patching: MockPatching, pkg: MockPackage): SoftwarePackage {
  return { ...pkg, installed_on: installedOn(world, patching, pkg) }
}

/** Whether the device already has the package (detection before the action). */
export function detectedOn(pkg: MockPackage, device: MockDevice): boolean | null {
  if (pkg.detection.type === 'none') return null
  if (pkg.detection.type === 'software_name') {
    const rule = pkg.detection
    return softwareOf(device).some((item) => detectionMatches(rule, item))
  }
  const name = pkg.name.toLowerCase()
  return softwareOf(device).some((item) => item.name.toLowerCase().includes(name.split(' ')[0]))
}

export function packageSupports(pkg: Pick<MockPackage, 'platforms' | 'source'>, os: OsFamily) {
  return pkg.platforms.includes(os) && sourcePlatforms(pkg.source).includes(os)
}

/** Name pattern for a quick match in the explorer ("Deploy update" shortcut). */
export function packageMatchesName(pkg: MockPackage, name: string): boolean {
  return pkg.detection.type === 'software_name' ? wildcardToRegExp(pkg.detection.pattern).test(name) : pkg.name.toLowerCase() === name.toLowerCase()
}

// ------------------------------------------------------------------ deployments

export function deploymentCounts(results: Pick<MockDeploymentResult, 'status'>[]): DeploymentCounts {
  const counts: DeploymentCounts = { total: 0, succeeded: 0, failed: 0, pending: 0, skipped: 0, cancelled: 0 }
  for (const result of results) {
    counts.total += 1
    if (result.status === 'succeeded') counts.succeeded += 1
    else if (result.status === 'failed') counts.failed += 1
    else if (result.status === 'pending' || result.status === 'running') counts.pending += 1
    else if (result.status === 'skipped') counts.skipped += 1
    else counts.cancelled += 1
  }
  return counts
}

export function deploymentSummary(deployment: MockDeployment, detail = false): DeploymentSummary {
  return {
    id: deployment.id,
    package: { id: deployment.package_id, name: deployment.package_name },
    action: deployment.action,
    target_label: deployment.target_label,
    status: deployment.status,
    ...deploymentCounts(deployment.results),
    created_by_name: deployment.created_by_name,
    created_at: deployment.created_at,
    ...(detail ? { target: deployment.target, schedule: deployment.schedule, finished_at: deployment.finished_at } : {}),
  }
}

export function deploymentDetail(world: World, deployment: MockDeployment): DeploymentDetail {
  const results: DeploymentResult[] = deployment.results.map((result) => {
    const device = world.devices.find((item) => item.id === result.device_id)
    return {
      device_id: result.device_id,
      hostname: device ? (device.display_name ?? device.hostname) : 'Deleted device',
      status: result.status,
      exit_code: result.exit_code,
      detected_after: result.detected_after,
      error: result.error,
      output_preview: result.output_preview,
    }
  })
  return { deployment: deploymentSummary(deployment, true), results }
}

export function deviceDeployments(patching: MockPatching, deviceId: string): DeviceDeployment[] {
  return patching.deployments
    .flatMap((deployment) =>
      deployment.results
        .filter((result) => result.device_id === deviceId)
        .map((result) => ({
          deployment_id: deployment.id,
          package: { id: deployment.package_id, name: deployment.package_name },
          action: deployment.action,
          status: result.status,
          exit_code: result.exit_code,
          detected_after: result.detected_after,
          error: result.error,
          created_at: deployment.created_at,
          finished_at: result.status === 'pending' || result.status === 'running' ? null : (deployment.finished_at ?? deployment.created_at),
        })),
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 200)
}

const OUTPUT: Record<string, (pkg: MockPackage, action: DeploymentAction) => string> = {
  winget: (pkg, action) =>
    action === 'install'
      ? `Found ${pkg.name} [${'id' in pkg.source ? pkg.source.id : ''}]\nThis application is licensed to you by its owner.\nDownloading…\nSuccessfully verified installer hash\nStarting package install...\nSuccessfully installed`
      : `Found ${pkg.name} [${'id' in pkg.source ? pkg.source.id : ''}]\nStarting package uninstall...\nSuccessfully uninstalled`,
  choco: (pkg) => `Chocolatey v2.4.3\nInstalling the following packages:\n${pkg.name}\nThe install of ${pkg.name} was successful.`,
  brew: (pkg, action) => (action === 'install' ? `==> Downloading ${pkg.name}\n==> Installing Cask ${pkg.name}\n🍺  ${pkg.name} was successfully installed!` : `==> Uninstalling Cask ${pkg.name}`),
  apt: (pkg) => `Reading package lists...\nBuilding dependency tree...\nSetting up ${'id' in pkg.source ? pkg.source.id : pkg.name} ...\nProcessing triggers for man-db ...`,
  dnf: (pkg) => `Dependencies resolved.\nInstalling: ${'id' in pkg.source ? pkg.source.id : pkg.name}\nComplete!`,
  file: (pkg, action) =>
    pkg.source.type === 'file' ? `Verified SHA-256 ${pkg.source.sha256.slice(0, 16)}…\n${action === 'install' ? 'Installing' : 'Removing'} ${pkg.source.file_name}\nMSI (s) Product: ${pkg.name} -- ${action === 'install' ? 'Installation' : 'Removal'} completed successfully.` : '',
}

/** Planned result of one device's action, deterministic per device and deployment. */
export function planDeployment(pkg: MockPackage, action: DeploymentAction, device: MockDevice, salt: number): NonNullable<MockDeploymentResult['outcome']> {
  if (!packageSupports(pkg, device.os_family))
    return { status: 'skipped', exit_code: null, detected_after: null, error: `${pkg.name} does not support ${device.os_family}`, output_preview: null }
  const before = detectedOn(pkg, device)
  if (action === 'install' && before === true)
    return { status: 'skipped', exit_code: null, detected_after: true, error: 'Already installed (detected before the install)', output_preview: null }
  if (action === 'uninstall' && before === false)
    return { status: 'skipped', exit_code: null, detected_after: false, error: 'Not installed (nothing to remove)', output_preview: null }
  const x = Math.sin(device.seed * 0.0007 + salt * 3.7) * 10_000
  const roll = x - Math.floor(x)
  const output = (OUTPUT[pkg.source.type] ?? OUTPUT.dnf)(pkg, action)
  if (roll < 0.08) {
    const code = device.os_family === 'windows' ? 1603 : 100
    return {
      status: 'failed',
      exit_code: code,
      detected_after: action === 'uninstall',
      error: code === 1603 ? 'Exit code 1603: a fatal error occurred during installation' : 'Exit code 100: the package manager reported an error',
      output_preview: `${output.split('\n').slice(0, 2).join('\n')}\nInstaller failed with exit code ${code}`,
    }
  }
  const code = device.os_family === 'windows' && roll > 0.9 ? 3010 : 0
  return { status: 'succeeded', exit_code: code, detected_after: action === 'install', error: null, output_preview: code === 3010 ? `${output}\nA restart is required to complete the operation (3010).` : output }
}
