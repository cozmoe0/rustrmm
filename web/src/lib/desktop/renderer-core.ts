/* The render loop shared by the worker and the main-thread fallback: decode, assemble, draw. */
import { FramePipeline, type FrameInfo } from './pipeline'
import { MediaError, decodeMedia } from './protocol'
import { DesktopSurface, decodeJpeg } from './surface'

export interface RendererCoreEvents {
  presented(info: FrameInfo): void
  /** A message could not be decoded (it is skipped). */
  invalid(message: string): void
}

export class RendererCore {
  private surface: DesktopSurface
  private pipeline: FramePipeline<ImageBitmap>
  private events: RendererCoreEvents

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, events: RendererCoreEvents) {
    this.surface = new DesktopSurface(canvas)
    this.pipeline = new FramePipeline<ImageBitmap>({
      decodeJpeg: (payload) => decodeJpeg(payload),
      apply: (ops) => this.surface.apply(ops),
      reset: (width, height) => this.surface.reset(width, height),
      presented: (info) => events.presented(info),
    })
    this.events = events
  }

  /** A tile, copy rect or frame end, as received from the socket. */
  push(buffer: ArrayBuffer) {
    try {
      this.pipeline.push(decodeMedia(buffer), buffer.byteLength)
    } catch (error) {
      this.events.invalid(error instanceof MediaError ? error.message : 'invalid media message')
    }
  }

  reset(width: number, height: number) {
    this.pipeline.reset(width, height)
  }

  async snapshot(): Promise<Blob | null> {
    await this.pipeline.idle()
    return this.surface.snapshot()
  }

  get inFlight() {
    return this.pipeline.inFlight
  }

  dispose() {
    this.pipeline.dispose()
  }
}
