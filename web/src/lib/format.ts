const numberFormat = new Intl.NumberFormat()
const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

export function formatNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : numberFormat.format(value)
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

export function formatDateTime(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return dateTimeFormat.format(new Date(value))
}

export function formatDate(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return dateFormat.format(new Date(value))
}

export function formatTime(value: string | number | Date): string {
  return timeFormat.format(new Date(value))
}

const DIVISIONS: [number, Intl.RelativeTimeFormatUnit][] = [
  [60, 'second'],
  [60, 'minute'],
  [24, 'hour'],
  [7, 'day'],
  [4.34524, 'week'],
  [12, 'month'],
  [Number.POSITIVE_INFINITY, 'year'],
]

export function formatRelative(value: string | number | Date | null | undefined, now = Date.now()): string {
  if (value === null || value === undefined) return 'Never'
  let duration = (new Date(value).getTime() - now) / 1000
  if (Math.abs(duration) < 30) return 'just now'
  for (const [amount, unit] of DIVISIONS) {
    if (Math.abs(duration) < amount) return relativeFormat.format(Math.round(duration), unit)
    duration /= amount
  }
  return dateFormat.format(new Date(value))
}

export function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

/** A stopwatch-style clock: "0:07", "12:03", "1:02:03". Negative and non-finite values read as 0. */
export function formatClock(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const ss = String(secs).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${minutes}:${ss}`
}

/** A compact span with seconds precision: "38s", "4m 12s", "1h 3m", "2d 4h". */
export function formatSpan(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—'
  const total = Math.max(0, Math.round(seconds))
  if (total < 60) return `${total}s`
  if (total < 3600) {
    const secs = total % 60
    return secs ? `${Math.floor(total / 60)}m ${secs}s` : `${Math.floor(total / 60)}m`
  }
  return formatDuration(total)
}

/** Transfer speed: "512 B/s", "1.4 MB/s". */
export function formatRate(bytesPerSecond: number | null | undefined): string {
  if (bytesPerSecond === null || bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond)) return '—'
  return `${formatBytes(Math.max(0, Math.round(bytesPerSecond)))}/s`
}

/** Shortens long identifiers (hashes, keys) while keeping both ends recognisable. */
export function truncateMiddle(value: string, keep = 8): string {
  if (value.length <= keep * 2 + 1) return value
  return `${value.slice(0, keep)}…${value.slice(-keep)}`
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

/** Splits a user agent into a short "Browser on OS" label. */
export function describeUserAgent(agent: string | null): string {
  if (!agent) return 'Unknown device'
  const browser = /Edg\//.test(agent)
    ? 'Edge'
    : /Firefox\//.test(agent)
      ? 'Firefox'
      : /Chrome\//.test(agent)
        ? 'Chrome'
        : /Safari\//.test(agent)
          ? 'Safari'
          : 'Browser'
  const os = /Windows/.test(agent)
    ? 'Windows'
    : /iPhone|iPad/.test(agent)
      ? 'iOS'
      : /Mac OS X/.test(agent)
        ? 'macOS'
        : /Android/.test(agent)
          ? 'Android'
          : /Linux/.test(agent)
            ? 'Linux'
            : 'Unknown OS'
  return `${browser} on ${os}`
}
