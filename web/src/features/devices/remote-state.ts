/* Small cross-component state for the remote tools (palette intents, last tool, live shells). */
import { createStore, useStore } from '@/lib/store'
import type { RemoteTab } from './cockpit-tabs'

export type RemoteIntentAction = 'connect-terminal' | 'connect-desktop' | 'power' | 'message'

export interface RemoteIntent {
  deviceId: string
  action: RemoteIntentAction
  nonce: number
}

let intentCounter = 0

/** Requests that the cockpit for `deviceId` performs an action once it is mounted (palette, header buttons). */
export const remoteIntentStore = createStore<RemoteIntent | null>(null)

export function requestRemoteIntent(deviceId: string, action: RemoteIntentAction) {
  intentCounter += 1
  remoteIntentStore.set({ deviceId, action, nonce: intentCounter })
}

export function consumeRemoteIntent(nonce: number) {
  if (remoteIntentStore.get()?.nonce === nonce) remoteIntentStore.set(null)
}

export function useRemoteIntent(deviceId: string, action: RemoteIntentAction): RemoteIntent | null {
  const intent = useStore(remoteIntentStore)
  return intent && intent.deviceId === deviceId && intent.action === action ? intent : null
}

/** The remote tool last opened, so the "Remote" tab returns to it. */
export const lastRemoteTabStore = createStore<RemoteTab | null>(null, {
  key: 'rustrmm.remote-tab',
  deserialize: (raw) => {
    try {
      const value = JSON.parse(raw) as unknown
      return typeof value === 'string' ? (value as RemoteTab) : undefined
    } catch {
      return undefined
    }
  },
})

/** Devices with a connected (recorded) shell in this browser tab. */
export const liveShellStore = createStore<Record<string, boolean>>({})

export function setLiveShell(deviceId: string, live: boolean) {
  liveShellStore.set((prev) => (Boolean(prev[deviceId]) === live ? prev : { ...prev, [deviceId]: live }))
}

export function useLiveShell(deviceId: string): boolean {
  return Boolean(useStore(liveShellStore)[deviceId])
}

/** Devices with a connected remote desktop in this browser tab. */
export const liveDesktopStore = createStore<Record<string, boolean>>({})

export function setLiveDesktop(deviceId: string, live: boolean) {
  liveDesktopStore.set((prev) => (Boolean(prev[deviceId]) === live ? prev : { ...prev, [deviceId]: live }))
}

export function useLiveDesktop(deviceId: string): boolean {
  return Boolean(useStore(liveDesktopStore)[deviceId])
}

/** A recording the Sessions tab should open in the player (e.g. "Replay" after a shell ends). */
export const playbackRequestStore = createStore<string | null>(null)

export function requestPlayback(sessionId: string) {
  playbackRequestStore.set(sessionId)
}

export function usePlaybackRequest(): string | null {
  return useStore(playbackRequestStore)
}
