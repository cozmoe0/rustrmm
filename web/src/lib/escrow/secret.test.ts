import { describe, expect, it, vi } from 'vitest'
import {
  canonicalSecret,
  charClass,
  clearIfUnchanged,
  countdown,
  isBitLockerKey,
  itemSubject,
  scheduleClipboardClear,
  secretGroups,
  shortIdentifier,
  validateRevealReason,
} from './secret'

const KEY = '462352-389521-152614-012133-683936-110231-584243-704682'

describe('escrowed secrets', () => {
  it('requires a reason of 10 to 500 characters', () => {
    expect(validateRevealReason('too short')).toMatch(/at least 10/)
    expect(validateRevealReason('   padded       ')).toMatch(/at least 10/)
    expect(validateRevealReason('BIOS update recovery')).toBeNull()
    expect(validateRevealReason('x'.repeat(501))).toMatch(/500/)
  })

  it('formats BitLocker keys as eight groups of six digits', () => {
    expect(isBitLockerKey(KEY)).toBe(true)
    expect(isBitLockerKey(KEY.replace(/-/g, ''))).toBe(true)
    expect(isBitLockerKey('12345')).toBe(false)
    expect(secretGroups('bitlocker', KEY.replace(/-/g, ' '))).toEqual(KEY.split('-'))
    expect(canonicalSecret('bitlocker', KEY.replace(/-/g, ''))).toBe(KEY)
  })

  it('chunks passwords without changing what is copied', () => {
    expect(secretGroups('laps', 'Ab3$efGh9!kLmN')).toEqual(['Ab3$', 'efGh', '9!kL', 'mN'])
    expect(canonicalSecret('laps', 'Ab3$efGh9!kLmN')).toBe('Ab3$efGh9!kLmN')
    expect(secretGroups('filevault', 'abcd-efgh-ijkl-mnop-qrst-uvwx')).toEqual(['ABCD', 'EFGH', 'IJKL', 'MNOP', 'QRST', 'UVWX'])
    expect(['7', 'Q', 'q', '%'].map(charClass)).toEqual(['digit', 'upper', 'lower', 'symbol'])
  })

  it('counts down the reveal window', () => {
    const start = 1_000_000
    expect(countdown(start + 60_000, start)).toEqual({ seconds: 60, fraction: 1, expired: false })
    expect(countdown(start + 60_000, start + 30_500)).toMatchObject({ seconds: 30, expired: false })
    expect(countdown(start + 60_000, start + 60_000)).toEqual({ seconds: 0, fraction: 0, expired: true })
    expect(countdown(start + 60_000, start + 90_000).seconds).toBe(0)
  })

  it('clears the clipboard after the delay only if it still holds the secret', async () => {
    vi.useFakeTimers()
    try {
      let content = 'S3cret!'
      const clipboard = { writeText: vi.fn(async (text: string) => void (content = text)), readText: vi.fn(async () => content) }
      const done = vi.fn()
      const timers = { set: (callback: () => void, ms: number) => window.setTimeout(callback, ms), clear: (id: number) => window.clearTimeout(id) }
      // Not readable without a prompt: overwrite.
      scheduleClipboardClear('S3cret!', { clipboard, timers, onDone: done })
      await vi.advanceTimersByTimeAsync(59_000)
      expect(clipboard.writeText).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(clipboard.writeText).toHaveBeenCalledWith('')
      expect(done).toHaveBeenCalledWith('cleared')

      // A cancelled clear never runs.
      const cancel = scheduleClipboardClear('S3cret!', { clipboard, timers })
      cancel()
      await vi.advanceTimersByTimeAsync(61_000)
      expect(clipboard.writeText).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves the clipboard alone when the user copied something else since', async () => {
    const clipboard = { writeText: vi.fn(async () => undefined), readText: vi.fn(async () => 'something else') }
    expect(await clearIfUnchanged(clipboard, 'S3cret!', async () => true)).toBe('changed')
    expect(clipboard.writeText).not.toHaveBeenCalled()
    expect(await clearIfUnchanged(clipboard, 'something else', async () => true)).toBe('cleared')
    expect(await clearIfUnchanged(null, 'x')).toBe('unavailable')
  })

  it('describes items briefly', () => {
    expect(itemSubject({ kind: 'laps', label: '', identifier: 'it-admin', metadata: { account: 'it-admin' } })).toBe('it-admin')
    expect(itemSubject({ kind: 'bitlocker', label: '', identifier: '{x}', metadata: { volume: 'D:' } })).toBe('D: recovery key')
    expect(shortIdentifier('{2F1C9A0B-6D3E-4B7A-9C21-0E5D8F3A417D}')).toBe('{2F1C9A0B…417D}')
  })
})
