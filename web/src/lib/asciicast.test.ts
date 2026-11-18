import { describe, expect, it } from 'vitest'
import { AsciicastError, compressIdle, eventIndexAt, maxSize, parseAsciicast, parseResize, playbackOps, sizeAt } from './asciicast'

const SAMPLE = [
  JSON.stringify({ version: 2, width: 100, height: 30, timestamp: 1794960000, title: 'PowerShell on NWD-DC01', env: { SHELL: 'powershell' } }),
  JSON.stringify([0.12, 'o', 'PS C:\\> ']),
  JSON.stringify([0.9, 'o', 'h']),
  JSON.stringify([1.0, 'o', 'i']),
  JSON.stringify([1.2, 'r', '120x40']),
  JSON.stringify([12.2, 'o', '\r\nhello\r\n']),
  'not json',
  JSON.stringify([13, 'x', 'unknown code']),
  JSON.stringify([13.5, 'o', 'PS C:\\> ']),
  '',
].join('\n')

describe('parseAsciicast', () => {
  it('reads the header and events', () => {
    const cast = parseAsciicast(SAMPLE)
    expect(cast.header.width).toBe(100)
    expect(cast.header.height).toBe(30)
    expect(cast.header.title).toBe('PowerShell on NWD-DC01')
    expect(cast.events).toHaveLength(6)
    expect(cast.events[3]).toEqual({ time: 1.2, type: 'r', data: '120x40' })
    expect(cast.duration).toBe(13.5)
  })

  it('skips malformed lines and unknown event codes', () => {
    const cast = parseAsciicast(SAMPLE)
    expect(cast.events.every((event) => event.type === 'o' || event.type === 'r')).toBe(true)
  })

  it('handles CRLF files and leading blank lines', () => {
    const cast = parseAsciicast(`\r\n${SAMPLE.replace(/\n/g, '\r\n')}`)
    expect(cast.events).toHaveLength(6)
  })

  it('sorts out-of-order events and clamps negative times', () => {
    const text = [JSON.stringify({ version: 2, width: 80, height: 24 }), JSON.stringify([2, 'o', 'b']), JSON.stringify([-1, 'o', 'a'])].join('\n')
    expect(parseAsciicast(text).events.map((event) => [event.time, event.data])).toEqual([
      [0, 'a'],
      [2, 'b'],
    ])
  })

  it('falls back to 80x24 for a header without a usable size', () => {
    const cast = parseAsciicast(JSON.stringify({ version: 2, width: 'wide' }))
    expect(cast.header.width).toBe(80)
    expect(cast.header.height).toBe(24)
    expect(cast.duration).toBe(0)
  })

  it('rejects empty files, bad JSON and other versions', () => {
    expect(() => parseAsciicast('')).toThrow(AsciicastError)
    expect(() => parseAsciicast('{oops')).toThrow(AsciicastError)
    expect(() => parseAsciicast(JSON.stringify({ version: 1, width: 80, height: 24 }))).toThrow(/v2/)
  })
})

describe('timing', () => {
  const cast = parseAsciicast(SAMPLE)

  it('caps idle gaps without changing short pauses', () => {
    const compressed = compressIdle(cast.events, 2)
    expect(compressed.map((event) => Number(event.time.toFixed(2)))).toEqual([0.12, 0.9, 1, 1.2, 3.2, 4.5])
    // The original events are untouched.
    expect(cast.events[4].time).toBe(12.2)
  })

  it('compresses a long pause before the first event', () => {
    const events = [{ time: 30, type: 'o' as const, data: 'x' }]
    expect(compressIdle(events, 1)[0].time).toBe(1)
  })

  it('leaves events alone when compression is off', () => {
    expect(compressIdle(cast.events, 0)).toBe(cast.events)
  })

  it('counts the events played by a given time', () => {
    expect(eventIndexAt(cast.events, 0)).toBe(0)
    expect(eventIndexAt(cast.events, 0.12)).toBe(1)
    expect(eventIndexAt(cast.events, 1.1)).toBe(3)
    expect(eventIndexAt(cast.events, 100)).toBe(cast.events.length)
    expect(eventIndexAt([], 5)).toBe(0)
  })
})

describe('playback', () => {
  const cast = parseAsciicast(SAMPLE)

  it('merges consecutive output and keeps resizes in order', () => {
    expect(playbackOps(cast.events, 0, cast.events.length)).toEqual([
      { kind: 'output', data: 'PS C:\\> hi' },
      { kind: 'resize', cols: 120, rows: 40 },
      { kind: 'output', data: '\r\nhello\r\nPS C:\\> ' },
    ])
  })

  it('applies only the requested window', () => {
    expect(playbackOps(cast.events, 1, 3)).toEqual([{ kind: 'output', data: 'hi' }])
    expect(playbackOps(cast.events, 5, 99)).toEqual([{ kind: 'output', data: 'PS C:\\> ' }])
  })

  it('tracks the terminal size', () => {
    expect(sizeAt(cast.header, cast.events, 2)).toEqual({ cols: 100, rows: 30 })
    expect(sizeAt(cast.header, cast.events, 4)).toEqual({ cols: 120, rows: 40 })
    expect(maxSize(cast)).toEqual({ cols: 120, rows: 40 })
  })

  it('parses resize payloads', () => {
    expect(parseResize('132x43')).toEqual({ cols: 132, rows: 43 })
    expect(parseResize('0x10')).toBeNull()
    expect(parseResize('wide')).toBeNull()
  })
})
