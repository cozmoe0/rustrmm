import type { Ref } from 'react'

/** Assigns `value` to a callback or object ref (for components that keep their own ref and forward one). */
export function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === 'function') ref(value)
  else if (ref) (ref as { current: T | null }).current = value
}
