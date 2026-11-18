import { createStore, useStore } from './store'

export type WorkspaceTabKind = 'client' | 'device' | 'ticket' | 'job'

export interface WorkspaceTab {
  /** Stable identity, e.g. `client:<uuid>`. */
  id: string
  kind: WorkspaceTabKind
  title: string
  /** Router path the tab navigates to. */
  to: string
  params?: Record<string, string>
  accent?: string | null
  /** Small kind-specific hints for rendering, e.g. `{ os: 'windows' }` for device tabs. */
  meta?: Record<string, string>
}

const MAX_TABS = 12

export const workspaceStore = createStore<WorkspaceTab[]>([], {
  key: 'rustrmm.workspace-tabs',
  deserialize: (raw) => {
    try {
      const value = JSON.parse(raw) as unknown
      return Array.isArray(value) ? (value as WorkspaceTab[]) : undefined
    } catch {
      return undefined
    }
  },
})

export function openWorkspaceTab(tab: WorkspaceTab) {
  workspaceStore.set((tabs) => {
    const existing = tabs.findIndex((item) => item.id === tab.id)
    if (existing >= 0) {
      const next = [...tabs]
      next[existing] = { ...next[existing], ...tab }
      return next
    }
    const next = [...tabs, tab]
    return next.length > MAX_TABS ? next.slice(next.length - MAX_TABS) : next
  })
}

export function closeWorkspaceTab(id: string) {
  workspaceStore.set((tabs) => tabs.filter((tab) => tab.id !== id))
}

export function renameWorkspaceTab(id: string, title: string, accent?: string | null) {
  workspaceStore.set((tabs) =>
    tabs.some((tab) => tab.id === id && (tab.title !== title || tab.accent !== accent))
      ? tabs.map((tab) => (tab.id === id ? { ...tab, title, accent } : tab))
      : tabs,
  )
}

export function useWorkspaceTabs() {
  return useStore(workspaceStore)
}

/** The concrete path a tab points at, with route params substituted. */
export function tabHref(tab: WorkspaceTab) {
  let path = tab.to
  for (const [key, value] of Object.entries(tab.params ?? {})) path = path.replace(`$${key}`, value)
  return path
}
