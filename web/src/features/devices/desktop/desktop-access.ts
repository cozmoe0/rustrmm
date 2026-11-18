/* Remote desktop: policy refusals, consent expectations, session labels and viewer preferences. */
import { isApiError } from '@/lib/api/errors'
import type { DesktopConsentMode, DesktopSession, DesktopSessionState, PolicyRefusalDetails } from '@/lib/api/types'
import type { DesktopQuality } from '@/lib/desktop/control'
import type { ScaleMode } from '@/lib/desktop/viewport'
import { createStore } from '@/lib/store'

/** `403 disabled_by_policy`: the device's effective policy turns remote desktop off. */
export function policyRefusal(error: unknown): { policyName: string | null; policyId: string | null } | null {
  if (!isApiError(error) || error.code !== 'disabled_by_policy') return null
  const details = (error.details ?? {}) as Partial<PolicyRefusalDetails>
  return { policyName: details.policy_name ?? null, policyId: details.policy_id ?? null }
}

export const SESSION_STATE_LABEL: Record<DesktopSessionState, string> = {
  active: 'Active',
  disconnected: 'Disconnected',
  locked: 'Locked',
  login_screen: 'Sign-in screen',
}

export const SESSION_STATE_TONE: Record<DesktopSessionState, 'live' | 'warning' | 'neutral' | 'info'> = {
  active: 'live',
  disconnected: 'neutral',
  locked: 'warning',
  login_screen: 'info',
}

export function sessionTitle(session: DesktopSession): string {
  if (session.kind === 'rdp') return session.user ?? 'RDP session'
  return session.user ?? (session.state === 'login_screen' ? 'Sign-in screen' : 'Console')
}

/** Why a listed session can't be viewed, or null. */
export function sessionUnsupported(session: DesktopSession): string | null {
  if (session.type === 'wayland') return 'Wayland sessions are not supported yet'
  return null
}

/** The session to preselect: the active console, then any active session, then the first usable one. */
export function preferredSession(items: readonly DesktopSession[]): DesktopSession | null {
  const usable = items.filter((item) => !sessionUnsupported(item))
  return (
    usable.find((item) => item.kind === 'console' && item.state === 'active') ??
    usable.find((item) => item.state === 'active') ??
    usable.find((item) => item.kind === 'console') ??
    usable[0] ??
    null
  )
}

/** A stable key for a listed session (Linux ids may be null). */
export function sessionKey(session: DesktopSession, index: number): string {
  return session.session_id === null ? `index:${index}` : `id:${session.session_id}`
}

export type ConsentExpectation = 'ask' | 'none'

/**
 * Whether connecting will show the consent prompt, following the agent's rules: nobody is asked on
 * the sign-in screen; `when_user_present` asks only a signed-in user on an unlocked session.
 */
export function consentExpectation(mode: DesktopConsentMode, session: DesktopSession | null): ConsentExpectation {
  if (mode === 'never') return 'none'
  if (!session || !session.user || session.state === 'login_screen') return 'none'
  if (mode === 'always') return 'ask'
  return session.state === 'active' ? 'ask' : 'none'
}

/** Secure desktops are where UAC prompts and the lock and sign-in screens live. */
export function secureDesktopLabel(desktop: string): string | null {
  if (desktop === 'winlogon') return 'UAC / sign-in screen'
  if (desktop === 'screensaver') return 'Screen saver'
  if (desktop && desktop !== 'default') return desktop
  return null
}

export const QUALITY_OPTIONS: { value: DesktopQuality; label: string; description: string }[] = [
  { value: 'auto', label: 'Auto', description: 'Adapts to the connection' },
  { value: 'low', label: 'Low', description: 'Fastest, for slow links' },
  { value: 'medium', label: 'Medium', description: 'Balanced' },
  { value: 'high', label: 'High', description: 'Sharpest text' },
]

export interface DesktopPrefs {
  quality: DesktopQuality
  scale: ScaleMode
  stats: boolean
  /** Copy the device clipboard to this computer as soon as it changes. */
  autoClipboard: boolean
  /** On macOS, send ⌘ as Ctrl so shortcuts like ⌘C work on Windows and Linux. */
  mapMetaToCtrl: boolean
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

const DEFAULT_PREFS: DesktopPrefs = { quality: 'auto', scale: 'fit', stats: false, autoClipboard: false, mapMetaToCtrl: isMac }

export const desktopPrefsStore = createStore<DesktopPrefs>(DEFAULT_PREFS, {
  key: 'rustrmm.desktop.prefs',
  deserialize: (raw) => {
    try {
      const value = JSON.parse(raw) as Partial<DesktopPrefs>
      return { ...DEFAULT_PREFS, ...value }
    } catch {
      return undefined
    }
  },
})

export function setDesktopPref<K extends keyof DesktopPrefs>(key: K, value: DesktopPrefs[K]) {
  desktopPrefsStore.set((prev) => ({ ...prev, [key]: value }))
}

export const IS_MAC_CLIENT = isMac

/** "nwd-front-01 2026-11-18 14.03.22.png" */
export function screenshotFileName(hostname: string, at = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${hostname} ${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}.${pad(at.getMinutes())}.${pad(at.getSeconds())}.png`
}
