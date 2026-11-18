/* Pure helpers for the Phase 4 remote tools: access gating, OS paths, shells, event levels, validation. */
import type { Device, OsFamily } from './api/types'
import { isApiError } from './api/errors'

// ------------------------------------------------------------------ access

export type RemoteBlock = 'permission' | 'pending' | 'revoked' | 'inactive' | 'offline' | 'unsupported'

export interface RemoteAccess {
  ok: boolean
  block: RemoteBlock | null
  /** Short, user-facing explanation for tooltips and empty states. */
  reason: string
}

/**
 * Whether a remote tool can be used on a device. Every remote call travels to the agent, so the
 * device must be active and online; permission problems are reported first because they persist.
 */
export function remoteAccess(
  device: Pick<Device, 'status' | 'online'>,
  permitted: boolean,
  options: { permissionLabel?: string; requiresOnline?: boolean } = {},
): RemoteAccess {
  const { permissionLabel = 'remote tools', requiresOnline = true } = options
  if (!permitted) {
    return { ok: false, block: 'permission', reason: `Your role doesn’t include the ${permissionLabel} permission.` }
  }
  if (!requiresOnline) return { ok: true, block: null, reason: '' }
  if (device.status === 'pending') {
    return { ok: false, block: 'pending', reason: 'Approve this device before using remote tools.' }
  }
  if (device.status === 'revoked') {
    return { ok: false, block: 'revoked', reason: 'This agent is revoked, so it can’t receive commands.' }
  }
  if (device.status !== 'active') {
    return { ok: false, block: 'inactive', reason: 'Remote tools need an active device.' }
  }
  if (!device.online) {
    return { ok: false, block: 'offline', reason: 'The device is offline. Remote tools need a live agent connection.' }
  }
  return { ok: true, block: null, reason: '' }
}

/** Codes the server uses when the agent is unreachable; the cockpit refetches the device on these. */
export function isDeviceGoneError(error: unknown): boolean {
  return isApiError(error) && (error.code === 'device_offline' || error.code === 'device_inactive')
}

// ------------------------------------------------------------------ paths

export type PathStyle = 'windows' | 'posix'

export function pathStyle(os: OsFamily): PathStyle {
  return os === 'windows' ? 'windows' : 'posix'
}

export function separatorFor(style: PathStyle): string {
  return style === 'windows' ? '\\' : '/'
}

const DRIVE_ROOT = /^[a-zA-Z]:\\$/

/** Tidies user input: trims, unifies separators, collapses repeats and drops a trailing separator. */
export function normalizePath(style: PathStyle, input: string): string {
  let value = input.trim()
  if (value === '') return ''
  if (style === 'windows') {
    value = value.replace(/\//g, '\\')
    const unc = value.startsWith('\\\\')
    value = value.replace(/\\{2,}/g, '\\')
    if (unc) value = `\\${value}`
    if (/^[a-zA-Z]:$/.test(value)) value = `${value}\\`
    if (/^[a-zA-Z]:/.test(value)) value = value[0].toUpperCase() + value.slice(1)
    if (value.length > 3 && value.endsWith('\\') && !DRIVE_ROOT.test(value)) value = value.replace(/\\+$/, '')
    return value
  }
  value = value.replace(/\/{2,}/g, '/')
  if (value.length > 1) value = value.replace(/\/+$/, '')
  return value
}

export function isAbsolutePath(style: PathStyle, path: string): boolean {
  if (style === 'windows') return /^[a-zA-Z]:\\/.test(path) || path.startsWith('\\\\')
  return path.startsWith('/')
}

export function isRootPath(style: PathStyle, path: string): boolean {
  if (style === 'windows') return DRIVE_ROOT.test(path) || /^\\\\[^\\]+\\[^\\]+\\?$/.test(path)
  return path === '/'
}

export function joinPath(style: PathStyle, dir: string, name: string): string {
  const sep = separatorFor(style)
  if (!dir) return name
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`
}

/**
 * The folder above `path`. On Windows a drive root's parent is `''` (the drive list); on Unix the
 * root has no parent.
 */
export function parentPath(style: PathStyle, path: string): string | null {
  if (!path) return null
  if (style === 'windows') {
    if (isRootPath(style, path)) return ''
    const trimmed = path.replace(/\\+$/, '')
    const index = trimmed.lastIndexOf('\\')
    if (index < 0) return ''
    const head = trimmed.slice(0, index)
    if (/^[a-zA-Z]:$/.test(head)) return `${head}\\`
    if (/^\\\\[^\\]+\\[^\\]+$/.test(head)) return head
    return head || ''
  }
  if (path === '/') return null
  const trimmed = path.replace(/\/+$/, '')
  const index = trimmed.lastIndexOf('/')
  return index <= 0 ? '/' : trimmed.slice(0, index)
}

export function baseName(style: PathStyle, path: string): string {
  const sep = separatorFor(style)
  if (isRootPath(style, path)) return style === 'windows' ? path.replace(/\\$/, '') : '/'
  const trimmed = path.endsWith(sep) ? path.slice(0, -1) : path
  return trimmed.slice(trimmed.lastIndexOf(sep) + 1)
}

export interface PathSegment {
  label: string
  path: string
}

/** Breadcrumb segments, root first. */
export function pathSegments(style: PathStyle, path: string): PathSegment[] {
  if (!path) return []
  if (style === 'windows') {
    const unc = /^(\\\\[^\\]+\\[^\\]+)(.*)$/.exec(path)
    const drive = /^([a-zA-Z]:)(.*)$/.exec(path)
    const match = unc ?? drive
    if (!match) return [{ label: path, path }]
    const rootLabel = match[1]
    let current = unc ? rootLabel : `${rootLabel}\\`
    const segments: PathSegment[] = [{ label: rootLabel, path: current }]
    for (const part of match[2].split('\\').filter(Boolean)) {
      current = joinPath(style, current, part)
      segments.push({ label: part, path: current })
    }
    return segments
  }
  const segments: PathSegment[] = [{ label: '/', path: '/' }]
  let current = '/'
  for (const part of path.split('/').filter(Boolean)) {
    current = joinPath(style, current, part)
    segments.push({ label: part, path: current })
  }
  return segments
}

function hasControlCharacters(value: string) {
  for (let index = 0; index < value.length; index += 1) if (value.charCodeAt(index) < 32) return true
  return false
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** Validates a single file or folder name; returns an error message or null. */
export function validateFileName(style: PathStyle, name: string): string | null {
  const value = name.trim()
  if (!value) return 'Enter a name.'
  if (value === '.' || value === '..') return 'That name is reserved.'
  if (value.length > 255) return 'Names can be at most 255 characters.'
  if (style === 'windows') {
    if (/[<>:"/\\|?*]/.test(value) || hasControlCharacters(value)) return 'Names can’t contain < > : " / \\ | ? *'
    if (/[. ]$/.test(name)) return 'Names can’t end with a dot or a space.'
    if (WINDOWS_RESERVED.test(value)) return 'That name is reserved by Windows.'
    return null
  }
  if (value.includes('/') || value.includes('\0')) return 'Names can’t contain “/”.'
  return null
}

// ------------------------------------------------------------------ registry paths

/** Registry paths use backslashes and start at a hive (`HKLM`); `''` lists the hives. */
export function registrySegments(path: string): PathSegment[] {
  const parts = path.split('\\').filter(Boolean)
  return parts.map((label, index) => ({ label, path: parts.slice(0, index + 1).join('\\') }))
}

export function registryParent(path: string): string | null {
  if (!path) return null
  const parts = path.split('\\').filter(Boolean)
  return parts.slice(0, -1).join('\\')
}

const HIVE_ALIASES: Record<string, string> = {
  HKEY_LOCAL_MACHINE: 'HKLM',
  HKEY_USERS: 'HKU',
  HKEY_CLASSES_ROOT: 'HKCR',
  HKEY_CURRENT_CONFIG: 'HKCC',
  HKEY_CURRENT_USER: 'HKCU',
}

export function normalizeRegistryPath(input: string): string {
  const parts = input
    .trim()
    .replace(/\//g, '\\')
    .replace(/^Computer\\/i, '')
    .split('\\')
    .filter(Boolean)
  if (parts.length === 0) return ''
  const hive = parts[0].toUpperCase()
  parts[0] = HIVE_ALIASES[hive] ?? hive
  return parts.join('\\')
}

export interface RegistryDisplay {
  /** One-line rendering for the values table. */
  summary: string
  /** Full rendering for the detail panel (multi-line for MULTI_SZ and binary). */
  full: string
}

/** Renders registry data the way regedit does: DWORDs as hex plus decimal, binary as byte pairs. */
export function formatRegistryValue(type: string, data: string): RegistryDisplay {
  const upper = type.toUpperCase()
  if (upper === 'REG_DWORD' || upper === 'REG_QWORD') {
    const width = upper === 'REG_DWORD' ? 8 : 16
    const trimmed = data.trim()
    let value: bigint | null = null
    if (/^\d+$/.test(trimmed)) value = BigInt(trimmed)
    else if (/^0x[0-9a-f]+$/i.test(trimmed)) value = BigInt(trimmed)
    if (value === null) return { summary: data, full: data }
    const text = `0x${value.toString(16).padStart(width, '0')} (${value.toString()})`
    return { summary: text, full: text }
  }
  if (upper === 'REG_MULTI_SZ') {
    const lines = data.replaceAll('\0', '\n').split(/\r?\n/).filter((line) => line !== '')
    return { summary: lines.join(' · ') || '(empty)', full: lines.join('\n') }
  }
  if (upper === 'REG_BINARY' || upper === 'REG_NONE' || upper.startsWith('REG_RESOURCE') || upper === 'REG_FULL_RESOURCE_DESCRIPTOR') {
    const bytes = (data.replace(/[^0-9a-f]/gi, '').match(/.{1,2}/g) ?? []).map((pair) => pair.toLowerCase())
    if (bytes.length === 0) return { summary: '(zero-length binary value)', full: '' }
    const summary = bytes.slice(0, 24).join(' ') + (bytes.length > 24 ? ' …' : '')
    const rows: string[] = []
    for (let index = 0; index < bytes.length; index += 16) {
      rows.push(`${index.toString(16).padStart(4, '0')}  ${bytes.slice(index, index + 16).join(' ')}`)
    }
    return { summary, full: rows.join('\n') }
  }
  return { summary: data === '' ? '(value not set)' : data, full: data }
}

// ------------------------------------------------------------------ shells

export interface ShellOption {
  value: string
  label: string
  description: string
}

const WINDOWS_SHELLS: ShellOption[] = [
  { value: 'powershell', label: 'Windows PowerShell', description: 'PowerShell 5.1 · default' },
  { value: 'pwsh', label: 'PowerShell 7', description: 'pwsh, when installed' },
  { value: 'cmd', label: 'Command Prompt', description: 'cmd.exe' },
]

const UNIX_SHELLS: Record<'linux' | 'macos', ShellOption[]> = {
  linux: [
    { value: 'bash', label: 'bash', description: 'Bourne Again shell · default' },
    { value: 'zsh', label: 'zsh', description: 'Z shell, when installed' },
    { value: 'sh', label: 'sh', description: 'POSIX shell' },
  ],
  macos: [
    { value: 'zsh', label: 'zsh', description: 'Z shell · macOS default' },
    { value: 'bash', label: 'bash', description: 'Bourne Again shell' },
    { value: 'sh', label: 'sh', description: 'POSIX shell' },
  ],
}

export function shellOptions(os: OsFamily): ShellOption[] {
  return os === 'windows' ? WINDOWS_SHELLS : UNIX_SHELLS[os]
}

export function shellLabel(shell: string | null | undefined): string {
  if (!shell) return 'Default shell'
  const option = [...WINDOWS_SHELLS, ...UNIX_SHELLS.linux].find((item) => item.value === shell)
  return option?.label ?? shell
}

// ------------------------------------------------------------------ event logs

export type EventTone = 'critical' | 'error' | 'warning' | 'info' | 'verbose'

export interface EventLevelInfo {
  label: string
  tone: EventTone
}

/** Maps an event level (Windows semantics; the agent maps journal priorities onto them). */
export function eventLevel(level: number): EventLevelInfo {
  switch (level) {
    case 1:
      return { label: 'Critical', tone: 'critical' }
    case 2:
      return { label: 'Error', tone: 'error' }
    case 3:
      return { label: 'Warning', tone: 'warning' }
    case 5:
      return { label: 'Verbose', tone: 'verbose' }
    default:
      // 0 (LogAlways, used by the Security log) and 4 read as information.
      return { label: 'Information', tone: 'info' }
  }
}

/** Options for the `level` filter, which means "this level and more severe". */
export const EVENT_LEVEL_FILTERS = [
  { value: 0, label: 'All levels' },
  { value: 1, label: 'Critical' },
  { value: 2, label: 'Error and above' },
  { value: 3, label: 'Warning and above' },
  { value: 4, label: 'Information and above' },
] as const

export const WINDOWS_EVENT_LOGS = ['System', 'Application', 'Security', 'Setup'] as const

export const EVENT_WINDOWS = [
  { value: 1, label: '1h' },
  { value: 24, label: '24h' },
  { value: 168, label: '7d' },
] as const

// ------------------------------------------------------------------ diagnostics

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const HOSTNAME = /^(?=.{1,253}\.?$)[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*\.?$/i

export function isIpLiteral(value: string): boolean {
  if (IPV4.test(value)) return true
  if (!value.includes(':')) return false
  // IPv6: hex groups with colons, optionally an embedded IPv4 tail and a zone id ("%eth0").
  const [address, zone] = value.split('%')
  if (zone !== undefined && !/^[\w.-]+$/.test(zone)) return false
  if ((address.match(/::/g)?.length ?? 0) > 1) return false
  const tail = address.slice(address.lastIndexOf(':') + 1)
  const hex = IPV4.test(tail) ? address.slice(0, address.length - tail.length) : address
  if (!/^[0-9a-f:]+$/i.test(hex)) return false
  const groups = hex.split(':')
  return groups.length <= 9 && groups.every((group) => group.length <= 4)
}

/** Mirrors the server: a host name or IP literal, no spaces and no leading "-". */
export function validateTarget(input: string): string | null {
  const value = input.trim()
  if (!value) return 'Enter a host name or IP address.'
  if (/\s/.test(value)) return 'Targets can’t contain spaces.'
  if (value.startsWith('-')) return 'Targets can’t start with “-”.'
  if (isIpLiteral(value) || HOSTNAME.test(value)) return null
  return 'Enter a valid host name or IP address.'
}

export function validatePort(input: string): string | null {
  const value = input.trim()
  if (!value) return 'Enter a port.'
  if (!/^\d+$/.test(value)) return 'Ports are whole numbers.'
  const port = Number(value)
  if (port < 1 || port > 65535) return 'Use a port between 1 and 65535.'
  return null
}

// ------------------------------------------------------------------ power

export const POWER_DELAYS = [
  { value: 0, label: 'Now' },
  { value: 60, label: 'In 1 minute' },
  { value: 300, label: 'In 5 minutes' },
  { value: 900, label: 'In 15 minutes' },
  { value: 1800, label: 'In 30 minutes' },
  { value: 3600, label: 'In 1 hour' },
] as const

/** macOS agents support only reboot, shutdown and cancel. */
export function supportsSessionPower(os: OsFamily): boolean {
  return os !== 'macos'
}
