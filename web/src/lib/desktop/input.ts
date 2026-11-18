/*
 * Input encoders for the remote desktop: mouse (DOM button bitmask, wheel notches), keys
 * (`KeyboardEvent.code`, `key`, `location`), special key combinations and stuck-key protection.
 */
import type { KeyMessage, MouseMessage } from './control'

export const MOUSE_BUTTON = { left: 1, right: 2, middle: 4, back: 8, forward: 16 } as const
const BUTTON_MASK = 0x1f

/** Wheel deltas per notch, by `WheelEvent.deltaMode`. */
export const PIXELS_PER_NOTCH = 100
export const LINES_PER_NOTCH = 3
/** One wheel event never scrolls more than this many notches (trackpads can report huge deltas). */
export const MAX_NOTCHES = 10

const round3 = (value: number) => Math.round(value * 1000) / 1000
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export interface WheelNotches {
  x: number
  y: number
}

/**
 * Converts a wheel event's deltas to notches (one detent = 1, fractions allowed): positive `y`
 * scrolls down and positive `x` scrolls right, the same sign convention as `WheelEvent`.
 */
export function wheelToNotches(event: { deltaX: number; deltaY: number; deltaMode: number }): WheelNotches {
  const perNotch = event.deltaMode === 1 ? LINES_PER_NOTCH : event.deltaMode === 2 ? 1 / LINES_PER_NOTCH : PIXELS_PER_NOTCH
  return {
    x: round3(clamp(event.deltaX / perNotch, -MAX_NOTCHES, MAX_NOTCHES)),
    y: round3(clamp(event.deltaY / perNotch, -MAX_NOTCHES, MAX_NOTCHES)),
  }
}

/** Sums wheel input between sends so a burst of trackpad events becomes one message per frame. */
export class WheelAccumulator {
  private x = 0
  private y = 0

  add(notches: WheelNotches) {
    this.x = clamp(this.x + notches.x, -MAX_NOTCHES, MAX_NOTCHES)
    this.y = clamp(this.y + notches.y, -MAX_NOTCHES, MAX_NOTCHES)
  }

  /** The accumulated notches since the last call, or null when there is nothing to send. */
  take(): WheelNotches | null {
    const x = round3(this.x)
    const y = round3(this.y)
    this.x = 0
    this.y = 0
    return x === 0 && y === 0 ? null : { x, y }
  }
}

/** A mouse message in remote pixels. Wheel fields are omitted unless non-zero. */
export function mouseMessage(point: { x: number; y: number }, buttons: number, wheel?: Partial<WheelNotches> | null): MouseMessage {
  const message: MouseMessage = { type: 'mouse', x: Math.round(point.x), y: Math.round(point.y), buttons: buttons & BUTTON_MASK }
  if (wheel?.x) message.wheel_x = round3(wheel.x)
  if (wheel?.y) message.wheel_y = round3(wheel.y)
  return message
}

/** The bit `MouseEvent.button` corresponds to in `MouseEvent.buttons` (they are numbered differently). */
export function buttonBit(button: number): number {
  switch (button) {
    case 0:
      return MOUSE_BUTTON.left
    case 1:
      return MOUSE_BUTTON.middle
    case 2:
      return MOUSE_BUTTON.right
    case 3:
      return MOUSE_BUTTON.back
    case 4:
      return MOUSE_BUTTON.forward
    default:
      return 0
  }
}

/** Codes for named keys, used when a virtual keyboard reports a `key` but no `code`. */
const KEY_TO_CODE: Record<string, string> = {
  Enter: 'Enter',
  Backspace: 'Backspace',
  Tab: 'Tab',
  Escape: 'Escape',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  Shift: 'ShiftLeft',
  Control: 'ControlLeft',
  Alt: 'AltLeft',
  Meta: 'MetaLeft',
  CapsLock: 'CapsLock',
  ContextMenu: 'ContextMenu',
  PrintScreen: 'PrintScreen',
}
for (let index = 1; index <= 12; index += 1) KEY_TO_CODE[`F${index}`] = `F${index}`

export function codeForKey(key: string): string {
  return KEY_TO_CODE[key] ?? ''
}

export interface KeyInput {
  code: string
  key: string
  location?: number
}

/**
 * A key message. `Unidentified` codes (IME, some virtual keyboards) are sent empty so the agent
 * types `key` as Unicode; named keys without a code get their standard code.
 */
export function keyMessage(input: KeyInput, down: boolean): KeyMessage {
  const key = input.key === 'Unidentified' ? '' : input.key
  let code = input.code === 'Unidentified' ? '' : input.code
  if (!code && key.length > 1) code = codeForKey(key)
  const location = input.location !== undefined && input.location >= 0 && input.location <= 3 ? input.location : 0
  return { type: 'key', code, key, down, location }
}

/**
 * Tracks keys held on the device so they can all be released when the viewer loses focus,
 * leaves full screen or switches to view-only (otherwise Ctrl or Alt would stay "stuck").
 */
export class KeyTracker {
  private held = new Map<string, KeyMessage>()

  /** Records a press; returns the message to send. Repeats (auto-repeat) are sent again. */
  down(input: KeyInput): KeyMessage {
    const message = keyMessage(input, true)
    const id = message.code || `key:${message.key}`
    this.held.set(id, message)
    return message
  }

  /** Records a release; returns the message to send, or null for a key that was never pressed here. */
  up(input: KeyInput): KeyMessage | null {
    const message = keyMessage(input, false)
    const id = message.code || `key:${message.key}`
    if (!this.held.has(id)) return null
    this.held.delete(id)
    return message
  }

  isHeld(code: string): boolean {
    return this.held.has(code)
  }

  get size(): number {
    return this.held.size
  }

  /** Releases for every held key, most recent first; clears the tracker. */
  releaseAll(): KeyMessage[] {
    const messages = [...this.held.values()].reverse().map((message) => ({ ...message, down: false }))
    this.held.clear()
    return messages
  }
}

export const KEY_SPECS = {
  ControlLeft: { code: 'ControlLeft', key: 'Control', location: 1 },
  AltLeft: { code: 'AltLeft', key: 'Alt', location: 1 },
  ShiftLeft: { code: 'ShiftLeft', key: 'Shift', location: 1 },
  MetaLeft: { code: 'MetaLeft', key: 'Meta', location: 1 },
  Tab: { code: 'Tab', key: 'Tab', location: 0 },
  Escape: { code: 'Escape', key: 'Escape', location: 0 },
  PrintScreen: { code: 'PrintScreen', key: 'PrintScreen', location: 0 },
  KeyV: { code: 'KeyV', key: 'v', location: 0 },
  KeyL: { code: 'KeyL', key: 'l', location: 0 },
  KeyR: { code: 'KeyR', key: 'r', location: 0 },
  KeyE: { code: 'KeyE', key: 'e', location: 0 },
  Delete: { code: 'Delete', key: 'Delete', location: 0 },
} as const satisfies Record<string, Required<KeyInput>>

export type SpecialKey = 'win' | 'alt-tab' | 'ctrl-esc' | 'print-screen' | 'win-r' | 'win-l' | 'win-e' | 'ctrl-shift-esc'

export interface SpecialKeyDefinition {
  label: string
  /** Shown as keycaps. */
  keys: string[]
  description: string
  combo: Required<KeyInput>[]
}

export const SPECIAL_KEYS: Record<SpecialKey, SpecialKeyDefinition> = {
  win: { label: 'Windows key', keys: ['Win'], description: 'Opens the Start menu', combo: [KEY_SPECS.MetaLeft] },
  'alt-tab': { label: 'Alt+Tab', keys: ['Alt', 'Tab'], description: 'Switches to the previous window', combo: [KEY_SPECS.AltLeft, KEY_SPECS.Tab] },
  'ctrl-esc': { label: 'Ctrl+Esc', keys: ['Ctrl', 'Esc'], description: 'Opens the Start menu', combo: [KEY_SPECS.ControlLeft, KEY_SPECS.Escape] },
  'print-screen': { label: 'Print Screen', keys: ['PrtScn'], description: 'Captures the screen on the device', combo: [KEY_SPECS.PrintScreen] },
  'win-r': { label: 'Run dialog', keys: ['Win', 'R'], description: 'Opens Run', combo: [KEY_SPECS.MetaLeft, KEY_SPECS.KeyR] },
  'win-e': { label: 'File Explorer', keys: ['Win', 'E'], description: 'Opens File Explorer', combo: [KEY_SPECS.MetaLeft, KEY_SPECS.KeyE] },
  'win-l': { label: 'Lock', keys: ['Win', 'L'], description: 'Locks the workstation', combo: [KEY_SPECS.MetaLeft, KEY_SPECS.KeyL] },
  'ctrl-shift-esc': {
    label: 'Task Manager',
    keys: ['Ctrl', 'Shift', 'Esc'],
    description: 'Opens Task Manager',
    combo: [KEY_SPECS.ControlLeft, KEY_SPECS.ShiftLeft, KEY_SPECS.Escape],
  },
}

/** Presses every key of a combination in order, then releases them in reverse order. */
export function comboMessages(combo: readonly KeyInput[]): KeyMessage[] {
  return [...combo.map((key) => keyMessage(key, true)), ...[...combo].reverse().map((key) => keyMessage(key, false))]
}

/** True for the browser shortcut that pastes (Ctrl+V, or ⌘V on macOS). */
export function isPasteShortcut(event: { code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  return event.code === 'KeyV' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey
}
