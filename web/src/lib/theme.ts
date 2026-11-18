import { useSyncExternalStore } from 'react'
import { createStore, useStore } from './store'

export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'
export type Density = 'compact' | 'comfortable'

// Raw strings (not JSON) so public/theme-init.js can read them before React loads.
export const themeStore = createStore<ThemePreference>('system', {
  key: 'rustrmm.theme',
  serialize: (value) => value,
  deserialize: (raw) => (raw === 'light' || raw === 'dark' || raw === 'system' ? raw : undefined),
})

export const densityStore = createStore<Density>('compact', {
  key: 'rustrmm.density',
  serialize: (value) => value,
  deserialize: (raw) => (raw === 'compact' || raw === 'comfortable' ? raw : undefined),
})

const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null

function systemTheme(): ResolvedTheme {
  return media?.matches ? 'dark' : 'light'
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === 'system' ? systemTheme() : preference
}

function applyTheme() {
  if (typeof document === 'undefined') return
  const resolved = resolveTheme(themeStore.get())
  const root = document.documentElement
  root.classList.toggle('dark', resolved === 'dark')
  root.style.colorScheme = resolved
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', resolved === 'dark' ? '#0C0E11' : '#F7F7F5')
}

function applyDensity() {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (densityStore.get() === 'comfortable') root.dataset.density = 'comfortable'
  else delete root.dataset.density
}

const resolvedListeners = new Set<() => void>()
function notifyResolved() {
  resolvedListeners.forEach((listener) => listener())
}

if (typeof window !== 'undefined') {
  themeStore.subscribe(() => {
    applyTheme()
    notifyResolved()
  })
  densityStore.subscribe(applyDensity)
  media?.addEventListener('change', () => {
    if (themeStore.get() === 'system') {
      applyTheme()
      notifyResolved()
    }
  })
  applyTheme()
  applyDensity()
}

function subscribeResolved(listener: () => void) {
  resolvedListeners.add(listener)
  return () => resolvedListeners.delete(listener)
}

export function useTheme() {
  const preference = useStore(themeStore)
  const resolved = useSyncExternalStore(
    subscribeResolved,
    () => resolveTheme(themeStore.get()),
    () => 'dark' as ResolvedTheme,
  )
  return {
    preference,
    resolved,
    setPreference: (value: ThemePreference) => themeStore.set(value),
    toggle: () => themeStore.set(resolved === 'dark' ? 'light' : 'dark'),
  }
}

export function useDensity() {
  const density = useStore(densityStore)
  return {
    density,
    setDensity: (value: Density) => densityStore.set(value),
    toggle: () => densityStore.set(density === 'compact' ? 'comfortable' : 'compact'),
  }
}
