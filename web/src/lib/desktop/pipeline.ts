/*
 * Frame assembly and flow control for the remote desktop.
 *
 * The agent sends, per frame: copy rects, then tiles, then a frame end, all with the same
 * `frame_seq`, and keeps at most two frames in flight until they are acknowledged. The pipeline
 * collects each frame, decodes its JPEG tiles in parallel (frames may overlap), then applies frames
 * strictly in arrival order: copy rects first, then tiles, then presents and reports the frame so
 * the caller can send `ack`. Decoding and drawing are injected so the logic runs anywhere (worker,
 * main thread, tests).
 */
import { TILE_ENCODING, bgraToRgba, solidRgb, type MediaMessage, type TileMessage } from './protocol'

export interface DecodedImage {
  readonly width: number
  readonly height: number
  close?: () => void
}

export type SurfaceOp<I extends DecodedImage = DecodedImage> =
  | { op: 'copy'; srcX: number; srcY: number; w: number; h: number; dstX: number; dstY: number }
  | { op: 'image'; x: number; y: number; w: number; h: number; image: I }
  | { op: 'pixels'; x: number; y: number; w: number; h: number; rgba: Uint8ClampedArray<ArrayBuffer> }
  | { op: 'solid'; x: number; y: number; w: number; h: number; rgb: [number, number, number] }

export interface FrameInfo {
  frameSeq: number
  /** Tile messages received for the frame. */
  tiles: number
  /** Tile count announced by the frame end. */
  expected: number
  copies: number
  bytes: number
  /** Frame end → all tiles decoded. */
  decodeMs: number
  /** First message of the frame → presented. */
  latencyMs: number
  /** A tile failed to decode, had an unknown encoding, or the tile count did not match. */
  damaged: boolean
  presentedAt: number
}

export interface PipelineHooks<I extends DecodedImage> {
  decodeJpeg(payload: Uint8Array, width: number, height: number): Promise<I>
  apply(ops: SurfaceOp<I>[]): void
  reset(width: number, height: number): void
  presented(info: FrameInfo): void
  now?: () => number
}

type PendingOp<I extends DecodedImage> = SurfaceOp<I> | null | Promise<SurfaceOp<I> | null>

interface PendingFrame<I extends DecodedImage> {
  seq: number
  copies: SurfaceOp<I>[]
  tiles: PendingOp<I>[]
  bytes: number
  firstAt: number
}

/** Partial frames kept at most; older ones are dropped (an agent bug or a lost frame end). */
const MAX_PARTIAL_FRAMES = 6

function release<I extends DecodedImage>(op: SurfaceOp<I> | null | undefined) {
  if (op && op.op === 'image') op.image.close?.()
}

export class FramePipeline<I extends DecodedImage = DecodedImage> {
  private frames = new Map<number, PendingFrame<I>>()
  private chain: Promise<void> = Promise.resolve()
  private generation = 0
  private queued = 0
  private hooks: PipelineHooks<I>
  private now: () => number
  /** Frames received in full but not yet presented. */
  get inFlight(): number {
    return this.queued
  }

  /** Frames whose tiles are still arriving. */
  get partial(): number {
    return this.frames.size
  }

  constructor(hooks: PipelineHooks<I>) {
    this.hooks = hooks
    this.now = hooks.now ?? (() => performance.now())
  }

  push(message: MediaMessage, byteLength = 0) {
    switch (message.type) {
      case 'tile': {
        const frame = this.frame(message.frameSeq)
        frame.tiles.push(this.tileOp(message))
        frame.bytes += byteLength
        break
      }
      case 'copy_rect': {
        const frame = this.frame(message.frameSeq)
        frame.copies.push({ op: 'copy', srcX: message.srcX, srcY: message.srcY, w: message.w, h: message.h, dstX: message.dstX, dstY: message.dstY })
        frame.bytes += byteLength
        break
      }
      case 'frame_end':
        this.finish(message.frameSeq, message.tiles, byteLength)
        break
      default:
        // Cursor messages are composited by the viewer, not drawn into the frame.
        break
    }
  }

  /** A new stream (ready, resize or monitor switch): drops partial frames, then resizes in order. */
  reset(width: number, height: number) {
    this.dropPartials()
    const generation = this.generation
    this.chain = this.chain.then(() => {
      if (generation === this.generation) this.hooks.reset(width, height)
    })
  }

  /** Stops presenting; pending decodes are released when they settle. */
  dispose() {
    this.generation += 1
    this.dropPartials()
    this.queued = 0
  }

  /** Resolves once every queued frame was presented (tests, screenshots). */
  idle(): Promise<void> {
    return this.chain
  }

  private frame(seq: number): PendingFrame<I> {
    let frame = this.frames.get(seq)
    if (!frame) {
      if (this.frames.size >= MAX_PARTIAL_FRAMES) {
        const oldest = this.frames.keys().next().value as number
        this.discard(this.frames.get(oldest)!)
        this.frames.delete(oldest)
      }
      frame = { seq, copies: [], tiles: [], bytes: 0, firstAt: this.now() }
      this.frames.set(seq, frame)
    }
    return frame
  }

  private tileOp(tile: TileMessage): PendingOp<I> {
    const { x, y, w, h } = tile
    if (w === 0 || h === 0) return null
    switch (tile.encoding) {
      case TILE_ENCODING.jpeg:
        return this.hooks.decodeJpeg(tile.payload, w, h).then(
          (image): SurfaceOp<I> => ({ op: 'image', x, y, w, h, image }),
          () => null,
        )
      case TILE_ENCODING.rawBgra:
        return { op: 'pixels', x, y, w, h, rgba: bgraToRgba(tile.payload) }
      case TILE_ENCODING.solid:
        return { op: 'solid', x, y, w, h, rgb: solidRgb(tile.payload) }
      default:
        return null
    }
  }

  private finish(seq: number, expected: number, byteLength: number) {
    const frame = this.frames.get(seq) ?? { seq, copies: [], tiles: [], bytes: 0, firstAt: this.now() }
    this.frames.delete(seq)
    frame.bytes += byteLength
    const endedAt = this.now()
    const generation = this.generation
    this.queued += 1
    // Start every decode now; only the drawing waits for earlier frames.
    const decoded = Promise.all(frame.tiles)
    this.chain = this.chain
      .then(async () => {
        const ops = await decoded
        if (generation !== this.generation) {
          ops.forEach(release)
          return
        }
        const decodedAt = this.now()
        const tiles = ops.filter((op): op is SurfaceOp<I> => op !== null)
        const damaged = tiles.length !== ops.length || frame.tiles.length !== expected
        this.hooks.apply([...frame.copies, ...tiles])
        this.queued = Math.max(0, this.queued - 1)
        const presentedAt = this.now()
        this.hooks.presented({
          frameSeq: seq,
          tiles: frame.tiles.length,
          expected,
          copies: frame.copies.length,
          bytes: frame.bytes,
          decodeMs: decodedAt - endedAt,
          latencyMs: presentedAt - frame.firstAt,
          damaged,
          presentedAt,
        })
      })
      .catch(() => {
        // A failing draw must not stall later frames; the frame counts as presented but damaged.
        if (generation !== this.generation) return
        this.queued = Math.max(0, this.queued - 1)
        const presentedAt = this.now()
        this.hooks.presented({
          frameSeq: seq,
          tiles: frame.tiles.length,
          expected,
          copies: frame.copies.length,
          bytes: frame.bytes,
          decodeMs: 0,
          latencyMs: presentedAt - frame.firstAt,
          damaged: true,
          presentedAt,
        })
      })
  }

  private discard(frame: PendingFrame<I>) {
    for (const op of frame.tiles) {
      if (op instanceof Promise) void op.then(release)
      else release(op)
    }
  }

  private dropPartials() {
    for (const frame of this.frames.values()) this.discard(frame)
    this.frames.clear()
  }
}

export interface FrameMeterSnapshot {
  /** Frames presented in the last second. */
  fps: number
  /** Received media bytes per second, as kbit/s. */
  kbps: number
  /** Rolling averages over recent frames. */
  decodeMs: number
  latencyMs: number
  presented: number
  damaged: number
}

/** Viewer-side frame statistics for the stats overlay. */
export class FrameMeter {
  private times: number[] = []
  private bytes: { at: number; n: number }[] = []
  private decode = 0
  private latency = 0
  private total = 0
  private damagedCount = 0

  record(info: FrameInfo) {
    this.total += 1
    if (info.damaged) this.damagedCount += 1
    const alpha = this.total === 1 ? 1 : 0.2
    this.decode += (info.decodeMs - this.decode) * alpha
    this.latency += (info.latencyMs - this.latency) * alpha
    this.times.push(info.presentedAt)
  }

  addBytes(n: number, at: number) {
    this.bytes.push({ at, n })
  }

  snapshot(now: number): FrameMeterSnapshot {
    while (this.times.length && this.times[0] < now - 1000) this.times.shift()
    while (this.bytes.length && this.bytes[0].at < now - 2000) this.bytes.shift()
    const bytes = this.bytes.reduce((sum, item) => sum + item.n, 0)
    return {
      fps: this.times.length,
      kbps: Math.round((bytes * 8) / 2 / 1000),
      decodeMs: Math.round(this.decode * 10) / 10,
      latencyMs: Math.round(this.latency * 10) / 10,
      presented: this.total,
      damaged: this.damagedCount,
    }
  }
}
