/* Webhook allowlist entries (monitoring settings): host names, IP addresses or CIDR ranges. */

const HOST = /^(?=.{1,253}$)([a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?)(\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?)*$/
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/
const IPV6 = /^[0-9a-f:.]+$/

/** Trimmed and lower-cased, as the server stores entries. */
export function normalizeAllowlistEntry(entry: string): string {
  return entry.trim().toLowerCase()
}

export type AllowlistKind = 'host' | 'ip' | 'cidr'

/** The kind of a (normalised) entry, or null when it is not a host name, IP address or CIDR range. */
export function allowlistKind(entry: string): AllowlistKind | null {
  const value = normalizeAllowlistEntry(entry)
  if (!value) return null
  const parts = value.split('/')
  if (parts.length > 2) return null
  const [address, prefix] = parts
  const v4 = IPV4.test(address)
  const v6 = !v4 && address.includes(':') && IPV6.test(address)
  if (prefix !== undefined) {
    if (!/^\d{1,3}$/.test(prefix)) return null
    const bits = Number(prefix)
    if (v4) return bits <= 32 ? 'cidr' : null
    if (v6) return bits <= 128 ? 'cidr' : null
    return null
  }
  if (v4 || v6) return 'ip'
  return HOST.test(address) && !/^\d+(\.\d+)*$/.test(address) ? 'host' : null
}

/** Normalises and de-duplicates a list, returning the entries that are not valid. */
export function normalizeAllowlist(entries: readonly string[]): { entries: string[]; invalid: string[] } {
  const normalized = [...new Set(entries.map(normalizeAllowlistEntry).filter(Boolean))]
  return { entries: normalized, invalid: normalized.filter((entry) => allowlistKind(entry) === null) }
}
