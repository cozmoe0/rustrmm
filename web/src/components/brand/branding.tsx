/* Applies white-label branding (public `GET /branding`) to the console: accent token, product name and logos. */
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { brandingQuery } from '@/lib/api/queries'
import { DEFAULT_PRODUCT_NAME, applyAccent, isDefaultProductName, logoFor, productNameStore, useProductName } from '@/lib/branding'
import type { ThemeName } from '@/lib/color'
import { useTheme } from '@/lib/theme'
import { cn } from '@/lib/utils'
import { LogoMark } from './logo'

/** Mounted once at the root: keeps the accent and product name in sync with the server's branding. */
export function BrandingEffect() {
  const { data } = useQuery(brandingQuery)
  const { resolved } = useTheme()
  useEffect(() => {
    applyAccent(data?.accent_color ?? null, resolved)
  }, [data?.accent_color, resolved])
  useEffect(() => {
    if (data) productNameStore.set(data.product_name.trim() || DEFAULT_PRODUCT_NAME)
  }, [data])
  return null
}

/** The uploaded logo for a surface, or the RustRMM mark. */
export function BrandMark({ surface, className, fallbackClassName }: { surface: ThemeName; className?: string; fallbackClassName?: string }) {
  const { data } = useQuery(brandingQuery)
  const url = logoFor(data, surface)
  if (url) return <img src={url} alt="" className={cn('h-8 max-w-[8rem] object-contain', className)} />
  return <LogoMark className={fallbackClassName} />
}

/** "RustRMM" with the copper "RMM", or the white-label product name. */
export function ProductWordmark({ className }: { className?: string }) {
  const name = useProductName()
  if (isDefaultProductName(name)) {
    return (
      <span className={cn('font-display font-semibold tracking-tight', className)}>
        Rust<span className="text-primary">RMM</span>
      </span>
    )
  }
  return <span className={cn('font-display truncate font-semibold tracking-tight', className)}>{name}</span>
}
