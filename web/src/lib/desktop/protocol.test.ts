/* Golden-byte tests mirroring `crates/proto/src/desktop.rs` (tile_golden_bytes, small_messages_golden_bytes, decoding_rejects_garbage). */
import { describe, expect, it } from 'vitest'
import { MEDIA_KIND, MediaError, TILE_ENCODING, bgraToRgba, decodeMedia, encodeMedia, peekKind, solidRgb, type MediaMessage } from './protocol'

const bytes = (values: number[]) => new Uint8Array(values)

describe('tile messages', () => {
  const golden = [
    0x01, // type
    0x04, 0x03, 0x02, 0x01, // frame_seq
    0x40, 0x00, // x
    0x80, 0x00, // y
    0x40, 0x01, // w
    0x02, 0x00, // h
    0x03, // encoding
    0x10, 0x20, 0x30, 0xff, // BGRA
  ]

  it('encodes and decodes the Rust golden bytes', () => {
    const tile: MediaMessage = { type: 'tile', frameSeq: 0x0102_0304, x: 64, y: 128, w: 0x0140, h: 2, encoding: TILE_ENCODING.solid, payload: bytes([0x10, 0x20, 0x30, 0xff]) }
    expect([...encodeMedia(tile)]).toEqual(golden)
    expect(decodeMedia(bytes(golden))).toEqual(tile)
  })

  it('returns the payload as a view into the message, not a copy', () => {
    const buffer = bytes(golden).buffer
    const tile = decodeMedia(buffer)
    expect(tile.type).toBe('tile')
    if (tile.type !== 'tile') return
    expect(tile.payload.buffer).toBe(buffer)
    expect(tile.payload.byteOffset).toBe(14)
  })

  it('decodes a message that starts inside a larger buffer', () => {
    const padded = new Uint8Array(golden.length + 5)
    padded.set(golden, 3)
    const tile = decodeMedia(padded.subarray(3, 3 + golden.length))
    expect(tile).toMatchObject({ type: 'tile', frameSeq: 0x0102_0304, x: 64, y: 128, w: 320, h: 2 })
  })

  it('reads frame numbers as unsigned 32-bit values', () => {
    const message = encodeMedia({ type: 'frame_end', frameSeq: 0xffff_ffff, tiles: 0 })
    expect(decodeMedia(message)).toEqual({ type: 'frame_end', frameSeq: 4294967295, tiles: 0 })
  })

  it('round-trips raw BGRA and JPEG tiles', () => {
    const raw: MediaMessage = { type: 'tile', frameSeq: 9, x: 1, y: 2, w: 2, h: 1, encoding: TILE_ENCODING.rawBgra, payload: bytes([1, 2, 3, 255, 4, 5, 6, 255]) }
    expect(decodeMedia(encodeMedia(raw))).toEqual(raw)
    const jpeg: MediaMessage = { type: 'tile', frameSeq: 9, x: 0, y: 0, w: 64, h: 64, encoding: TILE_ENCODING.jpeg, payload: bytes([0xff, 0xd8, 0xff, 0xd9]) }
    expect(decodeMedia(encodeMedia(jpeg))).toEqual(jpeg)
  })
})

describe('small messages', () => {
  const cases: [MediaMessage, number[]][] = [
    [{ type: 'frame_end', frameSeq: 7, tiles: 0x0203 }, [0x02, 7, 0, 0, 0, 0x03, 0x02]],
    [{ type: 'cursor_position', x: -2, y: 300, visible: true }, [0x03, 0xfe, 0xff, 0x2c, 0x01, 1]],
    [{ type: 'cursor_shape', hotX: 1, hotY: 2, w: 1, h: 1, rgba: bytes([9, 8, 7, 6]) }, [0x04, 1, 0, 2, 0, 1, 0, 1, 0, 9, 8, 7, 6]],
    [
      { type: 'copy_rect', frameSeq: 0x01, srcX: 0, srcY: 100, w: 800, h: 500, dstX: 0, dstY: 60 },
      [0x05, 1, 0, 0, 0, 0, 0, 100, 0, 0x20, 0x03, 0xf4, 0x01, 0, 0, 60, 0],
    ],
  ]

  it.each(cases)('%o matches the golden bytes', (message, golden) => {
    expect([...encodeMedia(message)]).toEqual(golden)
    expect(decodeMedia(bytes(golden))).toEqual(message)
  })

  it('reads a hidden cursor', () => {
    expect(decodeMedia(bytes([0x03, 0, 0, 0, 0, 0]))).toEqual({ type: 'cursor_position', x: 0, y: 0, visible: false })
  })

  it('peeks the message type', () => {
    expect(peekKind(bytes([MEDIA_KIND.cursorShape, 1]))).toBe(0x04)
    expect(peekKind(new ArrayBuffer(0))).toBeNull()
  })
})

describe('decoding rejects garbage', () => {
  const error = (input: number[]) => {
    try {
      decodeMedia(bytes(input))
    } catch (caught) {
      return caught as MediaError
    }
    throw new Error('expected a decode error')
  }

  it('rejects empty messages and unknown types', () => {
    expect(error([]).code).toBe('empty')
    const unknown = error([0x7f])
    expect(unknown.code).toBe('unknown_type')
    expect(unknown.kind).toBe(0x7f)
    expect(unknown.message).toBe('unknown message type 0x7f')
  })

  it('rejects truncated messages', () => {
    const truncated = error([0x02, 1, 0])
    expect(truncated.code).toBe('truncated')
    expect(truncated.kind).toBe(0x02)
    expect(error([0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).code).toBe('truncated')
    expect(error([0x05, 1, 0, 0, 0]).code).toBe('truncated')
    expect(error([0x03, 1, 0, 1]).code).toBe('truncated')
  })

  it('rejects raw and solid tiles whose payload does not match the header', () => {
    const raw = encodeMedia({ type: 'tile', frameSeq: 1, x: 0, y: 0, w: 2, h: 2, encoding: TILE_ENCODING.rawBgra, payload: new Uint8Array(15) })
    expect(error([...raw]).code).toBe('bad_payload')
    const solid = encodeMedia({ type: 'tile', frameSeq: 1, x: 0, y: 0, w: 64, h: 64, encoding: TILE_ENCODING.solid, payload: new Uint8Array(3) })
    expect(error([...solid]).code).toBe('bad_payload')
    const shape = [0x04, 0, 0, 0, 0, 2, 0, 2, 0, 1, 2, 3]
    expect(error(shape).code).toBe('bad_payload')
  })

  it('accepts JPEG tiles of any payload length', () => {
    const jpeg = encodeMedia({ type: 'tile', frameSeq: 1, x: 0, y: 0, w: 64, h: 64, encoding: TILE_ENCODING.jpeg, payload: bytes([0xff, 0xd8, 0xff, 0xd9]) })
    expect(decodeMedia(jpeg)).toMatchObject({ type: 'tile', encoding: TILE_ENCODING.jpeg })
  })
})

describe('pixel helpers', () => {
  it('swizzles BGRA to RGBA and forces alpha opaque', () => {
    expect([...bgraToRgba(bytes([10, 20, 30, 0, 40, 50, 60, 128]))]).toEqual([30, 20, 10, 255, 60, 50, 40, 255])
  })

  it('reads a solid tile colour', () => {
    expect(solidRgb(bytes([0x10, 0x20, 0x30, 0xff]))).toEqual([0x30, 0x20, 0x10])
  })
})
