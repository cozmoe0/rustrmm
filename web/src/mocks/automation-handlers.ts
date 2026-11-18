/* MSW handlers for Phase 5: scripts, variables, jobs, approvals, custom fields, groups and policies. */
import { http, HttpResponse } from 'msw/http'
import type {
  AutomationSettings,
  CustomFieldInput,
  CustomFieldScope,
  GroupInput,
  JobCreate,
  JobResultDetail,
  ParameterValue,
  PolicyAssignmentInput,
  PolicyInput,
  RuleDocument,
  ScriptInput,
  ScriptParameter,
  VariableInput,
} from '@/lib/api/types'
import { envNameError, validateParameterDefinitions, validateParameterValues } from '@/lib/automation/params'
import { compactPolicy, validatePolicyDocument } from '@/lib/automation/policy'
import { CHECK_TYPES } from './monitoring-catalog'
import { evaluateRules, ruleFieldCatalog, validateRules } from '@/lib/automation/rules'
import { isValidCron, isValidTimeZone } from '@/lib/cron'
import {
  coerceFieldValue,
  currentVersion,
  customValueEntries,
  customValuesFor,
  deviceFacts,
  effectivePolicyFor,
  groupMembers,
  jobRuns,
  maskSecrets,
  nextRunAt,
  parseDirectives,
  publicApproval,
  publicGroup,
  publicJob,
  publicJobSummary,
  publicPolicy,
  publicResult,
  publicRun,
  publicVariable,
  renderOutput,
  resolveTarget,
  runResults,
  scriptDetail,
  scriptSummary,
  secretValues,
  targetLabel,
  type MockGroup,
  type MockJob,
  type MockPolicy,
  type MockRun,
  type MockScript,
  type MockScriptVersion,
} from './automation-model'
import { createRun, markDirty, settleJob, startAutomationSim, world } from './automation-sim'
import { db, permissionsFor, persist, recordAudit, uuid } from './db'
import { toPublicDevice, type MockDevice } from './devices'
import { API, actor, currentUser, fail, guard, latency, noContent } from './http-helpers'
import { sha256Hex } from './sha256'
import { emitMockEvent } from './stream'

startAutomationSim()

const LANGUAGES = ['powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh', 'python']
const PLATFORMS = ['windows', 'linux', 'macos']
const KEY_PATTERN = /^[a-z][a-z0-9_]{0,47}$/

function invalid(message: string, details?: Record<string, unknown>) {
  return HttpResponse.json({ error: { code: 'validation_failed', message, details } }, { status: 422 })
}

function audit(
  action: string,
  target: { type: string; id: string; name: string } | null,
  details: Record<string, unknown> = {},
) {
  recordAudit({
    actor: actor(),
    action,
    target,
    client_id: null,
    site_id: null,
    ip: '10.20.0.14',
    user_agent: navigator.userAgent,
    details,
  })
}

function steppedUp() {
  return Boolean(db.session?.steppedUpUntil && db.session.steppedUpUntil > Date.now())
}

function now() {
  return new Date().toISOString()
}

function findScript(id: unknown) {
  return db.automation.scripts.find((script) => script.id === id)
}

function findJob(id: unknown) {
  return db.automation.jobs.find((job) => job.id === id && !job.deleted)
}

function findRun(id: unknown) {
  return db.automation.runs.find((run) => run.id === id)
}

function findDevice(id: unknown): MockDevice | undefined {
  return db.devices.find((device) => device.id === id)
}

// ------------------------------------------------------------------ scripts

function validateScript(body: ScriptInput): Response | null {
  if (!body.name?.trim() || body.name.trim().length > 120)
    return invalid('Enter a name of up to 120 characters.', { field: 'name' })
  if (!body.category?.trim()) return invalid('Choose a category.', { field: 'category' })
  if (!LANGUAGES.includes(body.language)) return invalid('Choose a supported language.', { field: 'language' })
  if (
    !Array.isArray(body.platforms) ||
    body.platforms.length === 0 ||
    body.platforms.some((platform) => !PLATFORMS.includes(platform))
  ) {
    return invalid('Choose at least one platform.', { field: 'platforms' })
  }
  if (!Number.isInteger(body.timeout_secs) || body.timeout_secs < 10 || body.timeout_secs > 86_400)
    return invalid('Timeout must be 10–86400 seconds.', { field: 'timeout_secs' })
  if (body.risk !== 'normal' && body.risk !== 'high') return invalid('Risk must be normal or high.', { field: 'risk' })
  if (!body.content?.trim()) return invalid('The script is empty.', { field: 'content' })
  if (body.content.length > 256 * 1024) return invalid('Scripts are limited to 256 KiB.', { field: 'content' })
  const issues = validateParameterDefinitions(body.parameters ?? [])
  const index = issues.findIndex((item) => Object.keys(item).length > 0)
  if (index >= 0)
    return invalid(`Parameter ${index + 1}: ${Object.values(issues[index])[0]}`, { field: 'parameters', index })
  return null
}

function sameParameters(a: ScriptParameter[], b: ScriptParameter[]) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function newVersion(body: ScriptInput, number: number): MockScriptVersion {
  const user = currentUser()
  return {
    version: number,
    content: body.content,
    parameters: body.parameters ?? [],
    content_sha256: sha256Hex(body.content),
    notes: body.notes?.trim() || (number === 1 ? 'Initial version' : 'Updated'),
    created_by_name: user?.name ?? 'Unknown',
    created_by_id: user?.id ?? null,
    created_at: now(),
    approved_by_name: null,
    approved_at: null,
  }
}

const scriptHandlers = [
  http.get(`${API}/scripts`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'scripts.view' })
    if (denied) return denied
    const params = new URL(request.url).searchParams
    const search = params.get('search')?.trim().toLowerCase()
    const category = params.get('category')
    const language = params.get('language')
    const platform = params.get('platform')
    const archived = params.get('include_archived') === 'true'
    const state = world()
    const items = db.automation.scripts
      .filter((script) => archived || !script.archived)
      .filter(
        (script) => !search || `${script.name} ${script.description} ${script.category}`.toLowerCase().includes(search),
      )
      .filter((script) => !category || script.category === category)
      .filter((script) => !language || script.language === language)
      .filter((script) => !platform || script.platforms.includes(platform as MockScript['platforms'][number]))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((script) => scriptSummary(state, script))
    return HttpResponse.json({ items })
  }),

  http.get(`${API}/script-categories`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'scripts.view' })
    if (denied) return denied
    const counts = new Map<string, number>()
    for (const script of db.automation.scripts)
      if (!script.archived) counts.set(script.category, (counts.get(script.category) ?? 0) + 1)
    return HttpResponse.json({
      items: [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, count]) => ({ name, count })),
    })
  }),

  http.post(`${API}/scripts`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'scripts.manage' })
    if (denied) return denied
    const body = (await request.json()) as ScriptInput
    const problem = validateScript(body)
    if (problem) return problem
    const user = currentUser()
    const script: MockScript = {
      id: uuid(),
      key: null,
      name: body.name.trim(),
      description: body.description?.trim() ?? '',
      category: body.category.trim(),
      language: body.language,
      platforms: body.platforms,
      timeout_secs: body.timeout_secs,
      risk: body.risk,
      builtin: false,
      archived: false,
      approved_version: null,
      versions: [newVersion(body, 1)],
      created_by_name: user?.name ?? 'Unknown',
      created_by_id: user?.id ?? null,
      created_at: now(),
      updated_at: now(),
    }
    db.automation.scripts.push(script)
    audit(
      'script.created',
      { type: 'script', id: script.id, name: script.name },
      { content_sha256: script.versions[0].content_sha256 },
    )
    persist()
    return HttpResponse.json(scriptDetail(world(), script), { status: 201 })
  }),

  http.get(`${API}/scripts/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'scripts.view' })
    if (denied) return denied
    const script = findScript(params.id)
    return script ? HttpResponse.json(scriptDetail(world(), script)) : fail(404, 'not_found', 'Script not found.')
  }),

  http.put(`${API}/scripts/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'scripts.manage' })
    if (denied) return denied
    const script = findScript(params.id)
    if (!script) return fail(404, 'not_found', 'Script not found.')
    if (script.builtin)
      return fail(409, 'builtin_readonly', 'Built-in scripts are read-only. Duplicate it to customise.')
    const body = (await request.json()) as ScriptInput
    const problem = validateScript(body)
    if (problem) return problem
    const current = currentVersion(script)
    const changed = current.content !== body.content || !sameParameters(current.parameters, body.parameters ?? [])
    if (changed) script.versions.push(newVersion(body, current.version + 1))
    Object.assign(script, {
      name: body.name.trim(),
      description: body.description?.trim() ?? '',
      category: body.category.trim(),
      language: body.language,
      platforms: body.platforms,
      timeout_secs: body.timeout_secs,
      risk: body.risk,
      updated_at: now(),
    })
    audit(
      'script.updated',
      { type: 'script', id: script.id, name: script.name },
      {
        new_version: changed ? currentVersion(script).version : null,
        content_sha256: currentVersion(script).content_sha256,
      },
    )
    persist()
    return HttpResponse.json(scriptDetail(world(), script))
  }),

  http.post(`${API}/scripts/:id/duplicate`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'scripts.manage' })
    if (denied) return denied
    const source = findScript(params.id)
    if (!source) return fail(404, 'not_found', 'Script not found.')
    const current = currentVersion(source)
    const user = currentUser()
    const copy: MockScript = {
      ...source,
      id: uuid(),
      key: source.key,
      name: `${source.name} (copy)`,
      builtin: false,
      archived: false,
      approved_version: null,
      versions: [
        {
          ...current,
          version: 1,
          notes: `Duplicated from “${source.name}” v${current.version}`,
          created_by_name: user?.name ?? 'Unknown',
          created_by_id: user?.id ?? null,
          created_at: now(),
          approved_by_name: null,
          approved_at: null,
        },
      ],
      created_by_name: user?.name ?? 'Unknown',
      created_by_id: user?.id ?? null,
      created_at: now(),
      updated_at: now(),
    }
    db.automation.scripts.push(copy)
    audit('script.created', { type: 'script', id: copy.id, name: copy.name }, { duplicated_from: source.id })
    persist()
    return HttpResponse.json(scriptDetail(world(), copy), { status: 201 })
  }),

  http.delete(`${API}/scripts/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'scripts.manage', stepUp: true })
    if (denied) return denied
    const script = findScript(params.id)
    if (!script) return fail(404, 'not_found', 'Script not found.')
    script.archived = true
    script.updated_at = now()
    audit('script.archived', { type: 'script', id: script.id, name: script.name })
    persist()
    return noContent()
  }),

  http.get(`${API}/scripts/:id/versions/:version`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'scripts.view' })
    if (denied) return denied
    const script = findScript(params.id)
    const version = script?.versions.find((item) => item.version === Number(params.version))
    if (!version) return fail(404, 'not_found', 'Version not found.')
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { created_by_id, ...rest } = version
    return HttpResponse.json(rest)
  }),

  http.post(`${API}/scripts/:id/versions/:version/approve`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'scripts.approve', stepUp: true })
    if (denied) return denied
    const script = findScript(params.id)
    const version = script?.versions.find((item) => item.version === Number(params.version))
    if (!script || !version) return fail(404, 'not_found', 'Version not found.')
    const user = currentUser()
    if (version.created_by_id && version.created_by_id === user?.id && !db.automation.settings.allow_self_approval) {
      return fail(
        403,
        'self_approval',
        'You created this version, so someone else has to approve it. An administrator can allow self-approval in automation settings.',
      )
    }
    version.approved_by_name = user?.name ?? 'Unknown'
    version.approved_at = now()
    script.approved_version = version.version
    audit(
      'script.approved',
      { type: 'script', id: script.id, name: script.name },
      { version: version.version, content_sha256: version.content_sha256 },
    )
    persist()
    return HttpResponse.json(scriptDetail(world(), script))
  }),
]

// ------------------------------------------------------------------ variables

function validateVariable(body: VariableInput, existingId?: string): Response | null {
  const nameProblem = envNameError(body.name ?? '')
  if (nameProblem) return invalid(nameProblem, { field: 'name' })
  if (!['global', 'client', 'site'].includes(body.scope)) return invalid('Choose a scope.', { field: 'scope' })
  if (body.scope !== 'global' && !body.scope_id) return invalid(`Choose a ${body.scope}.`, { field: 'scope_id' })
  if (body.scope === 'client' && !db.clients.some((client) => client.id === body.scope_id))
    return invalid('Client not found.', { field: 'scope_id' })
  if (body.scope === 'site' && !db.sites.some((site) => site.id === body.scope_id))
    return invalid('Site not found.', { field: 'scope_id' })
  const scopeId = body.scope === 'global' ? null : body.scope_id
  const clash = db.automation.variables.find(
    (variable) =>
      variable.id !== existingId &&
      variable.scope === body.scope &&
      variable.scope_id === scopeId &&
      variable.name.toUpperCase() === body.name.trim().toUpperCase(),
  )
  if (clash) return fail(409, 'variable_exists', `A ${body.scope} variable named ${clash.name} already exists here.`)
  if (body.value !== undefined && body.value.length > 8192)
    return invalid('Values are limited to 8 KiB.', { field: 'value' })
  return null
}

const variableHandlers = [
  http.get(`${API}/variables`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'scripts.view' })
    if (denied) return denied
    const params = new URL(request.url).searchParams
    const scope = params.get('scope')
    const scopeId = params.get('scope_id')
    const state = world()
    const items = db.automation.variables
      .filter((variable) => !scope || variable.scope === scope)
      .filter((variable) => !scopeId || variable.scope_id === scopeId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((variable) => publicVariable(state, variable))
    return HttpResponse.json({ items })
  }),

  http.post(`${API}/variables`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'scripts.manage' })
    if (denied) return denied
    const body = (await request.json()) as VariableInput
    const problem = validateVariable(body)
    if (problem) return problem
    if (body.value === undefined) return invalid('Enter a value.', { field: 'value' })
    const variable = {
      id: uuid(),
      scope: body.scope,
      scope_id: body.scope === 'global' ? null : (body.scope_id ?? null),
      name: body.name.trim(),
      value: body.value,
      secret: body.secret,
      description: body.description?.trim() ?? '',
      updated_at: now(),
      updated_by_name: currentUser()?.name ?? 'Unknown',
    }
    db.automation.variables.push(variable)
    audit(
      'variable.created',
      { type: 'variable', id: variable.id, name: variable.name },
      { scope: variable.scope, secret: variable.secret },
    )
    persist()
    return HttpResponse.json(publicVariable(world(), variable), { status: 201 })
  }),

  http.put(`${API}/variables/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'scripts.manage' })
    if (denied) return denied
    const variable = db.automation.variables.find((item) => item.id === params.id)
    if (!variable) return fail(404, 'not_found', 'Variable not found.')
    const body = (await request.json()) as VariableInput
    const problem = validateVariable(body, variable.id)
    if (problem) return problem
    if (body.value === undefined && (!variable.secret || !body.secret))
      return invalid('Enter a value.', { field: 'value' })
    Object.assign(variable, {
      scope: body.scope,
      scope_id: body.scope === 'global' ? null : (body.scope_id ?? null),
      name: body.name.trim(),
      secret: body.secret,
      description: body.description?.trim() ?? '',
      updated_at: now(),
      updated_by_name: currentUser()?.name ?? 'Unknown',
    })
    if (body.value !== undefined) variable.value = body.value
    audit(
      'variable.updated',
      { type: 'variable', id: variable.id, name: variable.name },
      { value_changed: body.value !== undefined },
    )
    persist()
    return HttpResponse.json(publicVariable(world(), variable))
  }),

  http.delete(`${API}/variables/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'scripts.manage' })
    if (denied) return denied
    const variable = db.automation.variables.find((item) => item.id === params.id)
    if (!variable) return fail(404, 'not_found', 'Variable not found.')
    db.automation.variables = db.automation.variables.filter((item) => item.id !== variable.id)
    audit('variable.deleted', { type: 'variable', id: variable.id, name: variable.name })
    persist()
    return noContent()
  }),
]

// ------------------------------------------------------------------ jobs

function scheduleProblem(schedule: JobCreate['schedule']): string | null {
  if (!schedule || !['now', 'once', 'cron'].includes(schedule.type)) return 'Choose when the job runs.'
  if (schedule.type === 'once' && Number.isNaN(Date.parse(schedule.at))) return 'Choose a valid date and time.'
  if (schedule.type === 'cron') {
    if (!isValidCron(schedule.cron)) return 'Enter a valid 5-field cron expression.'
    if (!isValidTimeZone(schedule.timezone)) return 'Choose a valid time zone.'
  }
  return null
}

function createApproval(job: MockJob) {
  const user = currentUser()
  db.automation.approvals.push({
    id: uuid(),
    job_id: job.id,
    requested_by_name: user?.name ?? 'Unknown',
    requested_by_id: user?.id ?? null,
    requested_at: now(),
    status: 'pending',
    decided_by_name: null,
    decided_at: null,
    comment: null,
  })
  emitMockEvent('approvals.changed', null)
}

/** Starts a freshly created or approved job according to its schedule. */
function activate(job: MockJob) {
  if (job.schedule.type === 'now') {
    job.status = 'running'
    createRun(job, 'manual')
  } else {
    job.status = 'scheduled'
    job.next_run_at = nextRunAt(job.schedule)
  }
}

function deviceRunEntries(device: MockDevice, limit: number) {
  const state = world()
  const out = []
  const runs = [...db.automation.runs].sort((a, b) => b.started_at.localeCompare(a.started_at))
  for (const run of runs) {
    const job = db.automation.jobs.find((item) => item.id === run.job_id)
    if (!job) continue
    const result = runResults(state, run).find((item) => item.device_id === device.id)
    if (!result) continue
    const script = db.automation.scripts.find((item) => item.id === job.script_id)
    out.push({
      ...publicResult(state, run, result),
      job_id: job.id,
      job_name: job.name,
      run_id: run.id,
      script_name: script?.name ?? 'Deleted script',
    })
    if (out.length >= limit) break
  }
  return out
}

const jobHandlers = [
  http.post(`${API}/jobs`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'scripts.run' })
    if (denied) return denied
    const body = (await request.json()) as JobCreate
    const script = findScript(body.script_id)
    if (!script || script.archived) return fail(404, 'not_found', 'Script not found.')
    const settings = db.automation.settings
    const versionNumber = settings.require_script_approval ? script.approved_version : currentVersion(script).version
    if (versionNumber === null)
      return fail(
        409,
        'script_not_approved',
        'Only approved script versions may run, and this script has no approved version yet.',
      )
    const version = script.versions.find((item) => item.version === versionNumber)!
    const paramErrors = validateParameterValues(version.parameters, body.parameters ?? {})
    const firstParam = Object.keys(paramErrors)[0]
    if (firstParam) return invalid(paramErrors[firstParam], { parameter: firstParam })
    const unknown = Object.keys(body.parameters ?? {}).find(
      (key) => !version.parameters.some((param) => param.name === key),
    )
    if (unknown) return invalid(`Unknown parameter ${unknown}.`, { parameter: unknown })
    const scheduleError = scheduleProblem(body.schedule)
    if (scheduleError) return invalid(scheduleError, { field: 'schedule' })
    if (!body.target || !['devices', 'group', 'site', 'client'].includes(body.target.type) || !body.target.ids?.length)
      return invalid('Choose at least one target.', { field: 'target' })
    if (!Number.isInteger(body.concurrency) || body.concurrency < 1 || body.concurrency > 500)
      return invalid('Concurrency must be 1–500.', { field: 'concurrency' })
    if (
      !Number.isInteger(body.offline_wait_minutes) ||
      body.offline_wait_minutes < 0 ||
      body.offline_wait_minutes > 10_080
    )
      return invalid('Offline wait must be 0–10080 minutes.', { field: 'offline_wait_minutes' })
    if (
      body.timeout_secs !== null &&
      body.timeout_secs !== undefined &&
      (body.timeout_secs < 10 || body.timeout_secs > 86_400)
    )
      return invalid('Timeout must be 10–86400 seconds.', { field: 'timeout_secs' })

    const state = world()
    const count = resolveTarget(state, body.target).length
    if (count === 0) return invalid('The target resolves to no devices.', { field: 'target' })
    const guarded = count > settings.mass_action_threshold || script.risk === 'high'
    if (guarded) {
      if (!steppedUp()) return fail(403, 'step_up_required', 'Re-authenticate to continue.')
      if (body.confirm_count !== count) {
        return HttpResponse.json(
          {
            error: {
              code: 'confirmation_required',
              message: `This job targets ${count} devices. Confirm the count to continue.`,
              details: { count },
            },
          },
          { status: 409 },
        )
      }
    }
    const user = currentUser()
    const job: MockJob = {
      id: uuid(),
      name: body.name?.trim() || script.name,
      script_id: script.id,
      script_version: version.version,
      content_sha256: version.content_sha256,
      parameters: Object.fromEntries(
        Object.entries(body.parameters ?? {}).filter(([, value]) => value !== undefined),
      ) as Record<string, ParameterValue>,
      target: { ...body.target, label: targetLabel(state, body.target) },
      schedule: body.schedule,
      next_run_at: null,
      status: 'scheduled',
      offline_wait_minutes: body.offline_wait_minutes,
      concurrency: body.concurrency,
      timeout_secs: body.timeout_secs ?? script.timeout_secs,
      created_by_name: user?.name ?? 'Unknown',
      created_by_id: user?.id ?? null,
      created_at: now(),
      approved_by_name: null,
      deleted: false,
    }
    db.automation.jobs.push(job)
    audit(
      'job.created',
      { type: 'job', id: job.id, name: job.name },
      { script_id: script.id, version: version.version, content_sha256: version.content_sha256, devices: count },
    )
    if (guarded && settings.four_eyes_jobs) {
      job.status = 'pending_approval'
      createApproval(job)
    } else activate(job)
    markDirty()
    persist()
    return HttpResponse.json(publicJob(world(), job), { status: 201 })
  }),

  http.get(`${API}/jobs`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'scripts.view' })
    if (denied) return denied
    const params = new URL(request.url).searchParams
    const status = params.get('status')
    const scriptId = params.get('script_id')
    const deviceId = params.get('device_id')
    const limit = Math.min(200, Number(params.get('limit') ?? 50) || 50)
    const offset = Number(params.get('cursor') ?? 0) || 0
    const state = world()
    const activity = (job: MockJob) => jobRuns(state, job.id)[0]?.started_at ?? job.created_at
    const filtered = db.automation.jobs
      .filter((job) => !job.deleted)
      .filter((job) => !status || job.status === status)
      .filter((job) => !scriptId || job.script_id === scriptId)
      .filter((job) => !deviceId || resolveTarget(state, job.target).some((device) => device.id === deviceId))
      .sort((a, b) => activity(b).localeCompare(activity(a)))
    const page = filtered.slice(offset, offset + limit)
    return HttpResponse.json({
      items: page.map((job) => publicJobSummary(state, job)),
      next_cursor: offset + limit < filtered.length ? String(offset + limit) : null,
    })
  }),

  http.get(`${API}/jobs/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'scripts.view' })
    if (denied) return denied
    const job = findJob(params.id)
    return job ? HttpResponse.json(publicJob(world(), job)) : fail(404, 'not_found', 'Job not found.')
  }),

  http.post(`${API}/jobs/:id/run-now`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'scripts.run' })
    if (denied) return denied
    const job = findJob(params.id)
    if (!job) return fail(404, 'not_found', 'Job not found.')
    if (job.status === 'pending_approval') return fail(409, 'pending_approval', 'This job is waiting for approval.')
    if (job.status === 'rejected' || job.status === 'cancelled')
      return fail(409, 'job_inactive', 'This job was cancelled or rejected.')
    if (job.schedule.type === 'now')
      return fail(409, 'not_scheduled', 'Run now applies to scheduled and recurring jobs. Re-run a run instead.')
    createRun(job, 'manual')
    audit('job.run_started', { type: 'job', id: job.id, name: job.name }, { trigger: 'manual' })
    persist()
    return HttpResponse.json(publicJob(world(), job))
  }),

  http.post(`${API}/jobs/:id/cancel`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'scripts.run' })
    if (denied) return denied
    const job = findJob(params.id)
    if (!job) return fail(404, 'not_found', 'Job not found.')
    for (const run of db.automation.runs.filter((item) => item.job_id === job.id && item.status === 'running'))
      cancelRun(run)
    job.status = 'cancelled'
    job.next_run_at = null
    const approval = db.automation.approvals.find((item) => item.job_id === job.id && item.status === 'pending')
    if (approval) {
      approval.status = 'rejected'
      approval.decided_by_name = currentUser()?.name ?? null
      approval.decided_at = now()
      approval.comment = 'Cancelled by the requester'
      emitMockEvent('approvals.changed', null)
    }
    audit('job.cancelled', { type: 'job', id: job.id, name: job.name })
    persist()
    return HttpResponse.json(publicJob(world(), job))
  }),

  http.delete(`${API}/jobs/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'scripts.run' })
    if (denied) return denied
    const job = findJob(params.id)
    if (!job) return fail(404, 'not_found', 'Job not found.')
    if (db.automation.runs.some((run) => run.job_id === job.id && run.status === 'running'))
      return fail(409, 'run_active', 'Cancel the active run before deleting this job.')
    job.deleted = true
    job.next_run_at = null
    persist()
    return noContent()
  }),

  http.get(`${API}/job-runs/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'scripts.view' })
    if (denied) return denied
    const run = findRun(params.id)
    const job = run && db.automation.jobs.find((item) => item.id === run.job_id)
    if (!run || !job) return fail(404, 'not_found', 'Run not found.')
    const state = world()
    return HttpResponse.json({
      run: publicRun(run),
      job: publicJobSummary(state, job),
      results: runResults(state, run).map((result) => publicResult(state, run, result)),
    })
  }),

  http.get(`${API}/job-runs/:id/results/:deviceId`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'scripts.view' })
    if (denied) return denied
    const run = findRun(params.id)
    const job = run && db.automation.jobs.find((item) => item.id === run.job_id)
    if (!run || !job) return fail(404, 'not_found', 'Run not found.')
    const state = world()
    const result = runResults(state, run).find((item) => item.device_id === params.deviceId)
    if (!result) return fail(404, 'not_found', 'This device is not part of the run.')
    const base = publicResult(state, run, result)
    const device = findDevice(result.device_id)
    const script = findScript(job.script_id)
    let stdout = ''
    let stderr = ''
    if (device && (result.status === 'succeeded' || result.status === 'failed')) {
      const output = renderOutput(script, job, device, result.seed, result.ok)
      const secrets = secretValues(state, job, script)
      stdout = maskSecrets(output.stdout, secrets)
      stderr = maskSecrets(output.stderr ?? '', secrets)
    } else if (result.status === 'timed_out') {
      stderr = result.error ?? ''
    }
    const detail: JobResultDetail = {
      ...base,
      stdout,
      stderr,
      truncated: false,
      directives: parseDirectives(state, stdout),
    }
    return HttpResponse.json(detail)
  }),

  http.post(`${API}/job-runs/:id/rerun`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'scripts.run' })
    if (denied) return denied
    const run = findRun(params.id)
    const job = run && findJob(run.job_id)
    if (!run || !job) return fail(404, 'not_found', 'Run not found.')
    if (job.status === 'pending_approval' || job.status === 'rejected')
      return fail(409, 'job_inactive', 'This job has not been approved.')
    const { only } = (await request.json()) as { only: 'failed' | 'all' }
    const state = world()
    const ids =
      only === 'failed'
        ? runResults(state, run)
            .filter((result) => result.status === 'failed' || result.status === 'timed_out')
            .map((result) => result.device_id)
        : runResults(state, run).map((result) => result.device_id)
    if (ids.length === 0)
      return fail(
        409,
        'nothing_to_rerun',
        only === 'failed' ? 'No device failed in this run.' : 'This run has no devices.',
      )
    const created = createRun(job, 'rerun', ids)
    audit(
      'job.run_started',
      { type: 'job', id: job.id, name: job.name },
      { trigger: 'rerun', only, devices: ids.length },
    )
    persist()
    return HttpResponse.json({
      run: publicRun(created),
      job: publicJobSummary(world(), job),
      results: (created.results ?? []).map((result) => publicResult(world(), created, result)),
    })
  }),

  http.post(`${API}/job-runs/:id/cancel`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'scripts.run' })
    if (denied) return denied
    const run = findRun(params.id)
    const job = run && db.automation.jobs.find((item) => item.id === run.job_id)
    if (!run || !job) return fail(404, 'not_found', 'Run not found.')
    if (run.status !== 'running') return fail(409, 'run_finished', 'This run has already finished.')
    cancelRun(run)
    settleJob(job)
    audit('job.cancelled', { type: 'job', id: job.id, name: job.name }, { run_id: run.id })
    persist()
    const state = world()
    return HttpResponse.json({
      run: publicRun(run),
      job: publicJobSummary(state, job),
      results: runResults(state, run).map((result) => publicResult(state, run, result)),
    })
  }),

  http.get(`${API}/devices/:id/script-runs`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'scripts.view' })
    if (denied) return denied
    const device = findDevice(params.id)
    if (!device) return fail(404, 'not_found', 'Device not found.')
    const limit = Math.min(200, Number(new URL(request.url).searchParams.get('limit') ?? 50) || 50)
    return HttpResponse.json({ items: deviceRunEntries(device, limit) })
  }),

  http.post(`${API}/devices/:id/run-script`, async ({ request, params }) => {
    await latency()
    const body = (await request.json()) as {
      script_id?: string
      parameters?: Record<string, ParameterValue>
      adhoc?: { language: string; content: string }
      timeout_secs?: number | null
    }
    const denied = guard(
      request,
      body.adhoc ? { permission: 'scripts.manage', stepUp: true } : { permission: 'scripts.run' },
    )
    if (denied) return denied
    const device = findDevice(params.id)
    if (!device) return fail(404, 'not_found', 'Device not found.')
    let script: MockScript | undefined
    if (body.adhoc) {
      if (!LANGUAGES.includes(body.adhoc.language) || !body.adhoc.content?.trim())
        return invalid('Choose a language and enter some code.')
      const user = currentUser()
      script = {
        id: uuid(),
        key: null,
        name: 'Ad-hoc script',
        description: 'Unsaved code run from the console.',
        category: 'Ad-hoc',
        language: body.adhoc.language as MockScript['language'],
        platforms: [device.os_family],
        timeout_secs: body.timeout_secs ?? 300,
        risk: 'normal',
        builtin: false,
        archived: true,
        approved_version: 1,
        versions: [
          {
            version: 1,
            content: body.adhoc.content,
            parameters: [],
            content_sha256: sha256Hex(body.adhoc.content),
            notes: 'Ad-hoc run',
            created_by_name: user?.name ?? 'Unknown',
            created_by_id: user?.id ?? null,
            created_at: now(),
            approved_by_name: null,
            approved_at: null,
          },
        ],
        created_by_name: user?.name ?? 'Unknown',
        created_by_id: user?.id ?? null,
        created_at: now(),
        updated_at: now(),
      }
      db.automation.scripts.push(script)
      audit(
        'script.adhoc_run',
        { type: 'device', id: device.id, name: device.hostname },
        {
          language: body.adhoc.language,
          content_sha256: script.versions[0].content_sha256,
          preview: body.adhoc.content.slice(0, 200),
        },
      )
    } else {
      script = findScript(body.script_id)
      if (!script || script.archived) return fail(404, 'not_found', 'Script not found.')
    }
    const version = currentVersion(script)
    const errors = validateParameterValues(version.parameters, body.parameters ?? {})
    const first = Object.keys(errors)[0]
    if (first) return invalid(errors[first], { parameter: first })
    const state = world()
    const user = currentUser()
    const job: MockJob = {
      id: uuid(),
      name: script.name,
      script_id: script.id,
      script_version: version.version,
      content_sha256: version.content_sha256,
      parameters: body.parameters ?? {},
      target: { type: 'devices', ids: [device.id], label: targetLabel(state, { type: 'devices', ids: [device.id] }) },
      schedule: { type: 'now' },
      next_run_at: null,
      status: 'running',
      offline_wait_minutes: 0,
      concurrency: 1,
      timeout_secs: body.timeout_secs ?? script.timeout_secs,
      created_by_name: user?.name ?? 'Unknown',
      created_by_id: user?.id ?? null,
      created_at: now(),
      approved_by_name: null,
      deleted: false,
    }
    db.automation.jobs.push(job)
    const run = createRun(job, 'manual')
    persist()
    return HttpResponse.json({ job_id: job.id, run_id: run.id }, { status: 201 })
  }),
]

function cancelRun(run: MockRun) {
  const stamp = now()
  for (const result of run.results ?? []) {
    if (result.status === 'pending' || result.status === 'waiting_offline') {
      result.status = 'cancelled'
      result.error = 'Cancelled before it started'
      emitMockEvent('job.result', {
        job_id: run.job_id,
        run_id: run.id,
        device_id: result.device_id,
        status: 'cancelled',
      })
    }
  }
  // Running scripts finish on their own; the run completes once they do.
  const stillRunning = (run.results ?? []).some((result) => result.status === 'running')
  if (!stillRunning) {
    run.status = 'cancelled'
    run.finished_at = stamp
  }
  run.counts = { ...run.counts, ...countOpen(run) }
  emitMockEvent('job.updated', { job_id: run.job_id, run_id: run.id, status: run.status, counts: run.counts })
  markDirty()
}

function countOpen(run: MockRun) {
  const results = run.results ?? []
  return {
    pending: results.filter((result) => result.status === 'pending').length,
    waiting_offline: results.filter((result) => result.status === 'waiting_offline').length,
    running: results.filter((result) => result.status === 'running').length,
  }
}

// ------------------------------------------------------------------ approvals & settings

const approvalHandlers = [
  http.get(`${API}/approvals`, async ({ request }) => {
    await latency()
    const denied = guard(request)
    if (denied) return denied
    const status = new URL(request.url).searchParams.get('status')
    const user = currentUser()
    const canApprove = Boolean(user && permissionsFor(user).includes('scripts.approve'))
    const state = world()
    const nowMs = Date.now()
    for (const approval of db.automation.approvals) {
      if (approval.status === 'pending' && nowMs - new Date(approval.requested_at).getTime() > 7 * 86_400_000)
        approval.status = 'expired'
    }
    const items = db.automation.approvals
      .filter((approval) => canApprove || approval.requested_by_id === user?.id)
      .filter((approval) => !status || approval.status === status)
      .sort((a, b) => (b.decided_at ?? b.requested_at).localeCompare(a.decided_at ?? a.requested_at))
      .map((approval) => publicApproval(state, approval))
      .filter(Boolean)
    return HttpResponse.json({ items })
  }),

  http.post(`${API}/approvals/:id/approve`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'scripts.approve', stepUp: true })
    if (denied) return denied
    const approval = db.automation.approvals.find((item) => item.id === params.id)
    if (!approval) return fail(404, 'not_found', 'Approval not found.')
    if (approval.status !== 'pending') return fail(409, 'already_decided', 'This request has already been decided.')
    const user = currentUser()
    if (approval.requested_by_id && approval.requested_by_id === user?.id)
      return fail(403, 'self_approval', 'You requested this job, so another approver has to review it.')
    const { comment } = ((await request.json().catch(() => ({}))) ?? {}) as { comment?: string }
    const job = findJob(approval.job_id)
    approval.status = 'approved'
    approval.decided_by_name = user?.name ?? 'Unknown'
    approval.decided_at = now()
    approval.comment = comment?.trim() || null
    if (job) {
      job.approved_by_name = approval.decided_by_name
      activate(job)
      audit('job.approved', { type: 'job', id: job.id, name: job.name }, { approval_id: approval.id })
    }
    emitMockEvent('approvals.changed', null)
    markDirty()
    persist()
    return HttpResponse.json(publicApproval(world(), approval))
  }),

  http.post(`${API}/approvals/:id/reject`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'scripts.approve' })
    if (denied) return denied
    const approval = db.automation.approvals.find((item) => item.id === params.id)
    if (!approval) return fail(404, 'not_found', 'Approval not found.')
    if (approval.status !== 'pending') return fail(409, 'already_decided', 'This request has already been decided.')
    const { comment } = (await request.json()) as { comment?: string }
    if (!comment?.trim()) return invalid('Explain why you are rejecting this job.', { field: 'comment' })
    const job = findJob(approval.job_id)
    approval.status = 'rejected'
    approval.decided_by_name = currentUser()?.name ?? 'Unknown'
    approval.decided_at = now()
    approval.comment = comment.trim()
    if (job) {
      job.status = 'rejected'
      job.next_run_at = null
      audit('job.rejected', { type: 'job', id: job.id, name: job.name }, { approval_id: approval.id })
    }
    emitMockEvent('approvals.changed', null)
    persist()
    return HttpResponse.json(publicApproval(world(), approval))
  }),

  http.get(`${API}/settings/automation`, async ({ request }) => {
    await latency()
    return guard(request, { permission: 'settings.view' }) ?? HttpResponse.json(db.automation.settings)
  }),

  http.put(`${API}/settings/automation`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'settings.manage', stepUp: true })
    if (denied) return denied
    const body = (await request.json()) as AutomationSettings
    const int = (value: unknown, min: number, max: number) =>
      Number.isInteger(value) && (value as number) >= min && (value as number) <= max
    if (!int(body.mass_action_threshold, 1, 10_000))
      return invalid('The threshold must be 1–10000 devices.', { field: 'mass_action_threshold' })
    if (!int(body.max_output_kb, 16, 4096))
      return invalid('Output cap must be 16–4096 KiB.', { field: 'max_output_kb' })
    if (!int(body.default_offline_wait_minutes, 0, 10_080))
      return invalid('Offline wait must be 0–10080 minutes.', { field: 'default_offline_wait_minutes' })
    db.automation.settings = {
      mass_action_threshold: body.mass_action_threshold,
      four_eyes_jobs: Boolean(body.four_eyes_jobs),
      require_script_approval: Boolean(body.require_script_approval),
      allow_self_approval: Boolean(body.allow_self_approval),
      max_output_kb: body.max_output_kb,
      default_offline_wait_minutes: body.default_offline_wait_minutes,
    }
    audit('settings.automation_updated', null, { ...db.automation.settings })
    persist()
    return HttpResponse.json(db.automation.settings)
  }),
]

// ------------------------------------------------------------------ custom fields

function entityExists(scope: CustomFieldScope, id: unknown) {
  if (scope === 'device') return db.devices.some((device) => device.id === id)
  if (scope === 'client') return db.clients.some((client) => client.id === id)
  return db.sites.some((site) => site.id === id)
}

function valueHandlers(scope: CustomFieldScope, collection: string, viewPermission: string, managePermission: string) {
  return [
    http.get(`${API}/${collection}/:id/custom-fields`, async ({ request, params }) => {
      await latency()
      const denied = guard(request, { permission: viewPermission })
      if (denied) return denied
      if (!entityExists(scope, params.id)) return fail(404, 'not_found', 'Not found.')
      return HttpResponse.json({ items: customValueEntries(db.automation, scope, String(params.id)) })
    }),
    http.put(`${API}/${collection}/:id/custom-fields`, async ({ request, params }) => {
      await latency()
      const denied = guard(request, { permission: managePermission })
      if (denied) return denied
      const id = String(params.id)
      if (!entityExists(scope, id)) return fail(404, 'not_found', 'Not found.')
      const { values } = (await request.json()) as { values: Record<string, unknown> }
      const user = currentUser()
      for (const [key, raw] of Object.entries(values ?? {})) {
        const field = db.automation.customFields.find((item) => item.key === key && item.scope === scope)
        if (!field) return invalid(`Unknown ${scope} field “${key}”.`, { field: key })
        const coerced = coerceFieldValue(field, raw)
        if ('error' in coerced) return invalid(coerced.error, { field: key })
        db.automation.customValues[scope][id] ??= {}
        if (coerced.value === null) delete db.automation.customValues[scope][id][key]
        else
          db.automation.customValues[scope][id][key] = {
            value: coerced.value,
            updated_at: now(),
            updated_by: user?.name ?? 'Unknown',
          }
      }
      if (scope === 'device') emitMockEvent('devices.changed', { id })
      persist()
      return HttpResponse.json({ items: customValueEntries(db.automation, scope, id) })
    }),
  ]
}

function validateField(body: CustomFieldInput): Response | null {
  if (!KEY_PATTERN.test(body.key ?? ''))
    return invalid('Keys use lower-case letters, digits and underscores, starting with a letter (max 48).', {
      field: 'key',
    })
  if (!body.name?.trim()) return invalid('Enter a name.', { field: 'name' })
  if (!['text', 'number', 'boolean', 'date', 'select'].includes(body.type))
    return invalid('Choose a type.', { field: 'type' })
  if (!['device', 'client', 'site'].includes(body.scope)) return invalid('Choose a scope.', { field: 'scope' })
  if (body.type === 'select' && (!body.options?.length || new Set(body.options).size !== body.options.length))
    return invalid('Add at least one unique option.', { field: 'options' })
  if (body.script_writable && body.scope !== 'device')
    return invalid('Only device fields can be written by scripts.', { field: 'script_writable' })
  return null
}

const customFieldHandlers = [
  http.get(`${API}/custom-fields`, async ({ request }) => {
    await latency()
    const denied = guard(request)
    if (denied) return denied
    const scope = new URL(request.url).searchParams.get('scope')
    return HttpResponse.json({ items: db.automation.customFields.filter((field) => !scope || field.scope === scope) })
  }),
  http.post(`${API}/custom-fields`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'settings.manage' })
    if (denied) return denied
    const body = (await request.json()) as CustomFieldInput
    const problem = validateField(body)
    if (problem) return problem
    if (db.automation.customFields.some((field) => field.key === body.key))
      return fail(409, 'field_exists', `A field with the key ${body.key} already exists.`)
    const field = {
      id: uuid(),
      key: body.key,
      name: body.name.trim(),
      description: body.description?.trim() ?? '',
      type: body.type,
      options: body.type === 'select' ? body.options : [],
      scope: body.scope,
      script_writable: body.scope === 'device' && body.script_writable,
      created_at: now(),
    }
    db.automation.customFields.push(field)
    audit('custom_field.created', { type: 'custom_field', id: field.id, name: field.key })
    persist()
    return HttpResponse.json(field, { status: 201 })
  }),
  http.put(`${API}/custom-fields/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'settings.manage' })
    if (denied) return denied
    const field = db.automation.customFields.find((item) => item.id === params.id)
    if (!field) return fail(404, 'not_found', 'Field not found.')
    const body = (await request.json()) as CustomFieldInput
    if (body.key !== field.key || body.scope !== field.scope)
      return invalid('A field’s key and scope cannot change.', { field: 'key' })
    const problem = validateField(body)
    if (problem) return problem
    Object.assign(field, {
      name: body.name.trim(),
      description: body.description?.trim() ?? '',
      type: body.type,
      options: body.type === 'select' ? body.options : [],
      script_writable: field.scope === 'device' && body.script_writable,
    })
    persist()
    return HttpResponse.json(field)
  }),
  http.delete(`${API}/custom-fields/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'settings.manage', stepUp: true })
    if (denied) return denied
    const field = db.automation.customFields.find((item) => item.id === params.id)
    if (!field) return fail(404, 'not_found', 'Field not found.')
    db.automation.customFields = db.automation.customFields.filter((item) => item.id !== field.id)
    for (const values of Object.values(db.automation.customValues[field.scope])) delete values[field.key]
    audit('custom_field.deleted', { type: 'custom_field', id: field.id, name: field.key })
    persist()
    return noContent()
  }),
  ...valueHandlers('device', 'devices', 'devices.view', 'devices.manage'),
  ...valueHandlers('client', 'clients', 'clients.view', 'clients.manage'),
  ...valueHandlers('site', 'sites', 'clients.view', 'clients.manage'),
]

// ------------------------------------------------------------------ groups

function rulesProblem(rules: RuleDocument | null | undefined): Response | null {
  if (!rules) return invalid('Add at least one rule.', { field: 'rules' })
  const issues = validateRules(rules, ruleFieldCatalog(db.automation.customFields))
  if (issues.length) return invalid(issues[0].message, { field: 'rules', path: issues[0].path })
  return null
}

function groupInUse(group: MockGroup): string | null {
  const policy = db.automation.policies.find((item) =>
    item.assignments.some((assignment) => assignment.target_type === 'group' && assignment.target_id === group.id),
  )
  if (policy) return `It is assigned to the policy “${policy.name}”.`
  const job = db.automation.jobs.find(
    (item) =>
      !item.deleted &&
      item.status === 'scheduled' &&
      item.target.type === 'group' &&
      item.target.ids.includes(group.id),
  )
  if (job) return `The scheduled job “${job.name}” targets it.`
  return null
}

const groupHandlers = [
  http.get(`${API}/groups`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'devices.view' })
    if (denied) return denied
    const clientId = new URL(request.url).searchParams.get('client_id')
    const state = world()
    const items = db.automation.groups
      .filter((group) => !clientId || group.client_id === null || group.client_id === clientId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((group) => publicGroup(state, group))
    return HttpResponse.json({ items })
  }),
  http.post(`${API}/groups/preview`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'devices.view' })
    if (denied) return denied
    const { rules, client_id } = (await request.json()) as { rules: RuleDocument; client_id?: string | null }
    const problem = rulesProblem(rules)
    if (problem) return problem
    const state = world()
    const nowMs = Date.now()
    const matches = db.devices
      .filter(
        (device) =>
          (device.status === 'active' || device.status === 'quarantined') &&
          (!client_id || device.client_id === client_id),
      )
      .filter((device) => evaluateRules(rules, deviceFacts(state, device, nowMs)))
      .sort((a, b) => a.hostname.localeCompare(b.hostname))
    return HttpResponse.json({
      count: matches.length,
      items: matches
        .slice(0, 25)
        .map((device) => ({
          ...toPublicDevice(device),
          custom_fields: customValuesFor(db.automation, 'device', device.id),
        })),
    })
  }),
  http.post(`${API}/groups`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'devices.manage' })
    if (denied) return denied
    const body = (await request.json()) as GroupInput
    if (!body.name?.trim()) return invalid('Enter a name.', { field: 'name' })
    if (body.kind !== 'static' && body.kind !== 'dynamic')
      return invalid('Choose static or dynamic.', { field: 'kind' })
    if (body.kind === 'dynamic') {
      const problem = rulesProblem(body.rules)
      if (problem) return problem
    }
    if (
      db.automation.groups.some(
        (group) =>
          group.name.toLowerCase() === body.name.trim().toLowerCase() && group.client_id === (body.client_id ?? null),
      )
    ) {
      return fail(409, 'group_exists', 'A group with this name already exists.')
    }
    const group: MockGroup = {
      id: uuid(),
      name: body.name.trim(),
      description: body.description?.trim() ?? '',
      kind: body.kind,
      client_id: body.client_id ?? null,
      rules: body.kind === 'dynamic' ? (body.rules ?? null) : null,
      static_ids: [],
      created_by_name: currentUser()?.name ?? 'Unknown',
      updated_at: now(),
    }
    db.automation.groups.push(group)
    audit('group.created', { type: 'group', id: group.id, name: group.name }, { kind: group.kind })
    persist()
    return HttpResponse.json(publicGroup(world(), group), { status: 201 })
  }),
  http.put(`${API}/groups/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'devices.manage' })
    if (denied) return denied
    const group = db.automation.groups.find((item) => item.id === params.id)
    if (!group) return fail(404, 'not_found', 'Group not found.')
    const body = (await request.json()) as GroupInput
    if (!body.name?.trim()) return invalid('Enter a name.', { field: 'name' })
    if (body.kind !== group.kind) return invalid('A group’s kind cannot change.', { field: 'kind' })
    if (group.kind === 'dynamic') {
      const problem = rulesProblem(body.rules)
      if (problem) return problem
      group.rules = body.rules ?? null
    }
    group.name = body.name.trim()
    group.description = body.description?.trim() ?? ''
    if (body.client_id !== undefined) group.client_id = body.client_id
    group.updated_at = now()
    audit('group.updated', { type: 'group', id: group.id, name: group.name })
    persist()
    return HttpResponse.json(publicGroup(world(), group))
  }),
  http.delete(`${API}/groups/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'devices.manage' })
    if (denied) return denied
    const group = db.automation.groups.find((item) => item.id === params.id)
    if (!group) return fail(404, 'not_found', 'Group not found.')
    const inUse = groupInUse(group)
    if (inUse) return fail(409, 'group_in_use', `This group can’t be deleted yet. ${inUse}`)
    db.automation.groups = db.automation.groups.filter((item) => item.id !== group.id)
    audit('group.deleted', { type: 'group', id: group.id, name: group.name })
    persist()
    return noContent()
  }),
  http.get(`${API}/groups/:id/members`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'devices.view' })
    if (denied) return denied
    const group = db.automation.groups.find((item) => item.id === params.id)
    if (!group) return fail(404, 'not_found', 'Group not found.')
    const items = groupMembers(world(), group)
      .sort((a, b) => a.hostname.localeCompare(b.hostname))
      .map((device) => ({
        ...toPublicDevice(device),
        custom_fields: customValuesFor(db.automation, 'device', device.id),
      }))
    return HttpResponse.json({ items })
  }),
  http.post(`${API}/groups/:id/members`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'devices.manage' })
    if (denied) return denied
    const group = db.automation.groups.find((item) => item.id === params.id)
    if (!group) return fail(404, 'not_found', 'Group not found.')
    if (group.kind !== 'static') return fail(409, 'dynamic_group', 'Dynamic groups take their members from rules.')
    const { device_ids } = (await request.json()) as { device_ids: string[] }
    const valid = device_ids.filter((id) =>
      db.devices.some((device) => device.id === id && (!group.client_id || device.client_id === group.client_id)),
    )
    group.static_ids = [...new Set([...group.static_ids, ...valid])]
    group.updated_at = now()
    persist()
    return noContent()
  }),
  http.delete(`${API}/groups/:id/members`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'devices.manage' })
    if (denied) return denied
    const group = db.automation.groups.find((item) => item.id === params.id)
    if (!group) return fail(404, 'not_found', 'Group not found.')
    if (group.kind !== 'static') return fail(409, 'dynamic_group', 'Dynamic groups take their members from rules.')
    const { device_ids } = (await request.json()) as { device_ids: string[] }
    group.static_ids = group.static_ids.filter((id) => !device_ids.includes(id))
    group.updated_at = now()
    persist()
    return noContent()
  }),
  http.get(`${API}/devices/:id/groups`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'devices.view' })
    if (denied) return denied
    const device = findDevice(params.id)
    if (!device) return fail(404, 'not_found', 'Device not found.')
    const state = world()
    const items = db.automation.groups
      .filter((group) => groupMembers(state, group).some((member) => member.id === device.id))
      .map((group) => publicGroup(state, group))
    return HttpResponse.json({ items })
  }),
]

// ------------------------------------------------------------------ policies

function policyProblem(body: PolicyInput): Response | null {
  if (!body.name?.trim()) return invalid('Enter a name.', { path: 'name' })
  const issues = validatePolicyDocument(body.document, { checkTypes: CHECK_TYPES })
  if (issues.length)
    return HttpResponse.json(
      {
        error: {
          code: 'invalid_policy',
          message: `${issues[0].path ? `${issues[0].path}: ` : ''}${issues[0].message}`,
          details: { path: issues[0].path },
        },
      },
      { status: 422 },
    )
  for (const check of body.document.monitoring?.checks ?? []) {
    const scriptId = check.remediation?.script_id ?? (check.type === 'script' ? check.config?.script_id : undefined)
    if (typeof scriptId === 'string' && scriptId && !findScript(scriptId))
      return HttpResponse.json(
        {
          error: {
            code: 'invalid_policy',
            message: `Check “${check.name ?? check.id}” uses a script that doesn't exist.`,
            details: { path: `monitoring.checks.${check.id}` },
          },
        },
        { status: 422 },
      )
  }
  for (const task of body.document.tasks ?? []) {
    if (!findScript(task.script_id))
      return HttpResponse.json(
        {
          error: {
            code: 'invalid_policy',
            message: `Task “${task.name}” uses a script that doesn't exist.`,
            details: { path: `tasks.${task.id}.script_id` },
          },
        },
        { status: 422 },
      )
  }
  return null
}

/** Keeps one policy job per enabled task, as the server does. */
function syncPolicyJobs(policy: MockPolicy) {
  const tasks = policy.document.tasks ?? []
  for (const job of db.automation.jobs.filter((item) => item.policy?.policy_id === policy.id && !item.deleted)) {
    const task = tasks.find((item) => item.id === job.policy?.task_id)
    if (!task || !task.enabled) {
      job.status = 'cancelled'
      job.next_run_at = null
    }
  }
  for (const task of tasks.filter((item) => item.enabled)) {
    const script = findScript(task.script_id)
    if (!script) continue
    const version =
      (script.approved_version && script.versions.find((item) => item.version === script.approved_version)) ||
      currentVersion(script)
    let job = db.automation.jobs.find(
      (item) => item.policy?.policy_id === policy.id && item.policy.task_id === task.id && !item.deleted,
    )
    if (!job) {
      job = {
        id: uuid(),
        name: `${policy.name} · ${task.name}`,
        script_id: script.id,
        script_version: version.version,
        content_sha256: version.content_sha256,
        parameters: task.parameters,
        target: { type: 'client', ids: db.clients.map((client) => client.id), label: `Policy · ${policy.name}` },
        schedule: { type: 'cron', cron: task.cron, timezone: task.timezone },
        next_run_at: null,
        status: 'scheduled',
        offline_wait_minutes: task.offline_wait_minutes ?? db.automation.settings.default_offline_wait_minutes,
        concurrency: 25,
        timeout_secs: script.timeout_secs,
        created_by_name: `Policy: ${policy.name}`,
        created_by_id: null,
        created_at: now(),
        approved_by_name: null,
        deleted: false,
        policy: { policy_id: policy.id, task_id: task.id },
      }
      db.automation.jobs.push(job)
    }
    Object.assign(job, {
      name: `${policy.name} · ${task.name}`,
      script_id: script.id,
      script_version: version.version,
      content_sha256: version.content_sha256,
      parameters: task.parameters,
      schedule: { type: 'cron', cron: task.cron, timezone: task.timezone },
      offline_wait_minutes: task.offline_wait_minutes ?? db.automation.settings.default_offline_wait_minutes,
    })
    if (job.status === 'cancelled' || job.status === 'completed') job.status = 'scheduled'
    job.next_run_at = nextRunAt(job.schedule)
    job.target = { ...job.target, label: `Policy · ${policy.name}` }
  }
}

/** Touching a policy's `monitoring` section also needs `monitors.manage` (Phase 6). */
function monitoringDenied(request: Request, before: MockPolicy['document'] | undefined, after: MockPolicy['document'] | undefined) {
  const changed = JSON.stringify(before?.monitoring ?? null) !== JSON.stringify(after?.monitoring ?? null)
  return changed ? guard(request, { permission: 'monitors.manage' }) : null
}

const policyHandlers = [
  http.get(`${API}/policies`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'devices.view' })
    if (denied) return denied
    const state = world()
    return HttpResponse.json({
      items: [...db.automation.policies]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((policy) => publicPolicy(state, policy)),
    })
  }),
  http.post(`${API}/policies`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'policies.manage' })
    if (denied) return denied
    const body = (await request.json()) as PolicyInput
    const problem = policyProblem(body)
    if (problem) return problem
    const monitoring = monitoringDenied(request, undefined, compactPolicy(body.document, CHECK_TYPES))
    if (monitoring) return monitoring
    const policy: MockPolicy = {
      id: uuid(),
      name: body.name.trim(),
      description: body.description?.trim() ?? '',
      version: 1,
      document: compactPolicy(body.document, CHECK_TYPES),
      assignments: [],
      updated_at: now(),
      updated_by_name: currentUser()?.name ?? 'Unknown',
    }
    db.automation.policies.push(policy)
    syncPolicyJobs(policy)
    audit('policy.created', { type: 'policy', id: policy.id, name: policy.name })
    persist()
    return HttpResponse.json(publicPolicy(world(), policy), { status: 201 })
  }),
  http.get(`${API}/policies/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'devices.view' })
    if (denied) return denied
    const policy = db.automation.policies.find((item) => item.id === params.id)
    return policy ? HttpResponse.json(publicPolicy(world(), policy)) : fail(404, 'not_found', 'Policy not found.')
  }),
  http.put(`${API}/policies/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'policies.manage' })
    if (denied) return denied
    const policy = db.automation.policies.find((item) => item.id === params.id)
    if (!policy) return fail(404, 'not_found', 'Policy not found.')
    const body = (await request.json()) as PolicyInput
    const problem = policyProblem(body)
    if (problem) return problem
    const monitoring = monitoringDenied(request, policy.document, compactPolicy(body.document, CHECK_TYPES))
    if (monitoring) return monitoring
    policy.name = body.name.trim()
    policy.description = body.description?.trim() ?? ''
    policy.document = compactPolicy(body.document, CHECK_TYPES)
    policy.version += 1
    policy.updated_at = now()
    policy.updated_by_name = currentUser()?.name ?? 'Unknown'
    syncPolicyJobs(policy)
    audit('policy.updated', { type: 'policy', id: policy.id, name: policy.name }, { version: policy.version })
    persist()
    return HttpResponse.json(publicPolicy(world(), policy))
  }),
  http.delete(`${API}/policies/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'policies.manage', stepUp: true })
    if (denied) return denied
    const policy = db.automation.policies.find((item) => item.id === params.id)
    if (!policy) return fail(404, 'not_found', 'Policy not found.')
    const monitoring = monitoringDenied(request, policy.document, undefined)
    if (monitoring) return monitoring
    db.automation.policies = db.automation.policies.filter((item) => item.id !== policy.id)
    for (const job of db.automation.jobs.filter((item) => item.policy?.policy_id === policy.id)) {
      job.status = 'cancelled'
      job.next_run_at = null
    }
    audit('policy.deleted', { type: 'policy', id: policy.id, name: policy.name })
    persist()
    return noContent()
  }),
  http.post(`${API}/policies/:id/assignments`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'policies.manage' })
    if (denied) return denied
    const policy = db.automation.policies.find((item) => item.id === params.id)
    if (!policy) return fail(404, 'not_found', 'Policy not found.')
    const body = (await request.json()) as PolicyAssignmentInput
    const monitoring = monitoringDenied(request, policy.document, undefined)
    if (monitoring) return monitoring
    if (!['global', 'client', 'site', 'group', 'device'].includes(body.target_type))
      return invalid('Choose a target type.', { field: 'target_type' })
    const targetId = body.target_type === 'global' ? null : (body.target_id ?? null)
    if (body.target_type !== 'global') {
      const exists =
        body.target_type === 'client'
          ? db.clients.some((client) => client.id === targetId)
          : body.target_type === 'site'
            ? db.sites.some((site) => site.id === targetId)
            : body.target_type === 'group'
              ? db.automation.groups.some((group) => group.id === targetId)
              : db.devices.some((device) => device.id === targetId)
      if (!exists) return invalid(`Choose a ${body.target_type}.`, { field: 'target_id' })
    }
    if (
      policy.assignments.some(
        (assignment) => assignment.target_type === body.target_type && assignment.target_id === targetId,
      )
    ) {
      return fail(409, 'assignment_exists', 'The policy is already assigned to this target.')
    }
    const priority = Number.isInteger(body.priority) ? (body.priority as number) : 0
    const assignment = { id: uuid(), target_type: body.target_type, target_id: targetId, priority }
    policy.assignments.push(assignment)
    policy.updated_at = now()
    audit(
      'policy.assigned',
      { type: 'policy', id: policy.id, name: policy.name },
      { target_type: assignment.target_type, target_id: assignment.target_id },
    )
    persist()
    return HttpResponse.json(
      publicPolicy(world(), policy).assignments.find((item) => item.id === assignment.id),
      { status: 201 },
    )
  }),
  http.delete(`${API}/policy-assignments/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'policies.manage' })
    if (denied) return denied
    const policy = db.automation.policies.find((item) =>
      item.assignments.some((assignment) => assignment.id === params.id),
    )
    if (!policy) return fail(404, 'not_found', 'Assignment not found.')
    const monitoring = monitoringDenied(request, policy.document, undefined)
    if (monitoring) return monitoring
    policy.assignments = policy.assignments.filter((assignment) => assignment.id !== params.id)
    policy.updated_at = now()
    audit('policy.unassigned', { type: 'policy', id: policy.id, name: policy.name })
    persist()
    return noContent()
  }),
  http.get(`${API}/devices/:id/effective-policy`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'devices.view' })
    if (denied) return denied
    const device = findDevice(params.id)
    if (!device) return fail(404, 'not_found', 'Device not found.')
    return HttpResponse.json(effectivePolicyFor(world(), device))
  }),
]

export const automationHandlers = [
  ...scriptHandlers,
  ...variableHandlers,
  ...jobHandlers,
  ...approvalHandlers,
  ...customFieldHandlers,
  ...groupHandlers,
  ...policyHandlers,
]
