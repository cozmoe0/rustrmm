import { describe, expect, it } from 'vitest'
import {
  MAX_CLIPBOARD_BYTES,
  MAX_TEXT_CHARS,
  checkClipboard,
  chunkText,
  encodeControl,
  isInputMessage,
  parseAgentMessage,
  utf8Length,
} from './control'

describe('control messages', () => {
  it('encodes browser messages like the Rust serializer', () => {
    expect(encodeControl({ type: 'ack', frame_seq: 12 })).toBe('{"type":"ack","frame_seq":12}')
    expect(encodeControl({ type: 'cad' })).toBe('{"type":"cad"}')
    expect(encodeControl({ type: 'refresh' })).toBe('{"type":"refresh"}')
    expect(encodeControl({ type: 'quality', value: 'high' })).toBe('{"type":"quality","value":"high"}')
    expect(encodeControl({ type: 'view_only', value: true })).toBe('{"type":"view_only","value":true}')
    expect(encodeControl({ type: 'monitor', id: 1 })).toBe('{"type":"monitor","id":1}')
    expect(encodeControl({ type: 'key', code: 'KeyA', key: 'a', down: true, location: 0 })).toBe('{"type":"key","code":"KeyA","key":"a","down":true,"location":0}')
    // Rust prints -1.0; both parse to the same number.
    expect(JSON.parse(encodeControl({ type: 'mouse', x: 10, y: 20, buttons: 1, wheel_y: -1 }))).toEqual(JSON.parse('{"type":"mouse","x":10,"y":20,"buttons":1,"wheel_y":-1.0}'))
  })

  it('marks the messages the server drops while view-only', () => {
    expect(isInputMessage({ type: 'mouse', x: 0, y: 0, buttons: 0 })).toBe(true)
    expect(isInputMessage({ type: 'clipboard', text: 'x' })).toBe(true)
    expect(isInputMessage({ type: 'cad' })).toBe(true)
    expect(isInputMessage({ type: 'ack', frame_seq: 1 })).toBe(false)
    expect(isInputMessage({ type: 'view_only', value: false })).toBe(false)
    expect(isInputMessage({ type: 'monitor', id: 0 })).toBe(false)
  })

  it('parses ready with monitors', () => {
    const message = parseAgentMessage(
      '{"type":"ready","width":2560,"height":1440,"monitors":[{"id":0,"name":"\\\\\\\\.\\\\DISPLAY1","x":0,"y":0,"width":2560,"height":1440,"primary":true,"scale":1.0},{"id":1,"name":"\\\\\\\\.\\\\DISPLAY2","x":2560,"y":0,"width":1920,"height":1080,"primary":false,"scale":1.25}],"monitor":0,"view_only":false,"desktop":"default"}',
    )
    expect(message).toEqual({
      type: 'ready',
      width: 2560,
      height: 1440,
      monitors: [
        { id: 0, name: '\\\\.\\DISPLAY1', x: 0, y: 0, width: 2560, height: 1440, primary: true, scale: 1 },
        { id: 1, name: '\\\\.\\DISPLAY2', x: 2560, y: 0, width: 1920, height: 1080, primary: false, scale: 1.25 },
      ],
      monitor: 0,
      view_only: false,
      desktop: 'default',
    })
  })

  it('parses the other agent and server messages', () => {
    expect(parseAgentMessage('{"type":"consent","status":"waiting"}')).toEqual({ type: 'consent', status: 'waiting' })
    expect(parseAgentMessage('{"type":"desktop","name":"winlogon"}')).toEqual({ type: 'desktop', name: 'winlogon' })
    expect(parseAgentMessage('{"type":"resize","width":1600,"height":900}')).toEqual({ type: 'resize', width: 1600, height: 900 })
    expect(parseAgentMessage('{"type":"clipboard","text":"hi"}')).toEqual({ type: 'clipboard', text: 'hi' })
    expect(parseAgentMessage('{"type":"stats","fps":19.5,"kbps":2400,"encode_ms":4.2,"capture":"dxgi"}')).toEqual({ type: 'stats', fps: 19.5, kbps: 2400, encode_ms: 4.2, capture: 'dxgi' })
    expect(parseAgentMessage('{"type":"exit","code":null}')).toEqual({ type: 'exit', code: null })
    expect(parseAgentMessage('{"type":"error","message":"Wayland sessions are not supported yet"}')).toEqual({ type: 'error', message: 'Wayland sessions are not supported yet' })
    expect(parseAgentMessage('{"type":"closed","reason":"the user denied the session"}')).toEqual({ type: 'closed', reason: 'the user denied the session' })
  })

  it('ignores malformed and unknown messages', () => {
    expect(parseAgentMessage('not json')).toBeNull()
    expect(parseAgentMessage('[1,2]')).toBeNull()
    expect(parseAgentMessage('{"type":"teleport"}')).toBeNull()
    expect(parseAgentMessage('{"type":"consent","status":"maybe"}')).toBeNull()
    expect(parseAgentMessage('{"type":"ready","width":"wide"}')).toBeNull()
  })
})

describe('clipboard limit', () => {
  it('counts UTF-8 bytes like TextEncoder', () => {
    const samples = ['', 'plain ascii', 'café', '€uro', '日本語', 'emoji 🙂👍🏽', 'lone \ud800 surrogate', 'x'.repeat(1000)]
    const encoder = new TextEncoder()
    for (const sample of samples) expect(utf8Length(sample)).toBe(encoder.encode(sample).byteLength)
  })

  it('allows up to exactly 1 MiB of UTF-8', () => {
    expect(checkClipboard('a'.repeat(MAX_CLIPBOARD_BYTES))).toEqual({ ok: true, bytes: MAX_CLIPBOARD_BYTES })
    expect(checkClipboard('a'.repeat(MAX_CLIPBOARD_BYTES + 1))).toEqual({ ok: false, bytes: MAX_CLIPBOARD_BYTES + 1, reason: 'too_large' })
  })

  it('measures bytes, not characters', () => {
    // 349 525 three-byte characters are 1 048 575 bytes; one more character crosses the limit.
    const euro = '€'.repeat(349_525)
    expect(checkClipboard(euro).ok).toBe(true)
    expect(checkClipboard(`${euro}€`)).toMatchObject({ ok: false, reason: 'too_large' })
  })

  it('refuses empty text', () => {
    expect(checkClipboard('')).toEqual({ ok: false, bytes: 0, reason: 'empty' })
  })
})

describe('text chunks', () => {
  it('splits at 4096 characters', () => {
    const chunks = chunkText('a'.repeat(MAX_TEXT_CHARS * 2 + 5))
    expect(chunks.map((chunk) => chunk.length)).toEqual([MAX_TEXT_CHARS, MAX_TEXT_CHARS, 5])
  })

  it('counts code points and never splits a surrogate pair', () => {
    const chunks = chunkText('🙂'.repeat(5), 2)
    expect(chunks).toEqual(['🙂🙂', '🙂🙂', '🙂'])
  })

  it('normalises line breaks', () => {
    expect(chunkText('a\r\nb\rc')).toEqual(['a\nb\nc'])
    expect(chunkText('')).toEqual([])
  })
})
