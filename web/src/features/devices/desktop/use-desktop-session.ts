/*
 * One remote desktop session: `POST /devices/:id/desktop` (step-up handled by the API client), then
 * `/api/v1/remote-sessions/:session/ws?ticket=…` carrying binary media frames (rendered by the
 * worker renderer) and JSON control frames in both directions.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { desktopApi } from '@/lib/api/endpoints'
import { errorMessage, isApiError } from '@/lib/api/errors'
import type { DesktopCreateRequest } from '@/lib/api/types'
import {
  chunkText,
  checkClipboard,
  encodeControl,
  isInputMessage,
  parseAgentMessage,
  type AgentStats,
  type ConsentStatus,
  type DesktopAgentMessage,
  type DesktopBrowserMessage,
  type DesktopQuality,
  type InputDesktop,
  type KeyMessage,
  type MonitorInfo,
} from '@/lib/desktop/control'
import { comboMessages, type KeyInput } from '@/lib/desktop/input'
import { FrameMeter, type FrameInfo } from '@/lib/desktop/pipeline'
import { MEDIA_KIND, decodeMedia, peekKind, type CursorPositionMessage, type CursorShapeMessage } from '@/lib/desktop/protocol'
import { createRenderer, type DesktopRenderer, type RendererKind } from '@/lib/desktop/renderer'
import type { Size } from '@/lib/desktop/viewport'

export type DesktopPhase = 'idle' | 'starting' | 'connecting' | 'ready' | 'ended'

/** Why a session ended. `dropped` is a lost connection after streaming started (reconnectable). */
export type DesktopEnd = 'user' | 'closed' | 'exited' | 'error' | 'denied' | 'timeout' | 'dropped' | 'failed'

export interface DesktopSnapshot {
  phase: DesktopPhase
  /** Server progress text while connecting. */
  status: string | null
  consent: ConsentStatus | null
  consentAt: number | null
  end: DesktopEnd | null
  reason: string | null
  error: string | null
  errorCode: string | null
  errorDetails: unknown
  wasReady: boolean
  sessionId: string | null
  request: DesktopCreateRequest
  screen: Size | null
  monitors: MonitorInfo[]
  monitor: number | null
  /** Monitor requested but not yet confirmed by `ready`. */
  switching: number | null
  viewOnly: boolean
  quality: DesktopQuality
  desktop: InputDesktop
  agentStats: AgentStats | null
  clipboard: { text: string; at: number } | null
  renderer: RendererKind | null
  /** Bumped whenever a new renderer (canvas) replaces the previous one. */
  rendererVersion: number
  /** Automatic reconnect attempts since streaming last started. */
  reconnectAttempt: number
  startedAt: number | null
  readyAt: number | null
  endedAt: number | null
}

const INITIAL: DesktopSnapshot = {
  phase: 'idle',
  status: null,
  consent: null,
  consentAt: null,
  end: null,
  reason: null,
  error: null,
  errorCode: null,
  errorDetails: null,
  wasReady: false,
  sessionId: null,
  request: {},
  screen: null,
  monitors: [],
  monitor: null,
  switching: null,
  viewOnly: false,
  quality: 'auto',
  desktop: 'default',
  agentStats: null,
  clipboard: null,
  renderer: null,
  rendererVersion: 0,
  reconnectAttempt: 0,
  startedAt: null,
  readyAt: null,
  endedAt: null,
}

export function isDesktopBusy(phase: DesktopPhase) {
  return phase === 'starting' || phase === 'connecting' || phase === 'ready'
}

export interface DesktopSessionEvents {
  cursorShape?: (message: CursorShapeMessage) => void
  cursorPosition?: (message: CursorPositionMessage) => void
  /** The device clipboard changed (only sent while the session is not view-only). */
  clipboard?: (text: string) => void
  /** An agent error while streaming (for example a refused Ctrl+Alt+Del), shown verbatim. */
  agentError?: (message: string) => void
}

export interface StartOptions {
  sessionId?: number | null
  viewOnly: boolean
  quality: DesktopQuality
  /** An automatic reconnect (counts against the retry budget). */
  reconnect?: boolean
}

/** A damaged frame (failed decode, wrong tile count) asks for a full frame at most this often. */
const REFRESH_THROTTLE_MS = 3000

export function useDesktopSession(deviceId: string, events: DesktopSessionEvents = {}) {
  const [state, setState] = useState<DesktopSnapshot>(INITIAL)
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  })
  const socketRef = useRef<WebSocket | null>(null)
  const rendererRef = useRef<DesktopRenderer | null>(null)
  const generation = useRef(0)
  const meter = useRef(new FrameMeter())
  const traffic = useRef({ bytesIn: 0, bytesOut: 0, frames: 0 })
  const lastInputAt = useRef(0)
  const lastRefresh = useRef(0)
  const lastError = useRef<string | null>(null)
  const eventsRef = useRef(events)
  useEffect(() => {
    eventsRef.current = events
  })

  const rawSend = useCallback((message: DesktopBrowserMessage): boolean => {
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    const text = encodeControl(message)
    traffic.current.bytesOut += text.length
    socket.send(text)
    return true
  }, [])

  const end = useCallback((patch: Partial<DesktopSnapshot>) => {
    setState((prev) => (prev.phase === 'ended' || prev.phase === 'idle' ? { ...prev, reason: prev.reason ?? patch.reason ?? null } : { ...prev, phase: 'ended', status: null, switching: null, endedAt: Date.now(), ...patch }))
  }, [])

  const makeRenderer = useCallback(
    (current: number, kind?: RendererKind): DesktopRenderer => {
      rendererRef.current?.dispose()
      const renderer = createRenderer(
        {
          presented: (info: FrameInfo) => {
            if (current !== generation.current) return
            meter.current.record(info)
            traffic.current.frames += 1
            rawSend({ type: 'ack', frame_seq: info.frameSeq })
            if (info.damaged && performance.now() - lastRefresh.current > REFRESH_THROTTLE_MS) {
              lastRefresh.current = performance.now()
              rawSend({ type: 'refresh' })
            }
          },
          failed: () => {
            // The worker died: carry on with the main-thread renderer and ask for a full frame.
            if (current !== generation.current || rendererRef.current?.kind !== 'worker') return
            const replacement = makeRenderer(current, 'inline')
            const screen = stateRef.current.screen
            if (screen) replacement.reset(screen.width, screen.height)
            rawSend({ type: 'refresh' })
          },
        },
        kind,
      )
      rendererRef.current = renderer
      setState((prev) => ({ ...prev, renderer: renderer.kind, rendererVersion: prev.rendererVersion + 1 }))
      return renderer
    },
    [rawSend],
  )

  const handleControl = useCallback(
    (message: DesktopAgentMessage) => {
      switch (message.type) {
        case 'status':
          setState((prev) => (prev.phase === 'connecting' ? { ...prev, status: message.message } : prev))
          break
        case 'ready': {
          rendererRef.current?.reset(message.width, message.height)
          lastError.current = null
          setState((prev) => ({
            ...prev,
            phase: prev.phase === 'ended' ? prev.phase : 'ready',
            status: null,
            wasReady: true,
            readyAt: prev.readyAt ?? Date.now(),
            screen: { width: message.width, height: message.height },
            monitors: message.monitors,
            monitor: message.monitor,
            switching: null,
            reconnectAttempt: 0,
            viewOnly: message.view_only,
            desktop: message.desktop,
            consent: prev.consent === 'waiting' ? 'granted' : prev.consent,
          }))
          break
        }
        case 'resize':
          rendererRef.current?.reset(message.width, message.height)
          setState((prev) => ({
            ...prev,
            screen: { width: message.width, height: message.height },
            monitors: prev.monitors.map((monitor) => (monitor.id === prev.monitor ? { ...monitor, width: message.width, height: message.height } : monitor)),
          }))
          break
        case 'desktop':
          setState((prev) => ({ ...prev, desktop: message.name }))
          break
        case 'clipboard':
          setState((prev) => ({ ...prev, clipboard: { text: message.text, at: Date.now() } }))
          eventsRef.current.clipboard?.(message.text)
          break
        case 'consent':
          setState((prev) => ({ ...prev, consent: message.status, consentAt: Date.now() }))
          break
        case 'stats':
          setState((prev) => ({ ...prev, agentStats: { fps: message.fps, kbps: message.kbps, encode_ms: message.encode_ms, capture: message.capture } }))
          break
        case 'error':
          if (stateRef.current.phase === 'ready') eventsRef.current.agentError?.(message.message)
          else lastError.current = message.message
          break
        case 'exit':
          // `closed` follows with the server's reason.
          break
        case 'closed': {
          const reason = message.reason || 'The session ended.'
          setState((prev) => {
            if (prev.phase === 'ended' || prev.phase === 'idle') return { ...prev, reason: message.reason || prev.reason }
            const consentEnd = prev.consent === 'denied' || prev.consent === 'timeout' ? prev.consent : null
            const agentError = lastError.current
            return {
              ...prev,
              phase: 'ended',
              status: null,
              switching: null,
              endedAt: Date.now(),
              reason,
              end: consentEnd ?? (agentError && !prev.wasReady ? 'error' : 'closed'),
              error: agentError && !prev.wasReady ? agentError : prev.error,
              errorCode: agentError && !prev.wasReady ? 'device_error' : prev.errorCode,
            }
          })
          break
        }
      }
    },
    [],
  )

  const handleBinary = useCallback(
    (buffer: ArrayBuffer) => {
      traffic.current.bytesIn += buffer.byteLength
      meter.current.addBytes(buffer.byteLength, performance.now())
      const kind = peekKind(buffer)
      if (kind === MEDIA_KIND.cursorPosition || kind === MEDIA_KIND.cursorShape) {
        try {
          const message = decodeMedia(buffer)
          if (message.type === 'cursor_position') eventsRef.current.cursorPosition?.(message)
          else if (message.type === 'cursor_shape') eventsRef.current.cursorShape?.(message)
        } catch {
          // Skip malformed cursor messages.
        }
        return
      }
      rendererRef.current?.push(buffer)
    },
    [],
  )

  const start = useCallback(
    async (options: StartOptions) => {
      generation.current += 1
      const current = generation.current
      socketRef.current?.close(1000, 'Reconnecting')
      socketRef.current = null
      meter.current = new FrameMeter()
      traffic.current = { bytesIn: 0, bytesOut: 0, frames: 0 }
      lastInputAt.current = Date.now()
      lastError.current = null
      const request: DesktopCreateRequest = { view_only: options.viewOnly, quality: options.quality }
      if (options.sessionId !== undefined && options.sessionId !== null) request.session_id = options.sessionId
      setState((prev) => ({
        ...INITIAL,
        phase: 'starting',
        status: 'Requesting a session…',
        request,
        viewOnly: options.viewOnly,
        quality: options.quality,
        startedAt: Date.now(),
        renderer: prev.renderer,
        rendererVersion: prev.rendererVersion,
        reconnectAttempt: options.reconnect ? prev.reconnectAttempt + 1 : 0,
      }))

      let ticket
      try {
        ticket = await desktopApi.create(deviceId, request)
      } catch (error) {
        if (current !== generation.current) return
        setState((prev) => ({
          ...prev,
          phase: 'ended',
          end: 'failed',
          status: null,
          error: errorMessage(error, 'The remote desktop could not be started.'),
          errorCode: isApiError(error) ? error.code : null,
          errorDetails: isApiError(error) ? error.details : null,
          endedAt: Date.now(),
        }))
        return
      }
      if (current !== generation.current) return
      setState((prev) => ({ ...prev, phase: 'connecting', sessionId: ticket.session_id, status: 'Opening a secure tunnel to the agent…' }))
      const renderer = makeRenderer(current)
      void renderer

      let socket: WebSocket
      try {
        socket = new WebSocket(desktopApi.socketUrl(ticket.session_id, ticket.ticket))
      } catch {
        end({ end: 'failed', error: 'The browser could not open the remote desktop connection.', errorCode: 'socket_error' })
        return
      }
      socket.binaryType = 'arraybuffer'
      socketRef.current = socket

      socket.onmessage = (event: MessageEvent<string | ArrayBuffer | Blob>) => {
        if (current !== generation.current) return
        const { data } = event
        if (typeof data === 'string') {
          const message = parseAgentMessage(data)
          if (message) handleControl(message)
          return
        }
        if (data instanceof ArrayBuffer) handleBinary(data)
        else if (ArrayBuffer.isView(data)) {
          const view = data as ArrayBufferView
          handleBinary(new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice().buffer)
        } else if (data instanceof Blob) void data.arrayBuffer().then((buffer) => current === generation.current && handleBinary(buffer))
      }
      socket.onerror = () => {
        // `onclose` follows and decides how the session ended.
      }
      socket.onclose = (event) => {
        if (current !== generation.current) return
        socketRef.current = null
        setState((prev) => {
          if (prev.phase === 'ended' || prev.phase === 'idle') return prev
          const agentError = lastError.current
          return {
            ...prev,
            phase: 'ended',
            status: null,
            switching: null,
            endedAt: Date.now(),
            end: prev.wasReady ? 'dropped' : agentError ? 'error' : 'failed',
            error: agentError ?? prev.error,
            errorCode: agentError ? 'device_error' : prev.errorCode,
            reason: event.reason || (prev.wasReady ? 'The connection to the device was lost.' : 'The remote desktop could not be reached.'),
          }
        })
      }
    },
    [deviceId, end, handleBinary, handleControl, makeRenderer],
  )

  /** Sends an input message; refused (false) while not streaming or view-only. */
  const sendInput = useCallback(
    (message: DesktopBrowserMessage): boolean => {
      const current = stateRef.current
      if (current.phase !== 'ready') return false
      if (isInputMessage(message) && current.viewOnly) return false
      if (!rawSend(message)) return false
      if (isInputMessage(message)) lastInputAt.current = Date.now()
      return true
    },
    [rawSend],
  )

  const sendKeys = useCallback((messages: KeyMessage[]) => messages.forEach((message) => sendInput(message)), [sendInput])
  const sendCombo = useCallback((combo: readonly KeyInput[]) => sendKeys(comboMessages(combo)), [sendKeys])

  /** Types text as Unicode keystrokes, split into messages of at most 4096 characters. */
  const sendText = useCallback(
    (text: string): boolean => {
      const chunks = chunkText(text)
      if (chunks.length === 0) return false
      return chunks.every((chunk) => sendInput({ type: 'text', text: chunk }))
    },
    [sendInput],
  )

  const sendClipboard = useCallback(
    (text: string) => {
      const check = checkClipboard(text)
      if (!check.ok) return check
      return sendInput({ type: 'clipboard', text }) ? check : ({ ok: false, bytes: check.bytes, reason: 'empty' } as const)
    },
    [sendInput],
  )

  const setQuality = useCallback(
    (value: DesktopQuality) => {
      setState((prev) => ({ ...prev, quality: value }))
      rawSend({ type: 'quality', value })
    },
    [rawSend],
  )

  const setMonitor = useCallback(
    (id: number) => {
      if (stateRef.current.monitor === id) return
      if (rawSend({ type: 'monitor', id })) setState((prev) => ({ ...prev, switching: id }))
    },
    [rawSend],
  )

  const setViewOnly = useCallback(
    (value: boolean) => {
      if (rawSend({ type: 'view_only', value })) setState((prev) => ({ ...prev, viewOnly: value }))
    },
    [rawSend],
  )

  const refresh = useCallback(() => {
    lastRefresh.current = performance.now()
    rawSend({ type: 'refresh' })
  }, [rawSend])

  const disconnect = useCallback(() => {
    const socket = socketRef.current
    generation.current += 1
    socketRef.current = null
    socket?.close(1000, 'Closed by operator')
    setState((prev) => (prev.phase === 'ended' || prev.phase === 'idle' ? prev : { ...prev, phase: 'ended', end: 'user', status: null, switching: null, reason: 'You ended the session.', endedAt: Date.now() }))
  }, [])

  /** Forgets an ended session (back to the connect panel). */
  const reset = useCallback(() => {
    generation.current += 1
    socketRef.current?.close(1000, 'Closed by operator')
    socketRef.current = null
    rendererRef.current?.dispose()
    rendererRef.current = null
    setState((prev) => ({ ...INITIAL, rendererVersion: prev.rendererVersion + 1 }))
  }, [])

  // Leaving the page or the device closes the socket, which ends the session server-side.
  useEffect(
    () => () => {
      generation.current += 1
      socketRef.current?.close(1000, 'Closed by operator')
      socketRef.current = null
      rendererRef.current?.dispose()
      rendererRef.current = null
    },
    [],
  )

  const getRenderer = useCallback(() => rendererRef.current, [])
  const getMeter = useCallback(() => meter.current.snapshot(performance.now()), [])
  const getTraffic = useCallback(() => ({ ...traffic.current }), [])
  const getLastInputAt = useCallback(() => lastInputAt.current, [])
  const snapshot = useCallback(() => rendererRef.current?.snapshot() ?? Promise.resolve(null), [])

  return {
    state,
    start,
    disconnect,
    reset,
    sendInput,
    sendKeys,
    sendCombo,
    sendText,
    sendClipboard,
    setQuality,
    setMonitor,
    setViewOnly,
    refresh,
    snapshot,
    getRenderer,
    getMeter,
    getTraffic,
    getLastInputAt,
  }
}

export type DesktopSessionApi = ReturnType<typeof useDesktopSession>
