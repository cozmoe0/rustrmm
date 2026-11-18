/* Phase 11 mock state: report runs and schedules, dashboards, SSO, API tokens, webhooks, branding and signing status. */
import type {
  ApiToken,
  BrandingFile,
  BrandingSettings,
  Report,
  ReportRun,
  ReportSchedule,
  SigningStatus,
  SsoProvider,
  Webhook,
  WebhookDelivery,
  WidgetPlacement,
} from '@/lib/api/types'

export interface MockReportRun extends ReportRun {
  /** Async JSON runs keep their report for the download route; files are rebuilt from the parameters. */
  report?: Report
}

export interface MockDashboard {
  id: string
  name: string
  owner_id: string
  shared: boolean
  layout: WidgetPlacement[]
  created_at: string
  updated_at: string
}

export type MockSsoProvider = Omit<SsoProvider, 'has_client_secret' | 'redirect_uri'> & { client_secret: string | null }

export type MockApiToken = Omit<ApiToken, 'expired' | 'user'> & { user_id: string; revoked_at: string | null; token_hash: string }

export type MockWebhook = Omit<Webhook, 'has_secret' | 'last_delivery' | 'secret'> & { secret: string }

export interface MockBrandingFile extends Omit<BrandingFile, 'url'> {
  /** Base64 of the (sanitised) bytes. */
  data: string
}

export interface MockPlatform {
  reportRuns: MockReportRun[]
  reportSchedules: ReportSchedule[]
  dashboards: MockDashboard[]
  /** user id → dashboard id (their Home). */
  dashboardDefaults: Record<string, string>
  ssoProviders: MockSsoProvider[]
  ssoSettings: { enforce: boolean }
  apiTokens: MockApiToken[]
  webhooks: MockWebhook[]
  deliveries: WebhookDelivery[]
  branding: BrandingSettings
  brandingFiles: MockBrandingFile[]
  signing: SigningStatus
}

export function emptyPlatform(): MockPlatform {
  return {
    reportRuns: [],
    reportSchedules: [],
    dashboards: [],
    dashboardDefaults: {},
    ssoProviders: [],
    ssoSettings: { enforce: false },
    apiTokens: [],
    webhooks: [],
    deliveries: [],
    branding: { product_name: 'RustRMM', logo_light_file_id: null, logo_dark_file_id: null, accent_color: null },
    brandingFiles: [],
    signing: { source: 'none', version: null, imported_at: null, platforms: [] },
  }
}

export function brandingFileUrl(id: string): string {
  return `/api/v1/branding/files/${id}`
}

export function publicBrandingFile(file: MockBrandingFile): BrandingFile {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { data, ...rest } = file
  return { ...rest, url: brandingFileUrl(file.id) }
}

export function publicProvider(provider: MockSsoProvider): SsoProvider {
  const { client_secret, ...rest } = provider
  return {
    ...rest,
    has_client_secret: Boolean(client_secret),
    redirect_uri: `${window.location.origin}/api/v1/auth/oidc/${provider.id}/callback`,
  }
}

export function publicToken(token: MockApiToken, user?: { id: string; name: string; email: string }): ApiToken {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { user_id, revoked_at, token_hash, ...rest } = token
  return { ...rest, expired: new Date(token.expires_at).getTime() <= Date.now(), ...(user ? { user } : {}) }
}

export function publicWebhook(webhook: MockWebhook, deliveries: WebhookDelivery[]): Webhook {
  const { secret, ...rest } = webhook
  const last = deliveries
    .filter((delivery) => delivery.webhook_id === webhook.id && delivery.status !== 'pending' && delivery.status !== 'sending')
    .sort((a, b) => (b.last_attempt_at ?? b.created_at).localeCompare(a.last_attempt_at ?? a.created_at))[0]
  const retrying = deliveries.some((delivery) => delivery.webhook_id === webhook.id && delivery.status === 'pending' && delivery.attempts > 0)
  return {
    ...rest,
    has_secret: Boolean(secret),
    last_delivery: retrying
      ? { at: deliveries.find((delivery) => delivery.webhook_id === webhook.id && delivery.status === 'pending')!.last_attempt_at ?? new Date().toISOString(), status: 'retrying', error: 'Receiver answered 503' }
      : last
        ? { at: last.last_attempt_at ?? last.created_at, status: last.status === 'delivered' ? 'delivered' : 'failed', error: last.error }
        : null,
  }
}

/** base64 ⇄ bytes for stored logos. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  return btoa(binary)
}

export function base64ToBytes(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}
