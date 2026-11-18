/*
 * IPv4 ranges for discovery scans: CIDR parsing, the /20 size limit, the "private" rule the server
 * applies (RFC 1918, CGNAT 100.64.0.0/10 and link-local 169.254.0.0/16 for every address; loopback is not
 * private) and list-level checks (count, duplicates, overlaps).
 */

/** The largest range a scan accepts: a /20 (4096 addresses). */
export const MIN_PREFIX = 20
export const MAX_RANGES = 16
export const MAX_TCP_PORTS = 64
export const MAX_SCAN_CREDENTIALS = 10

export function parseIPv4(value: string): number | null {
  const parts = value.trim().split('.')
  if (parts.length !== 4) return null
  let out = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255 || (part.length > 1 && part.startsWith('0'))) return null
    out = out * 256 + octet
  }
  return out
}

export function formatIPv4(value: number): string {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.')
}

export interface ParsedRange {
  /** First address (the network address). */
  start: number
  /** Last address (inclusive). */
  end: number
  prefix: number
  /** Number of addresses. */
  size: number
  /** `a.b.c.d/nn` with host bits cleared (a single address stays bare). */
  normalized: string
  /** The input had host bits set (`192.168.1.7/24`). */
  hostBits: boolean
}

/** Parses `a.b.c.d/nn` or a single address (a /32). Returns null for anything else. */
export function parseRange(value: string): ParsedRange | null {
  const trimmed = value.trim()
  const [address, prefixText, extra] = trimmed.split('/')
  if (extra !== undefined) return null
  const ip = parseIPv4(address ?? '')
  if (ip === null) return null
  let prefix = 32
  if (prefixText !== undefined) {
    if (!/^\d{1,2}$/.test(prefixText)) return null
    prefix = Number(prefixText)
    if (prefix > 32) return null
  }
  const size = 2 ** (32 - prefix)
  const start = Math.floor(ip / size) * size
  const end = start + size - 1
  return {
    start,
    end,
    prefix,
    size,
    normalized: prefixText === undefined ? formatIPv4(ip) : `${formatIPv4(start)}/${prefix}`,
    hostBits: start !== ip,
  }
}

const PRIVATE_BLOCKS = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16'].map((block) => parseRange(block)!)

/** Every address of the range is private (RFC 1918, CGNAT or link-local). */
export function isPrivateRange(range: Pick<ParsedRange, 'start' | 'end'>): boolean {
  return PRIVATE_BLOCKS.some((block) => range.start >= block.start && range.end <= block.end)
}

export function isPrivateAddress(ip: string): boolean {
  const value = parseIPv4(ip)
  return value !== null && isPrivateRange({ start: value, end: value })
}

export interface RangeCheck {
  range: ParsedRange | null
  /** Blocks saving. */
  error: string | null
  /** Saving is allowed, but the user should look again. */
  warning: string | null
}

/** Validates one range: syntax, the /20 limit, and the private-address rule (an error unless public ranges are allowed). */
export function checkRange(value: string, allowPublic = false): RangeCheck {
  if (!value.trim()) return { range: null, error: 'Enter a range', warning: null }
  const range = parseRange(value)
  if (!range) return { range: null, error: 'Use CIDR notation such as 192.168.1.0/24, or a single address', warning: null }
  if (range.prefix < MIN_PREFIX) {
    return { range, error: `/${range.prefix} is ${range.size.toLocaleString('en-US')} addresses; split it into /${MIN_PREFIX} ranges (4,096 each) or smaller`, warning: null }
  }
  const loopback = range.start >= 0x7f000000 && range.end <= 0x7fffffff
  if (!isPrivateRange(range)) {
    const what = loopback ? 'Loopback addresses are not scanned as private' : 'This is not a private range (RFC 1918, 100.64.0.0/10 or 169.254.0.0/16)'
    if (!allowPublic) return { range, error: `${what}. Public ranges are off in network settings.`, warning: null }
    return { range, error: null, warning: `${what}. Only scan networks you are allowed to.` }
  }
  if (range.hostBits) return { range, error: null, warning: `Host bits are set; the probe scans ${range.normalized}` }
  return { range, error: null, warning: null }
}

/** Issues across the list: count, duplicates and overlapping ranges. Index-keyed like the server's `ranges[<i>]`. */
export function checkRanges(values: string[], allowPublic = false): { checks: RangeCheck[]; listError: string | null; total: number } {
  const checks = values.map((value) => checkRange(value, allowPublic))
  let listError: string | null = null
  if (values.length === 0) listError = 'Add at least one range'
  else if (values.length > MAX_RANGES) listError = `At most ${MAX_RANGES} ranges per scan`
  checks.forEach((check, index) => {
    if (!check.range || check.error) return
    for (let other = 0; other < index; other += 1) {
      const previous = checks[other].range
      if (!previous) continue
      if (check.range.start <= previous.end && previous.start <= check.range.end) {
        check.error = previous.start === check.range.start && previous.end === check.range.end ? 'Listed twice' : `Overlaps ${previous.normalized}`
        break
      }
    }
  })
  const total = checks.reduce((sum, check) => sum + (check.range && !check.error ? check.range.size : 0), 0)
  return { checks, listError, total }
}

/** Parses a port list such as `22, 80, 443 9100` into sorted unique ports. */
export function parsePorts(text: string): { ports: number[]; error: string | null } {
  const tokens = text.split(/[\s,;]+/).filter(Boolean)
  const ports = new Set<number>()
  for (const token of tokens) {
    if (!/^\d+$/.test(token)) return { ports: [...ports].sort((a, b) => a - b), error: `“${token}” is not a port number` }
    const port = Number(token)
    if (port < 1 || port > 65_535) return { ports: [...ports].sort((a, b) => a - b), error: `${port} is outside 1–65535` }
    ports.add(port)
  }
  const sorted = [...ports].sort((a, b) => a - b)
  if (sorted.length > MAX_TCP_PORTS) return { ports: sorted, error: `At most ${MAX_TCP_PORTS} ports` }
  return { ports: sorted, error: null }
}

/** Sorts dotted IPv4 addresses numerically (unparseable ones last). */
export function compareIp(a: string, b: string): number {
  const left = parseIPv4(a)
  const right = parseIPv4(b)
  if (left === null && right === null) return a.localeCompare(b)
  if (left === null) return 1
  if (right === null) return -1
  return left - right
}

export function ipInRange(ip: string, range: string): boolean {
  const value = parseIPv4(ip)
  const parsed = parseRange(range)
  return value !== null && parsed !== null && value >= parsed.start && value <= parsed.end
}
