/*
 * Outbound webhooks: event labels, the checks the server applies to a webhook, and receiver code
 * that verifies `X-RustRMM-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>">`.
 */
import type { WebhookEvent } from '@/lib/api/types'

export const WEBHOOK_EVENTS: { event: WebhookEvent; label: string; group: string; description: string }[] = [
  { event: 'device.enrolled', label: 'Device enrolled', group: 'Devices', description: 'A device joined (or is waiting for approval).' },
  { event: 'device.offline', label: 'Device offline', group: 'Devices', description: 'A device stayed offline past its offline threshold (sent once per offline period; reconnect flaps send nothing).' },
  { event: 'alert.opened', label: 'Alert opened', group: 'Alerts', description: 'A monitoring alert opened.' },
  { event: 'alert.resolved', label: 'Alert resolved', group: 'Alerts', description: 'An alert was resolved.' },
  { event: 'job.completed', label: 'Job completed', group: 'Automation', description: 'A script job run finished.' },
  { event: 'patch_run.completed', label: 'Patch run completed', group: 'Automation', description: 'A patch window run finished (one per client).' },
  { event: 'ticket.created', label: 'Ticket created', group: 'Helpdesk', description: 'A ticket was opened.' },
  { event: 'ticket.updated', label: 'Ticket updated', group: 'Helpdesk', description: 'A ticket changed (status, assignee, …).' },
  { event: 'secret.revealed', label: 'Secret revealed', group: 'Security', description: 'Someone revealed an escrowed key or password.' },
]

export function eventLabel(event: string): string {
  if (event === 'webhook.test') return 'Test delivery'
  return WEBHOOK_EVENTS.find((item) => item.event === event)?.label ?? event
}

export const SECRET_MIN = 16
export const SECRET_MAX = 256

/** `url` must be http(s) without credentials. */
export function webhookUrlError(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return 'Enter the receiver URL'
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return 'Enter a full URL, such as https://hooks.example.com/rustrmm'
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'Use an http:// or https:// URL'
  if (url.username || url.password) return 'Remove the user name and password from the URL'
  if (!url.hostname) return 'The URL needs a host'
  return null
}

export function webhookSecretError(value: string): string | null {
  if (value.length < SECRET_MIN) return `Use at least ${SECRET_MIN} characters`
  if (value.length > SECRET_MAX) return `At most ${SECRET_MAX} characters`
  return null
}

/** Whether a URL is plain http (allowed, but the payload travels unencrypted). */
export function isInsecureUrl(value: string): boolean {
  try {
    return new URL(value.trim()).protocol === 'http:'
  } catch {
    return false
  }
}

/** A random secret (base64url, 32 bytes) for the "Generate" button. */
export function generateSecret(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Splits `t=…,v1=…` into its parts. */
export function parseSignatureHeader(header: string): { t: number | null; v1: string[] } {
  let t: number | null = null
  const v1: string[] = []
  for (const part of header.split(',')) {
    const [key, value] = part.trim().split('=', 2)
    if (key === 't' && /^\d+$/.test(value ?? '')) t = Number(value)
    if (key === 'v1' && value) v1.push(value)
  }
  return { t, v1 }
}

export const VERIFY_SNIPPETS: { id: string; label: string; language: string; code: string }[] = [
  {
    id: 'node',
    label: 'Node.js',
    language: 'javascript',
    code: `import crypto from 'node:crypto'

// rawBody: the request body exactly as received (a Buffer), before JSON parsing.
export function verifyRustRmm(rawBody, header, secret, toleranceSeconds = 300) {
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.trim().split('=', 2)))
  const t = Number(parts.t)
  if (!Number.isInteger(t) || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false
  const expected = crypto.createHmac('sha256', secret).update(\`\${t}.\`).update(rawBody).digest()
  const given = Buffer.from(parts.v1 ?? '', 'hex')
  return given.length === expected.length && crypto.timingSafeEqual(given, expected)
}`,
  },
  {
    id: 'python',
    label: 'Python',
    language: 'python',
    code: `import hashlib, hmac, time

def verify_rustrmm(raw_body: bytes, header: str, secret: str, tolerance: int = 300) -> bool:
    parts = dict(kv.strip().split("=", 1) for kv in header.split(","))
    t = int(parts.get("t", "0"))
    if abs(time.time() - t) > tolerance:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get("v1", ""))`,
  },
  {
    id: 'go',
    label: 'Go',
    language: 'go',
    code: `func VerifyRustRMM(rawBody []byte, header, secret string) bool {
	var t, v1 string
	for _, kv := range strings.Split(header, ",") {
		k, v, _ := strings.Cut(strings.TrimSpace(kv), "=")
		switch k {
		case "t":
			t = v
		case "v1":
			v1 = v
		}
	}
	ts, err := strconv.ParseInt(t, 10, 64)
	if err != nil || math.Abs(float64(time.Now().Unix()-ts)) > 300 {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(t + "."))
	mac.Write(rawBody)
	given, err := hex.DecodeString(v1)
	return err == nil && hmac.Equal(given, mac.Sum(nil))
}`,
  },
]

/** Delivery retry schedule after a failure, as the server applies it. */
export const RETRY_SCHEDULE = ['30 s', '2 min', '10 min', '30 min', '1 h', '2 h', '4 h', 'then every 8 h for 24 h']
