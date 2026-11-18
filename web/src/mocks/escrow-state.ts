/* Phase 10 mock state for secrets escrow: items (with their fake secrets), reveal history and LAPS state. */
import type { EscrowItem } from '@/lib/api/types'

export interface MockReveal {
  user_name: string
  reason: string
  at: string
}

export interface MockEscrowItem extends EscrowItem {
  client_id: string
  site_id: string | null
  /** The fake plaintext; the real server only holds an age ciphertext and decrypts it in memory. */
  secret: string
  reveals: MockReveal[]
}

export interface MockLapsState {
  device_id: string
  account: string
  last_rotated_at: string | null
  next_rotation_at: string | null
  last_error: string | null
  pending_cmd_id: string | null
  pending_since: string | null
}

export interface MockEscrow {
  items: MockEscrowItem[]
  laps: Record<string, MockLapsState>
}

export function emptyEscrow(): MockEscrow {
  return { items: [], laps: {} }
}

export function publicEscrowItem(item: MockEscrowItem): EscrowItem {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { secret, reveals, ...rest } = item
  return rest
}

/** A BitLocker numerical password: eight 6-digit blocks, each a multiple of 11 below 720 896 (as Windows generates them). */
export function bitlockerKey(next: () => number): string {
  return Array.from({ length: 8 }, () => String(Math.floor(next() * 65_536) * 11).padStart(6, '0')).join('-')
}

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const LOWER = 'abcdefghijkmnopqrstuvwxyz'
const DIGITS = '23456789'
const SYMBOLS = '!@#$%^&*-_=+?'

/** A LAPS password with every character class (the agent's `full` complexity). */
export function lapsPassword(next: () => number, length = 20, complexity: 'full' | 'alphanumeric' = 'full'): string {
  const pools = complexity === 'full' ? [UPPER, LOWER, DIGITS, SYMBOLS] : [UPPER, LOWER, DIGITS]
  const all = pools.join('')
  const chars = pools.map((pool) => pool[Math.floor(next() * pool.length)])
  while (chars.length < length) chars.push(all[Math.floor(next() * all.length)])
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(next() * (index + 1))
    ;[chars[index], chars[swap]] = [chars[swap], chars[index]]
  }
  return chars.join('')
}

/** A protector id such as `{2F1C9A0B-6D3E-4B7A-9C21-0E5D8F3A417D}`. */
export function protectorId(hex: (length: number) => string): string {
  const raw = hex(32).toUpperCase()
  return `{${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20, 32)}}`
}
