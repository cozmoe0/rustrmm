import { ApiError } from './errors'
import type { ApiErrorBody } from './types'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export type QueryValue = string | number | boolean | null | undefined

export interface RequestOptions {
  method?: HttpMethod
  body?: unknown
  query?: Record<string, QueryValue>
  signal?: AbortSignal
  /** Set on the retry after a successful step-up so a second 403 is surfaced instead of looping. */
  skipStepUp?: boolean
  /** When false, a 401 is returned to the caller without triggering the global sign-out redirect. */
  authRequired?: boolean
  /**
   * Fetch cache mode. Secret reveals pass `no-store` so the browser never keeps the response, matching
   * the server's `Cache-Control: no-store`.
   */
  cache?: RequestCache
}

type StepUpHandler = () => Promise<boolean>

let csrfToken: string | null = null
let stepUpHandler: StepUpHandler | null = null
let pendingStepUp: Promise<boolean> | null = null
let unauthorizedHandler: (() => void) | null = null

/** Remembered from `Me.csrf_token`; sent as `X-CSRF-Token` on every state-changing request. */
export function setCsrfToken(token: string | null) {
  csrfToken = token
}

export function getCsrfToken() {
  return csrfToken
}

/** Registered by the step-up dialog: resolves true once the user re-authenticated. */
export function setStepUpHandler(handler: StepUpHandler | null) {
  stepUpHandler = handler
}

export function setUnauthorizedHandler(handler: (() => void) | null) {
  unauthorizedHandler = handler
}

export function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const base = path.startsWith('/api/') ? path : `/api/v1${path.startsWith('/') ? '' : '/'}${path}`
  if (!query) return base
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    params.set(key, String(value))
  }
  const qs = params.toString()
  return qs ? `${base}?${qs}` : base
}

async function parseError(res: Response): Promise<ApiError> {
  let body: Partial<ApiErrorBody> | null
  try {
    body = (await res.json()) as Partial<ApiErrorBody>
  } catch {
    body = null
  }
  const code = body?.error?.code ?? `http_${res.status}`
  const message = body?.error?.message ?? (res.statusText || `Request failed (${res.status})`)
  return new ApiError(res.status, code, message, body?.error?.details)
}

/** Shares one dialog between concurrent requests that all hit `step_up_required`. */
function requestStepUp(): Promise<boolean> {
  if (!stepUpHandler) return Promise.resolve(false)
  if (!pendingStepUp) {
    pendingStepUp = stepUpHandler().finally(() => {
      pendingStepUp = null
    })
  }
  return pendingStepUp
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const method = options.method ?? 'GET'
  const headers: Record<string, string> = { Accept: 'application/json' }
  let body: BodyInit | undefined

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken

  const res = await fetch(buildUrl(path, options.query), {
    method,
    headers,
    body,
    credentials: 'same-origin',
    signal: options.signal,
    cache: options.cache,
  })

  if (res.ok) return res

  const error = await parseError(res)

  if (res.status === 403 && error.code === 'step_up_required' && !options.skipStepUp) {
    const confirmed = await requestStepUp()
    if (confirmed) return send(path, { ...options, skipStepUp: true })
  }

  if (res.status === 401 && options.authRequired !== false) unauthorizedHandler?.()

  throw error
}

/** A same-origin `ws:`/`wss:` URL for an API path. */
export function buildWsUrl(path: string, query?: Record<string, QueryValue>): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}${buildUrl(path, query)}`
}

/** Like `request`, for endpoints that return plain text (e.g. asciicast recordings). */
export async function requestText(path: string, options: RequestOptions = {}): Promise<string> {
  const res = await send(path, options)
  return res.text()
}

/**
 * Like `request`, but hands back the raw `Response` (step-up, CSRF and errors handled) for endpoints
 * whose answer depends on status and headers, such as report runs (`200` file vs `202` queued).
 */
export function requestResponse(path: string, options: RequestOptions = {}): Promise<Response> {
  return send(path, options)
}

/** The file name from a `Content-Disposition` header, if any. */
export function dispositionFileName(header: string | null): string | null {
  return filenameFromDisposition(header)
}

/** Like `request`, for binary endpoints (e.g. a device screenshot). */
export async function requestBlob(path: string, options: RequestOptions = {}): Promise<Blob> {
  const res = await send(path, options)
  return res.blob()
}

export interface UploadOptions {
  query?: Record<string, QueryValue>
  /** Extra request headers (for example `X-File-Name`); values must be ASCII. */
  headers?: Record<string, string>
  onProgress?: (loaded: number, total: number) => void
  signal?: AbortSignal
}

function parseXhrError(xhr: XMLHttpRequest): ApiError {
  let body: Partial<ApiErrorBody> | null
  try {
    body = JSON.parse(xhr.responseText) as Partial<ApiErrorBody>
  } catch {
    body = null
  }
  return new ApiError(
    xhr.status,
    body?.error?.code ?? `http_${xhr.status}`,
    body?.error?.message ?? (xhr.statusText || `Request failed (${xhr.status})`),
    body?.error?.details,
  )
}

/**
 * Uploads a raw body with `XMLHttpRequest` so callers get upload progress. Shares CSRF, the
 * step-up prompt and the 401 redirect with `request`. Rejects with an `AbortError` when cancelled.
 */
export function uploadWithProgress<T>(path: string, body: Blob | FormData, options: UploadOptions = {}): Promise<T> {
  // A FormData body is sent as multipart/form-data; the browser sets the boundary itself.
  const multipart = typeof FormData !== 'undefined' && body instanceof FormData
  const fallbackTotal = multipart ? 0 : (body as Blob).size
  const attempt = (skipStepUp: boolean): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new DOMException('Upload cancelled', 'AbortError'))
        return
      }
      const xhr = new XMLHttpRequest()
      xhr.open('POST', buildUrl(path, options.query))
      xhr.setRequestHeader('Accept', 'application/json')
      if (!multipart) xhr.setRequestHeader('Content-Type', 'application/octet-stream')
      if (csrfToken) xhr.setRequestHeader('X-CSRF-Token', csrfToken)
      for (const [name, value] of Object.entries(options.headers ?? {})) xhr.setRequestHeader(name, value)
      xhr.upload.onprogress = (event) => options.onProgress?.(event.loaded, event.lengthComputable ? event.total : fallbackTotal)
      const onAbort = () => xhr.abort()
      options.signal?.addEventListener('abort', onAbort, { once: true })
      const cleanup = () => options.signal?.removeEventListener('abort', onAbort)
      xhr.onload = () => {
        cleanup()
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve((xhr.responseText ? JSON.parse(xhr.responseText) : undefined) as T)
          } catch {
            resolve(undefined as T)
          }
          return
        }
        const error = parseXhrError(xhr)
        if (xhr.status === 403 && error.code === 'step_up_required' && !skipStepUp) {
          void requestStepUp().then((confirmed) => (confirmed ? attempt(true).then(resolve, reject) : reject(error)))
          return
        }
        if (xhr.status === 401) unauthorizedHandler?.()
        reject(error)
      }
      xhr.onerror = () => {
        cleanup()
        reject(new ApiError(0, 'network_error', 'The upload was interrupted. Check your connection and try again.'))
      }
      xhr.onabort = () => {
        cleanup()
        reject(new DOMException('Upload cancelled', 'AbortError'))
      }
      xhr.send(body)
    })
  return attempt(false)
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const res = await send(path, options)
  if (res.status === 204 || res.headers.get('content-length') === '0') return undefined as T
  const type = res.headers.get('content-type') ?? ''
  if (!type.includes('json')) return undefined as T
  return (await res.json()) as T
}

type Body = RequestOptions['body']
type Opts = Omit<RequestOptions, 'method' | 'body'>

export const api = {
  get: <T>(path: string, options?: Opts) => request<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: Body, options?: Opts) =>
    request<T>(path, { ...options, method: 'POST', body }),
  put: <T>(path: string, body?: Body, options?: Opts) =>
    request<T>(path, { ...options, method: 'PUT', body }),
  patch: <T>(path: string, body?: Body, options?: Opts) =>
    request<T>(path, { ...options, method: 'PATCH', body }),
  del: <T = void>(path: string, options?: Opts) => request<T>(path, { ...options, method: 'DELETE' }),
}

function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header)
  if (star) return decodeURIComponent(star[1])
  const plain = /filename="?([^";]+)"?/i.exec(header)
  return plain ? plain[1] : null
}

/** Downloads a file endpoint (with step-up support) and hands it to the browser. */
export async function download(
  path: string,
  fallbackName: string,
  query?: Record<string, QueryValue>,
): Promise<void> {
  const res = await send(path, { method: 'GET', query })
  const blob = await res.blob()
  const name = filenameFromDisposition(res.headers.get('content-disposition')) ?? fallbackName
  saveBlob(blob, name)
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
