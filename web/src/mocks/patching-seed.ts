/*
 * Seeds the Phase 7 mock state: patching sections on the existing policies (plus a pilot-ring and a
 * design-studio policy), the catalog, client-scoped rule approvals and a few manual decisions and
 * client overrides, per-device patch states that agree with those approvals and rings, scan status,
 * and patch runs for the recent maintenance windows (one immediate install still in flight).
 */
import type { AutoApproveRule, Client, PatchScanSource, Site, User } from '@/lib/api/types'
import { nextCronRuns } from '@/lib/cron'
import { DEFAULT_REBOOT_MESSAGE } from '@/lib/patching/policy'
import type { MockAutomation, MockPolicy, World } from './automation-model'
import { hashString, inventoryFor, rng, type MockDevice } from './devices'
import { buildCatalog, patchTuesdays } from './patching-catalog'
import {
  applyRules,
  configCache,
  decide,
  decisionFor,
  effectiveSince,
  emptyPatching,
  installable,
  planInstall,
  type DevicePatchConfig,
  type MockPatch,
  type MockPatchRun,
  type MockPatchState,
  type MockPatching,
  type MockRunResult,
} from './patching-model'
import { raiseAlert, type MockMonitoring } from './monitoring-model'
import { seedSoftware } from './software-seed'

const DAY = 86_400_000
const HOUR = 3_600_000
const iso = (ms: number) => new Date(ms).toISOString()

const WINDOWS_RULES: AutoApproveRule[] = [
  { platform: 'windows', classifications: ['SecurityUpdates', 'CriticalUpdates'], severities: [], delay_days: { pilot: 0, broad: 7, late: 21 } },
  { platform: 'windows', classifications: ['Definitions'], delay_days: { pilot: 0, broad: 0, late: 0 } },
]
const BASE_RULES: AutoApproveRule[] = [
  ...WINDOWS_RULES,
  { platform: 'linux', classifications: ['security'], delay_days: { pilot: 0, broad: 3, late: 10 } },
  { platform: 'macos', classifications: ['security'], delay_days: { pilot: 0, broad: 0, late: 2 } },
]

/** Adds `patching` sections to the seeded policies and two patching-only policies. */
function seedPolicies(automation: MockAutomation, clients: Client[], users: User[], id: () => string, now: number) {
  const find = (prefix: string) => automation.policies.find((policy) => policy.name.startsWith(prefix))
  const baseline = find('MSP baseline')
  if (baseline) {
    baseline.document.patching = {
      enabled: true,
      scan_interval_hours: 12,
      window: { cron: '0 2 * * 3', duration_minutes: 180, timezone: 'America/Chicago' },
      ring: 'broad',
      auto_approve: BASE_RULES,
      windows: { include_drivers: false, include_feature_updates: false, include_preview: false },
      linux: { mode: 'security' },
      macos: { install: false },
      reboot: { mode: 'prompt', prompt_deferrals: 3, force_at_window_end: true, message: DEFAULT_REBOOT_MESSAGE },
      third_party: { winget: false },
    }
    baseline.version += 1
  }
  const servers = find('Servers')
  if (servers) {
    servers.document.patching = {
      window: { cron: '0 22 * * 6', duration_minutes: 240, timezone: 'UTC' },
      ring: 'late',
      reboot: { mode: 'force', force_at_window_end: true },
    }
    servers.version += 1
  }
  const linux = find('Linux patch Tuesday')
  if (linux) {
    linux.document.patching = {
      window: { cron: '0 4 * * 2', duration_minutes: 120, timezone: 'America/Los_Angeles' },
      linux: { mode: 'security' },
      reboot: { mode: 'force' },
    }
    linux.description = 'Security updates for Linux every Tuesday at 04:00 Pacific, with an automatic restart.'
    linux.version += 1
  }
  const meridian = find('Meridian compliance')
  if (meridian) {
    meridian.document.patching = {
      reboot: {
        mode: 'prompt',
        prompt_deferrals: 1,
        message: 'Meridian IT installed security updates. Please save your work and restart before your next shift.',
      },
    }
    meridian.version += 1
  }
  const pilotGroup = automation.groups.find((group) => group.name === 'Pilot ring') ?? automation.groups.find((group) => group.name === 'Northwind front desk')
  const atlas = clients.find((client) => client.name.startsWith('Atlas'))
  const by = users[1]?.name ?? 'Jordan Patel'
  const extra: MockPolicy[] = []
  if (pilotGroup) {
    extra.push({
      id: id(),
      name: 'Patch pilot ring',
      description: 'Devices in the Pilot ring group get approved updates first, so problems surface before the broad ring.',
      version: 2,
      document: { patching: { ring: 'pilot' } },
      assignments: [{ id: id(), target_type: 'group', target_id: pilotGroup.id, priority: 30 }],
      updated_at: iso(now - 18 * DAY),
      updated_by_name: by,
    })
  }
  if (atlas) {
    extra.push({
      id: id(),
      name: 'Atlas design studio',
      description: 'Third-party app updates through winget and feature updates offered for review.',
      version: 3,
      document: {
        patching: {
          auto_approve: [...BASE_RULES, { platform: 'winget', classifications: ['app'], delay_days: { pilot: 0, broad: 2, late: 5 } }],
          windows: { include_feature_updates: true },
          third_party: { winget: true },
        },
      },
      assignments: [{ id: id(), target_type: 'client', target_id: atlas.id, priority: 0 }],
      updated_at: iso(now - 9 * DAY),
      updated_by_name: 'Sam Rivera',
    })
  }
  automation.policies.push(...extra)
}

/** Products a winget patch upgrades, matched against the device's inventory. */
const WINGET_PRODUCT: Record<string, RegExp> = {
  'Google.Chrome': /^Google Chrome/i,
  'Mozilla.Firefox': /^Mozilla Firefox/i,
  'Notepad++.Notepad++': /^Notepad\+\+/i,
}

function applies(patch: MockPatch, device: MockDevice, config: DevicePatchConfig, software: () => string[]): boolean {
  if (patch.hosts?.length) return patch.hosts.includes(device.hostname)
  if (!patch.os.includes(device.os_name)) return false
  if (patch.platform === 'winget') {
    if (!config.winget) return false
    const product = patch.key.split(':')[1]
    const pattern = WINGET_PRODUCT[product]
    return Boolean(pattern && software().some((name) => pattern.test(name)))
  }
  if (patch.classification === 'Upgrades') return config.includeFeatureUpdates
  if (patch.tags?.length) return patch.tags.some((tag) => device.tags.includes(tag))
  return true
}

function scanSource(device: MockDevice, clients: Client[]): PatchScanSource {
  if (device.os_family === 'macos') return 'softwareupdate'
  if (device.os_family === 'linux') return device.os_name.startsWith('Red Hat') ? 'dnf' : 'apt'
  const client = clients.find((item) => item.id === device.client_id)?.name ?? ''
  return client.startsWith('Meridian') || client.startsWith('Harbor') ? 'wsus' : 'windows_update'
}

const WINDOWS_ERRORS = [
  '0x800f0922: The installation failed because the System Reserved partition is too small',
  '0x80073712: A component store file needed by Windows Update is missing or damaged',
  '0x8024200B: The update handler failed during installation',
]

export function seedPatching(input: {
  world: World
  clients: Client[]
  sites: Site[]
  users: User[]
  now: number
  id: () => string
  monitoring?: MockMonitoring
}): MockPatching {
  const { world, clients, users, now, id } = input
  seedPolicies(world.automation, clients, users, id, now)
  const patching = emptyPatching()
  patching.catalog = buildCatalog(now, id)
  const { current: tue, previous: prevTue } = patchTuesdays(now)
  const config = configCache(world)
  const managed = world.devices.filter((device) => device.status === 'active' || device.status === 'quarantined').sort((a, b) => a.hostname.localeCompare(b.hostname))
  const softwareCache = new Map<string, string[]>()
  const softwareOf = (device: MockDevice) => () => {
    let names = softwareCache.get(device.id)
    if (!names) {
      names = (inventoryFor(device).software?.data.items ?? []).map((item) => item.name)
      softwareCache.set(device.id, names)
    }
    return names
  }

  // Which devices report which patches.
  const reports = new Map<string, MockPatch[]>()
  for (const device of managed) {
    const cfg = config(device)
    if (!cfg.enabled) continue
    reports.set(device.id, patching.catalog.filter((patch) => applies(patch, device, cfg, softwareOf(device))))
  }

  // Rule approvals: the first device of each client to report a patch decides, with its own rules.
  for (const patch of patching.catalog) {
    const seen = new Set<string>()
    for (const device of managed) {
      if (seen.has(device.client_id) || !reports.get(device.id)?.includes(patch)) continue
      seen.add(device.client_id)
      applyRules(patching, patch, device.client_id, config(device), new Date(patch.first_seen_at).getTime() + 20 * 60_000)
    }
  }

  // Manual decisions and client overrides.
  const byKb = (kb: string, title?: RegExp) => patching.catalog.find((patch) => patch.kb === kb && (!title || title.test(patch.title)))
  const byTitle = (title: RegExp) => patching.catalog.find((patch) => title.test(patch.title))
  const client = (prefix: string) => clients.find((item) => item.name.startsWith(prefix))
  const manual = (patch: MockPatch | undefined, clientId: string | null, decision: 'approved' | 'declined' | 'deferred', by: string, at: number, until?: number) => {
    if (patch) decide(patching, { patch_id: patch.id, client_id: clientId, decision, by_name: by, until: until ? iso(until) : null }, at)
  }
  manual(byTitle(/^Microsoft 365 Apps Update/), null, 'approved', 'Jordan Patel', tue + 20 * HOUR)
  manual(byKb('KB890830'), null, 'approved', 'Jordan Patel', tue + 20 * HOUR)
  manual(byKb('KB5072200'), null, 'declined', 'Avery Chen', now - 40 * DAY)
  manual(byKb('KB5068450'), null, 'deferred', 'Jordan Patel', tue + 26 * HOUR, now + 4 * DAY)
  manual(byKb('KB5072033'), client('Meridian')?.id ?? null, 'deferred', 'Jordan Patel', tue + 22 * HOUR, now + 6 * DAY)
  manual(byTitle(/^Microsoft Edge-Stable/), client('Bluebird')?.id ?? null, 'approved', 'Sam Rivera', now - 2 * DAY)
  manual(byTitle(/^Google Chrome 143/), client('Atlas')?.id ?? null, 'approved', 'Sam Rivera', now - DAY)
  manual(byTitle(/^docker-ce/), null, 'declined', 'Riley Brooks', now - 4 * DAY)

  // Per-device states and scan status.
  for (const device of managed) {
    const cfg = config(device)
    const patches = reports.get(device.id)
    if (!patches) continue
    const r = rng(device.seed ^ 0x9e37)
    const lastSeen = device.last_seen_at ? new Date(device.last_seen_at).getTime() : now
    const away = !device.online && lastSeen < now - DAY
    const enrolled = new Date(device.enrolled_at).getTime()
    const states: Record<string, MockPatchState> = {}
    for (const patch of patches) {
      const pr = rng(device.seed ^ hashString(patch.key))
      const firstSeen = new Date(patch.first_seen_at).getTime()
      const detected = Math.min(Math.max(firstSeen, enrolled) + pr.between(0, 8) * HOUR, now - 5 * 60_000, lastSeen)
      const decision = decisionFor(patching, patch.id, device.client_id, now)
      const since = decision && installable(patch, decision, cfg) ? effectiveSince(patch, decision, cfg, now) : null
      const prevMonth = new Date(patch.release_date ?? 0).getTime() === prevTue
      let state: MockPatchState = { state: 'missing', detected_at: iso(detected), installed_at: null, last_error: null, attempts: 0 }
      const installedAt = (from: number) => iso(Math.min(lastSeen - 60_000, from + pr.between(2, 30) * HOUR))
      if (prevMonth) {
        if (device.hostname === 'NWD-XRAY-01') {
          state = { ...state, state: 'failed', last_error: WINDOWS_ERRORS[0], attempts: 3 }
        } else if (away && lastSeen < tue) {
          state = { ...state, state: 'missing' }
        } else {
          state = { ...state, state: 'superseded', installed_at: installedAt(prevTue + 8 * DAY) }
        }
      } else if (since !== null && since < now - 18 * HOUR && !(away && lastSeen < since + 12 * HOUR)) {
        const roll = pr.next()
        if (roll < 0.05 && patch.platform !== 'macos') {
          state = { ...state, state: 'failed', attempts: pr.between(1, 2), last_error: device.os_family === 'windows' ? pr.pick(WINDOWS_ERRORS) : 'E: Sub-process /usr/bin/dpkg returned an error code (1)' }
        } else if (roll < 0.22 && patch.reboot_required) {
          state = { ...state, state: 'pending_reboot', installed_at: installedAt(since) }
        } else if (roll < 0.9 || patch.classification === 'Definitions') {
          state = { ...state, state: 'installed', installed_at: installedAt(since) }
        }
      } else if (patch.classification === 'Definitions' || patch.title.startsWith('XProtect') || patch.title.startsWith('Microsoft Edge')) {
        // These update themselves on most machines whatever the approval says.
        if (!away && pr.chance(0.7)) state = { ...state, state: 'installed', installed_at: installedAt(firstSeen) }
      }
      // A device whose restart is pending keeps the reboot-requiring update in that state.
      if (device.sim.pendingReboot && patch.reboot_required && state.state === 'installed' && !prevMonth) state = { ...state, state: 'pending_reboot' }
      states[patch.id] = state
    }
    patching.states[device.id] = states
    const pendingReboot = device.sim.pendingReboot || Object.values(states).some((state) => state.state === 'pending_reboot')
    const reasons = !pendingReboot
      ? []
      : device.os_family === 'windows'
        ? ['Windows Update', 'Component Based Servicing']
        : device.os_family === 'linux'
          ? ['/var/run/reboot-required (linux-image)']
          : ['softwareupdate: restart required']
    const installs = Object.values(states).map((state) => state.installed_at).filter(Boolean) as string[]
    patching.status[device.id] = {
      scanned_at: iso(device.online ? now - r.between(4, 11 * 60) * 60_000 : lastSeen - r.between(5, 60) * 60_000),
      source: scanSource(device, clients),
      pending_reboot: pendingReboot,
      reboot_reasons: reasons,
      last_install_at: installs.sort().at(-1) ?? null,
    }
  }

  patching.runs = seedRuns(patching, config, managed, now, id)
  // Failed results of finished runs left a `patching.install_failed` alert open on their device.
  if (input.monitoring) {
    const monitoringWorld = { ...world, monitoring: input.monitoring }
    // Only the latest finished run of each policy, for devices that still have a failed update.
    const latest = new Map<string, MockPatchRun>()
    for (const run of patching.runs) if (run.status === 'completed' && run.policy_id && !latest.has(run.policy_id)) latest.set(run.policy_id, run)
    let raised = 0
    for (const run of latest.values()) {
      for (const result of run.results) {
        if (result.status !== 'failed' || raised >= 4) continue
        const device = managed.find((item) => item.id === result.device_id)
        if (!device || !Object.values(patching.states[device.id] ?? {}).some((state) => state.state === 'failed')) continue
        if (input.monitoring.alerts.some((alert) => alert.device_id === device.id && alert.check_id === 'patching.install_failed')) continue
        raised += 1
        raiseAlert(
          monitoringWorld,
          {
            device,
            source: 'server',
            check_id: 'patching.install_failed',
            check_type: 'patching',
            severity: 'warning',
            title: `Patch install failed on ${device.hostname}`,
            message: `${result.failed} of ${result.patch_ids.length} updates failed in “${run.policy_name}”: ${result.error ?? 'unknown error'}`,
          },
          new Date(run.window_start).getTime() + 45 * 60_000,
        )
      }
    }
  }
  const software = seedSoftware({ world, now, id, users })
  patching.packages = software.packages
  patching.files = software.files
  patching.deployments = software.deployments
  return patching
}

/** Window runs for the last few occurrences of each policy window, plus one immediate install in flight. */
function seedRuns(
  patching: MockPatching,
  config: (device: MockDevice) => DevicePatchConfig,
  managed: MockDevice[],
  now: number,
  id: () => string,
): MockPatchRun[] {
  const runs: MockPatchRun[] = []
  const byPolicy = new Map<string, { name: string; window: NonNullable<DevicePatchConfig['window']>; devices: MockDevice[] }>()
  for (const device of managed) {
    const cfg = config(device)
    if (!cfg.enabled || !cfg.window || !cfg.windowPolicyId) continue
    const entry = byPolicy.get(cfg.windowPolicyId) ?? { name: cfg.windowPolicyName ?? 'Policy window', window: cfg.window, devices: [] }
    entry.devices.push(device)
    byPolicy.set(cfg.windowPolicyId, entry)
  }
  let salt = 1
  for (const [policyId, entry] of byPolicy) {
    const starts = nextCronRuns(entry.window.cron, { timeZone: entry.window.timezone, count: 12, from: new Date(now - 32 * DAY) })
      .map((date) => date.getTime())
      .filter((start) => start <= now)
      .slice(-3)
    for (const start of starts) {
      salt += 1
      const end = start + entry.window.duration_minutes * 60_000
      const open = end > now
      const results: MockRunResult[] = []
      for (const device of entry.devices) {
        const r = rng(device.seed ^ (salt * 7919))
        // Devices with nothing to install are left out of the run.
        if (r.chance(0.3)) continue
        const lastSeen = device.last_seen_at ? new Date(device.last_seen_at).getTime() : now
        const offline = lastSeen < start
        const count = r.between(1, device.os_family === 'linux' ? 5 : 4)
        const ids = Object.keys(patching.states[device.id] ?? {}).slice(0, count)
        if (offline) {
          results.push({ device_id: device.id, status: open ? 'pending' : 'skipped', installed: 0, failed: 0, rebooted: false, error: open ? null : 'The device was offline during the window', patch_ids: ids, start_at: null, finish_at: null, outcome: null })
          continue
        }
        const outcome = planInstall(device, ids, patching.catalog, salt, config(device).reboot.mode)
        if (open) {
          const startAt = now + r.between(-60, 90) * 1000
          const finishAt = startAt + r.between(25, 140) * 1000
          results.push({
            device_id: device.id,
            status: startAt <= now ? 'running' : 'pending',
            installed: 0,
            failed: 0,
            rebooted: false,
            error: null,
            patch_ids: ids,
            start_at: startAt,
            finish_at: finishAt,
            outcome,
          })
        } else {
          results.push({
            device_id: device.id,
            status: outcome.status,
            installed: ids.length - outcome.failed_ids.length,
            failed: outcome.failed_ids.length,
            rebooted: outcome.rebooted,
            error: outcome.error,
            patch_ids: ids,
            start_at: null,
            finish_at: null,
            outcome: null,
          })
        }
      }
      if (results.length === 0) continue
      runs.push({
        id: id(),
        policy_id: policyId,
        policy_name: entry.name,
        window_start: iso(start),
        window_end: iso(end),
        status: open ? 'running' : 'completed',
        trigger: 'window',
        created_at: iso(start),
        results,
      })
    }
  }
  // An immediate install still in flight: retrying last month's failed update on the X-ray workstation.
  const xray = managed.find((device) => device.hostname === 'NWD-XRAY-01')
  if (xray) {
    const failed = Object.entries(patching.states[xray.id] ?? {}).filter(([, state]) => state.state === 'failed').map(([patchId]) => patchId)
    if (failed.length) {
      for (const patchId of failed) patching.states[xray.id][patchId] = { ...patching.states[xray.id][patchId], state: 'installing' }
      runs.push({
        id: id(),
        policy_id: null,
        policy_name: 'Immediate install',
        window_start: iso(now - 70_000),
        window_end: null,
        status: 'running',
        trigger: 'manual',
        created_at: iso(now - 70_000),
        results: [
          {
            device_id: xray.id,
            status: 'running',
            installed: 0,
            failed: 0,
            rebooted: false,
            error: null,
            patch_ids: failed,
            start_at: now - 60_000,
            finish_at: now + 40_000,
            outcome: { status: 'pending_reboot', failed_ids: [], rebooted: false, error: null },
          },
        ],
      })
    }
  }
  return runs.sort((a, b) => b.window_start.localeCompare(a.window_start))
}
