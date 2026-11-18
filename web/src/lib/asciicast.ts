/*
 * asciicast v2 parsing and playback timing for the in-app shell recording player.
 * Format: a JSON header line, then one JSON array per event: [seconds, code, data].
 * Codes the server writes: "o" (output) and "r" (resize, "COLSxROWS").
 */

export interface AsciicastHeader {
  version: 2
  width: number
  height: number
  timestamp?: number
  title?: string
  idle_time_limit?: number
  env?: Record<string, string>
}

export type AsciicastEventType = 'o' | 'r' | 'i' | 'm'

export interface AsciicastEvent {
  time: number
  type: AsciicastEventType
  data: string
}

export interface Asciicast {
  header: AsciicastHeader
  events: AsciicastEvent[]
  /** Time of the last event, in seconds. */
  duration: number
}

export class AsciicastError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AsciicastError'
  }
}

const EVENT_TYPES = new Set<string>(['o', 'r', 'i', 'm'])

/** Parses an asciicast v2 document. Malformed event lines are skipped; a bad header throws. */
export function parseAsciicast(text: string): Asciicast {
  const lines = text.split(/\r?\n/)
  const first = lines.findIndex((line) => line.trim() !== '')
  if (first < 0) throw new AsciicastError('The recording is empty.')

  let header: AsciicastHeader
  try {
    header = JSON.parse(lines[first]) as AsciicastHeader
  } catch {
    throw new AsciicastError('The recording header is not valid JSON.')
  }
  if (!header || typeof header !== 'object' || header.version !== 2) {
    throw new AsciicastError('Only asciicast v2 recordings are supported.')
  }
  const width = Number(header.width)
  const height = Number(header.height)
  header = {
    ...header,
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : 80,
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : 24,
  }

  const events: AsciicastEvent[] = []
  for (let index = first + 1; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    if (!Array.isArray(value) || value.length < 3) continue
    const [time, type, data] = value as [unknown, unknown, unknown]
    if (typeof time !== 'number' || !Number.isFinite(time) || typeof type !== 'string' || !EVENT_TYPES.has(type)) continue
    events.push({ time: Math.max(0, time), type: type as AsciicastEventType, data: typeof data === 'string' ? data : String(data) })
  }
  // Recordings are written in order, but a stable sort keeps playback correct if they are not.
  events.sort((a, b) => a.time - b.time)
  return { header, events, duration: events.at(-1)?.time ?? 0 }
}

/** Parses a resize payload ("120x32"). */
export function parseResize(data: string): { cols: number; rows: number } | null {
  const match = /^(\d+)x(\d+)$/.exec(data.trim())
  if (!match) return null
  const cols = Number(match[1])
  const rows = Number(match[2])
  return cols > 0 && rows > 0 ? { cols, rows } : null
}

/** Shortens every pause longer than `limit` seconds to `limit`. Returns new events. */
export function compressIdle(events: AsciicastEvent[], limit: number): AsciicastEvent[] {
  if (!(limit > 0)) return events
  let shift = 0
  let previous = 0
  return events.map((event) => {
    const gap = event.time - previous
    if (gap > limit) shift += gap - limit
    previous = event.time
    return { ...event, time: event.time - shift }
  })
}

/** Number of events at or before `time` (so `events.slice(0, n)` has been played). */
export function eventIndexAt(events: AsciicastEvent[], time: number): number {
  let low = 0
  let high = events.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (events[mid].time <= time) low = mid + 1
    else high = mid
  }
  return low
}

export type PlaybackOp = { kind: 'output'; data: string } | { kind: 'resize'; cols: number; rows: number }

/**
 * The terminal operations for events `[from, to)`, with consecutive output merged so a seek is
 * one large write instead of thousands of small ones.
 */
export function playbackOps(events: AsciicastEvent[], from: number, to: number): PlaybackOp[] {
  const ops: PlaybackOp[] = []
  for (let index = Math.max(0, from); index < Math.min(to, events.length); index += 1) {
    const event = events[index]
    if (event.type === 'o') {
      const last = ops.at(-1)
      if (last?.kind === 'output') last.data += event.data
      else ops.push({ kind: 'output', data: event.data })
    } else if (event.type === 'r') {
      const size = parseResize(event.data)
      if (size) ops.push({ kind: 'resize', ...size })
    }
  }
  return ops
}

/** Terminal size in effect after the first `index` events. */
export function sizeAt(header: AsciicastHeader, events: AsciicastEvent[], index: number): { cols: number; rows: number } {
  for (let cursor = Math.min(index, events.length) - 1; cursor >= 0; cursor -= 1) {
    if (events[cursor].type === 'r') {
      const size = parseResize(events[cursor].data)
      if (size) return size
    }
  }
  return { cols: header.width, rows: header.height }
}

/** Largest terminal size used anywhere in the recording (to size the player once). */
export function maxSize(recording: Asciicast): { cols: number; rows: number } {
  let cols = recording.header.width
  let rows = recording.header.height
  for (const event of recording.events) {
    if (event.type !== 'r') continue
    const size = parseResize(event.data)
    if (size) {
      cols = Math.max(cols, size.cols)
      rows = Math.max(rows, size.rows)
    }
  }
  return { cols, rows }
}
