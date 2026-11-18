/*
 * Notification channel editor model: a draft per kind, write-only secret handling ("••••••" comes back
 * for stored secrets; leaving a key out keeps it), client-side validation that mirrors the server's SSRF
 * and format rules, and the request body.
 */
import type { NotificationChannel, NotificationChannelInput, NotificationChannelKind } from '@/lib/api/types'
import { SECRET_MASK } from '@/lib/automation/params'

export const MAX_RECIPIENTS = 20
export const NTFY_DEFAULT_SERVER = 'https://ntfy.sh'
export const TOPIC_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
export const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]{1,64}$/
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/

/** Headers the server sets itself; they cannot be configured on a webhook channel. */
export const FORBIDDEN_HEADERS = [
  'host',
  'content-length',
  'content-type',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'proxy-authorization',
  'proxy-connection',
  'x-rustrmm-signature',
]

/** Write-only fields per kind (header values are secret too). */
export const SECRET_FIELDS: Record<NotificationChannelKind, ('webhook_url' | 'token' | 'secret')[]> = {
  email: [],
  slack: ['webhook_url'],
  teams: ['webhook_url'],
  discord: ['webhook_url'],
  ntfy: ['token'],
  webhook: ['secret'],
}

export function isMasked(value: unknown): boolean {
  return value === SECRET_MASK
}

/** A write-only value: kept as stored, replaced with a new value, or (optional fields only) removed. */
export interface SecretDraft {
  stored: boolean
  mode: 'keep' | 'replace' | 'remove'
  value: string
}

export interface HeaderDraft {
  key: string
  name: string
  value: string
  /** The value is stored on the server and comes back masked. */
  stored: boolean
  replacing: boolean
}

export interface ChannelDraft {
  name: string
  kind: NotificationChannelKind
  enabled: boolean
  to: string[]
  cc: string[]
  webhook_url: SecretDraft
  server_url: string
  topic: string
  token: SecretDraft
  url: string
  secret: SecretDraft
  headers: HeaderDraft[]
  /** False until the header list is edited; untouched headers are left out of the request (kept). */
  headersTouched: boolean
}

const freshSecret = (): SecretDraft => ({ stored: false, mode: 'replace', value: '' })
const storedSecret = (value: unknown): SecretDraft =>
  isMasked(value) ? { stored: true, mode: 'keep', value: '' } : freshSecret()

let headerKey = 0
export function newHeader(name = '', value = ''): HeaderDraft {
  headerKey += 1
  return { key: `h${headerKey}`, name, value, stored: false, replacing: true }
}

export function emptyDraft(kind: NotificationChannelKind): ChannelDraft {
  return {
    name: '',
    kind,
    enabled: true,
    to: [],
    cc: [],
    webhook_url: freshSecret(),
    server_url: NTFY_DEFAULT_SERVER,
    topic: '',
    token: freshSecret(),
    url: '',
    secret: freshSecret(),
    headers: [],
    headersTouched: false,
  }
}

const asList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map(String).filter(Boolean)
    : typeof value === 'string'
      ? value
          .split(/[,;]/)
          .map((item) => item.trim())
          .filter(Boolean)
      : []

export function draftFromChannel(channel: NotificationChannel): ChannelDraft {
  const config = channel.config
  const headers = config.headers && typeof config.headers === 'object' && !Array.isArray(config.headers)
    ? Object.entries(config.headers as Record<string, unknown>).map(([name, value]) => ({
        ...newHeader(name, isMasked(value) ? '' : String(value ?? '')),
        stored: isMasked(value),
        replacing: !isMasked(value),
      }))
    : []
  return {
    ...emptyDraft(channel.kind),
    name: channel.name,
    enabled: channel.enabled,
    to: asList(config.to),
    cc: asList(config.cc),
    webhook_url: storedSecret(config.webhook_url),
    server_url: typeof config.server_url === 'string' && config.server_url ? config.server_url : NTFY_DEFAULT_SERVER,
    topic: typeof config.topic === 'string' ? config.topic : '',
    token: storedSecret(config.token),
    url: typeof config.url === 'string' ? config.url : '',
    secret: storedSecret(config.secret),
    headers,
  }
}

/** https only (plain http when the host is allowlisted), no credentials. Null when fine. */
export function urlError(raw: string, label: string, allowlist: readonly string[] = []): string | null {
  const value = raw.trim()
  if (!value) return `Enter the ${label}`
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return `Enter a full URL, starting with https://`
  }
  if (url.username || url.password) return 'URLs with credentials are refused'
  if (url.protocol === 'https:') return null
  if (url.protocol === 'http:') {
    return allowlist.includes(url.hostname.toLowerCase())
      ? null
      : 'Use https. Plain http works only for hosts in the webhook allowlist.'
  }
  return 'Only https URLs are allowed'
}

export function emailError(value: string): string | null {
  return EMAIL.test(value.trim()) ? null : `“${value}” is not an email address`
}

export type ChannelField = 'name' | 'to' | 'cc' | 'webhook_url' | 'server_url' | 'topic' | 'token' | 'url' | 'secret' | 'headers'
export type ChannelErrors = Partial<Record<ChannelField, string>>

/** Whether a secret draft will send a new value. */
const sending = (secret: SecretDraft) => !secret.stored || secret.mode === 'replace'

export function validateChannelDraft(draft: ChannelDraft, allowlist: readonly string[] = []): ChannelErrors {
  const errors: ChannelErrors = {}
  if (!draft.name.trim()) errors.name = 'Enter a name'
  else if (draft.name.trim().length > 80) errors.name = 'Use 80 characters or fewer'
  switch (draft.kind) {
    case 'email': {
      if (draft.to.length === 0) errors.to = 'Add at least one recipient'
      else if (draft.to.length > MAX_RECIPIENTS) errors.to = `At most ${MAX_RECIPIENTS} recipients`
      else {
        const bad = draft.to.map(emailError).find(Boolean)
        if (bad) errors.to = bad
      }
      if (draft.cc.length > MAX_RECIPIENTS) errors.cc = `At most ${MAX_RECIPIENTS} cc recipients`
      else {
        const bad = draft.cc.map(emailError).find(Boolean)
        if (bad) errors.cc = bad
      }
      break
    }
    case 'slack':
    case 'teams':
    case 'discord':
      if (sending(draft.webhook_url)) {
        const problem = urlError(draft.webhook_url.value, 'webhook URL', allowlist)
        if (problem) errors.webhook_url = problem
      }
      break
    case 'ntfy': {
      if (draft.server_url.trim()) {
        const problem = urlError(draft.server_url, 'server URL', allowlist)
        if (problem) errors.server_url = problem
      }
      if (!TOPIC_PATTERN.test(draft.topic.trim())) errors.topic = 'Use 1–64 letters, digits, dashes or underscores'
      if (draft.token.stored && draft.token.mode === 'replace' && !draft.token.value)
        errors.token = 'Enter the new token, or keep the stored one'
      break
    }
    case 'webhook': {
      const problem = urlError(draft.url, 'URL', allowlist)
      if (problem) errors.url = problem
      if (draft.secret.stored && draft.secret.mode === 'replace' && !draft.secret.value)
        errors.secret = 'Enter the new secret, or keep the stored one'
      const seen = new Set<string>()
      for (const header of draft.headers) {
        const name = header.name.trim()
        if (!HEADER_NAME_PATTERN.test(name)) {
          errors.headers = name ? `“${name}” is not a valid header name` : 'Every header needs a name'
          break
        }
        if (FORBIDDEN_HEADERS.includes(name.toLowerCase())) {
          errors.headers = `The ${name} header is set by RustRMM and cannot be configured`
          break
        }
        if (seen.has(name.toLowerCase())) {
          errors.headers = `${name} is listed twice`
          break
        }
        seen.add(name.toLowerCase())
        if ((!header.stored || header.replacing) && !header.value) {
          errors.headers = `Enter a value for ${name}`
          break
        }
      }
      break
    }
  }
  return errors
}

function secretValue(secret: SecretDraft): string | null | undefined {
  if (secret.stored && secret.mode === 'keep') return undefined
  if (secret.mode === 'remove') return null
  return secret.value ? secret.value : undefined
}

/** The request body; secret keys left out keep the stored value. */
export function channelInput(draft: ChannelDraft): NotificationChannelInput {
  const config: Record<string, unknown> = {}
  const put = (key: string, value: unknown) => {
    if (value !== undefined) config[key] = value
  }
  switch (draft.kind) {
    case 'email':
      config.to = draft.to
      if (draft.cc.length) config.cc = draft.cc
      break
    case 'slack':
    case 'teams':
    case 'discord':
      put('webhook_url', secretValue(draft.webhook_url))
      break
    case 'ntfy':
      config.server_url = draft.server_url.trim() || NTFY_DEFAULT_SERVER
      config.topic = draft.topic.trim()
      put('token', secretValue(draft.token))
      break
    case 'webhook':
      config.url = draft.url.trim()
      put('secret', secretValue(draft.secret))
      if (draft.headersTouched)
        config.headers = Object.fromEntries(
          draft.headers.map((header) => [
            header.name.trim(),
            header.stored && !header.replacing ? SECRET_MASK : header.value,
          ]),
        )
      break
  }
  return { name: draft.name.trim(), kind: draft.kind, enabled: draft.enabled, config }
}

/** A one-line description of where a channel delivers, without revealing secrets. */
export function channelTarget(channel: Pick<NotificationChannel, 'kind' | 'config'>): string {
  const config = channel.config
  switch (channel.kind) {
    case 'email': {
      const to = asList(config.to)
      const cc = asList(config.cc)
      if (!to.length) return 'No recipients'
      return `${to[0]}${to.length > 1 ? ` +${to.length - 1}` : ''}${cc.length ? ` · cc ${cc.length}` : ''}`
    }
    case 'slack':
    case 'teams':
    case 'discord':
      return isMasked(config.webhook_url) ? 'Webhook URL stored (write-only)' : 'No webhook URL'
    case 'ntfy': {
      const server = typeof config.server_url === 'string' ? config.server_url : NTFY_DEFAULT_SERVER
      let host = server
      try {
        host = new URL(server).host
      } catch {
        // keep the raw value
      }
      return `${host}/${String(config.topic ?? '')}${isMasked(config.token) ? ' · token' : ''}`
    }
    case 'webhook': {
      const raw = typeof config.url === 'string' ? config.url : ''
      let label = raw
      try {
        const url = new URL(raw)
        label = `${url.host}${url.pathname === '/' ? '' : url.pathname}`
      } catch {
        // keep the raw value
      }
      const headers = config.headers && typeof config.headers === 'object' ? Object.keys(config.headers).length : 0
      return `${label}${isMasked(config.secret) ? ' · signed' : ''}${headers ? ` · ${headers} ${headers === 1 ? 'header' : 'headers'}` : ''}`
    }
  }
}

/** Body for toggling `enabled` without touching secrets. */
export function toggleInput(channel: NotificationChannel, enabled: boolean): NotificationChannelInput {
  const draft = draftFromChannel(channel)
  return { ...channelInput({ ...draft, enabled }), kind: channel.kind }
}
