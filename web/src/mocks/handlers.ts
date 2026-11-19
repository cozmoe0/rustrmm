import { http, HttpResponse } from 'msw/http'
import type {
  AssignmentInput,
  AuditEvent,
  Backup,
  BackupSettingsUpdate,
  Client,
  Me,
  RoleInput,
  Site,
  SiteInput,
  UserPatch,
} from '@/lib/api/types'
import {
  PERMISSION_CATALOG,
  db,
  fleetSummary,
  permissionsFor,
  persist,
  randomHex,
  recordAudit,
  recountClients,
  rolesWithCounts,
  uuid,
  type MockUser,
} from './db'
import { agentUpdateHandlers } from './agent-update-handlers'
import { automationHandlers } from './automation-handlers'
import { deviceHandlers } from './device-handlers'
import { monitoringHandlers } from './monitoring-handlers'
import { patchingHandlers } from './patching-handlers'
import { softwareHandlers } from './software-handlers'
import { remoteHandlers } from './remote-handlers'
import { ticketsHandlers } from './tickets-handlers'
import { escrowHandlers } from './escrow-handlers'
import { networkHandlers } from './network-handlers'
import { acceptSsoChallenge, platformHandlers, ssoBlocksPassword } from './platform-handlers'
import { API, actor, currentUser, fail, guard, latency, noContent, sleep } from './http-helpers'

const MOCK_TOTP = '123456'
/** Mock sessions last 12 hours; one MFA confirmation (sign-in or step-up) covers all of it. */
const SESSION_MS = 12 * 3_600_000

function buildMe(): Me {
  const user = currentUser()!
  const session = db.session!
  const now = Date.now()
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      mfa: { totp: user.totp_enabled, passkeys: db.passkeys.length },
      created_at: user.created_at,
    },
    csrf_token: session.csrf,
    permissions: permissionsFor(user),
    scopes: { global: true, client_ids: [], site_ids: [] },
    organization: { name: db.organization },
    session: {
      id: session.id,
      expires_at: new Date(now + SESSION_MS).toISOString(),
      idle_expires_at: new Date(now + 30 * 60_000).toISOString(),
      stepped_up_until:
        session.steppedUpUntil && session.steppedUpUntil > now ? new Date(session.steppedUpUntil).toISOString() : null,
    },
  }
}

function startSession() {
  // Every mock sign-in finishes with MFA, which counts as a step-up for the whole session.
  db.session = { id: uuid(), csrf: `mock-csrf-${randomHex(24)}`, steppedUpUntil: Date.now() + SESSION_MS, createdAt: new Date().toISOString() }
  db.challenge = null
  const user = currentUser()
  if (user) user.last_login_at = new Date().toISOString()
  db.sessions = [
    {
      id: db.session.id,
      created_at: db.session.createdAt,
      last_seen_at: db.session.createdAt,
      ip: '10.20.0.14',
      user_agent: navigator.userAgent,
      current: true,
    },
    ...db.sessions.filter((session) => !session.current),
  ]
  recordAudit({ actor: actor(), action: 'auth.login', target: null, client_id: null, site_id: null, ip: '10.20.0.14', user_agent: navigator.userAgent, details: { method: 'totp' } })
  persist()
}

function qrSvg(): string {
  // A decorative QR-like matrix; the real server returns a scannable code.
  const size = 25
  const cells: string[] = []
  const finder = (x: number, y: number) =>
    `<rect x="${x}" y="${y}" width="7" height="7" fill="#111"/><rect x="${x + 1}" y="${y + 1}" width="5" height="5" fill="#fff"/><rect x="${x + 2}" y="${y + 2}" width="3" height="3" fill="#111"/>`
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const inFinder = (x < 8 && y < 8) || (x > 16 && y < 8) || (x < 8 && y > 16)
      if (!inFinder && (x * 7 + y * 13 + x * y) % 3 === 0) cells.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="#111"/>`)
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/>${cells.join('')}${finder(0, 0)}${finder(18, 0)}${finder(0, 18)}</svg>`
}

function recoveryCodes() {
  return Array.from({ length: 10 }, () => `${randomHex(4)}-${randomHex(4)}-${randomHex(4)}`)
}

function webauthnRequestOptions() {
  return {
    options: {
      publicKey: {
        challenge: btoa(randomHex(32)).replace(/=+$/, ''),
        timeout: 60000,
        rpId: window.location.hostname,
        allowCredentials: [],
        userVerification: 'preferred',
      },
    },
  }
}

function resolveAssignments(items: AssignmentInput[]): MockUser['assignments'] {
  return items.map((item) => {
    const role = db.roles.find((candidate) => candidate.id === item.role_id)
    const scopeName =
      item.scope_type === 'client'
        ? db.clients.find((client) => client.id === item.scope_id)?.name ?? null
        : item.scope_type === 'site'
          ? db.sites.find((site) => site.id === item.scope_id)?.name ?? null
          : null
    return {
      id: uuid(),
      role_id: item.role_id,
      role_name: role?.name ?? 'Unknown role',
      scope: { type: item.scope_type, id: item.scope_type === 'global' ? null : item.scope_id, name: scopeName },
    }
  })
}

function publicUser(user: MockUser) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { password, totp_enabled, ...rest } = user
  return rest
}

function filterAudit(url: URL): AuditEvent[] {
  const action = url.searchParams.get('action')
  const actorId = url.searchParams.get('actor_id')
  const clientId = url.searchParams.get('client_id')
  const from = url.searchParams.get('from')
  const to = url.searchParams.get('to')
  const q = url.searchParams.get('q')?.toLowerCase()
  return [...db.audit]
    .reverse()
    .filter((event) => !action || event.action === action || event.action.startsWith(`${action}.`))
    .filter((event) => !actorId || event.actor.id === actorId)
    .filter((event) => !clientId || event.client_id === clientId)
    .filter((event) => !from || event.at >= from)
    .filter((event) => !to || event.at <= `${to}T23:59:59.999Z`)
    .filter(
      (event) =>
        !q ||
        [event.action, event.actor.name, event.target?.name, event.ip]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(q)),
    )
}

function slugify(name: string) {
  return name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function clientDetail(client: Client) {
  return { ...client, sites: db.sites.filter((site) => site.client_id === client.id) }
}

export const handlers = [
  // ------------------------------------------------------------ setup
  http.get(`${API}/setup/status`, async () => {
    await latency()
    return HttpResponse.json({ needs_setup: db.needsSetup, product: 'RustRMM', version: '0.1.0-mock' })
  }),

  http.post(`${API}/setup/complete`, async ({ request }) => {
    await sleep(700)
    if (!db.needsSetup) return fail(409, 'already_set_up', 'This installation is already set up.')
    const body = (await request.json()) as {
      setup_token: string
      organization_name: string
      owner: { name: string; email: string; password: string }
      first_client: { name: string }
      first_site: { name: string; timezone: string }
    }
    if (body.setup_token !== 'mock-setup-token') return fail(403, 'invalid_setup_token', 'Setup token not recognized.')
    const owner = db.roles.find((role) => role.name === 'Owner')!
    const now = new Date().toISOString()
    const user: MockUser = {
      id: uuid(),
      name: body.owner.name,
      email: body.owner.email,
      status: 'active',
      mfa_enabled: false,
      totp_enabled: false,
      password: body.owner.password,
      last_login_at: null,
      created_at: now,
      assignments: [{ id: uuid(), role_id: owner.id, role_name: owner.name, scope: { type: 'global', id: null, name: null } }],
    }
    const client: Client = {
      id: uuid(),
      name: body.first_client.name,
      slug: slugify(body.first_client.name),
      notes: '',
      accent_color: null,
      logo_url: null,
      site_count: 1,
      device_count: 0,
      created_at: now,
      updated_at: now,
    }
    const site: Site = {
      id: uuid(),
      client_id: client.id,
      name: body.first_site.name,
      timezone: body.first_site.timezone,
      address: '',
      notes: '',
      device_count: 0,
      created_at: now,
      updated_at: now,
    }
    db.needsSetup = false
    db.organization = body.organization_name
    db.users = [user]
    db.meUserId = user.id
    db.clients = [client]
    db.sites = [site]
    db.passkeys = []
    db.sessions = []
    recordAudit({ actor: { type: 'system', id: null, name: 'Setup' }, action: 'setup.completed', target: null, client_id: null, site_id: null, ip: '10.20.0.14', user_agent: navigator.userAgent, details: {} })
    persist()
    return HttpResponse.json({
      recovery_kit: {
        master_key: btoa(randomHex(32)),
        backup_identity: `AGE-SECRET-KEY-1${randomHex(52).toUpperCase()}`,
        backup_recipient: db.backupSettings.recipient,
        generated_at: now,
      },
    })
  }),

  // ------------------------------------------------------------ auth
  http.get(`${API}/auth/me`, async () => {
    await latency()
    if (!db.session || !currentUser()) return fail(401, 'unauthenticated', 'Not signed in.')
    return HttpResponse.json(buildMe())
  }),

  http.post(`${API}/auth/login`, async ({ request }) => {
    await sleep(350)
    const { email, password } = (await request.json()) as { email: string; password: string }
    const user = db.users.find((candidate) => candidate.email.toLowerCase() === email.toLowerCase())
    if (!user || user.password !== password || user.status !== 'active') {
      recordAudit({ actor: { type: 'user', id: null, name: email }, action: 'auth.login_failed', target: null, client_id: null, site_id: null, ip: '10.20.0.14', user_agent: navigator.userAgent, details: { reason: 'invalid_credentials' } })
      persist()
      return fail(401, 'invalid_credentials', 'Email or password is incorrect.')
    }
    if (ssoBlocksPassword(user.id)) {
      return fail(403, 'sso_required', 'Your organisation signs in with single sign-on. Use your identity provider below.')
    }
    db.meUserId = user.id
    const token = `chal_${randomHex(24)}`
    db.challenge = { token, kind: user.totp_enabled ? 'mfa' : 'setup', userId: user.id }
    persist()
    if (!user.totp_enabled) return HttpResponse.json({ status: 'mfa_setup_required', challenge_token: token })
    return HttpResponse.json({
      status: 'mfa_required',
      challenge_token: token,
      methods: db.passkeys.length > 0 ? ['totp', 'webauthn', 'recovery_code'] : ['totp', 'recovery_code'],
    })
  }),

  http.post(`${API}/auth/mfa/totp`, async ({ request }) => {
    await latency()
    const { challenge_token, code } = (await request.json()) as { challenge_token: string; code: string }
    acceptSsoChallenge(challenge_token)
    if (db.challenge?.token !== challenge_token) return fail(401, 'challenge_expired', 'Sign-in expired. Start again.')
    if (code !== MOCK_TOTP) return fail(401, 'invalid_code', 'That code is incorrect. Mock code: 123456.')
    startSession()
    return HttpResponse.json({ status: 'ok', me: buildMe() })
  }),

  http.post(`${API}/auth/mfa/recovery`, async ({ request }) => {
    await latency()
    const { challenge_token, code } = (await request.json()) as { challenge_token: string; code: string }
    acceptSsoChallenge(challenge_token)
    if (db.challenge?.token !== challenge_token) return fail(401, 'challenge_expired', 'Sign-in expired. Start again.')
    if (!/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/i.test(code)) return fail(401, 'invalid_code', 'That recovery code is not valid.')
    startSession()
    return HttpResponse.json({ status: 'ok', me: buildMe() })
  }),

  http.post(`${API}/auth/mfa/webauthn/start`, async () => {
    await latency()
    return HttpResponse.json(webauthnRequestOptions())
  }),

  http.post(`${API}/auth/mfa/webauthn/finish`, async ({ request }) => {
    await latency()
    const { challenge_token } = (await request.json()) as { challenge_token: string }
    acceptSsoChallenge(challenge_token)
    if (db.challenge?.token !== challenge_token) return fail(401, 'challenge_expired', 'Sign-in expired. Start again.')
    startSession()
    return HttpResponse.json({ status: 'ok', me: buildMe() })
  }),

  http.post(`${API}/auth/mfa/setup/totp/start`, async ({ request }) => {
    await latency()
    const { challenge_token } = (await request.json()) as { challenge_token: string }
    acceptSsoChallenge(challenge_token)
    if (db.challenge?.token !== challenge_token) return fail(401, 'challenge_expired', 'Sign-in expired. Start again.')
    const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'
    return HttpResponse.json({
      secret,
      otpauth_url: `otpauth://totp/RustRMM:${currentUser()?.email}?secret=${secret}&issuer=RustRMM`,
      qr_svg: qrSvg(),
    })
  }),

  http.post(`${API}/auth/mfa/setup/totp/finish`, async ({ request }) => {
    await latency()
    const { challenge_token, code } = (await request.json()) as { challenge_token: string; code: string }
    acceptSsoChallenge(challenge_token)
    if (db.challenge?.token !== challenge_token) return fail(401, 'challenge_expired', 'Sign-in expired. Start again.')
    if (code !== MOCK_TOTP) return fail(401, 'invalid_code', 'That code is incorrect. Mock code: 123456.')
    const user = currentUser()!
    user.totp_enabled = true
    user.mfa_enabled = true
    startSession()
    recordAudit({ actor: actor(), action: 'auth.mfa_enrolled', target: { type: 'user', id: user.id, name: user.name }, client_id: null, site_id: null, ip: '10.20.0.14', user_agent: navigator.userAgent, details: { method: 'totp' } })
    persist()
    return HttpResponse.json({ status: 'ok', me: buildMe(), recovery_codes: recoveryCodes() })
  }),

  http.post(`${API}/auth/logout`, async () => {
    await latency()
    if (db.session) {
      recordAudit({ actor: actor(), action: 'auth.logout', target: null, client_id: null, site_id: null, ip: '10.20.0.14', user_agent: navigator.userAgent, details: {} })
    }
    db.session = null
    db.sessions = db.sessions.filter((session) => !session.current)
    persist()
    return noContent()
  }),

  http.post(`${API}/auth/step-up`, async ({ request }) => {
    await latency()
    const denied = guard(request)
    if (denied) return denied
    const { code } = (await request.json()) as { code: string }
    if (code !== MOCK_TOTP) return fail(401, 'invalid_code', 'That code is incorrect. Mock code: 123456.')
    db.session!.steppedUpUntil = Date.now() + SESSION_MS
    recordAudit({ actor: actor(), action: 'auth.step_up', target: null, client_id: null, site_id: null, ip: '10.20.0.14', user_agent: navigator.userAgent, details: { method: 'totp' } })
    persist()
    return HttpResponse.json({ stepped_up_until: new Date(db.session!.steppedUpUntil).toISOString() })
  }),

  http.post(`${API}/auth/step-up/webauthn/start`, async ({ request }) => {
    await latency()
    return guard(request) ?? HttpResponse.json(webauthnRequestOptions())
  }),

  http.post(`${API}/auth/step-up/webauthn/finish`, async ({ request }) => {
    await latency()
    const denied = guard(request)
    if (denied) return denied
    db.session!.steppedUpUntil = Date.now() + SESSION_MS
    persist()
    return HttpResponse.json({ stepped_up_until: new Date(db.session!.steppedUpUntil).toISOString() })
  }),

  // ------------------------------------------------------------ me
  http.get(`${API}/me/sessions`, async ({ request }) => {
    await latency()
    return guard(request) ?? HttpResponse.json({ items: db.sessions })
  }),

  http.delete(`${API}/me/sessions/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request)
    if (denied) return denied
    const target = db.sessions.find((session) => session.id === params.id)
    if (!target) return fail(404, 'not_found', 'Session not found.')
    if (target.current) return fail(409, 'current_session', 'Use sign out to end the current session.')
    db.sessions = db.sessions.filter((session) => session.id !== params.id)
    recordAudit({ actor: actor(), action: 'session.revoked', target: { type: 'session', id: target.id, name: 'Browser session' }, client_id: null, site_id: null, ip: '10.20.0.14', user_agent: navigator.userAgent, details: {} })
    persist()
    return noContent()
  }),

  http.get(`${API}/me/passkeys`, async ({ request }) => {
    await latency()
    return guard(request) ?? HttpResponse.json({ items: db.passkeys })
  }),

  http.post(`${API}/me/passkeys/register/start`, async ({ request }) => {
    await latency()
    const denied = guard(request)
    if (denied) return denied
    const user = currentUser()!
    return HttpResponse.json({
      options: {
        publicKey: {
          rp: { name: 'RustRMM', id: window.location.hostname },
          user: { id: btoa(user.id).replace(/=+$/, ''), name: user.email, displayName: user.name },
          challenge: btoa(randomHex(32)).replace(/=+$/, ''),
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 },
          ],
          timeout: 60000,
          attestation: 'none',
          excludeCredentials: [],
          authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
        },
      },
    })
  }),

  http.post(`${API}/me/passkeys/register/finish`, async ({ request }) => {
    await latency()
    const denied = guard(request)
    if (denied) return denied
    const { name } = (await request.json()) as { name: string }
    const passkey = { id: uuid(), name: name || 'Passkey', created_at: new Date().toISOString(), last_used_at: null }
    db.passkeys.push(passkey)
    persist()
    return HttpResponse.json(passkey)
  }),

  http.delete(`${API}/me/passkeys/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request)
    if (denied) return denied
    db.passkeys = db.passkeys.filter((passkey) => passkey.id !== params.id)
    persist()
    return noContent()
  }),

  http.post(`${API}/me/password`, async ({ request }) => {
    await latency()
    const denied = guard(request)
    if (denied) return denied
    const { current_password, new_password } = (await request.json()) as { current_password: string; new_password: string }
    const user = currentUser()!
    if (user.password !== current_password) return fail(400, 'invalid_password', 'Current password is incorrect.')
    if (new_password.length < 12) return fail(400, 'weak_password', 'Use at least 12 characters.')
    user.password = new_password
    persist()
    return noContent()
  }),

  http.post(`${API}/me/recovery-codes`, async ({ request }) => {
    await latency()
    return guard(request, { stepUp: true }) ?? HttpResponse.json({ recovery_codes: recoveryCodes() })
  }),

  // ------------------------------------------------------------ clients & sites
  http.get(`${API}/clients`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'clients.view' })
    if (denied) return denied
    const search = new URL(request.url).searchParams.get('search')?.toLowerCase()
    recountClients()
    const items = db.clients
      .filter((client) => !search || client.name.toLowerCase().includes(search))
      .sort((a, b) => a.name.localeCompare(b.name))
    return HttpResponse.json({ items })
  }),

  http.post(`${API}/clients`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'clients.manage' })
    if (denied) return denied
    const body = (await request.json()) as { name: string; notes?: string }
    if (db.clients.some((client) => client.name.toLowerCase() === body.name.trim().toLowerCase())) {
      return fail(409, 'duplicate_name', 'A client with that name already exists.')
    }
    const now = new Date().toISOString()
    const client: Client = {
      id: uuid(),
      name: body.name.trim(),
      slug: slugify(body.name),
      notes: body.notes ?? '',
      accent_color: null,
      logo_url: null,
      site_count: 0,
      device_count: 0,
      created_at: now,
      updated_at: now,
    }
    db.clients.push(client)
    recordAudit({ actor: actor(), action: 'client.created', target: { type: 'client', id: client.id, name: client.name }, client_id: client.id, site_id: null, ip: '10.20.0.14', user_agent: navigator.userAgent, details: {} })
    persist()
    return HttpResponse.json(client, { status: 201 })
  }),

  http.get(`${API}/clients/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'clients.view' })
    if (denied) return denied
    recountClients()
    const client = db.clients.find((item) => item.id === params.id)
    return client ? HttpResponse.json(clientDetail(client)) : fail(404, 'not_found', 'Client not found.')
  }),

  http.patch(`${API}/clients/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'clients.manage' })
    if (denied) return denied
    const client = db.clients.find((item) => item.id === params.id)
    if (!client) return fail(404, 'not_found', 'Client not found.')
    const body = (await request.json()) as Partial<Client>
    if (body.name !== undefined) {
      client.name = body.name.trim()
      client.slug = slugify(client.name)
    }
    if (body.notes !== undefined) client.notes = body.notes
    if (body.accent_color !== undefined) client.accent_color = body.accent_color
    client.updated_at = new Date().toISOString()
    recordAudit({ actor: actor(), action: 'client.updated', target: { type: 'client', id: client.id, name: client.name }, client_id: client.id, site_id: null, ip: '10.20.0.14', user_agent: navigator.userAgent, details: { changed: Object.keys(body) } })
    persist()
    return HttpResponse.json(client)
  }),

  http.delete(`${API}/clients/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'clients.manage', stepUp: true })
    if (denied) return denied
    recountClients()
    const client = db.clients.find((item) => item.id === params.id)
    if (!client) return fail(404, 'not_found', 'Client not found.')
    if (client.device_count > 0) {
      return fail(409, 'client_not_empty', `${client.name} still has ${client.device_count} devices. Move or retire them first.`)
    }
    db.clients = db.clients.filter((item) => item.id !== client.id)
    db.sites = db.sites.filter((site) => site.client_id !== client.id)
    recordAudit({ actor: actor(), action: 'client.deleted', target: { type: 'client', id: client.id, name: client.name }, client_id: null, site_id: null, ip: '10.20.0.14', user_agent: navigator.userAgent, details: {} })
    persist()
    return noContent()
  }),

  http.get(`${API}/sites`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'clients.view' })
    if (denied) return denied
    recountClients()
    const clientId = new URL(request.url).searchParams.get('client_id')
    return HttpResponse.json({ items: db.sites.filter((site) => !clientId || site.client_id === clientId) })
  }),

  http.post(`${API}/clients/:id/sites`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'sites.manage' })
    if (denied) return denied
    const client = db.clients.find((item) => item.id === params.id)
    if (!client) return fail(404, 'not_found', 'Client not found.')
    const body = (await request.json()) as SiteInput
    if (db.sites.some((site) => site.client_id === client.id && site.name.toLowerCase() === body.name.trim().toLowerCase())) {
      return fail(409, 'duplicate_name', 'This client already has a site with that name.')
    }
    const now = new Date().toISOString()
    const site: Site = {
      id: uuid(),
      client_id: client.id,
      name: body.name.trim(),
      timezone: body.timezone ?? 'UTC',
      address: body.address ?? '',
      notes: body.notes ?? '',
      device_count: 0,
      created_at: now,
      updated_at: now,
    }
    db.sites.push(site)
    recordAudit({ actor: actor(), action: 'site.created', target: { type: 'site', id: site.id, name: site.name }, client_id: client.id, site_id: site.id, ip: '10.20.0.14', user_agent: navigator.userAgent, details: {} })
    persist()
    return HttpResponse.json(site, { status: 201 })
  }),

  http.patch(`${API}/sites/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'sites.manage' })
    if (denied) return denied
    const site = db.sites.find((item) => item.id === params.id)
    if (!site) return fail(404, 'not_found', 'Site not found.')
    const body = (await request.json()) as Partial<SiteInput>
    Object.assign(site, body, { updated_at: new Date().toISOString() })
    recordAudit({ actor: actor(), action: 'site.updated', target: { type: 'site', id: site.id, name: site.name }, client_id: site.client_id, site_id: site.id, ip: '10.20.0.14', user_agent: navigator.userAgent, details: { changed: Object.keys(body) } })
    persist()
    return HttpResponse.json(site)
  }),

  http.delete(`${API}/sites/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'sites.manage' })
    if (denied) return denied
    const site = db.sites.find((item) => item.id === params.id)
    if (!site) return fail(404, 'not_found', 'Site not found.')
    recountClients()
    if (site.device_count > 0) return fail(409, 'site_not_empty', `${site.name} still has ${site.device_count} devices.`)
    db.sites = db.sites.filter((item) => item.id !== site.id)
    recordAudit({ actor: actor(), action: 'site.deleted', target: { type: 'site', id: site.id, name: site.name }, client_id: site.client_id, site_id: null, ip: '10.20.0.14', user_agent: navigator.userAgent, details: {} })
    persist()
    return noContent()
  }),

  // ------------------------------------------------------------ users & roles
  http.get(`${API}/users`, async ({ request }) => {
    await latency()
    return guard(request, { permission: 'users.view' }) ?? HttpResponse.json({ items: db.users.map(publicUser) })
  }),

  http.post(`${API}/users`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'users.manage' })
    if (denied) return denied
    const body = (await request.json()) as { name: string; email: string; password: string; assignments: AssignmentInput[] }
    if (db.users.some((user) => user.email.toLowerCase() === body.email.toLowerCase())) {
      return fail(409, 'duplicate_email', 'A user with that email already exists.')
    }
    const user: MockUser = {
      id: uuid(),
      name: body.name,
      email: body.email,
      status: 'active',
      mfa_enabled: false,
      totp_enabled: false,
      password: body.password,
      last_login_at: null,
      created_at: new Date().toISOString(),
      assignments: resolveAssignments(body.assignments),
    }
    db.users.push(user)
    recordAudit({ actor: actor(), action: 'user.created', target: { type: 'user', id: user.id, name: user.name }, client_id: null, site_id: null, ip: '10.20.0.14', user_agent: navigator.userAgent, details: {} })
    persist()
    return HttpResponse.json(publicUser(user), { status: 201 })
  }),

  http.patch(`${API}/users/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'users.manage' })
    if (denied) return denied
    const user = db.users.find((item) => item.id === params.id)
    if (!user) return fail(404, 'not_found', 'User not found.')
    const body = (await request.json()) as UserPatch
    if (body.status === 'disabled' && user.id === db.meUserId) return fail(409, 'self_disable', 'You cannot disable your own account.')
    if (body.name !== undefined) user.name = body.name
    if (body.status !== undefined) user.status = body.status
    if (body.assignments !== undefined) user.assignments = resolveAssignments(body.assignments)
    recordAudit({ actor: actor(), action: body.status === 'disabled' ? 'user.disabled' : 'user.updated', target: { type: 'user', id: user.id, name: user.name }, client_id: null, site_id: null, ip: '10.20.0.14', user_agent: navigator.userAgent, details: { changed: Object.keys(body) } })
    persist()
    return HttpResponse.json(publicUser(user))
  }),

  http.delete(`${API}/users/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'users.manage' })
    if (denied) return denied
    if (params.id === db.meUserId) return fail(409, 'self_delete', 'You cannot delete your own account.')
    const user = db.users.find((item) => item.id === params.id)
    db.users = db.users.filter((item) => item.id !== params.id)
    recordAudit({ actor: actor(), action: 'user.deleted', target: { type: 'user', id: String(params.id), name: user?.name ?? null }, client_id: null, site_id: null, ip: '10.20.0.14', user_agent: navigator.userAgent, details: {} })
    persist()
    return noContent()
  }),

  http.post(`${API}/users/:id/reset-mfa`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'users.manage', stepUp: true })
    if (denied) return denied
    const user = db.users.find((item) => item.id === params.id)
    if (!user) return fail(404, 'not_found', 'User not found.')
    user.totp_enabled = false
    user.mfa_enabled = false
    recordAudit({ actor: actor(), action: 'user.mfa_reset', target: { type: 'user', id: user.id, name: user.name }, client_id: null, site_id: null, ip: '10.20.0.14', user_agent: navigator.userAgent, details: {} })
    persist()
    return noContent()
  }),

  http.get(`${API}/roles`, async ({ request }) => {
    await latency()
    return guard(request, { permission: 'users.view' }) ?? HttpResponse.json({ items: rolesWithCounts() })
  }),

  http.post(`${API}/roles`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'roles.manage' })
    if (denied) return denied
    const body = (await request.json()) as RoleInput
    const role = { id: uuid(), name: body.name, description: body.description, builtin: false, permissions: body.permissions, user_count: 0 }
    db.roles.push(role)
    recordAudit({ actor: actor(), action: 'role.created', target: { type: 'role', id: role.id, name: role.name }, client_id: null, site_id: null, ip: '10.20.0.14', user_agent: navigator.userAgent, details: {} })
    persist()
    return HttpResponse.json(role, { status: 201 })
  }),

  http.patch(`${API}/roles/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'roles.manage' })
    if (denied) return denied
    const role = db.roles.find((item) => item.id === params.id)
    if (!role) return fail(404, 'not_found', 'Role not found.')
    if (role.builtin) return fail(409, 'builtin_role', 'Built-in roles cannot be changed.')
    Object.assign(role, (await request.json()) as Partial<RoleInput>)
    recordAudit({ actor: actor(), action: 'role.updated', target: { type: 'role', id: role.id, name: role.name }, client_id: null, site_id: null, ip: '10.20.0.14', user_agent: navigator.userAgent, details: {} })
    persist()
    return HttpResponse.json(rolesWithCounts().find((item) => item.id === role.id))
  }),

  http.delete(`${API}/roles/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'roles.manage' })
    if (denied) return denied
    const role = rolesWithCounts().find((item) => item.id === params.id)
    if (!role) return fail(404, 'not_found', 'Role not found.')
    if (role.builtin) return fail(409, 'builtin_role', 'Built-in roles cannot be deleted.')
    if (role.user_count > 0) return fail(409, 'role_in_use', `${role.name} is still assigned to ${role.user_count} users.`)
    db.roles = db.roles.filter((item) => item.id !== role.id)
    persist()
    return noContent()
  }),

  http.get(`${API}/permissions`, async ({ request }) => {
    await latency()
    return guard(request) ?? HttpResponse.json({ items: PERMISSION_CATALOG })
  }),

  // ------------------------------------------------------------ audit
  http.get(`${API}/audit`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'audit.view' })
    if (denied) return denied
    const url = new URL(request.url)
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), 500)
    const cursor = url.searchParams.get('cursor')
    let items = filterAudit(url)
    if (cursor) items = items.filter((event) => event.id < Number(cursor))
    const page = items.slice(0, limit)
    const next = items.length > limit ? String(page[page.length - 1].id) : null
    return HttpResponse.json({ items: page, next_cursor: next })
  }),

  http.post(`${API}/audit/verify`, async ({ request }) => {
    await sleep(900)
    const denied = guard(request, { permission: 'audit.view' })
    if (denied) return denied
    return HttpResponse.json({ ok: true, checked: db.audit.length, broken_at: null })
  }),

  http.get(`${API}/audit/export`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'audit.export' })
    if (denied) return denied
    const url = new URL(request.url)
    const format = url.searchParams.get('format') === 'json' ? 'json' : 'csv'
    const items = filterAudit(url)
    recordAudit({ actor: actor(), action: 'audit.exported', target: null, client_id: null, site_id: null, ip: '10.20.0.14', user_agent: navigator.userAgent, details: { format, count: items.length } })
    persist()
    if (format === 'json') {
      return new HttpResponse(JSON.stringify(items, null, 2), {
        headers: { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="rustrmm-audit.json"' },
      })
    }
    const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`
    const rows = [
      ['id', 'at', 'actor_type', 'actor', 'action', 'target', 'ip', 'hash'].join(','),
      ...items.map((event) =>
        [event.id, event.at, event.actor.type, event.actor.name, event.action, event.target?.name, event.ip, event.hash]
          .map(escape)
          .join(','),
      ),
    ]
    return new HttpResponse(rows.join('\n'), {
      headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="rustrmm-audit.csv"' },
    })
  }),

  // ------------------------------------------------------------ backups
  http.get(`${API}/settings/backups`, async ({ request }) => {
    await latency()
    return guard(request, { permission: 'backups.view' }) ?? HttpResponse.json(db.backupSettings)
  }),

  http.put(`${API}/settings/backups`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'backups.manage', stepUp: true })
    if (denied) return denied
    const body = (await request.json()) as BackupSettingsUpdate
    const secret = body.destinations.s3.secret_access_key
    if (secret) db.s3Secret = secret
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { secret_access_key, ...s3 } = body.destinations.s3
    db.backupSettings = {
      ...body,
      recipient: db.backupSettings.recipient,
      destinations: { local: body.destinations.local, s3: { ...s3, has_secret: Boolean(db.s3Secret) } },
    }
    recordAudit({ actor: actor(), action: 'settings.backups_updated', target: null, client_id: null, site_id: null, ip: '10.20.0.14', user_agent: navigator.userAgent, details: { schedule: body.schedule_cron } })
    persist()
    return HttpResponse.json(db.backupSettings)
  }),

  http.get(`${API}/backups`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'backups.view' })
    if (denied) return denied
    return HttpResponse.json({ items: [...db.backups].sort((a, b) => b.started_at.localeCompare(a.started_at)) })
  }),

  http.post(`${API}/backups`, async ({ request }) => {
    await latency()
    const denied = guard(request, { permission: 'backups.manage' })
    if (denied) return denied
    if (db.backups.some((backup) => backup.status === 'running')) return fail(409, 'backup_running', 'A backup is already running.')
    const started = new Date()
    const backup: Backup = {
      id: uuid(),
      started_at: started.toISOString(),
      finished_at: null,
      status: 'running',
      trigger: 'manual',
      size_bytes: null,
      sha256: null,
      destinations: [],
      error: null,
    }
    db.backups.push(backup)
    persist()
    setTimeout(() => {
      const stored = db.backups.find((item) => item.id === backup.id)
      if (!stored) return
      const day = started.toISOString().slice(0, 19).replace(/[:T]/g, '-')
      stored.status = 'ok'
      stored.finished_at = new Date().toISOString()
      stored.size_bytes = 44 * 1_048_576 + Math.floor(Math.random() * 900_000)
      stored.sha256 = randomHex(64)
      stored.destinations = [
        { kind: 'local', status: 'ok', location: `/backups/rustrmm-${day}.tar.zst.age`, error: null },
        db.backupSettings.destinations.s3.enabled
          ? { kind: 's3', status: 'ok', location: `s3://${db.backupSettings.destinations.s3.bucket}/${db.backupSettings.destinations.s3.prefix}rustrmm-${day}.tar.zst.age`, error: null }
          : { kind: 's3', status: 'skipped', location: null, error: null },
      ]
      recordAudit({ actor: { type: 'system', id: null, name: 'Backup scheduler' }, action: 'backup.completed', target: { type: 'backup', id: stored.id, name: day }, client_id: null, site_id: null, ip: null, user_agent: null, details: { trigger: 'manual' } })
      persist()
    }, 4500)
    return HttpResponse.json(backup, { status: 202 })
  }),

  http.delete(`${API}/backups/:id`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'backups.manage', stepUp: true })
    if (denied) return denied
    db.backups = db.backups.filter((backup) => backup.id !== params.id)
    persist()
    return noContent()
  }),

  http.get(`${API}/backups/:id/download`, async ({ request, params }) => {
    await latency()
    const denied = guard(request, { permission: 'backups.manage', stepUp: true })
    if (denied) return denied
    const backup = db.backups.find((item) => item.id === params.id)
    if (!backup || backup.status !== 'ok') return fail(404, 'not_found', 'Backup file not available.')
    const name = `rustrmm-${backup.started_at.slice(0, 10)}.tar.zst.age`
    return new HttpResponse(`age-encryption.org/v1\n-> X25519 mock\n${randomHex(256)}`, {
      headers: { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${name}"` },
    })
  }),

  http.post(`${API}/backups/test-s3`, async ({ request }) => {
    await sleep(1100)
    const denied = guard(request, { permission: 'backups.manage' })
    if (denied) return denied
    const s3 = db.backupSettings.destinations.s3
    if (!s3.bucket || !s3.endpoint) return HttpResponse.json({ ok: false, error: 'Endpoint and bucket are required.' })
    if (!db.s3Secret) return HttpResponse.json({ ok: false, error: 'No secret access key is stored yet.' })
    return HttpResponse.json({ ok: true, error: null })
  }),

  // ------------------------------------------------------------ system
  http.get(`${API}/system/health`, async ({ request }) => {
    await latency()
    const denied = guard(request)
    if (denied) return denied
    return HttpResponse.json({
      status: 'ok',
      version: '0.1.0-mock',
      uptime_s: 3 * 86_400 + 7 * 3_600 + 12 * 60,
      db: { size_bytes: 186 * 1_048_576, wal_bytes: 3 * 1_048_576 },
      agents_connected: db.devices.filter((device) => device.status === 'active' && device.online).length,
      tls_mode: 'internal',
    })
  }),

  http.get(`${API}/fleet/summary`, async ({ request }) => {
    await latency()
    const denied = guard(request)
    if (denied) return denied
    const url = new URL(request.url)
    return HttpResponse.json(fleetSummary(url.searchParams.get('client_id'), url.searchParams.get('site_id')))
  }),

  http.post(`${API}/stream/ticket`, async ({ request }) => {
    await latency()
    return guard(request) ?? HttpResponse.json({ ticket: `mock-${randomHex(16)}`, expires_at: new Date(Date.now() + 30_000).toISOString() })
  }),
  ...agentUpdateHandlers,
  ...automationHandlers,
  ...monitoringHandlers,
  ...patchingHandlers,
  ...softwareHandlers,
  ...deviceHandlers,
  ...remoteHandlers,
  ...ticketsHandlers,
  ...escrowHandlers,
  ...networkHandlers,
  ...platformHandlers,
]
