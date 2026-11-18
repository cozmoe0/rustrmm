import { useNavigate } from '@tanstack/react-router'
import { useHotkeys, type HotkeyMap } from '@/lib/hotkeys'
import type { RoutePath } from '@/lib/nav'
import { workspaceStore } from '@/lib/workspace'
import { paletteStore, shortcutsStore } from './ui-state'

export function GlobalHotkeys() {
  const navigate = useNavigate()

  const go = (to: RoutePath) => () =>
    void navigate({
      to,
    })

  const openTab = (index: number) => () => {
    const tab = workspaceStore.get()[index]
    if (tab) {
      void navigate({
        to: tab.to as never,
        params: tab.params as never,
      })
    }
  }

  const map: HotkeyMap = {
    'mod+k': () => paletteStore.set((open) => !open),
    '?': () => shortcutsStore.set(true),
    '/': () => {
      const target = document.querySelector<HTMLElement>('[data-filter-input]')
      target?.focus()
    },
    'g h': go('/'),
    'g c': go('/clients'),
    'g d': go('/devices'),
    'g a': go('/alerts'),
    'g u': go('/automation'),
    'g p': go('/patching'),
    'g w': go('/software'),
    'g t': go('/tickets'),
    'g n': go('/network'),
    'g k': go('/secrets'),
    'g r': go('/reports'),
    'g s': go('/settings/users'),
  }
  for (let index = 0; index < 9; index += 1) {
    map[`mod+${index + 1}`] = openTab(index)
    map[`alt+${index + 1}`] = openTab(index)
  }

  useHotkeys(map)
  return null
}
