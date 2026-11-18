import { describe, expect, it } from 'vitest'
import { MAX_FRAMES_IN_FLIGHT } from './control'
import { FrameMeter, FramePipeline, type DecodedImage, type FrameInfo, type SurfaceOp } from './pipeline'
import { TILE_ENCODING, type MediaMessage } from './protocol'

interface FakeImage extends DecodedImage {
  id: number
  closed: boolean
}

/** A pipeline whose JPEG decodes resolve when the test says so. */
function harness() {
  const pending: { payload: Uint8Array; resolve: (image: FakeImage) => void; reject: (error: Error) => void }[] = []
  const log: string[] = []
  const presented: FrameInfo[] = []
  const images: FakeImage[] = []
  let clock = 0
  const pipeline = new FramePipeline<FakeImage>({
    decodeJpeg: (payload) =>
      new Promise<FakeImage>((resolve, reject) => {
        pending.push({ payload, resolve, reject })
      }),
    apply: (ops: SurfaceOp<FakeImage>[]) => {
      for (const op of ops) {
        if (op.op === 'copy') log.push(`copy ${op.srcY}->${op.dstY}`)
        else if (op.op === 'image') log.push(`jpeg ${op.image.id}@${op.x},${op.y}`)
        else if (op.op === 'pixels') log.push(`raw ${op.w}x${op.h} [${[...op.rgba.slice(0, 4)].join(',')}]`)
        else log.push(`solid rgb(${op.rgb.join(',')})@${op.x},${op.y}`)
      }
    },
    reset: (width, height) => log.push(`reset ${width}x${height}`),
    presented: (info) => {
      log.push(`present ${info.frameSeq}`)
      presented.push(info)
    },
    now: () => (clock += 1),
  })
  const decode = (index: number, id = index) => {
    const image: FakeImage = { id, width: 64, height: 64, closed: false, close: () => (image.closed = true) }
    images.push(image)
    pending[index].resolve(image)
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
  return { pipeline, pending, log, presented, images, decode, flush }
}

const jpeg = (frameSeq: number, x = 0, y = 0): MediaMessage => ({ type: 'tile', frameSeq, x, y, w: 64, h: 64, encoding: TILE_ENCODING.jpeg, payload: new Uint8Array([0xff, 0xd8]) })
const solid = (frameSeq: number, x = 0): MediaMessage => ({ type: 'tile', frameSeq, x, y: 0, w: 64, h: 64, encoding: TILE_ENCODING.solid, payload: new Uint8Array([0x10, 0x20, 0x30, 0xff]) })
const raw = (frameSeq: number): MediaMessage => ({ type: 'tile', frameSeq, x: 0, y: 0, w: 1, h: 1, encoding: TILE_ENCODING.rawBgra, payload: new Uint8Array([1, 2, 3, 0]) })
const copy = (frameSeq: number): MediaMessage => ({ type: 'copy_rect', frameSeq, srcX: 0, srcY: 100, w: 800, h: 500, dstX: 0, dstY: 60 })
const end = (frameSeq: number, tiles: number): MediaMessage => ({ type: 'frame_end', frameSeq, tiles })

describe('frame assembly', () => {
  it('applies copy rects before tiles, then presents', async () => {
    const { pipeline, log, presented, decode, flush } = harness()
    pipeline.push(jpeg(0, 0, 0))
    pipeline.push(copy(0))
    pipeline.push(solid(0, 64))
    pipeline.push(raw(0))
    pipeline.push(end(0, 3))
    expect(pipeline.inFlight).toBe(1)
    decode(0)
    await flush()
    expect(log).toEqual(['copy 100->60', 'jpeg 0@0,0', 'solid rgb(48,32,16)@64,0', 'raw 1x1 [3,2,1,255]', 'present 0'])
    expect(presented[0]).toMatchObject({ frameSeq: 0, tiles: 3, expected: 3, copies: 1, damaged: false })
    expect(pipeline.inFlight).toBe(0)
  })

  it('presents frames in order even when a later frame decodes first', async () => {
    const { pipeline, log, decode, flush } = harness()
    pipeline.push(jpeg(5))
    pipeline.push(end(5, 1))
    pipeline.push(jpeg(6))
    pipeline.push(end(6, 1))
    expect(pipeline.inFlight).toBe(2)
    decode(1, 61)
    await flush()
    expect(log).toEqual([])
    decode(0, 51)
    await flush()
    expect(log).toEqual(['jpeg 51@0,0', 'present 5', 'jpeg 61@0,0', 'present 6'])
  })

  it('presents an empty frame (copy rects only) at once', async () => {
    const { pipeline, log, flush } = harness()
    pipeline.push(copy(9))
    pipeline.push(end(9, 0))
    await flush()
    expect(log).toEqual(['copy 100->60', 'present 9'])
  })

  it('still presents (and acks) a frame whose tile count does not match, flagged as damaged', async () => {
    const { pipeline, presented, flush } = harness()
    pipeline.push(solid(1))
    pipeline.push(end(1, 2))
    await flush()
    expect(presented[0]).toMatchObject({ frameSeq: 1, tiles: 1, expected: 2, damaged: true })
  })

  it('skips a tile that fails to decode and marks the frame damaged', async () => {
    const { pipeline, pending, log, presented, flush } = harness()
    pipeline.push(jpeg(2))
    pipeline.push(solid(2, 64))
    pipeline.push(end(2, 2))
    pending[0].reject(new Error('corrupt'))
    await flush()
    expect(log).toEqual(['solid rgb(48,32,16)@64,0', 'present 2'])
    expect(presented[0].damaged).toBe(true)
  })

  it('treats an unknown encoding as damage', async () => {
    const { pipeline, presented, flush } = harness()
    pipeline.push({ type: 'tile', frameSeq: 3, x: 0, y: 0, w: 4, h: 4, encoding: 9, payload: new Uint8Array(1) })
    pipeline.push(end(3, 1))
    await flush()
    expect(presented[0].damaged).toBe(true)
  })

  it('ignores cursor messages', async () => {
    const { pipeline, log, flush } = harness()
    pipeline.push({ type: 'cursor_position', x: 1, y: 1, visible: true })
    await flush()
    expect(log).toEqual([])
    expect(pipeline.partial).toBe(0)
  })
})

describe('streams', () => {
  it('resets after the frames before it and drops partial frames', async () => {
    const { pipeline, log, decode, images, flush } = harness()
    pipeline.push(jpeg(0))
    pipeline.push(end(0, 1))
    pipeline.push(jpeg(1))
    // A monitor switch: frame 1 never ends, the new stream starts again at 0.
    pipeline.reset(1600, 900)
    expect(pipeline.partial).toBe(0)
    pipeline.push(solid(0))
    pipeline.push(end(0, 1))
    decode(1, 99)
    decode(0, 7)
    await flush()
    expect(log).toEqual(['jpeg 7@0,0', 'present 0', 'reset 1600x900', 'solid rgb(48,32,16)@0,0', 'present 0'])
    // The dropped frame's decoded tile is released.
    expect(images.find((image) => image.id === 99)?.closed).toBe(true)
  })

  it('stops presenting after dispose and releases late decodes', async () => {
    const { pipeline, log, decode, images, flush } = harness()
    pipeline.push(jpeg(0))
    pipeline.push(end(0, 1))
    pipeline.dispose()
    decode(0)
    await flush()
    expect(log).toEqual([])
    expect(images[0].closed).toBe(true)
  })
})

describe('flow control', () => {
  it('never lets the agent exceed two frames in flight when every presented frame is acked', async () => {
    const acked: number[] = []
    let inFlight = 0
    let maxInFlight = 0
    let nextSeq = 0
    const pipeline = new FramePipeline<DecodedImage>({
      decodeJpeg: () => new Promise((resolve) => setTimeout(() => resolve({ width: 64, height: 64 }), Math.random() * 3)),
      apply: () => undefined,
      reset: () => undefined,
      presented: (info) => {
        acked.push(info.frameSeq)
        inFlight -= 1
        agentPump()
      },
    })
    // The agent's rule: send a new frame only while fewer than MAX_FRAMES_IN_FLIGHT are unacked.
    const agentPump = () => {
      while (inFlight < MAX_FRAMES_IN_FLIGHT && nextSeq < 40) {
        const seq = nextSeq++
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        pipeline.push(jpeg(seq))
        pipeline.push(jpeg(seq, 64))
        pipeline.push(end(seq, 2))
      }
    }
    agentPump()
    for (let round = 0; round < 200 && acked.length < 40; round += 1) await new Promise((resolve) => setTimeout(resolve, 2))
    expect(acked).toEqual(Array.from({ length: 40 }, (_, index) => index))
    expect(maxInFlight).toBe(MAX_FRAMES_IN_FLIGHT)
    expect(pipeline.inFlight).toBe(0)
  })

  it('handles frame numbers that wrap at 2^32', async () => {
    const { pipeline, log, flush } = harness()
    pipeline.push(solid(0xffff_ffff))
    pipeline.push(end(0xffff_ffff, 1))
    pipeline.push(solid(0))
    pipeline.push(end(0, 1))
    await flush()
    expect(log.filter((line) => line.startsWith('present'))).toEqual(['present 4294967295', 'present 0'])
  })
})

describe('frame meter', () => {
  it('reports fps over the last second and kbps over the last two', () => {
    const meter = new FrameMeter()
    const info = (presentedAt: number): FrameInfo => ({ frameSeq: 0, tiles: 1, expected: 1, copies: 0, bytes: 0, decodeMs: 4, latencyMs: 10, damaged: false, presentedAt })
    for (let index = 0; index < 30; index += 1) meter.record(info(1000 + index * 50))
    meter.addBytes(250_000, 2400)
    meter.addBytes(250_000, 2500)
    const snapshot = meter.snapshot(2500)
    expect(snapshot.fps).toBe(20)
    expect(snapshot.kbps).toBe(2000)
    expect(snapshot.decodeMs).toBe(4)
    expect(snapshot.presented).toBe(30)
  })
})
