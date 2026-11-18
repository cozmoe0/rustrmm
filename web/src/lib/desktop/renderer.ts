/*
 * The remote desktop renderer behind one interface, with two implementations:
 *
 * - `worker`: the visible canvas is transferred to a dedicated worker (OffscreenCanvas). The main
 *   thread only forwards socket buffers by transfer and receives "presented" notices.
 * - `inline`: the same render core on the main thread, for browsers without OffscreenCanvas
 *   workers (and for comparison: append `?desktop-renderer=inline` to the URL).
 */
import type { FrameInfo } from './pipeline'
import { RendererCore } from './renderer-core'
import type { WorkerInbound, WorkerOutbound } from './desktop.worker'

export type RendererKind = 'worker' | 'inline'

export interface RendererEvents {
  presented(info: FrameInfo): void
  invalid?(message: string): void
  /** The worker failed; the caller may fall back to the inline renderer. */
  failed?(message: string): void
}

export interface DesktopRenderer {
  readonly kind: RendererKind
  readonly canvas: HTMLCanvasElement
  /** Forwards a tile, copy rect or frame end. The buffer may be transferred (do not reuse it). */
  push(buffer: ArrayBuffer): void
  reset(width: number, height: number): void
  /** A PNG of the current picture (without the cursor). */
  snapshot(): Promise<Blob | null>
  dispose(): void
}

export function workerRendererSupported(): boolean {
  return (
    typeof Worker !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    'transferControlToOffscreen' in HTMLCanvasElement.prototype
  )
}

function preferredKind(): RendererKind {
  try {
    const forced = new URLSearchParams(window.location.search).get('desktop-renderer')
    if (forced === 'inline') return 'inline'
  } catch {
    // ignore
  }
  return workerRendererSupported() ? 'worker' : 'inline'
}

function createCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  canvas.setAttribute('aria-hidden', 'true')
  return canvas
}

class InlineRenderer implements DesktopRenderer {
  readonly kind = 'inline' as const
  readonly canvas = createCanvas()
  private core: RendererCore

  constructor(events: RendererEvents) {
    this.core = new RendererCore(this.canvas, {
      presented: (info) => events.presented(info),
      invalid: (message) => events.invalid?.(message),
    })
  }

  push(buffer: ArrayBuffer) {
    this.core.push(buffer)
  }

  reset(width: number, height: number) {
    this.core.reset(width, height)
  }

  snapshot() {
    return this.core.snapshot()
  }

  dispose() {
    this.core.dispose()
  }
}

class WorkerRenderer implements DesktopRenderer {
  readonly kind = 'worker' as const
  readonly canvas = createCanvas()
  private worker: Worker
  private snapshots = new Map<number, (blob: Blob | null) => void>()
  private nextSnapshot = 1
  private disposed = false

  constructor(events: RendererEvents) {
    this.worker = new Worker(new URL('./desktop.worker.ts', import.meta.url), { type: 'module', name: 'rustrmm-desktop-renderer' })
    this.worker.onmessage = (event: MessageEvent<WorkerOutbound>) => {
      const message = event.data
      switch (message.type) {
        case 'presented':
          if (!this.disposed) events.presented(message.info)
          break
        case 'invalid':
          events.invalid?.(message.message)
          break
        case 'snapshot':
          this.snapshots.get(message.id)?.(message.blob)
          this.snapshots.delete(message.id)
          break
        case 'error':
          events.failed?.(message.message)
          break
      }
    }
    this.worker.onerror = (event) => {
      event.preventDefault()
      events.failed?.(event.message || 'The render worker stopped.')
    }
    const offscreen = this.canvas.transferControlToOffscreen()
    this.post({ type: 'init', canvas: offscreen }, [offscreen])
  }

  private post(message: WorkerInbound, transfer: Transferable[] = []) {
    if (!this.disposed) this.worker.postMessage(message, transfer)
  }

  push(buffer: ArrayBuffer) {
    this.post({ type: 'media', buffer }, [buffer])
  }

  reset(width: number, height: number) {
    this.post({ type: 'reset', width, height })
  }

  snapshot(): Promise<Blob | null> {
    if (this.disposed) return Promise.resolve(null)
    const id = this.nextSnapshot++
    return new Promise((resolve) => {
      this.snapshots.set(id, resolve)
      this.post({ type: 'snapshot', id })
    })
  }

  dispose() {
    if (this.disposed) return
    this.post({ type: 'dispose' })
    this.disposed = true
    // Give the worker a moment to release its bitmaps, then make sure it is gone.
    window.setTimeout(() => this.worker.terminate(), 250)
    for (const resolve of this.snapshots.values()) resolve(null)
    this.snapshots.clear()
  }
}

export function createRenderer(events: RendererEvents, kind: RendererKind = preferredKind()): DesktopRenderer {
  if (kind === 'worker') {
    try {
      return new WorkerRenderer(events)
    } catch {
      // Fall through to the main-thread renderer.
    }
  }
  return new InlineRenderer(events)
}
