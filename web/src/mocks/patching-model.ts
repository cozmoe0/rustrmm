/*
 * State and pure helpers behind the Phase 7 mock API: the patch catalog, client-scoped approvals with
 * the server's precedence, per-device patch states, effective approval by ring, compliance facts, patch
 * runs, the software library and deployments. Seeding, handlers and the live simulator share it.
 */
import type {
  AutoApproveRule,
  DeploymentAction,
  DeploymentResultStatus,
  DeploymentSchedule,
  DeploymentStatus,
  DevicePatchItem,
  DevicePatchState,
  JobTargetInput,
  Patch,
  PatchApproval,
  PatchDeviceCounts,
  PatchPlatform,
  PatchRing,
  PatchRingDelays,
  PatchRun,
  PatchRunCounts,
  PatchRunResult,
  PatchRunResultStatus,
  PatchRunStatus,
  PatchScanSource,
  PolicyPatchingSection,
  SoftwareFileUpload,
  SoftwarePackage,
} from '@/lib/api/types'
import { effectivePolicyFor, type World } from './automation-model'
import type { MockDevice } from './devices'
import { approvalBase, matchingRule, ringDelay } from '@/lib/patching/approval'
import { isMissingState } from '@/lib/patching/labels'
import { PATCHING_DEFAULTS } from '@/lib/patching/policy'
import type { ComplianceDeviceFacts } from '@/lib/patching/compliance'

const DAY = 86_400_000

// ------------------------------------------------------------------ state

/** A catalog entry plus which devices report it (by OS profile), used by seeding and scans. */
export type MockPatch = Omit<Patch, 'approval' | 'devices'> & {
  /** Operating system names (`Device.os_name`) the patch applies to; empty = by tag/software below. */
  os: string[]
  /** Only devices carrying one of these tags (Linux role packages, SQL servers…). */
  tags?: string[]
  /** Only these host names. */
  hosts?: string[]
}

export interface StoredDecision {
  patch_id: string
  /** null = global. */
  client_id: string | null
  decision: 'approved' | 'declined' | 'deferred'
  source: 'rule' | 'manual'
  at: string
  by_name: string
  until: string | null
  /** Rule approvals record the delays and policy of the rule that matched. */
  delay_days?: PatchRingDelays
  policy_id?: string
}

export interface MockPatchState {
  state: DevicePatchState
  detected_at: string
  installed_at: string | null
  last_error: string | null
  attempts: number
}

export interface MockDeviceStatus {
  scanned_at: string | null
  source: PatchScanSource | null
  pending_reboot: boolean
  reboot_reasons: string[]
  last_install_at: string | null
  /** A scan requested from the console finishes at this instant (the simulator completes it). */
  scan_due_at?: number | null
}

export interface MockRunResult {
  device_id: string
  status: PatchRunResultStatus
  installed: number
  failed: number
  rebooted: boolean
  error: string | null
  /** Patch ids sent to the device. */
  patch_ids: string[]
  /** Simulator schedule: when the result starts running and when it finishes, with the outcome. */
  start_at: number | null
  finish_at: number | null
  outcome: { status: PatchRunResultStatus; failed_ids: string[]; rebooted: boolean; error: string | null } | null
}

export interface MockPatchRun {
  id: string
  policy_id: string | null
  policy_name: string
  window_start: string
  window_end: string | null
  status: PatchRunStatus
  trigger: 'window' | 'manual'
  created_at: string
  results: MockRunResult[]
}

export type MockPackage = Omit<SoftwarePackage, 'installed_on'>

export interface MockDeploymentResult {
  device_id: string
  status: DeploymentResultStatus
  exit_code: number | null
  detected_after: boolean | null
  error: string | null
  output_preview: string | null
  start_at: number | null
  finish_at: number | null
  outcome: Omit<MockDeploymentResult, 'start_at' | 'finish_at' | 'outcome' | 'device_id'> | null
}

export interface MockDeployment {
  id: string
  package_id: string | null
  package_name: string
  action: DeploymentAction
  target: JobTargetInput
  target_label: string
  schedule: DeploymentSchedule
  status: DeploymentStatus
  created_by_name: string
  created_at: string
  finished_at: string | null
  /** Client of the target, for per-client events (null for mixed targets). */
  client_id: string | null
  results: MockDeploymentResult[]
}

export interface MockPatching {
  catalog: MockPatch[]
  decisions: StoredDecision[]
  /** deviceId → patchId → state. */
  states: Record<string, Record<string, MockPatchState>>
  status: Record<string, MockDeviceStatus>
  runs: MockPatchRun[]
  packages: MockPackage[]
  files: SoftwareFileUpload[]
  deployments: MockDeployment[]
}

export function emptyPatching(): MockPatching {
  return { catalog: [], decisions: [], states: {}, status: {}, runs: [], packages: [], files: [], deployments: [] }
}

export interface PatchingWorld extends World {
  patching: MockPatching
}

const iso = (ms: number) => new Date(ms).toISOString()

// ------------------------------------------------------------------ effective configuration

export interface DevicePatchConfig {
  enabled: boolean
  ring: PatchRing
  rules: AutoApproveRule[]
  rulesPolicyId: string | null
  window: { cron: string; duration_minutes: number; timezone: string } | null
  windowPolicyId: string | null
  windowPolicyName: string | null
  linuxMode: 'security' | 'all'
  macInstall: boolean
  winget: boolean
  reboot: typeof PATCHING_DEFAULTS.reboot
  includeFeatureUpdates: boolean
}

/** The device's effective `patching` configuration with defaults filled in. */
export function patchConfigFor(world: World, device: MockDevice): DevicePatchConfig {
  const effective = effectivePolicyFor(world, device)
  const section: PolicyPatchingSection = effective.document.patching ?? {}
  const names = new Map(effective.sources.map((source) => [source.policy_id, source.policy_name]))
  const windowPolicyId = effective.origins['patching.window.cron'] ?? null
  return {
    enabled: section.enabled ?? PATCHING_DEFAULTS.enabled,
    ring: section.ring ?? PATCHING_DEFAULTS.ring,
    rules: section.auto_approve ?? [],
    rulesPolicyId: effective.origins['patching.auto_approve'] ?? null,
    window: section.window
      ? {
          cron: section.window.cron,
          duration_minutes: section.window.duration_minutes ?? PATCHING_DEFAULTS.window.duration_minutes,
          timezone: section.window.timezone ?? PATCHING_DEFAULTS.window.timezone,
        }
      : null,
    windowPolicyId,
    windowPolicyName: windowPolicyId ? (names.get(windowPolicyId) ?? null) : null,
    linuxMode: section.linux?.mode ?? PATCHING_DEFAULTS.linux.mode,
    macInstall: section.macos?.install ?? PATCHING_DEFAULTS.macos.install,
    winget: section.third_party?.winget ?? PATCHING_DEFAULTS.third_party.winget,
    reboot: { ...PATCHING_DEFAULTS.reboot, ...section.reboot },
    includeFeatureUpdates: section.windows?.include_feature_updates ?? false,
  }
}

/** Memoises configs for one request (effective policies are not cheap to merge). */
export function configCache(world: World) {
  const cache = new Map<string, DevicePatchConfig>()
  return (device: MockDevice) => {
    let config = cache.get(device.id)
    if (!config) {
      config = patchConfigFor(world, device)
      cache.set(device.id, config)
    }
    return config
  }
}

// ------------------------------------------------------------------ approvals

function active(decision: StoredDecision, now: number) {
  return decision.decision !== 'deferred' || (decision.until !== null && new Date(decision.until).getTime() > now)
}

/**
 * The decision that applies for `clientId` (null = the global view): the client's manual decision,
 * then a manual global decision, then the client's rule approval. Expired deferrals are skipped.
 */
export function decisionFor(patching: MockPatching, patchId: string, clientId: string | null, now = Date.now()): StoredDecision | null {
  const mine = patching.decisions.filter((decision) => decision.patch_id === patchId && active(decision, now))
  if (clientId === null) return mine.find((decision) => decision.client_id === null && decision.source === 'manual') ?? null
  return (
    mine.find((decision) => decision.client_id === clientId && decision.source === 'manual') ??
    mine.find((decision) => decision.client_id === null && decision.source === 'manual') ??
    mine.find((decision) => decision.client_id === clientId && decision.source === 'rule') ??
    null
  )
}

export function approvalJson(decision: StoredDecision | null): PatchApproval {
  if (!decision) return { status: 'none' }
  return {
    status: decision.decision,
    source: decision.source,
    at: decision.at,
    by_name: decision.by_name,
    client_id: decision.client_id,
    ...(decision.decision === 'approved' ? { approved_at: decision.at } : {}),
    ...(decision.decision === 'deferred' ? { until: decision.until } : {}),
  }
}

/** Records a decision at one scope (replacing the one there); `none` clears it, rule approvals included. */
export function decide(
  patching: MockPatching,
  input: { patch_id: string; client_id: string | null; decision: 'approved' | 'declined' | 'deferred' | 'none'; until?: string | null; by_name: string },
  now = Date.now(),
) {
  // One decision per patch and scope: a client's manual decision replaces its rule approval.
  patching.decisions = patching.decisions.filter((item) => !(item.patch_id === input.patch_id && item.client_id === input.client_id))
  if (input.decision === 'none') return
  patching.decisions.push({
    patch_id: input.patch_id,
    client_id: input.client_id,
    decision: input.decision,
    source: 'manual',
    at: iso(now),
    by_name: input.by_name,
    until: input.decision === 'deferred' ? (input.until ?? null) : null,
  })
}

/** Records the client-scoped rule approval the first time a client sees a patch. */
export function applyRules(patching: MockPatching, patch: MockPatch, clientId: string, config: DevicePatchConfig, at: number) {
  if (patching.decisions.some((decision) => decision.patch_id === patch.id && decision.client_id === clientId && decision.source === 'rule')) return
  const rule = matchingRule(config.rules, patch)
  if (!rule) return
  patching.decisions.push({
    patch_id: patch.id,
    client_id: clientId,
    decision: 'approved',
    source: 'rule',
    at: iso(at),
    by_name: 'Approval rule',
    until: null,
    delay_days: rule.delay_days ?? {},
    policy_id: config.rulesPolicyId ?? undefined,
  })
}

/** Whether the device's policy lets this patch install at all (Linux security mode, macOS, winget). */
export function installable(patch: Pick<MockPatch, 'platform' | 'classification'>, decision: StoredDecision, config: DevicePatchConfig): boolean {
  if (patch.platform === 'macos' && !config.macInstall) return false
  if (patch.platform === 'winget' && !config.winget) return false
  if (patch.platform === 'linux' && config.linuxMode === 'security' && decision.source === 'rule' && patch.classification !== 'security') return false
  return true
}

/** When the patch became effective-approved for the device (manual: no ring delay); null when it isn't. */
export function effectiveSince(patch: MockPatch, decision: StoredDecision | null, config: DevicePatchConfig, now = Date.now()): number | null {
  if (!decision || decision.decision !== 'approved') return null
  const decidedAt = new Date(decision.at).getTime()
  const since = decision.source === 'manual' ? decidedAt : Math.max(approvalBase(patch) + ringDelay(decision.delay_days, config.ring) * DAY, decidedAt)
  return since <= now ? since : null
}

// ------------------------------------------------------------------ public shapes

export function publicPatch(patch: MockPatch, approval: PatchApproval, devices: PatchDeviceCounts): Patch {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { os, tags, hosts, ...rest } = patch
  return { ...rest, approval, devices }
}

/** Device counts: `missing` includes downloaded and installing, `installed` includes superseded. */
export function countStates(patching: MockPatching, patchId: string, deviceIds: Iterable<string>): PatchDeviceCounts {
  const counts: PatchDeviceCounts = { missing: 0, installed: 0, failed: 0, pending_reboot: 0 }
  for (const id of deviceIds) {
    const state = patching.states[id]?.[patchId]?.state
    if (!state) continue
    if (state === 'failed') counts.failed += 1
    else if (state === 'pending_reboot') counts.pending_reboot += 1
    else if (state === 'installed' || state === 'superseded') counts.installed += 1
    else counts.missing += 1
  }
  return counts
}

export function devicePatchItems(world: PatchingWorld, device: MockDevice, config: DevicePatchConfig, now = Date.now()): DevicePatchItem[] {
  const states = world.patching.states[device.id] ?? {}
  const items: DevicePatchItem[] = []
  for (const [patchId, state] of Object.entries(states)) {
    const patch = world.patching.catalog.find((item) => item.id === patchId)
    if (!patch) continue
    const decision = decisionFor(world.patching, patch.id, device.client_id, now)
    const since = decision && installable(patch, decision, config) ? effectiveSince(patch, decision, config, now) : null
    items.push({
      patch: publicPatch(patch, approvalJson(decision), countStates(world.patching, patch.id, [device.id])),
      state: state.state,
      detected_at: state.detected_at,
      installed_at: state.installed_at,
      last_error: state.last_error,
      effective_approved: since !== null,
    })
  }
  return items
}

/** Compliance inputs for one device; null when it has never scanned (such devices don't count). */
export function complianceFacts(
  world: PatchingWorld,
  device: MockDevice,
  config: DevicePatchConfig,
  group: { key: string; label: string },
  now = Date.now(),
): ComplianceDeviceFacts | null {
  const status = world.patching.status[device.id]
  if (!status?.scanned_at) return null
  const states = world.patching.states[device.id] ?? {}
  const patches = Object.entries(states).flatMap(([patchId, state]) => {
    const patch = world.patching.catalog.find((item) => item.id === patchId)
    if (!patch) return []
    const decision = decisionFor(world.patching, patch.id, device.client_id, now)
    const since = decision && installable(patch, decision, config) ? effectiveSince(patch, decision, config, now) : null
    return [{ severity: patch.severity, state: state.state, detected_at: new Date(state.detected_at).getTime(), effective_since: since }]
  })
  return { group_key: group.key, group_label: group.label, pending_reboot: status.pending_reboot, patches }
}

/** Missing patches that are effective-approved and installable now (what a window installs). */
export function installablePatchIds(world: PatchingWorld, device: MockDevice, config: DevicePatchConfig, now = Date.now()): string[] {
  const states = world.patching.states[device.id] ?? {}
  return Object.entries(states)
    .filter(([patchId, state]) => {
      if (!isMissingState(state.state) || state.state === 'installing') return false
      const patch = world.patching.catalog.find((item) => item.id === patchId)
      if (!patch) return false
      const decision = decisionFor(world.patching, patchId, device.client_id, now)
      return Boolean(decision && installable(patch, decision, config) && effectiveSince(patch, decision, config, now) !== null)
    })
    .map(([patchId]) => patchId)
}

// ------------------------------------------------------------------ runs

export function runCounts(results: Pick<MockRunResult, 'status'>[]): Required<PatchRunCounts> {
  const counts: Required<PatchRunCounts> = { total: 0, succeeded: 0, failed: 0, pending_reboot: 0, pending: 0, skipped: 0 }
  for (const result of results) {
    counts.total += 1
    if (result.status === 'succeeded') counts.succeeded += 1
    else if (result.status === 'failed') counts.failed += 1
    else if (result.status === 'pending_reboot') counts.pending_reboot += 1
    else if (result.status === 'pending' || result.status === 'running') counts.pending += 1
    else if (result.status === 'skipped') counts.skipped += 1
  }
  return counts
}

export function publicRun(run: MockPatchRun, visible: MockRunResult[] = run.results): PatchRun {
  return {
    id: run.id,
    policy_id: run.policy_id,
    policy_name: run.policy_name,
    window_start: run.window_start,
    window_end: run.window_end,
    status: run.status,
    trigger: run.trigger,
    ...runCounts(visible),
  }
}

export function publicRunResult(world: World, result: MockRunResult): PatchRunResult {
  const device = world.devices.find((item) => item.id === result.device_id)
  return {
    device_id: result.device_id,
    hostname: device ? (device.display_name ?? device.hostname) : 'Deleted device',
    status: result.status,
    installed: result.installed,
    failed: result.failed,
    rebooted: result.rebooted,
    error: result.error,
  }
}

/** Planned outcome of installing `patchIds` on a device, deterministic per device and run. */
export function planInstall(device: MockDevice, patchIds: string[], catalog: MockPatch[], seed: number, rebootMode: string) {
  const r = (salt: number) => {
    const x = Math.sin(device.seed * 0.001 + seed * 7.13 + salt) * 10_000
    return x - Math.floor(x)
  }
  const patches = patchIds.map((id) => catalog.find((patch) => patch.id === id)).filter(Boolean) as MockPatch[]
  const failedIds = patches.filter((patch, index) => patch.reboot_required && r(index + 1) < 0.08).map((patch) => patch.id)
  const needsReboot = patches.some((patch) => patch.reboot_required && !failedIds.includes(patch.id))
  const rebooted = needsReboot && (rebootMode === 'force' || (rebootMode === 'prompt' && r(99) < 0.55))
  const status: PatchRunResultStatus = failedIds.length ? 'failed' : needsReboot && !rebooted ? 'pending_reboot' : 'succeeded'
  const error = failedIds.length
    ? device.os_family === 'windows'
      ? `0x800f0922: ${failedIds.length} of ${patches.length} updates failed to install (CBS_E_INSTALLERS_FAILED)`
      : 'dpkg: error processing package (--configure): installed post-installation script returned error exit status 1'
    : null
  return { status, failed_ids: failedIds, rebooted, error }
}

export function isPatchPlatform(value: string): value is PatchPlatform {
  return value === 'windows' || value === 'linux' || value === 'macos' || value === 'winget'
}
