/*
 * API token rules the console checks before `POST /api-tokens`: the permission subset (only what the
 * creator holds), expiry (90 days by default, at most one year) and allowed source addresses.
 */
import type { Permission } from '@/lib/api/types'

const DAY = 86_400_000

export const TOKEN_DEFAULT_DAYS = 90
export const TOKEN_MAX_DAYS = 365
export const TOKEN_NAME_MAX = 80
export const MAX_CIDRS = 50

export const EXPIRY_PRESETS: { days: number; label: string }[] = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 180, label: '6 months' },
  { days: 365, label: '1 year' },
]

export function expiryFromDays(days: number, now = Date.now()): Date {
  return new Date(now + days * DAY)
}

/** The latest allowed expiry (one year from now). */
export function maxExpiry(now = Date.now()): Date {
  return new Date(now + TOKEN_MAX_DAYS * DAY)
}

/** A custom expiry must be in the future and at most a year away. */
export function expiryError(value: Date | null, now = Date.now()): string | null {
  if (!value || Number.isNaN(value.getTime())) return 'Choose an expiry date'
  if (value.getTime() <= now) return 'The expiry must be in the future'
  if (value.getTime() > maxExpiry(now).getTime() + 60_000) return 'Tokens expire within one year at most'
  return null
}

/** `YYYY-MM-DD` (local) to the end of that day, as the server compares instants. */
export function endOfLocalDay(date: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return null
  const value = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 0, 0)
  return Number.isNaN(value.getTime()) ? null : value
}

// ------------------------------------------------------------------ permissions

/** Catalog entries the creator holds, in catalog order: a token can never exceed its creator. */
export function grantablePermissions(catalog: readonly Permission[], held: readonly string[]): Permission[] {
  const mine = new Set(held)
  return catalog.filter((permission) => mine.has(permission.key))
}

/** Keeps only held permissions, de-duplicated, in catalog order (unknown keys last). */
export function permissionSubset(selected: readonly string[], held: readonly string[], catalog: readonly Permission[] = []): string[] {
  const mine = new Set(held)
  const wanted = new Set(selected.filter((key) => mine.has(key)))
  const ordered = catalog.map((permission) => permission.key).filter((key) => wanted.has(key))
  const rest = [...wanted].filter((key) => !ordered.includes(key)).sort()
  return [...ordered, ...rest]
}

/** Why a selection cannot be submitted, or null. */
export function permissionsError(selected: readonly string[], held: readonly string[]): string | null {
  if (selected.length === 0) return 'Choose at least one permission'
  const mine = new Set(held)
  const extra = selected.filter((key) => !mine.has(key))
  if (extra.length) return `You don’t hold ${extra.join(', ')}`
  return null
}

/** Read-only presets: every held `*.view` permission. */
export function readOnlyPreset(held: readonly string[]): string[] {
  return held.filter((key) => key.endsWith('.view'))
}

// ------------------------------------------------------------------ addresses

function parseIPv4(value: string): number[] | null {
  const parts = value.split('.')
  if (parts.length !== 4) return null
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN))
  if (octets.some((octet) => !Number.isInteger(octet) || octet > 255)) return null
  if (parts.some((part) => part.length > 1 && part.startsWith('0'))) return null
  return octets
}

function parseIPv6(value: string): boolean {
  if (!/^[0-9a-f:.]+$/i.test(value) || value.includes(':::')) return false
  const halves = value.split('::')
  if (halves.length > 2) return false
  const groups = (half: string) => (half === '' ? [] : half.split(':'))
  const head = groups(halves[0])
  const tail = halves.length === 2 ? groups(halves[1]) : []
  const all = [...head, ...tail]
  let count = 0
  for (let index = 0; index < all.length; index += 1) {
    const group = all[index]
    if (group.includes('.')) {
      // An embedded IPv4 address may only end the address.
      if (index !== all.length - 1 || !parseIPv4(group)) return false
      count += 2
    } else if (/^[0-9a-f]{1,4}$/i.test(group)) count += 1
    else return false
  }
  return halves.length === 2 ? count < 8 : count === 8
}

export type AddressFamily = 'ipv4' | 'ipv6'

export interface CidrCheck {
  value: string
  family: AddressFamily | null
  error: string | null
}

/** An IP address or CIDR block (IPv4 /0–32, IPv6 /0–128). */
export function checkCidr(raw: string): CidrCheck {
  const value = raw.trim()
  if (!value) return { value, family: null, error: 'Enter an address' }
  const [address, prefix, extra] = value.split('/')
  if (extra !== undefined) return { value, family: null, error: 'Use one “/” at most' }
  const family: AddressFamily | null = parseIPv4(address) ? 'ipv4' : parseIPv6(address) ? 'ipv6' : null
  if (!family) return { value, family: null, error: `“${address}” is not an IP address` }
  if (prefix !== undefined) {
    const max = family === 'ipv4' ? 32 : 128
    if (!/^\d{1,3}$/.test(prefix) || Number(prefix) > max) return { value, family, error: `The prefix must be 0–${max}` }
  }
  return { value, family, error: null }
}

export function cidrError(raw: string): string | null {
  return checkCidr(raw).error
}

/** A list error (too many, duplicates), or null. Empty means "any address". */
export function cidrListError(values: readonly string[]): string | null {
  if (values.length > MAX_CIDRS) return `At most ${MAX_CIDRS} addresses`
  const invalid = values.find((value) => cidrError(value))
  if (invalid) return cidrError(invalid)
  const seen = new Set<string>()
  for (const value of values) {
    const key = value.trim().toLowerCase()
    if (seen.has(key)) return `${value} is listed twice`
    seen.add(key)
  }
  return null
}

/** "rrmm_pat_Ab3d…" → shown as-is; a stray full token is never rendered beyond its prefix. */
export function displayPrefix(prefix: string): string {
  return prefix.length > 16 ? `${prefix.slice(0, 16)}…` : prefix
}
