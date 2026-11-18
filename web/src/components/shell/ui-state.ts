import { createStore, useStore } from '@/lib/store'

/** Transient shell UI state shared between the rail, top bar, palette and hotkeys. */
export const paletteStore = createStore(false)
export const shortcutsStore = createStore(false)
export const mobileNavStore = createStore(false)

/** Per-section collapsed state of the context panel (persisted). */
export const contextPanelStore = createStore<Record<string, boolean>>({}, { key: 'rustrmm.context-panel' })

export function usePaletteOpen() {
  return useStore(paletteStore)
}

export function useShortcutsOpen() {
  return useStore(shortcutsStore)
}

export function useMobileNavOpen() {
  return useStore(mobileNavStore)
}

export function useContextPanelCollapsed(section: string) {
  const state = useStore(contextPanelStore)
  return {
    collapsed: Boolean(state[section]),
    toggle: () => contextPanelStore.set((prev) => ({ ...prev, [section]: !prev[section] })),
  }
}
