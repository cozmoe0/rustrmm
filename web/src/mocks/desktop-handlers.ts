/* MSW handlers for remote desktop (Phase 8, docs/api-desktop.md): sessions, new sessions, screenshots. */
import { http, HttpResponse } from 'msw/http'
import type { DesktopCreateRequest } from '@/lib/api/types'
import { DESKTOP_QUALITIES } from '@/lib/desktop/control'
import { db, persist, randomHex, recordAudit, uuid } from './db'
import type { MockDevice } from './devices'
import { consentRequired, desktopPolicyFor, monitorsFor, resolveSession, scenarioFor, sessionsFor } from './desktop-data'
import { canvasToJpeg, createSurface } from './desktop-encoder'
import { DesktopScene } from './desktop-scene'
import { desktopSocketHandler, desktopTickets, registerDesktopTicket } from './desktop-stream'
import { API, currentUser, fail, guard, sleep } from './http-helpers'
import type { MockRemoteSession } from './remote-data'
import { emitMockEvent } from './stream'

const agent = (min = 250, spread = 400) => sleep(min + Math.random() * spread)

function audit(action: string, device: MockDevice, details: Record<string, unknown>) {
  const user = currentUser()
  recordAudit({
    actor: { type: 'user', id: user?.id ?? null, name: user?.name ?? null },
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

/** Auth, permission, scope, policy and reachability, in the server's order. */
function desktopDevice(request: Request, id: unknown, options: { stepUp?: boolean } = {}): MockDevice | Response {
  const denied = guard(request, { permission: 'remote.desktop' })
  if (denied) return denied
  const device = db.devices.find((item) => item.id === id)
  if (!device) return fail(404, 'not_found', 'Device not found.')
  const policy = desktopPolicyFor(device)
  if (!policy.enabled) {
    return HttpResponse.json(
      {
        error: {
          code: 'disabled_by_policy',
          message: 'Remote desktop is disabled by policy for this device.',
          details: { feature: 'desktop', policy_id: policy.refusedBy?.id ?? null, policy_name: policy.refusedBy?.name ?? null },
        },
      },
      { status: 403 },
    )
  }
  if (device.status !== 'active') return fail(409, 'device_inactive', 'The device is pending, revoked or retired.')
  if (!device.online) return fail(409, 'device_offline', `${device.hostname} has no live connection.`)
  if (options.stepUp) {
    const stepUp = guard(request, { stepUp: true })
    if (stepUp) return stepUp
  }
  return device
}

const isResponse = (value: unknown): value is Response => value instanceof Response

/** Paints the console's primary monitor and scales it to at most 1280 px wide. */
export async function renderScreenshot(device: MockDevice): Promise<{ blob: Blob; width: number; height: number }> {
  const monitor = monitorsFor(device)[0]
  const target = resolveSession(device, undefined)
  const windows = device.os_family === 'windows'
  const scene = new DesktopScene({
    theme: windows ? 'windows' : 'linux',
    width: monitor.width,
    height: monitor.height,
    monitor: 0,
    hostname: device.hostname,
    user: target?.user ?? null,
    secure: windows ? (target?.state === 'login_screen' ? 'signin' : target?.state === 'locked' ? 'lock' : null) : null,
  })
  const full = createSurface(monitor.width, monitor.height, false)
  scene.paint(full.ctx, { x: 0, y: 0, w: monitor.width, h: monitor.height })
  const scale = Math.min(1, 1280 / monitor.width)
  const width = Math.round(monitor.width * scale)
  const height = Math.round(monitor.height * scale)
  const out = createSurface(width, height, false)
  out.ctx.imageSmoothingQuality = 'high'
  out.ctx.drawImage(full.canvas, 0, 0, width, height)
  return { blob: await canvasToJpeg(out.canvas, 0.8), width, height }
}

export const desktopHandlers = [
  desktopSocketHandler,

  http.get(`${API}/devices/:id/desktop/sessions`, async ({ request, params }) => {
    await agent(200, 300)
    const device = desktopDevice(request, params.id)
    if (isResponse(device)) return device
    if (scenarioFor(device).localDisabled) return fail(422, 'device_error', 'remote desktop is disabled on this device by local policy')
    return HttpResponse.json(sessionsFor(device))
  }),

  http.post(`${API}/devices/:id/desktop`, async ({ request, params }) => {
    const device = desktopDevice(request, params.id, { stepUp: true })
    if (isResponse(device)) return device
    const body = (await request.json().catch(() => ({}))) as DesktopCreateRequest
    const quality = body.quality ?? 'auto'
    if (!DESKTOP_QUALITIES.includes(quality)) return fail(422, 'validation', `Unknown quality “${String(quality)}”.`)
    await agent(300, 300)
    if (device.os_family === 'macos') return fail(422, 'device_error', 'Remote desktop on macOS is not available yet')
    if (scenarioFor(device).localDisabled) return fail(422, 'device_error', 'remote desktop is disabled on this device by local policy')
    if (device.os_family === 'windows' && body.session_id !== undefined && !sessionsFor(device).items.some((item) => item.session_id === body.session_id)) {
      return fail(422, 'device_error', `Session ${body.session_id} does not exist on this device`)
    }
    const policy = desktopPolicyFor(device)
    const viewOnly = Boolean(body.view_only) || policy.viewOnly
    const sessionId = device.os_family === 'linux' ? (resolveSession(device, undefined)?.session_id ?? null) : (body.session_id ?? resolveSession(device, undefined)?.session_id ?? null)
    const now = new Date().toISOString()
    const session: MockRemoteSession = {
      id: uuid(),
      device_id: device.id,
      hostname: device.hostname,
      user_name: currentUser()?.name ?? null,
      kind: 'desktop',
      detail: { session_id: sessionId, view_only: viewOnly, quality, consent: null },
      started_at: now,
      connected_at: null,
      ended_at: null,
      end_reason: null,
      bytes_to_device: 0,
      bytes_from_device: 0,
      has_recording: false,
      recording_bytes: null,
      live: false,
    }
    db.remoteSessions.push(session)
    if (db.remoteSessions.length > 400) db.remoteSessions = db.remoteSessions.slice(-400)
    const ticket = randomHex(32)
    registerDesktopTicket({
      ticket,
      sessionId: session.id,
      deviceId: device.id,
      desktopSessionId: body.session_id,
      viewOnly,
      forcedViewOnly: policy.viewOnly,
      quality,
      expires: Date.now() + 30_000,
      technician: currentUser()?.name ?? 'A technician',
    })
    audit('remote.desktop.opened', device, { session_id: session.id, windows_session: sessionId, view_only: viewOnly, forced: policy.viewOnly, quality })
    window.setTimeout(() => {
      if (desktopTickets.has(session.id) && !session.connected_at && !session.ended_at) {
        desktopTickets.delete(session.id)
        session.ended_at = new Date().toISOString()
        session.end_reason = 'The browser did not connect before the ticket expired'
        persist()
        emitMockEvent('remote.session', { session_id: session.id, device_id: device.id, status: 'ended', kind: 'desktop' })
      }
    }, 31_000)
    return HttpResponse.json({ session_id: session.id, ticket, expires_in: 30 })
  }),

  http.get(`${API}/devices/:id/screenshot`, async ({ request, params }) => {
    await agent(250, 300)
    const device = desktopDevice(request, params.id)
    if (isResponse(device)) return device
    const scenario = scenarioFor(device)
    if (device.os_family === 'macos') return fail(422, 'device_error', 'Screenshots on macOS are not available yet')
    if (scenario.localDisabled) return fail(422, 'device_error', 'remote desktop is disabled on this device by local policy')
    if (scenario.streamError) return fail(422, 'device_error', scenario.streamError)
    const policy = desktopPolicyFor(device)
    const target = resolveSession(device, undefined)
    let consent: 'not_required' | 'granted' | 'denied' | 'timeout' = 'not_required'
    if (consentRequired(policy, target)) {
      consent = scenario.consentAnswer
      await sleep(consent === 'timeout' ? Math.min(policy.timeoutSecs, 8) * 1000 : consent === 'denied' ? 2400 : 1400)
      if (consent !== 'granted') {
        audit('remote.screenshot', device, { outcome: consent, size: 0, consent })
        return fail(422, 'device_error', consent === 'denied' ? 'The user denied the screenshot' : 'The user did not answer the consent prompt')
      }
    }
    const { blob, width, height } = await renderScreenshot(device)
    audit('remote.screenshot', device, { outcome: 'ok', size: blob.size, width, height, consent })
    return new HttpResponse(blob, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-store' } })
  }),
]
