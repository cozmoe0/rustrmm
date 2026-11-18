/*
 * Escrowed secrets on the console side: labels, the reveal reason rule, display formatting (BitLocker
 * recovery keys in their familiar 8×6 digit groups, passwords in readable chunks), the reveal countdown
 * and best-effort clipboard clearing. Revealed values live in component state only and are dropped when
 * the countdown ends or the dialog closes.
 */
import type { EscrowItem, EscrowKind } from '@/lib/api/types'

export const KIND_LABEL: Record<EscrowKind, string> = {
  bitlocker: 'BitLocker recovery key',
  laps: 'Local admin password',
  filevault: 'FileVault recovery key',
  luks: 'LUKS key',
}

export const KIND_SHORT: Record<EscrowKind, string> = {
  bitlocker: 'BitLocker',
  laps: 'LAPS',
  filevault: 'FileVault',
  luks: 'LUKS',
}

export const KIND_ORDER: EscrowKind[] = ['bitlocker', 'laps', 'filevault', 'luks']

/** How long a revealed secret stays on screen, and how long a copied one stays on the clipboard. */
export const REVEAL_SECONDS = 60
export const CLIPBOARD_CLEAR_MS = 60_000

export const REVEAL_REASON_MIN = 10
export const REVEAL_REASON_MAX = 500

/** The server's rule: a typed reason of 10–500 characters (counted after trimming). */
export function validateRevealReason(reason: string): string | null {
  const length = [...reason.trim()].length
  if (length < REVEAL_REASON_MIN) return `Give a reason of at least ${REVEAL_REASON_MIN} characters (${length}/${REVEAL_REASON_MIN})`
  if (length > REVEAL_REASON_MAX) return `Keep the reason under ${REVEAL_REASON_MAX} characters`
  return null
}

const BITLOCKER_DIGITS = /^\d{48}$/

/** Whether a value is a 48-digit BitLocker numerical password (with or without dashes or spaces). */
export function isBitLockerKey(value: string): boolean {
  return BITLOCKER_DIGITS.test(value.replace(/[\s-]/g, ''))
}

/**
 * The canonical form to copy: BitLocker keys as `123456-…` (eight dash-separated groups, as Windows asks
 * for them), FileVault keys upper-cased; passwords exactly as stored.
 */
export function canonicalSecret(kind: EscrowKind, secret: string): string {
  if (kind === 'bitlocker' && isBitLockerKey(secret)) return chunk(secret.replace(/[\s-]/g, ''), 6).join('-')
  if (kind === 'filevault') return secret.trim().toUpperCase()
  return secret
}

function chunk(value: string, size: number): string[] {
  const out: string[] = []
  for (let index = 0; index < value.length; index += size) out.push(value.slice(index, index + size))
  return out
}

/** Display groups: 8×6 digits for BitLocker, the key's own dash groups for FileVault, 4-character chunks otherwise. */
export function secretGroups(kind: EscrowKind, secret: string): string[] {
  if (!secret) return []
  if (kind === 'bitlocker' && isBitLockerKey(secret)) return chunk(secret.replace(/[\s-]/g, ''), 6)
  if (kind === 'filevault' && secret.includes('-')) return canonicalSecret(kind, secret).split('-')
  return chunk(secret, 4)
}

export type CharClass = 'digit' | 'upper' | 'lower' | 'symbol'

/** Colour-coding passwords helps tell `l`, `1`, `I`, `O` and `0` apart when typing one into a console. */
export function charClass(char: string): CharClass {
  if (/\d/.test(char)) return 'digit'
  if (/[A-Z]/.test(char)) return 'upper'
  if (/[a-z]/.test(char)) return 'lower'
  return 'symbol'
}

/** Seconds left (never negative) and the share of the window that remains (1 → 0). */
export function countdown(expiresAt: number, now: number, total = REVEAL_SECONDS) {
  const remainingMs = Math.max(0, expiresAt - now)
  const seconds = Math.ceil(remainingMs / 1000)
  return { seconds, fraction: total > 0 ? Math.min(1, remainingMs / (total * 1000)) : 0, expired: remainingMs <= 0 }
}

// ------------------------------------------------------------------ clipboard

export interface ClipboardLike {
  writeText(text: string): Promise<void>
  readText?: () => Promise<string>
}

export type ClipboardClearOutcome = 'cleared' | 'changed' | 'unavailable'

/**
 * Clears the clipboard if it still holds `secret`. When the clipboard can't be read without a permission
 * prompt, it is overwritten anyway: for a secret, clearing something else the user copied is the safer error.
 */
export async function clearIfUnchanged(
  clipboard: ClipboardLike | null | undefined,
  secret: string,
  canRead: () => Promise<boolean> = canReadClipboard,
): Promise<ClipboardClearOutcome> {
  if (!clipboard) return 'unavailable'
  try {
    if (clipboard.readText && (await canRead())) {
      const current = await clipboard.readText()
      if (current !== secret) return 'changed'
    }
  } catch {
    // Reading failed; fall through and overwrite.
  }
  try {
    await clipboard.writeText('')
    return 'cleared'
  } catch {
    return 'unavailable'
  }
}

/** True only when reading the clipboard won't prompt (the permission is already granted). */
export async function canReadClipboard(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.permissions) return false
    const status = await navigator.permissions.query({ name: 'clipboard-read' as PermissionName })
    return status.state === 'granted'
  } catch {
    return false
  }
}

interface Timers {
  set: (callback: () => void, ms: number) => number
  clear: (id: number) => void
}

const browserTimers: Timers = {
  set: (callback, ms) => window.setTimeout(callback, ms),
  clear: (id) => window.clearTimeout(id),
}

/**
 * Schedules clearing the clipboard after `delayMs` (best effort: it only runs while this tab stays open).
 * The timer is independent of any component, so closing the reveal dialog doesn't cancel it.
 * Returns a function that cancels the pending clear.
 */
export function scheduleClipboardClear(
  secret: string,
  options: { delayMs?: number; clipboard?: ClipboardLike | null; timers?: Timers; onDone?: (outcome: ClipboardClearOutcome) => void } = {},
): () => void {
  const timers = options.timers ?? browserTimers
  const clipboard = options.clipboard !== undefined ? options.clipboard : typeof navigator !== 'undefined' ? navigator.clipboard : null
  const id = timers.set(() => {
    void clearIfUnchanged(clipboard, secret).then((outcome) => options.onDone?.(outcome))
  }, options.delayMs ?? CLIPBOARD_CLEAR_MS)
  return () => timers.clear(id)
}

let pendingClear: (() => void) | null = null

/**
 * Copies a revealed secret and schedules the clipboard to be cleared after 60 s. A newer copy replaces the
 * pending clear (the latest secret is the one that gets wiped).
 */
export async function copySecret(secret: string, onCleared?: (outcome: ClipboardClearOutcome) => void): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(secret)
  } catch {
    return false
  }
  pendingClear?.()
  pendingClear = scheduleClipboardClear(secret, {
    onDone: (outcome) => {
      pendingClear = null
      onCleared?.(outcome)
    },
  })
  return true
}

// ------------------------------------------------------------------ items

/** A short description of what an item unlocks: “C: recovery key”, “rmm-admin”, … */
export function itemSubject(item: Pick<EscrowItem, 'kind' | 'label' | 'identifier' | 'metadata'>): string {
  if (item.label) return item.label
  if (item.kind === 'laps') return item.metadata.account ?? item.identifier
  if (item.metadata.volume) return `${item.metadata.volume} ${item.kind === 'bitlocker' ? 'recovery key' : 'key'}`
  return item.identifier
}

/** The protector id shortened for tables: `{2F1C9A0B-…-7D}`. */
export function shortIdentifier(identifier: string): string {
  const braced = /^\{([0-9a-f]{8})-[0-9a-f-]+([0-9a-f]{4})\}$/i.exec(identifier)
  if (braced) return `{${braced[1]}…${braced[2]}}`
  return identifier.length > 28 ? `${identifier.slice(0, 14)}…${identifier.slice(-8)}` : identifier
}
