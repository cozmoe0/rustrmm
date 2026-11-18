import { useEffect } from 'react'
import { useProductName } from './branding'

/** Sets the browser tab title for the current page (suffixed with the white-label product name). */
export function useTitle(title: string | undefined) {
  const product = useProductName()
  useEffect(() => {
    if (!title) return
    const previous = document.title
    document.title = `${title} · ${product}`
    return () => {
      document.title = previous
    }
  }, [title, product])
}
