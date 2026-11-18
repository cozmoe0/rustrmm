/*
 * Remote desktop render worker: owns the transferred OffscreenCanvas, decodes JPEG tiles with
 * createImageBitmap, assembles frames and draws them, so the main thread only relays socket
 * buffers (transferred, not copied) and sends acks.
 */
import type { FrameInfo } from './pipeline'
import { RendererCore } from './renderer-core'

export type WorkerInbound =
  | { type: 'init'; canvas: OffscreenCanvas }
  | { type: 'media'; buffer: ArrayBuffer }
  | { type: 'reset'; width: number; height: number }
  | { type: 'snapshot'; id: number }
  | { type: 'dispose' }

export type WorkerOutbound =
  | { type: 'presented'; info: FrameInfo }
  | { type: 'invalid'; message: string }
  | { type: 'snapshot'; id: number; blob: Blob | null }
  | { type: 'error'; message: string }

// The app is compiled against the DOM library, so describe the worker scope minimally.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerInbound>) => void) | null
  postMessage(message: WorkerOutbound): void
  close(): void
}

let core: RendererCore | null = null

scope.onmessage = (event) => {
  const message = event.data
  switch (message.type) {
    case 'init':
      try {
        core = new RendererCore(message.canvas, {
          presented: (info) => scope.postMessage({ type: 'presented', info }),
          invalid: (text) => scope.postMessage({ type: 'invalid', message: text }),
        })
      } catch (error) {
        scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'The renderer could not start.' })
      }
      break
    case 'media':
      core?.push(message.buffer)
      break
    case 'reset':
      core?.reset(message.width, message.height)
      break
    case 'snapshot':
      void (core?.snapshot() ?? Promise.resolve(null)).then(
        (blob) => scope.postMessage({ type: 'snapshot', id: message.id, blob }),
        () => scope.postMessage({ type: 'snapshot', id: message.id, blob: null }),
      )
      break
    case 'dispose':
      core?.dispose()
      core = null
      scope.close()
      break
  }
}
