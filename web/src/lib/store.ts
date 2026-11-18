import { useSyncExternalStore } from 'react'

export interface Store<T> {
  get(): T
  set(next: T | ((prev: T) => T)): void
  subscribe(listener: () => void): () => void
}

interface StoreOptions<T> {
  /** localStorage key; omit for an in-memory store. */
  key?: string
  /** Turns the stored string back into a value; return undefined to fall back to the initial value. */
  deserialize?: (raw: string) => T | undefined
  serialize?: (value: T) => string
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Storage can be unavailable (private mode, quota). The in-memory value still works.
  }
}

/** A tiny observable store with optional localStorage persistence. */
export function createStore<T>(initial: T, options: StoreOptions<T> = {}): Store<T> {
  const { key } = options
  const serialize = options.serialize ?? ((value: T) => JSON.stringify(value))
  const deserialize =
    options.deserialize ??
    ((raw: string) => {
      try {
        return JSON.parse(raw) as T
      } catch {
        return undefined
      }
    })

  let value = initial
  if (key && typeof window !== 'undefined') {
    const raw = readStorage(key)
    if (raw !== null) value = deserialize(raw) ?? initial
  }

  const listeners = new Set<() => void>()

  return {
    get: () => value,
    set(next) {
      const resolved = typeof next === 'function' ? (next as (prev: T) => T)(value) : next
      if (Object.is(resolved, value)) return
      value = resolved
      if (key) writeStorage(key, serialize(value))
      listeners.forEach((listener) => listener())
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}
