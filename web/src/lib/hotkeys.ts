import { useEffect, useRef } from 'react'

export type HotkeyHandler = (event: KeyboardEvent) => void

/**
 * Bindings use a small grammar:
 *  - "mod+k"   Ctrl on Windows/Linux, Cmd on macOS
 *  - "alt+1"   modifier combos
 *  - "g h"     a two-key sequence typed within one second
 *  - "?" "/"   single keys
 */
export type HotkeyMap = Record<string, HotkeyHandler>

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

export const modKeyLabel = isMac ? '⌘' : 'Ctrl'

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

function eventMatches(binding: string, event: KeyboardEvent): boolean {
  const parts = binding.toLowerCase().split('+')
  const key = parts.pop()!
  const wantMod = parts.includes('mod')
  const wantAlt = parts.includes('alt')
  const wantShift = parts.includes('shift')
  const mod = isMac ? event.metaKey : event.ctrlKey
  if (wantMod !== mod || wantAlt !== event.altKey) return false
  if (parts.length > 0 && wantShift !== event.shiftKey) return false
  const pressed = event.key.toLowerCase()
  if (pressed === key) return true
  // Alt/Shift change event.key on some layouts; fall back to the physical digit key.
  return /^\d$/.test(key) && event.code === `Digit${key}`
}

export function useHotkeys(map: HotkeyMap, enabled = true) {
  const mapRef = useRef(map)
  useEffect(() => {
    mapRef.current = map
  })

  useEffect(() => {
    if (!enabled) return
    let pending: string | null = null
    let pendingTimer: number | undefined

    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing) return
      const bindings = Object.entries(mapRef.current)
      const typing = isTypingTarget(event.target)

      for (const [binding, handler] of bindings) {
        if (!binding.includes('+')) continue
        if (eventMatches(binding, event)) {
          event.preventDefault()
          handler(event)
          return
        }
      }

      if (typing || event.ctrlKey || event.metaKey || event.altKey) return
      const key = event.key.toLowerCase()

      if (pending) {
        const sequence = `${pending} ${key}`
        pending = null
        window.clearTimeout(pendingTimer)
        const handler = mapRef.current[sequence]
        if (handler) {
          event.preventDefault()
          handler(event)
          return
        }
      }

      const startsSequence = bindings.some(([binding]) => binding.startsWith(`${key} `))
      if (startsSequence) {
        pending = key
        pendingTimer = window.setTimeout(() => {
          pending = null
        }, 1000)
        return
      }

      const single = mapRef.current[event.key] ?? mapRef.current[key]
      if (single && !bindings.some(([binding]) => binding === key && binding.includes(' '))) {
        event.preventDefault()
        single(event)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.clearTimeout(pendingTimer)
    }
  }, [enabled])
}
