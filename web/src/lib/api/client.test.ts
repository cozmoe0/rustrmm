import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, buildUrl, setCsrfToken, setStepUpHandler, setUnauthorizedHandler } from './client'
import { ApiError } from './errors'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('api client', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    setCsrfToken('csrf-123')
  })

  afterEach(() => {
    fetchMock.mockReset()
    vi.unstubAllGlobals()
    setCsrfToken(null)
    setStepUpHandler(null)
    setUnauthorizedHandler(null)
  })

  it('sends the CSRF header on mutations but not on reads', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ ok: true }))

    await api.get('/clients')
    await api.post('/clients', { name: 'Acme' })

    const [getUrl, getInit] = fetchMock.mock.calls[0]
    const [postUrl, postInit] = fetchMock.mock.calls[1]
    expect(getUrl).toBe('/api/v1/clients')
    expect((getInit?.headers as Record<string, string>)['X-CSRF-Token']).toBeUndefined()
    expect(postUrl).toBe('/api/v1/clients')
    expect((postInit?.headers as Record<string, string>)['X-CSRF-Token']).toBe('csrf-123')
    expect(postInit?.credentials).toBe('same-origin')
    expect(postInit?.body).toBe(JSON.stringify({ name: 'Acme' }))
  })

  it('retries once after a successful step-up', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'step_up_required', message: 'Re-authenticate' } }, 403))
      .mockResolvedValueOnce(jsonResponse({ id: 'b1' }))
    const handler = vi.fn().mockResolvedValue(true)
    setStepUpHandler(handler)

    const result = await api.del<{ id: string }>('/backups/b1')

    expect(handler).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ id: 'b1' })
  })

  it('surfaces step_up_required when the user cancels', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ error: { code: 'step_up_required', message: 'Re-authenticate' } }, 403),
    )
    setStepUpHandler(vi.fn().mockResolvedValue(false))

    await expect(api.post('/me/recovery-codes')).rejects.toMatchObject({ status: 403, code: 'step_up_required' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('shares one step-up prompt between concurrent requests', async () => {
    let calls = 0
    fetchMock.mockImplementation(async () => {
      calls += 1
      return calls <= 2
        ? jsonResponse({ error: { code: 'step_up_required', message: 'Re-authenticate' } }, 403)
        : jsonResponse({ ok: true })
    })
    const handler = vi.fn().mockResolvedValue(true)
    setStepUpHandler(handler)

    await Promise.all([api.post('/a'), api.post('/b')])

    expect(handler).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('maps error bodies to ApiError and calls the unauthorized handler on 401', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'unauthenticated', message: 'Session expired' } }, 401))
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)

    const error = await api.get('/clients').catch((err: unknown) => err)

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 401, code: 'unauthenticated', message: 'Session expired' })
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it('does not redirect on 401 for open endpoints', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'unauthenticated', message: 'Not signed in' } }, 401))
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)

    await expect(api.get('/auth/me', { authRequired: false })).rejects.toBeInstanceOf(ApiError)
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('builds query strings and drops empty values', () => {
    expect(buildUrl('/audit', { q: 'login', cursor: undefined, limit: 100, client_id: '' })).toBe(
      '/api/v1/audit?q=login&limit=100',
    )
  })
})
