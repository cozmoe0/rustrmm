/*
 * State and pure helpers behind the Phase 5 mock API (scripts, jobs, groups, policies, custom
 * fields). Nothing here touches the global mock db, so seeding, handlers and the run simulator can
 * all share it.
 */
import type {
  Approval,
  ApprovalStatus,
  AutomationSettings,
  Client,
  CustomField,
  CustomFieldScope,
  CustomFieldValue,
  CustomFieldValueEntry,
  DeviceGroup,
  EffectivePolicy,
  GroupKind,
  Job,
  JobResult,
  JobResultStatus,
  JobRun,
  JobRunCounts,
  JobRunStatus,
  JobSchedule,
  JobStatus,
  JobSummary,
  JobTarget,
  JobTrigger,
  OsFamily,
  ParameterValue,
  Policy,
  PolicyDocument,
  PolicyTargetType,
  ResultDirective,
  RuleDocument,
  Script,
  ScriptLanguage,
  ScriptParameter,
  ScriptRisk,
  ScriptSummary,
  ScriptVersionDetail,
  Site,
  Variable,
  VariableScope,
} from '@/lib/api/types'
import { mergePolicies, sortSources } from '@/lib/automation/policy'
import { evaluateRules, type DeviceFacts } from '@/lib/automation/rules'
import { SECRET_MASK } from '@/lib/automation/params'
import { nextCronRuns } from '@/lib/cron'
import { OS_LABEL } from '@/lib/devices'
import { deviceRamGb, hashString, rng, type MockDevice } from './devices'
import { genericOutput, libraryScript, type ScriptOutput } from './script-library'

// ------------------------------------------------------------------ state

export interface MockScriptVersion extends ScriptVersionDetail {
  created_by_id: string | null
}

export interface MockScript {
  id: string
  /** Stable built-in id from the library; null for custom scripts. */
  key: string | null
  name: string
  description: string
  category: string
  language: ScriptLanguage
  platforms: OsFamily[]
  timeout_secs: number
  risk: ScriptRisk
  builtin: boolean
  archived: boolean
  approved_version: number | null
  /** Ascending by version. */
  versions: MockScriptVersion[]
  created_by_name: string
  created_by_id: string | null
  created_at: string
  updated_at: string
}

export interface MockVariable {
  id: string
  scope: VariableScope
  scope_id: string | null
  name: string
  value: string
  secret: boolean
  description: string
  updated_at: string
  updated_by_name: string
}

export interface MockJob {
  id: string
  name: string
  script_id: string
  script_version: number
  content_sha256: string
  parameters: Record<string, ParameterValue>
  target: JobTarget
  schedule: JobSchedule
  next_run_at: string | null
  status: JobStatus
  offline_wait_minutes: number
  concurrency: number
  timeout_secs: number
  created_by_name: string
  created_by_id: string | null
  created_at: string
  approved_by_name: string | null
  deleted: boolean
  /** Set for jobs created from policy tasks. */
  policy?: { policy_id: string; task_id: string }
}

export interface MockResult {
  device_id: string
  hostname: string
  os_family: OsFamily
  client_name: string
  status: JobResultStatus
  exit_code: number | null
  started_at: string | null
  finished_at: string | null
  duration_ms: number | null
  error: string | null
  seed: number
  /** Planned outcome used by the simulator. */
  ok: boolean
  /** Simulator: when a running result finishes (ms epoch). */
  due?: number
  /** Simulator: when a waiting result gives up (ms epoch). */
  wait_until?: number
}

export interface MockRun {
  id: string
  job_id: string
  status: JobRunStatus
  trigger: JobTrigger
  started_at: string
  finished_at: string | null
  /** Historical runs keep only counts; results are regenerated from the seed. */
  synthetic: boolean
  counts: JobRunCounts
  results?: MockResult[]
}

export interface MockApproval {
  id: string
  job_id: string
  requested_by_name: string
  requested_by_id: string | null
  requested_at: string
  status: ApprovalStatus
  decided_by_name: string | null
  decided_at: string | null
  comment: string | null
}

export interface MockGroup {
  id: string
  name: string
  description: string
  kind: GroupKind
  client_id: string | null
  rules: RuleDocument | null
  static_ids: string[]
  created_by_name: string
  updated_at: string
}

export interface MockAssignment {
  id: string
  target_type: PolicyTargetType
  target_id: string | null
  priority: number
}

export interface MockPolicy {
  id: string
  name: string
  description: string
  version: number
  document: PolicyDocument
  assignments: MockAssignment[]
  updated_at: string
  updated_by_name: string
}

export interface StoredValue {
  value: CustomFieldValue
  updated_at: string
  updated_by: string
}

export interface MockAutomation {
  scripts: MockScript[]
  variables: MockVariable[]
  jobs: MockJob[]
  runs: MockRun[]
  approvals: MockApproval[]
  customFields: CustomField[]
  customValues: Record<CustomFieldScope, Record<string, Record<string, StoredValue>>>
  groups: MockGroup[]
  policies: MockPolicy[]
  settings: AutomationSettings
}

export interface World {
  automation: MockAutomation
  devices: MockDevice[]
  clients: Client[]
  sites: Site[]
}

export function emptyAutomation(): MockAutomation {
  return {
    scripts: [],
    variables: [],
    jobs: [],
    runs: [],
    approvals: [],
    customFields: [],
    customValues: { device: {}, client: {}, site: {} },
    groups: [],
    policies: [],
    settings: {
      mass_action_threshold: 25,
      four_eyes_jobs: false,
      require_script_approval: false,
      allow_self_approval: false,
      max_output_kb: 256,
      default_offline_wait_minutes: 60,
    },
  }
}

const isManaged = (device: MockDevice) => device.status === 'active' || device.status === 'quarantined'

// ------------------------------------------------------------------ scripts

export function currentVersion(script: MockScript): MockScriptVersion {
  return script.versions[script.versions.length - 1]
}

export function scriptLastRun(world: World, scriptId: string): ScriptSummary['last_run'] {
  const jobIds = new Set(world.automation.jobs.filter((job) => job.script_id === scriptId).map((job) => job.id))
  let latest: MockRun | null = null
  for (const run of world.automation.runs) {
    if (jobIds.has(run.job_id) && (!latest || run.started_at > latest.started_at)) latest = run
  }
  return latest
    ? {
        job_id: latest.job_id,
        run_id: latest.id,
        at: latest.started_at,
        succeeded: latest.counts.succeeded,
        failed: latest.counts.failed,
      }
    : null
}

export function scriptSummary(world: World, script: MockScript): ScriptSummary {
  const current = currentVersion(script)
  return {
    id: script.id,
    name: script.name,
    description: script.description,
    category: script.category,
    language: script.language,
    platforms: script.platforms,
    timeout_secs: script.timeout_secs,
    risk: script.risk,
    builtin: script.builtin,
    current_version: current.version,
    approved_version: script.approved_version,
    content_sha256: current.content_sha256,
    created_by_name: script.created_by_name,
    created_at: script.created_at,
    updated_at: script.updated_at,
    last_run: scriptLastRun(world, script.id),
    archived: script.archived,
  }
}

export function scriptDetail(world: World, script: MockScript): Script {
  const current = currentVersion(script)
  return {
    ...scriptSummary(world, script),
    content: current.content,
    parameters: current.parameters,
    versions: [...script.versions].reverse().map((version) => ({
      version: version.version,
      notes: version.notes,
      content_sha256: version.content_sha256,
      created_by_name: version.created_by_name,
      created_at: version.created_at,
      approved_by_name: version.approved_by_name,
      approved_at: version.approved_at,
    })),
  }
}

// ------------------------------------------------------------------ custom fields & facts

export function customValuesFor(
  automation: MockAutomation,
  scope: CustomFieldScope,
  id: string,
): Record<string, CustomFieldValue> {
  const stored = automation.customValues[scope][id] ?? {}
  const out: Record<string, CustomFieldValue> = {}
  for (const field of automation.customFields) {
    if (field.scope === scope && stored[field.key] !== undefined) out[field.key] = stored[field.key].value
  }
  return out
}

export function customValueEntries(
  automation: MockAutomation,
  scope: CustomFieldScope,
  id: string,
): CustomFieldValueEntry[] {
  const stored = automation.customValues[scope][id] ?? {}
  return automation.customFields
    .filter((field) => field.scope === scope)
    .map((field) => ({
      field,
      value: stored[field.key]?.value ?? null,
      updated_at: stored[field.key]?.updated_at ?? null,
      updated_by: stored[field.key]?.updated_by ?? null,
    }))
}

/** Validates and normalises a value for a field; returns an error message for invalid input. */
export function coerceFieldValue(field: CustomField, value: unknown): { value: CustomFieldValue } | { error: string } {
  if (value === null || value === undefined || value === '') return { value: null }
  switch (field.type) {
    case 'number': {
      const parsed = typeof value === 'number' ? value : Number(String(value).trim())
      return Number.isFinite(parsed) ? { value: parsed } : { error: `${field.name} must be a number.` }
    }
    case 'boolean':
      if (typeof value === 'boolean') return { value }
      if (value === 'true' || value === 'false') return { value: value === 'true' }
      return { error: `${field.name} must be true or false.` }
    case 'date':
      return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
        ? { value }
        : { error: `${field.name} must be a date (YYYY-MM-DD).` }
    case 'select':
      return field.options.includes(String(value))
        ? { value: String(value) }
        : { error: `${field.name} must be one of: ${field.options.join(', ')}.` }
    default:
      return String(value).length <= 1024 ? { value: String(value) } : { error: `${field.name} is too long.` }
  }
}

export function publicIpFor(device: MockDevice): string {
  const octet = (hashString(device.client_id) % 200) + 20
  return `203.0.113.${octet}`
}

export function deviceFacts(world: World, device: MockDevice, now = Date.now()): DeviceFacts {
  const facts: DeviceFacts = {
    hostname: device.hostname,
    os_name: device.os_name,
    os_version: device.os_version,
    agent_version: device.agent_version,
    device_type: device.device_type,
    last_user: device.last_user,
    domain: device.domain,
    manufacturer: device.manufacturer,
    model: device.model,
    serial: device.serial,
    public_ip: publicIpFor(device),
    os_family: device.os_family,
    client_id: device.client_id,
    site_id: device.site_id,
    tag: device.tags,
    online: device.online,
    pending_reboot: device.sim.pendingReboot,
    health_score: device.health_score,
    ram_gb: deviceRamGb(device),
    disk_free_pct: device.disk_pct === null ? null : Math.round((100 - device.disk_pct) * 10) / 10,
    uptime_days: device.uptime_s === null ? null : Math.floor(device.uptime_s / 86_400),
    last_seen_minutes:
      device.online || !device.last_seen_at ? 0 : Math.round((now - new Date(device.last_seen_at).getTime()) / 60_000),
  }
  for (const [key, value] of Object.entries(customValuesFor(world.automation, 'device', device.id)))
    facts[`custom.${key}`] = value
  return facts
}

// ------------------------------------------------------------------ groups

export function groupMembers(world: World, group: MockGroup): MockDevice[] {
  const pool = world.devices.filter(
    (device) => isManaged(device) && (!group.client_id || device.client_id === group.client_id),
  )
  if (group.kind === 'static') return pool.filter((device) => group.static_ids.includes(device.id))
  if (!group.rules) return []
  const rules = group.rules
  const now = Date.now()
  return pool.filter((device) => evaluateRules(rules, deviceFacts(world, device, now)))
}

export function publicGroup(world: World, group: MockGroup): DeviceGroup {
  return {
    id: group.id,
    name: group.name,
    description: group.description,
    kind: group.kind,
    client_id: group.client_id,
    client_name: group.client_id ? (world.clients.find((client) => client.id === group.client_id)?.name ?? null) : null,
    rules: group.kind === 'dynamic' ? group.rules : null,
    member_count: groupMembers(world, group).length,
    created_by_name: group.created_by_name,
    updated_at: group.updated_at,
  }
}

// ------------------------------------------------------------------ targets

export function resolveTarget(world: World, target: { type: JobTarget['type']; ids: string[] }): MockDevice[] {
  const managed = world.devices.filter(isManaged)
  switch (target.type) {
    case 'devices':
      return managed.filter((device) => target.ids.includes(device.id))
    case 'client':
      return managed.filter((device) => target.ids.includes(device.client_id))
    case 'site':
      return managed.filter((device) => target.ids.includes(device.site_id))
    case 'group': {
      const seen = new Set<string>()
      const out: MockDevice[] = []
      for (const group of world.automation.groups.filter((item) => target.ids.includes(item.id))) {
        for (const device of groupMembers(world, group)) {
          if (!seen.has(device.id)) {
            seen.add(device.id)
            out.push(device)
          }
        }
      }
      return out
    }
  }
}

export function targetLabel(world: World, target: { type: JobTarget['type']; ids: string[] }): string {
  const names = (list: { id: string; name: string }[]) =>
    target.ids.map((id) => list.find((item) => item.id === id)?.name).filter(Boolean) as string[]
  const join = (items: string[], noun: string) => (items.length === 1 ? items[0] : `${items.length} ${noun}`)
  switch (target.type) {
    case 'devices': {
      if (target.ids.length === 1)
        return world.devices.find((device) => device.id === target.ids[0])?.hostname ?? '1 device'
      return `${target.ids.length} devices`
    }
    case 'client':
      return join(names(world.clients), 'clients')
    case 'site': {
      const sites = target.ids.map((id) => world.sites.find((site) => site.id === id)).filter(Boolean) as Site[]
      if (sites.length === 1)
        return `${world.clients.find((client) => client.id === sites[0].client_id)?.name ?? ''} · ${sites[0].name}`
      return `${sites.length} sites`
    }
    case 'group': {
      const groups = world.automation.groups.filter((group) => target.ids.includes(group.id))
      if (groups.length === 1) return `${groups[0].name} (${groups[0].kind})`
      return `${groups.length} groups`
    }
  }
}

// ------------------------------------------------------------------ results & output

export function emptyCounts(): JobRunCounts {
  return { total: 0, pending: 0, waiting_offline: 0, running: 0, succeeded: 0, failed: 0 }
}

export function countResults(results: Pick<MockResult, 'status'>[]): JobRunCounts {
  const counts = emptyCounts()
  counts.total = results.length
  for (const result of results) {
    if (result.status === 'pending') counts.pending += 1
    else if (result.status === 'waiting_offline') counts.waiting_offline += 1
    else if (result.status === 'running') counts.running += 1
    else if (result.status === 'succeeded') counts.succeeded += 1
    else if (result.status === 'failed' || result.status === 'timed_out') counts.failed += 1
  }
  return counts
}

function platformLabel(platforms: OsFamily[]) {
  return platforms.map((os) => OS_LABEL[os]).join(' and ')
}

/** Generates the script's output for one device, deterministically from `seed`. */
export function renderOutput(
  script: MockScript | undefined,
  job: MockJob,
  device: MockDevice,
  seed: number,
  ok: boolean,
): ScriptOutput {
  const entry = libraryScript(script?.key)
  const ctx = { device, params: job.parameters, r: rng(seed ^ 0x5eed), ok }
  return entry ? entry.output(ctx) : genericOutput(ctx, script?.name ?? job.name)
}

export function maskSecrets(text: string, secrets: string[]): string {
  let out = text
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join(SECRET_MASK)
  return out
}

export function secretValues(world: World, job: MockJob, script: MockScript | undefined): string[] {
  const params = script
    ? (script.versions.find((version) => version.version === job.script_version)?.parameters ?? [])
    : []
  const fromParams = params
    .filter((param) => param.type === 'secret')
    .map((param) => String(job.parameters[param.name] ?? ''))
  const fromVariables = world.automation.variables
    .filter((variable) => variable.secret)
    .map((variable) => variable.value)
  return [...fromParams, ...fromVariables]
}

const DIRECTIVE = /^::rustrmm::set-field\s+([a-z][a-z0-9_]{0,47})=(.*)$/

export function parseDirectives(world: World, stdout: string): ResultDirective[] {
  const out: ResultDirective[] = []
  for (const line of stdout.split('\n')) {
    const match = DIRECTIVE.exec(line.trim())
    if (!match) continue
    const field = world.automation.customFields.find((item) => item.key === match[1])
    out.push({
      field: match[1],
      value: match[2].trim(),
      applied: Boolean(field && field.scope === 'device' && field.script_writable),
    })
  }
  return out
}

function exitFor(output: ScriptOutput, ok: boolean) {
  return output.exit ?? (ok ? 0 : 1)
}

/** Plans the outcome of a device in a fresh run. */
export function planResult(
  script: MockScript | undefined,
  device: MockDevice,
  seed: number,
): Pick<MockResult, 'ok'> & { skip?: string } {
  if (script && !script.platforms.includes(device.os_family))
    return { ok: true, skip: `Script runs on ${platformLabel(script.platforms)} only` }
  const entry = libraryScript(script?.key)
  const r = rng(seed)
  return { ok: !r.chance(entry?.failRate ?? 0.06) }
}

/** Results for historical runs, regenerated deterministically from the run and device. */
export function syntheticResults(world: World, run: MockRun): MockResult[] {
  const job = world.automation.jobs.find((item) => item.id === run.job_id)
  if (!job) return []
  const script = world.automation.scripts.find((item) => item.id === job.script_id)
  const entry = libraryScript(script?.key)
  const devices = resolveTarget(world, job.target)
  const startedAt = new Date(run.started_at).getTime()
  return devices.map((device) => {
    const seed = hashString(`${run.id}:${device.id}`)
    const r = rng(seed)
    const base = {
      device_id: device.id,
      hostname: device.hostname,
      os_family: device.os_family,
      client_name: device.client_name,
      seed,
    }
    const plan = planResult(script, device, seed)
    if (plan.skip) {
      return {
        ...base,
        ok: true,
        status: 'skipped' as const,
        exit_code: null,
        started_at: null,
        finished_at: null,
        duration_ms: null,
        error: plan.skip,
      }
    }
    if (!device.online && r.chance(0.5) && run.status !== 'running') {
      return {
        ...base,
        ok: true,
        status: 'skipped' as const,
        exit_code: null,
        started_at: null,
        finished_at: null,
        duration_ms: null,
        error: 'Device offline beyond the wait window',
      }
    }
    const [min, max] = entry?.duration ?? [800, 8000]
    const duration = r.between(min, max)
    const start = startedAt + r.between(200, 45_000)
    if (r.chance(0.008) && (script?.timeout_secs ?? 600) * 1000 < max * 2) {
      const limit = (job.timeout_secs ?? script?.timeout_secs ?? 600) * 1000
      return {
        ...base,
        ok: false,
        status: 'timed_out' as const,
        exit_code: null,
        started_at: new Date(start).toISOString(),
        finished_at: new Date(start + limit).toISOString(),
        duration_ms: limit,
        error: `Script exceeded the ${job.timeout_secs ?? script?.timeout_secs} s timeout; the process tree was stopped.`,
      }
    }
    const output = renderOutput(script, job, device, seed, plan.ok)
    const exit = exitFor(output, plan.ok)
    return {
      ...base,
      ok: plan.ok,
      status: exit === 0 ? ('succeeded' as const) : ('failed' as const),
      exit_code: exit,
      started_at: new Date(start).toISOString(),
      finished_at: new Date(start + duration).toISOString(),
      duration_ms: duration,
      error: null,
    }
  })
}

export function runResults(world: World, run: MockRun): MockResult[] {
  return run.synthetic ? syntheticResults(world, run) : (run.results ?? [])
}

export function publicResult(world: World, run: MockRun, result: MockResult): JobResult {
  let preview = ''
  if (result.status === 'succeeded' || result.status === 'failed') {
    const job = world.automation.jobs.find((item) => item.id === run.job_id)
    const device = world.devices.find((item) => item.id === result.device_id)
    if (job && device) {
      const script = world.automation.scripts.find((item) => item.id === job.script_id)
      const output = renderOutput(script, job, device, result.seed, result.ok)
      const text = maskSecrets(
        (output.stdout || output.stderr || '').replace(/^::rustrmm::.*$/gm, '').trim(),
        secretValues(world, job, script),
      )
      preview = text.slice(0, 200)
    }
  }
  return {
    device_id: result.device_id,
    hostname: result.hostname,
    os_family: result.os_family,
    client_name: result.client_name,
    status: result.status,
    exit_code: result.exit_code,
    started_at: result.started_at,
    finished_at: result.finished_at,
    duration_ms: result.duration_ms,
    error: result.error,
    stdout_preview: preview,
  }
}

// ------------------------------------------------------------------ jobs

export function publicRun(run: MockRun): JobRun {
  return {
    id: run.id,
    job_id: run.job_id,
    status: run.status,
    trigger: run.trigger,
    started_at: run.started_at,
    finished_at: run.finished_at,
    ...run.counts,
  }
}

function maskedParameters(world: World, job: MockJob): Record<string, ParameterValue> {
  const script = world.automation.scripts.find((item) => item.id === job.script_id)
  const params: ScriptParameter[] =
    script?.versions.find((version) => version.version === job.script_version)?.parameters ?? []
  const out: Record<string, ParameterValue> = {}
  for (const [key, value] of Object.entries(job.parameters)) {
    out[key] = params.find((param) => param.name === key)?.type === 'secret' ? SECRET_MASK : value
  }
  return out
}

function jobBase(world: World, job: MockJob) {
  const script = world.automation.scripts.find((item) => item.id === job.script_id)
  return {
    id: job.id,
    name: job.name,
    script: {
      id: job.script_id,
      name: script?.name ?? 'Deleted script',
      language: script?.language ?? 'powershell',
      risk: script?.risk ?? 'normal',
    },
    script_version: job.script_version,
    content_sha256: job.content_sha256,
    parameters: maskedParameters(world, job),
    target: job.target,
    schedule: job.schedule,
    next_run_at: job.next_run_at,
    status: job.status,
    offline_wait_minutes: job.offline_wait_minutes,
    concurrency: job.concurrency,
    timeout_secs: job.timeout_secs,
    created_by_name: job.created_by_name,
    created_at: job.created_at,
    approved_by_name: job.approved_by_name,
  }
}

export function jobRuns(world: World, jobId: string): MockRun[] {
  return world.automation.runs
    .filter((run) => run.job_id === jobId)
    .sort((a, b) => b.started_at.localeCompare(a.started_at))
}

export function publicJobSummary(world: World, job: MockJob): JobSummary {
  const last = jobRuns(world, job.id)[0]
  return { ...jobBase(world, job), last_run: last ? publicRun(last) : null }
}

export function publicJob(world: World, job: MockJob): Job {
  return { ...jobBase(world, job), runs: jobRuns(world, job.id).slice(0, 20).map(publicRun) }
}

export function publicApproval(world: World, approval: MockApproval): Approval | null {
  const job = world.automation.jobs.find((item) => item.id === approval.job_id)
  if (!job) return null
  return {
    id: approval.id,
    kind: 'job',
    subject: publicJobSummary(world, job),
    requested_by_name: approval.requested_by_name,
    requested_at: approval.requested_at,
    status: approval.status,
    decided_by_name: approval.decided_by_name,
    decided_at: approval.decided_at,
    comment: approval.comment,
  }
}

/** Next fire time after `from` for scheduled jobs, or null when the job won't run again. */
export function nextRunAt(schedule: JobSchedule, from = new Date()): string | null {
  if (schedule.type === 'now') return null
  if (schedule.type === 'once')
    return new Date(schedule.at).getTime() > from.getTime() ? schedule.at : from.toISOString()
  return nextCronRuns(schedule.cron, { timeZone: schedule.timezone, count: 1, from })[0]?.toISOString() ?? null
}

// ------------------------------------------------------------------ policies

export function assignmentTargetName(world: World, assignment: MockAssignment): string | null {
  switch (assignment.target_type) {
    case 'global':
      return null
    case 'client':
      return world.clients.find((client) => client.id === assignment.target_id)?.name ?? 'Deleted client'
    case 'site': {
      const site = world.sites.find((item) => item.id === assignment.target_id)
      if (!site) return 'Deleted site'
      return `${world.clients.find((client) => client.id === site.client_id)?.name ?? ''} · ${site.name}`
    }
    case 'group':
      return world.automation.groups.find((group) => group.id === assignment.target_id)?.name ?? 'Deleted group'
    case 'device':
      return world.devices.find((device) => device.id === assignment.target_id)?.hostname ?? 'Deleted device'
  }
}

export function publicPolicy(world: World, policy: MockPolicy): Policy {
  return {
    id: policy.id,
    name: policy.name,
    description: policy.description,
    version: policy.version,
    document: policy.document,
    assignments: policy.assignments.map((assignment) => ({
      ...assignment,
      target_name: assignmentTargetName(world, assignment),
    })),
    updated_at: policy.updated_at,
    updated_by_name: policy.updated_by_name,
  }
}

export function effectivePolicyFor(world: World, device: MockDevice): EffectivePolicy {
  const groupIds = new Set(
    world.automation.groups
      .filter((group) => groupMembers(world, group).some((member) => member.id === device.id))
      .map((group) => group.id),
  )
  const applies = (assignment: MockAssignment) => {
    switch (assignment.target_type) {
      case 'global':
        return true
      case 'client':
        return assignment.target_id === device.client_id
      case 'site':
        return assignment.target_id === device.site_id
      case 'group':
        return assignment.target_id !== null && groupIds.has(assignment.target_id)
      case 'device':
        return assignment.target_id === device.id
    }
  }
  const layers: { policy: MockPolicy; assignment: MockAssignment }[] = []
  for (const policy of world.automation.policies) {
    for (const assignment of policy.assignments) if (applies(assignment)) layers.push({ policy, assignment })
  }
  const sources = sortSources(
    layers.map(({ policy, assignment }) => ({
      policy_id: policy.id,
      policy_name: policy.name,
      version: policy.version,
      target_type: assignment.target_type,
      target_name: assignmentTargetName(world, assignment),
      priority: assignment.priority,
      document: policy.document,
    })),
  )
  const merged = mergePolicies(sources.map((source) => ({ policyId: source.policy_id, document: source.document })))
  return {
    document: merged.document,
    origins: merged.origins,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    sources: sources.map(({ document, ...rest }) => rest),
  }
}

export function publicVariable(world: World, variable: MockVariable): Variable {
  const scopeName =
    variable.scope === 'client'
      ? (world.clients.find((client) => client.id === variable.scope_id)?.name ?? null)
      : variable.scope === 'site'
        ? (() => {
            const site = world.sites.find((item) => item.id === variable.scope_id)
            return site
              ? `${world.clients.find((client) => client.id === site.client_id)?.name ?? ''} · ${site.name}`
              : null
          })()
        : null
  return {
    id: variable.id,
    scope: variable.scope,
    scope_id: variable.scope_id,
    scope_name: scopeName,
    name: variable.name,
    value: variable.secret ? null : variable.value,
    secret: variable.secret,
    description: variable.description,
    updated_at: variable.updated_at,
    updated_by_name: variable.updated_by_name,
  }
}
