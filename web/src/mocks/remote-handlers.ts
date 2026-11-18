/* MSW handlers for the Phase 4 remote tools (see docs/api-remote.md). */
import { http, HttpResponse } from 'msw/http'
import type { DiagnosticRequest, FileOperation, MessageRequest, PowerRequest, ServiceAction } from '@/lib/api/types'
import { db, persist, randomHex, recordAudit, rescoreDevice, uuid } from './db'
import type { MockDevice } from './devices'
import { API, actor, currentUser, fail, guard, noContent, sleep } from './http-helpers'
import {
  AgentError,
  canonicalPath,
  eventLogsFor,
  fileContent,
  findNode,
  fsRoots,
  isProtectedPath,
  joinMockPath,
  killProcess,
  listChildren,
  parentOf,
  processesFor,
  registryFor,
  runDiagnostic,
  scriptedRecording,
  seedSessionsFor,
  servicesFor,
  splitPath,
  toEntry,
  type FsNode,
  type MockRemoteSession,
} from './remote-data'
import { endMockShell, shellSocketHandler, shellTickets } from './remote-shell'
import { desktopHandlers } from './desktop-handlers'
import { endMockDesktop } from './desktop-stream'
import { emitMockEvent } from './stream'

const MAX_ENTRIES = 5000
/** Devices whose local policy disables the remote shell. */
const SHELL_DISABLED = new Set(['MCU-DC01', 'mcu-core-app'])

/** Round trip to the agent: queries feel quick, actions a little slower. */
const agent = (min = 250, spread = 450) => sleep(min + Math.random() * spread)

const agentError = (message: string) => fail(422, 'device_error', message)

function audit(action: string, device: MockDevice, details: Record<string, unknown> = {}) {
  recordAudit({
    actor: actor(),
    action,
    target: { type: 'device', id: device.id, name: device.hostname },
    client_id: device.client_id,
    site_id: device.site_id,
    ip: '10.20.0.14',
    user_agent: navigator.userAgent,
    details,
  })
  persist()
}

/** Auth, permission, scope (404) and agent reachability, in the server's order. */
function remoteDevice(request: Request, id: unknown, permission: string, options: { stepUp?: boolean } = {}): MockDevice | Response {
  const denied = guard(request, { permission })
  if (denied) return denied
  const device = db.devices.find((item) => item.id === id)
  if (!device) return fail(404, 'not_found', 'Device not found.')
  if (device.status !== 'active') return fail(409, 'device_inactive', 'The device is pending, revoked or retired.')
  if (!device.online) return fail(409, 'device_offline', `${device.hostname} has no live connection.`)
  if (options.stepUp) {
    const stepUp = guard(request, { stepUp: true })
    if (stepUp) return stepUp
  }
  return device
}

function isResponse(value: unknown): value is Response {
  return value instanceof Response
}

function newSession(device: MockDevice, kind: MockRemoteSession['kind'], detail: MockRemoteSession['detail']): MockRemoteSession {
  const now = new Date().toISOString()
  const session: MockRemoteSession = {
    id: uuid(),
    device_id: device.id,
    hostname: device.hostname,
    user_name: currentUser()?.name ?? null,
    kind,
    detail,
    started_at: now,
    connected_at: kind === 'shell' ? null : now,
    ended_at: null,
    end_reason: null,
    bytes_to_device: 0,
    bytes_from_device: 0,
    has_recording: false,
    recording_bytes: null,
    live: kind === 'shell' ? false : true,
  }
  db.remoteSessions.push(session)
  if (db.remoteSessions.length > 400) db.remoteSessions = db.remoteSessions.slice(-400)
  return session
}

function endSession(session: MockRemoteSession, reason: string) {
  session.live = false
  session.ended_at = new Date().toISOString()
  session.end_reason = reason
  persist()
  emitMockEvent('remote.session', { session_id: session.id, device_id: session.device_id, status: 'ended', kind: session.kind })
}

function ensureSeeded(device: MockDevice) {
  if (db.remoteSeeded.includes(device.id)) return
  const names = db.users.filter((user) => user.status === 'active').map((user) => user.name).slice(0, 4)
  db.remoteSessions.push(...seedSessionsFor(device, names.length > 0 ? names : ['Avery Chen']))
  db.remoteSeeded.push(device.id)
  persist()
}

// ------------------------------------------------------------------ power simulation

const scheduledPower = new Map<string, { timer: number; action: 'reboot' | 'shutdown' }>()

function powerCycle(device: MockDevice, action: 'reboot' | 'shutdown') {
  device.online = false
  device.uptime_s = null
  device.last_seen_at = new Date().toISOString()
  rescoreDevice(device)
  persist()
  emitMockEvent('devices.changed', { id: device.id, online: false })
  emitMockEvent('fleet.summary', null)
  // Rebooted devices come back on their own; a shut-down one is "powered on" again later.
  window.setTimeout(
    () => {
      device.online = true
      device.uptime_s = 40
      device.last_seen_at = new Date().toISOString()
      rescoreDevice(device)
      persist()
      emitMockEvent('devices.changed', { id: device.id, online: true })
      emitMockEvent('fleet.summary', null)
    },
    action === 'reboot' ? 25_000 : 120_000,
  )
}

// ------------------------------------------------------------------ handlers

export const remoteHandlers = [
  ...desktopHandlers,
  shellSocketHandler,

  // ------------------------------------------------------------ processes
  http.get(`${API}/devices/:id/processes`, async ({ request, params }) => {
    await agent(200, 300)
    const device = remoteDevice(request, params.id, 'remote.system')
    if (isResponse(device)) return device
    const items = processesFor(device)
    return HttpResponse.json({ count: items.length, items })
  }),

  http.post(`${API}/devices/:id/processes/:pid/kill`, async ({ request, params }) => {
    await agent(300, 500)
    const device = remoteDevice(request, params.id, 'remote.system')
    if (isResponse(device)) return device
    const pid = Number(params.pid)
    const body = (await request.json().catch(() => ({}))) as { tree?: boolean }
    const target = processesFor(device).find((item) => item.pid === pid)
    if (!target) return agentError(device.os_family === 'windows' ? `The process "${pid}" not found. (os error 87)` : `No such process (os error 3)`)
    if (pid === 0 || (device.os_family === 'windows' && pid === 4) || (device.os_family !== 'windows' && pid === 1)) {
      return agentError(`refusing to terminate a critical system process (PID ${pid})`)
    }
    if (/rustrmm-agent/i.test(target.name)) return agentError('refusing to terminate the RustRMM agent itself')
    if (device.os_family === 'windows' && ['csrss.exe', 'wininit.exe', 'smss.exe', 'lsass.exe'].includes(target.name)) {
      return agentError('Access is denied. (os error 5)')
    }
    const terminated = killProcess(device, pid, Boolean(body.tree))
    audit('remote.process_killed', device, { pid, name: target.name, tree: Boolean(body.tree), terminated })
    return HttpResponse.json({ ok: true, message: '', data: { pid, name: target.name, terminated } })
  }),

  // ------------------------------------------------------------ services
  http.get(`${API}/devices/:id/services`, async ({ request, params }) => {
    await agent(250, 400)
    const device = remoteDevice(request, params.id, 'remote.system')
    if (isResponse(device)) return device
    return HttpResponse.json({ items: [...servicesFor(device).values()] })
  }),

  http.post(`${API}/devices/:id/services/:name/:action`, async ({ request, params }) => {
    const device = remoteDevice(request, params.id, 'remote.system')
    if (isResponse(device)) return device
    const action = String(params.action) as ServiceAction
    if (!['start', 'stop', 'restart'].includes(action)) return fail(404, 'not_found', 'Unknown action.')
    const name = decodeURIComponent(String(params.name))
    const service = servicesFor(device).get(name)
    await agent(action === 'restart' ? 1400 : 800, 900)
    if (!service) return agentError(device.os_family === 'windows' ? 'The specified service does not exist as an installed service. (os error 1060)' : `Unit ${name} not found.`)
    if (/rustrmm/i.test(name) && action === 'stop') return agentError('refusing to stop the RustRMM agent service')
    if (action !== 'stop' && service.start_mode === 'disabled') {
      return agentError('The service cannot be started, either because it is disabled or because it has no enabled devices associated with it. (os error 1058)')
    }
    if (action !== 'stop' && /^certbot/.test(name)) {
      return agentError(`Job for ${name} failed because the control process exited with error code.\nSee "systemctl status ${name}" and "journalctl -xeu ${name}" for details.`)
    }
    if (device.os_family === 'linux') {
      service.state = action === 'stop' ? 'dead' : 'running'
      service.active = action === 'stop' ? 'inactive' : 'active'
    } else {
      service.state = action === 'stop' ? 'stopped' : 'running'
      if (device.os_family === 'macos') service.last_exit = action === 'stop' ? 0 : service.last_exit
    }
    audit(`remote.service_${action}`, device, { service: name })
    return HttpResponse.json({ ok: true, data: { name, action, state: service.state } })
  }),

  // ------------------------------------------------------------ event logs
  http.get(`${API}/devices/:id/event-logs`, async ({ request, params }) => {
    const device = remoteDevice(request, params.id, 'remote.system')
    if (isResponse(device)) return device
    const url = new URL(request.url)
    const log = url.searchParams.get('log') ?? ''
    const level = Math.max(0, Math.min(4, Number(url.searchParams.get('level')) || 0))
    const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get('limit')) || 200))
    const hours = Math.max(1, Math.min(24 * 30, Number(url.searchParams.get('hours')) || 24))
    await agent(device.os_family === 'windows' ? 500 : 300, 500)
    try {
      const items = eventLogsFor(device, device.os_family === 'macos' ? '' : log, level, hours, limit)
      return HttpResponse.json({ log: log || (device.os_family === 'windows' ? 'System' : ''), hours, items })
    } catch (error) {
      if (error instanceof AgentError) return agentError(error.message)
      throw error
    }
  }),

  // ------------------------------------------------------------ registry
  http.get(`${API}/devices/:id/registry`, async ({ request, params }) => {
    await agent(150, 250)
    const device = remoteDevice(request, params.id, 'remote.system')
    if (isResponse(device)) return device
    if (device.os_family !== 'windows') return agentError('the registry is only available on Windows')
    const path = new URL(request.url).searchParams.get('path') ?? ''
    try {
      return HttpResponse.json(registryFor(device, path))
    } catch (error) {
      if (error instanceof AgentError) return agentError(error.message)
      throw error
    }
  }),

  // ------------------------------------------------------------ power and messages
  http.post(`${API}/devices/:id/power`, async ({ request, params }) => {
    const body = (await request.clone().json().catch(() => ({}))) as Partial<PowerRequest>
    const action = body.action
    if (!action || !['reboot', 'shutdown', 'cancel', 'lock', 'logoff'].includes(action)) return fail(422, 'validation', 'Unknown power action.')
    const device = remoteDevice(request, params.id, 'remote.power', { stepUp: action === 'reboot' || action === 'shutdown' || action === 'logoff' })
    if (isResponse(device)) return device
    await agent(400, 500)
    if (device.os_family === 'macos' && (action === 'lock' || action === 'logoff')) return agentError(`${action} is not supported on macOS`)
    const delay = Math.max(0, Math.min(86_400, Number(body.delay_secs) || 0))
    if (action === 'cancel') {
      const pending = scheduledPower.get(device.id)
      if (!pending) {
        return agentError(device.os_family === 'windows' ? 'Unable to abort the system shutdown because no shutdown was in progress.(1116)' : 'No scheduled shutdown to cancel.')
      }
      window.clearTimeout(pending.timer)
      scheduledPower.delete(device.id)
      audit('remote.power_cancelled', device)
      return HttpResponse.json({ ok: true, message: '' })
    }
    if (action === 'reboot' || action === 'shutdown') {
      const effective = device.os_family === 'linux' ? Math.ceil(delay / 60) * 60 : delay
      if (effective === 0) {
        window.setTimeout(() => powerCycle(device, action), 2500)
      } else {
        const existing = scheduledPower.get(device.id)
        if (existing) window.clearTimeout(existing.timer)
        scheduledPower.set(device.id, {
          action,
          timer: window.setTimeout(() => {
            scheduledPower.delete(device.id)
            powerCycle(device, action)
          }, effective * 1000),
        })
      }
      audit(`remote.power_${action}`, device, { delay_secs: effective, message: body.message ?? '' })
      return HttpResponse.json({ ok: true, message: '', data: { action, delay_secs: effective } })
    }
    audit(`remote.power_${action}`, device)
    return HttpResponse.json({ ok: true, message: '' })
  }),

  http.post(`${API}/devices/:id/message`, async ({ request, params }) => {
    const device = remoteDevice(request, params.id, 'remote.power')
    if (isResponse(device)) return device
    const body = (await request.json().catch(() => ({}))) as Partial<MessageRequest>
    if (!body.body?.trim()) return fail(422, 'validation', 'The message body is required.')
    await agent(500, 400)
    if (device.os_family === 'windows' && isServerName(device) && !device.last_user) {
      return agentError('No interactive user session is active on this device.')
    }
    audit('remote.message_sent', device, { title: body.title ?? '', length: body.body.length })
    return HttpResponse.json({ ok: true, message: '' })
  }),

  // ------------------------------------------------------------ diagnostics
  http.post(`${API}/devices/:id/diagnostics`, async ({ request, params }) => {
    const device = remoteDevice(request, params.id, 'remote.system')
    if (isResponse(device)) return device
    const body = (await request.json().catch(() => ({}))) as Partial<DiagnosticRequest>
    const target = (body.target ?? '').trim()
    if (!body.kind || !['ping', 'traceroute', 'dns', 'port'].includes(body.kind)) return fail(422, 'validation', 'Unknown diagnostic.')
    if (!target || /\s/.test(target) || target.startsWith('-') || target.length > 253) {
      return fail(422, 'validation', 'The target must be a host name or an IP address.')
    }
    if (body.kind === 'port' && !(Number(body.port) >= 1 && Number(body.port) <= 65535)) return fail(422, 'validation', 'The port must be between 1 and 65535.')
    const { delay, result } = runDiagnostic(device, body.kind, target, body.port)
    await sleep(delay)
    audit('remote.diagnostic', device, { kind: body.kind, target, port: body.port ?? null })
    return HttpResponse.json(result)
  }),

  // ------------------------------------------------------------ files
  http.get(`${API}/devices/:id/files`, async ({ request, params }) => {
    await agent(150, 300)
    const device = remoteDevice(request, params.id, 'remote.files')
    if (isResponse(device)) return device
    const path = new URL(request.url).searchParams.get('path') ?? ''
    const windows = device.os_family === 'windows'
    const separator = windows ? '\\' : '/'
    if (!path) {
      const roots = [...fsRoots(device).values()]
      const entries = roots.map((node) => toEntry(device, node, windows ? `${node.name}\\` : '/', windows))
      return HttpResponse.json({ path: '', parent: null, separator, truncated: false, entries })
    }
    const split = splitPath(device, path)
    if (!split) return agentError('Paths must be absolute.')
    if (/system volume information/i.test(path)) return agentError('Access is denied. (os error 5)')
    const node = findNode(device, path)
    if (!node) return agentError(windows ? 'The system cannot find the path specified. (os error 3)' : 'No such file or directory (os error 2)')
    if (!node.dir) return agentError(windows ? 'The directory name is invalid. (os error 267)' : 'Not a directory (os error 20)')
    const canonical = canonicalPath(device, path)
    const all = listChildren(device, node, canonical)
    return HttpResponse.json({
      path: canonical,
      parent: parentOf(device, canonical),
      separator,
      truncated: all.length > MAX_ENTRIES,
      entries: all.slice(0, MAX_ENTRIES),
    })
  }),

  http.post(`${API}/devices/:id/files/op`, async ({ request, params }) => {
    await agent(250, 400)
    const device = remoteDevice(request, params.id, 'remote.files')
    if (isResponse(device)) return device
    const body = (await request.json().catch(() => ({}))) as Partial<FileOperation> & Record<string, unknown>
    const windows = device.os_family === 'windows'
    const exists = windows ? 'Cannot create a file when that file already exists. (os error 183)' : 'File exists (os error 17)'
    const missing = windows ? 'The system cannot find the file specified. (os error 2)' : 'No such file or directory (os error 2)'
    const absolute = (value: unknown): value is string => typeof value === 'string' && splitPath(device, value) !== null

    if (body.op === 'mkdir') {
      if (!absolute(body.path)) return fail(422, 'validation', 'Paths must be absolute.')
      if (isProtectedPath(device, body.path)) return agentError(`refusing to modify a protected path: ${body.path}`)
      const parent = findNode(device, parentOf(device, body.path) ?? '')
      if (!parent?.dir) return agentError(missing)
      const name = body.path.split(/[\\/]/).filter(Boolean).pop()!
      if (parent.children?.has(name.toLowerCase())) return agentError(exists)
      parent.children?.set(name.toLowerCase(), { name, dir: true, size: 0, modified: Date.now(), children: new Map() })
      audit('remote.file_mkdir', device, { path: body.path })
      return HttpResponse.json({ ok: true, message: '' })
    }
    if (body.op === 'rename') {
      if (!absolute(body.from) || !absolute(body.to)) return fail(422, 'validation', 'Paths must be absolute.')
      if (isProtectedPath(device, body.from) || isProtectedPath(device, body.to)) return agentError(`refusing to modify a protected path: ${body.from}`)
      const sourceParent = findNode(device, parentOf(device, body.from) ?? '')
      const sourceName = body.from.split(/[\\/]/).filter(Boolean).pop()!.toLowerCase()
      const node = sourceParent?.children?.get(sourceName)
      if (!node || !sourceParent) return agentError(missing)
      const targetParent = findNode(device, parentOf(device, body.to) ?? '')
      if (!targetParent?.dir) return agentError(missing)
      const targetName = body.to.split(/[\\/]/).filter(Boolean).pop()!
      const sameEntry = targetParent === sourceParent && targetName.toLowerCase() === sourceName
      if (!sameEntry && targetParent.children?.has(targetName.toLowerCase())) return agentError(exists)
      sourceParent.children?.delete(sourceName)
      node.name = targetName
      node.modified = Date.now()
      targetParent.children?.set(targetName.toLowerCase(), node)
      audit('remote.file_renamed', device, { from: body.from, to: body.to })
      return HttpResponse.json({ ok: true, message: '' })
    }
    if (body.op === 'delete') {
      if (!absolute(body.path)) return fail(422, 'validation', 'Paths must be absolute.')
      if (isProtectedPath(device, body.path)) return agentError(`refusing to modify a protected path: ${body.path}`)
      const parent = findNode(device, parentOf(device, body.path) ?? '')
      const name = body.path.split(/[\\/]/).filter(Boolean).pop()!.toLowerCase()
      const node = parent?.children?.get(name)
      if (!node || !parent) return agentError(missing)
      if (node.dir && (node.children?.size ?? 0) + (node.bulk ?? 0) > 0 && !body.recursive) {
        return agentError(windows ? 'The directory is not empty. (os error 145)' : 'Directory not empty (os error 39)')
      }
      parent.children?.delete(name)
      audit('remote.file_deleted', device, { path: body.path, recursive: Boolean(body.recursive) })
      return HttpResponse.json({ ok: true, message: '' })
    }
    return fail(422, 'validation', 'Unknown file operation.')
  }),

  http.get(`${API}/devices/:id/files/download`, async ({ request, params }) => {
    await agent(200, 300)
    const device = remoteDevice(request, params.id, 'remote.files')
    if (isResponse(device)) return device
    const path = new URL(request.url).searchParams.get('path') ?? ''
    const node = findNode(device, path)
    if (!node) return agentError(device.os_family === 'windows' ? 'The system cannot find the file specified. (os error 2)' : 'No such file or directory (os error 2)')
    if (node.dir) return agentError('Is a directory')
    const blob = fileContent(node, path)
    const session = newSession(device, 'download', { path })
    session.bytes_from_device = blob.size
    endSession(session, 'Completed')
    audit('remote.file_downloaded', device, { path, bytes: blob.size })
    return new HttpResponse(blob, {
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(blob.size),
        'content-disposition': `attachment; filename="${node.name.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(node.name)}`,
      },
    })
  }),

  http.post(`${API}/devices/:id/files/upload`, async ({ request, params }) => {
    const device = remoteDevice(request, params.id, 'remote.files')
    if (isResponse(device)) return device
    const url = new URL(request.url)
    const path = url.searchParams.get('path') ?? ''
    const overwrite = url.searchParams.get('overwrite') === 'true'
    if (!splitPath(device, path)) return fail(422, 'validation', 'The target path must be absolute.')
    if (isProtectedPath(device, path)) return agentError(`refusing to modify a protected path: ${path}`)
    const parentPath = parentOf(device, path)
    const parent = findNode(device, parentPath ?? '')
    if (!parent?.dir) return agentError(device.os_family === 'windows' ? 'The system cannot find the path specified. (os error 3)' : 'No such file or directory (os error 2)')
    const name = path.split(/[\\/]/).filter(Boolean).pop()!
    const existing = parent.children?.get(name.toLowerCase())
    if (existing && !overwrite) return agentError(`The file already exists: ${path}`)
    if (existing?.dir) return agentError('Is a directory')
    const buffer = await request.arrayBuffer()
    if (buffer.byteLength > 2 * 1024 ** 3) return fail(413, 'too_large', 'Uploads are limited to 2 GiB.')
    const session = newSession(device, 'upload', { path })
    persist()
    emitMockEvent('remote.session', { session_id: session.id, device_id: device.id, status: 'active', kind: 'upload' })
    // Simulate the tunnel to the agent: about 6 MB/s, at least half a second.
    await sleep(Math.min(6000, 500 + buffer.byteLength / 6_000))
    const node: FsNode = { name, dir: false, size: buffer.byteLength, modified: Date.now(), content: new Blob([buffer]) }
    parent.children?.set(name.toLowerCase(), node)
    session.bytes_to_device = buffer.byteLength
    endSession(session, 'Completed')
    audit('remote.file_uploaded', device, { path, bytes: buffer.byteLength, overwrite })
    return HttpResponse.json({ ok: true, bytes: buffer.byteLength, path: joinMockPath(device, parentPath ?? '', name) })
  }),

  // ------------------------------------------------------------ shell
  http.post(`${API}/devices/:id/shell`, async ({ request, params }) => {
    const device = remoteDevice(request, params.id, 'remote.shell', { stepUp: true })
    if (isResponse(device)) return device
    const body = (await request.json().catch(() => ({}))) as { shell?: string; cols?: number; rows?: number }
    const windows = device.os_family === 'windows'
    const allowed = windows ? ['', 'powershell', 'pwsh', 'cmd'] : ['', 'bash', 'zsh', 'sh']
    const requested = body.shell ?? ''
    if (!allowed.includes(requested)) return fail(422, 'validation', `Unknown shell “${requested}”.`)
    await agent(300, 300)
    if (SHELL_DISABLED.has(device.hostname)) return agentError('shell is disabled on this device by local policy')
    if (requested === 'pwsh' && device.os_name.includes('Windows 10')) return agentError('pwsh.exe was not found on this device. Install PowerShell 7 or use Windows PowerShell.')
    if (requested === 'zsh' && device.os_family === 'linux' && !device.os_name.startsWith('Ubuntu')) return agentError('zsh is not installed on this device')
    const shell = requested || (windows ? 'powershell' : device.os_family === 'macos' ? 'zsh' : 'bash')
    const cols = Math.max(20, Math.min(400, Number(body.cols) || 120))
    const rows = Math.max(5, Math.min(200, Number(body.rows) || 32))
    const session = newSession(device, 'shell', { shell, cols, rows })
    const ticket = randomHex(32)
    shellTickets.set(session.id, { ticket, sessionId: session.id, deviceId: device.id, shell, cols, rows, expires: Date.now() + 30_000 })
    persist()
    audit('remote.shell_opened', device, { session_id: session.id, shell })
    window.setTimeout(() => {
      if (shellTickets.has(session.id) && !session.connected_at) {
        shellTickets.delete(session.id)
        endSession(session, 'The browser did not connect before the ticket expired')
      }
    }, 31_000)
    return HttpResponse.json({ session_id: session.id, ticket, expires_in: 30 })
  }),

  // ------------------------------------------------------------ sessions
  http.get(`${API}/remote-sessions`, async ({ request }) => {
    await sleep(120 + Math.random() * 200)
    const denied = guard(request, { permission: 'devices.view' })
    if (denied) return denied
    const url = new URL(request.url)
    const deviceId = url.searchParams.get('device_id')
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 100))
    if (deviceId) {
      const device = db.devices.find((item) => item.id === deviceId)
      if (!device) return fail(404, 'not_found', 'Device not found.')
      if (device.status === 'active') ensureSeeded(device)
    }
    const items = db.remoteSessions
      .filter((session) => !deviceId || session.device_id === deviceId)
      .sort((a, b) => b.started_at.localeCompare(a.started_at))
      .slice(0, limit)
      .map((session) => {
        const { script: _script, ...rest } = session
        void _script
        return rest
      })
    return HttpResponse.json({ items })
  }),

  http.get(`${API}/remote-sessions/:id/recording`, async ({ request, params }) => {
    await sleep(150 + Math.random() * 250)
    const denied = guard(request, { permission: 'remote.recordings' })
    if (denied) return denied
    const session = db.remoteSessions.find((item) => item.id === params.id)
    if (!session) return fail(404, 'not_found', 'Session not found.')
    const text = db.recordings[session.id] ?? (session.script ? scriptedRecording(session, db.devices.find((item) => item.id === session.device_id)) : null)
    if (!text || !session.has_recording) return fail(404, 'not_found', 'This session has no recording.')
    return new HttpResponse(text, { headers: { 'content-type': 'application/x-asciicast' } })
  }),

  http.post(`${API}/remote-sessions/:id/end`, async ({ request, params }) => {
    await sleep(200 + Math.random() * 200)
    const session = db.remoteSessions.find((item) => item.id === params.id)
    // Ending a desktop session needs remote.desktop; shells and transfers need remote.shell.
    const denied = guard(request, { permission: session?.kind === 'desktop' ? 'remote.desktop' : 'remote.shell' })
    if (denied) return denied
    if (!session) return fail(404, 'not_found', 'Session not found.')
    if (!session.live) return fail(409, 'not_live', 'This session has already ended.')
    const ended = session.kind === 'desktop' ? endMockDesktop(session.id, 'Ended by an administrator') : endMockShell(session.id, 'Ended by an administrator')
    if (!ended) endSession(session, 'Ended by an administrator')
    const device = db.devices.find((item) => item.id === session.device_id)
    if (device) audit('remote.session_ended', device, { session_id: session.id })
    return noContent()
  }),
]

function isServerName(device: MockDevice) {
  return device.os_name.includes('Server')
}
