import { useEffect, useRef, useSyncExternalStore } from 'react'
import { systemApi } from './endpoints'
import type { StreamEvent } from './types'

export type StreamStatus = 'idle' | 'connecting' | 'open' | 'reconnecting'

/** The minimal socket surface the client needs; the mock layer provides a fake in dev. */
export interface StreamSocket {
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((event: { data: string }) => void) | null
  onclose: (() => void) | null
  readonly readyState: number
}

type Listener = (event: StreamEvent) => void

const OPEN = 1

/**
 * One multiplexed WebSocket for live UI events (`/api/v1/stream`).
 * Authenticates with a short-lived ticket, re-subscribes after reconnects and backs off exponentially.
 */
class StreamClient {
  private socket: StreamSocket | null = null
  private listeners = new Map<string, Set<Listener>>()
  private statusListeners = new Set<() => void>()
  private attempt = 0
  private timer: number | null = null
  private running = false
  /** Incremented on every start/stop so stale in-flight connects can tell they were superseded. */
  private generation = 0
  status: StreamStatus = 'idle'

  start() {
    if (this.running) return
    this.running = true
    this.generation += 1
    void this.connect(this.generation)
  }

  stop() {
    this.running = false
    this.generation += 1
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = null
    this.socket?.close()
    this.socket = null
    this.setStatus('idle')
  }

  subscribe(topic: string, listener: Listener): () => void {
    let set = this.listeners.get(topic)
    if (!set) {
      set = new Set()
      this.listeners.set(topic, set)
      this.sendSubscribe([topic])
    }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(topic)
    }
  }

  onStatus(listener: () => void) {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  private setStatus(status: StreamStatus) {
    if (this.status === status) return
    this.status = status
    this.statusListeners.forEach((listener) => listener())
  }

  private sendSubscribe(topics: string[]) {
    if (this.socket?.readyState === OPEN && topics.length > 0) {
      this.socket.send(JSON.stringify({ type: 'subscribe', topics }))
    }
  }

  private async openSocket(): Promise<StreamSocket> {
    if (import.meta.env.VITE_MOCK === '1') {
      const { createMockStreamSocket } = await import('@/mocks/stream')
      return createMockStreamSocket()
    }
    const { ticket } = await systemApi.streamTicket()
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${protocol}//${window.location.host}/api/v1/stream?ticket=${encodeURIComponent(ticket)}`
    return new WebSocket(url) as unknown as StreamSocket
  }

  private async connect(generation: number) {
    if (!this.running || generation !== this.generation) return
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting')
    try {
      const socket = await this.openSocket()
      if (!this.running || generation !== this.generation) {
        socket.close()
        return
      }
      this.socket = socket
      socket.onopen = () => {
        this.attempt = 0
        this.setStatus('open')
        this.sendSubscribe([...this.listeners.keys()])
      }
      socket.onmessage = (message) => {
        try {
          const event = JSON.parse(message.data) as StreamEvent
          if (event.type !== 'event') return
          this.listeners.get(event.topic)?.forEach((listener) => listener(event))
        } catch {
          // Ignore malformed frames.
        }
      }
      socket.onclose = () => {
        if (generation !== this.generation) return
        this.socket = null
        this.scheduleReconnect(generation)
      }
    } catch {
      this.scheduleReconnect(generation)
    }
  }

  private scheduleReconnect(generation: number) {
    if (!this.running || generation !== this.generation) return
    this.setStatus('reconnecting')
    const base = Math.min(30_000, 1_000 * 2 ** this.attempt)
    const delay = base / 2 + Math.random() * (base / 2)
    this.attempt += 1
    this.timer = window.setTimeout(() => void this.connect(generation), delay)
  }
}

export const stream = new StreamClient()

export function useStreamStatus(): StreamStatus {
  return useSyncExternalStore(
    (listener) => stream.onStatus(listener),
    () => stream.status,
    () => 'idle' as StreamStatus,
  )
}

/** Calls `handler` for every event on `topic` while the component is mounted. */
export function useStreamEvent<T>(topic: string, handler: (data: T) => void) {
  const ref = useRef(handler)
  useEffect(() => {
    ref.current = handler
  })
  useEffect(() => stream.subscribe(topic, (event) => ref.current(event.data as T)), [topic])
}
