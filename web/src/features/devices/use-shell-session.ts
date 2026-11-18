import { useCallback, useEffect, useRef, useState } from 'react'
import { remoteApi } from '@/lib/api/endpoints'
import { errorMessage, isApiError } from '@/lib/api/errors'
import type { ShellServerMessage } from '@/lib/api/types'

export type ShellPhase = 'idle' | 'starting' | 'connecting' | 'ready' | 'exited' | 'closed' | 'error'

export interface ShellSnapshot {
  phase: ShellPhase
  /** The server's progress text while the agent opens the shell. */
  status: string | null
  exitCode: number | null
  reason: string | null
  error: string | null
  errorCode: string | null
  /** Whether the session ever reached `ready` (so an error is a drop, not a failed start). */
  wasReady: boolean
  sessionId: string | null
  shell: string
  startedAt: number | null
  readyAt: number | null
  endedAt: number | null
}

const INITIAL: ShellSnapshot = {
  phase: 'idle',
  status: null,
  exitCode: null,
  reason: null,
  error: null,
  errorCode: null,
  wasReady: false,
  sessionId: null,
  shell: '',
  startedAt: null,
  readyAt: null,
  endedAt: null,
}

export function isShellEnded(phase: ShellPhase) {
  return phase === 'exited' || phase === 'closed' || phase === 'error'
}

export function isShellBusy(phase: ShellPhase) {
  return phase === 'starting' || phase === 'connecting' || phase === 'ready'
}

const encoder = new TextEncoder()

interface ShellSessionOptions {
  deviceId: string
  /** Terminal output (raw VT bytes) to write to xterm as-is. */
  onOutput: (data: Uint8Array) => void
  /** Current terminal size, sent as a resize as soon as the socket opens. */
  getSize: () => { cols: number; rows: number }
}

/**
 * One interactive shell over the remote-session WebSocket:
 * `POST /devices/:id/shell` (step-up handled by the API client), then
 * `/api/v1/remote-sessions/:session/ws?ticket=…` with binary VT frames and JSON control frames.
 */
export function useShellSession({ deviceId, onOutput, getSize }: ShellSessionOptions) {
  const [state, setState] = useState<ShellSnapshot>(INITIAL)
  const socketRef = useRef<WebSocket | null>(null)
  const generation = useRef(0)
  const stats = useRef({ bytesIn: 0, bytesOut: 0 })
  const callbacks = useRef({ onOutput, getSize })
  useEffect(() => {
    callbacks.current = { onOutput, getSize }
  })

  const end = useCallback((patch: Partial<ShellSnapshot>) => {
    setState((prev) => (isShellEnded(prev.phase) ? { ...prev, reason: prev.reason ?? patch.reason ?? null } : { ...prev, endedAt: Date.now(), ...patch }))
  }, [])

  const handleControl = useCallback(
    (message: ShellServerMessage) => {
      switch (message.type) {
        case 'status':
          setState((prev) => (prev.phase === 'connecting' ? { ...prev, status: message.message } : prev))
          break
        case 'ready':
          setState((prev) => ({ ...prev, phase: 'ready', status: null, wasReady: true, readyAt: Date.now() }))
          break
        case 'exit':
          end({ phase: 'exited', exitCode: message.code })
          break
        case 'error':
          end({ phase: 'error', error: message.message, errorCode: 'shell_error' })
          break
        case 'closed':
          setState((prev) =>
            isShellEnded(prev.phase)
              ? { ...prev, reason: message.reason || prev.reason }
              : { ...prev, phase: 'closed', reason: message.reason || 'The session ended.', endedAt: Date.now() },
          )
          break
      }
    },
    [end],
  )

  const start = useCallback(
    async (shell: string) => {
      generation.current += 1
      const current = generation.current
      socketRef.current?.close(1000)
      socketRef.current = null
      stats.current = { bytesIn: 0, bytesOut: 0 }
      setState({ ...INITIAL, phase: 'starting', shell, status: 'Requesting a session…', startedAt: Date.now() })

      const { cols, rows } = callbacks.current.getSize()
      let ticket
      try {
        ticket = await remoteApi.createShell(deviceId, { shell, cols, rows })
      } catch (error) {
        if (current !== generation.current) return
        setState((prev) => ({
          ...prev,
          phase: 'error',
          status: null,
          error: errorMessage(error, 'The shell could not be started.'),
          errorCode: isApiError(error) ? error.code : null,
          endedAt: Date.now(),
        }))
        return
      }
      if (current !== generation.current) return
      setState((prev) => ({ ...prev, phase: 'connecting', sessionId: ticket.session_id, status: 'Opening a secure tunnel to the agent…' }))

      let socket: WebSocket
      try {
        socket = new WebSocket(remoteApi.shellSocketUrl(ticket.session_id, ticket.ticket))
      } catch {
        end({ phase: 'error', error: 'The browser could not open the shell connection.', errorCode: 'socket_error' })
        return
      }
      socket.binaryType = 'arraybuffer'
      socketRef.current = socket

      socket.onopen = () => {
        if (current !== generation.current) return
        const size = callbacks.current.getSize()
        socket.send(JSON.stringify({ type: 'resize', cols: size.cols, rows: size.rows }))
      }
      socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
        if (current !== generation.current) return
        if (typeof event.data === 'string') {
          try {
            handleControl(JSON.parse(event.data) as ShellServerMessage)
          } catch {
            // Ignore malformed control frames.
          }
          return
        }
        const bytes = new Uint8Array(event.data)
        stats.current.bytesIn += bytes.byteLength
        callbacks.current.onOutput(bytes)
      }
      socket.onerror = () => {
        if (current !== generation.current) return
        end({ phase: 'error', error: 'The connection to the shell failed.', errorCode: 'socket_error' })
      }
      socket.onclose = (event) => {
        if (current !== generation.current) return
        socketRef.current = null
        setState((prev) =>
          isShellEnded(prev.phase)
            ? prev
            : {
                ...prev,
                phase: 'closed',
                status: null,
                reason: event.reason || (prev.phase === 'ready' ? 'The connection was lost.' : 'The shell could not be reached.'),
                endedAt: Date.now(),
              },
        )
      }
    },
    [deviceId, end, handleControl],
  )

  const send = useCallback((data: string) => {
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    const bytes = encoder.encode(data)
    stats.current.bytesOut += bytes.byteLength
    socket.send(bytes)
  }, [])

  const resize = useCallback((cols: number, rows: number) => {
    const socket = socketRef.current
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols, rows }))
  }, [])

  const disconnect = useCallback(() => {
    const socket = socketRef.current
    generation.current += 1
    socketRef.current = null
    socket?.close(1000, 'Closed by operator')
    setState((prev) => (isShellEnded(prev.phase) || prev.phase === 'idle' ? prev : { ...prev, phase: 'closed', status: null, reason: 'You ended the session.', endedAt: Date.now() }))
  }, [])

  // Closing the page or leaving the cockpit closes the socket, which ends the session server-side.
  useEffect(
    () => () => {
      generation.current += 1
      socketRef.current?.close(1000, 'Closed by operator')
      socketRef.current = null
    },
    [],
  )

  const getStats = useCallback(() => ({ ...stats.current }), [])

  return { state, start, send, resize, disconnect, getStats }
}
