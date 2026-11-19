/*
 * Mock remote desktop data: each device's interactive sessions and monitors, the effective
 * desktop policy, and the scripted behaviours (consent outcomes, agent errors) that let the
 * console's states be explored.
 */
import type { DesktopConsentMode, DesktopSession, DesktopSessionList } from '@/lib/api/types'
import type { MonitorInfo } from '@/lib/desktop/control'
import { effectivePolicyFor } from './automation-model'
import { db } from './db'
import type { MockDevice } from './devices'
import type { SceneTheme } from './desktop-scene'

export interface DesktopPolicy {
  enabled: boolean
  /** The policy that disabled remote desktop (for `403 disabled_by_policy`). */
  refusedBy: { id: string; name: string } | null
  consent: DesktopConsentMode
  timeoutSecs: number
  banner: boolean
  viewOnly: boolean
}

export function desktopPolicyFor(device: MockDevice): DesktopPolicy {
  const effective = effectivePolicyFor({ automation: db.automation, devices: db.devices, clients: db.clients, sites: db.sites }, device)
  const remote = effective.document.remote_access ?? {}
  const enabled = remote.desktop !== false
  const originId = effective.origins['remote_access.desktop']
  const origin = effective.sources.find((source) => source.policy_id === originId)
  return {
    enabled,
    refusedBy: !enabled && origin ? { id: origin.policy_id, name: origin.policy_name } : null,
    consent: remote.desktop_consent ?? 'never',
    timeoutSecs: remote.consent_timeout_secs ?? 30,
    banner: remote.desktop_banner ?? true,
    viewOnly: remote.desktop_view_only ?? false,
  }
}

/** Devices whose agent has the local `desktop` capability turned off. */
const DESKTOP_DISABLED = new Set(['mcu-core-app', 'MCU-DC01'])

/** Scripted consent answers: these users decline, or never answer. */
const CONSENT_DENIES = new Set(['NWD-DRCHEN-LT'])
const CONSENT_IGNORES = new Set(['ATLAS-CAD-07'])
/** Agents where Ctrl+Alt+Del is refused (the SoftwareSASGeneration policy is missing). */
const CAD_REFUSED = new Set(['BB-POS-01'])
/** Locked consoles. */
const LOCKED = new Set(['NWD-OP1', 'HPL-WS-011'])

export type ConsentAnswer = 'granted' | 'denied' | 'timeout'

export interface DesktopScenario {
  theme: SceneTheme
  localDisabled: boolean
  consentAnswer: ConsentAnswer
  cadRefused: boolean
  /** Agent error sent instead of streaming (shown verbatim by the viewer). */
  streamError: string | null
}

export function scenarioFor(device: MockDevice): DesktopScenario {
  const linux = device.os_family === 'linux'
  const sessions = sessionsFor(device).items
  let streamError: string | null = null
  if (linux && sessions.length === 0) streamError = 'No graphical session'
  else if (linux && sessions.every((session) => session.type === 'wayland')) streamError = 'Wayland sessions are not supported yet'
  return {
    theme: linux ? 'linux' : 'windows',
    localDisabled: DESKTOP_DISABLED.has(device.hostname),
    consentAnswer: CONSENT_DENIES.has(device.hostname) ? 'denied' : CONSENT_IGNORES.has(device.hostname) ? 'timeout' : 'granted',
    cadRefused: CAD_REFUSED.has(device.hostname),
    streamError,
  }
}

function isServer(device: MockDevice) {
  return device.os_name.includes('Server') || device.device_type === 'server' || device.device_type === 'virtual'
}

function hash(text: string) {
  let value = 7
  for (const char of text) value = (value * 31 + char.charCodeAt(0)) >>> 0
  return value
}

/** The device's displays: two on desks, one on laptops, small single screens on servers. */
export function monitorsFor(device: MockDevice): MonitorInfo[] {
  if (device.os_family === 'linux') {
    if (isServer(device)) return [{ id: 0, name: 'Virtual-1', x: 0, y: 0, width: 1440, height: 900, primary: true, scale: 1 }]
    return [
      { id: 0, name: 'DP-1', x: 0, y: 0, width: 1920, height: 1080, primary: true, scale: 1 },
      { id: 1, name: 'HDMI-1', x: 1920, y: 90, width: 1600, height: 900, primary: false, scale: 1 },
    ]
  }
  if (isServer(device)) return [{ id: 0, name: '\\\\.\\DISPLAY1', x: 0, y: 0, width: 1440, height: 900, primary: true, scale: 1 }]
  if (device.device_type === 'laptop') return [{ id: 0, name: '\\\\.\\DISPLAY1', x: 0, y: 0, width: 1920, height: 1080, primary: true, scale: 1.25 }]
  return [
    { id: 0, name: '\\\\.\\DISPLAY1', x: 0, y: 0, width: 1920, height: 1080, primary: true, scale: 1 },
    { id: 1, name: '\\\\.\\DISPLAY2', x: 1920, y: 90, width: 1600, height: 900, primary: false, scale: 1 },
  ]
}

/** `GET /devices/{id}/desktop/sessions`. */
export function sessionsFor(device: MockDevice): DesktopSessionList {
  if (device.os_family === 'macos') return { items: [], tcc: { screen_recording: hash(device.hostname) % 2 === 0, accessibility: hash(device.hostname) % 3 === 0 ? null : false } }
  const monitors = monitorsFor(device).length
  if (device.os_family === 'linux') {
    if (device.hostname === 'nwd-pacs-01') return { items: [{ session_id: 2, kind: 'console', user: 'imaging', state: 'active', monitors: null, type: 'wayland' }] }
    if (device.hostname === 'sf-edge-gw' || device.hostname === 'mcu-backup-01') return { items: [] }
    if (device.hostname === 'sf-wms-01') return { items: [{ session_id: null, kind: 'console', user: null, state: 'login_screen', monitors, type: 'x11' }] }
    return { items: [{ session_id: 3, kind: 'console', user: device.hostname.startsWith('atlas') ? 'render' : 'admin', state: 'active', monitors, type: 'x11' }] }
  }
  const domain = device.domain ? device.domain.split('.')[0].toUpperCase() : device.hostname.split('-')[0]
  if (isServer(device)) {
    const items: DesktopSession[] = [{ session_id: 1, kind: 'console', user: null, state: 'login_screen', monitors }]
    items.push({ session_id: 2, kind: 'rdp', user: `${domain}\\administrator`, state: 'active', monitors: 1 })
    if (hash(device.hostname) % 2 === 0) items.push({ session_id: 3, kind: 'rdp', user: `${domain}\\svc-backup`, state: 'disconnected', monitors: 1 })
    return { items }
  }
  const user = device.last_user
  return {
    items: [
      {
        session_id: 1,
        kind: 'console',
        user,
        state: !user ? 'login_screen' : LOCKED.has(device.hostname) ? 'locked' : 'active',
        monitors,
      },
    ],
  }
}

/** The session a request targets (Linux always uses the active graphical session). */
export function resolveSession(device: MockDevice, sessionId: number | undefined): DesktopSession | null {
  const items = sessionsFor(device).items
  if (device.os_family === 'linux') return items.find((item) => item.type !== 'wayland') ?? items[0] ?? null
  if (sessionId === undefined) return items.find((item) => item.kind === 'console') ?? items[0] ?? null
  return items.find((item) => item.session_id === sessionId) ?? null
}

/** Whether the agent would ask the user, following the documented rules. */
export function consentRequired(policy: DesktopPolicy, session: DesktopSession | null): boolean {
  if (policy.consent === 'never' || !session?.user || session.state === 'login_screen') return false
  if (policy.consent === 'always') return true
  return session.state === 'active'
}
