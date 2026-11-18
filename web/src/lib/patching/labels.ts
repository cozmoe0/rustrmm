/* Display vocabulary for patching: platforms, classifications, severities, states, sources and runs. */
import type {
  DevicePatchState,
  PatchApprovalStatus,
  PatchPlatform,
  PatchRing,
  PatchRunResultStatus,
  PatchRunStatus,
  PatchScanSource,
  PatchSeverity,
  RebootMode,
} from '@/lib/api/types'

export type Tone = 'live' | 'success' | 'warning' | 'critical' | 'info' | 'neutral' | 'primary'

export const PLATFORM_ORDER: PatchPlatform[] = ['windows', 'linux', 'macos', 'winget']

export const PLATFORM_LABEL: Record<PatchPlatform, string> = {
  windows: 'Windows',
  linux: 'Linux',
  macos: 'macOS',
  winget: 'winget',
}

export const WINDOWS_CLASSIFICATIONS = [
  'SecurityUpdates',
  'CriticalUpdates',
  'UpdateRollups',
  'Updates',
  'Definitions',
  'Drivers',
  'FeaturePacks',
  'Upgrades',
  'ServicePacks',
  'Tools',
] as const
export const LINUX_CLASSIFICATIONS = ['security', 'bugfix', 'enhancement', 'other'] as const
export const MAC_CLASSIFICATIONS = ['os', 'security', 'app'] as const

export const CLASSIFICATION_LABEL: Record<string, string> = {
  SecurityUpdates: 'Security updates',
  CriticalUpdates: 'Critical updates',
  UpdateRollups: 'Update rollups',
  Updates: 'Updates',
  Definitions: 'Definition updates',
  Drivers: 'Drivers',
  FeaturePacks: 'Feature packs',
  Upgrades: 'Upgrades',
  ServicePacks: 'Service packs',
  Tools: 'Tools',
  security: 'Security',
  bugfix: 'Bug fix',
  enhancement: 'Enhancement',
  other: 'Other',
  os: 'OS update',
  app: 'App update',
}

/** Classifications a rule may list for a platform (macOS labels also apply to winget). */
export function classificationsFor(platform: PatchPlatform): readonly string[] {
  if (platform === 'windows') return WINDOWS_CLASSIFICATIONS
  if (platform === 'linux') return LINUX_CLASSIFICATIONS
  return MAC_CLASSIFICATIONS
}

export function classificationLabel(platform: PatchPlatform, classification: string): string {
  if (platform === 'macos' && classification === 'security') return 'Security response'
  return CLASSIFICATION_LABEL[classification] ?? classification
}

/** Security-relevant classifications drive the "security" facet and the security badge. */
export function isSecurityClassification(classification: string): boolean {
  return classification === 'SecurityUpdates' || classification === 'CriticalUpdates' || classification === 'security'
}

export const SEVERITY_ORDER: PatchSeverity[] = ['Critical', 'Important', 'Moderate', 'Low']
export const SEVERITY_RANK: Record<PatchSeverity, number> = { Critical: 0, Important: 1, Moderate: 2, Low: 3 }
export const SEVERITY_TONE: Record<PatchSeverity, Tone> = {
  Critical: 'critical',
  Important: 'warning',
  Moderate: 'info',
  Low: 'neutral',
}

export const APPROVAL_ORDER: PatchApprovalStatus[] = ['approved', 'none', 'deferred', 'declined']
export const APPROVAL_LABEL: Record<PatchApprovalStatus, string> = {
  approved: 'Approved',
  declined: 'Declined',
  deferred: 'Deferred',
  none: 'Not approved',
}
export const APPROVAL_TONE: Record<PatchApprovalStatus, Tone> = {
  approved: 'success',
  declined: 'neutral',
  deferred: 'info',
  none: 'warning',
}

export const STATE_ORDER: DevicePatchState[] = [
  'failed',
  'installing',
  'downloaded',
  'missing',
  'pending_reboot',
  'installed',
  'superseded',
]
export const STATE_LABEL: Record<DevicePatchState, string> = {
  missing: 'Missing',
  downloaded: 'Downloaded',
  installing: 'Installing',
  installed: 'Installed',
  failed: 'Failed',
  pending_reboot: 'Restart pending',
  superseded: 'Superseded',
}
export const STATE_TONE: Record<DevicePatchState, Tone> = {
  missing: 'warning',
  downloaded: 'info',
  installing: 'live',
  installed: 'success',
  failed: 'critical',
  pending_reboot: 'info',
  superseded: 'neutral',
}

/** States in which a patch still has to be installed (mirrors the server's compliance rule). */
export function isMissingState(state: DevicePatchState): boolean {
  return state === 'missing' || state === 'downloaded' || state === 'installing' || state === 'failed'
}

export const SOURCE_LABEL: Record<PatchScanSource, string> = {
  wsus: 'WSUS',
  windows_update: 'Windows Update',
  apt: 'apt',
  dnf: 'dnf',
  zypper: 'zypper',
  pacman: 'pacman',
  apk: 'apk',
  softwareupdate: 'softwareupdate',
}

export const RING_ORDER: PatchRing[] = ['pilot', 'broad', 'late']
export const RING_LABEL: Record<PatchRing, string> = { pilot: 'Pilot', broad: 'Broad', late: 'Late' }
export const RING_DESCRIPTION: Record<PatchRing, string> = {
  pilot: 'First to receive approved updates — IT and test machines.',
  broad: 'Most devices, after the pilot ring has had time to surface problems.',
  late: 'Critical servers and sensitive endpoints that update last.',
}

export const REBOOT_MODE_LABEL: Record<RebootMode, string> = {
  never: 'Never restart',
  prompt: 'Ask the user',
  force: 'Restart automatically',
}
export const REBOOT_MODE_DESCRIPTION: Record<RebootMode, string> = {
  never: 'Leave the restart to the user; the device reports “restart pending” until then.',
  prompt: 'Show a restart prompt the signed-in user can postpone a set number of times.',
  force: 'Restart with a five-minute warning as soon as installs finish.',
}

export const RUN_STATUS_LABEL: Record<PatchRunStatus, string> = {
  running: 'Running',
  completed: 'Completed',
  cancelled: 'Cancelled',
}

export const RUN_RESULT_LABEL: Record<PatchRunResultStatus, string> = {
  pending: 'Waiting',
  running: 'Installing',
  succeeded: 'Succeeded',
  failed: 'Failed',
  pending_reboot: 'Restart pending',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
}
export const RUN_RESULT_TONE: Record<PatchRunResultStatus, Tone> = {
  pending: 'neutral',
  running: 'live',
  succeeded: 'success',
  failed: 'critical',
  pending_reboot: 'info',
  skipped: 'neutral',
  cancelled: 'neutral',
}
export const RUN_RESULT_ORDER: PatchRunResultStatus[] = ['failed', 'running', 'pending', 'pending_reboot', 'succeeded', 'skipped', 'cancelled']

/** Days between two instants, rounded down (never negative). */
export function daysBetween(from: number, to: number): number {
  return Math.max(0, Math.floor((to - from) / 86_400_000))
}
