import { describe, expect, it } from 'vitest'
import {
  KeyTracker,
  MAX_NOTCHES,
  SPECIAL_KEYS,
  WheelAccumulator,
  buttonBit,
  codeForKey,
  comboMessages,
  isPasteShortcut,
  keyMessage,
  mouseMessage,
  wheelToNotches,
} from './input'

describe('mouse', () => {
  it('rounds coordinates and keeps the DOM button bitmask', () => {
    expect(mouseMessage({ x: 10.6, y: 19.4 }, 1)).toEqual({ type: 'mouse', x: 11, y: 19, buttons: 1 })
    expect(mouseMessage({ x: 0, y: 0 }, 1 | 2 | 4 | 8 | 16)).toMatchObject({ buttons: 31 })
    expect(mouseMessage({ x: 0, y: 0 }, 0xff)).toMatchObject({ buttons: 31 })
  })

  it('adds wheel notches only when non-zero', () => {
    expect(mouseMessage({ x: 1, y: 1 }, 0, { x: 0, y: 1.25 })).toEqual({ type: 'mouse', x: 1, y: 1, buttons: 0, wheel_y: 1.25 })
    expect(mouseMessage({ x: 1, y: 1 }, 0, { x: -0.5, y: 0 })).toEqual({ type: 'mouse', x: 1, y: 1, buttons: 0, wheel_x: -0.5 })
    expect('wheel_x' in mouseMessage({ x: 1, y: 1 }, 0, { x: 0, y: 0 })).toBe(false)
  })

  it('maps MouseEvent.button to the buttons bitmask', () => {
    expect([0, 1, 2, 3, 4, 7].map(buttonBit)).toEqual([1, 4, 2, 8, 16, 0])
  })
})

describe('wheel notches', () => {
  it('converts pixel, line and page deltas (positive y scrolls down)', () => {
    expect(wheelToNotches({ deltaX: 0, deltaY: 100, deltaMode: 0 })).toEqual({ x: 0, y: 1 })
    expect(wheelToNotches({ deltaX: 0, deltaY: -3, deltaMode: 1 })).toEqual({ x: 0, y: -1 })
    expect(wheelToNotches({ deltaX: 50, deltaY: 0, deltaMode: 0 })).toEqual({ x: 0.5, y: 0 })
    expect(wheelToNotches({ deltaX: 0, deltaY: 1, deltaMode: 2 })).toEqual({ x: 0, y: 3 })
  })

  it('keeps fractions for trackpads and clamps huge deltas', () => {
    expect(wheelToNotches({ deltaX: 0, deltaY: 4, deltaMode: 0 })).toEqual({ x: 0, y: 0.04 })
    expect(wheelToNotches({ deltaX: 0, deltaY: 100_000, deltaMode: 0 }).y).toBe(MAX_NOTCHES)
  })

  it('accumulates a burst of events into one send', () => {
    const wheel = new WheelAccumulator()
    wheel.add({ x: 0, y: 0.3 })
    wheel.add({ x: 0.1, y: 0.3 })
    expect(wheel.take()).toEqual({ x: 0.1, y: 0.6 })
    expect(wheel.take()).toBeNull()
  })
})

describe('keys', () => {
  it('sends code, key and location', () => {
    expect(keyMessage({ code: 'KeyA', key: 'a', location: 0 }, true)).toEqual({ type: 'key', code: 'KeyA', key: 'a', down: true, location: 0 })
    expect(keyMessage({ code: 'ShiftRight', key: 'Shift', location: 2 }, false)).toEqual({ type: 'key', code: 'ShiftRight', key: 'Shift', down: false, location: 2 })
    expect(keyMessage({ code: 'Numpad1', key: '1', location: 3 }, true).location).toBe(3)
  })

  it('falls back to Unicode for unknown codes and fills codes for named keys', () => {
    expect(keyMessage({ code: 'Unidentified', key: 'é' }, true)).toMatchObject({ code: '', key: 'é' })
    expect(keyMessage({ code: '', key: 'Enter' }, true)).toMatchObject({ code: 'Enter', key: 'Enter' })
    expect(keyMessage({ code: '', key: 'Unidentified' }, true)).toMatchObject({ code: '', key: '' })
    expect(keyMessage({ code: 'KeyA', key: 'a', location: 9 }, true).location).toBe(0)
    expect(codeForKey('ArrowLeft')).toBe('ArrowLeft')
    expect(codeForKey('F11')).toBe('F11')
    expect(codeForKey('ß')).toBe('')
  })

  it('tracks held keys and releases them all, most recent first', () => {
    const tracker = new KeyTracker()
    tracker.down({ code: 'ControlLeft', key: 'Control', location: 1 })
    tracker.down({ code: 'AltLeft', key: 'Alt', location: 1 })
    tracker.down({ code: 'KeyT', key: 't' })
    expect(tracker.up({ code: 'KeyT', key: 't' })).toMatchObject({ code: 'KeyT', down: false })
    expect(tracker.up({ code: 'KeyQ', key: 'q' })).toBeNull()
    expect(tracker.isHeld('ControlLeft')).toBe(true)
    expect(tracker.releaseAll().map((message) => [message.code, message.down])).toEqual([
      ['AltLeft', false],
      ['ControlLeft', false],
    ])
    expect(tracker.size).toBe(0)
  })

  it('sends auto-repeat presses again', () => {
    const tracker = new KeyTracker()
    expect(tracker.down({ code: 'KeyA', key: 'a' }).down).toBe(true)
    expect(tracker.down({ code: 'KeyA', key: 'a' }).down).toBe(true)
    expect(tracker.releaseAll()).toHaveLength(1)
  })

  it('presses combinations in order and releases them in reverse', () => {
    expect(comboMessages(SPECIAL_KEYS['alt-tab'].combo).map((message) => `${message.down ? '+' : '-'}${message.code}`)).toEqual(['+AltLeft', '+Tab', '-Tab', '-AltLeft'])
    expect(comboMessages(SPECIAL_KEYS.win.combo).map((message) => `${message.down ? '+' : '-'}${message.code}`)).toEqual(['+MetaLeft', '-MetaLeft'])
    expect(comboMessages(SPECIAL_KEYS['ctrl-esc'].combo)[0]).toEqual({ type: 'key', code: 'ControlLeft', key: 'Control', down: true, location: 1 })
    expect(SPECIAL_KEYS['print-screen'].combo.map((key) => key.code)).toEqual(['PrintScreen'])
  })

  it('recognises the paste shortcut', () => {
    const base = { code: 'KeyV', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }
    expect(isPasteShortcut({ ...base, ctrlKey: true })).toBe(true)
    expect(isPasteShortcut({ ...base, metaKey: true })).toBe(true)
    expect(isPasteShortcut({ ...base, ctrlKey: true, shiftKey: true })).toBe(false)
    expect(isPasteShortcut(base)).toBe(false)
  })
})
