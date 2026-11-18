/*
 * Remote desktop JSON control messages (text frames, both directions) and their limits, mirrored
 * from `DesktopControl` in `crates/proto/src/desktop.rs` (docs/api-desktop.md).
 */

export type DesktopQuality = 'auto' | 'low' | 'medium' | 'high'
export const DESKTOP_QUALITIES: readonly DesktopQuality[] = ['auto', 'low', 'medium', 'high']

/** JPEG quality of the fixed levels; `auto` adapts between 35 and 82. */
export const QUALITY_JPEG: Record<Exclude<DesktopQuality, 'auto'>, number> = { low: 45, medium: 65, high: 82 }

export type ConsentStatus = 'waiting' | 'granted' | 'denied' | 'timeout'
/** Lower-cased Windows input desktop: `default`, `winlogon` (UAC, lock and sign-in screens) or `screensaver`. */
export type InputDesktop = 'default' | 'winlogon' | 'screensaver' | (string & {})
export type CaptureMethod = 'dxgi' | 'gdi' | 'x11' | (string & {})

/** Clipboard text limit in either direction (UTF-8 bytes). */
export const MAX_CLIPBOARD_BYTES = 1024 * 1024
/** `text` message limit (characters). */
export const MAX_TEXT_CHARS = 4096
/** The agent keeps at most this many unacknowledged frames in flight. */
export const MAX_FRAMES_IN_FLIGHT = 2
/** Frames unacknowledged this long are written off by the agent. */
export const FRAME_WRITE_OFF_MS = 10_000
/** A desktop session ends after this long without input (acks don't count). */
export const IDLE_TIMEOUT_MS = 30 * 60_000

export interface MonitorInfo {
  /** Position in the list: primary first, then left to right. */
  id: number
  name: string
  x: number
  y: number
  width: number
  height: number
  primary: boolean
  scale: number
}

export interface ReadyMessage {
  type: 'ready'
  width: number
  height: number
  monitors: MonitorInfo[]
  monitor: number
  view_only: boolean
  desktop: InputDesktop
}

export interface AgentStats {
  fps: number
  kbps: number
  encode_ms: number
  capture: CaptureMethod
}

export type DesktopAgentMessage =
  | ReadyMessage
  | { type: 'desktop'; name: InputDesktop }
  | { type: 'resize'; width: number; height: number }
  | { type: 'clipboard'; text: string }
  | { type: 'consent'; status: ConsentStatus }
  | ({ type: 'stats' } & AgentStats)
  | { type: 'exit'; code: number | null }
  | { type: 'error'; message: string }
  /** Server: always the last text frame. */
  | { type: 'closed'; reason: string }
  /** Server: progress while the agent opens the tunnel (shared with shells). */
  | { type: 'status'; message: string }

export interface MouseMessage {
  type: 'mouse'
  x: number
  y: number
  /** DOM `MouseEvent.buttons`: 1 left, 2 right, 4 middle, 8 back, 16 forward. */
  buttons: number
  /** Notches; positive scrolls right. */
  wheel_x?: number
  /** Notches; positive scrolls down. */
  wheel_y?: number
}

export interface KeyMessage {
  type: 'key'
  /** `KeyboardEvent.code`; empty when unknown, in which case a single-character `key` is typed. */
  code: string
  key: string
  down: boolean
  /** `KeyboardEvent.location`: 0 standard, 1 left, 2 right, 3 numpad. */
  location: number
}

export type DesktopBrowserMessage =
  | { type: 'ack'; frame_seq: number }
  | MouseMessage
  | KeyMessage
  | { type: 'text'; text: string }
  | { type: 'cad' }
  | { type: 'monitor'; id: number }
  | { type: 'quality'; value: DesktopQuality }
  | { type: 'refresh' }
  | { type: 'clipboard'; text: string }
  | { type: 'view_only'; value: boolean }

/** Browser messages the server drops while the session is view-only. */
export function isInputMessage(message: DesktopBrowserMessage): boolean {
  return message.type === 'mouse' || message.type === 'key' || message.type === 'text' || message.type === 'cad' || message.type === 'clipboard'
}

export function encodeControl(message: DesktopBrowserMessage): string {
  return JSON.stringify(message)
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isString = (value: unknown): value is string => typeof value === 'string'

function parseMonitor(value: unknown): MonitorInfo | null {
  if (!isRecord(value) || !isNumber(value.id) || !isNumber(value.width) || !isNumber(value.height)) return null
  return {
    id: value.id,
    name: isString(value.name) ? value.name : `Display ${value.id + 1}`,
    x: isNumber(value.x) ? value.x : 0,
    y: isNumber(value.y) ? value.y : 0,
    width: value.width,
    height: value.height,
    primary: value.primary === true,
    scale: isNumber(value.scale) && value.scale > 0 ? value.scale : 1,
  }
}

/** Parses an agent or server text frame; returns null for malformed or unknown messages. */
export function parseAgentMessage(text: string): DesktopAgentMessage | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(value) || !isString(value.type)) return null
  switch (value.type) {
    case 'ready': {
      if (!isNumber(value.width) || !isNumber(value.height)) return null
      const monitors = Array.isArray(value.monitors) ? value.monitors.map(parseMonitor).filter((item): item is MonitorInfo => item !== null) : []
      return {
        type: 'ready',
        width: value.width,
        height: value.height,
        monitors,
        monitor: isNumber(value.monitor) ? value.monitor : (monitors[0]?.id ?? 0),
        view_only: value.view_only === true,
        desktop: isString(value.desktop) ? value.desktop : 'default',
      }
    }
    case 'desktop':
      return isString(value.name) ? { type: 'desktop', name: value.name } : null
    case 'resize':
      return isNumber(value.width) && isNumber(value.height) ? { type: 'resize', width: value.width, height: value.height } : null
    case 'clipboard':
      return isString(value.text) ? { type: 'clipboard', text: value.text } : null
    case 'consent':
      return value.status === 'waiting' || value.status === 'granted' || value.status === 'denied' || value.status === 'timeout'
        ? { type: 'consent', status: value.status }
        : null
    case 'stats':
      return {
        type: 'stats',
        fps: isNumber(value.fps) ? value.fps : 0,
        kbps: isNumber(value.kbps) ? value.kbps : 0,
        encode_ms: isNumber(value.encode_ms) ? value.encode_ms : 0,
        capture: isString(value.capture) ? value.capture : '',
      }
    case 'exit':
      return { type: 'exit', code: isNumber(value.code) ? value.code : null }
    case 'error':
      return { type: 'error', message: isString(value.message) ? value.message : 'The agent reported an error.' }
    case 'closed':
      return { type: 'closed', reason: isString(value.reason) ? value.reason : '' }
    case 'status':
      return isString(value.message) ? { type: 'status', message: value.message } : null
    default:
      return null
  }
}

/** UTF-8 byte length without allocating an encoded copy. */
export function utf8Length(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
      } else bytes += 3
    } else bytes += 3
  }
  return bytes
}

export type ClipboardCheck = { ok: true; bytes: number } | { ok: false; bytes: number; reason: 'empty' | 'too_large' }

/** Whether `text` may be sent as a clipboard message (non-empty, at most 1 MiB of UTF-8). */
export function checkClipboard(text: string): ClipboardCheck {
  const bytes = utf8Length(text)
  if (bytes === 0) return { ok: false, bytes, reason: 'empty' }
  if (bytes > MAX_CLIPBOARD_BYTES) return { ok: false, bytes, reason: 'too_large' }
  return { ok: true, bytes }
}

/**
 * Splits text into `text` messages of at most `max` characters (Unicode code points), never
 * splitting a surrogate pair. Line breaks are normalised to `\n`.
 */
export function chunkText(text: string, max = MAX_TEXT_CHARS): string[] {
  const normalized = text.replace(/\r\n?/g, '\n')
  const chunks: string[] = []
  let current = ''
  let count = 0
  for (const char of normalized) {
    if (count === max) {
      chunks.push(current)
      current = ''
      count = 0
    }
    current += char
    count += 1
  }
  if (current) chunks.push(current)
  return chunks
}

/** Typing more than this is refused: it would be thousands of keystrokes on the device. */
export const MAX_TYPED_CHARS = MAX_TEXT_CHARS * 4
