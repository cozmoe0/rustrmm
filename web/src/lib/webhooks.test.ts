import { describe, expect, it } from 'vitest'
import { describeApproval } from './patching/approval'
import { eventLabel, generateSecret, isInsecureUrl, parseSignatureHeader, webhookSecretError, webhookUrlError } from './webhooks'

describe('webhook validation', () => {
  it('accepts http(s) URLs without credentials', () => {
    expect(webhookUrlError('https://hooks.example.com/rustrmm')).toBeNull()
    expect(webhookUrlError('http://siem.local:8088/in')).toBeNull()
    expect(webhookUrlError('')).toMatch(/Enter/)
    expect(webhookUrlError('hooks.example.com')).toMatch(/full URL/)
    expect(webhookUrlError('ftp://example.com')).toMatch(/http/)
    expect(webhookUrlError('https://user:pass@example.com/')).toMatch(/user name/)
    expect(isInsecureUrl('http://example.com')).toBe(true)
    expect(isInsecureUrl('https://example.com')).toBe(false)
  })

  it('bounds secrets to 16–256 characters and generates strong ones', () => {
    expect(webhookSecretError('short')).toMatch(/16/)
    expect(webhookSecretError('x'.repeat(257))).toMatch(/256/)
    const secret = generateSecret()
    expect(webhookSecretError(secret)).toBeNull()
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(generateSecret()).not.toBe(secret)
  })

  it('labels events', () => {
    expect(eventLabel('ticket.created')).toBe('Ticket created')
    expect(eventLabel('webhook.test')).toBe('Test delivery')
    expect(eventLabel('something.else')).toBe('something.else')
  })
})

describe('signature header', () => {
  it('parses t and v1 values', () => {
    expect(parseSignatureHeader('t=1763460000,v1=abc123')).toEqual({ t: 1763460000, v1: ['abc123'] })
    expect(parseSignatureHeader('v1=a, t=12, v1=b')).toEqual({ t: 12, v1: ['a', 'b'] })
    expect(parseSignatureHeader('garbage')).toEqual({ t: null, v1: [] })
  })

  it('matches the documented scheme: HMAC-SHA256 of "<t>.<body>" in hex', async () => {
    const secret = 'whsec_test_secret_0123456789'
    const body = '{"id":"evt_1","event":"webhook.test","created_at":"2026-11-18T10:00:00Z","data":{}}'
    const t = 1763460000
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${body}`)))
    const hex = [...mac].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    const header = `t=${t},v1=${hex}`
    const parsed = parseSignatureHeader(header)
    expect(parsed.t).toBe(t)
    expect(parsed.v1[0]).toBe(hex)
    expect(hex).toHaveLength(64)
  })
})

describe('rule approval summary', () => {
  it('describes client rule approvals in the all-clients catalog', () => {
    const display = describeApproval({ status: 'approved', source: 'rule', scope: 'clients', clients: 3, at: '2026-11-01T00:00:00Z', by_name: 'Auto-approval rule', client_id: null })
    expect(display.label).toBe('Approved · rule (3 clients)')
    expect(display.source).toBe('rule')
    expect(display.override).toBe(false)
    expect(display.detail).toMatch(/3 clients/)
    expect(describeApproval({ status: 'approved', source: 'rule', scope: 'clients', clients: 1, client_id: null }).label).toBe('Approved · rule (1 client)')
  })
})
