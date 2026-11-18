/* Validation and display helpers for deploy keys (enrollment tokens). */
import type { EnrollmentToken } from './api/types'

const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i

/** DNS domain such as `corp.example.com` or `clinic.local` (no wildcards, no trailing dot). */
export function isValidDomain(value: string): boolean {
  const domain = value.trim()
  if (domain.length === 0 || domain.length > 253) return false
  const labels = domain.split('.')
  if (labels.length < 2) return false
  return labels.every((label) => DOMAIN_LABEL.test(label)) && !/^\d+$/.test(labels[labels.length - 1])
}

function isIpv4(value: string): boolean {
  const parts = value.split('.')
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255 && String(Number(part)) === part)
}

function isIpv6(value: string): boolean {
  if (!/^[0-9a-f:]+$/i.test(value) || !value.includes(':')) return false
  const doubleColons = value.split('::').length - 1
  if (doubleColons > 1) return false
  const groups = value.split(':').filter((group) => group.length > 0)
  if (groups.some((group) => group.length > 4)) return false
  return doubleColons === 1 ? groups.length < 8 : groups.length === 8
}

/** IPv4 or IPv6 network in CIDR notation, e.g. `10.40.0.0/16` or `2001:db8::/32`. */
export function isValidCidr(value: string): boolean {
  const [address, prefix, ...rest] = value.trim().split('/')
  if (rest.length > 0 || prefix === undefined || !/^\d{1,3}$/.test(prefix)) return false
  const bits = Number(prefix)
  if (isIpv4(address)) return bits <= 32
  if (isIpv6(address)) return bits <= 128
  return false
}

export function domainError(value: string): string | null {
  return isValidDomain(value) ? null : `“${value}” isn't a valid domain (e.g. corp.example.com)`
}

export function cidrError(value: string): string | null {
  return isValidCidr(value) ? null : `“${value}” isn't a valid network — use CIDR like 10.0.0.0/8`
}

export type TokenUsage = { label: string; pct: number | null }

/** "11 / 40" style usage with a fill percentage (null when unlimited). */
export function tokenUsage(token: Pick<EnrollmentToken, 'uses' | 'max_uses'>): TokenUsage {
  if (token.max_uses === null) return { label: `${token.uses} · unlimited`, pct: null }
  const pct = Math.min(100, (token.uses / Math.max(1, token.max_uses)) * 100)
  return { label: `${token.uses} / ${token.max_uses}`, pct: Math.round(pct * 10) / 10 }
}

/** Days until expiry (negative when expired), or null for keys that never expire. */
export function daysUntil(iso: string | null, now = Date.now()): number | null {
  if (!iso) return null
  return Math.ceil((new Date(iso).getTime() - now) / 86_400_000)
}

/** Masks the secret part of a deploy key for display: keeps the scheme and the last 6 characters. */
export function maskDeployKey(key: string): string {
  const [scheme] = key.split('_', 1)
  if (key.length <= 16) return '•'.repeat(key.length)
  return `${scheme}_${'•'.repeat(18)}${key.slice(-6)}`
}
