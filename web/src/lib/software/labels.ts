/* Display vocabulary for the software library and deployments. */
import type {
  DeploymentAction,
  DeploymentResultStatus,
  DeploymentStatus,
  DetectionRule,
  InstallerType,
  OsFamily,
  PackageSource,
  PackageSourceType,
} from '@/lib/api/types'
import type { Tone } from '@/lib/patching/labels'

export interface SourceMeta {
  label: string
  /** Platforms the source can install on. */
  platforms: OsFamily[]
  idLabel: string
  placeholder: string
  hint: string
}

export const SOURCE_ORDER: PackageSourceType[] = ['winget', 'choco', 'brew', 'apt', 'dnf', 'zypper', 'pacman', 'apk', 'file']

export const SOURCE_META: Record<PackageSourceType, SourceMeta> = {
  winget: { label: 'winget', platforms: ['windows'], idLabel: 'Package ID', placeholder: '7zip.7zip', hint: 'The exact winget ID, as shown by winget search.' },
  choco: { label: 'Chocolatey', platforms: ['windows'], idLabel: 'Package name', placeholder: '7zip', hint: 'Runs only where Chocolatey is installed.' },
  brew: { label: 'Homebrew', platforms: ['macos'], idLabel: 'Formula or cask', placeholder: 'p7zip', hint: 'Runs as the signed-in console user, never as root.' },
  apt: { label: 'apt', platforms: ['linux'], idLabel: 'Package name', placeholder: 'p7zip-full', hint: 'Debian and Ubuntu.' },
  dnf: { label: 'dnf', platforms: ['linux'], idLabel: 'Package name', placeholder: 'p7zip', hint: 'RHEL, Fedora, Rocky and Alma.' },
  zypper: { label: 'zypper', platforms: ['linux'], idLabel: 'Package name', placeholder: 'p7zip-full', hint: 'openSUSE and SLES.' },
  pacman: { label: 'pacman', platforms: ['linux'], idLabel: 'Package name', placeholder: 'p7zip', hint: 'Arch Linux.' },
  apk: { label: 'apk', platforms: ['linux'], idLabel: 'Package name', placeholder: '7zip', hint: 'Alpine Linux.' },
  file: { label: 'Uploaded file', platforms: ['windows', 'macos', 'linux'], idLabel: 'Installer', placeholder: '', hint: 'An installer you upload; agents verify its SHA-256 before running it.' },
}

export const INSTALLER_ORDER: InstallerType[] = ['msi', 'exe', 'pkg', 'deb', 'rpm', 'sh']

export const INSTALLER_META: Record<InstallerType, { label: string; platforms: OsFamily[]; installArgs: string; uninstallArgs: string; runs: string }> = {
  msi: { label: 'Windows Installer (.msi)', platforms: ['windows'], installArgs: '/qn /norestart', uninstallArgs: '/qn /norestart', runs: 'msiexec /i <file> <args>' },
  exe: { label: 'Executable (.exe)', platforms: ['windows'], installArgs: '/S', uninstallArgs: '', runs: '<file> <args>' },
  pkg: { label: 'macOS package (.pkg)', platforms: ['macos'], installArgs: '', uninstallArgs: '', runs: 'installer -pkg <file> -target /' },
  deb: { label: 'Debian package (.deb)', platforms: ['linux'], installArgs: '', uninstallArgs: '', runs: 'dpkg -i <file>' },
  rpm: { label: 'RPM package (.rpm)', platforms: ['linux'], installArgs: '', uninstallArgs: '', runs: 'rpm -U <file>' },
  sh: { label: 'Shell script (.sh)', platforms: ['linux', 'macos'], installArgs: '', uninstallArgs: '', runs: 'sh <file> <args>' },
}

/** Installer type guessed from a file name. */
export function installerFromName(name: string): InstallerType | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase()
  if (ext === 'msi' || ext === 'exe' || ext === 'pkg' || ext === 'deb' || ext === 'rpm' || ext === 'sh') return ext
  return null
}

/** Platforms a source supports; for files, the installer type decides. */
export function sourcePlatforms(source: Pick<PackageSource, 'type'> & { installer?: InstallerType }): OsFamily[] {
  if (source.type === 'file') return source.installer ? INSTALLER_META[source.installer].platforms : SOURCE_META.file.platforms
  return SOURCE_META[source.type].platforms
}

/** "winget · 7zip.7zip", "Uploaded file · 7z2501-x64.msi". */
export function describeSource(source: PackageSource): string {
  if (source.type === 'file') return `${source.installer.toUpperCase()} · ${source.file_name}`
  if (source.type === 'brew') return `Homebrew${source.cask ? ' cask' : ''} · ${source.id}`
  return `${SOURCE_META[source.type].label} · ${source.id}`
}

/** Whether a package can be uninstalled through its source (the server's rule). */
export function canUninstall(source: PackageSource): boolean {
  if (source.type !== 'file') return true
  if (source.installer === 'msi') return true
  return (source.installer === 'exe' || source.installer === 'sh') && source.uninstall_args.trim().length > 0
}

export const DETECTION_LABEL: Record<DetectionRule['type'], string> = {
  software_name: 'Installed software name',
  file: 'File exists',
  registry: 'Registry value',
  none: 'No detection',
}

export const ACTION_LABEL: Record<DeploymentAction, string> = { install: 'Install', uninstall: 'Uninstall' }

export const DEPLOYMENT_STATUS_LABEL: Record<DeploymentStatus, string> = {
  scheduled: 'Scheduled',
  running: 'Running',
  completed: 'Completed',
  cancelled: 'Cancelled',
}
export const DEPLOYMENT_STATUS_TONE: Record<DeploymentStatus, Tone> = {
  scheduled: 'info',
  running: 'live',
  completed: 'success',
  cancelled: 'neutral',
}

export const RESULT_LABEL: Record<DeploymentResultStatus, string> = {
  pending: 'Waiting',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
}
export const RESULT_TONE: Record<DeploymentResultStatus, Tone> = {
  pending: 'neutral',
  running: 'live',
  succeeded: 'success',
  failed: 'critical',
  skipped: 'neutral',
  cancelled: 'neutral',
}
export const RESULT_ORDER: DeploymentResultStatus[] = ['failed', 'running', 'pending', 'succeeded', 'skipped', 'cancelled']

export function isResultDone(status: DeploymentResultStatus): boolean {
  return status !== 'pending' && status !== 'running'
}
