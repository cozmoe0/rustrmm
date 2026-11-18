/*
 * Mock remote desktop agent over MSW's WebSocket support. It speaks the real protocol: consent,
 * `ready` (again after a monitor switch), binary tiles / copy rects / frame ends / cursor messages
 * in the exact little-endian layouts, at most two frames in flight until acked, stats every 2 s,
 * input handling (mouse, keys, text, wheel, Ctrl+Alt+Del), secure-desktop transitions, clipboard
 * echo, view-only enforcement and the 30-minute idle timeout.
 */
import { ws } from 'msw/ws'
import {
  MAX_CLIPBOARD_BYTES,
  MAX_FRAMES_IN_FLIGHT,
  QUALITY_JPEG,
  FRAME_WRITE_OFF_MS,
  IDLE_TIMEOUT_MS,
  utf8Length,
  type DesktopBrowserMessage,
  type DesktopQuality,
  type MonitorInfo,
} from '@/lib/desktop/control'
import { encodeMedia } from '@/lib/desktop/protocol'
import { db, persist, recordAudit } from './db'
import type { MockDevice } from './devices'
import { consentRequired, desktopPolicyFor, monitorsFor, resolveSession, scenarioFor } from './desktop-data'
import { createSurface, cursorShapes, encodeFrame, type Surface } from './desktop-encoder'
import { DesktopScene, type CursorKind } from './desktop-scene'
import type { MockRemoteSession } from './remote-data'
import { emitMockEvent } from './stream'

/** Message types only the agent or server send. */
const AGENT_ONLY = new Set(['ready', 'desktop', 'resize', 'consent', 'stats', 'exit', 'error', 'closed', 'status'])

export interface DesktopTicketInfo {
  ticket: string
  sessionId: string
  deviceId: string
  desktopSessionId: number | undefined
  viewOnly: boolean
  forcedViewOnly: boolean
  quality: DesktopQuality
  expires: number
  technician: string
}

/** Tickets issued by `POST /devices/:id/desktop`, valid once for 30 s. */
export const desktopTickets = new Map<string, DesktopTicketInfo>()
/** Every desktop session id, so the shell socket handler leaves these connections alone. */
const desktopSessionIds = new Set<string>()
const live = new Map<string, (reason: string) => void>()

// A reload or closed tab takes the in-page mock agent with it: record the end like the server would.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    for (const end of [...live.values()]) end('Closed by operator')
  })
}

export function registerDesktopTicket(info: DesktopTicketInfo) {
  desktopTickets.set(info.sessionId, info)
  desktopSessionIds.add(info.sessionId)
}

export function isDesktopSession(sessionId: string) {
  return desktopSessionIds.has(sessionId)
}

/** Ends a live mock desktop (administrator `POST /remote-sessions/:id/end`). */
export function endMockDesktop(sessionId: string, reason: string): boolean {
  const end = live.get(sessionId)
  if (!end) return false
  end(reason)
  return true
}

function audit(action: string, device: MockDevice, details: Record<string, unknown>) {
  const user = db.users.find((item) => item.id === db.meUserId)
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
}

/** Auto quality: starts at 65 and 20 fps; adapts every 2 s from the ack round trip (docs/api-desktop.md). */
class Adaptation {
  quality = 65
  fps = 20
  update(rttMs: number, blockedShare: number) {
    if (rttMs > 300 || blockedShare > 0.5) {
      this.quality = Math.max(35, this.quality - 10)
      this.fps = Math.max(5, Math.round(this.fps * (2 / 3)))
    } else if (rttMs > 150 || blockedShare > 0.2) {
      this.quality = Math.max(35, this.quality - 5)
      this.fps = Math.max(5, this.fps - 3)
    } else if (rttMs < 80 && blockedShare < 0.05) {
      this.quality = Math.min(82, this.quality + 3)
      this.fps = Math.min(30, this.fps + 5)
    }
  }
}

export const desktopSocketHandler = ws.link('*/api/v1/remote-sessions/:sessionId/ws').addEventListener('connection', ({ client, params }) => {
  const sessionId = String(params.sessionId)
  if (!desktopSessionIds.has(sessionId)) return
  const url = new URL(client.url)
  const info = desktopTickets.get(sessionId)
  const session = db.remoteSessions.find((item) => item.id === sessionId) as MockRemoteSession | undefined
  const device = db.devices.find((item) => item.id === info?.deviceId)

  if (!info || !device || !session || url.searchParams.get('ticket') !== info.ticket || info.expires < Date.now()) {
    client.send(JSON.stringify({ type: 'error', message: 'The session ticket is invalid or has expired.' }))
    client.send(JSON.stringify({ type: 'closed', reason: 'Invalid ticket' }))
    window.setTimeout(() => client.close(1008, 'Invalid ticket'), 30)
    return
  }
  desktopTickets.delete(sessionId)

  const policy = desktopPolicyFor(device)
  const scenario = scenarioFor(device)
  const target = resolveSession(device, info.desktopSessionId)
  const monitors: MonitorInfo[] = monitorsFor(device)
  const started = Date.now()
  const timers: number[] = []
  let closed = false
  let streaming = false
  let viewOnly = info.viewOnly || policy.viewOnly
  let quality: DesktopQuality = info.quality
  const adaptation = new Adaptation()
  let active = 0
  let generation = 0
  let seq = 0
  let encoding = false
  let lastFrameAt = 0
  let pumpTimer = 0
  const schedulePump = (ms: number) => {
    window.clearTimeout(pumpTimer)
    pumpTimer = window.setTimeout(() => pump(), ms)
  }
  const inFlight = new Map<number, number>()
  const window2s = { frames: 0, bytes: 0, encodeMs: 0, rtt: [] as number[], blockedMs: 0, startedAt: performance.now() }
  let blockedSince: number | null = null
  let lastInput = Date.now()
  const pointer = { x: 0, y: 0, buttons: 0, visible: true }
  let cursorKind: CursorKind = 'arrow'
  const modifiers = { ctrl: false }
  const counts = { cad: 0, toDevice: 0, fromDevice: 0, dropped: 0 }

  const scenes = new Map<number, { scene: DesktopScene; surface: Surface }>()
  const view = (id: number) => {
    let entry = scenes.get(id)
    if (!entry) {
      const monitor = monitors.find((item) => item.id === id) ?? monitors[0]
      const initialSecure = id === 0 && target ? (target.state === 'login_screen' ? 'signin' : target.state === 'locked' ? 'lock' : null) : null
      const scene = new DesktopScene({
        theme: scenario.theme,
        width: monitor.width,
        height: monitor.height,
        monitor: id === 0 ? 0 : 1,
        hostname: device.hostname,
        user: target?.user ?? null,
        secure: scenario.theme === 'windows' ? initialSecure : null,
        events: {
          desktop: (name) => {
            sendJson({ type: 'desktop', name })
            pump()
          },
          clipboard: (text) => sendClipboard(text),
          resize: (width, height) => resizeMonitor(id, width, height),
        },
      })
      entry = { scene, surface: createSurface(monitor.width, monitor.height) }
      scenes.set(id, entry)
    }
    return entry
  }

  const sendJson = (message: object) => {
    if (closed) return
    client.send(JSON.stringify(message))
  }

  const sendBinary = (bytes: Uint8Array<ArrayBuffer>) => {
    if (closed) return
    client.send(bytes)
    session.bytes_from_device += bytes.byteLength
    window2s.bytes += bytes.byteLength
  }

  const sendClipboard = (text: string) => {
    if (viewOnly || !streaming || utf8Length(text) > MAX_CLIPBOARD_BYTES) return
    counts.fromDevice += 1
    sendJson({ type: 'clipboard', text })
  }

  const finish = (reason: string, options: { notify?: boolean; exit?: boolean } = {}) => {
    if (closed) return
    if (options.exit) sendJson({ type: 'exit', code: null })
    if (options.notify !== false) sendJson({ type: 'closed', reason })
    closed = true
    streaming = false
    window.clearTimeout(pumpTimer)
    timers.forEach((timer) => window.clearTimeout(timer))
    timers.forEach((timer) => window.clearInterval(timer))
    live.delete(sessionId)
    session.live = false
    session.ended_at = new Date().toISOString()
    session.end_reason = reason
    audit('remote.desktop.ended', device, {
      session_id: session.id,
      reason,
      duration_secs: Math.round((Date.now() - started) / 1000),
      bytes: session.bytes_from_device + session.bytes_to_device,
      consent: session.detail?.consent ?? null,
      view_only: viewOnly,
      ctrl_alt_del: counts.cad,
      clipboard_to_device: counts.toDevice,
      clipboard_from_device: counts.fromDevice,
      dropped_inputs: counts.dropped,
    })
    persist()
    emitMockEvent('remote.session', { session_id: session.id, device_id: session.device_id, status: 'ended', kind: 'desktop' })
    window.setTimeout(() => client.close(1000, reason.slice(0, 120)), 30)
  }

  live.set(sessionId, (reason) => finish(reason))

  // ------------------------------------------------------------------ frames

  const currentQuality = () => (quality === 'auto' ? adaptation.quality : QUALITY_JPEG[quality])
  const currentFps = () => (quality === 'auto' ? adaptation.fps : 30)

  const sendCursor = (shapeToo: boolean) => {
    if (shapeToo) sendBinary(encodeMedia(cursorShapes()[cursorKind]))
    sendBinary(encodeMedia({ type: 'cursor_position', x: pointer.x, y: pointer.y, visible: pointer.visible }))
  }

  const sendReady = () => {
    const monitor = monitors.find((item) => item.id === active) ?? monitors[0]
    const { scene } = view(active)
    sendJson({ type: 'ready', width: monitor.width, height: monitor.height, monitors, monitor: active, view_only: viewOnly, desktop: scene.desktopName })
    sendCursor(true)
  }

  const pump = () => {
    if (!streaming || closed || encoding) return
    const now = performance.now()
    for (const [frame, sentAt] of inFlight) if (now - sentAt > FRAME_WRITE_OFF_MS) inFlight.delete(frame)
    const { scene, surface } = view(active)
    if (!scene.hasChanges()) return
    if (inFlight.size >= MAX_FRAMES_IN_FLIGHT) {
      blockedSince ??= now
      return
    }
    if (blockedSince !== null) {
      window2s.blockedMs += now - blockedSince
      blockedSince = null
    }
    if (now - lastFrameAt < 1000 / currentFps()) {
      schedulePump(Math.ceil(1000 / currentFps() - (now - lastFrameAt)))
      return
    }
    encoding = true
    lastFrameAt = now
    const frameGeneration = generation
    const frameSeq = seq
    seq = (seq + 1) >>> 0
    const { dirty, copies } = scene.take()
    if (copies.length) scene.applyCopies(surface.ctx, surface.canvas, copies)
    for (const rect of dirty) scene.paint(surface.ctx, rect)
    void encodeFrame(surface, scene.width, scene.height, frameSeq, dirty, copies, currentQuality())
      .then((frame) => {
        if (closed || frameGeneration !== generation) return
        for (const message of frame.messages) sendBinary(message)
        inFlight.set(frameSeq, performance.now())
        window2s.frames += 1
        window2s.encodeMs += frame.encodeMs
      })
      .catch(() => {
        // An encode failure skips the frame; the next change repaints.
      })
      .finally(() => {
        encoding = false
        if (frameGeneration === generation) schedulePump(0)
      })
  }

  const fullFrame = () => {
    view(active).scene.invalidateAll()
    pump()
  }

  const resizeMonitor = (id: number, width: number, height: number) => {
    const monitor = monitors.find((item) => item.id === id)
    const entry = scenes.get(id)
    if (!monitor || !entry) return
    monitor.width = width
    monitor.height = height
    entry.scene.resize(width, height)
    entry.surface = createSurface(width, height)
    if (id === active) {
      generation += 1
      inFlight.clear()
      encoding = false
      sendJson({ type: 'resize', width, height })
      pointer.x = Math.min(pointer.x, width - 1)
      pointer.y = Math.min(pointer.y, height - 1)
      sendCursor(false)
      fullFrame()
    }
  }

  const switchMonitor = (id: number) => {
    if (id === active || !monitors.some((monitor) => monitor.id === id)) return
    active = id
    // A new stream: frame numbers start again at 0 and in-flight frames are forgotten.
    generation += 1
    seq = 0
    inFlight.clear()
    encoding = false
    const monitor = monitors.find((item) => item.id === id)!
    pointer.x = Math.round(monitor.width / 2)
    pointer.y = Math.round(monitor.height / 2)
    sendReady()
    fullFrame()
  }

  const updateCursor = () => {
    const kind = view(active).scene.cursorAt(pointer.x, pointer.y)
    const changed = kind !== cursorKind
    cursorKind = kind
    sendCursor(changed)
  }

  // ------------------------------------------------------------------ input

  const handle = (message: DesktopBrowserMessage) => {
    const isInput = message.type === 'mouse' || message.type === 'key' || message.type === 'text' || message.type === 'cad' || message.type === 'clipboard'
    if (isInput && viewOnly) {
      // The server drops input while the session is view-only.
      counts.dropped += 1
      return
    }
    if (isInput) lastInput = Date.now()
    const { scene } = view(active)
    switch (message.type) {
      case 'ack': {
        const sentAt = inFlight.get(message.frame_seq)
        if (sentAt !== undefined) {
          window2s.rtt.push(performance.now() - sentAt)
          inFlight.delete(message.frame_seq)
        }
        pump()
        break
      }
      case 'mouse': {
        if (!streaming) return
        const monitor = monitors.find((item) => item.id === active)!
        pointer.x = Math.max(0, Math.min(monitor.width - 1, Math.round(message.x)))
        pointer.y = Math.max(0, Math.min(monitor.height - 1, Math.round(message.y)))
        pointer.visible = true
        scene.pointer(pointer.x, pointer.y, message.buttons)
        if (message.wheel_y) scene.wheel(pointer.x, pointer.y, message.wheel_y)
        updateCursor()
        pump()
        break
      }
      case 'key': {
        if (!streaming) return
        if (message.code === 'ControlLeft' || message.code === 'ControlRight') modifiers.ctrl = message.down
        if (message.down) {
          scene.key(message.code, message.key, modifiers.ctrl)
          if (pointer.visible && !modifiers.ctrl && message.key.length === 1) {
            // Windows hides the pointer while you type.
            pointer.visible = false
            sendCursor(false)
          }
        }
        pump()
        break
      }
      case 'text':
        if (!streaming) return
        scene.type(message.text)
        pump()
        break
      case 'cad':
        if (!streaming) return
        counts.cad += 1
        audit('remote.desktop.cad', device, { session_id: session.id })
        persist()
        if (scenario.theme !== 'windows') break
        if (scenario.cadRefused) {
          sendJson({ type: 'error', message: 'Ctrl+Alt+Del needs the SoftwareSASGeneration policy' })
          break
        }
        if (scene.secure !== 'signin' && scene.secure !== 'lock') scene.enterSecure('cad')
        else scene.invalidateAll()
        pump()
        break
      case 'monitor':
        if (streaming) switchMonitor(message.id)
        break
      case 'quality':
        quality = message.value
        if (streaming) fullFrame()
        break
      case 'refresh':
        if (streaming) fullFrame()
        break
      case 'clipboard':
        counts.toDevice += 1
        session.bytes_to_device += utf8Length(message.text)
        scene.setClipboard(message.text)
        // The device's clipboard listener fires for the new text too: echo it back.
        timers.push(window.setTimeout(() => sendClipboard(message.text), 180))
        break
      case 'view_only':
        if (!message.value && policy.viewOnly) return
        if (viewOnly === message.value) return
        viewOnly = message.value
        session.detail = { ...session.detail, view_only: viewOnly }
        audit('remote.desktop.view_only', device, { session_id: session.id, value: viewOnly })
        persist()
        break
    }
  }

  client.addEventListener('message', (event) => {
    if (closed || typeof event.data !== 'string') return
    session.bytes_to_device += event.data.length
    let parsed: unknown
    try {
      parsed = JSON.parse(event.data)
    } catch {
      return
    }
    const type = (parsed as { type?: unknown } | null)?.type
    // Agent-to-browser types sent by the browser are dropped, like the server does.
    if (typeof type !== 'string' || AGENT_ONLY.has(type)) return
    handle(parsed as DesktopBrowserMessage)
  })

  client.addEventListener('close', () => {
    if (!closed) finish('Closed by operator', { notify: false })
  })

  // ------------------------------------------------------------------ session start

  const startStreaming = () => {
    if (closed) return
    streaming = true
    session.connected_at = new Date().toISOString()
    session.live = true
    persist()
    emitMockEvent('remote.session', { session_id: session.id, device_id: session.device_id, status: 'active', kind: 'desktop' })
    const monitor = monitors[0]
    pointer.x = Math.round(monitor.width * 0.42)
    pointer.y = Math.round(monitor.height * 0.4)
    sendReady()
    fullFrame()
    // Clocks and animations, stats every 2 s, the idle timeout.
    timers.push(
      window.setInterval(() => {
        if (!streaming) return
        view(active).scene.tick(new Date())
        pump()
      }, 250),
    )
    timers.push(
      window.setInterval(() => {
        if (!streaming) return
        const now = performance.now()
        const seconds = Math.max(0.5, (now - window2s.startedAt) / 1000)
        const rtt = window2s.rtt.length ? window2s.rtt.reduce((sum, value) => sum + value, 0) / window2s.rtt.length : 0
        const blocked = (window2s.blockedMs + (blockedSince !== null ? now - blockedSince : 0)) / (seconds * 1000)
        if (quality === 'auto') adaptation.update(rtt, blocked)
        sendJson({
          type: 'stats',
          fps: Math.round((window2s.frames / seconds) * 10) / 10,
          kbps: Math.round((window2s.bytes * 8) / seconds / 1000),
          encode_ms: window2s.frames ? Math.round((window2s.encodeMs / window2s.frames) * 10) / 10 : 0,
          capture: scenario.theme === 'linux' ? 'x11' : 'dxgi',
        })
        Object.assign(window2s, { frames: 0, bytes: 0, encodeMs: 0, rtt: [], blockedMs: 0, startedAt: now })
      }, 2000),
    )
    timers.push(
      window.setInterval(() => {
        if (Date.now() - lastInput > IDLE_TIMEOUT_MS) finish('The session ended after 30 minutes without input')
      }, 30_000),
    )
  }

  const setConsent = (consent: 'not_required' | 'granted' | 'denied' | 'timeout') => {
    session.detail = { ...session.detail, consent }
    if (consent !== 'not_required') audit('remote.desktop.consent', device, { session_id: session.id, status: consent })
    persist()
  }

  timers.push(window.setTimeout(() => sendJson({ type: 'status', message: 'Waiting for the agent to open a tunnel…' }), 90))
  timers.push(
    window.setTimeout(() => {
      if (closed) return
      if (scenario.streamError) {
        sendJson({ type: 'error', message: scenario.streamError })
        finish(scenario.streamError, { exit: true })
        return
      }
      sendJson({ type: 'status', message: 'Starting the desktop helper…' })
      if (!consentRequired(policy, target)) {
        setConsent('not_required')
        timers.push(window.setTimeout(startStreaming, 450))
        return
      }
      sendJson({ type: 'consent', status: 'waiting' })
      const answer = scenario.consentAnswer
      const delay = answer === 'timeout' ? policy.timeoutSecs * 1000 : answer === 'denied' ? 3600 : 2800
      timers.push(
        window.setTimeout(() => {
          if (closed) return
          sendJson({ type: 'consent', status: answer })
          setConsent(answer)
          if (answer === 'granted') startStreaming()
          else finish(answer === 'denied' ? 'The user denied the session' : 'The user did not answer the consent prompt', { exit: true })
        }, delay),
      )
    }, 650),
  )
})
