/*
 * Remote desktop binary media messages (agent → browser), as defined in docs/api-desktop.md and
 * mirrored from `crates/proto/src/desktop.rs`. The first byte is the message type; every integer
 * is little-endian. Payloads are returned as views into the input buffer (no copies).
 */

/** Binary message types (first byte). */
export const MEDIA_KIND = {
  tile: 0x01,
  frameEnd: 0x02,
  cursorPosition: 0x03,
  cursorShape: 0x04,
  copyRect: 0x05,
} as const

/** Tile payload encodings. */
export const TILE_ENCODING = {
  /** A baseline JPEG of exactly the tile's size. */
  jpeg: 1,
  /** Uncompressed BGRA, `w * h * 4` bytes, rows top-down (regions of at most 256 pixels). */
  rawBgra: 2,
  /** The whole tile is one colour; the payload is 4 bytes of BGRA. */
  solid: 3,
} as const

/** Size of a tile message before its payload. */
export const TILE_HEADER_LEN = 14
/** Largest cursor image the agent sends (pixels per side). */
export const MAX_CURSOR_SIDE = 256
/** The agent merges dirty 64×64 tiles into rectangles of up to 16×4 tiles. */
export const TILE_SIZE = 64
export const MAX_REGION_WIDTH = 1024
export const MAX_REGION_HEIGHT = 256
/** Regions of at most this many pixels are sent raw. */
export const RAW_MAX_PIXELS = 256

export interface TileMessage {
  type: 'tile'
  frameSeq: number
  x: number
  y: number
  w: number
  h: number
  encoding: number
  payload: Uint8Array
}

export interface FrameEndMessage {
  type: 'frame_end'
  frameSeq: number
  /** Number of tile messages in the frame (copy rects are not counted). */
  tiles: number
}

export interface CursorPositionMessage {
  type: 'cursor_position'
  /** Pixels of the active monitor; may be negative or beyond it. */
  x: number
  y: number
  visible: boolean
}

export interface CursorShapeMessage {
  type: 'cursor_shape'
  hotX: number
  hotY: number
  w: number
  h: number
  /** `w * h * 4` bytes of RGBA. */
  rgba: Uint8Array
}

export interface CopyRectMessage {
  type: 'copy_rect'
  frameSeq: number
  srcX: number
  srcY: number
  w: number
  h: number
  dstX: number
  dstY: number
}

export type MediaMessage = TileMessage | FrameEndMessage | CursorPositionMessage | CursorShapeMessage | CopyRectMessage

export type MediaErrorCode = 'empty' | 'unknown_type' | 'truncated' | 'bad_payload'

export class MediaError extends Error {
  readonly code: MediaErrorCode
  /** The message type byte, when there was one. */
  readonly kind: number | null

  constructor(code: MediaErrorCode, message: string, kind: number | null = null) {
    super(message)
    this.name = 'MediaError'
    this.code = code
    this.kind = kind
  }
}

function toBytes(input: ArrayBuffer | Uint8Array): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input)
}

const hex = (value: number) => `0x${value.toString(16).padStart(2, '0')}`

/** The message type byte, or null for an empty message. */
export function peekKind(input: ArrayBuffer | Uint8Array): number | null {
  const bytes = toBytes(input)
  return bytes.byteLength > 0 ? bytes[0] : null
}

/** Decodes one binary message. Throws a `MediaError` with the same cases as the Rust decoder. */
export function decodeMedia(input: ArrayBuffer | Uint8Array): MediaMessage {
  const bytes = toBytes(input)
  if (bytes.byteLength === 0) throw new MediaError('empty', 'empty message')
  const kind = bytes[0]
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // Offsets below are relative to the byte after the type, like the Rust decoder's `rest`.
  const rest = bytes.byteLength - 1
  const need = (n: number) => {
    if (rest < n) throw new MediaError('truncated', `message type ${hex(kind)} is truncated (${bytes.byteLength} bytes)`, kind)
  }
  const u16 = (offset: number) => view.getUint16(1 + offset, true)
  const i16 = (offset: number) => view.getInt16(1 + offset, true)
  const u32 = (offset: number) => view.getUint32(1 + offset, true)

  switch (kind) {
    case MEDIA_KIND.tile: {
      need(TILE_HEADER_LEN - 1)
      const w = u16(8)
      const h = u16(10)
      const encoding = bytes[13]
      const payload = bytes.subarray(TILE_HEADER_LEN)
      const expected = encoding === TILE_ENCODING.rawBgra ? w * h * 4 : encoding === TILE_ENCODING.solid ? 4 : null
      if (expected !== null && expected !== payload.byteLength) {
        throw new MediaError('bad_payload', 'payload size does not match the header', kind)
      }
      return { type: 'tile', frameSeq: u32(0), x: u16(4), y: u16(6), w, h, encoding, payload }
    }
    case MEDIA_KIND.frameEnd:
      need(6)
      return { type: 'frame_end', frameSeq: u32(0), tiles: u16(4) }
    case MEDIA_KIND.cursorPosition:
      need(5)
      return { type: 'cursor_position', x: i16(0), y: i16(2), visible: bytes[5] !== 0 }
    case MEDIA_KIND.cursorShape: {
      need(8)
      const w = u16(4)
      const h = u16(6)
      const rgba = bytes.subarray(9)
      if (rgba.byteLength !== w * h * 4) throw new MediaError('bad_payload', 'payload size does not match the header', kind)
      return { type: 'cursor_shape', hotX: u16(0), hotY: u16(2), w, h, rgba }
    }
    case MEDIA_KIND.copyRect:
      need(16)
      return {
        type: 'copy_rect',
        frameSeq: u32(0),
        srcX: u16(4),
        srcY: u16(6),
        w: u16(8),
        h: u16(10),
        dstX: u16(12),
        dstY: u16(14),
      }
    default:
      throw new MediaError('unknown_type', `unknown message type ${hex(kind)}`, kind)
  }
}

class Writer {
  readonly bytes: Uint8Array<ArrayBuffer>
  private view: DataView
  private offset = 0

  constructor(length: number) {
    this.bytes = new Uint8Array(new ArrayBuffer(length))
    this.view = new DataView(this.bytes.buffer)
  }

  u8(value: number) {
    this.view.setUint8(this.offset, value)
    this.offset += 1
    return this
  }

  u16(value: number) {
    this.view.setUint16(this.offset, value, true)
    this.offset += 2
    return this
  }

  i16(value: number) {
    this.view.setInt16(this.offset, value, true)
    this.offset += 2
    return this
  }

  u32(value: number) {
    this.view.setUint32(this.offset, value >>> 0, true)
    this.offset += 4
    return this
  }

  raw(data: Uint8Array) {
    this.bytes.set(data, this.offset)
    this.offset += data.byteLength
    return this
  }
}

/** Encodes one message exactly as the agent does (used by the mock agent and the tests). */
export function encodeMedia(message: MediaMessage): Uint8Array<ArrayBuffer> {
  switch (message.type) {
    case 'tile':
      return new Writer(TILE_HEADER_LEN + message.payload.byteLength)
        .u8(MEDIA_KIND.tile)
        .u32(message.frameSeq)
        .u16(message.x)
        .u16(message.y)
        .u16(message.w)
        .u16(message.h)
        .u8(message.encoding)
        .raw(message.payload).bytes
    case 'frame_end':
      return new Writer(7).u8(MEDIA_KIND.frameEnd).u32(message.frameSeq).u16(message.tiles).bytes
    case 'cursor_position':
      return new Writer(6)
        .u8(MEDIA_KIND.cursorPosition)
        .i16(message.x)
        .i16(message.y)
        .u8(message.visible ? 1 : 0).bytes
    case 'cursor_shape':
      return new Writer(9 + message.rgba.byteLength)
        .u8(MEDIA_KIND.cursorShape)
        .u16(message.hotX)
        .u16(message.hotY)
        .u16(message.w)
        .u16(message.h)
        .raw(message.rgba).bytes
    case 'copy_rect':
      return new Writer(17)
        .u8(MEDIA_KIND.copyRect)
        .u32(message.frameSeq)
        .u16(message.srcX)
        .u16(message.srcY)
        .u16(message.w)
        .u16(message.h)
        .u16(message.dstX)
        .u16(message.dstY).bytes
  }
}

/** Converts a BGRA payload (rows top-down) to RGBA for `ImageData`. Alpha is forced opaque. */
export function bgraToRgba(bgra: Uint8Array, out: Uint8ClampedArray<ArrayBuffer> = new Uint8ClampedArray(bgra.byteLength)): Uint8ClampedArray<ArrayBuffer> {
  for (let index = 0; index + 3 < bgra.byteLength; index += 4) {
    out[index] = bgra[index + 2]
    out[index + 1] = bgra[index + 1]
    out[index + 2] = bgra[index]
    out[index + 3] = 255
  }
  return out
}

/** `[r, g, b]` of a solid tile's BGRA payload. */
export function solidRgb(payload: Uint8Array): [number, number, number] {
  return [payload[2] ?? 0, payload[1] ?? 0, payload[0] ?? 0]
}
